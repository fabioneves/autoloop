#!/usr/bin/env node
// autoloop — step-subject.mjs
//
// Composes the subject line of a COMPLETED step task, so the panel's cost
// profile is produced rather than remembered.
//
// The dev skill has required `[<elapsed>] [<HH:MM ended>]` on every completed
// step since v0.49.21, and live runs kept shipping bare subjects
// (`∞ #123 — 02 PLAN [OPUS]`). The rule was never the problem: obeying it asked
// the orchestrator to divide milliseconds into minutes and read a clock at the
// exact moment it was also collecting a typed result, disposing findings and
// moving labels. Recall plus arithmetic under load is the shape that decays —
// the same lesson the lessons budget learned in v0.49.19, one panel over.
//
// So the numbers the loop already has become a command: the dispatch result
// carries `ms`, this tool carries the format and the clock.
//
// It also normalises the executor slot to UPPER-CASE. That is one rule stated
// in the skill for every surface at once ("every model name is UPPER-CASE
// everywhere it appears"), which makes it exactly the kind of rule a long run
// applies unevenly. Composing the subject is the one moment the casing can be
// guaranteed instead of asked for.
//
// Colour is deliberately NOT set here, and cannot be: a task subject renders as
// plain text, no ANSI escape survives a markdown renderer, and the host owns the
// theme. CAPS is the whole highlight mechanism the panel affords.
//
// Usage:
//   node step-subject.mjs --subject <text> --ms <n>
//   node step-subject.mjs --subject <text> --started-at-ms <epoch>
//   node step-subject.mjs --self-test

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The two tokens this tool appends. Recognising them is what makes composition
// idempotent: a subject completed once must survive being composed again
// (a resumed unit re-completes a task it already finished) without growing a
// second pair of brackets.
const ELAPSED_TOKEN = /^(?:\d+min|\d+h\d{2}m)$/u;
const CLOCK_TOKEN = /^\d{2}:\d{2}$/u;

// Model and engine names: `opus`, `fable`, `gpt-5.6-sol`, `claude:opus`. Kept
// narrow on purpose — a bracket group that is not a name shape is left alone
// rather than mangled, because this tool must never rewrite a step's title.
const EXECUTOR_SLOT = /^[A-Za-z][A-Za-z0-9.:-]*$/u;

// `<n>min` under an hour, `<n>h<mm>m` at or over it, per the dev skill's panel
// contract. Minutes are rounded, not truncated: a 59-second step reading `0min`
// says the step was free, which is the one thing a cost profile must not say.
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}min`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatClock(epochMs) {
  const at = new Date(epochMs);
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

// Upper-cases the executor slot wherever it sits, and only it. Elapsed and
// clock tokens are this tool's own output and are never touched.
export function normaliseExecutorSlot(subject) {
  return String(subject).replace(/\[([^\]]*)\]/gu, (whole, inner) => {
    if (ELAPSED_TOKEN.test(inner) || CLOCK_TOKEN.test(inner)) return whole;
    if (!EXECUTOR_SLOT.test(inner)) return whole;
    return `[${inner.toUpperCase()}]`;
  });
}

// Already-completed means the subject ENDS with an elapsed token followed by a
// clock token. Anything less is incomplete and gets composed.
function isComplete(subject) {
  const trailing = /\[([^\]]*)\]\s*\[([^\]]*)\]\s*$/u.exec(String(subject));
  return trailing !== null
    && ELAPSED_TOKEN.test(trailing[1])
    && CLOCK_TOKEN.test(trailing[2]);
}

// Returns `{ok, subject}` or `{ok:false, error}`. A composition problem is a
// usage error the caller must see, never a silently unchanged subject: a
// subject that comes back looking untouched is exactly the bare row this tool
// exists to stop shipping.
export function completedSubject(subject, { ms = null, startedAtMs = null, nowMs } = {}) {
  const text = String(subject ?? '').trim();
  if (text === '') return { ok: false, error: 'subject is empty' };
  if (!Number.isFinite(nowMs)) return { ok: false, error: 'no clock reading' };
  const normalised = normaliseExecutorSlot(text);
  if (isComplete(normalised)) return { ok: true, subject: normalised };
  const durationMs = ms !== null
    ? ms
    : startedAtMs !== null ? nowMs - startedAtMs : null;
  if (durationMs === null) {
    return { ok: false, error: 'neither --ms nor --started-at-ms was given' };
  }
  const elapsed = formatElapsed(durationMs);
  if (elapsed === null) return { ok: false, error: `not a duration: ${durationMs}` };
  const clock = formatClock(nowMs);
  if (clock === null) return { ok: false, error: 'clock reading is not a time' };
  return { ok: true, subject: `${normalised} [${elapsed}] [${clock}]` };
}

export function parseArgs(argv) {
  const out = { subject: null, ms: null, startedAtMs: null, error: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--subject') { out.subject = value ?? null; index += 1; continue; }
    if (flag === '--ms' || flag === '--started-at-ms') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        out.error = `${flag} needs a number, got ${value === undefined ? 'nothing' : value}`;
        return out;
      }
      if (flag === '--ms') out.ms = parsed;
      else out.startedAtMs = parsed;
      index += 1;
      continue;
    }
    out.error = `unknown argument ${flag}`;
    return out;
  }
  if (out.subject === null) out.error = '--subject is required';
  return out;
}

function selfTest() {
  const NOW = Date.UTC(2026, 6, 28, 12, 35);
  const clockNow = formatClock(NOW);
  const cases = [
    // [subject, opts, expected]
    ['∞ #123 — 03 PLAN-REVIEW [GPT-5.6-SOL]', { ms: 660_000 },
      `∞ #123 — 03 PLAN-REVIEW [GPT-5.6-SOL] [11min] [${clockNow}]`],
    // The live defect: a bare completed row, now composed rather than recalled.
    ['∞ #123 — 02 PLAN [OPUS]', { ms: 300_000 },
      `∞ #123 — 02 PLAN [OPUS] [5min] [${clockNow}]`],
    // One rule, applied by the mechanism instead of by memory.
    ['∞ #123 — 02 PLAN [opus]', { ms: 60_000 },
      `∞ #123 — 02 PLAN [OPUS] [1min] [${clockNow}]`],
    ['∞ #78 — 08 FIX r3/5 [gpt-5.6-sol]', { ms: 60_000 },
      `∞ #78 — 08 FIX r3/5 [GPT-5.6-SOL] [1min] [${clockNow}]`],
    // At and over an hour, zero-padded, matching the closing rail's 2h09m.
    ['∞ #78 — 05 IMPLEMENT [OPUS]', { ms: 60 * 60_000 },
      `∞ #78 — 05 IMPLEMENT [OPUS] [1h00m] [${clockNow}]`],
    ['∞ #78 — 05 IMPLEMENT [OPUS]', { ms: 129 * 60_000 },
      `∞ #78 — 05 IMPLEMENT [OPUS] [2h09m] [${clockNow}]`],
    // A sub-minute step is cheap, not free.
    ['∞ #78 — 04 CLAIM', { ms: 900 }, `∞ #78 — 04 CLAIM [1min] [${clockNow}]`],
    // In-session steps have no dispatch `ms`; a recorded start is enough.
    ['∞ #78 — 01 PREMISE', { startedAtMs: NOW - 180_000 },
      `∞ #78 — 01 PREMISE [3min] [${clockNow}]`],
    // Idempotent: a resumed unit re-completing a finished task must not grow a
    // second pair of brackets.
    [`∞ #123 — 02 PLAN [OPUS] [5min] [${clockNow}]`, { ms: 300_000 },
      `∞ #123 — 02 PLAN [OPUS] [5min] [${clockNow}]`],
    // Steps the orchestrator runs itself take no executor slot at all.
    ['∞ #78 — 09 GATE', { ms: 120_000 }, `∞ #78 — 09 GATE [2min] [${clockNow}]`],
  ];
  let fail = 0;
  for (const [subject, opts, expected] of cases) {
    const got = completedSubject(subject, { ...opts, nowMs: NOW });
    if (!got.ok || got.subject !== expected) {
      fail += 1;
      console.error(`FAIL [${expected}]: got ${got.ok ? got.subject : got.error}`);
    }
  }
  const checks = [
    ['an empty subject is a usage error',
      completedSubject('  ', { ms: 1, nowMs: NOW }).ok === false],
    ['a subject with no duration is a usage error, not a bare passthrough',
      completedSubject('∞ #1 — 02 PLAN', { nowMs: NOW }).ok === false],
    ['a negative duration is refused rather than rendered',
      formatElapsed(-1) === null && formatElapsed(Number.NaN) === null],
    // The title is the step's, not this tool's: only name-shaped slots move.
    ['a non-name bracket group is left exactly as written',
      normaliseExecutorSlot('∞ #1 — 02 PLAN [see docs/agentic] [opus]')
        === '∞ #1 — 02 PLAN [see docs/agentic] [OPUS]'],
    ['an appended clock token is never upper-cased into nonsense',
      normaliseExecutorSlot('∞ #1 — 02 PLAN [OPUS] [11min] [14:35]')
        === '∞ #1 — 02 PLAN [OPUS] [11min] [14:35]'],
    ['a clock reads local 24-hour time', /^\d{2}:\d{2}$/u.test(formatClock(NOW))],
    ['--ms wins over --started-at-ms when both are given',
      completedSubject('∞ #1 — 02 PLAN', { ms: 60_000, startedAtMs: NOW - 6_000_000, nowMs: NOW })
        .subject.includes('[1min]')],
    ['a missing --subject is refused', parseArgs(['--ms', '5']).error !== null],
    ['a non-numeric --ms is refused', parseArgs(['--subject', 'x', '--ms', 'soon']).error !== null],
    ['an unknown argument is refused', parseArgs(['--colour', 'yellow']).error !== null],
    ['a well-formed invocation parses', parseArgs(['--subject', 'x', '--ms', '5']).error === null],
  ];
  for (const [name, ok] of checks) {
    if (!ok) { fail += 1; console.error(`FAIL ${name}`); }
  }
  const total = cases.length + checks.length;
  console.log(fail === 0 ? `self-test OK (${total} cases)` : `self-test: ${fail} FAILED`);
  return fail === 0;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== null) {
    console.error(`step-subject: ${parsed.error}`);
    process.exit(1);
  }
  const composed = completedSubject(parsed.subject, {
    ms: parsed.ms,
    startedAtMs: parsed.startedAtMs,
    nowMs: Date.now(),
  });
  if (!composed.ok) {
    console.error(`step-subject: ${composed.error}`);
    process.exit(1);
  }
  console.log(composed.subject);
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
