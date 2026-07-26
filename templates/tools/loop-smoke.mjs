#!/usr/bin/env node

// No-model end-to-end loop smoke: the release gate that proves the mechanical
// spine of a live /autoloop:dev session against a scratch fixture repository,
// with the REAL tool chain — and no model, no network, and no gh
// authentication.
//
// Sequence (the mechanical path of a live session):
//   1. `prime.mjs --json` validates ProjectConfig, reports the base, runs one
//      `scan.mjs`, persists the snapshot, and writes the run marker. The
//      fixture origin is a fake GitHub slug and the children run with an empty
//      GH_CONFIG_DIR and no token variables, so every `gh` call fails
//      immediately without network and scan degrades to a complete snapshot
//      whose sections are typed-incomplete — which prime accepts (completeness
//      fallbacks stay with the caller).
//   2. `dispatch.mjs --role plan-review` against a shimmed engine.
//   3. `dispatch.mjs --role implement` against the same shim.
//   4. `dispatch.mjs --role code-review` against the same shim.
//   5. The configured gate command runs on the fixture.
//   6. The guardrail close: `command-guard.mjs` blocks a merge while the run
//      marker is live, then the marker is removed and the guard stands down.
//
// Every dispatch's launched argv is captured, and the gate asserts that no
// reviewer dispatch was ever handed a write tool. The phase table prints each
// phase's wall cost so a regression in the mechanics is visible without a
// profiler.
//
// `--real-engine-smoke` is the OTHER mode: it runs ONE real `code-review`
// dispatch WITHOUT the shim, against the authenticated engine. It is the only
// check that proves a dispatch reaches a model at all — the shimmed smoke
// proves the mechanics and cannot tell a working engine from a missing one.
//
// It is deliberately NOT part of `--self-test` and NOT part of CI: it costs
// real model spend and needs an authenticated engine CLI. Run it by hand
// before a release.
//
// Usage:
//   node tools/agentic/loop-smoke.mjs --self-test
//   node tools/agentic/loop-smoke.mjs --real-engine-smoke   # manual, costs money

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSAL_TOOL_FILES } from './verify.mjs';

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SMOKE_BUDGET_MS = 60_000;
const STEP_TIMEOUT_MS = 55_000;
// One real dispatch is a model round trip, not a mechanical step.
const REAL_ENGINE_BUDGET_MS = 10 * 60_000;
const REAL_ENGINE_STEP_TIMEOUT_MS = 9 * 60_000;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const FIXTURE_ORIGIN_URL = 'https://github.com/autoloop-smoke/fixture.git';
// Ambient credentials and host-repo Git state must not leak into the fixture:
// the smoke's contract is deterministic offline behavior.
const STRIPPED_ENV_PREFIXES = ['GIT_'];
const STRIPPED_ENV_KEYS = [
  'NODE_OPTIONS',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
];
const FIXTURE_CONFIG = {
  version: '0.26.0',
  baseBranch: 'main',
  gate: { command: 'true', quickCommand: null, setupCommand: null },
  merge: { policy: 'manual' },
  tracker: { provider: 'none' },
  review: { checklistPath: 'docs/agentic/checklist.md' },
  caps: {
    gateRetriesPerUnit: 2,
    reviseRoundsPerPr: 3,
    codeReviewRoundsPerUnit: 5,
    sliceMaxLines: 700,
    sliceMaxFiles: 10,
  },
};
const PASSING_VERDICT = { verdict: 'pass', findings: [], rebuts: [] };

// One shim stands in for the engine on PATH. It appends its own argv to a log
// so the gate can assert what each role actually launched, then prints the
// stream-json `result` event the role expects.
function writeEngineShim(scratch, argvLog) {
  const shimDirectory = join(scratch, 'engine-shims');
  mkdirSync(shimDirectory, { recursive: true });
  const shimPath = join(shimDirectory, 'claude');
  const verdict = JSON.stringify({
    type: 'result',
    subtype: 'success',
    structured_output: PASSING_VERDICT,
  });
  const text = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'fixture writer completed the slice',
  });
  writeFileSync(shimPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
    'cat > /dev/null',
    'case "$*" in',
    `  *--json-schema*) printf '%s\\n' ${JSON.stringify(verdict)} ;;`,
    `  *) printf '%s\\n' ${JSON.stringify(text)} ;;`,
    'esac',
    '',
  ].join('\n'));
  chmodSync(shimPath, 0o755);
  return shimDirectory;
}

// `shimDirectory` is null in real-engine mode, which leaves PATH alone so the
// dispatch resolves the host's actual engine CLI.
function smokeEnvironment(ghConfigDir, shimDirectory) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
      && !STRIPPED_ENV_KEYS.includes(key)),
  );
  environment.GH_CONFIG_DIR = ghConfigDir;
  if (shimDirectory !== null) {
    environment.PATH = [shimDirectory, environment.PATH ?? '']
      .filter(Boolean)
      .join(':');
  }
  return environment;
}

function bounded(text, limit = 600) {
  const value = String(text ?? '').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: `
      + bounded(result.error?.message ?? result.stderr),
    );
  }
  return String(result.stdout ?? '').trim();
}

function runTool(name, args, { root, environment, input, stepTimeoutMs }) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    input,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    timeout: stepTimeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    return { ok: false, detail: `${name}: ${result.error.message}` };
  }
  return {
    ok: true,
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function runToolJson(name, args, options) {
  const result = runTool(name, args, options);
  if (!result.ok) return result;
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {}
  if (parsed === null || typeof parsed !== 'object') {
    return {
      ok: false,
      detail: `${name}: exit ${result.status}; stdout ${bounded(result.stdout)}; `
        + `stderr ${bounded(result.stderr)}`,
    };
  }
  return { ok: true, status: result.status, value: parsed };
}

function writeFixtureState(root) {
  const statePath = join(root, 'docs', 'agentic', 'STATE.md');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, [
    '# STATE — autoloop loop-smoke fixture',
    '',
    'Scratch fixture repository for the no-model end-to-end loop smoke.',
    '',
    '```json autoloop-config',
    JSON.stringify(FIXTURE_CONFIG, null, 2),
    '```',
    '',
  ].join('\n'));
}

// Vendors the tool set the way an installed repository carries it. From the
// plugin checkout (templates/tools) this is scaffold's own reconciliation —
// the exact layout logic Setup uses, auto-merge rename included. From an
// installed copy (tools/agentic) the sibling tools already carry their
// installed names, so they are copied directly.
async function vendorFixtureTools(root) {
  const templatesDirectory = dirname(TOOL_DIRECTORY);
  if (existsSync(join(templatesDirectory, 'STATE.template.md'))) {
    const { reconcile } = await import('./scaffold.mjs');
    reconcile(root, templatesDirectory);
    return 'scaffold-reconcile';
  }
  const toolsTarget = join(root, 'tools', 'agentic');
  mkdirSync(toolsTarget, { recursive: true });
  for (const name of [
    ...UNIVERSAL_TOOL_FILES,
    'session-preflight.sh',
    'self-test-manifest.json',
  ]) {
    const source = join(TOOL_DIRECTORY, name);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(toolsTarget, name));
    if (name.endsWith('.sh')) chmodSync(join(toolsTarget, name), 0o755);
  }
  return 'installed-sibling-copy';
}

async function buildFixtureRepository(scratch) {
  const root = join(scratch, 'repo');
  mkdirSync(root, { recursive: true });
  runGit(root, ['init', '--quiet', root]);
  runGit(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  runGit(root, ['remote', 'add', 'origin', FIXTURE_ORIGIN_URL]);
  writeFixtureState(root);
  const ciPolicyPath = join(root, '.autoloop', 'ci-policy.json');
  mkdirSync(dirname(ciPolicyPath), { recursive: true });
  writeFileSync(
    ciPolicyPath,
    `${JSON.stringify({ schemaVersion: 1, requiredChecks: [] }, null, 2)}\n`,
  );
  const vendoring = await vendorFixtureTools(root);
  runGit(root, ['add', '--all']);
  runGit(root, [
    '-c', 'user.name=autoloop-smoke',
    '-c', 'user.email=autoloop-smoke@localhost',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'chore: loop smoke fixture',
  ]);
  return { root: realpathSync(root), vendoring };
}

// The mechanical steps of a live /autoloop:dev session, each a separate child
// process against the fixture repository.
export function runSmokeSteps({
  root,
  environment,
  argvLog,
  stepTimeoutMs = STEP_TIMEOUT_MS,
  roles = ['plan-review', 'implement', 'code-review'],
}) {
  const steps = [];
  const timed = (name, execute) => {
    const startedAt = Date.now();
    const result = execute();
    steps.push({ ...result, name, ms: Date.now() - startedAt });
    return result.ok;
  };
  const tool = (name) => join(root, 'tools', 'agentic', name);
  const outcome = { steps, runMarker: null, dispatches: [] };

  const primed = timed('prime', () => {
    const result = runToolJson(
      'prime.mjs --json',
      [tool('prime.mjs'), '--json'],
      { root, environment, stepTimeoutMs },
    );
    if (!result.ok) return result;
    const value = result.value;
    if (result.status !== 0 || value.ok !== true) {
      return { ok: false, detail: `prime failed: ${bounded(JSON.stringify(value))}` };
    }
    const sections = Object.values(value.sections ?? {});
    let persistedKind = null;
    try {
      persistedKind = JSON.parse(readFileSync(value.snapshotPath, 'utf8')).kind;
    } catch {}
    const shapeErrors = [
      persistedKind !== 'autoloop-repository-snapshot'
        && 'persisted snapshot file is absent or not a repository snapshot',
      sections.length === 0 && 'summary has no snapshot sections',
      value.config?.version !== FIXTURE_CONFIG.version
        && `config.version is ${bounded(String(value.config?.version))}`,
      value.base?.onBase !== true && 'base facts do not report the configured base',
      value.checkout?.clean !== true && 'fixture checkout is not clean',
      (typeof value.runMarker !== 'string' || !existsSync(value.runMarker))
        && 'run marker was not written',
      !Number.isInteger(value.timings?.scanMs) && 'prime reported no scan timing',
    ].filter(Boolean);
    if (shapeErrors.length > 0) {
      return {
        ok: false,
        detail: `prime summary shape is invalid: ${shapeErrors.join('; ')}`,
      };
    }
    outcome.runMarker = value.runMarker;
    const complete = sections.filter((section) => section.complete === true);
    return {
      ok: true,
      detail: `scan ${value.timings.scanMs}ms; sections `
        + `${complete.length}/${sections.length} complete `
        + '(offline scan degrades typed-incomplete)',
    };
  });
  if (!primed) return outcome;

  for (const role of roles) {
    const promptPath = join(root, `.git/autoloop/${role}-prompt.md`);
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, `loop-smoke fixture prompt for ${role}\n`);
    const dispatched = timed(`dispatch:${role}`, () => {
      const result = runToolJson(
        `dispatch.mjs --role ${role}`,
        [
          tool('dispatch.mjs'),
          '--role', role,
          '--prompt-file', promptPath,
          '--output-file', join(root, `.git/autoloop/${role}-result.json`),
          '--json',
        ],
        { root, environment, stepTimeoutMs },
      );
      if (!result.ok) return result;
      const value = result.value;
      if (result.status !== 0 || value.ok !== true) {
        return {
          ok: false,
          detail: `dispatch failed: ${bounded(JSON.stringify(value))}`,
        };
      }
      const expectsVerdict = role !== 'implement';
      const shapeErrors = [
        value.role !== role && `result role is ${bounded(String(value.role))}`,
        expectsVerdict && value.verdict?.verdict !== 'pass'
          && 'review dispatch returned no parsed verdict',
        !expectsVerdict && typeof value.text !== 'string'
          && 'writer dispatch returned no terminal text',
        !Number.isInteger(value.startupMs) && 'dispatch reported no wrapper overhead',
      ].filter(Boolean);
      if (shapeErrors.length > 0) {
        return { ok: false, detail: shapeErrors.join('; ') };
      }
      outcome.dispatches.push({
        role,
        tools: value.tools,
        startupMs: value.startupMs,
        ms: value.ms,
      });
      return {
        ok: true,
        detail: `${value.tools.join(',')} · ${value.ms}ms `
          + `(${value.startupMs}ms wrapper overhead)`,
      };
    });
    if (!dispatched) return outcome;
  }

  timed('posture-audit', () => {
    let launched;
    try {
      launched = readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean);
    } catch (error) {
      return { ok: false, detail: `engine argv log unreadable: ${error.message}` };
    }
    if (launched.length !== roles.length) {
      return {
        ok: false,
        detail: `expected ${roles.length} engine launches, saw ${launched.length}`,
      };
    }
    const reviewerLaunches = launched.filter((line) =>
      line.includes('--permission-mode plan'));
    const offending = reviewerLaunches.filter((line) =>
      /--tools \S*(?:Write|Edit|Bash)/.test(line));
    if (reviewerLaunches.length !== roles.filter((r) => r !== 'implement').length) {
      return { ok: false, detail: 'a reviewer role did not launch in plan mode' };
    }
    if (offending.length > 0) {
      return { ok: false, detail: 'a reviewer dispatch received a write tool' };
    }
    return {
      ok: true,
      detail: `${reviewerLaunches.length} reviewer launch(es), none with a write tool`,
    };
  });

  timed('gate', () => {
    const result = spawnSync('sh', ['-c', FIXTURE_CONFIG.gate.command], {
      cwd: root,
      encoding: 'utf8',
      env: environment,
      timeout: stepTimeoutMs,
      windowsHide: true,
    });
    return result.status === 0
      ? { ok: true, detail: `configured gate \`${FIXTURE_CONFIG.gate.command}\` green` }
      : { ok: false, detail: `gate exited ${result.status}` };
  });

  timed('guardrail-close', () => {
    const guard = tool('command-guard.mjs');
    const guardOptions = {
      root,
      environment,
      stepTimeoutMs,
      input: JSON.stringify({ tool_input: { command: 'gh pr merge 9 --squash' } }),
    };
    const blocked = runTool(
      'command-guard.mjs (run open)',
      [guard, '--config', join(root, 'docs', 'agentic', 'STATE.md')],
      guardOptions,
    );
    if (!blocked.ok) return blocked;
    if (blocked.status !== 2) {
      return {
        ok: false,
        detail: `guard exited ${blocked.status} while the run was open, expected 2`,
      };
    }
    rmSync(outcome.runMarker, { force: true });
    const standDown = runTool(
      'command-guard.mjs (run closed)',
      [guard, '--config', join(root, 'docs', 'agentic', 'STATE.md')],
      guardOptions,
    );
    if (!standDown.ok) return standDown;
    if (standDown.status !== 0) {
      return {
        ok: false,
        detail: `guard exited ${standDown.status} after the run closed, expected 0`,
      };
    }
    return { ok: true, detail: 'merge blocked while open; guard stands down when closed' };
  });

  return outcome;
}

async function selfTest({ realEngine = false } = {}) {
  const startedAt = Date.now();
  const budgetMs = realEngine ? REAL_ENGINE_BUDGET_MS : SMOKE_BUDGET_MS;
  const stepTimeoutMs = realEngine
    ? REAL_ENGINE_STEP_TIMEOUT_MS
    : STEP_TIMEOUT_MS;
  const phases = [];
  const timedPhase = async (name, execute) => {
    const phaseStart = Date.now();
    const result = await execute();
    phases.push({
      name,
      ms: Date.now() - phaseStart,
      ok: result.ok,
      detail: result.detail ?? '',
    });
    return result;
  };

  const mode = realEngine ? 'real-engine (one live dispatch)' : 'shimmed engine';
  const scratch = mkdtempSync(join(tmpdir(), 'autoloop-loop-smoke-'));
  let allOk = false;
  try {
    const ghConfigDir = join(scratch, 'gh-config');
    mkdirSync(ghConfigDir, { recursive: true });
    const argvLog = join(scratch, 'engine-argv.log');
    writeFileSync(argvLog, '');
    // Real-engine mode is defined by the ABSENCE of the shim: the dispatch has
    // to resolve and run the host's actual engine CLI.
    const environment = smokeEnvironment(
      ghConfigDir,
      realEngine ? null : writeEngineShim(scratch, argvLog),
    );

    let fixture = null;
    const setup = await timedPhase('fixture-setup', async () => {
      try {
        fixture = await buildFixtureRepository(scratch);
        return { ok: true, detail: `layout via ${fixture.vendoring}` };
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    });

    let outcome = null;
    if (setup.ok) {
      outcome = runSmokeSteps({
        root: fixture.root,
        environment,
        argvLog,
        stepTimeoutMs,
        // The real-engine mode spends money, so it proves exactly one thing:
        // that a dispatch reaches a model and returns a parseable verdict.
        roles: realEngine ? ['code-review'] : undefined,
      });
      for (const step of outcome.steps) {
        phases.push({
          name: step.name,
          ms: step.ms ?? 0,
          ok: step.ok,
          detail: step.detail ?? '',
        });
      }
    }

    const totalMs = Date.now() - startedAt;
    const withinBudget = totalMs < budgetMs;
    allOk = phases.every((phase) => phase.ok) && withinBudget;

    console.log(`loop smoke · ${mode}`);
    console.log('phase              ms      result');
    for (const phase of phases) {
      const status = phase.ok ? 'ok' : 'FAIL';
      console.log(
        `${phase.name.padEnd(19)}${String(phase.ms).padStart(6)}  ${status}`
        + `${phase.detail ? `  ${phase.detail}` : ''}`,
      );
    }
    console.log(
      `${'total'.padEnd(19)}${String(totalMs).padStart(6)}  `
      + `${withinBudget ? 'ok' : 'FAIL'}  budget ${budgetMs}ms`,
    );
    const overhead = (outcome?.dispatches ?? [])
      .map(({ role, startupMs }) => `${role} ${startupMs}ms`)
      .join(' · ');
    if (overhead) console.log(`dispatch wrapper overhead: ${overhead}`);
    return allOk;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url))
      === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') {
    const passed = await selfTest();
    console.log(passed ? 'self-test OK (loop smoke)' : 'self-test FAILED');
    process.exit(passed ? 0 : 1);
  } else if (
    process.argv.length === 3
    && process.argv[2] === '--real-engine-smoke'
  ) {
    // Manual pre-release check. Never wired into `--self-test`, `verify.mjs`,
    // or CI: it spends real model budget.
    const passed = await selfTest({ realEngine: true });
    console.log(
      passed
        ? 'real-engine smoke OK (one live dispatch returned a typed verdict)'
        : 'real-engine smoke FAILED',
    );
    process.exit(passed ? 0 : 1);
  } else {
    console.error('loop-smoke: expected --self-test or --real-engine-smoke');
    process.exit(2);
  }
}
