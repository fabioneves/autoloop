# Workflow measurement

Autoloop records workflow cost so optimization decisions can be based on comparable runs rather
than anecdotes. Raw records are local operational telemetry; they are not committed, posted to an
issue, or sent to another service by the measurement tool.

## Record lifecycle

Each completed unit emits one measurement-v1 JSON object and pipes it to:

```bash
node tools/agentic/measurement-contract.mjs --record < /tmp/autoloop-measurement.json
```

The tool validates the full record and creates one immutable, mode-`0600` file below the current
worktree's Git path at `autoloop/measurements/v1/<recordId>.json`. A duplicate UUID is rejected.
This keeps linked worktrees isolated and preserves the raw input needed to recompute aggregates.

Summarize every retained record with:

```bash
node tools/agentic/measurement-contract.mjs --summarize-store
```

The summary groups only comparable runs: revision, workload, host, selector, requested/actual
route, adapter, degradation, intent source, stage, round, lane, merge policy, base-freshness
strategy, configuration fingerprint, capability fingerprint, and outage transition must match.

## Required evidence

A record includes:

- total, active, engine-wait, CI-wait, human-wait, first-selection, per-step, and instrumentation
  time;
- orchestrator, implementer, and reviewer token counts;
- prompt/context byte counts;
- GitHub API calls, subprocesses, and remote mutations;
- dispatch count/duration, review rounds, finding yield, and accepted rebuts;
- first-pass gate, local-green/CI-red, context-park, resume, and recovery outcomes; and
- exact revision, route, policy, and capability/configuration fingerprints.

Provider facts that cannot be observed are `null` and require an explicit
`{ "field": "...", "reason": "..." }` entry. Missing data is never converted into zero. A
legacy importer may retain the retired route field only as `legacyProfile`; it cannot influence a
current route.

## Statistical bar

The contract reports the arithmetic median for every non-empty metric sample. Nearest-rank p95 is
withheld below 20 observations in a cohort. Budgets remain provisional below 100 observations
unless a tighter confidence rule is documented before looking at the result.

Capture manual-policy legacy and safe-system cohorts with the same workload definitions. Use the
legacy-to-safe difference only as the aggregate cost of the safety migration. Set regression
budgets from the safe-system cohort, stratified by workload and route. A claimed optimization must
retain its before/after raw records and preserve exact-head delivery, recovery, lane, overlap, and
review invariants.

Until those sample floors are met, report the observed counts and distributions as provisional;
do not claim a performance win.
