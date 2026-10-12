# Spec: Session ownership

Module: `session-ownership` in [Session recovery fixes](SPEC-session-recovery.md).

## Objective

Autoloop must affect only the Claude Code session that runs it. A human session in an Autoloop repository, a session in any other repository, and a session after `/clear` or `prime.mjs --close-run` must behave as if the plugin had no hooks. Users are operators of the machine; the consumers are every plugin hook and skill.

The operator observed Autoloop behavior in sessions that did not run it. The cause, confirmed in source: every hook decides through `guardedRoot()` (`tools/hook-root.mjs`), which returns the repository root when `.autoloop/config.json` exists, whether or not a run is open or owned.

## Operator decisions (2026-10-12)

1. Ownership ends at `/clear` or `prime.mjs --close-run`, not only at process exit.
2. A session that does not own a run is not refused a branch switch while a loop reviewer reads that checkout. The loop's exact-head checks detect a changed checkout.
3. Autoloop skills run only when invoked by name or by the loop. Pitcrew stays invocable by Dev; its description names Autoloop-owned PRs only.

## Required behavior

1. **One ownership predicate.** A session owns a run when its owner latch exists, matches this Claude process (PID and start time, as today), records this conversation's session id, and is not closed. Hooks compare the latch session id with the `session_id` in the hook input. A missing or different session id is not ownership. The predicate reads no git state and starts no process when no latch exists.
2. **Starting a run.** Prime records the session id in the latch (from `CLAUDE_CODE_SESSION_ID`) before it opens a run. `--close-run` marks the latch closed. A new `prime.mjs` call in the same conversation re-opens ownership. Compaction keeps the session id and keeps ownership.
3. **Hooks outside an owned run do nothing.** Without ownership, every hook exits 0 with no output, no GitHub call, no git call, no file write, and no context injection. This covers SessionStart preflight and STATE injection, the command and edit guards, the PostToolUse riders, SubagentStop transcript capture, and the Stop write-back check.
4. **The one exception is starting Autoloop.** The command guard still checks a command that runs the plugin's own `prime.mjs`, because that command opens a run (for example, a prime compound that deletes run state, or a prime against a foreign repository). It does not apply other rules to that session until the run opens.
5. **Crash fallback.** When the guard process crashes, `hooks.json` fails closed only if this session owns a run, decided by the latch file alone. Without ownership it allows the command.
6. **Owned sessions keep current behavior.** Inside an owned run, the guards, riders, preflight, write-back enforcement, and transcript capture behave as today. Dispatched workers keep their own `--settings` deny rules; the change must not give them hooks.
7. **Remove unconditional UI text.** Drop the `statusMessage` entries that print Autoloop text in every session.
8. **Skills.** `dev`, `shape`, `setup`, `queue-trace`, `lean-code`, and `codebase-design` carry `disable-model-invocation: true`. Pitcrew keeps model invocation (Dev calls it) with a description limited to Autoloop-owned pull requests. Role briefs that read skill files by path keep working.
9. **Marker hardening.** A run marker records the owner PID with its start time. `ownRunMarkers` ignores a live ancestor whose start time differs (PID reuse). The guard writes a latch only for a start-time match.
10. **Documentation.** Update text that says the preflight or STATE is injected into every session. Record that vendored pre-plugin installs (`tools/agentic/*`) are outside this fix and need devendoring.

## Commands

```bash
node tools/run-markers.mjs --self-test
node tools/hook-root.mjs --self-test
node tools/command-guard.mjs --self-test
node tools/edit-guard.mjs --self-test
node tools/label-swap-reminder.mjs --self-test
node tools/subagent-transcript.mjs --self-test
node tools/writeback-check.mjs --self-test
node tools/prime.mjs --self-test
node tools/regression-index.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
git diff --check
```

Run every self-test and the full gate under a capped transient unit (see the release plan).

## Project structure

- `tools/run-markers.mjs`: ownership predicate, latch session id and closed state, marker start time.
- `tools/hook-root.mjs`: `guardedRoot` answers only for an owned run; `activeAutoloopRoot` stays for prime, setup, and doctor.
- `tools/prime.mjs`: latch session id, `--close-run` closes ownership.
- `tools/command-guard.mjs`, `tools/edit-guard.mjs`: early exit without ownership, prime exception.
- `tools/label-swap-reminder.mjs`, `tools/subagent-transcript.mjs`, `tools/writeback-check.mjs`, `tools/session-preflight.sh`: ownership gate.
- `hooks/hooks.json`, `tools/verify.mjs` (`PLUGIN_HOOKS`): crash fallback and status text.
- `skills/*/SKILL.md`: frontmatter and ownership wording; `README.md`.
- `tools/contract-lint.mjs` or `tools/verify.mjs`: skill frontmatter check; `tools/regression-index.mjs`, `CHANGELOG.md`.

## Code style

Keep one predicate and call it at the top of each hook, before any git or GitHub work:

```js
if (!ownedRun({ sessionId: input.session_id })) process.exit(0);
```

Do not add per-hook ownership logic or a configuration switch.

## Testing strategy

Write failing tests first with an isolated `HOME`, a counting `gh` shim, and real hook entry points. Cover, in a repository with `.autoloop/config.json` and no owned run: no preflight output and no `gh` call; command and edit guards allow run-state edits, large commands, unreadable payloads, and a branch switch during a review dispatch; no rider; no transcript copy; no Stop output, `gh` call, or reminder file; the crash fallback exits 0. Cover the prime exception. Cover an owned session (behavior unchanged), a `/clear` session id mismatch, a closed run, and PID reuse with a different start time. Bound every spawned process.

## Boundaries

- Always: decide ownership before any side effect; keep owned-run protection unchanged; keep the plugin's own-start check.
- Ask first: a new state store, configuration flag, or permission change.
- Never: make a non-owned session pay git or GitHub cost in a hook, give dispatched workers hooks, edit vendored repositories, or delete another session's run state.

## Success criteria

A non-owned session in any repository sees no Autoloop hook effect, except a refused unsafe command that itself starts Autoloop. An owned run behaves as before. `/clear` and `--close-run` end ownership. Loop-only skills do not trigger automatically. Focused tests and the capped full gate pass.

## Open questions

None. The operator answered the ownership, branch-guard, and skill questions on 2026-10-12.
