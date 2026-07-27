#!/usr/bin/env node

// Stable Git checkout and GitHub repository identity.
//
// Every effectful tool needs the same three facts before it acts: which
// checkout it is standing in, which GitHub repository that checkout belongs to,
// and whether the tree is clean. Deriving those facts twice and comparing them
// is the whole contract — a checkout that changes mid-probe is a typed failure,
// not a value to act on.
//
// This module used to live inside the route adapter, which also owned engine
// dispatch, capability probing, and an authority broker. Those are gone; the
// checkout probe is not, because it is what `publish-verdict.mjs` and
// `lifecycle-driver.mjs` bind their mutations to.
//
// Usage:
//   node tools/agentic/checkout-contract.mjs [--json] [<cwd>]
//   node tools/agentic/checkout-contract.mjs --self-test

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_IO_BYTES = 16 * 1024 * 1024;
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
export const CHECKOUT_KEYS = Object.freeze([
  'root',
  'repositoryFingerprint',
  'branch',
  'headOid',
  'clean',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, required, optional = []) {
  return isPlainObject(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function hashValue(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function validCheckout(checkout) {
  return hasExactKeys(checkout, CHECKOUT_KEYS)
    && typeof checkout.root === 'string'
    && checkout.root.length > 1
    && checkout.root.length <= 4096
    && isAbsolute(checkout.root)
    && resolve(checkout.root) === checkout.root
    && !/[\x00-\x1f\x7f]/.test(checkout.root)
    && HEX_64.test(checkout.repositoryFingerprint)
    && typeof checkout.branch === 'string'
    && checkout.branch.length > 0
    && checkout.branch.length <= 255
    && !/[\x00-\x1f\x7f]/.test(checkout.branch)
    && HEX_40.test(checkout.headOid)
    && typeof checkout.clean === 'boolean';
}

export function sameCheckout(left, right) {
  return validCheckout(left)
    && validCheckout(right)
    && hashValue(left) === hashValue(right);
}

function sanitizedGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_EXTERNAL_DIFF: '',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PAGER: 'cat',
  };
}

function gitOutput(cwd, args) {
  const result = spawnSync('git', [
    '--no-replace-objects',
    '--no-optional-locks',
    '-C',
    cwd,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    ...args,
  ], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: MAX_IO_BYTES,
    env: sanitizedGitEnvironment(),
  });
  if (result.status !== 0 || result.error) {
    // Name the likely cause: a live session ran the driver from its scratchpad
    // and spent a diagnosis on this line saying nothing.
    throw new Error(
      `Git checkout probe failed (cwd ${process.cwd()} — run from the repository root)`,
    );
  }
  return String(result.stdout ?? '').trim();
}

export function parseGitHubRemote(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 4096
    || /[\x00-\x20\x7f]/.test(value)
  ) {
    return null;
  }
  let host;
  let path;
  const scp = value.match(/^git@([A-Za-z0-9.-]+):(.+)$/);
  if (scp) {
    [, host, path] = scp;
  } else {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (
      !['https:', 'ssh:'].includes(parsed.protocol)
      || parsed.search !== ''
      || parsed.hash !== ''
      || parsed.port !== ''
      || (
        parsed.protocol === 'ssh:'
        && parsed.username !== ''
        && parsed.username !== 'git'
      )
      || (parsed.protocol === 'https:' && parsed.username !== '')
      || parsed.password !== ''
    ) {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname.replace(/^\/+/, '');
  }
  const canonicalPath = path.endsWith('.git') ? path.slice(0, -4) : path;
  const match = canonicalPath.match(
    /^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,99}))\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,99}))$/,
  );
  if (
    !match
    || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host)
  ) {
    return null;
  }
  return {
    host: host.toLowerCase(),
    owner: match[1].toLowerCase(),
    repo: match[2].toLowerCase(),
  };
}

function probeGitHubRepository(root) {
  const remotes = gitOutput(root, [
    'config',
    '--get-all',
    'remote.origin.url',
  ]).split(/\r?\n/).filter(Boolean);
  if (remotes.length !== 1) {
    throw new Error('checkout requires exactly one canonical origin URL');
  }
  const repository = parseGitHubRemote(remotes[0]);
  if (!repository) {
    throw new Error('origin is not a canonical GitHub repository locator');
  }
  return repository;
}

function probeExecutionRepository(cwd) {
  if (
    typeof cwd !== 'string'
    || cwd.length < 1
    || cwd.length > 4096
  ) {
    throw new Error('checkout root is invalid');
  }
  const requested = realpathSync(resolve(cwd));
  const root = realpathSync(gitOutput(requested, ['rev-parse', '--show-toplevel']));
  // One spawn for the three root-relative reads: rev-parse emits each answer on
  // its own line in argument order, and --abbrev-ref modifies only revisions
  // that FOLLOW it, so the plain HEAD before it stays a full OID.
  // --git-common-dir must be asked from root (its short form is cwd-relative).
  const batched = gitOutput(root, [
    'rev-parse',
    '--git-common-dir',
    'HEAD',
    '--abbrev-ref',
    'HEAD',
  ]).split('\n');
  if (batched.length !== 3) throw new Error('checkout probe is invalid');
  const [commonRaw, headOid, branch] = batched.map((line) => line.trim());
  const common = realpathSync(
    isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw),
  );
  const repository = probeGitHubRepository(root);
  const checkout = {
    root,
    repositoryFingerprint: hashValue({ root, common, repository }),
    branch,
    headOid,
    clean: gitOutput(root, [
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
    ]) === '',
  };
  if (!validCheckout(checkout)) throw new Error('checkout probe is invalid');
  return { checkout, repository };
}

export function snapshotExecutionRepository(cwd) {
  const first = probeExecutionRepository(cwd);
  const second = probeExecutionRepository(first.checkout.root);
  if (hashValue(first) !== hashValue(second)) {
    throw new Error('checkout or GitHub repository changed during snapshot');
  }
  return deepFreeze(second);
}

export function resolveGitHubRepository(cwd) {
  return snapshotExecutionRepository(cwd).repository;
}

export function snapshotExecutionCheckout(cwd) {
  return snapshotExecutionRepository(cwd).checkout;
}

function fixtureGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: sanitizedGitEnvironment(),
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`fixture git ${args.join(' ')} failed`);
  }
  return String(result.stdout ?? '').trim();
}

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };

  check(
    'canonical GitHub remotes parse from SSH, SCP, and HTTPS forms',
    JSON.stringify(parseGitHubRemote('git@github.com:Owner/Repo.git'))
      === JSON.stringify({ host: 'github.com', owner: 'owner', repo: 'repo' })
    && JSON.stringify(parseGitHubRemote('https://github.com/owner/repo'))
      === JSON.stringify({ host: 'github.com', owner: 'owner', repo: 'repo' })
    && JSON.stringify(parseGitHubRemote('ssh://git@github.com/owner/repo.git'))
      === JSON.stringify({ host: 'github.com', owner: 'owner', repo: 'repo' }),
  );
  check(
    'credential-bearing, ported, and non-repository remotes are refused',
    parseGitHubRemote('https://user:token@github.com/owner/repo') === null
    && parseGitHubRemote('https://github.com:8443/owner/repo') === null
    && parseGitHubRemote('https://github.com/owner') === null
    && parseGitHubRemote('https://github.com/owner/repo/extra') === null
    && parseGitHubRemote('file:///tmp/repo') === null
    && parseGitHubRemote(null) === null,
  );

  const checkout = {
    root: '/repo',
    repositoryFingerprint: 'a'.repeat(64),
    branch: 'main',
    headOid: 'b'.repeat(40),
    clean: true,
  };
  check('a well-formed checkout validates', validCheckout(checkout));
  check(
    'malformed checkouts are refused',
    !validCheckout({ ...checkout, root: 'relative' })
    && !validCheckout({ ...checkout, headOid: 'short' })
    && !validCheckout({ ...checkout, clean: 'yes' })
    && !validCheckout({ ...checkout, extra: 1 })
    && !validCheckout(null),
  );
  check(
    'checkout identity compares by exact value',
    sameCheckout(checkout, { ...checkout })
    && !sameCheckout(checkout, { ...checkout, clean: false })
    && !sameCheckout(checkout, null),
  );

  const scratch = mkdtempSync(join(tmpdir(), 'autoloop-checkout-'));
  try {
    const root = join(scratch, 'repo');
    fixtureGit(scratch, ['init', '--quiet', root]);
    fixtureGit(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    fixtureGit(root, [
      'remote',
      'add',
      'origin',
      'https://github.com/autoloop-fixtures/checkout.git',
    ]);
    writeFileSync(join(root, 'tracked.txt'), 'base\n');
    fixtureGit(root, ['add', '--all']);
    fixtureGit(root, [
      '-c', 'user.name=autoloop',
      '-c', 'user.email=autoloop@localhost',
      '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'test: checkout fixture',
    ]);
    const snapshot = snapshotExecutionRepository(root);
    check(
      'a real checkout snapshots its identity, branch, head, and cleanliness',
      validCheckout(snapshot.checkout)
      && snapshot.checkout.branch === 'main'
      && snapshot.checkout.clean === true
      && snapshot.repository.owner === 'autoloop-fixtures'
      && snapshot.repository.repo === 'checkout'
      && Object.isFrozen(snapshot),
    );
    check(
      'a nested working directory resolves to the same checkout root',
      sameCheckout(snapshotExecutionCheckout(root), snapshot.checkout),
    );
    writeFileSync(join(root, 'untracked.txt'), 'dirty\n');
    check(
      'an untracked file makes the checkout dirty without changing its identity',
      snapshotExecutionCheckout(root).clean === false
      && snapshotExecutionCheckout(root).repositoryFingerprint
        === snapshot.checkout.repositoryFingerprint,
    );
    fixtureGit(root, ['remote', 'set-url', 'origin', '/local/path']);
    let refusedNonGitHub = false;
    try {
      snapshotExecutionRepository(root);
    } catch {
      refusedNonGitHub = true;
    }
    check('a non-GitHub origin is a hard failure', refusedNonGitHub);
    let refusedNonRepository = false;
    try {
      snapshotExecutionRepository(scratch);
    } catch {
      refusedNonRepository = true;
    }
    check('a directory outside any checkout is a hard failure', refusedNonRepository);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(
    failures.length === 0
      ? `self-test OK (${cases.length} cases)`
      : `self-test FAILED (${failures.length}/${cases.length})`,
  );
  return failures.length === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const json = args.includes('--json');
  const cwd = args.find((argument) => !argument.startsWith('--')) ?? process.cwd();
  let snapshot;
  try {
    snapshot = snapshotExecutionRepository(cwd);
  } catch (error) {
    console.error(`checkout-contract: ${error.message}`);
    process.exit(1);
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 1)}\n`);
    return;
  }
  const { checkout, repository } = snapshot;
  console.log(`repository  ${repository.host}/${repository.owner}/${repository.repo}`);
  console.log(`root        ${checkout.root}`);
  console.log(`branch      ${checkout.branch}`);
  console.log(`head        ${checkout.headOid}`);
  console.log(`tree        ${checkout.clean ? 'clean' : 'dirty'}`);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url))
      === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
