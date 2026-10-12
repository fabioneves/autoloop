# Spec: Protected-path reduction

Module: `protected-path-reduction` in [Flow](SPEC-flow.md).

## Objective

A unit that edits an ordinary repository file is delivered and merged under the configured merge
policy. The `human:authorize` label is reserved for a change the operator must see before it
runs: secrets, CI workflows, and the loop's own control files. The project adds its own paths
through `protectedPaths`; the plugin does not add them back.

## Current state

`tools/lane-contract.mjs:111-139` defines `MERGE_PROTECTED_PATH_FAMILIES`. It labels edits to
`CLAUDE.md`, `AGENTS.md`, `docs/agentic/*` (except `ARCH.md`), `.github`, every root dotfile and
dot-directory, `package.json`, lockfiles, `tsconfig*`, build and lint configs, `data/`, container
files, and the guardrail roots `tools`, `.claude`, `.codex`, `.opencode`, `.agents`, `.githooks`.
`merge-authorization-contract.mjs:16-22` refuses auto-merge for any pull request carrying the
label. Under an automatic merge policy this parks delivered units for a human, and the next unit
on the same files creates a conflicting pull request.

## Required behavior

1. **Built-in families.** The plugin protects only:
   - secret and credential paths, by the one rule `isSecretPath` in `lane-contract.mjs` (shared
     with the command guard and the lane): a path segment that is the word `secret`, `secrets`,
     `credential`, `credentials`, `token`, `tokens` or `crypt` with any extension
     (`docs/secrets.md`, `config/credentials.json`; `src/tokenizer.ts`, `auth/token-refresh.ts`
     and `lib/encryption.ts` are source); `keys/`, `certs/`, `.ssh/`; `id_rsa*`, `id_ed25519*`,
     `private-key`, `private_key`, `keypair`; the extensions `.crt`, `.jks`, `.key`,
     `.keystore`, `.p12`, `.pem`, `.pfx`; and `.env*` files;
   - `.github/**` as a whole: workflows, composite actions, `CODEOWNERS` and dependabot
     configuration all run in CI with the repository's secrets or decide who reviews;
   - the loop's own control files: `.autoloop/**`, `.claude/**`, `.codex/**`, `.opencode/**`,
     `.agents/**`, `.githooks/**`.
2. **Removed families.** `CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md`, `docs/agentic/**`,
   root dotfiles outside the list above, `package.json`, lockfiles, `tsconfig*`, build and lint
   configs, `data/**`, container build and compose files, and the `tools` root are no longer
   protected by the plugin. A project that wants them lists them in `protectedPaths`.
3. **Project list unchanged.** `protectedPaths` in `.autoloop/config.json` keeps its semantics and
   validation (`config-contract.mjs:457`). The effective set is the union of the built-in families
   and the project list.
4. **Dependencies stay a hard-defer.** A new dependency install, a secret value, or a production
   data write is still refused at build time as today. This spec changes which edits need a label,
   not what the loop may install. The merge gate enforces the dependency hard-defer in code:
   `auto-merge.mjs` reads the base and head contents of every changed `package.json` or
   `composer.json` (any directory) and every changed lockfile, and a manifest whose
   `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` (or `require`,
   `require-dev`) gain a key, whose `scripts` gain `preinstall`, `install`, `postinstall` or
   `prepare`, or a lockfile that adds a package, is a `human:authorize` hit named `dependency
   change`, which the AND-gate refuses as it does any `human:authorize`. A version bump, a
   removal, or a deleted manifest is ordinary. A manifest the executor cannot read, or more than
   twenty changed manifests, fails closed.
5. **Lane widening.** `widenLane` matches a directory prefix as the directory it names (a
   project glob `spec/**` labels a widening by `spec/`), and refuses a prefix at or under a
   guardrail root (`.github/`, `.claude/`, `.autoloop/`, …) with `WIDEN_GUARDRAIL_ROOT`, as it
   refuses a secret path with `WIDEN_SECRET_PATH`. `terminal-finalize` applies `human:authorize`
   to the pull request when the review ledger's `scopeChanges` reached a protected path.
6. **Setup and doctor.** `setup.mjs` templates and the STATE template describe the new built-in
   list. Doctor reports a project `protectedPaths` entry that duplicates a built-in family.
7. **Existing labels.** A `human:authorize` label already on a pull request is not removed by the
   loop. Pitcrew and reconcile treat it as today.

## Commands

```bash
node tools/lane-contract.mjs --self-test
node tools/escalate-paths.mjs --self-test
node tools/auto-merge.mjs --self-test
node tools/merge-authorization-contract.mjs --self-test
node tools/setup.mjs --self-test
node tools/verify.mjs --plugin-root .
```

## Project structure

- `tools/lane-contract.mjs`: `MERGE_PROTECTED_PATH_FAMILIES`, `SHARED_GUARDRAIL_ROOTS`,
  `DEPLOYMENT_GUARDRAIL_GLOBS`.
- `tools/escalate-paths.mjs`: shared family definitions if they live there.
- `tools/setup.mjs`, STATE template, `README.md`, `CHANGELOG.md`.

## Testing strategy

Failing tests first: `CLAUDE.md`, `package.json`, `tsconfig.json`, `docs/agentic/checklist.md`,
`data/x.json`, and `Dockerfile` produce no protected hit; `.env.local`, `keys/x.pem`,
`.github/workflows/ci.yml`, `.github/CODEOWNERS`, and `.autoloop/config.json` still do; a project
`protectedPaths` entry for `spec/**` still labels. Auto-merge accepts a pull request that edits
`CLAUDE.md` and carries no label, and refuses one whose `package.json` gains a dependency or an
install script, or whose lockfile adds a package, with a `dependency change` reason.

## Boundaries

- Always: keep the secret families; keep the project list.
- Ask first: removing `.github/**` or the control-file roots.
- Never: a plugin default that re-adds an ordinary file family.

## Success criteria

A delivered unit that edits documentation, configuration, or dependencies manifests merges under
`merge.policy: auto` without a label. A unit that edits a secret path or a workflow still carries
`human:authorize`. Self-tests and the full gate pass.
