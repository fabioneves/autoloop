# Spec: initiative-policy (module of SPEC-initiative.md)

## Objective

Replace "when unsure, block the unit" with a closed decision rule. A would-be block falls into exactly one class:

| Class | When | Loop action |
|---|---|---|
| `human` | Trust/irreversible (merge, secrets/credentials, destructive data or history ops, protected paths, repo/branch protection) **or** an unspecified product/contract value with no clearly better option | block the unit as today (`loop-blocked` + `human:decide` / `human:authorize`), with an `autoloop-block-v1` marker (see `SPEC-blocked-triage.md`) |
| `fix` | The obstacle is code, tests, docs, CI config, dependencies, or a stale/inaccurate issue premise the repository can correct | fix it inside the unit when it is within the unit's lane; otherwise file a repair unit (`SPEC-loop-authored-work.md`) and either wait on it (`unit.mjs --wait --on-issue`) or continue if independent |
| `decide` | A judgment call with a recommendable option: ambiguous wording, scope correction, a choice between designs, a Critical still open at the review cap (re-plan or split), work bigger than the issue | take the recommended option, post an `autoloop-decision-v1` comment, continue |

`human` is the **only** class that blocks, and it is closed: a situation not named in it is `fix` or `decide`. "Do not silently redesign scope" becomes "never redesign scope *silently*": a scope change is a `decide` with a recorded decision.

## Behaviour

1. **`autoloop-decision-v1` marker** (new, `templates/tools/unit.mjs --decide`), one bare call:
   `unit.mjs --decide --issue N --choice "<one line>" --alternatives "<a; b>" --why "<one line>"`.
   Posts a comment carrying `<!-- autoloop-decision-v1 {"issue":N,"choice":…,"alternatives":[…],"why":…,"at":…} -->` and labels
   the issue `loop-decided` (created on first use), plus a readable
   rendering. It never edits the issue body (an edit after `loop-ready` makes the issue ineligible, `snapshot-contract.mjs:1107-1108`).
   Exports the pure core `decisionMarker(input)` / `parseDecision(body)`.
2. **Digest:** the digest adds a "Decided by the loop" section: every `loop-decided` issue whose newest decision is at most seven
   days old, marked `decided, reversible`, below the existing blocked/authorize rows (which stay "waiting on a human"). `unit.mjs`
   has no run identity, so a time window stands in for "this run"; a failed decision read never stops the questions posting. The operator reviews decisions at the digest, not mid-run.
3. **Reversal:** a human reverses a decision by replying `/answer <what instead>` on the issue (the same explicit form as
   `SPEC-blocked-triage.md` — in a solo repository a plain comment cannot be told apart from the loop's own). The loop reads prior
   `autoloop-decision-v1` comments and later `/answer` comments as premise context for any re-attempt; an `/answer` postdating a
   decision overrides it. The loop never re-takes a decision a human reversed.
4. **Classification is recorded, not inferred later:** a block's marker names its class (`human`); a decision's marker is the `decide` class by its kind (`autoloop-decision-v1`), so it carries no separate field.
5. **Dev skill rewrite** (`skills/dev/SKILL.md`):
   - Step 1 premise: "duplicate, ambiguous, outside autonomy … human block" → classify; `human` blocks, `fix`/`decide` proceed.
   - `REVIEW_CAP_REACHED` (`:1406-1420`): Critical open → `decide`. As built, the choice is made in two places:
     - the carve happens at the closing round, because past it no round remains to review a reduction;
     - at the cap itself the decide is a re-plan, filed as a blocking repair. A re-plan cannot resume the unit, because the marker binds `planHash`, so the unit is closed `--obsolete` against the repair's PR once that merges.

     The review contract names this state `cap-reached`, not `human-block`.
     and deliver the rest; a human block only when the Critical is itself a `human`-class matter.
   - Handoff (`:1893-1901`): "anything phrased 'tell me when…'" → `fix`/`decide` unless `human`-class.
   - Autonomy section (`:2203-2231`): replace "most conservative action … label the unit" with the three-class rule.
   - Malformed/duplicate lifecycle marker (`:120-127`): stays a block (loop-machinery defect; trust-adjacent) — unchanged.
6. **Plan step:** the plan names each `decide` it takes and its recommendation, so the plan reviewer judges it before code exists.

## Boundaries

- Always: record every `decide` before acting on it; cite evidence (`file:line`, command output) in the `why`.
- Never: take a `decide` that touches a `human`-class matter; edit an issue body; apply `loop-ready`; merge; weaken a gate, test,
  or review predicate to reach green (that is not a fix).
- Keep: reviewer ≠ writer; exact-head CI; v0.50 dispositions (`--obsolete`, `--wait`, `defer`).

## Tests (failing first)

- `unit.mjs --self-test`: decision marker round-trip; `--decide` refuses without `--choice`/`--why`; refuses a closed issue;
  digest rows include decisions with `decided — reversible`.
- `contract-lint`: the dev skill's autonomy section names exactly the two `human` classes; no remaining "most conservative action …
  label" or "ambiguous … human block" phrasing (a lint pin, like the existing stale-instruction lint).
- `regression-index`: pins #336/#340/#342 evidence to the rewritten sections.

## Success criteria

- Replaying the three session cases (#342 comment claims, #336 provenance rule, #340 real defect) through the rewritten rules yields
  `fix`/`decide`, not `human:decide`; #258's label length still yields `human`.
- `node templates/tools/verify.mjs --plugin-root .` passes.
