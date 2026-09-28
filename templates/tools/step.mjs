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

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  const failures = checks.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${checks.length} cases)`
    : `self-test FAILED (${failures.length}/${checks.length})`);
  return failures.length === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.error('usage: step.mjs --self-test');
  process.exit(2);
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
