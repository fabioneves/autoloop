#!/usr/bin/env node
// autoloop — run-markers.mjs
//
// The run's durable evidence: markers prime writes under the common git dir,
// bound to the session's process ancestry. The command guard, the other hooks,
// prime, step and the reports all read runs through here; the guard's own
// self-test exercises it.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

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
export function runMarkerDirectory(cwd = process.cwd()) {
  const result = spawnSync(
    'git',
    ['-C', cwd, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true },
  );
  if (result.status !== 0 || result.error) return null;
  const common = String(result.stdout ?? '').trim();
  if (!common) return null;
  return join(isAbsolute(common) ? common : resolve(cwd, common), 'autoloop', 'run');
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
      marker = JSON.parse(readFileSync(path, 'utf8'));
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

// Every base an open plugin run names. A second marker can only add a base:
// the guard enforces each, so a forged one never relaxes the rules.
export function pluginRunBases(dirs = [process.cwd()]) {
  return [...new Set(pluginRunMarkers(dirs).map(({ marker }) => marker.baseBranch))];
}

// The session latch: the run's second record, outside the repository. The
// markers live in the git dir, which the run can reach, and a run that
// deleted them switched its own guard off (security audit after 0.60.0). The
// command guard writes a latch the first time it sees an open plugin run in a
// session — once, never updated, so the first base is pinned — and honours it
// for as long as a latched process is alive in the hook's ancestry, whatever
// happened to the markers. Keyed by session and repository (its common dir).
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export function latchDirectory(home = homedir()) {
  return join(home, '.claude', 'autoloop', 'run-latches');
}

export function commonDirOf(cwd = process.cwd()) {
  const markers = runMarkerDirectory(cwd);
  return markers === null ? null : dirname(dirname(markers));
}

function latchPath(sessionId, commonDir, directory) {
  return join(directory, `${createHash('sha256').update(`${sessionId}\0${commonDir}`).digest('hex')}.json`);
}

const livePid = (pid) => Number.isSafeInteger(pid) && pid > 1 && processAlive(pid);

export function recordLatch({ sessionId, commonDir, markers, directory = latchDirectory(), nowMs = Date.now() }) {
  if (!SESSION_ID.test(String(sessionId ?? '')) || typeof commonDir !== 'string') return null;
  const plugin = markers.filter(({ marker }) => typeof marker.baseBranch === 'string');
  if (plugin.length === 0) return null;
  const path = latchPath(sessionId, commonDir, directory);
  const latch = {
    version: 1,
    sessionId,
    commonDir,
    baseBranch: plugin[0].marker.baseBranch,
    pids: [...new Set(plugin.flatMap(({ marker }) => marker.pids))].filter((pid) => Number.isSafeInteger(pid) && pid > 1),
    latchedAtMs: nowMs,
  };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(latch)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return null;
  }
  return path;
}

// { latch } while it binds this session's live ancestry; { unreadable } for a
// latch that exists but cannot be trusted (the guard then refuses); null when
// there is none, or its processes have all exited (the file is pruned).
export function sessionLatch({ sessionId, commonDir, directory = latchDirectory(), ancestors = ancestorPids() }) {
  if (!SESSION_ID.test(String(sessionId ?? '')) || typeof commonDir !== 'string') return null;
  const path = latchPath(sessionId, commonDir, directory);
  let latch;
  try {
    latch = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT' ? null : { unreadable: true, path };
  }
  if (latch?.version !== 1 || latch.sessionId !== sessionId || latch.commonDir !== commonDir
    || typeof latch.baseBranch !== 'string' || !Array.isArray(latch.pids)) {
    return { unreadable: true, path };
  }
  const live = latch.pids.filter(livePid);
  if (live.length === 0) {
    try {
      unlinkSync(path);
    } catch { /* already gone */ }
    return null;
  }
  return live.some((pid) => ancestors.has(pid)) ? { latch, path } : null;
}

// Latches whose processes have all exited: their sessions are over.
export function pruneLatches(directory = latchDirectory()) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const pruned = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const { pids } = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(pids) && !pids.some(livePid)) {
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
