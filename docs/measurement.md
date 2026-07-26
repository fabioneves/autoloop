# Workflow measurement

Autoloop measurement-v1 records workflow cost as local, recomputable evidence. The contract can
describe a terminal completed, blocked, or failed unit across stages, review rounds, routes, and adapters;
it does not flatten that unit into one misleading route. The measurement tool never posts records
to GitHub or sends them to another service.

The pipeline is implemented in v0.41.0. This repository does not yet contain real legacy,
safe-system, or post-optimization samples, and it has no evidence-derived performance budget.
Capture those records before making performance claims. Never synthesize a missing historical
baseline or relabel a current run as `legacy-workflow`.

## Record lifecycle

Each unit retains a versioned event stream while it runs. Generate the measurement run UUID and
retain the benchmark manifests immediately after Runtime opens, before authentication probes,
Git synchronization, the startup scan, lifecycle recovery, route probing, or selection. Bind it
to the broker-issued Runtime run:

```bash
node tools/agentic/run-scope.mjs --bind-measurement-json \
  /tmp/autoloop-measurement-binding.json
```

The exact request is `{run,measurement}`. `measurement` is version 1 and
declares the run UUID, workload/checkpoint identifiers, benchmark fingerprints, intent source,
and merge/base policy. Unit identity, lane proof, and outage transition are deliberately absent:
they are not known before selection and cannot be caller-authored. The broker rejects caller
capability, route-state, repository, host, configuration, nonce, observation, or authority fields
and persists `run-start` after validating the exact run it issued. Start the `selection` stage
immediately and execute every startup GitHub read, subprocess, and mutation through the measured
operation wrapper; otherwise startup calls and time-to-selection are incomplete. A Runtime run may bind successive
unit measurement UUIDs, but one measurement UUID can never move between Runtime runs.

An event has `version: 1`, one run UUID, a closed event kind, and its kind-specific payload. The
ordered kinds are `run-start`, `unit-context`, `stage-start`, `wait-start`, `wait-end`,
`operation`, `dispatch`, `stage-end`, `lifecycle`, and `run-finish`. The tool assigns the event
UUID, sequence, timestamp,
and live Git revision. A run starts once, finishes once, and cannot append after its finish. A
code-changing run may cross commits: each event retains its observed HEAD,
`provenance.derivation.startRevision` retains the run-start HEAD, and the aggregate `revision` is
the final/result HEAD from `run-finish`. Finalization requires that result revision to remain the
live HEAD. A run that does not change code therefore has equal start and result revisions.
Stage and wait spans must pair and cannot overlap. Operation, dispatch, finding, rebut, lifecycle,
stage, and wait identities are unique, so replay cannot inflate a counter.

Capture declared boundaries with the public command and an empty envelope map:

```json
{
  "version": 1,
  "runId": "<run-uuid>",
  "kind": "stage-start",
  "payload": { "id": "implementation-1", "stage": "implementation", "round": 1 },
  "envelopes": {}
}
```

```bash
node tools/agentic/measurement-contract.mjs --capture-event \
  < /tmp/autoloop-measurement-boundary.json
```

The public capture path rejects every caller-supplied observed producer envelope. It accepts
boundary events and explicit `{status:"unavailable",reason:"..."}` evidence only. It also rejects
`run-start` and `unit-context` as caller authority. After selection and the first exact Runtime
plan, bind the selected unit through the broker:

```bash
node tools/agentic/run-scope.mjs --bind-measurement-unit-json \
  /tmp/autoloop-measurement-unit.json
```

The exact request is `{runId,run,plan,unitId}`. The ledger requires the already-bound measurement
run and the exact plan it issued, derives the initial lane and lane-proof fingerprint from that
plan, binds its exact capability and initial route-state fingerprints, and persists one
idempotent `unit-context` before the first dispatch. A changed unit, foreign/reused plan, caller
lane/capability/outage field, or second context fails. Later final-diff proof may
legitimately promote a lane; each dispatch segment therefore retains its own Runtime-derived
effective lane and proof fingerprint while the record-level lane remains the initial planned lane.

Execute each
GitHub API read, subprocess, or remote mutation through the measured command wrapper instead:

```json
{
  "version": 1,
  "runId": "<run-uuid>",
  "stageId": "gate",
  "operationId": "gate-command-1",
  "kind": "subprocess",
  "action": "run configured gate",
  "command": {
    "executable": "node",
    "args": ["tools/agentic/verify.mjs", "--install-root", "."],
    "cwd": "<absolute-repository-root>"
  }
}
```

```bash
node tools/agentic/measurement-contract.mjs --run-operation \
  < /tmp/autoloop-measured-operation.json
```

The wrapper classifies the executable and arguments independently, applies the same configured-base
and forbidden-operation policy as the shell guard, runs without a shell, removes ambient Git and
authority overrides, fingerprints bounded redacted stdout/stderr facts, and persists the
operation before returning success. Unknown Git/GitHub shapes and Git global-option push forms are
remote mutations. Before any remote mutation it durably journals an authenticated prepared
intent and, only after the authenticated operation event is retained, appends its matching commit
marker. One unresolved intent blocks every later remote mutation in that run. The run is
terminally blocked for external, action-specific read-back; the wrapper provides no caller-trusted
reconciliation shortcut and never executes a retry. A committed effect cannot be replayed under a
fresh operation ID. Duplicate operation IDs are rejected before execution. A remote mutation
returns `retrySafe:false`.

For Runtime work, retain `stage-start`, then replace `--observe-json` with:

```bash
node tools/agentic/run-scope.mjs --observe-measured-json \
  /tmp/autoloop-runtime-observation.json
```

The exact request is `{runId,run,routeState,plan,outcome}`. Use it for every Dev/Pitcrew
observation, including retry and fallback. On a final Runtime receipt, the broker
persists one `dispatch` with the full authenticated `runtimeReceipt` and its derived
finding/rebut identities, then one `stage-end` with the receipt's actual route, adapter, and
degradation, before consuming the outcome. Retry and fallback results retain the stage and do not
claim a receipt. Plain `--observe-json` refuses final Dev/Pitcrew receipts. Provider accounting is
currently retained as typed unavailable when the adapter does not expose it.

`run-finish` has separate `terminalEvidence`, `gateEvidence`, and `lifecycleEvidence` references.
v0.40 does not have producer-backed terminal/gate/lifecycle or provider-accounting capture, so
live runs must retain those fields as typed unavailable and must not finalize an aggregate or enter
an enforceable budget. This is why the shipped budget policy is `pending-evidence`. Do not convert
workflow prose, caller JSON, a CheckRun name, or a missing provider field into observed evidence.
The producer-backed Runtime and command events remain retained for later replay.

Only after a future or installed producer supplies every required observed finish envelope may the
finish event be turned into a derived record:

```json
{
  "runId": "<run-uuid>",
  "recordId": "<new-record-uuid>"
}
```

```bash
node tools/agentic/measurement-contract.mjs --finalize-events \
  < /tmp/autoloop-measurement-finalization.json
```

When every required producer is available, finalization authenticates and replays the complete
event set, derives timings from tool-clock
boundaries—including the full `run-start` to selection-end wall interval—counts unique retained
operations and receipts, aggregates provider envelopes, and
atomically writes the measurement-v1 record. It refuses gaps, reordering, identity mismatch,
replay, incomplete spans, inconsistent route receipts, unavailable count evidence, or an aggregate
that does not validate. On every later store read, the tool loads the raw events again, verifies
their HMACs and exact event-set fingerprint, recomputes the aggregate, and compares every content
field. `--record` deliberately refuses caller-composed aggregate JSON.

Raw events are write-once mode-`0600` files below
`autoloop/measurements/v1/events/<runId>/`; finalized records are write-once mode-`0600` files at
`autoloop/measurements/v1/<recordId>.json`. The directory is owned by the current user at mode
`0700`; its private authority key is mode `0600`. Events and records are tamper-evident and
authenticated to that store, not globally immutable or independently attested. A duplicate UUID,
symlink anywhere in the store path, non-regular or multiply linked file, wrong owner or mode,
oversized input or file, graph node with more than 10,000 own properties, sparse array, unknown
field, retired field, or invalid route combination is rejected. Graph width is checked from the
own-key list before property descriptors are materialized or children are queued.
Temporary writes are fsynced and linked under the final UUID only after completion. Publication
and recovery share one repository-wide Git-ref compare-and-swap lock, so a reader cannot recover
an active writer's two-link window. The lock owner is a Git blob bound to PID, process-instance
identity, nonce, store fingerprint, and time. Exact-old-OID acquisition/release is ABA-safe.
Symbolic lock refs are rejected, and acquire, takeover, and release use no-dereference ref updates,
so a ref-type race cannot mutate the symbolic target. A crashed, zombie, or PID-reused owner can be
replaced only after its process state or identity proves it stale; an owner whose liveness or
identity cannot be verified remains held fail-closed. On restart, the lock holder removes an
unlinked temporary or completes the unlink side of an unambiguous two-link publication before
opening a final record. A missing authority in a non-empty store is corruption and can never
rotate into a new key; a genuinely empty store can initialize once.

Live HEAD, Git-path resolution, object writes, and lock-ref operations all use one explicit
repository context with replacement objects disabled and every ambient `GIT_*` override removed.
Caller `GIT_DIR`, worktree/object-directory, or injected config variables cannot redirect capture
or locking.

The HMAC authenticates what this local tool retained at event time. It proves local retention under
the store authority and binds live HEAD, tool-clock capture, event order, and the declared payload.
It does not prove that an external command ran, that a provider's declaration was true, or that a
fingerprinted receipt was independently observed. Checkpoint, workload, comparison-context,
checkpoint-endpoint, and evidence fingerprints remain declarations bound into authenticated raw
events. A separate authenticated legacy import path does not exist, so legacy data cannot enter
the enforceable local budget store through direct persistence or event-stream finalization.
`legacyProfile` is the only optional retired aggregate field and has no route-selection authority.

Summarize retained records with:

```bash
node tools/agentic/measurement-contract.mjs --summarize-store
```

The result contains separate unit and segment cohorts. One shared cohort identity preserves flow,
intent source and provenance, raw selector, selected engine and route, every selected and actual
segment route, lane, merge/base policy, configuration, the stable checkpoint endpoint, degradation,
and provider/model/engine observations. Serialized compatibility keys named `requestedEngine` and
`requestedRoute` describe captured/selected routing and never imply an authenticated user request.
Segment cohorts add their stage, round, and role. Capability
and outage fingerprints and transitions remain per-invocation evidence: they do not split a stable
endpoint cohort, but every result reports their exact value/count distributions rather than hiding
the variation. Checkpoint comparison permits revision, configuration, and endpoint to differ
between checkpoints while requiring exactly one of each within a checkpoint. Budget evaluation
permits revision and endpoint to differ between source and current while requiring one of each per
side and the same configuration and stage-independent runtime identity across sides.
Duplicate record IDs, duplicate run/unit identities, duplicate terminal-evidence fingerprints,
and exact semantic observation clones are invalid and excluded from aggregates. Budget source and
current cohorts must also have disjoint run/unit identities and terminal-evidence fingerprints.
This is equality-based replay detection, not independent attestation. Invalid authenticated
avoided-cost/control evidence makes `--summarize-store` fail nonzero rather than returning a
healthy partial claim.

## Record contract

The top-level record identifies:

- the final/result live revision, workload, and declared checkpoint: `safe-system` or
  `post-optimization`;
- `comparisonContextFingerprint`, the SHA-256 of the exact retained bytes of a versioned benchmark
  manifest;
- `checkpointEndpointFingerprint`, the SHA-256 of the exact retained bytes of the
  checkpoint-specific, versioned endpoint manifest;
- a declared run ID, unit ID, and terminal-evidence fingerprint used to prevent duplicate
  observations;
- active host, raw selector, selected engine, invocation route, Dev/Pitcrew intent, intent source,
  and immutable `intentProvenance`;
- final lane, merge policy, base-freshness strategy, configuration/capability/outage
  fingerprints, and any outage transition; and
- measurement duration and API/process/mutation overhead.

`segments` is a non-empty ordered list of route-bearing and orchestration work. Each segment records its stage,
round, writer/reviewer/orchestrator role, nominal selected route, actual route, adapter,
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
context, and cost observations. When every segment value is observed, the validator always requires
the unit total to equal the segment sum.

If one or more segment values are unavailable but the provider independently reports a unit total,
that observed unit value must retain typed provenance:

```json
{
  "status": "observed",
  "value": 42,
  "provenance": {
    "method": "provider-unit-total",
    "evidenceFingerprint": "<sha256-of-canonical-rawEvidence>",
    "rawEvidence": {
      "version": 1,
      "runId": "f23e4567-e89b-42d3-a456-426614174000",
      "unitId": "issue-1",
      "metric": "reasoningTokens",
      "provider": "openai",
      "value": 42
    }
  }
}
```

`rawEvidence` is a closed, versioned provider-accounting envelope. Its run ID and unit ID must equal
the measurement observation, its metric and value must equal the claimed aggregate, and its
provider must be observed identically on every segment in that unit. `evidenceFingerprint` is the
SHA-256 of the contract's canonical JSON serialization of that exact object. Missing, extra,
arbitrary, or mismatched fields fail validation even when their hash is internally consistent.
Retain only the accounting envelope; never include prompts, credentials, or unrelated provider
responses. The validator proves the retained declaration was not changed after capture, not that a
provider independently attested it. A mixed-provider unit, an unavailable segment-provider
identity, or an aggregate without this provenance remains typed `unavailable`. Provider-unit
evidence cannot override the exact segment-sum rule when all segment values are observed.

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

The comparison admits manual-to-manual records only. Before capture, retain one immutable,
versioned benchmark manifest containing the workload definition, inputs, execution procedure,
mode, and intended checkpoint pair. Hash its exact bytes into `comparisonContextFingerprint` on
every legacy and later record. A changed manifest fingerprint never matches.

Retain a second immutable, versioned manifest for each checkpoint's intended benchmark endpoint,
including its stable configuration/capability/outage regime and route topology. Hash its exact
bytes into `checkpointEndpointFingerprint`. Every record on one side of a comparison must use the
same endpoint fingerprint; the legacy and later checkpoint fingerprints may differ. Per-invocation
capability/outage fingerprints remain auditable record facts but do not fragment a 20- or 100-run
cohort. Configuration is exact within each checkpoint; its fingerprint may differ across the
legacy and later implementations.

Within the shared comparison context, comparison holds workload and the complete mode fixed. It
also holds the unordered unique runtime identities fixed across checkpoints: role, requested and
actual route, adapter, degradation, provider, model, and engine. Provider, model, and engine must
all be observed on every compared segment; identical `unavailable` reasons never establish
identity and refuse the comparison. Every compared unit must be completed, and each checkpoint
must contain one exact revision, configuration, and endpoint. Revision, configuration, and
endpoint may differ across checkpoints; capability/outage evidence and stage/round topology may
vary and are reported explicitly. This admits a genuine safety migration that changes
orchestration structure without pooling a provider/model, route, failed outcome, or implementation
change inside either side.

The comparison never uses `legacyProfile` as a route. Duplicate record IDs invalidate the complete
input, including when the duplicate contents differ. Unmatched cohorts remain visible instead of
being coerced into a comparison; every present unmatched side still requires one exact revision,
configuration, and endpoint and retains its aggregate metrics, outcomes, and invocation-evidence
distributions. The legacy-to-safe delta is the aggregate cost of the safety migration, not
attribution to an individual repair.

A newly safe non-manual mode is a separate safe-only cohort unless its legacy behavior can be
measured through a non-mutating replay.

## Evidence-derived budgets

The versioned policy at `.autoloop/measurement-budget-policy.json` is the automatic budget gate.
Its honest initial state is:

```json
{
  "budgets": [],
  "evidenceBundle": null,
  "reason": "No authenticated safe-system and post-optimization event-derived cohorts have been retained.",
  "status": "pending-evidence",
  "version": 1
}
```

Check it directly with:

```bash
node tools/agentic/measurement-contract.mjs \
  --check-budget-policy .autoloop/measurement-budget-policy.json
```

`pending-evidence` is a valid configuration state and exits successfully so a new installation
remains usable, but its result always contains `passed: false`. Verification prints it as `NOTE`,
never `PASS`. A missing, malformed, non-canonical, or unsafe policy file fails verification.

Once genuine evidence exists, export the exact selected record/event sets:

```json
{ "recordIds": ["<every-policy-baseline-and-current-record-uuid>"] }
```

```bash
(umask 077
 node tools/agentic/measurement-contract.mjs --export-evidence-bundle \
   < /tmp/autoloop-measurement-record-ids.json \
   > .autoloop/measurement-evidence-v1.json)
```

The tool prints the bundle SHA-256 to stderr. The canonical, bounded bundle contains every
finalized record and its complete authenticated raw event stream, sorted by record ID. Commit it
in the same human-reviewed change as the policy. A human may then replace the policy with canonical
`status: "active"` JSON, `reason: null`, an `evidenceBundle` object binding the exact path
`.autoloop/measurement-evidence-v1.json` and printed SHA-256, and one or more entries containing
`budget`, the exact sorted
`baselineRecordIds`, and the exact sorted `currentRecordIds`. The baseline IDs must equal the
budget's authenticated source IDs. Record IDs cannot be reused between or within policy entries,
and workload/execution-mode routes must be unique and deterministically sorted. An active policy
passes only when every entry is stable and within its limits. Missing evidence, unavailable
runtime identity, cohort mismatch, provisional samples, or a regression fails the automatic gate.

This committed policy-bound bundle is the portable CI path: a fresh clone needs no private
`.git/autoloop/measurements/v1` store. Verification checks safe file shape and exact bytes, requires
the bundle IDs to equal the active policy IDs, validates every historical event and finalized
record, cross-binds the first event to `provenance.derivation.startRevision` and `run-finish` to
the aggregate result `revision`, replays every aggregate, then evaluates the budgets. Revision
transitions are valid only when both endpoints match. The original store HMAC values remain
retained audit evidence, but their private local key is intentionally not exported and cannot be
reverified in another clone. Portable authority comes from the human-reviewed Git artifact and
the policy's exact SHA-256 binding. Changing any byte therefore requires a matching reviewed policy
change; it never manufactures independent provider or command attestation.

Budgets are exact mode/workload contracts. A mode fixes active host, selector, selected engine and
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
replay-verified, event-derived records from the local store. Caller-supplied aggregate JSON and
locally authenticated aggregate declarations cannot seed or enforce a budget. The evaluator
requires the baseline input to equal the named source set exactly, rejects extra decoy records,
and derives the cohort from named records independently of caller ordering.
Source records share one exact revision. Current `post-optimization` records may use a different
revision and checkpoint endpoint, but each side must contain exactly one revision and endpoint,
and both sides must retain the same configuration and strict runtime identity. Every source and
current unit must be completed, with provider/model/engine observed on every segment. Exact
capability/outage fingerprints may vary within the stable endpoint; source and evaluation output
their value/count distributions. The evaluator replays every named source content fingerprint and
authentication tag and refuses changed, duplicated, missing, unauthenticated, replayed,
cohort-mismatched, or mixed-revision evidence. It also refuses a median below its declared
reporting floor or a p95 below at least 20 observations. A valid result remains `provisional` until
both source and current metrics meet the declared stable floor, which is at least 100
observations. Only stable evidence returns `passed` or `failed`; a provisional overage is reported
as `withinLimit: false` without being called a regression.

All accepted numeric evidence is bounded below `Number.MAX_SAFE_INTEGER / 10000`; aggregate
arithmetic therefore cannot turn an accepted finite sample into `Infinity` or JSON `null`.

Capture the manual safe-system baseline on the same repeatable workloads as any genuine,
separately retained legacy comparison evidence. Legacy comparison remains descriptive until an
authenticated import exists. Establish mode-specific budgets only from replay-verified safe
baseline events and retain every raw event for accepted optimizations.

This repository currently retains no real legacy, safe-system, or post-optimization sample
cohorts, so the committed policy remains `pending-evidence` and no numeric budget is claimed.
There is also no independently attested provider, GitHub, subprocess, or remote-mutation observer:
the event HMAC proves local write-once retention of a declared evidence fingerprint or typed
unavailable reason, not external truth. Do not activate policy entries until real retained cohorts,
operator-reviewed limits, and the applicable external evidence envelopes exist.
