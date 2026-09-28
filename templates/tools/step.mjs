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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, loopRunIsLive, ownRunMarkers } from './command-guard.mjs';
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

// The retained prime snapshot is the newest one; a mutation marks it stale so
// no later decision reads a label state that has moved.
function invalidateRetainedSnapshot(gitDir) {
  const directory = join(gitDir, 'autoloop', 'prime');
  if (!existsSync(directory)) return null;
  const newest = readdirSync(directory)
    .filter((name) => name.endsWith('.snapshot.json'))
    .map((name) => join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  if (!newest) return null;
  const snapshot = readJson(newest, null);
  if (!verifySnapshot(snapshot)) return `! retained snapshot ${newest} is unreadable; re-prime before deciding`;
  writeAtomically(newest, invalidateSnapshot(snapshot, 'ISSUE_MUTATION'));
  return null;
}

function autoloopDir(root, run) {
  const common = run('git', ['rev-parse', '--git-common-dir']);
  return common.ok ? join(resolve(root, common.stdout), 'autoloop') : null;
}

function newestSnapshot(dir) {
  const directory = join(dir, 'prime');
  if (!existsSync(directory)) return null;
  const newest = readdirSync(directory)
    .filter((name) => name.endsWith('.snapshot.json'))
    .map((name) => join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  return newest ? readJson(newest, null) : null;
}

function openUnits(dir) {
  const directory = join(dir, 'steps');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^\d+\.json$/u.test(name))
    .map((name) => readJson(join(directory, name), null))
    .filter((record) => record && !record.closed && record.steps?.length
      && record.steps.at(-1).step !== '11-record')
    .map((record) => ({ issue: record.issue, ...record.steps.at(-1) }))
    .sort((left, right) => left.issue - right.issue);
}

export function parkedView({ root, run = realRun(root), nowMs = Date.now() }) {
  const dir = autoloopDir(root, run);
  if (dir === null) return renderParked({ nowMs, units: [], eligible: null });
  const snapshot = newestSnapshot(dir);
  const eligible = eligibleIssueNumbers(snapshot);
  const blocked = snapshot?.sections?.blockedIssues;
  const waiting = blocked?.complete === true ? blocked.items.map((issue) => issue.number).slice(0, 3) : [];
  return renderParked({ nowMs, units: openUnits(dir), eligible: eligible === null ? null : eligible.length, waiting });
}

export function closeUnit({ root, run = realRun(root), nowMs = Date.now(), issue, outcome, title = '', pr = null, lines = null, question = '' }) {
  const dir = autoloopDir(root, run);
  const path = dir === null ? null : join(dir, 'steps', `${issue}.json`);
  const record = path === null ? null : readJson(path, null);
  if (!record?.steps?.length) return { ok: false, lines: [`step: no steps recorded for #${issue}`] };
  const card = renderCard({ issue, title, outcome, steps: record.steps, nowMs, pr, lines, question });
  record.closed = { outcome, atMs: nowMs };
  writeAtomically(path, record);
  return { ok: true, lines: [card] };
}

export function transition({
  root, run = realRun(root), evaluateCommand = evaluate, nowMs = Date.now(),
  issue, to, round = null, model = null, fallback = false, badge = '⏳', note = '', staged = false,
}) {
  const refuse = (message) => ({ ok: false, lines: [message] });
  if (!Number.isSafeInteger(issue) || issue < 1) return refuse('step: --issue must be a positive issue number');
  if (STEPS[to] === undefined) return refuse(`step: unknown step ${to}; one of ${Object.keys(STEPS).join(', ')}`);
  const common = run('git', ['rev-parse', '--git-common-dir']);
  if (!common.ok) return refuse(`step: not inside a git repository: ${common.stderr}`);
  const gitDir = resolve(root, common.stdout);
  const stepsPath = join(gitDir, 'autoloop', 'steps', `${issue}.json`);
  const record = readJson(stepsPath, { issue, steps: [] });
  const last = record.steps.at(-1);
  if (last && last.step === to && (last.round ?? null) === (round ?? null)) {
    return { ok: true, lines: [`already on ${to}`] };
  }
  // A staged unit runs its read-only steps 1-3 unlabelled, so the worked
  // unit keeps the only label mutations; it is announced and recorded only.
  const labels = staged ? { ok: true, stdout: '[]' }
    : run('gh', ['issue', 'view', String(issue), '--json', 'labels', '--jq', '[.labels[].name]']);
  if (!labels.ok) return refuse(`step: could not read #${issue}'s labels: ${labels.stderr}`);
  const plan = staged ? null : swapPlan(readJsonText(labels.stdout), to);
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
  const warning = plan === null ? null : invalidateRetainedSnapshot(gitDir);
  record.steps.push({ step: to, round, model, fallback, staged, startedAtMs: nowMs });
  writeAtomically(stepsPath, record);
  return {
    ok: true,
    lines: [renderRibbon({ atMs: nowMs, issue, step: to, round, badge, model, fallback, note }),
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
export function renderParked({ nowMs, units, eligible, waiting = [] }) {
  const rule = '┄'.repeat(12);
  const queue = Number.isFinite(eligible) ? `queue ${eligible} eligible` : 'queue unknown (re-prime)';
  const human = waiting.map((issue) => ` · #${issue} ⚠️ awaits /answer`).join('');
  return [
    `🅿️ ${rule} PARKED · ${clock(nowMs)} ${rule}`,
    ...units.map(({ issue, step, model, startedAtMs }) => {
      const [name] = STEPS[step] ?? [step];
      return `├ #${issue} · ${step.slice(0, 2)} ${name.toLowerCase()} on ${modelChip(model)} · ${minutes(nowMs - startedAtMs)}`;
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
    ...units.map(({ issue, step, model, round, startedAtMs }) => {
      const [name] = STEPS[step] ?? [step];
      return `- #${issue} at ${step.slice(0, 2)} ${name.toLowerCase()}${round ? ` r${round}` : ''} on ${modelChip(model)} since ${clock(startedAtMs)}`;
    }),
    ...(units.length === 0 ? ['- no unit in flight'] : []),
    ...(park?.until ? [`- parked until ${clock(Date.parse(park.until))}: ${oneLine(park.reason, 120)}`] : []),
    ...(snapshot ? [`- retained snapshot ${snapshot.path}, ${minutes(snapshot.ageMs)} old`] : []),
  ];
  let card = '';
  for (const line of lines) {
    if (card.length + line.length + 1 > RUN_CARD_LIMIT - 2) return `${card}…`;
    card += `${card ? '\n' : ''}${line}`;
  }
  return card;
}

export function runCard({ root, run = realRun(root), nowMs = Date.now(), live = loopRunIsLive, markers = ownRunMarkers }) {
  if (!live(root)) return '';
  const dir = autoloopDir(root, run);
  if (dir === null) return '';
  const park = markers(root).map(({ marker }) => marker.park).find((value) => value?.until) ?? null;
  const directory = join(dir, 'prime');
  const newest = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith('.snapshot.json'))
      .map((name) => join(directory, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
    : undefined;
  const snapshot = newest ? { path: newest, ageMs: nowMs - statSync(newest).mtimeMs } : null;
  return renderRunCard({ nowMs, units: openUnits(dir), park, snapshot });
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
  const model = String(id ?? '').toLowerCase().replace(/^[a-z]+-gateway-/u, '');
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/u.exec(model);
  if (claude) return `${claude[1].toUpperCase()} ${claude[3] ? `${claude[2]}.${claude[3]}` : claude[2]}`;
  const gpt = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/u.exec(model);
  if (gpt) return `${gpt[2].toUpperCase()} ${gpt[1]}`;
  return model.toUpperCase();
}

export function modelChip(id) {
  if (id === null || id === undefined || id === '') return '⚪ ORCHESTRATOR';
  const model = String(id).toLowerCase();
  const dot = MODEL_DOTS.find(([pattern]) => pattern.test(model))?.[1] ?? '⚪';
  return `${dot} ${shortModel(id)}`;
}

function clock(atMs) {
  const at = new Date(atMs);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function oneLine(text, limit = 90) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
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
    const chip = modelChip(model);
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
      shortModel('mystery-model'),
    ].join('|')) === 'FABLE 5.1|OPUS 5.5|ASTRA 6|HAIKU 4.5|ASTRA 6|MYSTERY-MODEL'],
    ['each model family has its colour dot; the orchestrator and unknowns are white', safely(() => [
      modelChip('claude-fable-5-1'), modelChip('claude-opus-5-5'), modelChip('gpt-6-astra'),
      modelChip('claude-sonnet-5'), modelChip(null), modelChip('mystery'),
    ].join('|')) === '🟣 FABLE 5.1|🟠 OPUS 5.5|🟢 ASTRA 6|🔵 SONNET 5|⚪ ORCHESTRATOR|⚪ MYSTERY'],
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
      && parsed(['--card', '--issue', '350', '--outcome', 'finished']).error !== null],
    ['a resumed call parses', parsed(['--issue', '78', '--resumed', 'plan returned', '--ms', '401000']).mode === 'resumed'],
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
    ['the run card is bounded', safely(() => renderRunCard({
      nowMs: at(10, 20),
      units: Array.from({ length: 80 }, (unused, index) => ({ issue: index + 1, step: '02-plan', model: 'gpt-6-astra', startedAtMs: at(9, 0) })),
      park: null, snapshot: null,
    })).length <= 1500],
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
    const refused = transition.length === undefined ? null : go({ to: '09-gate', run: () => ({ ok: false, stdout: '', stderr: 'HTTP 502' }) });
    results.push(['a failed gh call is loud', refused.ok === false && refused.lines.join(' ').includes('HTTP 502')]);
    results.push(['an unknown step is refused before anything moves', go({ to: '12-ship' }).ok === false]);
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
        && view.includes('queue unknown (re-prime)')]);
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
    results.push(['a card for a unit with no steps is refused',
      (() => {
        try {
          return closeUnit({ root, run, nowMs: at(10, 30), issue: 999, outcome: 'shipped' }).ok === false;
        } catch {
          return false;
        }
      })()]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return results;
}

const USAGE = 'usage: step.mjs --issue <N> --to <step> [--round <r>/<cap>] [--model <id>] [--fallback] [--staged] '
  + '[--badge <b>] [--note <text>]\n       step.mjs --issue <N> --resumed <what> [--ms <n>]\n       step.mjs --self-test';

export function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--parked') return { mode: 'parked', error: null };
  if (argv.length === 1 && argv[0] === '--card-run') return { mode: 'card-run', error: null };
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
  const root = realRun(process.cwd())('git', ['rev-parse', '--show-toplevel']).stdout || process.cwd();
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
    process.stdout.write(`${parkedView({ root })}\n`);
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
