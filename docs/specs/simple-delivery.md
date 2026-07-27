# Spec: Simple delivery — finish the v0.42.0 simplification

- **Status:** approved objective (maintainer decision 2026-07-27: "we want something simple that
  works"; ci-policy explicitly removed — "I don't need comparisons")
- **Target release:** v0.49.0
- **Supersedes:** the v0.40.0 finalize/merge evidence program (CheckRun publication, App
  attestation, committed-vs-server CI policy comparison) for every supported configuration.
  Recorded here because v0.42.0 deleted the broker but left this layer standing.

## Objective

A delivery path a solo, PAT-authenticated operator can run end to end. Every write the finalizer
and merge executor perform must be possible with `gh auth login` alone. The reference design is
v0.39's shipped delivery (104 merges), kept where it was right, upgraded only with the invariants
the 0.40–0.48 era genuinely earned.

## Evidence this is the right cut

One live unit (#78) hit four distinct delivery blockers in 24 hours, all in this layer and none
in the core loop: free-plan 403 on rules endpoints; committed-vs-server CI policy contradiction
(unsatisfiable by construction on this plan); no sanctioned path for a ready-head unit behind
base; CheckRun writes App-only by GitHub design (`ensure('review')`/`ensure('gate')` run before
the policy branch, so every policy hits the 403 — no agentic CheckRun has ever existed in the
repository). Meanwhile plan → implement → codex review → gate ran clean all day. Four blockers,
one layer, zero value delivered by it in a solo installation: with one shared credential, in-band
attribution is unprovable by construction (solo spec's own residual-risk statement), and v0.39's
publisher said the same thing in its header — "with the shared maintainer login this is evidence,
not proof."

## Deleted surfaces

- **`.autoloop/ci-policy.json`**, its template, `canonicalCiPolicy()`, the setup scaffold/interview
  for it, and every committed-vs-server required-check comparison in `delivery-contract.mjs` —
  including the rules/branch-protection endpoint reads (the free-plan-403 handling becomes moot;
  keep the 403 corpus knowledge as history). Required-check protection is replaced entirely by the
  **triggered-checks floor**: every check that actually ran on the exact head must be green.
- **CheckRun writes**: `ensurePublishedCheckRun` and all `ensure('review'|'gate'|'ownership'|
  'policy')` call sites; `--expect-app-id`; App pinning (`hasTrustedProducer`) for agentic
  evidence; `NON_MANUAL_TERMINAL_CHECKS` / `MANUAL_TERMINAL_CHECKS` server-pinned workflow
  validation.
- **`--ownership-attestation-file`** and the ownership-attestation ceremony. The premerge record
  already carries the ownership facts (issue, issueBodyHash, claimCommitOid, frozenPlanHash,
  frozenPlanCommentId) — one SHA-bound, hashed, durable comment is the ownership evidence.
- `merge-authorization-contract.mjs` paths that exist only for App/identity-separated
  installations. **Explicit decision this spec records:** the only implemented non-manual mode is
  solo — `merge.policy` of `ratified`/`auto` REQUIRES `merge.soloOperatorAcknowledged: true` plus
  `merge.unverifiedInvocationAcknowledged: true`, and a non-manual, non-solo config is a typed
  refusal at finalize naming this spec. The v0.40 multi-actor unattended mode was never usable and
  is not preserved.

## Kept invariants (each one earned)

- Exact-head **CAS merge** with SHA-bound readback; 409 refusal; ambiguous outcome → refusal.
- **Premerge record comment**: SHA-bound, content-hashed, the single durable terminal evidence.
- **Lifecycle driver** flow unchanged: marker, claim ancestry, `READY_HEAD_BOUND`, terminal
  record readback. (Rock-solid across every run today.)
- **Triggered-checks floor**: all runs on the exact head green, evaluated from the check/status
  read APIs (PAT-readable).
- **Commit statuses** for gate/review verdicts — v0.39's publisher restored: contexts
  `agentic/gate` and `agentic/review`, success-only (absence is the failure signal), SHA-bound,
  description carries the summary hash. Writes via `POST /statuses/{sha}` (PAT-accepted).
- Protected path families, kill switch, hard-block labels, caps, pitcrew's ready-head rule,
  writer≠reviewer, the full review-contract convergence machinery. None of this changes.

## Contract changes

- `attestation-contract.mjs` premerge record: `review`/`gate` parts drop `checkRunId`; each
  becomes `{ summaryHash }`. Record version bumps; verifier reads
  `/repos/{r}/commits/{sha}/status` and requires, per context, state `success` on the exact
  recorded head with a description matching `summaryHash` (prefix match on the short hash is
  acceptable; the record hash still seals the full value).
- `publish-verdict.mjs terminal-finalize`: statuses instead of CheckRuns; no App arguments; the
  ownership/policy sections reduce to the premerge record write + readback. Manual and solo
  non-manual share one code path that differs only in whether the merge executor may act.
- `auto-merge.mjs` (vendored) drops `REQUIRED_CI_CHECKS`: the floor plus `mergeStateStatus`
  CLEAN plus the verified premerge record are the merge predicate. Setup stops filling the
  removed block.

## Success criteria

1. **The live proof:** `#78` finalizes end to end on the real repository — statuses posted,
   record verified, PR ready, labels terminal — with nothing but the operator's `gh` PAT.
2. Every self-test green; the release-proven manifest regenerated; corpus replay green; a new
   corpus entry pins the status-post command shape.
3. Fixtures pin: solo finalize posts exactly two statuses and zero CheckRuns; a non-manual,
   non-solo config refuses typed; manual mode never merges; CAS/readback behavior byte-identical
   to today's fixtures.
4. Setup on an existing repo removes `.autoloop/ci-policy.json` in its visible diff and reports
   it; a fresh scaffold never creates it.
5. Net line count of the delivery layer goes DOWN by at least half. This is deletion surgery;
   a diff that grows it is wrong.

## Boundaries

- Implement in a fresh session against this spec, slice by slice, fixture-first — not appended to
  the 2026-07-27 marathon session. (Process lesson from 0.46.0: prose and contract must ship
  together; each slice here pairs them.)
- Never weaken: CAS/exact-head semantics, protected paths, kill switch, record hashing,
  writer≠reviewer.
- Ask first: anything that would change manual-mode behavior for non-solo installations beyond
  the recorded typed-refusal decision above.
