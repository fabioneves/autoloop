# Spec: marker-recovery (v0.53.1)

## Objective

Recovering a surfaced lifecycle marker takes one bare, fast call instead of a hand-built request.

Evidence: the first LFE run on v0.53.0 (2026-09-28, session 0bf7f2f2).
- The run had 33 surfaced markers to reconcile. Building the requests took a forked agent about
  100k tokens and several minutes. It had to work out the recipe from `lifecycle-driver.mjs` and
  `skills/dev/SKILL.md:1189-1215`:
  - the 9 intent keys from the tip;
  - the root comment id, not the tip;
  - the plan body, with exact bytes;
  - the PR title and body.
  The guard also refused its first GraphQL query, because the query was read from a file.
  The previous run (0.52.0) improvised the same recipe from scratch.
- Every driver call took about 37s. One `readOperationalState` on LFE #270 made **17 serial `gh`
  calls in 9.4s**, and a reconcile that writes does at least 4 reads (`readStable` reads twice, before
  and after the write). Within that one read:
  - 7 of the calls were `collaborators/<login>/permission` for the same login;
  - 3 were pages of `pulls?state=all` (210+ PRs, 2.6s), used to find the PR of one branch.

## Behaviour

1. **`lifecycle-driver.mjs --reconcile-issue <N>`.** It builds the reconcile request from GitHub,
   then runs the existing `driveLifecycle`. The output is the same typed result as
   `--reconcile-json`.
   - **Intent:** the 9 intent keys of the tip of the issue's authoritative marker chain. The
     chain is resolved with the same trust and author rules the read already applies. The
     `lifecycleCommentId` is the chain root.
   - **Plan body:** the one authorized comment on the issue whose sha256 is `planHash`. The frozen
     plan comment lives on the same issue, so no extra read is needed.
   - **Title and PR body:** from the marker's `pr`, via `pulls/<pr>`.
   - **Base branch:** `baseBranch` from the validated ProjectConfig in `docs/agentic/STATE.md`.
   - **`premergeRecordDraft`:** `null`.
   - **Refusals** (errors on stderr, exit 1, the same as `--reconcile-json`), with no GitHub
     mutation:
     - no authoritative marker;
     - no plan comment, or more than one;
     - no `pr` on the marker (an intent that crashed before its draft PR). This keeps
       `--reconcile-json`, because only the frozen plan knows the title and PR body.
       The refusal prints the root ID and the intent to use;
     - a PR whose head is not the marker's branch.
   - The read refuses an issue whose `repository_url` is not the repository `origin` names. GitHub
     redirects a transferred repository's API path, but a head filter on the stale owner finds no PR.
   - The request is built by a pure function from the fetched facts, so it can be self-tested.
   - The CLI mode stays a closed list, and `<N>` must be a positive safe integer.
2. **A cheaper read. The guarantees don't change.**
   - Collaborator roles are memoized per login within one `readOperationalState`.
     `readStable` still reads twice, so a role change between reads is still observed.
   - The branch's pull request is read with `pulls?state=all&head=<owner>:<branch>`, not by paging
     every PR. `exactPullRequest` still requires the ref, the valid claim and the issue.
     - A fork PR that reuses the branch name no longer makes the lookup ambiguous. Loop PRs are
       same-repository by contract (`loopOwnership`, `scan.mjs`).
3. **Prose.**
   - Dev step 5 and the recovery recipe (`skills/dev/SKILL.md:1189-1215`) recover a surfaced marker
     with one bare `--reconcile-issue <N>` call.
   - `--reconcile-json` stays for a marker with no PR, and for flows that carry a
     `premergeRecordDraft`.
   - The pitcrew recovery line says the same.

4. **Markers of finished units never gate selection.**
   - Evidence: the first 0.53.0 run on LFE sat 40 minutes with 39+ eligible units while it
     reconciled 33 markers, all on closed issues with merged PRs. Such a marker cannot affect
     eligibility: its issue is closed, and `eligibleQueueIssueNumbers` already excludes marker
     issues. `SPEC-historical-markers.md` open question 2 recommended keeping it before selection,
     and the run proved that wrong.
   - `prime --json` and `snapshot-contract --summary` gain
     `markers: {gating: [<issue>], deferred: [<issue>]}`:
     - `gating`: surfaced markers whose issue is in the complete `openIssues`;
     - `deferred`: the rest (closed issues);
     - `null` when `lifecycleMarkers` or `openIssues` is incomplete.
   - Dev step 5 and pitcrew step 4: reconcile `gating` markers before selection. Reconcile
     `deferred` markers while a dispatch is in flight (the overlap windows), or before
     `--close-run`, never ahead of the queue.
   - The same run also left 8 markers that fail on every attempt: 7 with
     `PREMERGE_CI_COMPONENT_MISMATCH`, where the pre-merge CI evidence no longer matches live CI
     for merges a month old, plus #314. Deferring keeps them off the critical path. Whether the
     terminal-outcome append should re-verify CI evidence on an already-merged PR is a separate
     contract decision.
5. **The Stop hook reads every open issue.** `writeback-check.mjs:873` read
   `issue list --state open --limit 100`, and LFE has 139 open issues. The hook counted 39 eligible
   units against prime's 59, and treated any dependency outside the first 100 as closed. With a
   large backlog it can miss a stalled run. The limit becomes 1000, matching the scan's own bound
   of ten 100-item pages.
6. **A park that waits on anything but a dispatch is recorded before its ribbon prints.** In both
   the 0.52.0 and 0.53.0 runs the orchestrator printed `🅿️ PARKED` while waiting on a background
   subagent, and the Stop hook hard-blocked the turn. The hook recognises dispatch processes,
   live streams and recorded parks; a subagent is none of those. The ribbon section of the dev
   skill says to run `prime.mjs --park` first in that case.

## Boundaries

- Never:
  - Weaken trust: the same authorized-role, chain-author and malformed-marker checks.
  - Mutate anything while building the request.
  - Infer a title or PR body.
  - Let the batching change the double read in `readStable`.
- Ask first: dropping `readStable`'s second read.

## Tests (failing first)

- `lifecycle-driver.mjs --self-test`:
  - The builder returns a request with no gaps (`reconcileRequestGaps`) from a fixture issue:
    root plus successor markers, the plan comment and a PR.
  - It uses the root id, not the tip.
  - It refuses a missing marker, a missing plan, two plans, and a marker without a PR.
  - It ignores marker and plan comments from unauthorized authors.
  - `cliMode(['--reconcile-issue', '12'])` is accepted; `'0'`, `'x'` and extra arguments are
    refused.
- Guard corpus: `node tools/agentic/lifecycle-driver.mjs --reconcile-issue 219` is allowed.
- Live and read-only on LFE, under the `gh` shim: one read makes ≤ 10 calls, down from 17. The time
  goes in the commit message.

## Success criteria

- The self-tests above fail before the change and pass after it.
- `verify.mjs --plugin-root .` is green.
- The live read is measured and recorded.
