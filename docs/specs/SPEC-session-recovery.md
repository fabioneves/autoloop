# Capability map: Session recovery fixes

## Objective

Repair three Autoloop defects: a delivered PR cannot enter revision after its head changes, a tool recovery fault can become a human decision, and an unchanged draft reminder repeats after unrelated replies.

## Modules

| Module ID | Responsibility | Depends on | Spec |
|---|---|---|---|
| `revision-recovery` | Recover a changed delivered head without transferring old approval. | — | [Revision recovery](SPEC-revision-recovery.md) |
| `block-classification` | Restrict new human blocks to the closed human class. | `revision-recovery` | [Block classification](SPEC-block-classification.md) |
| `draft-warning-suppression` | Suppress unchanged draft reminders within one session. | — | [Draft warning suppression](SPEC-draft-warning-suppression.md) |

Build order: `revision-recovery` → `block-classification` → `draft-warning-suppression`.

## Shared boundaries

- Preserve exact-head review, gate, and delivery requirements, trusted marker chains, and real human gates.
- Keep the existing root `SPEC.md` unchanged. It describes separate work.
- Use synthetic test data. Do not commit session records, host paths, or private project details.
- Make no live repository intervention, remote publication, release, installation, permission change, dependency addition, or file deletion without separate approval.
- Use test-driven tasks, simplify before independent review, and run the full repository gate.

The module map, build order, module specs, and implementation plan are approved. Use
`tasks/plan-session-recovery.md` and `tasks/todo-session-recovery.md`; leave the existing task files unchanged.
