#!/usr/bin/env node
// autoloop — step.mjs
//
// One call per step transition, and the loop's status lines rendered from
// facts rather than composed from memory.
//
// Measured on LFE (2026-09-28, unit #350): 14 ribbons printed among ~120
// orchestrator tool calls. Every ribbon cost a clock read, a hand label swap
// and a snapshot invalidation around it, and was then drawn by hand, so the
// columns drifted and the window read as machinery rather than status.
//
// Usage:
//   node step.mjs --self-test

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './command-guard.mjs';
import { loopRunIsLive, ownRunMarkers, sessionLatch } from './run-markers.mjs';
import {
  completeSection, createSnapshot, eligibleIssueNumbers, invalidateSnapshot, SNAPSHOT_SECTIONS, verifySnapshot,
} from './snapshot-contract.mjs';
import { realRun } from './unit.mjs';

const LADDER = Object.freeze([
  '01-premise', '02-plan', '03-plan-review', '04-claim', '05-implement',
  '06-simplify', '07-diff-review', '08-code-review', '09-gate',
]);

// Pure: the label change a step needs, or null when none. Both halves, always:
// the predecessor is named even when an earlier swap already lost it, because
// the guard refuses an add that does not retire it. A fix round rides step
// 08's label; 00, 10 and 11 carry none.
export function swapPlan(current, to) {
  if (!LADDER.includes(to)) return null;
  const target = `loop:${to}`;
  const index = LADDER.indexOf(to);
  const predecessor = index > 0 ? [`loop:${LADDER[index - 1]}`] : [];
  const remove = [...new Set([
    ...current.filter((label) => /^loop:0\d-/u.test(label) && label !== target),
    ...predecessor,
  ])];
  const add = [
    ...(to === '01-premise' && !current.includes('loop-started') ? ['loop-started'] : []),
    ...(current.includes(target) ? [] : [target]),
  ];
  if (add.length === 0 && remove.every((label) => !current.includes(label))) return null;
  return { remove, add };
}

// Pure: the ladder steps a transition jumps over. The guard cannot see them:
// swapPlan always names the predecessor, so a 03→09 swap reads as a proper
// one. A fix round sits at 08; 10 and 11 come after 09. No ladder label yet
// (a fresh or staged unit) skips nothing. A skip is noted, never refused:
// step 06 is skipped by rule when no simplify engine is available.
export function skippedSteps(current, to) {
  const position = (step) => {
    if (step === '08-fix') return LADDER.indexOf('08-code-review');
    if (/^1\d-/u.test(step)) return LADDER.length;
    return LADDER.indexOf(step);
  };
  const highest = Math.max(-1, ...current
    .map((label) => /^loop:(0\d-[a-z-]+)$/u.exec(label)?.[1])
    .filter((step) => step !== undefined)
    .map(position));
  const target = position(to);
  return highest < 0 || target <= highest + 1 ? [] : LADDER.slice(highest + 1, target);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeAtomically(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(staged, path);
}

function autoloopDir(root, run) {
  const common = run('git', ['rev-parse', '--git-common-dir']);
  return common.ok ? { dir: join(resolve(root, common.stdout), 'autoloop') } : { dir: null, error: common.stderr };
}

// The retained prime snapshot is the newest one prime wrote.
function retainedSnapshotPath(dir) {
  const directory = join(dir, 'prime');
  if (!existsSync(directory)) return null;
  return readdirSync(directory)
    .filter((name) => name.endsWith('.snapshot.json'))
    .map((name) => join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] ?? null;
}

// A mutation marks the retained snapshot stale, so no later decision reads a
// label state that has moved.
// Invalidation clears the queue, so its eligible count is kept first for the
// parked view.
const QUEUE_COUNT = 'queue-count.json';

function invalidateRetainedSnapshot(dir) {
  const path = retainedSnapshotPath(dir);
  if (path === null) return null;
  const snapshot = readJson(path, null);
  if (!verifySnapshot(snapshot)) return `! retained snapshot ${path} is unreadable; re-prime before deciding`;
  const eligible = eligibleIssueNumbers(snapshot);
  if (eligible !== null) {
    writeAtomically(join(dir, QUEUE_COUNT), { eligible: eligible.length, scannedAtMs: Date.parse(snapshot.scannedAt) });
  }
  writeAtomically(path, invalidateSnapshot(snapshot, 'ISSUE_MUTATION'));
  return null;
}

// The current run began at its earliest open marker (every prime writes one;
// a close stamps them all). Markers from before the stamp give no bound.
function runStartMs(markers) {
  const starts = markers
    .map(({ marker }) => marker)
    .filter((marker) => marker.closedAt === undefined && Number.isSafeInteger(marker.openedAtMs))
    .map((marker) => marker.openedAtMs);
  return starts.length ? Math.min(...starts) : null;
}

// A unit is in flight when its record is open and this run touched it: an
// abandoned run's unit stays open in its steps file indefinitely.
function openUnits(dir, sinceMs = null) {
  const directory = join(dir, 'steps');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^\d+\.json$/u.test(name))
    .map((name) => readJson(join(directory, name), null))
    .filter((record) => record && !record.closed && record.steps?.length
      && record.steps.at(-1).step !== '11-record'
      && (sinceMs === null || record.steps.at(-1).startedAtMs >= sinceMs))
    .map((record) => ({ issue: record.issue, ...record.steps.at(-1) }))
    .sort((left, right) => left.issue - right.issue);
}

export function parkedView({ root, run = realRun(root), nowMs = Date.now(), markers = ownRunMarkers }) {
  const { dir } = autoloopDir(root, run);
  if (dir === null) return renderParked({ nowMs, units: [], eligible: null });
  const snapshotPath = retainedSnapshotPath(dir);
  const snapshot = snapshotPath === null ? null : readJson(snapshotPath, null);
  // Every step swap marks the snapshot stale, so a parked view nearly always
  // reads one; the count recorded just before that swap is shown with its time.
  const eligible = eligibleIssueNumbers(snapshot);
  const last = eligible === null ? readJson(join(dir, QUEUE_COUNT), null) : null;
  const blocked = snapshot?.sections?.blockedIssues;
  const waiting = blocked?.complete === true ? blocked.items.map((issue) => issue.number).slice(0, 3) : [];
  return renderParked({
    nowMs, units: openUnits(dir, runStartMs(markers(root))), waiting,
    eligible: eligible !== null ? eligible.length : last?.eligible ?? null,
    asOfMs: eligible === null ? last?.scannedAtMs ?? null : null,
  });
}

export function closeUnit({ root, run = realRun(root), nowMs = Date.now(), issue, outcome, title = '', pr = null, lines = null, question = '', ifOpen = false }) {
  const { dir } = autoloopDir(root, run);
  if (dir === null) return { ok: false, lines: ifOpen ? [] : [`step: no steps recorded for #${issue} (not in a git repository)`] };
  const path = join(dir, 'steps', `${issue}.json`);
  // A unit blocked at its premise, before any step was announced, still gets
  // its card (LFE run 2026-09-30: #389's --card failed "no steps recorded").
  const stored = readJson(path, null);
  // ifOpen: close only a record still in flight (a tool closing on the
  // orchestrator's behalf never re-renders a card already shown).
  if (ifOpen && (!stored?.steps?.length || stored.closed)) return { ok: false, lines: [] };
  if (!stored?.steps?.length && outcome !== 'blocked') return { ok: false, lines: [`step: no steps recorded for #${issue}`] };
  const record = stored ?? { issue, steps: [] };
  const card = renderCard({ issue, title, outcome, steps: record.steps ?? [], nowMs, pr, lines, question });
  record.closed = { outcome, atMs: nowMs };
  writeAtomically(path, record);
  return { ok: true, lines: [card] };
}

export function transition({
  root, run = realRun(root), evaluateCommand = evaluate, nowMs = Date.now(),
  issue, to, round = null, model = null, fallback = false, badge = '⏳', note = '', staged = false,
  markers = ownRunMarkers,
}) {
  const refuse = (message) => ({ ok: false, lines: [message] });
  if (!Number.isSafeInteger(issue) || issue < 1) return refuse('step: --issue must be a positive issue number');
  if (STEPS[to] === undefined) return refuse(`step: unknown step ${to}; one of ${Object.keys(STEPS).join(', ')}`);
  const { dir, error } = autoloopDir(root, run);
  if (dir === null) return refuse(`step: not inside a git repository: ${error}`);
  const stepsPath = join(dir, 'steps', `${issue}.json`);
  // A closed record is a finished run: a unit worked again starts afresh, so
  // "already on" and the card only ever see the current run.
  const stored = readJson(stepsPath, null);
  const record = stored === null || stored.closed ? { issue, steps: [] } : stored;
  const last = record.steps.at(-1);
  // A step an ended session recorded is announced afresh by the run that
  // inherits it, so the parked view (this run's steps only) shows it.
  const since = runStartMs(markers(root));
  const earlierRun = since !== null && Number.isSafeInteger(last?.startedAtMs) && last.startedAtMs < since;
  if (last && last.step === to && (last.round ?? null) === (round ?? null) && !earlierRun) {
    return { ok: true, lines: [`already on ${to}`] };
  }
  // A staged unit runs its read-only steps 1-3 unlabelled, so the worked
  // unit keeps the only label mutations; it is announced and recorded only.
  const labels = staged ? { ok: true, stdout: '[]' }
    : run('gh', ['issue', 'view', String(issue), '--json', 'labels', '--jq', '[.labels[].name]']);
  if (!labels.ok) return refuse(`step: could not read #${issue}'s labels: ${labels.stderr}`);
  const current = readJsonText(labels.stdout);
  const plan = staged ? null : swapPlan(current, to);
  const skipped = staged ? [] : skippedSteps(current, to);
  if (plan !== null) {
    const argv = ['issue', 'edit', String(issue),
      ...(plan.remove.length ? ['--remove-label', plan.remove.join(',')] : []),
      ...(plan.add.length ? ['--add-label', plan.add.join(',')] : [])];
    const branch = run('git', ['branch', '--show-current']).stdout || 'main';
    const verdict = evaluateCommand(`gh ${argv.join(' ')}`, branch, { stepTool: true });
    if (verdict.block) return refuse(verdict.reason);
    const swapped = run('gh', argv);
    if (!swapped.ok) return refuse(`step: label swap on #${issue} failed: ${swapped.stderr}`);
  }
  // A labelled step not yet recorded moved its labels now or in a retry's
  // failed first attempt; either way the retained snapshot is stale. Once the
  // labels have moved, a bookkeeping fault is reported, never thrown.
  let warning = null;
  try {
    if (!staged && LADDER.includes(to)) warning = invalidateRetainedSnapshot(dir);
    record.steps.push({
      step: to, round, model, fallback, staged, startedAtMs: nowMs, ...(skipped.length ? { skipped } : {}),
    });
    writeAtomically(stepsPath, record);
  } catch (error) {
    warning = `! step: #${issue} moved to ${to} but its record failed: ${error.message}; re-prime before deciding`;
  }
  return {
    ok: true,
    lines: [renderRibbon({ atMs: nowMs, issue, step: to, round, badge, model, fallback, note }),
      ...(skipped.length ? [`⚠️ #${issue} skipped ${skipped.join(', ')}`] : []),
      ...(warning ? [warning] : [])],
  };
}

const OUTCOMES = Object.freeze({
  shipped: '✅ #{n} SHIPPED',
  delivered: '⚠️ #{n} DELIVERED · awaits human merge',
  blocked: '❌ #{n} BLOCKED',
  human: '⚠️ #{n} NEEDS A HUMAN',
});
const BAR_CELLS = 15;

function minutes(ms) {
  const total = Math.round(Math.max(0, ms) / 60_000);
  if (total < 1) return '<1m';
  return total < 60 ? `${total}m` : `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

// Time per step from a unit's step history. Fix rounds fold into code
// review: they are how step 08 converges, not a step of their own.
function stepTimes(steps, nowMs) {
  const times = new Map();
  let rounds = 0;
  let round = null;
  steps.forEach((entry, index) => {
    const key = entry.step === '08-fix' ? '08-code-review' : entry.step;
    const end = steps[index + 1]?.startedAtMs ?? nowMs;
    times.set(key, (times.get(key) ?? 0) + Math.max(0, end - entry.startedAtMs));
    const match = /^(\d+)\/(\d+)$/u.exec(String(entry.round ?? ''));
    if (match && key === '08-code-review') {
      rounds = Math.max(rounds, Number(match[1]));
      round = `r${match[1]}/${match[2]}`;
    }
  });
  return { times, rounds, round };
}

// The time-only closing card, one per unit.
export function renderCard({ issue, title = '', outcome, steps, nowMs, pr = null, lines = null, question = '' }) {
  const head = (OUTCOMES[outcome] ?? `${outcome} #{n}`).replace('{n}', String(issue));
  const { times, rounds, round } = stepTimes(steps, nowMs);
  const longest = Math.max(1, ...times.values());
  const rows = [...times.entries()].map(([key, ms]) => {
    const [name, glyph] = STEPS[key] ?? [key, '·'];
    const cells = Math.max(1, Math.round((ms / longest) * BAR_CELLS));
    const suffix = key === '08-code-review' && round ? `  ${round}` : '';
    return `│  ${glyph} ${name.toLowerCase().padEnd(12)} ${minutes(ms).padStart(5)}  ${'▰'.repeat(cells)}${suffix}`;
  });
  const total = minutes(nowMs - (steps[0]?.startedAtMs ?? nowMs));
  const facts = [total,
    ...(Number.isFinite(lines) ? [`${lines} lines`] : []),
    ...(rounds > 0 ? [`${rounds} round${rounds === 1 ? '' : 's'}`] : []),
    ...(Number.isFinite(pr) ? [`PR #${pr}`] : [])];
  return [
    `╭─ ${head}${title ? ` · ${oneLine(title, 70)}` : ''}`,
    ...rows,
    ...(question ? [`│  ❓ ${oneLine(question, 140)}`] : []),
    `╰─ ${facts.join(' · ')}`,
  ].join('\n');
}

// The parked block: every wait with its model and age, then the queue.
export function renderParked({ nowMs, units, eligible, waiting = [], asOfMs = null }) {
  const rule = '┄'.repeat(12);
  const asOf = Number.isFinite(asOfMs) ? ` as of ${clock(asOfMs)}` : '';
  const queue = Number.isFinite(eligible) ? `queue ${eligible} eligible${asOf}` : 'queue unknown (re-prime)';
  const human = waiting.map((issue) => ` · #${issue} ⚠️ awaits /answer`).join('');
  return [
    `🅿️ ${rule} PARKED · ${clock(nowMs)} ${rule}`,
    ...units.map(({ issue, step, model, startedAtMs, staged }) => {
      const [name] = STEPS[step] ?? [step];
      // A staged step recorded without a model was announced, not launched:
      // "on ⚪ ENGINE" read as a running review for hours (LFE #388).
      const where = staged && !model ? 'staged, not dispatched' : `on ${modelChip(model, step)}`;
      return `├ #${issue} · ${step.slice(0, 2)} ${name.toLowerCase()} ${where} · ${minutes(nowMs - startedAtMs)}`;
    }),
    `└ ${queue}${human} · resumes on results`,
  ].join('\n');
}

const RUN_CARD_LIMIT = 1500;

// What a compacted orchestrator needs to resume without re-reading its state:
// facts with their times, never instructions.
export function renderRunCard({ nowMs, units, park, snapshot }) {
  const lines = [
    `## autoloop run state after compaction — facts as of ${clock(nowMs)}, re-prime before deciding`,
    ...(park?.until ? [`- parked until ${clock(Date.parse(park.until))}: ${oneLine(park.reason, 120)}`] : []),
    ...(snapshot ? [`- retained snapshot ${snapshot.path}, ${minutes(snapshot.ageMs)} old`] : []),
    ...units.map(({ issue, step, model, round, startedAtMs }) => {
      const [name] = STEPS[step] ?? [step];
      return `- #${issue} at ${step.slice(0, 2)} ${name.toLowerCase()}${round ? ` r${round}` : ''} on ${modelChip(model, step)} since ${clock(startedAtMs)}`;
    }),
    ...(units.length === 0 ? ['- no unit in flight'] : []),
  ];
  // The hook's budget is bytes; the ellipsis line costs four.
  let card = '';
  for (const line of lines) {
    const next = `${card}${card ? '\n' : ''}${line}`;
    if (Buffer.byteLength(next) > RUN_CARD_LIMIT - 4) return `${card}\n…`;
    card = next;
  }
  return card;
}

export function runCard({ root, run = realRun(root), nowMs = Date.now(), live = loopRunIsLive, markers = ownRunMarkers }) {
  if (!live(root)) return '';
  const { dir } = autoloopDir(root, run);
  if (dir === null) return '';
  const own = markers(root);
  const park = own.map(({ marker }) => marker.park).find((value) => value?.until) ?? null;
  const newest = retainedSnapshotPath(dir);
  const snapshot = newest ? { path: newest, ageMs: nowMs - statSync(newest).mtimeMs } : null;
  return renderRunCard({ nowMs, units: openUnits(dir, runStartMs(own)), park, snapshot });
}

function readJsonText(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

// step id → [name, glyph]. The glyph set is the dev skill's closed set.
export const STEPS = Object.freeze({
  '00-reconcile': ['RECONCILE', '🔁'],
  '01-premise': ['PREMISE', '🧭'],
  '02-plan': ['PLAN', '📐'],
  '03-plan-review': ['PLAN-REVIEW', '🔬'],
  '04-claim': ['CLAIM', '📌'],
  '05-implement': ['IMPLEMENT', '🔨'],
  '06-simplify': ['SIMPLIFY', '🧹'],
  '07-diff-review': ['DIFF-REVIEW', '👓'],
  '08-code-review': ['CODE-REVIEW', '🔍'],
  '08-fix': ['FIX', '🔧'],
  '09-gate': ['GATE', '🚦'],
  '10-publish': ['PUBLISH', '📦'],
  '11-record': ['RECORD', '📝'],
});

// Colour comes from colour emoji: raw ANSI does not survive the markdown
// renderer the orchestrator's messages go through. These dots carry no
// variation selector and are uniformly double-width, so the column holds.
const MODEL_DOTS = Object.freeze([
  [/fable/u, '🟣'],
  [/opus/u, '🟠'],
  [/sonnet/u, '🔵'],
  [/haiku/u, '🟡'],
  [/astra|gpt/u, '🟢'],
]);

export function shortModel(id) {
  const model = String(id ?? '').toLowerCase().replace(/^[a-z]+-gateway-/u, '').replace(/\[1m\]$/u, '');
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/u.exec(model);
  if (claude) return `${claude[1].toUpperCase()} ${claude[3] ? `${claude[2]}.${claude[3]}` : claude[2]}`;
  const gpt = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/u.exec(model);
  if (gpt) return `${gpt[2].toUpperCase()} ${gpt[1]}`;
  return model.toUpperCase();
}

// The steps whose work is a dispatch (the dev skill's role table). With no
// model known, such a step ran the engine's default, never the orchestrator.
const DISPATCHED = new Set([
  '02-plan', '03-plan-review', '05-implement', '06-simplify', '07-diff-review', '08-code-review', '08-fix',
]);

export function modelChip(id, step = null) {
  if (id === null || id === undefined || id === '') return DISPATCHED.has(step) ? '⚪ ENGINE' : '⚪ ORCHESTRATOR';
  const model = String(id).toLowerCase();
  const dot = MODEL_DOTS.find(([pattern]) => pattern.test(model))?.[1] ?? '⚪';
  return `${dot} ${shortModel(id)}`;
}

function clock(atMs) {
  const at = new Date(atMs);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

// The 🧊 frozen plan is named the same way on every line (operator ask,
// 2026-09-28). Ice cube, not snowflake: ❄️ carries a variation selector and
// would break the aligned columns.
function oneLine(text, limit = 90) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
    .replace(/(?<!🧊 )\b(frozen plan)\b/giu, '🧊 $1');
  const points = [...flat];
  return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : flat;
}

export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function progress(step, round) {
  const rounds = /^(\d+)\/(\d+)$/u.exec(String(round ?? ''));
  if (rounds && Number(rounds[1]) <= Number(rounds[2])) {
    const [done, cap] = [Number(rounds[1]), Number(rounds[2])];
    return `${'▰'.repeat(done)}${'▱'.repeat(cap - done)} r${done}/${cap}`;
  }
  const n = Number(step.slice(0, 2));
  return `${'▰'.repeat(n)}${'▱'.repeat(11 - n)} ${step.slice(0, 2)}/11`;
}

// One status line with fixed columns. Only plain-width segments are padded;
// every emoji sits alone in its own column, so the columns line up.
export function renderRibbon({ atMs, issue, step, round = null, badge = '⏳', model = null, fallback = false, note = '' }) {
  const unit = `#${issue}`.padEnd(4);
  try {
    const [name, glyph] = STEPS[step];
    const chip = modelChip(model, step);
    const [dot, ...modelName] = chip.split(' ');
    return `${clock(atMs)} ${unit} ${badge} ${glyph} ${name.padEnd(12)} ${progress(step, round).padEnd(17)}  `
      + `${dot} ${modelName.join(' ').padEnd(12)}${fallback ? '↪' : ' '} ${oneLine(note)}`.trimEnd();
  } catch {
    return `${clock(atMs)} ${unit} ${badge} ${step} ${oneLine(note)}`.trimEnd();
  }
}

export function renderResumed({ atMs, issue, what, ms = null }) {
  const took = Number.isFinite(ms) ? ` · ${duration(ms)}` : '';
  return `${clock(atMs)} ${`#${issue}`.padEnd(4)} ▶️ resumed — ${oneLine(what)}${took}`;
}

function selfTest() {
  const at = (hh, mm) => new Date(2026, 8, 28, hh, mm).getTime();
  const safely = (run) => {
    try {
      return run();
    } catch (error) {
      return `THREW ${error.message}`;
    }
  };
  const ribbon = (options) => safely(() => renderRibbon(options));
  const checks = [
    ['model ids read as short names', safely(() => [
      shortModel('claude-fable-5-1'), shortModel('claude-opus-5-5'), shortModel('gpt-6-astra'),
      shortModel('claude-haiku-4-5-20251001'), shortModel('anthropic-gateway-gpt-6-astra'),
      shortModel('mystery-model'), shortModel('claude-opus-5-5[1m]'), shortModel('anthropic-gateway-gpt-6-astra[1m]'),
    ].join('|')) === 'FABLE 5.1|OPUS 5.5|ASTRA 6|HAIKU 4.5|ASTRA 6|MYSTERY-MODEL|OPUS 5.5|ASTRA 6'],
    ['each model family has its colour dot; the orchestrator and unknowns are white', safely(() => [
      modelChip('claude-fable-5-1'), modelChip('claude-opus-5-5'), modelChip('gpt-6-astra'),
      modelChip('claude-sonnet-5'), modelChip(null), modelChip('mystery'),
    ].join('|')) === '🟣 FABLE 5.1|🟠 OPUS 5.5|🟢 ASTRA 6|🔵 SONNET 5|⚪ ORCHESTRATOR|⚪ MYSTERY'],
    // A dispatch with no pinned model runs the engine's default, not the
    // orchestrator; only the steps the orchestrator runs itself say so.
    ['a dispatched step with no known model is the engine, not the orchestrator', safely(() => [
      modelChip(null, '05-implement'), modelChip(null, '08-fix'), modelChip(null, '02-plan'),
      modelChip(null, '10-publish'), modelChip(null, '01-premise'),
      ribbon({ atMs: at(9, 40), issue: 350, step: '06-simplify' }).includes('⚪ ENGINE'),
    ].join('|')) === '⚪ ENGINE|⚪ ENGINE|⚪ ENGINE|⚪ ORCHESTRATOR|⚪ ORCHESTRATOR|true'],
    ['a step ribbon has fixed columns: time, unit, badge, step, bar, model, note',
      ribbon({ atMs: at(9, 40), issue: 350, step: '05-implement', model: 'claude-opus-5-5', note: '11 files planned' })
        === '09:40 #350 ⏳ 🔨 IMPLEMENT    ▰▰▰▰▰▱▱▱▱▱▱ 05/11  🟠 OPUS 5.5      11 files planned'],
    ['a review round replaces the counter with the round',
      ribbon({ atMs: at(10, 2), issue: 350, step: '08-code-review', round: '2/5', badge: '🚧', model: 'gpt-6-astra', note: '2 Major open' })
        === '10:02 #350 🚧 🔍 CODE-REVIEW  ▰▰▱▱▱ r2/5         🟢 ASTRA 6       2 Major open'],
    ['a fix round has its own glyph', ribbon({ atMs: at(10, 19), issue: 350, step: '08-fix', round: '2/5', badge: '🚧', model: 'claude-opus-5-5', note: 'x' })
      .startsWith('10:19 #350 🚧 🔧 FIX          ▰▰▱▱▱ r2/5         🟠 OPUS 5.5')],
    ['a fallback is marked beside the model',
      ribbon({ atMs: at(10, 31), issue: 356, step: '03-plan-review', model: 'claude-opus-5-5', fallback: true, note: 'FABLE timed out' })
        === '10:31 #356 ⏳ 🔬 PLAN-REVIEW  ▰▰▰▱▱▱▱▱▱▱▱ 03/11  🟠 OPUS 5.5    ↪ FABLE timed out'],
    ['an orchestrator step shows the orchestrator',
      ribbon({ atMs: at(9, 12), issue: 350, step: '01-premise', badge: '✅', note: 'ruling holds' })
        === '09:12 #350 ✅ 🧭 PREMISE      ▰▱▱▱▱▱▱▱▱▱▱ 01/11  ⚪ ORCHESTRATOR  ruling holds'],
    ['every step renders, and the model column starts at one place', safely(() => {
      const steps = ['00-reconcile', '01-premise', '02-plan', '03-plan-review', '04-claim',
        '05-implement', '06-simplify', '07-diff-review', '08-code-review', '09-gate', '10-publish', '11-record'];
      const starts = steps.map((step) => {
        const line = renderRibbon({ atMs: at(9, 0), issue: 7, step, model: 'gpt-6-astra' });
        return [...line].indexOf('🟢');
      });
      return starts.every((start) => start === starts[0] && start > 0);
    })],
    ['a note is one line, whitespace collapsed and bounded', (() => {
      const line = ribbon({ atMs: at(9, 0), issue: 7, step: '02-plan', model: 'gpt-6-astra', note: 'a\n\nb   c'.padEnd(300, 'x') });
      return !line.includes('\n') && line.includes('a b c') && line.length < 200;
    })()],
    ['the frozen plan wears its ice cube, once', [
      ribbon({ atMs: at(9, 0), issue: 7, step: '04-claim', note: 'Frozen plan posted' }),
      safely(() => renderResumed({ atMs: at(9, 0), issue: 7, what: 'implement read the 🧊 frozen plan' })),
    ].every((line) => /🧊 (?:F|f)rozen plan/u.test(line) && (line.match(/🧊/gu) ?? []).length === 1)],
    ['an unknown step still renders a plain line, never throws',
      ribbon({ atMs: at(9, 0), issue: 7, step: '99-invented' }).includes('99-invented')],
    ['a resumed line carries the duration from ms',
      safely(() => renderResumed({ atMs: at(14, 14), issue: 78, what: 'plan returned', ms: 401_000 }))
        === '14:14 #78  ▶️ resumed — plan returned · 6m 41s'],
  ];
  const parsed = (argv) => {
    try {
      return parseArgs(argv);
    } catch (error) {
      return { error: `THREW ${error.message}` };
    }
  };
  checks.push(
    ['a transition call parses', JSON.stringify(parsed(['--issue', '350', '--to', '08-code-review', '--round', '2/5',
      '--model', 'gpt-6-astra', '--badge', '🚧', '--note', '2 Major open', '--fallback']))
      === JSON.stringify({ mode: 'to', issue: 350, to: '08-code-review', round: '2/5', model: 'gpt-6-astra',
        badge: '🚧', note: '2 Major open', fallback: true, staged: false, what: null, ms: null, error: null })],
    ['card and parked calls parse', parsed(['--card', '--issue', '350', '--outcome', 'delivered', '--pr', '550']).mode === 'card'
      && parsed(['--parked']).mode === 'parked'
      // The view written to a file for the orchestrator to print once: a
      // printed view was shown twice, the tool's copy and the repeat.
      && JSON.stringify(parsed(['--parked', '--out', '/t/parked.txt'])) === JSON.stringify({ mode: 'parked', out: '/t/parked.txt', error: null })
      && parsed(['--parked', '--out']).error !== null
      && parsed(['--card', '--issue', '350', '--outcome', 'finished']).error !== null],
    ['a resumed call parses', parsed(['--issue', '78', '--resumed', 'plan returned', '--ms', '401000']).mode === 'resumed'],
    // LFE, 2026-09-29: a 0.55.3 setup ran all five phases and printed only
    // ribbons 1, 2 and 4 by hand. The call prints the skill's exact lines.
    ['each setup phase prints its ribbon, with a blocked or human badge when given', safely(() => [
      renderSetupPhase('resolve'), renderSetupPhase('audit'), renderSetupPhase('interview'),
      renderSetupPhase('write'), renderSetupPhase('verify'), renderSetupPhase('verify', '❌'),
    ].join('\n')) === [
      '⏳ ∞ ▰▱▱▱▱ 1/5 RESOLVE ─ version · mode · base',
      '⏳ ∞ ▰▰▱▱▱ 2/5 AUDIT ─ one-call battery',
      '⏳ ∞ ▰▰▰▱▱ 3/5 INTERVIEW ─ decisions only',
      '⏳ ∞ ▰▰▰▰▱ 4/5 WRITE ─ config · visible diff',
      '⏳ ∞ ▰▰▰▰▰ 5/5 VERIFY ─ evidence · delivery',
      '❌ ∞ ▰▰▰▰▰ 5/5 VERIFY ─ evidence · delivery',
    ].join('\n')],
    ['a setup call parses and refuses an unknown phase or badge',
      JSON.stringify(parsed(['--setup', 'verify'])) === JSON.stringify({ mode: 'setup', phase: 'verify', badge: '⏳', error: null })
        && parsed(['--setup', 'audit', '--badge', '⚠️']).badge === '⚠️'
        && parsed(['--setup', 'deploy']).error !== null
        && parsed(['--setup', 'audit', '--badge', '🎉']).error !== null
        && parsed(['--setup']).error !== null],
    ['bad calls are refused', ['--issue x --to 02-plan', '--to 02-plan', '--issue 7', '--issue 7 --to 02-plan --round 9',
      '--issue 7 --to 02-plan --colour red', '--issue 7 --resumed x --ms soon']
      .every((call) => parsed(call.split(' ')).error !== null)],
  );
  checks.push(...transitionChecks(at));
  const minute = 60_000;
  const start = at(9, 9);
  const history = [
    { step: '01-premise', startedAtMs: start },
    { step: '03-plan-review', model: 'claude-fable-5-1', startedAtMs: start + 1 * minute },
    { step: '05-implement', model: 'claude-opus-5-5', startedAtMs: start + 9 * minute },
    { step: '06-simplify', model: 'claude-fable-5-1', startedAtMs: start + 20 * minute },
    { step: '08-code-review', round: '1/5', model: 'gpt-6-astra', startedAtMs: start + 26 * minute },
    { step: '08-fix', round: '1/5', model: 'claude-opus-5-5', startedAtMs: start + 40 * minute },
    { step: '08-code-review', round: '2/5', model: 'gpt-6-astra', startedAtMs: start + 52 * minute },
    { step: '09-gate', startedAtMs: start + 68 * minute },
  ];
  const card = safely(() => renderCard({
    issue: 350, title: 'Axis B playback state machine', outcome: 'delivered', steps: history,
    nowMs: start + 77 * minute, pr: 550, lines: 393,
  }));
  checks.push(
    ['a closing card shows each step\'s time with bars scaled to the longest, rounds folded into review',
      card === [
        '╭─ ⚠️ #350 DELIVERED · awaits human merge · Axis B playback state machine',
        '│  🧭 premise         1m  ▰',
        '│  🔬 plan-review     8m  ▰▰▰',
        '│  🔨 implement      11m  ▰▰▰▰',
        '│  🧹 simplify        6m  ▰▰',
        '│  🔍 code-review    42m  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰  r2/5',
        '│  🚦 gate            9m  ▰▰▰',
        '╰─ 1h 17m · 393 lines · 2 rounds · PR #550',
      ].join('\n')],
    ['a blocked card ends on its question', (() => {
      const blocked = safely(() => renderCard({
        issue: 349, outcome: 'human', steps: history.slice(0, 1), nowMs: start + minute,
        question: 'May the stateless Axis A contract supersede the 1 Sept ruling?',
      }));
      return blocked.startsWith('╭─ ⚠️ #349 NEEDS A HUMAN')
        && blocked.includes('│  ❓ May the stateless Axis A contract supersede the 1 Sept ruling?')
        && blocked.endsWith('╰─ 1m');
    })()],
    ['a staged step recorded without a model reads as not dispatched', safely(() => renderParked({
      nowMs: at(10, 30), units: [{ issue: 388, step: '03-plan-review', model: null, staged: true, startedAtMs: at(10, 14) }], eligible: 5,
    }).includes('#388 · 03 plan-review staged, not dispatched · 16m'))],
    ['the parked block names every wait with its model and age, and the queue', safely(() => renderParked({
      nowMs: at(9, 53),
      units: [
        { issue: 350, step: '06-simplify', model: 'claude-fable-5-1', startedAtMs: at(9, 51) },
        { issue: 356, step: '03-plan-review', model: 'claude-fable-5-1', startedAtMs: at(9, 52) },
      ],
      eligible: 57,
      waiting: [349],
    })) === [
      '🅿️ ┄┄┄┄┄┄┄┄┄┄┄┄ PARKED · 09:53 ┄┄┄┄┄┄┄┄┄┄┄┄',
      '├ #350 · 06 simplify on 🟣 FABLE 5.1 · 2m',
      '├ #356 · 03 plan-review on 🟣 FABLE 5.1 · 1m',
      '└ queue 57 eligible · #349 ⚠️ awaits /answer · resumes on results',
    ].join('\n')],
    ['the post-compaction run card carries facts only, and says to re-prime', (() => {
      const card = safely(() => renderRunCard({
        nowMs: at(10, 20),
        units: [{ issue: 350, step: '10-publish', model: null, startedAtMs: at(10, 10) },
          { issue: 356, step: '03-plan-review', model: 'gpt-6-astra', round: null, startedAtMs: at(10, 1) }],
        park: { reason: 'plan revision in flight', until: new Date(at(10, 45)).toISOString() },
        snapshot: { path: '/r/.git/autoloop/prime/a.snapshot.json', ageMs: 12 * 60_000 },
      }));
      return card.startsWith('## autoloop run state after compaction — facts as of 10:20, re-prime before deciding')
        && card.includes('- #350 at 10 publish on ⚪ ORCHESTRATOR since 10:10')
        && card.includes('- #356 at 03 plan-review on 🟢 ASTRA 6 since 10:01')
        && card.includes('- parked until 10:45: plan revision in flight')
        && card.includes('- retained snapshot /r/.git/autoloop/prime/a.snapshot.json, 12m old');
    })()],
    // The hook's budget is bytes, and every model dot is four of them; the
    // park is the fact a resumed orchestrator needs first, so units give way.
    ['the run card is bounded in bytes and keeps the park when units overflow', (() => {
      const card = safely(() => renderRunCard({
        nowMs: at(10, 20),
        units: Array.from({ length: 80 }, (unused, index) => ({ issue: index + 1, step: '02-plan', model: 'claude-fable-5-1', startedAtMs: at(9, 0) })),
        park: { reason: 'operator message', until: new Date(at(22, 49)).toISOString() },
        snapshot: null,
      }));
      return Buffer.byteLength(card) <= 1500 && card.includes('- parked until 22:49: operator message');
    })()],
    ['a shortened line never splits an emoji', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(
      safely(() => renderResumed({ atMs: at(9, 0), issue: 1, what: `xx${'🟣'.repeat(100)}` })))],
    ['no live run, no card', safely(() => runCard({ root: '/nowhere', live: () => false })) === ''],
    ['a parked block with unknown queue evidence says so', safely(() => renderParked({
      nowMs: at(9, 53), units: [], eligible: null, waiting: [],
    })).endsWith('└ queue unknown (re-prime) · resumes on results')],
  );
  const failures = checks.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${checks.length} cases)`
    : `self-test FAILED (${failures.length}/${checks.length})`);
  return failures.length === 0;
}

// A fake repository state directory and gh, with the real command guard.
function transitionChecks(at) {
  const root = mkdtempSync(join(tmpdir(), 'step-'));
  const prime = join(root, '.git', 'autoloop', 'prime');
  mkdirSync(prime, { recursive: true });
  const sections = Object.fromEntries(SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]));
  writeFileSync(join(prime, 'a.snapshot.json'), JSON.stringify(createSnapshot({
    scannedAt: '2026-09-28T09:00:00.000Z', sections,
  })));
  let labels = ['loop-ready', 'loop-started', 'loop:05-implement'];
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'git') {
      return { ok: true, stdout: args.includes('--git-common-dir') ? join(root, '.git') : 'main', stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view') return { ok: true, stdout: JSON.stringify(labels), stderr: '' };
    if (args[0] === 'issue' && args[1] === 'edit') {
      const removed = args.flatMap((arg, index) => (args[index - 1] === '--remove-label' ? arg.split(',') : []));
      const added = args.flatMap((arg, index) => (args[index - 1] === '--add-label' ? arg.split(',') : []));
      labels = [...labels.filter((label) => !removed.includes(label)), ...added];
      return { ok: true, stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: `unexpected ${command}` };
  };
  const go = (options) => {
    try {
      return transition({ root, run, nowMs: at(9, 51), issue: 350, ...options });
    } catch (error) {
      return { ok: false, lines: [`THREW ${error.message}`] };
    }
  };
  const results = [];
  try {
    const plan = (() => {
      try {
        return [
          swapPlan(['loop-ready', 'loop:05-implement'], '06-simplify'),
          swapPlan(['loop-ready'], '01-premise'),
          swapPlan(['loop-ready', 'loop:08-code-review'], '08-fix'),
          swapPlan(['loop-ready', 'loop:09-gate'], '10-publish'),
          swapPlan(['loop-ready', 'loop:03-plan-review'], '05-implement'),
        ];
      } catch {
        return null;
      }
    })();
    results.push(['a swap names both halves; 01 also starts the unit; 08-fix, 10 and 11 move nothing',
      JSON.stringify(plan) === JSON.stringify([
        { remove: ['loop:05-implement'], add: ['loop:06-simplify'] },
        { remove: [], add: ['loop-started', 'loop:01-premise'] },
        null,
        null,
        { remove: ['loop:03-plan-review', 'loop:04-claim'], add: ['loop:05-implement'] },
      ])]);
    const skips = (() => {
      try {
        return [
          skippedSteps(['loop:03-plan-review'], '09-gate'),
          skippedSteps(['loop:07-diff-review'], '10-publish'),
          skippedSteps(['loop:09-gate'], '10-publish'),
          skippedSteps(['loop:08-code-review'], '08-fix'),
          skippedSteps(['loop-ready'], '05-implement'),
          skippedSteps(['loop:05-implement'], '06-simplify'),
        ];
      } catch {
        return null;
      }
    })();
    results.push(['the steps a transition jumps over are named; a first label or the next step skips nothing',
      JSON.stringify(skips) === JSON.stringify([
        ['04-claim', '05-implement', '06-simplify', '07-diff-review', '08-code-review'],
        ['08-code-review', '09-gate'],
        [], [], [], [],
      ])]);
    const first = go({ to: '06-simplify', model: 'claude-fable-5-1', note: '393 lines' });
    const snapshot = JSON.parse(readFileSync(join(prime, 'a.snapshot.json'), 'utf8'));
    const steps = (() => {
      try {
        return JSON.parse(readFileSync(join(root, '.git', 'autoloop', 'steps', '350.json'), 'utf8'));
      } catch {
        return null;
      }
    })();
    results.push(['a transition swaps the labels, invalidates the snapshot, records the step and prints the ribbon',
      first.ok === true
        && calls.some((call) => call === 'gh issue edit 350 --remove-label loop:05-implement --add-label loop:06-simplify')
        && labels.includes('loop:06-simplify') && !labels.includes('loop:05-implement')
        && snapshot.invalidation?.reasonCodes?.includes('ISSUE_MUTATION')
        && steps?.steps?.at(-1)?.step === '06-simplify' && steps.steps.at(-1).model === 'claude-fable-5-1'
        && first.lines.length === 1 && first.lines[0].startsWith('09:51 #350 ⏳ 🧹 SIMPLIFY')]);
    const edits = calls.filter((call) => call.startsWith('gh issue edit')).length;
    const again = go({ to: '06-simplify', model: 'claude-fable-5-1' });
    results.push(['the same step twice swaps nothing and says so',
      again.ok === true && again.lines.join('') === 'already on 06-simplify'
        && calls.filter((call) => call.startsWith('gh issue edit')).length === edits]);
    const backward = go({ to: '05-implement', model: 'claude-opus-5-5' });
    results.push(['a swap the guard refuses is printed and changes nothing',
      backward.ok === false && /step labels only climb/u.test(backward.lines.join(' '))
        && labels.includes('loop:06-simplify')]);
    const round = go({ to: '08-code-review', round: '1/5', model: 'gpt-6-astra' });
    const fix = go({ to: '08-fix', round: '1/5', model: 'claude-opus-5-5' });
    results.push(['review and fix rounds are separate announcements under one label',
      round.ok === true && fix.ok === true && fix.lines[0].includes('🔧 FIX') && labels.includes('loop:08-code-review')]);
    results.push(['a skipped step is printed under the ribbon and recorded',
      round.lines[1] === '⚠️ #350 skipped 07-diff-review'
        && readJson(join(root, '.git', 'autoloop', 'steps', '350.json'), { steps: [] })
          .steps.find((entry) => entry.step === '08-code-review')?.skipped?.join() === '07-diff-review'
        && fix.lines.length === 1]);
    const refused = transition.length === undefined ? null : go({ to: '09-gate', run: () => ({ ok: false, stdout: '', stderr: 'HTTP 502' }) });
    results.push(['a failed gh call is loud', refused.ok === false && refused.lines.join(' ').includes('HTTP 502')]);
    results.push(['an unknown step is refused before anything moves', go({ to: '12-ship' }).ok === false]);
    // A throw after the swap (a racing file, a full disk) must not hide that
    // the labels moved: the ribbon prints and the fault is a warning line.
    const faulted = (() => {
      mkdirSync(join(root, '.git', 'autoloop', 'steps', '361.json', 'blocker'), { recursive: true });
      const saved = labels;
      labels = ['loop-ready', 'loop-started', 'loop:05-implement'];
      const result = go({ issue: 361, to: '06-simplify', model: 'claude-fable-5-1' });
      const moved = labels.includes('loop:06-simplify');
      labels = saved;
      return { result, moved };
    })();
    results.push(['a bookkeeping fault after the swap is a warning, not a crash',
      faulted.result.ok === true && faulted.moved
        && faulted.result.lines[0].includes('🧹 SIMPLIFY')
        && faulted.result.lines.some((line) => line.startsWith('! step: #361 moved to 06-simplify but'))]);
    // A retry after that fault finds the labels already moved: nothing to
    // swap, but the snapshot is still stale and is invalidated again.
    const retried = (() => {
      writeFileSync(join(prime, 'a.snapshot.json'), JSON.stringify(createSnapshot({
        scannedAt: '2026-09-28T09:00:00.000Z', sections,
      })));
      const saved = labels;
      labels = ['loop-ready', 'loop-started', 'loop:07-diff-review'];
      go({ issue: 362, to: '07-diff-review', model: 'gpt-6-astra' });
      labels = saved;
      return JSON.parse(readFileSync(join(prime, 'a.snapshot.json'), 'utf8'));
    })();
    results.push(['a labelled step already in place still invalidates the snapshot',
      retried.invalidation?.reasonCodes?.includes('ISSUE_MUTATION') === true]);
    const editsBefore = calls.filter((call) => call.startsWith('gh issue edit')).length;
    const staged = go({ issue: 356, to: '02-plan', staged: true, model: 'gpt-6-astra' });
    results.push(['a staged unit is announced and recorded, never labelled',
      staged.ok === true && staged.lines[0].includes('📐 PLAN')
        && calls.filter((call) => call.startsWith('gh issue edit')).length === editsBefore
        && !calls.some((call) => call.startsWith('gh issue view 356'))]);
    const view = (() => {
      try {
        return parkedView({ root, run, nowMs: at(10, 30) });
      } catch (error) {
        return `THREW ${error.message}`;
      }
    })();
    results.push(['the parked view lists open units from the steps files',
      typeof view === 'string' && view.includes('├ #350 · 08 fix on 🟠 OPUS 5.5')
        && view.includes(`queue 0 eligible as of ${clock(Date.parse('2026-09-28T09:00:00.000Z'))}`)]);
    // An abandoned run's unit stays open in its steps file; only this run's
    // units are in flight. Markers from before the stamp filter nothing.
    const scoped = (() => {
      try {
        const since = (openedAtMs) => () => [{ marker: { version: 1, pids: [1], openedAtMs } }];
        return [
          parkedView({ root, run, nowMs: at(10, 30), markers: since(at(10, 0)) }),
          parkedView({ root, run, nowMs: at(10, 30), markers: () => [{ marker: { version: 1, pids: [1] } }] }),
          runCard({ root, run, nowMs: at(10, 30), live: () => true, markers: since(at(10, 0)) }),
        ];
      } catch (error) {
        return [`THREW ${error.message}`, '', ''];
      }
    })();
    results.push(['status views list only the units the current run touched',
      !scoped[0].includes('#350') && scoped[1].includes('#350')
        && !scoped[2].includes('#350') && scoped[2].includes('- no unit in flight')]);
    const closed = (() => {
      try {
        return closeUnit({ root, run, nowMs: at(10, 30), issue: 350, outcome: 'delivered', pr: 550 });
      } catch (error) {
        return { ok: false, lines: [`THREW ${error.message}`] };
      }
    })();
    const afterClose = (() => {
      try {
        return parkedView({ root, run, nowMs: at(10, 31) });
      } catch (error) {
        return `THREW ${error.message}`;
      }
    })();
    results.push(['closing a unit prints its card and drops it from the parked view',
      closed.ok === true && closed.lines[0].startsWith('╭─ ⚠️ #350 DELIVERED') && !afterClose.includes('#350')]);
    // Review of feat/status-first: a unit blocked at 01 and unblocked by a
    // human re-ran 01 as "already on", so loop-started never came back and
    // the unit was invisible to --parked and --card-run.
    const rerun = (() => {
      try {
        labels = ['loop-ready'];
        go({ issue: 360, to: '01-premise' });
        closeUnit({ root, run, nowMs: at(10, 40), issue: 360, outcome: 'blocked' });
        labels = ['loop-ready'];
        const again = go({ issue: 360, to: '01-premise' });
        return { again, labels: [...labels], record: readJson(join(root, '.git', 'autoloop', 'steps', '360.json'), null),
          parked: parkedView({ root, run, nowMs: at(10, 45) }) };
      } catch (error) {
        return { again: { ok: false, lines: [`THREW ${error.message}`] } };
      }
    })();
    results.push(['a unit that runs again after its card starts a fresh run',
      rerun.again.ok === true && rerun.again.lines[0].includes('#360')
        && rerun.labels.includes('loop-started') && rerun.labels.includes('loop:01-premise')
        && rerun.record?.closed === undefined && rerun.record?.steps?.length === 1
        && rerun.parked.includes('#360')]);
    // A unit blocked at its premise has no announced step, and still gets
    // its card (LFE run 2026-09-30).
    results.push(['a card for a unit with no steps renders (a premise block)',
      (() => {
        try {
          const card = closeUnit({ root, run, nowMs: at(10, 30), issue: 999, outcome: 'blocked', question: 'which spec?' });
          return card.ok === true && card.lines[0].includes('#999') && card.lines[0].includes('which spec?')
            // Any other outcome still needs recorded steps (a typo'd number is refused).
            && closeUnit({ root, run, nowMs: at(10, 30), issue: 998, outcome: 'shipped' }).ok === false;
        } catch {
          return false;
        }
      })()]);
    // A session that inherits an ended session's in-flight unit announces its
    // step again: a fresh entry this run, so the parked view shows it.
    results.push(['a step recorded before this run is announced afresh and parked',
      (() => {
        try {
          labels = ['loop-ready'];
          const runFrom = (openedAtMs) => () => [{ marker: { version: 1, pids: [1], openedAtMs } }];
          transition({ root, run, nowMs: at(9, 0), issue: 380, to: '05-implement', markers: runFrom(at(8, 0)) });
          const same = transition({ root, run, nowMs: at(9, 10), issue: 380, to: '05-implement', markers: runFrom(at(8, 0)) });
          const hidden = parkedView({ root, run, nowMs: at(11, 0), markers: runFrom(at(11, 0)) });
          const again = transition({ root, run, nowMs: at(11, 1), issue: 380, to: '05-implement', markers: runFrom(at(11, 0)) });
          const shown = parkedView({ root, run, nowMs: at(11, 2), markers: runFrom(at(11, 0)) });
          return same.lines[0] === 'already on 05-implement' && !hidden.includes('#380')
            && again.ok === true && again.lines[0] !== 'already on 05-implement' && shown.includes('#380');
        } catch {
          return false;
        }
      })()]);
    // The lifecycle driver closes a reconciled unit on the orchestrator's
    // behalf: only a record still open, never re-rendering a card shown.
    results.push(['ifOpen closes an open record once, and nothing else',
      (() => {
        try {
          labels = ['loop-ready'];
          go({ issue: 370, to: '00-reconcile' });
          const first = closeUnit({ root, run, nowMs: at(10, 50), issue: 370, outcome: 'shipped', pr: 577, ifOpen: true });
          const again = closeUnit({ root, run, nowMs: at(10, 51), issue: 370, outcome: 'shipped', pr: 577, ifOpen: true });
          const none = closeUnit({ root, run, nowMs: at(10, 51), issue: 371, outcome: 'shipped', ifOpen: true });
          return first.ok === true && first.lines[0].includes('#370 SHIPPED')
            && again.ok === false && again.lines.length === 0
            && none.ok === false && none.lines.length === 0
            && !parkedView({ root, run, nowMs: at(10, 52) }).includes('#370');
        } catch {
          return false;
        }
      })()]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return results;
}

// Setup's five phases, printed by a call as each begins (LFE, 2026-09-29: a
// setup that ran all five printed ribbons 1, 2 and 4 by hand).
export const SETUP_PHASES = Object.freeze([
  ['resolve', 'RESOLVE', 'version · mode · base'],
  ['audit', 'AUDIT', 'one-call battery'],
  ['interview', 'INTERVIEW', 'decisions only'],
  ['write', 'WRITE', 'config · visible diff'],
  ['verify', 'VERIFY', 'evidence · delivery'],
]);
const SETUP_BADGES = Object.freeze(['⏳', '❌', '⚠️']);

export function renderSetupPhase(phase, badge = '⏳') {
  const index = SETUP_PHASES.findIndex(([id]) => id === phase);
  if (index < 0 || !SETUP_BADGES.includes(badge)) return null;
  const [, name, detail] = SETUP_PHASES[index];
  const cells = `${'▰'.repeat(index + 1)}${'▱'.repeat(SETUP_PHASES.length - index - 1)}`;
  return `${badge} ∞ ${cells} ${index + 1}/${SETUP_PHASES.length} ${name} ─ ${detail}`;
}

const USAGE = 'usage: step.mjs --issue <N> --to <step> [--round <r>/<cap>] [--model <id>] [--fallback] [--staged] '
  + '[--badge <b>] [--note <text>]\n       step.mjs --issue <N> --resumed <what> [--ms <n>]\n'
  + '       step.mjs --setup <resolve|audit|interview|write|verify> [--badge ⏳|❌|⚠️]\n       step.mjs --self-test';

export function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--parked') return { mode: 'parked', error: null };
  if (argv[0] === '--parked' && argv[1] === '--out') {
    return argv.length === 3 && argv[2] !== ''
      ? { mode: 'parked', out: argv[2], error: null }
      : { mode: 'parked', out: null, error: '--parked --out needs one file path' };
  }
  if (argv.length === 1 && argv[0] === '--card-run') return { mode: 'card-run', error: null };
  if (argv[0] === '--setup') {
    const [, phase, flag, badge = '⏳'] = argv;
    const shapeOk = argv.length === 2 || (argv.length === 4 && flag === '--badge');
    return shapeOk && renderSetupPhase(phase, badge) !== null
      ? { mode: 'setup', phase, badge, error: null }
      : { mode: 'setup', phase, badge, error: 'expected --setup <resolve|audit|interview|write|verify> [--badge ⏳|❌|⚠️]' };
  }
  const out = {
    mode: null, issue: null, to: null, round: null, model: null, badge: '⏳', note: '',
    fallback: false, staged: false, what: null, ms: null, error: null,
  };
  const valued = { '--issue': 'issue', '--to': 'to', '--round': 'round', '--model': 'model', '--badge': 'badge',
    '--note': 'note', '--resumed': 'what', '--ms': 'ms', '--outcome': 'outcome', '--title': 'title',
    '--pr': 'pr', '--lines': 'lines', '--question': 'question' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--fallback') { out.fallback = true; continue; }
    if (flag === '--staged') { out.staged = true; continue; }
    if (flag === '--card') { out.card = true; continue; }
    if (valued[flag] === undefined) return { ...out, error: `unknown argument ${flag}` };
    const value = argv[index + 1];
    if (value === undefined) return { ...out, error: `${flag} needs a value` };
    out[valued[flag]] = value;
    index += 1;
  }
  out.issue = /^[1-9]\d{0,8}$/u.test(String(out.issue)) ? Number(out.issue) : null;
  if (out.issue === null) return { ...out, error: '--issue must be a positive issue number' };
  if (out.round !== null && !/^\d+\/\d+$/u.test(out.round)) return { ...out, error: '--round must look like 2/5' };
  if (out.ms !== null) {
    out.ms = Number(out.ms);
    if (!Number.isFinite(out.ms)) return { ...out, error: '--ms needs a number' };
  }
  for (const key of ['pr', 'lines']) {
    if (out[key] === undefined) continue;
    if (!/^\d{1,9}$/u.test(String(out[key]))) return { ...out, error: `--${key} needs a number` };
    out[key] = Number(out[key]);
  }
  if (out.card) {
    if (OUTCOMES[out.outcome] === undefined) {
      return { ...out, error: `--outcome must be one of ${Object.keys(OUTCOMES).join(', ')}` };
    }
    if (out.to !== null || out.what !== null) return { ...out, error: '--card takes no --to or --resumed' };
    const { card, ...rest } = out;
    return { ...rest, mode: 'card' };
  }
  if (out.to !== null && out.what === null) out.mode = 'to';
  else if (out.what !== null && out.to === null) out.mode = 'resumed';
  else return { ...out, error: 'give exactly one of --to or --resumed' };
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const parsed = parseArgs(args);
  if (parsed.error) {
    console.error(`step: ${parsed.error}\n${USAGE}`);
    process.exit(2);
  }
  if (parsed.mode === 'setup') {
    process.stdout.write(`${renderSetupPhase(parsed.phase, parsed.badge)}\n`);
    return;
  }
  // Outside a repository (a unit's /tmp scratch dir), the run's own
  // repository as the session latch records it (LFE run 2026-09-30).
  const root = realRun(process.cwd())('git', ['rev-parse', '--show-toplevel']).stdout
    || sessionLatch()?.latch?.scope
    || process.cwd();
  if (parsed.mode === 'card-run') {
    try {
      const card = runCard({ root });
      if (card) process.stdout.write(`${card}\n`);
    } catch {
      // A hook must never break the session it serves.
    }
    return;
  }
  if (parsed.mode === 'parked') {
    // With --out the view goes to the file only: the orchestrator reads it
    // and prints it once, instead of the tool's copy plus its repeat.
    const view = `${parkedView({ root })}\n`;
    if (parsed.out) {
      mkdirSync(dirname(resolve(parsed.out)), { recursive: true });
      writeFileSync(parsed.out, view);
    } else {
      process.stdout.write(view);
    }
    return;
  }
  if (parsed.mode === 'card') {
    const closed = closeUnit({ root, ...parsed });
    process.stdout.write(`${closed.lines.join('\n')}\n`);
    process.exit(closed.ok ? 0 : 1);
  }
  if (parsed.mode === 'resumed') {
    process.stdout.write(`${renderResumed({ atMs: Date.now(), issue: parsed.issue, what: parsed.what, ms: parsed.ms })}\n`);
    return;
  }
  const result = transition({ root, ...parsed });
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.ok ? 0 : 1);
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
