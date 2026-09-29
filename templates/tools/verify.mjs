#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_VERSION, effectiveChecklistPath, resolveProjectConfig } from './config-contract.mjs';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const SELF_TEST_MANIFEST_NAME = 'self-test-manifest.json';
const SELF_TEST_PATTERN = /(?:async\s+)?function\s+selfTest\s*\(/;
export const UNIVERSAL_TOOL_FILES = Object.freeze([
  'attestation-contract.mjs',
  'checkout-contract.mjs',
  'claim-contract.mjs',
  'command-guard.mjs',
  'edit-guard.mjs',
  'config-contract.mjs',
  'contract-lint.mjs',
  'delivery-contract.mjs',
  'dispatch-render.mjs',
  'dispatch.mjs',
  'escalate-paths.mjs',
  'hook-root.mjs',
  'label-swap-reminder.mjs',
  'lane-contract.mjs',
  'lifecycle-contract.mjs',
  'lifecycle-driver.mjs',
  'loop-scope.mjs',
  'loop-smoke.mjs',
  'overlap-report.mjs',
  'prime.mjs',
  'publish-verdict.mjs',
  'release-verify.mjs',
  'review-contract.mjs',
  'scan.mjs',
  'setup.mjs',
  'sizing-contract.mjs',
  'snapshot-contract.mjs',
  'stats.mjs',
  'step.mjs',
  'subagent-transcript.mjs',
  'unit.mjs',
  'verify.mjs',
  'writeback-check.mjs',
]);
const PLUGIN_TOOL_FILES = Object.freeze([
  ...UNIVERSAL_TOOL_FILES,
  'auto-merge.reference.mjs',
  'merge-authorization-contract.mjs',
]);
// Global install: the plugin ships these hooks in hooks/hooks.json, each
// running the plugin's own copy. Exactly one handler per tool, on its event
// and matcher, with exactly this command. The command guard fails closed only
// inside an autoloop repository: a crashed guard refuses there, while a broken
// plugin never refuses commands in every other repository.
const PLUGIN_TOOLS = '${CLAUDE_PLUGIN_ROOT}/templates/tools';
export const PLUGIN_HOOKS = Object.freeze([
  { name: 'session-preflight.sh', event: 'SessionStart', matcher: null, command: `bash "${PLUGIN_TOOLS}/session-preflight.sh"` },
  { name: 'edit-guard.mjs', event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit', command: `node "${PLUGIN_TOOLS}/edit-guard.mjs"` },
  {
    name: 'command-guard.mjs',
    event: 'PreToolUse',
    matcher: 'Bash|AskUserQuestion',
    // The guard's own verdict (0 or 2) is final. Anything else is a crash: it
    // refuses where the project's top level has any .autoloop entry (a
    // symlink or unreadable directory included, as the resolver treats them).
    command: `node "${PLUGIN_TOOLS}/command-guard.mjs"; s=$?; [ $s -eq 0 ] && exit 0; [ $s -eq 2 ] && exit 2; `
      + 'r=$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null || printf %s "$CLAUDE_PROJECT_DIR"); '
      + '{ [ -e "$r/.autoloop" ] || [ -L "$r/.autoloop" ]; } && exit 2; exit 0',
  },
  { name: 'label-swap-reminder.mjs', event: 'PostToolUse', matcher: 'Bash', command: `node "${PLUGIN_TOOLS}/label-swap-reminder.mjs"` },
  { name: 'subagent-transcript.mjs', event: 'SubagentStop', matcher: null, command: `node "${PLUGIN_TOOLS}/subagent-transcript.mjs"` },
  { name: 'writeback-check.mjs', event: 'Stop', matcher: null, command: `node "${PLUGIN_TOOLS}/writeback-check.mjs"` },
].map((entry) => Object.freeze(entry)));

export function pluginHookProblems(document, toolsDir) {
  const problems = [];
  const handlers = [];
  for (const [event, groups] of Object.entries(document?.hooks ?? {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (handler?.type !== 'command' || typeof handler.command !== 'string') {
          problems.push(`hooks.${event}: expected command handlers only`);
          continue;
        }
        handlers.push({ event, matcher: group.matcher ?? null, command: handler.command });
      }
    }
  }
  for (const entry of PLUGIN_HOOKS) {
    const matches = handlers.filter((handler) => handler.command === entry.command);
    if (matches.length !== 1) {
      problems.push(`${entry.name}: expected exactly one handler running \`${entry.command}\`, found ${matches.length}`);
    } else if (matches[0].event !== entry.event || matches[0].matcher !== entry.matcher) {
      problems.push(`${entry.name}: expected ${entry.event}${entry.matcher === null ? '' : ` matcher ${entry.matcher}`}`);
    }
    if (!existsSync(resolve(toolsDir, entry.name))) problems.push(`${entry.name}: not in the plugin tools`);
  }
  for (const handler of handlers) {
    if (!PLUGIN_HOOKS.some((entry) => entry.command === handler.command)) {
      problems.push(`unexpected hook \`${handler.command}\` on ${handler.event}`);
    }
  }
  return problems;
}

function checkPluginHooks(root) {
  try {
    const problems = pluginHookProblems(
      JSON.parse(readFileSync(resolve(root, 'hooks', 'hooks.json'), 'utf8')),
      resolve(root, 'templates', 'tools'),
    );
    return { ok: problems.length === 0, detail: problems.join('; ') };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    // Contract self-tests spawn Git and Node repeatedly, and a macOS runner is
    // slow enough at process creation to exceed a two-minute ceiling that Linux
    // clears in seconds. The bound still catches a genuine hang.
    timeout: 600000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return {
    ok: result.status === 0 && !result.error,
    detail: [
      result.error?.message,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join('\n'),
  };
}

function checkJson(path) {
  try {
    JSON.parse(readFileSync(path, 'utf8'));
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

// The committed CI policy is retired (docs/specs/simple-delivery.md); a copy
// left behind reads as authoritative configuration, so its absence is verified.
function checkRetiredCiPolicy(root) {
  return existsSync(resolve(root, '.autoloop', 'ci-policy.json'))
    ? {
        ok: false,
        detail: '.autoloop/ci-policy.json is retired — run scaffold reconcile to remove it',
      }
    : { ok: true, detail: '' };
}

// The release contract never passes `--release-mode` here.
function checkReleaseContract(root) {
  const result = run(
    process.execPath,
    [resolve(root, 'templates', 'tools', 'release-verify.mjs'), '--check-root', root],
    root,
  );
  return result.ok ? { ok: true, detail: '' } : result;
}

function checkExists(path) {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink()
      ? { ok: true, detail: '' }
      : { ok: false, detail: `${path}: required artifact is not a regular file` };
  } catch {
    return { ok: false, detail: `${path}: required artifact is missing` };
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkConfiguredChecklist(root) {
  try {
    const resolved = resolveProjectConfig(root);
    if (!resolved?.ok) {
      return {
        ok: false,
        detail: `ProjectConfig is invalid: ${resolved?.errors?.join('; ') ?? 'no autoloop configuration'}`,
      };
    }
    return checkExists(effectiveChecklistPath(root, resolved.config));
  } catch (error) {
    return { ok: false, detail: `cannot resolve configured checklist: ${error.message}` };
  }
}

// The manifest hashes exactly the template tools this file would spawn a
// self-test for. Deterministic: it reads bytes, never runs anything.
function selfTestManifestTools(toolsDir) {
  const ownName = basename(fileURLToPath(import.meta.url));
  const tools = {};
  for (const name of readdirSync(toolsDir).filter((entry) => entry.endsWith('.mjs')).sort()) {
    if (name === ownName) continue;
    const source = readFileSync(join(toolsDir, name));
    if (!SELF_TEST_PATTERN.test(source.toString('utf8'))) continue;
    tools[name] = createHash('sha256').update(source).digest('hex');
  }
  return Object.fromEntries(
    Object.entries(tools).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function renderSelfTestManifest(toolsDir) {
  return `${JSON.stringify({
    version: 1,
    node: nodeMajor(),
    tools: selfTestManifestTools(toolsDir),
  }, null, 2)}\n`;
}

// Plugin-root freshness: a stale committed manifest must not ship. The node
// field is NOT compared against the running process — CI regenerates on more
// than one Node line, so freshness binds the hashed template bytes.
function checkSelfTestManifest(toolsDir) {
  let committed;
  try {
    committed = JSON.parse(readFileSync(resolve(toolsDir, SELF_TEST_MANIFEST_NAME), 'utf8'));
  } catch (error) {
    return { ok: false, detail: `self-test manifest is unreadable: ${error.message}` };
  }
  const errors = [];
  if (committed?.version !== 1) errors.push('version: expected 1');
  if (!/^\d+$/u.test(String(committed?.node ?? ''))) {
    errors.push('node: expected a numeric major version');
  }
  const expected = selfTestManifestTools(toolsDir);
  const actual = plainObject(committed?.tools) ? committed.tools : {};
  for (const [name, hash] of Object.entries(expected)) {
    if (actual[name] !== hash) errors.push(`${name}: manifest hash is stale`);
  }
  for (const name of Object.keys(actual)) {
    if (expected[name] === undefined) {
      errors.push(`${name}: manifest entry has no template tool`);
    }
  }
  return errors.length === 0
    ? { ok: true, detail: '' }
    : {
      ok: false,
      detail: 'regenerate with '
        + '`node templates/tools/verify.mjs --emit-self-test-manifest '
        + `> templates/tools/${SELF_TEST_MANIFEST_NAME}\`: ${errors.join('; ')}`,
    };
}

function pluginChecks(root) {
  const toolsDir = resolve(root, 'templates', 'tools');
  const checks = toolChecks(root, toolsDir, PLUGIN_TOOL_FILES);

  for (const relativePath of [
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
  ]) {
    checks.push({
      name: `json ${relativePath}`,
      execute: () => checkJson(resolve(root, relativePath)),
    });
  }
  checks.push({ name: 'plugin hooks hooks/hooks.json', execute: () => checkPluginHooks(root) });
  checks.push({
    name: 'shell session-preflight',
    execute: () => run(
      'bash',
      ['-n', resolve(root, 'templates', 'tools', 'session-preflight.sh')],
      root,
    ),
  });
  checks.push({
    name: 'shell dispatch-stream',
    execute: () => run(
      'bash',
      ['-n', resolve(root, 'templates', 'tools', 'dispatch-stream.sh')],
      root,
    ),
  });
  checks.push({
    name: 'guard corpus replay',
    execute: () => run(
      process.execPath,
      [resolve(root, 'templates', 'tools', 'command-guard.mjs'), '--corpus'],
      root,
    ),
  });
  checks.push({
    name: 'release-proven self-test manifest',
    execute: () => checkSelfTestManifest(toolsDir),
  });
  checks.push({
    name: 'release contract',
    execute: () => checkReleaseContract(root),
  });
  checks.push({
    name: 'forward contract lint',
    execute: () => run(
      process.execPath,
      [resolve(root, 'templates', 'tools', 'contract-lint.mjs'), '--check-root', root],
      root,
    ),
  });
  checks.push({
    name: 'skill byte budgets',
    execute: () => checkSkillBudgets(root),
  });
  return checks;
}

// Every skill loads whole into the session that invokes it, and again after
// every compaction: on LFE the dev skill added ~50k tokens to a 70k floor, re-
// read on each of 69 calls. Budgets are bytes and only ratchet down — shrink a
// skill and lower its budget in the same commit; raising one is a visible edit.
export const SKILL_BUDGETS = Object.freeze({
  'codebase-design': 6489,
  dev: 58717,
  'lean-code': 3909,
  pitcrew: 19813,
  'queue-trace': 6933,
  setup: 12725,
  shape: 26690,
});

export function skillBudgetProblems(sizes, budgets = SKILL_BUDGETS) {
  return Object.entries(sizes).sort(([left], [right]) => left.localeCompare(right)).flatMap(([skill, bytes]) => {
    if (!Object.hasOwn(budgets, skill)) return [`SKILL_BUDGET_MISSING ${skill}`];
    return bytes > budgets[skill] ? [`SKILL_OVER_BUDGET ${skill} ${bytes}/${budgets[skill]} bytes`] : [];
  });
}

function checkSkillBudgets(root) {
  const skills = resolve(root, 'skills');
  const sizes = {};
  for (const name of existsSync(skills) ? readdirSync(skills) : []) {
    const path = join(skills, name, 'SKILL.md');
    if (existsSync(path)) sizes[name] = lstatSync(path).size;
  }
  const problems = skillBudgetProblems(sizes);
  return problems.length === 0 ? { ok: true, detail: '' } : { ok: false, detail: problems.join('\n') };
}

function toolChecks(root, toolsDir, requiredFiles) {
  const checks = [];
  for (const name of requiredFiles) {
    checks.push({
      name: `required tool ${name}`,
      execute: () => checkExists(resolve(toolsDir, name)),
    });
  }
  const ownName = basename(fileURLToPath(import.meta.url));
  const toolNames = existsSync(toolsDir) ? readdirSync(toolsDir)
    .filter((name) => name.endsWith('.mjs'))
    .sort() : [];
  for (const name of toolNames) {
    const path = join(toolsDir, name);
    checks.push({
      name: `syntax ${name}`,
      execute: () => run(process.execPath, ['--check', path], root),
    });
    if (name === ownName) continue;
    if (!SELF_TEST_PATTERN.test(readFileSync(path, 'utf8'))) continue;
    checks.push({
      name: `self-test ${name}`,
      execute: () => run(process.execPath, [path, '--self-test'], root),
    });
  }
  return checks;
}

// A devendored repository carries none of the tool: no tools/agentic/ and no
// vendored hook wiring. Either one left behind means devendor is unfinished
// (or undone), and a wired vendored guard would switch the plugin's off.
function checkNoVendoredLayout(root) {
  const leftovers = [];
  if (existsSync(resolve(root, 'tools', 'agentic'))) leftovers.push('tools/agentic/');
  for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
    try {
      if (readFileSync(resolve(root, file), 'utf8').includes('tools/agentic/')) leftovers.push(`${file} (vendored hooks)`);
    } catch {
      // absent or unreadable: nothing vendored wired there
    }
  }
  return leftovers.length === 0
    ? { ok: true, detail: '' }
    : { ok: false, detail: `vendored layout remains: ${leftovers.join(', ')} — run autoloop:setup (devendor)` };
}

// The project doctor: the repository's own data, checked against the plugin
// that runs it. Every tool lives in the plugin, so nothing here self-tests.
function projectChecks(root) {
  const toolsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
  return [
    {
      name: 'ProjectConfig',
      execute: () => run(process.execPath, [resolve(toolsDir, 'config-contract.mjs'), '--root', root], root),
    },
    { name: 'configured review checklist', execute: () => checkConfiguredChecklist(root) },
    { name: 'retired CI policy absent', execute: () => checkRetiredCiPolicy(root) },
    { name: 'no vendored layout', execute: () => checkNoVendoredLayout(root) },
  ];
}

function nodeMajor() {
  return String(process.versions.node).split('.')[0];
}

function selfTest() {
  const success = run(process.execPath, ['--version'], process.cwd());
  const failure = run(process.execPath, ['--definitely-not-a-node-option'], process.cwd());
  const toolsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
  // The committed manifest must match the template bytes it hashes.
  const manifestRoot = mkdtempSync(join(tmpdir(), 'autoloop-manifest-'));
  let freshManifestPasses;
  let staleManifestFails;
  try {
    const fixtureTool = 'function selfTest() { return true; }\n';
    writeFileSync(join(manifestRoot, 'fixture-tool.mjs'), fixtureTool);
    writeFileSync(join(manifestRoot, SELF_TEST_MANIFEST_NAME), renderSelfTestManifest(manifestRoot));
    freshManifestPasses = checkSelfTestManifest(manifestRoot).ok;
    writeFileSync(join(manifestRoot, 'fixture-tool.mjs'), `${fixtureTool}// drifted\n`);
    staleManifestFails = !checkSelfTestManifest(manifestRoot).ok;
  } finally {
    rmSync(manifestRoot, { recursive: true, force: true });
  }
  // The project doctor: a devendored repository passes; any vendored layout
  // left behind fails and names devendor.
  const projectRoot = mkdtempSync(join(tmpdir(), 'autoloop-project-'));
  let devendoredPasses;
  let vendoredToolsFail;
  let vendoredWiringFails;
  let missingChecklistFails;
  try {
    mkdirSync(join(projectRoot, '.autoloop'));
    writeFileSync(join(projectRoot, '.autoloop', 'config.json'), JSON.stringify({
      version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' },
    }));
    const doctor = () => projectChecks(projectRoot).map((check) => ({ name: check.name, ...check.execute() }));
    devendoredPasses = doctor().every((result) => result.ok);
    mkdirSync(join(projectRoot, '.claude'));
    writeFileSync(join(projectRoot, '.claude', 'settings.json'), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node tools/agentic/writeback-check.mjs"}]}]}}');
    vendoredWiringFails = doctor().some((result) => result.name === 'no vendored layout' && !result.ok && result.detail.includes('devendor'));
    rmSync(join(projectRoot, '.claude'), { recursive: true, force: true });
    mkdirSync(join(projectRoot, 'tools', 'agentic'), { recursive: true });
    vendoredToolsFail = doctor().some((result) => result.name === 'no vendored layout' && !result.ok);
    rmSync(join(projectRoot, 'tools'), { recursive: true, force: true });
    // No checklist of its own: the plugin's is used. A path the repository
    // configured explicitly must exist.
    writeFileSync(join(projectRoot, '.autoloop', 'config.json'), JSON.stringify({
      version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' },
      review: { checklistPath: 'docs/review-checklist.md' },
    }));
    missingChecklistFails = doctor().some((result) => result.name === 'configured review checklist' && !result.ok);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
  // Global install: the plugin's own hooks.json. Each tool has exactly one
  // handler, on its event and matcher, running the plugin's copy.
  const pluginHookDocument = (entries = PLUGIN_HOOKS) => {
    const hooks = {};
    for (const entry of entries) {
      (hooks[entry.event] ??= []).push({
        ...(entry.matcher === null ? {} : { matcher: entry.matcher }),
        hooks: [{ type: 'command', command: entry.command }],
      });
    }
    return { hooks };
  };
  const pluginProblems = (document) => pluginHookProblems(document, toolsDir);
  const withGuard = (command) => PLUGIN_HOOKS.map((entry) =>
    (entry.name === 'command-guard.mjs' ? { ...entry, command } : entry));
  const guardEntry = PLUGIN_HOOKS.find((entry) => entry.name === 'command-guard.mjs');
  // A crashed guard refuses inside an autoloop repository and nowhere else:
  // a broken plugin must not refuse every command in every repository.
  const crashRoot = mkdtempSync(join(tmpdir(), 'autoloop-hook-crash-'));
  let crashInside;
  let crashOutside;
  let refusalKept;
  let crashBesideDanglingConfig;
  let crashInSubdirectory;
  try {
    const stub = join(crashRoot, 'plugin', 'templates', 'tools', 'command-guard.mjs');
    mkdirSync(dirname(stub), { recursive: true });
    mkdirSync(join(crashRoot, 'project', '.autoloop'), { recursive: true });
    writeFileSync(join(crashRoot, 'project', '.autoloop', 'config.json'), '{}');
    mkdirSync(join(crashRoot, 'project', 'sub'));
    spawnSync('git', ['init', '-q', join(crashRoot, 'project')]);
    mkdirSync(join(crashRoot, 'elsewhere'));
    mkdirSync(join(crashRoot, 'dangling'));
    symlinkSync(join(crashRoot, 'nowhere'), join(crashRoot, 'dangling', '.autoloop'));
    const guardExits = (code, project) => {
      writeFileSync(stub, `process.exit(${code});\n`);
      return spawnSync('sh', ['-c', guardEntry.command], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: join(crashRoot, 'plugin'), CLAUDE_PROJECT_DIR: join(crashRoot, project) },
      }).status;
    };
    crashInside = guardExits(1, 'project');
    crashOutside = guardExits(1, 'elsewhere');
    // The guard's own refusal is final wherever it happens; a crash beside a
    // config the shell cannot follow (a dangling symlink) still refuses.
    refusalKept = guardExits(2, 'elsewhere') === 2 && guardExits(0, 'project') === 0;
    crashBesideDanglingConfig = guardExits(1, 'dangling');
    crashInSubdirectory = guardExits(1, 'project/sub');
  } finally {
    rmSync(crashRoot, { recursive: true, force: true });
  }
  const cases = [
    ['the plugin hook document passes its contract', pluginProblems(pluginHookDocument()).length === 0],
    ['a missing plugin hook is named',
      pluginProblems(pluginHookDocument(PLUGIN_HOOKS.slice(1))).some((problem) => problem.includes(PLUGIN_HOOKS[0].name))],
    ['a plugin hook on the wrong matcher is refused',
      pluginProblems(pluginHookDocument(PLUGIN_HOOKS.map((entry) =>
        (entry.name === 'command-guard.mjs' ? { ...entry, matcher: 'Bash' } : entry)))).length > 0],
    ['a command guard without its fail-closed branch is refused',
      pluginProblems(pluginHookDocument(withGuard('node "${CLAUDE_PLUGIN_ROOT}/templates/tools/command-guard.mjs"')))
        .some((problem) => problem.includes('command-guard.mjs'))],
    ['a hook outside the contract is refused',
      pluginProblems(pluginHookDocument([...PLUGIN_HOOKS,
        { name: 'x', event: 'Stop', matcher: null, command: 'echo hi' }])).some((problem) => problem.includes('echo hi'))],
    ['a vendored tool path is refused',
      pluginProblems(pluginHookDocument(withGuard('node "$CLAUDE_PROJECT_DIR/tools/agentic/command-guard.mjs" || exit 2'))).length > 0],
    ['a crashed plugin guard refuses in an autoloop repository and allows elsewhere',
      crashInside === 2 && crashOutside === 0],
    ['the guard\'s own refusal is never turned into an allow', refusalKept],
    ['a crash beside an unfollowable .autoloop still refuses', crashBesideDanglingConfig === 2],
    ['a crash in a session started in a subdirectory still refuses', crashInSubdirectory === 2],
    // 0.56.0: a skill loads whole into the session that invokes it and again
    // after every compaction (LFE: the dev skill added ~50k tokens to a 70k
    // floor, re-read on every one of 69 calls). A skill never grows silently.
    ['a skill over its byte budget, or with none, fails; within budget passes',
      JSON.stringify(skillBudgetProblems({ dev: 60001, setup: 100, novel: 5 }, { dev: 60000, setup: 100 }))
        === JSON.stringify(['SKILL_OVER_BUDGET dev 60001/60000 bytes', 'SKILL_BUDGET_MISSING novel'])
        && skillBudgetProblems({ dev: 60000 }, { dev: 60000 }).length === 0],
    ['structured command success', success.ok && success.detail.length > 0],
    ['structured command failure', !failure.ok && failure.detail.length > 0],
    ['invalid JSON is rejected', checkJson(fileURLToPath(import.meta.url)).ok === false],
    ['a fresh committed manifest passes the plugin check', freshManifestPasses],
    ['a stale committed manifest fails the plugin check', staleManifestFails],
    ['a devendored project passes the doctor', devendoredPasses],
    ['vendored hook wiring left behind fails the doctor and names devendor', vendoredWiringFails],
    ['a tools/agentic directory left behind fails the doctor', vendoredToolsFail],
    ['a missing explicitly configured checklist fails the doctor', missingChecklistFails],
  ];
  const failures = cases.filter(([, passed]) => !passed);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(
    failures.length === 0
      ? `self-test OK (${cases.length} cases)`
      : `self-test FAILED (${failures.length}/${cases.length})`,
  );
  return failures.length === 0;
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { mode: 'self-test', root: null, full: false, error: null };
  }
  if (args.length === 1 && args[0] === '--emit-self-test-manifest') {
    return { mode: 'emit-manifest', root: null, full: false, error: null };
  }
  if (args.length === 2 && args[0] === '--plugin-root' && args[1]) {
    return { mode: 'plugin', root: args[1], full: false, error: null };
  }
  if (args.length === 2 && args[0] === '--project-root' && args[1]) {
    return { mode: 'project', root: args[1], full: false, error: null };
  }
  return {
    mode: null,
    root: null,
    full: false,
    error: 'expected --plugin-root <path>, --project-root <path>, '
      + '--emit-self-test-manifest, or --self-test',
  };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`verify: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);
  if (parsed.mode === 'emit-manifest') {
    process.stdout.write(
      renderSelfTestManifest(resolve(fileURLToPath(new URL('.', import.meta.url)))),
    );
    return;
  }

  const root = resolve(parsed.root);
  const checks = parsed.mode === 'plugin'
    ? pluginChecks(root)
    : projectChecks(root);
  const failures = [];
  for (const check of checks) {
    const startedAt = process.hrtime.bigint();
    const result = check.execute();
    const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    // A check's duration prints on its own line, so a slow self-test names
    // itself instead of the log stalling on the previous check's PASS line.
    const timing = elapsedMs >= 1000 ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
    if (result.ok) {
      console.log(`PASS ${check.name}${timing}`);
      // A passing child's stdout is otherwise discarded, which swallowed the
      // self-tests' diagnostic attribution — surface every such line.
      for (const line of result.detail?.match(/^(?:slow checks|matrix phases): .+$/gmu) ?? []) {
        console.log(`  ${line}`);
      }
    } else {
      console.error(`FAIL ${check.name}${timing}`);
      if (result.detail) console.error(result.detail);
      failures.push(check.name);
    }
  }
  if (failures.length > 0) {
    console.error(`verification failed (${failures.length} check(s))`);
    process.exit(1);
  }
  console.log('verification passed');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) main();
