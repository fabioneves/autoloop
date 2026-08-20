#!/usr/bin/env node
// autoloop — label-swap-reminder.mjs (PostToolUse hook, Bash matcher)
// Vendored into the host repo by autoloop:setup; runs from the repo, never the plugin.
//
// The dev/pitcrew skills anchor chat markers — the unit banner, the step ribbon,
// the closing rail — and the terminal push notification to label swaps ("riders
// ride the mandatory action"). Prose anchoring alone has been observed to drop
// riders and skip swaps under load, so this hook makes the anchor mechanical:
// whenever a Bash command swaps a loop label onto an issue, it injects the
// concrete rider checklist — plus a pointer to the NEXT expected swap, so a
// skipped step label surfaces at the following one. Every rider names only
// surfaces that exist: riders once demanded the host task tools (TaskCreate/
// TaskUpdate) after the harness had removed them, and two of three impossible
// riders per swap taught a live run to ignore the possible one too.
// A hook must never break the loop: any parse problem exits 0 with no output.

import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// name, ribbon glyph, dispatched (a dispatched step's ribbon carries the
// model-only executor slot; an orchestrator-run step carries none).
const STEPS = {
  '01-premise': ['PREMISE', '🧭', false],
  '02-plan': ['PLAN', '📐', true],
  '03-plan-review': ['PLAN-REVIEW', '🔬', true],
  '04-claim': ['CLAIM', '📌', false],
  '05-implement': ['IMPLEMENT', '🔨', true],
  '06-simplify': ['SIMPLIFY', '🧹', true],
  '07-diff-review': ['DIFF-REVIEW', '👓', false],
  '08-code-review': ['CODE-REVIEW', '🔍', true],
  '09-gate': ['GATE', '🚦', false],
};

// The ribbon exemplar mirrors the dev skill's step-ribbon grammar exactly, so
// the reminder hands over a line to fill rather than a format to recall.
// [HH:MM] comes from `date +%H:%M` in the same turn, never from memory.
function ribbonFor(n, key) {
  const [name, glyph, dispatched] = STEPS[key];
  const s = Number(key.slice(0, 2));
  const cells = '▰'.repeat(s) + '▱'.repeat(11 - s);
  const slot = dispatched ? ' [<MODEL>]' : '';
  const round = key === '08-code-review' ? ' r<n>/<cap>' : '';
  return `[HH:MM][${n}] ⏳ ∞ ${cells} ${key.slice(0, 2)}/11 ${glyph} ${name}${round}${slot} ─ <detail>`;
}

// Claude Code 2.1.234 removed the task tools outright but only DEFERRED
// PushNotification; a live run read the visible roster as the whole roster,
// declared the notifier nonexistent, and dropped every delivery notification
// while a working tool sat one ToolSearch away.
const PUSH_NOTE = ' — DEFERRED on newer hosts, not absent: ToolSearch("select:PushNotification")'
  + ' loads it; report the send result, and only a host that cannot load it may say so on the'
  + ' rail instead;';

// Per-step extras: skill-load riders the dev skill anchors to these swaps (naming ≠ loading).
const EXTRAS = {
  '02-plan': ' The plan must NAME the guidance-mapped domain skills (the repo CLAUDE.md/AGENTS.md'
    + ' mapping) and carry the literal `## Constraints` section distilling them — the plan'
    + ' reviewer flags both when missing.',
  '06-simplify': ' Dispatch ONE behavior-preserving simplify pass (implement role, fable) whose'
    + ' prompt loads `agent-skills:code-simplification` and carries the measured diff vs the'
    + " plan's line budget; tests green before it returns, test files unedited, behavior frozen."
    + ' Verify the returned diff yourself — a behavior change is reverted, not fixed.',
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

// A dispatch IS the step it serves, which makes it an anchor a skipped swap
// cannot hide behind. Firing only on swaps left this hook blind to the failure
// that actually happens: a live 0.42.3 run swapped 04-claim and then never
// swapped again, running implement, simplify, diff review and two code-review
// rounds while the issue still read `loop:04-claim`. `NEXT` already declares
// these dispatches as the moments 03, 05/06 and 08 come due. Steps 04 and 07
// have no dispatch of their own and stay anchored to the preceding swap's
// pointer — re-arming the chain at 05 is what gets them back. The anchor
// matches dispatch-stream.sh as well as dispatch.mjs: a live 0.49.44 run
// dispatched every role through the stream wrapper and this anchor never fired.
const DISPATCH_STEP = {
  'plan-review': '03-plan-review',
  implement: '05-implement',
  'code-review': '08-code-review',
};

// Setup has no labels, so its phases had no mechanical anchor — and prose alone
// proved intermittent: live runs printed one ribbon of five, then none, then a
// scattered subset, across three wordings. Each phase inevitably runs a
// signature command, so the ribbon rides that command the same way dev's riders
// ride label swaps. First match wins; the reminder names the ribbon due NOW and
// the one after it.
const SETUP_PHASE_ANCHORS = [
  [/release-verify\.mjs\s+--sort-versions/,
    'autoloop: RESOLVE is running — its ribbon `⏳ ∞ ▰▱▱▱▱ 1/5 RESOLVE` must already be printed; '
    + 'print it NOW if missing (late beats never). Next: `⏳ ∞ ▰▰▱▱▱ 2/5 AUDIT` before the audit '
    + 'battery.'],
  [/scaffold\.mjs\s+--audit\b/,
    'autoloop: the AUDIT battery just ran — `⏳ ∞ ▰▰▱▱▱ 2/5 AUDIT` must already be printed; print '
    + 'it NOW if missing. Next: `⏳ ∞ ▰▰▰▱▱ 3/5 INTERVIEW` BEFORE the first question to the human.'],
  [/scaffold\.mjs\s+--(?:reconcile|merge-state|merge-loop)\b/,
    'autoloop: WRITE is running — `⏳ ∞ ▰▰▰▰▱ 4/5 WRITE` must already be printed (and 3/5 '
    + 'INTERVIEW before it); print any missing ribbon NOW. Next: `⏳ ∞ ▰▰▰▰▰ 5/5 VERIFY` when '
    + 'evidence collection starts.'],
  [/verify\.mjs\s+--install-root\b/,
    'autoloop: install-root verify just ran — in a setup session `⏳ ∞ ▰▰▰▰▰ 5/5 VERIFY` must '
    + 'already be printed; print it NOW if missing. The closing rail `✅ ╰─ ∞ setup · complete …` '
    + 'is the only green line.'],
];

// Returns null when the command is not a loop-label swap on an issue.
// opts.archMap: docs/agentic/ARCH.md exists → step 6 also reminds the map update.
export function reminderFor(command, opts = {}) {
  if (typeof command !== 'string') return null;

  for (const [pattern, message] of SETUP_PHASE_ANCHORS) {
    if (pattern.test(command)) return message;
  }

  // The run frame and the panel probe have no label to ride; prime is the
  // command every run inevitably starts with, so they ride prime.
  if (/\bprime\.mjs\b/.test(command)) {
    return "autoloop: prime just ran — if this is a Dev run's FIRST successful prime, the run "
      + 'frame `┏━━ ∞ RUN OPEN · <HH:MM> ━━…` prints NOW, exactly once (a resume or mid-run '
      + 're-prime never reprints it), with the task-panel fate line directly beneath it: probe '
      + 'the host roster — task tools present → `🗒 task panel: mirroring`; absent → `🗒 task '
      + 'panel: none on this host — dispatch descriptions carry the in-flight view`. In the same '
      + 'turn load the terminal notifier once via ToolSearch("select:PushNotification") — on '
      + 'newer hosts it is DEFERRED, not absent.';
  }

  // terminal-finalize performs the delivered label mutations itself, so no
  // `gh issue edit` ever fires the terminal riders on this path — a live
  // 0.49.44 run shipped a unit with no closing rail and no notification.
  if (/publish-verdict\.mjs\s+terminal-finalize\b/.test(command)) {
    return 'autoloop: terminal-finalize just ran. The driver swaps the terminal labels itself, '
      + 'so no gh edit will fire the delivered riders — on a delivered result they are due NOW: '
      + '① ribbons for 10 PUBLISH 📦 and 11 RECORD 📝 as those steps run (every step prints one, '
      + "no-ops included); ② the unit's SHIPPED closing rail with the total; ③ PushNotification "
      + `\`✔ #<N> PR #<P> ready for your merge · <elapsed>\`${PUSH_NOTE} A typed failure `
      + 'instead: report it verbatim and follow its remedy.';
  }

  const dispatchMatch = command.match(
    /dispatch(?:-stream\.sh|\.mjs)\b[^\n]*?--role[= ]+["']?([a-z-]+)/,
  );
  if (dispatchMatch) {
    const role = dispatchMatch[1];
    const key = DISPATCH_STEP[role];
    if (!key) return null;
    if (role === 'implement') {
      return 'autoloop: an implement-role dispatch just went out — it serves step 05 '
        + '(`loop:05-implement`, writer) or step 06 (`loop:06-simplify`, simplify pass). The '
        + "matching label must ALREADY be current on this unit's issue; if not, swap it NOW "
        + "(late beats never) and print the step's ribbon — writer: "
        + `\`${ribbonFor('#<N>', '05-implement')}\`; simplify: `
        + `\`${ribbonFor('#<N>', '06-simplify')}\`. A step that dispatches without swapping `
        + 'strands the label timeline.';
    }
    return `autoloop: the ${role} dispatch just went out — \`loop:${key}\` must ALREADY be the `
      + `current step label on this unit's issue. If it is not, swap it NOW (late beats never) `
      + `and print the step's ribbon \`${ribbonFor('#<N>', key)}\`. A step that dispatches `
      + 'without swapping strands the label timeline — the issue keeps advertising an earlier '
      + 'step, which is how a crashed or abandoned run gets mis-reconciled by the next one.';
  }

  if (!/gh\s+issue\s+edit\b/.test(command)) return null;
  const add = command.match(/--add-label[= ]+["']?([^"'\s]+)/);
  if (!add) return null;
  const labels = add[1].split(',');
  const issue = command.match(/gh\s+issue\s+edit\s+(\d+)/)?.[1];
  const n = issue ? `#${issue}` : '#<N>';

  if (labels.includes('loop-delivered')) {
    return `autoloop: \`loop-delivered\` landed for ${n} — TERMINAL riders due NOW, same message or the next: `
      + '① ribbons for any late steps not yet announced (10 PUBLISH 📦, 11 RECORD 📝 — every '
      + 'step prints one, no-ops included); '
      + `② the unit's closing rail \`[HH:MM][${n}] ✅ ∞ ══ SHIPPED 🎉 ─ PR #<P> · `
      + '<delivered|merged> · <short OID> · <total> ══`; '
      + `③ PushNotification \`✔ ${n} PR #<P> ready for your merge · <elapsed>\`${PUSH_NOTE} `
      + `④ remove \`loop-started\` and every \`loop:*\` step label still on the issue.`;
  }
  if (labels.includes('loop-blocked')) {
    return `autoloop: \`loop-blocked\` landed for ${n} — TERMINAL riders due NOW, same message or the next: `
      + `① the unit's closing rail \`[HH:MM][${n}] ❌ ∞ ══ BLOCKED ─ <safe composed reason> ══\`; `
      + `② PushNotification \`✖ ${n} blocked — <reason gate>\`${PUSH_NOTE} `
      + `③ a comment recording the reason + gate label, and remove \`loop-started\` `
      + `and every \`loop:*\` step label. KEEP \`loop-ready\`: \`loop-blocked\` already takes the `
      + `issue out of the eligible queue, and \`loop-ready\` is the human's authorization token `
      + `that no loop path may re-apply — stripping it turns their one-label unblock into a `
      + `deadlock the loop cannot leave.`;
  }

  const label = (labels.find((l) => l.startsWith('loop:')) || '').trim();
  if (!label) return null;
  const key = label.slice('loop:'.length);

  if (key === 'revising') {
    return `autoloop: \`${label}\` swap ran for ${n}. Riders due in the SAME message as the swap `
      + `(emit any missing one in your NEXT message — late beats never): ① pitcrew take-up banner; `
      + `② its step ribbon. Pitcrew folds into the scoreboard; it never opens dev unit rows.`;
  }
  if (!STEPS[key]) return null;
  const entry = key === '01-premise'
    ? `① unit banner; ② its step ribbon \`${ribbonFor(n, key)}\``
    : `① the step ribbon \`${ribbonFor(n, key)}\`${key === '08-code-review'
      ? ' (its cells count ROUNDS against the configured cap, one ▰ per round done-or-current)'
      : ''}`;
  const [nextLabel, nextWhen] = NEXT[key];
  const archNudge = key === '06-simplify' && opts.archMap
    ? ` Structure changed this unit (component/dir/CI path filter/integration point)? Update the curated facts in docs/agentic/ARCH.md on the unit branch now — it must ride this unit's review and gate. Never add freshness metadata or a shared timestamp.`
    : '';
  return `autoloop: \`${label}\` swap ran for ${n}. Riders due in the SAME message as the swap `
    + `(missing one? emit it in your NEXT message — late beats never): ${entry}. The ribbon IS `
    + `the step's one announcement — never also print a \`▶ … step X/11\` header beside it, and `
    + `never reprint a ribbon already announced.${EXTRAS[key] ?? ''}${archNudge} `
    + `Next: swap \`${nextLabel}\` when ${nextWhen} — a skipped swap strands labels and blinds the timing telemetry.`;
}

function selfTest() {
  const cases = [
    ['gh issue edit 7 --remove-label loop:01-premise --add-label loop:02-plan', /02\/11 📐 PLAN/],
    ['gh issue edit 7 --add-label loop:02-plan', /Next: swap `loop:03-plan-review`/],
    ['gh issue edit 9 --add-label loop-started,loop:01-premise', /unit banner/],
    ['gh issue edit 9 --add-label loop-started,loop:01-premise', /01\/11 🧭 PREMISE/],
    ['gh issue edit 7 --remove-label loop:03-plan-review --add-label loop:04-claim', /Next: swap `loop:05-implement`/],
    ['gh issue edit 12 --remove-label loop-delivered --add-label loop:revising', /pitcrew take-up banner/],
    ['gh issue edit 12 --add-label "loop:09-gate"', /09\/11 🚦 GATE/],
    ['gh issue edit 5 --remove-label loop:05-implement --add-label loop:06-simplify', /06\/11 🧹 SIMPLIFY/],
    ['gh issue edit 5 --add-label loop:06-simplify', /agent-skills:code-simplification/],
    ['gh issue edit 7 --add-label "loop:02-plan"', /## Constraints/],
    ['gh issue edit 5 --remove-label loop:06-simplify --add-label loop:07-diff-review', /naming in the plan is not loading/],
    // A dispatched step's ribbon carries the model-only executor slot; an
    // orchestrator step carries none; 08's cells count rounds, not steps.
    ['gh issue edit 7 --add-label loop:05-implement', /05\/11 🔨 IMPLEMENT \[<MODEL>\]/],
    ['gh issue edit 7 --add-label loop:07-diff-review', /07\/11 👓 DIFF-REVIEW ─/],
    ['gh issue edit 7 --add-label loop:08-code-review', /ROUNDS against the configured cap/],
    ['gh issue edit 7 --add-label loop:08-code-review', /r<n>\/<cap>/],
    // The `▶ … step X/11` header is the duplicate announcement the dev skill
    // bans; the rider that used to demand it now bans it in the same breath.
    ['gh issue edit 7 --add-label loop:05-implement', /never also print a `▶/],
    ['gh issue edit 7 --remove-label loop:09-gate,loop-started --add-label loop-delivered', /PushNotification `✔ #7/],
    ['gh issue edit 7 --remove-label loop:09-gate,loop-started --add-label loop-delivered', /SHIPPED 🎉/],
    ['gh issue edit 7 --remove-label loop:09-gate,loop-started --add-label loop-delivered', /ToolSearch\("select:PushNotification"\)/],
    ['gh issue edit 4 --add-label loop-blocked', /PushNotification `✖ #4/],
    ['gh issue edit 4 --add-label loop-blocked', /══ BLOCKED/],
    ['gh issue edit 4 --add-label loop-blocked', /KEEP `loop-ready`/],
    ['ls /cache | node /cache/0.47.0/templates/tools/release-verify.mjs --sort-versions | tail -3', /1\/5 RESOLVE/],
    ['node /cache/templates/tools/scaffold.mjs --audit .', /2\/5 AUDIT/],
    ['node /cache/templates/tools/scaffold.mjs --reconcile /repo', /4\/5 WRITE/],
    ['node /cache/templates/tools/scaffold.mjs --merge-state . > /tmp/s.md', /4\/5 WRITE/],
    ['node tools/agentic/verify.mjs --install-root . 2>&1 | tee /tmp/v.txt', /5\/5 VERIFY/],
    // The run frame and the panel probe ride prime; the terminal riders ride
    // terminal-finalize, whose label mutations never pass through gh edit.
    ['node /cache/0.49.45/templates/tools/prime.mjs --json > /tmp/prime.json', /RUN OPEN/],
    ['node /cache/0.49.45/templates/tools/prime.mjs --json', /task panel/],
    ['node /x/templates/tools/publish-verdict.mjs terminal-finalize --request-file /tmp/t.json --review-evidence-file /tmp/r.json', /SHIPPED closing rail/],
    ['node /x/templates/tools/publish-verdict.mjs gate 5e8fce7f17abd16922882ded89ad6dcabbf4d14b', null],
    ['node tools/agentic/dispatch.mjs --role implement --prompt-file /tmp/p.md --json', /loop:05-implement/],
    ['node tools/agentic/dispatch.mjs --role implement --prompt-file /tmp/p.md --json', /loop:06-simplify/],
    ['node tools/agentic/dispatch.mjs --role code-review --prompt-file /tmp/p.md --json', /loop:08-code-review/],
    ['node tools/agentic/dispatch.mjs --role plan-review --prompt-file /tmp/p.md --json', /loop:03-plan-review/],
    // A live 0.49.44 run dispatched every role through dispatch-stream.sh and
    // the dispatch anchor, matching only dispatch.mjs, never fired once.
    ['bash /cache/0.49.45/templates/tools/dispatch-stream.sh /tmp/l.jsonl /tmp/r.json --role code-review --prompt-file /tmp/p.md --model x', /loop:08-code-review/],
    ['bash /cache/0.49.45/templates/tools/dispatch-stream.sh /tmp/l.jsonl /tmp/r.json --role doubt-review --prompt-file /tmp/p.md', null],
    ['node tools/agentic/dispatch.mjs --role doubt-review --prompt-file /tmp/p.md', null],
    ['node tools/agentic/lifecycle-driver.mjs --reconcile-json', null],
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
  // No rider may name the removed host task tools: two impossible riders per
  // swap taught a live run to ignore the possible ones too.
  const sample = [
    reminderFor('gh issue edit 9 --add-label loop-started,loop:01-premise'),
    reminderFor('gh issue edit 7 --add-label loop:05-implement'),
    reminderFor('gh issue edit 7 --remove-label loop:09-gate,loop-started --add-label loop-delivered'),
    reminderFor('gh issue edit 4 --add-label loop-blocked'),
  ].join('\n');
  if (/Task(Create|Update|List)/.test(sample)) {
    fail++;
    console.error('FAIL: a rider names the removed host task tools');
  }
  const withMap = reminderFor('gh issue edit 5 --add-label loop:06-simplify', { archMap: true });
  const withoutMap = reminderFor('gh issue edit 5 --add-label loop:06-simplify', {});
  if (!/ARCH\.md/.test(withMap)) { fail++; console.error('FAIL: archMap:true missing ARCH.md nudge'); }
  if (
    !/Never add freshness metadata/.test(withMap)
    || withMap.includes(`Last${'-'}verified`)
  ) {
    fail++;
    console.error('FAIL: ARCH nudge contradicts the no-freshness-metadata contract');
  }
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
