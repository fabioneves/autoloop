# Spec: repair PRs auto-merge on their parent's authority

## Objective

A loop repair (`unit.mjs --repair --parent <N>`) carries `loop-repair`, never `loop-ready`: its
authority is the parent's `loop-ready`. Selection (snapshot-contract `repairAuthorized`) and, since
0.62.0, finalize (`publish-verdict repairStands`) read that standing. The merge executor still
requires `loop-ready` on the linked issue itself, so every repair PR waits for a human even when
auto-merge is on. Operator decision (2026-09-30): repair PRs auto-merge.

Success: with auto-merge enabled, a delivered repair whose parent still stands merges exactly like
an ordinary unit; every other precondition (hard labels, dependencies, exact-head verdicts,
premerge record, ownership, merge-protected paths, base config) is unchanged.

## Authorization rule

The linked issue's authorization is ONE of:

1. **Ordinary (unchanged):** the issue carries `loop-ready`; its latest `loop-ready` event is a
   `labeled` event by a trusted role, newer than the issue's last edit.
2. **Repair (new):** the issue carries `loop-repair` and not `loop-ready`, and all of:
   - its body holds exactly one valid repair marker (`parseRepair`, depth 1);
   - it was authored by the loop login and never edited (`lastEditedAt` null). The loop never
     edits a repair body; a human who edits one takes ownership and labels it `loop-ready`
     (path 1);
   - the parent is not blocked (no hard label), and is OPEN, or CLOSED as COMPLETED with
     `loop-delivered`;
   - the parent's latest `loop-ready` label event is `labeled`, by the actor and at the time the
     marker copied (`parentLabeledBy`, `parentLabeledAt`), and that actor holds a trusted role
     now; the parent still carries `loop-ready` and is not itself a repair;
   - the parent was not edited after that event (`lastEditedAt` null or not later; at merge,
     strictly earlier, as the ordinary merge rule reads an edit at the label's instant). Review
     finding, operator decision 2026-09-30: an edited parent is no longer approved itself, so
     its repairs are revoked in selection, finalize and merge alike.

The evidence for path 2 is read live by the executor (issue record, parent record, parent
timeline, actor permission), never from the working tree or the scan.

A parent closed as COMPLETED after delivery keeps authorizing its open repairs (a carve-out's
remainder outlives its parent). To revoke them, close the parent as not planned (operator
decision 2026-09-30: documented, not changed).

## Boundaries

- Always: fail closed; incomplete parent evidence refuses with its own reason.
- Never: widen path 1; accept a repair of a repair (depth > 1); accept `loop-repair` together
  with `loop-ready` as path 2.

## Testing

- merge-authorization-contract fixtures: repair authorized; each clause of path 2 broken
  (marker missing, edited body, foreign author, parent blocked, parent closed not-planned,
  parent re-labelled, untrusted actor, `loop-ready` + `loop-repair`) refuses.
- auto-merge evidence derivation: a fake repair + parent hydrates path-2 evidence.
- `node tools/verify.mjs --plugin-root .` passes.

## Packaging

Branch `feat/repair-automerge` from `fix/lfe-run-findings`, released as 0.63.0 after 0.62.0.
