#!/usr/bin/env node

import {
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 1024 * 1024;

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
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

function pluginChecks(root) {
  const toolsDir = resolve(root, 'templates', 'tools');
  const checks = toolChecks(root, toolsDir);

  checks.push({
    name: 'syntax opencode plugin',
    execute: () => run(
      process.execPath,
      ['--check', resolve(root, 'templates', 'opencode-plugin.template.js')],
      root,
    ),
  });
  for (const relativePath of [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'templates/codex-hooks.template.json',
    'templates/opencode-config.template.json',
    'templates/settings-hooks.template.json',
  ]) {
    checks.push({
      name: `json ${relativePath}`,
      execute: () => checkJson(resolve(root, relativePath)),
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
    execute: () => run(
      process.execPath,
      [resolve(root, 'templates', 'tools', 'release-verify.mjs'), '--check-root', root],
      root,
    ),
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

function toolChecks(root, toolsDir) {
  const checks = [];
  const toolNames = readdirSync(toolsDir)
    .filter((name) => name.endsWith('.mjs'))
    .sort();
  for (const name of toolNames) {
    const path = join(toolsDir, name);
    checks.push({
      name: `syntax ${name}`,
      execute: () => run(process.execPath, ['--check', path], root),
    });
    if (
      name !== basename(fileURLToPath(import.meta.url))
      && readFileSync(path, 'utf8').includes('--self-test')
    ) {
      checks.push({
        name: `self-test ${name}`,
        execute: () => run(process.execPath, [path, '--self-test'], root),
      });
    }
  }
  return checks;
}

function installChecks(root) {
  const toolsDir = resolve(root, 'tools', 'agentic');
  const checks = toolChecks(root, toolsDir);
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
    name: 'shell session-preflight',
    execute: () => run(
      'bash',
      ['-n', resolve(toolsDir, 'session-preflight.sh')],
      root,
    ),
  });
  for (const relativePath of [
    '.claude/settings.json',
    '.codex/hooks.json',
    'opencode.json',
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
  return checks;
}

function selfTest() {
  const success = run(process.execPath, ['--version'], process.cwd());
  const failure = run(process.execPath, ['--definitely-not-a-node-option'], process.cwd());
  const cases = [
    ['structured command success', success.ok && success.detail.length > 0],
    ['structured command failure', !failure.ok && failure.detail.length > 0],
    ['invalid JSON is rejected', checkJson(fileURLToPath(import.meta.url)).ok === false],
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
      console.log(`PASS ${check.name}`);
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
