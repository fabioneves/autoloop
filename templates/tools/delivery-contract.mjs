#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;
const GREEN_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CI_POLICY_PATH = '.autoloop/ci-policy.json';
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_CHECK_RUNS = 10_000;
const MAX_BRANCH_RULES = 10_000;
const BRANCH_RULE_PAGE_SIZE = 100;
const WORKFLOW_CHECKS = new Set([
  'agentic/gate',
  'agentic/human-authorization',
  'agentic/ownership',
  'agentic/policy',
  'agentic/review',
]);
const DELIVERY_INPUT_KEYS = [
  'committedHead',
  'gatedHead',
  'pullRequest',
  'repository',
  'reviewedHead',
  'schemaVersion',
];
const TEST_GITHUB_JSON = Symbol('testGithubJson');
const GIT_ENV = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
});
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

function classifyCheck(check) {
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

export function fingerprintRequiredChecks(requiredChecks) {
  if (
    !Array.isArray(requiredChecks)
    || requiredChecks.some((name) => typeof name !== 'string' || name.length === 0)
    || new Set(requiredChecks).size !== requiredChecks.length
  ) {
    return null;
  }
  return createHash('sha256')
    .update(JSON.stringify([...requiredChecks].sort()))
    .digest('hex');
}

export function canonicalCiPolicy(requiredChecks) {
  if (fingerprintRequiredChecks(requiredChecks) === null) return null;
  return `${JSON.stringify({
    schemaVersion: 1,
    requiredChecks: [...requiredChecks].sort(),
  }, null, 2)}\n`;
}

export function parseCiPolicy(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (bytes.length === 0 || bytes.length > MAX_POLICY_BYTES) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || Object.keys(parsed).sort().join('\0')
      !== ['requiredChecks', 'schemaVersion'].sort().join('\0')
    || parsed.schemaVersion !== 1
  ) {
    return null;
  }
  const canonical = canonicalCiPolicy(parsed.requiredChecks);
  if (canonical === null || canonical !== text) return null;
  return Object.freeze({
    schemaVersion: 1,
    requiredChecks: Object.freeze([...parsed.requiredChecks]),
  });
}

function runGit(repositoryRoot, args, encoding = 'buffer') {
  return execFileSync(
    'git',
    ['--no-replace-objects', '-C', repositoryRoot, ...args],
    {
      encoding,
      env: GIT_ENV,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    },
  );
}

function exactRepositoryRoot(candidate) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return null;
  let lexicalRoot;
  let realRoot;
  try {
    lexicalRoot = resolve(candidate);
    realRoot = realpathSync(candidate);
  } catch {
    return null;
  }
  if (lexicalRoot !== realRoot) return null;
  try {
    const declaredRoot = runGit(realRoot, ['rev-parse', '--show-toplevel'], 'utf8').trim();
    if (
      !isAbsolute(declaredRoot)
      || resolve(declaredRoot) !== realRoot
      || realpathSync(declaredRoot) !== realRoot
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return realRoot;
}

function repositorySlugFromRemote(remote) {
  if (typeof remote !== 'string') return null;
  const match = remote.trim().match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u,
  );
  if (!match) return null;
  const slug = `${match[1]}/${match[2]}`;
  return REPOSITORY_RE.test(slug) ? slug : null;
}

function loadBoundCiPolicy(remoteHead, repository, repositoryRoot) {
  const root = exactRepositoryRoot(repositoryRoot);
  if (root === null) return { ok: false, code: 'CI_POLICY_REPOSITORY_INVALID' };
  let head;
  let objectType;
  let remote;
  try {
    head = runGit(root, ['rev-parse', '--verify', 'HEAD'], 'utf8').trim();
    objectType = runGit(root, ['cat-file', '-t', remoteHead], 'utf8').trim();
    remote = runGit(root, ['remote', 'get-url', 'origin'], 'utf8').trim();
  } catch {
    return { ok: false, code: 'CI_POLICY_HEAD_UNAVAILABLE' };
  }
  if (repositorySlugFromRemote(remote) !== repository) {
    return { ok: false, code: 'CI_POLICY_REPOSITORY_MISMATCH' };
  }
  if (head !== remoteHead || objectType !== 'commit') {
    return { ok: false, code: 'CI_POLICY_HEAD_MISMATCH' };
  }

  let treeEntry;
  try {
    treeEntry = runGit(
      root,
      ['ls-tree', '-z', remoteHead, '--', CI_POLICY_PATH],
    ).toString('utf8');
  } catch {
    return { ok: false, code: 'CI_POLICY_TREE_UNAVAILABLE' };
  }
  const match = treeEntry.match(
    /^100644 blob ([0-9a-f]{40})\t\.autoloop\/ci-policy\.json\0$/u,
  );
  if (!match) return { ok: false, code: 'CI_POLICY_TREE_ENTRY_INVALID' };

  const policyPath = resolve(root, CI_POLICY_PATH);
  const policyDirectory = dirname(policyPath);
  try {
    const directoryStats = lstatSync(policyDirectory);
    const fileStats = lstatSync(policyPath);
    if (
      !directoryStats.isDirectory()
      || directoryStats.isSymbolicLink()
      || !fileStats.isFile()
      || fileStats.isSymbolicLink()
      || realpathSync(policyDirectory) !== policyDirectory
      || realpathSync(policyPath) !== policyPath
      || !policyPath.startsWith(`${root}${sep}`)
    ) {
      return { ok: false, code: 'CI_POLICY_PATH_INVALID' };
    }
  } catch {
    return { ok: false, code: 'CI_POLICY_PATH_INVALID' };
  }

  let committedSource;
  let checkoutSource;
  try {
    committedSource = runGit(root, ['cat-file', 'blob', match[1]]);
    checkoutSource = readFileSync(policyPath);
  } catch {
    return { ok: false, code: 'CI_POLICY_SOURCE_UNAVAILABLE' };
  }
  if (!committedSource.equals(checkoutSource)) {
    return { ok: false, code: 'CI_POLICY_CHECKOUT_STALE' };
  }
  const policy = parseCiPolicy(committedSource);
  if (policy === null) return { ok: false, code: 'CI_POLICY_MALFORMED' };
  return {
    ok: true,
    policy,
    evidence: Object.freeze({
      path: CI_POLICY_PATH,
      blobOid: match[1],
      sourceFingerprint: createHash('sha256').update(committedSource).digest('hex'),
      requiredChecksFingerprint: fingerprintRequiredChecks(policy.requiredChecks),
      repository,
    }),
  };
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

function githubNotFound(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .filter((value) => typeof value === 'string' || Buffer.isBuffer(value))
    .some((value) => /\bHTTP(?:\/[0-9.]+)?[ \t]+404\b/iu.test(String(value)));
}

function githubRestJson(
  repository,
  endpoint,
  options = {},
  execute = execFileSync,
) {
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
  } catch (error) {
    if (options.allowNotFound === true && githubNotFound(error)) return null;
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
    || !Number.isSafeInteger(value?.app?.id)
    || value.app.id < 1
  ) {
    evidenceFailure('CHECK_RUN_EVIDENCE_INVALID');
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    headOid: value.head_sha,
    status: value.status.toUpperCase(),
    conclusion: value.conclusion === null ? null : value.conclusion.toUpperCase(),
    appId: value.app.id,
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

function addRequiredCheck(checks, name, appId) {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.length > 255
    || !Number.isSafeInteger(appId)
    || appId < 1
  ) {
    evidenceFailure('REQUIRED_CHECK_PRODUCER_UNPINNED');
  }
  const existing = checks.get(name);
  if (existing !== undefined && existing !== appId) {
    evidenceFailure('REQUIRED_CHECK_PRODUCER_AMBIGUOUS');
  }
  checks.set(name, appId);
}

function freezeRequiredChecks(checks) {
  return Object.freeze(
    [...checks.entries()]
      .map(([name, appId]) => Object.freeze({ name, appId }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}

function normalizeRequiredCheckRules(value) {
  if (!Array.isArray(value)) evidenceFailure('REQUIRED_CHECK_RULES_INCOMPLETE');
  const checks = new Map();
  for (const rule of value) {
    if (typeof rule?.type !== 'string') {
      evidenceFailure('REQUIRED_CHECK_RULES_INCOMPLETE');
    }
    if (rule.type !== 'required_status_checks') continue;
    if (!Array.isArray(rule?.parameters?.required_status_checks)) {
      evidenceFailure('REQUIRED_CHECK_RULES_INCOMPLETE');
    }
    for (const check of rule.parameters.required_status_checks) {
      addRequiredCheck(checks, check?.context, check?.integration_id);
    }
  }
  return freezeRequiredChecks(checks);
}

function normalizeClassicBranchProtection(value) {
  if (value === null) return Object.freeze([]);
  if (typeof value !== 'object' || Array.isArray(value)) {
    evidenceFailure('CLASSIC_BRANCH_PROTECTION_INCOMPLETE');
  }
  const required = value.required_status_checks;
  if (required === null) return Object.freeze([]);
  if (
    typeof required !== 'object'
    || Array.isArray(required)
    || typeof required.strict !== 'boolean'
    || !Array.isArray(required.contexts)
    || !Array.isArray(required.checks)
  ) {
    evidenceFailure('CLASSIC_BRANCH_PROTECTION_INCOMPLETE');
  }
  const contexts = required.contexts;
  const checks = new Map();
  if (
    contexts.some((context) =>
      typeof context !== 'string'
      || context.length === 0
      || context.length > 255)
    || new Set(contexts).size !== contexts.length
  ) {
    evidenceFailure('CLASSIC_BRANCH_PROTECTION_INCOMPLETE');
  }
  for (const check of required.checks) {
    addRequiredCheck(checks, check?.context, check?.app_id);
  }
  if (
    checks.size !== contexts.length
    || contexts.some((context) => !checks.has(context))
  ) {
    evidenceFailure('CLASSIC_BRANCH_PROTECTION_INCOMPLETE');
  }
  return freezeRequiredChecks(checks);
}

function mergeRequiredChecks(...sources) {
  const checks = new Map();
  for (const source of sources) {
    for (const check of source) addRequiredCheck(checks, check.name, check.appId);
  }
  return freezeRequiredChecks(checks);
}

function sameEvidence(left, right) {
  return fingerprint(left) === fingerprint(right);
}

function deliveryEvidenceBinding(evidence) {
  const requiredChecks = evidence.requiredChecks.filter(
    (check) => !WORKFLOW_CHECKS.has(check.name),
  );
  const identities = new Set(
    requiredChecks.map((check) => `${check.name}\0${check.appId}`),
  );
  return {
    schemaVersion: evidence.schemaVersion,
    source: evidence.source,
    repository: evidence.repository,
    pullRequest: evidence.pullRequest,
    remoteHead: evidence.remoteHead,
    baseRefName: evidence.baseRefName,
    requiredChecks,
    checks: evidence.checks.filter(
      (check) => identities.has(`${check.name}\0${check.appId}`),
    ),
  };
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

function fetchRequiredCheckRules(repository, baseRefName, fetchJson) {
  const endpoint =
    `repos/${repository}/rules/branches/${encodeURIComponent(baseRefName)}`
    + `?per_page=${BRANCH_RULE_PAGE_SIZE}`;
  const rules = [];
  const identities = new Set();
  const maximumPages =
    Math.ceil(MAX_BRANCH_RULES / BRANCH_RULE_PAGE_SIZE) + 1;
  for (let page = 1; page <= maximumPages; page += 1) {
    const values = fetchJson(repository, `${endpoint}&page=${page}`);
    if (
      !Array.isArray(values)
      || values.length > BRANCH_RULE_PAGE_SIZE
      || rules.length + values.length > MAX_BRANCH_RULES
    ) {
      evidenceFailure('REQUIRED_CHECK_RULE_PAGINATION_INCOMPLETE');
    }
    for (const rule of values) {
      const identity = stableJson(rule);
      if (identities.has(identity)) {
        evidenceFailure('REQUIRED_CHECK_RULE_PAGINATION_INCOMPLETE');
      }
      identities.add(identity);
      rules.push(rule);
    }
    if (values.length < BRANCH_RULE_PAGE_SIZE) {
      return normalizeRequiredCheckRules(rules);
    }
  }
  return evidenceFailure('REQUIRED_CHECK_RULE_PAGINATION_INCOMPLETE');
}

function fetchClassicRequiredChecks(repository, baseRefName, fetchJson) {
  const endpoint =
    `repos/${repository}/branches/${encodeURIComponent(baseRefName)}/protection`;
  return normalizeClassicBranchProtection(
    fetchJson(repository, endpoint, { allowNotFound: true }),
  );
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
  const firstRules = fetchRequiredCheckRules(
    request.repository,
    firstPullRequest.baseRefName,
    fetchJson,
  );
  const firstClassic = fetchClassicRequiredChecks(
    request.repository,
    firstPullRequest.baseRefName,
    fetchJson,
  );
  const secondChecks = fetchCheckRuns(
    request.repository,
    firstPullRequest.headOid,
    fetchJson,
  );
  const secondRules = fetchRequiredCheckRules(
    request.repository,
    firstPullRequest.baseRefName,
    fetchJson,
  );
  const secondClassic = fetchClassicRequiredChecks(
    request.repository,
    firstPullRequest.baseRefName,
    fetchJson,
  );
  const secondPullRequest = normalizePullRequest(
    fetchJson(request.repository, pullRequestEndpoint),
    request,
  );
  if (
    !sameEvidence(firstPullRequest, secondPullRequest)
    || !sameEvidence(firstChecks, secondChecks)
    || !sameEvidence(firstRules, secondRules)
    || !sameEvidence(firstClassic, secondClassic)
  ) {
    evidenceFailure('LIVE_DELIVERY_EVIDENCE_CHANGED');
  }
  const evidence = {
    schemaVersion: 1,
    source: 'github-rest',
    repository: request.repository,
    pullRequest: request.pullRequest,
    remoteHead: firstPullRequest.headOid,
    baseRefName: firstPullRequest.baseRefName,
    draft: firstPullRequest.draft,
    requiredChecks: mergeRequiredChecks(firstRules, firstClassic),
    checks: firstChecks,
  };
  return Object.freeze({
    ...evidence,
    provenance: Object.freeze({
      schemaVersion: 1,
      source: 'github-rest',
      repository: request.repository,
      pullRequest: request.pullRequest,
      evidenceFingerprint: fingerprint(deliveryEvidenceBinding(evidence)),
    }),
  });
}

function classifyObservedChecks(observation, policy, policyEvidence) {
  const policyNames = [...policy.requiredChecks].sort();
  const ciRequirements = observation.requiredChecks.filter(
    (check) => !WORKFLOW_CHECKS.has(check.name),
  );
  const liveNames = ciRequirements.map((check) => check.name);
  if (fingerprintRequiredChecks(policyNames) !== fingerprintRequiredChecks(liveNames)) {
    return result('awaiting-ci', 'CI_REQUIREMENTS_MISMATCH', {
      headOid: observation.remoteHead,
      requirementsPolicy: policyEvidence,
      liveEvidence: observation,
    });
  }

  const missingChecks = [];
  const ambiguousChecks = [];
  const untrustedChecks = [];
  const requiredChecks = [];
  for (const requirement of ciRequirements) {
    const matching = observation.checks.filter((check) => check.name === requirement.name);
    if (matching.length === 0) missingChecks.push(requirement.name);
    else if (matching.length !== 1) ambiguousChecks.push(requirement.name);
    else if (matching[0].appId !== requirement.appId) untrustedChecks.push(requirement.name);
    else requiredChecks.push(matching[0]);
  }
  if (untrustedChecks.length > 0) {
    return result('awaiting-ci', 'CI_REQUIRED_CHECK_PRODUCER_MISMATCH', {
      headOid: observation.remoteHead,
      untrustedChecks,
      liveEvidence: observation,
    });
  }
  if (ambiguousChecks.length > 0) {
    return result('awaiting-ci', 'CI_REQUIRED_CHECK_AMBIGUOUS', {
      headOid: observation.remoteHead,
      ambiguousChecks,
      liveEvidence: observation,
    });
  }
  if (missingChecks.length > 0) {
    return result('awaiting-ci', 'CI_REQUIRED_CHECK_MISSING', {
      headOid: observation.remoteHead,
      missingChecks,
      liveEvidence: observation,
    });
  }
  const failedChecks = [];
  let pending = false;
  for (const check of requiredChecks) {
    const classification = classifyCheck(check);
    if (classification === 'pending') pending = true;
    if (classification === 'failed') failedChecks.push(check.name);
  }
  if (failedChecks.length > 0) {
    return result('gate-red', 'CI_FAILED', {
      headOid: observation.remoteHead,
      failedChecks,
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
    policyNames.length === 0 ? 'NO_REQUIRED_CI' : 'CI_GREEN',
    {
      headOid: observation.remoteHead,
      requirementsPolicy: Object.freeze({
        ...policyEvidence,
        producerBindings: ciRequirements,
        producerBindingsFingerprint: fingerprint(ciRequirements),
      }),
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

  const requirementsPolicy = loadBoundCiPolicy(
    observation.remoteHead,
    request.repository,
    context.repositoryRoot ?? process.cwd(),
  );
  if (!requirementsPolicy.ok) {
    return result('awaiting-ci', 'CI_REQUIREMENTS_UNPROVEN', {
      headOid: observation.remoteHead,
      policyCode: requirementsPolicy.code,
      liveEvidence: observation,
    });
  }
  return classifyObservedChecks(
    observation,
    requirementsPolicy.policy,
    requirementsPolicy.evidence,
  );
}

function commitFixture(source, kind = 'file') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoloop-delivery-')));
  runGit(root, ['init', '-q']);
  runGit(root, ['remote', 'add', 'origin', 'https://github.com/owner/repository.git']);
  if (kind === 'file') {
    mkdirSync(resolve(root, '.autoloop'));
    writeFileSync(resolve(root, CI_POLICY_PATH), source);
  } else if (kind === 'missing') {
    writeFileSync(resolve(root, 'README.md'), 'fixture\n');
  } else if (kind === 'symlink-file') {
    mkdirSync(resolve(root, '.autoloop'));
    writeFileSync(resolve(root, 'policy-target.json'), source);
    symlinkSync('../policy-target.json', resolve(root, CI_POLICY_PATH));
  } else if (kind === 'symlink-directory') {
    mkdirSync(resolve(root, 'outside'));
    writeFileSync(resolve(root, 'outside', 'ci-policy.json'), source);
    symlinkSync('outside', resolve(root, '.autoloop'));
  }
  runGit(root, ['add', '--all']);
  runGit(root, [
    '-c',
    'user.name=Autoloop Test',
    '-c',
    'user.email=autoloop@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  return {
    root,
    head: runGit(root, ['rev-parse', 'HEAD'], 'utf8').trim(),
  };
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
      conclusion: check.conclusion,
      app: check.appId === undefined ? undefined : { id: check.appId },
    }));
    const ruleValues = (values, malformed) => {
      if (malformed === true) return {};
      return (values?.length ?? 0) === 0
        ? []
        : [{
            type: 'required_status_checks',
            parameters: {
              required_status_checks: values.map((check) => ({
                context: check.name,
                integration_id: check.appId,
              })),
            },
          }];
    };
    const protectionValue = (values, malformed) => {
      if (malformed === true) return { required_status_checks: {} };
      if (values === undefined) return null;
      return {
        required_status_checks: {
          strict: true,
          contexts: values.map((check) => check.name),
          checks: values.map((check) => ({
            context: check.name,
            app_id: check.appId,
          })),
        },
      };
    };
    let pullRequestReads = 0;
    let checkSnapshotReads = 0;
    let useSecondChecks = false;
    let ruleSnapshotReads = 0;
    let useSecondRules = false;
    let protectionReads = 0;
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
        if (page === 1) {
          useSecondChecks = checkSnapshotReads > 0;
          checkSnapshotReads += 1;
        }
        const values = useSecondChecks && fixture.secondChecks
          ? fixture.secondChecks
          : fixture.checks;
        const allChecks = checkValues(values);
        const checks = allChecks.slice((page - 1) * 100, page * 100);
        return {
          total_count:
            fixture.checksIncomplete === true ? allChecks.length + 1 : allChecks.length,
          check_runs: checks,
        };
      }
      if (endpoint.includes('/rules/branches/')) {
        const pageMatch = endpoint.match(/[?&]page=(\d+)$/u);
        const page = pageMatch === null ? 1 : Number(pageMatch[1]);
        const pageSize = endpoint.includes('per_page=100') ? 100 : 30;
        if (!Number.isSafeInteger(page) || page < 1) {
          throw new Error(`invalid fixture rule page ${endpoint}`);
        }
        if (page === 1) {
          useSecondRules = ruleSnapshotReads > 0;
          ruleSnapshotReads += 1;
        }
        const firstRules = fixture.rules
          ?? ruleValues(fixture.requiredChecks, fixture.rulesMalformed);
        const secondRules = fixture.secondRules
          ?? ruleValues(fixture.secondRequiredChecks, fixture.rulesMalformed);
        const rules = useSecondRules && (
          fixture.secondRules !== undefined
          || fixture.secondRequiredChecks !== undefined
        )
          ? secondRules
          : firstRules;
        if (!Array.isArray(rules)) return rules;
        return rules.slice((page - 1) * pageSize, page * pageSize);
      }
      if (endpoint.endsWith('/protection')) {
        const second = protectionReads > 0 && (
          fixture.secondBranchProtection !== undefined
          || fixture.secondClassicRequiredChecks !== undefined
        );
        protectionReads += 1;
        if (second) {
          return fixture.secondBranchProtection
            ?? protectionValue(
              fixture.secondClassicRequiredChecks,
              fixture.branchProtectionMalformed,
            );
        }
        return fixture.branchProtection
          ?? protectionValue(
            fixture.classicRequiredChecks,
            fixture.branchProtectionMalformed,
          );
      }
      throw new Error(`unexpected fixture endpoint ${endpoint}`);
    };
  }

  function liveFixture(fixture) {
    if (fixture.name === 'caller-composed remote and CI observations cannot finalize delivery') {
      return fixture;
    }
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
    const checks = Array.isArray(ci.checks)
      ? ci.checks.map((check, index) => ({
          id: index + 101,
          name: check.name ?? check.context,
          status: check.status,
          conclusion: check.conclusion,
          headOid: check.headOid ?? remoteHead,
          appId: 15368,
        }))
      : [];
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
          requiredChecks: Array.isArray(ci.requiredChecks)
            ? ci.requiredChecks.map((name) => ({ name, appId: 15368 }))
            : [],
          checks,
          checksIncomplete: ci.complete !== true,
          rulesMalformed: ci.requirementsComplete !== true,
        }),
      },
    };
  }

  const empty = commitFixture(canonicalCiPolicy([]));
  const missing = commitFixture('', 'missing');
  const mismatched = commitFixture(canonicalCiPolicy(['test']));
  const subset = commitFixture(canonicalCiPolicy(['lint', 'test']));
  const malformed = commitFixture('{"schemaVersion":1,"requiredChecks":[]}\n');
  const manyRequiredNames = Array.from(
    { length: 101 },
    (_, index) => `required-${String(index + 1).padStart(3, '0')}`,
  );
  const manyRequired = commitFixture(canonicalCiPolicy(manyRequiredNames));
  const requiredRule = (name, appId = 15368, rulesetId = 1) => ({
    type: 'required_status_checks',
    ruleset_id: rulesetId,
    parameters: {
      required_status_checks: [{ context: name, integration_id: appId }],
    },
  });
  const stale = commitFixture(canonicalCiPolicy([]));
  writeFileSync(resolve(stale.root, CI_POLICY_PATH), canonicalCiPolicy(['test']));
  const wrongHead = commitFixture(canonicalCiPolicy([]));
  const wrongRemoteHead = wrongHead.head;
  writeFileSync(resolve(wrongHead.root, 'later.txt'), 'later\n');
  runGit(wrongHead.root, ['add', 'later.txt']);
  runGit(wrongHead.root, [
    '-c',
    'user.name=Autoloop Test',
    '-c',
    'user.email=autoloop@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'later',
  ]);
  const symlinkFile = commitFixture(canonicalCiPolicy([]), 'symlink-file');
  const symlinkDirectory = commitFixture(canonicalCiPolicy([]), 'symlink-directory');
  const fixtureRoots = [
    empty.root,
    missing.root,
    mismatched.root,
    subset.root,
    malformed.root,
    manyRequired.root,
    stale.root,
    wrongHead.root,
    symlinkFile.root,
    symlinkDirectory.root,
  ];
  const sha = empty.head;
  const testSha = mismatched.head;
  const other = 'b'.repeat(40);
  let terminalBindingFingerprint = null;
  const cases = [
    {
      name: 'caller-composed remote and CI observations cannot finalize delivery',
      input: {
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        remoteHead: testSha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: testSha,
          checks: [{
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: testSha,
            id: 101,
            appId: 15368,
          }],
        },
      },
      context: { repositoryRoot: mismatched.root },
      expected: 'error',
      expectedCode: 'INVALID_DELIVERY_INPUT',
    },
    {
      name: 'required CheckRun without a database ID cannot finalize delivery',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: testSha, baseRefName: 'main' },
          requiredChecks: [{ name: 'test', appId: 15368 }],
          checks: [{
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: testSha,
            appId: 15368,
          }],
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
      expectedEvidenceCode: 'CHECK_RUN_EVIDENCE_INVALID',
    },
    {
      name: 'required CheckRun from a producer other than the server pin cannot finalize delivery',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: testSha, baseRefName: 'main' },
          requiredChecks: [{ name: 'test', appId: 15368 }],
          checks: [{
            id: 101,
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: testSha,
            appId: 99999,
          }],
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'CI_REQUIRED_CHECK_PRODUCER_MISMATCH',
    },
    {
      name: 'classic branch-protection required checks authorize exact-head delivery',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: testSha, baseRefName: 'main' },
          requiredChecks: [],
          classicRequiredChecks: [{ name: 'test', appId: 15368 }],
          checks: [{
            id: 101,
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: testSha,
            appId: 15368,
          }],
        },
      },
      expected: 'delivered',
      expectedCode: 'CI_GREEN',
    },
    {
      name: 'missing classic branch-protection check cannot finalize delivery',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: testSha, baseRefName: 'main' },
          requiredChecks: [],
          classicRequiredChecks: [{ name: 'test', appId: 15368 }],
          checks: [],
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'CI_REQUIRED_CHECK_MISSING',
    },
    {
      name: 'classic branch-protection drift cannot authorize delivery',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: testSha, baseRefName: 'main' },
          requiredChecks: [],
          classicRequiredChecks: [{ name: 'test', appId: 15368 }],
          secondClassicRequiredChecks: [{ name: 'test', appId: 99999 }],
          checks: [{
            id: 101,
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: testSha,
            appId: 15368,
          }],
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
      expectedEvidenceCode: 'LIVE_DELIVERY_EVIDENCE_CHANGED',
    },
    {
      name: 'classic branch-protection context without a producer pin is rejected',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: testSha, baseRefName: 'main' },
          requiredChecks: [],
          classicRequiredChecks: [{ name: 'test', appId: null }],
          checks: [],
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
      expectedEvidenceCode: 'REQUIRED_CHECK_PRODUCER_UNPINNED',
    },
    {
      name: 'CheckRun mutation between complete live reads cannot finalize delivery',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: testSha, baseRefName: 'main' },
          requiredChecks: [{ name: 'test', appId: 15368 }],
          checks: [{
            id: 101,
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: testSha,
            appId: 15368,
          }],
          secondChecks: [{
            id: 102,
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: testSha,
            appId: 15368,
          }],
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
      expectedEvidenceCode: 'LIVE_DELIVERY_EVIDENCE_CHANGED',
    },
    {
      name: 'server-required context without a producer pin cannot finalize delivery',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: testSha, baseRefName: 'main' },
          requiredChecks: [{ name: 'test', appId: null }],
          checks: [],
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
      expectedEvidenceCode: 'REQUIRED_CHECK_PRODUCER_UNPINNED',
    },
    {
      name: 'duplicate current-head required CheckRuns cannot finalize delivery',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: testSha, baseRefName: 'main' },
          requiredChecks: [{ name: 'test', appId: 15368 }],
          checks: [
            {
              id: 101,
              name: 'test',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              headOid: testSha,
              appId: 15368,
            },
            {
              id: 102,
              name: 'test',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              headOid: testSha,
              appId: 15368,
            },
          ],
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'CI_REQUIRED_CHECK_AMBIGUOUS',
    },
    {
      name: 'incomplete CheckRun pagination cannot finalize delivery',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: testSha, baseRefName: 'main' },
          requiredChecks: [{ name: 'test', appId: 15368 }],
          checks: [],
          checksIncomplete: true,
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
      expectedEvidenceCode: 'CHECK_RUN_PAGINATION_INCOMPLETE',
    },
    {
      name: 'all numbered CheckRun pages are retained in delivered evidence',
      input: {
        schemaVersion: 1,
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: empty.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: sha, baseRefName: 'main' },
          requiredChecks: [],
          checks: Array.from({ length: 101 }, (_, index) => ({
            id: index + 1,
            name: `check-${index + 1}`,
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: sha,
            appId: 15368,
          })),
        },
      },
      expected: 'delivered',
      expectedCode: 'NO_REQUIRED_CI',
      verify: (actual) => (
        actual.liveEvidence?.checks?.length === 101
        && actual.liveEvidence.checks[100].id === 101
      ),
    },
    {
      name: 'all numbered active branch-rule pages authorize required CI',
      input: {
        schemaVersion: 1,
        committedHead: manyRequired.head,
        reviewedHead: manyRequired.head,
        gatedHead: manyRequired.head,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: manyRequired.root,
        githubFixture: {
          pullRequest: {
            number: 12,
            headOid: manyRequired.head,
            baseRefName: 'main',
          },
          rules: manyRequiredNames.map((name, index) =>
            requiredRule(name, 15368, index + 1)),
          checks: manyRequiredNames.map((name, index) => ({
            id: index + 1,
            name,
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: manyRequired.head,
            appId: 15368,
          })),
        },
      },
      expected: 'delivered',
      expectedCode: 'CI_GREEN',
      verify: (actual) => (
        actual.liveEvidence?.requiredChecks?.length === 101
        && actual.liveEvidence.requiredChecks[100].name === 'required-101'
      ),
    },
    {
      name: 'active branch-rule drift on a later page cannot authorize delivery',
      input: {
        schemaVersion: 1,
        committedHead: manyRequired.head,
        reviewedHead: manyRequired.head,
        gatedHead: manyRequired.head,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: manyRequired.root,
        githubFixture: {
          pullRequest: {
            number: 12,
            headOid: manyRequired.head,
            baseRefName: 'main',
          },
          rules: manyRequiredNames.map((name, index) =>
            requiredRule(name, 15368, index + 1)),
          secondRules: manyRequiredNames.map((name, index) =>
            requiredRule(
              name,
              index === 100 ? 99999 : 15368,
              index + 1,
            )),
          checks: manyRequiredNames.map((name, index) => ({
            id: index + 1,
            name,
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: manyRequired.head,
            appId: 15368,
          })),
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
      expectedEvidenceCode: 'LIVE_DELIVERY_EVIDENCE_CHANGED',
    },
    {
      name: 'repeated active branch rule across pages cannot authorize delivery',
      input: {
        schemaVersion: 1,
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: empty.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: sha, baseRefName: 'main' },
          rules: [
            ...Array.from({ length: 100 }, (_, index) => ({
              type: 'creation',
              ruleset_id: index + 1,
            })),
            { type: 'creation', ruleset_id: 100 },
          ],
          checks: [],
        },
      },
      expected: 'awaiting-ci',
      expectedCode: 'LIVE_DELIVERY_EVIDENCE_UNAVAILABLE',
      expectedEvidenceCode: 'REQUIRED_CHECK_RULE_PAGINATION_INCOMPLETE',
    },
    {
      name: 'caller-authored source fingerprint cannot replace a missing policy artifact',
      input: {
        committedHead: missing.head,
        reviewedHead: missing.head,
        gatedHead: missing.head,
        remoteHead: missing.head,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          requirementsEvidence: {
            source: 'configured-policy',
            sourceFingerprint: 'c'.repeat(64),
            requiredChecksFingerprint: fingerprintRequiredChecks([]),
          },
          headOid: missing.head,
          checks: [],
        },
      },
      context: { repositoryRoot: missing.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'configured empty required-check policy proves delivery without CI',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: sha,
          checks: [],
        },
      },
      context: { repositoryRoot: empty.root },
      expected: 'delivered',
    },
    {
      name: 'policy required checks must match the claimed required-check set',
      input: {
        committedHead: mismatched.head,
        reviewedHead: mismatched.head,
        gatedHead: mismatched.head,
        remoteHead: mismatched.head,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: mismatched.head,
          checks: [],
        },
      },
      context: { repositoryRoot: mismatched.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'caller cannot omit one configured required check',
      input: {
        committedHead: subset.head,
        reviewedHead: subset.head,
        gatedHead: subset.head,
        remoteHead: subset.head,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: subset.head,
          checks: [{
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: subset.head,
          }],
        },
      },
      context: { repositoryRoot: subset.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'noncanonical policy bytes are rejected',
      input: {
        committedHead: malformed.head,
        reviewedHead: malformed.head,
        gatedHead: malformed.head,
        remoteHead: malformed.head,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: malformed.head,
          checks: [],
        },
      },
      context: { repositoryRoot: malformed.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'stale checkout policy bytes are rejected',
      input: {
        committedHead: stale.head,
        reviewedHead: stale.head,
        gatedHead: stale.head,
        remoteHead: stale.head,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: stale.head,
          checks: [],
        },
      },
      context: { repositoryRoot: stale.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'checkout HEAD must equal the policy-bound remote head',
      input: {
        committedHead: wrongRemoteHead,
        reviewedHead: wrongRemoteHead,
        gatedHead: wrongRemoteHead,
        remoteHead: wrongRemoteHead,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: wrongRemoteHead,
          checks: [],
        },
      },
      context: { repositoryRoot: wrongHead.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'symlinked policy file is rejected',
      input: {
        committedHead: symlinkFile.head,
        reviewedHead: symlinkFile.head,
        gatedHead: symlinkFile.head,
        remoteHead: symlinkFile.head,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: symlinkFile.head,
          checks: [],
        },
      },
      context: { repositoryRoot: symlinkFile.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'symlinked policy directory cannot escape the repository path',
      input: {
        committedHead: symlinkDirectory.head,
        reviewedHead: symlinkDirectory.head,
        gatedHead: symlinkDirectory.head,
        remoteHead: symlinkDirectory.head,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: symlinkDirectory.head,
          checks: [],
        },
      },
      context: { repositoryRoot: symlinkDirectory.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'complete current-head required CI is delivered',
      input: {
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        remoteHead: testSha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: testSha,
          checks: [{
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headOid: testSha,
          }],
        },
      },
      context: { repositoryRoot: mismatched.root },
      expected: 'delivered',
      expectedCode: 'CI_GREEN',
      verify: (actual) => (
        actual.liveEvidence?.source === 'github-rest'
        && actual.liveEvidence?.repository === 'owner/repository'
        && actual.liveEvidence?.pullRequest === 12
        && actual.liveEvidence?.checks?.length === 1
        && actual.liveEvidence.checks[0].id === 101
        && actual.liveEvidence.checks[0].headOid === testSha
        && actual.liveEvidence.checks[0].appId === 15368
        && /^[0-9a-f]{64}$/u.test(
          actual.liveEvidence?.provenance?.evidenceFingerprint ?? '',
        )
      ),
    },
    {
      name: 'optional failed and pending checks do not block empty-policy delivery',
      input: {
        schemaVersion: 1,
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: empty.root,
        githubFixture: {
          pullRequest: { number: 12, headOid: sha, baseRefName: 'main' },
          requiredChecks: [],
          checks: [
            {
              id: 101,
              name: 'optional-failed',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
              headOid: sha,
              appId: 15368,
            },
            {
              id: 102,
              name: 'optional-pending',
              status: 'IN_PROGRESS',
              conclusion: null,
              headOid: sha,
              appId: 15368,
            },
          ],
        },
      },
      expected: 'delivered',
      expectedCode: 'NO_REQUIRED_CI',
      verify: (actual) => actual.liveEvidence?.checks?.length === 2,
    },
    {
      name: 'optional failed and pending checks do not block required green CI',
      input: {
        schemaVersion: 1,
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: mismatched.root,
        githubFixture: {
          pullRequest: {
            number: 12,
            headOid: testSha,
            baseRefName: 'main',
          },
          requiredChecks: [{ name: 'test', appId: 15368 }],
          checks: [
            {
              id: 101,
              name: 'test',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              headOid: testSha,
              appId: 15368,
            },
            {
              id: 102,
              name: 'optional-failed',
              status: 'COMPLETED',
              conclusion: 'FAILURE',
              headOid: testSha,
              appId: 15368,
            },
            {
              id: 103,
              name: 'optional-pending',
              status: 'IN_PROGRESS',
              conclusion: null,
              headOid: testSha,
              appId: 15368,
            },
          ],
        },
      },
      expected: 'delivered',
      expectedCode: 'CI_GREEN',
      verify: (actual) => actual.liveEvidence?.checks?.length === 3,
    },
    {
      name: 'draft terminal candidate binds workflow checks without treating them as CI',
      input: {
        schemaVersion: 1,
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: empty.root,
        githubFixture: {
          pullRequest: {
            number: 12,
            headOid: sha,
            baseRefName: 'main',
            draft: true,
          },
          rules: [
            requiredRule('agentic/review', 1),
            requiredRule('agentic/gate', 1),
          ],
          checks: [
            {
              id: 101,
              name: 'agentic/review',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              headOid: sha,
              appId: 1,
            },
            {
              id: 102,
              name: 'agentic/gate',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              headOid: sha,
              appId: 1,
            },
          ],
        },
      },
      expected: 'delivered',
      expectedCode: 'NO_REQUIRED_CI',
      verify: (actual) => {
        terminalBindingFingerprint =
          actual.liveEvidence?.provenance?.evidenceFingerprint ?? null;
        return (
          actual.liveEvidence?.draft === true
          && actual.liveEvidence?.requiredChecks?.length === 2
          && /^[0-9a-f]{64}$/u.test(terminalBindingFingerprint ?? '')
        );
      },
    },
    {
      name: 'ready and policy publication preserve the terminal CI binding',
      input: {
        schemaVersion: 1,
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        repository: 'owner/repository',
        pullRequest: 12,
      },
      context: {
        repositoryRoot: empty.root,
        githubFixture: {
          pullRequest: {
            number: 12,
            headOid: sha,
            baseRefName: 'main',
            draft: false,
          },
          rules: [
            requiredRule('agentic/review', 1),
            requiredRule('agentic/gate', 1),
            requiredRule('agentic/ownership', 1),
            requiredRule('agentic/policy', 1),
          ],
          checks: [
            {
              id: 101,
              name: 'agentic/review',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              headOid: sha,
              appId: 1,
            },
            {
              id: 102,
              name: 'agentic/gate',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              headOid: sha,
              appId: 1,
            },
            {
              id: 103,
              name: 'agentic/ownership',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              headOid: sha,
              appId: 1,
            },
            {
              id: 104,
              name: 'agentic/policy',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              headOid: sha,
              appId: 1,
            },
          ],
        },
      },
      expected: 'delivered',
      expectedCode: 'NO_REQUIRED_CI',
      verify: (actual) => (
        actual.liveEvidence?.draft === false
        && actual.liveEvidence?.requiredChecks?.length === 4
        && actual.liveEvidence?.provenance?.evidenceFingerprint
          === terminalBindingFingerprint
      ),
    },
    {
      name: 'pending check produces awaiting-ci',
      input: {
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        remoteHead: testSha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: testSha,
          checks: [{
            name: 'test',
            status: 'IN_PROGRESS',
            conclusion: null,
            headOid: testSha,
          }],
        },
      },
      context: { repositoryRoot: mismatched.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'incomplete check snapshot cannot prove delivery',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: false,
          requirementsComplete: true,
          requiredChecks: [],
          checks: [],
        },
      },
      expected: 'awaiting-ci',
    },
    {
      name: 'empty fetched checks without complete requirements cannot prove no CI',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: { complete: true, headOid: sha, checks: [] },
      },
      expected: 'awaiting-ci',
    },
    {
      name: 'missing required check remains awaiting CI',
      input: {
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        remoteHead: testSha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: testSha,
          checks: [],
        },
      },
      context: { repositoryRoot: mismatched.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'failed check returns gate-red',
      input: {
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        remoteHead: testSha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: testSha,
          checks: [{
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            headOid: testSha,
          }],
        },
      },
      context: { repositoryRoot: mismatched.root },
      expected: 'gate-red',
    },
    {
      name: 'stale green check cannot prove delivery',
      input: {
        committedHead: testSha,
        reviewedHead: testSha,
        gatedHead: testSha,
        remoteHead: testSha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: testSha,
          checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headOid: other }],
        },
      },
      context: { repositoryRoot: mismatched.root },
      expected: 'awaiting-ci',
    },
    {
      name: 'remote head mismatch requires re-gate',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: other,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: other,
          checks: [],
        },
      },
      expected: 're-gate',
    },
    {
      name: 'unreviewed committed head requires another review',
      input: {
        committedHead: other,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: sha,
          checks: [],
        },
      },
      expected: 're-review',
    },
    {
      name: 'ungated reviewed head requires another gate',
      input: {
        committedHead: other,
        reviewedHead: other,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: sha,
          checks: [],
        },
      },
      expected: 're-gate',
    },
  ];
  let passed = 0;
  const liveShapedNotFound = new Error('GitHub API request failed');
  liveShapedNotFound.status = 1;
  liveShapedNotFound.stdout = '';
  liveShapedNotFound.stderr = 'gh: Branch not protected (HTTP 404)\n';
  const unitCases = [[
    'a live classic-protection 404 is authoritative absence',
    githubRestJson(
      'owner/repository',
      'repos/owner/repository/branches/main/protection',
      { allowNotFound: true },
      () => {
        throw liveShapedNotFound;
      },
    ) === null,
  ]];
  for (const [name, ok] of unitCases) {
    if (ok) passed += 1;
    else console.error(`FAIL ${name}`);
  }
  try {
    for (const sourceFixture of cases) {
      const fixture = liveFixture(sourceFixture);
      const actual = finalizeHead(fixture.input, fixture.context);
      if (
        actual.state !== fixture.expected
        || (fixture.expectedCode && actual.code !== fixture.expectedCode)
        || (
          fixture.expectedEvidenceCode
          && actual.evidenceCode !== fixture.expectedEvidenceCode
        )
        || (fixture.verify && fixture.verify(actual) !== true)
      ) {
        console.error(
          `FAIL ${fixture.name}: expected ${fixture.expected}/${fixture.expectedCode ?? '*'}`
          + `/${fixture.expectedEvidenceCode ?? '*'}, got ${actual.state}/${actual.code}`
          + `/${actual.evidenceCode ?? '*'}`,
        );
        continue;
      }
      passed += 1;
    }
  } finally {
    for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  }
  const total = cases.length + unitCases.length;
  console.log(passed === total ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${total})`);
  return passed === total;
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
