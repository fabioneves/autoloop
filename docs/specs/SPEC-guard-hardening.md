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
- **Latch failures refuse.** A latch that cannot be written, while plugin markers are open, is
  refused. Latches are keyed by the repository the markers live in.
- **Run-state and guard-code paths are protected** in every autoloop repository, whether or not a
  run is open. This closes "prime, then delete the marker it just wrote".
  - Protected paths:
    - the marker directories, for both the project and the cwd;
    - the latch directory;
    - the plugin's own `tools/` and `hooks/`.
- **Proven, not pattern-matched.** Matching dangerous word-forms one at a time lost to the shell's
  rewriting in review: brace expansion, ANSI-C quotes, symlinks, `git --work-tree … clean`, and
  unresolved substitutions. So a destructive command is proven instead.
  - "Destructive" covers `rm`, `mv`, `cp`, `ln`, `rsync`, `chmod`/`chown`, `find` with actions,
    `tar`/`unzip` extraction, `dd`, and writing `git`/`gh` subcommands.
  - Before any operand is judged:
    - braces are expanded (capped);
    - `~`, `$HOME`, `$$` and the command's own variables are substituted, with derivable values
      followed: assignments, `$(mktemp)`, and the items of a `for` list;
    - symlinks already on disk are resolved.
  - Each resulting path must be neither inside a protected directory nor an ancestor of one.
  - An operand the guard still cannot resolve is refused if any of these hold:
    - its origin mentions the git dir or `~/.claude`;
    - it names a run-state component (`autoloop`, `run`, `run-latches`);
    - its literal lead sits inside the state, or within two levels above it;
    - it is fed by a `find` over the state.
  - A destructive `xargs` is refused, since its operands come from the pipe.
  - Any other program may not name a path inside the run state. Running the plugin's own code
    (`node <plugin>/tools/x.mjs`) is fine.
  - Redirections are writes; `>&file` counts, `>&2` does not.
  - Command substitutions are judged as the commands they run, outside single quotes only.
    Nesting past the tokenizer's caps refuses.
  - The edit guard refuses Write/Edit targets inside the protected paths.
- **False positives.** Replayed over 22,764 recorded Bash commands from every local project: 0.
- **Residual risk (accepted).** The guard runs as the same uid as the session. A script file the
  run writes and then executes, or a value hidden behind an unsmelly opaque substitution, can
  still reach the records. Inline interpreter source is already refused. The enforcement boundary
  stays the repository's server-side rules.

### 2. guard-budget

- **Foreign-prime check.** `foreignPrimeProblem` memoises the common git dir: the project's is
  computed once, and each target directory once. More than 64 distinct target directories in one
  command is refused.
- **Shared deadline.** Every git call a hook makes goes through `git-budget.mjs` and shares a
  10 s deadline. Each call gets at most 4 s and is killed with SIGKILL when that runs out. A stalled
  call (a FIFO at `.git/config`) or a spent budget refuses; "no answer" is never read as "no run".
- **Command size.** Guarded commands over 64 KB are refused. The check grows faster than linearly
  in length (3.2 s at the cap), and the longest of 26,980 recorded commands was 32 KB.
- **Pre-existing regexes fixed.** Three regexes backtracked catastrophically:
  - the ANSI-C quote decoder, on a run of backslashes;
  - the git-mutation and interpreter-heredoc path prefixes, on a run of slashes.

  Each could hold the guard past the host's timeout. A fuzz over padded runs of every shell
  special character now stays under 1.5 s at 40 KB.

### 3. merge-config

- The executor's settings come from the base branch's committed config, read server-side:
  `gh api repos/<owner>/<name>/contents/.autoloop/config.json?ref=<base>`. The repository is the
  one it merges into.
- The working tree only names the base. If the committed config names a different base, the
  executor refuses.
- If the committed config cannot be read, nothing auto-merges.
- Every `gh` call the executor makes runs without an ambient `GH_REPO`/`GH_HOST`. A GitHub
  Enterprise repository's own host, as `gh repo view` reports it, is set explicitly.

## Commands

- Self-tests: `node tools/{command-guard,edit-guard,run-state-guard,git-budget,auto-merge}.mjs --self-test`
- Full: `node tools/verify.mjs --plugin-root .`

## Boundaries

- **Always:** fail closed on unreadable state. Include each fix's tests in the same commit.
- **Ask first:** schema changes. None are planned.
- **Never:** relax an existing rule; block reads of run state (`cat`/`jq` of markers stay allowed).

## Success criteria

- `rm -rf .git/autoloop/run` is refused mid-run. After a marker vanishes by other means, the guard
  still enforces.
- A forged marker with another base cannot relax the base rules.
- A padded prime command, a stalled git dir and an oversized command are refused within the
  deadline, never timed out.
- With a working-tree config flipped to `auto` over a committed `manual`, the executor refuses.
- `verify --plugin-root .` exits 0.
