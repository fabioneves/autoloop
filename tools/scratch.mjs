#!/usr/bin/env node
// autoloop — scratch.mjs
//
// The checkouts a run needs beside its own: a base worktree a read-only role
// reads as files, or any other ref the orchestrator must see whole. They live
// on disk under <git-common-dir>/autoloop/scratch/, never on the /tmp tmpfs:
// LFE, 2026-10-15, invented /tmp checkouts filled the tmpfs inodes and the
// run stopped. This tool makes them, so no Write or Bash redirect of the
// session targets the protected .git directory.
//
// A scratch worktree is recreated on demand, so prune removes every one that
// no live process uses and that is older than the grace time. Prime prunes at
// run open and `--base` after each handout; `--prune` does the same by hand.
//
// Usage:
//   node scratch.mjs --base <ref>    a detached worktree of <ref>; prints {path, oid}
//   node scratch.mjs --prune         remove the scratch worktrees nothing uses; prints {removed}
//   node scratch.mjs --self-test

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDispatchCmdline } from './inherited-dispatch.mjs';

// A worktree younger than this stays: the orchestrator makes it, then writes
// the prompt that names it, then dispatches. Each handout restarts it.
export const SCRATCH_GRACE_MS = 2 * 60 * 60 * 1000;
// A checkout of a large repository takes minutes; a waiter waits as long.
const CHECKOUT_MS = 10 * 60 * 1000;
const OID_RE = /^[0-9a-f]{40}$/u;
const NAP = new Int32Array(new SharedArrayBuffer(4));

function git(cwd, args, timeout = 120_000) {
  // No hook and no fsmonitor: a project's program must not run in a scratch copy.
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', timeout,
  });
  return { ok: result.status === 0, stdout: String(result.stdout ?? '').trim(), stderr: String(result.stderr ?? '').trim() };
}

export function scratchRoot(cwd) {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok || common.stdout === '') throw new Error(`not inside a git repository: ${common.stderr}`);
  return join(common.stdout, 'autoloop', 'scratch');
}

function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function linkAt(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function presentAt(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// The scratch root, resolved, or null when it is absent or a link moves it
// out of the common dir: nothing is made or removed there.
function resolvedRoot(cwd) {
  const root = scratchRoot(cwd);
  const common = realOrNull(dirname(dirname(root)));
  const real = realOrNull(root);
  return common !== null && real === join(common, 'autoloop', 'scratch') ? real : null;
}

function registeredWorktrees(cwd) {
  const listed = git(cwd, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) throw new Error(`git worktree list failed: ${listed.stderr}`);
  return listed.stdout.split(/\n{2,}/u).map((block) => {
    const lines = block.split('\n');
    const field = (name) => lines.find((line) => line === name || line.startsWith(`${name} `));
    return {
      path: field('worktree')?.slice('worktree '.length),
      head: field('HEAD')?.slice('HEAD '.length) ?? null,
      locked: field('locked') !== undefined,
    };
  }).filter(({ path }) => path);
}

function registeredAt(cwd, path) {
  return registeredWorktrees(cwd).find((worktree) => worktree.path === path) ?? null;
}

// A lock file beside an entry names the pid of the one process that makes,
// replaces or removes it. A dead holder's lock is taken over; two takers of
// the same dead lock in the same instant is the one race left.
function lockHeld(lock) {
  let text;
  try {
    text = readFileSync(lock, 'utf8');
  } catch {
    return false;
  }
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    // Made and not yet written: held for a moment.
    try {
      return Date.now() - lstatSync(lock).mtimeMs < 10_000;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function tryLock(lock) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST' || lockHeld(lock)) return false;
      rmSync(lock, { force: true });
    }
  }
  return false;
}

function lockedRun(lock, work) {
  const deadline = Date.now() + CHECKOUT_MS;
  while (!tryLock(lock)) {
    if (Date.now() > deadline) throw new Error(`another process still holds ${lock}`);
    Atomics.wait(NAP, 0, 0, 100);
  }
  try {
    return work();
  } finally {
    rmSync(lock, { force: true });
  }
}

// Registered at the commit, not locked by a killed add, and unchanged.
function ready(cwd, path, oid) {
  const entry = registeredAt(cwd, path);
  if (entry === null || entry.locked || entry.head !== oid) return false;
  const status = git(path, ['status', '--porcelain', '--untracked-files=no']);
  return status.ok && status.stdout === '';
}

// A worktree goes through git, locked or not; a link goes as a link. True
// when nothing is left at the path and git no longer lists it.
function discard(cwd, path) {
  if (linkAt(path)) rmSync(path);
  if (registeredAt(cwd, path) !== null) git(cwd, ['worktree', 'remove', '--force', '--force', path]);
  rmSync(path, { recursive: true, force: true });
  return !presentAt(path) && registeredAt(cwd, path) === null;
}

export function baseWorktree(cwd, ref) {
  const resolved = git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!resolved.ok || !OID_RE.test(resolved.stdout)) throw new Error(`${ref} names no commit`);
  const oid = resolved.stdout;
  mkdirSync(scratchRoot(cwd), { recursive: true });
  const root = resolvedRoot(cwd);
  if (root === null) throw new Error('the scratch root is a link out of the git common dir');
  const path = join(root, `base-${oid.slice(0, 12)}`);
  return lockedRun(`${path}.lock`, () => {
    if (ready(cwd, path, oid)) {
      const now = new Date();
      utimesSync(join(path, '.git'), now, now);
      return { path, oid, reused: true };
    }
    // Anything else at the path is a leftover of a killed or changed checkout.
    discard(cwd, path);
    const added = git(cwd, ['worktree', 'add', '--detach', path, oid], CHECKOUT_MS);
    if (!added.ok) {
      discard(cwd, path);
      throw new Error(`git worktree add failed: ${added.stderr}`);
    }
    return { path, oid, reused: false };
  });
}

// Linux: the paths live processes use — their working directories, their
// command-line arguments, and the prompt text of each running dispatch (a
// reviewer reads the base worktree its prompt names). Null where /proc cannot
// be read, or shows a nested PID namespace (only part of the processes): then
// nothing is pruned.
export function liveUses(procRoot = '/proc') {
  let pids;
  try {
    const nspid = /^NSpid:\s*(.*)$/mu.exec(readFileSync(join(procRoot, 'self', 'status'), 'utf8'))?.[1];
    if (nspid === undefined || nspid.trim().split(/\s+/u).length !== 1) return null;
    pids = readdirSync(procRoot).filter((name) => /^\d+$/u.test(name));
  } catch {
    return null;
  }
  const uses = [];
  for (const pid of pids) {
    let cwd = null;
    try {
      cwd = readlinkSync(join(procRoot, pid, 'cwd'));
      uses.push(cwd);
    } catch {
      // Gone, or another user's process.
    }
    let cmdline = '';
    try {
      cmdline = readFileSync(join(procRoot, pid, 'cmdline'), 'utf8');
    } catch {
      continue;
    }
    uses.push(...cmdline.split('\0').filter((arg) => arg.startsWith('/')));
    const promptFile = parseDispatchCmdline(cmdline)?.promptFile;
    if (promptFile && (cwd !== null || isAbsolute(promptFile))) {
      try {
        uses.push(readFileSync(resolve(cwd ?? '/', promptFile), 'utf8'));
      } catch {
        // An unreadable prompt names nothing.
      }
    }
  }
  return uses;
}

// A working directory or an argument inside the path, or prompt text naming it.
function usedBy(path, uses) {
  return uses.some((use) => use.includes(path));
}

// Each entry of the scratch root that no live process uses and that is older
// than the grace time is removed under its lock: a worktree through git, any
// other entry as it is. Nothing outside the root is touched, and no other
// worktree's registration.
export function pruneScratch(cwd, { uses = liveUses(), nowMs = Date.now(), graceMs = SCRATCH_GRACE_MS } = {}) {
  const root = resolvedRoot(cwd);
  if (root === null || uses === null) return { removed: [] };
  const old = (path) => {
    try {
      return nowMs - lstatSync(path).mtimeMs >= graceMs;
    } catch {
      return true;
    }
  };
  const removed = [];
  const remove = (path, stillOld) => {
    const lock = `${path}.lock`;
    if (!tryLock(lock)) return;
    try {
      if (stillOld() && discard(cwd, path)) removed.push(path);
    } finally {
      rmSync(lock, { force: true });
    }
  };
  for (const { path } of registeredWorktrees(cwd)) {
    if (realOrNull(dirname(path)) !== root || usedBy(path, uses)) continue;
    remove(path, () => old(join(path, '.git')));
  }
  const registered = new Set(registeredWorktrees(cwd).map(({ path }) => path));
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (registered.has(path) || usedBy(path, uses) || !old(path)) continue;
    if (name.endsWith('.lock')) {
      if (!lockHeld(path)) {
        rmSync(path, { force: true });
        removed.push(path);
      }
      continue;
    }
    remove(path, () => true);
  }
  return { removed };
}

// A repository of one commit under base, and git run in it.
function testRepo(base, name) {
  const repo = join(base, name);
  const run = (args, cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  mkdirSync(repo);
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@example.test']);
  run(['config', 'user.name', 't']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  run(['add', 'a.txt']);
  run(['commit', '-q', '-m', 'one']);
  return { repo, run };
}

// The first use of path that /proc shows, or null after a short wait.
function settledUses(path) {
  for (let tries = 0; tries < 50; tries += 1) {
    const uses = liveUses();
    if (uses?.some((use) => use.includes(path))) return uses;
    spawnSync('sleep', ['0.05']);
  }
  return null;
}

// What a crash, a concurrent caller or the operator's own worktrees leave.
function hardeningChecks(base, results, holders) {
  const { repo, run } = testRepo(base, 'hardening');
  const root = join(repo, '.git', 'autoloop', 'scratch');
  const longAgo = new Date(Date.now() - 3 * SCRATCH_GRACE_MS);
  const age = (path) => utimesSync(path, longAgo, longAgo);
  const later = Date.now() + 60_000;
  const listed = () => run(['worktree', 'list', '--porcelain']);

  // The operator's own worktrees: one old and unused, one moved away for now.
  const own = join(base, 'own-worktree');
  run(['worktree', 'add', '-q', '--detach', own]);
  age(join(own, '.git'));
  const away = join(base, 'away-worktree');
  run(['worktree', 'add', '-q', '--detach', away]);
  renameSync(away, `${away}.moved`);
  const made = baseWorktree(repo, 'HEAD');
  age(join(made.path, '.git'));
  const reused = baseWorktree(repo, 'HEAD');
  const afterReuse = pruneScratch(repo, { uses: [], nowMs: later });
  renameSync(`${away}.moved`, away);
  results.push(['prune touches no worktree outside the root, not one moved away for now, and a handout restarts the grace time',
    reused.reused === true && afterReuse.removed.length === 0 && existsSync(made.path)
      && existsSync(own) && listed().includes(own)
      && spawnSync('git', ['status', '--porcelain'], { cwd: away }).status === 0]);

  // A killed `git worktree add` leaves its worktree locked; a process can change one.
  run(['worktree', 'lock', '--reason', 'initializing', made.path]);
  const unlocked = baseWorktree(repo, 'HEAD');
  writeFileSync(join(made.path, 'a.txt'), 'changed\n');
  const cleaned = baseWorktree(repo, 'HEAD');
  results.push(['a locked or changed worktree is never reused: it is made again',
    unlocked.reused === false && cleaned.reused === false
      && readFileSync(join(made.path, 'a.txt'), 'utf8') === 'one\n' && !listed().includes('locked')]);
  run(['worktree', 'lock', '--reason', 'initializing', made.path]);
  age(join(made.path, '.git'));
  const lockedGone = pruneScratch(repo, { uses: [], nowMs: later });
  results.push(['prune removes an old worktree a killed add left locked',
    JSON.stringify(lockedGone.removed) === JSON.stringify([made.path]) && !listed().includes(made.path)]);

  // The maker of a worktree holds its lock: prune leaves it; a dead maker's lock is taken over.
  const named = baseWorktree(repo, 'HEAD');
  age(join(named.path, '.git'));
  writeFileSync(`${named.path}.lock`, String(process.pid));
  const whileHeld = pruneScratch(repo, { uses: [], nowMs: later });
  writeFileSync(`${named.path}.lock`, spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const takenOver = baseWorktree(repo, 'HEAD');
  results.push(['prune leaves a worktree whose maker holds its lock; a dead maker\'s lock is taken over',
    whileHeld.removed.length === 0 && existsSync(named.path) && takenOver.reused === true && !existsSync(`${named.path}.lock`)]);

  if (process.platform === 'linux') {
    // A dispatch whose relative prompt file names the worktree, then a process whose argument does.
    age(join(named.path, '.git'));
    mkdirSync(join(base, 'fake-tools'));
    writeFileSync(join(base, 'fake-tools', 'dispatch.mjs'), 'setTimeout(() => {}, 30000);\n');
    writeFileSync(join(base, 'brief.md'), `Read the base at ${named.path}.\n`);
    const dispatch = spawn(process.execPath, [join(base, 'fake-tools', 'dispatch.mjs'), '--role', 'code-review', '--prompt-file', 'brief.md'],
      { cwd: base, stdio: 'ignore' });
    holders.push(dispatch);
    const byPrompt = settledUses(named.path);
    const promptKept = byPrompt !== null && pruneScratch(repo, { uses: byPrompt, nowMs: later }).removed.length === 0;
    dispatch.kill('SIGKILL');
    const argument = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', named.path], { cwd: base, stdio: 'ignore' });
    holders.push(argument);
    const byArgument = settledUses(named.path);
    const argumentKept = byArgument !== null && pruneScratch(repo, { uses: byArgument, nowMs: later }).removed.length === 0;
    results.push(['a dispatch whose relative prompt names a worktree keeps it, and so does a process whose argument names it',
      promptKept && argumentKept && existsSync(named.path)]);
    argument.kill('SIGKILL');
  }

  // A scratch root linked out of the common dir is never used.
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(join(elsewhere, 'leftover'), { recursive: true });
  age(join(elsewhere, 'leftover'));
  renameSync(root, `${root}.real`);
  symlinkSync(elsewhere, root);
  let refused = false;
  try {
    baseWorktree(repo, 'HEAD');
  } catch {
    refused = true;
  }
  const linked = pruneScratch(repo, { uses: [], nowMs: later });
  rmSync(root);
  renameSync(`${root}.real`, root);
  results.push(['a scratch root linked out of the common dir is refused and pruned of nothing',
    refused && linked.removed.length === 0 && existsSync(join(elsewhere, 'leftover'))]);

  // A worktree a link replaced: the link goes, never what it points at.
  const swapped = baseWorktree(repo, 'HEAD');
  const moved = join(base, 'moved-worktree');
  renameSync(swapped.path, moved);
  symlinkSync(moved, swapped.path);
  age(join(moved, '.git'));
  const unlinked = pruneScratch(repo, { uses: [], nowMs: later });
  results.push(['a worktree replaced by a link out of the root loses the link, never the target',
    unlinked.removed.includes(swapped.path) && !presentAt(swapped.path) && readFileSync(join(moved, 'a.txt'), 'utf8') === 'one\n']);

  // A nested PID namespace shows only part of the processes.
  const proc = join(base, 'proc');
  mkdirSync(join(proc, 'self'), { recursive: true });
  mkdirSync(join(proc, '7'));
  writeFileSync(join(proc, 'self', 'status'), 'Name:\tnode\nNSpid:\t7\t1\n');
  const nested = liveUses(proc);
  writeFileSync(join(proc, 'self', 'status'), 'Name:\tnode\nNSpid:\t7\n');
  results.push(['a nested PID namespace reads as no process table', nested === null && Array.isArray(liveUses(proc))]);

  // A handout prunes what a moved base left behind.
  mkdirSync(join(root, 'displaced'));
  age(join(root, 'displaced'));
  const cli = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--base', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  results.push(['--base prints the worktree and prunes an old entry nothing uses',
    cli.status === 0 && JSON.parse(cli.stdout).path === named.path && !existsSync(join(root, 'displaced'))]);
}

function selfTest() {
  const results = [];
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'scratch-test-')));
  const repo = join(base, 'repo');
  const run = (args, cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  let holder = null;
  const holders = [];
  try {
    mkdirSync(repo);
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 't@example.test']);
    run(['config', 'user.name', 't']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    run(['add', 'a.txt']);
    run(['commit', '-q', '-m', 'one']);
    const first = run(['rev-parse', 'HEAD']);
    // A project hook that would run on checkout.
    const hookMark = join(base, 'hook-ran');
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${hookMark}\n`, { mode: 0o755 });
    const root = join(repo, '.git', 'autoloop', 'scratch');
    const made = baseWorktree(repo, 'main');
    results.push(['a base worktree is a detached checkout of the ref on disk under the common dir, and runs no hook',
      made.path === join(root, `base-${first.slice(0, 12)}`) && made.oid === first && made.reused === false
        && readFileSync(join(made.path, 'a.txt'), 'utf8') === 'one\n'
        && run(['rev-parse', 'HEAD'], made.path) === first && !existsSync(hookMark)]);
    results.push(['the same commit reuses its worktree', JSON.stringify(baseWorktree(repo, first)) === JSON.stringify({ ...made, reused: true })]);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    run(['commit', '-q', '-am', 'two']);
    const second = baseWorktree(repo, 'HEAD');
    run(['checkout', '-q', '--detach', first], second.path);
    const repaired = baseWorktree(repo, 'HEAD');
    results.push(['a worktree moved off its commit is made again at the commit',
      repaired.path === second.path && repaired.reused === false
        && readFileSync(join(repaired.path, 'a.txt'), 'utf8') === 'two\n']);
    let refused = null;
    try {
      baseWorktree(repo, 'no-such-ref');
    } catch (error) {
      refused = error.message;
    }
    results.push(['a ref that names no commit is refused', refused === 'no-such-ref names no commit']);

    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep\n');
    symlinkSync(outside, join(root, 'link-out'));
    mkdirSync(join(root, 'leftover'));
    const nowMs = Date.now() + 10 * SCRATCH_GRACE_MS;
    const young = pruneScratch(repo, { uses: [], nowMs: Date.now() });
    const kept = pruneScratch(repo, { uses: [`prompt text naming ${made.path} as the base`], nowMs });
    results.push(['prune keeps a worktree younger than the grace time and one a live prompt names',
      young.removed.length === 0 && JSON.stringify(kept.removed.sort())
        === JSON.stringify([join(root, 'leftover'), join(root, 'link-out'), second.path].sort())
        && existsSync(made.path) && !existsSync(second.path)
        && readFileSync(join(outside, 'keep.txt'), 'utf8') === 'keep\n'
        && !run(['worktree', 'list', '--porcelain']).includes(second.path)]);

    results.push(['without a process table nothing is pruned',
      JSON.stringify(pruneScratch(repo, { uses: liveUses(join(base, 'no-proc')), nowMs })) === '{"removed":[]}'
        && existsSync(made.path)]);
    // A live process working inside a worktree keeps it, read from /proc.
    holder = spawn('sleep', ['30'], { cwd: made.path, stdio: 'ignore' });
    let held = null;
    for (let tries = 0; tries < 50 && held === null; tries += 1) {
      const uses = liveUses();
      if (uses?.includes(made.path)) held = pruneScratch(repo, { uses, nowMs });
      else spawnSync('sleep', ['0.05']);
    }
    holder.kill('SIGKILL');
    spawnSync('sleep', ['0.2']);
    const released = pruneScratch(repo, { nowMs });
    results.push(['a live process working in a worktree keeps it; once it ends the worktree is pruned',
      process.platform !== 'linux'
        || (held !== null && held.removed.length === 0 && JSON.stringify(released.removed) === JSON.stringify([made.path])
          && !existsSync(made.path) && run(['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).length === 1)]);
    hardeningChecks(base, results, holders);
  } catch (error) {
    results.push([`the scratch checks ran: ${error.stack}`, false]);
  } finally {
    holder?.kill('SIGKILL');
    for (const child of holders) child.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
  const failures = results.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${results.length} cases)`
    : `self-test FAILED (${failures.length}/${results.length})`);
  return failures.length === 0;
}

function main(args) {
  if (args.length === 1 && args[0] === '--self-test') return selfTest() ? 0 : 1;
  try {
    if (args.length === 2 && args[0] === '--base') {
      const { path, oid } = baseWorktree(process.cwd(), args[1]);
      // The checkouts a moved base left behind go now, not at the next run open.
      try {
        pruneScratch(process.cwd());
      } catch {
        // Prime prunes at the next run open.
      }
      process.stdout.write(`${JSON.stringify({ path, oid })}\n`);
      return 0;
    }
    if (args.length === 1 && args[0] === '--prune') {
      process.stdout.write(`${JSON.stringify(pruneScratch(process.cwd()))}\n`);
      return 0;
    }
  } catch (error) {
    process.stderr.write(`scratch: ${error.message}\n`);
    return 1;
  }
  process.stderr.write('usage: scratch.mjs --base <ref> | --prune | --self-test\n');
  return 2;
}

const isMain = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
