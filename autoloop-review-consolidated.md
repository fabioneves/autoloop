# Autoloop — consolidated review and remediation plan

- **This document:** v10, 2026-07-24
- **Reviewed tree:** v0.39.9 at `9dbc5b6`
- **Toolchain checked:** Codex CLI 0.145.0
- **Review date:** 2026-07-23; efficiency, architecture, and v9/v10 corrections 2026-07-24
- **Findings source:** consolidated review v6, SHA-256
  `fa0315634dcd13026e12d54d4c4c1c88d49149d9f99fe5d50f8d7204457a7744`
- **Follow-up verification:** `review.md` v1, 2026-07-24, SHA-256
  `96f153b7e9b7a9edcea8be6c17e73535d82a681d20c03276faea3a065eba2ec8`
- **Architecture amendment input:** verified consolidated review v7, SHA-256
  `715b6716a7e518c4022037e24d9ef34560b1d906ffd3848a67390e7e5126cdd5`
- **v9 correction input:** verified consolidated review v8, SHA-256
  `005e1d4996eb1a69151f5610beecbe90fc7b496215917b7c93680e47a730ff3f`
- **v10 terminology input:** verified consolidated review v9, SHA-256
  `4c4c1852774c2c6b086e696afdfe2eefdaef6c6be8a142a072a3427d00e80549`
- **Target release:** Autoloop v0.40.0; repository configuration schema v0.25.0
- **Amendment provenance:** the efficiency workstream was added after the six-round consolidation;
  the follow-up verification corrected both findings and efficiency claims. The native-first,
  invocation-scoped architecture was accepted in the maintainer discussion on 2026-07-24. The v9
  correction records the superseded native-Codex lane decision and closes ordering and selector
  ambiguities found by the independent v8 verification. The v10 correction removes one ambiguous
  use of “route matrix” identified by the independent v9 verification.

Findings 1–12 and the core safety plan originated in the six review rounds and are presented here as
amended by the 2026-07-24 follow-up verification. The later efficiency workstream carries its
separate provenance above. The document intentionally keeps one canonical description for each
finding instead of repeating findings in a summary, detail section, and plan. That reduces the
contract drift identified by the review itself.

The findings remain verified observations about v0.39.9. The architecture section is a prospective
decision for v0.40.0, not a claim that the six-round review proved persisted host/profile
configuration inherently wrong. The review proved inconsistency; the v0.40.0 decision chooses
invocation-scoped routing as the remedy.

## Decision

Autoloop has a strong supervised-workflow design: exact-head evidence, fresh reviewer threads,
bounded convergence, explicit trust rules, and useful recovery after a draft PR exists. It is not
ready for unattended merging.

Use `merge.policy: manual` today, with:

- a protected configured base branch;
- no bypass of required controls by the shared loop/maintainer account;
- independent inspection of the current head, CI, review state, paths, and provenance before merge;
- manual recovery when a partial claim or terminal writeback is stranded.

Manual mode prevents findings 9–12 from automatically landing code. It does not remove findings
1–8. In particular, finding 4 can bypass the human-merge boundary when effective no-bypass base
protection is absent.

There are two deployment bars:

1. **Auto-merge enablement:** resolve findings 1–3, 5, 8–12 and install the persistent server-side
   controls described below. Finding 4 may be temporarily compensated by verified no-bypass branch
   rules, but remains product debt.
2. **Dependable unattended queue operation:** satisfy the auto-merge bar and resolve command
   enforcement (4), scan completeness (6), and lifecycle recovery (7). This plan defines no
   substitute compensation for those three unattended-operation requirements.

The architecture and all review remediation belong to one v0.40.0 program. That does not collapse
the deployment bars: the work lands in ordered, independently verifiable slices, and a repository
does not enable non-manual merge merely because it has migrated to the new runtime contract.

## Architecture decision for v0.40.0

- **Status:** accepted for implementation
- **Decision date:** 2026-07-24
- **Release contract:** Autoloop v0.40.0 with repository configuration schema v0.25.0

### Context and constraints

Autoloop must run natively from Claude Code, Codex, and opencode without a repository reconfiguration
when the operator changes host. A bare invocation uses the active host. Cross-engine work is an
explicit property of the current invocation:

```text
/autoloop:dev
/autoloop:dev with codex
/autoloop:dev with opencode
```

The first form means native. The latter forms request an engine for that run only. The same grammar
applies to a direct Pitcrew invocation and to doctor. Issue text, STATE, installed artifacts, prior
runs, hook files, global defaults, and environment compatibility flags carry zero engine-selection
authority.

The design must also respect Autoloop's execution model. Deterministic `.mjs` tools can parse,
validate, and produce plans, but they cannot directly invoke every host's native agent surface.
Model-interpreted skills therefore remain the host execution adapters. The executable policy
selects the tested route and posture, its route adapter compiles the attempt, and a thin active-host
adapter performs it and returns evidence.

### Terms

- **Active host:** the current Claude, Codex, or opencode session, attested from its live integration
  and effective tool surface.
- **Engine selector:** the canonical raw invocation intent: `native` for a bare invocation, or an
  explicit `claude`, `codex`, or `opencode` suffix in the current invocation. Run context and
  relaunch preserve this value for provenance even when route selection normalizes it.
- **Requested engine:** the active host when the selector is `native`; otherwise the explicitly
  selected engine.
- **Route:** the tested execution path selected for one stage. A native route means that the active
  host and effective engine are the same; it does not require an in-session process.
- **Capability:** preflight evidence that a route and its isolation contract can run.
- **Outage:** run-local evidence that a route which passed preflight is temporarily failing.

### Deep runtime module and execution seam

Deepen the existing run-scope contract into one deterministic `RuntimeContract` module. Its public
interface is small and all values crossing it are serializable:

```ts
interface RuntimeContract {
  open(input: {
    invocation: string;
    hostEvidence: HostEvidence;
    config: ProjectConfig;
    continuation?: RelaunchEnvelope;
  }): Result<RunContext, RuntimeError>;

  plan(input: {
    run: RunContext;
    work: WorkContext;
    laneProof: LaneProof;
    capabilities: CapabilitySnapshot;
    routeState: RouteState;
  }): Result<DispatchPlan, RuntimeError>;

  observe(input: {
    run: RunContext;
    routeState: RouteState;
    plan: DispatchPlan;
    outcome: DispatchAttemptOutcome;
  }): Result<RouteTransition, RuntimeError>;

  finish(input: {
    run: RunContext;
    progress: ProgressFacts;
  }): Result<StopOrRelaunchPlan, RuntimeError>;
}
```

`open()` parses and freezes run intent. `plan()` selects exactly one deterministic dispatch plan or
returns one typed error. `observe()` owns retry, outage, recovery-probe, and fallback transitions.
`finish()` retains the existing stop and bounded relaunch guarantees. A thin compatibility wrapper
may preserve the current `run-scope.mjs` command surface during migration, but it contains no
independent policy.

Every dispatch plan is bound to the run-intent hash, artifact version, lane-proof fingerprint, and
capability fingerprint. A changed input expires the plan rather than allowing an adapter to execute
stale policy. The minimum stable error vocabulary distinguishes invalid or conflicting intent,
unknown/ambiguous active host, configuration migration required, unsupported route, missing
capability, unverifiable isolation, stale lane proof, expired plan, partial writer result, invalid
relaunch, and unsafe fallback.

The module owns invocation parsing, scope, continuation, supported-route selection,
stage/lane/round policy, capability-versus-outage policy, retry/fallback decisions, relaunch
validation, stop validation, and stable reason codes. It does not own issue selection, planning,
lane classification, GitHub lifecycle, review judgment, gate execution, recovery, or merge
authorization.

The closed catalog binds each supported route to a route adapter. The route adapter owns the
security and artifact contract; the active-host adapter remains thin:

```ts
interface RouteAdapter {
  readonly id: RouteId;
  requirements(): readonly CapabilityRequirement[];
  artifacts(): ArtifactContract;
  compile(plan: DispatchPlan): Result<DispatchAttemptPlan, RuntimeError>;
  classify(raw: RawAttemptResult): DispatchAttemptOutcome;
}

interface HostAdapter {
  attestHost(): HostEvidence;
  probe(requirements: readonly CapabilityRequirement[]): CapabilitySnapshot;
  execute(attempt: DispatchAttemptPlan): RawAttemptResult;
}
```

Route adapters own required repository artifacts, static validation, doctor requirements, minimum
versions, exact launch flags and prompt transport, collection/schema validation, effective
isolation evidence, and single-attempt classification. Host adapters attest the host and perform
the route adapter's compiled probe/attempt through the real host tool surface. Neither adapter
chooses a route or improvises a retry/fallback.

`RuntimeContract.observe()` reduces single-attempt outcomes, selects any retry or fallback, and
assembles the final dispatch receipt with attempt count, requested and actual routes, adapter,
model identity when observable, isolation/effect evidence, outage transition, fallback, and
degradation. An adapter cannot self-authorize a second attempt.

### Closed route catalog

v0.40.0 supports exactly the routes that have an explicit adapter, isolation contract, doctor
contract, and fixtures:

| Active host | Requested engine | Route |
|---|---|---|
| Claude | Claude | Native Claude |
| Codex | Codex | Native Codex |
| opencode | opencode | Native opencode |
| Claude | Codex | Claude → fresh `codex exec` |
| Claude | opencode | Claude → fresh `opencode run` |

Claude→opencode is retained because it is an existing v0.39.9 route; v0.40.0 changes its selection
from a persisted profile to explicit invocation intent rather than removing the capability.

The other four host/engine pairs return `UNSUPPORTED_ROUTE`. Recognizing an engine name does not
authorize an untested pairing. Naming the active engine explicitly normalizes the selected route to
native without rewriting the raw selector stored in `RunContext`. New routes are added only with
their adapter, security contract, doctor checks, and fixtures; capabilities do not dynamically
compose arbitrary pairings.

Native describes the host/engine relationship, not process topology:

- Native Claude uses fresh Agent-tool threads.
- Native Codex implementation uses a fresh writable worker. Review primarily uses a fresh external
  `codex exec --sandbox read-only`; an in-session reviewer is a disclosed degraded fallback only.
- Native opencode uses fresh task agents and the deny-stripped typed reviewer for review.
- Claude→Codex uses fresh `codex exec` processes with role-appropriate sandboxing.
- Claude→opencode uses fresh `opencode run` processes and the typed reviewer for review.

For native Codex only, this explicitly supersedes the 2026-07-21 maintainer decision to use
host-session reviewers for docs/small lanes (`skills/dev/SKILL.md:410–430`). The route remains
native, but reviewer isolation now determines process topology: a healthy reviewer uses fresh
external `codex exec --sandbox read-only`. Claude and opencode retain their safe host-native lane
adapters. This is a deliberate safety-over-cost change, not an accidental reinterpretation of the
standing decision.

### Stage, lane, and convergence policy

“Requested” below means the invocation-selected route; “native” means the safe active-host route.
Lane inputs are mechanical proofs issued by the configured-base-aware classifier, not prose
assertions.

| Stage | Docs lane | Small lane | Full lane |
|---|---|---|---|
| Plan review | Native | Native | Requested |
| Implementation | Native | Requested | Requested |
| Code review round 1 | Native | Native after final-diff proof | Requested |
| Code review round 2+ | Native | Native | Native |
| Bounded doubt/judgment review | Native | Native | Native |

Pitcrew uses the same resolver. In v0.40.0 its revision work is unconditionally full lane;
therefore revision implementation and its first independent full review use the requested route,
while later convergence uses native. Adding narrower Pitcrew lanes is a separate policy decision,
not an inference from Dev's table. A final Dev diff that loses docs/small eligibility is promoted
to the full route. Uncertain Dev lane evidence fails closed to full.

A rare bounded doubt/judgment review always uses the safe native reviewer adapter, regardless of
the requested cross-host engine, because it reviews an in-flight decision and has no later
independent review. It is one fresh read-only dispatch with the native adapter's isolation and
fallback contract. It is not an outage recovery probe; if no safe native review route exists, stop.

When Dev invokes Pitcrew as the return path of one cycle, both share the same frozen `RunContext`
and run-local route state. A standalone Pitcrew invocation opens new intent from its own current
invocation.

The existing convergence decisions remain invariants:

- dispatch a plan reviewer exactly once;
- review the full artifact in code-review round 1;
- review the fix delta and open rebuttals in rounds 2+;
- route a verified out-of-delta Critical/Major or exhausted cap to the human-block path, never to a
  second plan review or another full-artifact convergence round;
- use fresh author and reviewer identities for each artifact version and reject an author/reviewer
  collision;
- keep one writer and at most one depth-one, independently read-only staged-ahead unit.

### Capability, outage, and fallback

Probe only the selected route and its reachable fallback, cache the result for the run under a
capability fingerprint, and invalidate it when relevant evidence changes.

- Missing executable, authentication, minimum version, required artifact, or effective isolation is
  a capability failure. An explicit selector is never silently ignored.
- A route that passed preflight but later dies may enter the bounded outage state after the
  documented retry.
- Outage fallback uses a safe native route only when its isolation contract is satisfied. Every
  substitution is disclosed and never rewrites run intent.
- Sandbox initialization failure is an environment/config failure, not an engine outage.
- Typed-child, `agent_type`, and `fork_turns` checks apply only when the degraded native-Codex
  in-session fallback is reachable or selected. A healthy external-exec route cannot fail because
  an unused fallback feature is unavailable.
- A writer with uncertain or partial effects is reconciled through lifecycle recovery, never
  duplicated by a blind retry.
- No review is skipped. If neither the selected route nor an accepted safe fallback is available,
  stop with a typed error.

Capability and outage state are run-local evidence. They are not standing configuration and do not
change the requested engine. Dispatch receipts are audit evidence, not future routing authority.

### Configuration, Setup, and doctor

Autoloop v0.40.0 introduces repository configuration schema v0.25.0. The standing contract retains
repository policy—configured base, gate commands, merge policy, tracker, review checklist, and
numeric caps—and removes routing authority:

- delete `runtime.supportedHosts`;
- delete `engine.profile`;
- preserve valid non-null role tuning only through the explicit adapter-scoped field map below;
  options tune a selected route and never select one;
- reject requested engine, resolved route, capability, and outage fields in standing configuration.

Migration maps only role tuning that was effective under the valid 0.24.0 profile/host shape:

- with `engine.profile: "claude"`,
  `engine.claude.{implementerModel,reviewerModel}` →
  `adapterOptions["claude.native"]`;
- with a Claude-only Codex profile,
  `engine.codex.{implementerModel,reviewerModel,implementerEffort,reviewerEffort}` →
  `adapterOptions["claude.codex-exec"]`;
- with a Claude-only opencode profile,
  `engine.opencode.{implementerModel,reviewerModel}` →
  `adapterOptions["claude.opencode-exec"]`.

The route-qualified Codex and opencode options apply only to those Claude cross-host adapters;
native Codex and native opencode continue to inherit their active session configuration. Valid
native/dual 0.24.0 shapes already require the corresponding pins to be null. Omit null-only
entries. Report any non-null field outside the effective legacy profile as dormant and remove it
unless the human explicitly elects new tuning in the visible migration. Invalid or unknown tuning
fails migration. No dead option is preserved or newly activated silently, and no option selects its
adapter.

The executable project contract validates every required key, enum, numeric range, command shape,
conditional tracker value, checklist path, and adapter option. Active-host and route capability
checks belong to `RuntimeContract` and the selected adapter, not to the standing configuration
schema.

One Setup migration vendors or reconciles the safe repository artifacts for Claude, Codex, and
opencode so changing the active host requires no repository reconfiguration. Artifact presence is
capability evidence, never deployment intent. Per-user CLI installation and authentication remain
host prerequisites.

The Setup wizard no longer asks for supported hosts or a standing engine profile. Global wizard
defaults remove those fields as well. Setup may offer adapter tuning, but the answer cannot change
the bare native default or create an implicit cross-engine route.

Setup statically validates all vendored artifacts but live-verifies only the active or explicitly
selected route. Bare doctor proves the active native route. `doctor with codex` and
`doctor with opencode` prove the same invocation-scoped routes Dev would select. Inactive routes are
reported as unverified notes, not fabricated successes or standing configuration failures. Adapter
contracts own their reviewer template, required permissions, minimum versions, launch flags,
effective-isolation checks, and remediation text; Setup and doctor consume the same contract.

Migration reads schema 0.24.0 only to produce a visible 0.25.0 migration. It never converts the old
profile into an implicit v0.40.0 run intent. A former Claude/Codex or Claude/opencode cross-host
default must add `with codex` or `with opencode` to each interactive or scheduled invocation that
must preserve that behavior. Native-only behavior migrates to the bare invocation. Runtime rejects
an unmigrated schema with an exact Setup remedy.

### Relaunch and recovery

The v1 relaunch marker carries only generation. v0.40.0 uses a constrained v2 envelope:

```ts
type RelaunchEnvelope = {
  v: 2;
  originHost: "claude" | "codex" | "opencode";
  selector: "native" | "claude" | "codex" | "opencode";
  scope: RunScope;
  generation: number;
  runIntentHash: string;
};
```

The prompt remains one exact canonical template. The envelope accepts only fixed enums and bounded
numbers, never arbitrary instructions. `selector` stores the canonical raw selector from
`RunContext`: a bare invocation remains `native`, while an explicit same-host selector remains
explicit even though its route is native. A same-run relaunch preserves selector and scope,
re-attests the active host, rejects a host mismatch, and re-probes capabilities. A new human
invocation creates new intent. Old v1 markers are rejected or cleared rather than interpreted
through a retired profile. Recovery of an existing claim uses the new invocation's intent; a
historical route is evidence, not an obligation.

### Alternatives considered

1. **Keep `supportedHosts` and `engine.profile`.** Rejected because repository configuration would
   continue to carry session intent, host switching would still require reconciliation, and
   Setup/doctor/runtime could continue to disagree.
2. **Build one effectful controller that performs every dispatch.** Rejected because native host
   agent surfaces are not all callable from one Node process. The deterministic module produces a
   plan; host skills remain thin execution adapters.
3. **Dynamically compose arbitrary host, engine, and transport adapters.** Deferred. It offers
   future extensibility but adds registry and ambiguity machinery and can imply support for
   untested pairings. v0.40.0 uses a closed, tested catalog.

### Consequences

- Bare scheduled work intentionally follows the host on which it runs. A stable cross-engine
  schedule says `with codex` or `with opencode` and runs on a host for which the closed catalog
  defines that route; v0.40.0 does not make cross-engine schedules portable across unsupported
  pairs.
- Switching among native Claude, Codex, and opencode requires no repository migration after schema
  0.25.0.
- One executable decision path replaces prose host/profile matrices, repeated probes, and
  grep-shaped doctor logic while preserving the model's planning and review work.
- The initial migration is broad and must reconcile Setup, doctor, Dev, Pitcrew, STATE, LOOP,
  README, defaults, session preflight, reviewer artifacts, hooks, smoke checks, telemetry, and
  schedules in one reviewed migration.
- Architecture migration does not close any unrelated finding and does not authorize non-manual
  merge.

## Finding index

| # | Severity | Finding |
|---|---|---|
| 1 | Major | Pitcrew can mark a revised PR delivered before CI passes on its new head |
| 2 | Major | A verified late Critical/Major can escape review convergence |
| 3 | Major | Loop-ownership parsing is duplicated and inconsistent |
| 4 | Major | The command guard is not an enforcement boundary |
| 5 | Major | Configuration, doctor, and reviewer-dispatch contracts disagree by host and mode |
| 6 | Major | Scan incompleteness permits unsupported absence conclusions |
| 7 | Major | Claim and terminal lifecycle writebacks are not interruption-safe |
| 8 | Major | Configured-base and protected-path classification are inconsistent |
| 9 | Dormant under manual; **release-blocking under non-manual** | The merge gate does not re-assert loop ownership and merge eligibility |
| 10 | Dormant under manual; **release-blocking under classified auto-merge** | Path-A authorization is neither head-bound nor provably human |
| 11 | Dormant under manual; **release-blocking under non-manual** | Verdict producer identity is unchecked |
| 12 | Dormant under manual; **release-blocking under non-manual** | Merge authorization is based on a non-atomic evidence snapshot |

## Verified findings

### 1. Pitcrew can mark a revised PR delivered before CI passes

Pitcrew restores `loop-delivered` immediately after push and remote-SHA verification
(`skills/pitcrew/SKILL.md:130–145`). It does not wait for CI on the revised head.

The forward path correctly waits and leaves a pending head ready without the delivered label
(`skills/dev/SKILL.md:747–762`). `templates/STATE.template.md:271–276` defines delivered as reviewed,
gated, and CI-green on the current head.

This is Major rather than Critical in isolation. `loop-delivered` does not itself authorize
`auto-merge.mjs`; under non-manual policy the gate independently rejects missing configured CI and
visible pending or failing runs. The false terminal label is still operational state, not cosmetic:
it tells a manual human that only merge remains and drives awaiting-merge accounting, notifications,
and telemetry. When the configured required-check list is empty, the triggered-check floor only
examines runs already visible in the fetched snapshot; that evidence-arrival race belongs to
finding 12 and must not be described as universally fail-closed.

**Required change:** use one `finalizeHead()` transition in both paths:

`push → verify remote head → wait/classify CI → mark delivered`

Represent pending checks as an explicit `awaiting-ci` state.

### 2. A verified late Critical/Major can escape convergence

Review rounds after round 1 inspect the fix delta. That is an intentional convergence rule and
must remain. However, `skills/dev/SKILL.md:694–704` says a real finding outside the delta is surfaced
but never gated in the unit. The workflow can then publish `agentic/review=SUCCESS`.

**Required change:** keep delta scoping, but route any verified out-of-delta Critical/Major to the
existing human-block path. Do not dispatch another plan reviewer or return every review round to the
full unit diff.

### 3. Loop-ownership parsing is duplicated and inconsistent

`loop-scope.mjs` does not require the issue number in the branch to match the closing issue number
in the PR body. The closing grammar also differs between scan/scope and writeback/stats:
`Closes: #5` passes some consumers and fails others. `templates/tools/scan.mjs:23–47` also contains
a fallback from the mandatory digit capture in group 5 to group 4, the `resolv` suffix. Group 5 is
present on every successful match under the current regex, so the fallback is unreachable dead
fragility, not a live wrong-issue path.

**Required change:** create one canonical `parseLoopClaim()` returning a typed result containing the
branch issue, body issue, equality decision, and normalized closing grammar. Every consumer,
including recovery and auto-merge, must use it. Add cross-consumer contract fixtures.

### 4. The command guard is not an enforcement boundary

Verified gaps in `templates/tools/command-guard.mjs` include:

- order-insensitive commit/switch chains;
- ordinary destination refspecs to, or deletion of, the base;
- global `gh` flags bypassing inline-body checks;
- a hardcoded `main`/`master`/`develop` permanent set instead of `cfg.baseBranch`.

Explicit `+<refspec>` force is already caught and tested.

**Required change:** parse command order and destination refs structurally, pass the configured base
into the evaluator, handle global `gh` flags, and add one regression fixture per reproduced bypass.
Keep the guard as defense-in-depth; no-bypass repository rules are the base-branch boundary.

### 5. Configuration, doctor, and reviewer-dispatch contracts disagree

There are three related defects with different remediation paths:

1. **5a — immediate Setup/doctor incompatibility.** Doctor requires
   `sandbox_mode = "read-only"` (`skills/setup/SKILL.md:559–567`) while Setup and the shipped Codex
   0.145 template correctly use `default_permissions = ":read-only"` and identify the legacy field
   as a no-op (`skills/setup/SKILL.md:429`;
   `templates/codex-reviewer-agent.template.toml:3–12`). A fresh Codex scaffold can therefore fail
   its own doctor.
2. **5b — incomplete executable configuration schema.**
   `templates/tools/config-contract.mjs:38–96` validates only the schema version, supported-host
   set/order, engine profile/native-host compatibility, native role pins, and optional active-host
   membership. It does not validate `baseBranch`, the `gate` object and commands, `merge.policy`,
   `tracker`, `review.checklistPath`, or any `caps` value—the runtime surface enumerated in
   `skills/dev/SKILL.md:32–34`, with the gate/merge/tracker/review/cap semantics defined in
   `templates/STATE.template.md:52–65`. Gate-command existence and executability are checked
   separately only by prose doctor
   (`skills/setup/SKILL.md:599–600`).
3. **5c — model-facing dispatch-route contradiction.** Native-Codex Prime, the dispatch table, and
   the hard rule establish a fresh external `codex exec --sandbox read-only` process as the primary
   reviewer (`skills/dev/SKILL.md:87–100,264–277,953–957`). Yet the doubt-cycle, plan-review, and
   code-review instructions still direct native Codex to an in-session
   `agent_type = "autoloop_reviewer"` spawn without conditioning that direction on exec failure
   (`skills/dev/SKILL.md:358–364,560–563,669–676`). Docs/small lanes also select host-session
   reviewers while the primary exec route is available (`skills/dev/SKILL.md:410–430`).
   The same hard rule makes a spawn schema without `fork_turns` an unconditional preflight failure
   (`skills/dev/SKILL.md:958–961`), so an external-exec-capable setup can still fail on a field that
   belongs to in-session routes. Setup doctor likewise hard-checks the typed child even though Setup
   says Multi-Agent V2 children inherit the writable parent and external exec is primary
   (`skills/setup/SKILL.md:434–461,568–574`). A correct external-exec setup can therefore fail
   doctor, and an actual run can select a route that contradicts its declared isolation rule.

This is not evidence that the primary `codex exec --sandbox read-only` barrier is broken. It is an
end-to-end route-selection and validation contradiction.

**Immediate required change (5a):** make doctor require
`default_permissions = ":read-only"` for the reviewed Codex 0.145 contract and add a deterministic
cross-artifact test proving that the shipped scaffold template satisfies doctor's static
reviewer-TOML contract. This is an operational-prose defect with executable consequences, not a
runtime sandbox escape. The one-line field correction is a quick win, but it does not repair 5b or
5c.

**Structural required change (5b/5c):** the v7 profile-keyed remedy is superseded by the accepted
v0.40.0 architecture above.

For 5b, implement the complete schema-0.25.0 `ProjectContract`. Validate every remaining
runtime-required value and migrate away from `runtime.supportedHosts` and `engine.profile`.
Retained adapter options are non-authoritative tuning. Route capability is observed from the
current host and invocation; it is not declared by repository configuration.

For 5c, implement the deterministic `RuntimeContract` and closed route catalog used by Setup,
doctor, Dev, Pitcrew, every lane, every review round, and capability/outage fallback. Callers
provide immutable run intent plus stage, a mechanically issued lane proof, round, artifact
identity, and observed capability/outage facts. The module returns one tested dispatch plan or one
typed error; no caller retains an independent host/profile table.

Preserve the reviewed isolation contracts: external read-only Codex review, the typed deny-stripped
opencode reviewer, and fresh Claude Agent-tool review. Native Codex review remains external
`codex exec --sandbox read-only` when healthy, including docs/small lanes; native does not imply a
writable in-session reviewer. Typed-child checks (`agent_type`, parent overrides, effective child
surface, and `fork_turns`) apply only to the degraded native-Codex fallback that needs them.

Routes not selected by the current invocation receive static artifact validation and, at most, a
note that effective capability remains unverified. If prompt-level writable review remains an
accepted availability tradeoff, call it degraded and apply the integrity checks; do not
simultaneously claim that every accepted native review is OS-sandboxed.

### 6. Scan incompleteness permits unsupported absence conclusions

The scan caps several collections, omits review threads from the one-call run scan, and returns
generic issue `updatedAt` rather than body-edit evidence. Consumers can still infer that no eligible
or blocked work remains. Queue-stop accepts `eligibleRemaining === 0` without completeness proof.

**Required change:** fetch the missing facts and expose discriminated per-section results:

`{ items, complete, error }`

Paginate unresolved threads and the comments needed for author verification. Capture
`lastEditedAt` or a durable body hash. Selection, blocker resolution, actionability,
queue-exhaustion, relaunch, and stop validation must reject absence conclusions whenever
`complete !== true`.

Preserve the intentional per-section fail-open availability rule: an infrastructure error must not
wedge the entire run. Fail open to a bounded fallback, not to a false negative.

### 7. Claim and terminal lifecycle writebacks are not interruption-safe

Claim creation orders the claim label, branch, claim commit, push, and frozen-plan comment before
draft-PR creation (`skills/dev/SKILL.md:586–605`). Recovery fully adopts only claims that already
have an open draft PR (`skills/dev/SKILL.md:489–509`). If the run dies before `gh pr create`, the
next selection can reselect the still-`loop-ready` issue and clear its stale step label
(`skills/dev/SKILL.md:510–517`; `templates/STATE.template.md:285–292`), but it has no path to
reconcile the pre-existing local/remote branch, claim commit, or plan comment as one resumable
claim. Those residual artifacts can collide with or duplicate the new claim.

The opposite end has the same shape. Dev marks the issue delivered and, under non-manual policy,
may merge in step 10 before posting the complete run record in step 11
(`skills/dev/SKILL.md:742–795`). A crash can therefore leave delivered or merged state without its
promised audit trail, including under manual mode between delivery and the record.

**Required change:** model the lifecycle as idempotent phases with a durable marker written before
the first mutation. Bind issue/body hash, plan hash or durable plan reference, branch, planned base
OID, claim commit, head OID, and phase. Restart must independently reconcile:

- local branch and claim commit;
- remote branch;
- frozen-plan comment;
- draft PR;
- delivered state;
- pre-merge audit record;
- merge outcome and final record.

Use a recoverable two-phase terminal record: persist the complete pre-merge evidence first, then
merge, then idempotently append the outcome. A later run must backfill a missing terminal outcome.
Record requested and actual routes as audit evidence, never as recovery authority. A same-chain
relaunch preserves its selector through the v2 envelope; a new human invocation and orphan recovery
use the new invocation's intent. Neither may infer a route from the retired profile or an old run
record.

### 8. Configured-base and protected-path classification are inconsistent

`escalate-paths.mjs` derives its range from the repository default rather than `cfg.baseBranch`.
It omits `.opencode/**` even though STATE declares it protected, and its CLI has no planned-path
mode despite Dev using it for pre-implementation lane selection. Drift also runs the other way:
the executable classifier includes `.githooks/**`, while STATE does not.

These gaps can suppress `human:authorize` or select a cheaper lane using the wrong or empty diff.
They do not expose the automatic protected-path floor for root dot-directories:
`auto-merge.reference.mjs` independently rejects `.opencode/**` and `.githooks/**` through its
`/^\./` family. That is a defense-in-depth mitigation, not a reason to leave the human signal and
lane classifier inconsistent.

**Required change:** require an explicit configured base ref/OID, add `.opencode/**`, add a
planned-path input mode, fail closed when the base is unavailable, and share fixtures with the STATE
escalate list and auto-merge protected families. Passing the configured base also removes
`escalate-paths.mjs`'s per-call `gh repo view` lookup; implement and measure that as one change, not
as a separate optimization. The classifier must return an opaque lane proof bound to the configured
base and either planned paths or the final diff. `RuntimeContract` accepts that proof, not a
caller-authored lane string; missing, stale, or unverifiable proof selects the full lane.

### 9. The merge gate does not re-assert ownership and merge eligibility

The core PR query fetches head SHA, labels, and head repository; status/check verdicts arrive through
the separate rollup fetch. It does not fetch `headRefName`, body, or linked issue.

The ownership contract (`README.md:230–232`, `templates/STATE.template.md:377–379`) requires:

- same-repository head;
- matching branch/body issue number;
- trusted and unchanged linked issue;
- correct claim-commit ancestry;
- frozen-plan comment.

Merge eligibility additionally requires the current delivered lifecycle and current
blocker/dependency state (`templates/STATE.template.md:264–283`,
`skills/dev/SKILL.md:482–513,747–766`).

Ordinary selection checks issue eligibility only. Full provenance is checked only when adopting an
orphan, and the gate checks neither complete contract.

**Required change:** fetch and validate the full ownership and merge-eligibility contract inside the
gate, or require an independently attributable exact-head attestation that binds every element.

### 10. Path-A authorization is neither head-bound nor provably human

Path A authorizes solely from the presence of `risk:pure-deletion` or
`risk:mechanical-refactor`. The label survives a later force-push and the query does not identify
the label event actor.

With a shared loop/maintainer credential, an actor name would still not prove that a human supplied
the authorization.

**Required change:** first separate the loop identity. Then fetch the label event, require a trusted
human actor different from the loop, and bind the authorization to the current head OID. Reject a
label that predates the current head or whose provenance is incomplete.

### 11. Verdict producer identity is unchecked

`agentic/gate` and `agentic/review` are checked for context, success, and head SHA, not producer.
Under a shared maintainer login these statuses are evidence, not proof. README already requires a
dedicated least-privilege machine identity for unattended scheduling.

Identity separation is necessary but not sufficient.

**Required change:** publish verdicts through an independently attributable GitHub App or trusted
Actions CheckRun. Fetch and validate the creator/app in the gate, reject unapproved producers, and
pin required server-side checks to the expected App where supported.

### 12. Merge authorization is based on a non-atomic snapshot

`fetchInputs()` snapshots PR facts, files, threads, checks, labels, and the issue kill switch
sequentially. The direct merge executor conditions only on the head SHA. After the snapshot:

- a hard-block label or kill switch can appear;
- a review can request changes;
- a new unresolved conversation can appear;
- the base tip can advance while the PR head remains unchanged.

A second pre-merge fetch merely narrows the race. An exact-head attestation does not bind later
changes to PR or issue metadata.

**Required change:** server-enforce the predicates GitHub supports, without bypass:

- required status checks pinned to trusted producers;
- the intended required-review policy, including stale/latest-push behavior;
- conversation resolution;
- one of the following base-freshness strategies:
  - **Direct merge:** strict required checks with “require branches to be up to date.”
  - **Merge queue:** require the queue, replace the current direct REST merge executor with a
    queue-aware executor, configure CI for `merge_group` events, and recover the asynchronous queue
    outcome.

GitHub documents merge queues as providing the same latest-base benefit as strict up-to-date
protection; they are alternatives, not an unconditional cumulative requirement. Queue availability
also depends on repository ownership and plan. See
[GitHub’s protected-branch documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
and GitHub’s
[merge-group CI requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#triggering-merge-group-checks-with-github-actions).

GitHub's current availability rule is explicit:

> “Pull request merge queues are available in any public repository owned by an organization, or in
> private repositories owned by organizations using GitHub Enterprise Cloud.”
>
> — [GitHub, “Managing a merge queue”](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#product-statement)

The reviewed `fabioneves/autoloop` repository is public and user-owned, so it is not currently
eligible for GitHub's merge queue; this was reverified against the GitHub API and the availability
documentation on 2026-07-24. Its dogfood path is strict up-to-date required checks. Setup must
capability-detect queue support before offering that strategy to an installed repository.

Issue-label and issue-based kill-switch semantics are not atomic with merge. Represent them through
a trusted required check where practical, while acknowledging event-propagation latency. If an
absolute last-moment stop is required, retain manual merge or move authorization to a platform
primitive that can enforce it atomically. Queueing lengthens this exposure because the server may
merge well after the tool enqueues the PR; the required check must remain authoritative during the
queue lifecycle or the residual risk must be accepted explicitly. Do not describe an in-tool
refetch as closure.

## Intentional decisions to preserve

Do not “fix” these by reverting deliberate cost and convergence choices:

- **One plan-review dispatch.** The orchestrator dispositions revisions; do not add another engine
  plan-review round. Correct README’s unqualified writer/reviewer prose instead.
- **Delta-scoped code review after round 1.** Keep it. Finding 2 changes only the late-real-Major
  escape.
- **Per-section fail-open scanning.** Keep availability, but never use incomplete data to prove
  absence.
- **Command guard as defense-in-depth.** Repository controls remain the enforcement boundary.
- **Native-first invocation semantics.** Bare invocation means native; cross-engine routing requires
  explicit intent in the current invocation.
- **Safe native adapters.** Native routing never weakens reviewer isolation merely to retain a
  docs/small cost reduction.
- **Routing is not lifecycle authority.** Run intent and actual routes are recorded, but Git and
  GitHub lifecycle facts remain authoritative.

## Structural investments

The highest-return work is incremental contract centralization, not an effectful controller
rewrite:

1. `parseLoopClaim()` plus shared cross-consumer fixtures.
2. Complete `ProjectContract` schema 0.25.0 and an explicit 0.24.0→0.25.0 migration that removes
   persisted route authority.
3. The deterministic `RuntimeContract`, closed route catalog, route and host adapters, v2 relaunch
   envelope, and capability/outage reducer consumed by Setup, doctor, Dev, Pitcrew, every lane, and
   every fallback.
4. A configured-base-aware planned/final classifier that issues opaque lane proofs.
5. Cross-artifact tests: templates satisfy the selected adapter's doctor contract; STATE paths match
   classifiers and gate families; summary policy matches executable policy.
6. `finalizeHead()` for delivery.
7. `{ items, complete, error }` scan results and absence-safe consumers.
8. An idempotent lifecycle phase model for claim through terminal audit record.

Match verification to the artifact class. Deterministic `.mjs` behavior receives executable
fixtures; Setup/doctor/template operational contracts receive extracted validators and
cross-artifact compatibility tests; explanatory prose receives static contract lint.
Model-interpreted skill prose is operational, not “just documentation,” but it should not be
tested as though it were the same artifact as an executable policy function.

## Efficiency and performance workstream

The safety remediation must preserve the workflow's deliberate cost controls and restore the
performance work from the initial review. Optimize from measurements, not source-size intuition,
and do not trade away review independence, exact-head gating, scan completeness, or recoverability
for a faster happy path.

### Measurement foundation and baselines

The reviewed tree contains large model-facing contracts:

| Artifact | Size at `9dbc5b6` |
|---|---:|
| `skills/dev/SKILL.md` | 83,379 bytes |
| `skills/setup/SKILL.md` | 56,141 bytes |
| `templates/STATE.template.md` | 27,669 bytes |

The initial review estimated that a Dev invocation can begin with roughly 30,000 tokens of protocol
before issue and code context. Treat that as a hypothesis, not a budget: source bytes are not
additive, and the active host, requested engine, route, and lane determine what is actually
injected. Instrument the real payload.

The measurement deliverable is a versioned capture pipeline, not a larger claim for `stats.mjs`.
It may combine run records, dispatch traces, provider token accounting, command/API instrumentation,
and label timelines; it need not be one monolithic tool. Retain the raw, workload-identified records
needed to recompute aggregates after correcting an estimator. Record instrumentation overhead and
unavailable host/provider fields instead of inferring them.

Every record must identify the repository revision, workload, active host, engine selector,
requested engine, requested and actual route, intent source, adapter, degradation, stage, round,
lane, merge policy, base-freshness strategy, configuration/capability fingerprint, outage
transition, and measurement-pipeline version. Legacy v0.39 records retain the retired profile only
as `legacyProfile`. Capture comparable samples for each route in the v0.40.0 closed catalog and each
representative full, small, and docs lane that can actually run in the test environment:

- time to first eligible issue selection;
- total and per-step wall time, with active work separated from engine, CI, and human wait time;
- input, cached-input, output, and reasoning tokens by orchestrator and dispatched role, plus
  model/engine cost where the provider exposes it;
- GitHub API requests, subprocess launches, and remote mutations per unit;
- engine dispatch count and duration, review rounds, finding yield, and accepted-rebuttal rate;
- first-pass gate rate, local-green/CI-red rate, context-budget parks, and resumed-versus-restarted
  interrupted units.

`stats.mjs` is only the coarse label-gap timing slice. It cannot currently separate active work from
engine/CI/human waits, calculate p95, capture tokens/calls/mutations/dispatches, stratify by
active-host/requested-engine/actual-route/lane, or measure time to first selection. Fix its
even-count median; compute p95 in it or the composite pipeline; do not use it as the sole baseline
authority. Until finding 3 repairs its claim parser, supply an explicitly validated issue cohort
rather than relying on default discovery, which is capped at 100 without completeness proof.

Use two measurement checkpoints:

1. **Legacy-workflow baseline:** after containment and before Step 1, capture the reviewed behavior
   under manual merge policy for cost attribution. It is historical evidence, not the budget for
   the redesigned safe workflow.
2. **Safe-system baseline:** after Steps 1–8 are installed and verified, rerun the same workloads.
   Keep the comparison manual-to-manual, holding workload, equivalent actual route, lane, and
   base-freshness strategy constant. Derive enforced budgets from this checkpoint. Match a legacy
   profile to its observed route, never to a removed configuration field.

The two endpoints show the aggregate net cost or savings of safety remediation. Attribute a change
to an individual repair only when an intermediate matched checkpoint or step-level instrumentation
supports it. A newly safe non-manual route is a separate safe-only cohort unless its legacy behavior
can be exercised through a non-mutating replay; never compare a manual legacy run with a live
non-manual safe run.

Report sample count with the statistical median and nearest-rank p95. Require at least 20 comparable
observations per cohort before reporting p95, and mark its budget provisional until 100 observations
or a predeclared tighter confidence criterion is met. Do not compare different lanes as though they
were the same workload.

### Existing gains to preserve

Treat these as performance invariants while implementing the findings:

- **One-call startup scan.** Internally it may paginate and use bounded concurrency, but Dev and
  Pitcrew should consume one typed, generation-tagged repository snapshot rather than rebuild state
  through serial model-mediated calls. The generation tag is a freshness boundary, not a claim that
  the GitHub facts were fetched atomically.
- **Depth-one overlap.** While one unit waits on an engine or isolated host thread, stage at most
  one next unit through read-only premise, plan, and plan review. Checkout, claim, implementation,
  gate, and terminal mutations remain single-flight.
- **Mechanically selected docs and small lanes.** Preserve the stage/lane table's docs/small
  policy, final-diff reclassification, escalation checks, reviewer independence, and full final
  gate. Their savings are host-dependent: Claude and opencode retain safe cheaper host-native
  reviews, while native Codex deliberately replaces the former host-session reviewer optimization
  with external read-only `codex exec`. Do not claim zero engine dispatches for native-Codex
  docs/small review; measure that safety-over-cost change separately.
- **One deep review per artifact.** Keep one plan-review dispatch and full-diff code-review round 1;
  use fresh fix-delta reviews for convergence and the human-block path for a verified late
  Critical/Major.
- **Two-tier feedback and no lone round trips.** Preserve the optional quick inner-loop gate, the
  mandatory full final gate, and batching of each lifecycle-label swap with the step's first real
  command.
- **Idle exit and context-budget handoff.** Do not poll an empty queue or start a unit that cannot
  finish in the remaining context.

### Highest-return optimizations

1. **Make the repository snapshot complete without returning to serial calls.** Fetch every fact
   required by selection, Pitcrew actionability, blocker resolution, recovery, and stop validation;
   paginate to completeness; use bounded concurrency or GraphQL where it measurably reduces
   round-trips; expose `{ items, complete, error }` per section. Reuse a snapshot only through a
   mutation-free decision phase. Invalidate affected sections after Git or GitHub mutation and
   refetch authorization evidence at its existing safety boundary. Never cache merge authority
   across a mutation or wait.
2. **Shrink model protocol incrementally.** Move repeated deterministic parsing, configuration,
   route selection, transitions, and validation into the shared contracts listed above. Measure the
   actual injected-token reduction for each extraction. Do not replace the skills with a controller
   rewrite; each extraction should remove duplicated prose, add fixtures, and leave issue
   understanding, planning, implementation, and adversarial review with the model.
3. **Reduce API and process amplification.** Batch independent reads, eliminate per-item follow-up
   calls where a paginated query can return the same facts, share the typed snapshot between Dev
   and Pitcrew, and avoid repeating host/config probes only while their inputs and capability
   fingerprint remain unchanged. Preserve explicit refreshes after state changes. Set request and
   subprocess budgets from the safe-system baseline rather than inventing arbitrary limits.
4. **Reduce presentation mutations without weakening state.** Lifecycle labels remain authoritative
   until an equally recoverable replacement exists. Consolidate non-authoritative progress into one
   updated surface where the host permits it, and avoid duplicating the same heartbeat across chat,
   comments, labels, and timeline reads. Retain the final durable audit record, human-action
   notifications, and the events required for recovery and timing. The host-local chat/task
   heartbeat pair is an intentional live-wait signal; change it only when measurement justifies the
   cost and the replacement remains equally visible.
5. **Measure overlap and lane effectiveness.** Record staged-ahead utilization, engine minutes
   avoided by docs/small lanes, idle wait eliminated, false lane classifications, and scope-drift
   fallbacks. Calculate engine minutes avoided only from a matched full-lane control, a
   non-mutating replay, or an explicitly labeled counterfactual model; lane telemetry alone cannot
   establish avoided cost. Increase concurrency only for independent read-only work; never add a
   second implementer or concurrent checkout mutation to improve a benchmark.
6. **Count avoided rework as performance.** Track partial claims resumed, audit records backfilled,
   duplicate scans avoided, and false doctor failures prevented. `finalizeHead()`, typed dispatch,
   and idempotent lifecycle phases are safety fixes whose workflow return should also be measured.

### Performance acceptance

For every optimization, record the bottleneck, comparable before/after samples, the affected active
host/requested engine/actual route/lane, and the regression guard. A change is a performance
improvement only when the target metric improves without increasing false absence conclusions,
stale authorization, unreviewed scope, failed recovery, or gate escapes.

After the safe-system baseline, set explicit budgets for prompt tokens, time to first selection,
per-unit API requests/subprocesses/mutations, and p50/p95 unit time. Keep budgets mode-aware: a
cross-host route and a native route do not have the same cost profile. Make the benchmark workload
repeatable across the closed route catalog, with unavailable live-host coverage reported
explicitly. Performance work does not delay containment or lower the auto-merge bar.

## Remediation order

### Step 0 — containment

Do this before broader remediation:

- Change new installations to `merge.policy: manual`.
- Halt or migrate existing non-manual installations.
- Protect the configured base with no bypass for the shared loop/maintainer account, including
  administrators.
- Require trusted checks and the intended review/conversation controls.
- Select either strict up-to-date direct merges or, on a queue-capable repository, a merge queue
  with correctly triggered merge-group CI.
- Do not invoke `auto-merge.mjs`.

Containment takes precedence. Once it is active, establish the versioned measurement pipeline,
record its overhead, fix the measurement-only median defect, and capture the manual-mode
legacy-workflow baseline before Step 1 changes workflow behavior.

### Step 1 — repair the immediate Setup/doctor incompatibility

Replace doctor's obsolete `sandbox_mode` requirement with the reviewed
`default_permissions = ":read-only"` contract and add a scaffold-template-satisfies-doctor test
for static reviewer-TOML validation (finding 5a). Extract that check as the Codex adapter's shared
artifact contract so the v0.40.0 Setup and doctor consume it; do not add another one-off prose/grep
rule that Step 3 must discard. This quick win does not close the executable schema or route work.

### Step 2 — repair delivered-state integrity

Implement `finalizeHead()` and use it in Dev and Pitcrew (finding 1).

### Step 3 — install the v0.40.0 runtime architecture and shared contracts

Deliver the architecture and findings 3, 5b/5c, and 8 as one migration program with reviewable
slices:

1. Add the complete schema-0.25.0 `ProjectContract`, explicit 0.24.0→0.25.0 migration, and fixtures.
   Remove persisted host/profile route authority; preserve valid non-null tuning only as
   non-authoritative adapter options.
2. Add the deterministic `RuntimeContract`, closed five-route catalog, route and host adapter
   contracts, capability/outage reducer, v2 relaunch envelope, typed errors, dispatch receipts, and
   exhaustive route fixtures.
3. Implement `parseLoopClaim()` and the configured-base planned/final classifier with opaque lane
   proofs. Complete their consumer fixtures before any lane is cut over to `RuntimeContract`.
4. Prepare the universal Setup scaffold, selected-route doctor checks, STATE, LOOP, README,
   defaults, session preflight, reviewer artifacts, hooks, smoke checks, telemetry, and scheduler
   examples against the candidate contracts. Explicitly mark the 2026-07-21 docs/small
   host-session-reviewer decision as superseded for native Codex and remove forward zero-engine
   claims for that route.
5. Atomically activate schema 0.25.0 and cut over Setup, doctor, Dev, Pitcrew, every lane, every
   review round, every fallback, run-scope/stop handling, relaunch handling, claim parsing, and lane
   classification. Remove independent route matrices and obsolete host/profile preflights. Run
   cross-artifact compatibility tests and static contract lint for stale route prose in forward
   operational artifacts; exempt this historical review evidence, migration diagnostics, and
   `legacyProfile` telemetry.

Slices 1–4 are prerequisites of slice 5 and may land behind tests without changing active behavior.
Schema migration and consumer cutover are one atomic behavior slice: no supported intermediate
state combines schema 0.25.0 with 0.24.0 route selection, or vice versa, and no cutover can occur
before the lane-proof issuer exists.

### Step 4 — redesign non-manual authorization

Re-assert full ownership and eligibility, introduce and enforce the separate machine identity,
head-bind Path-A authorization, authenticate verdict producers, and choose the direct-strict or
merge-queue server strategy (findings 9–12).

### Step 5 — close the late-finding escape

Route verified out-of-delta Critical/Major findings to the existing human-block state without
changing delta convergence (finding 2).

Auto-merge may be reconsidered only after Steps 0–5 are installed and verified.

### Step 6 — harden command enforcement

Implement structured command/order and destination-ref validation with configured-base awareness,
plus regression fixtures (finding 4).

### Step 7 — make scans absence-safe

Build the shared typed snapshot, fetch missing review/body facts, paginate with bounded concurrency,
and propagate completeness through every consumer (finding 6). Preserve the one-call startup
boundary and define its mutation-driven invalidation rules.

### Step 8 — make the lifecycle resumable

Implement durable phase markers and idempotent reconciliation from pre-claim through post-merge
audit completion (finding 7).

Dependable unattended queue operation requires Steps 0–8, not only auto-merge authorization.
After Step 8 is verified, capture the safe-system baseline with the same workloads used for the
legacy baseline.

### Step 9 — measure and reduce workflow cost

Using the safe-system baseline, set mode- and workload-aware budgets and address only measured
bottlenecks from the efficiency workstream. Use the legacy-to-safe delta as the aggregate
safety-remediation delta, not as the enforced budget or per-repair attribution. Prioritize
prompt/context reduction, serial API and subprocess amplification, redundant presentation
mutations, and unused overlap. Add regression measurement for each accepted optimization.

### Step 10 — operational hardening

- Add a canonical CI verification command on Linux and macOS.
- Protect the base and release tags; keep controls non-bypassable by the loop.
- Replace `sort -V` and `sha1sum` assumptions with portable Node implementations.
- Resolve the ARCH “Last-verified line” contradiction.
- Centralize release-version literals and add a release verification command.
- Add LICENSE, SECURITY, CONTRIBUTING, and CHANGELOG.

## Acceptance criteria for implementation

The bars below are cumulative. Passing the architecture bar proves migration and routing
correctness; it does not close unrelated findings. Automated merge remains disabled until the
architecture and auto-merge bars pass. Dependable unattended operation requires the first three
bars; full plan completion requires all four.

### v0.40.0 architecture and migration

- Release manifests, cached-skill banners, and documentation identify Autoloop v0.40.0; migrated
  repository STATE uses configuration schema v0.25.0.
- Bare Dev, Pitcrew, and doctor invocations select the safe native route on Claude, Codex, and
  opencode. Explicit Claude→Codex and Claude→opencode invocations select their cross-host routes.
  The other four host/engine pairs fail before mutation with `UNSUPPORTED_ROUTE`.
- Schema 0.25.0 validates every standing runtime-required value and rejects persisted
  `runtime.supportedHosts`, `engine.profile`, requested engine, resolved route, capability, or
  outage authority. Retained adapter options cannot select a route.
- Every valid 0.24.0 host/profile shape has a migration fixture. Migration applies the explicit
  Claude-native, Claude→Codex-exec, and Claude→opencode-exec field map, omits null-only entries,
  reports dormant or unmappable fields instead of activating them, reports scheduled invocations
  that must add `with codex` or `with opencode`, and never silently converts a retired profile into
  run intent.
- One Setup migration reconciles the safe repository artifacts for all three hosts. Switching the
  active native host afterward requires no repository reconfiguration.
- Setup, doctor, Dev, and Pitcrew use the same `ProjectContract`, `RuntimeContract`, route catalog,
  and route/host adapter contracts. No consumer retains an independent host/profile matrix or
  grep-shaped route decision.
- Exhaustive fixtures cover all active-host × selector × Dev/Pitcrew flow × stage × lane × round ×
  capability/outage inputs, including bounded doubt/judgment review. Each returns one deterministic
  plan or one typed error. Golden plans include artifact, lane-proof, and capability fingerprints.
- The stage/lane/round table, one-plan-review rule, full round 1, delta-scoped convergence,
  writer/reviewer separation, serialized writer, and depth-one read-only overlap pass routing
  contract fixtures. Finding 2's end-to-end late-Major behavior remains in its own remediation and
  auto-merge criterion.
- Pitcrew fixtures prove unconditional full-lane revision implementation and first review, native
  convergence, shared `RunContext` when called from Dev, and fresh intent when invoked standalone.
- Native Codex review remains fresh external OS-enforced read-only review when healthy in full,
  docs, small, and convergence routes. Fixtures and operational prose explicitly mark the prior
  native-Codex host-session docs/small decision as superseded. Unused degraded-spawn capabilities
  are not evaluated.
- The shipped Codex and opencode reviewer artifacts pass their shared adapter doctor contracts.
  Static validation of an inactive route is not reported as effective runtime success.
- Relaunch v2 round-trips the canonical raw selector, scope, generation, origin host, and
  run-intent hash. Fixtures prove that bare `native` stays `native`, an explicit same-host selector
  stays explicit while resolving to a native route, and corruption, conflicting intent, stale
  generation, and host mismatch are rejected. The envelope never carries arbitrary prompt text or
  standing outage authority.
- Every dispatch receipt and run record distinguishes active host, selector, requested engine,
  requested route, actual route, adapter, observable model identity, effective isolation,
  capability/outage transition, fallback, and degradation.
- Static contract lint rejects stale profile-based routing prose in forward operational artifacts
  while exempting historical review evidence, migration diagnostics, and `legacyProfile`
  telemetry. Live smoke coverage is reported for each available route; an unavailable host or
  route is typed `unavailable`, never inferred green.

### Auto-merge enablement

- The complete v0.40.0 architecture and migration bar above passes.
- **Finding 1:** Dev and Pitcrew use the same tested transition, and delivered is impossible until
  CI is green on the verified current head.
- **Finding 2:** a fixture proves that a verified out-of-delta Critical/Major enters the human-block
  state and cannot publish review success.
- **Finding 3:** every claim consumer uses the canonical parser and rejects a branch/body issue
  mismatch under shared closing-grammar fixtures.
- **Finding 5:** the immediate scaffold-template-satisfies-doctor fixture passes, and the v0.40.0
  architecture bar proves complete configuration validation and deterministic selected-route
  behavior with explicit degradation.
- **Finding 8:** every path consumer uses the configured base, supports its declared planned/final
  inputs, and passes shared STATE/classifier/gate fixtures, including `.opencode/**` and
  `.githooks/**`. Planned and final classification returns a base-bound lane proof; an invalid proof
  cannot select docs/small routing.
- **Finding 9:** the gate revalidates the complete loop-ownership and current merge-eligibility
  contract on the authorized head.
- **Findings 10–11:** the loop has a distinct machine identity; Path-A authorization is
  human-attributable and head-bound; and gate/review verdicts come from an approved producer.
- **Finding 12:** non-bypassable server rules enforce the supported check, review, conversation, and
  base-freshness predicates. Direct merge proves strict up-to-date checks; queue mode proves
  repository capability, `merge_group` CI, queue-aware submission, and asynchronous outcome
  recovery. Any residual issue-label or kill-switch race is explicitly accepted and documented.
- If finding 4 remains temporarily unresolved at this bar, effective no-bypass protection for the
  configured base is independently verified and the command guard is recorded as open product
  debt. This exception does not satisfy the unattended-operation bar.

### Dependable unattended queue operation

- The complete auto-merge bar above passes.
- **Finding 4:** structured command/order and destination-ref fixtures pass against the configured
  base, including every reproduced bypass, while server protection remains non-bypassable.
- **Finding 6:** the startup snapshot is complete, internally paginated with bounded concurrency,
  shared by Dev and Pitcrew, invalidated at explicit mutation boundaries, and incapable of
  supporting an absence conclusion from an incomplete section.
- **Finding 7:** crash-injection tests at every lifecycle phase prove idempotent recovery, including
  partial pre-PR claims and merged-without-final-record. Same-chain relaunch preserves current
  selector intent, while a new invocation or orphan recovery never infers a route from the retired
  profile or historical audit data.

### Measurement and full-plan completion

- A versioned pipeline retains recomputable raw records and reports time, tokens, calls, mutations,
  dispatches, review yield, gate outcomes, and recovery outcomes by repository revision, workload,
  active host, selector, requested engine, requested and actual route, adapter, stage, round, lane,
  merge policy, base-freshness strategy, capability/outage transition, and
  capability/configuration fingerprint. Legacy records preserve the retired field only as
  `legacyProfile`. A provider field that cannot be observed is a typed `unavailable` value with a
  reason, never an inferred zero.
- Comparable manual-to-manual legacy and safe-system cohorts report the statistical median,
  nearest-rank p95, sample count, and instrumentation overhead. Each reported p95 meets the
  20-observation floor; budgets remain provisional until the declared 100-observation or tighter
  confidence criterion is met.
- Prompt/context, API, subprocess, mutation, and timing budgets derive from the safe-system baseline
  and are enforced by mode-aware regression checks.
- Every claimed optimization has comparable before/after evidence and preserves the overlap, lane,
  review, recovery, and exact-head gate invariants. Avoided-cost claims use a matched control,
  non-mutating replay, or clearly labeled counterfactual model.
- Step 10's cross-platform verification, repository/release protections, portable tooling, contract
  cleanup, version centralization, and governance files are complete.

## Verification notes

- All 12 findings were checked against the v0.39.9 tree.
- Finding 12 is verified from the fetch/decision/merge contract; it was not represented as a
  runtime concurrency reproduction.
- `codex exec --sandbox read-only` remains a valid primary isolation route in the reviewed v0.39.9
  Codex configuration and is the safe native-Codex review adapter in the v0.40.0 design. Finding 5
  concerns contradictory v0.39 selection and validation, not failure of that sandbox.
- The v0.40.0 architecture, migration criteria, and acceptance fixtures are prospective until
  implemented and run; they are not included in the v0.39.9 verification claim.
- No runtime source-code changes were made as part of this review or architecture amendment.
