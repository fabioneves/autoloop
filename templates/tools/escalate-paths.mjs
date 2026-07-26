#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HUMAN_AUTHORIZATION_GLOBS,
  PATH_POLICY_FIXTURES,
  classifyLaneProof,
  globToRe,
  matchHumanAuthorization,
} from './lane-contract.mjs';

export const ESCALATE_PATHS = [
  ...HUMAN_AUTHORIZATION_GLOBS,
  // 'src/auth/**',
  // 'src/db/schema/**',
  // 'src/payments/**',
];

export { globToRe };

export function matchEscalate(files) {
  return matchHumanAuthorization(files, ESCALATE_PATHS);
}

function positiveInteger(value) {
  if (!/^\d+$/.test(value ?? '')) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseNameStatusZ(raw) {
  const tokens = String(raw).split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const files = [];
  let complete = true;
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const code = /^[ACDMRTUXB]/.test(status) ? status[0] : null;
    const previousPath = code === 'R' || code === 'C' ? tokens[index++] : null;
    const path = tokens[index++];
    if (
      !code ||
      !path ||
      path.includes('\ufffd') ||
      ((code === 'R' || code === 'C') && (!previousPath || previousPath.includes('\ufffd')))
    ) {
      complete = false;
    }
    files.push({ status, previousPath: previousPath ?? null, path: path ?? null });
  }
  return { complete, files };
}

export function parseNumstatZ(raw) {
  const tokens = String(raw).split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const files = [];
  let complete = true;
  for (let index = 0; index < tokens.length;) {
    const header = /^([^\t]*)\t([^\t]*)\t(.*)$/s.exec(tokens[index++]);
    if (!header) {
      complete = false;
      continue;
    }
    const additions = positiveInteger(header[1]);
    const deletions = positiveInteger(header[2]);
    const previousPath = header[3] === '' ? tokens[index++] : null;
    const path = header[3] === '' ? tokens[index++] : header[3];
    if (
      additions === null ||
      deletions === null ||
      !path ||
      path.includes('\ufffd') ||
      (header[3] === '' && (!previousPath || previousPath.includes('\ufffd')))
    ) {
      complete = false;
    }
    files.push({ previousPath: previousPath ?? null, path: path ?? null, additions, deletions });
  }
  return { complete, files };
}

export function mergeFinalDiff(nameStatus, numstat, headOid, persistedData = null) {
  let complete =
    nameStatus.complete === true &&
    numstat.complete === true &&
    nameStatus.files.length === numstat.files.length;
  const files = nameStatus.files.map((statusEntry, index) => {
    const statsEntry = numstat.files[index] ?? {};
    if (
      statusEntry.path !== statsEntry.path ||
      statusEntry.previousPath !== statsEntry.previousPath
    ) {
      complete = false;
    }
    return {
      ...statusEntry,
      additions: statsEntry.additions ?? null,
      deletions: statsEntry.deletions ?? null,
      contentRead: false,
      previousContentRead: false,
      contentHash: null,
    };
  });
  return {
    complete,
    headOid,
    changedFiles: files.length,
    files,
    persistedData,
  };
}

function gitText(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitBytes(args) {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}

function booleanFlag(args, flag) {
  const value = flagValue(args, flag);
  return value === 'true' ? true : value === 'false' ? false : null;
}

function resolveBase(args) {
  const ref = flagValue(args, '--base');
  const expectedOid = flagValue(args, '--base-oid')?.toLowerCase() ?? null;
  if (!ref) return { configuredBase: { ref: '', oid: '' }, error: '--base is required' };
  try {
    const oid = gitText(['rev-parse', '--verify', `${ref}^{commit}`]).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(oid)) {
      return { configuredBase: { ref, oid: '' }, error: `configured base "${ref}" did not resolve to a commit` };
    }
    if (expectedOid && expectedOid !== oid) {
      return {
        configuredBase: { ref, oid: '' },
        error: `configured base "${ref}" resolved to ${oid}, not supplied OID ${expectedOid}`,
      };
    }
    return { configuredBase: { ref, oid }, error: null };
  } catch (error) {
    return {
      configuredBase: { ref, oid: '' },
      error: `configured base "${ref}" is unavailable: ${String(error.message).slice(0, 160)}`,
    };
  }
}

function plannedPaths(args) {
  const paths = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--planned-path' && args[index + 1]) paths.push(args[++index]);
    if (args[index] === '--planned-paths') {
      while (args[index + 1] && !args[index + 1].startsWith('--')) paths.push(args[++index]);
    }
  }
  return paths;
}

function plannedInput(args) {
  const jsonPath = flagValue(args, '--planned-json');
  if (jsonPath) return JSON.parse(readFileSync(jsonPath, 'utf8'));
  const files = plannedPaths(args).map((path) => ({
    path,
    contentRead: args.includes('--content-read-all'),
  }));
  return {
    complete: true,
    files,
    estimatedChangedLines: positiveInteger(flagValue(args, '--estimated-lines')),
    persistedData: booleanFlag(args, '--persisted-data'),
  };
}

function plannedSubject(args) {
  return {
    kind: 'plan',
    artifactVersion: positiveInteger(flagValue(args, '--artifact-version')),
    fingerprint: flagValue(args, '--artifact-fingerprint')?.toLowerCase() ?? '',
  };
}

function withContentEvidence(final, range, args) {
  if (!args.includes('--content-read-all')) return final;
  const paths = final.files.flatMap(({ previousPath, path }) => previousPath ? [previousPath, path] : [path]);
  if (!paths.every((path) => /^docs\//i.test(path) || /\.md$/i.test(path))) return final;
  try {
    gitBytes(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--find-renames=50%', range]);
    const evidenceHash = createHash('sha256')
      .update(`${range}\0${paths.sort().join('\0')}`)
      .digest('hex');
    return {
      ...final,
      files: final.files.map((file) => ({
        ...file,
        contentRead: true,
        previousContentRead: ['R', 'C'].includes(file.status?.[0]),
        contentHash: createHash('sha256')
          .update(`${evidenceHash}\0${file.previousPath ?? ''}\0${file.path}`)
          .digest('hex'),
      })),
    };
  } catch {
    return final;
  }
}

function finalInput(configuredBase, args) {
  const headOid = gitText(['rev-parse', '--verify', 'HEAD^{commit}']).trim().toLowerCase();
  const range = `${configuredBase.oid}...${headOid}`;
  const nameStatus = parseNameStatusZ(gitText(['diff', '--name-status', '-z', '--find-renames=50%', range]));
  const numstat = parseNumstatZ(gitText(['diff', '--numstat', '-z', '--find-renames=50%', range]));
  const final = mergeFinalDiff(nameStatus, numstat, headOid, booleanFlag(args, '--persisted-data'));
  const { headOid: ignoredHeadOid, ...evidence } = withContentEvidence(final, range, args);
  return {
    evidence,
    subject: { kind: 'head', headOid },
  };
}

function proofPaths(laneProof) {
  const { decisionEvidence, mode } = laneProof;
  return mode === 'planned'
    ? decisionEvidence.files.map(({ path }) => path)
    : decisionEvidence.files.flatMap(({ previousPath, path }) =>
      previousPath ? [previousPath, path] : [path]);
}

function selfTest() {
  const cases = [
    ['.env.example', true],
    ['apps/web/.env.local', true],
    ['.ENV.local', true],
    ['.github/workflows/ci.yml', true],
    ['Dockerfile', true],
    ['deploy/Dockerfile.prod', true],
    ['docker-compose.yml', true],
    ['k8s/docker-compose.prod.yml', true],
    ['AGENTS.override.md', true],
    ['AGENTS.md', true],
    ['CLAUDE.md', true],
    ['src/AGENTS.md', true],
    ['packages/web/CLAUDE.md', true],
    ['deep/nested/dir/AGENTS.override.md', true],
    ['src/MYAGENTS.md', false],
    ['docs/agentic/STATE.md', true],
    ['docs/agentic/LOOP.md', false],
    ['src/index.ts', false],
    ['README.md', false],
    ...PATH_POLICY_FIXTURES.map(({ path, humanAuthorization }) => [path, humanAuthorization]),
  ];
  let ok = true;
  for (const [file, expect] of cases) {
    const got = matchEscalate([file]).length > 0;
    if (got !== expect) {
      console.error(`FAIL [expect ${expect}, got ${got}]: ${file}`);
      ok = false;
    }
  }
  const nameStatus = parseNameStatusZ('M\u0000src/a.mjs\u0000R100\u0000docs/old.md\u0000docs/new.md\u0000');
  const numstat = parseNumstatZ('2\t1\tsrc/a.mjs\u00000\t0\t\u0000docs/old.md\u0000docs/new.md\u0000');
  const merged = mergeFinalDiff(nameStatus, numstat, '3'.repeat(40), false);
  const subject = plannedSubject([
    '--artifact-version',
    '3',
    '--artifact-fingerprint',
    'A'.repeat(64),
  ]);
  const incompleteSubject = plannedSubject([]);
  const traversalProof = classifyLaneProof({
    mode: 'planned',
    configuredBase: { ref: 'origin/main', oid: '1'.repeat(40) },
    subject,
    planned: {
      complete: true,
      estimatedChangedLines: 1,
      files: [{ path: '../.opencode/plugins/autoloop.js', contentRead: true }],
      persistedData: false,
    },
  });
  const diffChecks = [
    ['name-status complete', nameStatus.complete && nameStatus.files.length === 2],
    ['rename sides retained', nameStatus.files[1].previousPath === 'docs/old.md' && nameStatus.files[1].path === 'docs/new.md'],
    ['numstat complete', numstat.complete && numstat.files[0].additions === 2 && numstat.files[0].deletions === 1],
    ['diff merge complete', merged.complete && merged.changedFiles === 2],
    ['binary numstat opaque', parseNumstatZ('-\t-\tasset.png\u0000').complete === false],
    ['planned subject parsed', subject.artifactVersion === 3 && subject.fingerprint === 'a'.repeat(64)],
    ['missing planned subject remains typed', incompleteSubject.artifactVersion === null && incompleteSubject.fingerprint === ''],
    ['normalized traversal is incomplete', traversalProof.decisionEvidence.sourceComplete === false],
    ['normalized traversal is not reported as a path', proofPaths(traversalProof).length === 0],
  ];
  const usageText = usage();
  const plannedGaps = incompleteInputGuidance('planned', [
    'PLAN_SUBJECT_UNAVAILABLE',
    'SMALL_PERSISTED_DATA_UNVERIFIED',
  ]);
  const finalGaps = incompleteInputGuidance('final', [
    'BASE_OID_UNAVAILABLE',
    'FINAL_DIFF_INCOMPLETE',
  ]);
  diffChecks.push(
    ['usage names every mode and required flag',
      usageText.includes('--planned-path')
      && usageText.includes('--artifact-version')
      && usageText.includes('--artifact-fingerprint')
      && usageText.includes('--base-oid')
      && usageText.includes('--working-tree')
      && !usageText.includes('LANE_PROOF')],
    ['planned reason codes become actionable guidance',
      plannedGaps.includes('--artifact-version')
      && plannedGaps.includes('--artifact-fingerprint')
      && plannedGaps.includes('--estimated-lines')],
    ['final reason codes become actionable guidance',
      finalGaps.includes('--base-oid')],
    ['unknown reason codes never fabricate guidance',
      incompleteInputGuidance('planned', ['SOMETHING_ELSE']) === null],
  );
  for (const [name, passed] of diffChecks) {
    if (!passed) {
      console.error(`FAIL: ${name}`);
      ok = false;
    }
  }
  console.log(ok ? `self-test OK (${cases.length + diffChecks.length} checks)` : 'self-test FAILED');
  return ok;
}

function usage() {
  return [
    'usage: escalate-paths.mjs <mode> [--json]',
    '',
    'planned mode (pre-implementation lane selection):',
    '  --base <ref> --base-oid <sha> --artifact-version <n> --artifact-fingerprint <sha256>',
    '  --estimated-lines <n> --planned-path <path> [--planned-path <path>...]',
    '  (or --planned-paths <a,b,c> / --planned-json <file>)',
    '',
    'final mode (post-implementation reclassification):',
    '  --base <ref> --base-oid <sha> [--head <sha>]',
    '',
    'working-tree mode (escalate-path check only, no lane proof):',
    '  --working-tree',
    '',
    'other: --self-test | --help',
    '',
    'Exit 0 clean, 1 escalate paths matched, 2 evidence incomplete (the lane',
    'fails closed to full and the reason codes name the missing input).',
  ].join('\n');
}

// Incomplete evidence already fails closed to the full lane, but the reason
// codes lived only inside the emitted proof, so a caller saw a bare exit 2 and
// had to read this file's source to learn which flag was missing (observed in
// a live run).
const REASON_GUIDANCE = Object.freeze({
  PLAN_SUBJECT_UNAVAILABLE: ['--artifact-version', '--artifact-fingerprint'],
  SMALL_PERSISTED_DATA_UNVERIFIED: ['--estimated-lines'],
  BASE_OID_UNAVAILABLE: ['--base-oid'],
  BASE_REF_UNAVAILABLE: ['--base'],
  FINAL_DIFF_INCOMPLETE: ['--base-oid'],
});

function incompleteInputGuidance(mode, reasonCodes) {
  const flags = [];
  for (const code of reasonCodes ?? []) {
    for (const flag of REASON_GUIDANCE[code] ?? []) {
      if (!flags.includes(flag)) flags.push(flag);
    }
  }
  if (flags.length === 0) return null;
  return `${mode} evidence is incomplete; supply ${flags.join(' ')}`;
}

function outputResult(files, laneProof, args, sourceComplete, error = null) {
  const hits = matchEscalate(files);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ laneProof, escalationHits: hits, sourceComplete, error }, null, 2));
  } else {
    for (const { file, glob } of hits) console.log(`ESCALATE  ${file}  (matched ${glob})`);
    console.log(`LANE_PROOF ${JSON.stringify(laneProof)}`);
    if (error) console.error(`escalate-paths: ${error}`);
    else if (hits.length) console.log('→ apply `human:authorize` and record the matched path');
    else console.log('no escalate paths touched');
  }
  if (!sourceComplete) {
    const guidance = incompleteInputGuidance(
      laneProof.mode,
      laneProof.reasonCodes,
    );
    if (guidance) console.error(`escalate-paths: ${guidance}`);
    return 2;
  }
  return hits.length ? 1 : 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  // Before any mode resolution: --help must never emit a lane proof for a
  // fabricated state (it did, then errored that --base was missing).
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(usage());
    process.exit(args.length === 0 ? 2 : 0);
  }
  if (args.includes('--working-tree')) {
    try {
      const tracked = gitText(['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean);
      const untracked = gitText(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
      const files = [...new Set([...tracked, ...untracked])];
      const hits = matchEscalate(files);
      for (const { file, glob } of hits) console.log(`ESCALATE  ${file}  (matched ${glob})`);
      if (hits.length) console.log('→ apply `human:authorize` and record the matched path');
      else console.log('no escalate paths touched');
      process.exit(hits.length ? 1 : 0);
    } catch (error) {
      console.error(`escalate-paths: git working-tree read failed: ${error.message}`);
      process.exit(2);
    }
  }

  const base = resolveBase(args);
  const mode = args.includes('--planned-json') || args.includes('--planned-path') || args.includes('--planned-paths')
    ? 'planned'
    : 'final';
  let evidence;
  let subject = mode === 'planned'
    ? plannedSubject(args)
    : { kind: 'head', headOid: '' };
  let evidenceError = base.error;
  try {
    if (mode === 'planned') {
      evidence = plannedInput(args);
    } else if (base.error) {
      evidence = { complete: false, changedFiles: null, files: [], persistedData: null };
    } else {
      ({ evidence, subject } = finalInput(base.configuredBase, args));
    }
  } catch (error) {
    evidenceError = `unable to read ${mode} evidence: ${String(error.message).slice(0, 160)}`;
    evidence = mode === 'planned'
      ? { complete: false, files: [], estimatedChangedLines: null, persistedData: null }
      : { complete: false, changedFiles: null, files: [], persistedData: null };
  }
  const laneProof = classifyLaneProof(
    {
      mode,
      configuredBase: base.configuredBase,
      subject,
      [mode]: evidence,
    },
    { extraHumanAuthorizationGlobs: ESCALATE_PATHS },
  );
  const files = proofPaths(laneProof);
  const sourceComplete = laneProof.decisionEvidence.sourceComplete;
  process.exit(outputResult(files, laneProof, args, sourceComplete, evidenceError));
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
