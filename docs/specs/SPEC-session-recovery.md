# Capability map: Session recovery fixes

## Objective

Repair Autoloop recovery and status reporting. A changed delivered head must have a safe revision path. Tool faults must not become human decisions. Draft warnings must respect blocked work. Dispatch returns and parked displays must describe the correct work.

## Modules

| Module ID | Responsibility | Depends on | Spec |
|---|---|---|---|
| `revision-recovery` | Recover a changed delivered head without transferring old approval. | — | [Revision recovery](SPEC-revision-recovery.md) |
| `block-classification` | Restrict new human blocks to the closed human class. | `revision-recovery` | [Block classification](SPEC-block-classification.md) |
| `draft-warning-suppression` | Suppress unchanged draft reminders within one session and identify blocked work. | — | [Draft warning suppression](SPEC-draft-warning-suppression.md) |
| `dispatch-return-association` | Bind each return to its dispatch attempt and step instance. | — | [Dispatch return association](SPEC-dispatch-return-association.md) |
| `parked-disposition` | Show known waiting, blocked, repair, and merge-pending states without hiding open work. | `dispatch-return-association` | [Parked disposition](SPEC-parked-disposition.md) |
| `work-size-removal` | Remove artificial work-size quotas and informational character, file, and changed-line reporting. | — | [Work-size removal](SPEC-work-size-removal.md) |

Build order: `revision-recovery` → `block-classification` → `draft-warning-suppression` → `dispatch-return-association` → `parked-disposition` → `work-size-removal`.

## Shared boundaries

- Preserve exact-head review, gate, and delivery requirements, trusted marker chains, and real human gates.
- Keep the existing root `SPEC.md` unchanged. It describes separate work.
- Use synthetic test data. Do not commit session records, host paths, or private project details.
- Make no live repository intervention, remote publication, release, installation, permission change, dependency addition, or file deletion without separate approval.
- Use test-driven tasks, simplify before independent review, and run the full repository gate.

The recovery/status capability map, module specifications, and implementation plan are approved.
The operator subsequently requested `work-size-removal`; review that specification and its plan
extension before its implementation. Use `tasks/plan-session-recovery-release.md` and
`tasks/todo-session-recovery-release.md`. Preserve the original recovery plan and unrelated
task files.
