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

- **Session latch, owned by the session's Claude process.** The run's second record lives outside
  the repository at `~/.claude/autoloop/run-latches/<pid>.json`.
  - `<pid>` is the session's Claude process, found through process ancestry the same way markers
    are matched. It is never found through git or through anything the run can edit.
  - The latch records the run's base, pinned once, and the owner's start time (against pid reuse).
  - **prime writes it** when it opens a run, and refuses to open the run if it cannot. So no
    command between opening the run and the guard's first look can hide the run.
  - The command guard writes it too, the first time it sees open markers, and refuses if the write
    fails.
  - It is written atomically: a temp file, then a hard link into place.
  - It holds while its owner lives. A present but unreadable latch fails closed: every command is
    refused.
  - A run whose repository git can no longer read (a broken HEAD or config) is refused until the
    repository is repaired. Breaking git hides the markers, but not the latch.
- **Every base is enforced.** The guard evaluates the command against the latch's base and every
  open marker's base, and refuses if any of them refuses. A forged marker can only add
  restrictions.
- **A command that opens a run does only that.** Besides prime it may only read. Prime is run on
  its own everywhere in the skills, and this closes every "prime, then undo the records" compound.
- **Protected paths.** These are protected in every autoloop repository, run or not:
  - the marker directories, for both the project and the cwd;
  - the latch directory;
  - the session's shell snapshots in `~/.claude/shell-snapshots`, which every Bash call sources;
  - the plugin's own `tools/` and `hooks/`.

  While a run is open, these are protected as well:
  - the project's `.claude/settings*.json`;
  - the user's `~/.claude/settings*.json` and the plugin registry.
- **Destructive operands are proven.** Matching dangerous word-forms one at a time lost to the
  shell's rewriting in three review rounds, so a destructive command's operands are proven
  instead.
  - The destructive commands are:
    - `rm`, `mv`, `cp`, `ln`, `rsync`, `install`;
    - `chmod`/`chown`;
    - `find` with actions, `fd -x/-X`, `rg --pre`;
    - `tar`/`unzip` extraction, `tar --remove-files`, `zip -m`;
    - `dd`, `tee`, `truncate`, `rimraf`/`trash`/`del` (including via `npx`/`bunx`);
    - destructive `xargs`/`parallel`, and writing `git`/`gh` subcommands.
  - Before an operand is judged:
    - braces are expanded (capped);
    - tildes are expanded (`~`, `~+`, `~-`, the user's own `~name`);
    - variables are substituted: the command's own assignments, `for` lists, `$(mktemp)`, `$$`,
      and otherwise the session's environment, as the shell would;
    - `$PWD`/`$OLDPWD` follow the tracked directory, through `cd`, `cd -`, `pushd`/`popd` and
      subshells;
    - symlinks already on disk are resolved.
  - Each resulting path must be neither inside a protected directory nor an ancestor of one. A
    copy must not land the protected name, and a hard link or symlink must not point at the
    protected state.
  - **Unknown means refused.** A value from a substitution, `read`, `printf -v`, a nameref or a
    positional parameter, or a relative path after an untracked `cd`, cannot be proven, so a
    destructive command that uses one is refused.
  - `git` is also refused when aimed at the state through `-C`, `--work-tree`, `--git-dir`,
    `GIT_WORK_TREE`/`GIT_DIR`/`GIT_COMMON_DIR` (inline or exported) or `config core.worktree`.
  - Any other program may not name a path inside the run state, and may not name the plugin's
    code, unless it is running a plugin tool.
- **The tokenizer.**
  - It decodes ANSI-C quotes.
  - It splits redirections glued to words (`echo x>file`); `>&file` is a write, `>&2` is not.
  - It keeps the text after `<<EOF` on its line. This was a pre-existing bypass of every rule:
    `cat <<EOF && gh pr merge`.
  - It judges substitutions outside single quotes, and those in unquoted heredoc bodies.
  - It judges `eval` and `sh -c` scripts as the commands they run.
  - Nesting past its caps refuses.
- **False positives.** Replayed over 22,841 recorded Bash commands from every local project: 4
  refused. Each is a destructive command whose operand is a value the guard cannot see:
  `$(git worktree list …)`, `$(fd …)`, `$(date …)`, and an unknown loop-derived name. None is from
  a loop run.
- **Residual risk (accepted).** The guard runs as the same uid as the session. A script file the
  run writes and then executes can still reach any of it. Inline interpreter source is already
  refused. The enforcement boundary stays the repository's server-side rules, and an OS-level
  sandbox is the structural fix (see the open question).

### 2. guard-budget

- **Foreign-prime check.** `foreignPrimeProblem` memoises the common git dir: the project's is
  computed once, and each target directory once. More than 64 distinct target directories in one
  command is refused.
- **Shared deadline.** Every git call the command guard and the edit guard make goes through
  `git-budget.mjs` and shares a 10 s deadline. A caller that sets no deadline still gets at most
  10 s per call. Each call gets at most 4 s and is killed with SIGKILL when that runs out. A stalled
  call (a FIFO at `.git/config`) or a spent budget refuses; "no answer" is never read as "no run".
- **Command size.** Guarded commands over 64 KB are refused. The check grows faster than linearly
  in length (3.2 s at the cap), and the longest of 26,980 recorded commands was 32 KB.
- **Linear tokenizer.** Subshell parentheses are cut by position, and the fd lead of a
  redirection is found by walking back. Both were quadratic on padded input.
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

## Open question

A text-level guard cannot be complete against a same-uid process that can write and run a script.
The next structural step is OS-level write denial for these protected paths, for example Claude
Code's sandbox for Bash, if it can be configured to do that. That is to be evaluated separately.

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
