# Spec: historical-markers

## Objective

Lifecycle markers on finished units are never reconciled again. A run spends its prime on live
units and one-time backfills. It does not redo old bookkeeping.

Field evidence, from living-football-engine on 2026-09-28 with v0.52.0:
- Prime surfaced 45 lifecycle markers. All 45 were on closed issues whose PRs had merged, and none
  overlapped the queue or any open PR.
- The skill requires every marker to be reconciled before selection (`skills/dev/SKILL.md:120-141`,
  `skills/pitcrew/SKILL.md:50-55`). That means 45 serial `lifecycle-driver.mjs --reconcile-json`
  calls, each needing its frozen plan fetched first.
- About 12 minutes in, 1 of 45 calls had finished. 39 eligible units sat idle. The Stop hook rejected
  the wait, and the operator had to override the skill.

Root cause:
1. `lifecycleIssueNumbers` feeds the issue of every merged PR into the marker scan
   (`templates/tools/scan.mjs:715-720`). `fetchLifecycleMarkers` returns every tip it finds, whatever
   its phase (`scan.mjs:734-785`).
2. A merged unit whose marker can never reach `terminal-record` has no terminal state. Examples are a
   `draft-pr` marker with no `headOid`, which is `artifactMismatch('terminal-marker')` at
   `lifecycle-contract.mjs:1296-1298`, or a marker head that differs from the merged head
   (`:1040-1045`). The driver refuses these on every run, forever. The prose then asks for "one
   comment" each time, and nothing makes that comment idempotent across runs.
3. The 12 `terminal-record` tips are driver no-ops (`lifecycle-driver.mjs:1108-1113`). Each still
   costs a plan fetch and two stable reads.

## Behaviour

1. **New terminal phase `terminal-refused`.**
   - Add it to `PHASES` in `lifecycle-contract.mjs:41-56`. The marker carries
     `refusal: {code, artifact, mismatch?}` and the merge commit `mergeOid`.
   - `reconcileLifecycle` returns it as a marker patch only when both are true:
     - the unit's PR is merged (`facts.merge.complete && facts.merge.merged`). The contract has no
       issue-state fact, and the driver already refuses an unmerged unit whose issue is not open
       (`lifecycle-driver.mjs:602-604`). A merge is irreversible, so it is the terminal fact; the
       scan filter (behaviour 3) adds the closed-issue condition for surfacing;
     - the refusal is one of the two shapes no driver path can ever finish after a merge: the
       marker never bound a claim or head (`terminal-marker`), or it bound a head the merge did
       not use (`merge`, "merged head vs marker head"). Every other `ARTIFACT_IDENTITY_MISMATCH`
       on a merged unit may be a contract defect a later release repairs (the #149 history in
       `lifecycle-contract.mjs`), so it stays reachable;
     - the observed merge commit is a commit OID. A missing one is an observation defect, and
       writing it would serialize `"mergeOid":undefined`, an unparseable marker.
   - In every other case, including every open issue and unmerged PR and every other block code, the
     result is the same as today.
   - A tip already at `terminal-refused` whose merge commit still matches reconciles to a no-op
     typed result, `LIFECYCLE_TERMINAL_REFUSED`. Incomplete merge evidence waits
     (`inspect-merge`), and a changed merge commit is itself a mismatch.
2. **The driver writes it, never the prose.**
   - The existing marker compare-and-swap successor path writes the patch (`lifecycle-driver.mjs:1106-1112`).
   - The driver's result still carries the refusal code and detail verbatim, so the run record can
     name the defect.
3. **The scan does not surface finished markers.**
   - `fetchLifecycleMarkers` drops a tip from `lifecycleMarkers.items` when its phase is
     `terminal-record` or `terminal-refused` AND its issue is not in the complete `openIssues` section.
   - If `openIssues` is incomplete, nothing is dropped and the section stays incomplete, exactly as
     today.
   - A terminal tip on a still-open issue is still surfaced.
4. **Prose.**
   - `skills/dev/SKILL.md` step 5 and `skills/pitcrew/SKILL.md` step 4: reconcile every marker the
     snapshot surfaces.
   - Delete the "post one comment carrying the refusal verbatim" instruction for terminal units,
     because the driver now records the refusal durably.
   - Keep "apply NO label" and "name it in the run record".
   - Delete the rationale anecdote at `:134-136`, which the mechanism now covers.

Steady state: a unit the loop merges ends at `terminal-record` through the driver and never appears
again. A unit a human merges is backfilled once, then drops out. A unit that can never be fixed is
refused once, gets `terminal-refused`, and drops out.

## Boundaries

- Always:
  - Git and GitHub facts stay lifecycle authority. `terminal-refused` is written only after the
    driver's stable reads prove the issue is closed and the PR merged.
  - Marker authority and trust rules are unchanged (`scan.mjs:723-732`).
- Never:
  - Write `terminal-refused` on a live unit.
  - Let the scan drop a marker on an open issue, or drop one when `openIssues` evidence is
    incomplete.
  - Let a marker be edited or appended outside the driver.
  - Change behaviour for any refusal code other than `ARTIFACT_IDENTITY_MISMATCH`.
- Ask first: bounding how much merged-PR history the marker scan reads (see Open questions).

## Tests (failing first)

- `lifecycle-contract.mjs --self-test`:
  - Closed issue, merged PR, `draft-pr` tip without `headOid` → patch to `terminal-refused` with
    `refusal.artifact === 'terminal-marker'`.
  - Same for a merged head that differs from the marker head (`artifact === 'merge'`).
  - Open issue with the same mismatch → unchanged block, no patch.
  - Unmerged PR → unchanged block.
  - A `terminal-refused` tip with matching facts → `LIFECYCLE_TERMINAL_REFUSED`, no patch.
  - The marker validator accepts `terminal-refused` with `refusal` and rejects it without.
- `lifecycle-driver.mjs --self-test`:
  - A merged `draft-pr` unit makes exactly one successor write, and a second reconcile writes nothing.
  - The result carries the refusal code and detail.
- `scan.mjs --self-test`:
  - Tips at `terminal-record` or `terminal-refused` on closed issues are dropped.
  - The same tips on open issues are kept.
  - Non-terminal tips on closed issues (a backfill) are kept.
  - Incomplete `openIssues` → nothing dropped and the section is incomplete.
- `snapshot-contract.mjs --self-test`: snapshot validation accepts the filtered section.
- `regression-index.mjs`: add an incident for the 45-marker historical reconcile that blocked
  selection (LFE, 2026-09-28).
- Full gate: `node templates/tools/verify.mjs --plugin-root .`, then regenerate the manifest with
  `node templates/tools/verify.mjs --emit-self-test-manifest > templates/tools/self-test-manifest.json`.

## Success criteria

- Replaying the LFE shape (45 closed markers: 12 `terminal-record`, 26 `premerge-record`, 6
  `draft-pr`, 1 head-mismatched `premerge-record`) gives this:
  - The first run reconciles the 33 non-terminal ones. 26 backfill to `terminal-record` and 7 become
    `terminal-refused`.
  - The second prime surfaces 0 markers.
- No refusal comment is posted by prose, and a second run adds none.
- `verify.mjs` is green.

## Open questions

1. **How much the scan reads.** Every prime still reads the comments of every merged PR's issue, up
   to `MAX_ITEMS = 10000` (`scan.mjs:31-32,496`), just to find the tips it will now drop. This spec
   leaves that alone. The other bug fixed here made the cost visible, but it has not been measured
   on its own. Bounding it (for example, skipping issues whose last marker read was terminal) is a
   separate change if a measurement justifies it.
2. **Backfills still run before selection.** On the first run after the fix, LFE will still make its
   33 driver calls before taking work: 26 successor writes and 7 terminal refusals. That is a
   one-time cost. The recommendation is to keep the ordering rule as it is rather than add a second
   "closed-issue markers run at the end" path.
