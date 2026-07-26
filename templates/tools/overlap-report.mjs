#!/usr/bin/env node
// autoloop — overlap-report.mjs
//
// The run record's `overlap:` line, computed instead of narrated.
//
// v0.39 carried the same line but the orchestrator wrote it by hand. Depth-one
// overlap then disappeared in v0.40.0 and nobody noticed for three minor
// versions, because a self-reported field says whatever the writer believes and
// costs nothing to omit. A live 0.42.3 run idled ~32 minutes across two
// dispatches with five eligible issues in the queue and reported nothing at all.
//
// Concurrency here is derived from the dispatch log's own timestamps, so it
// cannot be overstated: two dispatch windows either intersect in wall-clock or
// they do not. `concurrent 0m` next to `eligible 5` is the signal that a run
// serialized work it could have overlapped.
//
// Run scope comes from the newest run-marker file's mtime (`prime.mjs` writes
// one per run), so the report needs no argument to know which run it is in.
//
// Loop-safety: read-only, and fail-open on every infrastructure error — a
// reporting tool must never wedge a run. `--self-test` runs the pure fixtures.
//
// Usage:
//   node tools/agentic/overlap-report.mjs [--root <dir>] [--eligible <n>] [--json]

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

function gitPath(root, relative) {
  const result = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--git-path', relative],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true },
  );
  if (result.status !== 0 || result.error) return null;
  const path = String(result.stdout ?? '').trim();
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(root, path);
}

// Entries are appended by concurrent dispatches, so a torn or partial final line
// is expected rather than exceptional; it is skipped, not fatal.
export function parseDispatchLog(text) {
  const entries = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof entry?.role === 'string'
      && Number.isSafeInteger(entry.startedAtMs)
      && Number.isSafeInteger(entry.ms)
      && entry.ms >= 0
    ) {
      entries.push(entry);
    }
  }
  return entries;
}

// Wall-clock during which at least one dispatch was in flight.
export function unionMs(entries) {
  const windows = entries
    .map(({ startedAtMs, ms }) => [startedAtMs, startedAtMs + ms])
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let openStart = null;
  let openEnd = null;
  for (const [start, end] of windows) {
    if (openEnd === null || start > openEnd) {
      if (openEnd !== null) total += openEnd - openStart;
      openStart = start;
      openEnd = end;
    } else if (end > openEnd) {
      openEnd = end;
    }
  }
  if (openEnd !== null) total += openEnd - openStart;
  return total;
}

export function summarize(entries, eligible = null) {
  const busyMs = entries.reduce((sum, { ms }) => sum + ms, 0);
  const wallMs = unionMs(entries);
  return {
    dispatches: entries.length,
    wallMs,
    // Sum minus union is exactly the time two or more dispatches were running
    // together — the wall-clock overlap actually reclaimed.
    concurrentMs: Math.max(0, busyMs - wallMs),
    eligible,
  };
}

export function formatDuration(ms) {
  if (ms < 1000) return '0s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function formatOverlapLine(summary) {
  const parts = [
    `dispatches ${summary.dispatches}`,
    `wall ${formatDuration(summary.wallMs)}`,
    `concurrent ${formatDuration(summary.concurrentMs)}`,
  ];
  if (summary.eligible !== null) parts.push(`eligible ${summary.eligible}`);
  return `overlap: ${parts.join(' · ')}`;
}

// The newest run marker's mtime is when this run opened. Without one, every
// entry is in scope and the report says so rather than inventing a boundary.
export function runStartedAtMs(root) {
  try {
    const directory = gitPath(root, 'autoloop/run');
    if (directory === null || !existsSync(directory)) return null;
    const stamps = readdirSync(directory)
      .map((name) => {
        try {
          return statSync(join(directory, name)).mtimeMs;
        } catch {
          return null;
        }
      })
      .filter((value) => value !== null);
    return stamps.length === 0 ? null : Math.max(...stamps);
  } catch {
    return null;
  }
}

export function report(root, eligible = null) {
  const logPath = gitPath(root, 'autoloop/dispatch-log.jsonl');
  const text = logPath !== null && existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
    : '';
  const startedAtMs = runStartedAtMs(root);
  const entries = parseDispatchLog(text).filter(
    (entry) => startedAtMs === null || entry.startedAtMs >= startedAtMs,
  );
  const summary = { ...summarize(entries, eligible), runScoped: startedAtMs !== null };
  return { ...summary, line: formatOverlapLine(summary) };
}

export function parseArgs(args) {
  const parsed = { root: process.cwd(), eligible: null, json: false, mode: 'report' };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--self-test') {
      parsed.mode = 'self-test';
      continue;
    }
    if (flag === '--json') {
      parsed.json = true;
      continue;
    }
    const value = args[index + 1];
    if (flag === '--root' && value !== undefined) {
      parsed.root = value;
      index += 1;
      continue;
    }
    if (flag === '--eligible' && value !== undefined) {
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) return null;
      parsed.eligible = count;
      index += 1;
      continue;
    }
    return null;
  }
  return parsed;
}

function selfTest() {
  const failures = [];
  const check = (name, passed) => {
    if (!passed) failures.push(name);
  };
  const at = (startedAtMs, ms, role = 'implement') => ({ role, startedAtMs, ms, ok: true });

  check(
    'sequential dispatches report no concurrency',
    summarize([at(1000, 500), at(2000, 500)]).concurrentMs === 0,
  );
  check(
    'fully nested dispatches report the inner window as concurrent',
    summarize([at(1000, 1000), at(1200, 400)]).concurrentMs === 400,
  );
  check(
    'partially overlapping dispatches report only the intersection',
    summarize([at(1000, 1000), at(1500, 1000)]).concurrentMs === 500,
  );
  check(
    'union wall-clock ignores the gap between dispatches',
    unionMs([at(0, 100), at(1000, 100)]) === 200,
  );
  check('an empty log summarizes to zero', summarize([]).dispatches === 0);
  check(
    'a torn final line is skipped rather than fatal',
    parseDispatchLog('{"role":"a","startedAtMs":1,"ms":2}\n{"role":"b","star').length === 1,
  );
  check(
    'entries missing required fields are rejected',
    parseDispatchLog('{"role":"a"}\n{"startedAtMs":1,"ms":2}\n{"role":"a","startedAtMs":1,"ms":-1}')
      .length === 0,
  );
  check(
    'the line names concurrency even when it is zero',
    formatOverlapLine(summarize([at(1000, 60_000), at(70_000, 60_000)], 5))
      === 'overlap: dispatches 2 · wall 2m · concurrent 0s · eligible 5',
  );
  check(
    'eligible is omitted when unknown',
    formatOverlapLine(summarize([])) === 'overlap: dispatches 0 · wall 0s · concurrent 0s',
  );
  check('args reject an unknown flag', parseArgs(['--wat']) === null);
  check('args reject a negative eligible count', parseArgs(['--eligible', '-1']) === null);
  check(
    'args accept root, eligible and json',
    parseArgs(['--root', '/r', '--eligible', '3', '--json'])?.eligible === 3,
  );

  for (const name of failures) console.error(`FAIL ${name}`);
  const total = 12;
  console.log(
    failures.length === 0
      ? `self-test OK (${total} cases)`
      : `self-test FAILED (${failures.length}/${total})`,
  );
  return failures.length === 0;
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed === null) {
  console.error('usage: overlap-report.mjs [--root <dir>] [--eligible <n>] [--json]');
  process.exit(2);
}
if (parsed.mode === 'self-test') {
  process.exit(selfTest() ? 0 : 1);
}
try {
  const result = report(parsed.root, parsed.eligible);
  console.log(parsed.json ? JSON.stringify(result, null, 1) : result.line);
} catch (error) {
  // Read-only reporting must never wedge a run.
  console.error(`overlap-report: unavailable (${error.message})`);
}
