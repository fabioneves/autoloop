---
name: setup
description: Scaffold, migrate, reconfigure, or diagnose Autoloop from Claude Code, Codex CLI, or opencode. Repository artifacts support all three hosts; a bare invocation checks the active native route, while an explicit `with codex` or `with opencode` suffix checks that route for this invocation only.
---

# autoloop:setup — scaffold / migrate / reconfigure / doctor

Your first output, before a tool call or question, is exactly:

```text
┌─┐ ┬ ┬ ┌┬┐ ┌─┐ ┬   ┌─┐ ┌─┐ ┌─┐
├─┤ │ │  │  │ │ │   │ │ │ │ ├─┘
┴ ┴ └─┘  ┴  └─┘ ┴─┘ └─┘ └─┘ ┴
∞ setup · v0.40.2 · starting
```

If a tool call already happened, print the banner with the next output. Print it once.

Setup is idempotent and has four modes:

- Fresh install: `docs/agentic/STATE.md` is absent.
- Migration: STATE contains a migratable schema older than `0.25.0` (`0.23.0` or `0.24.0`).
- Reconfigure: STATE contains schema `0.25.0`.
- Doctor: the invocation contains `doctor`; read-only and never writes.

The repository scaffold is universal. It contains safe artifacts for Claude Code, Codex, and
opencode so switching native hosts does not require reconfiguration. The invocation selects the
route:

```text
/autoloop:setup doctor
/autoloop:setup doctor with codex
/autoloop:setup doctor with opencode
```

Codex uses `$autoloop:setup doctor`; opencode invokes the `setup` skill with `doctor`. Both accept
the same trailing selector grammar.

A bare invocation means the active native route. A suffix is a run-local captured preference.
Same-UID prompt hooks cannot prove who supplied it. STATE, environment
variables, installed artifacts, old run records, and global defaults have zero routing authority.
Only these five routes exist:

| Active host | Captured engine preference | Route |
|---|---|---|
| Claude | Claude | `claude.native` |
| Codex | Codex | `codex.native` |
| opencode | opencode | `opencode.native` |
| Claude | Codex | `claude.codex-exec` |
| Claude | opencode | `claude.opencode-exec` |

Every other host/engine pair fails before mutation with `UNSUPPORTED_ROUTE`.

## Prime

1. Resolve this skill's real path and its sibling `templates/` directory. Do not depend on
   `CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT`, or another compatibility variable.
2. Print the banner.
3. In doctor mode, require the Claude/Codex `UserPromptSubmit` or opencode
   `opencode.user-prompt` hook to have passed the command-shaped event to
   `intent-contract.mjs --capture-hook` before this skill began. Call the sibling
   `run-scope.mjs --attest-host-json` with exactly `{sessionId}`. Its broker consumes the one-use
   process/repository/session-bound transport and reads validated STATE itself. Runtime records
   immutable `intentProvenance: "best-effort-unverified"`; the hook is not user attribution.
   Never construct host evidence or pass prompt/config prose. Exactly one of `claude`, `codex`, or
   `opencode` must be observed. Ambiguous, missing, or replayed transport is a failure. Write modes
   do not attest or open a run.
4. Check version currency before deriving drift. In a versioned plugin cache, list sibling
   directory names and pipe them through:

   ```bash
   node <templates>/tools/release-verify.mjs --sort-versions
   ```

   In a live tree, compare the loaded banner with `VERSION` and the banner on disk. A newer disk
   version means this session is stale: setup/migration stops; doctor reports FAIL and asks for a
   fresh session.
5. Fetch the configured base and audit `origin/<base>`, not the parked checkout. Until STATE is
   parsed, use the repository default only to find an existing STATE; then switch the audit ref to
   `cfg.baseBranch`. A unit branch's older files are a NOTE, never drift evidence.
6. In doctor mode only, call `run-scope.mjs --open-json` with exactly `{hostEvidence}`. The broker,
   not Setup, supplies Runtime with the consumed captured routing preference and ProjectConfig it
   read and validated from STATE. `/autoloop:setup doctor`, `$autoloop:setup doctor`, and
   opencode's plain `doctor` normalize to flow `doctor` without changing the selector.
   `merge.policy` other than `manual` fails before probing. Caller `invocation` or `config` fields
   are invalid. Fresh install, migration, and reconfigure do not
   open run intent or select a route: the scaffold is universal. Reject an engine suffix on those
   write modes and use a later explicit doctor invocation for live route verification. Do not
   maintain a prose route table or substitute another engine on failure.
7. Run the one-call audit below. Follow up only on failed or incomplete sections.

Before or during scaffold reconciliation, every Runtime/adapter call uses the loaded skill's
sibling `<templates>/tools/run-scope.mjs`; after reconciliation, verify the installed
`tools/agentic/run-scope.mjs` produces the same results. Use structured JSON operation flags:
host attestation uses exact `{sessionId}` with `--attest-host-json`, opening uses exact
`{hostEvidence}` with `--open-json`, and Linux-only live capability probing uses exact
`{hostEvidence,run,routes:[selectedRoute, optionalNativeFallback],cwd:absoluteRepositoryRoot}` with
`--probe-json`. On non-Linux hosts every route probe fails with
`UNVERIFIABLE_ISOLATION` before issuing an attempt challenge or creating probe scratch state.
Doctor plans use `--plan-json` then `--compile-json` and
broker-only `--execute-json` for every route. Setup never fabricates contract output in prose or
trusts an older installed contract to validate its own migration.

Runtime signing authority lives only in the process-bound broker's memory. The broker exposes
typed, sequence-gated operations rather than a generic signer. A new invocation attestation
consumes the one-use prompt record; one exact opencode continuation target instead reuses the
unchanged broker and receives target evidence only from its prompt-prepared, session-bound durable
ledger. Exact target Runtime open and the prompted transition join in either order before the
completed transfer revokes source authority; an early target stop defers teardown until that join.
The target's terminal stop
removes the final registry/socket and zeroes keys. Every adapter and capability probe requires the same executed
`host.process-authority-isolation` smoke: Linux needs usable `/usr/bin/bwrap`, private PID/mount/
runtime/temp/device/home views, closed ambient reads, no remote Git/GitHub/SSH credentials or host
IPC, and role-specific checkout/scratch access. v0.40 reports all live adapters unavailable on
macOS. A present executable without the complete verified boundary is a capability failure.

## Project configuration

Schema `0.25.0` stores repository policy, never session intent:

```json autoloop-config
{
  "version": "0.25.0",
  "baseBranch": "main",
  "gate": {
    "command": "npm test",
    "quickCommand": null,
    "setupCommand": null
  },
  "merge": { "policy": "manual" },
  "tracker": { "provider": "none" },
  "review": { "checklistPath": "docs/agentic/checklist.md" },
  "caps": {
    "gateRetriesPerUnit": 2,
    "reviseRoundsPerPr": 3,
    "codeReviewRoundsPerUnit": 5,
    "sliceMaxLines": 700,
    "sliceMaxFiles": 10
  }
}
```

Optional `adapterOptions` may tune only these already-selected Claude routes:

- `claude.native`: `implementerModel`, `reviewerModel`
- `claude.codex-exec`: `implementerModel`, `reviewerModel`, `implementerEffort`,
  `reviewerEffort`
- `claude.opencode-exec`: `implementerModel`, `reviewerModel`

Adapter options never select a route. Native Codex and native opencode inherit their active
session configuration.

Validate configuration only through `config-contract.mjs`. Unknown keys, invalid enums, unsafe
paths/model identifiers, commands with control characters, or out-of-range caps fail. Doctor also
checks that each configured command's executable is discoverable and that the checklist exists at
the audited base ref.

## Schema migration

Use `migrateProjectConfig()` from `config-contract.mjs`; do not hand-transform JSON and do not call
a single version step directly. It reads the configuration's own version and applies the ordered
chain until the current schema, so a caller never names a version pair. `MIGRATABLE_CONFIG_VERSIONS`
lists what it accepts; anything else is a typed `UNSUPPORTED_CONFIG_VERSION` rather than a silent
pass.

From `0.23.0` it first adds the fields that version predates — `gate.quickCommand`,
`caps.codeReviewRoundsPerUnit`, and the `engine.opencode` block — then continues through the
`0.24.0` step below. A Jira tracker still requires supplemental facts, and the typed
`MIGRATION_INPUT_REQUIRED` result names exactly which.

- Remove `runtime.supportedHosts` and `engine.profile`.
- Remove `caps.runWallClockHours`; v0.40 queue runs have no fixed whole-run clock ceiling.
- Reset every legacy `ratified` or `auto` merge policy to `manual`. v0.40 does not re-enable a
  non-manual policy because its prompt transport is not authenticated provenance.
- Never convert the legacy profile into current invocation intent.
- Preserve valid, effective, non-null tuning only through the adapter-scoped map implemented by
  the contract.
- Report dormant or unmappable tuning rather than activating it.
- For Jira, ask for and confirm `epicKey` and Atlassian `cloudId`; pass them as
  `migrationFacts.tracker`. Missing facts are `MIGRATION_INPUT_REQUIRED`, not values to infer.
- Tell former Claude-to-Codex and Claude-to-opencode schedules to append `with codex` or
  `with opencode` explicitly. Bare schedules now follow their active host.
- Reconcile every template-derived operational section and universal host artifact in the same
  migration. A version-only migration is forbidden.

Show the old config, migrated config, warnings, and artifact diff before writing.

## Fresh-install and reconfigure questions

Use structured questions when the host provides them; otherwise ask one concise question at a
time. Global defaults may pre-fill answers but never skip confirmation.

Ask only:

1. Mission and non-negotiable invariants.
2. Configured base branch.
3. Gate, optional quick gate, optional setup command, and the complete required CI CheckRun-name
   set. An empty set must be an explicit repository-policy choice, never an inference from an
   empty API response.
4. Tracker: none or Jira; Jira requires epic key and cloud ID.
5. Review checklist path/content.
6. Numeric caps.
7. Optional tuning for the three adapter-option entries. State clearly that tuning cannot change
   the bare native route.
8. Extra human-authorization/protected paths.
9. Universal host prompt hooks are mandatory best-effort transport for every enabled Claude,
   Codex, or OpenCode runtime entrypoint. They are not attributable intent.
10. Optional agent-skills dependency.
11. Merge policy. v0.40 requires `manual`; do not offer `ratified` or `auto` as an enabled choice.

Never infer that an empty required-check list means CI is safe. Merge, merge queue, tag
publication, and release publication require an independent maintainer action outside the run.

Global defaults contain only non-project preferences:

```json
{
  "merge": { "policy": "manual" },
  "tracker": { "provider": "none" },
  "caps": {
    "gateRetriesPerUnit": 2,
    "reviseRoundsPerPr": 3,
    "codeReviewRoundsPerUnit": 5,
    "sliceMaxLines": 700,
    "sliceMaxFiles": 10
  },
  "hooks": true,
  "adapterOptions": {}
}
```

The loop never reads defaults at runtime. Do not store base, commands, Jira identifiers, route,
host, selector, capabilities, credentials, or secrets there.

## Universal scaffold

Copy or reconcile all required tools. A tool importing another tool is not optional.

| Repository path | Template | Contract |
|---|---|---|
| `.autoloop/ci-policy.json` | `ci-policy.template.json` | Canonical schema-v1 complete required-CheckRun policy |
| `.autoloop/measurement-budget-policy.json` | `measurement-budget-policy.template.json` | Canonical version-1 retained-evidence budget gate |
| `tools/agentic/adapter-contract.mjs` | `tools/adapter-contract.mjs` | Static reviewer artifact validation |
| `tools/agentic/attestation-contract.mjs` | `tools/attestation-contract.mjs` | Exact-head gate/ownership/policy/authorization records |
| `tools/agentic/claim-contract.mjs` | `tools/claim-contract.mjs` | Canonical branch/body ownership parser |
| `tools/agentic/command-guard.mjs` | `tools/command-guard.mjs` | Structured command/ref guard |
| `tools/agentic/config-contract.mjs` | `tools/config-contract.mjs` | ProjectConfig and migration |
| `tools/agentic/continuation-store.mjs` | `tools/continuation-store.mjs` | Append-only, session-bound opencode relaunch state |
| `tools/agentic/contract-lint.mjs` | `tools/contract-lint.mjs` | Forward-artifact contract drift |
| `tools/agentic/delivery-contract.mjs` | `tools/delivery-contract.mjs` | Exact-head CI/delivery transition |
| `tools/agentic/escalate-paths.mjs` | `tools/escalate-paths.mjs` | Configured-base lane-proof CLI |
| `tools/agentic/intent-contract.mjs` | `tools/intent-contract.mjs` | Best-effort, one-use process-bound prompt transport |
| `tools/agentic/label-swap-reminder.mjs` | same name | Label transition reminder |
| `tools/agentic/lane-contract.mjs` | `tools/lane-contract.mjs` | Lane proof and shared path policy |
| `tools/agentic/lifecycle-contract.mjs` | `tools/lifecycle-contract.mjs` | Durable mutation recovery |
| `tools/agentic/lifecycle-driver.mjs` | `tools/lifecycle-driver.mjs` | Stable-read lifecycle effect executor and revision epochs |
| `tools/agentic/loop-scope.mjs` | `tools/loop-scope.mjs` | Loop PR scope |
| `tools/agentic/measurement-contract.mjs` | `tools/measurement-contract.mjs` | Versioned efficiency records |
| `tools/agentic/publish-verdict.mjs` | `tools/publish-verdict.mjs` | Universal exact-head terminal finalizer and CheckRun publisher |
| `tools/agentic/release-verify.mjs` | `tools/release-verify.mjs` | Portable release/version helpers |
| `tools/agentic/review-contract.mjs` | `tools/review-contract.mjs` | Convergence/human-block transition |
| `tools/agentic/route-adapter-contract.mjs` | `tools/route-adapter-contract.mjs` | Typed route attempt compilation |
| `tools/agentic/run-scope.mjs` | `tools/run-scope.mjs` | Runtime open/finish compatibility wrapper |
| `tools/agentic/runtime-contract.mjs` | `tools/runtime-contract.mjs` | Route/stage/capability/relaunch policy |
| `tools/agentic/scan.mjs` | `tools/scan.mjs` | Complete typed startup snapshot |
| `tools/agentic/snapshot-contract.mjs` | `tools/snapshot-contract.mjs` | Snapshot completeness and invalidation |
| `tools/agentic/session-preflight.sh` | same name | Session injection |
| `tools/agentic/stats.mjs` | `tools/stats.mjs` | Presentation statistics only |
| `tools/agentic/subagent-transcript.mjs` | same name | Non-routing host-subagent transcript telemetry |
| `tools/agentic/verify.mjs` | `tools/verify.mjs` | Canonical installed-contract verification |
| `tools/agentic/writeback-check.mjs` | same name | Canonical writeback checks |

`publish-verdict.mjs` is universal, including manual mode: it owns the sole exact-head terminal
transition from draft/premerge evidence to ready and delivered. Raw `gh pr ready` and raw
`loop-delivered` label mutations are forbidden. The non-manual merge authorization/reference tools
remain shipped, fail-closed test artifacts but v0.40 Setup never materializes or invokes
`tools/agentic/auto-merge.mjs`. The universal finalizer runs or binds manual gate/review evidence,
creates the head-bound premerge record, performs the ready/label effects, and reads every
postcondition back.

Write `.autoloop/ci-policy.json` as the exact canonical JSON serialization produced by
`canonicalCiPolicy()` with the explicitly confirmed complete CheckRun-name set. It is universal,
including manual installations. Doctor rejects a missing, noncanonical, or symlinked policy.
The shared lane policy treats this file as both human-authorized and merge-protected, so no loop PR
can weaken the CI set it is about to use for delivery.

For a fresh install, copy `measurement-budget-policy.template.json` byte-for-byte to
`.autoloop/measurement-budget-policy.json`. Its `pending-evidence` state is intentional:
verification reports `passed: false` and never invents a baseline, sample, limit, or successful
budget gate. Preserve an existing valid active policy during reconfiguration. Activate or change
entries only in a human-reviewed change after genuine authenticated raw-event safe-system and
post-optimization cohorts exist. Before activation, export exactly the policy record IDs with
`measurement-contract.mjs --export-evidence-bundle`, commit the canonical output as
`.autoloop/measurement-evidence-v1.json`, and bind its exact SHA-256 in the active policy. This is
the portable fresh-clone CI evidence path; never copy the private local store authority key. The
shared lane policy treats both files as human-authorized and merge-protected. The policy must
remain the exact canonical serialization accepted by
`measurement-contract.mjs --check-budget-policy`; missing, malformed, symlinked, digest-mismatched,
provisional, or regressed active policy evidence fails closed.

Always reconcile the route-enabling host artifacts:

- `.codex/agents/autoloop-reviewer.toml` from `codex-reviewer-agent.template.toml`
- `.opencode/agent/autoloop-reviewer.md` from `opencode-reviewer-agent.template.md`
- `opencode.json`, merged per key from `opencode-config.template.json`

Always reconcile `.claude/settings.json` from
`settings-hooks.template.json`, `.codex/hooks.json` from `codex-hooks.template.json` unless the
same project-layer hooks live in `.codex/config.toml`, and `.opencode/plugins/autoloop.js` from
`opencode-plugin.template.js`. Never duplicate Codex hook representations. Doctor fails if any
enabled host entrypoint is absent, inactive, or cannot retain one-use best-effort transport. It validates
every installed hook/plugin artifact; disabling one disables that host's Autoloop runtime and is
a doctor failure when the host remains configured.
Codex skips every new or hash-changed non-managed hook until a human trusts that exact definition.
After reconciling Codex hooks, instruct the user to open `/hooks`, review the source and hash, and
trust it; Setup never bypasses or manufactures that trust. A static verifier PASS proves shape and
tool targets only. Doctor reports effective activation/trust as a separate PASS; missing inventory
or an untrusted definition is a FAIL and is never called active.

Preserve maintainer edits, show diffs, and ask before replacing edited vendored artifacts. New
Codex agents and opencode agents/plugins require a fresh host session.

The Codex reviewer contract is:

- `name = "autoloop_reviewer"`
- `default_permissions = ":read-only"`
- `approval_policy = "never"`
- no model/provider/effort override
- no legacy `sandbox_mode`

Validate it through `adapter-contract.mjs`; Setup and doctor must not reproduce it with grep.
Healthy native-Codex review uses fresh external `codex exec --sandbox read-only`, including
docs/small lanes. No in-session `agent_type`/`fork_turns` fallback is part of v0.40; doctor neither
probes nor requires it.

The opencode reviewer must pass the shared closed-world adapter contract: wildcard deny first,
followed only by in-worktree read/glob/grep/list allows. Static validity of an inactive artifact is
a PASS for the artifact and a NOTE for effective runtime capability.

## One-call audit

Run one shell invocation after version and base resolution. Use the audited base materialized in a
temporary directory for doctor; do not diagnose a parked branch.

```bash
echo "=== toolchain ==="
gh auth status 2>&1 | head -3
node --version
codex --version 2>/dev/null || echo codex:absent
opencode --version 2>/dev/null || echo opencode:absent
echo "=== config ==="
node tools/agentic/config-contract.mjs docs/agentic/STATE.md 2>&1
echo "=== contracts ==="
node tools/agentic/verify.mjs --install-root .
echo "=== sizes ==="
wc -c docs/agentic/STATE.md docs/agentic/ARCH.md 2>/dev/null
```

A scan or audit section that fails is incomplete, not an empty success. Follow it with one targeted
check. STATE Lessons over 3000 bytes and ARCH over 8000 bytes are compaction NOTEs, not failures.

## Selected-route doctor

Doctor is read-only. Report `PASS`, `FAIL`, or `NOTE`, name the audited ref, active host, canonical
captured selector, selected engine, route, adapter, `intentProvenance`, and capability fingerprint.
Never say the selector was requested by a verified user.

Always check:

- installed/session version and release verifier;
- repository access, configured base, clean config validation, checklist, and gate executable;
- every universal tool/artifact present, importable, syntactically valid, and self-tested;
- shared STATE/path-policy fixtures, including `.opencode/**` and `.githooks/**`;
- hooks parse and refer only to present vendored tools;
- Codex hook shape/tool references separately from effective enablement and hash trust (unproven
  activation is a NOTE, not a PASS);
- open duplicate migration PRs;
- no stale profile-based routing prose in forward operational artifacts;
- static Codex and opencode reviewer contracts.

Then, on Linux, pass exact broker-issued `{hostEvidence,run}`, the selected route followed by its
independently authenticated/capable same-host native fallback, if any, and the absolute audited
repository root to
`--probe-json`. The broker binds authority internally and
the route adapter executes every capability smoke; presence checks, caller observations, and
static guesses cannot produce an available fact. Non-Linux doctor route probes fail closed with
`UNVERIFIABLE_ISOLATION`; macOS CI verifies portable static contracts only. Plan the
doctor stage from the returned Linux snapshot, then compile and execute it through the broker-only
process route-adapter sequence.
Doctor receives no writer/reviewer adapter tuning and never constructs a
capability success, status, effect, isolation result, or attempt outcome:

- Native Claude: authenticated Claude print mode, structured output, effective inline
  writer/reviewer sandbox policy, subprocess credential scrub and network denial, read-only
  writer Git metadata with broker-owned commit, plus read-only reviewer checkout.
- Native Codex: authenticated Codex `0.145.0+`, exact workspace-write/read-only process postures,
  structured verdict, read-only writer Git metadata with broker-owned commit, and effective
  process/read/network isolation.
- Native opencode: authenticated opencode `1.18.3+`, fresh `run --pure` sealed writer with exactly
  read/edit/glob/grep/list and read-only Git metadata, typed reviewer with exactly
  read/glob/grep/list, one terminal result, broker-owned networkless local commit after a valid
  complete writer result, private IPC, and forbidden continuation/session/share flags. The trusted
  engine retains provider transport for inference; no model-callable shell/network/custom/MCP
  surface exists.
- Claude→Codex: authenticated Codex `0.145.0+`, exact workspace-write/read-only launch flags,
  structured verdict, read-only writer Git metadata with broker-owned commit,
  process-authority sandbox, and network/isolation evidence.
- Claude→opencode: authenticated opencode `1.18.3+`, the same exact fresh sealed OpenCode
  writer/reviewer and broker-commit postures, process-authority sandbox, and forbidden
  continuation/session/share flags.

Unavailable inactive routes are NOTEs. A selected missing executable/authentication/version,
artifact, or isolation property is a typed capability FAIL. Never silently fall back during
doctor.

Any non-manual policy is a typed `UNVERIFIABLE_INVOCATION_PROVENANCE` failure before the route
probe. Do not invoke a merge, merge queue, tag publication, or release publication.

For every GitHub repository that can publish a release, doctor also runs:

```bash
node tools/agentic/release-verify.mjs --check-tag-policy --check-root .
node tools/agentic/release-verify.mjs --check-immutable-releases --check-root .
```

It binds the repository to the exact checkout origin and fails unless a live active `refs/tags/v*`
ruleset has no exclusions or bypass actors and forbids deletion and non-fast-forward updates, and
unless the live immutable-release setting reports `enabled=true`. Add
`--require-owner-enforcement` to the immutable-release command when organization-owner enforcement
is required; then `enforced_by_owner=true` is mandatory too.

Both checks require authenticated live GitHub API evidence. Set
`AUTOLOOP_RELEASE_POLICY_TOKEN` to a credential with Administration repository read and enough
ruleset access to disclose bypass actors. Missing, insufficient, or redacted authentication is a
doctor `FAIL`, never a `NOTE`. Setup may present the exact required controls but never mutates
repository or release protection without the user's explicit authorization.

## Write and delivery

Fresh install starts from templates. Reconfigure/migration preserves repo-owned mission,
invariants, tracker identifiers, checklist additions, lessons, dormant policy-reference config,
and any explicit extra protected paths.

Create lifecycle and step labels idempotently. Do not create non-manual policy labels.

Never mutate default/release branch protection, GitHub Apps, or credentials without explicit user
authorization. Present the exact desired settings and verify after changes.

Run:

1. every vendored tool self-test;
2. syntax/JSON/TOML checks;
3. scaffold-template-satisfies-adapter-doctor;
4. config extraction/validation;
5. Runtime route fixtures;
6. claim/lane/path cross-consumer fixtures;
7. release verification;
8. static stale-route lint.

Show the complete diff. A fresh install or migration is delivered through a PR by default. Never
auto-merge Setup's own change.

End with:

```text
∞ setup · complete
```

Doctor ends with:

```text
∞ setup · doctor complete
```

## Hard rules

- Never persist host, selector, selected engine, resolved route, capabilities, outages, or
  fallback state in ProjectConfig.
- Never infer active host from config, environment variables, files, or history.
- Never interpret legacy profile as current run intent.
- Never validate reviewer artifacts with prose/grep when the adapter contract exists.
- Never report an inactive route as effectively verified.
- Never let a missing optional fallback capability fail a healthy selected route.
- Never use incomplete evidence to prove absence.
- Never enable or invoke non-manual merge in v0.40.
