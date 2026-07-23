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

const LOOP_BRANCH_RE = /^(feat|fix|chore|docs|refactor|test|perf|build|ci)\/gh-\d+-/;
const CLOSES_RE = /\b(clos(e|es|ed)|fix(es|ed)?|resolv(e|es|ed))\s+#(\d+)/i;
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
    return {
      n: v.length,
      median: v[Math.floor((v.length - 1) / 2)],
      mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
      min: v[0], max: v[v.length - 1],
    };
  };
  const perStep = {};
  for (const key of STEP_KEYS) perStep[key] = dist(units.map((u) => u.stats.steps[key]?.ms));
  return { perStep, total: dist(units.map((u) => u.stats.totalMs)) };
}

function gh(cmd) {
  return JSON.parse(execSync(`gh ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
}

function discoverIssues(limit) {
  const prs = gh(`pr list --state all --json headRefName,body --limit ${limit}`);
  const nums = new Set();
  for (const pr of prs) {
    if (!LOOP_BRANCH_RE.test(pr.headRefName ?? '')) continue;
    const m = CLOSES_RE.exec(pr.body ?? '');
    if (m) nums.add(Number(m[5]));
  }
  return [...nums].sort((a, b) => a - b);
}

function fetchTimeline(issue) {
  const raw = gh(`api repos/{owner}/{repo}/issues/${issue}/timeline --paginate`);
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
    ['fmt', fmtMs(2117000) === '35m 17s' && fmtMs(44000) === '44s' && fmtMs(null) === '—'],
    ['empty unit', computeUnitStats([]).totalMs === null],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name] of failed) console.error(`FAIL: ${name}`);
  console.log(failed.length === 0 ? `self-test OK (${checks.length} checks)` : `self-test: ${failed.length} FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

function main() {
  if (process.argv.includes('--self-test')) selfTest();
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const issuesArg = argv[argv.indexOf('--issues') + 1];
  const limit = Number(argv[argv.indexOf('--limit') + 1]) || 100;
  const issues = argv.includes('--issues')
    ? issuesArg.split(',').map(Number)
    : discoverIssues(limit);
  const units = issues.map((issue) => ({ issue, stats: computeUnitStats(fetchTimeline(issue)) }))
    .filter((u) => u.stats.started != null);
  const agg = aggregate(units);
  if (json) { console.log(JSON.stringify({ units, aggregate: agg }, null, 2)); return; }

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
