# TODO: solo-operator mode (spec: docs/specs/solo-operator-mode.md)

- [x] T1: config-contract — `merge.soloOperatorAcknowledged` validation + fixtures (256 cases)
- [x] T2: merge-authorization-contract — solo relaxations + kept-control refusal fixtures + non-solo regression fixtures (65 cases)
- [x] Checkpoint A: full verify green
- [x] T3: auto-merge.reference — SOLO_OPERATOR wiring, honest header + header self-guard, solo/non-solo self-test shapes (template 126 checks; solo-filled copy 123/123 incl. dry-run would-merge). Note: acknowledgment-pair refusal is enforced at Runtime open (shipped in 0.40.1) and by Setup's fill contract, not in-engine — the engine never reads STATE.
- [x] T4: contract-lint wrap/pronoun fixtures (11 cases) + README/STATE conditional prose (6 stale sites fixed, 2 more than the audit listed)
- [x] Checkpoint B: full verify green; solo-filled vendored shape self-tested
- [x] T5: scaffold preserves filled auto-merge.mjs (12 cases) + setup interview solo question + REPO CONFIG fill contract + dev executor prose
- [x] T6: v0.41.0 release literals (release-verify green) + CHANGELOG + review-doc v14 amendment
- [x] Final: `verify.mjs --plugin-root .` passes; spec success criteria 1–6 evidenced

## Left for the user
- Commit + PR (git commit blocked by session permission classifier; everything is staged on `feat/solo-operator-mode`)
- Release/tag 0.41.0, then in living-football-engine: reinstall plugin, add `merge.soloOperatorAcknowledged: true` to STATE, re-run setup so it fills the vendored REPO CONFIG block (repository, `fabioneves` login, `["validate"]` checks, SOLO_OPERATOR=true)
