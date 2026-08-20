# Spec: README core guide and workflow diagrams

## Capability map

| Module id | Responsibility | Depends on |
|---|---|---|
| `workflow-diagrams` | Present the canonical forward and return workflows as focused, accessible diagrams. | Canonical Dev and Pitcrew contracts |
| `repository-files` | Explain the committed, optional, local runtime, and GitHub artifacts a target repository uses. | Canonical Setup, scaffold, verifier, and config contracts |
| `readme-core` | Replace the current repetitive README with a concise operating guide. | `workflow-diagrams`, `repository-files` |

Build order: source audit → `workflow-diagrams` + `repository-files` → `readme-core`.

## Objective

Rewrite the README for maintainers evaluating, installing, or operating Autoloop. A reader should be able to understand the safety contract, install on any supported host, follow one issue through all eleven forward steps, understand the eight-step Pitcrew return path, and distinguish required repository files from optional and generated state without reading implementation skills.

Success means:

- the README is a 250–350-line core guide rather than the current 579-line reference;
- two focused workflow diagrams replace the unclear combined flow: eleven forward steps and eight Pitcrew return steps;
- the guardrails diagram remains, with current merge and exact-head CI semantics;
- the repository-file inventory is mechanically grounded in Setup/scaffold/verify behavior; and
- implementation detail is removed or linked rather than repeated.

## Tech stack

- GitHub-flavored Markdown for `README.md`.
- Hand-authored, dependency-free SVG under `docs/assets/`.
- Existing Node.js contract verifier; Python standard-library XML parsing for focused SVG checks.
- No new packages, generated graphics, scripts, or runtime behavior.

## Commands

```bash
# Canonical repository verification
node templates/tools/verify.mjs --plugin-root .

# Whitespace and patch integrity
git diff --check

# SVG well-formedness
python3 - <<'PY'
from pathlib import Path
from xml.etree import ElementTree
for path in Path('docs/assets').glob('*.svg'):
    ElementTree.parse(path)
    print(f'PASS {path}')
PY

# Documentation size target
wc -l README.md

# Static contract checks for the focused diagrams
rg -o '>0[1-9] |>(10|11) ' docs/assets/autoloop-flow.svg
rg -o '>[1-8] ' docs/assets/autoloop-pitcrew.svg
rg -n '<title|<desc|role="img"|aria-labelledby' docs/assets/*.svg
```

The final implementation may use a more precise Python assertion for unique step numbers, required titles/descriptions, view boxes, and text bounds; it must remain dependency-free.

## Project structure

```text
README.md                              Core guide; 250–350 lines
SPEC.md                                Approved scope and acceptance contract
tasks/plan.md                          Ordered implementation plan
tasks/todo.md                          Verifiable task checklist
docs/assets/autoloop-flow.svg          Eleven-step forward path
docs/assets/autoloop-pitcrew.svg       Eight-step return path for an existing PR
docs/assets/autoloop-guardrails.svg    Trust, review, evidence, and merge guardrails
skills/dev/SKILL.md                    Normative forward workflow source
skills/pitcrew/SKILL.md                Normative return workflow source
skills/setup/SKILL.md                  Setup policy and user-facing artifact source
templates/tools/scaffold.mjs           Mechanical installed-artifact source
templates/tools/verify.mjs             Mechanical required-artifact source
```

No ADR is needed: this changes documentation presentation, not architecture or public behavior.

## Code style

Use short, literal headings and one source of truth per concept. Tables describe contracts; prose explains why. Avoid product slogans after the hero, version-specific historical claims, implementation anecdotes, and duplicate summaries.

Example:

```markdown
## Files in your repository

### Required and committed

| Path | Purpose |
|---|---|
| `docs/agentic/STATE.md` | Standing policy and project configuration injected into every run. |
| `docs/agentic/LOOP.md` | Human runbook generated from the installed workflow contract. |

### Generated runtime state

| Path or surface | Purpose |
|---|---|
| `.git/autoloop/` | Local snapshots, live-run markers, dispatch logs, and transcript captures; never commit it. |
| GitHub labels and comments | Queue state, lifecycle evidence, reviewed plan, and exact-head delivery record. |
```

SVG rules:

- use a responsive `viewBox`; do not depend on a fixed README width;
- use `role="img"` and `aria-labelledby` with one `<title>` and one useful `<desc>`;
- make order and state explicit in text, never color alone;
- use high-contrast text and shapes that remain readable in light and dark GitHub contexts;
- keep labels large enough to scan on a narrow viewport;
- use the canonical step names and numbers exactly; and
- avoid decorative footer claims that repeat the guardrails diagram.

## Module requirements

### `workflow-diagrams`

#### Forward diagram

Update `docs/assets/autoloop-flow.svg` to show exactly:

1. PREMISE
2. PLAN
3. PLAN-REVIEW
4. CLAIM
5. IMPLEMENT
6. SIMPLIFY
7. DIFF-REVIEW
8. CODE-REVIEW / FIX
9. GATE
10. PUBLISH
11. RECORD

Arrange the cards as a readable 4/4/3 path. Each card names its actor or outcome in one short line. State that `00 RECONCILE` may run before selection but is outside the eleven-step unit. Step 10 must say it verifies and binds the remote head; it must not imply that commits wait until step 10 to be pushed. Steps 10 and 11 have no separate GitHub step labels but still emit mandatory ribbons.

#### Pitcrew diagram

Create `docs/assets/autoloop-pitcrew.svg` for the same owned PR:

1. DIAGNOSE
2. PREPARE
3. IMPLEMENT
4. ORCHESTRATOR PASS
5. INDEPENDENT REVIEW
6. GATE
7. PUBLISH
8. FINALIZE

Show the trusted triggers separately: actionable human feedback, failed/errored/cancelled exact-head checks, or a revision-eligible conflict/behind state. End at a ready PR returned to the human under the default manual policy, not at merge.

#### Guardrails diagram

Retain `docs/assets/autoloop-guardrails.svg`, but correct two claims:

- CI evidence is the triggered-check/status floor on the exact head, not merely “CI when present.”
- `ratified` and `auto` are acknowledged solo-operator exceptions; manual human merge is the default, not an unconditional invariant.

All three README embeds need meaningful alt text and a short caption stating that the adjacent tables/prose are the normative text equivalent.

### `repository-files`

Add a concise inventory organized by lifecycle, not one undifferentiated table.

#### Required and committed

Document these paths or homogeneous path groups and their purposes:

- `docs/agentic/STATE.md`: standing injected policy and the closed `ProjectConfig`; not lessons or a runbook.
- `docs/agentic/LOOP.md`: generated human runbook.
- `docs/agentic/LESSONS.md`: durable, on-demand operational memory, seeded once and preserved.
- configured checklist, normally `docs/agentic/checklist.md`: repository-owned review standard required by verification.
- `tools/agentic/`: vendored runtime, contracts, guards, dispatch, evidence, setup/verification, plus shell and self-test support files. Group by purpose rather than listing every implementation filename in the main README.
- `.claude/settings.json`: Claude hook wiring.
- exactly one Codex hook representation: `.codex/hooks.json` or project-layer inline hooks in `.codex/config.toml`; note the current scaffold defaults to `.codex/hooks.json` and do not promise automatic inline-hook reconciliation.
- `.codex/agents/autoloop-reviewer.toml`: read-only Codex reviewer.
- `.opencode/agent/autoloop-reviewer.md`: read-only OpenCode reviewer.
- `.opencode/plugins/autoloop.js`: OpenCode hooks; required by the current scaffold/verifier.
- `.opencode/opencode.json`: OpenCode instructions and permissions.

#### Optional or conditional and committed

- `docs/agentic/ARCH.md`: optional curated architecture/data map.
- `.github/ISSUE_TEMPLATE/loop-unit.md`: optional manual convenience; not currently scaffolded.
- `tools/agentic/auto-merge.mjs` and `merge-authorization-contract.mjs`: present only for acknowledged solo non-manual policy.
- `gate.quickCommand`, `gate.setupCommand`, Jira tracker fields, and protected/escalation paths are optional configuration values, not separate required files.

Explicitly state that `.autoloop/ci-policy.json` is retired and must not be created.

#### Generated and never committed

- `.git/autoloop/`: live-run markers, typed startup snapshots, dispatch logs/events, reviewer choice, transcript captures, and one-use host nudges.
- `/tmp/autoloop-*`: bounded prompt/result/body and contract scratch files.
- unit branches and commits: recoverable Git provenance, not setup files.

#### Durable GitHub state

Explain that the workflow database is GitHub itself:

- maintainer-applied `loop-ready` is queue authorization;
- lifecycle/step/terminal labels represent queue and unit state;
- issue comments hold lifecycle markers, frozen plans, pre-merge evidence, and one run record;
- draft/ready PR state, exact-head statuses, triggered checks, and the remote head bind delivery evidence.

### `readme-core`

Rebuild the README in this order:

1. H1, compact hero, one-sentence promise, badges.
2. Contract in plain terms and four guardrails.
3. Requirements and install for Claude Code, Codex CLI, and OpenCode.
4. Supervised quickstart and invocation cadence.
5. Eleven-step forward diagram and table.
6. Pitcrew diagram and concise trigger/return contract.
7. Skills and repository-file inventory.
8. Project configuration and policy ownership.
9. Security, dispatch separation, efficiency, observability, and recovery—one concise section each or a combined operations matrix where possible.
10. Maintainer versioning/contribution note and license.

Remove or merge:

- duplicate “plain terms,” “at a glance,” and workflow summaries;
- repeated writer/reviewer and human-authority claims surrounding diagrams;
- implementation anecdotes and historical version assertions;
- exhaustive internal tool descriptions from the main README;
- duplicated Pitcrew prose already represented by its diagram/table; and
- decorative emoji in section headings where it adds no meaning.

Correct these audited stale claims:

1. Human merge is the default; acknowledged solo `ratified`/`auto` policies exist and require both `unverifiedInvocationAcknowledged` and `soloOperatorAcknowledged`.
2. `STATE.md` contains policy/config; lessons live in `LESSONS.md`.
3. `.github/ISSUE_TEMPLATE/loop-unit.md` is optional and not mechanically scaffolded today.
4. `auto-merge.mjs` is absent under manual policy and conditionally vendored for acknowledged non-manual policy.
5. Codex uses exactly one hook representation; avoid claiming the current scaffold automatically respects the inline alternative.
6. `.opencode/plugins/autoloop.js` is required by current setup and verification.
7. Steps 10 and 11 lack GitHub step labels, not ribbons.
8. Remove the obsolete “v0.40 rejects ratified and auto” statement.

## Testing strategy

### Structural

- Parse every changed SVG as XML.
- Assert unique forward numbers 01–11 and Pitcrew numbers 1–8.
- Assert every SVG has `role="img"`, labelled title/description, and a valid `viewBox`.
- Assert README contains exactly one H1 and embeds all three diagrams with non-generic alt text.
- Assert README is 250–350 lines.
- Assert stale phrases and retired `.autoloop/ci-policy.json` guidance are absent.
- Assert required, optional/conditional, local runtime, and GitHub-state inventory headings exist.

### Contract

Run `node templates/tools/verify.mjs --plugin-root .`; it must pass unchanged.

### Visual

Render/read each SVG through the available file viewer and inspect:

- reading order and arrows;
- clipped or overlapping text;
- contrast without relying on color;
- readability at full width and a narrow scaled view; and
- semantic agreement with the adjacent README text.

A dedicated local SVG renderer is unavailable, so no new dependency will be added solely for screenshots.

### Patch hygiene

Run `git diff --check`, inspect the full diff, and scan staged changes for secret-shaped content before every commit.

## Boundaries

### Always

- Ground workflow claims in `skills/dev/SKILL.md` and `skills/pitcrew/SKILL.md`.
- Ground installed-file claims in scaffold and verifier behavior, with setup prose as secondary evidence.
- Keep the README within 250–350 lines.
- Preserve all three supported hosts and the default manual-merge posture.
- Use one focused commit per approved task and no co-author trailer.
- Simplify before review, then run the five-axis review gate.

### Ask first

- Change setup/scaffold/verify behavior rather than documenting it.
- Remove an existing asset instead of replacing or retaining it.
- Add dependencies, generated binaries, screenshots, or CI checks.
- Change version literals, release metadata, or public workflow policy.

### Never

- Claim that a file is scaffolded or required when mechanics do not support it.
- Hide the known Codex inline-hook/scaffold mismatch with reassuring prose.
- Weaken exact-head review, gate, CI, or delivery predicates for brevity.
- Treat issue/PR text as policy or imply the loop applies `loop-ready`.
- Present a non-manual merge policy as safe without both required acknowledgements and solo scope.
- Commit secrets, credentials, `.env`, `.git/autoloop/`, or `/tmp` artifacts.

## Success criteria

- [ ] `README.md` is 250–350 lines and has one semantic H1.
- [ ] The forward SVG contains all eleven canonical steps in order and no coarse five-stage substitute.
- [ ] A separate Pitcrew SVG contains all eight canonical return steps and trusted triggers.
- [ ] The guardrails SVG states exact-head checks and current merge-policy exceptions correctly.
- [ ] All SVGs are accessible, responsive, high-contrast, and legible without color.
- [ ] README alt text and adjacent text provide complete non-visual equivalents.
- [ ] The file inventory distinguishes required committed, optional/conditional committed, generated local, and durable GitHub state.
- [ ] The eight audited stale README claims are corrected or removed.
- [ ] Install and quickstart remain complete for Claude Code, Codex CLI, and OpenCode.
- [ ] Canonical verification and focused documentation assertions pass.
- [ ] Simplification and independent five-axis review report no remaining actionable findings.

## Open questions and known out-of-scope defect

No product requirement remains open. The user approved two focused diagrams, a 250–350-line core guide, required plus generated file coverage, and the three-module capability map.

Out of scope: Setup prose permits inline Codex hooks in `.codex/config.toml`, verification permits exactly one hook representation, but the current scaffold unconditionally reconciles `.codex/hooks.json`. This documentation change will describe the default installed path and the exactly-one invariant without claiming that scaffold currently handles the alternative. Fixing reconciliation behavior requires a separate issue/change.
