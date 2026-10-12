#!/usr/bin/env node
// autoloop — run-markers.mjs
//
// The run's durable evidence: markers prime writes under the common git dir,
// bound to the session's process ancestry. The command guard, the other hooks,
// prime, step and the reports all read runs through here; the guard's own
// self-test exercises it.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedGit } from './git-budget.mjs';

// The guard is defense-in-depth for commands a run issues; repository rules are
// the enforcement boundary. Applying it to every Bash call in the project turns
// ordinary development into a fight with a policy that was never aimed at it, so
// it enforces only for the session that owns an open run (ownedRun, below).
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
      && processAlive(pid)
      && sameProcess(marker, pid))) {
      markers.push({ path, marker });
    }
  }
  return markers;
}

// A pid the marker recorded with its start time is that process only: a
// later process given the same pid is not the run's.
function sameProcess(marker, pid) {
  const recorded = marker.starts?.[pid];
  if (recorded === undefined || recorded === null) return true;
  const now = processStart(pid);
  return now === null || now === recorded;
}

export function loopRunIsOpen(cwd = process.cwd()) {
  return ownRunMarkers(cwd).length > 0;
}

// Whether a marker is still taking work. `closedAt` is asked only by the Stop
// hook, the parked view and the AskUserQuestion rule; the guards keep a closed
// run's rules for its session (its latch, ownedRun includeClosed). Anything
// present but unrecognised counts as closed, because the liveness guard's
// failure direction is silence.
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
// the run's base, pinned once, and the conversation that opened the run.
// Only prime writes it, before the run's marker (no window between opening
// and a first hook); `--close-run` closes it and a later prime re-opens it.
// Its start time guards against pid reuse. It is also what every hook asks
// first (ownedRun): a session owns a run only through its latch.
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

// The working directory of a live process, or null.
function processCwd(pid) {
  try {
    return realpathSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

// The conversations this session continues: its own id, and the session its
// Claude process resumed or forked (`--resume <id or transcript path>`).
// Moving a session to the background forks it and leaves the original
// process alive and idle, holding the run it opened; the fork is that run.
export function sessionLineage({ env = process.env, ownerCmdline = ownerCommandLine() } = {}) {
  const lineage = new Set();
  if (env.CLAUDE_CODE_SESSION_ID) lineage.add(env.CLAUDE_CODE_SESSION_ID);
  for (const flag of ['--resume', '-r']) {
    const at = ownerCmdline.indexOf(flag);
    const id = at === -1 ? null : /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u.exec(ownerCmdline[at + 1] ?? '')?.[1];
    if (id) lineage.add(id);
  }
  return lineage;
}

function ownerCommandLine() {
  try {
    return readFileSync(`/proc/${sessionOwnerPid()}/cmdline`, 'utf8').split('\0');
  } catch {
    return [];
  }
}

// Open runs on this checkout that another live Claude session holds: a
// marker not closed, one of whose pids is a live Claude process outside this
// process's own ancestry, working inside this repository. One orchestrator
// per checkout (LFE run 2026-09-30: a resumed fork and a new session opened
// runs 15 s apart and fought over the branch). A marker kept alive only by a
// shell or tmux pid, or a pid now working elsewhere, is not a session's run.
export function liveRunsElsewhere(root, {
  own = new Set([process.pid, process.ppid, ...ancestorPids()]),
  lineage = sessionLineage(),
  entryOf = procEntry,
  cwdOf = processCwd,
} = {}) {
  const directory = runMarkerDirectory(root);
  if (directory === null) return [];
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  let top;
  try {
    top = realpathSync(root);
  } catch {
    top = root;
  }
  const runs = [];
  for (const name of names) {
    let marker;
    try {
      marker = JSON.parse(readRegularFile(join(directory, name)));
    } catch {
      continue;
    }
    if (marker?.closedAt !== undefined || !Array.isArray(marker?.pids)) continue;
    const pids = marker.pids.filter((pid) => Number.isSafeInteger(pid) && pid > 1);
    if (pids.some((pid) => own.has(pid))) continue;
    if (typeof marker.sessionId === 'string' && lineage.has(marker.sessionId)) continue;
    const holder = pids.find((pid) => {
      const entry = entryOf(pid);
      const cwd = entry === null ? null : cwdOf(pid);
      return entry !== null && isClaudeProcess(entry[1], entry[2])
        && cwd !== null && (cwd === top || cwd.startsWith(`${top}/`));
    });
    if (holder !== undefined) runs.push({ pid: holder, openedAtMs: marker.openedAtMs ?? null, parked: Boolean(marker.park) });
  }
  return runs;
}

// The step model table prime resolved for this run (models-config.mjs
// pinModels): its dispatches read it here, beside the run's markers.
export function pinnedModelsPath(cwd = process.cwd()) {
  const markers = runMarkerDirectory(cwd);
  return markers === null ? null : join(dirname(markers), 'models.json');
}

export function protectedPaths({
  projectRoot, cwd = projectRoot, runOpen, home = homedir(),
  configDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
}) {
  const state = [
    runMarkerDirectory(projectRoot), runMarkerDirectory(cwd), latchDirectory(home),
    pinnedModelsPath(projectRoot), pinnedModelsPath(cwd),
    join(home, '.claude', 'shell-snapshots'), join(home, '.claude', 'session-env'),
    ...(runOpen ? [
      ...['.claude/settings.json', '.claude/settings.local.json'].map((file) => join(projectRoot, file)),
      ...['settings.json', 'settings.local.json', 'plugins/installed_plugins.json', 'plugins/known_marketplaces.json']
        .map((file) => join(home, '.claude', file)),
      // The operator's step models, where models-config reads them: a run
      // never changes its own.
      join(configDir, 'autoloop', 'config.json'),
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
// latch belongs would block the hook past its timeout. Checked on the open
// descriptor, so a swap after the check cannot reach the read.
export function readRegularFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function latchPath(owner, directory) {
  return join(directory, `${owner}.json`);
}

// scope: the run's repository root, so the guard can tell a repository git
// no longer reads (a broken HEAD) from a project directory that was never one.
// An existing latch of this process keeps its base and scope; prime re-opens
// it for its own conversation.
export function recordLatch({
  owner = currentOwner(), baseBranch, scope = null, sessionId = null, directory = latchDirectory(), nowMs = Date.now(),
}) {
  if (!Number.isSafeInteger(owner) || owner < 1 || typeof baseBranch !== 'string') return null;
  const path = latchPath(owner, directory);
  const existing = sessionLatch({ owner, directory });
  if (existing?.unreadable) return null;
  if (existing !== null) {
    const { closedAt, ...kept } = existing.latch;
    // An open latch keeps the conversation it names: rebinding it would
    // switch that session's guards off (security review H2).
    if (closedAt === undefined && typeof kept.sessionId === 'string' && kept.sessionId !== '') return path;
    return replaceLatch(path, { ...kept, sessionId }) ? path : null;
  }
  const latch = { version: 2, owner, ownerStart: processStart(owner), baseBranch, scope, latchedAtMs: nowMs, sessionId };
  // Written whole to a temporary file and linked into place: a crash
  // mid-write never leaves a torn (unreadable, so refusing) latch.
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(latch)}\n`, { flag: 'w', mode: 0o600 });
    linkSync(temporary, path);
    return path;
  } catch (error) {
    // Another process of this session linked it first: that one stands.
    return error?.code === 'EEXIST' && sessionLatch({ owner, directory })?.latch !== undefined ? path : null;
  } finally {
    try {
      unlinkSync(temporary);
    } catch { /* already gone */ }
  }
}

function replaceLatch(path, latch) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(latch)}\n`, { flag: 'w', mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    try {
      unlinkSync(temporary);
    } catch { /* already gone */ }
    return false;
  }
}

// `prime.mjs --close-run`: the session stops owning its run.
export function closeLatch({ owner = currentOwner(), directory = latchDirectory(), nowMs = Date.now() } = {}) {
  const existing = sessionLatch({ owner, directory });
  if (existing === null || existing.unreadable) return null;
  if (existing.latch.closedAt !== undefined) return existing.path;
  return replaceLatch(existing.path, { ...existing.latch, closedAt: new Date(nowMs).toISOString() }) ? existing.path : null;
}

// This Claude process's latch, read only: { latch, path, closed } when it is
// this process's (same start time); { unreadable, path } when it exists but
// cannot be trusted; else null. With no latch at all it reads one directory
// listing: no git, no process.
export function heldLatch({ owner, directory = latchDirectory() } = {}) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return null;
  }
  if (!names.some((name) => /^\d+\.json$/u.test(name))) return null;
  const pid = owner ?? currentOwner();
  if (!Number.isSafeInteger(pid) || pid < 1 || !names.includes(`${pid}.json`)) return null;
  const path = latchPath(pid, directory);
  let latch;
  try {
    latch = JSON.parse(readRegularFile(path));
  } catch (error) {
    return error?.code === 'ENOENT' ? null : { unreadable: true, path };
  }
  if (latch?.version !== 2 || latch.owner !== pid || typeof latch.baseBranch !== 'string') return { unreadable: true, path };
  if (latch.ownerStart === null || latch.ownerStart === undefined || latch.ownerStart !== processStart(pid)) return null;
  return { latch, path, closed: latch.closedAt !== undefined };
}

export function openLatch(where = {}) {
  const held = heldLatch(where);
  return held?.closed ? null : held;
}

// The one ownership predicate (SPEC-session-ownership): this process's open
// latch, naming the conversation in the hook's input (`session_id`). /clear
// starts another conversation, so it ends ownership; compaction keeps it.
// Every hook asks it before any git, GitHub or file work. The guards pass
// includeClosed: --close-run ends the Stop check, preflight, riders and
// transcript capture, but this session stays guarded until /clear or exit.
export function ownedRun({ sessionId, includeClosed = false, ...where } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const held = includeClosed ? heldLatch(where) : openLatch(where);
  return held === null || held.unreadable || held.latch.sessionId === sessionId ? held : null;
}

// The host's session id for prime. Bash sees only the environment, which a
// command can change; the command guard reads `session_id` from the hook
// input of the prime command and leaves it here, beside the latch, with the
// owner's start time so a reused pid never inherits it. It is single-use and
// short-lived: a prime the guard did not recognise as one (after /clear, it
// would open the old session's run) finds nothing to take (re-audit N1).
export const HOST_SESSION_MAX_AGE_MS = 10_000;

function sessionPath(owner, directory) {
  return join(directory, `${owner}.session`);
}

// A prime whose input names no session clears an earlier one: prime then
// refuses rather than open the run for a conversation that did not ask.
export function recordHostSession({ owner = currentOwner(), sessionId, directory = latchDirectory(), nowMs = Date.now() } = {}) {
  if (!Number.isSafeInteger(owner) || owner < 1) return null;
  const path = sessionPath(owner, directory);
  const ownerStart = processStart(owner);
  if (typeof sessionId !== 'string' || sessionId === '' || ownerStart === null) {
    try {
      unlinkSync(path);
    } catch { /* none recorded */ }
    return null;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ sessionId, ownerStart, atMs: nowMs, nonce: randomUUID() })}\n`);
    } finally {
      closeSync(fd);
    }
    if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`${path} is not a regular file`);
    renameSync(temporary, path);
    return path;
  } catch {
    try {
      unlinkSync(temporary);
    } catch { /* never written */ }
    return null;
  }
}

// Takes the hand-off: renamed aside first, so one prime alone can read it,
// then removed whatever it holds. Only a fresh one of this process counts.
export function takeHostSession({ owner = currentOwner(), directory = latchDirectory(), nowMs = Date.now() } = {}) {
  if (!Number.isSafeInteger(owner) || owner < 1) return null;
  const taken = `${sessionPath(owner, directory)}.${process.pid}.tmp`;
  try {
    renameSync(sessionPath(owner, directory), taken);
  } catch {
    return null;
  }
  try {
    const { sessionId, ownerStart, atMs } = JSON.parse(readRegularFile(taken));
    const start = processStart(owner);
    const age = nowMs - atMs;
    return typeof sessionId === 'string' && sessionId !== '' && start !== null && ownerStart === start
      && Number.isFinite(age) && age >= -1000 && age <= HOST_SESSION_MAX_AGE_MS ? sessionId : null;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(taken);
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
      if (/^\d+\.(?:json|session)\.\d+\.tmp$/u.test(name)) {
        if (nowMs - lstatSync(path).mtimeMs > 60_000) {
          unlinkSync(path);
          pruned.push(path);
        }
        continue;
      }
      const kind = /^(\d+)\.(json|session)$/u.exec(name);
      if (kind === null) continue;
      const recorded = JSON.parse(readRegularFile(path));
      const owner = kind[2] === 'session' ? Number(kind[1]) : recorded.owner;
      const { ownerStart } = recorded;
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

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'run-markers-')));
  try {
    const directory = join(scratch, 'latches');
    const owner = sessionOwnerPid();
    const start = processStart(owner);
    const latchFile = join(directory, `${owner}.json`);
    const plant = (fields) => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(latchFile, JSON.stringify({ version: 2, owner, ownerStart: start, baseBranch: 'main', scope: scratch, latchedAtMs: 1, ...fields }));
    };
    const owned = (sessionId) => ownedRun({ sessionId, directory });
    check('no latch directory, or none for this process, is no ownership',
      owned('s-1') === null && (mkdirSync(directory, { recursive: true }), owned('s-1')) === null);
    plant({ sessionId: 's-1' });
    check('an open latch of this process naming this session owns the run',
      owned('s-1')?.latch?.sessionId === 's-1');
    check('a missing session id, or another session (after /clear), is no ownership',
      owned(undefined) === null && owned('') === null && owned('s-2') === null);
    plant({ sessionId: 's-1', closedAt: '2026-10-12T00:00:00.000Z' });
    check('a closed latch is no ownership', owned('s-1') === null);
    const guarding = (sessionId) => ownedRun({ sessionId, includeClosed: true, directory });
    check('a closed latch keeps the guards for its own session only, until /clear',
      guarding('s-1')?.closed === true && guarding('s-1')?.latch?.sessionId === 's-1'
        && guarding('s-2') === null && guarding(undefined) === null);
    plant({ sessionId: 's-1', ownerStart: 'another-process' });
    check('a latch whose pid now belongs to another process (start time differs) is no ownership',
      owned('s-1') === null && existsSync(latchFile));
    plant({ sessionId: 's-1', ownerStart: null });
    check('a latch with no recorded start time is no ownership', owned('s-1') === null);
    plant({});
    check('a latch from before session ids is no ownership', owned('s-1') === null);
    writeFileSync(latchFile, '{ corrupt');
    check('an unreadable latch of this process is reported, never read as ownership',
      owned('s-1')?.unreadable === true && openLatch({ directory })?.unreadable === true);
    rmSync(directory, { recursive: true, force: true });
    const opened = recordLatch({ baseBranch: 'main', scope: scratch, sessionId: 's-1', directory });
    const first = JSON.parse(readFileSync(latchFile, 'utf8'));
    check('prime records the session id and this process\'s start time in a new latch',
      opened === latchFile && first.sessionId === 's-1' && first.ownerStart === start && owned('s-1') !== null);
    for (const other of ['s-foreign', null, '']) recordLatch({ baseBranch: 'main', scope: scratch, sessionId: other, directory });
    check('an open latch is never rebound to another, an empty or a missing session id',
      JSON.parse(readFileSync(latchFile, 'utf8')).sessionId === 's-1' && owned('s-1') !== null && owned('s-foreign') === null);
    const closed = closeLatch({ directory, nowMs: Date.UTC(2026, 9, 12) });
    check('--close-run closes the latch: ownership ends',
      closed === latchFile && typeof JSON.parse(readFileSync(latchFile, 'utf8')).closedAt === 'string' && owned('s-1') === null);
    const reopened = recordLatch({ baseBranch: 'other', scope: scratch, sessionId: 's-2', directory });
    const second = JSON.parse(readFileSync(latchFile, 'utf8'));
    check('a later prime re-opens ownership for its own conversation and keeps the pinned base',
      reopened === latchFile && second.closedAt === undefined && second.sessionId === 's-2'
        && second.baseBranch === 'main' && owned('s-2') !== null && owned('s-1') === null);
    // The host's session id, as the command guard read it from the prime
    // command's hook input: only this process's file, with its start time.
    const sessionFile = join(directory, `${owner}.session`);
    const recorded = recordHostSession({ sessionId: 's-host', directory });
    const mode = lstatSync(sessionFile).mode & 0o777;
    const written = JSON.parse(readFileSync(sessionFile, 'utf8'));
    const hostRead = takeHostSession({ directory });
    const again = takeHostSession({ directory });
    writeFileSync(sessionFile, JSON.stringify({ ...written, ownerStart: 'another-process' }));
    const reused = takeHostSession({ directory });
    recordHostSession({ sessionId: 's-host', directory, nowMs: Date.now() - 60_000 });
    const stale = takeHostSession({ directory });
    const staleGone = !existsSync(sessionFile);
    symlinkSync(latchFile, sessionFile);
    const linked = recordHostSession({ sessionId: 's-host', directory }) === null && takeHostSession({ directory }) === null
      && readFileSync(latchFile, 'utf8').length > 0;
    rmSync(sessionFile, { force: true });
    // Re-audit N1: a hand-off read without being consumed let a later,
    // unrecognised prime (after /clear) open the old session's run.
    check('the guard hands prime the host session id once, fresh, in a private file of this process; nothing else is trusted',
      recorded === sessionFile && mode === 0o600 && typeof written.nonce === 'string' && Number.isFinite(written.atMs)
        && hostRead === 's-host' && again === null && reused === null && stale === null && staleGone && linked
        && takeHostSession({ directory }) === null && recordHostSession({ sessionId: '', directory }) === null);
    // A latch swapped for a FIFO between the type check and the read once
    // could hang the guard past its timeout (review L4).
    if (process.platform === 'linux') {
      const race = join(scratch, 'race');
      mkdirSync(race);
      writeFileSync(join(race, 'regular'), '{}');
      spawnSync('mkfifo', [join(race, 'fifo')], { timeout: 5000 });
      const swapper = spawn(process.execPath, ['-e', `const fs = require('node:fs'); const [d] = process.argv.slice(1);
        const until = Date.now() + 15000;
        while (Date.now() < until) { for (const name of ['regular', 'fifo']) {
          try { fs.renameSync(d + '/' + name, d + '/latch'); fs.renameSync(d + '/latch', d + '/' + name); } catch {} } }`, race], { stdio: 'ignore' });
      const reader = spawnSync(process.execPath, ['--input-type=module', '-e', `const { readRegularFile } = await import(process.argv[2]);
        const until = Date.now() + 3000;
        while (Date.now() < until) { try { readRegularFile(process.argv[1]); } catch {} }
        console.log('done');`, join(race, 'latch'), fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
      swapper.kill('SIGKILL');
      check('a latch swapped for a FIFO mid-read never hangs the reader', reader.status === 0 && reader.stdout.includes('done'));
    }
    // Marker hardening: a live ancestor whose start differs is a reused pid.
    const repo = join(scratch, 'repo');
    spawnSync('git', ['init', '-q', repo], { timeout: 10000 });
    const markers = runMarkerDirectory(repo);
    if (markers !== null && process.platform === 'linux') {
      mkdirSync(markers, { recursive: true });
      const ancestor = process.ppid;
      const mark = (fields) => writeFileSync(join(markers, 'm.json'), JSON.stringify({ version: 1, pids: [ancestor], baseBranch: 'main', ...fields }));
      mark({ starts: { [ancestor]: processStart(ancestor) } });
      const matched = ownRunMarkers(repo).length;
      mark({ starts: { [ancestor]: 'another-process' } });
      const reused = ownRunMarkers(repo).length;
      mark({});
      const legacy = ownRunMarkers(repo).length;
      check('a marker names its pids with start times, and a reused ancestor pid matches nothing',
        matched === 1 && reused === 0 && legacy === 1);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.error('usage: run-markers.mjs --self-test');
  process.exit(2);
}
