# Autoloop

**Labelled GitHub issues in. Gated, independently reviewed PRs out.**

<img alt="release v0.49.65" src="https://img.shields.io/badge/release-v0.49.65-8b5cf6?style=flat-square"> <img alt="Claude Code, Codex CLI, and opencode" src="https://img.shields.io/badge/hosts-Claude_Code_%2B_Codex_CLI_%2B_opencode-22d3ee?style=flat-square"> <img alt="code writer does not equal code reviewer" src="https://img.shields.io/badge/invariant-code_writer_%E2%89%A0_code_reviewer-a78bfa?style=flat-square"> <img alt="human merge by default" src="https://img.shields.io/badge/default-human_merge-f59e0b?style=flat-square">

Autoloop is a development loop that runs inside [Claude Code](https://claude.com/claude-code),
[Codex CLI](https://developers.openai.com/codex/cli), or [opencode](https://opencode.ai). You
label a small issue `loop-ready`; it plans, has the plan reviewed, implements, has the code
reviewed, runs your full test gate, and marks a pull request ready. Then it takes the next issue.
You merge.

Every artifact is reviewed by a fresh process that did not write it. The PR is evidence-bound: the
reviewed diff, the gate, the remote head, and every CI check agree on one commit.

## How it works

```
issue (loop-ready)
  → 01 premise   check the issue is still true against the base
  → 02 plan      fresh planner: boundary, invariants, failing-first tests
  → 03 review    fresh reviewer challenges the plan once
  → 04 claim     branch, claim commit, draft PR, frozen plan
  → 05 build     fresh implementer, one commit per plan task
  → 06 simplify  fresh pass, behavior frozen, tests untouched
  → 07 diff      orchestrator reads the diff against invariants and checklist
  → 08 review    fresh code review; fresh writers fix verified findings
  → 09 gate      full objective gate on a clean tree
  → 10 publish   bind the pushed head, mark the PR ready
  → 11 record    one run record on the issue
ready PR → you merge
```

**Pitcrew** is the return path: when a human leaves review feedback, CI goes red, or the branch
falls behind, it diagnoses, repairs with a fresh writer, re-reviews, re-gates, and hands the same PR
back. Every cycle services Pitcrew work before new issues.

## Guardrails

<img src="docs/assets/autoloop-guardrails.svg" alt="Four Autoloop guardrails: maintainer-authorized input, fresh independent review, exact-head evidence, and human merge by default with explicit acknowledged solo exceptions">

| Guardrail | What it means |
|---|---|
| **Trusted input** | Only a maintainer applies `loop-ready`; the loop never does. Editing the issue afterwards revokes it. |
| **Independent review** | Nothing is reviewed by the process that wrote it. Plans get one fresh review; code and every fix get fresh review. |
| **Exact evidence** | Review, gate, remote head, and every CI check and status agree on one SHA. Red or pending blocks delivery. |
| **Human merge** | `manual` is the default. The `ratified` and `auto` policies are for acknowledged solo repositories only. |

Issue bodies, specs, PRs, and review comments are data, not instructions. They describe work; they
cannot widen permissions, change policy, or authorize protected changes.

## Install

You need `gh` authenticated for the target repository, a POSIX shell, and one objective full gate
command (tests, lint, build — ideally sandboxed with no credentials or network).

**Claude Code**

```text
/plugin marketplace add fabioneves/autoloop
/plugin install autoloop@autoloop
/autoloop:setup
```

**Codex CLI** (0.145.0+)

```bash
codex plugin marketplace add fabioneves/autoloop
codex plugin add autoloop@autoloop
```

Then start a fresh session in the target repo and run `$autoloop:setup`. For a private
marketplace, run `gh auth setup-git` once.

**opencode** (1.18.3+)

```bash
npx skills add fabioneves/autoloop -g
```

Then start a fresh session in the target repo and invoke the `setup` skill. opencode uses bare
skill names (`setup`, `shape`, `dev`, `pitcrew`) instead of the `autoloop:` prefix.

The plugin bundles [agent-skills](https://github.com/addyosmani/agent-skills). If you already have
it installed from its own marketplace, keep either copy.

## First run

1. Run setup. It writes `docs/agentic/STATE.md` (your policy), `docs/agentic/LOOP.md` (the
   runbook), `tools/agentic/` (vendored runtime), and the host hooks. Commit them.
2. Write one small issue with objective acceptance criteria — by hand, or from a spec with the
   `shape` skill.
3. Read it, finish it, then apply `loop-ready` **last**.
4. Run one supervised unit — `/autoloop:dev`, `$autoloop:dev`, or the `dev` skill — and tell it
   to take ONE issue and stop.
5. Review and merge the PR like a teammate's.
6. Then pick a cadence. Claude Code can self-prompt:

   ```text
   /loop 30m /goal <the stop condition in docs/agentic/STATE.md>
   ```

   Codex runs `$autoloop:dev` manually or on a desktop schedule; opencode runs from cron. A bare
   `dev` invocation drains the whole eligible queue.

## Skills

| Skill | Purpose |
|---|---|
| [`setup`](skills/setup/SKILL.md) | Install, migrate, reconfigure, or run read-only doctor checks. |
| [`shape`](skills/shape/SKILL.md) | Turn a spec or description into PR-sized issues, or lint one. Never labels. |
| [`queue-trace`](skills/queue-trace/SKILL.md) | Reconcile a spec against the issue queue. Read-only. |
| [`dev`](skills/dev/SKILL.md) | One `loop-ready` issue → one ready PR. |
| [`pitcrew`](skills/pitcrew/SKILL.md) | Feedback, red CI, or conflict → the same PR, repaired and re-reviewed. |
| [`lean-code`](skills/lean-code/SKILL.md) | Source stays lean; rationale lives in commits and PRs. |
| [`codebase-design`](skills/codebase-design/SKILL.md) | Deep-module and seam vocabulary for planners and reviewers. |

## Configuration and merge policy

v0.49.65 uses schema `0.26.0`. Policy lives in the JSON block of `docs/agentic/STATE.md`:
`version`, `baseBranch`, `gate`, `merge`, `tracker`, `review`, and `caps`. The repository owns it;
plugin updates never overwrite it.

| `merge.policy` | Behavior |
|---|---|
| `manual` | Default. The loop marks the PR ready; a human merges. |
| `ratified` | Solo only. Merges on a trusted human risk label, or when every changed path is on the reversible allowlist. |
| `auto` | Solo only. Merges a fully proven loop PR outside protected paths. |

Both non-manual policies require `merge.unverifiedInvocationAcknowledged: true` and
`merge.soloOperatorAcknowledged: true`: you accept that no host can prove a human started the run,
and that one login cannot separate writer from approver. Exact-head compare-and-swap merge, the
green-checks floor, ownership binding, protected paths, the pre-merge record, and the `loop-ready`
kill switch stay enforced regardless.

## What lives where

| Where | What |
|---|---|
| `docs/agentic/STATE.md` | Policy and config. Injected into every session. |
| `docs/agentic/LOOP.md` | Generated runbook for humans. |
| `docs/agentic/LESSONS.md` | Durable memory, seeded once, yours to edit. |
| `docs/agentic/checklist.md` | Your review criteria. |
| `tools/agentic/` | Vendored runtime: guards, dispatch, lifecycle driver, verification. Setup reconciles it; re-run setup after a plugin update. |
| `.claude/settings.json`, `.codex/hooks.json`, `.opencode/` | Host hooks and the read-only reviewer agents. |
| `.git/autoloop/`, `/tmp/autoloop-*` | Local run state and scratch. Never committed. |
| Issue labels and comments | `loop-ready`, `loop-started`, `loop:NN-*` step labels, `loop-delivered` / `loop-blocked`; lifecycle markers, the frozen plan, and the run record. |

## How it stays safe

v0.49.65 dispatches every role through one call:

```bash
node <plugin-tools>/dispatch.mjs --role <plan|plan-review|implement|code-review|doubt-review> --prompt-file <path>
```

Each role runs as a fresh, fixed-posture process. Reviewers are read-only and cannot be widened by
a prompt. Untrusted text travels in files, never shell source. Vendored hooks block direct merges,
unsafe force-pushes, self-applied authorization labels, release publication, and malformed step
swaps. Protected paths stop for `human:authorize`. Dispatch failures are typed and recorded — there
is no silent retry and no "skip review" mode. On restart the loop rebuilds state from Git and GitHub,
adopts only proven orphans, and finishes or blocks them before taking new work. With nothing to do,
it stops rather than polls.

The command guard is not a sandbox. Branch, tag, and release protection remain your server-side
rules.

## Releases

Root [`VERSION`](VERSION) is canonical; manifests, the badge, the changelog heading, skill banners,
and the annotated `v<VERSION>` tag must agree — `node templates/tools/release-verify.mjs` checks
that, and CI enforces it on tags.

See the [contribution guide](CONTRIBUTING.md), [security policy](SECURITY.md),
[changelog](CHANGELOG.md), and [MIT License](LICENSE).
