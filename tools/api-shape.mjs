#!/usr/bin/env node
// autoloop — api-shape.mjs
//
// Live GitHub API shape contract. Every tool here pins
// `X-GitHub-Api-Version`, and a pinned version is a promise about response
// SHAPE that GitHub is free to change in the next version. On 2026-07-28 that
// promise broke: version 2026-03-10 removed `merge_commit_sha` from BOTH the
// list and the single pull-request representation, so `lifecycle-driver.mjs`
// read `undefined`, and the lifecycle contract refused the terminal backfill of
// every human-merged unit with ARTIFACT_IDENTITY_MISMATCH(merge). Four shipped
// units wedged; two sessions spent an hour each proving their own state was
// consistent, because it was.
//
// No offline self-test could have caught it. A fixture encodes what we BELIEVE
// the API returns, so it agrees with the code and both are wrong together. Only
// a live probe of the pinned version can tell us the field is gone — which is
// why this runs on the release train rather than on every push.
//
// Usage:
//   node api-shape.mjs --repository <owner/repo> [--pull-request <n>] [--json]
//   node api-shape.mjs --self-test

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const API_VERSION = '2026-03-10';

// Each entry: the fact a tool reads, where it reads it, and the incident that
// earned the check. `path` is dotted; a `null` value counts as ABSENT, because
// a null merge commit is exactly as unusable as a missing key.
export const REQUIRED_FACTS = Object.freeze([
  Object.freeze({
    id: 'pull-request.head.sha',
    surface: 'rest:pulls-list',
    path: 'head.sha',
    reader: 'lifecycle-driver.mjs · merge + remote-claim facts',
  }),
  Object.freeze({
    id: 'pull-request.merged_at',
    surface: 'rest:pulls-list',
    path: 'merged_at',
    reader: 'lifecycle-driver.mjs · merged flag',
    nullable: true,
  }),
  Object.freeze({
    id: 'pull-request.base.ref',
    surface: 'rest:pulls-single',
    path: 'base.ref',
    reader: 'delivery-contract.mjs · base identity',
  }),
  Object.freeze({
    id: 'pull-request.mergeCommit.oid',
    surface: 'graphql:pull-request',
    path: 'mergeCommit.oid',
    reader: 'lifecycle-driver.mjs · terminal outcome mergeOid',
    incident: '2026-07-28: REST merge_commit_sha vanished under the pinned '
      + 'version and wedged four merged units',
  }),
  Object.freeze({
    id: 'commit.status.state',
    surface: 'rest:commit-status',
    path: 'state',
    reader: 'delivery-contract.mjs · triggered-checks floor',
  }),
  Object.freeze({
    id: 'check-runs.total_count',
    surface: 'rest:check-runs',
    path: 'total_count',
    reader: 'delivery-contract.mjs · check-run pagination',
  }),
]);

function read(value, path) {
  return path.split('.').reduce(
    (node, key) => (node === null || node === undefined ? undefined : node[key]),
    value,
  );
}

export function evaluateFacts(responses, facts = REQUIRED_FACTS) {
  return facts.map((fact) => {
    const source = responses[fact.surface];
    if (source === undefined) {
      return { ...fact, ok: false, detail: 'surface was not probed' };
    }
    const value = read(source, fact.path);
    const present = value !== undefined && (fact.nullable === true || value !== null);
    return {
      ...fact,
      ok: present,
      detail: present
        ? 'present'
        : `${fact.path} is ${value === undefined ? 'absent' : 'null'} in `
          + `${fact.surface} under API version ${API_VERSION}`,
    };
  });
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  }));
}

function rest(repository, endpoint) {
  return gh([
    'api',
    '--hostname',
    'github.com',
    endpoint,
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    `X-GitHub-Api-Version: ${API_VERSION}`,
  ]);
}

function probe(repository, pullRequest) {
  const list = rest(repository, `repos/${repository}/pulls?state=all&per_page=100&page=1`);
  const chosen = Array.isArray(list)
    ? (pullRequest === null
        ? list.find((entry) => typeof entry?.merged_at === 'string') ?? list[0]
        : list.find((entry) => entry?.number === pullRequest))
    : undefined;
  if (chosen === undefined) throw new Error('no pull request available to probe');
  const single = rest(repository, `repos/${repository}/pulls/${chosen.number}`);
  const head = chosen.head?.sha;
  const graphql = gh([
    'api',
    '--hostname',
    'github.com',
    'graphql',
    '-f',
    'query=query($owner:String!,$name:String!,$number:Int!){'
    + 'repository(owner:$owner,name:$name){pullRequest(number:$number){merged mergeCommit{oid}}}}',
    '-F',
    `owner=${repository.split('/')[0]}`,
    '-F',
    `name=${repository.split('/')[1]}`,
    '-F',
    `number=${chosen.number}`,
  ]);
  return {
    pullRequest: chosen.number,
    responses: {
      'rest:pulls-list': chosen,
      'rest:pulls-single': single,
      'graphql:pull-request': graphql?.data?.repository?.pullRequest ?? {},
      'rest:commit-status': rest(repository, `repos/${repository}/commits/${head}/status`),
      'rest:check-runs': rest(
        repository,
        `repos/${repository}/commits/${head}/check-runs?filter=all&per_page=1`,
      ),
    },
  };
}

function selfTest() {
  const complete = {
    'rest:pulls-list': { head: { sha: 'a'.repeat(40) }, merged_at: null },
    'rest:pulls-single': { base: { ref: 'main' } },
    'graphql:pull-request': { mergeCommit: { oid: 'b'.repeat(40) } },
    'rest:commit-status': { state: 'success' },
    'rest:check-runs': { total_count: 0 },
  };
  const cases = [
    ['a complete shape passes every fact', evaluateFacts(complete).every((f) => f.ok)],
    ['the 2026-07-28 incident is caught: mergeCommit.oid absent', (() => {
      const broken = { ...complete, 'graphql:pull-request': { merged: true } };
      const failed = evaluateFacts(broken).filter((f) => !f.ok);
      return failed.length === 1
        && failed[0].id === 'pull-request.mergeCommit.oid'
        && failed[0].detail.includes('absent')
        && failed[0].detail.includes(API_VERSION);
    })()],
    ['a null value counts as absent unless the fact is nullable', (() => {
      const nulled = { ...complete, 'graphql:pull-request': { mergeCommit: { oid: null } } };
      return evaluateFacts(nulled).some((f) => f.id === 'pull-request.mergeCommit.oid' && !f.ok)
        && evaluateFacts(complete).every((f) => f.ok);
    })()],
    ['an unprobed surface fails rather than passing silently', (() => {
      const { 'rest:check-runs': ignored, ...partial } = complete;
      return evaluateFacts(partial).some((f) =>
        f.id === 'check-runs.total_count' && !f.ok && f.detail.includes('not probed'));
    })()],
    ['every fact names the tool that reads it', REQUIRED_FACTS.every((f) =>
      typeof f.reader === 'string' && f.reader.includes('.mjs'))],
  ];
  const failures = cases.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

function parseArgs(args) {
  const parsed = { repository: null, pullRequest: null, json: false, selfTest: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--self-test') parsed.selfTest = true;
    else if (flag === '--json') parsed.json = true;
    else if (flag === '--repository') { parsed.repository = args[index + 1]; index += 1; }
    else if (flag === '--pull-request') { parsed.pullRequest = Number(args[index + 1]); index += 1; }
    else return { ...parsed, error: `unknown option ${flag}` };
  }
  return parsed;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.selfTest) process.exit(selfTest() ? 0 : 1);
  if (parsed.error || !/^[^/]+\/[^/]+$/u.test(parsed.repository ?? '')) {
    console.error('usage: api-shape.mjs --repository <owner/repo> [--pull-request <n>] [--json]');
    process.exit(2);
  }
  let probed;
  try {
    probed = probe(parsed.repository, Number.isSafeInteger(parsed.pullRequest)
      ? parsed.pullRequest
      : null);
  } catch (error) {
    console.error(`api-shape: probe failed: ${error.message}`);
    process.exit(1);
  }
  const results = evaluateFacts(probed.responses);
  const failed = results.filter((fact) => !fact.ok);
  if (parsed.json) {
    console.log(JSON.stringify({
      apiVersion: API_VERSION,
      repository: parsed.repository,
      pullRequest: probed.pullRequest,
      ok: failed.length === 0,
      facts: results,
    }, null, 1));
  } else {
    for (const fact of results) {
      console.log(`${fact.ok ? 'PASS' : 'FAIL'} ${fact.id} — ${fact.detail}`);
      if (!fact.ok) console.log(`     read by ${fact.reader}`);
    }
    console.log(failed.length === 0
      ? `api shape holds under ${API_VERSION} (${results.length} facts)`
      : `api shape BROKE under ${API_VERSION} (${failed.length}/${results.length})`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
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
