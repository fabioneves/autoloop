# The autoloop — runbook

A standing, self-prompting development loop for **{{PROJECT_NAME}}**, run in one Claude Code,
Codex CLI, or opencode session. It takes each eligible **`loop-ready` GitHub issue**: **the orchestrator** (the session) plans it, **the reviewer**
reviews the plan, **the implementer** builds it, **the orchestrator** reviews + fixes the diff and runs the objective
gate, a **fresh reviewer thread** reviews the code, then it opens a PR that `Closes #N` and moves
to the next eligible issue; a human merges. Writer and reviewer are never the same thread. You don't prompt
the steps.

**Source of truth is git/GitHub:** queue = open `loop-ready` issues · in-progress = open PRs whose
body `Closes #N` · done = merged PRs · blocked = `loop-blocked` issues. `STATE.md` is standing
config (mission, config block, caps, lessons), **not** the queue.

## The pieces

| Asset | Role |
|---|---|
| GitHub issues (`loop-ready`) | **the queue** — the loop's input |
| `docs/agentic/STATE.md` | standing config — mission, config block, autonomy, caps, lessons |
| `autoloop:dev` (plugin skill) | **forward path** — issue → ready PR |
| `autoloop:pitcrew` (plugin skill) | **return path** — revises the loop's PRs from review / CI / conflicts |
| Supported hosts + engine profile (STATE → Config) | declared Claude/Codex/opencode host matrix and its native or exec dispatch |
| `{{CHECKLIST_PATH}}` | the criteria both reviewers grade against |
| `{{GATE_COMMAND}}` | the objective gate — the only source of "done" |
| `tools/agentic/*` (vendored) | preflight, command guard, write-back check, escalate classifier, loop-scope predicate, one-call run scan |
| Host continuation | Claude: `/loop` + `/goal`; Codex CLI: `/goal` and manual reruns; opencode: manual reruns or cron + `opencode run` |

## How to feed the queue

The queue is **GitHub issues**. Three ways in, all ending in git (plus one self-serve: the loop
files its own `loop-maintenance` issues when `STATE.md`/`ARCH.md` exceed their size budgets, and
takes them only when the queue is otherwise empty — the PR still ends at your merge):

1. **File an issue** and label it **`loop-ready`** (a trusted maintainer applies the label — see
   the injection guardrail in `STATE.md`). One issue = one PR-sized unit; state acceptance criteria
   and, if it depends on other issues, a `## Blocked by` section listing them.
2. **Brainstorm → plan → queue.** A design session produces a committed artifact (a spec/ADR under
   `docs/`); run **`/autoloop:shape <spec path>`** on Claude Code,
   **`$autoloop:shape <spec path>`** on Codex CLI, or the **`shape`** skill on opencode to
   decompose it into PR-sized issues with
   verified premises and testable acceptance (an interactive step a human runs, not the loop).
   Slice files them **unlabelled** — you review and apply `loop-ready` yourself.
3. **Ask your coding agent in any session** "file an issue for X" (or invoke the host's
   `autoloop:shape lint #N` form to grade one
   you wrote by hand before labeling it).

The merged PR (`Closes #N`) is the durable record.

## How to run it

**1. Watch the first run (do this before anything unattended).** Pause or clear any active
queue-wide `/goal`; the first run must have no persistent queue-drain goal. Invoke
`/autoloop:dev` in Claude Code, `$autoloop:dev` in Codex CLI, or the `dev` skill in opencode and
say **"take ONE issue and stop"**. The single-unit bound is those words in your invocation —
it is not repository state: any invocation without an explicit bound ("loop it", "drain the
queue", or just invoking the skill) drains the eligible queue. Confirm that the implementer
builds inside the claimed branch, the gate actually fails bad work, and the fresh review is
honest.

Only after that bounded run succeeds, set the unattended queue goal:

```
/goal Every open loop-ready issue is claimed by an open/merged PR (green gate),
      labelled loop-blocked with a reason, or dependency-blocked (open ## Blocked by).
```

An unbounded run may then drain eligible issues until the queue is empty or STATE's wall-clock cap
is reached.

**2. Claude Code cadence** (active session, your machine):

```
/loop 30m /goal <the stop condition above>
```
with `autoloop:dev` as the body. Each cycle runs **`autoloop:pitcrew` first** (clear review
feedback on open PRs), then `autoloop:dev` — clear the return path before opening more forward
work.

Codex CLI has `/goal` but no `/loop`; rerun `$autoloop:dev` manually. For recurring scheduling,
use a desktop scheduled task rather than inventing a CLI slash command. opencode likewise reruns
the `dev` skill manually, or on a cadence via cron wrapping
`opencode run "load the autoloop dev skill and run one cycle; stop condition: <the stop
condition above>"` from the repo root.

**Unattended cadence (Claude, survives closing the terminal):** the host's native scheduler —
a cron-style scheduled agent (`CronCreate` / the `/schedule` flow) running the pitcrew→dev cycle
on your cadence — instead of `/loop`, which lives and dies with its session.

## Asking for changes (the round-trip)

PRs are **draft while being worked, ready-for-review when the gate is green + the code review
passes** — so your review inbox is `gh pr list --search "draft:false"`. To request changes, leave a
normal PR review (`gh pr review <N> --request-changes -b "…"` or inline comments). **`autoloop:pitcrew`**
reads the threads, revises the **same branch**, re-runs the gate, resolves the threads, pushes, and
re-readies. You only ever **review + merge** — the loop never merges (unless your repo ratified the
optional auto-merge gate, whose every refusal still falls back to you).

## Autonomy & safety (L2)

- **PRs, never direct merges.** A human merges unless the repo-ratified policy gate performs its
  narrow evidence-backed exception. Read the diff — review is the ceiling.
- **The gate decides done**, not the model. Non-zero `{{GATE_COMMAND}}` = not done.
- **Escalate-list** paths are *built* but flagged `human:authorize` for extra-careful human review.
  **New dependencies and secrets/data-writes hard-defer** — the loop never adds a package or a
  secret autonomously.
- **Issue text is untrusted data** — the loop acts only on `loop-ready` labels applied by a
  maintainer, verified.
- **Never circumvent a guardrail.** If the gate, a hook, or a NEVER-DO rule can't pass
  legitimately, the loop stops and reports — never disables the check.
