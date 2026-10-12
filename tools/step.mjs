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
  completeSection, createSnapshot, eligibleIssueNumbers, invalidateSnapshot, issueSnapshotItem, SNAPSHOT_SECTIONS,
  verifySnapshot,
} from './snapshot-contract.mjs';
import { realRun } from './unit.mjs';
import { parseGitHubRemote } from './checkout-contract.mjs';
import { mergeCaption, projectParked, stepAttempt } from './parked-disposition.mjs';
import { resolveProjectConfig } from './config-contract.mjs';
import { newAssociationId, readStepBinding, updateStepRecord, validReceipt } from './dispatch-return-association.mjs';

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

// The repository the checkout's one origin names, read locally; null when it
// cannot be proved, so no snapshot speaks for this checkout.
function originRepository(run) {
  const origin = run('git', ['config', '--get-all', 'remote.origin.url']);
  const values = origin.ok ? origin.stdout.split(/\r?\n/u).filter(Boolean) : [];
  const parsed = values.length === 1 ? parseGitHubRemote(values[0]) : null;
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

// Every open unit with what it waits for, from the steps files and the
// retained snapshot. Reads only: no GitHub call, no state change.
function projectedUnits(dir, run, nowMs, sinceMs) {
  const directory = join(dir, 'steps');
  const records = existsSync(directory) ? readdirSync(directory)
    .filter((name) => /^\d+\.json$/u.test(name))
    .map((name) => readJson(join(directory, name), null)) : [];
  const path = retainedSnapshotPath(dir);
  const snapshot = path === null ? null : readJson(path, null);
  return { snapshot, ...projectParked({ records, snapshot, repository: originRepository(run), nowMs, sinceMs }) };
}

export function parkedView({ root, run = realRun(root), nowMs = Date.now(), markers = ownRunMarkers }) {
  const { dir } = autoloopDir(root, run);
  if (dir === null) return renderParked({ nowMs, units: [], eligible: null });
  const { snapshot, units, humanWaits } = projectedUnits(dir, run, nowMs, runStartMs(markers(root)));
  // Every step swap marks the snapshot stale, so a parked view nearly always
  // reads one; the count recorded just before that swap is shown with its time.
  const eligible = eligibleIssueNumbers(snapshot);
  const last = eligible === null ? readJson(join(dir, QUEUE_COUNT), null) : null;
  return renderParked({
    nowMs, units, waiting: humanWaits,
    eligible: eligible !== null ? eligible.length : last?.eligible ?? null,
    asOfMs: eligible === null ? last?.scannedAtMs ?? null : null,
  });
}

// What each step dispatches when it is itself: a different role under it (a
// fix batch under a review step) is named on the parked line.
const STEP_ROLES = Object.freeze({
  '02-plan': 'plan', '03-plan-review': 'plan-review', '05-implement': 'implement', '06-simplify': 'simplify',
  '07-diff-review': 'diff-review', '08-code-review': 'code-review', '08-fix': 'fix',
});
const REVIEW_ROLES = new Set(['plan-review', 'diff-review', 'code-review', 'doubt-review']);

// A dispatch tells the unit's current step what is running, so the parked view
// shows it even when the orchestrator announced nothing new (LFE run
// 2026-09-30: "07 diff-review on ⚪ ENGINE" while Opus ran a fix; a closing
// review round under the same step read "returned"). It names the model and
// role, clears any return, and counts review rounds. A unit with no open
// record is left alone.
export function noteDispatch({ root, run = realRun(root), issue, model, role = null, binding, previousDispatchId }) {
  if (!Number.isSafeInteger(issue) || issue < 1 || (model !== null && (typeof model !== 'string' || model === ''))
    || typeof role !== 'string' || role === '') return { ok: false };
  const { dir } = autoloopDir(root, run);
  if (dir === null) return { ok: false };
  const path = join(dir, 'steps', `${issue}.json`);
  const original = binding === undefined ? readStepBinding(path, issue) : binding;
  if (original === null) return { ok: false };
  try {
    return updateStepRecord(path, (record) => {
      const last = record?.steps?.at(-1);
      const previous = previousDispatchId === undefined ? original.dispatchId : previousDispatchId;
      if (record?.issue !== issue || record.closed || !last
        || record.steps.length - 1 !== original.index || last.startedAtMs !== original.startedAtMs
        || (last.stepId ?? null) !== original.stepId || (last.dispatchId ?? null) !== previous) {
        return { ok: false, changed: false };
      }
      const stepId = last.stepId ?? newAssociationId();
      const dispatchId = newAssociationId();
      last.stepId = stepId;
      last.dispatchId = dispatchId;
      last.model = model;
      delete last.returnedAtMs;
      delete last.waiting;
      last.role = role;
      if (REVIEW_ROLES.has(role)) last.reviewRound = (last.reviewRound ?? 0) + 1;
      return { ok: true, changed: true, record,
        receipt: { issue, stepId, dispatchId, role } };
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function markReturned({ root, run = realRun(root), nowMs = Date.now(), issue, receipt }) {
  const { dir } = autoloopDir(root, run);
  if (dir === null || receipt?.issue !== issue) return { ok: false };
  const path = join(dir, 'steps', `${issue}.json`);
  return updateStepRecord(path, (record) => {
    const last = record?.steps?.at(-1);
    if (record?.issue !== issue || record.closed || !last
      || last.stepId !== receipt.stepId || last.dispatchId !== receipt.dispatchId
      || last.role !== receipt.role) return { ok: false, changed: false };
    const changed = !Number.isFinite(last.returnedAtMs);
    if (changed) last.returnedAtMs = nowMs;
    return { ok: true, changed, record, step: last };
  });
}

// The repository's validated merge.policy, or null when it cannot be read.
function mergePolicy(root) {
  try {
    const resolved = resolveProjectConfig(root);
    return resolved?.ok ? resolved.config.merge.policy : null;
  } catch {
    return null;
  }
}

// A delivered card records the pending merge and keeps the unit open; only a
// shipped, human or blocked card closes it (the lifecycle driver's verified
// merged close-out among them, with ifOpen, once).
export function closeUnit({ root, run = realRun(root), nowMs = Date.now(), issue, outcome, title = '', pr = null, question = '', reason = '', ifOpen = false }) {
  const { dir } = autoloopDir(root, run);
  if (dir === null) return { ok: false, lines: ifOpen ? [] : [`step: no steps recorded for #${issue} (not in a git repository)`] };
  const path = join(dir, 'steps', `${issue}.json`);
  const policy = outcome === 'delivered' ? mergePolicy(root) : null;
  try {
    return updateStepRecord(path, (stored) => {
      if (ifOpen && (!stored?.steps?.length || stored.closed)) return { ok: false, changed: false, lines: [] };
      if (!stored?.steps?.length && outcome !== 'blocked') {
        return { ok: false, changed: false, lines: [`step: no steps recorded for #${issue}`] };
      }
      if (outcome === 'delivered' && stored.closed && stored.closed.outcome !== 'delivered') {
        return { ok: false, changed: false, lines: [`step: #${issue} is closed as ${stored.closed.outcome}; a delivered card cannot reopen it`] };
      }
      const record = stored ?? { issue, steps: [] };
      const card = renderCard({ issue, title, outcome, steps: record.steps ?? [], nowMs, pr, question, policy, reason });
      if (outcome === 'delivered') {
        const since = record.pending?.pr === pr && Number.isFinite(record.pending.atMs) ? record.pending.atMs : nowMs;
        delete record.closed;
        record.pending = { outcome, pr, policy, reason: reason || null, atMs: since };
      } else {
        delete record.pending;
        record.closed = { outcome, atMs: nowMs };
      }
      return { ok: true, changed: true, record, lines: [card] };
    });
  } catch (error) {
    return { ok: false, lines: [`step: could not close #${issue}: ${error.message}`] };
  }
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
    const saved = updateStepRecord(stepsPath, (latest) => {
      const previous = latest?.steps?.at(-1);
      if (latest !== null && (latest.issue !== issue || !Array.isArray(latest.steps))) {
        throw new Error('invalid step record');
      }
      if ((latest?.steps?.length ?? 0) !== (stored?.steps?.length ?? 0)
        || Boolean(latest?.closed) !== Boolean(stored?.closed)
        || previous?.step !== stored?.steps?.at(-1)?.step
        || previous?.stepId !== stored?.steps?.at(-1)?.stepId
        || previous?.startedAtMs !== stored?.steps?.at(-1)?.startedAtMs) {
        return { ok: false, changed: false };
      }
      const current = latest === null || latest.closed ? { issue, steps: [] } : latest;
      current.steps.push({
        step: to, stepId: newAssociationId(), round, model, fallback, staged, startedAtMs: nowMs,
        ...(skipped.length ? { skipped } : {}),
      });
      return { ok: true, changed: true, record: current };
    });
    if (!saved.ok) warning = `! step: #${issue} moved to ${to} but newer step state was kept; re-prime before deciding`;
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
  delivered: '⚠️ #{n} DELIVERED · {merge}',
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
export function renderCard({ issue, title = '', outcome, steps, nowMs, pr = null, question = '', policy = null, reason = '' }) {
  const head = (OUTCOMES[outcome] ?? `${outcome} #{n}`).replace('{n}', String(issue)).replace('{merge}', mergeCaption(policy));
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
    ...(rounds > 0 ? [`${rounds} round${rounds === 1 ? '' : 's'}`] : []),
    ...(Number.isFinite(pr) ? [`PR #${pr}`] : [])];
  return [
    `╭─ ${head}${title ? ` · ${oneLine(title, 70)}` : ''}`,
    ...rows,
    ...(question ? [`│  ❓ ${oneLine(question, 140)}`] : []),
    ...(reason ? [`│  ⌛ ${oneLine(reason, 140)}`] : []),
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
    ...units.map((unit) => {
      const local = parkedLocal(unit, nowMs);
      const note = dispositionNote(unit, nowMs);
      return note ? `├ #${unit.issue} · ${note.join(' ')} · local ${local}` : `├ #${unit.issue} · ${local}`;
    }),
    `└ ${queue}${human} · resumes on results`,
  ].join('\n');
}

const DISPOSITION_GLYPHS = Object.freeze({ blocked: '❌', waiting: '⌛', repair: '🩹' });

// A human gate first, then a pending merge, then any other observation. A
// pending merge is the card's fact: never "merged" from checks or elapsed time.
function dispositionNote({ observed, pending }, nowMs) {
  if (observed && (observed.disposition === 'blocked' || !pending)) {
    return [DISPOSITION_GLYPHS[observed.disposition], observation(observed, nowMs)];
  }
  if (!pending) return null;
  const { pr, policy, reason, atMs, observedAtMs } = pending;
  return ['🔀', `${pr ? `PR #${pr} ` : ''}${mergeCaption(policy)}${reason ? ` (${oneLine(reason, 80)})` : ''}`
    + ` since ${stamp(atMs, nowMs)}${observedAtMs === null ? '' : ` · PR open per scan ${stamp(observedAtMs, nowMs)}`}`];
}

// A clock time, with its date when it is not today: a time from yesterday is
// dated history.
function stamp(atMs, nowMs) {
  if (!Number.isFinite(atMs)) return 'unknown';
  const [at, now] = [new Date(atMs), new Date(nowMs)];
  return at.toDateString() === now.toDateString() ? clock(atMs)
    : `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${clock(atMs)}`;
}

function observation({ disposition, labels, atMs, current }, nowMs) {
  const gates = disposition === 'blocked' ? ` (${labels.join(', ')})` : '';
  return `${disposition}${gates} ${current ? 'per scan' : 'as of scan'} ${stamp(atMs, nowMs)}${current ? '' : ', unconfirmed'}`;
}

// A mark, an earlier run's step or an undated one was seen, not confirmed
// running: it shows when it was last seen, never an elapsed running time.
function lastSeenNote({ local, lastSeenAtMs }, nowMs) {
  return local === 'current' || local === undefined ? null
    : `last seen ${stamp(lastSeenAtMs, nowMs)}${local === 'earlier-run' ? ' (earlier run)' : ''}`;
}

function parkedLocal(unit, nowMs) {
  const { step, model, startedAtMs, staged, returnedAtMs, round, attempt, role, reviewRound, waiting } = unit;
  const seen = lastSeenNote(unit, nowMs);
  // A unit waiting on another issue, a green base or a timer is not in
  // its step at all (unit.mjs --wait records it).
  if (waiting?.on) return `waits on ${waiting.on} · ${seen ?? minutes(nowMs - waiting.atMs)}`;
  const [name] = STEPS[step] ?? [step];
  // Which round: the announced one, else the review rounds dispatched under
  // the step, else how many times the step was entered (a plan's revisions
  // are versions) — the last only once there is more than one.
  const recorded = typeof round === 'string' ? Number(round.split('/')[0]) : null;
  const which = recorded !== null && Number.isSafeInteger(recorded)
    ? ` r${recorded}`
    : Number.isSafeInteger(reviewRound) ? ` r${reviewRound}`
      : attempt > 1 ? ` ${step === '02-plan' ? 'v' : 'r'}${attempt}` : '';
  // A different role running under the step (a fix batch under a review).
  const under = role && STEP_ROLES[step] && role !== STEP_ROLES[step] ? ` · ${role}` : '';
  const label = `${step.slice(0, 2)} ${name.toLowerCase()}${which}${under}`;
  if (seen) return `${label} · ${seen}`;
  // A step whose dispatch came back is not running: a staged unit waits
  // for the worked one to finish (LFE run 2026-09-30, "02 plan on ASTRA"
  // for a plan that had returned).
  if (Number.isFinite(returnedAtMs)) {
    return `${label} returned${staged ? ' · staged, waits its turn' : ''} · ${minutes(nowMs - returnedAtMs)}`;
  }
  // A staged step recorded without a model was announced, not launched:
  // "on ⚪ ENGINE" read as a running review for hours (LFE #388).
  const where = staged && !model ? 'staged, not dispatched' : `on ${modelChip(model, step)}`;
  return `${label} ${where} · ${minutes(nowMs - startedAtMs)}`;
}

const RUN_CARD_LIMIT = 1500;

// What a compacted orchestrator needs to resume without re-reading its state:
// facts with their times, never instructions.
export function renderRunCard({ nowMs, units, park, snapshot }) {
  const lines = [
    `## autoloop run state after compaction — facts as of ${clock(nowMs)}, re-prime before deciding`,
    ...(park?.until ? [`- parked until ${clock(Date.parse(park.until))}: ${oneLine(park.reason, 120)}`] : []),
    ...(snapshot ? [`- retained snapshot ${snapshot.path}, ${minutes(snapshot.ageMs)} old`] : []),
    ...units.map((unit) => {
      const { issue, step, model, round, startedAtMs } = unit;
      const [name] = STEPS[step] ?? [step];
      const seen = lastSeenNote(unit, nowMs);
      const local = `${step.slice(0, 2)} ${name.toLowerCase()}${round ? ` r${round}` : ''} `
        + `${seen ?? `on ${modelChip(model, step)} since ${clock(startedAtMs)}`}`;
      const note = dispositionNote(unit, nowMs);
      return note ? `- #${issue} ${note[1]}; local ${local}` : `- #${issue} at ${local}`;
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
  const { units } = projectedUnits(dir, run, nowMs, runStartMs(own));
  return renderRunCard({ nowMs, units, park, snapshot });
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
  [/astra|gpt|^(?:[a-z]+-gateway-)?sol(?:\[1m\])?$/u, '🟢'],
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
export function renderRibbon({ atMs, issue, step, round = null, badge = '⏳', model = null, fallback = false, note = '', span = null }) {
  const unit = `#${issue}`.padEnd(4);
  try {
    const [name, glyph] = STEPS[step];
    const chip = modelChip(model, step);
    const [dot, ...modelName] = chip.split(' ');
    return `${clock(atMs)} ${unit} ${badge} ${glyph} ${name.padEnd(12)} ${(span ?? progress(step, round)).padEnd(17)}  `
      + `${dot} ${modelName.join(' ').padEnd(12)}${fallback ? '↪' : ' '} ${oneLine(note)}`.trimEnd();
  } catch {
    return `${clock(atMs)} ${unit} ${badge} ${step} ${oneLine(note)}`.trimEnd();
  }
}

// A review's outcome, read from its dispatch result: the verdict, then each
// severity present. No glyph carries a variation selector, so columns hold.
const SEVERITY_GLYPHS = Object.freeze([
  ['Critical', '🚨'],
  ['Major', '🔺'],
  ['Minor', '🔸'],
  ['Suggestion', '💡'],
]);

function reviewOutcome(verdict) {
  const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
  const counts = SEVERITY_GLYPHS
    .map(([severity, glyph]) => [glyph, findings.filter((finding) => finding?.severity === severity).length, severity])
    .filter(([, count]) => count > 0)
    .map(([glyph, count, severity]) => `${glyph} ${count} ${severity}`);
  return [verdict.verdict === 'pass' ? '✅ PASS' : '❌ FAIL', ...(counts.length > 0 ? counts : ['✨ clean'])].join(' · ');
}

// The step's start ribbon, closed: same columns, the duration in place of the
// progress bar, the model that actually ran, and the outcome as the note.
export function renderFinished({ atMs, issue, step, role = null, model = null, ms = null, result = null, what = '' }) {
  const failed = result?.ok === false;
  const verb = failed ? 'failed' : 'done';
  const span = Number.isFinite(ms) ? `${verb} in ${duration(ms)}` : verb;
  const ran = result?.role ?? role;
  const outcome = failed
    ? result.error?.code ?? 'dispatch failed'
    : result?.verdict?.verdict ? reviewOutcome(result.verdict) : '';
  const offStep = ran && STEP_ROLES[step] && ran !== STEP_ROLES[step] ? ran : '';
  const note = [offStep, [outcome, oneLine(what)].filter(Boolean).join(' — ')].filter(Boolean).join(' · ');
  return renderRibbon({
    atMs, issue, step, badge: failed ? '💥' : '🔔', model: result?.model ?? result?.error?.model ?? model,
    fallback: Boolean(result?.fallback ?? result?.error?.fallback), note, span,
  });
}

export function resumedLine({ root, run = realRun(root), nowMs = Date.now(), issue, what, ms = null, resultPath = null }) {
  let result = null;
  let note = what;
  if (resultPath !== null) {
    try {
      result = JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch {
      note = `${what} (result unreadable)`.trim();
    }
  }
  const receipt = validReceipt(result, issue);
  let returned = { ok: false };
  if (receipt !== null) {
    try {
      returned = markReturned({ root, run, nowMs, issue, receipt });
    } catch (error) {
      note = `${note} (step record unavailable: ${error.message})`.trim();
    }
  }
  const elapsedMs = ms ?? (Number.isFinite(result?.ms) ? result.ms
    : Number.isFinite(result?.error?.ms) ? result.error.ms : null);
  const current = returned.ok ? returned.step : null;
  return current && STEPS[current.step]
    ? renderFinished({ atMs: nowMs, issue, step: current.step, role: receipt.role,
      model: current.model ?? null, ms: elapsedMs, result, what: note })
    : renderResumed({ atMs: nowMs, issue, what: note, ms: elapsedMs });
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
    ['family aliases display without invented versions and retain their badges', safely(() => [
      modelChip('opus'), modelChip('opus[1m]'), modelChip('fable'), modelChip('fable[1m]'),
      modelChip('astra'), modelChip('astra[1m]'), modelChip('sol'), modelChip('sol[1m]'),
      modelChip('sonnet[1m]'), modelChip('haiku[1m]'), modelChip('openai-gateway-sol[1m]'),
    ].join('|')) === '🟠 OPUS|🟠 OPUS|🟣 FABLE|🟣 FABLE|🟢 ASTRA|🟢 ASTRA|🟢 SOL|🟢 SOL|🔵 SONNET|🟡 HAIKU|🟢 SOL'],
    ['Sol recognition does not color unrelated custom names', safely(() => [
      modelChip('console'), modelChip('solar-custom'), modelChip('custom-sol'), modelChip('mystery[1m]'),
    ].join('|')) === '⚪ CONSOLE|⚪ SOLAR-CUSTOM|⚪ CUSTOM-SOL|⚪ MYSTERY'],
    // A dispatch with no pinned model runs the engine's default, not the
    // orchestrator; only the steps the orchestrator runs itself say so.
    ['a dispatched step with no known model is the engine, not the orchestrator', safely(() => [
      modelChip(null, '05-implement'), modelChip(null, '08-fix'), modelChip(null, '02-plan'),
      modelChip(null, '10-publish'), modelChip(null, '01-premise'),
      ribbon({ atMs: at(9, 40), issue: 350, step: '06-simplify' }).includes('⚪ ENGINE'),
    ].join('|')) === '⚪ ENGINE|⚪ ENGINE|⚪ ENGINE|⚪ ORCHESTRATOR|⚪ ORCHESTRATOR|true'],
    ['a step ribbon has fixed columns: time, unit, badge, step, bar, model, note',
      ribbon({ atMs: at(9, 40), issue: 350, step: '05-implement', model: 'claude-opus-5-5', note: 'tests first' })
        === '09:40 #350 ⏳ 🔨 IMPLEMENT    ▰▰▰▰▰▱▱▱▱▱▱ 05/11  🟠 OPUS 5.5      tests first'],
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
    // Operator ask, 2026-10-03: "#597 ▶️ resumed — full review returned: fail,
    // 3 Major, 1 Minor" said in prose what the dispatch result already holds.
    // The finished line mirrors the step's start ribbon, column for column,
    // and reads the verdict and severities from the result itself.
    ['a finished review mirrors its ribbon and reads the verdict from the result', safely(() => renderFinished({
      atMs: at(21, 52), issue: 597, step: '08-code-review', ms: 755_123,
      result: { ok: true, role: 'code-review', model: 'gpt-6-astra[1m]', ms: 755_123, fallback: null,
        verdict: { verdict: 'fail', findings: ['Major', 'Minor', 'Major', 'Major'].map((severity) => ({ severity })) } },
    })) === '21:52 #597 🔔 🔍 CODE-REVIEW  done in 12m 35s    🟢 ASTRA 6       ❌ FAIL · 🔺 3 Major · 🔸 1 Minor'],
    ['a clean pass says so, and every severity has its glyph', [
      safely(() => renderFinished({ atMs: at(9, 0), issue: 7, step: '03-plan-review', ms: 60_000,
        result: { ok: true, model: 'claude-fable-5-1', verdict: { verdict: 'pass', findings: [] } } })),
      safely(() => renderFinished({ atMs: at(9, 0), issue: 7, step: '07-diff-review', ms: 60_000,
        result: { ok: true, model: 'gpt-6-astra', verdict: { verdict: 'fail', findings:
          ['Suggestion', 'Critical', 'Minor', 'Major'].map((severity) => ({ severity })) } } })),
    ].every((line, index) => line.endsWith(index === 0
      ? '✅ PASS · ✨ clean'
      : '❌ FAIL · 🚨 1 Critical · 🔺 1 Major · 🔸 1 Minor · 💡 1 Suggestion'))],
    ['a writer finishes with its note, a failed dispatch with its code, a fallback with its arrow', [
      safely(() => renderFinished({ atMs: at(9, 0), issue: 7, step: '05-implement', ms: 2_509_000,
        result: { ok: true, model: 'claude-opus-5-5' }, what: 'commits recorded, verification pending' })),
      safely(() => renderFinished({ atMs: at(9, 0), issue: 7, step: '05-implement', ms: 180_000,
        result: { ok: false, model: 'claude-opus-5-5', error: { code: 'ENGINE_EXIT_NONZERO' } } })),
      safely(() => renderFinished({ atMs: at(9, 0), issue: 7, step: '08-code-review', ms: 60_000,
        result: { ok: true, model: 'claude-sonnet-5', fallback: { from: 'gpt-6-astra' },
          verdict: { verdict: 'pass', findings: [{ severity: 'Minor' }] } } })),
    ].join('\n') === [
      '09:00 #7   🔔 🔨 IMPLEMENT    done in 41m 49s    🟠 OPUS 5.5      commits recorded, verification pending',
      '09:00 #7   💥 🔨 IMPLEMENT    failed in 3m 0s    🟠 OPUS 5.5      ENGINE_EXIT_NONZERO',
      '09:00 #7   🔔 🔍 CODE-REVIEW  done in 1m 0s      🔵 SONNET 5    ↪ ✅ PASS · 🔸 1 Minor',
    ].join('\n')],
    ['a role off its step is named, and no result falls back to the step record', [
      safely(() => renderFinished({ atMs: at(9, 0), issue: 7, step: '08-fix', role: 'plan', model: 'gpt-6-astra',
        ms: 576_012, what: 'proof re-derivation returned' })),
    ].join('\n') === '09:00 #7   🔔 🔧 FIX          done in 9m 36s     🟢 ASTRA 6       plan · proof re-derivation returned'],
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
      && parsed(['--card', '--issue', '350', '--outcome', 'finished']).error !== null
      && parsed(['--card', '--issue', '350', '--outcome', 'delivered', '--reason', 'checks pending']).reason === 'checks pending'],
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
      '--issue 7 --to 02-plan --colour red', '--issue 7 --resumed x --ms soon',
      '--card --issue 7 --outcome shipped --lines 393']
      .every((call) => parsed(call.split(' ')).error !== null)],
  );
  checks.push(...transitionChecks(at));
  checks.push(...dispositionChecks());
  checks.push(...pendingMergeChecks());
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
    nowMs: start + 77 * minute, pr: 550, lines: 393, policy: 'manual',
  }));
  checks.push(
    // LFE #506: a card names time, rounds and PR, never a changed-line total, even when a caller passes one.
    ['a closing card shows each step\'s time with bars scaled to the longest, rounds folded into review',
      card === [
        '╭─ ⚠️ #350 DELIVERED · awaits human merge · Axis B playback state machine',
        '│  🧭 premise         1m  ▰',
        '│  🔬 plan-review     8m  ▰▰▰',
        '│  🔨 implement      11m  ▰▰▰▰',
        '│  🧹 simplify        6m  ▰▰',
        '│  🔍 code-review    42m  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰  r2/5',
        '│  🚦 gate            9m  ▰▰▰',
        '╰─ 1h 17m · 2 rounds · PR #550',
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
    // Operator, 2026-09-30: the parked view shows which round a step is on.
    ['a step shows its round: the recorded one, else how many times it was entered',
      renderParked({
        nowMs: at(10, 30), eligible: 5, units: [
          { issue: 398, step: '08-code-review', model: 'gpt-6-astra', round: '2/20', startedAtMs: at(10, 29) },
          { issue: 427, step: '02-plan', model: 'gpt-6-astra', staged: true, attempt: 2, startedAtMs: at(10, 20) },
          { issue: 430, step: '07-diff-review', model: 'gpt-6-astra', attempt: 1, startedAtMs: at(10, 25) },
        ],
      }).split('\n').slice(1, 4).join('|') === '├ #398 · 08 code-review r2 on 🟢 ASTRA 6 · 1m|'
        + '├ #427 · 02 plan v2 on 🟢 ASTRA 6 · 10m|├ #430 · 07 diff-review on 🟢 ASTRA 6 · 5m'
      && stepAttempt([{ step: '02-plan' }, { step: '03-plan-review' }, { step: '02-plan' }, { step: '02-plan' }]) === 2
      && stepAttempt([{ step: '07-diff-review' }]) === 1],
    // LFE run 2026-09-30: a staged plan that had come back read "02 plan on
    // 🟢 ASTRA 6 · 7m" with nothing running; a returned step says so.
    ['a returned step reads as returned, staged or worked, aged from its return',
      renderParked({
        nowMs: at(10, 30), eligible: 5, units: [
          { issue: 427, step: '02-plan', model: 'gpt-6-astra', staged: true, startedAtMs: at(10, 0), returnedAtMs: at(10, 23) },
          { issue: 398, step: '06-simplify', model: 'claude-fable-5-1', startedAtMs: at(10, 10), returnedAtMs: at(10, 28) },
        ],
      }).includes('├ #427 · 02 plan returned · staged, waits its turn · 7m')
      && renderParked({
        nowMs: at(10, 30), eligible: 5, units: [
          { issue: 398, step: '06-simplify', model: 'claude-fable-5-1', startedAtMs: at(10, 10), returnedAtMs: at(10, 28) },
        ],
      }).includes('├ #398 · 06 simplify returned · 2m')],
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
    const first = go({ to: '06-simplify', model: 'claude-fable-5-1', note: 'clarity pass' });
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
      typeof view === 'string' && view.includes('├ #350 · 08 fix r1 on 🟠 OPUS 5.5')
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
    results.push(['units an earlier run left open stay visible as last seen, never as running',
      scoped[0].includes('├ #350 · 08 fix r1 · last seen 09:51 (earlier run)') && !scoped[0].includes('#350 · 08 fix r1 on')
        && scoped[1].includes('├ #350 · 08 fix r1 on 🟠 OPUS 5.5')
        && scoped[2].includes('- #350 at 08 fix r1/5 last seen 09:51 (earlier run)')
        && !scoped[2].includes('#350 at 08 fix r1/5 on')]);
    const closed = (() => {
      try {
        return closeUnit({ root, run, nowMs: at(10, 30), issue: 350, outcome: 'shipped', pr: 550 });
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
      closed.ok === true && closed.lines[0].startsWith('╭─ ✅ #350 SHIPPED') && !afterClose.includes('#350')]);
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
    results.push(['a step recorded before this run reads as last seen until it is announced afresh',
      (() => {
        try {
          labels = ['loop-ready'];
          const runFrom = (openedAtMs) => () => [{ marker: { version: 1, pids: [1], openedAtMs } }];
          transition({ root, run, nowMs: at(9, 0), issue: 380, to: '05-implement', markers: runFrom(at(8, 0)) });
          const same = transition({ root, run, nowMs: at(9, 10), issue: 380, to: '05-implement', markers: runFrom(at(8, 0)) });
          const hidden = parkedView({ root, run, nowMs: at(11, 0), markers: runFrom(at(11, 0)) });
          const again = transition({ root, run, nowMs: at(11, 1), issue: 380, to: '05-implement', markers: runFrom(at(11, 0)) });
          const shown = parkedView({ root, run, nowMs: at(11, 2), markers: runFrom(at(11, 0)) });
          return same.lines[0] === 'already on 05-implement'
            && hidden.includes('├ #380 · 05 implement · last seen 09:00 (earlier run)')
            && again.ok === true && again.lines[0] !== 'already on 05-implement'
            && shown.includes('├ #380 · 05 implement on ⚪ ENGINE · 1m');
        } catch {
          return false;
        }
      })()]);
    // LFE run 2026-09-30: a fix announced without --model read "07 diff-review
    // on ⚪ ENGINE" while Opus ran it; the dispatch names its own model.
    results.push(['a dispatch names its model on the unit\'s current step',
      (() => {
        try {
          labels = ['loop-ready'];
          transition({ root, run, nowMs: at(12, 0), issue: 391, to: '07-diff-review', markers: () => [] });
          const noted = noteDispatch({ root, run, issue: 391, model: 'claude-opus-5-5[1m]', role: 'fix' });
          const view = parkedView({ root, run, nowMs: at(12, 3), markers: () => [] });
          const line = view.split('\n').find((text) => text.includes('#391')) ?? '';
          return noted.ok === true && line.includes('07 diff-review · fix on 🟠 OPUS 5.5') && !line.includes('ENGINE')
            && noteDispatch({ root, run, issue: 9998, model: 'x', role: 'fix' }).ok === false;
        } catch {
          return false;
        }
      })()]);
    // LFE run 2026-09-30, 17:32: diff-review r3 ran under the same announced
    // step and the view still read "returned"; fix batches ran under it too.
    // Each dispatch clears the return, counts review rounds, names its role.
    results.push(['a dispatch clears the return, counts review rounds, and names a fix under a review step',
      (() => {
        try {
          labels = ['loop-ready'];
          transition({ root, run, nowMs: at(13, 0), issue: 392, to: '07-diff-review', markers: () => [] });
          const launched = noteDispatch({ root, run, issue: 392, model: 'gpt-6-astra[1m]', role: 'diff-review' });
          markReturned({ root, run, nowMs: at(13, 5), issue: 392, receipt: launched.receipt });
          noteDispatch({ root, run, issue: 392, model: 'claude-opus-5-5[1m]', role: 'fix' });
          const fixing = parkedView({ root, run, nowMs: at(13, 6), markers: () => [] }).split('\n').find((l) => l.includes('#392'));
          noteDispatch({ root, run, issue: 392, model: 'gpt-6-astra[1m]', role: 'diff-review' });
          const reviewing = parkedView({ root, run, nowMs: at(13, 7), markers: () => [] }).split('\n').find((l) => l.includes('#392'));
          return fixing === '├ #392 · 07 diff-review r1 · fix on 🟠 OPUS 5.5 · 6m'
            && reviewing === '├ #392 · 07 diff-review r2 on 🟢 ASTRA 6 · 7m';
        } catch (error) {
          return false;
        }
      })()]);
    // A waiting unit reads as waiting, aged from the wait; a dispatch clears it.
    results.push(['a waiting unit reads "waits on", and a dispatch clears it',
      (() => {
        const line = renderParked({
          nowMs: at(10, 58), eligible: 1,
          units: [{ issue: 427, step: '07-diff-review', model: 'gpt-6-astra', reviewRound: 3, returnedAtMs: at(9, 0), waiting: { on: '#587', atMs: at(10, 0) }, startedAtMs: at(9, 0) }],
        }).split('\n')[1];
        try {
          labels = ['loop-ready'];
          transition({ root, run, nowMs: at(14, 0), issue: 393, to: '05-implement', markers: () => [] });
          const path = join(root, '.git', 'autoloop', 'steps', '393.json');
          const record = readJson(path, null);
          record.steps.at(-1).waiting = { on: '#1', atMs: at(14, 1) };
          writeFileSync(path, JSON.stringify(record));
          noteDispatch({ root, run, issue: 393, model: 'claude-opus-5-5[1m]', role: 'implement' });
          return line === '├ #427 · waits on #587 · 58m' && readJson(path, null).steps.at(-1).waiting === undefined;
        } catch {
          return false;
        }
      })()]);
    results.push(['a bound return marks its step; a new step does not inherit it',
      (() => {
        try {
          labels = ['loop-ready'];
          transition({ root, run, nowMs: at(11, 0), issue: 390, to: '02-plan', staged: true, model: 'gpt-6-astra', markers: () => [] });
          const launched = noteDispatch({ root, run, issue: 390, model: 'gpt-6-astra', role: 'plan' });
          const path = join(root, '.git', 'autoloop', 'steps', '390.json');
          const before = readFileSync(path, 'utf8');
          const plain = resumedLine({ root, run, nowMs: at(11, 4), issue: 390, what: 'unbound plan returned' });
          const unchanged = readFileSync(path, 'utf8') === before;
          markReturned({ root, run, nowMs: at(11, 5), issue: 390, receipt: launched.receipt });
          const returned = parkedView({ root, run, nowMs: at(11, 9), markers: () => [] });
          transition({ root, run, nowMs: at(11, 10), issue: 390, to: '03-plan-review', staged: true, model: 'claude-fable-5-1', markers: () => [] });
          const next = parkedView({ root, run, nowMs: at(11, 11), markers: () => [] });
          return plain.includes('▶️ resumed') && unchanged
            && returned.includes('#390 · 02 plan returned · staged, waits its turn · 4m')
            && next.includes('#390 · 03 plan-review on') && !next.includes('returned')
            && markReturned({ root, run, nowMs: at(11, 12), issue: 9999, receipt: launched.receipt }).ok === false;
        } catch {
          return false;
        }
      })()]);
    // The finished line names the step from the record and the outcome from
    // the dispatch result; with no record it keeps the plain resumed line.
    results.push(['--resumed with --result renders the finished line from record and result',
      (() => {
        try {
          labels = ['loop-ready'];
          transition({ root, run, nowMs: at(12, 0), issue: 391, to: '08-code-review', round: '1/20', model: 'gpt-6-astra', markers: () => [] });
          const launched = noteDispatch({ root, run, issue: 391, role: 'code-review', model: 'gpt-6-astra[1m]' });
          const resultPath = join(root, 'review-result.json');
          writeFileSync(resultPath, JSON.stringify({ ok: true, role: 'code-review', model: 'gpt-6-astra[1m]', ms: 755_123,
            receipt: launched.receipt,
            verdict: { verdict: 'fail', findings: [{ severity: 'Major' }, { severity: 'Minor' }] } }));
          const finished = resumedLine({ root, run, nowMs: at(12, 13), issue: 391, what: '', resultPath });
          const path = join(root, '.git', 'autoloop', 'steps', '391.json');
          const beforeUnreadable = readFileSync(path, 'utf8');
          const unreadable = resumedLine({ root, run, nowMs: at(12, 14), issue: 391, what: 'review returned', resultPath: join(root, 'missing.json') });
          const plain = resumedLine({ root, run, nowMs: at(12, 15), issue: 9998, what: 'plan returned', ms: 60_000 });
          return finished === '12:13 #391 🔔 🔍 CODE-REVIEW  done in 12m 35s    🟢 ASTRA 6       ❌ FAIL · 🔺 1 Major · 🔸 1 Minor'
            && unreadable.includes('▶️ resumed') && unreadable.endsWith('review returned (result unreadable)')
            && readFileSync(path, 'utf8') === beforeUnreadable
            && plain === '12:15 #9998 ▶️ resumed — plan returned · 1m 0s';
        } catch (error) {
          return false;
        }
      })()]);
    results.push(['a late review cannot mark a later gate returned', (() => {
      labels = ['loop-ready'];
      go({ issue: 401, to: '08-code-review' });
      const launched = noteDispatch({ root, run, issue: 401, role: 'code-review', model: 'gpt-6-astra' });
      const resultPath = join(root, 'late-review.json');
      writeFileSync(resultPath, JSON.stringify({ ok: true, role: 'code-review', model: 'gpt-6-astra',
        ms: 90_000, receipt: launched.receipt, verdict: { verdict: 'pass', findings: [] } }));
      go({ issue: 401, to: '09-gate' });
      const path = join(root, '.git', 'autoloop', 'steps', '401.json');
      const before = readFileSync(path, 'utf8');
      const line = resumedLine({ root, run, issue: 401, what: 'review returned', resultPath });
      return launched.receipt?.stepId && readFileSync(path, 'utf8') === before
        && line.includes('▶️ resumed') && !line.includes('GATE');
    })()]);
    results.push(['same-role attempts reject old results, and duplicates keep the first return time', (() => {
      labels = ['loop-ready'];
      go({ issue: 402, to: '07-diff-review' });
      const first = noteDispatch({ root, run, issue: 402, role: 'diff-review', model: 'gpt-6-astra' });
      const second = noteDispatch({ root, run, issue: 402, role: 'diff-review', model: 'claude-sonnet-5' });
      const path = join(root, '.git', 'autoloop', 'steps', '402.json');
      const firstPath = join(root, 'first-review.json');
      const secondPath = join(root, 'second-review.json');
      writeFileSync(firstPath, JSON.stringify({ ok: true, role: 'diff-review', model: 'gpt-6-astra',
        receipt: first.receipt, verdict: { verdict: 'pass', findings: [] } }));
      writeFileSync(secondPath, JSON.stringify({ ok: true, role: 'diff-review', model: 'claude-sonnet-5',
        receipt: second.receipt, verdict: { verdict: 'pass', findings: [] } }));
      const before = readFileSync(path, 'utf8');
      const stale = resumedLine({ root, run, issue: 402, what: 'old', resultPath: firstPath, nowMs: at(14, 1) });
      const unchanged = readFileSync(path, 'utf8') === before;
      const matched = resumedLine({ root, run, issue: 402, what: 'new', resultPath: secondPath, nowMs: at(14, 2) });
      const duplicate = resumedLine({ root, run, issue: 402, what: 'new again', resultPath: secondPath, nowMs: at(14, 3) });
      const last = readJson(path, null).steps.at(-1);
      return first.receipt?.dispatchId !== second.receipt?.dispatchId && unchanged
        && stale.includes('▶️ resumed') && matched.includes('🔔 👓 DIFF-REVIEW')
        && duplicate.includes('🔔 👓 DIFF-REVIEW') && last.returnedAtMs === at(14, 2)
        && last.reviewRound === 2 && last.model === 'claude-sonnet-5';
    })()]);
    results.push(['wrong, missing, malformed and legacy results leave the open record unchanged', (() => {
      labels = ['loop-ready'];
      go({ issue: 403, to: '08-fix' });
      const launched = noteDispatch({ root, run, issue: 403, role: 'fix', model: 'claude-opus-5-5' });
      const path = join(root, '.git', 'autoloop', 'steps', '403.json');
      const resultPath = join(root, 'bad-result.json');
      const before = readFileSync(path, 'utf8');
      const examples = [
        { ok: true, role: 'fix', receipt: { ...launched.receipt, issue: 404 } },
        { ok: true, role: 'plan', receipt: launched.receipt },
        { ok: true, role: 'fix', receipt: { ...launched.receipt, dispatchId: 'old' } },
        { ok: true, role: 'fix' },
        { ok: true, role: 'fix', receipt: null },
        { role: 'fix', receipt: launched.receipt },
      ];
      return examples.every((value) => {
        writeFileSync(resultPath, JSON.stringify(value));
        const line = resumedLine({ root, run, issue: 403, what: 'fix returned', resultPath });
        return line.includes('▶️ resumed') && readFileSync(path, 'utf8') === before;
      }) && resumedLine({ root, run, issue: 403, what: 'no result' }).includes('▶️ resumed')
        && readFileSync(path, 'utf8') === before;
    })()]);
    results.push(['a closed unit and a new generation reject a prior result', (() => {
      labels = ['loop-ready'];
      go({ issue: 404, to: '02-plan' });
      const launched = noteDispatch({ root, run, issue: 404, role: 'plan', model: 'gpt-6-astra' });
      const resultPath = join(root, 'prior-generation.json');
      writeFileSync(resultPath, JSON.stringify({ ok: true, role: 'plan', model: 'gpt-6-astra', receipt: launched.receipt }));
      closeUnit({ root, run, issue: 404, outcome: 'blocked' });
      const path = join(root, '.git', 'autoloop', 'steps', '404.json');
      const beforeClosed = readFileSync(path, 'utf8');
      const closedLine = resumedLine({ root, run, issue: 404, what: 'plan returned', resultPath });
      labels = ['loop-ready'];
      go({ issue: 404, to: '02-plan' });
      const beforeNew = readFileSync(path, 'utf8');
      const newLine = resumedLine({ root, run, issue: 404, what: 'plan returned', resultPath });
      return launched.receipt?.stepId && beforeClosed !== beforeNew
        && closedLine.includes('▶️ resumed') && newLine.includes('▶️ resumed')
        && readFileSync(path, 'utf8') === beforeNew;
    })()]);
    results.push(['a retry cannot replace a newer independent launch on the same step', (() => {
      labels = ['loop-ready'];
      go({ issue: 405, to: '08-code-review' });
      const path = join(root, '.git', 'autoloop', 'steps', '405.json');
      const original = readStepBinding(path, 405);
      const first = noteDispatch({ root, run, issue: 405, role: 'code-review', model: 'gpt-6-astra',
        binding: original, previousDispatchId: original.dispatchId });
      const independent = noteDispatch({ root, run, issue: 405, role: 'code-review', model: 'claude-sonnet-5' });
      const before = readFileSync(path, 'utf8');
      const retried = noteDispatch({ root, run, issue: 405, role: 'code-review', model: 'gpt-6-astra',
        binding: { ...original, stepId: first.receipt.stepId }, previousDispatchId: first.receipt.dispatchId });
      return first.receipt?.stepId === independent.receipt?.stepId
        && independent.receipt?.dispatchId !== first.receipt?.dispatchId && retried.ok === false
        && readFileSync(path, 'utf8') === before;
    })()]);
    results.push(['a collector blocked by a writer keeps the result plain and changes no bytes', (() => {
      labels = ['loop-ready'];
      go({ issue: 406, to: '02-plan' });
      const launched = noteDispatch({ root, run, issue: 406, role: 'plan', model: 'gpt-6-astra' });
      const path = join(root, '.git', 'autoloop', 'steps', '406.json');
      const resultPath = join(root, 'locked-result.json');
      writeFileSync(resultPath, JSON.stringify({ ok: true, role: 'plan', receipt: launched.receipt }));
      const before = readFileSync(path, 'utf8');
      mkdirSync(`${path}.lock`);
      let line;
      try { line = resumedLine({ root, run, issue: 406, what: 'plan returned', resultPath }); }
      finally { rmSync(`${path}.lock`, { recursive: true, force: true }); }
      return line.includes('▶️ resumed') && line.includes('step record unavailable')
        && readFileSync(path, 'utf8') === before;
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

// LFE, 2026-10-12: open units read "00 reconcile" for 26h while their labels
// said loop-waiting, loop-blocked or loop-repair. Status reads project the
// retained snapshot over the local record and never call GitHub.
function dispositionChecks() {
  const day = (d, hh, mm) => new Date(2026, 9, d, hh, mm).getTime();
  const nowMs = day(12, 10, 30);
  const scanMs = day(12, 10, 20);
  const root = mkdtempSync(join(tmpdir(), 'step-disposition-'));
  const autoloop = join(root, '.git', 'autoloop');
  const snapshotPath = join(autoloop, 'prime', `${'a'.repeat(40)}.snapshot.json`);
  const issue = (number, labels) => issueSnapshotItem({
    number, title: `Issue ${number}`, body: '', updatedAt: '2026-10-11T08:00:00Z', labels: labels.map((name) => ({ name })),
  });
  const snapshotOf = (issues, scannedAtMs = scanMs, openPrs = []) => {
    const sections = Object.fromEntries(SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]));
    sections.repo = completeSection([{ owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets', defaultBranch: 'main' }]);
    sections.openPrs = completeSection(openPrs.map(([issueNumber, number]) => ({
      number, title: 'loop unit', body: `Closes #${issueNumber}`, isDraft: false, reviewDecision: 'APPROVED',
      headRefName: `feat/gh-${issueNumber}-loop-unit`, headRefOid: 'b'.repeat(40), baseRefName: 'main',
      mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', mergedAt: null, updatedAt: '2026-10-12T08:00:00Z',
      author: 'actor', headRepository: 'acme/widgets', statusCheckState: 'SUCCESS', statusCheckRollup: [],
      issue: issueNumber, orphanCandidate: false, ownership: 'loop',
    })));
    sections.tree = completeSection([{ dirtyEntries: [], dirtyPaths: 0, branch: 'main', headOid: 'a'.repeat(40) }]);
    sections.openIssues = completeSection(issues);
    sections.blockedIssues = completeSection(issues.filter((item) => item.labels.includes('loop-blocked')));
    return createSnapshot({ scannedAt: new Date(scannedAtMs).toISOString(), sections });
  };
  const issues = [
    issue(501, ['human:decide', 'loop-blocked']), issue(502, ['loop-waiting']), issue(503, ['loop-repair']),
    issue(504, ['loop-started']), issue(520, ['loop-blocked']), issue(510, ['loop-blocked']),
  ];
  const records = [
    ...[501, 502, 503, 504].map((number) => ({ issue: number, steps: [{ step: '00-reconcile', startedAtMs: day(11, 8, 0) }] })),
    { issue: 520, steps: [{ step: '05-implement', stepId: 's', dispatchId: 'd', model: 'claude-opus-5-5', role: 'implement',
      startedAtMs: day(12, 10, 25) }] },
    { issue: 530, steps: [{ step: '08-fix', round: '1/5', model: 'claude-opus-5-5', startedAtMs: day(10, 9, 51) }] },
    { issue: 531, steps: [{ step: '09-gate', startedAtMs: day(12, 9, 0) }, { step: '11-record', startedAtMs: day(12, 9, 40) }] },
  ];
  let origin = 'git@github.com:acme/widgets.git';
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'git' && args.includes('--git-common-dir')) return { ok: true, stdout: join(root, '.git'), stderr: '' };
    if (command === 'git' && args.join(' ') === 'config --get-all remote.origin.url') return { ok: true, stdout: origin, stderr: '' };
    return { ok: false, stdout: '', stderr: `unexpected ${command}` };
  };
  const markers = () => [{ marker: { version: 1, pids: [1], openedAtMs: day(11, 7, 0) } }];
  const write = (snapshot, extra = []) => {
    rmSync(join(autoloop, 'steps'), { recursive: true, force: true });
    mkdirSync(join(autoloop, 'steps'), { recursive: true });
    mkdirSync(dirname(snapshotPath), { recursive: true });
    for (const record of [...records, ...extra]) {
      writeFileSync(join(autoloop, 'steps', `${record.issue}.json`), JSON.stringify(record));
    }
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
  };
  const files = () => [...readdirSync(join(autoloop, 'steps')).sort().map((name) => readFileSync(join(autoloop, 'steps', name), 'utf8')),
    readFileSync(snapshotPath, 'utf8'), String(existsSync(join(autoloop, QUEUE_COUNT)))].join('\n');
  const views = () => {
    try {
      return { parked: parkedView({ root, run, nowMs, markers }), card: runCard({ root, run, nowMs, live: () => true, markers }) };
    } catch (error) {
      return { parked: `THREW ${error.message}`, card: `THREW ${error.message}` };
    }
  };
  const results = [];
  try {
    write(snapshotOf(issues));
    const before = files();
    const current = views();
    const unchanged = files() === before && calls.every((call) => !call.startsWith('gh'));
    results.push(['the parked view shows a current blocked, waiting or repair observation instead of an old reconcile mark',
      [
        '├ #501 · ❌ blocked (human:decide, loop-blocked) per scan 10:20 · local 00 reconcile · last seen 10-11 08:00',
        '├ #502 · ⌛ waiting per scan 10:20 · local 00 reconcile · last seen 10-11 08:00',
        '├ #503 · 🩹 repair per scan 10:20 · local 00 reconcile · last seen 10-11 08:00',
        '├ #504 · 00 reconcile · last seen 10-11 08:00',
      ].every((line) => current.parked.split('\n').includes(line)) && !/26h|on ⚪ ORCHESTRATOR/u.test(current.parked)]);
    results.push(['newer local work keeps its active attempt over an older snapshot',
      current.parked.split('\n').includes('├ #520 · 05 implement on 🟠 OPUS 5.5 · 5m')
        && current.card.includes('- #520 at 05 implement on 🟠 OPUS 5.5 since 10:25')]);
    results.push(['earlier-run and record-step units stay visible, each once, and a shown unit is no extra human wait',
      current.parked.split('\n').includes('├ #530 · 08 fix r1 · last seen 10-10 09:51 (earlier run)')
        && current.parked.split('\n').includes('├ #531 · 11 record · last seen 09:40')
        && current.parked.endsWith('└ queue 0 eligible · #510 ⚠️ awaits /answer · resumes on results')
        && [501, 502, 503, 504, 520, 530, 531].every((number) => current.parked.split(`#${number} `).length === 2
          && current.card.split(`#${number} `).length === 2)]);
    results.push(['the run card carries the same dispositions from the same projection',
      current.card.includes('- #501 blocked (human:decide, loop-blocked) per scan 10:20; local 00 reconcile last seen 10-11 08:00')
        && current.card.includes('- #502 waiting per scan 10:20; local 00 reconcile last seen 10-11 08:00')
        && current.card.includes('- #530 at 08 fix r1/5 last seen 10-10 09:51 (earlier run)')
        && current.card.includes('- #531 at 11 record last seen 09:40')]);
    results.push(['status rendering makes no GitHub call and changes no file', unchanged]);
    write(invalidateSnapshot(snapshotOf(issues), 'ISSUE_MUTATION'));
    const history = views();
    results.push(['an invalidated snapshot is shown as dated history, never as current',
      history.parked.split('\n').includes(
        '├ #501 · ❌ blocked (human:decide, loop-blocked) as of scan 10:20, unconfirmed · local 00 reconcile · last seen 10-11 08:00')
        && !history.parked.includes('per scan') && !history.parked.includes('awaits /answer')
        && history.card.includes('- #501 blocked (human:decide, loop-blocked) as of scan 10:20, unconfirmed; local')]);
    const unqualified = (view) => view.parked.split('\n').includes('├ #501 · 00 reconcile · last seen 10-11 08:00')
      && !view.parked.includes('blocked (') && !view.card.includes('blocked (') && !view.parked.includes('awaits /answer');
    origin = 'https://github.com/other/widgets.git';
    write(snapshotOf(issues));
    const foreign = views();
    origin = 'git@github.com:acme/widgets.git';
    write(snapshotOf(issues, nowMs + 60_000));
    const future = views();
    const tampered = JSON.parse(JSON.stringify(snapshotOf(issues)));
    tampered.sections.openIssues.items[0].labels = ['loop-started'];
    write(tampered);
    const invalid = views();
    results.push(['a foreign, future-dated or unverifiable snapshot leaves the local state qualified',
      unqualified(foreign) && unqualified(future) && unqualified(invalid)]);
    write(snapshotOf(issues), Array.from({ length: 80 }, (unused, index) => ({
      issue: 600 + index, steps: [{ step: '00-reconcile', startedAtMs: day(11, 8, 0) }],
    })));
    const crowded = (() => {
      try {
        return runCard({ root, run, nowMs, live: () => true,
          markers: () => [{ marker: { version: 1, pids: [1], openedAtMs: day(11, 7, 0),
            park: { reason: 'operator message', until: new Date(day(12, 22, 49)).toISOString() } } }] });
      } catch (error) {
        return `THREW ${error.message}`;
      }
    })();
    results.push(['the projected run card stays within its byte bound and keeps the park',
      Buffer.byteLength(crowded) <= 1500 && crowded.includes('- parked until 22:49: operator message')
        && crowded.includes('- #501 blocked (') && crowded.endsWith('\n…')]);
    const legacyDelivered = [640, 641].map((number) => ({ issue: number,
      steps: [{ step: '09-gate', startedAtMs: day(12, 9, 0) }], closed: { outcome: 'delivered', atMs: day(12, 9, 30) } }));
    write(snapshotOf(issues, scanMs, [[640, 740]]), legacyDelivered);
    const legacyBefore = files();
    calls.length = 0;
    const observedOpen = views();
    const observedUnchanged = files() === legacyBefore && calls.every((call) => !call.startsWith('gh'));
    write(snapshotOf(issues), legacyDelivered);
    const unobserved = views();
    results.push(['a legacy delivered record stays readable and unchanged, pending only while its open PR is observed',
      observedOpen.parked.split('\n').includes(
        '├ #640 · 🔀 PR #740 merge disposition pending since 09:30 · PR open per scan 10:20 · local 09 gate · last seen 09:30')
        && observedOpen.card.includes('- #640 PR #740 merge disposition pending since 09:30 · PR open per scan 10:20; local 09 gate')
        && !observedOpen.parked.includes('#641') && observedUnchanged
        && !unobserved.parked.includes('#640') && !unobserved.parked.startsWith('THREW')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return results;
}

// LFE, 2026-10-12: an automatically merged repository's delivered unit left
// the parked view at its card while its merge was still pending, and the card
// told a human to merge it.
function pendingMergeChecks() {
  const day = (hh, mm) => new Date(2026, 9, 12, hh, mm).getTime();
  const base = mkdtempSync(join(tmpdir(), 'step-pending-'));
  const stepsDir = join(base, '.git', 'autoloop', 'steps');
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'git' && args.includes('--git-common-dir')) return { ok: true, stdout: join(base, '.git'), stderr: '' };
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') return { ok: true, stdout: '["loop-delivered"]', stderr: '' };
    return { ok: false, stdout: '', stderr: `unexpected ${command}` };
  };
  // Each policy's checkout: its own .autoloop/config.json, read by the real resolver.
  const checkout = (name, policy) => {
    const dir = join(base, name);
    mkdirSync(join(dir, '.autoloop'), { recursive: true });
    if (policy !== null) {
      writeFileSync(join(dir, '.autoloop', 'config.json'), JSON.stringify({
        version: '0.28.0', baseBranch: 'main', gate: { command: 'npm test' }, merge: { policy },
      }));
    }
    return dir;
  };
  const seed = (issue) => writeFileSync(join(stepsDir, `${issue}.json`),
    JSON.stringify({ issue, steps: [{ step: '09-gate', startedAtMs: day(9, 0) }] }));
  const record = (issue) => readJson(join(stepsDir, `${issue}.json`), null);
  const head = (result) => result?.lines?.[0]?.split('\n')[0] ?? '';
  const markers = () => [];
  const results = [];
  try {
    mkdirSync(stepsDir, { recursive: true });
    const checkouts = { manual: checkout('manual', 'manual'), auto: checkout('auto', 'auto'),
      ratified: checkout('ratified', 'ratified'), missing: checkout('missing', null), invalid: checkout('invalid', 'sometimes') };
    const captions = Object.entries(checkouts).map(([name, root], index) => {
      seed(650 + index);
      return head(closeUnit({ root, run, nowMs: day(9, 30), issue: 650 + index, outcome: 'delivered', pr: 750 + index }));
    });
    results.push(['a delivered card names the merge policy, human merge only under manual, neutral when unknown',
      JSON.stringify(captions) === JSON.stringify([
        '╭─ ⚠️ #650 DELIVERED · awaits human merge', '╭─ ⚠️ #651 DELIVERED · automatic merge pending',
        '╭─ ⚠️ #652 DELIVERED · ratified merge decision pending', '╭─ ⚠️ #653 DELIVERED · merge disposition pending',
        '╭─ ⚠️ #654 DELIVERED · merge disposition pending'])]);
    seed(660);
    const card = closeUnit({ root: checkouts.auto, run, nowMs: day(9, 30), issue: 660, outcome: 'delivered', pr: 760,
      reason: 'required checks pending' });
    transition({ root: checkouts.auto, run, nowMs: day(9, 31), issue: 660, to: '11-record', markers });
    const repeated = closeUnit({ root: checkouts.auto, run, nowMs: day(9, 32), issue: 660, outcome: 'delivered', pr: 760,
      reason: 'required checks pending' });
    const stored = record(660);
    const before = readFileSync(join(stepsDir, '660.json'), 'utf8');
    calls.length = 0;
    const parked = parkedView({ root: base, run, nowMs: day(10, 0), markers });
    const runState = runCard({ root: base, run, nowMs: day(10, 0), live: () => true, markers });
    const line = '├ #660 · 🔀 PR #760 automatic merge pending (required checks pending) since 09:30 · local 11 record · last seen 09:31';
    results.push(['a delivered automatic merge stays pending through 11-record, a repeated card and the run card',
      card.ok === true && card.lines[0].includes('│  ⌛ required checks pending') && head(repeated) === head(card)
        && stored?.closed === undefined
        && JSON.stringify(stored?.pending) === JSON.stringify({ outcome: 'delivered', pr: 760, policy: 'auto',
          reason: 'required checks pending', atMs: day(9, 30) })
        && parked.split('\n').includes(line) && parked.split('#660 ').length === 2
        && runState.includes('- #660 PR #760 automatic merge pending (required checks pending) since 09:30; local 11 record last seen 09:31')
        && runState.split('#660 ').length === 2 && !parked.includes('#650 · 🔀 PR #750 automatic')
        && parked.includes('├ #650 · 🔀 PR #750 awaits human merge since 09:30')]);
    results.push(['rendering a pending merge makes no GitHub call, never merges and changes no record',
      calls.every((call) => !call.startsWith('gh')) && readFileSync(join(stepsDir, '660.json'), 'utf8') === before
        && !/merged|SHIPPED/u.test(parked) && !/merged|SHIPPED/u.test(runState)]);
    const gated = renderParked({ nowMs: day(10, 0), eligible: 0, units: [{ issue: 670, step: '11-record', local: 'mark',
      lastSeenAtMs: day(9, 31), startedAtMs: day(9, 31),
      observed: { disposition: 'blocked', labels: ['human:decide'], atMs: day(9, 50), current: true },
      pending: { pr: 770, policy: 'auto', reason: null, atMs: day(9, 30), observedAtMs: null } }] }).split('\n')[1];
    results.push(['a human gate outranks a pending merge on the parked line',
      gated === '├ #670 · ❌ blocked (human:decide) per scan 09:50 · local 11 record · last seen 09:31']);
    const shipped = closeUnit({ root: checkouts.auto, run, nowMs: day(10, 5), issue: 660, outcome: 'shipped', pr: 760, ifOpen: true });
    const shippedAgain = closeUnit({ root: checkouts.auto, run, nowMs: day(10, 6), issue: 660, outcome: 'shipped', pr: 760, ifOpen: true });
    results.push(['a later verified shipped close-out supersedes the pending delivery exactly once',
      shipped.ok === true && head(shipped) === '╭─ ✅ #660 SHIPPED' && shippedAgain.ok === false && shippedAgain.lines.length === 0
        && record(660)?.closed?.outcome === 'shipped' && record(660)?.pending === undefined
        && !parkedView({ root: base, run, nowMs: day(10, 7), markers }).includes('#660')]);
    for (const issue of [661, 662]) {
      seed(issue);
      closeUnit({ root: checkouts.auto, run, nowMs: day(9, 40), issue, outcome: 'delivered', pr: issue + 100 });
    }
    const human = closeUnit({ root: checkouts.auto, run, nowMs: day(10, 10), issue: 661, outcome: 'human', question: 'reopened' });
    const blocked = closeUnit({ root: checkouts.auto, run, nowMs: day(10, 10), issue: 662, outcome: 'blocked' });
    const shippedRecord = readFileSync(join(stepsDir, '660.json'), 'utf8');
    const reopen = closeUnit({ root: checkouts.auto, run, nowMs: day(10, 11), issue: 660, outcome: 'delivered', pr: 760 });
    const after = parkedView({ root: base, run, nowMs: day(10, 12), markers });
    results.push(['a human or blocked card supersedes a pending delivery, and a delivered card cannot reopen a finished unit',
      human.ok === true && blocked.ok === true
        && record(661)?.closed?.outcome === 'human' && record(661)?.pending === undefined
        && record(662)?.closed?.outcome === 'blocked' && record(662)?.pending === undefined
        && !after.includes('#661') && !after.includes('#662') && !after.includes('#660')
        && reopen.ok === false && readFileSync(join(stepsDir, '660.json'), 'utf8') === shippedRecord]);
  } catch (error) {
    results.push([`pending merge checks ran (${error.message})`, false]);
  } finally {
    rmSync(base, { recursive: true, force: true });
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
  + '[--badge <b>] [--note <text>]\n       step.mjs --issue <N> --resumed <what> [--result <dispatch-result.json>] [--ms <n>]\n'
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
    '--pr': 'pr', '--question': 'question', '--reason': 'reason', '--result': 'result' };
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
  if (out.pr !== undefined) {
    if (!/^\d{1,9}$/u.test(String(out.pr))) return { ...out, error: '--pr needs a number' };
    out.pr = Number(out.pr);
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
    process.stdout.write(`${resumedLine({ root, issue: parsed.issue, what: parsed.what, ms: parsed.ms, resultPath: parsed.result ?? null })}\n`);
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
