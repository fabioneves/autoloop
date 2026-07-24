# Workflow measurement

Autoloop measurement-v1 records workflow cost as local, recomputable evidence. The contract can
describe a single completed unit that crosses several stages, review rounds, routes, and adapters;
it does not flatten that unit into one misleading route. The measurement tool never posts records
to GitHub or sends them to another service.

The pipeline is implemented in v0.40.0. This repository does not yet contain real legacy,
safe-system, or post-optimization samples, and it has no evidence-derived performance budget.
Capture those records before making performance claims. Never synthesize a missing historical
baseline or relabel a current run as `legacy-workflow`.

## Record lifecycle

Each terminal unit emits one strict measurement-v1 JSON object:

```bash
node tools/agentic/measurement-contract.mjs --record < /tmp/autoloop-measurement.json
```

The tool validates every field and creates one immutable mode-`0600` file below the current
worktree's Git path at `autoloop/measurements/v1/<recordId>.json`. The directory is mode `0700`.
A duplicate UUID, symlinked store, widened file mode, sparse array, unknown field, retired field,
or invalid route combination is rejected. `legacyProfile` is the only optional retired field and
has no route-selection authority.

Summarize retained records with:

```bash
node tools/agentic/measurement-contract.mjs --summarize-store
```

The result contains separate unit and segment cohorts. Unit cohorts preserve the complete set of
actual routes used by the unit. Segment cohorts add stage, round, role, requested and actual route,
adapter, degradation, provider, model, and engine identity. Configuration, capability, and outage
fingerprints prevent unlike runtime states from being pooled.

## Record contract

The top-level record identifies:

- the exact revision, workload, and checkpoint: `legacy-workflow`, `safe-system`, or
  `post-optimization`;
- active host, raw selector, requested engine, invocation route, Dev/Pitcrew intent, and intent
  source;
- final lane, merge policy, base-freshness strategy, configuration/capability/outage
  fingerprints, and any outage transition; and
- measurement duration and API/process/mutation overhead.

`segments` is a non-empty ordered list of route-bearing work. Each segment records its stage,
round, writer/reviewer/orchestrator role, nominal requested route, actual route, adapter,
degradation, timing, dynamic step timings, and telemetry. The validator enforces the closed
five-route catalog and the stage/lane policy:

- docs and small Dev plan review use the active host's native route;
- docs implementation is native; small/full implementation uses the invocation route;
- docs/small code review and every later convergence round are native;
- full-lane first review uses the invocation route;
- Pitcrew implementation and first review use the invocation route, with later review native; and
- judgment, gate, and delivery segments are attributed to the active host's native route.

Only an implementation segment may record a cross-host-to-native outage fallback. Its degradation
must be explicit. The adapter always equals the actual closed-catalog route.

Each segment has typed provider facts:

```json
{ "status": "observed", "value": 123 }
```

or:

```json
{ "status": "unavailable", "reason": "provider did not expose cached input tokens" }
```

Provider, model, engine, prompt/cached/output/reasoning tokens, context bytes, and USD engine cost
use that representation. Unavailable data is never zero. The unit carries aggregate token,
context, and cost observations; when every segment value is observed, the validator requires the
unit total to equal the segment sum.

The unit also records:

- time to first selection, total/active/engine/CI/human time, and dynamic step timings;
- GitHub API calls, subprocesses, and remote mutations;
- dispatch count and duration, code-review rounds, finding counts, and accepted/rejected rebuts;
- gate and local-green/CI-red outcomes;
- resume/restart, recovery, and context-park outcomes;
- staged-ahead use and scope/lane misses; and
- resumed claims, audit backfills, avoided duplicate scans, and prevented false doctor failures.

An estimated avoided-time or avoided-operation claim is valid only with an evidence fingerprint
and one of `matched-control`, `non-mutating-replay`, or `labeled-counterfactual`. A matched-control
claim also names its control record IDs. A label or lane decision by itself is not avoided-cost
evidence.

## Summary and statistical bar

Every numeric metric, including every dynamically named step, reports:

- observed and unavailable sample counts;
- the arithmetic median;
- nearest-rank p95 only with at least 20 observed values; and
- its own `provisional` flag until that metric has at least 100 observed values.

The provisional decision uses the metric's observed count, not the cohort's record count. Outcome
rates report their own denominator and provisional status. Rates include first-pass gate,
local-green/CI-red, resumed and restarted interrupted units, overlap utilization, false lane
classifications, scope-drift fallbacks, and accepted rebuts. Estimated avoided-time metrics are
cohorted by evidence method so matched controls are never pooled with labeled counterfactuals.

## Matched checkpoint comparison

Compare genuine legacy records with the safe-system checkpoint:

```bash
node tools/agentic/measurement-contract.mjs --compare safe-system \
  < /tmp/legacy-and-safe-records.json
```

Use `post-optimization` to compare a later checkpoint against legacy:

```bash
node tools/agentic/measurement-contract.mjs --compare post-optimization \
  < /tmp/legacy-and-post-records.json
```

The comparison admits manual-to-manual records only. It matches workload, observed actual-route
set, lane, and base-freshness strategy. It never uses `legacyProfile` as a route. Unmatched cohorts
remain visible instead of being coerced into a comparison. The legacy-to-safe delta is the
aggregate cost of the safety migration, not attribution to an individual repair.

A newly safe non-manual mode is a separate safe-only cohort unless its legacy behavior can be
measured through a non-mutating replay.

## Evidence-derived budgets

Budgets are exact mode/workload contracts. A mode fixes active host, selector, requested engine and
route, observed actual-route set, lane, merge policy, and base-freshness strategy. Every budget
contains the safe-system revision, sorted source record IDs, a recomputable cohort fingerprint,
and the source statistic and sample count for each metric.

Create the source evidence from one homogeneous safe-system cohort:

```bash
node tools/agentic/measurement-contract.mjs --budget-source \
  < /tmp/safe-system-cohort.json
```

The operator adds justified maxima and declared sample floors to that evidence. The fixed budget
surface covers median prompt tokens, context bytes, GitHub API calls, subprocesses, remote
mutations, time to first selection, median unit time, and p95 unit time. Validate the exact budget
shape with:

```bash
node tools/agentic/measurement-contract.mjs --validate-budget \
  < /tmp/autoloop-budget.json
```

Evaluate it with a strict envelope:

```json
{
  "budget": {},
  "baselineRecords": [],
  "currentRecords": []
}
```

```bash
node tools/agentic/measurement-contract.mjs --evaluate-budget \
  < /tmp/autoloop-budget-evaluation.json
```

The evaluator replays the named safe-system records and refuses changed or missing source
evidence. It also refuses a median below its declared reporting floor or a p95 below at least 20
observations. A valid result remains `provisional` until both source and current metrics meet the
declared stable floor, which is at least 100 observations. Only stable evidence returns `passed`
or `failed`; a provisional overage is reported as `withinLimit: false` without being called a
regression.

Capture the manual safe-system baseline on the same repeatable workloads as any genuine legacy
evidence. Then establish mode-specific budgets from the safe baseline and retain the raw records
for every accepted optimization. No current project budget should be treated as active until those
real samples and operator-selected limits exist.
