#!/usr/bin/env node

// Deterministic scaffold reconciliation. Setup previously walked every vendored
// tool and host artifact through model-mediated compare/copy calls — dozens of
// slow round trips wrapping microsecond file operations. This tool performs the
// complete mechanical reconciliation in one invocation and returns a typed
// report. Judgment stays with the model: STATE/LOOP prose merging, the
// interview, ci-policy authorship, the visible diff, and the commit.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractConfig, validateConfig } from './config-contract.mjs';
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeArtifact(root, relativePath, bytes, results, mode) {
  const target = resolve(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  let action = 'created';
  if (existsSync(target)) {
    action = Buffer.compare(readFileSync(target), Buffer.from(bytes)) === 0
      ? 'identical'
      : 'refreshed';
  }
  if (action !== 'identical') writeFileSync(target, bytes);
  if (mode !== undefined) chmodSync(target, mode);
  results.push({ path: relativePath, action });
}

function hookCommands(entry) {
  return (Array.isArray(entry?.hooks) ? entry.hooks : [])
    .map((hook) => hook?.command)
    .filter((command) => typeof command === 'string');
}

// Non-clobbering per-event merge: an event the repository lacks is added whole;
// within an existing event, a template entry is appended only when none of the
// repository's entries already carries one of its commands. Repository-owned
// hooks are never removed or reordered.
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
    const present = new Set(merged.hooks[event].flatMap(hookCommands));
    for (const entry of templateEntries) {
      if (hookCommands(entry).some((command) => present.has(command))) continue;
      merged.hooks[event].push(structuredClone(entry));
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

export function reconcile(root, templates) {
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
      results.push({ path: `tools/agentic/${name}`, action: 'kept-modified' });
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
    );
  }
  if (!nonManual) {
    for (const name of NON_MANUAL_TOOL_FILES) {
      const stale = resolve(root, 'tools', 'agentic', name);
      if (existsSync(stale)) {
        unlinkSync(stale);
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
    );
  }

  for (const [templateName, relativePath] of HOOK_MERGES) {
    const template = readJson(join(templates, templateName));
    const target = resolve(root, relativePath);
    const existing = existsSync(target) ? readJson(target) : null;
    const { merged, changed } = mergeHookDocuments(existing, template);
    if (existing === null) {
      writeArtifact(root, relativePath, stableJson(merged), results);
    } else if (changed) {
      writeFileSync(target, stableJson(merged));
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
    unlinkSync(legacyPath);
    results.push({ path: 'opencode.json', action: 'removed' });
  }
  writeArtifact(
    root,
    '.opencode/opencode.json',
    stableJson(mergeOpencodeConfig(existingConfig, template)),
    results,
  );

  const budgetPolicy = resolve(root, '.autoloop', 'measurement-budget-policy.json');
  if (existsSync(budgetPolicy)) {
    results.push({
      path: '.autoloop/measurement-budget-policy.json',
      action: 'kept',
    });
  } else {
    writeArtifact(
      root,
      '.autoloop/measurement-budget-policy.json',
      readFileSync(join(templates, 'measurement-budget-policy.template.json')),
      results,
    );
  }

  const loop = resolve(root, 'docs', 'agentic', 'LOOP.md');
  const loopTemplate = readFileSync(join(templates, 'LOOP.template.md'));
  if (!existsSync(loop)) {
    writeArtifact(root, 'docs/agentic/LOOP.md', loopTemplate, results);
  } else if (Buffer.compare(readFileSync(loop), loopTemplate) === 0) {
    results.push({ path: 'docs/agentic/LOOP.md', action: 'identical' });
  } else {
    results.push({ path: 'docs/agentic/LOOP.md', action: 'kept' });
    warnings.push('docs/agentic/LOOP.md differs from the template; reconcile its prose in the visible diff');
  }

  if (!existsSync(resolve(root, '.autoloop', 'ci-policy.json'))) {
    warnings.push(
      '.autoloop/ci-policy.json is absent; it is human-owned policy — author it '
      + 'through the interview, never generate it',
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

function fixtureTemplates() {
  const templates = mkdtempSync(join(tmpdir(), 'autoloop-scaffold-templates-'));
  mkdirSync(join(templates, 'tools'), { recursive: true });
  writeFileSync(join(templates, TEMPLATE_MARKER), '# state template\n');
  writeFileSync(join(templates, 'LOOP.template.md'), '# loop template\n');
  writeFileSync(
    join(templates, 'measurement-budget-policy.template.json'),
    '{ "status": "pending-evidence" }\n',
  );
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
      version: '0.25.0',
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

    const first = reconcile(root, templates);
    const actions = new Map(first.results.map((entry) => [entry.path, entry.action]));
    expect(
      'a manual repository vendors the universal set without the merge executor',
      actions.get('tools/agentic/verify.mjs') === 'created'
        && actions.get('tools/agentic/auto-merge.mjs') === undefined,
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
      'absent human policy is a warning, never a generated file',
      first.warnings.some((warning) => warning.includes('.autoloop/ci-policy.json'))
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
      fixtureState('manual').replace('"0.25.0"', '"0.24.0"'),
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

function main(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return selfTest() ? 0 : 1;
  }
  const reconcileAt = args.indexOf('--reconcile');
  const templatesAt = args.indexOf('--templates');
  const root = reconcileAt >= 0 ? args[reconcileAt + 1] : undefined;
  const templates = templatesAt >= 0
    ? args[templatesAt + 1]
    : defaultTemplates();
  const expected = 2 + (templatesAt >= 0 ? 2 : 0);
  if (reconcileAt < 0 || typeof root !== 'string' || args.length !== expected) {
    console.error(
      'usage: scaffold.mjs --reconcile <repository root> [--templates <dir>] | --self-test',
    );
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
    report = reconcile(resolve(root), resolve(templates));
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
