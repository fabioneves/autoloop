# Spec: Guard reduction

Module: `guard-reduction` in [Flow](SPEC-flow.md).

## Objective

The command guard refuses only an act that is irreversible, unauthorized, or hides one of those.
Every other rule is removed. A refused inspection command must become impossible by construction,
not rarer by tuning.

## Current state

`tools/command-guard.mjs` enforces 19 rule groups (header, lines 6-26; messages, lines
2206-2806). The opaque-shell group (inline interpreters, heredocs, command assembly, unresolved
expansions, unknown subcommands, grouped commit/push) produced the most false positives, including
128 refused reads in ten days on one project and a paused run over a search pattern that looked
like Python.

## Required behavior

1. **Kept rules.** The guard refuses, in an owned session:
   - `gh pr merge`, the REST merge endpoint, GraphQL merge mutations, and branch-protection
     mutations;
   - a commit on, or a push to, the configured base branch, except through a pull request;
   - `git push --force` and `-f` (`--force-with-lease` stays allowed);
   - a release-tag push or a GitHub release mutation;
   - `git add`, `git commit -a`, or `git commit <path>` naming a secret path (`.env*`, key
     material, credential files, as defined by `escalate-paths.mjs`);
   - a `Co-Authored-By` trailer;
   - `AskUserQuestion` while a run is live;
   - a branch switch of the checkout while a reviewer dispatch reads it;
   - a prime command that does anything else;
   - an unreadable hook payload while this process holds a latch (fail closed for the owner).
2. **Removed rules.** The guard no longer inspects: inline `--body`; `/answer` comments;
   `loop-ready`, `loop-halt`, `loop-repair`, and lifecycle label commands; raw `gh pr ready`;
   every step-label rule; the opaque-shell group; background `dispatch.mjs`; command length.
   A command that matches none of the kept rules is allowed without lexing.
3. **Plain parsing.** The kept rules are matched on the literal command with the existing
   `lexShell` tokens. A token the lexer cannot classify is allowed, not refused. The guard never
   refuses because it does not understand a command.
4. **Remedy text.** Each kept refusal names the rule and one allowed form. No refusal recommends a
   measurement or a size.
5. **Label discipline moves to tooling.** `step.mjs` remains the only tool that swaps step labels,
   and it keeps its own ladder checks. The guard does not duplicate them.
6. **Edit guard unchanged.** `tools/edit-guard.mjs` keeps refusing edits to settings, latches, run
   markers, and the plugin's tools and hooks.
7. **Skill text.** `skills/dev/SKILL.md` and `skills/pitcrew/SKILL.md` drop the prose for removed
   rules. The `NEVER` list in `README.md` matches the kept rules exactly.

## Commands

```bash
node tools/command-guard.mjs --self-test
node tools/edit-guard.mjs --self-test
node tools/regression-index.mjs --self-test
node tools/contract-lint.mjs --check-root .
node tools/verify.mjs --plugin-root .
```

## Project structure

- `tools/command-guard.mjs`: kept rules, removed rule code and tests, remedy text.
- `tools/regression-index.mjs`: incidents anchored to removed tests move to the kept rule that
  covers them or are retired with a note.
- `skills/dev/SKILL.md`, `skills/pitcrew/SKILL.md`, `README.md`, `CHANGELOG.md`.

## Testing strategy

Write failing tests first: each removed rule has a test that its former trigger is now allowed
(a literal `for` loop, `command -v`, a `grep` for `node`, `$?`, an `rg` pattern with Python
syntax, a 70 KB command, an inline `--body`). Each kept rule keeps its refusal test and gains a
test that the remedy names an allowed form. The guard self-test must show zero refusals on a
corpus of 50 ordinary read, test, and inspection commands.

## Boundaries

- Always: keep the kept rules exact; keep fail-closed for an unreadable payload in the owner.
- Ask first: adding any rule back.
- Never: a configuration switch to re-enable a removed rule; refusal on a parse failure.

## Success criteria

A loop session runs a day of ordinary work with zero guard refusals that the operator must undo.
A merge, base push, force push, release, or secret commit is still refused. The guard self-test
and the full gate pass.
