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
//
// `retired` keeps an incident whose enforcer a release removed on purpose:
// the entry stays, with the release and the reason ('<version>: <why>'), and
// its enforcers are no longer checked. A rule removed without this note
// fails the audit, which is the point.
export const INCIDENTS = Object.freeze([
  Object.freeze({
    id: 'flow-release-review-left-no-round-after-the-re-plan-and-no-pr-wait-cap',
    date: '2026-10-12',
    symptom: 'The 0.69.0 release review found a Critical first seen in the re-plan round could be '
      + 'neither fixed nor decided (every later round was REVIEW_REPLAN_SPENT), a PR wait had no '
      + 'cap while --minutes had one, the draft hand-off labelled human:decide by prose only, a '
      + '0.68 retained snapshot failed verify as "unreadable", and the fix round budget lived in '
      + 'two files with no check that they agree.',
    cause: 'The round-budget rule, the PR-wait lift, the hand-off label, and the snapshot version '
      + 'message were each written in one place and never exercised end to end.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'review-contract.mjs', anchor: "'a Critical first seen in the re-plan round is fixed in one more round'" }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "'a second fix round after the re-plan round is refused'" }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "'a Critical still open after the admitted fix round blocks with the ledger'" }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "'the append-round CLI builds the widened boundary, covers a widening by the delta, and hands off after the budget'" }),
      Object.freeze({ file: 'step.mjs', anchor: "'the fix round budget and the round pattern agree with review-contract.mjs'" }),
      Object.freeze({ file: 'step.mjs', anchor: "'the open-findings round labels human:decide and leaves the PR a draft'" }),
      Object.freeze({ file: 'step.mjs', anchor: "'a shipped card invalidates the retained snapshot as a PR mutation'" }),
      Object.freeze({ file: 'step.mjs', anchor: "'a retained snapshot of an older version is refused by its version'" }),
      Object.freeze({ file: 'snapshot-contract.mjs', anchor: "'a retained snapshot of an older version names its version and the re-prime remedy'" }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: "'a retained snapshot of an older version names its version in the authority detail'" }),
      Object.freeze({ file: 'unit.mjs', anchor: "'a PR wait lifts after 720 minutes with a re-plan reason, and is resumed'" }),
      Object.freeze({ file: 'unit.mjs', anchor: "'a lane entry without a trailing slash matches its exact path only'" }),
      Object.freeze({ file: 'unit.mjs', anchor: "'an overlap hit waits on the PR, the merge lifts it resumed, the re-check against the new snapshot is clear, and an older snapshot names its version'" }),
      Object.freeze({ file: 'unit.mjs', anchor: "'the PR body sections list open findings with predicate and raisings, and Minors, and are empty without entries'" }),
      Object.freeze({ file: 'label-swap-reminder.mjs', anchor: "--role fix --prompt-file /tmp/p.md --json', /--to 08-fix --round fix-<n>/" }),
      Object.freeze({ file: '../docs/specs/SPEC-review-rounds.md', anchor: 'contract admits exactly one round after it' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '**After the re-plan round, one round.**' }),
    ]),
  }),
  Object.freeze({
    id: 'delivered-units-on-shared-files-conflicted-each-other',
    date: '2026-10-12',
    symptom: 'On one project nine open loop pull requests formed two conflict groups of four and '
      + 'three: merging any one of them conflicted the others.',
    cause: 'Selection took the next eligible issue while an earlier unit was delivered and unmerged, '
      + 'and nothing compared the new plan\'s file boundary with the delivered pull requests\' changed '
      + 'paths. The boundary was prose, the scan did not fetch changed paths, and no wait named a PR.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: "'a plan without a structured boundary is refused, and a boundary passes through'" }),
      Object.freeze({ file: 'scan.mjs', anchor: "'the PR query fetches changed paths, pages past 100, and the normalized PR carries them sorted and unique'" }),
      Object.freeze({ file: 'snapshot-contract.mjs', anchor: "'the delivered set is every open loop PR at ready-head or premerge-record, with its paths'" }),
      Object.freeze({ file: 'snapshot-contract.mjs', anchor: "'a merged or closed loop PR is a PR_MUTATION, which invalidates the delivered set'" }),
      Object.freeze({ file: 'unit.mjs', anchor: "'overlapWith names the first delivered PR whose files intersect the boundary, and the paths'" }),
      Object.freeze({ file: 'unit.mjs', anchor: "'a PR wait round-trips and clears when the PR merges or closes, not while it is open'" }),
      Object.freeze({ file: 'unit.mjs', anchor: "'prime lifts a PR wait on merge, marks it resumed for a re-plan, and holds it while the PR is open'" }),
      Object.freeze({ file: 'unit.mjs', anchor: "'--overlap reads a plan result and a retained snapshot, skips the unit\\'s own PR, and refuses an invalidated snapshot'" }),
      Object.freeze({ file: 'prime.mjs', anchor: "'a lifted PR wait is printed lifted and resumed, and is not pointed past a halt'" }),
      Object.freeze({ file: 'step.mjs', anchor: "'a unit held by overlap reads \"waits on PR #M (paths)\"'" }),
      Object.freeze({ file: 'briefs/plan.md', anchor: 'boundary: the complete file boundary' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '**Overlap check before the claim**' }),
    ]),
  }),
  Object.freeze({
    id: 'review-rounds-past-three-did-not-converge',
    date: '2026-10-12',
    symptom: 'On one project 12 units reached the code-review round cap of 20. One unit ran 15 '
      + 'review and 6 fix dispatches in a day, another 8 fix and 8 review rounds plus a two-hour '
      + 'timeout. Majors in late rounds were raised on lines that earlier fixes added.',
    cause: 'The contract bounded rounds at 20 and nothing else: a Major could be fixed again '
      + 'every round, and a re-filed Major under a new id restarted its count. Since 0.69.0 a '
      + 'unit gets round 1 plus three fix rounds; a Major still open is decided, re-planned once, '
      + 'or deferred, findings are keyed by predicate, a Critical is fixed regardless, and a Major '
      + 'surviving the re-plan round hands the unit off as a draft with human:decide.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'review-contract.mjs', anchor: 'export const FIX_ROUND_BUDGET = 3;' }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a fourth fix round is refused'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a Major re-filed under a new id on the same predicate keeps its raisings'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a decision rebuts the finding and one closing full round over the same artifact closes it'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a second re-plan is refused'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a verified Critical past the budget is still fixed in the next round'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a Critical still open after the admitted fix round blocks with the ledger'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'Minors never consume the budget and never hold delivery'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a Major surviving the re-plan round hands the unit off as a draft with its ledger'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'the builder refuses a fourth fix round and accepts one re-plan round with its new plan'," }),
      Object.freeze({ file: 'step.mjs', anchor: "'a review round replaces the counter with the fix budget'," }),
      Object.freeze({ file: 'step.mjs', anchor: "'round 1, the re-plan round and the open-findings hand-off name themselves'," }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: "'a review step keeps its named round: a fix round, the re-plan round, the open-findings hand-off'," }),
      Object.freeze({ file: 'briefs/code-review.md', anchor: 'A re-raise on the same predicate is the same finding' }),
      Object.freeze({ file: 'briefs/fix.md', anchor: 'or a predicate has a Major in two consecutive rounds' }),
      Object.freeze({ file: 'briefs/plan.md', anchor: 'On a re-plan, the input is the code-review findings ledger' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '**After the re-plan round, one round.**' }),
    ]),
  }),
  Object.freeze({
    id: 'fixes-outside-the-plan-boundary-became-repair-issues',
    date: '2026-10-12',
    symptom: 'On one project a verified Major whose fix was one directory outside the frozen file '
      + 'boundary became a repair issue, which the loop queued behind the stopped run, or a block.',
    cause: 'The frozen boundary was edit authority: a fix outside it needed a separate scope '
      + 'decision, the implementer was told to stay inside it, and nothing distinguished a path in '
      + 'the unit\'s own seam from one in another subsystem. Since 0.69.0 a verified finding is '
      + 'fixed where the defect is under a recorded `widen` disposition, the next delta round must '
      + 'change the widened paths, a writer lists `extraPaths` that a plan task needed and round 1 '
      + 'records them, a widening into a protected path labels human:authorize and into a secret '
      + 'path is refused, and only a path outside the seam is deferred to a repair.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a widen disposition adds its paths to the evidence boundary, the delta covers them, and the close lists the scope change'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a delta round that omits a widened path is refused REVIEW_DELTA_SCOPE_INCOMPLETE'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a widen without a verified finding, without paths, or into a secret path is refused'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a widening into a protected path labels human:authorize and does not refuse'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'an implement result listing extra paths is recorded as widenings before round 1'," }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a finding outside the seam is deferred to a repair at any round; one inside it is widened'," }),
      Object.freeze({ file: 'lane-contract.mjs', anchor: "'a widened path is in the unit lane and a prefix matches only its directory'," }),
      Object.freeze({ file: 'lane-contract.mjs', anchor: "'a widening into a protected path is a human:authorize hit, not a refusal'," }),
      Object.freeze({ file: 'lane-contract.mjs', anchor: "'a widening into a secret path is refused WIDEN_SECRET_PATH'," }),
      Object.freeze({ file: 'dispatch.mjs', anchor: "'an implement result passes its extra-paths block through typed, and a malformed block is a typed failure that keeps the text'," }),
      Object.freeze({ file: 'unit.mjs', anchor: "'the PR body section lists every widening under ## Scope changes with its finding id, and is empty without widenings'," }),
      Object.freeze({ file: 'unit.mjs', anchor: "'a repair is filed with the parent provenance, loop-repair and never loop-ready, then the parent waits on it'," }),
      Object.freeze({ file: 'briefs/implement.md', anchor: 'An edit outside the boundary is allowed only when a plan task cannot pass its test without it.' }),
      Object.freeze({ file: 'briefs/fix.md', anchor: 'Fix where the defect is.' }),
      Object.freeze({ file: 'briefs/code-review.md', anchor: 'do not refuse it as out of scope' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: 'A verified fix outside the boundary is a `widen` disposition.' }),
    ]),
  }),
  Object.freeze({
    id: 'premise-blocks-waited-on-decisions-the-loop-can-take',
    date: '2026-10-12',
    symptom: 'On one project 33 units blocked at premise for a human decision, ten of them in one '
      + 'hour on a batch of decision-shaped issues; most were specification gaps on issues written '
      + 'weeks before they were built.',
    cause: 'The planner read a contradiction between an issue and the specification as '
      + 'TRUST_REQUIRED or UNSPECIFIED_VALUE and blocked. The briefs asked for a named human question, '
      + 'and no record made the loop\'s own decisions visible in the pull request.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'unit.mjs', anchor: 'is refused as retired, names --decide, and makes no GitHub call' }),
      Object.freeze({ file: 'unit.mjs', anchor: "'a decision marker without a question (before 0.69.0) still parses'" }),
      Object.freeze({ file: 'unit.mjs', anchor: "'the PR body section lists every decision under ## Decisions with its link, and is empty without decisions'" }),
      Object.freeze({ file: 'unit.mjs', anchor: "'a resumed block whose reason is now retired is listed as decided by the /answer that lifted it'" }),
      Object.freeze({ file: 'step.mjs', anchor: 'decisions when it has any, and says nothing when it has none' }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: "'a unit carries its recorded decision count; none or a malformed count is zero'" }),
      Object.freeze({ file: 'briefs/plan.md', anchor: 'Do not request ratification or approval' }),
      Object.freeze({ file: 'briefs/plan-review.md', anchor: 'A decision is never a finding because no human approved it.' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: 'a specification gap is a `decide`, never a block' }),
    ]),
  }),
  Object.freeze({
    id: 'decisions-invented-work-size-quotas-and-compressed-a-plan',
    date: '2026-10-12',
    symptom: 'LFE #506: decisions invented a 16000-character plan cap and a six-path, 987-line '
      + 'cap, and a complete 24048-character plan was compressed to fit them.',
    cause: 'Briefs, the simplify rider and the record tools asked for line and file totals and a '
      + 'plan-relative line budget, so estimates read as limits. No project policy set them.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'briefs/plan.md', anchor: 'Never invent a plan-character, file-count or changed-line quota' }),
      Object.freeze({ file: 'briefs/plan-review.md', anchor: 'A plan compressed, split, delayed or stopped only to fit such a number is a finding' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '**No work-size quota.**' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: "'a readable plan body over 16000 characters is accepted with its exact body'" }),
      Object.freeze({ file: 'dispatch.mjs', anchor: "'no role brief requests a work-size total or budget reduction, and plan briefs forbid invented quotas'" }),
      Object.freeze({ file: 'label-swap-reminder.mjs', anchor: 'the simplify rider asks for a work-size measurement or budget reduction' }),
      Object.freeze({ file: 'sizing-contract.mjs', anchor: "'a retired size flag is refused by name, and no record is made from it'" }),
      Object.freeze({ file: 'sizing-contract.mjs', anchor: "'a historical size-bearing marker still parses, without its size fields'" }),
      Object.freeze({ file: 'stats.mjs', anchor: "['historical size fields never reach the JSON report, nested or top-level'" }),
      Object.freeze({ file: 'step.mjs', anchor: "'--card --issue 7 --outcome shipped --lines 393'" }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'FAIL [no refusal remedy recommends a work-size measurement]' }),
    ]),
  }),
  Object.freeze({
    id: 'routine-units-edited-protected-guidance-to-count-progress',
    date: '2026-10-06',
    symptom: 'Each detmath export unit edited CLAUDE.md only to decrement a pending-export count, '
      + 'so a routine unit picked up human:authorize and could not merge autonomously.',
    cause: 'No brief said where progress belongs, so plans froze the count edit into protected '
      + 'guidance and writers executed it as planned without flagging it.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'briefs/plan.md', anchor: 'Never plan a progress counter or task-status mirror into protected guidance' }),
      Object.freeze({ file: 'briefs/plan-review.md', anchor: 'that only records progress is a scope finding' }),
      Object.freeze({ file: 'briefs/implement.md', anchor: 'Never add or update a progress counter or task-status mirror in protected guidance' }),
      Object.freeze({ file: 'briefs/implement.md', anchor: 'If the frozen plan names such an edit, leave that edit pending and report it for an orchestrator ruling' }),
      Object.freeze({ file: 'briefs/fix.md', anchor: 'Never add or update a progress counter or task-status mirror in protected guidance' }),
      Object.freeze({ file: 'briefs/fix.md', anchor: 'If the frozen plan names such an edit, leave that edit pending and report it for an orchestrator ruling' }),
      Object.freeze({ file: 'briefs/simplify.md', anchor: 'Never add or update a progress counter or task-status mirror in protected guidance' }),
      Object.freeze({ file: 'briefs/simplify.md', anchor: 'preserve the frozen plan and any existing edit, report the mismatch as pending for an orchestrator ruling' }),
    ]),
  }),
  Object.freeze({
    id: 'review-scope-was-confused-with-edit-authorization',
    date: '2026-10-05',
    symptom: 'A confirmed full-review finding was annotated out of scope because its fix '
      + 'needed edits outside the frozen plan; the review recorder rejected the annotation.',
    cause: 'The annotation instructions named inScope without distinguishing the review '
      + 'boundary from permission to edit. Recording a finding grants no edit authority.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '`inScope` is review scope, not edit authorization.' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: 'Round 1: every finding is `inScope:true`.' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: 'A verified fix outside the boundary is a `widen` disposition.' }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'a full review cannot classify a finding out of scope'," }),
    ]),
  }),
  Object.freeze({
    id: 'dispatched-children-got-a-200k-window-behind-the-gateway',
    date: '2026-09-29',
    symptom: 'LFE #352: the astra plan failed after compacting, and its Opus '
      + 'fallback auto-compacted at 172,375 tokens, though both models have 1M.',
    cause: 'Behind a gateway (ANTHROPIC_BASE_URL) Claude Code cannot look a model '
      + 'up, so a bare id gets a 200k window: measured through the proxy, '
      + 'claude-opus-5-5 200,000 and claude-opus-5-5[1m] 1,000,000; the same for '
      + 'Fable and astra. The routes and fallbacks carried bare ids; the default '
      + 'model table (models-config.mjs) now carries [1m] on every id.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'models-config.mjs', anchor: "plan: Object.freeze({ model: 'astra[1m]', effort: 'high', fallback: 'opus[1m]' })," }),
      Object.freeze({ file: 'dispatch.mjs', anchor: "'with no global config the defaults are written and every role resolves its own entry'" }),
    ]),
  }),
  Object.freeze({
    id: 'unreconcilable-markers-retried-every-run',
    date: '2026-09-29',
    symptom: 'LFE: seven closed-issue markers were re-reconciled every run and '
      + 'refused identically (PREMERGE_CI_COMPONENT_MISMATCH): 7 of 69 API calls, '
      + 'about 1.1M cache-read tokens and 2 minutes per session.',
    cause: 'Nothing remembered a deterministic refusal, so every run spent a call '
      + 'per marker to learn the same answer.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'lifecycle-driver.mjs', anchor: 'export function markerRefusalRecord(' }),
      Object.freeze({ file: 'lifecycle-driver.mjs', anchor: 'export function blockRefusalRecord(' }),
      Object.freeze({ file: 'prime.mjs', anchor: 'export function splitKnownRefused(' }),
    ]),
  }),
  Object.freeze({
    id: 'foreground-dispatches-blocked-the-orchestrator',
    date: '2026-09-29',
    symptom: 'LFE: three of four dispatches held the orchestrator for the host\'s '
      + '600 s foreground ceiling; nothing else could run meanwhile.',
    cause: 'Background dispatches were refused (0.49.65) because host kills took '
      + 'the dispatch down with its task. dispatch-stream.sh has since detached '
      + 'the dispatch, so a killed watcher no longer loses it (verified live).',
    enforcedBy: Object.freeze([
      // 0.69.0: the guard no longer judges a launch shape; the ordinary
      // corpus proves a background dispatch is allowed.
      Object.freeze({ file: 'command-guard.mjs', anchor: 'an ordinary command is never refused in the owning session' }),
    ]),
  }),
  Object.freeze({
    id: 'foreground-dispatch-stream-flooded-the-orchestrator',
    date: '2026-09-29',
    symptom: 'LFE: one implement dispatch streamed ~196 lines / 21.9 KB into the '
      + 'orchestrator by 5.5 minutes (314 lines / 30.7 KB for the whole live file); '
      + 'about 8 dispatches per unit brought compaction forward.',
    cause: 'Dispatches run in the foreground since background shells were killed, '
      + 'so the pane stream rendered for a task view became the tool result.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch-render.mjs', anchor: "'the compact pane is bounded however long the dispatch runs'" }),
      Object.freeze({ file: 'dispatch-stream.sh', anchor: 'dispatch-render.mjs" --compact' }),
    ]),
  }),
  Object.freeze({
    id: 'no-whole-run-kill-switch',
    date: '2026-09-29',
    symptom: 'Found comparing with a sibling loop project: a human could pause '
      + 'auto-merge (automerge:halt) but had no way to stop the loop taking '
      + 'new units short of killing the session.',
    cause: 'Selection had no run-wide stop predicate.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'snapshot-contract.mjs', anchor: "...(context.halted ? ['loop-halted'] : [])," }),
      // 0.69.0: the guard's loop-halt rule is removed (SPEC-guard-reduction).
    ]),
  }),
  Object.freeze({
    id: 'nothing-kept-edits-off-the-hook-wiring',
    date: '2026-09-29',
    symptom: 'Found comparing with a sibling loop project: a dispatched writer '
      + '(hooks off, Edit/Write allowed) and a live-run orchestrator (guard '
      + 'matched Bash only) could both edit the hook wiring that runs the guard.',
    cause: 'Hook wiring was protected against shell commands only. Scope is the '
      + 'wiring alone (operator, 2026-09-29): other loop infrastructure is built '
      + 'through the queue and flagged human:authorize at merge.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'edit-guard.mjs', anchor: 'export function hookWiringEditProblem(' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: "'a dispatch denies edits to the hook wiring of its worktree and its main checkout'" }),
    ]),
  }),
  Object.freeze({
    id: 'setup-ran-five-phases-and-printed-three-ribbons',
    date: '2026-09-29',
    symptom: 'LFE: a 0.55.3 setup ran resolve, audit, interview, write and verify '
      + 'but printed only ribbons 1/5, 2/5 and 4/5; the operator asked where '
      + 'step 5 was, though verification and delivery had run.',
    cause: 'Setup ribbons were prose for the model to print by hand; nothing '
      + 'produced them, so phases went unannounced.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'step.mjs', anchor: 'export function renderSetupPhase(' }),
      Object.freeze({
        file: '../skills/setup/SKILL.md',
        anchor: '**Every phase begins with one call, which prints its ribbon; repeat that line verbatim.**',
      }),
    ]),
  }),
  Object.freeze({
    id: 'setup-wrote-the-new-schema-before-the-new-guard',
    date: '2026-09-29',
    symptom: 'LFE: setup to 0.55.2 wrote STATE 0.28.0, then every Bash command '
      + 'was refused by the working tree\'s 0.53.0 guard ("version: must equal '
      + '0.27.0"); it reverted STATE to recover.',
    cause: 'The setup skill named no write order, and scaffold --reconcile told a '
      + 'pre-migration STATE to "migrate the configuration first", which is the '
      + 'order the old guard cannot survive. Closed structurally by the global '
      + 'cutover: the running guard is the plugin\'s, never a repository copy '
      + 'older than the config beside it, and devendor works in its own '
      + 'worktree while the session keeps its vendored hooks.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../skills/setup/SKILL.md',
        anchor: '**Work in a linked worktree, never this checkout**',
      }),
      Object.freeze({ file: 'setup.mjs', anchor: "return refusal('LIVE_CHECKOUT'," }),
    ]),
  }),
  Object.freeze({
    id: 'installed-loop-smoke-omitted-the-role-briefs',
    date: '2026-09-29',
    symptom: 'LFE: setup to 0.55.1 ran the installed tools/agentic/loop-smoke.mjs '
      + 'and dispatch:plan-review failed with BRIEF_TEMPLATE_MISSING; the plugin '
      + 'battery had passed the same file as release-proven.',
    cause: 'From an installed copy the smoke builds its fixture by copying '
      + 'UNIVERSAL_TOOL_FILES; 0.54.0 added briefs/ to what scaffold vendors but '
      + 'not to that list. The plugin run builds its fixture through scaffold, '
      + 'so only the installed path ever lacked the briefs, and nothing ran it. '
      + 'Closed structurally by the global cutover: nothing is installed, and the '
      + 'smoke runs every step from the plugin against a devendored fixture.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'loop-smoke.mjs', anchor: 'const tool = (name) => join(TOOL_DIRECTORY, name);' }),
    ]),
  }),
  Object.freeze({
    id: 'hook-relay-ran-the-old-guard-during-setup-reconcile',
    date: '2026-09-28',
    symptom: 'LFE: setup migrated STATE to 0.28.0 and reconciled tools/agentic '
      + 'to 0.55.0 in the working tree, then every Bash command was refused: '
      + '"invalid ProjectConfig: caps: is required; version: must equal 0.27.0".',
    cause: 'hook-relay delegated whenever the local copy differed from the '
      + 'base copy, assuming the base is always newer. During a reconcile the '
      + 'working tree is the newer one, so the relay ran origin/main\'s 0.53.0 '
      + 'guard against the migrated STATE. Closed structurally by the global '
      + 'cutover: nothing is reconciled into a repository and nothing relays; '
      + 'the one guard is the plugin\'s, wired by the plugin.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../hooks/hooks.json',
        anchor: 'node \\"${CLAUDE_PLUGIN_ROOT}/tools/loop-execution-admission.mjs\\" --guard-entry command',
      }),
      Object.freeze({
        file: 'verify.mjs',
        anchor: "'the plugin hook document passes its contract'",
      }),
    ]),
  }),
  Object.freeze({
    id: 'setup-refused-by-its-own-sessions-parked-run',
    date: '2026-09-28',
    symptom: 'LFE: /autoloop:setup for v0.54.0 audited 26 scaffold changes, then '
      + 'the guard refused its interview (a live run never waits on a '
      + 'synchronous question). Setup told the operator to finish or park a '
      + 'unit that was already parked on its PR, with the tree clean on main.',
    cause: 'The session had run the loop and parked it; the run marker stayed '
      + 'live. Setup had no rule for its own session\'s parked run, so the '
      + 'guard\'s remedy (--close-run) read as bypassing it.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../skills/setup/SKILL.md',
        anchor: '**A parked run in this session is closed, not worked around.**',
      }),
    ]),
  }),
  Object.freeze({
    id: 'every-session-under-one-tmux-server-owned-the-loop-run',
    date: '2026-09-28',
    symptom: 'A run marker recorded the prime process\'s whole ancestry up to the tmux '
      + 'server, so any other session under that server, working in the same repo, '
      + 'matched it: its Stop hook could see a dark run and its AskUserQuestion was '
      + 'refused as if it were the loop.',
    cause: 'Ownership is "a marker pid is one of my ancestors", and the shell, '
      + 'multiplexer and init chain above Claude Code are shared by every session. '
      + 'The ancestry now ends at the session\'s own claude process.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'run-markers.mjs', anchor: 'export function ancestorChain(start, readEntry = procEntry, limit = 64) {' }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'FAIL [an ancestry stops at its own claude process]' }),
    ]),
  }),
  Object.freeze({
    id: 'a-native-route-bypassed-the-sessions-gateway',
    date: '2026-09-28',
    symptom: 'A Fable plan review on LFE never reached the operator\'s gateway: '
      + 'the session ran with ANTHROPIC_BASE_URL on a proxy that passes Claude '
      + 'models through, but the dispatch child ran direct (apiKeySource none).',
    cause: 'dispatchEnvironment deleted a session-wide ANTHROPIC_BASE_URL from '
      + 'every native route on the premise that the proxy never serves Claude '
      + 'models. Every dispatch now inherits the session environment untouched: '
      + 'autoloop sets no URL at all (SPEC-model-config.md).',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: "'every dispatch inherits the session\\'s ANTHROPIC_BASE_URL and runs its own role\\'s model'" }),
    ]),
  }),
  Object.freeze({
    id: 'closed-unit-markers-held-the-queue-for-40-minutes',
    date: '2026-09-28',
    symptom: 'The first run on 0.53.0 reconciled 33 markers of closed, merged '
      + 'units one by one before selecting anything, with 39+ eligible units '
      + 'idle for 40 minutes; 8 of them fail on every run.',
    cause: 'Every surfaced marker gated selection, though a closed issue\'s '
      + 'marker cannot change eligibility. The summary now splits markers into '
      + 'gating (issue open) and deferred, and deferred ones are reconciled in '
      + 'overlap windows.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'snapshot-contract.mjs', anchor: "'summary splits surfaced markers into gating (open issue) and deferred'" }),
      Object.freeze({ file: 'snapshot-contract.mjs', anchor: 'export function markerSchedule(snapshot) {' }),
    ]),
  }),
  Object.freeze({
    id: 'finished-units-were-re-reconciled-before-every-selection',
    date: '2026-09-28',
    symptom: 'A run started by reconciling 45 lifecycle markers, all on closed '
      + 'issues with merged PRs, one serial driver call each, while 39 eligible '
      + 'units waited; 7 of them could never finish and would be refused again '
      + 'on every run.',
    cause: 'The scan surfaced the marker of every merged PR\'s issue, and a '
      + 'merged unit whose marker never bound a head had no terminal phase. '
      + 'The driver now records it as terminal-refused, and the scan drops '
      + 'terminal tips on closed issues.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'lifecycle-contract.mjs', anchor: "name: 'a merged unit whose marker can never bind is refused terminally'" }),
      Object.freeze({ file: 'lifecycle-driver.mjs', anchor: "'an unrepairable merged unit is refused terminally once, then reconciles to nothing'" }),
      Object.freeze({ file: 'scan.mjs', anchor: "'finished markers on closed issues are not surfaced; the rest are'" }),
    ]),
  }),
  Object.freeze({
    id: 'a-rejected-tool-call-closed-the-run',
    date: '2026-09-28',
    symptom: 'A prime call went to a permission prompt that was answered "no" '
      + 'with no operator message; when a dispatch woke the turn, the Stop hook '
      + 'offered "a human asked for the session back" as the way out and the '
      + 'run closed with 39 eligible units queued.',
    cause: 'The hook named only take-a-unit or close. It now says the request '
      + 'must come in a message, and that a rejected or interrupted call parks.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'not that request: park instead with' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: "dark.hard[0].includes('asked for the session back in a message')" }),
    ]),
  }),
  Object.freeze({
    id: 'improvised-review-evidence-drew-the-permission-classifier',
    date: '2026-09-23',
    symptom: '9 of 29 permission-classifier blocks on one repository were '
      + 'review evidence improvised in /tmp — generated build scripts, .jq '
      + 'programs, skeleton JSON, `jq … > evidence.json` — and one held a run '
      + 'on a permission prompt for 10.3h before it halted.',
    cause: 'Only the escalation round had a tool; every ordinary round was '
      + 'hand-assembled, and fields such as artifactFingerprint and the '
      + 'identities had no defined derivation at all.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'review-contract.mjs', anchor: 'export function appendRound(evidence, result, options = {}) {' }),
      Object.freeze({ file: 'review-contract.mjs', anchor: 'export function artifactFingerprintOf(root) {' }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "if (process.argv.includes('--append-round')) {" }),
    ]),
  }),
  Object.freeze({
    id: 'a-synchronous-question-stalled-the-whole-queue',
    date: '2026-09-23',
    symptom: 'Three live runs asked the operator a question mid-run with '
      + 'AskUserQuestion and waited ~25h in total, with eligible units queued '
      + 'behind a question that concerned one unit.',
    cause: 'The no-menu rule was prose only. The guard now refuses '
      + 'AskUserQuestion while a run is live and names the recorded form: an '
      + 'issue comment, `human:decide`, the next unit.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'export function askUserQuestionProblem(runIsLive) {' }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "payload?.tool_name === 'AskUserQuestion'" }),
      Object.freeze({ file: 'verify.mjs', anchor: "matcher: 'Bash|AskUserQuestion'," }),
    ]),
  }),
  Object.freeze({
    id: 'the-stop-hook-blocked-sessions-with-no-open-run',
    date: '2026-09-23',
    symptom: 'The Stop hook hard-blocked turns in loop repositories when no '
      + 'loop run was open, and blocked unpushed work while the writer '
      + 'dispatch that owned it was still committing.',
    cause: 'Hard gaps fired regardless of run state, and the unpushed-work '
      + 'check ignored in-flight evidence.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'export function scopeToOpenRun(hard, reminders, runIsOpen) {' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'reminders, loopRunIsOpen(ROOT));' }),
    ]),
  }),
  Object.freeze({
    id: 'a-usage-limit-park-became-a-run-close',
    date: '2026-09-23',
    symptom: 'Runs that hit a model usage limit or a red base closed instead '
      + 'of parking, and nothing resumed them when the limit reset or the '
      + 'base went green.',
    cause: 'The Stop hook had no evidence for a timed wait, so a parked turn '
      + 'read as dark and the only way to end it cleanly was --close-run. '
      + '`prime.mjs --park` records the wait and the hook honours it until it '
      + 'expires.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'prime.mjs', anchor: 'export function parkRunMarkers(' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'export function parkEvidence(markers, nowMs) {' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: '?? parkEvidence(ownRunMarkers(ROOT)' }),
    ]),
  }),
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
        anchor: 'function dispatchProcesses(root) {',
      }),
      Object.freeze({
        file: 'writeback-check.mjs',
        anchor: '?? (processes?.length > 0 ? `a dispatch process is running',
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
      + 'harness defect, reported upstream — killed the dispatch with its task. '
      + '0.56.0: dispatch-stream.sh detaches the dispatch, so a swept watcher '
      + 'no longer loses it (verified live 2026-09-29); dispatches launch in '
      + 'the background again and a killed watcher\'s result is collected with '
      + '--wait-file. Only a bare backgrounded dispatch.mjs is refused.',
    enforcedBy: Object.freeze([
      // 0.69.0: the guard no longer judges a launch shape; the ordinary
      // corpus proves a background dispatch is allowed.
      Object.freeze({ file: 'command-guard.mjs', anchor: 'an ordinary command is never refused in the owning session' }),
      Object.freeze({
        file: '../skills/dev/SKILL.md',
        anchor: '**Launch every dispatch in the background**',
      }),
      Object.freeze({
        file: '../skills/dev/SKILL.md',
        anchor: '**A killed stream task is not a killed dispatch.**',
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
      + 'tools relay themselves to the base branch\'s copy. Closed structurally '
      + 'by the global cutover: hooks run the plugin\'s copy, which no branch '
      + 'carries, and find the repository from CLAUDE_PROJECT_DIR.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../hooks/hooks.json',
        anchor: 'node \\"${CLAUDE_PLUGIN_ROOT}/tools/loop-execution-admission.mjs\\" --guard-entry command',
      }),
      Object.freeze({
        file: 'writeback-check.mjs',
        anchor: 'ROOT = guardedRoot(sessionId);',
      }),
      Object.freeze({
        file: 'hook-root.mjs',
        anchor: 'return owned === null || owned.unreadable ? null : hookRoot();',
      }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'the owning session keeps every hook acting; a marker alone does not',
      }),
      Object.freeze({
        file: 'hook-root.mjs',
        anchor: "'CLAUDE_PROJECT_DIR is the root, whatever the cwd'",
      }),
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'const root = guardedRoot(input.session_id);',
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
        anchor: 'parked.hard.length === 0 && parked.reminders.length === 0',
      }),
      Object.freeze({
        file: '../skills/dev/SKILL.md',
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
        file: '../skills/dev/SKILL.md',
        anchor: "the chain's ROOT and stays the captured ID",
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
        anchor: 'findings is announced as `step.mjs --to 08-fix --round fix-<n>` under the current ',
      }),
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'dispatched nine implement-role fix',
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
      // 0.69.0: the ladder rule and its remedy moved from the guard to step.mjs.
      Object.freeze({ file: 'step.mjs', anchor: 'export function backwardStep(' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a backward-swap refusal names the caught pair and its own remedy' }),
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
      + 'returns null for. Following the advice would have proxied them. Since '
      + 'SPEC-model-config autoloop manages no proxy: preflight prints the step '
      + 'models and judges no environment, and the skill never probes one.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'session-preflight.sh',
        anchor: 'run_timed 10 node "$TOOLS_DIR/models-config.mjs" --lines',
      }),
      Object.freeze({
        file: '../skills/dev/SKILL.md',
        anchor: 'never probe, start or configure a proxy',
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
        file: '../skills/dev/SKILL.md',
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
        file: 'auto-merge.mjs',
        anchor: 'function finalizerHasNotRun(pr) {',
      }),
      Object.freeze({
        file: 'auto-merge.mjs',
        anchor: "name: 'a PR the terminal finalizer never touched says so first',",
      }),
      Object.freeze({
        file: '../skills/dev/SKILL.md',
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
        file: '../skills/dev/SKILL.md',
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
        file: '../skills/dev/SKILL.md',
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
        anchor: 'function sameArtifactRound(previous, current) {',
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
        file: '../skills/dev/SKILL.md',
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
        file: '../skills/dev/SKILL.md',
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
      // 0.69.0: the guard's add-only rule is removed; step.mjs, the only
      // label-swapping tool, always retires the predecessor.
      Object.freeze({
        file: 'step.mjs',
        anchor: 'the predecessor is named even when an earlier swap already lost it',
      }),
      Object.freeze({
        file: 'step.mjs',
        anchor: 'export function skippedSteps(',
      }),
      Object.freeze({
        file: 'step.mjs',
        anchor: "'a skipped step is printed under the ribbon and recorded'",
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
      // 0.69.0: the ladder rule moved from the guard to step.mjs.
      Object.freeze({ file: 'step.mjs', anchor: 'export function backwardStep(' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a backward swap is refused by this tool, printed, and changes nothing' }),
      Object.freeze({
        file: 'label-swap-reminder.mjs',
        anchor: 'This is the ONE plan review',
      }),
      Object.freeze({
        file: '../skills/dev/SKILL.md',
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
        file: 'auto-merge.mjs',
        anchor: 'function fetchPlannedBaseComparison(',
      }),
      Object.freeze({
        file: 'auto-merge.mjs',
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
      // 0.69.0: the guard's step-label rule is removed; step.mjs, the only
      // label-swapping tool, refuses a step it does not know.
      Object.freeze({ file: 'step.mjs', anchor: "'an unknown step is refused before anything moves'" }),
      Object.freeze({ file: 'step.mjs', anchor: "08's label; 00, 10 and 11 carry none." }),
      Object.freeze({
        file: '../skills/dev/SKILL.md',
        anchor: 'No label moves at this step, or step 11',
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
        file: '../skills/dev/SKILL.md',
        anchor: 'equally one human action, and equally irreversible',
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
        file: '../skills/dev/SKILL.md',
        anchor: 'A step is announced ONCE, by its ribbon',
      }),
      Object.freeze({
        file: 'step.mjs',
        anchor: "'the same step twice swaps nothing and says so'",
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
      // 0.69.0: loops are never judged; the ordinary corpus holds a literal
      // loop, and a loop body that merges is still caught.
      Object.freeze({ file: 'command-guard.mjs', anchor: 'an ordinary command is never refused in the owning session' }),
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
      // 0.69.0: interpreters are never judged; the ordinary corpus holds the lookup.
      Object.freeze({ file: 'command-guard.mjs', anchor: 'an ordinary command is never refused in the owning session' }),
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
    retired: '0.69.0: the guard no longer refuses an unresolved token, so no refusal names one (SPEC-guard-reduction).',
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
        file: 'verify.mjs',
        anchor: "{ name: 'retired CI policy absent', execute: () => checkRetiredCiPolicy(root) },",
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
      + 'authored work. Since SPEC-model-config every role resolves only its own '
      + 'entry of one table, so nothing is shared by posture.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: '  const entry = resolved.models[role];' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: "'with no global config the defaults are written and every role resolves its own entry'" }),
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
        file: '../skills/setup/SKILL.md',
        anchor: 'Never write `$?` in any form: the tool result already carries the exit status.',
      }),
      Object.freeze({ file: 'setup.mjs', anchor: 'console.log(JSON.stringify(result, null, 2));' }),
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
      // 0.69.0: the assembler rule is removed; every kept refusal names its
      // rule and one allowed form.
      Object.freeze({ file: 'command-guard.mjs', anchor: 'a refusal names its rule and one allowed form' }),
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
        file: '../skills/dev/SKILL.md',
        anchor: 'Never hand-query a unit',
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
    retired: '0.69.0: the guard no longer refuses an expansion, so no expansion refusal exists (SPEC-guard-reduction).',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'a loop refusal names the loop variable and the loop remedy',
      }),
      Object.freeze({
        file: 'command-guard.mjs',
        anchor: 'a bare-variable refusal names the variable and the substitution path',
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
      + 'an executable command is an invitation to improvise into a refusal. '
      + 'Since SPEC-model-config the loop probes no proxy at all: an unreachable '
      + 'model falls back inside dispatch.',
    enforcedBy: Object.freeze([
      Object.freeze({
        file: '../skills/dev/SKILL.md',
        anchor: 'never probe, start or configure a proxy',
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
        file: '../skills/setup/SKILL.md',
        anchor: 'Version currency, one pipeline',
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
      // 0.69.0: the guard's label rules are removed; the skill and the STATE
      // template still prescribe the vehicle.
      Object.freeze({
        file: '../skills/dev/SKILL.md',
        anchor: 'gh issue edit <pr-number> --add-label human:authorize',
      }),
      Object.freeze({
        file: '../templates/STATE.template.md',
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
      + 'template restructuring stranded every installed repo. Closed '
      + 'structurally by the global cutover: STATE is the repository\'s own '
      + 'prose, which no plugin change has to reach; devendor moves it once.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'setup.mjs', anchor: 'export function stateProse(markdown, template' }),
    ]),
  }),
  Object.freeze({
    id: 'exit-echo-decoration-took-the-typed-front-down',
    date: '2026-08-12',
    symptom: 'A live run appended `; echo "exit=$?"` to a typed escalate-paths '
      + 'call; the refusal cost the call and its useful front, and the retry '
      + 'that worked was the same command with the echo deleted.',
    cause: 'The guard refused `$?` as unresolvable although an exit status is '
      + 'a number that no position turns into a command. Since 0.50.0 special '
      + 'parameters are judged as a literal `0`, so the decoration is allowed.',
    enforcedBy: Object.freeze([
      // 0.69.0: no expansion is judged; the ordinary corpus holds `echo $?`.
      Object.freeze({ file: 'command-guard.mjs', anchor: 'an ordinary command is never refused in the owning session' }),
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
    retired: '0.69.0: the guard no longer refuses a substitution, so the labeled count is allowed as typed (SPEC-guard-reduction).',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: 'let prose carry the label' }),
      Object.freeze({ file: 'guard-corpus.json', anchor: '.test.ts tracked:' }),
    ]),
  }),
  Object.freeze({
    id: 'one-recording-could-not-route-each-step',
    date: '2026-09-23',
    symptom: 'The operator wanted a model per step — astra plans, Fable reviews '
      + 'the plan and simplifies, Opus writes and fixes, astra reviews 07/08 — '
      + 'and one review-engine line could express none of it: every verdict '
      + 'role shared one model and writers could not be routed at all.',
    cause: 'Routing was keyed to "verdict or not". Since 0.50.0 each role '
      + 'resolves only its own `routes` line (fail-closed on any bad line), a '
      + 'native route never inherits a proxy URL. Since SPEC-model-config each '
      + 'role has its own entry in one config table, and the no-self-review '
      + 'invariant is enforced in code, fallbacks included.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'models-config.mjs', anchor: 'export function invariantProblems(models) {' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: "'with no global config the defaults are written and every role resolves its own entry'" }),
      Object.freeze({ file: 'dispatch.mjs', anchor: "'an invalid model table fails the dispatch closed, typed, and names why'" }),
    ]),
  }),
  Object.freeze({
    id: 'the-guard-refused-reads-that-could-hide-nothing',
    date: '2026-09-23',
    symptom: '128 guard refusals in ten days of LFE runs, most of them reads: '
      + '~29 command substitutions, ~21 `$?`, ~13 inline awk ranges and sums. '
      + 'Each cost a turn, and none hid a git or gh mutation.',
    cause: 'Opaque syntax was refused by shape. It can only conceal a rule when '
      + 'its value reaches a command position, code, a command-running tool, '
      + 'Git/GitHub CLI environment, or a git/gh call other than a read-only git '
      + 'subcommand — and awk only runs anything through system/getline/pipes.',
    enforcedBy: Object.freeze([
      // 0.69.0: opaque syntax is never judged (SPEC-guard-reduction); the
      // ordinary corpus holds substitutions, `$?` and an awk pipe.
      Object.freeze({ file: 'command-guard.mjs', anchor: 'an ordinary command is never refused in the owning session' }),
      Object.freeze({ file: 'guard-corpus.json', anchor: 'find . $(cat args.txt)' }),
    ]),
  }),
  Object.freeze({
    id: 'effect-free-failures-stopped-the-run',
    date: '2026-09-23',
    symptom: 'Runs stopped on failures a rerun would have cleared: a reviewer that '
      + 'died mid-stream, a planner at its usage limit with a fallback recorded '
      + 'and never taken, a transient gh failure during prime, and host-killed '
      + 'stream tasks that took their in-flight dispatch down with them.',
    cause: 'Every retry was orchestrator prose, so each one cost a turn or was '
      + 'skipped. Since 0.50.0 reviewer-posture dispatches retry transient codes '
      + 'and take their fallback in the tool, scan retries transient gh reads, '
      + 'and the stream wrapper detaches the dispatch so a killed task is waited on.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: 'export function nextAttempt(' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: 'a writer is never rerun by the tool: it may have committed before it died' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: 'export function waitState(' }),
      Object.freeze({ file: 'scan.mjs', anchor: 'export function transientCommandFailure(' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '**A killed stream task is not a killed dispatch.**' }),
    ]),
  }),
  Object.freeze({
    id: 'mechanical-outcomes-waited-on-a-human',
    date: '2026-09-23',
    symptom: 'Units stopped at human:decide or a review hand-off whose outcome '
      + 'needed no judgement: an already-delivered premise, a wait on another '
      + 'unit or a red base, a Major re-raised every round, a verified '
      + 'out-of-delta finding, a gating cap round, and a ticked task box.',
    cause: 'Each had one mechanically checkable outcome, and nothing could '
      + 'record it except a block. Since 0.50.0 the unit disposes of itself: '
      + 'unit.mjs closes a delivered premise on evidence or parks the unit as '
      + 'loop-waiting until prime lifts it, the review contract defers and '
      + 'continues, and the driver ignores task-list ticks.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'unit.mjs', anchor: 'export function markObsolete(' }),
      Object.freeze({ file: 'unit.mjs', anchor: 'export function liftWaits(' }),
      Object.freeze({ file: 'snapshot-contract.mjs', anchor: "...(issue.labels.includes('loop-waiting') ? ['waiting'] : [])" }),
      Object.freeze({ file: 'review-contract.mjs', anchor: 'const DEFER_AFTER_RAISINGS = 3;' }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "return decision('continue', 'REVIEW_REPLAN', {" }),
      Object.freeze({ file: 'lifecycle-contract.mjs', anchor: 'export function issueBodyIdentity(' }),
    ]),
  }),
  Object.freeze({
    id: 'a-reached-limit-parked-the-unit-on-a-question',
    date: '2026-09-23',
    symptom: 'A unit at the review cap with only Majors open, or on a step the '
      + 'host killed three times, sat at human:decide for hours. The only '
      + 'answers were "ship it with the findings listed" and "try again later".',
    cause: 'Reaching a limit had one outcome, a block. Since 0.50.0 a closing '
      + 'round with only Majors under manual policy was REVIEW_CAP_HANDOFF: the '
      + 'unit published with the findings filed and listed for the human at '
      + 'merge; since 0.69.0 the spent fix budget is REVIEW_REPLAN, and the loop '
      + 'decides, re-plans once, or defers. The kill bound becomes a timed wait '
      + 'that prime lifts.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'review-contract.mjs', anchor: "return decision('continue', 'REVIEW_REPLAN', {" }),
      Object.freeze({ file: 'review-contract.mjs', anchor: "name: 'three fix rounds spend the budget: a Major still open is decided, re-planned or deferred'," }),
      Object.freeze({ file: 'unit.mjs', anchor: "condition = { on: 'time', until: new Date(now + minutes * 60_000).toISOString() };" }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '**`REVIEW_REPLAN` — the budget is spent, Majors remain.**' }),
    ]),
  }),
  Object.freeze({
    id: 'every-unit-paid-for-the-full-gate-twice',
    date: '2026-09-23',
    symptom: '83h of loop:09-gate label time on LFE: step 9 ran the full gate as '
      + 'a raw preflight, terminal-finalize ran it again on the same head, and '
      + 'again on every re-invoke after a settle refusal.',
    cause: 'The preflight left no evidence the finalizer could trust. Since 0.50.0 '
      + 'step 9 gates through publish-verdict, which publishes agentic/gate on '
      + 'green, and terminal-finalize reuses that exact-head status.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'publish-verdict.mjs', anchor: 'export function terminalGateSummary(' }),
      Object.freeze({ file: 'publish-verdict.mjs', anchor: 'const gate = (adapters.gate ?? terminalGateSummary)(snapshot, config);' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '`node <plugin-tools>/publish-verdict.mjs gate <head> > <log> 2>&1`' }),
    ]),
  }),
  Object.freeze({
    id: 'human-decisions-trickled-in-one-unit-at-a-time',
    date: '2026-09-23',
    symptom: 'Decisions waiting on a human were scattered across issue threads '
      + 'and found one at a time, and 22 of them were spec contradictions that '
      + 'shape could have caught before the issues were queued.',
    cause: 'Nothing gathered them, and shape checked criteria for testability, not '
      + 'for agreement with what they cite. Since 0.50.0 prime posts one digest '
      + 'at every close and park, and the shape Acceptance axis checks the source.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'unit.mjs', anchor: 'export function postDigest(' }),
      Object.freeze({ file: 'prime.mjs', anchor: 'export function withDigest(' }),
      Object.freeze({ file: '../skills/shape/SKILL.md', anchor: 'Each criterion must also AGREE with what it cites' }),
    ]),
  }),
  Object.freeze({
    id: 'a-units-cost-left-with-the-session',
    date: '2026-09-24',
    symptom: 'Per-step timings lived in the session panel and the dispatch log was '
      + 'machine-local with no issue on it, so a unit\'s cost could not be read back '
      + 'from GitHub; the scoreboard also dropped plan, plan-review and every resumed '
      + 'session (an issue with 2h57m of review across two sessions showed 1h51m).',
    cause: 'Nothing wrote the numbers to the issue, and the scoreboard measures one '
      + 'session from loop-started. Since 0.50.0 each dispatch logs its --issue and '
      + 'branch (plan and plan-review only by --issue: they run before the branch '
      + 'exists), and step 11 appends stats.mjs --record: active time per step '
      + 'across sessions, paused while blocked or waiting, with its dispatches.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'stats.mjs', anchor: 'export function unitActiveTime(' }),
      Object.freeze({ file: 'stats.mjs', anchor: 'export function timingRecord(' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: 'function currentBranch(cwd) {' }),
      Object.freeze({ file: 'stats.mjs', anchor: "const PRE_CLAIM_ROLES = new Set(['plan', 'plan-review']);" }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '`--issue <N>` names the unit on every dispatch' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '`node <plugin-tools>/stats.mjs --record --issue <N>`' }),
    ]),
  }),
  Object.freeze({
    id: 'any-dispatch-excused-every-units-unpushed-work',
    date: '2026-09-24',
    symptom: 'The Stop hook demoted every stranded-commit hard block to a reminder '
      + 'while ANY dispatch ran: a writer for unit A dying mid-push was excused by a '
      + 'reviewer still running for unit B.',
    cause: 'The in-flight signal was one repository-wide fact. The process table now '
      + 'ties each dispatch to its unit by its --issue, else its worktree branch, and '
      + 'unpushed work is excused only by a dispatch for its own unit.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'export function unitDispatchEvidence(pr, processes) {' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'export function dispatchIssueFromCmdline(cmdline) {' }),
    ]),
  }),
  Object.freeze({
    id: 'overlap-report-blind-in-a-linked-worktree',
    date: '2026-09-24',
    symptom: 'overlap-report run from a linked worktree reported no dispatches, and '
      + 'importing it ran its CLI, so stats.mjs kept a second copy of its parser.',
    cause: 'It resolved the dispatch log with --git-path, which is per worktree; '
      + 'dispatch.mjs writes the log in the common Git directory. It now uses '
      + 'dispatch.mjs\'s resolver, and a main guard makes it importable.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'overlap-report.mjs', anchor: 'const logPath = resolveDispatchLogPath(root);' }),
      Object.freeze({ file: 'overlap-report.mjs', anchor: 'if (isMain) main();' }),
    ]),
  }),
  Object.freeze({
    id: 'a-route-could-send-the-prompt-and-credentials-anywhere',
    date: '2026-09-24',
    symptom: 'A route or review-engine recording accepted any http(s) URL, and an '
      + 'agent can record one with a plain dispatch.mjs call: every dispatch on that '
      + 'route would send its prompt and inherited credentials to that host.',
    cause: 'The URL check was syntax only. Proxy URLs are now loopback only '
      + '(127.0.0.1, localhost, [::1]) in the routes table, its fallback, the proxy '
      + 'preset and the legacy review-engine recording. Since SPEC-model-config '
      + 'autoloop records no URL at all: a dispatch inherits the session '
      + 'environment, so no recording can redirect it.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch.mjs', anchor: 'export function dispatchEnvironment() {' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: "'every dispatch inherits the session\\'s ANTHROPIC_BASE_URL and runs its own role\\'s model'" }),
    ]),
  }),  Object.freeze({
    id: 'a-route-without-a-fallback-stopped-on-an-unavailable-model',
    date: '2026-09-24',
    symptom: 'A route with no recorded >model failed ROUTE_FALLBACK_MISSING at a usage '
      + 'limit or an unavailable model, although every model on the table is available '
      + 'to the operator.',
    cause: 'Fallbacks were opt-in per route. Since SPEC-model-config every role\'s '
      + 'default carries a fallback, and a model the session cannot serve moves '
      + 'any role, a writer too, to it.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'models-config.mjs', anchor: "implement: Object.freeze({ model: 'opus[1m]', effort: 'high', fallback: 'fable[1m]' })," }),
      Object.freeze({ file: 'dispatch.mjs', anchor: "'an unavailable model moves any role, a writer too, to its fallback once, stamped'" }),
    ]),
  }),
  Object.freeze({
    id: 'a-fix-outside-the-unit-had-no-way-into-the-queue',
    date: '2026-09-25',
    symptom: 'A manual session found a unit gate-red because the base failed a dependency '
      + 'audit, fixed it in a separate PR first and then delivered the unit; the loop could '
      + 'only file that fix without loop-ready, where no run could ever take it.',
    cause: 'Only a human could make an issue eligible. Since 0.52.0 unit.mjs --repair files it '
      + 'under the parent\'s loop-ready, the scan and contract re-check that provenance each '
      + 'run, and the guard keeps loop-repair for unit.mjs alone.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'unit.mjs', anchor: 'export function markRepair(' }),
      Object.freeze({ file: 'snapshot-contract.mjs', anchor: 'function repairAuthorized(repair) {' }),
      Object.freeze({ file: 'scan.mjs', anchor: 'export function repairItemFacts(' }),
      // 0.69.0: the guard's loop-repair rule is removed (SPEC-guard-reduction).
    ]),
  }),
  Object.freeze({
    id: 'units-blocked-on-calls-the-loop-could-make',
    date: '2026-09-25',
    symptom: 'Two manual queue sessions resolved blocks the loop would have held for a human '
      + '(a unit blocked only by inaccurate comment claims, a real defect in delivered work, a '
      + 'provenance rule that rejected a correct value), each with a one-sentence recommendation, '
      + 'and merged 15-20 PRs each in two days.',
    cause: 'Ambiguity, scope and a Critical at the review cap were human blocks by rule, and a '
      + 'block carried no machine-readable question. Since 0.52.0 only the closed human classes '
      + 'block (unit.mjs --block), and a judgment call is a recorded, reversible decision '
      + '(unit.mjs --decide).',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'unit.mjs', anchor: 'export function markDecided(' }),
      Object.freeze({ file: 'unit.mjs', anchor: 'export function markBlocked(' }),
      Object.freeze({ file: 'contract-lint.mjs', anchor: "code: 'BLOCK_WHEN_UNSURE'," }),
      Object.freeze({ file: 'contract-lint.mjs', anchor: "code: 'RAW_HUMAN_BLOCK'," }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '## Autonomy: fix, decide, or block' }),
    ]),
  }),
  Object.freeze({
    id: 'a-writer-probe-ran-the-machine-out-of-memory',
    date: '2026-09-30',
    symptom: 'LFE #398: a fix writer raised its own probe to 64 concurrent processes with '
      + '2,000 arguments each and ran it three times in a loop; the OOM killer fired and '
      + 'systemd failed the whole tmux scope, taking the session and every dispatch in it.',
    cause: 'Nothing bounded a writer\'s own test and probe runs, and a dispatch shares the '
      + 'session\'s cgroup, so the double fork does not survive a scope kill. Every writer '
      + 'brief now bounds its runs: modest concurrency, no repeat loops, within memory.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'briefs/implement.md', anchor: 'One out-of-memory kill ends this session and the loop\'s with it.' }),
      Object.freeze({ file: 'briefs/fix.md', anchor: 'One out-of-memory kill ends this session and the loop\'s with it.' }),
      Object.freeze({ file: 'briefs/simplify.md', anchor: 'One out-of-memory kill ends this session and the loop\'s with it.' }),
    ]),
  }),
  Object.freeze({
    id: 'reconcile-invented-a-merge-attempt-and-blocked-it-as-unknown',
    date: '2026-10-01',
    symptom: 'LFE #434 and #428: auto-merge.mjs refused both delivered PRs for a human merge '
      + '(protected paths), and the next run\'s reconcile replaced that question with a '
      + '"resolve the unknown merge operation" block.',
    cause: 'Under a non-manual policy, reconcile recorded a merge intent, then an attempt, on '
      + 'an open PR, but the driver never merges and no tool reports an attempt back, so '
      + 'the attempt always read as unknown. An open PR now waits (MERGE_PENDING) and stale '
      + 'merge bookkeeping on one clears.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'lifecycle-contract.mjs', anchor: "return transition('wait', 'await-merge', 'MERGE_PENDING', {" }),
      Object.freeze({ file: 'lifecycle-contract.mjs', anchor: "['stale merge bookkeeping clears to the premerge marker, which awaits the merge', (() => {" }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '`MERGE_PENDING` on a unit without `loop-blocked`' }),
    ]),
  }),
  Object.freeze({
    id: 'delivered-pr-head-moved-before-revision-entry',
    date: '2026-10-10',
    symptom: 'Two delivered, open PRs had new merge-updated heads. Pitcrew could not begin '
      + 'a revision because the old approval named the prior head.',
    cause: 'The revision request had one head field and the production reader compared the '
      + 'historical premerge approval with the new live head. Recovery now binds both heads '
      + 'without treating the old approval as a review of the new one.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'lifecycle-contract.mjs', anchor: 'delivered A with verified history and owned B requests an explicit revision' }),
      Object.freeze({ file: 'lifecycle-driver.mjs', anchor: 'production revision begins once, returns the PR to draft, and keeps A and B separate' }),
      Object.freeze({ file: 'lifecycle-driver.mjs', anchor: 'stale A verdicts and unrelated green CI do not approve B or C; C needs exact-head verdicts' }),
      Object.freeze({ file: 'lifecycle-driver.mjs', anchor: 'a wrong or missing PR base cannot start a revision' }),
      Object.freeze({ file: 'lifecycle-driver.mjs', anchor: 'a PR human:authorize merge signal is preserved without blocking revision' }),
      Object.freeze({ file: '../skills/pitcrew/SKILL.md', anchor: 'Use A for `expectedHeadOid` and B for optional `recoveryHeadOid`' }),
    ]),
  }),
  Object.freeze({
    id: 'tool-recovery-fault-created-a-human-decision',
    date: '2026-10-10',
    symptom: 'A changed delivered head was recorded as a human decision, although an answer '
      + 'could not supply the missing lifecycle transition.',
    cause: 'The block tool accepted every uppercase reason. New blocks now require a closed '
      + 'human reason; legacy records remain readable and recovery uses its typed result.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'unit.mjs', anchor: 'cannot create a human block or make a GitHub call' }),
      Object.freeze({ file: 'unit.mjs', anchor: 'legacy human reasons remain readable and visible in the digest' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '`REVISION_REQUIRED` routes to Pitcrew, not a human block.' }),
      Object.freeze({ file: '../skills/pitcrew/SKILL.md', anchor: 'Tool faults and incomplete evidence are not human decisions.' }),
    ]),
  }),
  Object.freeze({
    id: 'unchanged-draft-reminder-repeated-on-unrelated-stops',
    date: '2026-10-10',
    symptom: 'The Stop hook repeated the same draft-PR warning after several unrelated '
      + 'read-only replies.',
    cause: 'Draft classification had no session-local state. The hook now records only '
      + 'draft-reminder fingerprints, including known blocker labels. Blocked drafts name their '
      + 'issue gate instead of suggesting publication; hard errors and other diagnostics stay active.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'the real Stop hook emits an unchanged draft reminder once per session' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'blocked drafts identify issue blockers without publication advice' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'a standalone human gate is named even before the publication step' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'changing or removing a human gate emits one new accurate blocker notice' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'clearing all blockers permits publication advice and a standalone gate overrides mid-unit silence' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'invalid ownership remains a hard gap even on a blocked draft' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'a comment update stays silent but a new head gets one reminder' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'Pitcrew revision drafts are expected and stay silent' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'unwritable reminder storage fails open on every Stop' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'nonregular cache entries cannot block the hook or be replaced' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'oversized cache entries are ignored without suppression or replacement' }),
      Object.freeze({ file: 'writeback-check.mjs', anchor: 'hard Stops still block after an unchanged draft reminder was shown' }),
    ]),
  }),
  Object.freeze({
    id: 'late-review-collection-marked-the-gate-returned',
    date: '2026-10-12',
    symptom: 'A code-review result collected after the unit moved to step 09 printed '
      + '"09 gate returned" while the Docker gate was still running.',
    cause: 'Collection stamped the latest step before it read the result. Each dispatch now carries '
      + 'a step and attempt receipt; only an exact current match marks a return, and a retry or '
      + 'fallback counts no new review round. The record lock names its holder, so a lock a killed '
      + 'writer left is reclaimed instead of wedging every later step write (review R1); a writer '
      + 'commits and releases only while the lock still carries its nonce, and a moved lock is never '
      + 'put back (re-audit N2).',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'step.mjs', anchor: 'a late review cannot mark a later gate returned' }),
      Object.freeze({ file: 'step.mjs', anchor: 'same-role attempts reject old results, and duplicates keep the first return time' }),
      Object.freeze({ file: 'step.mjs', anchor: 'wrong, missing, malformed and legacy results leave the open record unchanged' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: 'real fake-engine success and failure receipts reach the collector' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: 'a fallback cannot rebind after a gate transition during the first attempt' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: 'a contested step lock cannot cancel a valid engine result or assert its return' }),
      Object.freeze({ file: 'dispatch.mjs', anchor: 'One review round per dispatch, however many attempts it took' }),
      Object.freeze({ file: 'dispatch-return-association.mjs', anchor: 'an owned lock blocks a second writer without being reclaimed' }),
      Object.freeze({ file: 'dispatch-return-association.mjs', anchor: 'a lock whose holder is dead, or whose pid now names another process, is reclaimed' }),
      Object.freeze({ file: 'dispatch-return-association.mjs', anchor: 'a lock left by a SIGKILLed writer no longer wedges the next one' }),
      Object.freeze({ file: 'dispatch-return-association.mjs', anchor: 'two writers reclaiming one stale lock both land, one at a time' }),
      Object.freeze({ file: 'dispatch-return-association.mjs', anchor: 'a writer whose live lock was moved aside writes nothing over the next writer and removes no other lock' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a lock left by a dead writer, or a reused pid, wedges no transition, dispatch note or close' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a corrupt step record is reported by transition and never replaced' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: 'only its own step returned' }),
    ]),
  }),
  Object.freeze({
    id: 'recursive-self-test-orphans-exhausted-session-memory',
    date: '2026-10-12',
    symptom: 'One self-test run left thousands of orphaned Node processes; three session cgroups '
      + 'recorded 2467 OOM kills and the load average passed 2000.',
    cause: 'The self-test started whenever argv[1] named the module, so each spawned worker started it '
      + 'again; timeouts killed only the direct child. Self-tests now need --self-test, and verify '
      + 'kills, confirms, and reports each self-test process group: settled from the test\'s exit, '
      + 'so a descendant holding its output is a leftover, not a timeout. verify.mjs runs its own '
      + 'self-test in the gate and never starts it from inside it.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'dispatch-return-association.mjs', anchor: 'importing with this module as argv[1] never starts the self-test' }),
      Object.freeze({ file: 'dispatch-return-association.mjs', anchor: 'the self-test refuses to run inside its own worker' }),
      Object.freeze({ file: 'dispatch-return-association.mjs', anchor: 'a timed-out worker is killed and confirmed gone' }),
      Object.freeze({ file: 'verify.mjs', anchor: 'a timed-out self-test loses its whole process group, child included' }),
      Object.freeze({ file: 'verify.mjs', anchor: 'a self-test that leaves a descendant fails and the descendant is killed' }),
      Object.freeze({ file: 'verify.mjs', anchor: 'is reported as left processes within seconds, not as a timeout' }),
      Object.freeze({ file: 'verify.mjs', anchor: 'a group that cannot be confirmed gone fails as a cleanup failure, and the gate stops there' }),
      Object.freeze({ file: 'verify.mjs', anchor: 'own self-test in its own group, and a self-test never starts it again' }),
    ]),
  }),
  Object.freeze({
    id: 'old-reconcile-marks-hid-blocked-waiting-and-repair-units',
    date: '2026-10-12',
    symptom: 'The LFE parked view showed open units as "00 reconcile" for 26h while their labels said '
      + 'loop-waiting, loop-blocked with a human gate, or loop-repair.',
    cause: 'Status views showed only the latest local step and hid earlier-run and record-step units. '
      + 'One pure projection now prefers a verified, same-repository, not future-dated snapshot '
      + 'over an older local mark, dates invalidated data as history, and keeps every open unit visible.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'parked-disposition.mjs', anchor: 'a local reconcile mark yields to a current blocked, waiting or repair observation' }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: 'newer local work outranks an older snapshot, and an active attempt keeps its model, role and round' }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: 'a unit absent from the snapshot stays visible with its own local state' }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: 'invalid, foreign, future-dated, unidentified, incomplete and missing snapshots are not authority' }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: 'an invalidated snapshot is dated history, never current' }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: 'earlier-run units and record steps stay visible as last seen; only a card closes a unit' }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: 'one entry per unit, and a blocked unit is not repeated as a human wait' }),
      Object.freeze({ file: 'step.mjs', anchor: 'the parked view shows a current blocked, waiting or repair observation instead of an old reconcile mark' }),
      Object.freeze({ file: 'step.mjs', anchor: 'the run card carries the same dispositions from the same projection' }),
      Object.freeze({ file: 'step.mjs', anchor: 'status rendering makes no GitHub call and changes no file' }),
      Object.freeze({ file: 'step.mjs', anchor: 'the projected run card stays within its byte bound and keeps the park' }),
      Object.freeze({ file: 'step.mjs', anchor: 'units an earlier run left open stay visible as last seen, never as running' }),
    ]),
  }),
  Object.freeze({
    id: 'delivered-card-hid-pending-automatic-merge',
    date: '2026-10-12',
    symptom: 'In a repository with automatic merge, a delivered unit left the parked view at its card '
      + 'while its merge was still pending, and the card said a human must merge it.',
    cause: 'The delivered caption was fixed text, and every card closed the step record. The caption now '
      + 'follows the validated merge.policy; a delivered card records the pending merge apart from closure '
      + 'until a shipped, human or blocked card supersedes it.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'parked-disposition.mjs', anchor: 'the delivered caption follows the validated merge policy and is neutral when unknown' }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: 'a pending delivery stays visible through its record step with its PR, policy and reason; a terminal card ends it' }),
      Object.freeze({ file: 'parked-disposition.mjs', anchor: 'a legacy delivered card is pending only while a later scan positively observes its open PR' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a delivered card names the merge policy, human merge only under manual, neutral when unknown' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a delivered automatic merge stays pending through 11-record, a repeated card and the run card' }),
      Object.freeze({ file: 'step.mjs', anchor: 'rendering a pending merge makes no GitHub call, never merges and changes no record' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a human gate outranks a pending merge on the parked line' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a pending merge beside a waiting or repair observation names both on the parked line and the run card' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a delivered unit sent back to a fix or revision step is no longer merge pending' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a later verified shipped close-out supersedes the pending delivery exactly once' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a human or blocked card supersedes a pending delivery, and a delivered card cannot reopen a finished unit' }),
      Object.freeze({ file: 'step.mjs', anchor: 'a legacy delivered record stays readable and unchanged, pending only while its open PR is observed' }),
      Object.freeze({ file: 'lifecycle-driver.mjs', anchor: 'a merged close-out supersedes a pending delivery once, and a reopened issue gets a human card' }),
    ]),
  }),
  Object.freeze({
    id: 'autoloop-acted-in-sessions-not-running-it',
    date: '2026-10-12',
    symptom: 'Human sessions in an Autoloop repository got the preflight and STATE injected, four gh '
      + 'queries and reminders on every Stop, riders, transcript copies and guard refusals, and a '
      + 'crashed guard refused there while any stale marker remained; loop skills could trigger on '
      + 'ordinary requests.',
    cause: 'Every hook decided through guardedRoot(), which answered for any repository with '
      + '.autoloop/config.json, run or not. One predicate now decides (run-markers.mjs ownedRun): '
      + 'this Claude process\'s open latch, its start time matching, naming the hook input\'s '
      + 'session_id. Prime writes it, --close-run closes it, /clear changes the session. Loop '
      + 'skills are explicit-invocation only.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'run-markers.mjs', anchor: 'export function ownedRun({ sessionId, includeClosed = false, ...where } = {}) {' }),
      Object.freeze({ file: 'run-markers.mjs', anchor: 'a missing session id, or another session (after /clear), is no ownership' }),
      Object.freeze({ file: 'run-markers.mjs', anchor: 'a closed latch is no ownership' }),
      Object.freeze({ file: 'run-markers.mjs', anchor: 'a latch whose pid now belongs to another process (start time differs) is no ownership' }),
      Object.freeze({ file: 'run-markers.mjs', anchor: 'a later prime re-opens ownership for its own conversation and keeps the pinned base' }),
      Object.freeze({ file: 'run-markers.mjs', anchor: 'a marker names its pids with start times, and a reused ancestor pid matches nothing' }),
      Object.freeze({ file: 'hook-root.mjs', anchor: 'function sessionOwnershipCases(check) {' }),
      Object.freeze({ file: 'hook-root.mjs', anchor: 'the owning session keeps the preflight and STATE, the Stop check, the rider and the transcript copy' }),
      Object.freeze({ file: 'hook-root.mjs', anchor: 'without a run, the guard still refuses a prime compound that deletes run state, and a prime in a foreign repository' }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'const latched = ownedRun({ sessionId, includeClosed: true });' }),
      Object.freeze({ file: 'edit-guard.mjs', anchor: 'if (ownedRun({ sessionId, includeClosed: true }) === null) process.exit(0);' }),
      Object.freeze({ file: 'subagent-transcript.mjs', anchor: 'const root = guardedRoot(payload?.session_id);' }),
      Object.freeze({ file: 'session-preflight.sh', anchor: 'REPO_DIR="$(node "$TOOLS_DIR/hook-root.mjs" --guarded-root 2>/dev/null)" || exit 0' }),
      Object.freeze({ file: 'prime.mjs', anchor: 'export function closeRun(' }),
      Object.freeze({ file: '../hooks/hooks.json', anchor: 'run-latches/$PPID.json' }),
      Object.freeze({ file: 'verify.mjs', anchor: 'holds a latch, closed too, and allows without one' }),
      Object.freeze({ file: 'verify.mjs', anchor: 'a hook with a statusMessage is refused' }),
      Object.freeze({ file: 'verify.mjs', anchor: "export const EXPLICIT_ONLY_SKILLS = Object.freeze(['codebase-design', 'dev', 'lean-code', 'queue-trace', 'setup', 'shape']);" }),
    ]),
  }),
  Object.freeze({
    id: 'close-run-disabled-the-guards',
    date: '2026-10-12',
    symptom: 'Security review of the session-ownership change: a run could run prime.mjs --close-run '
      + '(or re-prime with CLAUDE_CODE_SESSION_ID unset, empty or foreign) and the command and edit '
      + 'guards stood down for the rest of the session, so `gh pr merge` and deleting the run state '
      + 'were allowed.',
    cause: 'A closed latch ended all ownership, and prime bound the latch to the session id in its '
      + 'environment, which a command can change. A closed latch now keeps both guards for its own '
      + 'session until /clear or exit; prime reads the session id the command guard took from the '
      + 'prime command\'s hook input, refuses without it, never rebinds an open latch, and confirms '
      + 'the latch before writing a marker. The hand-off is single-use and expires in seconds, so a '
      + 'prime the guard did not recognise (after /clear) opens nothing (re-audit N1). A payload '
      + 'naming no session, a crashed guard and a guard '
      + 'that cannot start all refuse beside a latch; latches are read from an fd that cannot block.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'prime.mjs', anchor: 'a hand-off from another conversation is refused when the environment names a different session' }),
      Object.freeze({ file: 'run-markers.mjs', anchor: 'a closed latch keeps the guards for its own session only, until /clear' }),
      Object.freeze({ file: 'run-markers.mjs', anchor: 'an open latch is never rebound to another, an empty or a missing session id' }),
      Object.freeze({ file: 'run-markers.mjs', anchor: 'the guard hands prime the host session id once, fresh, in a private file of this process; nothing else is trusted' }),
      Object.freeze({ file: 'prime.mjs', anchor: 'after /clear an unrecognised or stale prime opens and reopens nothing' }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'a prime command prunes the latches of exited sessions; no other command does' }),
      Object.freeze({ file: 'run-markers.mjs', anchor: 'a latch swapped for a FIFO mid-read never hangs the reader' }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'a closed run keeps the guard for its own session until /clear, and a payload naming no session is refused beside a latch' }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'the guard hands prime the hook input' }),
      Object.freeze({ file: 'command-guard.mjs', anchor: 'a crashed guard refuses only for the session that owns a run, closed too' }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "process.on('uncaughtException', crashed);" }),
      Object.freeze({ file: 'edit-guard.mjs', anchor: 'a closed run keeps the edit guard for its own session until /clear, and a payload naming no session is refused beside a latch' }),
      Object.freeze({ file: 'hook-root.mjs', anchor: 'a closed run of this session: no preflight, Stop output, rider or transcript copy, and both guards refuse until /clear' }),
      Object.freeze({ file: 'prime.mjs', anchor: 'prime opens a run only for the host session the guard handed it, refuses without one, and never rebinds an open latch' }),
      Object.freeze({ file: 'verify.mjs', anchor: 'holds a latch, closed too, and allows without one' }),
      Object.freeze({ file: 'loop-smoke.mjs', anchor: "runTool('command-guard.mjs (prime)'" }),
    ]),
  }),
  Object.freeze({
    id: 'guard-reduction-left-literal-evasions-of-the-kept-rules',
    date: '2026-10-12',
    symptom: 'Review of the 0.69.0 guard reduction: a commit on the base through the contents API '
      + 'or createCommitOnBranch, a force ref move through updateRef, a merge through raw curl to '
      + 'api.github.com, `git -c alias.m=\'push --force\' m`, `gh alias set m \'pr merge\'`, a '
      + 'function, case or trap body, `bash <<EOF` fed a merge, `echo "gh pr merge" | sh`, '
      + '`sudo -u dev gh pr merge`, `GH=gh; $GH pr merge` and `gh workflow run` on an unmerged '
      + 'branch were all allowed. Three secret-path definitions disagreed (`src/tokenizer.ts` '
      + 'was secret in one, `.github/CODEOWNERS` was ordinary, and a prefix widening by `.github/` '
      + 'earned no label), and the dependency hard-defer lived only in skill prose.',
    cause: 'The kept rules matched gh positionals and a few REST paths, not the API families, the '
      + 'raw HTTP clients, or the text a command runs (alias values, function and trap bodies, fed '
      + 'shells). Wrapper option values were read as the command. The guard, the merge families '
      + 'and the lane each had their own secret-path regex; `.github/workflows` alone was protected; '
      + 'widenLane matched a prefix as a file; no tool read a manifest diff at the merge gate.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: 'command-guard.mjs', anchor: "['gh api -X PUT repos/o/r/contents/README.md -f branch=main -f message=x -f content=eA==', 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "['curl -X PUT https://api.github.com/repos/o/r/pulls/4/merge', 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "[\"git -c alias.m='push --force' m origin feat/gh-1-x\", 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "['git -c alias.st=status st', 'feat/gh-1-x', false]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "[\"gh alias set m 'pr merge' && gh m 1\", 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "['f() { gh pr merge 1; }; f', 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "['case x in x) gh pr merge 1;; esac', 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "[\"trap 'gh pr merge 1' EXIT\", 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "['gh workflow run ci.yml', 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "['bash <<EOF\\ngh pr merge 4\\nEOF', 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "['echo \"gh pr merge 4\" | sh', 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "['sudo -u dev gh pr merge 4', 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "['GH=gh; $GH pr merge 4', 'feat/gh-1-x', true]," }),
      Object.freeze({ file: 'command-guard.mjs', anchor: "['gh api HTTPS://API.GITHUB.COM:443/repos/o/r/pulls/42/merge -X PUT', 'feat/gh-2-y', true]," }),
      Object.freeze({ file: 'guard-corpus.json', anchor: 'H1 a contents PUT commits on the base past the checkout' }),
      Object.freeze({ file: 'guard-corpus.json', anchor: 'accepted by design, SPEC-guard-reduction required behavior 2' }),
      Object.freeze({ file: 'lane-contract.mjs', anchor: "'isSecretPath is the one secret-path rule: whole segments, key material, env files'" }),
      Object.freeze({ file: 'lane-contract.mjs', anchor: "'a prefix widening at or under a guardrail root is refused WIDEN_GUARDRAIL_ROOT'" }),
      Object.freeze({ file: 'lane-contract.mjs', anchor: "'every path under .github is protected'" }),
      Object.freeze({ file: 'escalate-paths.mjs', anchor: "['.github/CODEOWNERS', true]," }),
      Object.freeze({ file: 'auto-merge.mjs', anchor: "'package.json gains a dependency → human:authorize'" }),
      Object.freeze({ file: 'auto-merge.mjs', anchor: "'a changed manifest without fetched contents → human:authorize (fail closed)'" }),
      Object.freeze({ file: 'auto-merge.mjs', anchor: "'dependencyChanges names the gained keys and packages, and nothing for a bump or a removal'" }),
      Object.freeze({ file: 'publish-verdict.mjs', anchor: 'a review ledger widened into a protected path labels the pull request human:authorize before readiness' }),
      Object.freeze({ file: 'publish-verdict.mjs', anchor: "the human:authorize label is one gh api POST on the pull request's labels" }),
    ]),
  }),
  Object.freeze({
    id: 'every-step-was-announced-twice-and-a-pr-was-not-tied-to-its-issue',
    date: '2026-10-12',
    symptom: 'The transcript showed every step line twice: the card the step tool printed on its tool '
      + 'row, then the same line again as the model\'s own text. A delivered pull request in a list '
      + 'could not be read back to its issue without a lookup.',
    cause: 'The ribbon rule said a step is announced once, by its ribbon, and the model read the '
      + 'ribbon as the line it had to write, while the tool row already carried it. The ribbon and '
      + 'the card named the issue alone; no step passed the pull request number to the record.',
    enforcedBy: Object.freeze([
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: 'the line `step.mjs` prints on its tool row. Never\n  repeat it in prose' }),
      Object.freeze({ file: '../skills/dev/SKILL.md', anchor: '`step.mjs --to 10-publish --pr <M>`' }),
      Object.freeze({ file: 'step.mjs', anchor: "'a transition with --pr keeps the PR on the record, and every later ribbon names it beside the issue'" }),
    ]),
  }),
]);

export function auditIncidents(incidents = INCIDENTS, read = (file) =>
  readFileSync(join(HERE, file), 'utf8')) {
  return incidents.map((incident) => {
    const failures = [];
    if (incident.retired !== undefined) {
      if (!/^\d+\.\d+\.\d+: \S/u.test(String(incident.retired))) {
        failures.push('retired without a "<version>: <why>" note');
      }
      return { id: incident.id, date: incident.date, ok: failures.length === 0, retired: incident.retired, failures };
    }
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
    ['a retired incident keeps its entry, is not checked, and must name its release and reason', (() => {
      const [noted] = auditIncidents([{ id: 'x', date: '2026-01-01', retired: '0.69.0: the rule is removed', enforcedBy: [{ file: 'a.mjs', anchor: 'GONE' }] }], read);
      const [bare] = auditIncidents([{ id: 'y', date: '2026-01-01', retired: 'gone', enforcedBy: [] }], read);
      return noted.ok && noted.retired === '0.69.0: the rule is removed' && !bare.ok && bare.failures[0].includes('<version>: <why>');
    })()],
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
      console.log(`${row.ok ? (row.retired ? 'RETIRED' : 'PASS') : 'FAIL'} ${row.date} ${row.id}${row.retired ? ` (${row.retired})` : ''}`);
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
