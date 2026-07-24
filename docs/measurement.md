# Workflow measurement

Autoloop measurement-v1 records workflow cost as local, recomputable evidence. The contract can
describe a terminal completed, blocked, or failed unit across stages, review rounds, routes, and adapters;
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

The tool rejects normal `legacy-workflow` import, binds `revision` to the live checkout HEAD,
replaces `capturedAt` with its current clock, validates every field, and adds content and semantic
observation fingerprints plus store-local HMAC provenance. It then atomically creates one
write-once mode-`0600` file below the current worktree's Git path at
`autoloop/measurements/v1/<recordId>.json`. The directory is owned by the current user at mode
`0700`; its private authority key is mode `0600`. Records are tamper-evident and authenticated to
that store, not globally immutable or independently attested. A duplicate UUID, symlink anywhere
in the store path, non-regular or multiply linked record, wrong owner or mode, oversized input or
file, sparse array, unknown field, retired field, or invalid route combination is rejected.
Temporary writes are fsynced and linked under the final UUID only after completion. Publication
and recovery share one repository-wide Git-ref compare-and-swap lock, so a reader cannot recover
an active writer's two-link window. The lock owner is a Git blob bound to PID, process-instance
identity, nonce, store fingerprint, and time. Exact-old-OID acquisition/release is ABA-safe; a
crashed or PID-reused owner can be replaced only after its process identity is proved stale. On
restart, the lock holder removes an unlinked temporary or completes the unlink side of an
unambiguous two-link publication before opening a final record. A missing authority in a non-empty
store is corruption and can never rotate into a new key; a genuinely empty store can initialize
once.

Live HEAD, Git-path resolution, object writes, and lock-ref operations all use one explicit
repository context with replacement objects disabled and every ambient `GIT_*` override removed.
Caller `GIT_DIR`, worktree/object-directory, or injected config variables cannot redirect capture
or locking.

The HMAC authenticates what this local tool retained. It proves live HEAD and tool-clock capture.
Checkpoint and run/unit/terminal-evidence identity are explicitly marked operator/run-record
declarations; the tool does not claim independent truth for them. A separate authenticated legacy
import path does not exist yet, so legacy data cannot enter the enforceable local budget store.
`legacyProfile` is the only optional retired field and has no route-selection authority.

Summarize retained records with:

```bash
node tools/agentic/measurement-contract.mjs --summarize-store
```

The result contains separate unit and segment cohorts. One shared cohort identity preserves flow,
intent source, raw selector, requested engine and route, every requested and actual segment route,
lane, merge/base policy, configuration/capability/outage state, degradation, and provider/model/
engine observations. Segment cohorts add their stage, round, and role. Each operation reports its
explicit allowed-to-vary fields: summaries vary none; checkpoint comparisons vary revision,
checkpoint, capture identity, and terminal outcome; budget-current evaluation varies those same
fields while retaining the complete runtime identity.
Duplicate record IDs, duplicate run/unit identities, duplicate terminal-evidence fingerprints,
and exact semantic observation clones are invalid and excluded from aggregates. Budget source and
current cohorts must also have disjoint run/unit identities and terminal-evidence fingerprints.
This is equality-based replay detection, not independent attestation. Invalid authenticated
avoided-cost/control evidence makes `--summarize-store` fail nonzero rather than returning a
healthy partial claim.

## Record contract

The top-level record identifies:

- the live revision, workload, and declared checkpoint: `safe-system` or `post-optimization`;
- a declared run ID, unit ID, and terminal-evidence fingerprint used to prevent duplicate
  observations;
- active host, raw selector, requested engine, invocation route, Dev/Pitcrew intent, and intent
  source;
- final lane, merge policy, base-freshness strategy, configuration/capability/outage
  fingerprints, and any outage transition; and
- measurement duration and API/process/mutation overhead.

`segments` is a non-empty ordered list of route-bearing and orchestration work. Each segment records its stage,
round, writer/reviewer/orchestrator role, nominal requested route, actual route, adapter,
degradation, timing, dynamic step timings, and telemetry. The validator enforces the closed
five-route catalog and the stage/lane policy:

- docs and small Dev plan review use the active host's native route;
- docs implementation is native; small/full implementation uses the invocation route;
- docs/small code review and every later convergence round are native;
- full-lane first review uses the invocation route;
- Pitcrew implementation and first review use the invocation route, with later review native; and
- judgment, gate, and delivery segments are attributed to the active host's native route.

Dev records include premise validation, selection, planning, plan review, claim, implementation,
simplification, orchestrator diff review, code-review rounds, gate, and delivery. Pitcrew omits
planning/plan review and includes recovery when resuming. A blocked or failed record may terminate
at a valid early prefix such as plan review; a completed record must reach delivery after a
successful gate. Active/wait components reconcile exactly to each segment and unit total,
dispatch totals reconcile to engine-dispatch segments, aggregate telemetry reconciles to segments,
and time-to-first-selection equals its named unit step.

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

Every avoided-time field is either typed `unavailable` with a reason or `verified` with a
tamper-evident evidence bundle. The bundle names the observed and counterfactual values, their
arithmetic, the method, and any exact authenticated control record IDs and content fingerprints.
Matched controls must exist in the same supplied record set, authenticate to the local store, and
share the complete comparable cohort; the tool replays their median. Until an external experiment
attestation is integrated, `non-mutating-replay` and `labeled-counterfactual` cannot be marked
verified and must remain typed unavailable. A label or lane decision by itself is not avoided-cost
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

The comparison admits manual-to-manual records only. It matches the shared strict cohort identity,
allowing only revision, checkpoint, capture identity, and terminal outcome to vary. It never uses
`legacyProfile` as a route. Duplicate record IDs invalidate the complete input, including when the
duplicate contents differ. Unmatched cohorts remain visible instead of being coerced into a
comparison. The legacy-to-safe delta is the aggregate cost of the safety migration, not
attribution to an individual repair.

A newly safe non-manual mode is a separate safe-only cohort unless its legacy behavior can be
measured through a non-mutating replay.

## Evidence-derived budgets

Budgets are exact mode/workload contracts. A mode fixes active host, selector, requested engine and
route, observed actual-route set, lane, merge policy, and base-freshness strategy. Every budget
contains the safe-system revision, sorted source record IDs plus their content fingerprints and
store-authentication tags, a recomputable cohort fingerprint, and the source statistic and sample
count for each metric.

Create the source evidence from one homogeneous safe-system cohort:

```json
{ "recordIds": ["<safe-system-record-uuid>", "<safe-system-record-uuid>"] }
```

```bash
node tools/agentic/measurement-contract.mjs --budget-source \
  < /tmp/safe-system-record-ids.json
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
  "baselineRecordIds": ["<safe-system-record-uuid>"],
  "currentRecordIds": ["<post-optimization-record-uuid>"]
}
```

```bash
node tools/agentic/measurement-contract.mjs --evaluate-budget \
  < /tmp/autoloop-budget-evaluation.json
```

`--budget-source` and `--evaluate-budget` accept record IDs, then load the corresponding
authenticated records from the local store. Caller-supplied record JSON cannot seed or enforce a
budget. The evaluator requires the baseline input to equal the named source set exactly, rejects
extra decoy records, and derives the cohort from named records independently of caller ordering.
Source records share one exact revision. Current `post-optimization` records may use a different
revision, while every other strict runtime identity dimension remains fixed. The evaluator replays
every named source content fingerprint and authentication tag and refuses changed, duplicated,
missing, unauthenticated, or cohort-mismatched evidence. It also
refuses a median below its declared reporting floor or a p95 below at least 20 observations. A
valid result remains `provisional` until both source and current metrics meet the declared stable
floor, which is at least 100 observations. Only stable evidence returns `passed` or `failed`; a
provisional overage is reported as `withinLimit: false` without being called a regression.

Capture the manual safe-system baseline on the same repeatable workloads as any genuine,
separately retained legacy comparison evidence. Legacy comparison remains descriptive until an
authenticated import exists. Establish mode-specific budgets only from the authenticated safe
baseline and retain the raw records for every accepted optimization. No current project budget
should be treated as active until those real samples and operator-selected limits exist.
