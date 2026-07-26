# Changelog

Notable changes to Autoloop are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow semantic versioning.

## [0.42.2] - 2026-07-26

### Fixed

- **The claim commit carries its own identity.** `sanitizedEnvironment` sets
  `GIT_CONFIG_GLOBAL=/dev/null` and strips every `GIT_*` variable, so neither `~/.gitconfig` nor
  `GIT_AUTHOR_*` could reach the claim commit and a checkout without repo-local `user.*` — which is
  what a real checkout looks like — had no identity to commit under at all. A live run died with
  "Author identity unknown" at the claim step. The driver now supplies the GitHub login it already
  authenticated as, which also binds the commit to the identity the merge gate checks later. The
  path was unreachable before 0.42.1: the driver refused every non-manual policy earlier, so
  fixing that is what exposed this.
- **Dispatch no longer forces the engine's env scrub.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` was
  set on every child to satisfy the broker capability `claude.subprocess.credentials-scrubbed`,
  and the broker also swept the stub files scrub mode creates. v0.42.0 deleted the broker, the
  predicate, and the sweeper; only the costs remained. Measured: the child ignored
  `--permission-mode` so the declared postures were never applied, the checkout gained seventeen
  zero-byte stubs nobody removed, and every Bash call died at sandbox start on `/home/.mcp.json`,
  which blocked a live run at the implement step. Roles again run under the posture they declare.
- **An implement dispatch proves it moved the checkout.** `ok` from a review role means a
  schema-valid verdict; from the writer it meant only that the engine answered, so an implement
  whose sandbox never started returned `ok: true` carrying its own error as the text payload.
  Writer dispatches now fingerprint HEAD and porcelain status around the spawn and fail typed with
  `WRITER_MADE_NO_CHANGE`, preserving the engine's text as the diagnostic. A cwd that is not a Git
  work tree, or carries no commit yet, asserts nothing.

## [0.42.1] - 2026-07-26

### Changed

- Setup's WRITE phase reconciles STATE and LOOP through that merge and its report instead of
  reading the templates and splicing prose by hand.
- Setup names the copy of every contract it runs. During a migration the configuration is migrated
  and validated with `<templates>/tools/config-contract.mjs`, never the repository's vendored copy,
  which is still the pre-migration validator until the reconcile lands and rejects the migrated
  block on its version literal.

### Removed

- Tag-time live-control verification. The release gate no longer reads GitHub rulesets or the
  immutable-release setting: `release-verify.mjs` drops the `--check-tag-policy`,
  `--check-base-policy`, and `--check-immutable-releases` modes, the
  `--allow-unverified-live-controls` escape, and the `AUTOLOOP_RELEASE_POLICY_TOKEN`
  credential. Branch, tag, and release protection stay configured on GitHub as the
  maintainer's responsibility; `--release-mode` still verifies the static release contract
  and proves the annotated-tag binding from local git objects.

### Fixed

- **The lifecycle driver accepts every merge policy its contract validates.** A live run planned
  and independently reviewed an issue, then hard-stopped at the claim step because the driver
  required `intent.mergePolicy === 'manual'` on top of the contract's own validation. The
  lifecycle contract accepts `manual`, `ratified`, and `auto` and branches where it matters; the
  extra clause was a leftover from when non-manual was dormant reference code, and it refused
  the claim for every acknowledged non-manual repository — exactly the configuration solo mode
  exists to serve.
- **The command guard resolves literal expansions instead of refusing them.** Every live session
  wrote something like `S=/tmp/x; sha256sum $S/plan.md` and was refused as opaque, then retried
  with a literal path. When a variable is assigned a literal in the same command, the guard now
  substitutes it and judges the real command — strictly stronger than refusal, because
  `verb=merge; gh pr $verb 42` now blocks on the merge rule itself. Command substitution,
  environment variables, and values carrying whitespace or metacharacters stay opaque and stay
  blocked.

### Added

- **`scaffold.mjs --merge-state` / `--merge-loop`** — mechanical STATE and LOOP reconciliation.
  A v0.42.0 migration spent 203 seconds reading templates in fragments and 148 seconds splicing
  prose by hand, over half the run. Ownership is derived from the template's own
  `{{PLACEHOLDER}}` markers rather than declared: a marker's shape determines whether the
  repository owns a fence body, list additions, a whole section, or a scalar. Only Lessons is
  declared, keyed by heading, so a rename fails closed rather than replacing durable memory.
  Structural ambiguity produces a typed report and a non-zero exit, never a lossy merge.
  Verified against a real installed STATE: the three differences from the hand-merged result
  were exactly the decisions it flagged, and LOOP came out byte-identical with no decisions.

## [0.42.0] - 2026-07-26

### Removed

- The authority broker and everything built on it. `run-scope.mjs`, `runtime-contract.mjs`,
  `route-adapter-contract.mjs`, `measurement-contract.mjs`, `intent-contract.mjs`, and
  `continuation-store.mjs` are deleted, together with the closed route catalog, host attestation,
  capability probing and its bwrap smokes, dispatch plans/receipts, relaunch v2 envelopes, and the
  measurement ledger (`docs/measurement.md`,
  `.autoloop/measurement-budget-policy.json`). That machinery existed for unattended merging by
  unattributable actors across hosts; it made the loop unusable for the supervised solo operator it
  actually has. A live run spent 5.5 minutes reverse-engineering the broker envelope protocol and
  still failed closed without reaching implementation.
- The `UserPromptSubmit` / `opencode.user-prompt` intent-capture hooks and the opencode plugin's
  continuation/relaunch subsystem.
- Config keys `runtime`, `engine`, `adapterOptions`, and `measurement`.

### Added

- `dispatch.mjs`: one call runs one role dispatch and returns a typed result.
  `--role <plan-review|implement|code-review|doubt-review> --prompt-file <path> [--tools <csv>]
  [--output-file <path>] [--json]`. It spawns `claude -p` directly — a fresh process per dispatch,
  so writer and reviewer identities never collide. Reviewers get a read-only posture
  (`Glob,Grep,Read`, permission mode `plan`) that can never be handed a write tool; the writer gets
  `Bash,Edit,Glob,Grep,Read,Write` with `acceptEdits`. Review roles return the structured verdict
  schema, parsed and validated, or fail typed. Every failure is `{ok:false, step, error}` with the
  child's stderr preserved — no retries, no fallback engine — and every result reports the
  wrapper's own overhead separately from engine time.
- `checkout-contract.mjs`: the stable checkout and GitHub repository identity probe, extracted from
  the deleted route adapter, where `publish-verdict.mjs` and `lifecycle-driver.mjs` still need it.

### Changed

- `prime.mjs` is one child process: validate ProjectConfig in-process, report the checkout against
  the configured base, run one `scan.mjs`, persist the snapshot, print a decision-sized summary.
  It replaces five broker calls the model had to hand-assemble.
- `review-contract.mjs` keeps every decision — one plan review, delta-scoped rounds after round 1,
  the human-block path for verified out-of-delta Critical/Major, the cap — and takes recorded
  dispatch rounds instead of broker-signed receipts. Freshness is now structural: a unique
  `dispatchId` per round and a `reviewerIdentity` that is never the author's.
- `command-guard.mjs` scopes itself to open runs through a durable run marker `prime.mjs` writes
  and binds to the observed process ancestry, replacing the broker lease. Every guard decision is
  unchanged.
- `loop-smoke.mjs` proves the new path end to end against a shimmed engine — prime, three role
  dispatches, the gate command, the guardrail close — asserts no reviewer dispatch received a write
  tool, and prints a phase timing table. `--real-engine-smoke` now runs ONE real dispatch.
- Config schema `0.26.0`, with a `0.25.0` migration that drops the retired keys and carries every
  remaining value across unchanged, including `merge.policy` and both acknowledgements.

## [0.41.4] - 2026-07-26

### Fixed

- **The isolated posture can dispatch an engine at all.** Every route capability smoke returned
  `route-smoke-failed`, so no live run ever got past the probe. Two upstream engine behaviors,
  both found by reading the engine's own stderr out of the sandbox: Claude Code's env-scrub
  hardening silently forces `--permission-mode` back to `default` (so the writer's Write was
  denied and no proof marker appeared), and its inner sandbox needs to create mount points
  inside `.git`, which read-only Git metadata refused, failing every Bash call. Permissions are
  now derived from each posture's own tool ceiling — the reviewer grants nothing, a net
  narrowing — and read-only Git metadata is a tmpfs with real entries re-bound read-only
  underneath, with the write denials re-verified intact.
- **The engine's sandbox litter no longer reaches a commit.** Scrub mode creates ~17 zero-byte
  stubs (`.env*`, `package.json`, `yarn.lock`, …) for sensitive paths that do not exist; it
  normally hides them by appending to `.git/info/exclude`, which fails precisely because
  Autoloop mounts Git metadata read-only. Untracked litter would have stopped the next run
  through the dirty-tree rule and — since the broker commit stages `git add --all` — landed in
  the pull request. The broker now removes only what appeared during a dispatch: untracked,
  regular, zero-byte, non-symlink, and reported in the typed result. Every guard is
  mutation-proven in the self-tests.
- No error-shaped output on the happy path: typed `snapshot-contract --summary/--section`
  accessors so nothing is hand-parsed, guard refusals reworded as policy with the sanctioned
  alternative named, the capability smoke bounded at 120s per dispatch (it was 20 minutes), and
  bundle files named from the broker run identifier when measurement capture is off.

### Removed

- Tag-time live-control verification and `AUTOLOOP_RELEASE_POLICY_TOKEN`. Repository protection
  is configured on GitHub and remains the maintainer's responsibility; the release gate verifies
  the release contract — version literals, annotated-tag binding, changelog, banners, smoke
  evidence, workflow shape. −937 lines.

### Added

- `loop-smoke.mjs --real-engine-smoke`: the opt-in pre-release gate for `posture: isolated`.
  It runs the full chain with no engine shims and asserts real capabilities (11/11 on a
  bwrap-capable, authenticated host, ~40s). It costs real tokens, so it stays manual — the
  shimmed `loop-smoke` remains in every CI battery.

## [0.41.3] - 2026-07-26

### Fixed

- **The route probe works from the detached broker** — the last gate between prime and unit
  work. `issueCapabilitySnapshot` executes inside the authority broker, which re-parents to
  init, so the live-host ancestry walk found nothing and every live probe failed with
  `INVALID_CAPABILITY_ATTESTATION`; self-tests skip that branch by design and no earlier live
  run had reached the probe. The broker retains its host binding once at startup (a real walk,
  while its spawner's ancestry still proves the session; fail-closed, no fallbacks) and
  broker-side callers compare against it. Proven red first.
- Measured operations and the conclude call bind to an explicit run id from the prime summary:
  interrupted sessions leave run-start-without-run-finish ledgers, so bare exactly-one
  derivation was permanently ambiguous on any repository with history.

### Changed

- **Measurement capture is opt-in** (`measurement.capture`: default `off`, `events` restores
  full capture per repository). The pipeline enforces nothing until its producers land, while
  live runs paid 3–6 minutes of ceremony per run: with capture off, prime is attest → open →
  one plain scan, no ledger opens, commands run unmeasured, and a blocked close is only the
  finish decision.

### Added

- **`loop-smoke.mjs` — the no-model end-to-end release gate**: fixture repository → synthetic
  hook capture → real detached broker → full events-mode prime → route probe → guardrail
  close, asserting typed results, byte-complete artifacts, broker teardown, and a 60-second
  budget (measured 716ms). It runs in every verify battery, reproduces this release's probe
  bug red against the prior tree, and would have caught every live failure of the past day.

## [0.41.2] - 2026-07-26

### Fixed

- Prime returns `hostEvidence`: its internal attest consumes the one-use intent record, so the
  evidence it held was the run's only copy — the first live run blocked at the route probe
  without it. The summary and persisted bundle now carry it; the skill forbids re-attesting.
- Prime persists its full bundle and raw snapshot under `.git/autoloop/prime/` and prints a
  decision-sized summary with per-section counts: the inlined ~300KB snapshot exceeded what a
  model-facing tool result can carry, silently recreating the manual-scan ceremony.

### Changed — startup cost, round two

- `measurement-contract.mjs --measured <operationId> [--action <text>] -- <command>...` runs a
  measured operation in one invocation: the open run, active stage, and operation kind are
  derived from the store (fail-closed on ambiguity), and the assembled input reaches
  `runMeasuredOperation` unchanged — no per-command envelope files, no validation relaxations.
- `prime.mjs --conclude-json` closes a guardrail-blocked run in one call: human wait pair,
  typed-unavailable stage-end, blocked run-finish, and the finish decision, in the exact order
  live sessions performed by hand across two to three minutes.
- Scaffold audit/reconcile report entries carry a `source` field naming each artifact's exact
  template path (renames included), ending spurious hand-diff guesses.

## [0.41.1] - 2026-07-26

### Fixed

- **The loop can start again.** `scan.mjs` printed its ~313KB snapshot and exited via
  `process.exit(await main())`, which discards async-buffered stdout — and stdout is async
  whenever it is a pipe, which the required measured-operation wrapper always is. Every v0.41.0
  Dev run therefore blocked at prime step 10 on a snapshot truncated to one pipe buffer.
  `scan.mjs`, `snapshot-contract.mjs`, and `measurement-contract.mjs` now write primary output
  synchronously (EAGAIN-retrying `writeSync`); an end-to-end self-test pipes 400KB through a
  real child that exits immediately.
- The macOS CI contract job ran 2–3.5 minutes against Ubuntu's ~1: `detectActiveHost()` walks
  the ancestor process chain (`ps` spawns on macOS at ~44ms a call) and was evaluated before
  the self-test-mode short-circuit, charging all 2,304 matrix fixtures — 101 of the suite's
  106 seconds. The mode check now evaluates first; macOS runs at parity (1m04s).
- The permanent slow-suite diagnostics that found it: verify prints per-check durations and
  surfaces each self-test's family histogram and matrix-phase attribution, so the next platform
  stall names its own culprit in the CI log.

### Changed — startup cost

- **One-call prime.** `prime.mjs --dev-json {sessionId}` composes attest → open → mechanical
  measurement-declaration derivation → bind → selection stage-start → the measured startup scan
  into one deterministic invocation returning one typed bundle. It holds no broker authority —
  it issues the same public CLI commands the model previously assembled by hand across ~30
  round trips and ~4–5 minutes; non-scan prime is now ~2 seconds and a live prime is
  scan-dominated. The manual per-op path remains documented for continuations and diagnosis.
- **Release-proven verify.** Install-root verification skips re-spawning a tool's self-test
  when its bytes match the committed release manifest (template sha256 + node major, freshness-
  checked in plugin CI, vendored by scaffold): measured 23.3s → 0.7s. Any byte difference,
  missing entry, node-major mismatch, or unreadable manifest fails open to the real spawn;
  `--full` restores the entire battery; plugin templates always self-test fully.
- Setup's audit uses `scaffold.mjs --audit` — the identical typed reconciliation report with
  zero writes — replacing per-artifact manual diffing, and captures verify output once.

### Added

- One visual language across the cycle: run frame, per-step progress ribbons (eleven cells in
  Dev, eight in Pitcrew, five setup phases), rounded unit banners, and closing rails for
  shipped/blocked/complete. The tool surface is now two-tier: ~8 entry points a session
  invokes; every other vendored file is a library those entry points own.
- `adapter-contract --template-root` accepts the plugin root or the templates directory itself;
  `run-scope` usage names the `<path|->` argument on every operation flag.

## [0.41.0] - 2026-07-26

### Added

- Solo-operator merge mode for single-identity repositories, where the loop necessarily runs
  under the only maintainer's login. `merge.soloOperatorAcknowledged: true` — valid only alongside
  a non-manual policy AND `merge.unverifiedInvocationAcknowledged: true` — waives the four gate
  controls one login cannot satisfy: identity separation, App attestation, live server-policy
  verification, and the approving-review requirement (GitHub forbids self-approval). Everything
  else keeps full strength: exact-head CAS merge with SHA-bound confirmation, required CI green on
  the exact head from `.autoloop/ci-policy.json`, claim/ownership/frozen-plan binding, hard-block
  labels, protected path families, the kill switch, executor-identity matching, and Path-A label
  event verification with head binding. A solo config whose trusted list is not exactly the loop
  login is invalid, and migration never emits the flag. Non-solo behavior is byte-identical.
- Setup fills the vendored merge executor's REPO CONFIG block in the same visible diff that
  vendors it (repository, loop login, required checks from the committed CI policy, and the
  solo-operator transcription), then runs the vendored file's config-derived `--self-test` as
  evidence — a placeholder block refuses every invocation, so an unfilled vendor was an
  incomplete setup.
- `scaffold.mjs` preserves a Setup-filled `auto-merge.mjs` as `kept-modified` instead of
  clobbering it back to placeholders on reconciliation, matching the existing
  `escalate-paths.mjs` policy-preservation rule.

### Fixed

- The merge reference header no longer claims "Setup never installs or invokes this file" —
  false since the 0.40.1 acknowledgement contract — and now states the enablement conditional; a
  self-test case guards the header because contract lint deliberately skips `auto-merge.*`.
- `UNCONDITIONAL_NON_MANUAL_REFUSAL` lint now crosses single line wraps and recognizes
  unconditional `UNVERIFIABLE_INVOCATION_PROVENANCE` rejection claims that name the policy in a
  different table cell; the six stale prose sites it then surfaced in README and the STATE
  template (including two the drift audit had not listed) now state the acknowledgement
  conditional.
- `scaffold.mjs` self-test reported a hardcoded case count; it now counts.

## [0.40.5] - 2026-07-26

### Added

- `scaffold.mjs` performs the complete mechanical scaffold reconciliation in one call: it vendors
  the policy-derived tool set, refreshes host artifacts, merges hooks and `.opencode/opencode.json`
  without clobbering repository-owned entries, folds a legacy root `opencode.json` into
  `.opencode/`, and returns a typed report. Setup drops from dozens of model round trips to a
  handful. A policy-bearing tool whose repository copy differs (`escalate-paths.mjs` carrying extra
  escalate globs) is reported `kept-modified`, never overwritten.
- A contract-lint rule, `UNCONDITIONAL_NON_MANUAL_REFUSAL`: forward operational artifacts may no
  longer claim a non-manual merge policy fails outright without stating the acknowledgement
  conditional.

### Fixed

- Installed STATE prose no longer carries the plugin version. The vendored template embedded it, so
  every patch release dirtied every configured repository's STATE by one literal and forced a
  prose reconciliation per repository per release — the direct cause of a thirteen-minute setup run
  whose entire payload was a version string. STATE references the configuration schema only.
- Setup's evidence surface is now explicitly bounded: static validation and
  `verify.mjs --install-root`, never the repository gate, test suite, or CI. A live session had
  begun repairing a pre-existing failure on the configured base to "prove" a prose edit; a failing
  base is a NOTE for the human, and Setup never modifies repository source.
- Seven skill-prose sites still asserted that v0.40 forbids a non-manual merge policy, contradicting
  the 0.40.1 contract; a Setup session resolving the contradiction refused to offer the policy the
  interview was told to offer. All prose now states the conditional.
- Dev had no non-manual invocation path at all: its terminal step said "never invoke
  auto-merge.mjs" unconditionally. Under an acknowledged non-manual policy the run now invokes the
  vendored executor once for the delivered PR and treats its typed verdict as final; the executor
  independently refetches every ownership, eligibility, evidence, and server-protection predicate
  and refuses with a typed reason when any is missing, and a refusal routes to the human-block path.

## [0.40.4] - 2026-07-26

### Changed

- Setup shows the merge policy in every interview and offers to change it. The 0.40.3 question
  fired only for a repository on or migrating from a non-manual policy, so a repository whose
  earlier migration had already reset `auto` to `manual` was never asked — the trigger state had
  been erased by the very reset the question existed to surface.
- Migration and reconfigure collapse the interview to one summary table and a single accept-all
  confirmation, expanding into individual questions only where an item carries a real decision.
  Fewer questions, never fewer disclosures: everything still appears in the summary and the
  visible diff.

## [0.40.3] - 2026-07-25

### Fixed

- Vendored contract self-tests resolved reviewer templates relative to their own file, which only
  lands in the plugin tree. Once vendored to `tools/agentic/`, `verify.mjs --install-root` failed
  with `ENOENT` unless the templates were also copied loose into `tools/`. The check now applies to
  a shipped template where one exists and is skipped as not applicable where none does, so an
  installed repository needs no stray files.
- The command guard blocked every command in a repository whose configuration still awaited
  migration, including the commands Setup needed to perform it. A migratable schema now reports the
  remedy and yields.
- The command guard applied to every Bash call in a project, so ordinary development fought a policy
  aimed at loop-issued commands. It now enforces only while a run is open, evidenced by a live
  broker lease bound to the caller's own ancestry. Anything unreadable or ambiguous means no run.

### Changed

- `opencode.json` moves to `.opencode/opencode.json`, alongside the other opencode artifacts.
  opencode reads project configuration from either location, verified against 1.18.4, so the
  scaffold no longer adds a loose file to the project root. Setup merges a legacy root copy into
  `.opencode/` and removes it.
- Setup asks about the merge policy instead of silently resetting it. A repository on or migrating
  from `ratified` or `auto` is offered the restore, told in one sentence what an unauthenticated
  trigger means, and has both `merge.policy` and `merge.unverifiedInvocationAcknowledged` written
  together.
- Setup shows every numeric cap with its current value beside the scaffold default and offers to
  change any, calling out `sliceMaxLines` and `codeReviewRoundsPerUnit`. A migrated repository keeps
  its own values, so showing them is what makes a preserved value distinguishable from a silent one.

## [0.40.2] - 2026-07-25

### Added

- `migrateProjectConfig()` migrates a repository configuration from its own version to the current
  schema through an ordered chain, so callers never name a version pair. `MIGRATABLE_CONFIG_VERSIONS`
  declares what it accepts and anything else is a typed `UNSUPPORTED_CONFIG_VERSION`.
- A `0.23.0` migration step. That version predates `gate.quickCommand`,
  `caps.codeReviewRoundsPerUnit`, and the `engine.opencode` block; all three are added
  deterministically, then the existing `0.24.0` step completes the migration.

### Fixed

- A repository on schema `0.23.0` could not upgrade at all. Migration existed only as a single
  hardcoded `0.24.0` to `0.25.0` hop, named for that pair in the function and in Setup's prose, so
  any other version had nowhere to go and Runtime refused the repository outright.

## [0.40.1] - 2026-07-25

### Added

- An explicit `merge.unverifiedInvocationAcknowledged` opt-in. `ratified` and `auto` are no longer
  refused outright: a repository that sets it to `true` records that it accepts a trigger no
  supported transport can authenticate, and Runtime then opens the run. Without it, run open still
  fails closed with `UNVERIFIABLE_INVOCATION_PROVENANCE`. Findings 10 and 11 remain open, so a
  non-manual policy relies on configured base protection for its safety.

### Fixed

- Contract verification no longer depends on the checkout umask. The budget-policy reader accepted
  only modes 600/640/644, so the same commit passed under umask 022 and failed under 002 — Git does
  not track the group-write bit. It now rejects what actually matters: a world-writable policy file.
- The 0.24.0 migration no longer describes a reset merge policy as "legacy", which read as though
  `ratified` and `auto` had been retired. They are current values, and the warning now names the
  acknowledgement that restores them.

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

[Unreleased]: https://github.com/fabioneves/autoloop/compare/v0.42.1...HEAD
[0.42.1]: https://github.com/fabioneves/autoloop/compare/v0.42.0...v0.42.1
[0.42.0]: https://github.com/fabioneves/autoloop/compare/v0.41.4...v0.42.0
[0.41.4]: https://github.com/fabioneves/autoloop/compare/v0.41.3...v0.41.4
[0.41.3]: https://github.com/fabioneves/autoloop/compare/v0.41.2...v0.41.3
[0.41.2]: https://github.com/fabioneves/autoloop/compare/v0.41.1...v0.41.2
[0.41.1]: https://github.com/fabioneves/autoloop/compare/v0.41.0...v0.41.1
[0.41.0]: https://github.com/fabioneves/autoloop/compare/v0.40.5...v0.41.0
[0.40.5]: https://github.com/fabioneves/autoloop/compare/v0.40.4...v0.40.5
[0.40.4]: https://github.com/fabioneves/autoloop/compare/v0.40.3...v0.40.4
[0.40.3]: https://github.com/fabioneves/autoloop/compare/v0.40.2...v0.40.3
[0.40.2]: https://github.com/fabioneves/autoloop/compare/v0.40.1...v0.40.2
[0.40.1]: https://github.com/fabioneves/autoloop/compare/v0.40.0...v0.40.1
[0.40.0]: https://github.com/fabioneves/autoloop/compare/v0.39.9...v0.40.0
