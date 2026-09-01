#!/usr/bin/env node
// autoloop — regression-index.mjs
//
// One executable check per incident this plugin has actually suffered.
//
// `guard-corpus.json` already established the pattern: every case carries a
// `why` naming the run that earned it, so a rule can never be deleted without
// someone reading what it cost. This file extends that discipline past the
// guard, to defects whose enforcer is a self-test case somewhere else in the
// tree.
//
// It does NOT re-test the defects. It asserts that the test which pins each one
// still exists — because the failure mode of a regression suite is not a bad
// assertion, it is a case quietly deleted during a refactor, after which the
// bug is free to return and nothing says so. Every entry names the file and the
// exact text that must survive.
//
// Adding an incident with no enforcer fails. Renaming an enforcing case without
// updating its incident fails. Both are the point.
//
// Usage:
//   node regression-index.mjs [--json]
//   node regression-index.mjs --self-test

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// `anchor` is verbatim source text from `file`. Keep it short enough to survive
// reformatting and specific enough that its presence really means the case is
// still there.
export const INCIDENTS = Object.freeze([
  Object.freeze({
    id: 'the-park-guard-could-not-see-a-dispatch-with-an-explicit-live-file',
    date: '2026-09-01',
    symptom: 'A live run was hard-blocked three times in 70 minutes for '
      + 'ending turns with eligible units queued while a dispatch was '
      + 'demonstrably in flight, and answered the third with "the hook can\'t '
      + 'see the in-flight dispatch". Each block cost a turn of explanation; '
      + 'one usefully forced read-only staging, the others repeated it.',
    cause: 'The park-awareness stream signal reads mtimes under the common '
      + 'dir\'s dispatch-live directory, but the skill\'s own wrapper idiom '
      + 'passes an explicit scratchpad live-file path, so every '
      + 'wrapper-launched dispatch was invisible to it and only the '
      + '30-minute PR-recency signal remained. The process table sees what '
      + 'no launch style hides: a dispatch process whose cwd sits inside one '
      + 'of the repository\'s worktrees.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'writeback-check.mjs',
        anchor: 'function dispatchProcessInFlight(root) {',
      }),
      Object.freeze({
        file: 'writeback-check.mjs',
        anchor: '?? dispatchProcessInFlight(ROOT),',
      }),
      Object.freeze({
        file: 'writeback-check.mjs',
        anchor: "cwdWithinWorktrees('/repo-two', ['/repo']) === false",
      }),
    ]),
  }),
  Object.freeze({
    id: 'the-host-swept-backgrounded-dispatches-and-foreground-survived',
    date: '2026-08-29',
    symptom: 'Across two sessions, explicitly backgrounded dispatch tasks '
      + 'were killed 68-107 seconds in (once 54 minutes in, while returning) '
      + 'with only [killed] on the task, no stderr, no result file — while '
      + 'the identical brief launched as a plain foreground command was '
      + 'auto-backgrounded by the host and ran 619 seconds to completion. '
      + 'Kernel logs showed no OOM; two kills once landed in the same '
      + 'millisecond; the host documentation says an explicitly backgrounded '
      + 'task persists.',
    cause: 'An undocumented host-side sweep of run_in_background tasks — a '
      + 'harness defect, reported upstream. The auto-background handoff is '
      + 'the documented path that demonstrably survives it, so the skill '
      + 'launches dispatches foreground until the sweep stops being observed.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'export function backgroundDispatchProblem(command, runInBackground) {',
      }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'FAIL [background dispatch launch rule]',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'launch dispatches FOREGROUND and let the host background them',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'foreground on Claude Code (host backgrounds it — see the sweep note)',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'A gate\nkilled with only `[killed]` and no log tail is the same sweep',
      }),
    ]),
  }),
  Object.freeze({
    id: 'a-unit-branch-ran-fossil-hooks-for-the-life-of-the-unit',
    date: '2026-08-29',
    symptom: 'A live run ended its turn mid-unit on a promise ("Round 10 is '
      + 'next") with nothing in flight and idled for hours. The dark-run Stop '
      + 'hook that exists to refuse exactly that had been on the repository\'s '
      + 'base branch for hours — but the checkout sat on a unit branch forked '
      + 'two days and three releases earlier, and hooks execute the checkout\'s '
      + 'copy, so a 0.49.58 hook with no dark-run gap ran instead.',
    cause: 'Hooks are wired to $CLAUDE_PROJECT_DIR/tools/agentic/<tool> — '
      + 'deliberately vendored so guard behavior stays under the repo\'s own '
      + 'review — which makes them branch-local: a branch forked before a '
      + 'scaffold reconcile carries fossil guards until it merges. The wiring '
      + 'cannot fix it (the hook command must name a stable path), so the '
      + 'tools relay themselves to the base branch\'s copy.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'hook-relay.mjs',
        anchor: 'export function relayHookToBase(importMetaUrl, argv = process.argv) {',
      }),
      Object.freeze({
        file: 'hook-relay.mjs',
        anchor: 'a drifted branch copy delegates to the base copy with the repo root on the wire',
      }),
      Object.freeze({
        file: 'hook-relay.mjs',
        anchor: 'a base copy that predates the relay contract is never handed the process',
      }),
      Object.freeze({
        file: 'writeback-check.mjs',
        anchor: 'const ROOT = process.env.AUTOLOOP_HOOK_ROOT',
      }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'relayHookToBase(import.meta.url);',
      }),
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'relayHookToBase(import.meta.url);',
      }),
    ]),
  }),
  Object.freeze({
    id: 'the-dark-run-gap-hard-blocked-the-skills-own-park',
    date: '2026-08-28',
    symptom: 'A live run parked twice exactly as the Dev skill prescribes — '
      + 'once with two planner dispatches streaming, once with a 20-minute '
      + 'background verify gate against a just-pushed draft PR — and the '
      + 'Stop hook hard-blocked both turns as a dark run with eligible units '
      + 'queued. The run spent about an hour polling in-turn to appease it.',
    cause: 'checkDarkRun counted the queue but had no notion of in-flight '
      + 'work, so a park (which ends the turn on purpose and is re-invoked by '
      + 'the background completion) was indistinguishable from the abandoned '
      + 'run the gap exists for.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'writeback-check.mjs',
        anchor: 'export function runInFlightEvidence(prs, streamAgeMs, nowMs) {',
      }),
      Object.freeze({
        file: 'writeback-check.mjs',
        anchor: "runInFlightEvidence([], 5_000, nowMs) === 'a dispatch stream is live'",
      }),
      Object.freeze({
        file: 'writeback-check.mjs',
        anchor: 'parked.hard.length === 0 && parked.reminders.length === 1',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'A PARK is not a dark run',
      }),
    ]),
  }),
  Object.freeze({
    id: 'the-captured-root-refusal-named-neither-comment',
    date: '2026-08-28',
    symptom: 'A live run captured the newest lifecycle marker comment id '
      + 'instead of the chain root, and terminal-finalize refused with '
      + '"captured lifecycle root comment is not canonical" — after a '
      + '20-minute gate, with nothing on the wire saying which comment the '
      + 'contract wanted instead.',
    cause: 'resolveLifecycleCommentChain resolves the root itself and holds '
      + 'both ids at the point of refusal, but the message carried neither, '
      + 'so the remedy had to be reverse-engineered from the contract source.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'lifecycle-contract.mjs',
        anchor: "pass the chain's ROOT comment id",
      }),
      Object.freeze({
        file: 'lifecycle-contract.mjs',
        anchor: 'a captured tip id is refused by name, with the root id to use instead',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: "it is\nthe chain's ROOT and stays the captured ID",
      }),
    ]),
  }),
  Object.freeze({
    id: 'the-dispatch-anchor-advised-the-swap-the-guard-refuses',
    date: '2026-08-28',
    symptom: 'A live run at loop:08-code-review dispatched nine implement-'
      + 'role fix rounds, and the label-swap reminder told it each time that '
      + 'loop:05-implement must already be current — the exact backward swap '
      + 'the command guard refuses. The orchestrator overrode the advice by '
      + 'hand every round.',
    cause: 'The implement dispatch anchor knew only steps 05 and 06; a fix '
      + 'round inside a later step was not a case it stated, so its advice '
      + 'contradicted the labels-only-climb rule.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'A fix answering review findings runs under the CURRENT ',
      }),
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'The fix-round case rides the same reminder.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'backward-swap-refusal-prescribed-the-wrong-incident-remedy',
    date: '2026-08-28',
    symptom: 'A live run at loop:08-code-review tried to swap back to '
      + 'loop:05-implement and was refused with "Re-reviewing a revised plan '
      + 'is not a step … continue forward (claim)" — a diagnosis and a remedy '
      + 'that belong to the 03→02 plan-re-review incident, at a step long '
      + 'past claim, with no plan review anywhere in sight.',
    cause: 'The backward-swap rule blocks every descending pair, but its '
      + 'reason string was hardcoded to the incident that motivated the rule. '
      + 'The standing refusal contract — name the token you caught, give a '
      + 'remedy the reader can execute — was violated by the guard\'s own '
      + 'message: the reader at 08 had to reverse-engineer the rule to learn '
      + 'that fix rounds run under the current step label.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'backward-swap refusal names the caught pair and its own remedy',
      }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'The remedy must fit the swap the guard caught',
      }),
      Object.freeze({
        file: 'guard-corpus.json',
        anchor: 'block was right, remedy was wrong',
      }),
    ]),
  }),
  Object.freeze({
    id: 'preflight-called-a-self-contained-proxy-broken',
    date: '2026-08-27',
    symptom: 'A setup run reported "review-engine records a proxied model but '
      + 'ANTHROPIC_BASE_URL is unset — reviews will fail typed" and handed it '
      + 'to the operator as an unresolved blocker. The recording carried '
      + '`@http://127.0.0.1:18765`, the proxy answered 200, and the previous '
      + 'run had completed every review through it.',
    cause: 'The check predates self-contained proxy mode (0.49.2) and kept '
      + 'reading the session environment. Worse than the false alarm was its '
      + 'remedy: dispatchEnvironment spreads process.env, so a session-wide '
      + 'ANTHROPIC_BASE_URL is inherited by EVERY dispatch child including '
      + 'implement and plan — exactly the writers resolveDefaultBaseUrl '
      + 'returns null for. Following the advice would have proxied them.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'session-preflight.sh',
        anchor: 'proxied reviews are self-contained',
      }),
      Object.freeze({
        file: 'session-preflight.sh',
        anchor: 'so writers are proxied too',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'the session\'s own environment is not a prerequisite and not evidence',
      }),
    ]),
  }),
  Object.freeze({
    id: 'hand-assembled-review-evidence-halted-a-run',
    date: '2026-08-27',
    symptom: 'A run reached living-football-engine #314 one step from delivery '
      + '— gate and review both green on the exact head — and halted. The '
      + 'closing full-artifact round had genuinely run and passed; recording '
      + 'it needed a jq append that the permission classifier refused three '
      + 'times, including a minimal one. The unit is still undelivered.',
    cause: 'The closing round was assembled by hand. Every field but four is '
      + 'inherited and the ledger carry-forward is validCumulativeLedger read '
      + 'constructively, yet each unit wrote its own program — five bespoke '
      + '`assemble-evidence-<issue>.jq` files on one host. An ad-hoc program '
      + 'writing review verdicts into an audit artifact is exactly the shape a '
      + 'classifier should refuse, and there was no sanctioned path.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'review-contract.mjs',
        anchor: 'export function appendEscalationRound(evidence, result, options = {}) {',
      }),
      Object.freeze({
        file: 'review-contract.mjs',
        anchor: "name: 'appending the closing round to a clean delta converges the review',",
      }),
      Object.freeze({
        file: 'review-contract.mjs',
        anchor: "name: 'a tool may not stamp a finding verified',",
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: '--append-escalation-round',
      }),
    ]),
  }),
  Object.freeze({
    id: 'auto-merge-refusal-read-as-a-wedge-when-the-finalizer-never-ran',
    date: '2026-08-26',
    symptom: 'living-football-engine #314 / PR #332 was converged, gated, and '
      + 'carried both verdict statuses green on the exact head. After '
      + 'READY_HEAD_BOUND the run went straight to auto-merge, read its refusal '
      + '(draft, issue not delivered, ownership incomplete, no premerge '
      + 'record) as the Copilot ready-trigger wedge, and stopped. The unit is '
      + 'still an unmerged draft.',
    cause: 'publish-verdict terminal-finalize was never invoked for that PR — '
      + 'the last invocation in the session predated it by a day. Every '
      + 'refusal reason was the state the finalizer exists to change, and the '
      + 'executor listed them as six equal blockers with nothing naming the '
      + 'missing step.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'auto-merge.reference.mjs',
        anchor: 'function finalizerHasNotRun(pr) {',
      }),
      Object.freeze({
        file: 'auto-merge.reference.mjs',
        anchor: "name: 'a PR the terminal finalizer never touched says so first',",
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'Declining to invoke the\nfinalizer is not an outcome',
      }),
    ]),
  }),
  Object.freeze({
    id: 'reviewer-briefs-carried-commands-a-reviewer-cannot-run',
    date: '2026-08-25',
    symptom: 'Two code-review round-4 attempts on living-football-engine #313 '
      + 'died three and two minutes in, having spent their whole budget '
      + 'searching the filesystem for a commit the brief told them to inspect '
      + 'with git. Round 3 had passed only because it read files directly.',
    cause: 'A reviewer posture is Glob,Grep,Read — resolveTools refuses Bash '
      + 'for it outright — so every git command written into those briefs was '
      + 'unexecutable. The skill had said "never a command it cannot run" '
      + 'since 0.47 in prose, and the briefs kept carrying them.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'export function reviewerPromptProblem(role, prompt) {',
      }),
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: "'a reviewer brief carrying a shell fence is refused before the engine starts',",
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'REVIEWER_PROMPT_NOT_EXECUTABLE',
      }),
    ]),
  }),
  Object.freeze({
    id: 'a-fail-verdict-with-only-minors-threw-away-two-rounds',
    date: '2026-08-24',
    symptom: 'living-football-engine #310 rounds 4 and 5 both returned real '
      + 'findings and both were rejected as INVALID_REVIEW_VERDICT. The '
      + 'content was recoverable only by scraping the live event stream, and '
      + 'the message named no rule.',
    cause: 'dispatch enforces pass => no Critical/Major and fail => at least '
      + 'one. The brief said to fail on "at least one finding", so a '
      + 'Minor-only round returned `fail` and the envelope was self-'
      + 'inconsistent. The refusal said only "not a valid review verdict" and '
      + 'discarded the findings with the envelope.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'export function reviewVerdictProblem(value) {',
      }),
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: "? { rejectedVerdict: verdict }",
      }),
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: "'an inconsistent verdict names the rule it broke',",
      }),
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'export function reviewEnvelopeStamp(role) {',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'a round that found only Minors is a `pass` that\n  lists them',
      }),
    ]),
  }),
  Object.freeze({
    id: 'a-delta-round-closed-a-review-the-contract-called-clean',
    date: '2026-08-26',
    symptom: 'living-football-engine #314 ran code-review rounds 2 through 5 '
      + 'all delta and converged on one; nobody had read the artifact whole '
      + 'since round 1, four fixes and a near-total test rewrite earlier. '
      + 'Round 4 had already caught an assertion made vacuous two rounds '
      + 'before. The corrective full round could not be recorded at all.',
    cause: '"Convergence closes on a full-artifact round" was 0.46.0 prose. '
      + '`reviewTransition` returned REVIEW_CLEAN for a clean delta round, and '
      + 'the artifactFingerprint-must-differ rule then refused the closing '
      + 'round over unchanged bytes, so noticing the gap late was unfixable.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'review-contract.mjs',
        anchor: "return decision('continue', 'REVIEW_FULL_CLOSE_REQUIRED', {",
      }),
      Object.freeze({
        file: 'review-contract.mjs',
        anchor: 'function scopeEscalates(previous, current) {',
      }),
      Object.freeze({
        file: 'review-contract.mjs',
        anchor: "name: 'convergence may not close on a delta round',",
      }),
      Object.freeze({
        file: 'review-contract.mjs',
        anchor: "name: 'a full-artifact round re-reading the delta head closes the review',",
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'A clean delta round does not converge the unit.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'reworded-re-raise-made-a-review-chain-unpublishable',
    date: '2026-08-25',
    symptom: 'living-football-engine #313 converged clean at round 4 and its '
      + '`agentic/review` status could never be published at any head; PR '
      + '#330 is still an unmerged draft. Rounds 1 and 2 both raised the same '
      + 'two Majors, round 2 rewording each to say what the fix missed.',
    cause: 'A finding id was identified by severity AND summary AND evidence, '
      + 'so re-raising one with a fresh explanation broke authentication for '
      + 'the whole chain. The check runs ahead of the ledger, so no evidence '
      + 'construction satisfied it — the only input that would have was one '
      + 'with the reviewers\' recorded verdicts rewritten to agree.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'review-contract.mjs',
        anchor: 'function authenticatedFindings(rounds, gaps = []) {',
      }),
      Object.freeze({
        file: 'review-contract.mjs',
        anchor: "name: 'a later reviewer may reword a re-raised finding',",
      }),
      Object.freeze({
        file: 'review-contract.mjs',
        anchor: "name: 'a re-raised finding may not change severity',",
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'a finding id is its defect AND its severity',
      }),
    ]),
  }),
  Object.freeze({
    id: 'add-only-step-swap-stranded-the-claim-label',
    date: '2026-08-23',
    symptom: 'A unit wore loop:04-claim and loop:08-code-review at once: the '
      + 'first model-driven swap after the driver\'s claim was '
      + '`--add-label loop:05-implement` with no remove, and the 06→08 swap '
      + 'left no 07-diff-review on the timeline.',
    cause: 'The guard validated what a swap adds (rules 9, 10) and the '
      + 'reminder knew only the forward pointer; nothing required the '
      + 'predecessor to be retired in the same command, so an add-only swap '
      + 'and a skipped step both passed as progress.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'function addsStepWithoutRetiringPredecessor(',
      }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: "['gh issue edit 298 --add-label loop:05-implement', 'feat/gh-298-x', true]",
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'A swap is one command with both halves',
      }),
    ]),
  }),
  Object.freeze({
    id: 'plan-review-re-dispatched-as-rounds-with-backward-step-swaps',
    date: '2026-08-23',
    symptom: 'A staged unit ran PLAN-REVIEW r1, r2, r3 against one plan '
      + '(v2, v3, v4), swapping loop:03-plan-review back to loop:02-plan '
      + 'before each revision; it had also never received loop-started or '
      + 'the 01/02 labels at selection.',
    cause: 'The dev skill said "review the plan once" in prose only. The '
      + 'dispatch anchor treated plan-review like any repeatable step, the '
      + 'swap reminder knew only forward swaps, and no guard refused a '
      + 'backward one — so re-review read as a round, and 0.49.49 had '
      + 'already raised a pitcrew cap in its name.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'function swapsStepLabelBackward(',
      }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: '--add-label "loop:02-plan" --remove-label "loop:03-plan-review"',
      }),
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'This is the ONE plan review',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'A second plan-review dispatch is a loop defect, not a round',
      }),
    ]),
  }),
  Object.freeze({
    id: 'auto-merge-demanded-the-claim-parent-equal-the-moving-base-tip',
    date: '2026-08-23',
    symptom: 'A delivered unit under merge.policy auto was refused with '
      + '"branch-starting claim commit is not parented by the current base" '
      + 'after three unrelated commits landed on main during its 4-hour run; '
      + 'the branch even carried a base merge.',
    cause: 'validateOwnership compared the claim commit\'s parent to '
      + 'pr.baseRefOid — the CURRENT tip — which equals the planned base only '
      + 'while nothing has merged since claim. The same equality-against-a-'
      + 'moving-tip defect as the draft-creation wedge, one predicate over. '
      + 'The invariant is ancestry: parent IS the marker-sealed plannedBaseOid '
      + 'and the current base descends from it.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'merge-authorization-contract.mjs',
        anchor: 'current base does not descend from the planned base',
      }),
      Object.freeze({
        file: 'merge-authorization-contract.mjs',
        anchor: 'claim parented by the planned base with a forward-moved current base allows',
      }),
      Object.freeze({
        file: 'auto-merge.reference.mjs',
        anchor: 'function fetchPlannedBaseComparison(',
      }),
      Object.freeze({
        file: 'auto-merge.reference.mjs',
        anchor: 'claim commit whose planned base the current base no longer descends from blocks',
      }),
    ]),
  }),
  Object.freeze({
    id: 'invented-step-label-stripped-the-gate-label',
    date: '2026-08-23',
    symptom: 'After a green gate a run swapped `loop:09-gate` for an invented '
      + '`loop:10-publish`; gh removed 09-gate, failed on the unknown label '
      + 'behind a `2>/dev/null`, and the unit read as freshly selected '
      + '(`loop-ready` + `loop-started`, no step label) through publish.',
    cause: 'The step table numbers 10 PUBLISH and 11 RECORD like every other '
      + 'step, and nothing said the ladder ends at 09-gate, so "new step ⇒ '
      + 'new loop:NN label" pattern-matched. The terminal finalizer owns the '
      + 'only swap after the gate, and no guard refused the invented label.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'function addsUnknownStepLabel(',
      }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: '--add-label loop:10-publish 2>/dev/null',
      }),
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'carry NO label',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'No label swap opens this step, or step 11',
      }),
    ]),
  }),
  Object.freeze({
    id: 'base-advanced-between-intent-and-draft-wedged-the-unit',
    date: '2026-08-21',
    symptom: 'A unit with a review-converged plan blocked at phase '
      + 'plan-comment with "configured base moved before draft creation", '
      + 'deterministically across three attempts: main had advanced by one '
      + 'commit in the minutes between intent persist and draft creation.',
    cause: 'ensureDraftPr demanded the live base tip EQUAL the marker\'s '
      + 'immutable plannedBaseOid. The branch had already forked from that '
      + 'OID at local claim and the PR targets the base BRANCH, so the '
      + 'equality protected nothing the next commit would not break again — '
      + 'and with no epoch-bump verb before premerge the refusal was permanent.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'lifecycle-driver.mjs',
        anchor: 'function plannedBaseStillReachable(',
      }),
      Object.freeze({
        file: 'lifecycle-driver.mjs',
        anchor: 'tolerates a forward-moved base and refuses a rewritten one',
      }),
    ]),
  }),
  Object.freeze({
    id: 'loop-reapplied-block-labels-over-a-human-unblock',
    date: '2026-08-21',
    symptom: 'A unit blocked at the plan-review cap was unblocked by its '
      + 'human (loop-blocked + human:decide removed in one edit); five hours '
      + 'later a run re-applied both labels as "bookkeeping — blocking labels '
      + 'restored", reversing the unblock and costing the human a second one.',
    cause: 'Block state was inferred from the PRESENCE of the historical '
      + 'block comment instead of from the label timeline, whose unlabeled '
      + 'events postdating the comment ARE the unblock. Nothing stated the '
      + 'mirror of the loop-ready rule: removing the block labels is the '
      + "human's one-action decision, and no loop path may reverse it.",
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'reversed a human unblock',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'equally one human action, and equally irreversible',
      }),
    ]),
  }),
  Object.freeze({
    id: 'panel-choreography-deleted-for-a-surface-one-flag-away',
    date: '2026-08-20',
    symptom: 'v0.49.45 compressed the task-panel choreography out of the dev '
      + 'skill as "instructions for a surface no current host exposes", '
      + 'leaving a probe that can print `mirroring` and no instructions for '
      + 'what to do when it does — a run finding the tools would half-mirror.',
    cause: 'The removal was diagnosed from the visible roster: Claude Code '
      + '2.1.233 gated the task tools by MODEL, and the operator restores '
      + 'them with CLAUDE_CODE_ENABLE_TODO_TOOLS. Absent-for-this-session was '
      + 'read as gone-for-good, and load-bearing prose was deleted on it.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'Everything below applies whenever the probe says',
      }),
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'demands a task row unconditionally',
      }),
    ]),
  }),
  Object.freeze({
    id: 'ready-transition-invalidated-the-frozen-delivery-evidence',
    date: '2026-08-20',
    symptom: 'Six consecutive delivered units on a Copilot-review repository '
      + 'refused auto-merge and failed their finalizer readbacks: the ready '
      + 'transition triggered a check run that landed after ci.evidenceHash '
      + 'froze, so no later observation could reproduce the recorded '
      + 'fingerprint.',
    cause: 'terminal-finalize froze the delivery evidence while the PR was '
      + 'still draft, then marked it ready — the one mutation it performs '
      + 'that itself grows the triggered-check set on repositories where '
      + 'readiness triggers an app review.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'publish-verdict.mjs',
        anchor: 'did not settle after the ready transition',
      }),
      Object.freeze({
        file: 'publish-verdict.mjs',
        anchor: 'the record freezes the settled post-ready evidence',
      }),
    ]),
  }),
  Object.freeze({
    id: 'task-mirror-died-with-the-harness-surface',
    date: '2026-08-20',
    symptom: 'Claude Code 2.1.234 removed TaskCreate/TaskUpdate and two full '
      + 'runs across four context windows mirrored nothing and said nothing; '
      + 'delivery push notifications were dropped as "does not exist" while '
      + 'PushNotification — merely deferred — sat one ToolSearch away.',
    cause: 'The mirror rule told hosts without task tools to "skip this '
      + 'silently", so an absent surface read exactly like a forgotten one, '
      + 'and the run diagnosed the tool roster from what was visible instead '
      + 'of asking ToolSearch.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'the skip is no longer silent',
      }),
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'ToolSearch("select:PushNotification")',
      }),
    ]),
  }),
  Object.freeze({
    id: 'hook-demanded-the-header-the-skill-bans',
    date: '2026-08-20',
    symptom: 'The swap riders named a `▶ #N · step X/11` step line as due '
      + 'while the dev skill bans that exact shape as a duplicate of the '
      + 'ribbon; obeying either surface violated the other, and a run that '
      + 'learns riders cannot all be followed stops following the rest — the '
      + 'same run skipped eight of eleven ribbons.',
    cause: 'Two surfaces specified the same step announcement independently '
      + 'and drifted: the skill moved to glyphed ribbons while the hook kept '
      + 'the retired step-line grammar, alongside riders naming tools the '
      + 'harness had removed.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'A step is announced ONCE, by its ribbon',
      }),
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'never reprint a ribbon already announced',
      }),
    ]),
  }),
  Object.freeze({
    id: 'literal-for-loop-refused-as-unresolvable',
    date: '2026-07-29',
    symptom: 'Three live runs lost a round to a `for` over a LITERAL word list '
      + '— `for n in 222 223 224` and a sweep over eight named spec files — '
      + 'and were told to write the iterations out by hand.',
    cause: 'The guard resolved a literal ASSIGNMENT by substituting and judging '
      + 'the real command, but refused a literal loop, which is the same '
      + 'operation repeated. The printed remedy was the expansion the guard '
      + 'could perform itself.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'export function expandLiteralForLoops(' }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: "['for f in 41 42; do gh pr merge $f; done', 'feat/gh-1-x', true]",
      }),
    ]),
  }),
  Object.freeze({
    id: 'command-v-lookup-read-as-an-invocation',
    date: '2026-07-29',
    symptom: '`command -v php` was refused as inline interpreter source while a '
      + 'live setup checked whether its configured gate still resolves — the '
      + 'probe this plugin\'s own setup skill asks for.',
    cause: '`command` is a passthrough wrapper, so the name behind it read as '
      + 'an invocation with no script argument, which is the stdin shape. '
      + '`-v`/`-V` make it a lookup that runs nothing.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'function isLookupSegment(' }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: "['command -v php', 'feat/gh-1-x', false]",
      }),
    ]),
  }),
  Object.freeze({
    id: 'rebased-claim-branch-wedged-a-merged-unit-remotely',
    date: '2026-07-29',
    symptom: 'With the local-claim fix in place, #149 advanced exactly one '
      + 'check and was refused ARTIFACT_IDENTITY_MISMATCH(remote-claim). The '
      + 'run read it as "branch deleted on merge"; the branch was present on '
      + 'the remote at the PR head.',
    cause: 'The rebase that orphaned the claim commit locally orphaned it on '
      + 'the remote too, so containsClaimCommit was false against a branch '
      + 'that had merged cleanly. Fixing one side and not the other moved the '
      + 'refusal one check along.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'lifecycle-contract.mjs',
        anchor: 'a rebased remote claim branch cannot wedge a merged unit either',
      }),
    ]),
  }),
  Object.freeze({
    id: 'rebased-claim-branch-wedged-a-merged-unit',
    date: '2026-07-28',
    symptom: '#149 shipped and PR #238 merged, but every terminal backfill was '
      + 'refused ARTIFACT_IDENTITY_MISMATCH(local-claim), leaving a permanent '
      + '`draft-pr` marker on a closed unit that no hand edit may repair.',
    cause: 'The branch was rebased after the claim, rewriting every OID on it '
      + 'including the claim commit, so the marker held the original while the '
      + 'surviving local branch carried the rewrite. A merged unit\'s local '
      + 'branch is leftover history; the merge commit is the proof.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'lifecycle-contract.mjs',
        anchor: 'a rebased local claim branch cannot wedge a merged unit',
      }),
    ]),
  }),
  Object.freeze({
    id: 'overlap-window-anchored-to-the-last-prime',
    date: '2026-07-28',
    symptom: 'A five-hour run reported `dispatches 8 · concurrent 0s` while '
      + 'its dispatch log held 57 entries and four concurrent pairs. The same '
      + 'log now reports `dispatches 57 · concurrent 93m`.',
    cause: 'Run markers accumulate, one per prime and never pruned (27 in the '
      + 'live checkout). The window boundary was Math.max over all their '
      + 'mtimes, so it anchored to the most recent PRIME rather than to the '
      + 'run being reported.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'overlap-report.mjs',
        anchor: 'the boundary is the marker for this run, never the newest one',
      }),
    ]),
  }),
  Object.freeze({
    id: 'flat-dispatch-ceiling-killed-a-working-writer',
    date: '2026-07-28',
    symptom: 'An implement dispatch grinding a Go slice was killed at the flat '
      + '30-minute ceiling mid-task. Its tokens were spent and unrecoverable; '
      + 'only the two commits it had already made survived.',
    cause: 'One ceiling served both postures. It was sized for "a run that '
      + 'needs more than half an hour has a different problem", which is true '
      + 'of a reviewer returning one verdict and false of a writer grinding '
      + 'against the slice caps.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: 'export function timeoutMsFor(' }),
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'the ceiling is per posture: a writer grinds, a reviewer should not',
      }),
    ]),
  }),
  Object.freeze({
    id: 'unresolved-tokens-named-as-a-comma-splice',
    date: '2026-07-28',
    symptom: 'A refusal read "`$p`, a command substitution cannot be resolved '
      + 'statically" — a comma splice that parses as one garbled subject and '
      + 'hides that two separate things need fixing.',
    cause: 'Named tokens were joined with `, ` and truncated at three with no '
      + 'remainder, so a long list also sent the reader back for a second '
      + 'refusal having fixed everything the first one mentioned.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'export function nameList(' }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'two unresolved tokens are joined, not comma-spliced',
      }),
    ]),
  }),
  Object.freeze({
    id: 'retired-artifact-absence-went-unreported',
    date: '2026-07-28',
    symptom: 'A live session probed `ls .autoloop/ci-policy.json` beside the '
      + 'reconcile audit, so a PASSING check printed `No such file or '
      + 'directory` and read as a failure.',
    cause: 'The reconcile report named the retired artifact only when it '
      + 'removed one. Silence about an absence cannot be told apart from an '
      + 'unperformed check, so a reader re-derives it with a shell probe.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'scaffold.mjs',
        anchor: 'a fresh scaffold never creates the retired CI policy, and says so',
      }),
    ]),
  }),
  Object.freeze({
    id: 'completed-step-rows-shipped-without-their-cost',
    date: '2026-07-28',
    symptom: 'Live panels showed bare completed rows (`∞ #123 — 02 PLAN '
      + '[OPUS]`) with no `[elapsed] [HH:MM]`, losing the per-step cost '
      + 'profile the panel is the only surviving record of.',
    cause: 'The rule shipped in v0.49.21 as prose only. Obeying it required '
      + 'millisecond arithmetic and a clock read in the same turn as '
      + 'collecting a result, disposing findings and swapping labels.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'step-subject.mjs', anchor: 'export function completedSubject(' }),
      Object.freeze({
        file: 'step-subject.mjs',
        anchor: 'The live defect: a bare completed row, now composed rather than recalled.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'plan-followed-the-review-engine-recording',
    date: '2026-07-28',
    symptom: 'A run configured to plan on `fable` and review on a proxied '
      + '`gpt-5.6-sol` planned on the review model instead: the recorded proxy '
      + 'URL and effort were injected into the plan dispatch, so the `--model '
      + 'fable` pin was resolved by the review proxy.',
    cause: 'The review-engine recording was keyed to the reviewer POSTURE, and '
      + '`plan` shares that posture for its read-only sandbox while being '
      + 'authored work. Keying on the verdict RESULT separates the two.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: 'function followsReviewChoice(' }),
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'codex refuses to author a plan, which is writing under a reading posture',
      }),
    ]),
  }),
  Object.freeze({
    id: 'interpreter-name-in-argument-position',
    date: '2026-07-28',
    symptom: '`git log --oneline | grep node` and `git log --grep xargs` were '
      + 'refused as inline interpreter source and inline command assembly — '
      + 'plain read-only history queries, denied for naming a tool.',
    cause: 'Interpreter and assembler detection searched the whole segment, so '
      + 'a search PATTERN read as an invocation. The git/gh rules already '
      + 'judged by position; these two did not.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'function invokedAt(' }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: "['git log --oneline | grep node', 'feat/gh-1-x', false]",
      }),
    ]),
  }),
  Object.freeze({
    id: 'merge-commit-sha-removed-from-rest',
    date: '2026-07-28',
    symptom: 'Every human-merged unit refused its terminal backfill with '
      + 'ARTIFACT_IDENTITY_MISMATCH(merge); four shipped units wedged.',
    cause: 'REST API version 2026-03-10 removed `merge_commit_sha` from both '
      + 'pull-request representations, so the driver read undefined.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'api-shape.mjs',
        anchor: 'the 2026-07-28 incident is caught: mergeCommit.oid absent',
      }),
      Object.freeze({ file: 'lifecycle-driver.mjs', anchor: 'function mergeCommitOid(' }),
    ]),
  }),
  Object.freeze({
    id: 'blocking-stripped-loop-ready',
    date: '2026-07-27',
    symptom: 'A blocked unit could never be resumed: the block flow removed '
      + '`loop-ready`, and the loop is forbidden from reapplying it.',
    cause: '`loop-ready` was treated as redundant with `loop-blocked` rather '
      + 'than as the authorization token it is.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'label-swap-reminder.mjs', anchor: 'KEEP `loop-ready`' }),
    ]),
  }),
  Object.freeze({
    id: 'unnamed-artifact-mismatch',
    date: '2026-07-28',
    symptom: 'A refusal naming only its category ("merge") sent two sessions '
      + 'an hour each proving state that was already consistent.',
    cause: 'Typed refusals carried a category but not the predicate that '
      + 'failed or the values it compared.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'lifecycle-contract.mjs',
        anchor: 'merge commit is not a commit OID',
      }),
    ]),
  }),
  Object.freeze({
    id: 'delivery-floor-ignored-untriggered-checks',
    date: '2026-07-26',
    symptom: 'Delivery could pass while the exact head carried no green '
      + 'evidence at all.',
    cause: 'The floor asked whether checks failed, not whether any ran.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'delivery-contract.mjs',
        anchor: 'no triggered checks delivers on the floor alone',
      }),
    ]),
  }),
  Object.freeze({
    id: 'effort-dropped-at-cli-seam',
    date: '2026-07-27',
    symptom: 'Reviews requested at xhigh silently ran at the engine default.',
    cause: 'The flag validated but never reached the spawned argv.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: "'--effort', 'nope'" }),
    ]),
  }),
  Object.freeze({
    id: 'release-literals-counted-file-wide',
    date: '2026-07-28',
    symptom: 'Adding a second workflow step that needs the repository name '
      + 'failed a release gate that had nothing to say about it.',
    cause: 'Requirements describing the release-verify invocation were counted '
      + 'across the whole workflow, so the literal became reserved file-wide. '
      + 'The tempting fix was to spell the flag differently and dodge it.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'release-verify.mjs',
        anchor: 'another step may bind the repository without tripping the gate',
      }),
    ]),
  }),
  Object.freeze({
    id: 'exit-code-contract-unreadable-under-the-guard',
    date: '2026-07-28',
    symptom: 'Every setup lost a round to a guard refusal: the merge step '
      + 'documents its outcome as "exit 3", so sessions reached for `$?`, '
      + 'which the guard blocks as an active shell expansion.',
    cause: 'A tool contract expressed only as an exit code, under a guard that '
      + 'forbids the idiom for reading exit codes. The same fact was in the '
      + 'report all along as `ok: false`, but nothing said so.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/setup/SKILL.md',
        anchor: 'Read that from the report, never from `$?`',
      }),
      Object.freeze({ file: 'scaffold.mjs', anchor: 'return report.ok ? 0 : 3;' }),
    ]),
  }),
  Object.freeze({
    id: 'guard-refusals-named-no-alternative',
    date: '2026-07-28',
    symptom: 'A session lost a round to `ls -d … | xargs -n1 basename` — a '
      + 'plain listing — then ran the plain listing anyway. The refusal said '
      + '"use literal canonical commands" without naming which one.',
    cause: 'The refusal named its category, not its remedy. The message policy '
      + 'required a closing sentence naming the sanctioned alternative, and '
      + 'generic prose satisfied it on shape while naming nothing.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'fanout refusal names the listing command to use instead',
      }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'const ASSEMBLER_REMEDY' }),
    ]),
  }),
  Object.freeze({
    id: 'gh-json-merged-field-does-not-exist',
    date: '2026-07-28',
    symptom: 'A session lost a round to `gh pr view --json merged`, which is '
      + 'not a field, while hand-querying merge state the driver already '
      + 'reports.',
    cause: '`merged` is a real field in the REST representation and in GraphQL '
      + 'but not in `gh pr view --json`, which spells it `mergedAt`. Nothing '
      + 'said to ask the driver instead of improvising a gh call.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'Never hand-query a unit',
      }),
    ]),
  }),
  Object.freeze({
    id: 'lessons-budget-orphaned-by-its-own-migration',
    date: '2026-07-28',
    symptom: 'LESSONS.md reached 8010 bytes with nothing reporting it, while '
      + 'ARCH had a working budget.',
    cause: 'The lessons budget was dev-skill prose naming "STATE Lessons" — a '
      + 'section the v0.49.14 diet had moved into its own file — so it pointed '
      + 'at nothing and silently never fired. A migration retargeted the '
      + 'document and left its maintenance rule behind.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'scaffold.mjs', anchor: 'const CURATED_DOCUMENTS' }),
      Object.freeze({
        file: 'scaffold.mjs',
        anchor: 'a curated document over its budget is reported with the curation rule',
      }),
    ]),
  }),
  Object.freeze({
    id: 'slice-budget-blocked-a-finished-unit',
    date: '2026-07-28',
    symptom: 'A unit with both suites green, committed and pushed was blocked '
      + 'at 722 lines against a 700-line budget, one decision short of '
      + 'shipping. The human raised the cap — the only answer that block can '
      + 'produce.',
    cause: 'STATE described all caps as blocking, so a run treated a SHAPING '
      + 'budget as a run-time gate. By the time lines are countable the work is '
      + 'done and the budget knows nothing it did not know at shaping time; a '
      + 'cap whose verdict is always the same is not a gate.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'Slice budgets are the exception: they NOTE, they never block',
      }),
      Object.freeze({
        file: '../../templates/STATE.template.md',
        anchor: 'They never block a\n    unit at run time',
      }),
    ]),
  }),
  Object.freeze({
    id: 'plan-discarded-over-a-title-character',
    date: '2026-07-28',
    symptom: 'A live run spent ~40 minutes of opus re-planning because an '
      + 'em-dash in the plan TITLE discarded the entire plan, and the refusal '
      + '("structured output is not a valid plan") named neither the field nor '
      + 'the reason.',
    cause: 'A boolean validator behind a categorical message, plus a policy '
      + 'inversion: the ASCII rule exists because the ORCHESTRATOR composes '
      + 'titles from a safe allowlist, so throwing away the model-authored body '
      + 'over a title character discards the expensive artifact to protect a '
      + 'field the caller was going to author anyway.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'a rejected plan names the field, the reason, and the offending character',
      }),
      Object.freeze({
        file: 'dispatch.mjs',
        anchor: 'only a non-ASCII title is salvageable by retitling, and it keeps the body',
      }),
    ]),
  }),
  Object.freeze({
    id: 'expansion-refusal-warned-of-the-wrong-hazard',
    date: '2026-07-28',
    symptom: 'A read-only `for s in …; do sed …; done` byte count was refused '
      + 'with "can hide a mutation … split discovery and mutation into separate '
      + 'tool calls" — a hazard not present — while never mentioning the loop '
      + 'variable that actually defeated resolution.',
    cause: 'One generic message served every expansion shape. Wrong advice is '
      + 'worse than none: the reader fixes the half the message names.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'a loop refusal names the loop variable and the loop remedy',
      }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'an exit-status refusal points at the report, not at assignment',
      }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'export function unresolvedExpansionReason' }),
    ]),
  }),
  Object.freeze({
    id: 'proxy-probe-had-no-executable-command',
    date: '2026-07-28',
    symptom: 'A run lost a round recording the proxy engine: it read the URL '
      + 'back out of `review-engine` to probe it, and the command substitution '
      + 'was refused.',
    cause: 'The skill said to probe "the recorded URL" without giving the '
      + 'command, so a session composed one from the file it had just written. '
      + 'Same shape as the exit-3 merge contract: an outcome described without '
      + 'an executable command is an invitation to improvise into a refusal.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'Write the URL as a literal',
      }),
    ]),
  }),
  Object.freeze({
    id: 'sort-versions-dropped-path-lines',
    date: '2026-07-28',
    symptom: 'Two live setups lost their first command to `ls -d <cache>/*/ | '
      + 'xargs -n1 basename` — refused for the xargs — while the skill insisted '
      + 'there was "nothing to pre-clean".',
    cause: 'The skill showed only half the pipeline (the ls half was left to '
      + 'the model), and `--sort-versions` silently dropped full-path lines, so '
      + 'the basename instinct was answering a REAL hazard with the one vehicle '
      + 'the guard refuses. The tool now takes basenames itself and the skill '
      + 'shows the complete pipeline.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'release-verify.mjs',
        anchor: 'takes the basename of path lines instead of dropping them',
      }),
      Object.freeze({
        file: '../../skills/setup/SKILL.md',
        anchor: 'ONE\n   complete pipeline',
      }),
    ]),
  }),
  Object.freeze({
    id: 'label-refusal-named-no-command',
    date: '2026-07-28',
    symptom: 'Seventeen loop runs in one day applied `human:authorize` via '
      + '`gh pr edit` (which dies on gh that still queries Projects-classic '
      + 'cards), fell back to raw `gh api …/issues/<n>/labels`, and ate the '
      + 'deny with no vehicle to retry.',
    cause: 'The refusal said "use a canonical gh issue command" without '
      + 'naming one, so every run re-derived `gh issue edit <n> --add-label` '
      + '— which works on PRs and never touches project cards. The refusal '
      + 'now names the vehicle, and the dev skill and STATE template '
      + 'prescribe it where the label self-apply is described.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'avoids the Projects-classic GraphQL failure',
      }),
      Object.freeze({
        file: '../../skills/dev/SKILL.md',
        anchor: 'gh issue edit <pr-number> --add-label human:authorize',
      }),
      Object.freeze({
        file: '../STATE.template.md',
        anchor: 'gh issue edit <pr-number> --add-label human:authorize',
      }),
    ]),
  }),
  Object.freeze({
    id: 'state-sections-never-migrated',
    date: '2026-07-27',
    symptom: 'Existing repos kept a 29 KB STATE.md injected into every '
      + 'session; a template change alone could not reach them.',
    cause: 'Setup merged documents but had no way to relocate a section, so '
      + 'template restructuring stranded every installed repo.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'scaffold.mjs', anchor: 'lessons-out-of-state' }),
    ]),
  }),
  Object.freeze({
    id: 'exit-echo-decoration-took-the-typed-front-down',
    date: '2026-08-12',
    symptom: 'A live run appended `; echo "exit=$?"` to a typed escalate-paths '
      + 'call; the refusal cost the call and its useful front, and the retry '
      + 'that worked was the same command with the echo deleted.',
    cause: 'The `$?` remedy pointed at the report but never named the '
      + 'executable step for the trailing-echo form, which is deletion.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'the fix is deletion' }),
      Object.freeze({ file: 'guard-corpus.json', anchor: 'exit=$?' }),
    ]),
  }),
  Object.freeze({
    id: 'label-only-substitution-had-no-bare-spelling',
    date: '2026-08-12',
    symptom: 'A live run labeled two counts with `echo ".test.ts tracked: '
      + '$(git ls-files … | wc -l)"` and was refused with measuring remedies '
      + 'that never said how to get a LABELED count.',
    cause: 'The substitution remedy named the numbers but not the labeling '
      + 'spelling — run the counter bare and let prose carry the label.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'let prose carry the label' }),
      Object.freeze({ file: 'guard-corpus.json', anchor: '.test.ts tracked:' }),
    ]),
  }),
]);

export function auditIncidents(incidents = INCIDENTS, read = (file) =>
  readFileSync(join(HERE, file), 'utf8')) {
  return incidents.map((incident) => {
    const failures = [];
    for (const enforcer of incident.enforcedBy) {
      let source;
      try {
        source = read(enforcer.file);
      } catch {
        failures.push(`${enforcer.file} is missing`);
        continue;
      }
      if (!source.includes(enforcer.anchor)) {
        failures.push(`${enforcer.file} no longer contains "${enforcer.anchor}"`);
      }
    }
    return { id: incident.id, date: incident.date, ok: failures.length === 0, failures };
  });
}

// Every guard case must say what it cost. A rule with no incident behind it is
// an opinion, and opinions get deleted by the next person who finds them
// inconvenient.
export function auditGuardCorpus(corpus) {
  const cases = Array.isArray(corpus?.cases) ? corpus.cases : null;
  if (cases === null) return ['guard-corpus.json has no cases array'];
  return cases.flatMap((entry, index) => {
    const label = entry?.cmd ? JSON.stringify(entry.cmd.split('\n')[0].slice(0, 40)) : `#${index}`;
    if (typeof entry?.why !== 'string' || entry.why.trim() === '') {
      return [`guard case ${label} records no incident in \`why\``];
    }
    if (entry.expect !== 'allow' && entry.expect !== 'block') {
      return [`guard case ${label} has no allow/block expectation`];
    }
    return [];
  });
}

function selfTest() {
  const reads = { 'a.mjs': 'contains THE ANCHOR here' };
  const read = (file) => {
    if (!(file in reads)) throw new Error('missing');
    return reads[file];
  };
  const incident = (enforcedBy) => [{ id: 'x', date: '2026-01-01', enforcedBy }];
  const cases = [
    ['every registered incident still has its enforcing case', (() => {
      const failed = auditIncidents().filter((row) => !row.ok);
      for (const row of failed) console.error(`  ${row.id}: ${row.failures.join('; ')}`);
      return failed.length === 0;
    })()],
    ['every guard case names the incident that earned it', (() => {
      const corpus = JSON.parse(readFileSync(join(HERE, 'guard-corpus.json'), 'utf8'));
      const failures = auditGuardCorpus(corpus);
      for (const failure of failures) console.error(`  ${failure}`);
      return failures.length === 0;
    })()],
    ['a present anchor passes', auditIncidents(
      incident([{ file: 'a.mjs', anchor: 'THE ANCHOR' }]), read,
    )[0].ok],
    ['a deleted case fails, and the failure quotes the anchor', (() => {
      const [row] = auditIncidents(incident([{ file: 'a.mjs', anchor: 'GONE' }]), read);
      return !row.ok && row.failures[0].includes('"GONE"');
    })()],
    ['a missing enforcer file fails rather than throwing', (() => {
      const [row] = auditIncidents(incident([{ file: 'nope.mjs', anchor: 'x' }]), read);
      return !row.ok && row.failures[0].includes('missing');
    })()],
    ['one broken enforcer fails the incident even when others hold', (() => {
      const [row] = auditIncidents(incident([
        { file: 'a.mjs', anchor: 'THE ANCHOR' },
        { file: 'a.mjs', anchor: 'GONE' },
      ]), read);
      return !row.ok && row.failures.length === 1;
    })()],
    ['a guard case with no `why` is rejected', auditGuardCorpus({
      cases: [{ cmd: 'ls', expect: 'allow' }],
    }).length === 1],
    ['every incident states a symptom and a cause', INCIDENTS.every((entry) =>
      entry.symptom.length > 20 && entry.cause.length > 20)],
  ];
  const failures = cases.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const rows = auditIncidents();
  const guard = auditGuardCorpus(
    JSON.parse(readFileSync(join(HERE, 'guard-corpus.json'), 'utf8')),
  );
  const broken = rows.filter((row) => !row.ok).length + (guard.length > 0 ? 1 : 0);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok: broken === 0, incidents: rows, guard }, null, 1));
  } else {
    for (const row of rows) {
      console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.date} ${row.id}`);
      for (const failure of row.failures) console.log(`     ${failure}`);
    }
    console.log(`${guard.length === 0 ? 'PASS' : 'FAIL'} guard corpus provenance`);
    for (const failure of guard) console.log(`     ${failure}`);
    console.log(broken === 0
      ? `every incident is pinned (${rows.length} incidents)`
      : `${broken} incident(s) lost their enforcer`);
  }
  process.exit(broken === 0 ? 0 : 1);
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
