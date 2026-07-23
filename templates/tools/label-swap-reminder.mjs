#!/usr/bin/env node
// autoloop — label-swap-reminder.mjs (PostToolUse hook, Bash matcher)
// Vendored into the host repo by autoloop:setup; runs from the repo, never the plugin.
//
// The dev/pitcrew skills anchor chat markers, the Claude Code task rename, and the
// terminal push notification to label swaps ("riders ride the mandatory action").
// Prose anchoring alone has been observed to drop riders and skip swaps under load,
// so this hook makes the anchor mechanical: whenever a Bash command swaps a loop
// label onto an issue, it injects the concrete rider checklist — plus a pointer to
// the NEXT expected swap, so a skipped step label surfaces at the following one.
// A hook must never break the loop: any parse problem exits 0 with no output.

import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const STEPS = {
  '01-premise': 'PREMISE', '02-plan': 'PLAN', '03-plan-review': 'PLAN REVIEW',
  '04-claim': 'CLAIM', '05-implement': 'IMPLEMENT', '06-simplify': 'SIMPLIFY',
  '07-diff-review': 'DIFF REVIEW', '08-code-review': 'CODE REVIEW', '09-gate': 'GATE',
};

// Per-step extras: skill-load riders the dev skill anchors to these swaps (naming ≠ loading).
const EXTRAS = {
  '02-plan': ' The plan must NAME the guidance-mapped domain skills (the repo CLAUDE.md/AGENTS.md'
    + ' mapping) and carry the literal `## Constraints` section distilling them — the plan'
    + ' reviewer flags both when missing.',
  '06-simplify': ' Load `agent-skills:code-simplification` via the Skill tool in THIS message —'
    + ' the swap is the load anchor.',
  '07-diff-review': ' Load `agent-skills:code-review-and-quality` AND the domain skills the plan'
    + ' named via the Skill tool in THIS message — naming in the plan is not loading; reviewing'
    + ' bare is a skipped rider.',
};

// key → [next swap, when it is due]
const NEXT = {
  '01-premise': ['loop:02-plan', 'planning starts'],
  '02-plan': ['loop:03-plan-review', 'the plan-review dispatch goes out'],
  '03-plan-review': ['loop:04-claim', 'the branch is claimed'],
  '04-claim': ['loop:05-implement', 'the implementer dispatch goes out'],
  '05-implement': ['loop:06-simplify', 'simplification starts'],
  '06-simplify': ['loop:07-diff-review', 'the diff review starts'],
  '07-diff-review': ['loop:08-code-review', 'the fresh code-review dispatch goes out'],
  '08-code-review': ['loop:09-gate', 'the gate runs'],
  '09-gate': ['loop-delivered (or loop-blocked)', 'the unit reaches its terminal state'],
};

// Returns null when the command is not a loop-label swap on an issue.
// opts.archMap: docs/agentic/ARCH.md exists → step 6 also reminds the map update.
export function reminderFor(command, opts = {}) {
  if (typeof command !== 'string') return null;
  if (!/gh\s+issue\s+edit\b/.test(command)) return null;
  const add = command.match(/--add-label[= ]+["']?([^"'\s]+)/);
  if (!add) return null;
  const labels = add[1].split(',');
  const issue = command.match(/gh\s+issue\s+edit\s+(\d+)/)?.[1];
  const n = issue ? `#${issue}` : '#<N>';

  if (labels.includes('loop-delivered')) {
    return `autoloop: \`loop-delivered\` landed for ${n} — TERMINAL riders due NOW, same message or the next: `
      + `① end banner \`✔ ISSUE ${n} DONE — PR #<P> ready · gate green\`; `
      + `② final TaskUpdate \`${n} · ✔ delivered — PR #<P> · <elapsed>\` + status completed; `
      + `③ PushNotification \`✔ ${n} PR #<P> ready for your merge · <elapsed>\` — report the send result; `
      + `④ remove \`loop-started\` and every \`loop:*\` step label still on the issue.`;
  }
  if (labels.includes('loop-blocked')) {
    return `autoloop: \`loop-blocked\` landed for ${n} — TERMINAL riders due NOW, same message or the next: `
      + `① end banner \`✖ ISSUE ${n} BLOCKED — <composed reason>\`; `
      + `② final TaskUpdate \`${n} · ✖ blocked — <reason>\` + status completed; `
      + `③ PushNotification \`✖ ${n} blocked — <reason gate>\` — report the send result; `
      + `④ a comment recording the reason + gate label, and remove \`loop-ready\`, \`loop-started\`, `
      + `and every \`loop:*\` step label.`;
  }

  const label = (labels.find((l) => l.startsWith('loop:')) || '').trim();
  if (!label) return null;
  const key = label.slice('loop:'.length);

  if (key === 'revising') {
    return `autoloop: \`${label}\` swap ran for ${n}. Riders due in the SAME message as the swap `
      + `(emit any missing one in your NEXT message — late beats never): ① pitcrew take-up banner; `
      + `② step line. Task rows are the dev loop's; pitcrew folds into the scoreboard.`;
  }
  const step = STEPS[key];
  if (!step) return null;
  const s = Number(key.slice(0, 2));
  const entry = key === '01-premise'
    ? `① unit banner; ② TaskCreate \`${n} · <composed title>\` (Claude Code); ③ step line \`▶ ${n} · step 1/11 — PREMISE (orchestrator)\``
    : `① step line \`▶ ${n} · step ${s}/11 — ${step} (<actor>)\`; ② TaskUpdate rename \`${n} · ${s}/11 ${step} — <composed title>\` + activeForm (Claude Code task mirror; refresh with \` · <unit elapsed>\` at each ~3-min heartbeat while this step waits)`;
  const [nextLabel, nextWhen] = NEXT[key];
  const archNudge = key === '06-simplify' && opts.archMap
    ? ` Structure changed this unit (component/dir/CI path filter/integration point)? Update docs/agentic/ARCH.md (+ its Last-verified line) on the unit branch now — it must ride this unit's review and gate.`
    : '';
  return `autoloop: \`${label}\` swap ran for ${n}. Riders due in the SAME message as the swap `
    + `(missing one? emit it in your NEXT message — late beats never): ${entry}.${EXTRAS[key] ?? ''}${archNudge} `
    + `Next: swap \`${nextLabel}\` when ${nextWhen} — a skipped swap strands labels and blinds the timing telemetry.`;
}

function selfTest() {
  const cases = [
    ['gh issue edit 7 --remove-label loop:01-premise --add-label loop:02-plan', /step 2\/11 — PLAN/],
    ['gh issue edit 7 --add-label loop:02-plan', /Next: swap `loop:03-plan-review`/],
    ['gh issue edit 9 --add-label loop-started,loop:01-premise', /TaskCreate `#9/],
    ['gh issue edit 7 --remove-label loop:03-plan-review --add-label loop:04-claim', /Next: swap `loop:05-implement`/],
    ['gh issue edit 12 --remove-label loop-delivered --add-label loop:revising', /pitcrew take-up banner/],
    ['gh issue edit 12 --add-label "loop:09-gate"', /step 9\/11 — GATE/],
    ['gh issue edit 5 --remove-label loop:05-implement --add-label loop:06-simplify', /step 6\/11 — SIMPLIFY/],
    ['gh issue edit 5 --add-label loop:06-simplify', /code-simplification/],
    ['gh issue edit 7 --add-label "loop:02-plan"', /## Constraints/],
    ['gh issue edit 5 --remove-label loop:06-simplify --add-label loop:07-diff-review', /naming in the plan is not loading/],
    ['gh issue edit 7 --remove-label loop:09-gate,loop-started --add-label loop-delivered', /PushNotification `✔ #7/],
    ['gh issue edit 4 --add-label loop-blocked --remove-label loop-ready', /PushNotification `✖ #4/],
    ['gh label create loop:02-plan --force', null],
    ['gh issue edit 4 --add-label needs-dependency', null],
    ['gh pr edit 4 --add-label loop:02-plan', null],
    ['echo hello', null],
    [undefined, null],
  ];
  let fail = 0;
  for (const [cmd, want] of cases) {
    const got = reminderFor(cmd);
    const ok = want === null ? got === null : typeof got === 'string' && want.test(got);
    if (!ok) { fail++; console.error(`FAIL: ${cmd}\n  got: ${got}`); }
  }
  const withMap = reminderFor('gh issue edit 5 --add-label loop:06-simplify', { archMap: true });
  const withoutMap = reminderFor('gh issue edit 5 --add-label loop:06-simplify', {});
  if (!/ARCH\.md/.test(withMap)) { fail++; console.error('FAIL: archMap:true missing ARCH.md nudge'); }
  if (/ARCH\.md/.test(withoutMap)) { fail++; console.error('FAIL: archMap:false leaked ARCH.md nudge'); }
  console.log(fail === 0 ? `self-test OK (${cases.length} cases)` : `self-test: ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

const entry = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) {
  if (process.argv.includes('--self-test')) selfTest();
  else {
    let raw = '';
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
      try {
        const input = JSON.parse(raw);
        if (input.tool_name !== 'Bash') process.exit(0);
        const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        const msg = reminderFor(input.tool_input?.command, {
          archMap: existsSync(join(root, 'docs/agentic/ARCH.md')),
        });
        if (msg) {
          console.log(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
          }));
        }
      } catch { /* malformed hook input — stay silent, never break the loop */ }
      process.exit(0);
    });
  }
}
