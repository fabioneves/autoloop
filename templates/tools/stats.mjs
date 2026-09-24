#!/usr/bin/env node
// autoloop — stats.mjs: cross-unit step-timing telemetry from issue label timelines.
// Vendored into the host repo by autoloop:setup; read-only (gh api reads, no writes).
//
// The step labels exist to produce per-unit timing tables (dev step 11). This tool
// aggregates them ACROSS units so pipeline tuning runs on data, not feel: per-step
// duration distributions, totals, and the hygiene flags (skipped swaps, stranded
// labels). Usage:
//   node tools/agentic/stats.mjs                 # all loop-owned PR issues (open+merged)
//   node tools/agentic/stats.mjs --issues 5,7    # explicit issue list
//   node tools/agentic/stats.mjs --json          # machine output
// Limitations (v1, deliberate): label telemetry only — review-round counts live in the
// per-issue run records; units re-entered via adoption measure first-label → first-unlabel.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLAIM_CONTRACT_FIXTURES, parseLoopBranchIssue, parseLoopClaim } from './claim-contract.mjs';
import { resolveDispatchLogPath } from './dispatch.mjs';
import { parseDispatchLog } from './overlap-report.mjs';
import { parseOutcomeRecord, parseShapeRecord } from './sizing-contract.mjs';
const STEP_KEYS = ['01-premise', '02-plan', '03-plan-review', '04-claim', '05-implement',
  '06-simplify', '07-diff-review', '08-code-review', '09-gate'];

export function fmtMs(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Pure. events: [{event:'labeled'|'unlabeled', label, at}] (at: ISO string or ms). */
export function computeUnitStats(events) {
  const ev = (events ?? [])
    .filter((e) => typeof e?.label === 'string' && e.label.startsWith('loop'))
    .map((e) => ({ ...e, t: typeof e.at === 'number' ? e.at : Date.parse(e.at) }))
    .sort((a, b) => a.t - b.t);
  const firstLabeled = (name) => ev.find((e) => e.event === 'labeled' && e.label === name)?.t ?? null;
  const firstUnlabeledAfter = (name, t0) =>
    ev.find((e) => e.event === 'unlabeled' && e.label === name && e.t >= t0)?.t ?? null;

  const started = firstLabeled('loop-started');
  const terminalLabel = ['loop-delivered', 'loop-blocked'].find((l) => firstLabeled(l) != null) ?? null;
  const terminal = terminalLabel ? firstLabeled(terminalLabel) : null;

  const steps = {};
  for (let i = 0; i < STEP_KEYS.length; i++) {
    const key = STEP_KEYS[i];
    const start = firstLabeled(`loop:${key}`);
    if (start == null) continue;
    const unlabeled = firstUnlabeledAfter(`loop:${key}`, start);
    const nextStart = STEP_KEYS.slice(i + 1)
      .map((k) => firstLabeled(`loop:${k}`))
      .find((t) => t != null && t >= start) ?? null;
    // A stranded label's unlabel is post-terminal cleanup, not the step's end — prefer the
    // next present step's start (or terminal) for duration in that case.
    const cleanUnlabeled = unlabeled != null && (terminal == null || unlabeled <= terminal) ? unlabeled : null;
    const end = cleanUnlabeled ?? nextStart ?? terminal ?? unlabeled;
    steps[key] = {
      ms: end != null ? end - start : null,
      stranded: terminal != null && (unlabeled == null || unlabeled > terminal),
    };
  }
  const presentIdx = STEP_KEYS.map((k, i) => (steps[k] ? i : -1)).filter((i) => i >= 0);
  const maxIdx = presentIdx.length ? Math.max(...presentIdx) : -1;
  const skipped = STEP_KEYS.filter((k, i) => !steps[k] && i < maxIdx);
  return {
    started, terminal, terminalLabel,
    totalMs: started != null && terminal != null ? terminal - started : null,
    steps, skipped,
    stranded: STEP_KEYS.filter((k) => steps[k]?.stranded).map((k) => `loop:${k}`),
  };
}

/** Pure. units: [{issue, stats}] → per-step {n, median, mean, min, max} + totals. */
export function aggregate(units) {
  const dist = (values) => {
    const v = values.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const middle = Math.floor(v.length / 2);
    return {
      n: v.length,
      median: v.length % 2 ? v[middle] : (v[middle - 1] + v[middle]) / 2,
      mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
      min: v[0], max: v[v.length - 1],
    };
  };
  const perStep = {};
  for (const key of STEP_KEYS) perStep[key] = dist(units.map((u) => u.stats.steps[key]?.ms));
  return { perStep, total: dist(units.map((u) => u.stats.totalMs)) };
}

// ── The run record's timing block ──────────────────────────────────────────
//
// The per-step numbers lived in the session panel and scrolled away, and the
// dispatch log is machine-local with no issue on it, so a unit's cost could not
// be read back from GitHub. Step 11 appends this block to the run record: wall
// time per step from the label timeline, and under each step the dispatches that
// ran on the unit's branch. The marker makes it queryable across units.
const STEP_OF_ROLE = Object.freeze({
  plan: '02-plan',
  'plan-review': '03-plan-review',
  implement: '05-implement',
  simplify: '06-simplify',
  'diff-review': '07-diff-review',
  'code-review': '08-code-review',
  'doubt-review': '08-code-review',
  fix: '08-code-review',
});

/**
 * Pure. Active time per step across every session of a unit. `computeUnitStats`
 * reads first-label to first-unlabel from `loop-started`, which misses plan and
 * plan-review (labelled before it) and every session after a block; a unit's
 * cost is all of them. Steps are sequential, so a step also ends when another
 * step label goes on or the unit turns terminal — a stranded label never
 * accrues. A step still open is measured to `now`.
 */
export function unitActiveTime(events, now) {
  const ev = (events ?? [])
    .filter((e) => typeof e?.label === 'string' && e.label.startsWith('loop'))
    .map((e) => ({ ...e, t: typeof e.at === 'number' ? e.at : Date.parse(e.at) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);
  const open = new Map();
  const steps = {};
  const close = (label, t) => {
    const key = label.slice('loop:'.length);
    if (STEP_KEYS.includes(key)) steps[key] = (steps[key] ?? 0) + (t - open.get(label));
    open.delete(label);
  };
  let sessions = 0;
  const closeAll = (t, except = null) => {
    for (const label of [...open.keys()]) if (label !== except) close(label, t);
  };
  for (const e of ev) {
    if (e.event === 'labeled' && e.label === 'loop-started') sessions += 1;
    // The unit stops accruing when it turns terminal, is set waiting, or its
    // session ends; a step label left on across a pause is not work.
    const pauses = e.event === 'labeled'
      ? ['loop-delivered', 'loop-blocked', 'loop-waiting'].includes(e.label)
      : e.label === 'loop-started';
    if (pauses) {
      closeAll(e.t);
    } else if (e.event === 'labeled' && e.label.startsWith('loop:')) {
      closeAll(e.t, e.label);
      if (!open.has(e.label)) open.set(e.label, e.t);
    } else if (e.event === 'unlabeled' && open.has(e.label)) {
      close(e.label, e.t);
    }
  }
  if (Number.isFinite(now)) closeAll(now);
  const activeMs = Object.values(steps).reduce((sum, ms) => sum + ms, 0);
  return { steps, activeMs, sessions };
}

// Plan and plan-review run before the unit's branch exists, from whatever the
// orchestrator's checkout is on (often the in-flight unit's branch while the
// next unit is staged), so a branch never attributes them.
const PRE_CLAIM_ROLES = new Set(['plan', 'plan-review']);

/**
 * Pure. The dispatch-log lines that belong to this issue, oldest first: by the
 * `--issue` a dispatch was given, else by its loop branch for post-claim roles.
 */
export function unitDispatches(logText, issue) {
  return parseDispatchLog(logText)
    .filter((entry) => (Number.isSafeInteger(entry.issue)
      ? entry.issue === issue
      : !PRE_CLAIM_ROLES.has(entry.role) && parseLoopBranchIssue(entry.branch) === issue))
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
}

function dispatchCell(entry) {
  const model = entry.model ?? entry.engine ?? 'default';
  const outcome = entry.ok ? '' : ` ✖ ${entry.code ?? 'failed'}`;
  const fallback = entry.fallback ? ' ↪ fallback' : '';
  return `${entry.role} · ${model}${entry.effort ? `/${entry.effort}` : ''} · ${fmtMs(entry.ms)}${outcome}${fallback}`;
}

/** Pure. The markdown block step 11 appends to the run record. */
export function timingRecord(issue, active, dispatches) {
  const marker = {
    v: 1,
    issue,
    activeMs: active.activeMs,
    sessions: active.sessions,
    steps: active.steps,
    dispatches: dispatches.map(({ role, engine, model, effort, ms, ok, code, fallback }) =>
      ({ role, engine, model, effort, ms, ok, code, fallback })),
  };
  const rounds = dispatches.filter(({ role, ok }) => role === 'code-review' && ok).length;
  const byStep = new Map();
  for (const entry of dispatches) {
    const key = STEP_OF_ROLE[entry.role] ?? 'other';
    byStep.set(key, [...(byStep.get(key) ?? []), dispatchCell(entry)]);
  }
  const rows = [...STEP_KEYS, 'other']
    .filter((key) => active.steps[key] !== undefined || byStep.has(key))
    .map((key) => `| ${key} | ${fmtMs(active.steps[key])} | ${(byStep.get(key) ?? []).join('<br>') || '—'} |`);
  return [
    `**Timing** · active ${fmtMs(active.activeMs)} over ${active.sessions} session${active.sessions === 1 ? '' : 's'} · `
      + `${dispatches.length} attributed dispatches · `
      + `${rounds} code-review round${rounds === 1 ? '' : 's'}`,
    '',
    ...(rows.length === 0 ? [] : ['| step | wall | dispatches |', '|---|---|---|', ...rows, '']),
    `<!-- autoloop-timing-v1 ${JSON.stringify(marker)} -->`,
  ].join('\n');
}

// maxBuffer is raised because execSync's 1 MB default is smaller than this
// tool's own reads: 60 issues with bodies AND comments is 1.1 MB on a real
// repository, since every run record is an issue comment and they are long. The
// default made the sizing join fail with ENOBUFS the first time it ran against a
// live queue, and it would only ever fail more as history grows.
function gh(cmd) {
  return JSON.parse(execSync(`gh ${cmd}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  }));
}

// ── The sizing join ────────────────────────────────────────────────────────
//
// `sizing-contract.mjs` has recorded a PREDICTION per unit (cases, invariants,
// estimated files/lines, in the issue body) and an OUTCOME per unit (review
// rounds, escalation, result, actual files/lines, in the run record comment)
// since it was written. Its own header says "Only the PAIR is useful" — and the
// pair had never been joined, so the ~5-case threshold stayed an argument from
// two runs and nobody could ask whether five-case units really do converge
// faster than nine-case ones.
//
// It answers one question: does the predicted case count predict cost? Buckets
// rather than a correlation, because n is small and a bucket survives a small n
// legibly while a coefficient invites reading noise as signal.
const CASE_BUCKETS = Object.freeze([
  { key: '1-5 (within rule)', min: 1, max: 5 },
  { key: '6-8 (over)', min: 6, max: 8 },
  { key: '9+ (far over)', min: 9, max: Infinity },
]);

function medianOf(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const middle = Math.floor(v.length / 2);
  return v.length % 2 ? v[middle] : (v[middle - 1] + v[middle]) / 2;
}

/**
 * Pure. rows: [{issue, shape, outcome}] where shape/outcome are parsed records
 * or null. Returns the paired rows, the two unpaired sets, and per-bucket cost.
 */
export function joinSizing(rows) {
  const paired = [];
  const predictionOnly = [];
  const outcomeOnly = [];
  for (const { issue, shape, outcome } of rows ?? []) {
    if (shape && outcome) paired.push({ issue, shape, outcome });
    else if (shape) predictionOnly.push(issue);
    else if (outcome) outcomeOnly.push(issue);
  }
  const buckets = CASE_BUCKETS.map(({ key, min, max }) => {
    const inBucket = paired.filter(
      ({ shape }) => shape.cases >= min && shape.cases <= max,
    );
    const shipped = inBucket.filter(({ outcome }) => outcome.result === 'shipped');
    return {
      bucket: key,
      n: inBucket.length,
      blocked: inBucket.filter(({ outcome }) => outcome.result === 'blocked').length,
      escalated: inBucket.filter(({ outcome }) => outcome.escalated === true).length,
      medianCodeRounds: medianOf(inBucket.map(({ outcome }) => outcome.codeRounds)),
      medianCodeRoundsShipped: medianOf(shipped.map(({ outcome }) => outcome.codeRounds)),
    };
  });
  // Prediction error, signed: positive means the unit cost MORE than shaped.
  // Reported separately from cost because a bad line estimate and a bad case
  // count are different shaping errors with different fixes.
  const lineErrors = paired
    .filter(({ shape, outcome }) =>
      shape.linesEstimate != null && outcome.prodLines != null)
    .map(({ issue, shape, outcome }) => ({
      issue, predicted: shape.linesEstimate, actual: outcome.prodLines,
      error: outcome.prodLines - shape.linesEstimate,
    }));
  return {
    paired,
    predictionOnly,
    outcomeOnly,
    buckets,
    medianLineError: medianOf(lineErrors.map((e) => e.error)),
    lineErrors,
  };
}

// Predictions ride the issue BODY, outcomes ride a run-record COMMENT (dev step
// 11 posts one per run). Both are issue-local, so one list call carries both.
// The LAST parseable outcome wins: a unit re-entered by adoption posts a second
// run record, and the newest is the one that describes how it actually ended.
// The failure REASON is returned, never swallowed. A bare `return null` here
// reported "could not read issues" for what was actually ENOBUFS, sending the
// reader to look at permissions and the repository instead of at a buffer size.
function fetchSizingRows(limit) {
  let issues;
  try {
    issues = gh(`issue list --state all --limit ${limit} --json number,body,comments`);
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
  if (!Array.isArray(issues)) return { error: 'gh returned a non-array payload' };
  return {
    rows: issues.map((issue) => {
      const shape = parseShapeRecord(issue.body ?? '');
      const outcomes = (issue.comments ?? [])
        .map((comment) => parseOutcomeRecord(comment?.body ?? ''))
        .filter((parsed) => parsed.ok);
      return {
        issue: issue.number,
        shape: shape.ok ? shape.record : null,
        outcome: outcomes.length ? outcomes.at(-1).record : null,
      };
    }),
  };
}

function reportSizing(argv) {
  const limit = Number(argv[argv.indexOf('--limit') + 1]) || 100;
  const fetched = fetchSizingRows(limit);
  if (fetched.error) {
    console.error(`stats: could not read issues for the sizing join — ${fetched.error}`);
    process.exit(1);
  }
  const report = joinSizing(fetched.rows);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('issue  cases inv  pred-lines  result     rounds  esc  act-lines  line-err');
  for (const { issue, shape, outcome } of report.paired) {
    const predicted = shape.linesEstimate ?? null;
    const actual = outcome.prodLines ?? null;
    const error = predicted != null && actual != null ? actual - predicted : null;
    console.log(
      `#${String(issue).padEnd(5)}`
      + `${String(shape.cases).padEnd(6)}${String(shape.invariants).padEnd(5)}`
      + `${String(predicted ?? '—').padEnd(12)}${String(outcome.result).padEnd(11)}`
      + `${String(outcome.codeRounds).padEnd(8)}${(outcome.escalated ? 'yes' : 'no').padEnd(5)}`
      + `${String(actual ?? '—').padEnd(11)}${error == null ? '—' : (error > 0 ? `+${error}` : error)}`,
    );
  }
  console.log(`\ncost by predicted case count (${report.paired.length} paired units):`);
  console.log('bucket              n   blocked  escalated  median rounds  median rounds (shipped)');
  for (const b of report.buckets) {
    console.log(
      `${b.bucket.padEnd(20)}${String(b.n).padEnd(4)}${String(b.blocked).padEnd(9)}`
      + `${String(b.escalated).padEnd(11)}${String(b.medianCodeRounds ?? '—').padEnd(15)}`
      + `${b.medianCodeRoundsShipped ?? '—'}`,
    );
  }
  console.log(`\nmedian production-line error: ${report.medianLineError ?? '—'} (positive = cost more than shaped)`);
  // Named, never silently dropped — the same rule the timing scoreboard follows.
  if (report.predictionOnly.length) {
    console.log(
      `\n⚠ ${report.predictionOnly.length} shaped but no outcome yet (queued or in flight): `
      + report.predictionOnly.map((n) => `#${n}`).join(', '),
    );
  }
  if (report.outcomeOnly.length) {
    console.log(
      `⚠ ${report.outcomeOnly.length} ran with NO sizing marker (shaped before the marker, or filed by hand): `
      + report.outcomeOnly.map((n) => `#${n}`).join(', '),
    );
  }
  if (report.paired.length === 0) {
    console.log('\nNo paired units yet — a prediction with no outcome is an opinion, and an outcome');
    console.log('with no prediction cannot say which shaping choice produced it.');
  }
}

export function claimedIssues(prs) {
  const nums = new Set();
  for (const pr of prs ?? []) {
    const claim = parseLoopClaim({ branch: pr.headRefName, body: pr.body });
    if (claim.valid) nums.add(claim.issue);
  }
  return [...nums].sort((a, b) => a - b);
}

function discoverIssues(limit) {
  return claimedIssues(gh(`pr list --state all --json headRefName,body --limit ${limit}`));
}

// A unit whose issue is gone takes its own row out, never the scoreboard. A
// deleted issue answers the timeline endpoint with HTTP 410, and the bare
// JSON.parse(execSync(...)) in `gh` above threw it straight through main: one
// deleted issue and a whole run reported NO timings, having read every other
// unit successfully. Observed 2026-07-29 — 26 issues were deleted while
// re-shaping a queue, and the next scoreboard produced nothing at all.
//
// A reporting tool must never wedge on the thing it reports. `null` here means
// unreadable, and the caller counts those and names them, because a scoreboard
// that silently drops units is worse than one that crashes — it looks complete.
function fetchTimeline(issue) {
  let raw;
  try {
    raw = gh(`api repos/{owner}/{repo}/issues/${issue}/timeline --paginate`);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((e) => e.event === 'labeled' || e.event === 'unlabeled')
    .map((e) => ({ event: e.event, label: e.label?.name ?? '', at: e.created_at }));
}

function selfTest() {
  // Fixture: unit #7's real timeline (2026-07-19) — skipped 05/08, stranded 04/07.
  const T = (hms) => `2026-07-19T${hms}Z`;
  const events = [
    { event: 'labeled', label: 'loop-ready', at: T('10:49:24') },
    { event: 'labeled', label: 'loop-started', at: T('14:21:20') },
    { event: 'labeled', label: 'loop:01-premise', at: T('14:21:20') },
    { event: 'unlabeled', label: 'loop:01-premise', at: T('14:22:31') },
    { event: 'labeled', label: 'loop:02-plan', at: T('14:22:31') },
    { event: 'labeled', label: 'loop:03-plan-review', at: T('14:25:12') },
    { event: 'unlabeled', label: 'loop:02-plan', at: T('14:25:12') },
    { event: 'unlabeled', label: 'loop:03-plan-review', at: T('14:32:35') },
    { event: 'labeled', label: 'loop:04-claim', at: T('14:32:35') },
    { event: 'labeled', label: 'loop:06-simplify', at: T('14:44:29') },
    { event: 'labeled', label: 'loop:07-diff-review', at: T('14:48:01') },
    { event: 'unlabeled', label: 'loop:06-simplify', at: T('14:48:01') },
    { event: 'labeled', label: 'loop:09-gate', at: T('14:54:44') },
    { event: 'unlabeled', label: 'loop-started', at: T('14:56:36') },
    { event: 'unlabeled', label: 'loop:09-gate', at: T('14:56:36') },
    { event: 'labeled', label: 'loop-delivered', at: T('14:56:37') },
    { event: 'unlabeled', label: 'loop:04-claim', at: T('14:58:46') },
    { event: 'unlabeled', label: 'loop:07-diff-review', at: T('14:58:46') },
  ];
  const s = computeUnitStats(events);
  const agg = aggregate([{ issue: 7, stats: s }, { issue: 7, stats: s }]);
  const even = aggregate([
    { stats: { steps: {}, totalMs: 1000 } },
    { stats: { steps: {}, totalMs: 3000 } },
  ]);
  const cohort = claimedIssues(CLAIM_CONTRACT_FIXTURES.map((fixture) => ({
    headRefName: fixture.branch,
    body: fixture.body,
  })));
  const checks = [
    ['total 35m17s', s.totalMs === 2117000],
    ['outcome delivered', s.terminalLabel === 'loop-delivered'],
    ['plan 2m41s', s.steps['02-plan'].ms === 161000],
    ['plan-review 7m23s', s.steps['03-plan-review'].ms === 443000],
    ['claim ends at next present step', s.steps['04-claim'].ms === Date.parse(T('14:44:29')) - Date.parse(T('14:32:35'))],
    ['skipped 05+08', s.skipped.join(',') === '05-implement,08-code-review'],
    ['stranded 04+07', s.stranded.join(',') === 'loop:04-claim,loop:07-diff-review'],
    ['gate not stranded', s.steps['09-gate'].stranded === false],
    ['agg n=2 median total', agg.total.n === 2 && agg.total.median === 2117000],
    ['even median averages middle values', even.total.median === 2000],
    ['canonical claim cohort', cohort.join(',') === '5,7,9,12'],
    ['fmt', fmtMs(2117000) === '35m 17s' && fmtMs(44000) === '44s' && fmtMs(null) === '—'],
    ['empty unit', computeUnitStats([]).totalMs === null],
    // The run record's timing block: posted in step 11, often before the terminal
    // label, so an open unit is measured up to `now`.
    ...(() => {
      const active = unitActiveTime(events, null);
      const now = Date.parse(T('15:00:00'));
      const resumed = unitActiveTime([
        ...events.filter(({ label }) => label !== 'loop-delivered').slice(0, 13),
        { event: 'labeled', label: 'loop-blocked', at: T('15:00:00') },
        { event: 'unlabeled', label: 'loop-blocked', at: T('16:00:00') },
        { event: 'labeled', label: 'loop-started', at: T('16:10:00') },
        { event: 'labeled', label: 'loop:08-code-review', at: T('16:10:00') },
      ], Date.parse(T('16:30:00')));
      const log = [
        { role: 'plan', engine: 'claude', model: 'gpt-6-astra', effort: 'xhigh', branch: 'main', issue: 7, startedAtMs: 3, ms: 150000, ok: true },
        // #8's plan staged while the checkout sat on #7's branch: it is #8's.
        { role: 'plan', engine: 'claude', branch: 'feat/gh-7-x', issue: 8, startedAtMs: 4, ms: 1, ok: true },
        // A plan with no --issue is never charged by branch.
        { role: 'plan-review', engine: 'claude', branch: 'feat/gh-7-x', startedAtMs: 4, ms: 1, ok: true },
        { role: 'code-review', engine: 'claude', model: 'gpt-6-astra', branch: 'feat/gh-7-x', startedAtMs: 5, ms: 60000, ok: false, code: 'ENGINE_TIMEOUT' },
        { role: 'code-review', engine: 'claude', model: 'claude-opus-5-5', branch: 'feat/gh-7-x', startedAtMs: 6, ms: 70000, ok: true, fallback: true },
        { role: 'implement', engine: 'claude', branch: 'feat/gh-8-y', startedAtMs: 4, ms: 1, ok: true },
        { role: 'implement', engine: 'claude', startedAtMs: 2, ms: 1, ok: true },
      ];
      const mine = unitDispatches(`${log.map((entry) => JSON.stringify(entry)).join('\n')}\n{"role":"pl`, 7);
      const record = timingRecord(7, active, mine);
      const marker = JSON.parse(/<!-- autoloop-timing-v1 (\{.*\}) -->/u.exec(record)?.[1] ?? 'null');
      return [
        ['active time counts plan and plan-review, and a stranded label stops at the next step',
          active.steps['02-plan'] === 161000 && active.steps['04-claim'] === 714000
          && active.steps['07-diff-review'] === 403000 && active.activeMs === 2116000
          && active.sessions === 1],
        ['a resumed session adds to its step, and an open step runs to now',
          resumed.sessions === 2 && resumed.steps['08-code-review'] === 20 * 60000
          && resumed.steps['09-gate'] === now - Date.parse(T('14:54:44'))],
        ['only the issue\'s own branch is itemized, in start order',
          mine.map(({ role }) => role).join() === 'plan,code-review,code-review'],
        ['the marker carries total, steps and dispatches',
          marker?.issue === 7 && marker.activeMs === 2116000 && marker.sessions === 1
          && marker.steps['02-plan'] === 161000 && marker.dispatches.length === 3],
        ['a dispatch sits under its step with model, effort and outcome',
          /\| 02-plan \| 2m 41s \| plan · gpt-6-astra\/xhigh · 2m 30s \|/u.test(record)
          && record.includes('code-review · gpt-6-astra · 1m 0s ✖ ENGINE_TIMEOUT')
          && record.includes('code-review · claude-opus-5-5 · 1m 10s ↪ fallback')],
        ['the header counts attributed dispatches and completed review rounds',
          record.includes('3 attributed dispatches · 1 code-review round')],
        ['a pause stops the clock: loop-waiting on, or the session\'s loop-started off',
          (() => {
            const paused = unitActiveTime([
              { event: 'labeled', label: 'loop-started', at: T('10:00:00') },
              { event: 'labeled', label: 'loop:05-implement', at: T('10:00:00') },
              { event: 'unlabeled', label: 'loop-started', at: T('11:00:00') },
              { event: 'labeled', label: 'loop-started', at: T('20:00:00') },
              { event: 'labeled', label: 'loop:05-implement', at: T('20:00:00') },
              { event: 'labeled', label: 'loop-waiting', at: T('20:30:00') },
              { event: 'unlabeled', label: 'loop-waiting', at: T('22:00:00') },
              { event: 'labeled', label: 'loop:05-implement', at: T('22:00:00') },
              { event: 'labeled', label: 'loop:06-simplify', at: T('22:10:00') },
            ], null);
            return paused.steps['05-implement'] === 100 * 60000 && paused.sessions === 2;
          })()],
        ['an unparseable timestamp is skipped, never NaN',
          unitActiveTime([{ event: 'labeled', label: 'loop:02-plan', at: 'garbage' }], 5).activeMs === 0],
        ['a unit with no logged dispatch still records its steps',
          timingRecord(7, active, []).includes('0 attributed dispatches')],
      ];
    })(),
    // The sizing join, on the two units that actually produced records: #240
    // (7 cases, blocked, escalated) and #266 (6 cases, shipped, 7 rounds, 33
    // production lines against a 240 estimate).
    ...(() => {
      const rows = [
        { issue: 240,
          shape: { v: 1, cases: 7, invariants: 1, linesEstimate: 210 },
          outcome: { v: 1, issue: 240, codeRounds: 2, escalated: true, result: 'blocked' } },
        { issue: 266,
          shape: { v: 1, cases: 6, invariants: 1, linesEstimate: 240 },
          outcome: { v: 1, issue: 266, codeRounds: 7, escalated: false, result: 'shipped', prodLines: 33 } },
        { issue: 265, shape: { v: 1, cases: 5, invariants: 1 }, outcome: null },
        { issue: 219, shape: null,
          outcome: { v: 1, issue: 219, codeRounds: 3, escalated: true, result: 'blocked' } },
      ];
      const r = joinSizing(rows);
      const over = r.buckets.find((b) => b.bucket === '6-8 (over)');
      const within = r.buckets.find((b) => b.bucket === '1-5 (within rule)');
      return [
        ['join pairs only units with BOTH records', r.paired.length === 2],
        ['a prediction with no outcome is named, not dropped',
          r.predictionOnly.join() === '265'],
        ['an outcome with no prediction is named, not dropped',
          r.outcomeOnly.join() === '219'],
        ['buckets count by PREDICTED cases', over.n === 2 && within.n === 0],
        ['blocked and escalated are counted per bucket',
          over.blocked === 1 && over.escalated === 1],
        ['median rounds spans the bucket', over.medianCodeRounds === 4.5],
        ['shipped-only median excludes the blocked unit',
          over.medianCodeRoundsShipped === 7],
        ['line error is signed, negative when a unit cost LESS than shaped',
          r.medianLineError === -207],
        ['an empty join says so rather than dividing by zero',
          joinSizing([]).paired.length === 0 && joinSizing([]).medianLineError === null],
        ['a null row list is tolerated', joinSizing(null).paired.length === 0],
      ];
    })(),
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name] of failed) console.error(`FAIL: ${name}`);
  console.log(failed.length === 0 ? `self-test OK (${checks.length} checks)` : `self-test: ${failed.length} FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// Read-only and fail-open: an unreadable timeline or log shrinks the block, it
// never fails the run record it belongs to.
function printRecord(argv) {
  const issue = Number(argv[argv.indexOf('--issue') + 1]);
  if (!argv.includes('--issue') || !Number.isSafeInteger(issue) || issue <= 0) {
    console.error('usage: stats.mjs --record --issue <n>');
    process.exit(2);
  }
  const timeline = fetchTimeline(issue);
  const active = unitActiveTime(timeline ?? [], Date.now());
  let logText = '';
  try {
    const path = resolveDispatchLogPath(process.cwd());
    if (path !== null && existsSync(path)) logText = readFileSync(path, 'utf8');
  } catch {
    logText = '';
  }
  if (timeline === null) console.log('_label timeline unreadable — steps omitted_\n');
  console.log(timingRecord(issue, active, unitDispatches(logText, issue)));
}

function main() {
  if (process.argv.includes('--self-test')) selfTest();
  const argv = process.argv.slice(2);
  if (argv.includes('--sizing')) { reportSizing(argv); return; }
  if (argv.includes('--record')) { printRecord(argv); return; }
  const json = argv.includes('--json');
  const issuesArg = argv[argv.indexOf('--issues') + 1];
  const limit = Number(argv[argv.indexOf('--limit') + 1]) || 100;
  const issues = argv.includes('--issues')
    ? issuesArg.split(',').map(Number)
    : discoverIssues(limit);
  const timelines = issues.map((issue) => ({ issue, timeline: fetchTimeline(issue) }));
  const unreadable = timelines.filter(({ timeline }) => timeline === null).map(({ issue }) => issue);
  const units = timelines
    .filter(({ timeline }) => timeline !== null)
    .map(({ issue, timeline }) => ({ issue, stats: computeUnitStats(timeline) }))
    .filter((u) => u.stats.started != null);
  const agg = aggregate(units);
  if (json) {
    console.log(JSON.stringify({ units, unreadable, aggregate: agg }, null, 2));
    return;
  }
  // Named, never silently dropped: an unreadable unit is usually a deleted issue,
  // and a scoreboard missing rows it never mentions reads as a complete one.
  if (unreadable.length > 0) {
    console.log(
      `⚠ ${unreadable.length} issue(s) unreadable (deleted, or no access) — excluded: `
      + unreadable.map((n) => `#${n}`).join(', '),
    );
  }

  console.log('issue  outcome    total     ' + STEP_KEYS.map((k) => k.slice(3, 9).padEnd(8)).join(''));
  for (const { issue, stats } of units) {
    const outcome = stats.terminalLabel?.replace('loop-', '') ?? 'in-flight';
    console.log(
      `#${String(issue).padEnd(5)}${outcome.padEnd(11)}${fmtMs(stats.totalMs).padEnd(10)}` +
      STEP_KEYS.map((k) => fmtMs(stats.steps[k]?.ms).padEnd(8)).join(''),
    );
    if (stats.skipped.length) console.log(`       ⚠ skipped swaps: ${stats.skipped.join(', ')}`);
    if (stats.stranded.length) console.log(`       ⚠ stranded labels: ${stats.stranded.join(', ')}`);
  }
  console.log(`\naggregate (${units.length} units) — median [min–max]:`);
  for (const k of STEP_KEYS) {
    const d = agg.perStep[k];
    if (d) console.log(`  ${k.padEnd(16)} ${fmtMs(d.median).padEnd(9)} [${fmtMs(d.min)}–${fmtMs(d.max)}] n=${d.n}`);
  }
  if (agg.total) console.log(`  ${'total'.padEnd(16)} ${fmtMs(agg.total.median).padEnd(9)} [${fmtMs(agg.total.min)}–${fmtMs(agg.total.max)}] n=${agg.total.n}`);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();
if (isMain) main();
