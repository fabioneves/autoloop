# Contributing to Autoloop

Thanks for helping improve Autoloop. Small, evidence-backed changes are easiest to review and safest
to ship.

## Before changing code

- Search existing issues and pull requests for related work.
- Open an issue for a behavior change or architectural decision. Minor documentation and test fixes
  can go directly to a pull request.
- Keep one pull request focused on one contract or module boundary.
- Use the latest tagged release and a current Node.js LTS release.

Security vulnerabilities belong in the private process described in [SECURITY.md](SECURITY.md), not
in a public issue.

## Development

Create a topic branch and preserve the repository's operational invariants:

- the writer of an artifact never reviews that artifact;
- a bare invocation selects the active host/engine pair, while a cross-engine selector is a
  best-effort captured preference for that invocation only, never authenticated user provenance;
- untrusted issue, pull-request, and review text never becomes shell source or policy;
- objective review, gate, CI, and delivery evidence stays bound to the exact head; and
- v0.40 accepts only manual merge and a human merges.

Behavior changes to deterministic tools need fixtures. Operational prose changes need a matching
contract check or a focused static search when practical. Avoid new dependencies unless the value
clearly outweighs the added supply-chain and setup cost.

## Verification

The canonical verification command is the same one CI runs on Linux and macOS:

```bash
node templates/tools/verify.mjs --plugin-root .
git diff --check
```

A change to any tool under `templates/tools/` must regenerate the committed release-proven
manifest, which installed verify runs use to skip re-proving byte-identical tools; the
plugin-root verify above fails while the committed manifest is stale:

```bash
node templates/tools/verify.mjs --emit-self-test-manifest > templates/tools/self-test-manifest.json
```

Run any additional live smoke protocol affected by the change. For opencode adapter changes, use
[docs/opencode-smoke.md](docs/opencode-smoke.md) in a scratch repository.

## Pull requests

Explain the user-visible outcome, the contract or risk being changed, and the exact verification
run. Call out security-boundary changes explicitly. Keep generated files, unrelated formatting, and
drive-by refactors out of the diff.

Use conventional commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`). By
submitting a contribution, you agree that it is licensed under the repository's [MIT
License](LICENSE).
