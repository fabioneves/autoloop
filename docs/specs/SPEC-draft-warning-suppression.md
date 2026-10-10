# Spec: Draft warning suppression

Module: `draft-warning-suppression` in [Session recovery fixes](SPEC-session-recovery.md).

## Objective

Stop repeated, unchanged draft-PR reminders from interrupting unrelated replies. Keep the first useful reminder and all hard safety checks visible.

Users are loop operators and people who ask read-only questions in a loop repository.

## Tech stack

Use the existing Node.js ESM Stop hook and repository-local Git metadata. Add no dependency, setting, background process, or global reminder store.

## Required behavior

1. Keep expected mid-unit drafts silent under the existing step rules. A draft at the publication step can produce an actionable reminder. Missing step evidence must not be presented as proof that publication was forgotten.
2. Show a draft reminder at most once for an unchanged relevant PR state in one session. A later unrelated Stop must not repeat it.
3. Show it again after a relevant state change, including a new head, a changed publication step, or a ready-to-draft transition. Do not reset suppression merely because an unrelated comment changed `updatedAt`.
4. Keep sessions and repositories separate. Use the hook's session identity, with the existing session environment identity as a fallback. Hash identity before using it in a file path. With no reliable session identity, emit normally rather than sharing suppression across sessions.
5. Store only the bounded current draft-reminder state for that session under Git's existing Autoloop metadata directory. Read and write it without changing tracked files, issue labels, run ownership, or marker authority. Reuse existing path/identity helpers where appropriate, but do not repurpose security latches as reminder state.
6. A missing, malformed, or unwritable reminder file must not block the hook. Emit the reminder normally when suppression cannot be established safely. Use an atomic write pattern so interrupted writes cannot create false suppression.
7. Suppress only draft reminders. Keep invalid ownership, unpushed work, stalled steps, unanswered writeback gaps, query failures, human answers, and dark-run checks unchanged. A hard Stop must still display its hard errors even if a draft reminder was already seen.
8. Preserve the existing `stop_hook_active` recursion rule. It is separate from unchanged-state suppression.

## Commands

```bash
node tools/writeback-check.mjs --self-test
node tools/regression-index.mjs --self-test
node tools/contract-lint.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
git diff --check
```

The existing Stop-hook entry point remains unchanged. No application build is required.

## Project structure

- `tools/writeback-check.mjs`: draft classification, pure suppression decision, local persistence adapter, hook integration, and tests.
- `tools/run-markers.mjs` or `tools/hook-root.mjs`: reuse existing exported identity/path helpers only as needed.
- `tools/regression-index.mjs`, `CHANGELOG.md`: coverage registration and operator-facing change.
- `tasks/plan-session-recovery.md`, `tasks/todo-session-recovery.md`: approved implementation plan and task progress.

## Code style

Keep classification and emission separate. Use a small pure state comparison with an injected storage boundary. Retain the existing output shape:

```js
return {
  exitCode: 0,
  stdout: JSON.stringify({ systemMessage: reminders.join('\n') }),
  stderr: '',
};
```

Do not create a general notification framework or add unrelated hook cleanup.

## Testing strategy

First reproduce duplicate draft reminders across two Stops. Cover:

- Same session and unchanged state: first reminder only.
- New session or different repository: independent first reminder.
- Relevant head/step/draft changes: a new reminder; unrelated updates: no repeat.
- Expected mid-unit draft and absent step evidence.
- Multiple PRs with independent state.
- Missing identity, corrupt cache, write failure, and interrupted atomic publication.
- Hard errors and other reminder classes remain visible on repeated Stops.
- Hook recursion and repositories outside Autoloop remain unchanged.

Use pure fixtures plus an integration test through the real hook with fake GitHub output and temporary Git metadata. Do not query or modify live PRs.

## Boundaries

- Always: keep hard checks active, isolate sessions, fail open on reminder storage errors, and preserve accurate output.
- Ask first: a global store, configuration setting, dependency, or broader suppression policy.
- Never: suppress all reminders, change issue state from the hook, remove run latches, or mistake missing evidence for a completed check.

## Success criteria

An unchanged draft produces one reminder per session. Relevant changes produce a new reminder. Cache failures do not block the session. Hard errors and other diagnostics still appear. Focused tests and the full repository gate pass; changes are simplified and independently reviewed.

## Open questions

None. The specification is approved.
