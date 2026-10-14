#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// The loop's own control files: the project's loop config and policy
// (config.json outranks STATE), the agent-tool settings and hooks, and the
// git hooks. A writer changing one would reconfigure the gate.
const SHARED_GUARDRAIL_ROOTS = ['.autoloop', '.claude', '.codex', '.opencode', '.agents', '.githooks'];

// `.github` as a whole: workflows, composite actions, CODEOWNERS and
// dependabot all run in CI with the repository's secrets or decide who
// reviews (0.69.0 review of the protected-path reduction).
const GUARDRAIL_ROOTS = ['.github', ...SHARED_GUARDRAIL_ROOTS];

// The one secret-path rule, for the command guard (a commit), the merge
// families (a merge) and the lane (a widening). A path holds a secret when
// a segment IS one of the words secret, credential, token or crypt (with any
// extension: `docs/secrets.md`, `crypt.ts`), not when a name contains one
// (`src/tokenizer.ts`, `auth/token-refresh.ts`, `lib/encryption.ts` are
// source); when it is key material by directory (`keys/`, `certs/`,
// `.ssh/`), by name (`id_rsa*`, `id_ed25519*`, `private-key`, `keypair`)
// or by extension; or when it is an `.env*` file.
const SECRET_WORD_RE = /^(?:secrets?|credentials?|tokens?|crypt)(?:\..*)?$/iu;
const SECRET_SEGMENT_RE = /^(?:keys|certs|\.ssh)$/iu;
const SECRET_NAME_RE = /^id_(?:rsa|ed25519|ecdsa|dsa)(?:[^/]*)$|private[-_]?key|keypair/iu;
const SECRET_EXTENSION_RE = /\.(?:crt|jks|key|keystore|p12|pem|pfx)$/iu;
const ENV_FILE_RE = /^\.env(?:[^/]*)$/iu;

export function isSecretPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  const leaf = segments[segments.length - 1];
  return segments.some((segment) => SECRET_WORD_RE.test(segment) || SECRET_SEGMENT_RE.test(segment) || SECRET_NAME_RE.test(segment))
    || SECRET_EXTENSION_RE.test(leaf)
    || ENV_FILE_RE.test(leaf);
}

// The built-in protected families beside the secret rule, as globs: the
// `.github` tree and the loop's control roots. Nothing else. Documentation,
// dependency manifests, build configs, container files, and data are
// ordinary files; a project that wants one protected lists it in
// `protectedPaths`. A secret path is matched by `isSecretPath`, reported
// under the `<secret-path>` glob.
export const SECRET_PATH_GLOB = '<secret-path>';
export const HUMAN_AUTHORIZATION_GLOBS = ['.github/workflows/**', ...GUARDRAIL_ROOTS.map((root) => `${root}/**`)];

// The built-in families protect secrets, CI workflows, and the loop's own
// control files. Every other path is ordinary: a project that wants it
// protected lists it in `protectedPaths`.
export const PATH_POLICY_FIXTURES = [
  // The project's loop config and policy (global install): config.json
  // outranks STATE, so a writer changing it would reconfigure the gate.
  { path: '.autoloop/config.json', humanAuthorization: true, mergeProtected: true },
  { path: '.autoloop/STATE.md', humanAuthorization: true, mergeProtected: true },
  { path: '.claude/settings.json', humanAuthorization: true, mergeProtected: true },
  { path: '.codex/hooks.json', humanAuthorization: true, mergeProtected: true },
  { path: '.opencode/plugins/autoloop.js', humanAuthorization: true, mergeProtected: true },
  { path: '.agents/plugins/marketplace.json', humanAuthorization: true, mergeProtected: true },
  { path: '.githooks/pre-commit', humanAuthorization: true, mergeProtected: true },
  { path: '.githooks/pre-push', humanAuthorization: true, mergeProtected: true },
  { path: '.github/workflows/ci.yml', humanAuthorization: true, mergeProtected: true },
  { path: '.env.local', humanAuthorization: true, mergeProtected: true },
  { path: 'keys/x.pem', humanAuthorization: true, mergeProtected: true },
  { path: 'certs/private-key.pem', humanAuthorization: true, mergeProtected: true },
  { path: 'config/credentials.json', humanAuthorization: true, mergeProtected: true },
  { path: 'config/credentials.yml', humanAuthorization: true, mergeProtected: true },
  { path: 'secrets/a.txt', humanAuthorization: true, mergeProtected: true },
  // Ordinary repository files.
  { path: 'CLAUDE.md', humanAuthorization: false, mergeProtected: false },
  { path: 'AGENTS.md', humanAuthorization: false, mergeProtected: false },
  { path: 'AGENTS.override.md', humanAuthorization: false, mergeProtected: false },
  { path: 'docs/agentic/checklist.md', humanAuthorization: false, mergeProtected: false },
  { path: 'docs/agentic/STATE.md', humanAuthorization: false, mergeProtected: false },
  { path: 'docs/agentic/ARCH.md', humanAuthorization: false, mergeProtected: false },
  { path: 'docs/guide.md', humanAuthorization: false, mergeProtected: false },
  { path: 'package.json', humanAuthorization: false, mergeProtected: false },
  { path: 'pnpm-lock.yaml', humanAuthorization: false, mergeProtected: false },
  { path: 'tsconfig.json', humanAuthorization: false, mergeProtected: false },
  { path: 'vite.config.ts', humanAuthorization: false, mergeProtected: false },
  { path: 'data/x.json', humanAuthorization: false, mergeProtected: false },
  { path: 'Dockerfile', humanAuthorization: false, mergeProtected: false },
  { path: 'docker-compose.yml', humanAuthorization: false, mergeProtected: false },
  { path: 'deploy/docker-compose.prod.yml', humanAuthorization: false, mergeProtected: false },
  { path: 'tools/x.mjs', humanAuthorization: false, mergeProtected: false },
  { path: 'tools/agentic/gate.mjs', humanAuthorization: false, mergeProtected: false },
  { path: '.editorconfig', humanAuthorization: false, mergeProtected: false },
  { path: '.github/dependabot.yml', humanAuthorization: true, mergeProtected: true },
  { path: '.github/CODEOWNERS', humanAuthorization: true, mergeProtected: true },
  { path: 'auth/token-refresh.ts', humanAuthorization: false, mergeProtected: false },
  { path: 'src/tokenizer.ts', humanAuthorization: false, mergeProtected: false },
  { path: 'lib/encryption.ts', humanAuthorization: false, mergeProtected: false },
  { path: 'docs/secrets.md', humanAuthorization: true, mergeProtected: true },
  { path: 'certs/server.crt', humanAuthorization: true, mergeProtected: true },
  { path: '.ssh/id_rsa', humanAuthorization: true, mergeProtected: true },
];

export function globToRe(glob) {
  const source = String(glob)
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return part.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`, 'i');
}

function normalizedGlobs(globs) {
  return [...new Set((globs ?? []).filter((glob) => typeof glob === 'string' && glob.length > 0))].sort();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// A human-authorization hit: the secret rule first (reported as
// `<secret-path>`), then the built-in and project globs, the most specific
// (longest) matching glob named (`.github/workflows/**` over `.github/**`).
export function matchHumanAuthorization(files, globs = HUMAN_AUTHORIZATION_GLOBS) {
  const patterns = normalizedGlobs(globs)
    .sort((left, right) => right.length - left.length)
    .map((glob) => ({ glob, re: globToRe(glob) }));
  const hits = [];
  for (const file of files ?? []) {
    if (typeof file !== 'string' || file.length === 0) {
      hits.push({ file, glob: '<opaque-path>' });
      continue;
    }
    if (isSecretPath(file)) {
      hits.push({ file, glob: SECRET_PATH_GLOB });
      continue;
    }
    const matched = patterns.find(({ re }) => re.test(file));
    if (matched) hits.push({ file, glob: matched.glob });
  }
  return hits;
}

// The same families as matchHumanAuthorization, named for the merge
// executor's report. The `secret` family holds secret values or key
// material: a unit never widens its lane into one (SPEC-elastic-scope); the
// guardrail roots label it.
const MERGE_PROTECTED_PATH_FAMILIES = [
  { name: 'secret path', secret: true, matches: isSecretPath },
  ...GUARDRAIL_ROOTS.map((root) => ({
    name: root,
    matches: (path) => path.toLowerCase().startsWith(`${root}/`),
  })),
];

export function matchMergeProtected(files, extraGlobs = []) {
  const extraFamilies = normalizedGlobs(extraGlobs).map((glob) => ({
    name: `extra-protected ${glob}`,
    matches: (path) => globToRe(glob).test(path),
  }));
  const hits = [];
  for (const file of files ?? []) {
    if (typeof file !== 'string' || file.length === 0) {
      hits.push({ file, family: 'opaque path' });
      continue;
    }
    const matched = [...MERGE_PROTECTED_PATH_FAMILIES, ...extraFamilies].find(({ matches }) => matches(file));
    if (matched) hits.push({ file, family: matched.name });
  }
  return hits;
}

// A project glob that a built-in family already covers: the glob itself is a
// built-in, or a path shaped like it hits a family with no extra globs. The
// doctor names these; the union is unchanged.
export function duplicateProtectedGlobs(globs) {
  const builtIn = new Set(HUMAN_AUTHORIZATION_GLOBS);
  return normalizedGlobs(globs).filter((glob) => {
    if (builtIn.has(glob)) return true;
    const sample = glob.split('/').map((segment) => (segment === '**' ? 'x/y' : segment.replace(/\*/g, 'x'))).join('/');
    return matchMergeProtected([sample]).length > 0;
  });
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const ZERO_40 = '0'.repeat(40);
const ZERO_64 = '0'.repeat(64);
const PROOF_KEYS = [
  'configuredBase',
  'decisionEvidence',
  'fingerprint',
  'inputHash',
  'kind',
  'lane',
  'mode',
  'proofHash',
  'reasonCodes',
  'subject',
  'version',
];
const PLANNED_EVIDENCE_KEYS = [
  'estimatedChangedLines',
  'files',
  'humanAuthorizationGlobs',
  'kind',
  'normalizationReasonCodes',
  'persistedData',
  'sourceComplete',
];
const FINAL_EVIDENCE_KEYS = [
  'changedFiles',
  'files',
  'humanAuthorizationGlobs',
  'kind',
  'normalizationReasonCodes',
  'persistedData',
  'sourceComplete',
];
const PLANNED_FILE_KEYS = ['contentHash', 'contentRead', 'path'];
const FINAL_FILE_KEYS = [
  'additions',
  'contentHash',
  'contentRead',
  'deletions',
  'path',
  'previousContentRead',
  'previousPath',
  'status',
];
const SOURCE_COMPLETE_REASONS = new Set([
  'FINAL_FILES_EMPTY',
  'FINAL_STATUS_UNSAFE',
  'PLANNED_FILES_EMPTY',
]);

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

function canonicalReasons(reasons) {
  return [...new Set(reasons)].sort();
}

function sameValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function normalizedBase(base, reasonCodes) {
  const exact = hasExactKeys(base, ['oid', 'ref']);
  const rawRef = exact && typeof base.ref === 'string' ? base.ref : '';
  const rawOid = exact && typeof base.oid === 'string' ? base.oid : '';
  const validRef = rawRef.length > 0 && !/[\x00-\x1f\x7f]/.test(rawRef);
  const validOid = /^[0-9a-f]{40}$/.test(rawOid) && !/^0{40}$/.test(rawOid);
  if (!exact) reasonCodes.push('BASE_SHAPE_OPAQUE');
  if (!validRef) reasonCodes.push('BASE_REF_UNAVAILABLE');
  if (!validOid) reasonCodes.push('BASE_OID_UNAVAILABLE');
  return {
    ref: validRef ? rawRef : '(unavailable)',
    oid: validOid ? rawOid : ZERO_40,
  };
}

function normalizedSubject(mode, subject, reasonCodes) {
  if (mode === 'final') {
    const valid =
      hasExactKeys(subject, ['headOid', 'kind']) &&
      subject.kind === 'head' &&
      HEX_40.test(subject.headOid) &&
      subject.headOid !== ZERO_40;
    if (!valid) reasonCodes.push('HEAD_SUBJECT_UNAVAILABLE');
    return { kind: 'head', headOid: valid ? subject.headOid : ZERO_40 };
  }
  const valid =
    hasExactKeys(subject, ['artifactVersion', 'fingerprint', 'kind']) &&
    subject.kind === 'plan' &&
    Number.isSafeInteger(subject.artifactVersion) &&
    subject.artifactVersion > 0 &&
    HEX_64.test(subject.fingerprint) &&
    subject.fingerprint !== ZERO_64;
  if (!valid) reasonCodes.push('PLAN_SUBJECT_UNAVAILABLE');
  return {
    kind: 'plan',
    artifactVersion: valid ? subject.artifactVersion : 1,
    fingerprint: valid ? subject.fingerprint : ZERO_64,
  };
}

function normalizedPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\ufffd')
  ) {
    return null;
  }
  if (value.startsWith('/') || value.includes('\\')) return null;
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return null;
  return value;
}

// SPEC-elastic-scope: the unit's lane is the plan boundary plus every recorded
// widening, as one list of repository-relative paths or directory prefixes
// that end in `/`. The dirty-tree rule and the exact-head check ask the same
// question of it: is every path in the lane?
export function inLane(path, lane) {
  return (Array.isArray(lane) ? lane : []).some((entry) =>
    entry === path || (entry.endsWith('/') && path.startsWith(entry)));
}

// Widens a lane by the given paths. A secret path is refused
// (`WIDEN_SECRET_PATH`), a malformed one too (`WIDEN_PATH_INVALID`), and a
// directory prefix at or under a guardrail root (`.github/`, `.claude/`,
// …) as well (`WIDEN_GUARDRAIL_ROOT`: a prefix is open-ended, and a lane
// never takes a control tree whole). Any other protected path (one file
// under a guardrail root, a project `protectedPaths` glob) is accepted and
// reported in `authorize`, which earns the unit its `human:authorize` label
// rather than a block. A prefix is matched as the directory it names.
export function widenLane(lane, paths, extraGlobs = []) {
  const widened = [...(Array.isArray(lane) ? lane : [])];
  const authorize = [];
  const globs = normalizedGlobs([...HUMAN_AUTHORIZATION_GLOBS, ...(extraGlobs ?? [])]);
  for (const raw of Array.isArray(paths) ? paths : []) {
    const path = normalizedPath(typeof raw === 'string' ? raw.replace(/\/$/, '') : raw);
    if (path === null) return { ok: false, code: 'WIDEN_PATH_INVALID', path: raw };
    const prefix = typeof raw === 'string' && raw.endsWith('/');
    const entry = prefix ? `${path}/` : path;
    if (isSecretPath(path)) return { ok: false, code: 'WIDEN_SECRET_PATH', path: entry };
    if (prefix && GUARDRAIL_ROOTS.some((root) => entry.toLowerCase().startsWith(`${root}/`))) {
      return { ok: false, code: 'WIDEN_GUARDRAIL_ROOT', path: entry };
    }
    if (inLane(entry, widened)) continue;
    widened.push(entry);
    authorize.push(...matchHumanAuthorization([entry], globs));
  }
  return { ok: true, lane: widened, authorize };
}

// Selection paths are separate from the legacy lane and authorization policy.
export class BoundaryPathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BoundaryPathError';
    this.code = code;
  }
}

function requireBoundary(ok, code, message) {
  if (!ok) throw new BoundaryPathError(code, message);
}

// A conservative Unicode collision key, not a filename. Compatibility forms,
// case expansions (including capital sharp S), and combining marks may collide
// even when the filesystem keeps them distinct. Never use this key for access.
function boundaryCollisionKey(value) {
  let key = value;
  const seen = new Set();
  while (!seen.has(key)) {
    seen.add(key);
    const folded = key.normalize('NFKD').toUpperCase().toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
    if (folded === key) return key;
    key = folded;
  }
  return [...seen].sort(compareText)[0];
}

function boundaryEntry(value, separators = false) {
  requireBoundary(typeof value === 'string' && value.length > 0
    && !/^[\\/]|^[a-z]:/i.test(value) && !/[\x00-\x1f\x7f-\x9f*?\[\]{}]/u.test(value),
  'BOUNDARY_PATH_INVALID', 'A boundary must contain exact repository-relative paths.');
  const path = separators ? value.replace(/\\/g, '/') : value;
  requireBoundary(!path.includes('\\'), 'BOUNDARY_PATH_INVALID', 'A canonical path must use slash separators.');
  const directory = path.endsWith('/');
  const components = (directory ? path.slice(0, -1) : path).split('/');
  requireBoundary(components.every((part) => part !== '' && part !== '.' && part !== '..'),
    'BOUNDARY_PATH_INVALID', 'A boundary path must not contain empty or traversal components.');
  for (const component of components) {
    requireBoundary(component.normalize('NFC') === component && !/[\p{Cf}\p{Cs}�]/u.test(component)
      && !Array.from(component).some((letter) => {
        const code = letter.codePointAt(0);
        return code >= 0xfdd0 && code <= 0xfdef || (code & 0xffff) >= 0xfffe;
      }),
    'BOUNDARY_PATH_UNSUPPORTED', 'A boundary path uses unsupported encoding or normalization.');
    const collision = boundaryCollisionKey(component);
    requireBoundary(collision !== '' && collision !== '.' && collision !== '..',
      'BOUNDARY_PATH_UNSUPPORTED', 'A component has an unsupported empty or traversal normalization.');
    requireBoundary(!/^(?:\.git(?:[. ]*|:.*)|git~[0-9]+(?:[. ]*|:.*))$/.test(collision),
      'BOUNDARY_PATH_UNSAFE', 'A boundary must not include Git administrative paths.');
    const portable = component.normalize('NFKC');
    requireBoundary(!/[\\/:~]|[. ]$/u.test(portable)
      && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(collision),
    'BOUNDARY_PATH_UNSUPPORTED', 'A boundary path uses an unsupported platform alias.');
  }
  return { path, directory, components };
}

// Pure, symmetric exclusion. Return the narrower path for each overlap. Equal
// collision keys use the first spelling in code-point order, in either direction.
// Services derive rules at BOTH roots and combine them with logical AND. Never
// store pathRules in a reservation or accept them from a plan author.
export function intersectBoundaries(left, right, pathRules = { caseSensitive: false }) {
  requireBoundary(Array.isArray(left) && Array.isArray(right),
    'BOUNDARY_PATH_INVALID', 'Boundaries must be arrays of path strings.');
  requireBoundary(hasExactKeys(pathRules, ['caseSensitive']) && typeof pathRules.caseSensitive === 'boolean',
    'BOUNDARY_PATH_INVALID', 'Path comparison requires derived case rules.');
  const key = (path) => pathRules.caseSensitive ? path : boundaryCollisionKey(path);
  const prepare = (entries) => Array.from(entries, (entry) => {
    const parsed = boundaryEntry(entry);
    return { ...parsed, key: key(parsed.path.replace(/\/$/, '')) };
  });
  const leftPaths = prepare(left);
  const rightPaths = prepare(right);
  const conflicts = new Map();
  for (const a of leftPaths) {
    for (const b of rightPaths) {
      let path;
      if (a.key === b.key) path = [a.path, b.path].sort(compareText)[0];
      else if (a.directory && b.key.startsWith(`${a.key}/`)) path = b.path;
      else if (b.directory && a.key.startsWith(`${b.key}/`)) path = a.path;
      else continue;
      const collision = key(path.replace(/\/$/, ''));
      const prior = conflicts.get(collision);
      if (prior === undefined || compareText(path, prior) < 0) conflicts.set(collision, path);
    }
  }
  return [...conflicts.values()].sort(compareText);
}

function boundaryGitEnv() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')
    && !['NODE_OPTIONS', 'NODE_PATH'].includes(name))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

function boundaryProbe(command, args) {
  return execFileSync(command, args, {
    env: boundaryGitEnv(), encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
    maxBuffer: Number.MAX_SAFE_INTEGER, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function boundaryGit(root, args) {
  return boundaryProbe('git', ['--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-C', root, ...args]);
}

function boundaryStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sameBoundaryObject(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function boundarySpelling(parent, name, stat) {
  requireBoundary(!name.includes('\\'), 'BOUNDARY_PATH_UNSUPPORTED', 'Literal backslash filenames are not supported.');
  const canonical = name.normalize('NFC');
  boundaryEntry(canonical);
  requireBoundary(canonical === name || sameBoundaryObject(stat, boundaryStat(join(parent, canonical))),
    'BOUNDARY_PATH_UNSUPPORTED', 'The filesystem does not resolve canonical Unicode spelling to the observed file.');
  return canonical;
}

function belowBoundary(root, path) {
  const suffix = relative(root, path);
  return suffix === '' || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

// Read-only observations, not core.ignoreCase. A proof in one directory says
// nothing about a nested mount or an empty/new directory. Observe each one.
function observeBoundaryDirectory(path) {
  const names = readdirSync(path, { encoding: 'buffer' }).map((bytes) => {
    const name = bytes.toString('utf8');
    requireBoundary(Buffer.from(name).equals(bytes), 'BOUNDARY_PATH_UNSUPPORTED', 'A directory contains an unsupported filename encoding.');
    return name;
  });
  let caseSensitive = false;
  for (const name of names) {
    if (!/^[\x20-\x7e]+$/.test(name) || !/[a-z]/i.test(name)) continue;
    const variant = name.replace(/[a-z]/i, (letter) => letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase());
    const actual = boundaryStat(join(path, name));
    const alternate = boundaryStat(join(path, variant));
    requireBoundary(actual, 'BOUNDARY_IO_ERROR', 'A directory changed during path observation.');
    if (sameBoundaryObject(actual, alternate)) return { names, caseSensitive: false };
    caseSensitive = true;
  }
  return { names, caseSensitive };
}

function requireBoundaryMounts(root) {
  let mounts;
  if (process.platform === 'linux') {
    mounts = boundaryProbe(process.execPath, ['--input-type=module', '-e',
      "import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync('/proc/self/mountinfo'));" ])
      .trimEnd().split('\n').map((line) => {
      const fields = line.split(' ');
      requireBoundary(fields.length >= 10 && fields.includes('-'), 'BOUNDARY_PATH_UNSUPPORTED', 'The filesystem mount table cannot be verified.');
      return fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    });
  } else if (process.platform === 'darwin') {
    mounts = boundaryProbe('/sbin/mount', [])
      .trimEnd().split('\n').map((line) => {
        const match = / on (\/.*) \([^\n]*\)$/.exec(line);
        requireBoundary(match, 'BOUNDARY_PATH_UNSUPPORTED', 'The filesystem mount table cannot be verified.');
        return match[1];
      });
  } else {
    throw new BoundaryPathError('BOUNDARY_PATH_UNSUPPORTED', 'This platform has no supported read-only mount observation.');
  }
  const rootKey = boundaryCollisionKey(root);
  requireBoundary(mounts.every((path) => isAbsolute(path)), 'BOUNDARY_PATH_UNSUPPORTED', 'The filesystem mount table contains an unsupported path.');
  requireBoundary(!mounts.some((path) => {
    const key = boundaryCollisionKey(path);
    return key !== rootKey && belowBoundary(rootKey, key);
  }), 'BOUNDARY_PATH_UNSUPPORTED', 'Nested filesystem mounts are not supported in boundary roots.');
}

// Synchronous and read-only. Absent targets are valid planned paths. Existing
// directories need a trailing slash; existing exact targets must be files.
export function canonicalBoundary(root, entries) {
  try {
    requireBoundary(typeof root === 'string' && isAbsolute(root),
      'BOUNDARY_ROOT_INVALID', 'A boundary requires an absolute repository root.');
    requireBoundary(Array.isArray(entries), 'BOUNDARY_PATH_INVALID', 'A boundary must be an array of path strings.');
    const rootStat = boundaryStat(root);
    requireBoundary(rootStat?.isDirectory() && !rootStat.isSymbolicLink() && realpathSync(root) === resolve(root),
      'BOUNDARY_ROOT_INVALID', 'The repository root must be a canonical real directory.');
    const marker = boundaryStat(join(root, '.git'));
    requireBoundary(marker && !marker.isSymbolicLink() && (marker.isFile() || marker.isDirectory()),
      'BOUNDARY_ROOT_INVALID', 'The boundary root must be a Git checkout.');
    let top, admin, common, index;
    try {
      top = boundaryGit(root, ['rev-parse', '--show-toplevel']).trim();
      admin = realpathSync(boundaryGit(root, ['rev-parse', '--absolute-git-dir']).trim());
      common = realpathSync(resolve(root, boundaryGit(root, ['rev-parse', '--git-common-dir']).trim()));
      index = boundaryGit(root, ['ls-files', '--stage', '-z']);
    } catch {
      throw new BoundaryPathError('BOUNDARY_ROOT_INVALID', 'Repository identity and index paths cannot be verified.');
    }
    requireBoundary(realpathSync(top) === root, 'BOUNDARY_ROOT_INVALID', 'The boundary root must be the checkout root.');
    // realpath does not reveal bind mounts. Refuse nested mounts before any
    // case proof, including same-device mounts that can alias another path.
    requireBoundaryMounts(root);
    const gitlinks = index.split('\0').filter((row) => row.startsWith('160000 ')).map((row) => {
      const path = row.slice(row.indexOf('\t') + 1);
      return boundaryCollisionKey(boundaryEntry(path).path);
    });
    let caseSensitive = true;
    const observed = new Map();
    const directory = (path) => {
      if (observed.has(path)) return observed.get(path);
      requireBoundary(belowBoundary(root, path) && ![admin, common].some((base) => belowBoundary(base, path)),
        'BOUNDARY_PATH_UNSAFE', 'A boundary must not enter administrative state or leave the checkout.');
      const stat = boundaryStat(path);
      requireBoundary(stat?.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path,
        'BOUNDARY_PATH_UNSAFE', 'Boundary components must be real directories inside the checkout.');
      requireBoundary(stat.dev === rootStat.dev, 'BOUNDARY_PATH_UNSUPPORTED', 'A boundary must not cross a filesystem device.');
      const observation = observeBoundaryDirectory(path);
      if (path !== root) {
        const names = new Set(observation.names.map(boundaryCollisionKey));
        requireBoundary(!names.has('.git') && !['head', 'objects', 'refs'].every((name) => names.has(name)),
          'BOUNDARY_PATH_UNSAFE', 'A boundary must not enter a nested repository.');
      }
      caseSensitive &&= observation.caseSensitive;
      observed.set(path, observation);
      return observation;
    };
    directory(root);
    const scanDescendants = (start) => {
      const pending = [start];
      const seen = new Set();
      while (pending.length) {
        const path = pending.pop();
        const stat = boundaryStat(path);
        const identity = `${stat?.dev}:${stat?.ino}`;
        requireBoundary(!seen.has(identity), 'BOUNDARY_PATH_UNSUPPORTED', 'A directory has an unsupported filesystem alias.');
        seen.add(identity);
        for (const name of directory(path).names) {
          const child = join(path, name);
          const item = boundaryStat(child);
          const spelling = boundarySpelling(path, name, item);
          if (/[^\x00-\x7f]/.test(spelling)) caseSensitive = false;
          requireBoundary(item && !item.isSymbolicLink(), 'BOUNDARY_PATH_UNSAFE', 'A directory boundary contains a symlink or changed entry.');
          requireBoundary(item.dev === rootStat.dev, 'BOUNDARY_PATH_UNSUPPORTED', 'A boundary must not cross a filesystem device.');
          requireBoundary(item.isDirectory() || item.isFile() && item.nlink === 1,
            'BOUNDARY_PATH_UNSUPPORTED', 'A boundary contains a special object or hard-linked file.');
          if (item.isDirectory()) pending.push(child);
        }
      }
    };
    const boundary = Array.from(entries, (raw) => {
      const parsed = boundaryEntry(raw, true);
      const folded = boundaryCollisionKey(parsed.path.replace(/\/$/, ''));
      if (/[^\x00-\x7f]/.test(parsed.path)) caseSensitive = false;
      requireBoundary(!gitlinks.some((link) => folded === link || folded.startsWith(`${link}/`)
        || parsed.directory && link.startsWith(`${folded}/`)),
      'BOUNDARY_PATH_UNSAFE', 'A boundary must not include a submodule path.');
      let parent = root;
      const canonical = [];
      let absent = false;
      for (const [i, component] of parsed.components.entries()) {
        if (absent) { canonical.push(component); continue; }
        const observation = directory(parent);
        // On POSIX a backslash can be a literal filename character. Never
        // normalize such a name into an unrelated slash-separated target.
        if (sep === '/' && raw.includes('\\')) {
          for (let end = i + 1; end <= parsed.components.length; end++) {
            const spelling = parsed.components.slice(i, end).join('\\');
            const candidates = [spelling];
            if (end === parsed.components.length && raw.endsWith('\\')) candidates.push(`${spelling}\\`);
            requireBoundary(!candidates.some((name) => name.includes('\\') && boundaryStat(join(parent, name))),
              'BOUNDARY_PATH_UNSUPPORTED', 'A separator spelling also names a literal backslash target.');
          }
        }
        const target = join(parent, component);
        const stat = boundaryStat(target);
        if (!stat) { absent = true; caseSensitive = false; canonical.push(component); continue; }
        requireBoundary(!stat.isSymbolicLink(), 'BOUNDARY_PATH_UNSAFE', 'A boundary path must not contain symlinks.');
        requireBoundary(stat.dev === rootStat.dev, 'BOUNDARY_PATH_UNSUPPORTED', 'A boundary must not cross a filesystem device.');
        const spelling = observation.names.includes(component) ? component : observation.names.find((name) =>
          sameBoundaryObject(boundaryStat(join(parent, name)), stat));
        requireBoundary(spelling !== undefined, 'BOUNDARY_IO_ERROR', 'The canonical filename cannot be observed.');
        canonical.push(boundarySpelling(parent, spelling, stat));
        parent = join(parent, spelling);
        requireBoundary(belowBoundary(root, realpathSync(parent)) && ![admin, common].some((base) => belowBoundary(base, parent)),
          'BOUNDARY_PATH_UNSAFE', 'A boundary must not enter administrative state or leave the checkout.');
        const last = i === parsed.components.length - 1;
        if (stat.isDirectory()) {
          requireBoundary(!last || parsed.directory, 'BOUNDARY_PATH_INVALID', 'A directory boundary must end with a slash.');
          directory(parent);
          if (last) scanDescendants(parent);
        } else {
          requireBoundary(last && !parsed.directory && stat.isFile(), 'BOUNDARY_PATH_INVALID', 'An exact boundary must name a file.');
          requireBoundary(stat.nlink === 1, 'BOUNDARY_PATH_UNSUPPORTED', 'Hard-linked file boundaries are not supported.');
        }
      }
      return `${canonical.join('/')}${parsed.directory ? '/' : ''}`;
    });
    return { boundary: [...new Set(boundary)].sort(compareText), pathRules: { caseSensitive } };
  } catch (error) {
    if (error instanceof BoundaryPathError) throw error;
    throw new BoundaryPathError('BOUNDARY_IO_ERROR', 'Boundary filesystem observations cannot be completed.');
  }
}

function plannedEvidence(raw, reasonCodes) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    reasonCodes.push('PLANNED_EVIDENCE_OPAQUE');
    return { files: [], estimatedChangedLines: null, persistedData: null };
  }
  if (raw.complete !== true) reasonCodes.push('PLANNED_FILES_INCOMPLETE');
  if (!Array.isArray(raw.files)) {
    reasonCodes.push('PLANNED_FILES_OPAQUE');
    return {
      files: [],
      estimatedChangedLines: Number.isInteger(raw.estimatedChangedLines) ? raw.estimatedChangedLines : null,
      persistedData: typeof raw.persistedData === 'boolean' ? raw.persistedData : null,
    };
  }
  const files = [];
  for (const entry of raw.files) {
    const path = normalizedPath(typeof entry === 'string' ? entry : entry?.path);
    if (!path) {
      reasonCodes.push('PLANNED_PATH_OPAQUE');
      continue;
    }
    const contentHash =
      typeof entry === 'object' && /^[0-9a-f]{64}$/i.test(entry?.contentHash ?? '')
        ? entry.contentHash.toLowerCase()
        : null;
    if (typeof entry === 'object' && entry?.contentHash != null && contentHash === null) {
      reasonCodes.push('PLANNED_CONTENT_HASH_OPAQUE');
    }
    files.push({
      path,
      contentRead: typeof entry === 'object' && entry?.contentRead === true,
      contentHash,
    });
  }
  files.sort((a, b) => compareText(a.path, b.path));
  if (!files.length) reasonCodes.push('PLANNED_FILES_EMPTY');
  if (new Set(files.map(({ path }) => path)).size !== files.length) reasonCodes.push('PLANNED_PATH_DUPLICATE');
  const estimatedChangedLines =
    Number.isInteger(raw.estimatedChangedLines) && raw.estimatedChangedLines >= 0
      ? raw.estimatedChangedLines
      : null;
  const persistedData = typeof raw.persistedData === 'boolean' ? raw.persistedData : null;
  return { files, estimatedChangedLines, persistedData };
}

function normalizedStatus(value) {
  if (typeof value !== 'string') return null;
  const match = /^([ACDMRTUXB])(\d{1,3})?$/.exec(value.toUpperCase());
  if (
    !match ||
    (match[2] && (!['R', 'C'].includes(match[1]) || Number(match[2]) > 100))
  ) {
    return null;
  }
  return { raw: value.toUpperCase(), code: match[1] };
}

function finalEvidence(raw, reasonCodes) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    reasonCodes.push('FINAL_EVIDENCE_OPAQUE');
    return { changedFiles: null, files: [], persistedData: null };
  }
  if (raw.complete !== true) reasonCodes.push('FINAL_DIFF_INCOMPLETE');
  if (!Array.isArray(raw.files)) {
    reasonCodes.push('FINAL_FILES_OPAQUE');
    return {
      changedFiles: Number.isInteger(raw.changedFiles) ? raw.changedFiles : null,
      files: [],
      persistedData: typeof raw.persistedData === 'boolean' ? raw.persistedData : null,
    };
  }
  const files = [];
  for (const entry of raw.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      reasonCodes.push('FINAL_ENTRY_OPAQUE');
      continue;
    }
    const status = normalizedStatus(entry.status);
    const path = normalizedPath(entry.path);
    const previousPath = entry.previousPath == null ? null : normalizedPath(entry.previousPath);
    const additions = Number.isInteger(entry.additions) && entry.additions >= 0 ? entry.additions : null;
    const deletions = Number.isInteger(entry.deletions) && entry.deletions >= 0 ? entry.deletions : null;
    const contentHash = /^[0-9a-f]{64}$/i.test(entry.contentHash ?? '') ? entry.contentHash.toLowerCase() : null;
    if (!status) reasonCodes.push('FINAL_STATUS_OPAQUE');
    if (!path) reasonCodes.push('FINAL_PATH_OPAQUE');
    if (additions === null || deletions === null) reasonCodes.push('FINAL_NUMSTAT_OPAQUE');
    if (entry.contentHash != null && contentHash === null) reasonCodes.push('FINAL_CONTENT_HASH_OPAQUE');
    if (status && ['U', 'X', 'B', 'T'].includes(status.code)) reasonCodes.push('FINAL_STATUS_UNSAFE');
    if (status && ['R', 'C'].includes(status.code) && !previousPath) reasonCodes.push('FINAL_RENAME_SOURCE_OPAQUE');
    if (status && !['R', 'C'].includes(status.code) && entry.previousPath != null) {
      reasonCodes.push('FINAL_RENAME_STATUS_INCONSISTENT');
    }
    if (status && path) {
      files.push({
        status: status.raw,
        previousPath,
        path,
        additions,
        deletions,
        contentRead: entry.contentRead === true,
        previousContentRead: entry.previousContentRead === true,
        contentHash,
      });
    }
  }
  files.sort((a, b) => compareText(
    `${a.previousPath ?? ''}\0${a.path}\0${a.status}`,
    `${b.previousPath ?? ''}\0${b.path}\0${b.status}`,
  ));
  if (!files.length) reasonCodes.push('FINAL_FILES_EMPTY');
  if (new Set(files.map(({ path }) => path)).size !== files.length) reasonCodes.push('FINAL_PATH_DUPLICATE');
  const changedFiles = Number.isInteger(raw.changedFiles) && raw.changedFiles >= 0 ? raw.changedFiles : null;
  if (changedFiles === null) reasonCodes.push('FINAL_CHANGED_FILES_OPAQUE');
  else if (changedFiles !== raw.files.length || changedFiles !== files.length) reasonCodes.push('FINAL_CHANGED_FILES_INCONSISTENT');
  return {
    changedFiles,
    files,
    persistedData: typeof raw.persistedData === 'boolean' ? raw.persistedData : null,
  };
}

function evidencePaths(mode, evidence) {
  if (mode === 'planned') return evidence.files.map(({ path }) => path);
  return evidence.files.flatMap(({ previousPath, path }) => previousPath ? [previousPath, path] : [path]);
}

function docsContentRead(mode, evidence) {
  if (mode === 'planned') return evidence.files.every(({ contentRead }) => contentRead);
  return evidence.files.every(({ status, contentRead, previousContentRead }) =>
    contentRead && (!['R', 'C'].includes(status[0]) || previousContentRead));
}

function isDocsPath(path) {
  return /^docs\//i.test(path) || /\.md$/i.test(path);
}

function sourceCompleteFromReasons(reasons) {
  return reasons.every((reason) => SOURCE_COMPLETE_REASONS.has(reason));
}

function canonicalDecisionEvidence(mode, evidence, reasons, globs) {
  const normalizationReasonCodes = canonicalReasons([
    ...reasons,
    ...intrinsicEvidenceReasons(mode, evidence),
  ]);
  const shared = {
    kind: mode,
    sourceComplete: sourceCompleteFromReasons(normalizationReasonCodes),
    normalizationReasonCodes,
    humanAuthorizationGlobs: globs,
    files: evidence.files,
    persistedData: evidence.persistedData,
  };
  return mode === 'planned'
    ? { ...shared, estimatedChangedLines: evidence.estimatedChangedLines }
    : { ...shared, changedFiles: evidence.changedFiles };
}

function intrinsicEvidenceReasons(mode, evidence) {
  const reasons = [];
  if (!evidence.files.length) {
    reasons.push(mode === 'planned' ? 'PLANNED_FILES_EMPTY' : 'FINAL_FILES_EMPTY');
  }
  if (new Set(evidence.files.map(({ path }) => path)).size !== evidence.files.length) {
    reasons.push(mode === 'planned' ? 'PLANNED_PATH_DUPLICATE' : 'FINAL_PATH_DUPLICATE');
  }
  if (mode === 'final') {
    if (evidence.changedFiles === null) reasons.push('FINAL_CHANGED_FILES_OPAQUE');
    else if (evidence.changedFiles !== evidence.files.length) {
      reasons.push('FINAL_CHANGED_FILES_INCONSISTENT');
    }
    for (const file of evidence.files) {
      const code = file.status[0];
      if (['U', 'X', 'B', 'T'].includes(code)) reasons.push('FINAL_STATUS_UNSAFE');
      if (['R', 'C'].includes(code) && file.previousPath === null) {
        reasons.push('FINAL_RENAME_SOURCE_OPAQUE');
      }
      if (!['R', 'C'].includes(code) && file.previousPath !== null) {
        reasons.push('FINAL_RENAME_STATUS_INCONSISTENT');
      }
      if (file.additions === null || file.deletions === null) {
        reasons.push('FINAL_NUMSTAT_OPAQUE');
      }
    }
  }
  return canonicalReasons(reasons);
}

function validPlannedFile(file) {
  return (
    hasExactKeys(file, PLANNED_FILE_KEYS) &&
    normalizedPath(file.path) === file.path &&
    typeof file.contentRead === 'boolean' &&
    (file.contentHash === null || HEX_64.test(file.contentHash))
  );
}

function validFinalFile(file) {
  const status = normalizedStatus(file?.status);
  return (
    hasExactKeys(file, FINAL_FILE_KEYS) &&
    status?.raw === file.status &&
    normalizedPath(file.path) === file.path &&
    (file.previousPath === null || normalizedPath(file.previousPath) === file.previousPath) &&
    (file.additions === null || (Number.isSafeInteger(file.additions) && file.additions >= 0)) &&
    (file.deletions === null || (Number.isSafeInteger(file.deletions) && file.deletions >= 0)) &&
    typeof file.contentRead === 'boolean' &&
    typeof file.previousContentRead === 'boolean' &&
    (file.contentHash === null || HEX_64.test(file.contentHash))
  );
}

function validDecisionEvidence(mode, evidence) {
  const expectedKeys = mode === 'planned' ? PLANNED_EVIDENCE_KEYS : FINAL_EVIDENCE_KEYS;
  if (
    !hasExactKeys(evidence, expectedKeys) ||
    evidence.kind !== mode ||
    typeof evidence.sourceComplete !== 'boolean' ||
    !Array.isArray(evidence.normalizationReasonCodes) ||
    evidence.normalizationReasonCodes.some(
      (reason) => typeof reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(reason),
    ) ||
    !sameValue(
      canonicalReasons(evidence.normalizationReasonCodes),
      evidence.normalizationReasonCodes,
    ) ||
    evidence.sourceComplete !== sourceCompleteFromReasons(evidence.normalizationReasonCodes) ||
    !Array.isArray(evidence.humanAuthorizationGlobs) ||
    evidence.humanAuthorizationGlobs.some(
      (glob) => typeof glob !== 'string' || glob.length === 0,
    ) ||
    !sameValue(normalizedGlobs(evidence.humanAuthorizationGlobs), evidence.humanAuthorizationGlobs) ||
    !HUMAN_AUTHORIZATION_GLOBS.every(
      (glob) => evidence.humanAuthorizationGlobs.includes(glob),
    ) ||
    !Array.isArray(evidence.files) ||
    !evidence.files.every(mode === 'planned' ? validPlannedFile : validFinalFile) ||
    ![null, true, false].includes(evidence.persistedData)
  ) {
    return false;
  }
  const sortedFiles = [...evidence.files].sort((left, right) =>
    compareText(
      mode === 'planned'
        ? left.path
        : `${left.previousPath ?? ''}\0${left.path}\0${left.status}`,
      mode === 'planned'
        ? right.path
        : `${right.previousPath ?? ''}\0${right.path}\0${right.status}`,
    ));
  if (!sameValue(sortedFiles, evidence.files)) return false;
  if (
    mode === 'planned' &&
    !(
      evidence.estimatedChangedLines === null ||
      (Number.isSafeInteger(evidence.estimatedChangedLines) &&
        evidence.estimatedChangedLines >= 0)
    )
  ) {
    return false;
  }
  if (
    mode === 'final' &&
    !(
      evidence.changedFiles === null ||
      (Number.isSafeInteger(evidence.changedFiles) && evidence.changedFiles >= 0)
    )
  ) {
    return false;
  }
  const intrinsic = intrinsicEvidenceReasons(mode, evidence);
  return intrinsic.every((reason) => evidence.normalizationReasonCodes.includes(reason));
}

function laneDecision(mode, evidence, structuralReasons, globs) {
  if (structuralReasons.length) return { lane: 'full', reasonCodes: structuralReasons };
  const paths = evidencePaths(mode, evidence);
  if (matchHumanAuthorization(paths, globs).length) {
    return { lane: 'full', reasonCodes: ['HUMAN_AUTHORIZATION_PATH'] };
  }
  if (paths.every(isDocsPath)) {
    return docsContentRead(mode, evidence)
      ? { lane: 'docs', reasonCodes: [] }
      : { lane: 'full', reasonCodes: ['DOCS_CONTENT_UNREAD'] };
  }
  const reasons = [];
  if (evidence.files.length > 2) reasons.push('SMALL_FILE_LIMIT_EXCEEDED');
  const changedLines =
    mode === 'planned'
      ? evidence.estimatedChangedLines
      : evidence.files.reduce((total, file) =>
        total === null || file.additions === null || file.deletions === null
          ? null
          : total + file.additions + file.deletions, 0);
  if (changedLines === null) reasons.push('SMALL_LINE_ESTIMATE_OPAQUE');
  else if (changedLines > 50) reasons.push('SMALL_LINE_LIMIT_EXCEEDED');
  if (evidence.persistedData !== false) reasons.push('SMALL_PERSISTED_DATA_UNVERIFIED');
  return reasons.length ? { lane: 'full', reasonCodes: reasons } : { lane: 'small', reasonCodes: [] };
}

function validSubject(mode, subject, allowUnavailable) {
  if (mode === 'final') {
    return (
      hasExactKeys(subject, ['headOid', 'kind']) &&
      subject.kind === 'head' &&
      HEX_40.test(subject.headOid) &&
      (allowUnavailable || subject.headOid !== ZERO_40)
    );
  }
  return (
    hasExactKeys(subject, ['artifactVersion', 'fingerprint', 'kind']) &&
    subject.kind === 'plan' &&
    Number.isSafeInteger(subject.artifactVersion) &&
    subject.artifactVersion > 0 &&
    HEX_64.test(subject.fingerprint) &&
    (allowUnavailable || subject.fingerprint !== ZERO_64)
  );
}

function proofContextReasons(proof) {
  const reasons = [];
  if (proof.configuredBase.ref === '(unavailable)') reasons.push('BASE_REF_UNAVAILABLE');
  if (proof.configuredBase.oid === ZERO_40) reasons.push('BASE_OID_UNAVAILABLE');
  if (proof.mode === 'planned' && proof.subject.fingerprint === ZERO_64) {
    reasons.push('PLAN_SUBJECT_UNAVAILABLE');
  }
  if (proof.mode === 'final' && proof.subject.headOid === ZERO_40) {
    reasons.push('HEAD_SUBJECT_UNAVAILABLE');
  }
  return reasons;
}

function proofHashFor(proof) {
  return sha256({
    kind: proof.kind,
    version: proof.version,
    mode: proof.mode,
    lane: proof.lane,
    configuredBase: proof.configuredBase,
    subject: proof.subject,
    inputHash: proof.inputHash,
    reasonCodes: proof.reasonCodes,
  });
}

function sealProof(proof) {
  const proofHash = proofHashFor(proof);
  return {
    ...proof,
    proofHash,
    fingerprint: sha256({ kind: 'autoloop-lane-fingerprint', proofHash }),
  };
}

export function verifyLaneProof(proof, expectations = {}) {
  if (
    !hasExactKeys(proof, PROOF_KEYS) ||
    proof.kind !== 'autoloop-lane-proof' ||
    proof.version !== 1 ||
    !['planned', 'final'].includes(proof.mode) ||
    !['docs', 'small', 'full'].includes(proof.lane) ||
    !hasExactKeys(proof.configuredBase, ['oid', 'ref']) ||
    typeof proof.configuredBase.ref !== 'string' ||
    proof.configuredBase.ref.length === 0 ||
    /[\x00-\x1f\x7f]/.test(proof.configuredBase.ref) ||
    !HEX_40.test(proof.configuredBase.oid) ||
    !validSubject(proof.mode, proof.subject, true) ||
    !validDecisionEvidence(proof.mode, proof.decisionEvidence) ||
    !HEX_64.test(proof.inputHash) ||
    !HEX_64.test(proof.proofHash) ||
    !HEX_64.test(proof.fingerprint) ||
    !Array.isArray(proof.reasonCodes) ||
    proof.reasonCodes.some(
      (reason) => typeof reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(reason),
    ) ||
    !sameValue(canonicalReasons(proof.reasonCodes), proof.reasonCodes)
  ) {
    return false;
  }
  const contextReasons = proofContextReasons(proof);
  if (
    !contextReasons.every((reason) =>
      proof.decisionEvidence.normalizationReasonCodes.includes(reason))
  ) {
    return false;
  }
  const decision = laneDecision(
    proof.mode,
    proof.decisionEvidence,
    proof.decisionEvidence.normalizationReasonCodes,
    proof.decisionEvidence.humanAuthorizationGlobs,
  );
  const reasonCodes = canonicalReasons(decision.reasonCodes);
  if (decision.lane !== proof.lane || !sameValue(reasonCodes, proof.reasonCodes)) {
    return false;
  }
  const inputHash = sha256({
    mode: proof.mode,
    configuredBase: proof.configuredBase,
    subject: proof.subject,
    decisionEvidence: proof.decisionEvidence,
  });
  if (
    inputHash !== proof.inputHash ||
    proofHashFor(proof) !== proof.proofHash ||
    sha256({ kind: 'autoloop-lane-fingerprint', proofHash: proof.proofHash }) !==
      proof.fingerprint
  ) {
    return false;
  }
  if (
    expectations === null ||
    typeof expectations !== 'object' ||
    Array.isArray(expectations) ||
    Object.keys(expectations).some(
      (key) => !['expectedBaseOid', 'expectedSubject'].includes(key),
    )
  ) {
    return false;
  }
  if (
    expectations.expectedBaseOid !== undefined &&
    (!HEX_40.test(expectations.expectedBaseOid) ||
      expectations.expectedBaseOid !== proof.configuredBase.oid)
  ) {
    return false;
  }
  if (
    expectations.expectedSubject !== undefined &&
    (!validSubject(proof.mode, expectations.expectedSubject, false) ||
      !sameValue(expectations.expectedSubject, proof.subject))
  ) {
    return false;
  }
  return true;
}

export function classifyLaneProof(input = {}, options = {}) {
  const structuralReasons = [];
  const candidate = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  if (candidate !== input) structuralReasons.push('INPUT_OPAQUE');
  if (settings !== options) structuralReasons.push('OPTIONS_OPAQUE');
  const mode = candidate.mode === 'final' ? 'final' : 'planned';
  if (!['planned', 'final'].includes(candidate.mode)) structuralReasons.push('MODE_INVALID');
  const configuredBase = normalizedBase(candidate.configuredBase, structuralReasons);
  const subject = normalizedSubject(mode, candidate.subject, structuralReasons);
  const evidence =
    mode === 'final'
      ? finalEvidence(candidate.final, structuralReasons)
      : plannedEvidence(candidate.planned, structuralReasons);
  const extraGlobs = settings.extraHumanAuthorizationGlobs;
  if (
    extraGlobs != null &&
    (!Array.isArray(extraGlobs) || extraGlobs.some((glob) => typeof glob !== 'string' || glob.length === 0))
  ) {
    structuralReasons.push('HUMAN_AUTHORIZATION_POLICY_OPAQUE');
  }
  const globs = normalizedGlobs([
    ...HUMAN_AUTHORIZATION_GLOBS,
    ...(Array.isArray(extraGlobs) ? extraGlobs : []),
  ]);
  const decisionEvidence = canonicalDecisionEvidence(
    mode,
    evidence,
    structuralReasons,
    globs,
  );
  const decision = laneDecision(
    mode,
    decisionEvidence,
    decisionEvidence.normalizationReasonCodes,
    globs,
  );
  const reasonCodes = [...new Set(decision.reasonCodes)].sort();
  const inputHash = sha256({
    mode,
    configuredBase,
    subject,
    decisionEvidence,
  });
  return sealProof({
    kind: 'autoloop-lane-proof',
    version: 1,
    mode,
    lane: decision.lane,
    configuredBase,
    subject,
    decisionEvidence,
    inputHash,
    reasonCodes,
  });
}

function planned(files, extras = {}) {
  return {
    mode: 'planned',
    configuredBase: { ref: 'origin/main', oid: '1'.repeat(40) },
    subject: { kind: 'plan', artifactVersion: 3, fingerprint: '5'.repeat(64) },
    planned: { complete: true, files, estimatedChangedLines: 20, persistedData: false, ...extras },
  };
}

function final(files, extras = {}) {
  return {
    mode: 'final',
    configuredBase: { ref: 'origin/main', oid: '1'.repeat(40) },
    subject: { kind: 'head', headOid: '3'.repeat(40) },
    final: {
      complete: true,
      changedFiles: files.length,
      files,
      persistedData: false,
      ...extras,
    },
  };
}

function boundarySelfTest() {
  const sensitive = { caseSensitive: true };
  const conservative = { caseSensitive: false };
  const intersections = [
    [['src/a'], ['src/a'], ['src/a']],
    [['src/'], ['src/a'], ['src/a']],
    [['src/a/'], ['src/'], ['src/a/']],
    [['src/'], ['src/ab/'], ['src/ab/']],
    [['src/a/'], ['src/ab/'], []],
    [['src'], ['src/'], ['src']],
    [['src/a'], ['src/ab'], []],
    [['src/'], ['srcx/a'], []],
    [['Src/A'], ['src/a'], []],
  ];
  for (const [left, right, expected] of intersections) {
    assert.deepEqual(intersectBoundaries(left, right, sensitive), expected);
    assert.deepEqual(intersectBoundaries(right, left, sensitive), expected, 'Intersection must be symmetric.');
  }
  assert.deepEqual(intersectBoundaries(['Src/'], ['src/A'], conservative), ['src/A']);
  assert.deepEqual(intersectBoundaries(['src/A'], ['Src/'], conservative), ['src/A']);
  assert.deepEqual(intersectBoundaries(['SRC/a', 'src/a'], ['src/a', 'SRC/a'], conservative), ['SRC/a']);
  assert.deepEqual(intersectBoundaries(['Straße/'], ['STRASSE/a'], conservative), ['STRASSE/a']);
  assert.deepEqual(intersectBoundaries(['ẞ.txt'], ['SS.TXT'], conservative), ['SS.TXT']);
  assert.deepEqual(intersectBoundaries(['ς.txt'], ['σ.txt'], conservative), ['ς.txt']);
  assert.deepEqual(intersectBoundaries(['CAFÉ/'], ['café/a'], conservative), ['café/a']);
  assert.deepEqual(intersectBoundaries(['z', 'a', 'z'], ['z', 'a'], sensitive), ['a', 'z']);
  assert.throws(() => intersectBoundaries(['a/.️/x'], [], sensitive), { code: 'BOUNDARY_PATH_UNSUPPORTED' });
  assert.throws(() => intersectBoundaries(['../x'], ['x'], sensitive), { code: 'BOUNDARY_PATH_INVALID' });
  assert.throws(() => intersectBoundaries([], ['../x'], sensitive), { code: 'BOUNDARY_PATH_INVALID' });
  assert.throws(() => intersectBoundaries(Array(1), ['x'], sensitive), { code: 'BOUNDARY_PATH_INVALID' });

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'autoloop-lane-paths-')));
  const root = join(scratch, 'repo');
  mkdirSync(root);
  const git = (...args) => boundaryGit(root, args).trim();
  try {
    git('init', '-q');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
    mkdirSync(join(root, 'Src', 'empty'), { recursive: true });
    writeFileSync(join(root, 'Src', 'File.txt'), 'fixture');
    const expected = ['Src/File.txt', 'new/file.txt'];
    const actual = canonicalBoundary(root, ['new\\file.txt', 'Src/File.txt', 'Src/File.txt']);
    assert.deepEqual(actual.boundary, expected, 'Canonical spelling and unique order must be stable.');
    assert.throws(() => canonicalBoundary(root, Array(1)), { code: 'BOUNDARY_PATH_INVALID' });
    assert.throws(() => canonicalBoundary(root, null), { code: 'BOUNDARY_PATH_INVALID' });
    assert.equal(typeof actual.pathRules.caseSensitive, 'boolean');
    const observedSensitive = !existsSync(join(root, '.GIT')) && !existsSync(join(root, 'sRC'))
      && !existsSync(join(root, 'Src', 'file.txt'));
    const existing = canonicalBoundary(root, ['Src/File.txt']);
    assert.equal(existing.pathRules.caseSensitive, observedSensitive, 'Existing directory observations, not a host-wide guess, select case rules.');
    const alias = existsSync(join(root, 'src', 'file.txt'));
    assert.deepEqual(canonicalBoundary(root, ['src/file.txt']).boundary,
      alias ? ['Src/File.txt'] : ['src/file.txt'], 'Only a real filesystem alias can change canonical spelling.');
    git('config', 'core.ignoreCase', !existing.pathRules.caseSensitive ? 'false' : 'true');
    assert.deepEqual(canonicalBoundary(root, ['Src/File.txt']), existing);
    git('config', 'core.ignoreCase', actual.pathRules.caseSensitive ? 'true' : 'false');
    assert.deepEqual(canonicalBoundary(root, ['new/file.txt', 'Src/File.txt']), actual, 'Git config must not select case rules.');
    assert.equal(canonicalBoundary(root, ['Src/empty/']).pathRules.caseSensitive, false, 'An empty directory gives no case proof.');
    assert.deepEqual(canonicalBoundary(root, ['Src\\File.txt']).boundary, ['Src/File.txt']);
    assert.deepEqual(canonicalBoundary(root, ['Src/']).boundary, ['Src/']);
    assert.deepEqual(canonicalBoundary(root, ['future/']).boundary, ['future/']);
    mkdirSync(join(root, 'Café'));
    writeFileSync(join(root, 'Café', 'Résumé.txt'), 'NFC Unicode');
    writeFileSync(join(root, 'Café', '資料-😀.txt'), 'NFC Unicode without a case mapping');
    const unicode = canonicalBoundary(root, ['Café/Résumé.txt', 'Café/資料-😀.txt']);
    assert.deepEqual(unicode.boundary, ['Café/Résumé.txt', 'Café/資料-😀.txt']);
    assert.equal(unicode.pathRules.caseSensitive, false, 'Unicode comparisons use conservative case and normalization keys.');
    assert.deepEqual(canonicalBoundary(root, ['Café/']).boundary, ['Café/']);
    const unicodeAlias = existsSync(join(root, 'café', 'résumé.txt'));
    assert.deepEqual(canonicalBoundary(root, ['café/résumé.txt']).boundary,
      unicodeAlias ? ['Café/Résumé.txt'] : ['café/résumé.txt'], 'Unicode case spelling must follow actual filesystem identity.');
    mkdirSync(join(root, 'normalization'));
    const decomposed = join(root, 'normalization', 'é.txt');
    writeFileSync(decomposed, 'decomposed filesystem control');
    const decomposedStat = lstatSync(decomposed);
    const normalizedStat = existsSync(join(root, 'normalization', 'é.txt')) ? lstatSync(join(root, 'normalization', 'é.txt')) : null;
    if (normalizedStat && decomposedStat.dev === normalizedStat.dev && decomposedStat.ino === normalizedStat.ino) {
      assert.deepEqual(canonicalBoundary(root, ['normalization/é.txt']).boundary, ['normalization/é.txt']);
      assert.deepEqual(canonicalBoundary(root, ['normalization/']).boundary, ['normalization/']);
    } else {
      assert.throws(() => canonicalBoundary(root, ['normalization/']), { code: 'BOUNDARY_PATH_UNSUPPORTED' });
    }
    assert.throws(() => canonicalBoundary(root, ['normalization/é.txt']), { code: 'BOUNDARY_PATH_UNSUPPORTED' });
    assert.throws(() => canonicalBoundary(root, ['Src']), { code: 'BOUNDARY_PATH_INVALID' });
    assert.throws(() => canonicalBoundary(root, ['Src/File.txt/']), { code: 'BOUNDARY_PATH_INVALID' });
    for (const entry of ['', '/x', 'C:/x', 'C:x', '//host/x', '\\\\host\\x', '../x', './x', 'a/../x', 'a//x', 'a//', 'a/*', 'a/?', 'a/[x]', 'a/{x,y}', 'a/\0x', 'a/\nx', 'a/\x7fx']) {
      assert.throws(() => canonicalBoundary(root, [entry]), { code: 'BOUNDARY_PATH_INVALID' }, JSON.stringify(entry));
    }
    for (const entry of ['a/\ufffd', 'a/e\u0301', 'a/x‌','a/x.', 'a/x ', 'a/NUL', 'a/file:stream']) {
      assert.throws(() => canonicalBoundary(root, [entry]), { code: 'BOUNDARY_PATH_UNSUPPORTED' }, JSON.stringify(entry));
    }
    for (const entry of ['.git/config', '.GIT/config', '.git./config', '.git /config', '.git::$DATA/config', 'a/.git/x', 'a/GIT~1/config']) {
      assert.throws(() => canonicalBoundary(root, [entry]), { code: 'BOUNDARY_PATH_UNSAFE' }, entry);
    }
    symlinkSync(scratch, join(root, 'outside'));
    symlinkSync(join(root, 'Src'), join(root, 'inside'));
    for (const entry of ['outside/x', 'inside/File.txt', 'outside/', 'inside']) {
      assert.throws(() => canonicalBoundary(root, [entry]), { code: 'BOUNDARY_PATH_UNSAFE' }, entry);
    }
    mkdirSync(join(root, 'unsafe'));
    symlinkSync(scratch, join(root, 'unsafe', 'escape'));
    assert.throws(() => canonicalBoundary(root, ['unsafe/']), { code: 'BOUNDARY_PATH_UNSAFE' });
    mkdirSync(join(root, 'nested'));
    git('-C', join(root, 'nested'), 'init', '-q');
    assert.throws(() => canonicalBoundary(root, ['nested/new']), { code: 'BOUNDARY_PATH_UNSAFE' });
    mkdirSync(join(root, 'container'));
    git('init', '--bare', '-q', join(root, 'container', 'bare'));
    assert.throws(() => canonicalBoundary(root, ['container/']), { code: 'BOUNDARY_PATH_UNSAFE' });
    git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},vendor/submodule`);
    assert.throws(() => canonicalBoundary(root, ['vendor/']), { code: 'BOUNDARY_PATH_UNSAFE' });
    assert.throws(() => canonicalBoundary(root, ['vendor/submodule/new']), { code: 'BOUNDARY_PATH_UNSAFE' });
    if (sep === '/') {
      writeFileSync(join(root, 'Src\\'), 'literal trailing backslash');
      assert.throws(() => canonicalBoundary(root, ['Src\\']), { code: 'BOUNDARY_PATH_UNSUPPORTED' });
      writeFileSync(join(root, 'Src\\File.txt'), 'literal backslash');
      assert.throws(() => canonicalBoundary(root, ['Src\\File.txt']), { code: 'BOUNDARY_PATH_UNSUPPORTED' });
      mkdirSync(join(root, 'literal'));
      writeFileSync(join(root, 'literal', 'a\\b'), 'literal backslash');
      assert.throws(() => canonicalBoundary(root, ['literal/a\\b']), { code: 'BOUNDARY_PATH_UNSUPPORTED' });
      assert.throws(() => canonicalBoundary(root, ['literal/']), { code: 'BOUNDARY_PATH_UNSUPPORTED' });
    }
    linkSync(join(root, 'Src', 'File.txt'), join(root, 'hardlink'));
    assert.throws(() => canonicalBoundary(root, ['hardlink']), { code: 'BOUNDARY_PATH_UNSUPPORTED' });
    assert.throws(() => canonicalBoundary(join(root, 'inside'), ['File.txt']), { code: 'BOUNDARY_ROOT_INVALID' });
    assert.throws(() => canonicalBoundary(scratch, ['new']), { code: 'BOUNDARY_ROOT_INVALID' });
    console.log('boundary self-test OK (pure intersections and real Git/filesystem checks)');
  } finally {
    // Retain fixtures when cleanup permission is not available.
    console.log(`Retained boundary fixture: ${scratch}`);
  }
}

function selfTest() {
  boundarySelfTest();
  const docs = classifyLaneProof(planned([{ path: 'docs/guide.md', contentRead: true }]));
  const unreadDocs = classifyLaneProof(planned([{ path: 'docs/guide.md', contentRead: false }]));
  const small = classifyLaneProof(planned([{ path: 'src/one.mjs' }, { path: 'src/two.mjs' }]));
  const opaqueSmall = classifyLaneProof(planned([{ path: 'src/one.mjs' }], { estimatedChangedLines: null }));
  const finalDocs = classifyLaneProof(final([
    { status: 'M', path: 'docs/guide.md', additions: 2, deletions: 1, contentRead: true },
  ]));
  const safeRename = classifyLaneProof(final([
    {
      status: 'R100',
      previousPath: 'docs/old.md',
      path: 'docs/new.md',
      additions: 0,
      deletions: 0,
      contentRead: true,
      previousContentRead: true,
    },
  ]));
  const opaqueRename = classifyLaneProof(final([
    { status: 'R100', path: 'docs/new.md', additions: 0, deletions: 0, contentRead: true },
  ]));
  const binary = classifyLaneProof(final([
    { status: 'M', path: 'src/image.png', additions: '-', deletions: '-', contentRead: true },
  ]));
  const incompleteFinal = classifyLaneProof(final([
    { status: 'M', path: 'src/one.mjs', additions: 1, deletions: 1 },
  ], { complete: false }));
  const changedFilesMismatch = classifyLaneProof(final([
    { status: 'M', path: 'src/one.mjs', additions: 1, deletions: 1 },
  ], { changedFiles: 2 }));
  const unsafeStatus = classifyLaneProof(final([
    { status: 'U', path: 'src/one.mjs', additions: 1, deletions: 1 },
  ]));
  const escalatedRename = classifyLaneProof(final([
    {
      status: 'R100',
      previousPath: '.githooks/pre-push',
      path: 'docs/pre-push.md',
      additions: 1,
      deletions: 1,
      contentRead: true,
      previousContentRead: true,
    },
  ]));
  const escalated = classifyLaneProof(planned([{ path: '.opencode/plugins/autoloop.js', contentRead: true }]));
  const baseChanged = classifyLaneProof({
    ...planned([{ path: 'docs/guide.md', contentRead: true }]),
    configuredBase: { ref: 'origin/release', oid: '2'.repeat(40) },
  });
  const headChangedInput = final([
    { status: 'M', path: 'docs/guide.md', additions: 2, deletions: 1, contentRead: true },
  ]);
  headChangedInput.subject = { kind: 'head', headOid: '4'.repeat(40) };
  const headChanged = classifyLaneProof(headChangedInput);
  const opaqueInput = classifyLaneProof(null);
  const nullPlanned = classifyLaneProof({ ...planned([]), planned: null });
  const traversalPlanned = classifyLaneProof(planned([
    { path: '../.opencode/plugins/autoloop.js', contentRead: true },
  ]));
  const malformedPlanned = classifyLaneProof({
    ...planned([]),
    planned: { complete: true, files: { path: 'docs/guide.md' } },
  });
  const forgedLane = sealProof({ ...opaqueSmall, lane: 'docs', reasonCodes: [] });
  const checks = [
    ['planned docs', docs.mode === 'planned' && docs.lane === 'docs'],
    ['unread docs fail closed', unreadDocs.lane === 'full' && unreadDocs.reasonCodes.includes('DOCS_CONTENT_UNREAD')],
    ['planned small', small.lane === 'small'],
    ['opaque small fails closed', opaqueSmall.lane === 'full'],
    ['final docs', finalDocs.mode === 'final' && finalDocs.lane === 'docs'],
    ['complete rename', safeRename.lane === 'docs'],
    ['opaque rename fails closed', opaqueRename.lane === 'full'],
    ['binary numstat fails closed', binary.lane === 'full'],
    ['incomplete final diff fails closed', incompleteFinal.lane === 'full'],
    ['changed-file mismatch fails closed', changedFilesMismatch.lane === 'full'],
    ['unsafe diff status fails closed', unsafeStatus.lane === 'full'],
    ['rename source is classified', escalatedRename.lane === 'full'],
    ['escalation wins', escalated.lane === 'full'],
    ['base-bound fingerprint', docs.fingerprint !== baseChanged.fingerprint],
    ['head-bound fingerprint', finalDocs.fingerprint !== headChanged.fingerprint],
    ['deterministic fingerprint', docs.fingerprint === classifyLaneProof(planned([{ path: 'docs/guide.md', contentRead: true }])).fingerprint],
    [
      'file order does not change fingerprint',
      small.fingerprint === classifyLaneProof(planned([
        { path: 'src/two.mjs' },
        { path: 'src/one.mjs' },
      ])).fingerprint,
    ],
    ['hash fields', [docs.inputHash, docs.proofHash, docs.fingerprint].every((value) => /^[0-9a-f]{64}$/.test(value))],
    ['proof verifies', verifyLaneProof(docs)],
    ['tampered proof rejected', !verifyLaneProof({ ...docs, lane: 'full' })],
    ['canonical decision evidence included', docs.decisionEvidence?.kind === 'planned'],
    ['planned subject bound', docs.subject?.kind === 'plan' && docs.subject.artifactVersion === 3],
    ['final subject bound', finalDocs.subject?.kind === 'head' && finalDocs.subject.headOid === '3'.repeat(40)],
    ['forged lane rejected after rehash', !verifyLaneProof(forgedLane)],
    [
      'expected subject mismatch rejected',
      !verifyLaneProof(docs, {
        expectedSubject: { kind: 'plan', artifactVersion: 4, fingerprint: '5'.repeat(64) },
      }),
    ],
    ['expected base mismatch rejected', !verifyLaneProof(docs, { expectedBaseOid: '2'.repeat(40) })],
    ['null planned source incomplete', nullPlanned.decisionEvidence?.sourceComplete === false],
    ['malformed planned source incomplete', malformedPlanned.decisionEvidence?.sourceComplete === false],
    ['path traversal source incomplete', traversalPlanned.decisionEvidence?.sourceComplete === false],
    ['opaque input fails closed', opaqueInput.lane === 'full' && verifyLaneProof(opaqueInput)],
    ['opaque policy paths fail closed', matchHumanAuthorization([null]).length === 1 && matchMergeProtected([null]).length === 1],
    [
      'a project protectedPaths glob protects an ordinary path',
      matchMergeProtected(['spec/a.md'], ['spec/**']).length === 1
        && matchMergeProtected(['spec/a.md']).length === 0
        && matchHumanAuthorization(['spec/a.md'], [...HUMAN_AUTHORIZATION_GLOBS, 'spec/**']).length === 1,
    ],
    [
      'project globs a built-in family covers are named as duplicates',
      JSON.stringify(duplicateProtectedGlobs(['spec/**', '.env*', 'secrets/**', 'compose.y*ml', '.github/workflows/**', 'infra/**']))
        === '[".env*",".github/workflows/**","secrets/**"]',
    ],
    // SPEC-elastic-scope: the unit's lane is the plan boundary plus every
    // recorded widening, for the exact-head and protected-path checks.
    [
      'a widened path is in the unit lane and a prefix matches only its directory',
      widenLane(['src/'], ['lib/b.mjs']).lane.every((entry) => inLane('lib/b.mjs', [entry]) || entry === 'src/')
        && !inLane('lib/c.mjs', ['src/'])
        && inLane('src/x/y.mjs', ['src/'])
        && !inLane('srcx/y.mjs', ['src/'])
        && !inLane('src', ['src/']),
    ],
    [
      'a widening into a protected path is a human:authorize hit, not a refusal',
      (() => {
        const workflow = widenLane(['src/'], ['.github/workflows/ci.yml']);
        const project = widenLane(['src/'], ['spec/a.md'], ['spec/**']);
        return workflow.ok === true
          && workflow.lane.includes('.github/workflows/ci.yml')
          && JSON.stringify(workflow.authorize) === '[{"file":".github/workflows/ci.yml","glob":".github/workflows/**"}]'
          && project.ok === true
          && project.authorize.length === 1
          && widenLane(['src/'], ['src/b.mjs']).authorize.length === 0;
      })(),
    ],
    [
      'a widening into a secret path is refused WIDEN_SECRET_PATH',
      ['.env.local', 'keys/x.pem', 'config/credentials.json', 'certs/private-key.pem']
        .every((path) => widenLane(['src/'], [path]).code === 'WIDEN_SECRET_PATH')
        && widenLane(['src/'], ['src/ok.mjs', '.env']).code === 'WIDEN_SECRET_PATH',
    ],
    [
      'a widening into a path outside the repository is refused WIDEN_PATH_INVALID',
      ['../x.mjs', '/etc/passwd', 'a/../b', ''].every((path) => widenLane(['src/'], [path]).code === 'WIDEN_PATH_INVALID'),
    ],
    // 0.69.0 review: one secret-path rule for the guard, the merge families
    // and the lane. A segment that is the word, not a word inside a name.
    [
      'isSecretPath is the one secret-path rule: whole segments, key material, env files',
      [
        ['src/tokenizer.ts', false], ['docs/secrets.md', true], ['certs/server.crt', true], ['.ssh/id_rsa', true],
        ['config/credentials.json', true], ['lib/encryption.ts', false], ['auth/token-refresh.ts', false],
        ['secret', true], ['x/secrets/a.json', true], ['secretary.md', false], ['credentialing.md', false],
        ['token.json', true], ['tokens/x', true], ['crypt/a', true], ['crypt.ts', true], ['lib/crypto.ts', false],
        ['keys/deploy', true], ['monkeys/a', false], ['hotkeys.json', false], ['id_ed25519.pub', true],
        ['deploy/private-key.pem', true], ['private_key', true], ['x/keypair.json', true],
        ['.env', true], ['.env.local', true], ['a/.env.production', true], ['environment.ts', false],
        ['server.pem', true], ['x/id.key', true], ['store.p12', true], ['cert.pfx', true], ['app.jks', true],
        ['java.keystore', true], ['a.crt', true],
      ].every(([path, expected]) => isSecretPath(path) === expected),
    ],
    // M1: a prefix widening is matched as a directory, and a prefix that is
    // a guardrail or secret root is refused outright.
    [
      'a prefix widening into a project-protected directory is a human:authorize hit',
      (() => {
        const spec = widenLane(['src/'], ['spec/'], ['spec/**']);
        return spec.ok === true && spec.lane.includes('spec/') && spec.authorize.length === 1
          && spec.authorize[0].glob === 'spec/**';
      })(),
    ],
    [
      'a prefix widening at or under a guardrail root is refused WIDEN_GUARDRAIL_ROOT',
      ['.github/', '.github/workflows/', '.claude/', '.autoloop/', '.githooks/', '.codex/', '.opencode/', '.agents/']
        .every((path) => widenLane(['src/'], [path]).code === 'WIDEN_GUARDRAIL_ROOT')
        && widenLane(['src/'], ['keys/']).code === 'WIDEN_SECRET_PATH'
        && widenLane(['src/'], ['.github/workflows/ci.yml']).ok === true,
    ],
    // M3a: `.github/**` is one protected family.
    [
      'every path under .github is protected',
      ['.github/dependabot.yml', '.github/CODEOWNERS', '.github/actions/setup/action.yml', '.github/workflows/ci.yml']
        .every((path) => matchMergeProtected([path]).length === 1 && matchHumanAuthorization([path]).length === 1)
        && matchMergeProtected(['github/x.md']).length === 0,
    ],
  ];
  for (const fixture of PATH_POLICY_FIXTURES) {
    checks.push([
      `human policy ${fixture.path}`,
      (matchHumanAuthorization([fixture.path]).length > 0) === fixture.humanAuthorization,
    ]);
    checks.push([
      `merge policy ${fixture.path}`,
      (matchMergeProtected([fixture.path]).length > 0) === fixture.mergeProtected,
    ]);
  }
  const failures = checks.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL: ${name}`);
  console.log(failures.length ? `self-test: ${failures.length} FAILED` : `self-test OK (${checks.length} checks)`);
  return failures.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) process.exit(selfTest() ? 0 : 1);
