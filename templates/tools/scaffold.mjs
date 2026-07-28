#!/usr/bin/env node

// Deterministic scaffold reconciliation. Setup previously walked every vendored
// tool and host artifact through model-mediated compare/copy calls — dozens of
// slow round trips wrapping microsecond file operations. This tool performs the
// complete mechanical reconciliation in one invocation and returns a typed
// report. A second entry point merges the STATE and LOOP documents against
// their templates on the same principle. Judgment stays with the model: the
// interview, whatever the merge report flags for human
// review, the visible diff, and the commit.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_VERSION, extractConfig, validateConfig } from './config-contract.mjs';
import {
  NON_MANUAL_TOOL_FILES,
  UNIVERSAL_TOOL_FILES,
} from './verify.mjs';

const TEMPLATE_MARKER = 'STATE.template.md';
// Vendored tools keep their template name, except the reference-named merge
// executor, which installs under the name the runtime dispatches.
const TOOL_SOURCE_NAMES = Object.freeze({
  'auto-merge.mjs': 'auto-merge.reference.mjs',
});
// Some vendored tools carry repository-owned policy that a blind byte refresh
// would silently delete, so a modified copy is reported for prose-level
// reconciliation instead of overwritten: escalate-paths.mjs holds the review's
// extra escalate globs, and auto-merge.mjs holds the Setup-filled REPO CONFIG
// block (repository, logins, required checks, solo-operator transcription).
const PRESERVE_IF_MODIFIED = Object.freeze(new Map([
  ['escalate-paths.mjs', 'repository-owned escalate entries'],
  ['auto-merge.mjs', 'the Setup-filled merge REPO CONFIG block'],
]));
const HOST_ARTIFACTS = Object.freeze([
  ['codex-reviewer-agent.template.toml', '.codex/agents/autoloop-reviewer.toml'],
  ['opencode-reviewer-agent.template.md', '.opencode/agent/autoloop-reviewer.md'],
  ['opencode-plugin.template.js', '.opencode/plugins/autoloop.js'],
]);
const HOOK_MERGES = Object.freeze([
  ['settings-hooks.template.json', '.claude/settings.json'],
  ['codex-hooks.template.json', '.codex/hooks.json'],
]);
// `repoAppendedHeadings` names the repository memory a template cannot mark
// with a placeholder, because the template ships seed content the repository
// then appends to. It is keyed by the template's own heading: a template that
// renames one stops matching, and the merge fails closed instead of replacing
// durable repository memory. LOOP declares none — it is entirely
// template-owned prose plus the scalar values below.
const MERGE_DOCUMENTS = Object.freeze({
  state: Object.freeze({
    label: 'STATE',
    template: 'STATE.template.md',
    install: 'docs/agentic/STATE.md',
    // Durable memory moved to LESSONS.md, which is never injected. STATE
    // therefore declares no repo-appended section: `migrateLessons` relocates
    // any legacy one before the merge, so the merge's fail-closed check for a
    // vanished repo-appended heading has nothing left to catch.
    repoAppendedHeadings: Object.freeze([]),
  }),
  loop: Object.freeze({
    label: 'LOOP',
    template: 'LOOP.template.md',
    install: 'docs/agentic/LOOP.md',
    repoAppendedHeadings: Object.freeze([]),
  }),
});
// Scalar holes the machine-readable config owns. The installed prose only
// renders these values and goes stale the moment the config changes, so the
// config wins over the installed line.
const CONFIG_VALUE_SOURCES = Object.freeze({
  CHECKLIST_PATH: (config) => config?.review?.checklistPath,
  GATE_COMMAND: (config) => config?.gate?.command,
});
const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/gu;
const HAS_PLACEHOLDER = /\{\{[A-Z0-9_]+\}\}/u;
const SOLE_PLACEHOLDER = /^\s*\{\{([A-Z0-9_]+)\}\}\s*$/u;
const LIST_MARKER = /^\s{0,3}[-*+]\s/u;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeArtifact(root, relativePath, bytes, results, mode, audit = false, source) {
  const target = resolve(root, relativePath);
  let action = 'created';
  if (existsSync(target)) {
    action = Buffer.compare(readFileSync(target), Buffer.from(bytes)) === 0
      ? 'identical'
      : 'refreshed';
  }
  if (!audit) {
    mkdirSync(dirname(target), { recursive: true });
    if (action !== 'identical') writeFileSync(target, bytes);
    if (mode !== undefined) chmodSync(target, mode);
  }
  results.push(source ? { path: relativePath, action, source } : { path: relativePath, action });
}

function hookCommands(entry) {
  return (Array.isArray(entry?.hooks) ? entry.hooks : [])
    .map((hook) => hook?.command)
    .filter((command) => typeof command === 'string');
}

// The vendored tools a hook command executes. Referencing the same
// `tools/agentic/<name>` is what identifies two differently-worded entries as
// versions of the same autoloop binding.
function referencedHookTools(entry) {
  const names = new Set();
  for (const command of hookCommands(entry)) {
    for (const match of command.matchAll(/tools\/agentic\/([A-Za-z0-9._-]+\.(?:mjs|sh))/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

// Non-clobbering per-event merge: an event the repository lacks is added whole;
// a template entry whose exact command is already present changes nothing; and
// maintainer hooks are never removed or reordered.
//
// One replacement case, learned live: when an existing entry runs the same
// vendored tool as the template entry but with different text, it is a
// SUPERSEDED autoloop binding, not maintainer work — appending beside it runs
// the guard twice per Bash call, with the stale copy missing whatever the
// rewording added (observed: the `|| exit 2` fail-closed suffix). Same tool,
// same event → replace in place.
export function mergeHookDocuments(existing, template) {
  const merged = structuredClone(existing ?? {});
  if (merged.hooks === undefined) merged.hooks = {};
  let changed = false;
  for (const [event, templateEntries] of Object.entries(template?.hooks ?? {})) {
    if (!Array.isArray(merged.hooks[event])) {
      merged.hooks[event] = structuredClone(templateEntries);
      changed = true;
      continue;
    }
    for (const entry of templateEntries) {
      const present = new Set(merged.hooks[event].flatMap(hookCommands));
      if (hookCommands(entry).some((command) => present.has(command))) continue;
      const tools = referencedHookTools(entry);
      const superseded = merged.hooks[event].findIndex((candidate) =>
        [...referencedHookTools(candidate)].some((name) => tools.has(name)));
      if (superseded !== -1) {
        merged.hooks[event][superseded] = structuredClone(entry);
      } else {
        merged.hooks[event].push(structuredClone(entry));
      }
      changed = true;
    }
  }
  return { merged, changed };
}

// Per-key merge where existing repository configuration wins; the instructions
// array is a union that preserves the repository's order.
export function mergeOpencodeConfig(existing, template) {
  const merged = structuredClone(template ?? {});
  for (const [key, value] of Object.entries(existing ?? {})) {
    merged[key] = structuredClone(value);
  }
  const instructions = [
    ...(Array.isArray(existing?.instructions) ? existing.instructions : []),
  ];
  for (const entry of Array.isArray(template?.instructions) ? template.instructions : []) {
    if (!instructions.includes(entry)) instructions.push(entry);
  }
  merged.instructions = instructions;
  return merged;
}

function readProjectConfig(root, warnings) {
  let text;
  try {
    text = readFileSync(resolve(root, 'docs', 'agentic', 'STATE.md'), 'utf8');
  } catch {
    warnings.push(
      'docs/agentic/STATE.md is absent; reconciling the universal tool set only',
    );
    return null;
  }
  try {
    const config = extractConfig(text);
    const errors = validateConfig(config);
    if (errors.length > 0) {
      warnings.push(
        'ProjectConfig is not schema-current; reconciling the universal tool set '
        + 'only — migrate the configuration first',
      );
      return null;
    }
    return config;
  } catch (error) {
    warnings.push(`ProjectConfig is unreadable (${error.message}); reconciling the universal tool set only`);
    return null;
  }
}

export function reconcile(root, templates, { audit = false } = {}) {
  if (!existsSync(join(templates, TEMPLATE_MARKER))) {
    throw new Error(
      `templates directory ${templates} does not contain ${TEMPLATE_MARKER}; `
      + 'pass --templates <plugin templates dir>',
    );
  }
  const results = [];
  const warnings = [];
  const config = readProjectConfig(root, warnings);
  const nonManual = config !== null && config.merge.policy !== 'manual';

  const tools = [
    ...UNIVERSAL_TOOL_FILES,
    'session-preflight.sh',
    'dispatch-stream.sh',
    // The release-proven self-test manifest rides beside the vendored tools so
    // the installed verify.mjs can pass byte-identical tools without spawning
    // their already-proven self-tests.
    'self-test-manifest.json',
    'guard-corpus.json',
    ...(nonManual ? NON_MANUAL_TOOL_FILES : []),
  ];
  for (const name of tools) {
    const source = join(
      templates,
      'tools',
      TOOL_SOURCE_NAMES[name] ?? name,
    );
    const bytes = readFileSync(source);
    const target = resolve(root, 'tools', 'agentic', name);
    if (
      PRESERVE_IF_MODIFIED.has(name)
      && existsSync(target)
      && Buffer.compare(readFileSync(target), bytes) !== 0
    ) {
      results.push({
        path: `tools/agentic/${name}`,
        action: 'kept-modified',
        source: `templates/tools/${TOOL_SOURCE_NAMES[name] ?? name}`,
      });
      warnings.push(
        `tools/agentic/${name} differs from the template and may carry `
        + `${PRESERVE_IF_MODIFIED.get(name)}; reconcile it in the visible diff `
        + 'instead of overwriting',
      );
      continue;
    }
    writeArtifact(
      root,
      `tools/agentic/${name}`,
      bytes,
      results,
      name.endsWith('.sh') ? 0o755 : undefined,
      audit,
      `templates/tools/${TOOL_SOURCE_NAMES[name] ?? name}`,
    );
  }
  if (!nonManual) {
    for (const name of NON_MANUAL_TOOL_FILES) {
      const stale = resolve(root, 'tools', 'agentic', name);
      if (existsSync(stale)) {
        if (!audit) unlinkSync(stale);
        results.push({ path: `tools/agentic/${name}`, action: 'removed' });
      }
    }
  }

  for (const [templateName, relativePath] of HOST_ARTIFACTS) {
    writeArtifact(
      root,
      relativePath,
      readFileSync(join(templates, templateName)),
      results,
      undefined,
      audit,
      `templates/${templateName}`,
    );
  }

  for (const [templateName, relativePath] of HOOK_MERGES) {
    const template = readJson(join(templates, templateName));
    const target = resolve(root, relativePath);
    const existing = existsSync(target) ? readJson(target) : null;
    const { merged, changed } = mergeHookDocuments(existing, template);
    if (existing === null) {
      writeArtifact(
        root,
        relativePath,
        stableJson(merged),
        results,
        undefined,
        audit,
        `templates/${templateName}`,
      );
    } else if (changed) {
      if (!audit) writeFileSync(target, stableJson(merged));
      results.push({ path: relativePath, action: 'merged' });
    } else {
      results.push({ path: relativePath, action: 'identical' });
    }
  }

  // Legacy root opencode.json folds into .opencode/opencode.json; the
  // repository's own values win over the template's.
  const template = readJson(join(templates, 'opencode-config.template.json'));
  const contained = resolve(root, '.opencode', 'opencode.json');
  const legacyPath = resolve(root, 'opencode.json');
  let existingConfig = existsSync(contained) ? readJson(contained) : null;
  if (existsSync(legacyPath)) {
    existingConfig = mergeOpencodeConfig(readJson(legacyPath), existingConfig ?? {});
    if (!audit) unlinkSync(legacyPath);
    results.push({ path: 'opencode.json', action: 'removed' });
  }
  writeArtifact(
    root,
    '.opencode/opencode.json',
    stableJson(mergeOpencodeConfig(existingConfig, template)),
    results,
    undefined,
    audit,
    'templates/opencode-config.template.json',
  );

  const loop = resolve(root, 'docs', 'agentic', 'LOOP.md');
  const loopTemplate = readFileSync(join(templates, 'LOOP.template.md'));
  if (!existsSync(loop)) {
    writeArtifact(
      root,
      'docs/agentic/LOOP.md',
      loopTemplate,
      results,
      undefined,
      audit,
      'templates/LOOP.template.md',
    );
  } else if (Buffer.compare(readFileSync(loop), loopTemplate) === 0) {
    results.push({ path: 'docs/agentic/LOOP.md', action: 'identical' });
  } else {
    results.push({ path: 'docs/agentic/LOOP.md', action: 'kept' });
    warnings.push(
      'docs/agentic/LOOP.md differs from the template; merge it with '
      + '`scaffold.mjs --merge-loop <root>` and review that typed report',
    );
  }

  // Durable memory is MOVED, never dropped: a repository that predates the
  // split keeps its lessons inside the injected STATE, and the merge would
  // otherwise fail closed on a repo-appended heading the template no longer
  // has. Relocating first makes the merge clean and costs the repository
  // nothing — the content lands in LESSONS.md before it leaves STATE.
  for (const migration of REPO_MIGRATIONS) {
    const outcome = migration.apply(root, templates, audit);
    if (outcome === null) continue;
    results.push({ ...outcome.result, migration: migration.id });
    warnings.push(`${migration.id}: ${outcome.warning}`);
  }

  // LESSONS is durable repository memory: seeded once, never overwritten, and
  // deliberately NOT injected — STATE is, which is why lessons moved out of it.
  const lessons = resolve(root, 'docs', 'agentic', 'LESSONS.md');
  if (!existsSync(lessons)) {
    writeArtifact(
      root,
      'docs/agentic/LESSONS.md',
      readFileSync(join(templates, 'LESSONS.template.md')),
      results,
      undefined,
      audit,
      'templates/LESSONS.template.md',
    );
  } else {
    results.push({ path: 'docs/agentic/LESSONS.md', action: 'kept' });
  }
  // STATE drift is reported the same way LOOP's is. Without this an operator
  // could reconcile, watch the lessons migrate, and never learn that the
  // template prose in STATE — every byte of it injected into every session — is
  // still the version they installed with.
  const statePath = resolve(root, 'docs', 'agentic', 'STATE.md');
  if (existsSync(statePath)) {
    const stateTemplate = readFileSync(join(templates, TEMPLATE_MARKER));
    if (Buffer.compare(readFileSync(statePath), stateTemplate) === 0) {
      results.push({ path: 'docs/agentic/STATE.md', action: 'identical' });
    } else {
      results.push({ path: 'docs/agentic/STATE.md', action: 'kept' });
      warnings.push(
        'docs/agentic/STATE.md differs from the template; merge it with '
        + '`scaffold.mjs --merge-state <root>` and review that typed report — STATE is injected '
        + 'into every session, so stale template prose is paid for on every run',
      );
    }
  }

  // The committed CI policy is retired (docs/specs/simple-delivery.md): the
  // delivery predicate is the triggered-checks floor, so a lingering copy is
  // dead configuration that reads as authoritative. Reconcile removes it in the
  // visible diff (audit mode only reports).
  const ciPolicyPath = resolve(root, '.autoloop', 'ci-policy.json');
  if (existsSync(ciPolicyPath)) {
    if (!audit) unlinkSync(ciPolicyPath);
    results.push({ path: '.autoloop/ci-policy.json', action: 'removed' });
    warnings.push(
      '.autoloop/ci-policy.json is retired (docs/specs/simple-delivery.md); '
      + (audit ? 'reconcile will remove it' : 'removed it — commit the deletion'),
    );
  }
  if (config !== null) {
    const checklist = resolve(root, config.review.checklistPath);
    if (!existsSync(checklist)) {
      warnings.push(`${config.review.checklistPath} is absent; author the review checklist`);
    }
  }
  return {
    version: 1,
    nonManualTooling: nonManual,
    results: results.sort((left, right) => left.path.localeCompare(right.path)),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// STATE / LOOP document merge
//
// A template rewrite deletes and renames prose wholesale while every install
// carries repository-owned content that must survive. Reading the template in
// fragments and hand-splicing the prose cost over half of a measured
// 11.2-minute migration, so the splice is mechanical here and the model only
// adjudicates what the report flags.
//
// The template declares its own repository-owned regions with {{PLACEHOLDER}}
// markers, and each marker's shape says how that region merges:
//   * sole content of a fenced block (the ```json autoloop-config``` block) —
//     the fence content comes from the install, the surrounding prose from the
//     template;
//   * alone on the line after a list (the extra escalate paths) — the
//     repository's own entries are spliced back after the template's;
//   * alone on its line anywhere else (Mission's guidance, spec docs, and
//     invariants) — the whole section is repository prose, preserved verbatim
//     under the template's heading;
//   * inside a line of prose (LOOP's project name, checklist path, and gate
//     command) — a scalar value, taken from the machine-readable config where
//     the config owns it and otherwise recovered by aligning that exact
//     template line against the installed document.
// Everything else is template-owned and arrives verbatim. Nothing is dropped:
// an installed section with no template counterpart is preserved in place and
// reported `needs-human-review`, and any structural ambiguity that could lose
// repository bytes yields the report and no merged document at all.
// ---------------------------------------------------------------------------

function headingKey(level, title) {
  return `${'#'.repeat(level)} ${title.toLowerCase().replace(/\s+/gu, ' ').trim()}`;
}

function fenceDelimiter(line) {
  const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  return match === null ? null : { marker: match[1], info: match[2].trim() };
}

function closesFence(fence, open) {
  return fence.marker[0] === open.marker[0]
    && fence.marker.length >= open.marker.length
    && fence.info === '';
}

function trimTrailingBlanks(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(0, end);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// Flat parse: the title and the prose before the first sub-heading are the
// preamble, and every heading below the title starts a section. A heading
// inside a fenced block is content — STATE's injection-guardrail snippet
// contains one.
function parseSections(text) {
  const lines = String(text).replace(/\r\n/gu, '\n').split('\n');
  const preamble = [];
  const sections = [];
  let open = null;
  let current = null;
  for (const line of lines) {
    const fence = fenceDelimiter(line);
    if (fence !== null) {
      if (open === null) open = fence;
      else if (closesFence(fence, open)) open = null;
    } else if (open === null) {
      const heading = /^(#{2,6})\s+(\S.*?)\s*$/u.exec(line);
      if (heading !== null) {
        current = {
          level: heading[1].length,
          title: heading[2],
          key: headingKey(heading[1].length, heading[2]),
          body: [],
        };
        sections.push(current);
        continue;
      }
    }
    (current === null ? preamble : current.body).push(line);
  }
  for (const section of sections) section.body = trimTrailingBlanks(section.body);
  return {
    preamble: trimTrailingBlanks(preamble),
    sections,
    unterminatedFence: open !== null,
  };
}

function renderDocument(preamble, blocks) {
  const parts = preamble.length > 0 ? [preamble.join('\n')] : [];
  for (const block of blocks) {
    parts.push([`${'#'.repeat(block.level)} ${block.title}`, ...block.body].join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

// The contiguous non-blank run ending just above `index` is a list when any of
// its lines opens a list item; that makes the placeholder a list extension
// point rather than a whole-section repository hole.
function listRunAbove(lines, index) {
  let start = index;
  while (start > 0 && lines[start - 1].trim() !== '') start -= 1;
  if (start === index) return null;
  return lines.slice(start, index).some((line) => LIST_MARKER.test(line)) ? start : null;
}

function classifyHoles(body) {
  const holes = [];
  let open = null;
  let fenceStart = -1;
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index];
    const fence = fenceDelimiter(line);
    if (fence !== null) {
      if (open === null) {
        open = fence;
        fenceStart = index;
      } else if (closesFence(fence, open)) {
        const inner = body.slice(fenceStart + 1, index);
        const sole = inner.length === 1 ? SOLE_PLACEHOLDER.exec(inner[0]) : null;
        if (sole !== null) {
          holes.push({
            kind: 'fence', name: sole[1], info: open.info, start: fenceStart, end: index,
          });
        }
        open = null;
      }
      continue;
    }
    if (open !== null) continue;
    const sole = SOLE_PLACEHOLDER.exec(line);
    if (sole !== null) {
      const listStart = listRunAbove(body, index);
      holes.push(listStart === null
        ? { kind: 'block', name: sole[1], index }
        : { kind: 'list', name: sole[1], index, listStart });
      continue;
    }
    for (const match of line.matchAll(PLACEHOLDER_PATTERN)) {
      holes.push({ kind: 'inline', name: match[1], index });
    }
  }
  return holes;
}

function listItemLabel(line) {
  const text = line.replace(LIST_MARKER, '').trim();
  const bold = /^\*\*(.+?)\*\*/u.exec(text);
  return (bold === null ? text : bold[1]).toLowerCase().replace(/\s+/gu, ' ').trim();
}

function parseListItems(lines) {
  const items = [];
  for (const line of lines) {
    if (LIST_MARKER.test(line)) items.push([line]);
    else if (items.length > 0) items[items.length - 1].push(line);
  }
  return items.map((lines_) => ({ lines: lines_, label: listItemLabel(lines_[0]) }));
}

function listRuns(lines) {
  const runs = [];
  let start = -1;
  for (let index = 0; index <= lines.length; index += 1) {
    const blank = index === lines.length || lines[index].trim() === '';
    if (!blank) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0) {
      const run = lines.slice(start, index);
      if (run.some((line) => LIST_MARKER.test(line))) runs.push(run);
      start = -1;
    }
  }
  return runs;
}

function fenceBlocks(text) {
  const lines = String(text).replace(/\r\n/gu, '\n').split('\n');
  const blocks = [];
  let open = null;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const fence = fenceDelimiter(lines[index]);
    if (fence === null) continue;
    if (open === null) {
      open = fence;
      start = index;
    } else if (closesFence(fence, open)) {
      blocks.push({ info: open.info, content: lines.slice(start + 1, index) });
      open = null;
    }
  }
  return blocks;
}

// A template line carrying inline placeholders becomes a pattern; the installed
// document must answer it with exactly one distinct value tuple, or the value
// is unresolved and the merge fails closed rather than guessing.
function alignLine(line, installLines) {
  const names = [...line.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
  if (names.length === 0) return null;
  const literals = line.split(/\{\{[A-Z0-9_]+\}\}/gu).map(escapeRegExp);
  const pattern = new RegExp(`^${literals.join('(.+?)')}$`, 'u');
  const tuples = new Map();
  for (const candidate of installLines) {
    const match = pattern.exec(candidate);
    if (match === null) continue;
    tuples.set(JSON.stringify(match.slice(1)), match.slice(1));
  }
  if (tuples.size !== 1) return null;
  const values = [...tuples.values()][0];
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

// Extracts a legacy "Lessons learned" section from STATE and appends it to
// LESSONS.md. Ordering is deliberate: LESSONS is written and re-read before
// STATE is rewritten, so an interrupted migration leaves duplicated memory
// rather than lost memory.
export function extractSection(documentText, headingPrefix) {
  const escaped = headingPrefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`^##\\s+${escaped}[^\\n]*$`, 'mu').exec(documentText ?? '');
  if (!match) return null;
  const start = match.index;
  const rest = documentText.slice(start + match[0].length);
  const next = /^##\s+/mu.exec(rest);
  const end = next === null
    ? documentText.length
    : start + match[0].length + next.index;
  const section = documentText.slice(start, end).trimEnd();
  const remainder = `${documentText.slice(0, start).trimEnd()}\n${documentText.slice(end)}`;
  return { section, remainder: `${remainder.trimEnd()}\n` };
}

export function extractLessonsSection(stateText) {
  const match = /^##\s+Lessons learned[^\n]*$/mu.exec(stateText ?? '');
  if (!match) return null;
  const start = match.index;
  const rest = stateText.slice(start + match[0].length);
  const next = /^##\s+/mu.exec(rest);
  const end = next === null ? stateText.length : start + match[0].length + next.index;
  const section = stateText.slice(start, end).trimEnd();
  const remainder = `${stateText.slice(0, start).trimEnd()}\n${stateText.slice(end)}`;
  return { section, remainder: `${remainder.trimEnd()}\n` };
}

// Upgrade jobs. Every entry is idempotent (a second reconcile is a no-op),
// writes the new home before clearing the old one, and REPORTS what it moved —
// an upgrade that a repository cannot see in its diff is indistinguishable from
// the loop rewriting its own policy. Reconcile runs them in order before any
// document merge, so a merge never meets a half-migrated file.
const REPO_MIGRATIONS = Object.freeze([
  Object.freeze({ id: 'lessons-out-of-state', apply: migrateLessons }),
  Object.freeze({ id: 'retired-state-sections', apply: retireStateSections }),
]);

// Sections the template used to own and no longer does. The merge cannot drop
// them itself — it preserves any installed section without a counterpart,
// which is exactly the rule that protects repository content — so retiring
// template prose is a migration's job. Every heading here was authored by the
// template alone: repositories append lessons, never playbooks, so removing
// them costs a repository nothing and is recoverable from git history.
const RETIRED_STATE_HEADINGS = Object.freeze([
  'Roles — code writer ≠ code reviewer',
  'Playbooks — decision-making with no human in the loop',
  'Queue-drain stop condition',
]);

function retireStateSections(root, templates, audit) {
  const statePath = resolve(root, 'docs', 'agentic', 'STATE.md');
  if (!existsSync(statePath)) return null;
  let text = readFileSync(statePath, 'utf8');
  const removed = [];
  for (const heading of RETIRED_STATE_HEADINGS) {
    const extracted = extractSection(text, heading);
    if (extracted === null) continue;
    removed.push(heading);
    text = extracted.remainder;
  }
  if (removed.length === 0) return null;
  if (!audit) writeFileSync(statePath, text);
  return {
    result: { path: 'docs/agentic/STATE.md', action: 'retired-sections', sections: removed },
    warning:
      `removed ${removed.length} section(s) the template no longer owns from `
      + `docs/agentic/STATE.md (${removed.join('; ')}) — every byte of STATE is injected into `
      + 'every session, and the skills now carry this material. Review the diff; git history has '
      + 'the text if a repository customised any of it'
      + (audit ? ' (audit mode: nothing was written)' : ''),
  };
}

function migrateLessons(root, templates, audit) {
  const statePath = resolve(root, 'docs', 'agentic', 'STATE.md');
  if (!existsSync(statePath)) return null;
  const extracted = extractLessonsSection(readFileSync(statePath, 'utf8'));
  if (extracted === null) return null;
  const lessonsPath = resolve(root, 'docs', 'agentic', 'LESSONS.md');
  if (!audit) {
    const base = existsSync(lessonsPath)
      ? readFileSync(lessonsPath, 'utf8')
      : readFileSync(join(templates, 'LESSONS.template.md'), 'utf8');
    mkdirSync(dirname(lessonsPath), { recursive: true });
    writeFileSync(
      lessonsPath,
      `${base.trimEnd()}\n\n<!-- moved from STATE.md by autoloop:setup -->\n${extracted.section}\n`,
    );
    // Only once the memory is durable somewhere else does it leave STATE.
    writeFileSync(statePath, extracted.remainder);
  }
  return {
    result: { path: 'docs/agentic/LESSONS.md', action: 'migrated' },
    warning:
      'moved the "Lessons learned" section out of docs/agentic/STATE.md into '
      + 'docs/agentic/LESSONS.md — STATE is injected into every session, LESSONS is read on '
      + 'demand. Review both files in the diff'
      + (audit ? ' (audit mode: nothing was written)' : ''),
  };
}

export function mergeDocument(templateText, installText, options = {}) {
  const {
    config = null,
    repoAppendedHeadings = [],
    label = 'document',
  } = options;
  const ambiguities = [];
  const warnings = [];
  const template = parseSections(templateText);
  const install = parseSections(installText);
  if (template.unterminatedFence) ambiguities.push('the template has an unterminated fenced block');
  if (install.unterminatedFence) {
    ambiguities.push('the installed document has an unterminated fenced block');
  }
  for (const [parsed, which] of [[template, 'the template'], [install, 'the installed document']]) {
    const seen = new Set();
    for (const section of parsed.sections) {
      if (seen.has(section.key)) {
        ambiguities.push(
          `${which} repeats the heading "${section.title}"; repeated headings cannot be matched`,
        );
      }
      seen.add(section.key);
    }
  }
  const appended = new Set(repoAppendedHeadings);
  const templateKeys = new Set(template.sections.map((section) => section.key));
  for (const key of appended) {
    if (!templateKeys.has(key)) {
      ambiguities.push(
        `the template no longer contains the repository-appended section "${key}"; `
        + 'classify it by hand before merging, or its repository content is replaced',
      );
    }
  }
  const installByKey = new Map(install.sections.map((section) => [section.key, section]));
  const installFences = fenceBlocks(installText);
  const preservedTexts = [];
  const filledFenceInfos = [];
  // A hole whose fill already failed keeps its marker in the assembled text;
  // the failure is reported once, not again as an unresolved value.
  const unfilledHoles = new Set();

  const sections = [];
  const merges = new Map();
  for (const templateSection of template.sections) {
    const heading = `${'#'.repeat(templateSection.level)} ${templateSection.title}`;
    const installed = installByKey.get(templateSection.key) ?? null;
    const holes = classifyHoles(templateSection.body);
    if (appended.has(templateSection.key) || holes.some((hole) => hole.kind === 'block')) {
      const preserve = installed !== null;
      if (preserve) preservedTexts.push(installed.body.join('\n'));
      merges.set(templateSection.key, {
        level: templateSection.level,
        title: templateSection.title,
        body: preserve ? installed.body : templateSection.body,
      });
      sections.push({
        heading,
        ownership: 'repository',
        action: preserve ? 'preserved' : 'new',
      });
      continue;
    }
    const body = [...templateSection.body];
    const preserved = [];
    for (const hole of [...holes].reverse()) {
      if (hole.kind === 'fence') {
        const matches = installFences.filter((block) => block.info === hole.info);
        if (matches.length !== 1) {
          ambiguities.push(
            `the installed document holds ${matches.length} \`${hole.info}\` blocks; `
            + 'exactly one is required to fill the template block',
          );
          unfilledHoles.add(hole.name);
          continue;
        }
        const content = matches[0].content;
        body.splice(hole.start + 1, hole.end - hole.start - 1, ...content);
        preservedTexts.push(content.join('\n'));
        filledFenceInfos.push(hole.info);
        let version = null;
        try {
          version = JSON.parse(content.join('\n'))?.version ?? null;
        } catch {
          version = null;
        }
        if (hole.info === 'json autoloop-config') {
          if (version === null) {
            warnings.push(
              'the preserved autoloop-config block is not valid JSON with a version; '
              + 'validate it with config-contract.mjs before committing',
            );
          } else if (version !== CONFIG_VERSION) {
            warnings.push(
              `the preserved autoloop-config records version ${version} and the current `
              + `schema is ${CONFIG_VERSION}; land the migrated configuration in this same commit`,
            );
          }
        }
        const stamp = version === null ? '' : ` (version ${version})`;
        preserved.push(`the \`${hole.info}\` block${stamp}`);
        continue;
      }
      if (hole.kind !== 'list') continue;
      const templateItems = parseListItems(body.slice(hole.listStart, hole.index));
      const labels = new Set(templateItems.map((item) => item.label));
      const candidates = installed === null
        ? []
        : listRuns(installed.body)
          .map((run) => parseListItems(run))
          .map((items) => ({
            items,
            overlap: items.filter((item) => labels.has(item.label)).length,
          }))
          .sort((left, right) => right.overlap - left.overlap);
      if (candidates.length > 0 && candidates[0].overlap === 0) {
        ambiguities.push(
          `no list under "${templateSection.title}" aligns with the template's list, so `
          + 'repository entries there cannot be told apart from template entries',
        );
        unfilledHoles.add(hole.name);
        continue;
      }
      const extras = candidates.length === 0
        ? []
        : candidates[0].items.filter((item) => !labels.has(item.label));
      body.splice(hole.index, 1, ...extras.flatMap((item) => item.lines));
      for (const item of extras) preservedTexts.push(item.lines.join('\n'));
      if (extras.length > 0) {
        preserved.push(
          `${extras.length} repository list ${extras.length === 1 ? 'entry' : 'entries'} `
          + `(${extras.map((item) => item.label).join(', ')})`,
        );
      }
    }
    merges.set(templateSection.key, {
      level: templateSection.level,
      title: templateSection.title,
      body,
    });
    const entry = {
      heading,
      ownership: 'template',
      action: installed === null ? 'new' : 'from-template',
    };
    if (preserved.length > 0) entry.preserved = preserved;
    sections.push(entry);
  }

  // An installed section with no template counterpart keeps its position: it is
  // emitted after the merged form of the nearest preceding matched section.
  const anchored = new Map();
  let anchor = '';
  for (const section of install.sections) {
    if (templateKeys.has(section.key)) {
      anchor = section.key;
      continue;
    }
    if (!anchored.has(anchor)) anchored.set(anchor, []);
    anchored.get(anchor).push(section);
    preservedTexts.push(section.body.join('\n'));
    sections.push({
      heading: `${'#'.repeat(section.level)} ${section.title}`,
      ownership: 'unclassified',
      action: 'needs-human-review',
      reason: 'the template has no counterpart section; keep, fold, or delete it by hand',
    });
  }
  const orphanBlocks = (key) => (anchored.get(key) ?? []).map((section) => ({
    level: section.level,
    title: section.title,
    body: section.body,
  }));
  const blocks = [...orphanBlocks('')];
  for (const templateSection of template.sections) {
    blocks.push(merges.get(templateSection.key));
    blocks.push(...orphanBlocks(templateSection.key));
  }

  let text = renderDocument(template.preamble, blocks);
  const installLines = String(installText).replace(/\r\n/gu, '\n').split('\n');
  const values = {};
  for (const [name, read] of Object.entries(CONFIG_VALUE_SOURCES)) {
    const value = read(config);
    if (typeof value === 'string' && value.length > 0 && text.includes(`{{${name}}}`)) {
      values[name] = { value, source: 'autoloop-config' };
      text = text.split(`{{${name}}}`).join(value);
    }
  }
  for (const line of text.split('\n')) {
    if (!HAS_PLACEHOLDER.test(line)) continue;
    const resolved = alignLine(line, installLines);
    if (resolved === null) continue;
    for (const [name, value] of Object.entries(resolved)) {
      const bound = values[name];
      if (bound === undefined) {
        values[name] = { value, source: 'installed line' };
      } else if (bound.source === 'installed line' && bound.value !== value) {
        ambiguities.push(
          `{{${name}}} aligns to both "${bound.value}" and "${value}" in the installed `
          + 'document; the value is not recoverable',
        );
      }
    }
  }
  for (const [name, entry] of Object.entries(values)) {
    text = text.split(`{{${name}}}`).join(entry.value);
  }
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(PLACEHOLDER_PATTERN)) {
      if (unfilledHoles.has(match[1])) continue;
      ambiguities.push(
        `{{${match[1]}}} has no value: no installed line matches the template line `
        + `"${line.trim()}"`,
      );
    }
  }
  const mergedFences = fenceBlocks(text);
  for (const info of new Set(filledFenceInfos)) {
    const count = mergedFences.filter((block) => block.info === info).length;
    if (count !== 1) {
      ambiguities.push(
        `the merged document would hold ${count} \`${info}\` blocks; a duplicate arrives with a `
        + 'section that has no template counterpart — resolve that section first',
      );
    }
  }
  for (const preserved of preservedTexts) {
    if (preserved.length > 0 && !text.includes(preserved)) {
      ambiguities.push(
        'a preserved repository region did not survive assembly verbatim: '
        + `"${preserved.split('\n')[0].trim()}"`,
      );
    }
  }
  const counts = {
    fromTemplate: sections.filter((entry) => entry.action === 'from-template').length,
    preserved: sections.filter((entry) => entry.action === 'preserved').length,
    new: sections.filter((entry) => entry.action === 'new').length,
    needsHumanReview: sections.filter((entry) => entry.action === 'needs-human-review').length,
  };
  if (counts.needsHumanReview > 0 && counts.new > 0) {
    warnings.push(
      `${counts.needsHumanReview} installed section(s) have no template counterpart while `
      + `${counts.new} template section(s) are new; a renamed section appears as both`,
    );
  }
  return {
    report: {
      version: 1,
      document: label,
      ok: ambiguities.length === 0,
      wrote: false,
      changed: null,
      counts,
      values,
      sections,
      warnings,
      ambiguities,
    },
    merged: ambiguities.length === 0 ? text : null,
  };
}

function readInstalledConfig(root) {
  try {
    return extractConfig(readFileSync(resolve(root, 'docs', 'agentic', 'STATE.md'), 'utf8'));
  } catch {
    return null;
  }
}

export function mergeDocumentFiles(root, templates, kind, { write = false } = {}) {
  const spec = MERGE_DOCUMENTS[kind];
  if (spec === undefined) throw new Error(`unknown document ${kind}`);
  if (!existsSync(join(templates, TEMPLATE_MARKER))) {
    throw new Error(
      `templates directory ${templates} does not contain ${TEMPLATE_MARKER}; `
      + 'pass --templates <plugin templates dir>',
    );
  }
  const installPath = resolve(root, spec.install);
  if (!existsSync(installPath)) {
    throw new Error(
      `${spec.install} does not exist; a fresh install is scaffolded by --reconcile, not merged`,
    );
  }
  const installText = readFileSync(installPath, 'utf8');
  const templateText = readFileSync(join(templates, spec.template), 'utf8');
  // Fail closed on memory the migrations have not relocated yet — but only when
  // THIS template has no counterpart heading, which is what makes the merge
  // destructive. A template that still owns the section merges it normally.
  if (
    kind === 'state'
    && extractLessonsSection(installText) !== null
    && extractLessonsSection(templateText) === null
  ) {
    throw new Error(
      `${spec.install} still carries a "Lessons learned" section; run `
      + '`scaffold.mjs --reconcile <root>` first — it moves durable memory into '
      + 'docs/agentic/LESSONS.md, which this merge would otherwise replace',
    );
  }
  const { report, merged } = mergeDocument(
    templateText,
    installText,
    {
      config: readInstalledConfig(root),
      label: spec.label,
      repoAppendedHeadings: spec.repoAppendedHeadings,
    },
  );
  report.template = `templates/${spec.template}`;
  report.install = spec.install;
  if (merged !== null) {
    report.changed = merged !== installText;
    if (write) {
      if (report.changed) writeFileSync(installPath, merged);
      report.wrote = true;
    }
  }
  return { report, merged };
}

function fixtureTemplates() {
  const templates = mkdtempSync(join(tmpdir(), 'autoloop-scaffold-templates-'));
  mkdirSync(join(templates, 'tools'), { recursive: true });
  writeFileSync(join(templates, TEMPLATE_MARKER), '# state template\n');
  writeFileSync(join(templates, 'LOOP.template.md'), '# loop template\n');
  writeFileSync(join(templates, 'LESSONS.template.md'), '# lessons template\n');
  writeFileSync(
    join(templates, 'opencode-config.template.json'),
    stableJson({ instructions: ['docs/agentic/STATE.md'], permission: { read: 'allow' } }),
  );
  for (const [templateName] of HOST_ARTIFACTS) {
    writeFileSync(join(templates, templateName), `fixture ${templateName}\n`);
  }
  for (const [templateName] of HOOK_MERGES) {
    writeFileSync(join(templates, templateName), stableJson({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'fixture-guard' }] }],
      },
    }));
  }
  const names = new Set([
    ...UNIVERSAL_TOOL_FILES.map((name) => TOOL_SOURCE_NAMES[name] ?? name),
    ...NON_MANUAL_TOOL_FILES.map((name) => TOOL_SOURCE_NAMES[name] ?? name),
    'session-preflight.sh',
    'dispatch-stream.sh',
    'self-test-manifest.json',
    'guard-corpus.json',
  ]);
  for (const name of names) {
    writeFileSync(join(templates, 'tools', name), `// fixture ${name}\n`);
  }
  return templates;
}

function fixtureState(policy) {
  const merge = policy === 'manual'
    ? { policy }
    : { policy, unverifiedInvocationAcknowledged: true };
  return [
    '# STATE',
    '',
    '```json autoloop-config',
    JSON.stringify({
      version: '0.26.0',
      baseBranch: 'main',
      gate: { command: 'npm test', quickCommand: null, setupCommand: null },
      merge,
      tracker: { provider: 'none' },
      review: { checklistPath: 'docs/agentic/checklist.md' },
      caps: {
        gateRetriesPerUnit: 2,
        reviseRoundsPerPr: 3,
        codeReviewRoundsPerUnit: 5,
        sliceMaxLines: 700,
        sliceMaxFiles: 10,
      },
    }, null, 2),
    '```',
    '',
  ].join('\n');
}

const FIXTURE_CONFIG = Object.freeze({
  version: '0.25.0',
  baseBranch: 'main',
  gate: { command: 'npm test', quickCommand: null, setupCommand: null },
  merge: { policy: 'manual' },
  tracker: { provider: 'none' },
  review: { checklistPath: 'docs/agentic/checklist.md' },
});

function fixtureStateTemplate() {
  return [
    '# STATE — fixture',
    '',
    '> Standing prose the template owns.',
    '',
    '## Mission (the VISION)',
    '',
    'Develop and maintain **{{PROJECT_NAME}}** to spec.',
    '',
    '{{REPO_GUIDANCE}}',
    '',
    'The load-bearing invariants:',
    '',
    '{{INVARIANTS}}',
    '',
    '## Config (the machine-readable surface)',
    '',
    'Config prose rewritten in this template version.',
    '',
    '```json autoloop-config',
    '{{CONFIG_JSON}}',
    '```',
    '',
    '## Roles — writer ≠ reviewer',
    '',
    'Renamed from "Runtime and roles" in this template version.',
    '',
    '### Escalate-list',
    '',
    '- **secrets / env**: `.env*`.',
    '- **deploy / ops**: `Dockerfile*`,',
    '  `.github/workflows/*`.',
    '{{ESCALATE_PATHS}}',
    '',
    '## Digest',
    '',
    'New in this template version.',
    '',
    '## Lessons learned (durable rules; write here, not in chat)',
    '',
    '- **Seed lesson.** Shipped by the template.',
    '',
  ].join('\n');
}

function fixtureStateInstall(extraFence = false) {
  return [
    '# STATE — fixture',
    '',
    '> Older standing prose the template rewrote.',
    '',
    '## Mission (the VISION)',
    '',
    'Develop and maintain **Fixture Project** to spec.',
    '',
    '- `AGENTS.md` — repository guidance.',
    '',
    'The load-bearing invariants:',
    '',
    '- Determinism is byte-exact.',
    '- No ambient randomness.',
    '',
    '## Config (the machine-readable surface)',
    '',
    'Older config prose that the new template deleted.',
    '',
    '```json autoloop-config',
    JSON.stringify(FIXTURE_CONFIG, null, 2),
    '```',
    '',
    '## Runtime and roles — invocation-scoped',
    '',
    'Template prose the new version deleted under a renamed heading.',
    ...(extraFence
      ? ['', '```json autoloop-config', '{ "version": "0.24.0" }', '```']
      : []),
    '',
    '### Escalate-list',
    '',
    '- **secrets / env**: `.env*`.',
    '- **deploy / ops**: `Dockerfile*`,',
    '  `.github/workflows/*`.',
    '- **authoritative specification**: `spec/**`.',
    '',
    '## Queue & progress',
    '',
    'A repository section the new template has no counterpart for.',
    '',
    '## Lessons learned (durable rules; write here, not in chat)',
    '',
    '- **Seed lesson.** Shipped by the template.',
    '- **Repository lesson.** Written by this repository.',
    '',
  ].join('\n');
}

function fixtureLoopTemplate() {
  return [
    '# The autoloop — fixture runbook',
    '',
    'A standing loop for **{{PROJECT_NAME}}**, driven from one session.',
    '',
    '## The pieces',
    '',
    '| Asset | Role |',
    '|---|---|',
    '| `{{CHECKLIST_PATH}}` | the criteria both reviewers grade against |',
    '| `{{GATE_COMMAND}}` | the objective gate — the only source of "done" |',
    '',
    '## Autonomy & safety',
    '',
    '- Non-zero `{{GATE_COMMAND}}` = not done. Rewritten in this template version.',
    '',
  ].join('\n');
}

function fixtureLoopInstall(alignable = true) {
  return [
    '# The autoloop — fixture runbook',
    '',
    alignable
      ? 'A standing loop for **Fixture Project**, driven from one session.'
      : 'An older sentence that shares no literal text with the new template line.',
    '',
    '## The pieces',
    '',
    '| Asset | Role |',
    '|---|---|',
    '| `docs/agentic/old-checklist.md` | the criteria both reviewers grade against |',
    '| `make check` | the objective gate — the only source of "done" |',
    '',
    '## Local operator notes',
    '',
    'A section this repository added to its own runbook.',
    '',
    '## Autonomy & safety',
    '',
    '- Non-zero `make check` = not done. Older wording.',
    '',
  ].join('\n');
}

function mergeSelfTest(expect) {
  const templates = mkdtempSync(join(tmpdir(), 'autoloop-merge-templates-'));
  const root = mkdtempSync(join(tmpdir(), 'autoloop-merge-root-'));
  try {
    writeFileSync(join(templates, TEMPLATE_MARKER), fixtureStateTemplate());
    writeFileSync(join(templates, 'LOOP.template.md'), fixtureLoopTemplate());
    const statePath = join(root, 'docs', 'agentic', 'STATE.md');
    const loopPath = join(root, 'docs', 'agentic', 'LOOP.md');
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, fixtureStateInstall());
    writeFileSync(loopPath, fixtureLoopInstall());

    // An unmigrated STATE is refused rather than silently stripped of memory:
    // the merge has no counterpart heading for it, so reconcile must relocate
    // it first.
    const splitTemplates = mkdtempSync(join(tmpdir(), 'autoloop-scaffold-split-'));
    for (const name of readdirSync(templates)) {
      const from = join(templates, name);
      if (statSync(from).isDirectory()) continue;
      writeFileSync(join(splitTemplates, name), readFileSync(from));
    }
    const lessonless = extractLessonsSection(fixtureStateTemplate());
    writeFileSync(join(splitTemplates, TEMPLATE_MARKER), lessonless.remainder);
    let unmigratedRefused = false;
    try {
      mergeDocumentFiles(root, splitTemplates, 'state');
    } catch (error) {
      unmigratedRefused = error.message.includes('LESSONS.md');
    }
    rmSync(splitTemplates, { recursive: true, force: true });
    expect('a STATE with unmigrated lessons is refused, not merged', unmigratedRefused);

    const migrated = extractLessonsSection(fixtureStateInstall());
    writeFileSync(statePath, migrated.remainder);
    const dry = mergeDocumentFiles(root, templates, 'state');
    const actions = new Map(dry.report.sections.map((entry) => [entry.heading, entry.action]));
    expect(
      'every repository-owned byte survives the merge',
      [
        'Fixture Project',
        '- `AGENTS.md` — repository guidance.',
        '- Determinism is byte-exact.',
        '- No ambient randomness.',
        '"version": "0.25.0"',
        '- **authoritative specification**: `spec/**`.',
        'A repository section the new template has no counterpart for.',
        'Template prose the new version deleted under a renamed heading.',
      ].every((fragment) => dry.merged.includes(fragment)),
    );
    expect(
      'template-owned prose is replaced wholesale, preamble included',
      dry.merged.includes('Standing prose the template owns.')
        && dry.merged.includes('Config prose rewritten in this template version.')
        && !dry.merged.includes('Older standing prose the template rewrote.')
        && !dry.merged.includes('Older config prose that the new template deleted.'),
    );
    expect(
      'a section the template added arrives as new',
      actions.get('## Digest') === 'new'
        && dry.merged.includes('New in this template version.')
        && actions.get('## Roles — writer ≠ reviewer') === 'new',
    );
    expect(
      'an installed section with no template counterpart is reported, never dropped',
      dry.report.counts.needsHumanReview === 2
        && actions.get('## Runtime and roles — invocation-scoped') === 'needs-human-review'
        && actions.get('## Queue & progress') === 'needs-human-review'
        && dry.report.warnings.some((warning) => warning.includes('renamed section')),
    );
    const preservedIn = (heading) =>
      dry.report.sections.find((entry) => entry.heading === heading)?.preserved?.[0];
    expect(
      'repository holes are filled surgically inside template-owned sections',
      preservedIn('## Config (the machine-readable surface)')
        === 'the `json autoloop-config` block (version 0.25.0)'
        && preservedIn('### Escalate-list')?.startsWith('1 repository list entry')
        && dry.merged.split('- **deploy / ops**').length === 2,
    );
    expect(
      'a preserved configuration older than the current schema is called out',
      dry.report.warnings.some((warning) =>
        warning.includes('version 0.25.0') && warning.includes(CONFIG_VERSION)),
    );
    expect(
      'the dry run writes nothing',
      dry.report.wrote === false
        && dry.report.changed === true
        && readFileSync(statePath, 'utf8') === migrated.remainder,
    );

    const written = mergeDocumentFiles(root, templates, 'state', { write: true });
    const again = mergeDocumentFiles(root, templates, 'state');
    expect(
      '--write applies the identical document and merging again is a no-op',
      written.report.wrote === true
        && readFileSync(statePath, 'utf8') === dry.merged
        && again.report.changed === false
        && again.report.ok === true,
    );

    writeFileSync(statePath, fixtureStateInstall(true));
    const ambiguous = mergeDocumentFiles(root, templates, 'state');
    expect(
      'two config blocks fail closed with a report and no merged document',
      ambiguous.merged === null
        && ambiguous.report.ok === false
        && ambiguous.report.ambiguities.some((entry) =>
          entry.includes('2 `json autoloop-config` blocks')),
    );

    const renamedLessons = mergeDocument(
      fixtureStateTemplate().replace(
        '## Lessons learned (durable rules; write here, not in chat)',
        '## Durable rules',
      ),
      fixtureStateInstall(),
      { repoAppendedHeadings: ['## lessons learned (durable rules; write here, not in chat)'] },
    );
    expect(
      'a template that renames repository memory fails closed instead of replacing it',
      renamedLessons.merged === null
        && renamedLessons.report.ambiguities.some((entry) =>
          entry.includes('repository-appended section')),
    );

    writeFileSync(statePath, fixtureStateInstall());
    const loop = mergeDocumentFiles(root, templates, 'loop');
    expect(
      'LOOP carries no repository sections: scalar values come from the config first',
      loop.report.values.GATE_COMMAND?.value === 'npm test'
        && loop.report.values.GATE_COMMAND?.source === 'autoloop-config'
        && loop.report.values.CHECKLIST_PATH?.value === 'docs/agentic/checklist.md'
        && loop.report.values.PROJECT_NAME?.value === 'Fixture Project'
        && loop.report.values.PROJECT_NAME?.source === 'installed line'
        && loop.merged.includes('| `npm test` | the objective gate')
        && loop.merged.includes('Rewritten in this template version.')
        && !loop.merged.includes('make check'),
    );
    expect(
      'a repository-added runbook section is preserved for human review',
      loop.report.counts.needsHumanReview === 1
        && loop.merged.includes('A section this repository added to its own runbook.'),
    );

    writeFileSync(loopPath, fixtureLoopInstall(false));
    const unresolved = mergeDocumentFiles(root, templates, 'loop');
    expect(
      'a value no installed line can answer fails closed instead of guessing',
      unresolved.merged === null
        && unresolved.report.ambiguities.some((entry) => entry.includes('{{PROJECT_NAME}}')),
    );

    let refused = false;
    try {
      mergeDocumentFiles(mkdtempSync(join(tmpdir(), 'autoloop-merge-empty-')), templates, 'state');
    } catch (error) {
      refused = error.message.includes('--reconcile');
    }
    expect('merging an absent document is refused, never scaffolded', refused);
  } finally {
    rmSync(templates, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

function selfTest() {
  let ok = true;
  let cases = 0;
  const expect = (name, pass) => {
    cases += 1;
    if (!pass) {
      console.error(`FAIL ${name}`);
      ok = false;
    }
  };
  const templates = fixtureTemplates();
  const root = mkdtempSync(join(tmpdir(), 'autoloop-scaffold-root-'));
  try {
    mkdirSync(join(root, 'docs', 'agentic'), { recursive: true });
    writeFileSync(join(root, 'docs', 'agentic', 'STATE.md'), fixtureState('manual'));
    writeFileSync(join(root, 'docs', 'agentic', 'checklist.md'), '# checklist\n');
    writeFileSync(join(root, 'opencode.json'), stableJson({
      instructions: ['docs/custom.md'],
      theme: 'dark',
    }));
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), stableJson({
      hooks: {
        PostToolUse: [{ hooks: [{ type: 'command', command: 'repo-owned' }] }],
      },
      permissions: { allow: ['Bash(ls:*)'] },
    }));

    const audited = reconcile(root, templates, { audit: true });
    const auditedActions = new Map(
      audited.results.map((entry) => [entry.path, entry.action]),
    );
    expect(
      'audit mode reports the full would-be reconciliation without writing',
      auditedActions.get('tools/agentic/verify.mjs') === 'created'
        && !existsSync(join(root, 'tools'))
        && existsSync(join(root, 'opencode.json'))
        && auditedActions.get('opencode.json') === 'removed',
    );

    const first = reconcile(root, templates);
    const actions = new Map(first.results.map((entry) => [entry.path, entry.action]));
    expect(
      'a manual repository vendors the universal set without the merge executor',
      actions.get('tools/agentic/verify.mjs') === 'created'
        && actions.get('tools/agentic/auto-merge.mjs') === undefined,
    );
    expect(
      'the release-proven self-test manifest is vendored beside the tools',
      actions.get('tools/agentic/self-test-manifest.json') === 'created',
    );
    expect(
      'a legacy root opencode.json folds into .opencode with repository values winning',
      actions.get('opencode.json') === 'removed'
        && (() => {
          const merged = readJson(join(root, '.opencode', 'opencode.json'));
          return merged.theme === 'dark'
            && merged.instructions[0] === 'docs/custom.md'
            && merged.instructions.includes('docs/agentic/STATE.md')
            && merged.permission.read === 'allow';
        })(),
    );
    expect(
      'hook merging appends the template entry and keeps repository-owned hooks',
      (() => {
        const settings = readJson(join(root, '.claude', 'settings.json'));
        return settings.permissions.allow[0] === 'Bash(ls:*)'
          && settings.hooks.PostToolUse[0].hooks[0].command === 'repo-owned'
          && settings.hooks.PreToolUse[0].hooks[0].command === 'fixture-guard';
      })(),
    );
    expect(
      'a superseded autoloop hook is replaced in place, not appended beside',
      (() => {
        // Live 0.45.0 reconcile: adding `|| exit 2` to the guard command made
        // the template entry not-"present", so the merge appended it and both
        // hosts ran the guard twice per Bash call — the stale copy without the
        // fail-closed suffix. Same vendored tool on the same event means the
        // existing entry is a superseded autoloop artifact: replace it.
        const oldGuard = 'if [ -f "$s" ]; then node "$s" --config "$c"; fi'
          .replace('"$s"', '"$r/tools/agentic/command-guard.mjs"');
        const newGuard = oldGuard.replace('--config "$c"', '--config "$c" || exit 2');
        const { merged, changed } = mergeHookDocuments(
          {
            hooks: {
              PreToolUse: [
                { matcher: 'Bash', hooks: [{ type: 'command', command: 'maintainer-own' }] },
                { matcher: 'Bash', hooks: [{ type: 'command', command: oldGuard }] },
              ],
            },
          },
          { hooks: { PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: newGuard }] },
          ] } },
        );
        return changed === true
          && merged.hooks.PreToolUse.length === 2
          && merged.hooks.PreToolUse[0].hooks[0].command === 'maintainer-own'
          && merged.hooks.PreToolUse[1].hooks[0].command === newGuard;
      })(),
    );
    expect(
      'an unchanged autoloop hook and maintainer hooks stay untouched',
      (() => {
        const guard = 'node "$r/tools/agentic/command-guard.mjs" --config "$c" || exit 2';
        const existing = {
          hooks: { PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'maintainer-own' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: guard }] },
          ] },
        };
        const { merged, changed } = mergeHookDocuments(
          existing,
          { hooks: { PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: guard }] },
          ] } },
        );
        return changed === false
          && JSON.stringify(merged) === JSON.stringify(existing);
      })(),
    );
    expect(
      'STATE drift is reported so the operator knows to merge it',
      (() => {
        const path = join(root, 'docs', 'agentic', 'STATE.md');
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n<!-- drifted -->\n`);
        const run = reconcile(root, templates, { audit: true });
        return run.results.some((entry) =>
          entry.path === 'docs/agentic/STATE.md' && entry.action === 'kept')
          && run.warnings.some((warning) => warning.includes('--merge-state'));
      })(),
    );
    expect(
      'lessons are seeded once and never overwritten',
      (() => {
        const path = join(root, 'docs', 'agentic', 'LESSONS.md');
        if (!existsSync(path)) return false;
        writeFileSync(path, '# repo memory\n- a hard-won rule\n');
        const again = reconcile(root, templates);
        return readFileSync(path, 'utf8').includes('a hard-won rule')
          && again.results.some((entry) =>
            entry.path === 'docs/agentic/LESSONS.md' && entry.action === 'kept');
      })(),
    );
    expect(
      'a legacy STATE has its lessons MOVED to LESSONS.md, and moving is idempotent',
      (() => {
        const path = join(root, 'docs', 'agentic', 'STATE.md');
        const lessonsPath = join(root, 'docs', 'agentic', 'LESSONS.md');
        const before = readFileSync(path, 'utf8');
        writeFileSync(path, `${before}\n## Lessons learned (durable rules)\n\n- legacy rule\n`);
        const audit = reconcile(root, templates, { audit: true });
        // Audit reports the move without performing it.
        if (
          !audit.results.some((entry) => entry.migration === 'lessons-out-of-state')
          || !readFileSync(path, 'utf8').includes('legacy rule')
          || readFileSync(lessonsPath, 'utf8').includes('legacy rule')
        ) {
          return false;
        }
        const run = reconcile(root, templates);
        const movedOut = !readFileSync(path, 'utf8').includes('legacy rule');
        const movedIn = readFileSync(lessonsPath, 'utf8').includes('legacy rule');
        const reported = run.results.some((entry) =>
          entry.migration === 'lessons-out-of-state');
        const again = reconcile(root, templates);
        const idempotent = !again.results.some((entry) =>
          entry.migration === 'lessons-out-of-state')
          && readFileSync(lessonsPath, 'utf8').match(/legacy rule/gu).length === 1;
        return movedOut && movedIn && reported && idempotent;
      })(),
    );
    expect(
      'a fresh scaffold never creates the retired CI policy',
      !first.results.some((entry) => entry.path === '.autoloop/ci-policy.json')
        && !existsSync(join(root, '.autoloop', 'ci-policy.json')),
    );
    mkdirSync(join(root, '.autoloop'), { recursive: true });
    writeFileSync(
      join(root, '.autoloop', 'ci-policy.json'),
      '{"schemaVersion":1,"requiredChecks":[]}\n',
    );
    const auditWithPolicy = reconcile(root, templates, { audit: true });
    expect(
      'audit reports the retired CI policy without deleting it',
      auditWithPolicy.results.some((entry) =>
        entry.path === '.autoloop/ci-policy.json' && entry.action === 'removed')
        && existsSync(join(root, '.autoloop', 'ci-policy.json')),
    );
    const removalRun = reconcile(root, templates);
    expect(
      'reconcile removes the retired CI policy and reports it',
      removalRun.results.some((entry) =>
        entry.path === '.autoloop/ci-policy.json' && entry.action === 'removed')
        && removalRun.warnings.some((warning) =>
          warning.includes('docs/specs/simple-delivery.md'))
        && !existsSync(join(root, '.autoloop', 'ci-policy.json')),
    );

    const second = reconcile(root, templates);
    expect(
      'a second run is idempotent',
      second.results.every((entry) =>
        ['identical', 'kept'].includes(entry.action)),
    );

    writeFileSync(
      join(root, 'tools', 'agentic', 'scan.mjs'),
      '// locally modified\n',
    );
    writeFileSync(
      join(root, 'tools', 'agentic', 'escalate-paths.mjs'),
      '// fixture escalate-paths.mjs with repo-owned spec/** entry\n',
    );
    const third = reconcile(root, templates);
    expect(
      'a locally modified vendored tool is refreshed and reported',
      third.results.some((entry) =>
        entry.path === 'tools/agentic/scan.mjs' && entry.action === 'refreshed'),
    );
    expect(
      'a modified policy-bearing tool is kept and warned about, never overwritten',
      third.results.some((entry) =>
        entry.path === 'tools/agentic/escalate-paths.mjs'
        && entry.action === 'kept-modified')
        && readFileSync(join(root, 'tools', 'agentic', 'escalate-paths.mjs'), 'utf8')
          .includes('spec/**')
        && third.warnings.some((warning) => warning.includes('escalate-paths.mjs')),
    );

    writeFileSync(join(root, 'docs', 'agentic', 'STATE.md'), fixtureState('auto'));
    const nonManual = reconcile(root, templates);
    const nonManualActions = new Map(
      nonManual.results.map((entry) => [entry.path, entry.action]),
    );
    expect(
      'a non-manual policy vendors the merge executor from its reference template',
      nonManual.nonManualTooling === true
        && nonManualActions.get('tools/agentic/auto-merge.mjs') === 'created'
        && nonManualActions.get('tools/agentic/merge-authorization-contract.mjs') === 'created',
    );
    expect(
      'every template-backed entry names its template source, through the rename',
      nonManual.results.find((entry) => entry.path === 'tools/agentic/auto-merge.mjs')
        ?.source === 'templates/tools/auto-merge.reference.mjs'
        && nonManual.results.find((entry) => entry.path === 'tools/agentic/verify.mjs')
          ?.source === 'templates/tools/verify.mjs'
        && nonManual.results.find((entry) => entry.path === '.codex/agents/autoloop-reviewer.toml')
          ?.source === 'templates/codex-reviewer-agent.template.toml',
    );

    const vendoredMerge = join(root, 'tools', 'agentic', 'auto-merge.mjs');
    writeFileSync(
      vendoredMerge,
      `${readFileSync(vendoredMerge, 'utf8')}\n// repo-filled REPO CONFIG\n`,
    );
    const filledAgain = reconcile(root, templates);
    expect(
      'a Setup-filled merge executor survives reconciliation for visible-diff review',
      filledAgain.results.some((entry) =>
        entry.path === 'tools/agentic/auto-merge.mjs' && entry.action === 'kept-modified')
        && readFileSync(vendoredMerge, 'utf8').includes('repo-filled REPO CONFIG')
        && filledAgain.warnings.some((warning) => warning.includes('auto-merge.mjs')),
    );

    writeFileSync(join(root, 'docs', 'agentic', 'STATE.md'), fixtureState('manual'));
    const backToManual = reconcile(root, templates);
    expect(
      'returning to manual removes the non-manual tooling',
      backToManual.results.some((entry) =>
        entry.path === 'tools/agentic/auto-merge.mjs' && entry.action === 'removed'),
    );

    writeFileSync(
      join(root, 'docs', 'agentic', 'STATE.md'),
      fixtureState('manual').replace('"0.26.0"', '"0.24.0"'),
    );
    const legacy = reconcile(root, templates);
    expect(
      'a non-current configuration reconciles the universal set with a migration warning',
      legacy.warnings.some((warning) => warning.includes('migrate the configuration'))
        && legacy.results.every((entry) => !entry.path.includes('auto-merge')),
    );

    let refused = false;
    try {
      reconcile(root, join(templates, 'tools'));
    } catch {
      refused = true;
    }
    expect('a directory without the template marker is refused', refused);
    mergeSelfTest(expect);
  } finally {
    rmSync(templates, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
  console.log(ok ? `self-test OK (${cases} cases)` : 'self-test FAILED');
  return ok;
}

function defaultTemplates() {
  const candidate = fileURLToPath(new URL('..', import.meta.url));
  return existsSync(join(candidate, TEMPLATE_MARKER)) ? candidate : null;
}

const USAGE = 'usage: scaffold.mjs --reconcile <repository root> [--templates <dir>]\n'
  + '       scaffold.mjs --audit <repository root> [--templates <dir>]\n'
  + '       scaffold.mjs --merge-state <repository root> [--templates <dir>] [--write] [--json]\n'
  + '       scaffold.mjs --merge-loop <repository root> [--templates <dir>] [--write] [--json]\n'
  + '       scaffold.mjs --self-test\n'
  + '--audit returns the identical typed report without writing anything.\n'
  + '--merge-* writes nothing without --write: the merged document goes to stdout and the\n'
  + 'typed report to stderr (with --json, one object on stdout carrying both). Exit 3 means\n'
  + 'a structural ambiguity that could lose repository content: report only, no document.';

function resolveTemplates(args) {
  const at = args.indexOf('--templates');
  return { at, value: at >= 0 ? args[at + 1] : defaultTemplates() };
}

function mergeMain(args, kind, flagAt) {
  const root = args[flagAt + 1];
  const templates = resolveTemplates(args);
  const write = args.includes('--write');
  const json = args.includes('--json');
  const expected = 2 + (templates.at >= 0 ? 2 : 0) + (write ? 1 : 0) + (json ? 1 : 0);
  if (typeof root !== 'string' || root.startsWith('--') || args.length !== expected) {
    console.error(USAGE);
    return 2;
  }
  if (templates.value === null) {
    console.error(
      'scaffold: cannot locate the plugin templates directory from this vendored '
      + 'copy; pass --templates <plugin templates dir>',
    );
    return 2;
  }
  let result;
  try {
    result = mergeDocumentFiles(resolve(root), resolve(templates.value), kind, { write });
  } catch (error) {
    console.error(`scaffold: ${error.message}`);
    return 1;
  }
  const { report, merged } = result;
  if (json) {
    console.log(JSON.stringify({ ...report, merged }, null, 2));
  } else if (write || merged === null) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.error(JSON.stringify(report, null, 2));
    process.stdout.write(merged);
  }
  return report.ok ? 0 : 3;
}

function main(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return selfTest() ? 0 : 1;
  }
  for (const [flag, kind] of [['--merge-state', 'state'], ['--merge-loop', 'loop']]) {
    const at = args.indexOf(flag);
    if (at >= 0) return mergeMain(args, kind, at);
  }
  const auditAt = args.indexOf('--audit');
  const reconcileAt = auditAt >= 0 ? auditAt : args.indexOf('--reconcile');
  const audit = auditAt >= 0;
  const templatesAt = args.indexOf('--templates');
  const root = reconcileAt >= 0 ? args[reconcileAt + 1] : undefined;
  const templates = templatesAt >= 0
    ? args[templatesAt + 1]
    : defaultTemplates();
  const expected = 2 + (templatesAt >= 0 ? 2 : 0);
  if (reconcileAt < 0 || typeof root !== 'string' || args.length !== expected) {
    console.error(USAGE);
    return 2;
  }
  if (templates === null) {
    console.error(
      'scaffold: cannot locate the plugin templates directory from this vendored '
      + 'copy; pass --templates <plugin templates dir>',
    );
    return 2;
  }
  let report;
  try {
    report = reconcile(resolve(root), resolve(templates), { audit });
  } catch (error) {
    console.error(`scaffold: ${error.message}`);
    return 1;
  }
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) process.exit(main(process.argv.slice(2)));
