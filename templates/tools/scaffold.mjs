#!/usr/bin/env node

// Deterministic scaffold reconciliation. Setup previously walked every vendored
// tool and host artifact through model-mediated compare/copy calls — dozens of
// slow round trips wrapping microsecond file operations. This tool performs the
// complete mechanical reconciliation in one invocation and returns a typed
// report. A second entry point merges the STATE and LOOP documents against
// their templates on the same principle. Judgment stays with the model: the
// interview, whatever the merge report flags for human
// review, the visible diff, and the commit.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
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
const HOOK_MERGES = Object.freeze([
  ['settings-hooks.template.json', '.claude/settings.json'],
]);
// Codex and opencode were retired in 0.51.0. These are the fingerprints of every
// version setup ever generated at each path, from the template history: a
// template copy, or a JSON merge with nothing repository-owned in it. JSON is
// compared canonically (sorted keys, no whitespace), since installs differed in
// formatting only. A file that matches is setup's own and is removed; any other
// is repository-owned and is reported, never deleted.
export const RETIRED_HOST_FILES = Object.freeze(new Map([
  ['.codex/agents/autoloop-reviewer.toml', new Set([
    '38b3a8c61507b8255ea5e83d32460da5f7d1e089ae39399ad32ba539dd00b908',
    '496af65a6e655b4ea71e9fb36b3006d0c2bb943f5801fac827a21952594c7fa5',
  ])],
  ['.opencode/agent/autoloop-reviewer.md', new Set([
    'c64c98b9028691eecaf5369302c143839d8813609a115359f9b47e389e883ead',
    'f85e0bba653f49e88fe8fb1a7b173b9e0bfbf271224c22852390714936aad515',
    'b8a5234528b1bf47a96fb04a83fda753206bd9283e493c57906e8ded17f80af2',
  ])],
  ['.opencode/plugins/autoloop.js', new Set([
    '5773a74bd929fb9ccfdce870f5d38ed5a07d5fc8de42d203c2f71bfeaf68f500',
    '29c340b20c43cd219c64c85b3f8ce567c9bd4aa64a75c2efecdf8312e411a030',
    '7c47d383c5514cb0c5f7a6a6181b676ca817a5015bc47caad688fd477b95ea81',
    '912e4662005d320285dfc205076bba69dfc6aa84bdcc22520a5ca5005f5622a7',
    'b498ab9574e25baa6300b91c5f0c06abbd8ebd511c52b0536181fb18b6802145',
    '2ae0e178baf873488ef21e4cad96bc64af733c1d9b964a29eaf91b6ef39d9609',
    '6305724b4e7381cc7d416be9c380189762486eabeece3cea29852aae757872cc',
  ])],
  ['.codex/hooks.json', new Set([
    'ee1c1b19e1011c4cea63d07fc114f83167abcf3447cc63da90bbf05a24cb6be1',
    'dcab1ce8811be09d7ffb8be2ceeb2397c9e14f3a0d2ea7150cdf6fc6ca46e8e4',
    '49ce6d0d6aa2cb654d8b0f60c719dbf221baae5329c1d3bd6b3285feebe7ba81',
    '31e4a5e441d45a4a67288f33d1c16b76ae3d324d0aeaad89485e5805f88961ad',
    '6a7a7cd5848931610db2ec6780436d3e139d6ff7bc1c5f6d5a896b36cc82b837',
    '911f68a4a2d489ebd04989251b52fb90b3a7c41d80328c0947339bd429c717a4',
    '5579520e787f3efa9b8fe8987dec0960240b3973e3f9452f6862fa69dce57808',
    '4b8a3f54de680b87767928f025ef685ebc5f4be394e011f0043ed91a1f95e884',
    '65e9de60952fcac2456b0291cd70fc408a4fa5cbbfa398ffaf315a82915fb906',
    '2900c35f414ccc3eead966f8693c42c175709c71eced20e184b033d01bc2ab24',
    '914b833bc9fa9af540c3703f199e45bf0d0f0eaf562df6633bc566985f60191d',
    '4545d19f48333e60d02df1e72172b3c007b8884af83360ab50673d3cdceb65ba',
    'a30188d4e9981e942344b9f0b652f18185aa85f8a4d463257c78492ef64d91c5',
    '8588844da3dbaef3cf603df5e22fc7a66b67224f704775a03ca32cf35472abbe',
  ])],
  ['.opencode/opencode.json', new Set([
    '1ca6ea9bbc9cba57de327853553546a653e9ed3808ddaa628a871c1c5d6e86d3',
    '7d922bb38fc9232928804f3efdae4919553e6ac252943be98bb19ffbbbf4a407',
    '6a31d52e7855dc3dbfc3c9d9bcc66552dd57701ce5e7db17739469f9b77a68ee',
  ])],
]));
// Vendored tools a release deleted. Every tools/agentic copy is template-owned,
// so a retired one is removed outright, like the non-manual set on a manual repo.
const RETIRED_TOOL_FILES = Object.freeze(['adapter-contract.mjs']);
const RETIRED_HOST_DIRECTORIES = Object.freeze([
  '.codex/agents', '.opencode/agent', '.opencode/plugins', '.codex', '.opencode',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

export function hostFileFingerprint(path, text) {
  let body = text;
  if (path.endsWith('.json')) {
    try {
      body = JSON.stringify(canonicalJson(JSON.parse(text)));
    } catch {
      // Unparseable JSON matches no generated fingerprint.
    }
  }
  return createHash('sha256').update(body).digest('hex');
}

export function removeRetiredHostFiles(root, results, audit, retired = RETIRED_HOST_FILES) {
  for (const [relativePath, fingerprints] of retired) {
    const target = resolve(root, relativePath);
    if (!existsSync(target)) continue;
    const generated = fingerprints.has(hostFileFingerprint(relativePath, readFileSync(target, 'utf8')));
    if (generated && !audit) unlinkSync(target);
    results.push({ path: relativePath, action: generated ? 'removed' : 'stale-left' });
  }
  if (audit) return;
  for (const directory of RETIRED_HOST_DIRECTORIES) {
    try {
      rmdirSync(resolve(root, directory));
    } catch {
      // Not empty (repository-owned or opencode's own files), or absent.
    }
  }
}
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
      if (hookCommands(entry).some((command) => present.has(command))) {
        // An unchanged command under a widened template matcher (0.50.0: the
        // guard also answers `AskUserQuestion`) is still a superseded binding.
        // Only an entry holding exactly the template's commands is autoloop's
        // own; a maintainer entry sharing a command keeps its matcher.
        const same = JSON.stringify(hookCommands(entry));
        const own = merged.hooks[event].find((candidate) =>
          JSON.stringify(hookCommands(candidate)) === same);
        if (own !== undefined && entry.matcher !== undefined && own.matcher !== entry.matcher) {
          own.matcher = entry.matcher;
          changed = true;
        }
        continue;
      }
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

// `merge.policy` decides nothing at runtime: the merge gate reads AUTOMERGE_MODE
// out of the vendored executor and computes its `mergePolicy` from THAT. So the
// two can disagree, and when they do the config's answer is silently discarded.
// Observed 2026-07-29 on a live repository that had carried `merge.policy: auto`
// with both acknowledgements since setup: the executor said 'classified', every
// code pull request was refused as unclassified, and the refusal cited a
// `ratified` policy the config never names — so nothing pointed at the constant
// that actually decided.
//
// Prose asking setup to derive one from the other is not a fix; that is what was
// already implied and it is how this shipped. This is the mechanical check, and
// it is a CONFLICT rather than a warning so a caller cannot read past it.
export const POLICY_TO_MODE = Object.freeze({
  auto: 'all-green',
  ratified: 'classified',
});

/**
 * Pure. Rewrites ONLY the AUTOMERGE_MODE line, so a repo-owned policy file keeps
 * every other Setup-filled value. Returns the new text, or null when there is
 * nothing to change. Repairing mechanically matters as much as detecting
 * mechanically: an instruction to "rewrite that one constant" is the same prose
 * that let the contradiction ship, and setup is where the human expects the fix.
 */
export function repairMergeMode(executorText, expectedMode) {
  if (typeof executorText !== 'string' || typeof expectedMode !== 'string') return null;
  const line = /^export const AUTOMERGE_MODE = '([^']*)';$/mu;
  const found = line.exec(executorText);
  if (found === null || found[1] === expectedMode) return null;
  return executorText.replace(line, `export const AUTOMERGE_MODE = '${expectedMode}';`);
}

/** Pure. Returns a conflict string, or null when the two agree or cannot be compared. */
export function mergeModeConflict(mergePolicy, executorText) {
  if (typeof executorText !== 'string' || executorText === '') return null;
  const declared = /^export const AUTOMERGE_MODE = '([^']*)';$/mu.exec(executorText)?.[1];
  if (declared === undefined) return null;
  if (mergePolicy === 'manual') {
    // The executor is not vendored for a manual policy; if it is present it is
    // inert, so the mode cannot contradict anything.
    return null;
  }
  const expected = POLICY_TO_MODE[mergePolicy];
  if (expected === undefined || declared === expected) return null;
  return `merge.policy is "${mergePolicy}" but tools/agentic/auto-merge.mjs declares `
    + `AUTOMERGE_MODE = '${declared}'; the executor's constant is the only value the merge gate `
    + `reads, so the committed policy is being discarded. Set it to '${expected}'`;
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
  for (const name of RETIRED_TOOL_FILES) {
    const stale = resolve(root, 'tools', 'agentic', name);
    if (existsSync(stale)) {
      if (!audit) unlinkSync(stale);
      results.push({ path: `tools/agentic/${name}`, action: 'removed' });
    }
  }

  removeRetiredHostFiles(root, results, audit);

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

  // ARCH and LESSONS are curated documents: allowed to grow between maintenance
  // units, not forever. Both budgets lived only as dev-skill prose, and the
  // lessons one still named "STATE Lessons" — a section the v0.49.14 diet moved
  // into its own file — so it pointed at nothing and silently never fired.
  // LESSONS reached 8010 bytes with no one told. A budget that lives in the
  // battery fires whether or not a session remembers the rule.
  for (const { path: relative, budget, guidance } of CURATED_DOCUMENTS) {
    const path = resolve(root, relative);
    if (!existsSync(path)) continue;
    const size = readFileSync(path).length;
    if (size <= budget) continue;
    warnings.push(
      `${relative} is ${size} bytes, over its ${budget}-byte curation budget: ${guidance}`,
    );
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
  } else {
    // Reporting the absence is the point. Saying nothing here is
    // indistinguishable from not having looked, which is what sent a live
    // session probing with `ls .autoloop/ci-policy.json` — a check whose
    // SUCCESS prints `No such file or directory` and reads as a failure. The
    // report already carries `identical` rows for files it changed nothing
    // about; a retired artifact confirmed gone belongs in the same list.
    results.push({ path: '.autoloop/ci-policy.json', action: 'absent' });
  }
  if (config !== null) {
    const checklist = resolve(root, config.review.checklistPath);
    if (!existsSync(checklist)) {
      warnings.push(`${config.review.checklistPath} is absent; author the review checklist`);
    }
  }
  const sorted = results.sort((left, right) => left.path.localeCompare(right.path));
  // The audit already knew whether a reconcile would change anything; it just
  // never said so, leaving the reader to count actions. That is why every
  // release felt like it required a Setup — most do not. Skills load from the
  // plugin and need nothing; only the VENDORED tools under `tools/agentic/**`
  // are copies, so a skills-only release changes nothing here and this reports
  // `false`.
  //
  // `kept` and `kept-modified` are repository-owned and deliberately untouched.
  // `absent` is a RETIRED artifact confirmed gone — the report says so precisely
  // to prove the check ran, so counting it as work to do would make every audit
  // demand a reconcile that changes nothing.
  // Read from the repository, not from the template: the vendored copy is the
  // policy, and it is `kept-modified` so a wholesale reconcile never corrects it.
  // The ONE constant that must agree with the committed config is repaired in
  // place, before `changing` is computed, so a pending repair counts as work to
  // do rather than reporting `reconcileNeeded: false` beside a live conflict.
  let executorText = '';
  try {
    executorText = readFileSync(resolve(root, 'tools', 'agentic', 'auto-merge.mjs'), 'utf8');
  } catch { /* not vendored — a manual policy, or nothing to contradict */ }
  const policyConflict = mergeModeConflict(config?.merge?.policy, executorText);
  let policyRepaired = null;
  if (policyConflict !== null) {
    warnings.push(policyConflict);
    const expected = POLICY_TO_MODE[config?.merge?.policy];
    const repaired = repairMergeMode(executorText, expected);
    if (repaired !== null) {
      policyRepaired = expected;
      if (!audit) {
        writeFileSync(resolve(root, 'tools', 'agentic', 'auto-merge.mjs'), repaired);
      }
      sorted.push({
        path: 'tools/agentic/auto-merge.mjs',
        action: audit ? 'policy-repair-pending' : 'policy-repaired',
        source: `derived from merge.policy: ${config?.merge?.policy}`,
      });
    }
  }
  const settled = new Set(['identical', 'kept', 'kept-modified', 'absent']);
  const changing = sorted.filter((entry) => !settled.has(entry.action));
  return {
    version: 1,
    nonManualTooling: nonManual,
    policyConflicts: policyConflict === null ? [] : [policyConflict],
    policyRepaired,
    reconcileNeeded: changing.length > 0,
    reconcileSummary: changing.length === 0
      ? 'current — no reconcile needed'
      : `reconcile needed: ${changing.length} artifact(s) — `
        + `${[...new Set(changing.map((entry) => entry.action))].sort().join(', ')}`,
    results: sorted,
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
// LESSONS gets a tighter budget than ARCH on purpose. ARCH maps a whole
// codebase and grows with it; LESSONS is supposed to SHRINK over time, because
// its own pruning rule retires any lesson a guard, contract, or hook has since
// come to enforce. A lessons file that only grows stops being read, and an
// unread lesson prevents nothing.
const CURATED_DOCUMENTS = Object.freeze([
  Object.freeze({
    path: 'docs/agentic/ARCH.md',
    budget: 8000,
    guidance: 're-curate the map, dropping imperative policy, shared freshness lines, '
      + 'restated counts, and width-aligned tables',
  }),
  Object.freeze({
    path: 'docs/agentic/LESSONS.md',
    budget: 6000,
    guidance: 'delete every lesson a guard rule, contract, or hook now enforces — the '
      + 'mechanism is the memory — and keep the rest rule-first, evidence-second',
  }),
]);

const REPO_MIGRATIONS = Object.freeze([
  Object.freeze({ id: 'lessons-out-of-state', apply: migrateLessons }),
]);

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
        reviseRoundsPerPr: 10,
        codeReviewRoundsPerUnit: 20,
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
        && !existsSync(join(root, 'tools')),
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
      'a widened matcher on an unchanged autoloop command reaches existing installs',
      (() => {
        // 0.50.0 widened the guard's matcher to `Bash|AskUserQuestion` without
        // touching its command text; a present command was "unchanged", so the
        // refusal of mid-run questions would never have reached a live repo.
        const guard = 'node "$r/tools/agentic/command-guard.mjs" --config "$c" || exit 2';
        const { merged, changed } = mergeHookDocuments(
          { hooks: { PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'maintainer-own' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: guard }] },
          ] } },
          { hooks: { PreToolUse: [
            { matcher: 'Bash|AskUserQuestion', hooks: [{ type: 'command', command: guard }] },
          ] } },
        );
        return changed === true
          && merged.hooks.PreToolUse.length === 2
          && merged.hooks.PreToolUse[0].matcher === 'Bash'
          && merged.hooks.PreToolUse[1].matcher === 'Bash|AskUserQuestion';
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
      // 2026-07-28: both budgets lived only as dev-skill prose, and the lessons
      // one still named "STATE Lessons" after the v0.49.14 diet moved lessons
      // into their own file, so it pointed at nothing. LESSONS reached 8010
      // bytes with nothing reporting it.
      'a curated document over its budget is reported with the curation rule',
      (() => {
        const path = join(root, 'docs', 'agentic', 'LESSONS.md');
        writeFileSync(path, `# lessons\n${'- a rule that became a mechanism\n'.repeat(300)}`);
        const run = reconcile(root, templates, { audit: true });
        const warning = run.warnings.find((entry) =>
          entry.includes('docs/agentic/LESSONS.md') && entry.includes('curation budget'));
        return warning !== undefined
          && warning.includes('6000')
          && warning.includes('now enforces');
      })(),
    );
    expect(
      'a curated document inside its budget is silent',
      (() => {
        const path = join(root, 'docs', 'agentic', 'LESSONS.md');
        writeFileSync(path, '# lessons\n- one short rule\n');
        const run = reconcile(root, templates, { audit: true });
        return !run.warnings.some((entry) => entry.includes('curation budget'));
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
      // The report NAMES the absence rather than staying silent about it: a
      // silent report cannot be told apart from an unperformed check.
      'a fresh scaffold never creates the retired CI policy, and says so',
      first.results.some((entry) =>
        entry.path === '.autoloop/ci-policy.json' && entry.action === 'absent')
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
        ['identical', 'kept', 'absent'].includes(entry.action)),
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
          ?.source === 'templates/tools/verify.mjs',
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

    const retiredTool = join(root, 'tools', 'agentic', 'adapter-contract.mjs');
    writeFileSync(retiredTool, '// vendored by an earlier release\n');
    const retiredAudit = reconcile(root, templates, { audit: true });
    const auditKeptRetiredTool = existsSync(retiredTool);
    const retiredRun = reconcile(root, templates);
    expect(
      'a reconcile removes a retired vendored tool, and an audit only reports it',
      [retiredAudit, retiredRun].every((run) => run.results.some((entry) =>
        entry.path === 'tools/agentic/adapter-contract.mjs' && entry.action === 'removed'))
        && auditKeptRetiredTool
        && !existsSync(retiredTool),
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

    // The merge-policy conflict check. Prose asking setup to derive one value
    // from the other is how the contradiction shipped in the first place, so
    // these assert the mechanism rather than the instruction.
    const mode = (value) => `export const AUTOMERGE_MODE = '${value}';\n`;
    expect(
      'auto against a classified executor is a conflict',
      (mergeModeConflict('auto', mode('classified')) ?? '').includes("Set it to 'all-green'"),
    );
    expect(
      'ratified against an all-green executor is a conflict',
      (mergeModeConflict('ratified', mode('all-green')) ?? '').includes("Set it to 'classified'"),
    );
    expect(
      'the conflict names the discarded config, not just the mismatch',
      (mergeModeConflict('auto', mode('classified')) ?? '').includes('being discarded'),
    );
    expect('auto against all-green agrees', mergeModeConflict('auto', mode('all-green')) === null);
    expect(
      'ratified against classified agrees',
      mergeModeConflict('ratified', mode('classified')) === null,
    );
    expect(
      'a manual policy cannot be contradicted by an inert executor',
      mergeModeConflict('manual', mode('classified')) === null,
    );
    expect(
      'an absent executor is not a conflict',
      mergeModeConflict('auto', '') === null,
    );
    expect(
      'an executor without the constant is not a conflict',
      mergeModeConflict('auto', 'export const OTHER = 1;\n') === null,
    );
    // The repair is mechanical too: detecting without repairing would have left
    // "rewrite that one constant" as prose, which is how this shipped.
    expect(
      'the repair rewrites the constant to the derived value',
      repairMergeMode(mode('classified'), 'all-green') === mode('all-green'),
    );
    expect(
      'the repair touches ONLY that line, keeping every other Setup-filled value',
      repairMergeMode(
        `export const REPOSITORY = { owner: 'o' };\n${mode('classified')}export const X = 1;\n`,
        'all-green',
      ) === `export const REPOSITORY = { owner: 'o' };\n${mode('all-green')}export const X = 1;\n`,
    );
    expect(
      'an already-correct constant is not rewritten',
      repairMergeMode(mode('all-green'), 'all-green') === null,
    );
    expect(
      'a missing constant is not invented',
      repairMergeMode('export const OTHER = 1;\n', 'all-green') === null,
    );
    // 0.51.0 retired Codex and opencode. A reconcile removes the host files
    // setup itself generated, proven by fingerprint, and keeps anything else.
    {
      const host = mkdtempSync(join(tmpdir(), 'autoloop-scaffold-retired-'));
      const put = (path, text) => {
        mkdirSync(dirname(join(host, path)), { recursive: true });
        writeFileSync(join(host, path), text);
      };
      put('.codex/agents/autoloop-reviewer.toml', 'generated reviewer\n');
      put('.codex/hooks.json', '{"hooks": {"Stop": []}}\n');
      put('.opencode/plugins/autoloop.js', 'hand-edited plugin\n');
      put('.opencode/node_modules/dep/index.js', 'dep\n');
      put('.opencode/package.json', '{}\n');
      const retired = new Map([
        ['.codex/agents/autoloop-reviewer.toml', new Set([hostFileFingerprint('x.toml', 'generated reviewer\n')])],
        // Key order and whitespace do not matter for a generated JSON file.
        ['.codex/hooks.json', new Set([hostFileFingerprint('x.json', '{"hooks":{"Stop":[]}}')])],
        ['.opencode/plugins/autoloop.js', new Set([hostFileFingerprint('x.js', 'generated plugin\n')])],
      ]);
      const audited = [];
      removeRetiredHostFiles(host, audited, true, retired);
      const auditKept = existsSync(join(host, '.codex/hooks.json'));
      const results = [];
      removeRetiredHostFiles(host, results, false, retired);
      const action = new Map(results.map((entry) => [entry.path, entry.action]));
      expect(
        'a reconcile removes the retired host files setup generated',
        action.get('.codex/agents/autoloop-reviewer.toml') === 'removed'
          && action.get('.codex/hooks.json') === 'removed'
          && !existsSync(join(host, '.codex'))
          && auditKept && audited.length === results.length,
      );
      expect(
        'a hand-edited retired host file is reported and kept',
        action.get('.opencode/plugins/autoloop.js') === 'stale-left'
          && readFileSync(join(host, '.opencode/plugins/autoloop.js'), 'utf8') === 'hand-edited plugin\n',
      );
      expect(
        'opencode\'s own dependencies are never touched',
        existsSync(join(host, '.opencode/node_modules/dep/index.js'))
          && existsSync(join(host, '.opencode/package.json')),
      );
      expect(
        'every live generated copy is in the shipped fingerprint table',
        [...RETIRED_HOST_FILES.keys()].length === 5
          && [...RETIRED_HOST_FILES.values()].every((set) => set.size > 0),
      );
      rmSync(host, { recursive: true, force: true });
    }
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

// Names the RIGHT invocation first, not the flag that makes the wrong one work.
// The vendored copy can never self-locate: `defaultTemplates` resolves
// <script dir>/.. and looks for the template marker, which is `templates/` in the
// plugin and `tools/` in a repository. So the plugin copy needs no flag and the
// vendored copy always needs one — and both skills already say to run the plugin
// copy. 2026-07-30: a live run hit this on `tools/agentic/scaffold.mjs --audit .`,
// paused a delivery, loaded the debugging skill, and recovered by passing
// --templates with a hardcoded version-pinned plugin path. That path goes stale
// at the next release; running the plugin copy never does. The old message
// offered only the flag, so the workaround was the only thing it pointed at.
const NO_TEMPLATES = 'scaffold: this vendored copy cannot locate the plugin templates directory. '
  + 'Run the PLUGIN copy instead — `node <plugin-tools>/scaffold.mjs --audit <root>` self-locates '
  + 'and needs no flag, and it is what autoloop:dev and autoloop:setup both specify. Only when the '
  + 'plugin is genuinely unavailable, pass --templates <plugin templates dir> here; a version-pinned '
  + 'path goes stale at the next release.';

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
      NO_TEMPLATES,
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
      NO_TEMPLATES,
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
