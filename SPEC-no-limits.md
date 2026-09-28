# Spec: no configured limits (v0.55.0)

## Objective

Operator decision, 2026-09-28: "remove all the limits, slice lines, etc. We don't need that
anymore." Setup still interviews every repository about four numeric caps and two byte budgets. On
LFE (v0.54.0 reconcile) it proposed `sliceMaxLines 5000 → 700` and was then refused by the guard,
because the session's parked run was still live.

Outcome:

- **M1. Schema 0.28.0 has no `caps` block.**
  - The 0.27.0 → 0.28.0 migration step deletes `caps` and names each removed key in its warnings.
  - `validateConfig` rejects `caps`.
- **M2. Review convergence is a fixed plugin bound: 20 rounds** (operator: "bump code reviews limit
  to 20").
  - `review-contract.mjs` exports `REVIEW_ROUND_CAP = 20` and reads it instead of
    `projectConfig.caps.codeReviewRoundsPerUnit`.
  - The closing round past the cap, `REVIEW_CAP_HANDOFF`, and `REVIEW_CAP_REACHED` keep their
    behaviour. The re-plan decide no longer names "raise the cap" as the alternative.
- **M3. Gate retries: no replacement.** `gateRetriesPerUnit` was never read by any tool or skill
  instruction (checked with `rg`), so it disappears with the block (operator: "if there's no
  enforcement, just leave it").
- **M4. Slice budgets are gone.**
  - Removed from the dev skill (the NOTE-and-ship rule), the shape skill, the setup interview and
    the STATE template. The dev skill keeps its git-measurement block as generic guidance: the
    simplify step's plan-relative measured budget and the guard's `--shortstat` hints use it.
  - Shape keeps its case-count sizing and ~300-line tripwire. Those are shaping guidance, not
    configured caps.
  - The regression incident `slice-budget-blocked-a-finished-unit` retires with its enforcers.
- **M5. Curated-document byte budgets are gone.**
  - Removed: `CURATED_DOCUMENTS` and its warnings in `scaffold.mjs`, and the 8000/6000-byte NOTEs
    in the dev and setup skills.
  - The regression incident `lessons-budget-orphaned-by-its-own-migration` retires with its
    enforcer.
- **M6. Setup takes the session back from a live run.**
  - When `/autoloop:setup` runs in a session whose loop run is live, setup closes that run first
    (`prime.mjs --close-run`). Invoking setup is the operator taking the session back.
  - The unit in flight is left as it is. The next run's prime reconciles it from its lifecycle
    marker.
  - Setup then interviews as usual. The guard's AskUserQuestion refusal only applies while a run is
    live, and it already names this remedy.

## Not changed

- The simplify brief's "measured budget" (the plan's own predicted line count against the diff)
  is plan-relative guidance, not a configured limit.
- The `--card-run` 1.5 KB cap, the dispatch timeouts and the guard's parse limits are internal
  safety bounds, not repository policy.

## Commands

- `node templates/tools/verify.mjs --plugin-root .` must exit 0.
- `node templates/tools/verify.mjs --emit-self-test-manifest > templates/tools/self-test-manifest.json`
  after each change to `templates/tools`.

## Testing

Self-tests in each touched tool. Every new behaviour gets a failing check first:

- migration removes `caps`;
- 0.28.0 rejects `caps`;
- 0.27.0 is migratable;
- the review contract uses 20;
- scaffold emits no budget warning;
- contract-lint no longer requires a scaffolded caps block.

## Boundaries

- Always: a migration hop, never a hand edit of a host's STATE; one test-driven commit per task.
- Never: remove the review round bound; touch LFE's STATE by hand.

## Success criteria

- `rg 'sliceMax|gateRetriesPerUnit|codeReviewRoundsPerUnit|CURATED_DOCUMENTS'` matches only
  migration code, its tests, CHANGELOG and specs.
- A 0.27.0 STATE migrates to 0.28.0 with the caps named in warnings. Setup asks no numeric-cap
  question.
- Setup in a session with a live run closes the run and proceeds.
- The full battery is green.
