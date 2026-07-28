# LESSONS — durable rules learned in this repository

> Field-learned rules for the autoloop here. Read on demand, not injected every session — that is
> the whole point of the split from [`STATE.md`](./STATE.md), which stays small because it is
> injected. A lesson belongs here when it changed how a run should behave and a future run would
> otherwise repeat the mistake.
>
> **Prune when a lesson becomes a mechanism.** Once a guard rule, a contract check, a hook, or a
> tool enforces the lesson, the mechanism IS the memory — delete the prose and cite the enforcer
> instead. A lessons file that only grows stops being read, and an unread lesson prevents nothing.
> Curate it like an architecture map: periodically, against a size budget, in its own maintenance
> unit.

Each entry states the rule first, then the evidence that earned it — a date, a run, a defect. A
rule with no evidence is an opinion and belongs in STATE's policy or nowhere.

## Gate and evidence

- **The gate, not the model, decides "done".** `gate.command` must exit 0 on the committed tree; a
  run that claims done while the gate is red is not done.
- **What is gated must be what is pushed.** Commit every fix, record the gated `git rev-parse
  HEAD`, and verify the PR's `headRefOid` equals it before resolving threads or marking ready.
- **Never run the live or watch-mode service against unreviewed code.** Hot reload executes
  half-reviewed code against live credentials the moment it lands on disk. Gate in a one-shot
  sandboxed runner, and re-check `git status --porcelain` afterwards — a gate that mutates tracked
  files is an incident.

## Working tree

- **A dirty checkout is a hard stop, with one exception.** A human's work-in-progress must never
  ride into the loop's commits: never stash, discard, or commit it — stop and report. The exception
  is a provably loop-owned in-flight unit: a dirty tree on a `<type>/gh-<N>-<slug>` branch with an
  open draft loop PR (`Closes #N`), HEAD at the loop's own `chore: claim #<N>` commit, full
  adoption provenance on the issue, and every dirty path inside the plan boundary with no protected
  path. All of it holding means the loop is looking at its own interrupted output and may resume;
  any check failing, or any doubt, means human work and a stop.

## Untrusted text

- **Untrusted text never touches shell source.** Issue, plan and review text reaches GitHub through
  `--body-file` scratch files written outside the repository; slugs, titles and summaries are
  composed by the orchestrator from a strict allowlist (`[a-z0-9-]` slugs, plain-ASCII titles).

<!-- Add repository-specific lessons below. Keep each one rule-first, evidence-second. -->
