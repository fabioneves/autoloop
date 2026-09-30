#!/usr/bin/env node
// autoloop — run-markers.mjs
//
// The run's durable evidence: markers prime writes under the common git dir,
// bound to the session's process ancestry. The command guard, the other hooks,
// prime, step and the reports all read runs through here; the guard's own
// self-test exercises it.

import { spawnSync } from 'node:child_process';
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedGit } from './git-budget.mjs';

// The guard is defense-in-depth for commands a run issues; repository rules are
// the enforcement boundary. Applying it to every Bash call in the project turns
// ordinary development into a fight with a policy that was never aimed at it, so
// it enforces only while a run is actually open.
//
// An open run is evidenced by a durable run marker that `prime.mjs` writes and
// binds to the ancestry it observed. The marker names live PIDs; a run whose
// orchestrator has exited leaves nothing alive to match, so the evidence
// disappears with the run without needing a daemon to revoke it. An unreadable
// marker means "no run": a guard that cannot establish an open run must not
// block a human. The session latch below is the exception — it exists only
// because this session already had a run, so an unreadable one refuses.
// The common git dir, not `--git-path` (which is per-worktree for this path):
// a command issued from a linked worktree must see the repository's run.
// Resolved once per directory per process: a hook asks for the same one
// several times, and each ask is a git spawn under the hook's budget.
const markerDirectories = new Map();

export function runMarkerDirectory(cwd = process.cwd()) {
  if (markerDirectories.has(cwd)) return markerDirectories.get(cwd);
  const result = boundedGit(['-C', cwd, 'rev-parse', '--git-common-dir']);
  if (result.status !== 0 || result.error) return null;
  const common = String(result.stdout ?? '').trim();
  if (!common) return null;
  const directory = join(isAbsolute(common) ? common : resolve(cwd, common), 'autoloop', 'run');
  markerDirectories.set(cwd, directory);
  return directory;
}

export function ownRunMarkers(cwd = process.cwd()) {
  const directory = runMarkerDirectory(cwd);
  if (directory === null) return [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const ancestors = ancestorPids();
  const markers = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(directory, entry);
    let marker;
    try {
      marker = JSON.parse(readRegularFile(path));
    } catch {
      continue;
    }
    if (marker?.version !== 1 || !Array.isArray(marker.pids)) continue;
    if (marker.pids.some((pid) =>
      Number.isSafeInteger(pid)
      && pid > 1
      && ancestors.has(pid)
      && processAlive(pid))) {
      markers.push({ path, marker });
    }
  }
  return markers;
}

export function loopRunIsOpen(cwd = process.cwd()) {
  return ownRunMarkers(cwd).length > 0;
}

// A run that closed deliberately is still OPEN to the command guard — the
// session goes on issuing commands and the rules that block `gh pr merge` have
// no reason to relax. `closedAt` answers a different question, asked only by the
// Stop hook: is this run still supposed to be taking work? Anything present but
// unrecognised counts as closed, because the liveness guard's failure direction
// is silence.
export function loopRunIsLive(cwd = process.cwd()) {
  return ownRunMarkers(cwd).some(({ marker }) => marker.closedAt === undefined);
}

// The open runs the plugin's prime opened (each marker records its base; a
// legacy install's own prime writes markers without one — that run is the
// vendored guard's, never this one's). Looked up from the hook's cwd and from
// the project root, since either may be where the session works; oldest first.
export function pluginRunMarkers(dirs = [process.cwd()]) {
  const seen = new Set();
  return dirs.flatMap((dir) => ownRunMarkers(dir))
    .filter(({ path, marker }) => typeof marker.baseBranch === 'string' && !seen.has(path) && seen.add(path))
    .sort((left, right) => (left.marker.openedAtMs ?? 0) - (right.marker.openedAtMs ?? 0));
}

// The session latch: the run's second record, outside the repository. The
// markers live in the git dir, which the run can reach, and a run that
// deleted them (or broke git so they could not be found) switched its own
// guard off (security audits after 0.60.0). The latch belongs to the
// session's Claude process — found in the ancestry the way markers are
// matched, never through git or anything the run can edit — and records
// the run's base, pinned once. prime writes it when it opens a run (no
// window between opening and a first hook), the command guard writes it the
// first time it sees an open run, and it holds for as long as that Claude
// process lives. Its start time guards against pid reuse.
export function latchDirectory(home = homedir()) {
  return join(home, '.claude', 'autoloop', 'run-latches');
}

// What the run may not change, for both guards. state: the marker
// directories (the project's and the command's), the session latches, the
// shell snapshots and session environment files every Bash call sources, and
// — while a run is open — the project's and the user's Claude settings and
// plugin registry. code: the plugin's own tools and hooks (this file's
// neighbours), which every hook call runs afresh.
export const PLUGIN_CODE_DIRS = Object.freeze(['tools', 'hooks']
  .map((name) => join(dirname(dirname(fileURLToPath(import.meta.url))), name)));

export function protectedPaths({ projectRoot, cwd = projectRoot, runOpen, home = homedir() }) {
  const state = [
    runMarkerDirectory(projectRoot), runMarkerDirectory(cwd), latchDirectory(home),
    join(home, '.claude', 'shell-snapshots'), join(home, '.claude', 'session-env'),
    ...(runOpen ? [
      ...['.claude/settings.json', '.claude/settings.local.json'].map((file) => join(projectRoot, file)),
      ...['settings.json', 'settings.local.json', 'plugins/installed_plugins.json', 'plugins/known_marketplaces.json']
        .map((file) => join(home, '.claude', file)),
    ] : []),
  ];
  const withReal = (list) => {
    const present = list.filter((path) => path !== null);
    return [...new Set([...present, ...present.map((path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    })])];
  };
  return { state: withReal(state), code: withReal(PLUGIN_CODE_DIRS) };
}

export function commonDirOf(cwd = process.cwd()) {
  const markers = runMarkerDirectory(cwd);
  return markers === null ? null : dirname(dirname(markers));
}

// The session's Claude process: the first Claude ancestor, or (on a host
// without one — CI) the outermost ancestor this process can see.
export function sessionOwnerPid(start = process.ppid, readEntry = procEntry, limit = 64) {
  let pid = start;
  let last = null;
  for (let depth = 0; depth < limit && pid >= 1; depth += 1) {
    const entry = readEntry(pid);
    // A Claude process may be pid 1 (a container); nothing else there is ours.
    if (pid === 1) return entry !== null && isClaudeProcess(entry[1], entry[2]) ? 1 : last;
    last = pid;
    if (entry === null) return last;
    const [parent, name, exe] = entry;
    if (isClaudeProcess(name, exe)) return pid;
    if (!Number.isSafeInteger(parent) || parent <= 0) return last;
    pid = parent;
  }
  return last;
}

let ownerMemo;
function currentOwner() {
  if (ownerMemo === undefined) ownerMemo = sessionOwnerPid();
  return ownerMemo;
}

// When a process started, as the kernel (or ps, in a fixed locale and zone)
// reports it: a pid reused by a later process has a different start. null
// when it cannot be read — which is never taken for a different process.
export function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    if (process.platform === 'linux') return null;
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    const text = String(result.stdout ?? '').trim();
    return result.status === 0 && text !== '' ? text : null;
  }
}

// Whether a latch's owner is gone: dead, or its pid provably reused.
function ownerGone(owner, ownerStart) {
  if (!Number.isSafeInteger(owner) || !processAlive(owner)) return true;
  if (ownerStart === null || ownerStart === undefined) return false;
  const now = processStart(owner);
  return now !== null && now !== ownerStart;
}

// A file read only if it is a regular one: a FIFO planted where a marker or
// latch belongs would block the hook past its timeout.
export function readRegularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error(`${path} is not a regular file`);
  return readFileSync(path, 'utf8');
}

function latchPath(owner, directory) {
  return join(directory, `${owner}.json`);
}

// scope: the run's repository root, so the guard can tell a repository git
// no longer reads (a broken HEAD) from a project directory that was never one.
export function recordLatch({ owner = currentOwner(), baseBranch, scope = null, directory = latchDirectory(), nowMs = Date.now() }) {
  if (!Number.isSafeInteger(owner) || owner < 1 || typeof baseBranch !== 'string') return null;
  const path = latchPath(owner, directory);
  const existing = sessionLatch({ owner, directory });
  if (existing !== null) return existing.unreadable ? null : path;
  const latch = { version: 2, owner, ownerStart: processStart(owner), baseBranch, scope, latchedAtMs: nowMs };
  // Written whole to a temporary file and linked into place: a crash
  // mid-write never leaves a torn (unreadable, so refusing) latch.
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(latch)}\n`, { flag: 'w', mode: 0o600 });
    linkSync(temporary, path);
    return path;
  } catch (error) {
    // Another hook of this session linked it first: that one stands.
    return error?.code === 'EEXIST' && sessionLatch({ owner, directory })?.latch !== undefined ? path : null;
  } finally {
    try {
      unlinkSync(temporary);
    } catch { /* already gone */ }
  }
}

// { latch } for this session's latch; { unreadable } for one that exists
// but cannot be trusted (the guard then refuses); null when there is none,
// or it was a dead or provably earlier process's (the file is pruned).
export function sessionLatch({ owner = currentOwner(), directory = latchDirectory() } = {}) {
  if (!Number.isSafeInteger(owner) || owner < 1) return null;
  const path = latchPath(owner, directory);
  let latch;
  try {
    latch = JSON.parse(readRegularFile(path));
  } catch (error) {
    return error?.code === 'ENOENT' ? null : { unreadable: true, path };
  }
  if (latch?.version !== 2 || latch.owner !== owner || typeof latch.baseBranch !== 'string') {
    return { unreadable: true, path };
  }
  if (ownerGone(owner, latch.ownerStart)) {
    try {
      unlinkSync(path);
    } catch { /* already gone */ }
    return null;
  }
  return { latch, path };
}

// Latches whose owners have exited (or whose pid now belongs to another
// process): their sessions are over.
export function pruneLatches(directory = latchDirectory(), nowMs = Date.now()) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const pruned = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      // A temporary left by a crash between write and link.
      if (/^\d+\.json\.\d+\.tmp$/u.test(name)) {
        if (nowMs - lstatSync(path).mtimeMs > 60_000) {
          unlinkSync(path);
          pruned.push(path);
        }
        continue;
      }
      if (!/^\d+\.json$/u.test(name)) continue;
      const { owner, ownerStart } = JSON.parse(readRegularFile(path));
      if (ownerGone(owner, ownerStart)) {
        unlinkSync(path);
        pruned.push(path);
      }
    } catch { /* unreadable: left for the session that owns it to refuse on */ }
  }
  return pruned;
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function ancestorPids(limit = 64) {
  return ancestorChain(process.ppid, procEntry, limit);
}

export function ancestorChain(start, readEntry = procEntry, limit = 64) {
  const pids = new Set();
  let pid = start;
  for (let depth = 0; depth < limit && pid > 1; depth += 1) {
    pids.add(pid);
    const entry = readEntry(pid);
    if (entry === null) return pids;
    const [parent, name, exe] = entry;
    if (isClaudeProcess(name, exe)) return pids;
    if (!Number.isSafeInteger(parent) || parent <= 0) return pids;
    pid = parent;
  }
  return pids;
}

// A session's ancestry ends at its own Claude Code process. Above it sit the
// shell, the terminal multiplexer and the init chain that every other session
// on the machine shares; recording those let any session in the repo pass for
// the loop's own run. With no `claude` ancestor (another host) the whole chain
// is kept, as before.
//
// comm is the name the binary was launched under, since it never retitles
// itself (measured, 2.1.283): `claude` through the installer's symlink,
// `claude.exe` for the npm package's copy, the bare version for a versioned
// path launched directly. The executable's path names the install in all three.
export function isClaudeProcess(name, exe = '') {
  return /^claude(?:\.exe)?$/u.test(name) || /\/claude\/versions\/[^/]+$|\/claude(?:\.exe)?$/u.test(exe);
}

export function procEntry(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    let exe = '';
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      exe = ''; // another user's process: comm alone decides
    }
    return Number.isSafeInteger(parent) ? [parent, name, exe] : null;
  } catch {
    return process.platform === 'linux' ? null : psEntry(pid);
  }
}

// Where /proc is absent (macOS), ps gives the parent and the command; the
// command is often the executable's full path there, which also names a
// Claude install the way /proc/<pid>/exe does.
export function psEntry(pid, run = (args) => spawnSync('ps', args, { encoding: 'utf8', timeout: 5000 })) {
  const result = run(['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)]);
  const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(String(result?.stdout ?? '').split('\n')[0] ?? '');
  if (result?.status !== 0 || match === null) return null;
  const command = match[2];
  return [Number(match[1]), basename(command), command.startsWith('/') ? command : ''];
}
