# Meta-review of `autoloop-review-consolidated.md` — v1

- **Reviewed artifact:** `autoloop-review-consolidated.md` (review dated 2026-07-23, efficiency amendment 2026-07-24)
- **Reviewed tree:** v0.39.9 at `9dbc5b6`
- **This meta-review:** v1, 2026-07-24
- **Method:** read every cited file; reproduced each executable claim with `node`; ran all vendored `--self-test` suites; verified the two GitHub doc citations by fetch; confirmed the byte-count baseline with `wc -c`.

This is a review *of the consolidated review*, not of Autoloop directly. It records where the
consolidated review is accurate, where it overstates or under-scopes, and what to fix before acting
on it.

## Overall verdict

The consolidated review is accurate, well-grounded, and high quality. Every one of findings 1–12 was
reproduced or confirmed against the actual code and prose. Its central recommendation — stay on
`merge.policy: manual`; do not enable `auto-merge.mjs` until findings 9–12 plus the server-side
controls are in place — is sound, and is corroborated by the codebase's own admission that the
shared-login verdict is "evidence, not proof" (`templates/tools/publish-verdict.mjs:10-12`).

Four substantive caveats on findings 1–12, and two scoping problems in the efficiency amendment,
follow. None overturn the review's conclusions.

## Part A — verification of findings 1–12

| # | Verdict | Note |
|---|---|---|
| 1 | Confirmed; **severity overstated** | Real contract violation (pitcrew marks `loop-delivered` without waiting for CI; dev waits). But `auto-merge.mjs` independently re-checks CI fail-closed, so the blast radius is a misleading label, not an unsafe merge. Major, not Critical. |
| 2 | Confirmed | `skills/dev/SKILL.md:697-701` explicitly records out-of-delta findings and never gates them. |
| 3 | Confirmed core; **one sub-claim is dead code** | Branch-issue vs body-issue mismatch and the `Closes: #5` colon-grammar split are real and reproduced. The "`scan.mjs:47` falls back to group 4 (`resolv` suffix)" sub-claim is dead code — group 5 always captures the digits on a match, so `closes[5] ?? closes[4]` never reaches group 4. Fragile, not live. |
| 4 | Confirmed — all four bypasses reproduced | See Part D. |
| 5 | Confirmed; **contains the single most actionable bug** | Point 2 (doctor requires `sandbox_mode = "read-only"` while the shipped 0.145 template uses `default_permissions = ":read-only"`) means a fresh Codex install scaffolds a template the same skill's own doctor then fails. Buried as a three-part Major; deserves top billing. |
| 6 | Confirmed | `validateStop({reason:'queue-exhausted'})` with no `eligibleRemaining` returns `{ok:true}` because `Number(undefined) || 0 === 0` — unknown silently treated as drained. |
| 7 | Confirmed | Claim ordering `skills/dev/SKILL.md:586-604` (branch/commit/push/plan-comment before draft PR) vs adoption keying on an open draft PR; merge (step 10) precedes the run record (step 11). |
| 8 | Confirmed; **one mitigating factor omitted** | `escalate-paths.mjs` uses the repo default not `cfg.baseBranch`, omits `.opencode/**`, has no planned-path mode. Mitigation the review doesn't mention: `auto-merge.reference.mjs`'s root-dotfile catch-all `/^\./` (line 495) still protects `.opencode/`, so only the `human:authorize` labeling floor is exposed, not the auto-merge floor. Drift is bidirectional — escalate-paths includes `.githooks/**` that STATE's list omits. |
| 9 | Confirmed | `CORE_QUERY` (`auto-merge.reference.mjs:88-119`) fetches no `headRefName`, body, or linked issue. |
| 10 | Confirmed | `pathA = SAFE_LABELS.some(...labels.includes...)` — no event/actor/OID binding. |
| 11 | Confirmed | Statuses filtered on context + state + sha only, never creator/app. |
| 12 | Confirmed TOCTOU; **one sub-claim unverified** | The non-atomic snapshot and the strict-up-to-date base-freshness answer are correct and match GitHub docs. The "public user-owned repo is ineligible for merge queue" claim could not be confirmed from the cited doc (the fetched merge-queue page carried no availability statement). Plausible; the capability-detect mitigation is right regardless. |

## Part B — the four substantive pushbacks (findings 1–12)

1. **Finding 1 is Major, not Critical.** Pitcrew step 7 under `ratified`/`auto` still calls
   `auto-merge.mjs`, whose triggered-checks floor (`auto-merge.reference.mjs:667-679`) re-checks CI
   fail-closed. A premature `loop-delivered` is a wrong label, not an unsafe merge; under `manual`
   it is cosmetic. The inconsistency is real and worth fixing, but it does not earn Critical on blast
   radius.

2. **Finding 3's "group 4 fallback" is dead code.** `"Resolves: #7"` → group 4 `"es"`, group 5
   `"7"`; group 5 always captures on a match, so the fallback never fires. The colon-grammar split
   in the same finding *is* live and real.

3. **Finding 12's merge-queue-ineligibility assertion is unverified.** Stated more definitively than
   the cited GitHub source supports. Verify against current docs before treating it as settled.

4. **Finding 8 omits a mitigating factor.** The `.opencode/**` gap exposes the `human:authorize`
   floor, but the auto-merge protected floor still catches `.opencode/` via the root-dotfile
   catch-all. Narrower exposure than "suppresses `human:authorize`" alone implies.

**Meta-point.** Autoloop is mostly prose skill contracts (interpreted by a model) plus a handful of
executable `.mjs` tools. The review treats "two prose passages disagree" and "the tool has a bug" as
the same kind of finding; for remediation they are not. The clearest executable defect — the
doctor/`sandbox_mode` contradiction (finding 5.2) — is the lowest-effort, highest-certainty fix in
the whole document and should lead the queue: it breaks a fresh Codex setup today and is a one-line
prose correction.

## Part C — efficiency amendment review (2026-07-24)

**Verified facts.** The byte-count baseline table is exact (dev 83,379 / setup 56,141 / STATE 27,669
— all three match `wc -c`). The ~30,000-token protocol hypothesis is consistent: dev body (~23.8K
tokens) + STATE hook injection (~7.9K) ≈ 31.7K before issue/code context, and it is correctly
labeled a hypothesis to instrument. The even-count median defect is reconfirmed (see Part D).

**Verdict.** Sound, and it does the hard part right: every optimization is subordinated to the
safety invariants ("never cache merge authority across a mutation or wait"; "lifecycle labels remain
authoritative until an equally recoverable replacement exists"; "never add a second implementer");
the "existing gains to preserve" list matches the code; "measure first, source bytes aren't
additive" is the right posture. Two scoping problems remain.

### Issue 1 — the baseline is pinned on a tool that cannot produce most of it

The amendment names `stats.mjs` "the baseline authority" (line 358) and makes fixing its median the
Step-0 enabler. But `stats.mjs` computes only per-step wall-clock durations from label-event
timelines (`{n, median, mean, min, max}` per step). The baseline it asks for (lines 349-357;
acceptance 522-523) needs far more, and `stats.mjs` structurally cannot deliver it:

- **No tokens, API-request/subprocess/mutation counts, engine-dispatch durations, review yield, or
  gate/recovery outcomes** — none exist in the tool.
- **No p95.** The section requires "p50 and p95" (line 360) and p95 in acceptance (523); `dist()`
  returns only median/mean/min/max.
- **Cannot separate active work from wait time** (line 351 requires it). A single label such as
  `loop:05-implement` spans active implementer work *and* engine/host wait *and* overlap staging;
  the label-gap duration conflates all three by construction.

So the median fix is necessary but nowhere near sufficient. The true Step-0 prerequisite is
**building an instrumentation harness** (token/call/mutation/dispatch capture, active-vs-wait
separation, percentiles), which the metrics list implies but the doc never names as a deliverable.
**Fix:** name the harness explicitly as the Step-0 deliverable; demote `stats.mjs` to the coarse
step-timing slice (plus a p95 addition), not the authority.

### Issue 2 — a pre-remediation baseline cannot set the enforced budgets

Step 0 captures a pre-remediation baseline; Step 8 sets budgets "using the retained pre-remediation
baseline." But the safety fixes in between legitimately raise per-unit cost — finding 6's
complete-scan pagination fetches more, finding 9's full ownership re-assertion adds gate-time calls,
finding 11's verdict CheckRun adds another. Budgets enforced against pre-remediation numbers will
false-flag the safety fixes as regressions, or be loosened until they catch nothing. **Fix:** make
the two-baseline structure explicit — pre-remediation numbers attribute the safety fixes' cost;
enforced budgets come from a re-baseline after Step 7.

### Minor

- **Provenance.** The opening still calls the whole document "the durable, corrected result of the
  six review rounds" (line 9), but the efficiency section is a single-pass amendment that did not go
  through those rounds. Mark it so a reader doesn't assume equal vetting.
- **"Generation-tagged snapshot" is aspirational.** `scan.mjs` emits `scannedAt` (a timestamp), not
  a generation tag; the typed/tagged snapshot is built by the finding-6 rework. The "should consume"
  phrasing keeps it prescriptive, so it's fine.
- **One implicit twofer.** Finding 8's "require an explicit configured base ref/OID" (Step 2) is the
  same change that removes `escalate-paths.mjs`'s per-call `gh repo view` (efficiency item 3). Note
  it so it isn't implemented twice or measured as separate work.

### Correctly dropped (good judgment, not oversight)

- **Implementer effort-tiering** — a speed-for-correctness trade the document's philosophy rightly
  resists.
- **The double `git status` in the Prime chain** (`skills/dev/SKILL.md:61-62`) — ~10ms local,
  beneath notice.

## Part D — reproduction evidence

**Finding 4 — command-guard bypasses** (`block:false` = bypass; reproduced via `evaluate()`):

```
git commit -m "x" && git switch -c feat/gh-1-y   on main  → block:false   (order-insensitive; commit lands on main)
git push origin HEAD:main                                  → block:false   (ordinary destination refspec to base)
git push origin --delete main  /  git push origin :main    → block:false   (base deletion)
gh --repo o/r issue comment 5 -b "hi"                      → block:false   (global flag defeats the \bgh\s+(pr|issue) anchor)
```
Plus `PERMANENT = ['main','master','develop']` hardcoded (`command-guard.mjs:39`) instead of
`cfg.baseBranch`.

**Finding 3 — loop-ownership parsing:**
```
inScope({branch:'feat/gh-12-x', body:'Closes #99'})  → {inScope:true}   (no branch==body issue check)
classifyPrs([... 'feat/gh-12-x','Closes #99' ...])   → issue: 99        (body wins; branch ignored)
"Closes: #5":  scan/loop-scope match=true · stats/writeback match=false (colon-grammar split)
"Resolves: #7": group4="es", group5="7"                                 (group-4 fallback is dead code)
```

**Finding 6 — absence conclusion:**
```
validateStop({reason:'queue-exhausted'})  → {ok:true, why:'queue drained'}   (missing eligibleRemaining treated as 0)
```

**Efficiency — even-count median defect:**
```
median[100,200]        = 100   (statistical 150)
median[100,200,300,400]= 200   (statistical 250)   → picks lower-middle, biases p50 low
```

**All 12 vendored self-tests pass** (command-guard 32, loop-scope 8, scan 4, run-scope 57,
config-contract 34, escalate-paths 23, stats 11, writeback-check, publish-verdict 9,
subagent-transcript, label-swap-reminder 17, auto-merge 75/75). The suites are green *while* the bugs
exist — evidence the coverage has exactly the gaps the review names (stats tests only n=2 identical
values; command-guard never tests chained-commit or destination refspecs; config-contract never
tests runtime keys).

## Recommended priority before acting

1. Correct finding 1 to Major and finding 3's dead-code phrasing; re-verify finding 12's merge-queue
   eligibility claim.
2. Promote the doctor/`sandbox_mode` contradiction (finding 5.2) to the front — it breaks a fresh
   Codex install today, one-line fix.
3. Rescope the efficiency Step 0: name the instrumentation harness as the deliverable (stats.mjs is
   the step-timing slice, needs p95); split pre-remediation baseline from post-Step-7 enforced
   budgets.

All `tools/agentic/*` changes are escalate-path and loop-infrastructure, so per Autoloop's own rule
(`templates/STATE.template.md:218-223`) they land as evidence-backed `loop-ready` issues with the
full cycle, not direct edits.
