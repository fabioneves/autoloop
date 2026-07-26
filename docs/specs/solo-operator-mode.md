# Spec: Solo-operator non-manual merge mode

- **Status:** approved objective (maintainer decision 2026-07-26, after full blocker briefing)
- **Target release:** v0.41.0, configuration schema stays `0.25.0`
- **Supersedes:** the unconditional "identity separation is a hard precondition for any
  non-manual merge" posture, for explicitly acknowledged solo installations only. Defaults
  for every other installation are unchanged. Recorded as a v14 amendment in
  `autoloop-review-consolidated.md`.

## Objective

A repository operated by exactly one human — where the loop necessarily runs under that same
GitHub login, the repository is on a plan without branch protection, and GitHub forbids
self-approval of one's own PRs — cannot satisfy the v0.40 non-manual authorization contract
even in principle. Its identity-separation, App-attestation, server-policy, and
approving-review requirements are *unsatisfiable* there, not merely unconfigured.

Add an explicit, acknowledged **solo-operator mode** that relaxes exactly those four
unsatisfiable requirement families while keeping every requirement a solo repository *can*
satisfy. A solo repo with `merge.policy: auto`, both acknowledgment flags, and a filled
repo-config block merges a delivered, CI-green, claim-clean PR unattended; everything else
still refuses fail-closed.

## What solo mode relaxes (only when `soloOperator === true`)

1. **Identity separation** — `trustedHumanLogins` must be exactly `[loopLogin]` (anything
   else is a config error: a second trusted human means solo mode is the wrong tool).
   The `loop-ready` label actor and the Path-A authorizer may equal `loopLogin`.
2. **App attestation** — `automationAppIds` / `authorizationAppIds` may be empty; the
   dedicated `agentic/human-authorization` CheckRun requirement is waived; required-check
   producers are validated by name + head SHA + success without App pinning (GitHub-Actions
   CheckRuns remain the expected producer). Concrete verdict-channel mechanics are resolved
   in T2/T3 against the existing gate code without weakening non-solo paths.
3. **Server-side policy** — the live branch-protection/ruleset verification is waived
   (the plan cannot have protection). `mergeStateStatus === 'CLEAN'`, exact-head CAS merge,
   409 refusal, and sha-bound outcome confirmation are all KEPT.
4. **Approving review** — `requiredApprovingReviewCount`/`reviewDecision === 'APPROVED'`
   waived (self-approval is impossible). `CHANGES_REQUESTED`, pending review requests, and
   unresolved conversations still block.

## What solo mode keeps (unchanged, non-negotiable)

- Exact-head CAS merge + sha-bound confirmation; ambiguous outcome → refusal.
- REQUIRED_CI_CHECKS green on the exact head, aligned with `.autoloop/ci-policy.json`.
- Full ownership contract: claim-commit ancestry and canonical first commit, branch/body
  issue match via `parseLoopClaim`, frozen-plan comment authored by `loopLogin`, issue body
  hash unchanged, delivered lifecycle + head-bound premerge record.
- Hard-block labels, issue kill switch, merge-protected path families (`tools/**`,
  `.claude/**`, `.codex/**`, `.opencode/**`, `.agents/**`, `.githooks/**`, root dot-families).
- Executor identity must equal `loopLogin`.
- Path-A label-event verification, head binding, and after-current-head ordering.

## Configuration surface

`merge.soloOperatorAcknowledged: true` — same pattern as `unverifiedInvocationAcknowledged`:
optional key, must be `true` when present, valid only when policy is non-manual AND
`unverifiedInvocationAcknowledged: true` is also present. No schema bump (precedent:
`unverifiedInvocationAcknowledged` landed inside 0.25.0). Migration behavior unchanged
(migration still forces `manual`; restoring non-manual + solo is an explicit interview act).

Vendored `auto-merge.mjs` repo-config block gains `SOLO_OPERATOR = false` (default). Setup
fills, for an acknowledged solo repo: `REPOSITORY` (from `gh repo view`), `LOOP_LOGIN`
(from `gh api user`), `TRUSTED_HUMAN_LOGINS = [login]`, `REQUIRED_CI_CHECKS` (from
`.autoloop/ci-policy.json`), `SOLO_OPERATOR = true`.

## Bundled in-scope bug fixes (found by the 2026-07-26 audit, on surfaces this feature touches)

- `auto-merge.reference.mjs` header still claims "v0.40 Setup never installs or invokes this
  file… Runtime rejects every non-manual run" — false since 0.40.1/0.40.5. Rewrite to state
  the acknowledged conditional; add a self-test asserting the header states the conditional.
- `README.md` merge-policy section and `templates/STATE.template.md` still assert
  unconditional manual-only. Reword to the conditional.
- `contract-lint.mjs` `UNCONDITIONAL_NON_MANUAL_REFUSAL` pattern cannot cross a line wrap
  (`[^.\n]`) and misses pronoun references. Widen to cross single newlines; add fixtures for
  the two previously-missed shapes.

## Explicit non-goals

Measurement producers, selection/actionability helper mandates, STATE-escalate fixture
binding, base-protection guidance, CHANGELOG compare-link verification, and the
`--allow-unverified-live-controls` README contradiction (a `fix/release-live-control-visibility`
branch already exists) stay out of scope. No new plan-review rounds. No change to any
non-solo authorization behavior.

## Security posture (threat model, stated honestly)

In a solo repository every in-band actor attribution is unprovable by construction: the
human, the loop, and any process holding the shared credential are indistinguishable. Solo
mode therefore does not *pretend* to authenticate a human; it substitutes the controls that
remain meaningful — exact-head CI evidence, lifecycle/ownership binding, protected paths,
kill switch, caps — and requires the operator to acknowledge exactly that in config. The
acknowledgment pair is the audit record of informed consent. Residual accepted risk: a
compromised shared credential can both author and merge changes outside protected paths;
CI is then the only independent gate.

## Commands

- Self-tests: `node templates/tools/<tool>.mjs --self-test`
- Full verification: `node templates/tools/verify.mjs --plugin-root .`
- Release check: exercised by verify (release-verify literals against `VERSION`)

## Success criteria

1. All existing self-tests still pass; `verify.mjs --plugin-root .` passes.
2. New fixtures prove, in solo mode: dry-run would-merge for a delivered CI-green claim-clean
   PR with single-identity config; refusal for each of — missing either acknowledgment,
   `trustedHumanLogins ≠ [loopLogin]`, CI pending/red, protected path, hard label, kill
   switch, tampered claim, wrong executor.
3. New fixtures prove non-solo behavior is byte-identical in decision terms: identity
   separation, App pinning, server policy, and review requirements all still enforced when
   `SOLO_OPERATOR` is false or the config flag is absent.
4. Config contract: `soloOperatorAcknowledged` accepted only alongside non-manual +
   `unverifiedInvocationAcknowledged`; must-be-true-when-present; rejected under `manual`.
5. Contract lint catches the wrapped-line and reworded refusal prose (new lint fixtures);
   README/STATE/auto-merge header state the conditional accurately.
6. Release verification passes at `0.41.0` with every literal updated.

## Boundaries

- Always: TDD per slice (failing fixture first), full self-test suite after each slice,
  one concern per commit, fail-closed defaults.
- Ask first: any relaxation beyond the four named families; any change to non-solo defaults;
  enabling anything without the acknowledgment pair.
- Never: weaken protected-path families, CAS/exact-head semantics, or kill-switch handling —
  in any mode; commit secrets; force-push.
