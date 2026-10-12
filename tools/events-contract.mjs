#!/usr/bin/env node
// autoloop — events-contract.mjs
//
// The contract between the loop and the UI (docs/specs/SPEC-events.md). The
// loop appends one line per state change to `<git-common-dir>/autoloop/
// events.jsonl`; the UI reads that file and nothing else of the loop's state.
// The UI writes one file per operator control under `autoloop/control/`; the
// loop consumes it and nothing else of the UI's. Every writer and reader goes
// through this module. A write is fail-open: the loop's own work never stops
// for a UI concern, so `appendEvent` and `writeControl` return `{ ok, error }`
// and never throw.
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EVENT_VERSION = 1;
export const EVENTS_FILE = 'events.jsonl';
export const EVENTS_ROTATED_FILE = 'events.1.jsonl';
export const CONTROL_DIR = 'control';
export const MAX_EVENTS_BYTES = 10 * 1024 * 1024;
export const MAX_LINE_BYTES = 4096;
export const MAX_TEXT_CHARS = 200;
export const CONTROL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const COMMON = Object.freeze(['v', 'at', 'run', 'kind', 'by']);
const OPTIONAL = Object.freeze(['issue', 'pr']);
// Each kind's fields beyond the common ones. A field not listed is refused.
export const EVENT_KINDS = Object.freeze({
  'run.start': Object.freeze([]),
  'run.end': Object.freeze(['reason']),
  select: Object.freeze([]),
  step: Object.freeze(['step', 'round', 'model', 'text']),
  'dispatch.start': Object.freeze(['dispatch', 'role', 'model', 'step', 'round', 'liveFile', 'pid']),
  'dispatch.end': Object.freeze(['dispatch', 'role', 'ms', 'ok', 'reason']),
  decision: Object.freeze(['text']),
  wait: Object.freeze(['reason', 'paths', 'text']),
  resume: Object.freeze(['reason', 'text']),
  block: Object.freeze(['reason', 'text']),
  deliver: Object.freeze([]),
  merge: Object.freeze(['ok', 'reason']),
  label: Object.freeze(['text']),
  control: Object.freeze(['text']),
  pause: Object.freeze([]),
  unpause: Object.freeze([]),
});
export const WRITERS = Object.freeze(['step', 'dispatch', 'unit', 'prime', 'publish', 'loop', 'ui']);

const CONTROL_COMMON = Object.freeze(['v', 'at', 'kind', 'by', 'session']);
export const CONTROL_KINDS = Object.freeze({
  pause: Object.freeze([]),
  unpause: Object.freeze([]),
  cancel: Object.freeze(['dispatch']),
  answer: Object.freeze(['issue', 'text']),
  merge: Object.freeze(['pr']),
  label: Object.freeze(['pr']),
});
const CONTROL_REQUIRED = Object.freeze({
  pause: [], unpause: [], cancel: ['dispatch'], answer: ['issue', 'text'], merge: ['pr'], label: ['pr'],
});

const isInt = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositive = (value) => Number.isSafeInteger(value) && value > 0;
const oneLine = (value) => typeof value === 'string' && !/[\n\r]/u.test(value) && value.length <= MAX_TEXT_CHARS;

function fieldError(name, value) {
  switch (name) {
    case 'v': return value === EVENT_VERSION ? null : `v must be ${EVENT_VERSION}`;
    case 'at': return isInt(value) ? null : 'at must be epoch ms';
    case 'run': case 'dispatch': case 'step': case 'round': case 'model': case 'role': case 'reason': case 'liveFile': case 'session':
      return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_CHARS * 2 ? null : `${name} must be a short string`;
    case 'kind': return typeof value === 'string' ? null : 'kind must be a string';
    case 'by': return WRITERS.includes(value) ? null : `by must be one of ${WRITERS.join(', ')}`;
    case 'issue': case 'pr': case 'pid': return isPositive(value) ? null : `${name} must be a positive integer`;
    case 'ms': return isInt(value) ? null : 'ms must be a non-negative integer';
    case 'ok': return typeof value === 'boolean' ? null : 'ok must be a boolean';
    case 'text': return oneLine(value) ? null : `text must be one line of at most ${MAX_TEXT_CHARS} characters`;
    case 'paths': return Array.isArray(value) && value.length <= 50 && value.every((path) => typeof path === 'string' && path.length <= 200)
      ? null : 'paths must be at most 50 short strings';
    default: return `${name} is not a field`;
  }
}

// A key whose value is undefined is absent: JSON.stringify drops it too.
function validateShape(record, common, optional, kinds, required = {}) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return { ok: false, error: 'not an object' };
  const kind = record.kind;
  if (!Object.hasOwn(kinds, kind)) return { ok: false, error: `unknown kind ${JSON.stringify(kind)}` };
  const allowed = new Set([...common, ...optional, ...kinds[kind]]);
  for (const [name, value] of Object.entries(record)) {
    if (value !== undefined && !allowed.has(name)) return { ok: false, error: `${name} is not a field of ${kind}` };
  }
  for (const name of common) {
    if (!(name in record)) return { ok: false, error: `${name} is required` };
  }
  for (const name of required[kind] ?? []) {
    if (!(name in record)) return { ok: false, error: `${name} is required for ${kind}` };
  }
  for (const [name, value] of Object.entries(record)) {
    if (value === undefined) continue;
    const error = fieldError(name, value);
    if (error !== null) return { ok: false, error };
  }
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line, 'utf8') >= MAX_LINE_BYTES) return { ok: false, error: `line is ${Buffer.byteLength(line, 'utf8')} bytes; the limit is ${MAX_LINE_BYTES}` };
  return { ok: true, line };
}

export function validateEvent(event) {
  const result = validateShape(event, COMMON, OPTIONAL, EVENT_KINDS);
  if (!result.ok) return result;
  // The optional common fields may be absent, never null.
  for (const name of ['issue', 'pr']) if (event[name] === null) return { ok: false, error: `${name} is absent, never null` };
  return result;
}

export function validateControl(control) {
  return validateShape(control, CONTROL_COMMON, [], CONTROL_KINDS, CONTROL_REQUIRED);
}

const eventsDir = (commonDir) => join(commonDir, 'autoloop');

// One appendFileSync per event: a line under the pipe buffer is one write.
// Rotation happens before the write that would pass the limit, so a reader
// sees at most two files and never a torn one.
export function appendEvent(commonDir, event, { maxBytes = MAX_EVENTS_BYTES } = {}) {
  const checked = validateEvent(event);
  if (!checked.ok) return checked;
  try {
    const directory = eventsDir(commonDir);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, EVENTS_FILE);
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(checked.line, 'utf8') + 1 > maxBytes) {
      renameSync(path, join(directory, EVENTS_ROTATED_FILE));
    }
    appendFileSync(path, `${checked.line}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// `limit` keeps the newest lines; the rotated file is read only when the
// current one holds fewer than that.
export function readEvents(commonDir, { limit = Infinity } = {}) {
  const directory = eventsDir(commonDir);
  const events = [];
  let skipped = 0;
  const readFile = (name) => {
    const path = join(directory, name);
    if (!existsSync(path)) return [];
    const parsed = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const record = JSON.parse(line);
        if (validateEvent(record).ok) parsed.push(record);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    return parsed;
  };
  const current = readFile(EVENTS_FILE);
  if (current.length < limit) events.push(...readFile(EVENTS_ROTATED_FILE));
  events.push(...current);
  return { events: Number.isFinite(limit) ? events.slice(-limit) : events, skipped };
}

const controlDir = (commonDir) => join(eventsDir(commonDir), CONTROL_DIR);
const controlName = (control) => `${String(control.at).padStart(13, '0')}-${control.kind}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;

// Written to a temporary name and renamed into place: a consumer never lists a
// half-written control. The temporary name starts with a dot and is never taken.
export function writeControl(commonDir, control) {
  const checked = validateControl(control);
  if (!checked.ok) return checked;
  try {
    const directory = controlDir(commonDir);
    mkdirSync(directory, { recursive: true });
    const name = controlName(control);
    const staged = join(directory, `.tmp-${name}`);
    writeFileSync(staged, `${checked.line}\n`);
    renameSync(staged, join(directory, name));
    return { ok: true, name };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function prune(directory, nowMs) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    try {
      if (nowMs - statSync(path).mtimeMs > CONTROL_RETENTION_MS) unlinkSync(path);
    } catch { /* pruning is best-effort */ }
  }
}

// The controls of the named kinds, oldest first, each with `done({ refused })`
// that moves its file to done/ or refused/ (a refusal records its reason in the
// file). A file that does not parse goes to refused/ at once. Pruning of the
// two directories at 7 days rides on every take.
export function takeControls(commonDir, kinds, { nowMs = Date.now() } = {}) {
  const directory = controlDir(commonDir);
  const done = join(directory, 'done');
  const refused = join(directory, 'refused');
  prune(done, nowMs);
  prune(refused, nowMs);
  if (!existsSync(directory)) return [];
  const wanted = new Set(kinds);
  const taken = [];
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const path = join(directory, name);
    let control;
    try {
      control = JSON.parse(readFileSync(path, 'utf8'));
      if (!validateControl(control).ok) throw new Error(validateControl(control).error);
    } catch (error) {
      mkdirSync(refused, { recursive: true });
      writeFileSync(join(refused, name), `${JSON.stringify({ name, reason: `unreadable: ${error.message}` })}\n`);
      unlinkSync(path);
      continue;
    }
    if (!wanted.has(control.kind)) continue;
    taken.push({
      control,
      name,
      done: ({ refused: reason = null } = {}) => {
        const target = reason === null ? done : refused;
        mkdirSync(target, { recursive: true });
        if (reason === null) renameSync(path, join(target, name));
        else {
          writeFileSync(join(target, name), `${JSON.stringify({ ...control, reason })}\n`);
          unlinkSync(path);
        }
      },
    });
  }
  return taken;
}

// The run id every writer stamps: prime writes it at run.start and clears it
// at run.end. A writer outside a run (an older plugin opened it, a bare tool
// call) stamps `unknown`, which the UI shows as such.
export const RUN_ID_FILE = 'run-id';
export function currentRunId(commonDir) {
  try {
    const id = readFileSync(join(eventsDir(commonDir), RUN_ID_FILE), 'utf8').trim();
    return id.length > 0 ? id : 'unknown';
  } catch {
    return 'unknown';
  }
}
export function setRunId(commonDir, id) {
  try {
    const path = join(eventsDir(commonDir), RUN_ID_FILE);
    if (id === null) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      mkdirSync(eventsDir(commonDir), { recursive: true });
      writeFileSync(path, `${id}\n`);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// What a writer calls: fills the version, the time and the run, drops
// undefined and null fields, appends, and reports a failure as one stderr line.
// Never throws; the writer's own result is never changed by it.
export function emitEvent(commonDir, event, { nowMs = Date.now(), stderr = process.stderr } = {}) {
  if (typeof commonDir !== 'string' || commonDir.length === 0) return { ok: false, error: 'no common dir' };
  const record = { v: EVENT_VERSION, at: nowMs, run: currentRunId(commonDir) };
  for (const [name, value] of Object.entries(event)) if (value !== undefined && value !== null) record[name] = value;
  const result = appendEvent(commonDir, record);
  if (!result.ok) {
    try { stderr.write(`events: ${record.kind ?? 'event'} not recorded: ${result.error}\n`); } catch { /* a closed stderr changes nothing */ }
  }
  return result;
}

// The paused marker: a control the loop keeps applied until unpause.
export const PAUSED_FILE = 'paused';
export function pausedPath(commonDir) { return join(controlDir(commonDir), PAUSED_FILE); }
export function isPaused(commonDir) { return existsSync(pausedPath(commonDir)); }
export function setPaused(commonDir, paused) {
  try {
    const path = pausedPath(commonDir);
    if (paused) {
      mkdirSync(controlDir(commonDir), { recursive: true });
      writeFileSync(path, '');
    } else if (existsSync(path)) unlinkSync(path);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function selfTest() {
  const checks = [];
  const check = (name, test) => {
    try {
      checks.push([name, test()]);
    } catch (error) {
      checks.push([`${name} (threw: ${error.message})`, false]);
    }
  };
  const fresh = () => mkdtempSync(join(tmpdir(), 'autoloop-events-'));
  const base = (over = {}) => ({ v: 1, at: 1700000000000, run: 'r1', kind: 'step', by: 'step', issue: 5, step: '05-implement', text: 'tests first', ...over });

  check('an event round-trips through append and read', () => {
    const dir = fresh();
    try {
      const written = appendEvent(dir, base());
      const { events, skipped } = readEvents(dir);
      return written.ok && skipped === 0 && events.length === 1 && events[0].step === '05-implement' && events[0].text === 'tests first';
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  check('an unknown kind is refused', () => !validateEvent(base({ kind: 'oops' })).ok);
  check('an extra field is refused', () => validateEvent(base({ secret: 'x' })).error === 'secret is not a field of step');
  check('a field of another kind is refused', () => validateEvent(base({ pid: 3 })).error === 'pid is not a field of step');
  check('a two-line text is refused', () => !validateEvent(base({ text: 'a\nb' })).ok);
  check('a text past 200 characters is refused', () => !validateEvent(base({ text: 'x'.repeat(201) })).ok);
  check('a line near 4 KiB is refused', () => {
    const wait = (paths) => base({ kind: 'wait', step: undefined, text: undefined, reason: 'pr', pr: 70, paths });
    return !validateEvent(wait(Array.from({ length: 50 }, () => 'p'.repeat(100)))).ok && validateEvent(wait(['src/a.mjs'])).ok;
  });
  check('a null issue is refused and an absent one accepted', () => !validateEvent(base({ issue: null })).ok && validateEvent(base({ issue: undefined })).ok);
  check('a writer outside the list is refused', () => !validateEvent(base({ by: 'model' })).ok);
  check('a malformed line is skipped and counted, the rest read', () => {
    const dir = fresh();
    try {
      appendEvent(dir, base());
      appendFileSync(join(dir, 'autoloop', EVENTS_FILE), 'not json\n{"v":1,"kind":"nope"}\n');
      appendEvent(dir, base({ at: 1700000000001 }));
      const { events, skipped } = readEvents(dir);
      return events.length === 2 && skipped === 2;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  check('the file rotates at the size and both files are read, newest last', () => {
    const dir = fresh();
    try {
      const lineBytes = Buffer.byteLength(`${JSON.stringify(base())}\n`);
      for (let n = 0; n < 5; n += 1) appendEvent(dir, base({ at: 1700000000000 + n }), { maxBytes: lineBytes * 3 });
      const rotated = existsSync(join(dir, 'autoloop', EVENTS_ROTATED_FILE));
      const { events } = readEvents(dir);
      return rotated && events.length === 5 && events[4].at === 1700000000004 && readEvents(dir, { limit: 2 }).events.length === 2;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  check('a failed append returns ok false and never throws', () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, 'autoloop'), 'a file where the directory should be');
      const result = appendEvent(dir, base());
      return result.ok === false && typeof result.error === 'string';
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const control = (over = {}) => ({ v: 1, at: 1700000000000, kind: 'answer', by: 'ui', session: 's1', issue: 5, text: 'use the spec', ...over });
  check('a control is written atomically and taken once', () => {
    const dir = fresh();
    try {
      const written = writeControl(dir, control());
      const listed = readdirSync(join(dir, 'autoloop', CONTROL_DIR));
      const first = takeControls(dir, ['answer']);
      first[0].done();
      const second = takeControls(dir, ['answer']);
      const inDone = readdirSync(join(dir, 'autoloop', CONTROL_DIR, 'done'));
      return written.ok && listed.length === 1 && !listed[0].startsWith('.') && first.length === 1 && first[0].control.text === 'use the spec'
        && second.length === 0 && inDone.length === 1;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  check('a control of another kind is left for its consumer', () => {
    const dir = fresh();
    try {
      writeControl(dir, control({ kind: 'pause', issue: undefined, text: undefined }));
      return takeControls(dir, ['answer']).length === 0 && takeControls(dir, ['pause']).length === 1;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  check('a refused control lands in refused/ with its reason', () => {
    const dir = fresh();
    try {
      writeControl(dir, control({ kind: 'merge', pr: 9, issue: undefined, text: undefined }));
      takeControls(dir, ['merge'])[0].done({ refused: 'not a loop pull request' });
      const files = readdirSync(join(dir, 'autoloop', CONTROL_DIR, 'refused'));
      const record = JSON.parse(readFileSync(join(dir, 'autoloop', CONTROL_DIR, 'refused', files[0]), 'utf8'));
      return files.length === 1 && record.reason === 'not a loop pull request' && record.pr === 9 && takeControls(dir, ['merge']).length === 0;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  check('a missing required field or an unknown control kind is refused at write', () =>
    !writeControl('/nonexistent', control({ text: undefined })).ok && !writeControl('/nonexistent', control({ kind: 'reboot' })).ok);
  check('an unreadable control file goes to refused/ and the rest are taken', () => {
    const dir = fresh();
    try {
      writeControl(dir, control());
      writeFileSync(join(dir, 'autoloop', CONTROL_DIR, '0000000000000-garbage.json'), '{');
      const taken = takeControls(dir, ['answer']);
      return taken.length === 1 && readdirSync(join(dir, 'autoloop', CONTROL_DIR, 'refused')).length === 1;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  check('done and refused files older than 7 days are pruned on a take', () => {
    const dir = fresh();
    try {
      writeControl(dir, control());
      takeControls(dir, ['answer'])[0].done();
      const later = Date.now() + CONTROL_RETENTION_MS + 1000;
      takeControls(dir, [], { nowMs: later });
      return readdirSync(join(dir, 'autoloop', CONTROL_DIR, 'done')).length === 0;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  check('emitEvent stamps v, at and the run id, drops null fields, and reports a failure on stderr', () => {
    const dir = fresh();
    try {
      const lines = [];
      const stderr = { write: (line) => lines.push(line) };
      setRunId(dir, 'run-7');
      const ok = emitEvent(dir, { by: 'step', kind: 'step', issue: 5, step: '02-plan', round: null, model: undefined, text: 'go' }, { nowMs: 42, stderr });
      const { events } = readEvents(dir);
      setRunId(dir, null);
      const unknown = emitEvent(dir, { by: 'prime', kind: 'select', issue: 6 }, { nowMs: 43, stderr });
      const second = readEvents(dir).events[1];
      chmodSync(join(dir, 'autoloop', EVENTS_FILE), 0o400);
      const failed = emitEvent(dir, { by: 'step', kind: 'step', issue: 5, step: 'x', text: 'oops' }, { stderr });
      return ok.ok && events[0].v === 1 && events[0].at === 42 && events[0].run === 'run-7' && !('round' in events[0]) && !('model' in events[0])
        && unknown.ok && second.run === 'unknown'
        && (process.getuid?.() === 0 || (!failed.ok && lines.length === 1 && lines[0].startsWith('events: step not recorded')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  check('the paused marker is set, read and cleared', () => {
    const dir = fresh();
    try {
      return !isPaused(dir) && setPaused(dir, true).ok && isPaused(dir) && setPaused(dir, false).ok && !isPaused(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const failures = checks.filter(([, passed]) => !passed);
  for (const [name] of failures) console.error(`FAIL: ${name}`);
  console.log(failures.length ? `self-test FAILED (${failures.length}/${checks.length})` : `self-test OK (${checks.length} checks)`);
  return failures.length === 0;
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest() ? 0 : 1;
  console.error('usage: events-contract.mjs --self-test');
  return 2;
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isMain) process.exit(main());
