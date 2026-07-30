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
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLAIM_CONTRACT_FIXTURES, parseLoopClaim } from './claim-contract.mjs';
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

function main() {
  if (process.argv.includes('--self-test')) selfTest();
  const argv = process.argv.slice(2);
  if (argv.includes('--sizing')) { reportSizing(argv); return; }
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
