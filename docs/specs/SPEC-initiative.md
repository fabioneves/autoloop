# Capability Map: Initiative

## Why

On 2026-09-23 to 09-25 the operator worked the LF and LFE queues by hand, without Autoloop, using one prompt: "work the issue queue, fix blocked issues first". Each session merged about 15–20 PRs in two days.

The difference from the loop was not the stops. Both sessions paused for classifier denials, questions and human merges, just as the loop does. The difference was what a problem *became*:

| Situation (session evidence) | Manual session | Loop today (v0.51.0) |
|---|---|---|
| #342 blocked by seven inaccurate comment claims | fixed the claims, re-gated, unblocked | `loop-blocked` stays until a human lifts it (`skills/dev/SKILL.md:909`) |
| #340 has a real defect in a delivered PR | reproduced it, fixed it with a regression test | unit is outside the eligible set |
| #336's approved membership rule would reject a correct value | "I recommend deriving its bits from the locked construction", then did it | premise "ambiguous … transition to the appropriate human block" (`SKILL.md`, step 1) |
| LF: `main` fails `npm audit`, which blocks #248 | opened a separate dependency-fix PR first, then continued #248 | the fix is outside #248's scope; follow-ups are filed without `loop-ready`, so the loop can never pick them up |
| #258 label length has no stated value | asked the question and kept working on independent slices | `human:decide`, next unit, which is correct: this is a real decision |

Most blocks carried a recommendation the session could state in one sentence. Where it could, the session acted on it.

## Target rule

**The loop fixes what it can and takes the recommended option on judgment calls. It blocks a unit only for a genuine human decision:**
- trust and irreversible actions;
- product values that no source states.

Every decision the loop takes is recorded where a human will see it, and it is reversible.

## Decisions (operator, 2026-09-25)

- **Genuine human decisions** are two classes only:
  1. **Trust and irreversible actions:** merge, secrets and credentials, destructive or irreversible operations on data or history, protected paths (`human:authorize`), repository and branch protection.
  2. **Unspecified product values:** a product or contract value that no source states, where no option is clearly better.
- **Scope beyond the issue** and **a Critical still open at the review cap** are the loop's call, not a human's.
- **Repair issues** that the loop files become eligible through a `loop-ready` parent, linked by a machine marker. The loop still never applies `loop-ready`.
- **Launch-time authorization**, replacing the per-issue `loop-ready`, is out of scope. It gets a separate spec.
- **Presence-aware mid-run questions** are dropped. With "take the recommended option" as the default, questions become rare, and the digest carries them.

## Modules

| Module id | Responsibility | Depends on |
|---|---|---|
| `initiative-policy` | The closed list of genuine human decisions. Every other would-be block becomes one of:<ul><li>**fix**: do it in this unit or in a repair unit;</li><li>**decide**: take the recommended option, record a `loop-decision` marker comment and a digest row, then continue.</li></ul>Rewrites the premise, handoff and review-cap rules. | — |
| `loop-authored-work` | Repair issues the loop files, linked to a trusted `loop-ready` parent, are eligible without a human label. Bounded in depth and count. | `initiative-policy` |
| `blocked-triage` | Every loop-applied block carries an `autoloop-block-v1` marker holding its question. At prime, a marked block that a trusted actor has answered with `/answer …` resumes on its own: the label is lifted, the answer becomes premise context, and the unit is selected first. A block without a marker, or without an answer, is held. | `initiative-policy` |

Build order: `initiative-policy` → `loop-authored-work`, `blocked-triage` (either order).

Module specs: `SPEC-initiative-policy.md`, `SPEC-loop-authored-work.md`, `SPEC-blocked-triage.md`.

## Invariants kept

- Merge, merge-queue, tag and release stay human (`SKILL.md` hard rules).
- The loop never applies, creates or renames `loop-ready`. The command guard is unchanged.
- The reviewer's model is never the writer's.
- Delivery still requires CI to be green on the exact head.
