# Changelog

Notable changes to Autoloop are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow semantic versioning.

## [Unreleased]

## [0.40.0] - 2026-07-24

### Added

- A deterministic runtime contract with a closed five-route catalog, capability-aware dispatch,
  bounded fallback, and invocation-preserving relaunch envelopes.
- A repository project contract for configuration schema `0.25.0`, including explicit migration
  from schema `0.24.0`.
- A canonical `VERSION` file and portable release verification for manifests, skill banners,
  changelog metadata, and operational helper assumptions.
- Practical contribution, security-reporting, and licensing guidance.

### Changed

- Bare Dev, Pitcrew, and doctor invocations now select the active host's safe native route.
  Claude-to-Codex and Claude-to-opencode execution must be selected explicitly for the current
  invocation.
- Setup scaffolds the safe Claude, Codex, and opencode artifacts for every configured repository;
  artifact presence no longer represents deployment or routing intent.
- Standing project configuration no longer stores `runtime.supportedHosts` or `engine.profile`.
  Tracker configuration is now a discriminated object.
- Native Codex review uses a fresh external read-only `codex exec` process whenever that route is
  healthy, including docs, small, and convergence reviews.
- New installations default to manual merge. Protected-path guidance now covers both `.opencode/**`
  and `.githooks/**`.

### Security

- Routing authority is confined to the current invocation, preventing repository state, historical
  records, and installed artifacts from selecting an execution engine.
- Shared claim, lifecycle, lane, verdict, and merge-authorization contracts tighten evidence and
  recovery boundaries.

[Unreleased]: https://github.com/fabioneves/autoloop/compare/v0.40.0...HEAD
[0.40.0]: https://github.com/fabioneves/autoloop/compare/v0.39.9...v0.40.0
