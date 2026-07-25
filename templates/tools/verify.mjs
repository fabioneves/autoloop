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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractConfig, validateConfig } from './config-contract.mjs';
import { parseCiPolicy } from './delivery-contract.mjs';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const UNIVERSAL_TOOL_FILES = Object.freeze([
  'adapter-contract.mjs',
  'attestation-contract.mjs',
  'claim-contract.mjs',
  'command-guard.mjs',
  'config-contract.mjs',
  'continuation-store.mjs',
  'contract-lint.mjs',
  'delivery-contract.mjs',
  'escalate-paths.mjs',
  'intent-contract.mjs',
  'label-swap-reminder.mjs',
  'lane-contract.mjs',
  'lifecycle-contract.mjs',
  'lifecycle-driver.mjs',
  'loop-scope.mjs',
  'measurement-contract.mjs',
  'publish-verdict.mjs',
  'release-verify.mjs',
  'review-contract.mjs',
  'route-adapter-contract.mjs',
  'run-scope.mjs',
  'runtime-contract.mjs',
  'scan.mjs',
  'snapshot-contract.mjs',
  'stats.mjs',
  'subagent-transcript.mjs',
  'verify.mjs',
  'writeback-check.mjs',
]);
const PLUGIN_TOOL_FILES = Object.freeze([
  ...UNIVERSAL_TOOL_FILES,
  'auto-merge.reference.mjs',
  'merge-authorization-contract.mjs',
]);
const NON_MANUAL_TOOL_FILES = Object.freeze([
  'auto-merge.mjs',
  'merge-authorization-contract.mjs',
]);
const CLAUDE_HOOK_CONTRACT = Object.freeze({
  'command-guard.mjs': Object.freeze({ event: 'PreToolUse', matcher: 'Bash' }),
  'intent-contract.mjs': Object.freeze({ event: 'UserPromptSubmit', matcher: null }),
  'label-swap-reminder.mjs': Object.freeze({ event: 'PostToolUse', matcher: 'Bash' }),
  'session-preflight.sh': Object.freeze({ event: 'SessionStart', matcher: null }),
  'subagent-transcript.mjs': Object.freeze({ event: 'SubagentStop', matcher: null }),
  'writeback-check.mjs': Object.freeze({ event: 'Stop', matcher: null }),
});
const CODEX_HOOK_CONTRACT = Object.freeze({
  ...CLAUDE_HOOK_CONTRACT,
  'session-preflight.sh': Object.freeze({
    event: 'SessionStart',
    matcher: 'startup|resume|clear|compact',
  }),
});
const OPENCODE_PLUGIN_TOOLS = Object.freeze([
  ...Object.keys(CODEX_HOOK_CONTRACT),
  'continuation-store.mjs',
]);

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

function checkCiPolicy(path) {
  try {
    const exactPath = resolve(path);
    const parentPath = dirname(exactPath);
    if (
      lstatSync(exactPath).isSymbolicLink()
      || lstatSync(parentPath).isSymbolicLink()
      || realpathSync(exactPath) !== exactPath
      || realpathSync(parentPath) !== parentPath
    ) {
      return { ok: false, detail: `${path}: CI policy path must not use symlinks` };
    }
    return parseCiPolicy(readFileSync(path)) === null
      ? { ok: false, detail: `${path}: CI policy is not canonical schema v1` }
      : { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function checkMeasurementPolicy(root, toolPath, policyPath) {
  const result = run(
    process.execPath,
    [toolPath, '--check-budget-policy', policyPath],
    root,
  );
  if (!result.ok) return result;
  let evaluation;
  try {
    evaluation = JSON.parse(result.detail);
  } catch (error) {
    return {
      ok: false,
      detail: `measurement budget policy returned invalid JSON: ${error.message}`,
    };
  }
  if (
    evaluation.status === 'pending-evidence'
    && evaluation.ok === true
    && evaluation.passed === false
  ) {
    return {
      ok: true,
      note: true,
      detail: 'pending-evidence — measurement budget gate has not passed',
    };
  }
  if (
    evaluation.status === 'passed'
    && evaluation.ok === true
    && evaluation.passed === true
  ) {
    return { ok: true, detail: '' };
  }
  return {
    ok: false,
    detail: `measurement budget policy returned inconsistent status: ${result.detail}`,
  };
}

// The release contract reports pending live evidence as a typed note: it never
// blocks contract verification and never passes `--release-mode`.
function checkReleaseContract(root) {
  const result = run(
    process.execPath,
    [resolve(root, 'templates', 'tools', 'release-verify.mjs'), '--check-root', root],
    root,
  );
  if (!result.ok) return result;
  const notes = result.detail
    .split('\n')
    .filter((line) => line.startsWith('note: '))
    .map((line) => line.slice('note: '.length));
  return notes.length === 0
    ? { ok: true, detail: '' }
    : { ok: true, note: true, detail: notes.join('; ') };
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

function referencedVendoredTools(text) {
  const names = new Set();
  for (const match of String(text).matchAll(/tools\/agentic\/([A-Za-z0-9][A-Za-z0-9._-]*)/gu)) {
    names.add(match[1]);
  }
  return names;
}

function validHookArguments(name, args = '') {
  const value = args.trim();
  if (name === 'command-guard.mjs') {
    return value.length === 0
      || /^--config\s+(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|\r\n]+)$/u.test(value);
  }
  if (name === 'intent-contract.mjs') return value === '--capture-hook';
  return value.length === 0;
}

function invokesVendoredTool(command, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const interpreter = name.endsWith('.sh') ? 'bash' : 'node';
  const direct = new RegExp(
    `^\\s*${interpreter}\\s+(?:"[^"\\r\\n]*tools/agentic/${escapedName}"|'[^'\\r\\n]*tools/agentic/${escapedName}'|[^\\s;&|\\r\\n]*tools/agentic/${escapedName})(?:\\s+([^;&|\\r\\n]+))?\\s*$`,
    'u',
  );
  const directMatch = String(command).match(direct);
  if (directMatch && validHookArguments(name, directMatch[1])) return true;
  for (const match of String(command).matchAll(
    /(?:^|[;\s])([A-Za-z_][A-Za-z0-9_]*)=(["'])([^"']+)\2/gu,
  )) {
    const [, variable, , value] = match;
    if (!value.endsWith(`tools/agentic/${name}`)) continue;
    const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const conditional = new RegExp(
      `^([\\s\\S]*?)if\\s+\\[\\s+-f\\s+["']?\\$\\{?${escapedVariable}\\}?["']?\\s+\\]\\s*;\\s*then\\s+([\\s\\S]*?)\\s*;\\s*else\\s+([\\s\\S]*?)\\s*;\\s*fi\\s*$`,
      'u',
    );
    const branches = String(command).match(conditional);
    if (!branches) continue;
    const prefix = branches[1];
    const assignments = prefix.split(';').map((part) => part.trim()).filter(Boolean);
    if (
      assignments.length === 0
      || assignments.some((part) =>
        !/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;\r\n]+)$/u
          .test(part))
    ) {
      continue;
    }
    const invocation = new RegExp(
      `^${interpreter}\\s+["']?\\$\\{?${escapedVariable}\\}?["']?(?:\\s+([^;&|\\r\\n]+))?\\s*$`,
      'u',
    );
    const invocationMatch = branches[2].match(invocation);
    if (
      !invocationMatch
      || !validHookArguments(name, invocationMatch[1])
    ) {
      continue;
    }
    if (
      name === 'command-guard.mjs'
      && !/(?:^|;)\s*exit\s+[1-9][0-9]*\s*$/u.test(branches[3])
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function referencedPluginTools(text) {
  const names = new Set();
  for (const match of String(text).matchAll(
    /\btool\(\s*["']([A-Za-z0-9][A-Za-z0-9._-]*)["']\s*\)/gu,
  )) {
    names.add(match[1]);
  }
  return names;
}

function validateToolReferences(
  text,
  toolsDir,
  expected,
  referenceExtractor,
  requireExpected = true,
) {
  const references = referenceExtractor(text);
  const errors = [];
  if (String(text).includes('tools/agentic/') && references.size === 0) {
    errors.push('contains an unparseable tools/agentic reference');
  }
  if (requireExpected || references.size > 0) {
    for (const name of expected) {
      if (!references.has(name)) errors.push(`missing configured tool reference ${name}`);
    }
  }
  for (const name of references) {
    if (!existsSync(resolve(toolsDir, name))) {
      errors.push(`configured tool reference does not resolve: ${name}`);
    }
  }
  return {
    ok: errors.length === 0,
    detail: errors.join('; '),
  };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateHookBindings(
  bindings,
  source,
  toolsDir,
  contract,
  requireConfigured,
  parseErrors = [],
) {
  const errors = [...parseErrors];
  const configured = new Map();
  const handlerReferences = new Set();
  for (const binding of bindings) {
    const references = referencedVendoredTools(binding.command);
    for (const name of references) {
      handlerReferences.add(name);
      if (!existsSync(resolve(toolsDir, name))) {
        errors.push(`configured tool reference does not resolve: ${name}`);
      }
      const expected = contract[name];
      if (!expected) continue;
      if (!invokesVendoredTool(binding.command, name)) {
        errors.push(`${name}: hook command references the tool without executing it`);
        continue;
      }
      if (
        binding.event !== expected.event
        || binding.matcher !== expected.matcher
      ) {
        errors.push(
          `${name}: expected ${expected.event}`
          + (expected.matcher === null ? '' : ` matcher ${expected.matcher}`),
        );
      }
      if (configured.has(name)) errors.push(`${name}: configured more than once`);
      configured.set(name, binding);
    }
  }
  for (const name of referencedVendoredTools(source)) {
    if (!handlerReferences.has(name)) {
      errors.push(`${name}: reference is outside a valid command-hook handler`);
    }
  }
  if (requireConfigured || configured.size > 0) {
    for (const name of Object.keys(contract)) {
      if (!configured.has(name)) errors.push(`missing configured tool reference ${name}`);
    }
  }
  return { ok: errors.length === 0, detail: errors.join('; ') };
}

function inspectHookJson(source, toolsDir, contract, requireConfigured = false) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { ok: false, detail: error.message };
  }
  const errors = [];
  const bindings = [];
  if (value?.hooks !== undefined && !plainObject(value.hooks)) {
    errors.push('hooks: expected an object');
  }
  for (const [event, groups] of Object.entries(value?.hooks ?? {})) {
    if (!Array.isArray(groups)) {
      errors.push(`hooks.${event}: expected an array`);
      continue;
    }
    groups.forEach((group, groupIndex) => {
      const path = `hooks.${event}[${groupIndex}]`;
      if (!plainObject(group) || !Array.isArray(group.hooks)) {
        errors.push(`${path}: expected a matcher group with hooks array`);
        return;
      }
      const matcher = group.matcher ?? null;
      if (matcher !== null && typeof matcher !== 'string') {
        errors.push(`${path}.matcher: expected a string`);
      }
      group.hooks.forEach((handler, handlerIndex) => {
        const handlerPath = `${path}.hooks[${handlerIndex}]`;
        if (!plainObject(handler) || handler.type !== 'command') {
          errors.push(`${handlerPath}: expected a command handler`);
          return;
        }
        const commands = [
          ['command', handler.command],
          ['commandWindows', handler.commandWindows],
          ['command_windows', handler.command_windows],
        ].filter(([, command]) => command !== undefined);
        if (
          commands.length === 0
          || commands.some(([, command]) =>
            typeof command !== 'string' || command.length === 0)
        ) {
          errors.push(`${handlerPath}: expected non-empty command text`);
          return;
        }
        commands.forEach(([, command]) => {
          bindings.push({ event, matcher, command });
        });
      });
    });
  }
  return validateHookBindings(
    bindings,
    source,
    toolsDir,
    contract,
    requireConfigured,
    errors,
  );
}

function tomlString(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if (!['"', "'"].includes(quote) || trimmed.at(-1) !== quote) return null;
  if (quote === "'" && trimmed.slice(1, -1).includes("'")) return null;
  try {
    return quote === '"' ? JSON.parse(trimmed) : trimmed.slice(1, -1);
  } catch {
    return null;
  }
}

function inlineCodexBindings(source) {
  const bindings = [];
  const errors = [];
  const groups = new Map();
  let current = null;
  const finishHandler = () => {
    if (!current || current.kind !== 'handler') return;
    if (current.type !== 'command' || current.commands.length === 0) {
      errors.push(`${current.path}: expected a command handler`);
    } else {
      current.commands.forEach((command) => {
        bindings.push({
          event: current.event,
          matcher: current.matcher,
          command,
        });
      });
    }
  };
  for (const [index, line] of String(source).split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (
      current
      && /^(?:command|commandWindows|command_windows)\s*=.*(?:'''|""")/u.test(trimmed)
    ) {
      errors.push(`${current.path}: multiline hook commands are unsupported`);
    }
    const section = /^\[\[hooks\.([A-Za-z][A-Za-z0-9]*)(\.hooks)?\]\]$/u.exec(trimmed);
    if (section) {
      finishHandler();
      const event = section[1];
      if (section[2]) {
        const group = groups.get(event);
        current = {
          kind: 'handler',
          event,
          matcher: group?.matcher ?? null,
          type: null,
          commands: [],
          path: `line ${index + 1}`,
        };
        if (!group) errors.push(`line ${index + 1}: hook handler has no matcher group`);
      } else {
        current = {
          kind: 'group',
          event,
          matcher: null,
          path: `line ${index + 1}`,
        };
        groups.set(event, current);
      }
      continue;
    }
    if (/^\[/u.test(trimmed)) {
      finishHandler();
      current = null;
      continue;
    }
    if (!current || !trimmed || trimmed.startsWith('#')) continue;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/u.exec(trimmed);
    if (!assignment) continue;
    const value = tomlString(assignment[2]);
    if (value === null) {
      errors.push(`${current.path}.${assignment[1]}: expected one quoted line`);
      continue;
    }
    if (current.kind === 'group' && assignment[1] === 'matcher') {
      current.matcher = value;
    } else if (current.kind === 'handler' && assignment[1] === 'type') {
      current.type = value;
    } else if (
      current.kind === 'handler'
      && ['command', 'commandWindows', 'command_windows'].includes(assignment[1])
    ) {
      current.commands.push(value);
    }
  }
  finishHandler();
  return { bindings, errors };
}

function inspectCodexConfig(
  source,
  toolsDir,
  siblingHooks,
  requireConfigured = false,
) {
  const hasInlineHooks = /^\s*\[\[?hooks(?:[.\]])/mu.test(source);
  if (hasInlineHooks && siblingHooks) {
    return {
      ok: false,
      detail: 'inline Codex hooks and .codex/hooks.json coexist in one project layer',
    };
  }
  if (!hasInlineHooks) {
    return requireConfigured
      ? { ok: false, detail: 'inline Codex hook tables are missing' }
      : { ok: true, detail: '' };
  }
  const parsed = inlineCodexBindings(source);
  if (parsed.bindings.length === 0 && parsed.errors.length === 0) {
    parsed.errors.push('inline Codex hook tables are malformed or unsupported');
  }
  return validateHookBindings(
    parsed.bindings,
    source,
    toolsDir,
    CODEX_HOOK_CONTRACT,
    requireConfigured,
    parsed.errors,
  );
}

function checkHookJson(path, toolsDir, contract, requireConfigured = false) {
  try {
    return inspectHookJson(
      readFileSync(path, 'utf8'),
      toolsDir,
      contract,
      requireConfigured,
    );
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function checkRequiredCodexEntrypoint(root, toolsDir) {
  const hooksPath = resolve(root, '.codex', 'hooks.json');
  const configPath = resolve(root, '.codex', 'config.toml');
  const hasHooks = existsSync(hooksPath);
  const hasConfig = existsSync(configPath);
  if (!hasHooks && !hasConfig) {
    return {
      ok: false,
      detail: 'Codex requires .codex/hooks.json or project-layer inline hooks',
    };
  }
  if (hasHooks) {
    const hooks = checkHookJson(
      hooksPath,
      toolsDir,
      CODEX_HOOK_CONTRACT,
      true,
    );
    if (!hooks.ok) return hooks;
  }
  if (hasConfig) {
    try {
      const config = inspectCodexConfig(
        readFileSync(configPath, 'utf8'),
        toolsDir,
        hasHooks,
        !hasHooks,
      );
      if (!config.ok) return config;
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }
  return { ok: true, detail: '' };
}

function checkOpencodePlugin(path, toolsDir) {
  try {
    return validateToolReferences(
      readFileSync(path, 'utf8'),
      toolsDir,
      OPENCODE_PLUGIN_TOOLS,
      referencedPluginTools,
      true,
    );
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function checkRequiredOpencodeEntrypoint(root, toolsDir) {
  const path = resolve(root, '.opencode', 'plugins', 'autoloop.js');
  const present = checkExists(path);
  if (!present.ok) return present;
  const references = checkOpencodePlugin(path, toolsDir);
  if (!references.ok) return references;
  return run(process.execPath, ['--check', path], root);
}

function installedEntrypointChecks(root, toolsDir) {
  return [
    {
      name: 'required Claude prompt entrypoint',
      execute: () => checkHookJson(
        resolve(root, '.claude', 'settings.json'),
        toolsDir,
        CLAUDE_HOOK_CONTRACT,
        true,
      ),
    },
    {
      name: 'required Codex prompt entrypoint',
      execute: () => checkRequiredCodexEntrypoint(root, toolsDir),
    },
    {
      name: 'required opencode prompt entrypoint',
      execute: () => checkRequiredOpencodeEntrypoint(root, toolsDir),
    },
  ];
}

function checkConfiguredChecklist(root) {
  try {
    const statePath = resolve(root, 'docs', 'agentic', 'STATE.md');
    const config = extractConfig(readFileSync(statePath, 'utf8'));
    const errors = validateConfig(config);
    if (errors.length > 0) {
      return {
        ok: false,
        detail: `ProjectConfig is invalid: ${errors.join('; ')}`,
      };
    }
    return checkExists(resolve(root, config.review.checklistPath));
  } catch (error) {
    return { ok: false, detail: `cannot resolve configured checklist: ${error.message}` };
  }
}

function pluginChecks(root) {
  const toolsDir = resolve(root, 'templates', 'tools');
  const checks = toolChecks(root, toolsDir, PLUGIN_TOOL_FILES, 'template');

  checks.push({
    name: 'syntax opencode plugin',
    execute: () => run(
      process.execPath,
      ['--check', resolve(root, 'templates', 'opencode-plugin.template.js')],
      root,
    ),
  });
  checks.push({
    name: 'self-test opencode plugin',
    execute: () => run(
      process.execPath,
      [resolve(root, 'templates', 'opencode-plugin.test.mjs')],
      root,
    ),
  });
  checks.push({
    name: 'opencode plugin tool references',
    execute: () => checkOpencodePlugin(
      resolve(root, 'templates', 'opencode-plugin.template.js'),
      toolsDir,
    ),
  });
  for (const relativePath of [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'templates/opencode-config.template.json',
    'templates/ci-policy.template.json',
    'templates/measurement-budget-policy.template.json',
  ]) {
    checks.push({
      name: `json ${relativePath}`,
      execute: () => checkJson(resolve(root, relativePath)),
    });
  }
  checks.push({
    name: 'canonical CI policy template',
    execute: () => checkCiPolicy(resolve(root, 'templates', 'ci-policy.template.json')),
  });
  checks.push({
    name: 'measurement budget policy template',
    execute: () => checkMeasurementPolicy(
      root,
      resolve(toolsDir, 'measurement-contract.mjs'),
      resolve(root, 'templates', 'measurement-budget-policy.template.json'),
    ),
  });
  for (const [relativePath, contract] of [
    ['templates/codex-hooks.template.json', CODEX_HOOK_CONTRACT],
    ['templates/settings-hooks.template.json', CLAUDE_HOOK_CONTRACT],
  ]) {
    checks.push({
      name: `hook contract ${relativePath}`,
      execute: () => checkHookJson(
        resolve(root, relativePath),
        toolsDir,
        contract,
        true,
      ),
    });
  }
  checks.push({
    name: 'shell session-preflight',
    execute: () => run(
      'bash',
      ['-n', resolve(root, 'templates', 'tools', 'session-preflight.sh')],
      root,
    ),
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
  return checks;
}

function toolChecks(root, toolsDir, requiredFiles, artifactMode) {
  const checks = [];
  for (const name of requiredFiles) {
    checks.push({
      name: `required tool ${name}`,
      execute: () => checkExists(resolve(toolsDir, name)),
    });
  }
  const toolNames = existsSync(toolsDir) ? readdirSync(toolsDir)
    .filter((name) => name.endsWith('.mjs'))
    .sort() : [];
  for (const name of toolNames) {
    const path = join(toolsDir, name);
    checks.push({
      name: `syntax ${name}`,
      execute: () => run(process.execPath, ['--check', path], root),
    });
    if (
      name !== basename(fileURLToPath(import.meta.url))
      && /(?:async\s+)?function\s+selfTest\s*\(/.test(readFileSync(path, 'utf8'))
    ) {
      checks.push({
        name: `self-test ${name}`,
        execute: () => run(
          process.execPath,
          name === 'adapter-contract.mjs'
            ? [
              path,
              '--self-test',
              artifactMode === 'template' ? '--template-root' : '--install-root',
              root,
            ]
            : [path, '--self-test'],
          root,
        ),
      });
    }
  }
  return checks;
}

function installedToolFiles(config) {
  return [
    ...UNIVERSAL_TOOL_FILES,
    ...(config?.merge?.policy && config.merge.policy !== 'manual'
      ? NON_MANUAL_TOOL_FILES
      : []),
  ];
}

function installChecks(root) {
  const toolsDir = resolve(root, 'tools', 'agentic');
  let config = null;
  try {
    const state = readFileSync(resolve(root, 'docs', 'agentic', 'STATE.md'), 'utf8');
    const candidate = extractConfig(state);
    if (validateConfig(candidate).length === 0) config = candidate;
  } catch {
    config = null;
  }
  const requiredFiles = installedToolFiles(config);
  const checks = toolChecks(root, toolsDir, requiredFiles, 'install');
  for (const relativePath of [
    '.autoloop/ci-policy.json',
    '.autoloop/measurement-budget-policy.json',
    '.codex/agents/autoloop-reviewer.toml',
    '.opencode/agent/autoloop-reviewer.md',
    'docs/agentic/LOOP.md',
    '.opencode/opencode.json',
  ]) {
    checks.push({
      name: `required artifact ${relativePath}`,
      execute: () => checkExists(resolve(root, relativePath)),
    });
  }
  checks.push({
    name: 'canonical installed CI policy',
    execute: () => checkCiPolicy(resolve(root, '.autoloop', 'ci-policy.json')),
  });
  checks.push({
    name: 'installed measurement budget policy',
    execute: () => checkMeasurementPolicy(
      root,
      resolve(toolsDir, 'measurement-contract.mjs'),
      resolve(root, '.autoloop', 'measurement-budget-policy.json'),
    ),
  });
  checks.push({
    name: 'configured review checklist',
    execute: () => checkConfiguredChecklist(root),
  });
  checks.push({
    name: 'ProjectConfig',
    execute: () => run(
      process.execPath,
      [
        resolve(toolsDir, 'config-contract.mjs'),
        resolve(root, 'docs', 'agentic', 'STATE.md'),
      ],
      root,
    ),
  });
  checks.push({
    name: 'installed forward contract lint',
    execute: () => run(
      process.execPath,
      [
        resolve(toolsDir, 'contract-lint.mjs'),
        '--check-install-root',
        root,
      ],
      root,
    ),
  });
  checks.push({
    name: 'shell session-preflight',
    execute: () => run(
      'bash',
      ['-n', resolve(toolsDir, 'session-preflight.sh')],
      root,
    ),
  });
  for (const relativePath of [
    '.opencode/opencode.json',
  ]) {
    try {
      readFileSync(resolve(root, relativePath));
    } catch {
      continue;
    }
    checks.push({
      name: `json ${relativePath}`,
      execute: () => checkJson(resolve(root, relativePath)),
    });
  }
  checks.push(...installedEntrypointChecks(root, toolsDir));
  return checks;
}

function selfTest() {
  const success = run(process.execPath, ['--version'], process.cwd());
  const failure = run(process.execPath, ['--definitely-not-a-node-option'], process.cwd());
  const toolsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
  const hookInvocation = (name, path) =>
    `${name.endsWith('.sh') ? 'bash' : 'node'} "${path}/${name}"`
    + (name === 'intent-contract.mjs' ? ' --capture-hook' : '');
  const hookDocument = (contract) => {
    const hooks = {};
    for (const [name, binding] of Object.entries(contract)) {
      if (!hooks[binding.event]) hooks[binding.event] = [];
      hooks[binding.event].push({
        ...(binding.matcher === null ? {} : { matcher: binding.matcher }),
        hooks: [{
          type: 'command',
          command: hookInvocation(name, '$ROOT/tools/agentic'),
        }],
      });
    }
    return JSON.stringify({ hooks });
  };
  const hookDocumentWithCommand = (contract, name, command) => {
    const document = JSON.parse(hookDocument(contract));
    for (const bindings of Object.values(document.hooks)) {
      for (const binding of bindings) {
        for (const hook of binding.hooks) {
          if (hook.command.includes(`/tools/agentic/${name}`)) {
            hook.command = command;
          }
        }
      }
    }
    return JSON.stringify(document);
  };
  const inlineHooks = (contract) => Object.entries(contract).map(([name, binding]) => [
    `[[hooks.${binding.event}]]`,
    ...(binding.matcher === null ? [] : [`matcher = "${binding.matcher}"`]),
    `[[hooks.${binding.event}.hooks]]`,
    'type = "command"',
    `command = '${hookInvocation(name, 'tools/agentic')}'`,
  ].join('\n')).join('\n');
  const partialHook = inspectHookJson(JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: 'node "$ROOT/tools/agentic/command-guard.mjs"',
        }],
      }],
    },
  }), toolsDir, CLAUDE_HOOK_CONTRACT, true);
  const completeHook = inspectHookJson(
    hookDocument(CLAUDE_HOOK_CONTRACT),
    toolsDir,
    CLAUDE_HOOK_CONTRACT,
    true,
  );
  const completeInlineCodex = inspectCodexConfig(
    inlineHooks(CODEX_HOOK_CONTRACT),
    toolsDir,
    false,
    true,
  );
  const duplicateCodex = inspectCodexConfig(
    inlineHooks(CODEX_HOOK_CONTRACT),
    toolsDir,
    true,
    true,
  );
  const swappedEvent = inspectHookJson(JSON.stringify({
    hooks: {
      Stop: [{
        hooks: [{
          type: 'command',
          command: 'node "$ROOT/tools/agentic/command-guard.mjs"',
        }],
      }],
    },
  }), toolsDir, CLAUDE_HOOK_CONTRACT, false);
  const matcherOnUnmatchedEvent = inspectHookJson(JSON.stringify({
    hooks: {
      Stop: [{
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: 'node "$ROOT/tools/agentic/writeback-check.mjs"',
        }],
      }],
    },
  }), toolsDir, CLAUDE_HOOK_CONTRACT, false);
  const bogusNesting = inspectHookJson(JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [],
        ignored: {
          command: 'node "$ROOT/tools/agentic/command-guard.mjs"',
        },
      }],
    },
  }), toolsDir, CLAUDE_HOOK_CONTRACT, false);
  const emptyRequiredHooks = inspectHookJson(
    '{"hooks":{}}',
    toolsDir,
    CLAUDE_HOOK_CONTRACT,
    true,
  );
  const multilineInline = inspectCodexConfig(
    '[[hooks.PreToolUse]]\nmatcher = "Bash"\n'
    + '[[hooks.PreToolUse.hooks]]\ntype = "command"\n'
    + 'command = """node tools/agentic/command-guard.mjs\n"""',
    toolsDir,
    false,
    true,
  );
  const malformedInline = inspectCodexConfig(
    '[hooks]\nenabled = true\n',
    toolsDir,
    false,
    false,
  );
  const missingReference = validateToolReferences(
    'node "$ROOT/tools/agentic/not-installed.mjs"',
    toolsDir,
    [],
    referencedVendoredTools,
  );
  const invalidClaudeHook = (name, command) => inspectHookJson(
    hookDocumentWithCommand(CLAUDE_HOOK_CONTRACT, name, command),
    toolsDir,
    CLAUDE_HOOK_CONTRACT,
    true,
  );
  const inertEchoHook = invalidClaudeHook(
    'command-guard.mjs',
    'echo tools/agentic/command-guard.mjs',
  );
  const shortCircuitedHook = invalidClaudeHook(
    'command-guard.mjs',
    'false && node tools/agentic/command-guard.mjs',
  );
  const maskedGuardHook = invalidClaudeHook(
    'command-guard.mjs',
    'node tools/agentic/command-guard.mjs || true',
  );
  const exitedGuardHook = invalidClaudeHook(
    'command-guard.mjs',
    'exit 0; node tools/agentic/command-guard.mjs',
  );
  const wrongGuardInterpreter = invalidClaudeHook(
    'command-guard.mjs',
    'bash tools/agentic/command-guard.mjs',
  );
  const wrongPreflightInterpreter = invalidClaudeHook(
    'session-preflight.sh',
    'node tools/agentic/session-preflight.sh',
  );
  const selfTestGuardHook = invalidClaudeHook(
    'command-guard.mjs',
    'node tools/agentic/command-guard.mjs --self-test',
  );
  const selfTestWritebackHook = invalidClaudeHook(
    'writeback-check.mjs',
    'node tools/agentic/writeback-check.mjs --self-test',
  );
  const manualTools = installedToolFiles({ merge: { policy: 'manual' } });
  const ratifiedTools = installedToolFiles({ merge: { policy: 'ratified' } });
  const entrypointRoot = mkdtempSync(join(tmpdir(), 'autoloop-entrypoints-'));
  let completeEntrypoints;
  let disabledClaudeEntrypoint;
  let missingCodexEntrypoint;
  let missingOpencodeEntrypoint;
  try {
    mkdirSync(resolve(entrypointRoot, '.claude'), { recursive: true });
    mkdirSync(resolve(entrypointRoot, '.codex'), { recursive: true });
    mkdirSync(
      resolve(entrypointRoot, '.opencode', 'plugins'),
      { recursive: true },
    );
    writeFileSync(
      resolve(entrypointRoot, '.claude', 'settings.json'),
      hookDocument(CLAUDE_HOOK_CONTRACT),
    );
    writeFileSync(
      resolve(entrypointRoot, '.codex', 'hooks.json'),
      hookDocument(CODEX_HOOK_CONTRACT),
    );
    writeFileSync(
      resolve(entrypointRoot, '.opencode', 'plugins', 'autoloop.js'),
      readFileSync(resolve(toolsDir, '..', 'opencode-plugin.template.js')),
    );
    completeEntrypoints = installedEntrypointChecks(
      entrypointRoot,
      toolsDir,
    ).every((check) => check.execute().ok);
    writeFileSync(
      resolve(entrypointRoot, '.claude', 'settings.json'),
      '{"hooks":{}}\n',
    );
    disabledClaudeEntrypoint = installedEntrypointChecks(
      entrypointRoot,
      toolsDir,
    ).some((check) =>
      check.name === 'required Claude prompt entrypoint'
      && !check.execute().ok);
    writeFileSync(
      resolve(entrypointRoot, '.claude', 'settings.json'),
      hookDocument(CLAUDE_HOOK_CONTRACT),
    );
    rmSync(resolve(entrypointRoot, '.codex', 'hooks.json'));
    writeFileSync(
      resolve(entrypointRoot, '.codex', 'config.toml'),
      '[project]\nname = "no-hooks"\n',
    );
    missingCodexEntrypoint = installedEntrypointChecks(
      entrypointRoot,
      toolsDir,
    ).some((check) =>
      check.name === 'required Codex prompt entrypoint'
      && !check.execute().ok);
    rmSync(resolve(entrypointRoot, '.codex', 'config.toml'));
    writeFileSync(
      resolve(entrypointRoot, '.codex', 'hooks.json'),
      hookDocument(CODEX_HOOK_CONTRACT),
    );
    rmSync(resolve(entrypointRoot, '.opencode', 'plugins', 'autoloop.js'));
    missingOpencodeEntrypoint = installedEntrypointChecks(
      entrypointRoot,
      toolsDir,
    ).some((check) =>
      check.name === 'required opencode prompt entrypoint'
      && !check.execute().ok);
  } finally {
    rmSync(entrypointRoot, { recursive: true, force: true });
  }
  const cases = [
    ['structured command success', success.ok && success.detail.length > 0],
    ['structured command failure', !failure.ok && failure.detail.length > 0],
    ['invalid JSON is rejected', checkJson(fileURLToPath(import.meta.url)).ok === false],
    ['complete JSON hook wiring resolves', completeHook.ok],
    ['complete inline Codex hook wiring resolves', completeInlineCodex.ok],
    ['partial hook wiring is rejected', !partialHook.ok],
    ['swapped hook event is rejected', !swappedEvent.ok],
    ['matcher on an unfiltered event is rejected', !matcherOnUnmatchedEvent.ok],
    ['references outside hook handlers are rejected', !bogusNesting.ok],
    ['empty required hook artifact is rejected', !emptyRequiredHooks.ok],
    ['multiline inline Codex hook command is rejected', !multilineInline.ok],
    ['malformed inline Codex hook tables are rejected', !malformedInline.ok],
    ['duplicate Codex hook representations are rejected', !duplicateCodex.ok],
    ['missing vendored hook target is rejected', !missingReference.ok],
    ['text-only hook references are rejected', !inertEchoHook.ok],
    ['short-circuited hook commands are rejected', !shortCircuitedHook.ok],
    ['masked command guards are rejected', !maskedGuardHook.ok],
    ['commands after exit are rejected', !exitedGuardHook.ok],
    ['command guards require node', !wrongGuardInterpreter.ok],
    ['session preflight requires bash', !wrongPreflightInterpreter.ok],
    ['command-guard self-test mode is not a production hook', !selfTestGuardHook.ok],
    ['writeback self-test mode is not a production hook', !selfTestWritebackHook.ok],
    [
      'non-manual installs require merge-authority tools',
      !manualTools.includes('auto-merge.mjs')
        && NON_MANUAL_TOOL_FILES.every((name) => ratifiedTools.includes(name)),
    ],
    ['manual installs include the terminal finalizer', manualTools.includes('publish-verdict.mjs')],
    ['manual installs include the lifecycle driver', manualTools.includes('lifecycle-driver.mjs')],
    ['complete host prompt entrypoints pass', completeEntrypoints],
    ['disabled Claude prompt entrypoint fails closed', disabledClaudeEntrypoint],
    ['missing Codex prompt entrypoint fails closed', missingCodexEntrypoint],
    ['missing opencode prompt entrypoint fails closed', missingOpencodeEntrypoint],
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
    return { mode: 'self-test', root: null, error: null };
  }
  if (args.length === 2 && args[0] === '--plugin-root' && args[1]) {
    return { mode: 'plugin', root: args[1], error: null };
  }
  if (args.length === 2 && args[0] === '--install-root' && args[1]) {
    return { mode: 'install', root: args[1], error: null };
  }
  return {
    mode: null,
    root: null,
    error: 'expected --plugin-root <path>, --install-root <path>, or --self-test',
  };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`verify: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);

  const root = resolve(parsed.root);
  const checks = parsed.mode === 'plugin' ? pluginChecks(root) : installChecks(root);
  const failures = [];
  for (const check of checks) {
    const result = check.execute();
    if (result.ok) {
      console.log(
        result.note
          ? `NOTE ${check.name}: ${result.detail}`
          : `PASS ${check.name}`,
      );
    } else {
      console.error(`FAIL ${check.name}`);
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
