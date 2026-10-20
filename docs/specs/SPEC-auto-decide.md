# Spec: Auto-decide

Module of [Initiative](SPEC-initiative.md). Operator request, 2026-10-19 (v0.72.1): when the loop
has a question, it takes its recommendation and does not wait for an answer. The setting is
optional and on by default.

## Objective

A unit waits for a human only for a hard-safety matter. Each other question that blocked the unit
in v0.72.0 becomes a recorded decision, and a human can reverse it.

## Configuration

- `.autoloop/config.json` key `autoDecide`: an optional boolean with no default key. Absent or
  `true`: on. `false`: every matter blocks, as in v0.72.0.
- `reviewedConfig` removes the key, so review fingerprints do not change. The schema stays
  `0.28.0`. A config that sets the key needs 0.72.1 or later.
- `prime.mjs` shows `auto-decide on|off` on its `config` line and `config.autoDecide` in the summary.
- `unit.mjs` reads the key from the project config. If the config is absent or cannot be read,
  auto-decide is off: the human is the safe side.

## Matters

`unit.mjs --block` requires `--matter`. `irreversible` goes with `IRREVERSIBLE_ACTION`; each other
matter goes with `POLICY_DENIED`. A mismatch is `INVALID_ARGS`.

| Matter | Kind | With `autoDecide` on |
|---|---|---|
| `irreversible` | hard | block: a production write, provisioning, a message sent, data or history destruction |
| `secret` | hard | block |
| `dependency` | hard | block: an install or an install-script change |
| `merge-authorization` | hard | block: the merge of a `human:authorize` pull request |
| `permission` | hard | block: credentials, branch protection, `loop-ready`, a host or classifier denial |
| `trust-marker` | hard | block: an invalid trusted lifecycle marker. A decision that leaves the marker refused would leave the unit selectable, and each run would decide again; only a block takes the unit out of the queue |
| `open-findings` | auto | decide "rework once" (review hand-off, [Review rounds](SPEC-review-rounds.md) §5a) |
| `state-exception` | auto | decide: comply with STATE and continue |
| `protected-build` | auto | decide: build in the admitted plan; the pull request carries `human:authorize` |
| `product-value` | auto | decide: the narrowest value, with the alternatives recorded |

## Required behavior

1. While `autoDecide` is on, `--block` with an auto matter is refused with `BLOCK_AUTO_DECIDABLE`
   before any GitHub write. The refusal names the `--decide --instead-of <matter>` form and the
   recommendation.
2. One exception: `open-findings` when the issue holds the loop's own decision with `insteadOf:
   "open-findings"`. The one rework is spent, so the block goes through. This is the operator's
   chosen hand-off: a draft pull request, `loop-blocked` and `human:decide`, then the next unit. A
   trusted `/answer rework` resumes the unit.
3. `--decide --instead-of <matter>` records `insteadOf` in the marker and in the comment. A hard
   matter is refused with `DECIDE_HARD_MATTER`. An unknown matter is `INVALID_ARGS`. While
   `autoDecide` is off, `--instead-of` is refused with `AUTO_DECIDE_OFF`. `open-findings` needs the
   hand-off's `--review-fingerprint` and `--review-round` and a "rework" choice, and a second one is
   refused with `REWORK_SPENT`.
4. A human reverses a decision with `/answer` on the unit, as for every decision
   ([Initiative policy](SPEC-initiative-policy.md) §3). The rework follows §5a of Review rounds.
5. The digest lists these decisions under "Auto-decided instead of a block". The pull request's
   `## Decisions` names "instead of a block (<matter>)".
6. The label-swap reminder gives a refused `--block` no card and no notification rider. It names
   the remedy.
7. The AskUserQuestion guard for a live run does not change.

## Boundaries

- Never auto-decide a hard matter, merge, or weaken a gate, a test or a review predicate.
- The loop names the matter, so `DECIDE_HARD_MATTER` is an argument check, not a security control.
  The mechanical controls are elsewhere: the command guard refuses irreversible acts, the edit
  guard refuses secret paths, and auto-merge refuses dependency changes, `protectedPaths` and
  `human:authorize`.
- The flow release's rule "do not add configuration switches" does not apply to this module: the
  operator asked for this switch.

## Tests

- `config-contract.mjs --self-test`: the key is optional and boolean; it is absent unless set; it is
  on unless `false`; the review fingerprint does not include it.
- `unit.mjs --self-test`: a matter is required and agrees with its reason; a hard matter blocks
  while `autoDecide` is on; an auto matter is refused before any call; every matter blocks while it
  is off; the open-findings exception, which counts only the loop's own rework decision; a second
  rework and `--instead-of` while auto-decide is off are refused; `--instead-of` with a hard matter
  is refused; the digest section; the CLI reads the project config, and an absent or unreadable
  config turns auto-decide off (only `git` on `PATH`, so no GitHub call).
- `prime.mjs --self-test`: the summary names `autoDecide` outside the fingerprint, and the `config`
  line shows it.
- `label-swap-reminder.mjs --self-test`: a refused `--block` gets no card or notification rider.

## Limits

- A reversal is read at the next attempt of the unit. A reversal does not undo work that is
  already delivered.
