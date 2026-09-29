# Spec: guard hardening (post-0.60.0 security audit)

## Objective

The 0.60.0 security audit found three weaknesses that predate that release. The operator approved
fixing all three (2026-09-29).

1. **run-state** — A run can switch its own command guard off by deleting its run marker under
   `<git-common-dir>/autoloop/run/`. A forged marker can also replace the base branch the guard
   enforces against.
2. **guard-budget** — A padded command can keep the guard running past its 15 s hook timeout. The
   host treats a timed-out hook as a non-blocking error, so the command then runs unguarded.
3. **merge-config** — The merge executor reads its policy from the working tree's
   `.autoloop/config.json`, which the run can edit. A `manual` repository could be flipped to
   `auto` locally and then merged.

## Design

### 1. run-state

- **Session latch.**
  - When the command guard sees an open plugin run for its session, it records a latch outside
    the repository: `~/.claude/autoloop/run-latches/<sha256(session_id, common dir)>.json`. The
    latch holds the base, the marker's process ids and the common dir.
  - While any latched process is alive and in the hook's ancestry, the run counts as open, even
    after every marker is gone. A present but unreadable latch fails closed: every command is
    refused.
  - A latch is written once and never updated, so the first base observed is pinned.
  - Latches whose processes are all dead are pruned.
- **Every base is enforced.** The guard evaluates the command against each base it knows: the
  latch's and every open marker's. It refuses if any of them refuses, so a forged marker can only
  add restrictions.
- **Run-state paths are refused** during a run:
  - The protected paths are the marker directory, for both the project and the cwd, and the latch
    directory.
  - Refused: a Bash command that writes, moves or deletes a protected path, or a path inside one.
    Redirections count as writes.
  - Refused: a recursive delete, recursive `chmod`/`chown`/`chgrp`, `mv`, or `find
    -delete/-exec` whose operand is an ancestor of a protected path (`rm -rf .git`, `find .
    -delete`).
  - Globs are matched segment by segment. Literal `cd`/`pushd` steps (with subshell scope) and
    literal assignments are followed. Command substitutions are judged as the commands they run.
  - An `xargs` consumer, or an unresolved operand (`rm "$f"` in a loop), makes the paths the
    other segments name into candidates.
  - The edit guard refuses Write/Edit targets inside the protected paths.
  - Replayed over 22,635 recorded Bash commands from every local project: one false positive, a
    `for` loop over `$f` in the same command as an unrelated `find .`.
- **Residual risk (accepted).** The guard runs as the same uid as the session. A script file the
  run writes and then executes can still reach both records; inline interpreter source is already
  refused. The enforcement boundary stays the repository's server-side rules.

### 2. guard-budget

- `foreignPrimeProblem` memoises the common git dir: the project's is computed once, and each
  target directory once.
- More than 64 distinct target directories in one command is refused.
- The guard has an internal deadline of 10 s, checked inside that loop. If it runs out, the guard
  refuses the command with the remedy "split the command". A guard that cannot finish fails
  closed before the host's timeout does.

### 3. merge-config

- The executor's settings come from the base branch's committed config, read server-side:
  `gh api repos/<owner>/<name>/contents/.autoloop/config.json?ref=<base>`. The repository is the
  one it merges into.
- The working tree only names the base. If the committed config names a different base, the
  executor refuses.
- If the committed config cannot be read, nothing auto-merges.
- Every `gh` call the executor makes runs without `GH_REPO`/`GH_HOST`.

## Commands

- Self-tests: `node tools/{command-guard,edit-guard,run-markers,auto-merge}.mjs --self-test`
- Full: `node tools/verify.mjs --plugin-root .`

## Boundaries

- **Always:** fail closed on unreadable state. Include each fix's tests in the same commit.
- **Ask first:** schema changes. None are planned.
- **Never:** relax an existing rule; block reads of run state (`cat`/`jq` of markers stay allowed).

## Success criteria

- `rm -rf .git/autoloop/run` is refused mid-run. After a marker vanishes by other means, the guard
  still enforces.
- A forged marker with another base cannot relax the base rules.
- A padded prime command is refused within the deadline, never timed out.
- With a working-tree config flipped to `auto` over a committed `manual`, the executor refuses.
- `verify --plugin-root .` exits 0.
