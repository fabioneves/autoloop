#!/usr/bin/env node
// Exact-head delivery contract. Decides whether a pull request head is
// deliverable from live GitHub evidence alone: the committed, reviewed, and
// gated heads must be the same OID, that OID must be the live remote head, and
// the TRIGGERED-CHECKS FLOOR must hold — every check run and every commit
// status that actually ran on that exact head is green. Red blocks, pending
// blocks, and a repository with no CI has nothing on the head, so the floor is
// trivially satisfied (NO_TRIGGERED_CHECKS).
//
// There is deliberately no committed required-check list and no server
// rules/protection comparison here. v0.40 bound delivery to a committed
// .autoloop/ci-policy.json reconciled against branch-protection reads; on a
// free-plan repository that comparison was unsatisfiable by construction and
// the protection endpoints refused reads (HTTP 403 "Upgrade to GitHub …").
// The floor needs only PAT-readable evidence: verification notes in
// docs/specs/simple-delivery.md.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;
const GREEN_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const MAX_CHECK_RUNS = 10_000;
const DELIVERY_INPUT_KEYS = [
  'committedHead',
  'gatedHead',
  'pullRequest',
  'repository',
  'reviewedHead',
  'schemaVersion',
];
const TEST_GITHUB_JSON = Symbol('testGithubJson');
const GH_ENV = Object.freeze({
  ...process.env,
  GH_PAGER: 'cat',
  GH_PROMPT_DISABLED: '1',
  NO_COLOR: '1',
  PAGER: 'cat',
});

function result(state, code, detail = {}) {
  return {
    state,
    code,
    canMarkDelivered: state === 'delivered',
    ...detail,
  };
}

export function classifyCheck(check) {
  const state = String(check?.state ?? '').toUpperCase();
  if (state) {
    if (state === 'SUCCESS') return 'green';
    if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
    return 'failed';
  }
  const status = String(check?.status ?? '').toUpperCase();
  const conclusion = String(check?.conclusion ?? '').toUpperCase();
  if (status && status !== 'COMPLETED') return 'pending';
  if (!conclusion) return 'pending';
  return GREEN_CONCLUSIONS.has(conclusion) ? 'green' : 'failed';
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function exactKeys(value, keys) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

class DeliveryEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function evidenceFailure(code) {
  throw new DeliveryEvidenceError(code);
}

function normalizeDeliveryRequest(input) {
  if (
    !exactKeys(input, DELIVERY_INPUT_KEYS)
    || input.schemaVersion !== 1
    || !REPOSITORY_RE.test(input.repository ?? '')
    || !Number.isSafeInteger(input.pullRequest)
    || input.pullRequest < 1
    || !SHA_RE.test(input.committedHead ?? '')
    || !SHA_RE.test(input.reviewedHead ?? '')
    || !SHA_RE.test(input.gatedHead ?? '')
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    repository: input.repository,
    pullRequest: input.pullRequest,
    committedHead: input.committedHead,
    reviewedHead: input.reviewedHead,
    gatedHead: input.gatedHead,
  });
}

function githubRestJson(repository, endpoint, execute = execFileSync) {
  if (!REPOSITORY_RE.test(repository)) evidenceFailure('GITHUB_REPOSITORY_INVALID');
  let output;
  try {
    output = execute(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        endpoint,
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2026-03-10',
      ],
      {
        encoding: 'utf8',
        env: GH_ENV,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      },
    );
  } catch {
    evidenceFailure('GITHUB_API_UNAVAILABLE');
  }
  try {
    return JSON.parse(output);
  } catch {
    return evidenceFailure('GITHUB_API_RESPONSE_INVALID');
  }
}

function normalizePullRequest(value, request) {
  const deliverableState =
    value?.state === 'open' && typeof value?.draft === 'boolean'
    || value?.state === 'closed' && value?.merged === true;
  if (
    value?.number !== request.pullRequest
    || !deliverableState
    || !SHA_RE.test(value?.head?.sha ?? '')
    || typeof value?.base?.ref !== 'string'
    || value.base.ref.length === 0
    || value.base.ref.length > 255
    || value?.base?.repo?.full_name !== request.repository
  ) {
    evidenceFailure('PULL_REQUEST_EVIDENCE_INVALID');
  }
  return Object.freeze({
    number: value.number,
    headOid: value.head.sha,
    baseRefName: value.base.ref,
    draft: value.draft === true,
  });
}

function normalizeCheckRun(value, headOid) {
  if (
    !Number.isSafeInteger(value?.id)
    || value.id < 1
    || typeof value?.name !== 'string'
    || value.name.length === 0
    || value.name.length > 255
    || value?.head_sha !== headOid
    || typeof value?.status !== 'string'
    || value.status.length === 0
    || (value.conclusion !== null && typeof value.conclusion !== 'string')
  ) {
    evidenceFailure('CHECK_RUN_EVIDENCE_INVALID');
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    headOid: value.head_sha,
    status: value.status.toUpperCase(),
    conclusion: value.conclusion === null ? null : value.conclusion.toUpperCase(),
  });
}

function normalizeCheckRunPages(value, headOid) {
  const pages = Array.isArray(value) ? value : [value];
  if (pages.length === 0) evidenceFailure('CHECK_RUN_PAGINATION_INCOMPLETE');
  let total = null;
  const checks = [];
  for (const page of pages) {
    if (
      !Number.isSafeInteger(page?.total_count)
      || page.total_count < 0
      || !Array.isArray(page?.check_runs)
      || (total !== null && page.total_count !== total)
    ) {
      evidenceFailure('CHECK_RUN_PAGINATION_INCOMPLETE');
    }
    total = page.total_count;
    checks.push(...page.check_runs.map((check) => normalizeCheckRun(check, headOid)));
  }
  const ids = checks.map((check) => check.id);
  if (checks.length !== total || new Set(ids).size !== ids.length) {
    evidenceFailure('CHECK_RUN_PAGINATION_INCOMPLETE');
  }
  return Object.freeze(checks.sort((left, right) => left.id - right.id));
}

function fetchCheckRuns(repository, headOid, fetchJson) {
  const endpoint = `repos/${repository}/commits/${headOid}/check-runs?filter=all&per_page=100`;
  const first = fetchJson(repository, `${endpoint}&page=1`);
  if (
    !Number.isSafeInteger(first?.total_count)
    || first.total_count < 0
    || first.total_count > MAX_CHECK_RUNS
  ) {
    evidenceFailure('CHECK_RUN_PAGINATION_INCOMPLETE');
  }
  const pages = [first];
  const pageCount = Math.max(1, Math.ceil(first.total_count / 100));
  for (let page = 2; page <= pageCount; page += 1) {
    pages.push(fetchJson(repository, `${endpoint}&page=${page}`));
  }
  return normalizeCheckRunPages(pages, headOid);
}

// The combined-status endpoint returns the LATEST status per context, which is
// exactly the floor's unit of evidence: a context is green iff its latest state
// is success. A page holding 100 contexts is treated as possibly truncated and
// fails closed rather than merging pages whose "latest" may have moved between
// fetches.
function normalizeStatuses(value, headOid) {
  if (
    value?.sha !== headOid
    || !Array.isArray(value?.statuses)
    || value.statuses.length >= 100
  ) {
    evidenceFailure('STATUS_EVIDENCE_INCOMPLETE');
  }
  const statuses = value.statuses.map((status) => {
    if (
      typeof status?.context !== 'string'
      || status.context.length === 0
      || status.context.length > 255
      || typeof status?.state !== 'string'
      || status.state.length === 0
      || (status.description !== null && typeof status.description !== 'string')
    ) {
      evidenceFailure('STATUS_EVIDENCE_INVALID');
    }
    return Object.freeze({
      context: status.context,
      state: status.state.toUpperCase(),
      description: status.description ?? '',
    });
  });
  const contexts = statuses.map((status) => status.context);
  if (new Set(contexts).size !== contexts.length) {
    evidenceFailure('STATUS_EVIDENCE_INVALID');
  }
  return Object.freeze(
    [...statuses].sort((left, right) => left.context.localeCompare(right.context)),
  );
}

function fetchCommitStatuses(repository, headOid, fetchJson) {
  return normalizeStatuses(
    fetchJson(
      repository,
      `repos/${repository}/commits/${headOid}/status?per_page=100`,
    ),
    headOid,
  );
}

function sameEvidence(left, right) {
  return fingerprint(left) === fingerprint(right);
}

function deliveryEvidenceBinding(evidence) {
  return {
    schemaVersion: evidence.schemaVersion,
    source: evidence.source,
    repository: evidence.repository,
    pullRequest: evidence.pullRequest,
    remoteHead: evidence.remoteHead,
    baseRefName: evidence.baseRefName,
    checks: evidence.checks,
    statuses: evidence.statuses,
  };
}

export function fetchLiveDeliveryObservation(input, context = {}) {
  const request = normalizeDeliveryRequest(input);
  if (request === null) evidenceFailure('INVALID_DELIVERY_INPUT');
  const fetchJson = context[TEST_GITHUB_JSON] ?? githubRestJson;
  const pullRequestEndpoint = `repos/${request.repository}/pulls/${request.pullRequest}`;
  const firstPullRequest = normalizePullRequest(
    fetchJson(request.repository, pullRequestEndpoint),
    request,
  );
  const firstChecks = fetchCheckRuns(
    request.repository,
    firstPullRequest.headOid,
    fetchJson,
  );
  const firstStatuses = fetchCommitStatuses(
    request.repository,
    firstPullRequest.headOid,
    fetchJson,
  );
  const secondChecks = fetchCheckRuns(
    request.repository,
    firstPullRequest.headOid,
    fetchJson,
  );
  const secondStatuses = fetchCommitStatuses(
    request.repository,
    firstPullRequest.headOid,
    fetchJson,
  );
  const secondPullRequest = normalizePullRequest(
    fetchJson(request.repository, pullRequestEndpoint),
    request,
  );
  if (
    !sameEvidence(firstPullRequest, secondPullRequest)
    || !sameEvidence(firstChecks, secondChecks)
    || !sameEvidence(firstStatuses, secondStatuses)
  ) {
    evidenceFailure('LIVE_DELIVERY_EVIDENCE_CHANGED');
  }
  const evidence = {
    schemaVersion: 2,
    source: 'github-rest',
    repository: request.repository,
    pullRequest: request.pullRequest,
    remoteHead: firstPullRequest.headOid,
    baseRefName: firstPullRequest.baseRefName,
    draft: firstPullRequest.draft,
    checks: firstChecks,
    statuses: firstStatuses,
  };
  return Object.freeze({
    ...evidence,
    provenance: Object.freeze({
      schemaVersion: 2,
      source: 'github-rest',
      repository: request.repository,
      pullRequest: request.pullRequest,
      evidenceFingerprint: fingerprint(deliveryEvidenceBinding(evidence)),
    }),
  });
}

// The triggered-checks floor: every check run and every status context on the
// exact head must be green. There is no required-name list to compare against —
// what ran is what counts, and nothing having run is a repository without CI,
// not a failure.
function classifyTriggeredChecks(observation) {
  const failedChecks = [];
  let pending = false;
  for (const check of observation.checks) {
    const classification = classifyCheck(check);
    if (classification === 'pending') pending = true;
    if (classification === 'failed') failedChecks.push(check.name);
  }
  for (const status of observation.statuses) {
    const classification = classifyCheck(status);
    if (classification === 'pending') pending = true;
    if (classification === 'failed') failedChecks.push(status.context);
  }
  if (failedChecks.length > 0) {
    return result('gate-red', 'CI_FAILED', {
      headOid: observation.remoteHead,
      failedChecks: failedChecks.sort(),
      liveEvidence: observation,
    });
  }
  if (pending) {
    return result('awaiting-ci', 'CI_PENDING', {
      headOid: observation.remoteHead,
      liveEvidence: observation,
    });
  }
  return result(
    'delivered',
    observation.checks.length === 0 && observation.statuses.length === 0
      ? 'NO_TRIGGERED_CHECKS'
      : 'CI_GREEN',
    {
      headOid: observation.remoteHead,
      liveEvidence: observation,
    },
  );
}

export function finalizeHead(input, context = {}) {
  const request = normalizeDeliveryRequest(input);
  if (request === null) return result('error', 'INVALID_DELIVERY_INPUT');
  if (request.committedHead !== request.reviewedHead) {
    return result('re-review', 'REVIEW_HEAD_MISMATCH', {
      committedHead: request.committedHead,
      reviewedHead: request.reviewedHead,
    });
  }
  if (request.reviewedHead !== request.gatedHead) {
    return result('re-gate', 'GATE_HEAD_MISMATCH', {
      reviewedHead: request.reviewedHead,
      gatedHead: request.gatedHead,
    });
  }

  let observation;
  try {
    observation = fetchLiveDeliveryObservation(request, context);
  } catch (error) {
    return result('awaiting-ci', 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE', {
      headOid: request.gatedHead,
      evidenceCode:
        error instanceof DeliveryEvidenceError
          ? error.code
          : 'LIVE_DELIVERY_EVIDENCE_FAILED',
    });
  }
  if (request.gatedHead !== observation.remoteHead) {
    return result('re-gate', 'REMOTE_HEAD_MISMATCH', {
      gatedHead: request.gatedHead,
      remoteHead: observation.remoteHead,
      liveEvidence: observation,
    });
  }
  return classifyTriggeredChecks(observation);
}

function selfTest() {
  function githubFixtureApi(fixture) {
    const pullRequestValue = (value) => ({
      number: value.number,
      state: value.state ?? 'open',
      draft: value.draft ?? false,
      merged: value.merged ?? false,
      head: { sha: value.headOid },
      base: {
        ref: value.baseRefName,
        repo: { full_name: fixture.repository ?? 'owner/repository' },
      },
    });
    const checkValues = (values) => (values ?? []).map((check) => ({
      id: check.id,
      name: check.name,
      head_sha: check.headOid,
      status: check.status,
      conclusion: check.conclusion ?? null,
    }));
    const statusValues = (values) => (values ?? []).map((status) => ({
      context: status.context,
      state: status.state,
      description: status.description ?? null,
    }));
    let pullRequestReads = 0;
    let checkSnapshotReads = 0;
    let statusSnapshotReads = 0;
    return (_repository, endpoint) => {
      if (endpoint.includes('/pulls/')) {
        const value = pullRequestReads > 0 && fixture.secondPullRequest
          ? fixture.secondPullRequest
          : fixture.pullRequest;
        pullRequestReads += 1;
        return pullRequestValue(value);
      }
      if (endpoint.includes('/check-runs?')) {
        const pageMatch = endpoint.match(/[?&]page=(\d+)$/u);
        const page = Number(pageMatch?.[1]);
        if (!Number.isSafeInteger(page) || page < 1) {
          throw new Error(`invalid fixture page ${endpoint}`);
        }
        const useSecond = page === 1
          ? (checkSnapshotReads += 1) > 1
          : checkSnapshotReads > 1;
        const values = useSecond && fixture.secondChecks
          ? fixture.secondChecks
          : fixture.checks;
        const allChecks = checkValues(values);
        return {
          total_count:
            fixture.checksIncomplete === true ? allChecks.length + 1 : allChecks.length,
          check_runs: allChecks.slice((page - 1) * 100, page * 100),
        };
      }
      if (endpoint.includes('/status?')) {
        statusSnapshotReads += 1;
        const values = statusSnapshotReads > 1 && fixture.secondStatuses
          ? fixture.secondStatuses
          : fixture.statuses;
        const headMatch = endpoint.match(/commits\/([0-9a-f]{40})\/status/u);
        return {
          sha: fixture.statusSha ?? headMatch?.[1],
          statuses: statusValues(values),
        };
      }
      throw new Error(`unexpected fixture endpoint ${endpoint}`);
    };
  }

  function liveFixture(fixture) {
    if ('repository' in fixture.input) {
      const { githubFixture, ...context } = fixture.context;
      return {
        ...fixture,
        context: {
          ...context,
          [TEST_GITHUB_JSON]: githubFixtureApi(githubFixture),
        },
      };
    }
    const ci = fixture.input.ci ?? {};
    const remoteHead = fixture.input.remoteHead ?? fixture.input.gatedHead;
    const mapChecks = (values) => (Array.isArray(values)
      ? values.map((check, index) => ({
          id: index + 101,
          name: check.name ?? check.context,
          status: check.status,
          conclusion: check.conclusion,
          headOid: check.headOid ?? remoteHead,
        }))
      : undefined);
    const checks = mapChecks(ci.checks) ?? [];
    return {
      ...fixture,
      input: {
        schemaVersion: 1,
        repository: 'owner/repository',
        pullRequest: 12,
        committedHead: fixture.input.committedHead,
        reviewedHead: fixture.input.reviewedHead,
        gatedHead: fixture.input.gatedHead,
      },
      context: {
        ...fixture.context,
        [TEST_GITHUB_JSON]: githubFixtureApi({
          pullRequest: {
            number: 12,
            headOid: remoteHead,
            baseRefName: 'main',
          },
          checks,
          checksIncomplete: ci.complete === false,
          statuses: ci.statuses ?? [],
          secondChecks: mapChecks(ci.secondChecks),
          secondStatuses: ci.secondStatuses,
          statusSha: ci.statusSha,
        }),
      },
    };
  }

  const HEAD = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  const heads = { committedHead: HEAD, reviewedHead: HEAD, gatedHead: HEAD };
  const green = { name: 'validate', status: 'completed', conclusion: 'success' };
  const cases = [
    {
      name: 'invalid input is a typed error',
      input: { schemaVersion: 1 },
      raw: true,
      expect: { state: 'error', code: 'INVALID_DELIVERY_INPUT' },
    },
    {
      name: 'unknown input key is a typed error',
      input: {
        schemaVersion: 1,
        repository: 'owner/repository',
        pullRequest: 12,
        ...heads,
        extra: true,
      },
      raw: true,
      expect: { state: 'error', code: 'INVALID_DELIVERY_INPUT' },
    },
    {
      name: 'review head mismatch demands re-review',
      input: { committedHead: HEAD, reviewedHead: OTHER, gatedHead: OTHER },
      expect: { state: 're-review', code: 'REVIEW_HEAD_MISMATCH' },
    },
    {
      name: 'gate head mismatch demands re-gate',
      input: { committedHead: HEAD, reviewedHead: HEAD, gatedHead: OTHER },
      expect: { state: 're-gate', code: 'GATE_HEAD_MISMATCH' },
    },
    {
      name: 'remote head mismatch demands re-gate',
      input: { ...heads, remoteHead: OTHER },
      expect: { state: 're-gate', code: 'REMOTE_HEAD_MISMATCH' },
    },
    {
      name: 'no triggered checks delivers on the floor alone',
      input: { ...heads, ci: {} },
      expect: { state: 'delivered', code: 'NO_TRIGGERED_CHECKS' },
    },
    {
      name: 'green check runs and statuses deliver',
      input: {
        ...heads,
        ci: {
          checks: [green],
          statuses: [
            { context: 'agentic/gate', state: 'success' },
            { context: 'agentic/review', state: 'success' },
          ],
        },
      },
      expect: { state: 'delivered', code: 'CI_GREEN' },
    },
    {
      name: 'neutral and skipped conclusions are green',
      input: {
        ...heads,
        ci: {
          checks: [
            { name: 'lint', status: 'completed', conclusion: 'neutral' },
            { name: 'docs', status: 'completed', conclusion: 'skipped' },
          ],
        },
      },
      expect: { state: 'delivered', code: 'CI_GREEN' },
    },
    {
      name: 'a failed check run on the head blocks the floor',
      input: {
        ...heads,
        ci: { checks: [{ ...green, conclusion: 'failure' }] },
      },
      expect: {
        state: 'gate-red',
        code: 'CI_FAILED',
        failedChecks: ['validate'],
      },
    },
    {
      name: 'a failed status context on the head blocks the floor',
      input: {
        ...heads,
        ci: {
          checks: [green],
          statuses: [{ context: 'external/scan', state: 'failure' }],
        },
      },
      expect: {
        state: 'gate-red',
        code: 'CI_FAILED',
        failedChecks: ['external/scan'],
      },
    },
    {
      name: 'an errored status context blocks the floor',
      input: {
        ...heads,
        ci: { statuses: [{ context: 'external/scan', state: 'error' }] },
      },
      expect: { state: 'gate-red', code: 'CI_FAILED' },
    },
    {
      name: 'a pending check run awaits CI',
      input: {
        ...heads,
        ci: { checks: [{ name: 'validate', status: 'in_progress', conclusion: null }] },
      },
      expect: { state: 'awaiting-ci', code: 'CI_PENDING' },
    },
    {
      name: 'a pending status context awaits CI',
      input: {
        ...heads,
        ci: { statuses: [{ context: 'external/scan', state: 'pending' }] },
      },
      expect: { state: 'awaiting-ci', code: 'CI_PENDING' },
    },
    {
      name: 'incomplete check-run pagination fails closed',
      input: { ...heads, ci: { checks: [green], complete: false } },
      expect: {
        state: 'awaiting-ci',
        code: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
        evidenceCode: 'CHECK_RUN_PAGINATION_INCOMPLETE',
      },
    },
    {
      name: 'status evidence for the wrong head fails closed',
      input: { ...heads, ci: { statusSha: OTHER } },
      expect: {
        state: 'awaiting-ci',
        code: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
        evidenceCode: 'STATUS_EVIDENCE_INCOMPLETE',
      },
    },
    {
      name: 'a possibly truncated status page fails closed',
      input: {
        ...heads,
        ci: {
          statuses: Array.from({ length: 100 }, (_, index) => ({
            context: `context-${index}`,
            state: 'success',
          })),
        },
      },
      expect: {
        state: 'awaiting-ci',
        code: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
        evidenceCode: 'STATUS_EVIDENCE_INCOMPLETE',
      },
    },
    {
      name: 'duplicate status contexts fail closed',
      input: {
        ...heads,
        ci: {
          statuses: [
            { context: 'agentic/gate', state: 'success' },
            { context: 'agentic/gate', state: 'success' },
          ],
        },
      },
      expect: {
        state: 'awaiting-ci',
        code: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
        evidenceCode: 'STATUS_EVIDENCE_INVALID',
      },
    },
    {
      name: 'check evidence that changes between reads fails closed',
      input: {
        ...heads,
        ci: {
          checks: [green],
          secondChecks: [{ ...green, conclusion: 'failure' }],
        },
      },
      expect: {
        state: 'awaiting-ci',
        code: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
        evidenceCode: 'LIVE_DELIVERY_EVIDENCE_CHANGED',
      },
    },
    {
      name: 'status evidence that changes between reads fails closed',
      input: {
        ...heads,
        ci: {
          statuses: [{ context: 'agentic/gate', state: 'success' }],
          secondStatuses: [{ context: 'agentic/gate', state: 'pending' }],
        },
      },
      expect: {
        state: 'awaiting-ci',
        code: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
        evidenceCode: 'LIVE_DELIVERY_EVIDENCE_CHANGED',
      },
    },
    {
      name: 'a check run bound to another head fails closed',
      input: {
        ...heads,
        ci: { checks: [{ ...green, headOid: OTHER }] },
      },
      expect: {
        state: 'awaiting-ci',
        code: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
        evidenceCode: 'CHECK_RUN_EVIDENCE_INVALID',
      },
    },
    {
      name: 'delivered evidence carries a stable provenance fingerprint',
      input: {
        ...heads,
        ci: {
          checks: [green],
          statuses: [{ context: 'agentic/gate', state: 'success' }],
        },
      },
      expect: { state: 'delivered', code: 'CI_GREEN' },
      verify: (outcome, repeat) => (
        /^[0-9a-f]{64}$/u.test(
          outcome.liveEvidence?.provenance?.evidenceFingerprint ?? '',
        )
        && outcome.liveEvidence.provenance.evidenceFingerprint
          === repeat.liveEvidence?.provenance?.evidenceFingerprint
      ),
    },
    {
      name: 'a closed unmerged pull request fails closed',
      input: {
        schemaVersion: 1,
        repository: 'owner/repository',
        pullRequest: 12,
        ...heads,
      },
      context: {
        githubFixture: {
          pullRequest: {
            number: 12,
            headOid: HEAD,
            baseRefName: 'main',
            state: 'closed',
            merged: false,
          },
          checks: [],
          statuses: [],
        },
      },
      repositoryFixture: true,
      expect: {
        state: 'awaiting-ci',
        code: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
        evidenceCode: 'PULL_REQUEST_EVIDENCE_INVALID',
      },
    },
    {
      name: 'a pull request that changes between reads fails closed',
      input: {
        schemaVersion: 1,
        repository: 'owner/repository',
        pullRequest: 12,
        ...heads,
      },
      context: {
        githubFixture: {
          pullRequest: { number: 12, headOid: HEAD, baseRefName: 'main' },
          secondPullRequest: { number: 12, headOid: HEAD, baseRefName: 'release' },
          checks: [],
          statuses: [],
        },
      },
      repositoryFixture: true,
      expect: {
        state: 'awaiting-ci',
        code: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
        evidenceCode: 'LIVE_DELIVERY_EVIDENCE_CHANGED',
      },
    },
  ];

  let failures = 0;
  for (const fixture of cases) {
    let outcome;
    let repeat;
    if (fixture.raw === true) {
      outcome = finalizeHead(fixture.input, {});
      repeat = outcome;
    } else if (
      fixture.input.remoteHead !== undefined
      || fixture.input.ci !== undefined
      || 'repository' in fixture.input
    ) {
      const resolved = liveFixture({
        input: fixture.input,
        context: fixture.context ?? {},
      });
      outcome = finalizeHead(resolved.input, resolved.context);
      const repeated = liveFixture({
        input: fixture.input,
        context: fixture.context ?? {},
      });
      repeat = finalizeHead(repeated.input, repeated.context);
    } else {
      outcome = finalizeHead({
        schemaVersion: 1,
        repository: 'owner/repository',
        pullRequest: 12,
        ...fixture.input,
      }, {});
      repeat = outcome;
    }
    const mismatched = Object.entries(fixture.expect).filter(([key, value]) =>
      stableJson(outcome?.[key]) !== stableJson(value));
    const verified = fixture.verify === undefined || fixture.verify(outcome, repeat);
    const deliveredConsistent =
      outcome?.canMarkDelivered === (outcome?.state === 'delivered');
    if (mismatched.length > 0 || !verified || !deliveredConsistent) {
      failures += 1;
      console.error(`FAIL ${fixture.name}: ${JSON.stringify(outcome)}`);
    }
  }
  console.log(failures === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures}/${cases.length})`);
  return failures === 0;
}

function parseCli(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { mode: 'self-test' };
  }
  if (
    args.length === 2
    && args[0] === '--live'
    && typeof args[1] === 'string'
    && isAbsolute(args[1])
  ) {
    return { mode: 'live', repositoryRoot: args[1] };
  }
  return null;
}

function main() {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed?.mode === 'self-test') process.exit(selfTest() ? 0 : 1);
  if (parsed?.mode !== 'live') {
    console.error('usage: delivery-contract.mjs --live <absolute-repository-root>');
    process.exit(2);
  }
  let input;
  try {
    const source = readFileSync(0);
    if (source.length === 0 || source.length > 64 * 1024) throw new Error('invalid input size');
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source));
  } catch {
    process.stdout.write(`${JSON.stringify(result('error', 'INVALID_DELIVERY_INPUT'))}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(finalizeHead(input, {
    repositoryRoot: parsed.repositoryRoot,
  }))}\n`);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
