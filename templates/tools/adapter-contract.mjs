#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
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
  const errors = [];
  const sections = new Set();
  let section = '';
  let multiline = false;
  for (const line of source.split(/\r?\n/)) {
    const triples = line.match(/"""/g)?.length ?? 0;
    if (!multiline) {
      const sectionMatch = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1];
        if (sections.has(section)) errors.push(`duplicate table [${section}]`);
        sections.add(section);
      } else {
        const assignment = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*([^#]*?)(?:\s+#.*)?$/.exec(line);
        if (assignment) {
          const key = section ? `${section}.${assignment[1]}` : assignment[1];
          if (values.has(key)) errors.push(`${key}: duplicate assignment`);
          values.set(key, scalar(assignment[2]));
        } else if (!/^\s*(?:#.*)?$/u.test(line)) {
          errors.push(`unparsed TOML line: ${line.trim()}`);
        }
      }
    }
    if (triples % 2 === 1) multiline = !multiline;
  }
  if (multiline) errors.push('unterminated multiline string');
  return { values, errors };
}

function validateCodex(source) {
  const parsed = tomlValues(source);
  const { values } = parsed;
  const errors = [...parsed.errors];
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
  const hardening = new Map([
    ['web_search', 'disabled'],
    ['features.apps', false],
    ['features.tool_suggest', false],
    ['features.remote_plugin', false],
    ['apps._default.enabled', false],
    ['apps._default.default_tools_enabled', false],
    ['apps._default.destructive_enabled', false],
    ['apps._default.open_world_enabled', false],
  ]);
  for (const [key, expected] of hardening) {
    if (values.get(key) !== expected) errors.push(`${key}: expected ${JSON.stringify(expected)}`);
  }
  return { ok: errors.length === 0, errors, notes, fingerprint: fingerprint(source) };
}

function frontmatterValues(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return null;
  const values = new Map();
  const unparsed = [];
  let section = '';
  for (const line of match[1].split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const nested =
      /^\s{2}(?:"([^"]+)"|([A-Za-z_*?][A-Za-z0-9_.*?-]*)):\s*(.+?)\s*$/.exec(line);
    if (nested && section) {
      const key = `${section}.${nested[1] ?? nested[2]}`;
      if (values.has(key)) unparsed.push(`${line} # duplicate ${key}`);
      values.set(key, scalar(nested[3]));
      continue;
    }
    const top = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!top) {
      unparsed.push(line);
      continue;
    }
    section = top[2] ? '' : top[1];
    if (top[2]) {
      if (values.has(top[1])) unparsed.push(`${line} # duplicate ${top[1]}`);
      values.set(top[1], scalar(top[2]));
    }
  }
  return { values, unparsed };
}

function validateOpencode(source) {
  const parsed = frontmatterValues(source);
  const values = parsed?.values;
  const errors = [];
  if (!parsed) errors.push('frontmatter: missing or malformed');
  if (parsed?.unparsed.length > 0) {
    errors.push('frontmatter: contains unsupported or malformed entries');
  }
  if (values?.get('mode') !== 'all') errors.push('mode: expected "all"');
  const permissionKeys = [...(values?.keys() ?? [])]
    .filter((key) => key.startsWith('permission.'));
  const expectedPermissionKeys = [
    'permission.*',
    'permission.read',
    'permission.glob',
    'permission.grep',
    'permission.list',
  ];
  if (permissionKeys.join('\0') !== expectedPermissionKeys.join('\0')) {
    errors.push(
      'permission: expected ordered closed-world deny followed only by read/glob/grep/list allows',
    );
  }
  if (values?.get('permission.*') !== 'deny') {
    errors.push('permission.*: expected "deny"');
  }
  for (const permission of ['read', 'glob', 'grep', 'list']) {
    if (values?.get(`permission.${permission}`) !== 'allow') {
      errors.push(`permission.${permission}: expected "allow"`);
    }
  }
  for (const key of [...(values?.keys() ?? [])]) {
    if (
      ['model', 'provider', 'tools'].includes(key)
      || key.startsWith('tools.')
    ) {
      errors.push(`${key}: reviewer artifact must inherit runtime selection and permission policy`);
    }
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

function selfTest(mode, root) {
  const paths = mode === 'template'
    ? {
      codex: resolve(root, 'templates', 'codex-reviewer-agent.template.toml'),
      opencode: resolve(root, 'templates', 'opencode-reviewer-agent.template.md'),
    }
    : {
      codex: resolve(root, '.codex', 'agents', 'autoloop-reviewer.toml'),
      opencode: resolve(root, '.opencode', 'agent', 'autoloop-reviewer.md'),
    };
  const codex = readFileSync(paths.codex, 'utf8');
  const opencode = readFileSync(paths.opencode, 'utf8');
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
      name: 'duplicate Codex safety key is rejected as invalid TOML',
      route: 'codex',
      source: codex.replace(
        'default_permissions = ":read-only"',
        'default_permissions = ":read-only"\ndefault_permissions = ":read-only"',
      ),
      ok: false,
    },
    {
      name: 'unterminated Codex instructions are rejected',
      route: 'codex',
      source: codex.replace(/\n"""\n\n# Reviewers/u, '\n\n# Reviewers'),
      ok: false,
    },
    {
      name: 'Codex reviewer cannot enable apps',
      route: 'codex',
      source: codex.replace('apps = false', 'apps = true'),
      ok: false,
    },
    {
      name: 'shipped opencode reviewer satisfies doctor contract',
      route: 'opencode',
      source: opencode,
      ok: true,
    },
    {
      name: 'opencode reviewer must keep the wildcard deny',
      route: 'opencode',
      source: opencode.replace('  "*": deny', '  "*": ask'),
      ok: false,
    },
    {
      name: 'opencode reviewer cannot allow a custom tool after the wildcard',
      route: 'opencode',
      source: opencode.replace('  list: allow', '  list: allow\n  dangerous_mcp_*: allow'),
      ok: false,
    },
    {
      name: 'duplicate opencode permission is rejected',
      route: 'opencode',
      source: opencode.replace('  list: allow', '  list: allow\n  list: allow'),
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
  const args = process.argv.slice(2);
  if (args[0] === '--self-test') {
    if (
      args.length !== 3
      || !['--template-root', '--install-root'].includes(args[1])
      || !args[2]
    ) {
      console.error(
        'adapter-contract: expected --self-test --template-root <root> '
        + 'or --self-test --install-root <root>',
      );
      process.exit(2);
    }
    const mode = args[1] === '--template-root' ? 'template' : 'install';
    process.exit(selfTest(mode, resolve(args[2])) ? 0 : 1);
  }
  const route = args[0];
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
