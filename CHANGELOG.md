# Changelog

Notable changes to Autoloop are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow semantic versioning.

## [Unreleased]

## [0.40.0] - 2026-07-25

### Added

- A deterministic runtime contract with a closed five-route catalog, capability-aware dispatch,
  typed route adapters, bounded fallback, and append-only, session-bound relaunch recovery.
- A repository project contract for configuration schema `0.25.0`, including explicit migration
  from schema `0.24.0`.
- Complete repository snapshots with bounded pagination, typed section completeness,
  mutation-driven invalidation, absence-safe stop decisions, and exact per-reference Issue-state
  evidence for dependency closure.
- Durable lifecycle reconciliation, exact-head delivery/review transitions, canonical loop-claim
  parsing, and configured-base lane proofs.
- Atomic write-once, content-fingerprinted, store-authenticated raw workflow event streams with a
  Runtime-bound pre-selection start and plan-bound unit/lane context; required benchmark-manifest
  `comparisonContextFingerprint` and stable
  `checkpointEndpointFingerprint` values; migration comparison with observed, stage-independent
  runtime identity; structured run/unit/metric/provider/value-bound `provider-unit-total`
  provenance; and an exact-replay mode/workload budget contract. Raw invocation fingerprints remain evidence
  with exact value/count distributions instead of fragmenting stable endpoint cohorts.
  Comparisons and budgets reject mixed revisions/configurations, non-completed work, unavailable
  runtime identity, and unsafe numeric magnitudes. Terminal/gate/lifecycle/provider producers and
  real legacy/safe/current cohorts remain pending, so the shipped policy is explicitly
  `pending-evidence`; historical baselines are never synthesized.
- Attributable exact-head CheckRuns, an executor-owned typed gate attestation, and a dormant,
  fail-closed strict-direct authorization reference contract for a future authenticated
  non-manual integration.
- A canonical `VERSION` file and portable release verification for manifests, skill banners,
  changelog metadata, static contract drift, and operational helper assumptions.
- Live release verification for annotated tag ancestry, no-bypass `v*` tag controls, and enabled
  immutable releases, with optional organization-owner enforcement.
- A typed `untested` live-smoke declaration. Contract and release verification both report it as a
  note and neither infers a passed route from it. v0.40.0 ships that declaration: the ten OpenCode
  live checks were not rerun against the v0.40.0 invocation contract, so native opencode and
  Claude-to-opencode are statically verified only and their live behaviour is unproven.
- Practical contribution, security-reporting, and licensing guidance.

### Changed

- Bare Dev, Pitcrew, and doctor invocations now select the active host's safe native route.
  Claude-to-Codex and Claude-to-opencode execution use an explicit current-invocation selector.
  Supported same-UID hooks preserve that selector as
  `intentProvenance: "best-effort-unverified"` and never claim authenticated human attribution.
- Setup scaffolds the safe Claude, Codex, and opencode artifacts for every configured repository;
  artifact presence no longer represents deployment or routing intent.
- Standing project configuration no longer stores `runtime.supportedHosts` or `engine.profile`.
  Tracker configuration is now a discriminated object.
- New scaffolds default to a 700-line slice cap, five code-review convergence rounds, and a
  700-line reversible Path-B limit.
- The fixed four-hour queue-run ceiling and `caps.runWallClockHours` setting are removed; queue
  runs stop on queue exhaustion, explicit invocation bounds, context handoff, or guardrail failure.
- All five routes use fresh Runtime-broker-launched Linux processes: structured Claude print mode,
  `codex exec`, or `opencode run --pure`. Native names the host/engine relationship, not an
  in-session child topology.
- Every typed writer receives writable checkout files with read-only Git metadata; the networkless
  broker makes exactly one clean direct-child commit only after accepting one complete typed
  result. Rewinds, amended history, multiple commits, and dirty completions fail.
- OpenCode writers additionally use a closed checkout-file tool allowlist. The trusted engine
  retains provider transport for inference without exposing it as a model tool.
- Authority-isolated routes require a verified Linux bubblewrap boundary with private home/IPC,
  closed selective mounts, role-scoped checkout access, and no remote Git/GitHub credentials; they
  report a typed capability failure on macOS.
- v0.40 live route execution is Linux-only. Non-Linux probes fail before issuing attempt
  challenges; macOS CI covers portable static contracts without advertising a live route.
- Measurement `run-start` is retained immediately after Runtime opens, before startup operations;
  the first exact plan later binds capability, initial route-state, unit, and lane facts.
- v0.40 Runtime accepts only manual merge. Protected-path guidance now covers both `.opencode/**`
  and `.githooks/**`.
- Schema migration resets legacy `ratified` and `auto` merge policy to manual. v0.40 rejects every
  non-manual run at open before capability probing, scratch creation, or mutation.
- Merge queue remains fail-closed in v0.40 until temporary-head verdict production and durable
  terminal recovery are implemented.

### Security

- Routing input is confined to the current invocation, preventing repository state, historical
  records, and installed artifacts from selecting an execution engine. The captured selector
  grants no lifecycle, human, merge, tag, or release authority.
- Runtime signing keys stay inside a host-bound broker. Finish revokes every run-owned capability,
  continuation validation and CAS remain broker-mediated, and acknowledged terminal delivery,
  stale-lock recovery, and host-death cleanup remove broker authority state.
- Shared claim, lifecycle, lane, verdict, and merge-authorization contracts tighten evidence and
  recovery boundaries.
- Append-only lifecycle comment chains resolve only from positive never-edited evidence. Scan,
  policy publication, the dormant merge reference contract, and the lifecycle driver derive that
  evidence from GitHub, and absent edit evidence is typed incomplete rather than assumed unedited.
  An edited root is accepted only when a successor hash-anchors its exact body.
- The command guard fails closed on malformed hook/config input, active shell expansion, inline
  interpreter source, unknown Git/GitHub aliases, protected refspecs, repository-rule mutation,
  `loop-ready` creation/application/rename, direct merge, release-tag pushes, and release
  publication.
- Exact-head delivery derives the complete required-check set from canonical tracked policy,
  rejects checkout/Git-object drift and path indirection, and protects that policy from loop merge.
- A trusted gate CheckRun can be emitted only after its publisher executes the configured command
  on the exact unchanged clean checkout.
- The dormant non-manual direct-merge reference contract re-fetches issue provenance, human label
  events, dependencies, frozen plans, executor identity, branch protection, applicable rulesets,
  and bypass actors before any SHA-bound merge authorization.

[Unreleased]: https://github.com/fabioneves/autoloop/compare/v0.40.0...HEAD
[0.40.0]: https://github.com/fabioneves/autoloop/compare/v0.39.9...v0.40.0
