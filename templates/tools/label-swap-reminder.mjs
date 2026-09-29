#!/usr/bin/env node
// autoloop — label-swap-reminder.mjs (PostToolUse hook, Bash matcher)
// Vendored into the host repo by autoloop:setup; runs from the repo, never the plugin.
//
// The dev/pitcrew skills anchor chat markers — the unit banner, the step ribbon,
// the closing rail — and the terminal push notification to label swaps ("riders
// ride the mandatory action"). Prose anchoring alone has been observed to drop
// riders and skip swaps under load, so this hook makes the anchor mechanical:
// whenever a loop command runs (a step.mjs call, a dispatch, prime, finalize,
// a block), it injects the concrete rider due at that moment. Every rider names only
// surfaces that exist: riders once demanded the host task tools (TaskCreate/
// TaskUpdate) after the harness had removed them, and two of three impossible
// riders per swap taught a live run to ignore the possible one too.
// A hook must never break the loop: any parse problem exits 0 with no output.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { activeAutoloopRoot } from './hook-root.mjs';

// Claude Code 2.1.234 removed the task tools outright but only DEFERRED
// PushNotification; a live run read the visible roster as the whole roster,
// declared the notifier nonexistent, and dropped every delivery notification
// while a working tool sat one ToolSearch away.
const PUSH_NOTE = ' — DEFERRED on newer hosts, not absent: ToolSearch("select:PushNotification")'
  + ' loads it; report the send result, and only a host that cannot load it may say so on the'
  + ' rail instead;';

// Per-step extras: nudges that ride the step's `step.mjs --to` call (naming ≠ loading).
const EXTRAS = {
  '02-plan': ' The plan must NAME the guidance-mapped domain skills (the repo CLAUDE.md/AGENTS.md'
    + ' mapping) and carry the literal `## Constraints` section distilling them — the plan'
    + ' reviewer flags both when missing.',
  '06-simplify': ' Dispatch ONE behavior-preserving simplify pass (`--role simplify`, routed) whose'
    + ' prompt loads `agent-skills:code-simplification` and carries the measured diff vs the'
    + " plan's line budget; tests green before it returns, test files unedited, behavior frozen."
    + ' Verify the returned diff yourself — a behavior change is reverted, not fixed.',
  '07-diff-review': ' Load `agent-skills:code-review-and-quality` AND the domain skills the plan'
    + ' named via the Skill tool in THIS message — naming in the plan is not loading; reviewing'
    + ' bare is a skipped rider. Plain run: the review is a `--role diff-review` dispatch.',
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
  [/config-contract\.mjs\s+--root\b/,
    'autoloop: the AUDIT battery just ran — `⏳ ∞ ▰▰▱▱▱ 2/5 AUDIT` must already be printed; print '
    + 'it NOW if missing. Next: `⏳ ∞ ▰▰▰▱▱ 3/5 INTERVIEW` BEFORE the first question to the human.'],
  [/setup\.mjs\s+--(?:init|devendor)\b/,
    'autoloop: WRITE is running — `⏳ ∞ ▰▰▰▰▱ 4/5 WRITE` must already be printed (and 3/5 '
    + 'INTERVIEW before it); print any missing ribbon NOW. Next: `⏳ ∞ ▰▰▰▰▰ 5/5 VERIFY` when '
    + 'evidence collection starts.'],
  [/verify\.mjs\s+--project-root\b/,
    'autoloop: project verify just ran — in a setup session `⏳ ∞ ▰▰▰▰▰ 5/5 VERIFY` must '
    + 'already be printed; print it NOW if missing. The closing rail `✅ ╰─ ∞ setup · complete …` '
    + 'is the only green line.'],
];

// Returns null when the command is not a loop-label swap on an issue.
// opts.archMap: docs/agentic/ARCH.md exists → step 6 also reminds the map update.
export function reminderFor(command, opts = {}) {
  if (typeof command !== 'string') return null;
  if (/\bstep\.mjs\b/.test(command)) return stepReminder(command, opts);

  for (const [pattern, message] of SETUP_PHASE_ANCHORS) {
    if (pattern.test(command)) return message;
  }

  // The run frame and the panel probe have no label to ride; prime is the
  // command every run inevitably starts with, so they ride prime.
  if (/\bprime\.mjs\b/.test(command)) {
    return "autoloop: prime just ran — if this is a Dev run's FIRST successful prime, the run "
      + 'frame `┏━━ ∞ RUN OPEN · <HH:MM> ━━…` prints NOW, exactly once (a resume or mid-run '
      + 're-prime never reprints it). In the same turn load the terminal notifier once via '
      + 'ToolSearch("select:PushNotification") — on newer hosts it is DEFERRED, not absent.';
  }

  // terminal-finalize performs the delivered label mutations itself, so no
  // `gh issue edit` ever fires the terminal riders on this path — a live
  // 0.49.44 run shipped a unit with no closing rail and no notification.
  if (/publish-verdict\.mjs\s+terminal-finalize\b/.test(command)) {
    return 'autoloop: terminal-finalize just ran. The driver swaps the terminal labels itself, '
      + 'so no gh edit will fire the delivered riders — on a delivered result they are due NOW: '
      + '① `step.mjs --to 10-publish` and `--to 11-record` as those steps run (every step is '
      + "announced, no-ops included); ② the unit's card, `step.mjs --card --issue <N> --outcome "
      + "shipped|delivered --pr <P>`, repeated verbatim; ③ PushNotification "
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
      return 'autoloop: an implement-role dispatch just went out — it serves step 05 (writer), '
        + 'step 06 (simplify pass), or a FIX round inside a later step. A fix answering review '
        + 'findings is announced as `step.mjs --to 08-fix --round <r>/<cap>` under the current '
        + 'step (labels only climb). Otherwise the step must ALREADY be announced '
        + '(`step.mjs --issue <N> --to 05-implement`); if not, run it NOW — late beats never.';
    }
    const once = role === 'plan-review'
      ? ' This is the ONE plan review: a Critical/Major on the revised plan is a recorded '
        + 'disposition carried into code-review r1, never a second plan-review dispatch, and '
        + 'the step label never moves back to `loop:02-plan` — next is claim.'
      : '';
    return `autoloop: the ${role} dispatch just went out — step \`${key}\` must ALREADY be `
      + `announced (\`step.mjs --issue <N> --to ${key}\`). If it is not, run it NOW (late beats `
      + `never).${once} A dispatch without its step strands the label timeline — the issue keeps `
      + 'advertising an earlier step, which is how an abandoned run gets mis-reconciled.';
  }

  // unit.mjs --block records the question and swaps the labels itself, so no
  // gh edit fires the blocked riders on this path.
  if (/\bunit\.mjs\b[^\n]*\s--block\b/.test(command)) {
    const n = `#${command.match(/--issue[= ]+(\d+)/)?.[1] ?? '<N>'}`;
    return `autoloop: \`unit.mjs --block\` just ran for ${n}. On an ok result the tool has already `
      + 'posted the question with its `/answer` form and swapped the labels (loop-ready kept), so '
      + `the TERMINAL riders are due NOW: ① the unit's card, \`step.mjs --card --issue `
      + `${n.slice(1)} --outcome human --question "<question>"\`; ② PushNotification `
      + `\`✖ ${n} blocked — <question>\`${PUSH_NOTE} `
      + 'then take the next unit. A typed refusal instead: report it verbatim and follow its remedy.';
  }

  if (!/gh\s+issue\s+edit\b/.test(command)) return null;
  const add = command.match(/--add-label[= ]+["']?([^"'\s]+)/);
  if (!add) return null;
  const labels = add[1].split(',');
  const issue = command.match(/gh\s+issue\s+edit\s+(\d+)/)?.[1];
  const n = issue ? `#${issue}` : '#<N>';

  if (labels.includes('loop-delivered')) {
    return `autoloop: \`loop-delivered\` landed for ${n} — TERMINAL riders due NOW, same message or the next: `
      + '① `step.mjs --to` for any late step not yet announced (10-publish, 11-record); '
      + `② the unit's card, \`step.mjs --card --issue ${n.slice(1)} --outcome shipped|delivered `
      + '--pr <P>`; '
      + `③ PushNotification \`✔ ${n} PR #<P> ready for your merge · <elapsed>\`${PUSH_NOTE} `
      + `④ remove \`loop-started\` and every \`loop:*\` step label still on the issue.`;
  }
  if (labels.includes('loop-blocked')) {
    return `autoloop: \`loop-blocked\` landed for ${n} — TERMINAL riders due NOW, same message or the next: `
      + `① the unit's card, \`step.mjs --card --issue ${n.slice(1)} --outcome blocked\`; `
      + `② PushNotification \`✖ ${n} blocked — <reason gate>\`${PUSH_NOTE} `
      + `③ a comment recording the reason + gate label, and remove \`loop-started\` `
      + `and every \`loop:*\` step label. KEEP \`loop-ready\`: \`loop-blocked\` already takes the `
      + `issue out of the eligible queue, and \`loop-ready\` is the human's authorization token `
      + `that no loop path may re-apply — stripping it turns their one-label unblock into a `
      + `deadlock the loop cannot leave. `
      + `④ LEGITIMACY: this apply is valid ONLY if THIS run is blocking ${n} NOW, with ③'s fresh `
      + `reason comment. If it "restored" labels inferred from an OLD block comment, you reversed `
      + `a human unblock — a trusted actor removing \`loop-blocked\` IS the unblock decision, the `
      + `exact mirror of \`loop-ready\` (the timeline shows it: \`unlabeled\` events after the `
      + `block comment). Remove the labels you just added and select the unit as ordinary `
      + `eligible work; the stale comment is history, never authority.`;
  }

  const label = (labels.find((l) => l.startsWith('loop:')) || '').trim();
  if (!label) return null;
  const key = label.slice('loop:'.length);

  if (key === 'revising') {
    return `autoloop: \`${label}\` swap ran for ${n}. Riders due in the SAME message as the swap `
      + `(emit any missing one in your NEXT message — late beats never): ① pitcrew take-up banner; `
      + `② its step ribbon. Pitcrew folds into the scoreboard; it never opens dev unit rows.`;
  }
  return null;
}

// A step opens with one step.mjs call; the nudges that belong to a step ride it.
export function stepReminder(command, opts = {}) {
  const key = command.match(/\bstep\.mjs\b[^\n]*--to[= ]+["']?([0-9]{2}-[a-z-]+)/)?.[1];
  if (!key) return null;
  const archNudge = key === '06-simplify' && opts.archMap
    ? ' Structure changed this unit (component/dir/CI path filter/integration point)? Update the'
      + ' curated facts in docs/agentic/ARCH.md on the unit branch now — it must ride this unit\'s'
      + ' review and gate. Never add freshness metadata or a shared timestamp.'
    : '';
  const extra = `${EXTRAS[key] ?? ''}${archNudge}`;
  return extra ? `autoloop: step ${key} opened.${extra}` : null;
}

function selfTest() {
  const cases = [
    // 0.54: a step opens with one step.mjs call; hand step swaps are refused by
    // the guard before they run, so the step's nudges ride step.mjs instead.
    ['node /cache/0.54.0/templates/tools/step.mjs --issue 7 --to 02-plan --model gpt-6-astra', /## Constraints/],
    ['node tools/agentic/step.mjs --issue 5 --to 06-simplify', /agent-skills:code-simplification/],
    ['node tools/agentic/step.mjs --issue 5 --to 07-diff-review', /naming in the plan is not loading/],
    ['node tools/agentic/step.mjs --issue 5 --to 05-implement', null],
    ['node tools/agentic/step.mjs --parked', null],
    ['gh issue edit 12 --remove-label loop-delivered --add-label loop:revising', /pitcrew take-up banner/],
    ['gh issue edit 7 --remove-label loop:09-gate,loop-started --add-label loop-delivered', /PushNotification `✔ #7/],
    ['gh issue edit 7 --remove-label loop:09-gate,loop-started --add-label loop-delivered', /step\.mjs --card --issue 7/],
    ['gh issue edit 7 --remove-label loop:09-gate,loop-started --add-label loop-delivered', /ToolSearch\("select:PushNotification"\)/],
    ['gh issue edit 4 --add-label loop-blocked', /PushNotification `✖ #4/],
    ['gh issue edit 4 --add-label loop-blocked', /--outcome blocked/],
    ['gh issue edit 4 --add-label loop-blocked', /KEEP `loop-ready`/],
    ['gh issue edit 4 --add-label loop-blocked', /reversed a human unblock/],
    ['gh issue edit 293 --add-label loop-blocked,human:decide', /unlabeled` events after the block comment/],
    ['node tools/agentic/unit.mjs --block --issue 12 --reason UNSPECIFIED_VALUE --question "q?"', /--outcome human/],
    ['node tools/agentic/unit.mjs --block --issue 12 --reason UNSPECIFIED_VALUE --question "q?"', /PushNotification `✖ #12/],
    ['node tools/agentic/unit.mjs --decide --issue 12 --choice c --why w', null],
    ['ls /cache | node /cache/0.47.0/templates/tools/release-verify.mjs --sort-versions | tail -3', /1\/5 RESOLVE/],
    ['node /cache/templates/tools/config-contract.mjs --root . --resolve', /2\/5 AUDIT/],
    ['node /cache/templates/tools/setup.mjs --init --root /repo --base main --gate x', /4\/5 WRITE/],
    ['node /cache/templates/tools/setup.mjs --devendor --root /tmp/w', /4\/5 WRITE/],
    ['node /p/templates/tools/verify.mjs --project-root . 2>&1 | tee /tmp/v.txt', /5\/5 VERIFY/],
    // The run frame rides prime; the terminal riders ride terminal-finalize,
    // whose label mutations never pass through gh edit.
    ['node /cache/0.49.45/templates/tools/prime.mjs --json > /tmp/prime.json', /RUN OPEN/],
    ['node /cache/0.49.45/templates/tools/prime.mjs --json', /^(?![\s\S]*task panel)/],
    ['node /x/templates/tools/publish-verdict.mjs terminal-finalize --request-file /tmp/t.json --review-evidence-file /tmp/r.json', /step\.mjs --card/],
    ['node /x/templates/tools/publish-verdict.mjs gate 5e8fce7f17abd16922882ded89ad6dcabbf4d14b', null],
    ['node tools/agentic/dispatch.mjs --role implement --prompt-file /tmp/p.md --json', /--to 05-implement/],
    // A live run at loop:08-code-review dispatched nine implement-role fix
    // rounds and this anchor told it to swap back to 05 every time.
    ['node tools/agentic/dispatch.mjs --role implement --prompt-file /tmp/p.md --json', /--to 08-fix/],
    ['node tools/agentic/dispatch.mjs --role implement --prompt-file /tmp/p.md --json', /labels only climb/],
    ['node tools/agentic/dispatch.mjs --role code-review --prompt-file /tmp/p.md --json', /--to 08-code-review/],
    ['node tools/agentic/dispatch.mjs --role plan-review --prompt-file /tmp/p.md --json', /--to 03-plan-review/],
    // A live run dispatched plan review three times for one plan (r1..r3).
    ['node tools/agentic/dispatch.mjs --role plan-review --prompt-file /tmp/p.md --json', /ONE plan review/],
    ['node tools/agentic/dispatch.mjs --role code-review --prompt-file /tmp/p.md --json', /^(?![\s\S]*ONE plan review)/],
    // A live 0.49.44 run dispatched every role through dispatch-stream.sh and
    // the dispatch anchor, matching only dispatch.mjs, never fired once.
    ['bash /cache/0.49.45/templates/tools/dispatch-stream.sh /tmp/l.jsonl /tmp/r.json --role code-review --prompt-file /tmp/p.md --model x', /--to 08-code-review/],
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
  // The task list is gone (0.54): no rider may ask for a task row.
  for (const [command] of cases) {
    if (typeof command === 'string' && /Task(Create|Update|List)|task row|task panel/.test(reminderFor(command) ?? '')) {
      fail++;
      console.error(`FAIL: a rider still names the task list: ${command}`);
    }
  }
  const withMap = reminderFor('node tools/agentic/step.mjs --issue 5 --to 06-simplify', { archMap: true });
  const withoutMap = reminderFor('node tools/agentic/step.mjs --issue 5 --to 06-simplify', {});
  if (!/ARCH\.md/.test(withMap)) { fail++; console.error('FAIL: archMap:true missing ARCH.md nudge'); }
  if (
    !/Never add freshness metadata/.test(withMap)
    || withMap.includes(`Last${'-'}verified`)
  ) {
    fail++;
    console.error('FAIL: ARCH nudge contradicts the no-freshness-metadata contract');
  }
  if (/ARCH\.md/.test(withoutMap)) { fail++; console.error('FAIL: archMap:false leaked ARCH.md nudge'); }
  // A plugin hook fires in every repository: it reminds only inside a
  // devendored autoloop repository, read from CLAUDE_PROJECT_DIR.
  {
    const scratch = mkdtempSync(join(tmpdir(), 'label-swap-gate-'));
    try {
      const hook = () => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh issue edit 4 --add-label loop-blocked' } }),
        encoding: 'utf8', cwd: tmpdir(), env: { ...process.env, CLAUDE_PROJECT_DIR: scratch },
      }).stdout;
      const unrelated = hook();
      mkdirSync(join(scratch, '.autoloop'));
      writeFileSync(join(scratch, '.autoloop', 'config.json'), '{}');
      const active = hook();
      if (unrelated !== '' || !/PushNotification/.test(active)) {
        fail++;
        console.error('FAIL: the reminder is silent outside an autoloop repository and speaks inside one');
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
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
        const root = activeAutoloopRoot();
        if (root === null) process.exit(0);
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
