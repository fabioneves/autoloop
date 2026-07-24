#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fingerprint(source) {
  return createHash('sha256').update(source).digest('hex');
}

function scalar(value) {
  const trimmed = value.trim();
  if (/^".*"$/.test(trimmed)) return trimmed.slice(1, -1);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

function tomlValues(source) {
  const values = new Map();
  let section = '';
  let multiline = false;
  for (const line of source.split(/\r?\n/)) {
    const triples = line.match(/"""/g)?.length ?? 0;
    if (!multiline) {
      const sectionMatch = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1];
      } else {
        const assignment = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*([^#]*?)(?:\s+#.*)?$/.exec(line);
        if (assignment) {
          const key = section ? `${section}.${assignment[1]}` : assignment[1];
          values.set(key, scalar(assignment[2]));
        }
      }
    }
    if (triples % 2 === 1) multiline = !multiline;
  }
  return values;
}

function validateCodex(source) {
  const values = tomlValues(source);
  const errors = [];
  const notes = [];
  const required = new Map([
    ['name', 'autoloop_reviewer'],
    ['default_permissions', ':read-only'],
    ['approval_policy', 'never'],
  ]);
  for (const [key, expected] of required) {
    if (values.get(key) !== expected) errors.push(`${key}: expected ${JSON.stringify(expected)}`);
  }
  if (values.has('sandbox_mode')) errors.push('sandbox_mode: legacy field is forbidden');
  for (const key of ['model', 'model_provider', 'model_reasoning_effort']) {
    if ([...values.keys()].some((candidate) => candidate === key || candidate.endsWith(`.${key}`))) {
      errors.push(`${key}: reviewer artifact must inherit runtime selection`);
    }
  }
  const advisory = new Map([
    ['web_search', 'disabled'],
    ['features.apps', false],
    ['features.tool_suggest', false],
    ['features.remote_plugin', false],
    ['apps._default.enabled', false],
    ['apps._default.default_tools_enabled', false],
    ['apps._default.destructive_enabled', false],
    ['apps._default.open_world_enabled', false],
  ]);
  for (const [key, expected] of advisory) {
    if (values.get(key) !== expected) notes.push(`${key}: expected ${JSON.stringify(expected)}`);
  }
  return { ok: errors.length === 0, errors, notes, fingerprint: fingerprint(source) };
}

function frontmatterValues(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return null;
  const values = new Map();
  let section = '';
  for (const line of match[1].split(/\r?\n/)) {
    const nested = /^\s{2}([A-Za-z_][A-Za-z0-9_-]*):\s*(.+?)\s*$/.exec(line);
    if (nested && section) {
      values.set(`${section}.${nested[1]}`, scalar(nested[2]));
      continue;
    }
    const top = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!top) continue;
    section = top[2] ? '' : top[1];
    if (top[2]) values.set(top[1], scalar(top[2]));
  }
  return values;
}

function validateOpencode(source) {
  const values = frontmatterValues(source);
  const errors = [];
  if (!values) errors.push('frontmatter: missing or malformed');
  for (const permission of ['edit', 'bash', 'task', 'webfetch', 'websearch']) {
    if (values?.get(`permission.${permission}`) !== 'deny') {
      errors.push(`permission.${permission}: expected "deny"`);
    }
  }
  for (const key of ['model', 'provider']) {
    if (values?.has(key)) errors.push(`${key}: reviewer artifact must inherit runtime selection`);
  }
  return { ok: errors.length === 0, errors, notes: [], fingerprint: fingerprint(source) };
}

export function validateReviewerArtifact(route, source) {
  if (typeof source !== 'string') {
    return { ok: false, errors: ['source: expected text'], notes: [], fingerprint: null };
  }
  if (route === 'codex') return validateCodex(source);
  if (route === 'opencode') return validateOpencode(source);
  return {
    ok: false,
    errors: [`route: unsupported reviewer artifact ${JSON.stringify(route)}`],
    notes: [],
    fingerprint: fingerprint(source),
  };
}

function selfTest() {
  const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const codex = readFileSync(resolve(templateRoot, 'codex-reviewer-agent.template.toml'), 'utf8');
  const opencode = readFileSync(resolve(templateRoot, 'opencode-reviewer-agent.template.md'), 'utf8');
  const fixtures = [
    {
      name: 'shipped Codex reviewer satisfies doctor contract',
      route: 'codex',
      source: codex,
      ok: true,
    },
    {
      name: 'legacy sandbox_mode cannot replace default_permissions',
      route: 'codex',
      source: codex
        .replace('default_permissions = ":read-only"', 'sandbox_mode = "read-only"'),
      ok: false,
    },
    {
      name: 'Codex reviewer cannot override model',
      route: 'codex',
      source: `${codex}\nmodel = "gpt-5"\n`,
      ok: false,
    },
    {
      name: 'shipped opencode reviewer satisfies doctor contract',
      route: 'opencode',
      source: opencode,
      ok: true,
    },
    {
      name: 'opencode reviewer must deny task delegation',
      route: 'opencode',
      source: opencode.replace('  task: deny', '  task: allow'),
      ok: false,
    },
    {
      name: 'unknown reviewer adapter is rejected',
      route: 'claude',
      source: '',
      ok: false,
    },
  ];
  let passed = 0;
  for (const fixture of fixtures) {
    const actual = validateReviewerArtifact(fixture.route, fixture.source);
    if (actual.ok !== fixture.ok) {
      console.error(`FAIL ${fixture.name}: expected ok=${fixture.ok}, got ok=${actual.ok}`);
      continue;
    }
    passed += 1;
  }
  console.log(passed === fixtures.length ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${fixtures.length})`);
  return passed === fixtures.length;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const route = process.argv[2];
  const source = readFileSync(0, 'utf8');
  const result = validateReviewerArtifact(route, source);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
