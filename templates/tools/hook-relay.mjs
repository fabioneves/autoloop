#!/usr/bin/env node
// autoloop — hook-relay.mjs
//
// Hooks are branch-local: the host executes `$CLAUDE_PROJECT_DIR/tools/agentic/
// <tool>.mjs`, which is whatever the CHECKOUT carries. A unit branch forked
// before a scaffold reconcile therefore runs fossil guards for the life of the
// unit — a live run went dark mid-unit under a Stop hook two releases too old
// to refuse it, while the repo's base branch had carried the current hook for
// hours. The wiring cannot fix this (the hook command has to name a stable
// path), so the TOOL does: at startup it compares itself against the base
// branch's copy and, when the branch is behind, re-executes the base copy.
//
// The trust rule the hook templates state — vendored, never the plugin, "so
// guard behavior stays under the repo's own review" — is preserved: the base
// branch's copy landed through the repo's own reviewed reconcile PRs. It is
// exactly the branch-local fossil that escapes that review by standing still.
//
// Fail-open everywhere: no base ref, no tools/agentic on base, any git error,
// a base copy too old to be relay-aware — the local copy runs, which is the
// behavior every installed repo has today. Delegation happens only when the
// base provably carries a DIFFERENT, relay-aware copy of the same tool.
//
// Usage (inside a vendored hook tool, first thing on its execution path):
//   import { relayHookToBase } from './hook-relay.mjs';
//   relayHookToBase(import.meta.url);
//
// The relayed child runs with AUTOLOOP_HOOK_RELAY=1 (so it never relays again)
// and AUTOLOOP_HOOK_ROOT=<repo root> (so a tool that derives the repository
// root from its own file location — which now sits in a cache directory under
// the git common dir — still resolves the real repository).
//
//   node tools/agentic/hook-relay.mjs --self-test

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RELAY_ENV = 'AUTOLOOP_HOOK_RELAY';
export const ROOT_ENV = 'AUTOLOOP_HOOK_ROOT';

// The base ref is resolved from the remote's default branch first, so a repo
// whose base is `develop` relays exactly like one on `main`; the bare `main`
// fallback serves fixtures and fresh clones with no origin/HEAD recorded.
const BASE_REFS = Object.freeze(['origin/HEAD', 'origin/main', 'main']);

// Proof that the base copy understands the relay contract (honors ROOT_ENV and
// never re-relays). A base copy from before this mechanism must not be handed
// the process: it would derive its repository root from the cache directory.
const RELAY_MARKER = 'hook-relay.mjs';

const VENDOR_DIR = 'tools/agentic';
const GIT_TIMEOUT_MS = 10_000;

function git(root, args, binary = false) {
  const result = spawnSync('git', ['-C', root, ...args], {
    ...(binary ? {} : { encoding: 'utf8' }),
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) return null;
  return result.stdout;
}

// Pure given a resolver: the first ref whose `<ref>:tools/agentic` names a
// tree. Returns { ref, tree } or null.
export function resolveBaseVendorTree(revParse) {
  for (const ref of BASE_REFS) {
    const tree = revParse(`${ref}:${VENDOR_DIR}`);
    if (typeof tree === 'string' && /^[0-9a-f]{40}$/u.test(tree.trim())) {
      return { ref, tree: tree.trim() };
    }
  }
  return null;
}

// Pure: should this invocation even consider relaying? Self-tests and corpus
// replays exercise THIS file, never the base's; a relayed child never relays.
export function relayApplies(argv, env) {
  if (env[RELAY_ENV] === '1') return false;
  if (argv.includes('--self-test') || argv.includes('--corpus')) return false;
  return true;
}

function materializeBaseTree(root, tree) {
  const commonRaw = git(root, ['rev-parse', '--git-common-dir']);
  if (commonRaw === null) return null;
  const common = commonRaw.trim();
  const commonDir = isAbsolute(common) ? common : resolve(root, common);
  const cacheParent = join(commonDir, 'autoloop', 'hook-base');
  const cacheDir = join(cacheParent, tree);
  if (existsSync(cacheDir)) return cacheDir;
  const listing = git(root, ['ls-tree', '-r', '-z', tree]);
  if (listing === null) return null;
  const staging = `${cacheDir}.tmp-${process.pid}`;
  try {
    mkdirSync(staging, { recursive: true });
    for (const entry of listing.split('\0')) {
      if (!entry) continue;
      const match = entry.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/u);
      if (!match) continue;
      const [, oid, path] = match;
      if (path.split('/').some((part) => part === '..' || part === '')) continue;
      const body = git(root, ['cat-file', 'blob', oid], true);
      if (body === null) throw new Error(`unreadable blob ${oid}`);
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    renameSync(staging, cacheDir);
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return existsSync(cacheDir) ? cacheDir : null;
  }
  // One tree per reconcile accumulates forever otherwise. Best-effort, and
  // never the tree that was just materialized.
  try {
    for (const sibling of readdirSync(cacheParent)) {
      if (sibling === tree) continue;
      rmSync(join(cacheParent, sibling), { recursive: true, force: true });
    }
  } catch { /* pruning is best-effort */ }
  return cacheDir;
}

export function relayHookToBase(importMetaUrl, argv = process.argv) {
  try {
    if (!relayApplies(argv, process.env)) return;
    const ownPath = fileURLToPath(importMetaUrl);
    const name = basename(ownPath);
    const root = resolve(dirname(ownPath), '..', '..');
    const base = resolveBaseVendorTree(
      (spec) => git(root, ['rev-parse', spec]),
    );
    if (base === null) return;
    const baseBlob = git(root, ['rev-parse', `${base.ref}:${VENDOR_DIR}/${name}`]);
    if (baseBlob === null) return;
    const ownBlob = git(root, ['hash-object', '--', ownPath]);
    if (ownBlob === null || ownBlob.trim() === baseBlob.trim()) return;
    const baseBody = git(root, ['cat-file', 'blob', baseBlob.trim()]);
    if (baseBody === null || !baseBody.includes(RELAY_MARKER)) return;
    const cacheDir = materializeBaseTree(root, base.tree);
    if (cacheDir === null) return;
    const delegate = join(cacheDir, name);
    if (!existsSync(delegate)) return;
    const child = spawnSync(process.execPath, [delegate, ...argv.slice(2)], {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, [RELAY_ENV]: '1', [ROOT_ENV]: root },
    });
    if (child.error || typeof child.status !== 'number') return;
    process.exit(child.status);
  } catch { /* fail-open: the local copy runs, as it always has */ }
}

function run(cwd, command, args, env = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };

  check(
    'relay applicability is decided from argv and environment alone',
    relayApplies(['node', 'x.mjs'], {}) === true
    && relayApplies(['node', 'x.mjs'], { [RELAY_ENV]: '1' }) === false
    && relayApplies(['node', 'x.mjs', '--self-test'], {}) === false
    && relayApplies(['node', 'x.mjs', '--corpus'], {}) === false,
  );
  check(
    'base tree resolution takes the first ref that answers',
    resolveBaseVendorTree(() => null) === null
    && resolveBaseVendorTree((spec) =>
      (spec === `main:${VENDOR_DIR}` ? 'a'.repeat(40) : null)).ref === 'main'
    && resolveBaseVendorTree(() => 'not-an-oid') === null,
  );

  // realpath'd because node canonicalizes the entry module's path: on macOS
  // /var/folders is a symlink into /private/var, so a probe launched from the
  // raw mkdtemp path reports its repository root in the canonical spelling.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'autoloop-hook-relay-')));
  try {
    const repo = join(scratch, 'repo');
    const tools = join(repo, VENDOR_DIR);
    mkdirSync(tools, { recursive: true });
    const gitc = (...args) => run(repo, 'git', args);
    gitc('init', '-q', '-b', 'main');
    gitc('config', 'user.name', 'Fixture');
    gitc('config', 'user.email', 'fixture@example.invalid');
    const relaySource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    writeFileSync(join(tools, 'hook-relay.mjs'), relaySource);
    const probe = (tag) =>
      "import { relayHookToBase } from './hook-relay.mjs';\n"
      + 'relayHookToBase(import.meta.url);\n'
      + `console.log('probe:${tag} relayed=' + (process.env.AUTOLOOP_HOOK_RELAY ?? '0')\n`
      + "  + ' root=' + (process.env.AUTOLOOP_HOOK_ROOT ?? 'none'));\n";
    writeFileSync(join(tools, 'probe.mjs'), probe('BASE'));
    writeFileSync(join(tools, 'equal.mjs'), probe('EQUAL'));
    // A pre-relay base copy: same tool name, no relay marker anywhere.
    writeFileSync(join(tools, 'fossil.mjs'), "console.log('fossil:BASE');\n");
    gitc('add', '.');
    gitc('commit', '-q', '-m', 'base');
    gitc('checkout', '-q', '-b', 'unit');
    writeFileSync(join(tools, 'probe.mjs'), probe('BRANCH'));
    writeFileSync(
      join(tools, 'fossil.mjs'),
      "import { relayHookToBase } from './hook-relay.mjs';\n"
      + 'relayHookToBase(import.meta.url);\n'
      + "console.log('fossil:BRANCH');\n",
    );
    gitc('add', '.');
    gitc('commit', '-q', '-m', 'unit drift');

    const drifted = run(repo, process.execPath, [join(tools, 'probe.mjs')]);
    check(
      'a drifted branch copy delegates to the base copy with the repo root on the wire',
      drifted.status === 0
      && drifted.stdout.includes('probe:BASE relayed=1')
      && drifted.stdout.includes(`root=${repo}`),
    );
    check(
      'the base tree is materialized once under the git common dir',
      existsSync(join(repo, '.git', 'autoloop', 'hook-base')),
    );
    const again = run(repo, process.execPath, [join(tools, 'probe.mjs')]);
    check(
      'the cached materialization serves the second invocation',
      again.status === 0 && again.stdout.includes('probe:BASE relayed=1'),
    );
    const marked = run(repo, process.execPath, [join(tools, 'probe.mjs')], {
      [RELAY_ENV]: '1',
    });
    check(
      'a relayed child never relays again',
      marked.status === 0 && marked.stdout.includes('probe:BRANCH'),
    );
    const testing = run(
      repo,
      process.execPath,
      [join(tools, 'probe.mjs'), '--self-test'],
    );
    check(
      'a self-test invocation exercises the local copy, never the base',
      testing.status === 0 && testing.stdout.includes('probe:BRANCH'),
    );
    const equal = run(repo, process.execPath, [join(tools, 'equal.mjs')]);
    check(
      'an identical copy runs locally without delegation',
      equal.status === 0 && equal.stdout.includes('probe:EQUAL relayed=0'),
    );
    const fossil = run(repo, process.execPath, [join(tools, 'fossil.mjs')]);
    check(
      'a base copy that predates the relay contract is never handed the process',
      fossil.status === 0 && fossil.stdout.includes('fossil:BRANCH'),
    );

    const bare = join(scratch, 'bare');
    mkdirSync(join(bare, VENDOR_DIR), { recursive: true });
    run(bare, 'git', ['init', '-q', '-b', 'main']);
    writeFileSync(join(bare, VENDOR_DIR, 'hook-relay.mjs'), relaySource);
    writeFileSync(join(bare, VENDOR_DIR, 'lone.mjs'), probe('LONE'));
    const lone = run(bare, process.execPath, [join(bare, VENDOR_DIR, 'lone.mjs')]);
    check(
      'a repo with no committed base vendor tree fails open to the local copy',
      lone.status === 0 && lone.stdout.includes('probe:LONE relayed=0'),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED: ${failures.join(', ')}`);
  return failures.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('hook-relay: a library for vendored hook tools; run with --self-test');
}
