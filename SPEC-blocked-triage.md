# Spec: blocked-triage (module of SPEC-initiative.md)

## Objective

An answered block resumes by itself. Today, after a human answers a `human:decide` question, they must also remove `loop-blocked` (`skills/dev/SKILL.md:959-966`), and the unit waits until they notice that second step.

In the manual sessions an answer resumed the work immediately. Blocked issues are re-examined first at every run start ("fix blocked issues first").

## Behaviour

1. **Block marker.** Every block the loop applies posts one comment carrying `<!-- autoloop-block-v1 {"issue":N,"class":"human","reason":"<code>","question":"<one line>","at":…} -->`. The rendered text ends with the reply form: *reply `/answer <your decision>` to resume*. One helper, `blockMarker(input)` in `unit.mjs`, is used by every block path, including the `review-contract.mjs` `REVIEW_CAP_REACHED` handling in the dev skill.

2. **Explicit answer.** In a solo repository the runner and the human share a login, so an ordinary comment cannot prove a human wrote it. An answer is a comment by a trusted actor (admin/maintain/write, the same evidence as `authorVerification`) whose body starts with `/answer`, posted after the newest block marker. A loop-authored comment never starts with `/answer`; the command guard refuses `gh issue comment` bodies that do.

3. **Triage at prime.** Prime runs this before its scan, next to `liftWaits`. For each open `loop-blocked` issue:
   - **No `autoloop-block-v1` marker** (a human block, or one from a pre-marker run): held, reported as `held: #N (no loop marker)`.
   - **Marker, no later `/answer`**: held, reported as `blocked: #N — <question>`.
   - **Marker plus a later `/answer`**: the loop removes `loop-blocked` and the gate label, then posts an `autoloop-resumed-v1` comment recording who answered and what. It deliberately does not post a decision marker, because the answer is the human's decision and not the loop's, and a decision marker would list it in the digest as the loop's own. It prints `resumed: #N`. The `/answer` text becomes premise context and overrides anything it conflicts with.
   - The marker must also match the current block. Three conditions, otherwise the block is held:
     - the runner posted it (`viewerDidAuthor`);
     - it names this issue;
     - its comment's `createdAt` is within 5 minutes before the latest `loop-blocked` label event (read from the issue's events).

     The marker's own `at` is informational: the window and the `/answer` cutoff both use GitHub's `createdAt`, so a skewed runner clock cannot hold a block forever, and a forged `at` buys nothing.

4. **Priority.** Resumed issues are selected before other queue work in the same run.

5. **Unchanged.** A human removing `loop-blocked` is still an unblock decision. The loop still never re-blocks an issue a human unblocked, and never removes `loop-ready`.

## Boundaries

- Never:
  - lift a block without a loop marker;
  - lift without an `/answer` from a trusted actor posted after the marker;
  - treat any other comment as an answer.
- A triage error leaves the issue blocked and never fails prime. This is the same failure direction as `liftWaits`.

## Tests (failing first)

- `unit.mjs --self-test`, using a fake runner:
  - an unmarked block is held;
  - a marked block without an answer is held;
  - a marked block answered by a trusted actor is resumed, with a decision comment;
  - `/answer` from an untrusted actor, or posted before the marker, is ignored;
  - a plain comment is ignored.
- `command-guard` self-test: a loop `gh issue comment` whose body starts with `/answer` is refused.
- `prime`: prints one line per held, waiting or resumed unit.

## Success criteria

- A #258-style case replayed with fixtures: the block posts its question, the operator replies `/answer 128 chars, "Unnamed device"`, and the next prime resumes #258 first with the answer as context. No label is touched by hand.
- `node templates/tools/verify.mjs --plugin-root .` passes.
