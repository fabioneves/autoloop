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
∞ setup · v0.40.0 · starting
```

If a tool call already happened, print the banner with the next output. Print it once.

Setup is idempotent and has four modes:

- Fresh install: `docs/agentic/STATE.md` is absent.
- Migration: STATE contains schema `0.24.0`.
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

A bare invocation means the active native route. A suffix is run-local intent. STATE, environment
variables, installed artifacts, old run records, and global defaults have zero routing authority.
Only these five routes exist:

| Active host | Requested engine | Route |
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
3. Determine the active host only from the live integration and effective tool surface. Produce
   exact host evidence for `RuntimeContract.open()`:

   ```json
   {
     "kind": "autoloop-host-evidence",
     "version": 1,
     "source": "live-integration",
     "observedHosts": ["claude"],
     "fingerprint": "<sha256 of the observed adapter/tool-surface facts>"
   }
   ```

   Exactly one of `claude`, `codex`, or `opencode` must be observed. Ambiguous or synthetic
   evidence is a failure.
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
6. Parse the invocation with `RuntimeContract.open()`. Doctor uses flow `doctor`. Do not maintain a
   prose route table or substitute another engine on failure.
7. Run the one-call audit below. Follow up only on failed or incomplete sections.

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
    "runWallClockHours": 4,
    "gateRetriesPerUnit": 2,
    "reviseRoundsPerPr": 3,
    "codeReviewRoundsPerUnit": 3,
    "sliceMaxLines": 500,
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

## Schema `0.24.0` migration

Use `migrateConfig024To025()` from `config-contract.mjs`; do not hand-transform JSON.

- Remove `runtime.supportedHosts` and `engine.profile`.
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
3. Gate, optional quick gate, and optional setup command.
4. Tracker: none or Jira; Jira requires epic key and cloud ID.
5. Review checklist path/content.
6. Numeric caps.
7. Optional tuning for the three adapter-option entries. State clearly that tuning cannot change
   the bare native route.
8. Extra human-authorization/protected paths.
9. Hooks: universal host hooks are recommended.
10. Optional agent-skills dependency.
11. Merge policy. Default and recommendation are `manual`.

Non-manual merge is unavailable until all of the following are explicitly configured and doctor
passes them:

- a dedicated least-privilege loop identity distinct from maintainer identities;
- trusted GitHub App IDs for gate/review/ownership/policy CheckRuns;
- a separately trusted producer for head-bound human authorization;
- complete required CI CheckRun names and App IDs;
- required approving review, stale-review dismissal, latest-push approval, resolved
  conversations, no force pushes/deletions, administrator enforcement, and no loop-actor bypass;
- either strict up-to-date direct merge, or a supported merge queue with `merge_group` CI and
  asynchronous recovery.

If any fact is missing, keep `merge.policy: manual`. Never infer that an empty required-check list
means CI is safe. The current public user-owned Autoloop repository uses direct strict protection;
merge queue support must be capability-detected per target repository.

Global defaults contain only non-project preferences:

```json
{
  "merge": { "policy": "manual" },
  "tracker": { "provider": "none" },
  "caps": {
    "runWallClockHours": 4,
    "gateRetriesPerUnit": 2,
    "reviseRoundsPerPr": 3,
    "codeReviewRoundsPerUnit": 3,
    "sliceMaxLines": 500,
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
| `tools/agentic/adapter-contract.mjs` | `tools/adapter-contract.mjs` | Static reviewer artifact validation |
| `tools/agentic/attestation-contract.mjs` | `tools/attestation-contract.mjs` | Exact-head ownership/policy/authorization records |
| `tools/agentic/claim-contract.mjs` | `tools/claim-contract.mjs` | Canonical branch/body ownership parser |
| `tools/agentic/command-guard.mjs` | `tools/command-guard.mjs` | Structured command/ref guard |
| `tools/agentic/config-contract.mjs` | `tools/config-contract.mjs` | ProjectConfig and migration |
| `tools/agentic/contract-lint.mjs` | `tools/contract-lint.mjs` | Forward-artifact contract drift |
| `tools/agentic/delivery-contract.mjs` | `tools/delivery-contract.mjs` | Exact-head CI/delivery transition |
| `tools/agentic/escalate-paths.mjs` | `tools/escalate-paths.mjs` | Configured-base lane-proof CLI |
| `tools/agentic/label-swap-reminder.mjs` | same name | Label transition reminder |
| `tools/agentic/lane-contract.mjs` | `tools/lane-contract.mjs` | Lane proof and shared path policy |
| `tools/agentic/lifecycle-contract.mjs` | `tools/lifecycle-contract.mjs` | Durable mutation recovery |
| `tools/agentic/loop-scope.mjs` | `tools/loop-scope.mjs` | Loop PR scope |
| `tools/agentic/measurement-contract.mjs` | `tools/measurement-contract.mjs` | Versioned efficiency records |
| `tools/agentic/release-verify.mjs` | `tools/release-verify.mjs` | Portable release/version helpers |
| `tools/agentic/review-contract.mjs` | `tools/review-contract.mjs` | Convergence/human-block transition |
| `tools/agentic/run-scope.mjs` | `tools/run-scope.mjs` | Runtime open/finish compatibility wrapper |
| `tools/agentic/runtime-contract.mjs` | `tools/runtime-contract.mjs` | Route/stage/capability/relaunch policy |
| `tools/agentic/scan.mjs` | `tools/scan.mjs` | Complete typed startup snapshot |
| `tools/agentic/snapshot-contract.mjs` | `tools/snapshot-contract.mjs` | Snapshot completeness and invalidation |
| `tools/agentic/session-preflight.sh` | same name | Session injection |
| `tools/agentic/stats.mjs` | `tools/stats.mjs` | Presentation statistics only |
| `tools/agentic/subagent-transcript.mjs` | same name | Attributable transcript capture |
| `tools/agentic/verify.mjs` | `tools/verify.mjs` | Canonical installed-contract verification |
| `tools/agentic/writeback-check.mjs` | same name | Canonical writeback checks |

`publish-verdict.mjs`, `merge-authorization-contract.mjs`, and a filled
`auto-merge.reference.mjs` are required only for a non-manual installation. Never invoke the
reference file. Build `tools/agentic/auto-merge.mjs` by preserving its repository-owned config
zone and reconciling the template-owned engine zone. Fill repository/base, required CI checks and
App IDs, loop login, trusted humans, automation/authorization App IDs, reversible/protected paths,
mode, and base-freshness strategy. Its self-test must pass. Any policy-content change ships through
a human-reviewed PR so the human merge re-ratifies it.

Always reconcile these host artifacts:

- `.claude/settings.json` from `settings-hooks.template.json`
- `.codex/hooks.json` from `codex-hooks.template.json`, unless the same project-layer hooks already
  live in `.codex/config.toml`; never duplicate both representations
- `.codex/agents/autoloop-reviewer.toml` from `codex-reviewer-agent.template.toml`
- `.opencode/agent/autoloop-reviewer.md` from `opencode-reviewer-agent.template.md`
- `.opencode/plugins/autoloop.js` from `opencode-plugin.template.js`
- `opencode.json`, merged per key from `opencode-config.template.json`

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
docs/small lanes. In-session `agent_type`/`fork_turns` checks apply only if the degraded fallback
is selected or reachable. They cannot fail a healthy external-exec route.

The opencode reviewer must pass the shared deny-stripped adapter contract. Static validity of an
inactive artifact is a PASS for the artifact and a NOTE for effective runtime capability.

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
raw selector, requested engine, route, adapter, and capability fingerprint.

Always check:

- installed/session version and release verifier;
- repository access, configured base, clean config validation, checklist, and gate executable;
- every universal tool/artifact present, importable, syntactically valid, and self-tested;
- shared STATE/path-policy fixtures, including `.opencode/**` and `.githooks/**`;
- hooks parse and refer only to present vendored tools;
- open duplicate migration PRs;
- no stale profile-based routing prose in forward operational artifacts;
- static Codex and opencode reviewer contracts.

Then probe only the selected route and reachable fallback according to
`RuntimeContract.plan()`:

- Native Claude: fresh Agent-tool writer/reviewer surfaces and read-only reviewer posture.
- Native Codex: worker surface plus authenticated Codex `0.145.0+`; external
  `codex exec --sandbox read-only` reviewer and effective isolation. Probe typed in-session
  fallback fields only if that degraded fallback is selected/reachable.
- Native opencode: opencode `1.18.3+`, fresh task writer, typed reviewer with
  edit/bash/task/webfetch/websearch absent.
- Claude→Codex: authenticated Codex `0.145.0+`, exact workspace-write/read-only launch flags,
  structured verdict, and network/isolation evidence.
- Claude→opencode: authenticated opencode `1.18.3+`, exact fresh `opencode run` transport, typed
  reviewer, and forbidden continuation/session/share flags.

Unavailable inactive routes are NOTEs. A selected missing executable/authentication/version,
artifact, or isolation property is a typed capability FAIL. Never silently fall back during
doctor.

For non-manual policy, also fail unless the dedicated identity, trusted producer IDs, CheckRun
contracts, complete ownership/lifecycle attestations, branch/ruleset controls, strict direct or
queue strategy, and no-bypass result are all proven. A live `--dry-run` must refuse a deliberately
incomplete fixture. Do not invoke a real merge.

## Write and delivery

Fresh install starts from templates. Reconfigure/migration preserves repo-owned mission,
invariants, tracker identifiers, checklist additions, lessons, auto-merge config zone, and any
explicit extra protected paths.

Create labels idempotently. All installations use lifecycle and step labels; non-manual
installations additionally use the ratified-risk and kill-switch labels.

Never mutate default/release branch protection, GitHub Apps, credentials, or non-manual policy
without explicit user authorization. Present the exact desired settings and verify after changes.

Run:

1. every vendored tool self-test;
2. syntax/JSON/TOML checks;
3. scaffold-template-satisfies-adapter-doctor;
4. config extraction/validation;
5. Runtime route fixtures;
6. claim/lane/path cross-consumer fixtures;
7. release verification;
8. static stale-route lint.

Show the complete diff. A fresh install or migration is delivered through a PR by default. A
non-manual configuration always requires a human-reviewed PR. Never auto-merge Setup's own policy
change.

End with:

```text
∞ setup · complete
```

Doctor ends with:

```text
∞ setup · doctor complete
```

## Hard rules

- Never persist host, selector, requested engine, resolved route, capabilities, outages, or
  fallback state in ProjectConfig.
- Never infer active host from config, environment variables, files, or history.
- Never interpret legacy profile as current run intent.
- Never validate reviewer artifacts with prose/grep when the adapter contract exists.
- Never report an inactive route as effectively verified.
- Never let a missing optional fallback capability fail a healthy selected route.
- Never use incomplete evidence to prove absence.
- Never enable or invoke non-manual merge before every architecture and authorization bar passes.
