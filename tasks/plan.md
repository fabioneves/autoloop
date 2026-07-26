# Implementation Plan: Solo-operator non-manual merge mode

Spec: `docs/specs/solo-operator-mode.md` (approved 2026-07-26). Branch: `feat/solo-operator-mode` off `main` (f85c65a).

## Overview

Add an acknowledged solo-operator mode that relaxes exactly four unsatisfiable authorization
families (identity separation, App attestation, live server policy, approving review) in the
dormant-reference merge gate, keeping every other control. Bundle the three audit-found bugs on
the same surfaces (false auto-merge header, stale unconditional-refusal prose, lint blind
spots). Release as v0.41.0.

## Architecture decisions

- **One config flag, two-key acknowledgment.** `merge.soloOperatorAcknowledged: true` is valid
  only alongside a non-manual policy AND `unverifiedInvocationAcknowledged: true`. Follows the
  existing `unverifiedInvocationAcknowledged` precedent exactly (optional key, must-be-true,
  policy-conditional) — no schema bump.
- **Relaxation lives in `merge-authorization-contract.mjs` as data-driven conditionals on
  `config.soloOperator`,** not a parallel code path. Every relaxed check gets an explicit
  `soloOperator === true` guard so the non-solo path is textually unchanged.
- **`trustedHumanLogins` must equal `[loopLogin]` in solo mode.** A second trusted human means
  solo mode is the wrong tool; fail closed on misconfiguration.
- **Verdict channel in solo mode:** required checks validated by name + head SHA + SUCCESS
  without App pinning; `agentic/human-authorization` CheckRun requirement waived for Path A
  (label-event verification, head binding, after-current-head ordering all kept). Resolve exact
  mechanics against existing `validateAuthorization`/`validateChecks` code in T2 without
  touching non-solo behavior.
- **TDD per slice:** each slice starts with failing self-test fixtures in the tool it touches;
  `--self-test` is the test runner; `verify.mjs --plugin-root .` is the suite gate.

## Task list

### Phase 1: Contract foundations

- **T1: config schema — `merge.soloOperatorAcknowledged`** (`templates/tools/config-contract.mjs`)
  - Acceptance: accepted only with non-manual policy + `unverifiedInvocationAcknowledged: true`;
    must be `true` when present; rejected under `manual`; rejected alone; migration still forces
    `manual` and never emits the solo flag.
  - Verify: new fixtures fail → pass; `config-contract.mjs --self-test` green (was 250 cases).
  - Files: `templates/tools/config-contract.mjs`. Size: S.

- **T2: gate relaxations** (`templates/tools/merge-authorization-contract.mjs`)
  - Acceptance: `soloOperator` config field (boolean, default absent/false). When true:
    `trustedHumanLogins` must equal `[loopLogin]`; loop-ready actor and Path-A authorizer may
    equal loop; App-ID lists may be empty; human-authorization CheckRun waived; server-policy
    verification waived; approving-review count/decision waived. KEPT: CLEAN merge state,
    CHANGES_REQUESTED / pending-request / unresolved-conversation blocks, hard labels,
    kill switch, protected paths, ownership contract, executor == loopLogin, Path-A
    head-binding + event verification. Non-solo decision surface byte-identical.
  - Verify: solo would-merge fixture + one refusal fixture per kept control + non-solo
    regression fixtures; `--self-test` green (was 49 cases).
  - Files: `templates/tools/merge-authorization-contract.mjs`. Size: M.

### Checkpoint A
- T1+T2 self-tests green; full `verify.mjs --plugin-root .` still passes; commits per slice.

### Phase 2: Engine + honesty fixes

- **T3: engine wiring + honest header** (`templates/tools/auto-merge.reference.mjs`)
  - Acceptance: `SOLO_OPERATOR = false` block constant, threaded into the gate config; header
    rewritten to state the acknowledged conditional (no "never installs or invokes" claim);
    self-test derives from the config block in both solo and non-solo shapes; dry-run
    would-merge fixture for the solo happy path; refusals for missing acknowledgment pair.
  - Verify: `--self-test` green (was 122 passed).
  - Files: `templates/tools/auto-merge.reference.mjs`. Size: M.

- **T4: lint blind spots + stale prose** (`templates/tools/contract-lint.mjs`, `README.md`,
  `templates/STATE.template.md`)
  - Acceptance: `UNCONDITIONAL_NON_MANUAL_REFUSAL` matches across a single line wrap and the
    README "it"-pronoun shape (fixtures for both, red first); README merge-policy section and
    STATE template state the conditional (acknowledged non-manual opens; solo additionally
    acknowledged); lint passes on the corrected prose and on this feature's additions.
  - Verify: `contract-lint.mjs --self-test` green; `verify.mjs` lint stage green.
  - Files: 3 above. Size: S.

### Checkpoint B
- Full verify green; vendored-name self-test parity (`auto-merge.mjs` rename path) confirmed.

### Phase 3: Setup + release

- **T5: Setup fills the solo config** (`templates/tools/scaffold.mjs`, `skills/setup/SKILL.md`,
  `skills/dev/SKILL.md`)
  - Acceptance: for an acknowledged solo repo, Setup interview offers solo mode only after the
    non-manual acknowledgment; scaffold fills `REPOSITORY`, `LOOP_LOGIN`,
    `TRUSTED_HUMAN_LOGINS=[login]`, `REQUIRED_CI_CHECKS` (from `.autoloop/ci-policy.json`),
    `SOLO_OPERATOR=true` in the vendored engine; non-solo vendor path unchanged (placeholders
    + SOLO_OPERATOR=false); scaffold self-test covers both shapes.
  - Verify: `scaffold.mjs --self-test` green (was 10 cases); setup SKILL prose consistent.
  - Files: 3 above. Size: M.

- **T6: release v0.41.0 + doc amendment**
  - Acceptance: `VERSION`=0.41.0 and every release literal updated (release-verify enforces:
    both plugin manifests, README badge/matrix/schema lines, CHANGELOG dated heading, three
    skill banners, docs/measurement.md, docs/opencode-smoke.md evidence lines); CHANGELOG
    entry documents solo mode, kept/relaxed controls, and the three bug fixes;
    `autoloop-review-consolidated.md` gains a short v14 amendment block recording the
    2026-07-26 decision and superseding the unconditional-manual wording.
  - Verify: `release-verify.mjs --self-test` + full `verify.mjs --plugin-root .` green.
  - Files: VERSION, CHANGELOG.md, README.md, 3 SKILL banners, plugin manifests, docs/*,
    autoloop-review-consolidated.md. Size: M (mechanical).

### Checkpoint: complete
- All self-tests + full verify green; each slice individually committed; success criteria 1–6
  of the spec checked off with evidence.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Relaxation leaks into non-solo path | High | Explicit `soloOperator === true` guards; byte-level non-solo regression fixtures in T2/T3 |
| Solo mode silently satisfiable with 2 humans | Med | `trustedHumanLogins === [loopLogin]` hard check; fixture |
| Header/prose drift again | Med | Lint fixtures for the exact previously-missed shapes; auto-merge header self-test |
| Release literal missed | Low | release-verify already fails CI on stale literals |

## Open questions

None blocking — verdict-channel mechanics in solo mode are bounded by T2's acceptance
criteria and resolved against existing code.
