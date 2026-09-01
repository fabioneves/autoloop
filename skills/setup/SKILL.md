---
name: setup
description: Scaffold, migrate, reconfigure, or diagnose Autoloop from Claude Code, Codex CLI, or opencode. Repository artifacts support all three hosts; doctor is read-only and verifies contracts, artifacts, and configuration.
---

# autoloop:setup — scaffold / migrate / reconfigure / doctor

Your first output, before a tool call or question, is exactly:

```text
┌─┐ ┬ ┬ ┌┬┐ ┌─┐ ┬   ┌─┐ ┌─┐ ┌─┐
├─┤ │ │  │  │ │ │   │ │ │ │ ├─┘
┴ ┴ └─┘  ┴  └─┘ ┴─┘ └─┘ └─┘ ┴
∞ setup · v0.49.66 · starting
```

If a tool call already happened, print the banner with the next output. Print it once.

Mark each phase with a state badge (⏳ in progress · ❌ blocked · ⚠️ needs a human) and a
five-cell ribbon in the same `∞` visual language — `▰` for done-or-current, `▱` for remaining —
as the phase begins:

```text
⏳ ∞ ▰▱▱▱▱ 1/5 RESOLVE ─ version · mode · base
⏳ ∞ ▰▰▱▱▱ 2/5 AUDIT ─ one-call battery
⏳ ∞ ▰▰▰▱▱ 3/5 INTERVIEW ─ decisions only
⏳ ∞ ▰▰▰▰▱ 4/5 WRITE ─ reconcile · visible diff
⏳ ∞ ▰▰▰▰▰ 5/5 VERIFY ─ evidence · delivery
```

Do not re-print a phase's ribbon when it completes — ✅ belongs only on the closing rail.

Doctor mode replaces the ribbon with its own single line: `∞ doctor ─ <audited ref>`.

Setup is idempotent and has four modes:

- Fresh install: `docs/agentic/STATE.md` is absent.
- Migration: STATE contains a migratable schema older than `0.26.0` (`0.23.0`, `0.24.0`, or
  `0.25.0`).
- Reconfigure: STATE contains schema `0.26.0`.
- Doctor: the invocation contains `doctor`; read-only and never writes.

The repository scaffold is universal. It contains safe artifacts for Claude Code, Codex, and
opencode so switching hosts does not require reconfiguration. Role dispatch does not depend on the
host: `tools/agentic/dispatch.mjs` spawns `claude -p` directly for every role.

```text
/autoloop:setup
/autoloop:setup doctor
```

Codex uses `$autoloop:setup doctor`; opencode invokes the `setup` skill with `doctor`.

## Prime

1. Resolve this skill's real path, then `templates/` at the PLUGIN ROOT — two levels up from the
   skill directory: `<skill dir>/../../templates`. It is a sibling of `skills/`, not of this
   skill's own directory; a live session read "sibling" the natural way and looked for
   `skills/setup/templates/`, which does not exist. Do not depend on `CLAUDE_PLUGIN_ROOT`,
   `PLUGIN_ROOT`, or another compatibility variable.
2. Print the banner.
3. Check version currency before deriving drift. In a versioned plugin cache, this is ONE
   complete pipeline — expand `<cache>` to the versions directory two levels above `<templates>`
   and run it as written, composing nothing:

   ```bash
   ls <cache> | node <templates>/tools/release-verify.mjs --sort-versions | tail -3
   ```

   `tail -3` on purpose: only the newest versions answer the currency question, and a mature
   cache holds dozens — a live one printed 87 lines to learn one. No pre-cleaning exists:
   `--sort-versions` takes the basename of path lines itself, so even `ls -d <cache>/*/` output
   sorts correctly. Never add `xargs -n1 basename` to the pipe — the guard refuses `xargs` on
   sight, and two live setups have lost their first command to exactly that decoration.

   In a live tree, compare the loaded banner with `VERSION` and the banner on disk. A newer disk
   version means this session is stale: setup/migration stops; doctor reports FAIL and asks for a
   fresh session.
4. Fetch the configured base and audit `origin/<base>`, not the parked checkout. Until STATE is
   parsed, use the repository default only to find an existing STATE; then switch the audit ref to
   `cfg.baseBranch`. A unit branch's older files are a NOTE, never drift evidence.

   **Then obey the configured base with the checkout, not just the audit ref.** On a clean tree,
   fetch and switch to `cfg.baseBranch` and pull fast-forward before auditing — the same rule Dev
   applies at Prime. Auditing the right ref is not enough on its own: the hooks load
   `$CLAUDE_PROJECT_DIR/tools/agentic/*`, so the command guard, this preflight and the label hooks
   all run the WORKING TREE's copies. A session parked on a unit branch executes the tools that
   branch forked with, however current the base is — which is how a guard fix that had shipped,
   installed and reconciled onto the base stayed inert for three separate sessions, each of which
   then misdiagnosed the block as a new bug.

   A dirty tree or an in-flight loop unit is human work: stop with the remedy and never stash,
   discard, or relocate it. Finish or park the unit first, then run Setup from the base.
5. Run the one-call audit below. Follow up only on failed or incomplete sections.

Every contract call names the copy it runs. Before the scaffold reconciliation lands, run contracts
from the plugin root's `<templates>/tools/`: the repository's `tools/agentic/` copies are
still the pre-migration ones, so they can only validate the pre-migration artifacts they shipped
with. After reconciliation, verify the installed `tools/agentic/` copies produce the same results.
The one-call audit below is the deliberate exception — it reads the installed copies because the
installed copies are what it audits. Setup never fabricates contract output in prose or trusts an
older installed contract to validate its own migration.

## Project configuration

Schema `0.26.0` stores repository policy, never session intent:

```json autoloop-config
{
  "version": "0.26.0",
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
    "reviseRoundsPerPr": 10,
    "codeReviewRoundsPerUnit": 20,
    "sliceMaxLines": 700,
    "sliceMaxFiles": 10
  }
}
```

There are no other keys. `runtime`, `engine`, `adapterOptions`, and `measurement` were retired
with the machinery they configured; the schema rejects them outright.

Validate configuration only through `config-contract.mjs`. Unknown keys, invalid enums, unsafe
paths/model identifiers, commands with control characters, or out-of-range caps fail. Doctor also
checks that each configured command's executable is discoverable — `config-contract.mjs --resolve`,
which examines the first word against PATH and executes nothing — and that the checklist exists at
the audited base ref.

## Schema migration

Use `migrateProjectConfig()` from `<templates>/tools/config-contract.mjs`; do not hand-transform
JSON and do not call
a single version step directly. It reads the configuration's own version and applies the ordered
chain until the current schema, so a caller never names a version pair. `MIGRATABLE_CONFIG_VERSIONS`
lists what it accepts; anything else is a typed `UNSUPPORTED_CONFIG_VERSION` rather than a silent
pass.

From `0.23.0` it first adds the fields that version predates — `gate.quickCommand`,
`caps.codeReviewRoundsPerUnit`, and the `engine.opencode` block — then continues through the
`0.24.0` and `0.25.0` steps below. A Jira tracker still requires supplemental facts, and the typed
`MIGRATION_INPUT_REQUIRED` result names exactly which.

- Remove `runtime.supportedHosts` and `engine.profile`.
- Remove `caps.runWallClockHours`; v0.40 queue runs have no fixed whole-run clock ceiling.
- Reset a `ratified` or `auto` merge policy to `manual` first, because migration must not carry an
  unattended merge nobody re-confirmed. Then ask (see the merge-policy question below): the value is
  not retired, and the human may restore it.
- Never convert the legacy profile into current invocation intent.
- Report dormant or unmappable tuning rather than activating it.
- For Jira, ask for and confirm `epicKey` and Atlassian `cloudId`; pass them as
  `migrationFacts.tracker`. Missing facts are `MIGRATION_INPUT_REQUIRED`, not values to infer.
- From `0.25.0`, drop `adapterOptions` and `measurement`. Both are pure removals: the migration
  names each removed key in its warnings and carries every remaining value across unchanged,
  including `merge.policy` and both acknowledgements.
- Reconcile every template-derived operational section and universal host artifact in the same
  migration (`--reconcile` plus the STATE/LOOP merge under Write and delivery). A version-only
  migration is forbidden.
- Validate the migrated configuration with `<templates>/tools/config-contract.mjs`, never
  `tools/agentic/config-contract.mjs`, because the validator that accepts the new schema only
  arrives with the reconcile — the installed one rejects the migrated block on its version
  literal.

Show the old config, migrated config, warnings, and artifact diff before writing.

## Fresh-install and reconfigure questions

Use structured questions when the host provides them; otherwise ask one concise question at a
time. Global defaults may pre-fill answers but never skip confirmation.

Scale the interview to the mode. A fresh install walks every item. Migration and reconfigure
collapse to one summary table — every current value beside its default or migrated value — and a
single accept-all confirmation, expanding an item into its own question only where it carries a
real decision: drift, **the gate**, **every `needs-human-review` STATE section**, a cap the human
may want to change, or the merge policy. Fewer questions, never fewer disclosures: everything still
appears in the summary and the visible diff.

An accept-all that silently swallows a decision is not a shorter interview, it is a missing one —
and the two items added to that list were both found by a human noticing their absence rather than
by anything in this skill.

Ask only:

1. Mission and non-negotiable invariants.
2. Configured base branch.
3. Gate, optional quick gate, optional setup command. **Do not ask for a required CI CheckRun-name
   set** — there is no longer one to configure. It was retired with `.autoloop/ci-policy.json` in
   v0.49.0, and delivery's predicate is the live triggered-checks floor: every check run and commit
   status on the exact head must be green, read at delivery time. `delivery-contract.mjs` says so
   in its own header — "there is deliberately no committed required-check list". A question whose
   answer nothing reads is worse than no question: it spends the human's attention and then implies
   the value matters.

   **Ask in EVERY mode, including reconfigure and migration, and show the configured commands
   verbatim beside what they resolve to.** The gate is the one setting that decides whether code
   ships, and the only one whose value is an executable that can rot without changing: a script
   the repository deleted, a compose service that got renamed, a package script that moved. A cap
   preserved across a migration is merely unexamined; a gate command preserved across a migration
   can be pointing at nothing, and the run finds out at step 09 on a converged artifact. Same
   reasoning the caps item gives — a preserved value the human never saw is indistinguishable from
   a silent one — applied to the value where being wrong costs the most.

   State whether each configured command **resolves right now** — with the tool, never a shell probe:

   ```bash
   node <templates>/tools/config-contract.mjs --resolve <repo>/docs/agentic/STATE.md
   ```

   It prints one PASS/FAIL line per configured gate command and exits non-zero if any executable is
   absent. Use it rather than composing `command -v <exe>`: that probe runs against the repository's
   OWN vendored guard, and during Setup that guard is the PRE-RECONCILE copy — a live audit was
   refused by the very file the reconcile was about to replace, which is a bootstrap the session
   cannot argue its way out of. Report what is missing; never repair it, and never substitute a
   command the human did not choose. A gate that cannot resolve is a finding for the human, not a
   gap for Setup to fill.
4. Tracker: none or Jira; Jira requires epic key and cloud ID.
5. Review checklist path/content.
6. Numeric caps. Show every cap with its current value and the scaffold default side by side, and
   offer to change any of them; accepting all is one keystroke. Call out `sliceMaxLines` and
   `codeReviewRoundsPerUnit` explicitly — they set slice size and review convergence, so they shape
   cost and cycle time more than the rest. A migrated repository keeps its own values, which is why
   they must be shown: a preserved value the human never saw is indistinguishable from a silent one.
7. Extra human-authorization/protected paths.
8. Optional agent-skills dependency.
9. Merge policy. Default `manual`. Show the current policy in every interview and offer to change
    it — migration history is not a reliable trigger, because an earlier migration may already have
    reset a non-manual policy before this question existed. When the repository is on, or is
    migrating from, `ratified` or `auto`, ask explicitly whether to restore it rather than
    resetting silently. Explain in one
    sentence what the human is accepting: no supported invocation transport can prove a human
    requested a run, so an unauthenticated trigger can merge. Restoring it writes both
    `merge.policy` and `merge.unverifiedInvocationAcknowledged: true`; the merge gate refuses the
    policy without that field. Configured base protection is what stands behind a non-manual
    policy.
    For a single-identity repository — the loop necessarily runs under the only maintainer's own
    login — additionally offer solo-operator mode, and only after the non-manual acknowledgement
    is accepted. Explain in one sentence what it waives and why: identity separation, App
    attestation, live server-policy verification, and the approving-review requirement are
    unsatisfiable with one login (GitHub forbids self-approval, and the gate would otherwise
    demand a second trusted human), while exact-head CAS merge, CI on the exact head, ownership
    binding, protected paths, and the kill switch keep full strength. Accepting writes
    `merge.soloOperatorAcknowledged: true` alongside the invocation acknowledgement; the schema
    rejects the flag without it. Never offer solo mode when more than one trusted human exists —
    the gate hard-fails a solo config whose trusted list is not exactly the loop login.

    **The answer determines `AUTOMERGE_MODE` in the vendored merge executor — derive it, never pick
    it separately.** `auto` writes `'all-green'`; `ratified` writes `'classified'`. That constant is
    the ONLY one the gate reads: it computes the contract's `mergePolicy`, and the committed
    `merge.policy` is never consulted at runtime. Writing `'classified'` for a repository that
    answered `auto` leaves a config whose merge setting does nothing, and the refusal blames a
    `ratified` policy the config never names. That happened: a live repository answered `auto`, got
    `'classified'`, and every code pull request was refused as unclassified — the maintainer's
    reasonable reading was that `auto` means merge, and nothing pointed at the constant.

    **`ratified` has two more values, and they were never asked for either.** The executor's comment
    says `REVERSIBLE_PATHS` is widened "only by explicit user choice" — but nothing ever offered the
    choice, so `['docs/**']` was imposed and then documented as a decision the human had made. Under
    `ratified` that list IS Path B, so a repository got docs-only auto-merge without knowing it was
    configurable. When and only when the answer is `ratified`:
    - **ASK for `REVERSIBLE_PATHS`** — it is repo config, above the executor's `end repo config`
      marker. Offer `['docs/**']` and state the matching rules: `**` crosses path segments, `*` stays
      inside one, matching is case-insensitive, and **every** current and previous path must match, so
      a rename across the boundary never qualifies. Widening it cannot expose a protected path — the
      protected families veto independently — so ask it plainly rather than hedging.
    - **DISCLOSE `SAFE_LABELS`, never ask** — `risk:pure-deletion` and `risk:mechanical-refactor` sit
      BELOW that marker, in the generic engine, so they are a fixed vocabulary and not a per-repo
      choice. Name them anyway: Path A is the per-pull-request escape hatch, and a maintainer who does
      not know the labels exist cannot use the one mechanism that merges a change outside the
      allowlist. Both labels must exist in the repository for it to work.

    Both are meaningless under `auto`, which subsumes Path B, and must not be presented as controls
    there — offering an inert setting is its own way of misleading someone about what governs a merge.

Never infer that green CI means the run may finish itself. Merge, merge queue, tag publication, and
release publication require an independent maintainer action outside the run. Delivery's own
predicate is the triggered-checks floor — every check run and commit status on the exact head
green, and at least one actually triggered, since a head that ran nothing is not a head that
passed.

Global defaults contain only non-project preferences:

```json
{
  "merge": { "policy": "manual" },
  "tracker": { "provider": "none" },
  "caps": {
    "gateRetriesPerUnit": 2,
    "reviseRoundsPerPr": 10,
    "codeReviewRoundsPerUnit": 20,
    "sliceMaxLines": 700,
    "sliceMaxFiles": 10
  },
  "hooks": true
}
```

The loop never reads defaults at runtime. Do not store base, commands, Jira identifiers,
credentials, or secrets there.

## Universal scaffold

Copy or reconcile all required tools. A tool importing another tool is not optional.

| Repository path | Template | Contract |
|---|---|---|
| `docs/agentic/LESSONS.md` | `LESSONS.template.md` | Durable repository memory — seeded once, never overwritten, read on demand |
| `tools/agentic/adapter-contract.mjs` | `tools/adapter-contract.mjs` | Static reviewer artifact validation |
| `tools/agentic/attestation-contract.mjs` | `tools/attestation-contract.mjs` | Exact-head gate/policy/authorization records |
| `tools/agentic/checkout-contract.mjs` | `tools/checkout-contract.mjs` | Stable checkout and GitHub repository identity |
| `tools/agentic/claim-contract.mjs` | `tools/claim-contract.mjs` | Canonical branch/body ownership parser |
| `tools/agentic/command-guard.mjs` | `tools/command-guard.mjs` | Structured command/ref guard |
| `tools/agentic/config-contract.mjs` | `tools/config-contract.mjs` | ProjectConfig and migration |
| `tools/agentic/contract-lint.mjs` | `tools/contract-lint.mjs` | Forward-artifact contract drift |
| `tools/agentic/delivery-contract.mjs` | `tools/delivery-contract.mjs` | Exact-head CI/delivery transition |
| `tools/agentic/dispatch.mjs` | `tools/dispatch.mjs` | One-call role dispatch with fixed tool postures |
| `tools/agentic/escalate-paths.mjs` | `tools/escalate-paths.mjs` | Configured-base lane-proof CLI |
| `tools/agentic/label-swap-reminder.mjs` | same name | Label transition reminder |
| `tools/agentic/lane-contract.mjs` | `tools/lane-contract.mjs` | Lane proof and shared path policy |
| `tools/agentic/lifecycle-contract.mjs` | `tools/lifecycle-contract.mjs` | Durable mutation recovery |
| `tools/agentic/lifecycle-driver.mjs` | `tools/lifecycle-driver.mjs` | Stable-read lifecycle effect executor and revision epochs |
| `tools/agentic/loop-scope.mjs` | `tools/loop-scope.mjs` | Loop PR scope |
| `tools/agentic/loop-smoke.mjs` | `tools/loop-smoke.mjs` | No-model end-to-end loop smoke |
| `tools/agentic/prime.mjs` | `tools/prime.mjs` | One-call config, base, and snapshot prime |
| `tools/agentic/publish-verdict.mjs` | `tools/publish-verdict.mjs` | Universal exact-head terminal finalizer and CheckRun publisher |
| `tools/agentic/release-verify.mjs` | `tools/release-verify.mjs` | Portable release/version helpers |
| `tools/agentic/review-contract.mjs` | `tools/review-contract.mjs` | Convergence/human-block transition |
| `tools/agentic/scan.mjs` | `tools/scan.mjs` | Complete typed startup snapshot |
| `tools/agentic/snapshot-contract.mjs` | `tools/snapshot-contract.mjs` | Snapshot completeness and invalidation |
| `tools/agentic/session-preflight.sh` | same name | Session injection |
| `tools/agentic/stats.mjs` | `tools/stats.mjs` | Presentation statistics only |
| `tools/agentic/subagent-transcript.mjs` | same name | Host-subagent transcript telemetry |
| `tools/agentic/verify.mjs` | `tools/verify.mjs` | Canonical installed-contract verification |
| `tools/agentic/writeback-check.mjs` | same name | Canonical writeback checks |

`publish-verdict.mjs` is universal, including manual mode: it owns the sole exact-head terminal
transition from draft/premerge evidence to ready and delivered. Raw `gh pr ready` and raw
`loop-delivered` label mutations are forbidden. The non-manual merge authorization tools are vendored exactly when ProjectConfig records an
acknowledged non-manual policy — `scaffold.mjs` derives the tool set from the configuration — and
removed when the policy returns to `manual`. Setup itself never invokes
`tools/agentic/auto-merge.mjs`. The universal finalizer runs or binds manual gate/review evidence,
creates the head-bound premerge record, performs the ready/label effects, and reads every
postcondition back.

After vendoring for an acknowledged non-manual policy, Setup fills the vendored file's REPO CONFIG
block in the same visible diff — a placeholder block refuses every invocation, so an unfilled
vendor is an incomplete setup, not a safe default. Fill `REPOSITORY` from `gh repo view` and
`LOOP_LOGIN` from `gh api user`. Non-manual is solo-only (docs/specs/simple-delivery.md): the
config requires `merge.soloOperatorAcknowledged: true` plus
`merge.unverifiedInvocationAcknowledged: true`, and the vendored block sets `SOLO_OPERATOR = true`,
`TRUSTED_HUMAN_LOGINS = [LOOP_LOGIN]`, and `REQUIRED_APPROVING_REVIEW_COUNT = 0`. Then run the
vendored file's `--self-test` (its fixtures derive from the block) and show the result as
evidence. Reconciliation never overwrites a filled block: `scaffold.mjs` reports the modified file
as `kept-modified` for visible-diff reconciliation.

There is no committed CI policy: delivery's CI predicate is the triggered-checks floor — every
check run and commit status on the exact head must be green, read live. If a configured repo still
carries `.autoloop/ci-policy.json`, reconcile removes it in the visible diff and the report says
so; doctor treats a lingering copy as a finding.

**Never probe for it with `ls`.** The reconcile report states the outcome either way —
`action: "removed"` or `action: "absent"` — and `verify.mjs` carries the named
`retired CI policy absent` check. A probe adds nothing and actively misleads: `ls` on a file that
is correctly gone prints `No such file or directory`, so the SUCCESS case renders as an error and
the next reader debugs a passing check. This is the same rule the proxy preflight follows for the
same reason — read the typed report, do not re-derive what it already states.

Always reconcile the host artifacts:

- `.codex/agents/autoloop-reviewer.toml` from `codex-reviewer-agent.template.toml`
- `.opencode/agent/autoloop-reviewer.md` from `opencode-reviewer-agent.template.md`
- `.opencode/opencode.json`, merged per key from `opencode-config.template.json`. opencode reads
  project configuration from either the repository root or `.opencode/`; Autoloop keeps it in
  `.opencode/` so the scaffold adds nothing loose to the project root. When a legacy root
  `opencode.json` exists, merge it into `.opencode/opencode.json` and delete the root copy in the
  same visible diff.

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

Perform the mechanical reconciliation with one call, never file-by-file model work:

```bash
node <templates>/tools/scaffold.mjs --reconcile <repository root>
```

It vendors the policy-derived tool set (adding the non-manual merge tools only under an
acknowledged non-manual ProjectConfig and removing them on return to `manual`), refreshes host
artifacts, merges hooks and `.opencode/opencode.json` without clobbering repository-owned entries,
folds a legacy root `opencode.json` into `.opencode/`, and returns a typed report. Present that
report; hand-copy nothing it covers. What it deliberately leaves to the model and human:
the checklist, anything it reports `kept-modified` (a policy-bearing
tool such as `escalate-paths.mjs` whose repository copy differs), and the visible diff and commit.
STATE and LOOP prose is the merge under Write and delivery — one call per document, never hand
work.

Preserve maintainer edits, show diffs, and ask before replacing edited vendored artifacts. New
Codex agents and opencode agents/plugins require a fresh host session.

The Codex reviewer contract is:

- `name = "autoloop_reviewer"`
- `default_permissions = ":read-only"`
- `approval_policy = "never"`
- no model/provider/effort override
- no legacy `sandbox_mode`

Validate it through `<templates>/tools/adapter-contract.mjs` before the reconcile lands and through
the installed copy after; Setup and doctor must not reproduce it with grep.
These artifacts define the read-only reviewer posture each host offers its own subagents; role
dispatch itself does not use them.

The opencode reviewer must pass the shared closed-world adapter contract: wildcard deny first,
followed only by in-worktree read/glob/grep/list allows.

## One-call audit

**Trust the preflight before re-deriving it.** The SessionStart hook already ran
`session-preflight.sh` and its output is in context: gh auth and repo access, node, codex, the
config contract, the release self-test, dispatch presence, clean-checkout state, checkout-vs-base
identity, and vendored-vs-installed drift. When that block is present and free of FAIL lines, do
not spend calls re-proving its facts — a live reconcile acknowledged "preflight already tells me"
and then re-ran every check anyway. Re-derive a fact only when the preflight is absent (no
vendored hooks yet), stale (the session predates a plugin change), or FAILing on that fact.

**Reconfigure/reconcile fast path.** With a green preflight, the audit is two sections:

```bash
echo "=== artifact drift ==="
node <templates>/tools/scaffold.mjs --audit .
echo "=== sizes ==="
wc -c docs/agentic/*.md 2>/dev/null || true
```

`verify.mjs --install-root` is deliberately NOT here: the VERIFY phase runs it after the write,
against the state that ships. Running it in AUDIT too proves the pre-write install twice per
setup — the pre-write state matters in migration and doctor, and only there.

**Full battery — fresh install, migration, doctor, or a missing/FAILing preflight.** One shell
invocation; for doctor, use the audited base materialized in a temporary directory rather than
diagnosing a parked branch.

```bash
echo "=== toolchain ==="
gh auth status 2>&1 | head -3
node --version
codex --version 2>/dev/null || echo codex:absent
opencode --version 2>/dev/null || echo opencode:absent
echo "=== config ==="
node tools/agentic/config-contract.mjs docs/agentic/STATE.md 2>&1
echo "=== contracts ==="
node tools/agentic/verify.mjs --install-root . 2>&1 | tee /tmp/autoloop-verify-audit.txt | grep -vE '^PASS ' || true
tail -2 /tmp/autoloop-verify-audit.txt
echo "=== artifact drift ==="
node <templates>/tools/scaffold.mjs --audit .
echo "=== sizes ==="
wc -c docs/agentic/*.md 2>/dev/null || true
```

**Read the battery by its SECTIONS, never by its exit code.** It is a diagnostic chain, so its
status is whatever the last command happened to return — and the two commands most likely to end
it fail on a HEALTHY repository: `grep -v '^PASS '` exits 1 precisely when every check passed and
it matches nothing, and `wc` exits 1 when an optional file like `ARCH.md` is absent. Both now
carry `|| true` for that reason. A live setup read the resulting `exit code 1` as a failed audit
when nothing had failed. If you want a pass/fail signal, run `verify.mjs --install-root` on its
own and read ITS status.

A scan or audit section that fails is incomplete, not an empty success. Follow it with one targeted
check. `docs/agentic/LESSONS.md` over 6000 bytes and ARCH over 8000 bytes are compaction NOTEs,
not failures; the reconcile battery raises both as warnings naming the curation rule.

### No improvised inspection

The battery above is guard-clean as written. Follow-up checks must be too, and the ones reached for
first usually are not: `node -e '<js>'` to call a contract, and `awk '<program>'` to measure a
section, are both refused by policy — an inline interpreter and a non-file-backed awk are
executable source the guard cannot read. Observed on consecutive setup runs, each spending a
refused call and a retry on the same two shapes.

The block is the policy working, never an error to engineer around. Compose the follow-up
correctly the first time:

- **substitute the real path** wherever this skill writes `<templates>` — write the literal
  directory, never a shell variable standing in for it. A variable is one more thing the guard has
  to resolve, and it buys nothing in a command written once;
- **to call a contract**, run its CLI directly (`node <templates>/tools/<tool>.mjs …`) or write a
  small script to the scratchpad and run the file — never `node -e`;
- **to measure a section**, use `wc -c`, `grep -c`, or `sed -n` — never an awk program;
- **to read a section's bytes**, `sed -n '/^## Heading/,$p'` reads what an awk range would;
- **compose every PR, issue, or comment body in a file.** `gh pr create --body "$(cat …)"` is
  command substitution and is refused whole; `gh` has the sanctioned flag built in — write the body
  to the scratchpad and pass `--body-file <path>`. Same for commit messages: `git commit -F -` with
  a quoted heredoc, or `-F <path>`. Observed live: a reconcile delivery lost a call to exactly this.
- **never write `$?` at all** — not after `;`, not after `&&`, under any variable name. It cannot be
  resolved without running the command, so it is opaque by construction and takes the whole
  invocation down with it, including the useful part in front of it. It also conveys nothing: the
  tool result already carries the exit status, and after `&&` the echo runs only when the command
  already succeeded, so `A && echo "ok=$?"` can print nothing but `0`. Observed four times in one
  day across three different spellings, each costing a refused call and a retry.

The `config` and `contracts` sections above deliberately run the repository's installed copies:
they report the pre-migration install as it stands, which is the thing being audited. A legacy
schema failing there is the migration signal, not an error to chase. Every validation *after* a
write runs from `<templates>/tools/` until the reconcile has landed.

Cost discipline — the verify battery is seconds, not minutes, but only when used as designed:

- Install-root verify applies the release-proven fast path automatically: a vendored tool whose
  bytes match the shipped `self-test-manifest.json` prints `PASS self-test <name>
  (release-proven)` without spawning, and only modified tools (the Setup-filled
  `auto-merge.mjs`, a repo-owned `escalate-paths.mjs`) self-test live, so the battery normally
  costs ~10-20 seconds. When a byte-identical tool is itself under suspicion, rerun with
  `--full` to spawn every self-test — expect minutes of wall clock in that mode.
- Capture its output ONCE (the `tee` above) and derive every later view from the capture. Never
  run the same verify twice to get a different `grep`/`tail` of identical output.
- `scaffold.mjs --audit` returns the complete would-be reconciliation as the same typed report
  with zero writes — it replaces every file-by-file `diff`/`cmp` of vendored tools and host
  artifacts during the audit. When you do diff a `kept`/`kept-modified` artifact by hand, diff
  against the report entry's `source` field — every template-backed entry names its exact
  template path, including through renames (`tools/agentic/auto-merge.mjs` reports
  `templates/tools/auto-merge.reference.mjs`; there is no `auto-merge.mjs` template). Manual per-artifact diffing is the anti-pattern that made a live
  setup run take twenty minutes; diff by hand only the artifacts the audit reports as
  `kept`/`kept-modified` (repo-owned prose and policy), never the mechanical set.
  `docs/agentic/LOOP.md` reported `kept` is not one of them: it is merged by
  `scaffold.mjs --merge-loop`, whose report is the review surface.
- The whole verify battery runs at most TWICE per session: once in this audit, once as the
  delivery evidence after writes. A reconcile that reports only `identical`/`kept` actions
  needs no second verify at all — cite the audit capture.

## Doctor

Doctor is read-only. Report `PASS`, `FAIL`, or `NOTE` and name the audited ref.

Always check:

- installed/session version and release verifier;
- repository access, configured base, clean config validation, checklist, and gate executable;
- every universal tool/artifact present, importable, syntactically valid, and self-tested;
- shared STATE/path-policy fixtures, including `.opencode/**` and `.githooks/**`;
- hooks parse and refer only to present vendored tools;
- Codex hook shape/tool references separately from effective enablement and hash trust (unproven
  activation is a NOTE, not a PASS);
- **`AUTOMERGE_MODE` agrees with the committed `merge.policy`.** Do not re-derive this by reading:
  `scaffold.mjs --audit` computes it and reports `policyConflicts` (also in `warnings`), so the check
  is mechanical and cannot be skipped by forgetting a bullet. A non-empty `policyConflicts` is a
  **FAIL**, not a NOTE — the constant is the only value the merge gate reads, so a repository
  answering `auto` while carrying `'classified'` has a merge setting that does nothing, and gets
  refusals citing a `ratified` policy its config never names. Nothing checked it before, which is why
  it survived on a live repository until every code pull request had been refused. **Reconcile
  repairs it**: `auto-merge.mjs` is repo-owned and never overwritten, so rewrite that ONE constant to
  the derived value, show the one-line diff, and leave the rest of the file untouched — a policy the
  human already answered is not a new decision to re-ask, but the edit is still shown because it
  changes what merges without a human;
- open duplicate migration PRs;
- no stale broker/route/measurement prose in forward operational artifacts;
- static Codex and opencode reviewer contracts;
- `dispatch.mjs --self-test` passes, which is what proves the role postures: the reviewer roles
  produce a read-only argv, the writer role produces the writing set, and a malformed structured
  verdict, a non-zero exit, and a timeout are each typed failures.

Doctor performs no live engine dispatch. Verifying that a dispatch actually reaches a model is
`loop-smoke.mjs --real-engine-smoke`, an opt-in pre-release check that spends real budget.

A non-manual policy lacking `merge.unverifiedInvocationAcknowledged: true` is a typed
configuration failure. Doctor never invokes a merge, merge queue, tag publication, or release
publication under any policy.

Repository, branch, tag, and release protection are configured on GitHub and remain the human's
responsibility; doctor does not read or verify that server-side configuration. Setup may present
the exact desired controls but never mutates repository or release protection without the user's
explicit authorization.

## Write and delivery

Fresh install starts from the templates: `--reconcile` writes `LOOP.md`, and Setup fills the STATE
template's placeholders from the interview answers.

Reconfigure and migration **merge** instead — one call per document. Never read the template in
fragments and splice its prose by hand; that cost over half of a measured 11.2-minute migration and
it silently loses repository content:

```bash
node <templates>/tools/scaffold.mjs --merge-state <repository root> > /tmp/autoloop-state-merged.md
node <templates>/tools/scaffold.mjs --merge-loop <repository root> > /tmp/autoloop-loop-merged.md
```

Both write nothing: the merged document goes to the redirect, the typed report to stderr. The
report names, per section, what came verbatim from the template, what was preserved from the
repository (Mission and its invariants, the `autoloop-config` block, extra escalate-path entries,
Lessons), which template sections are `new`, and which installed sections are
`needs-human-review`. Read that report — not the template.

1. Resolve only what the report flags. `needs-human-review` is an installed section the template
   has no counterpart for: it is preserved in place, never dropped, and the human decides to keep,
   fold, or delete it. A section renamed upstream appears as one `needs-human-review` entry beside
   one `new` entry — that pair is the rename.

   **ASK, section by section — never let a preserved section pass silently.** "Preserved in place"
   is the safe default and it is also what makes silence easy: the merged document is
   byte-identical to the installed one, `changed` is false, the diff is empty, and seven pending
   decisions sit in a `counts.needsHumanReview` field nobody reads. A live repository carries
   exactly that — seven sections (a whole `## Playbooks` tree and a queue-drain stop condition)
   that no template knows about, preserved across every reconfigure, never once surfaced as a
   question. The other repository in the same account has none, which is how a real divergence
   looks when nothing asks about it.

   List each one by heading with its first line as context, and take a keep/fold/delete answer.
   Keeping is a fine answer and usually the right one — repository-authored policy is exactly what
   the template cannot know. What is not fine is never being asked, because a section the template
   dropped and a section the repository authored deliberately are indistinguishable once both are
   silently preserved.
2. Act on every `warnings` entry. A preserved `autoloop-config` older than the current schema means
   the migrated block still has to land in this same commit.
3. Re-run the identical command with `--write` to apply it, then show the diff.

Exit 3 is a structural ambiguity that could lose repository bytes — a repeated heading, more than
one `autoloop-config` block, a scalar value no installed line answers, a template that renamed a
repository-owned section. There is no merged document in that case: fix exactly what the
`ambiguities` list names and re-run. Never route around it by splicing prose.

**Read that from the report, never from `$?`.** Exit 3 is a mirror of `ok: false` in the report
already on your screen, beside the `ambiguities` list that says what to fix — and a non-zero exit
is surfaced to you by the tool runner without being asked. `$?` is an active shell expansion, so
the guard refuses it on sight and is right to: it cannot judge a command whose text depends on
state it cannot read. Every session that reaches for it loses a round to a refusal and then reads
the report anyway. Skip to the report. The same holds for the whole family — `--json` puts the
report and the merged document on stdout together when you want one stream instead of two.

`--merge-loop` normally needs no decisions at all: LOOP carries no repository-authored sections,
only the project name, checklist path, and gate command, and the last two are read from the config
so a stale rendering is corrected rather than carried forward. A section a repository added to its
own LOOP is preserved and reported like any other.

The merge covers only these two documents. The review checklist, `LESSONS.md`, and `ARCH.md` are
separate repository-owned files it never reads or writes.

**STATE is injected into every session; LESSONS is not.** That is why durable rules live in
`docs/agentic/LESSONS.md` and STATE holds only policy — mission, config, autonomy, protected
ground, security. Reconcile runs ordered upgrade jobs (`REPO_MIGRATIONS`) before any merge, and
the first moves a legacy `Lessons learned` section out of STATE into LESSONS.md: it writes the new
home before clearing the old one, is idempotent, and reports itself so the move lands in the
visible diff. `--merge-state` refuses outright while such a section remains, because the template
no longer owns it and the merge would replace it. Curate LESSONS like `ARCH.md` — periodically,
against a size budget — and delete any lesson a guard rule, contract, or hook now enforces: the
mechanism is the memory at that point.

Create lifecycle and step labels idempotently. Do not create non-manual policy labels.

Never mutate default/release branch protection, GitHub Apps, or credentials without explicit user
authorization. Present the exact desired settings and verify after changes.

Run:

1. every vendored tool self-test;
2. syntax/JSON/TOML checks;
3. scaffold-template-satisfies-adapter-doctor;
4. config extraction/validation;
5. claim/lane/path cross-consumer fixtures;
6. release verification;
7. static stale-instruction lint;
8. the end-to-end loop smoke (`node tools/agentic/loop-smoke.mjs --self-test`) — no model, no
   network: prime → plan-review dispatch → implement dispatch → code-review dispatch → gate
   command → guardrail close, against a scratch fixture repository with a shimmed engine. It
   asserts every result is typed and that no reviewer dispatch was handed a write tool, and it
   prints a phase timing table.

Manual pre-release check — NOT part of the battery above, NOT part of `--self-test`, and NOT in CI:

```bash
node tools/agentic/loop-smoke.mjs --real-engine-smoke
```

It runs ONE real `code-review` dispatch against the authenticated engine, which is the only check
that proves a dispatch reaches a model at all: the shimmed smoke proves the mechanics and cannot
distinguish a working engine from a missing one. It needs an authenticated `claude` CLI and spends
real model budget. A missing precondition is reported as a failure rather than a skip.

Show the complete diff. A fresh install or migration is delivered through a PR by default. Never
auto-merge Setup's own change.

Never end a Setup session with the reconcile uncommitted. An abandoned working-tree migration is
the worst end state: the next Dev run must treat it as unattributable human work and stop, or —
worse — gets asked to land it mid-run (a live run wedged exactly this way). Deliver the migration
branch and PR in the same session, or revert the working tree to the pre-reconcile state before
stopping; interrupted means reverted, not parked.

End with:

```text
✅ ∞ ══ setup complete ─ <mode> · <changed>/<total> artifacts · verify <state> ══
```

Doctor ends with:

```text
∞ ══ setup doctor complete ─ <findings> finding(s) ══
```

## Hard rules

- Never persist host, engine, or session state in ProjectConfig.
- Never validate reviewer artifacts with prose/grep when the adapter contract exists.
- Never use incomplete evidence to prove absence.
- Never run the repository gate, test suite, or CI to prove a scaffold or prose edit; static
  validation and `verify.mjs --install-root` are Setup's entire evidence surface. A failing gate or
  red CI on the configured base is a NOTE for the human, never Setup's work — Setup never modifies
  repository source.
- When STATE drift is only a version or schema literal, apply it as one direct edit; never write
  block-surgery scripts against STATE. Anything broader is `scaffold.mjs --merge-state`, never a
  hand-assembled splice of template and repository prose.
- Enable a non-manual policy only through the explicit interview answer that writes
  `merge.unverifiedInvocationAcknowledged: true` beside it. Setup never merges.
