#!/usr/bin/env node
// Run-scope contract for the autoloop — queue draining is the DEFAULT; a run is bounded only
// when the CURRENT invocation says so explicitly.
//
// Incident this encodes (2026-07-21): invoked with "let's go, loop it!", the orchestrator
// finished one unit and parked, misreading STATE's timeless supervised-first-run guidance as an
// active one-unit bound. The scope of a run is a property of the INVOCATION, never of repo
// state: STATE prose, direct skill invocation, an absent `/goal`, and repo age/PR history carry
// ZERO scope signal.
//
//   resolveScope(text)   — the CURRENT invocation text only. Bounded ONLY on explicit markers:
//                          "take/do/run/process/ship ONE issue|unit", "stop after one issue",
//                          "only|just #N", "maxUnits: N". Everything else → queue. A queue-scoped
//                          invocation that explicitly opts in ("auto-continue", "keep going across
//                          sessions") or carries a relaunch marker also resolves `autoContinue`
//                          (+ the relaunch `generation`); bounded scope never auto-continues.
//   validateStop(facts)  — with eligible work remaining, ending the run requires one of:
//                          wall-clock-cap · context-budget · invocation-bound-reached (bound
//                          actually met) · guardrail-failure. queue-exhausted is valid only
//                          when nothing eligible remains. Anything else — "supervised first
//                          run" included — is refused: take the next unit instead of parking.
//
// Auto-continue relaunch chain (opencode: no native /loop). When a queue-draining run parks on
// `context-budget` with eligible work AND opted in, the dev skill writes a self-contained relaunch
// request that the vendored opencode plugin executes as a FRESH session — draining the queue across
// the context boundary without mid-flight compaction. Two independent bounds keep it finite:
//   shouldWriteRelaunch(facts) — a session requests relaunch ONLY if it opted in, is queue-scoped,
//                          shipped ≥1 unit this session (the PROGRESS gate: a finite queue + forward
//                          progress ⇒ termination), eligible work remains, and the chain is under
//                          MAX_RELAUNCH_GENERATIONS (a hard ceiling independent of the progress
//                          logic being bug-free).
//   buildRelaunchRequest(facts) — the marker JSON `{ v, generation, prompt }`; the prompt re-opts-in
//                          and embeds `[autoloop-relaunch gen=N]`, so the next session's resolveScope
//                          re-resolves autoContinue + generation and the chain self-propagates.
// The skill runs at generation G (resolveScope(...).generation ?? 0) and, if shouldWriteRelaunch,
// writes buildRelaunchRequest({ ..., generation: G + 1 }).
//
// CLI: node tools/agentic/run-scope.mjs "<invocation text>"   → status-line fragment, e.g.
//      `scope queue` · `scope queue+auto` · `scope bounded(1)` · `scope bounded(#52)`; empty argv
//      reads stdin. --self-test runs the fixtures.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STOP_REASONS = ['queue-exhausted', 'wall-clock-cap', 'context-budget', 'invocation-bound-reached', 'guardrail-failure'];
// Hard ceiling on relaunch-chain length — a backstop against a runaway spawn loop that does not
// rely on the progress gate being correct. A real single-chain drain shipping this many units is
// already enormous; past it the human relaunches. Not silent: the skill reports hitting it.
const MAX_RELAUNCH_GENERATIONS = 25;

export function resolveScope(text) {
  if (typeof text !== 'string') return { scope: 'queue' };

  const only = text.match(/\b(?:only|just)\s+(?:issue\s+)?#(\d+)\b/i);
  if (only) return { scope: 'bounded', maxUnits: 1, issue: Number(only[1]) };

  const max = text.match(/\bmaxUnits\s*[:=]\s*(\d+)\b/i);
  if (max) {
    const n = Number(max[1]);
    return n > 0 ? { scope: 'bounded', maxUnits: n } : { scope: 'queue' };
  }

  if (/\b(?:take|do|run|process|complete|ship)\s+(?:just\s+|only\s+)?one\s+(?:issue|unit)\b/i.test(text)
    || /\bstop\s+after\s+(?:just\s+)?one\s+(?:issue|unit)\b/i.test(text)) {
    return { scope: 'bounded', maxUnits: 1 };
  }

  // Queue scope — resolve the auto-continue run modifier. Bounded scope never reaches here, so a
  // bounded run can never auto-continue (never relaunch a run the human explicitly capped).
  const resolved = { scope: 'queue' };
  const gen = text.match(/\[autoloop-relaunch\s+gen=(\d+)\]/i);
  let optedIn = !!gen; // the machine relaunch marker is unconditional; human phrasing must be affirmative
  if (!optedIn) {
    // A false positive here spawns sessions the human didn't ask for — the harmful direction — so
    // require an affirmative trigger: reject a negator just before ("no auto-continue") or just
    // after ("auto-continue is disabled") the phrase.
    const phrase = text.match(/\bauto[-\s]?continue\b|\b(?:relaunch|keep going|continue)\s+across\s+sessions\b/i);
    if (phrase) {
      const before = text.slice(0, phrase.index).slice(-24);
      const after = text.slice(phrase.index + phrase[0].length).slice(0, 20);
      optedIn = !/\b(?:no|not|without|skip|don'?t|disable)\b/i.test(before)
        && !/\b(?:disabled?|off|not)\b/i.test(after);
    }
  }
  if (optedIn) {
    resolved.autoContinue = true;
    if (gen) resolved.generation = Number(gen[1]);
  }
  return resolved;
}

// The canonical relaunch prompt is FIXED — parameterized only by generation — so the opencode plugin
// can validate a marker against it EXACTLY and refuse to execute anything else. A marker is a request
// to run THIS drain, never an arbitrary instruction. The stop condition is NOT embedded: the
// relaunched session re-reads STATE in full at Prime, so STATE stays the single source (no drift, and
// no free text to shell-quote through the --relaunch call).
export const RELAUNCH_PROMPT_PREFIX =
  "Load the autoloop dev skill and drain the queue; auto-continue across sessions; stop per STATE's stop condition.";

export function buildRelaunchRequest({ generation = 1 } = {}) {
  const gen = Number(generation) > 0 ? Number(generation) : 1;
  return { v: 1, generation: gen, prompt: `${RELAUNCH_PROMPT_PREFIX} [autoloop-relaunch gen=${gen}]` };
}

// Whether the session running at `generation` (default 0) should write a relaunch request for the
// next session. All conditions must hold; any false branch parks as today.
export function shouldWriteRelaunch({ autoContinue, scope, unitsCompleted, eligibleRemaining, generation } = {}) {
  if (autoContinue !== true) return false;         // opt-in only — never a surprise default
  if (scope !== 'queue') return false;             // never relaunch a human-capped bounded run
  if (!(Number(unitsCompleted) >= 1)) return false; // progress gate — no forward progress, no relaunch
  if (!(Number(eligibleRemaining) >= 1)) return false; // nothing left to hand off
  if ((Number(generation) || 0) >= MAX_RELAUNCH_GENERATIONS) return false; // hard chain ceiling
  return true;
}

// The park-time decision from structured facts the dev skill supplies (it resolved autoContinue and
// its own generation from the invocation at Prime). autoContinue is a queue-only modifier by
// construction — resolveScope never sets it on bounded scope — so scope is queue here; a bounded run
// passes autoContinue:false and never reaches a write. On a pass, build the NEXT generation's request.
export function decideRelaunch({ autoContinue, generation, unitsCompleted, eligibleRemaining } = {}) {
  const write = shouldWriteRelaunch({ autoContinue, scope: 'queue', unitsCompleted, eligibleRemaining, generation });
  if (!write) return { write: false };
  return { write: true, request: buildRelaunchRequest({ generation: (Number(generation) || 0) + 1 }) };
}

export function validateStop({ eligibleRemaining, scope, maxUnits, unitsCompleted, reason } = {}) {
  if (!STOP_REASONS.includes(reason)) {
    return { ok: false, why: `"${reason}" is not a stop reason — valid: ${STOP_REASONS.join(' · ')}. With eligible work remaining, take the next unit.` };
  }
  const remaining = Number(eligibleRemaining) || 0;
  if (reason === 'queue-exhausted') {
    return remaining === 0
      ? { ok: true, why: 'queue drained' }
      : { ok: false, why: `queue-exhausted claimed with ${remaining} eligible issue(s) remaining — take the next unit.` };
  }
  if (reason === 'invocation-bound-reached') {
    if (scope !== 'bounded') return { ok: false, why: 'invocation-bound-reached requires a bounded scope — this invocation set none, so the default is queue draining.' };
    if (!(Number(unitsCompleted) >= Number(maxUnits))) {
      return { ok: false, why: `bound is ${maxUnits} unit(s); only ${Number(unitsCompleted) || 0} completed — the bound is not reached.` };
    }
    return { ok: true, why: `invocation bound of ${maxUnits} unit(s) reached` };
  }
  return { ok: true, why: reason };
}

export function formatScope(resolved) {
  if (resolved.scope !== 'bounded') return resolved.autoContinue ? 'scope queue+auto' : 'scope queue';
  return resolved.issue !== undefined ? `scope bounded(#${resolved.issue})` : `scope bounded(${resolved.maxUnits})`;
}

function selfTest() {
  const scopeCases = [
    ["let's go, loop it!", { scope: 'queue' }],
    ['drain the queue', { scope: 'queue' }],
    ['take ONE issue and stop', { scope: 'bounded', maxUnits: 1 }],
    ['only #52', { scope: 'bounded', maxUnits: 1, issue: 52 }],
    ['maxUnits: 3', { scope: 'bounded', maxUnits: 3 }],
    ['maxUnits=2', { scope: 'bounded', maxUnits: 2 }],
    ['Take one issue and stop.', { scope: 'bounded', maxUnits: 1 }],
    ['do just one unit', { scope: 'bounded', maxUnits: 1 }],
    ['stop after one issue', { scope: 'bounded', maxUnits: 1 }],
    ['just #7 please', { scope: 'bounded', maxUnits: 1, issue: 7 }],
    ['only issue #9', { scope: 'bounded', maxUnits: 1, issue: 9 }],
    ['run an autoloop cycle', { scope: 'queue' }],
    ['work through issues #52 and #53', { scope: 'queue' }],
    ['one issue at a time', { scope: 'queue' }],
    ['fix the login bug and ship it', { scope: 'queue' }],
    ['/goal every open loop-ready issue is claimed or blocked', { scope: 'queue' }],
    ['', { scope: 'queue' }],
    [undefined, { scope: 'queue' }],
    // auto-continue run modifier (queue scope only)
    ['drain the queue and auto-continue', { scope: 'queue', autoContinue: true }],
    ['loop it, auto continue across sessions', { scope: 'queue', autoContinue: true }],
    ['keep going across sessions', { scope: 'queue', autoContinue: true }],
    ['relaunch across sessions until the queue is empty', { scope: 'queue', autoContinue: true }],
    ['drain; auto-continue. [autoloop-relaunch gen=3]', { scope: 'queue', autoContinue: true, generation: 3 }],
    ['just a normal drain, no auto continue mention', { scope: 'queue' }],
    // bounded scope must NEVER auto-continue, even if the words appear
    ['take ONE issue and stop, then auto-continue', { scope: 'bounded', maxUnits: 1 }],
    ['only #52, auto-continue across sessions', { scope: 'bounded', maxUnits: 1, issue: 52 }],
  ];
  const relaunchWriteCases = [
    ['opted in · progress · eligible · gen 0', { autoContinue: true, scope: 'queue', unitsCompleted: 1, eligibleRemaining: 2, generation: 0 }, true],
    ['opted in · no generation field (first opt-in)', { autoContinue: true, scope: 'queue', unitsCompleted: 3, eligibleRemaining: 1 }, true],
    ['not opted in', { autoContinue: false, scope: 'queue', unitsCompleted: 1, eligibleRemaining: 2 }, false],
    ['bounded scope', { autoContinue: true, scope: 'bounded', unitsCompleted: 1, eligibleRemaining: 2 }, false],
    ['no progress this session', { autoContinue: true, scope: 'queue', unitsCompleted: 0, eligibleRemaining: 2 }, false],
    ['nothing eligible left', { autoContinue: true, scope: 'queue', unitsCompleted: 2, eligibleRemaining: 0 }, false],
    ['generation at the cap', { autoContinue: true, scope: 'queue', unitsCompleted: 1, eligibleRemaining: 2, generation: MAX_RELAUNCH_GENERATIONS }, false],
    ['generation one under the cap', { autoContinue: true, scope: 'queue', unitsCompleted: 1, eligibleRemaining: 2, generation: MAX_RELAUNCH_GENERATIONS - 1 }, true],
  ];
  const stopCases = [
    ['refuse supervised-first-run', { eligibleRemaining: 1, scope: 'queue', reason: 'supervised-first-run' }, false],
    ['refuse free-text reason', { eligibleRemaining: 2, scope: 'queue', reason: 'done for now' }, false],
    ['refuse empty reason', { eligibleRemaining: 1, scope: 'queue', reason: '' }, false],
    ['wall-clock with work left', { eligibleRemaining: 3, scope: 'queue', reason: 'wall-clock-cap' }, true],
    ['context budget with work left', { eligibleRemaining: 1, scope: 'queue', reason: 'context-budget' }, true],
    ['guardrail failure', { eligibleRemaining: 1, scope: 'queue', reason: 'guardrail-failure' }, true],
    ['bound reached', { eligibleRemaining: 1, scope: 'bounded', maxUnits: 1, unitsCompleted: 1, reason: 'invocation-bound-reached' }, true],
    ['bound not reached', { eligibleRemaining: 1, scope: 'bounded', maxUnits: 2, unitsCompleted: 1, reason: 'invocation-bound-reached' }, false],
    ['bound claimed in queue scope', { eligibleRemaining: 1, scope: 'queue', reason: 'invocation-bound-reached' }, false],
    ['queue exhausted, none left', { eligibleRemaining: 0, scope: 'queue', reason: 'queue-exhausted' }, true],
    ['queue exhausted claimed early', { eligibleRemaining: 2, scope: 'queue', reason: 'queue-exhausted' }, false],
  ];
  const formatCases = [
    [{ scope: 'queue' }, 'scope queue'],
    [{ scope: 'queue', autoContinue: true }, 'scope queue+auto'],
    [{ scope: 'bounded', maxUnits: 1 }, 'scope bounded(1)'],
    [{ scope: 'bounded', maxUnits: 1, issue: 52 }, 'scope bounded(#52)'],
  ];

  let fail = 0;
  for (const [text, want] of scopeCases) {
    const got = resolveScope(text);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fail++; console.error(`FAIL resolveScope(${JSON.stringify(text)}) → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }
  for (const [name, facts, want] of stopCases) {
    const got = validateStop(facts);
    if (got.ok !== want) { fail++; console.error(`FAIL validateStop ${name} → ${JSON.stringify(got)}, want ok=${want}`); }
  }
  for (const [resolved, want] of formatCases) {
    const got = formatScope(resolved);
    if (got !== want) { fail++; console.error(`FAIL formatScope → ${got}, want ${want}`); }
  }
  for (const [name, facts, want] of relaunchWriteCases) {
    const got = shouldWriteRelaunch(facts);
    if (got !== want) { fail++; console.error(`FAIL shouldWriteRelaunch ${name} → ${got}, want ${want}`); }
  }
  // buildRelaunchRequest: the prompt is EXACTLY the canonical template (the plugin validates against
  // it), parameterized only by generation — no free text, no stop condition embedded.
  let inlineChecks = 0;
  const inlineCheck = (cond, msg) => { inlineChecks += 1; if (!cond) { fail++; console.error(msg); } };
  const req = buildRelaunchRequest({ generation: 2 });
  inlineCheck(
    req.v === 1 && req.generation === 2 && req.prompt === `${RELAUNCH_PROMPT_PREFIX} [autoloop-relaunch gen=2]`,
    `FAIL buildRelaunchRequest exact shape → ${JSON.stringify(req)}`,
  );
  inlineCheck(buildRelaunchRequest().generation === 1, 'FAIL buildRelaunchRequest default generation');
  // Round-trip invariant: a relaunch prompt must re-resolve to autoContinue at the SAME generation,
  // so the chain self-propagates without drift.
  const rt = resolveScope(buildRelaunchRequest({ generation: 4 }).prompt);
  inlineCheck(
    JSON.stringify(rt) === JSON.stringify({ scope: 'queue', autoContinue: true, generation: 4 }),
    `FAIL relaunch round-trip → ${JSON.stringify(rt)}`,
  );
  // decideRelaunch: structured facts → gate → next-generation request.
  const decideCases = [
    ['opted-in first park advances to gen 1',
      { autoContinue: true, generation: 0, unitsCompleted: 1, eligibleRemaining: 2 },
      (d) => d.write === true && d.request.generation === 1],
    ['gen 2 advances to gen 3',
      { autoContinue: true, generation: 2, unitsCompleted: 1, eligibleRemaining: 1 },
      (d) => d.write === true && d.request.generation === 3],
    ['not opted in → no write',
      { autoContinue: false, generation: 0, unitsCompleted: 1, eligibleRemaining: 2 },
      (d) => d.write === false],
    ['no progress → no write',
      { autoContinue: true, generation: 0, unitsCompleted: 0, eligibleRemaining: 2 },
      (d) => d.write === false],
    ['at the generation cap → no write',
      { autoContinue: true, generation: MAX_RELAUNCH_GENERATIONS, unitsCompleted: 1, eligibleRemaining: 1 },
      (d) => d.write === false],
  ];
  for (const [name, input, ok] of decideCases) {
    const d = decideRelaunch(input);
    if (!ok(d)) { fail++; console.error(`FAIL decideRelaunch ${name} → ${JSON.stringify(d)}`); }
  }
  const total = scopeCases.length + stopCases.length + formatCases.length + relaunchWriteCases.length + inlineChecks + decideCases.length;
  console.log(fail === 0 ? `self-test OK (${total} cases)` : `self-test: ${fail} FAILED`);
  return fail === 0;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

  // --relaunch: the dev skill's context-budget park calls this. On a write, prints the marker JSON
  // to stdout (skill redirects it to .git/autoloop/relaunch-request) and exits 0; otherwise exits 3
  // with the reason on stderr (park as today). All flags are simple tokens (0/1/integers) — no free
  // text crosses the shell, so nothing to quote. Usage:
  //   run-scope.mjs --relaunch --auto <0|1> --generation <N> --units <N> --eligible <N>
  if (process.argv.includes('--relaunch')) {
    const flag = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
    const decision = decideRelaunch({
      autoContinue: flag('--auto') === '1',
      generation: Number(flag('--generation')) || 0,
      unitsCompleted: Number(flag('--units')),
      eligibleRemaining: Number(flag('--eligible')),
    });
    if (decision.write) {
      console.log(JSON.stringify(decision.request));
      process.exit(0);
    }
    console.error('relaunch: conditions not met (opt-in + >=1 unit + eligible work + under generation cap) — parking');
    process.exit(3);
  }

  let text = process.argv.slice(2).join(' ');
  if (!text) {
    try { text = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  }
  console.log(formatScope(resolveScope(text)));
}
