#!/usr/bin/env node

// No-model end-to-end loop smoke: the release gate that proves the mechanical
// spine of a live /autoloop:dev session against a scratch fixture repository,
// with the REAL tool chain and the REAL detached authority broker — and no
// model, no network, and no gh authentication.
//
// A live Dev session failed every `run-scope.mjs --probe-json` with
// INVALID_CAPABILITY_ATTESTATION: the detached broker re-parents to init once
// its spawner exits, so a fresh host-ancestry walk inside the broker finds no
// host. Self-tests never crossed that seam because CONTRACT_SELF_TEST_MODE
// skips the live-host comparison and the in-process broker fixtures keep the
// spawner alive. This smoke crosses exactly that seam: every step is a separate
// child process, the broker is the real detached one, and the probe runs after
// the broker's spawner has exited.
//
// Sequence (identical to a live session's mechanical path):
//   1. `intent-contract.mjs --capture-hook-json` seals a synthetic
//      UserPromptSubmit `/autoloop:dev` event (the supported hook transport).
//   2. `prime.mjs --dev-json` attests, opens, binds measurement, and runs the
//      measured startup scan. The fixture origin is a fake GitHub slug and the
//      children run with an empty GH_CONFIG_DIR and no token variables, so
//      every `gh` call fails immediately without network and scan degrades to
//      a complete snapshot whose sections are typed-incomplete — which prime
//      accepts (completeness fallbacks stay with the caller).
//   3. `run-scope.mjs --probe-json` with the prime summary's hostEvidence +
//      run + the run's requested native route. The result must be a typed
//      capability snapshot either way: available facts where the box has the
//      isolation toolchain, typed-unavailable facts where it does not. The
//      attestation error is the regression this gate exists to catch.
//   4. `run-scope.mjs --finish-json` guardrail stop, which retires the broker
//      session and shuts the broker down through its terminal protocol.
//
// Host ancestry: the hook capture binds intent to the host process ancestry it
// observes, and the broker re-verifies that binding when it consumes the
// record, so capture and prime MUST run under the same host ancestry. Under a
// live host (claude/codex/opencode ancestor) the steps run as direct children
// of this process and bind to that live host. Without one (CI), the steps run
// inside a `--smoke-host` child named `claude` through argv0 — the same
// fixture-host technique run-scope's own detached-broker self-tests use — so
// every step child observes exactly one host ancestor.
//
// `--real-engine-smoke` is the OTHER mode, and the opposite trade: it runs the
// same four steps WITHOUT the engine shims, so the route capability probe
// dispatches real writer and reviewer postures against a real authenticated
// engine, and then asserts every `claude.native` capability came back available.
// It is the pre-release gate for `posture: isolated` — the only mode that proves
// an engine can actually be dispatched inside the authority sandbox, which no
// shimmed run can show.
//
// It is deliberately NOT part of `--self-test` and NOT part of CI: it costs real
// model spend (roughly $0.25 per run), needs an authenticated engine CLI, and
// needs a working `/usr/bin/bwrap`. Run it by hand before a release.
//
// Usage:
//   node tools/agentic/loop-smoke.mjs --self-test
//   node tools/agentic/loop-smoke.mjs --real-engine-smoke   # manual, costs money

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHostProcessBinding } from './route-adapter-contract.mjs';
import { UNIVERSAL_TOOL_FILES } from './verify.mjs';

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SMOKE_BUDGET_MS = 60_000;
const STEP_TIMEOUT_MS = 55_000;
// Real engine dispatches are model round trips, not mechanics. The route probe
// runs a writer and a reviewer posture back to back, each capped at 20 minutes
// inside route-adapter-contract; observed end to end on a warm box is well under
// two minutes, and this budget leaves room for a slow model without hanging a
// release check indefinitely.
const REAL_ENGINE_BUDGET_MS = 15 * 60_000;
const REAL_ENGINE_STEP_TIMEOUT_MS = 14 * 60_000;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const FIXTURE_ORIGIN_URL = 'https://github.com/autoloop-smoke/fixture.git';
const FIXTURE_PROMPT = '/autoloop:dev';
// Ambient credentials and host-repo Git state must not leak into the fixture:
// the smoke's contract is deterministic offline behavior.
const STRIPPED_ENV_PREFIXES = ['GIT_', 'AUTOLOOP_AUTHORITY_'];
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
  version: '0.25.0',
  baseBranch: 'main',
  gate: { command: 'true', quickCommand: null, setupCommand: null },
  merge: { policy: 'manual' },
  // Live installs default to capture off; the smoke opts into 'events' so the
  // release gate exercises the FULL ledger path (bind, stage, measured scan).
  measurement: { capture: 'events' },
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

function brokerDirectory() {
  const parent = ['darwin', 'linux'].includes(process.platform)
    ? realpathSync('/tmp')
    : realpathSync(tmpdir());
  return join(
    parent,
    `autoloop-broker-${typeof process.getuid === 'function'
      ? process.getuid()
      : 'user'}`,
  );
}

// The live probe executes real engine capability postures (model dispatches
// with 20-minute caps) whenever the box has a working engine CLI. The smoke's
// contract is no model and no network, so the fixture presents an engine-less
// box: PATH-first shims make every engine CLI version preflight fail
// immediately, and the probe returns its fast typed snapshot with
// typed-unavailable capabilities — the exact shape an unprovisioned box
// reports. The regression this gate catches (INVALID_CAPABILITY_ATTESTATION
// from the detached broker) fires before any capability observation, so the
// shimmed preflight loses no coverage of it.
function writeEngineShims(scratch) {
  const shimDirectory = join(scratch, 'engine-shims');
  mkdirSync(shimDirectory, { recursive: true });
  for (const engine of ['claude', 'codex', 'opencode']) {
    const shimPath = join(shimDirectory, engine);
    writeFileSync(shimPath, '#!/bin/sh\nexit 127\n');
    chmodSync(shimPath, 0o755);
  }
  return shimDirectory;
}

// `shimDirectory` is null in real-engine mode, which leaves PATH alone so the
// probe resolves the host's actual engine CLI.
function smokeEnvironment(ghConfigDir, shimDirectory) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
      && !STRIPPED_ENV_KEYS.includes(key)),
  );
  environment.GH_CONFIG_DIR = ghConfigDir;
  environment.PATH = [shimDirectory, environment.PATH ?? '']
    .filter(Boolean)
    .join(':');
  return environment;
}

function bounded(text, limit = 600) {
  const value = String(text ?? '').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function failStep(name, detail) {
  return { name, ok: false, detail };
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

function runToolJson(
  name,
  args,
  { root, environment, input, stepTimeoutMs = STEP_TIMEOUT_MS },
) {
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
// installed names, so they are copied directly, plus the repository's
// installed opencode plugin.
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
  const installedPlugin = join(
    dirname(dirname(TOOL_DIRECTORY)),
    '.opencode',
    'plugins',
    'autoloop.js',
  );
  if (existsSync(installedPlugin)) {
    const pluginTarget = join(root, '.opencode', 'plugins', 'autoloop.js');
    mkdirSync(dirname(pluginTarget), { recursive: true });
    copyFileSync(installedPlugin, pluginTarget);
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

// The four mechanical steps of a live /autoloop:dev session, each a separate
// child process against the fixture repository. Runs either directly under a
// live host ancestry or inside the `--smoke-host` fixture host.
export function runSmokeSteps({
  root,
  host,
  sessionId,
  environment,
  stepTimeoutMs = STEP_TIMEOUT_MS,
}) {
  const steps = [];
  const timed = (name, execute) => {
    const startedAt = Date.now();
    const result = execute();
    steps.push({ ...result, name, ms: Date.now() - startedAt });
    return result.ok;
  };
  const tool = (name) => join(root, 'tools', 'agentic', name);
  const outcome = { steps, sessionFingerprint: null, probe: null };

  const captured = timed('capture-hook', () => {
    const event = {
      hook_event_name: host === 'opencode'
        ? 'opencode.user-prompt'
        : 'UserPromptSubmit',
      session_id: sessionId,
      turn_id: `turn-${randomUUID()}`,
      cwd: root,
      prompt: FIXTURE_PROMPT,
    };
    const result = runToolJson(
      'intent-contract.mjs --capture-hook-json',
      [tool('intent-contract.mjs'), '--capture-hook-json'],
      { root, environment, stepTimeoutMs, input: `${JSON.stringify(event)}\n` },
    );
    if (!result.ok) return result;
    if (result.status !== 0 || result.value.captured !== true) {
      return {
        ok: false,
        detail: `hook capture refused: ${bounded(JSON.stringify(result.value))}`,
      };
    }
    return { ok: true, detail: 'intent sealed' };
  });
  if (!captured) return outcome;

  let summary = null;
  const primed = timed('prime-dev', () => {
    const result = runToolJson(
      'prime.mjs --dev-json',
      [tool('prime.mjs'), '--dev-json', '-'],
      { root, environment, stepTimeoutMs, input: JSON.stringify({ sessionId }) },
    );
    if (!result.ok) return result;
    const value = result.value;
    if (result.status !== 0 || value.ok !== true) {
      return {
        ok: false,
        detail: `prime failed: ${bounded(JSON.stringify(value))}`,
      };
    }
    // The CLI prints the decision-sized summary: the full snapshot lives in
    // the persisted snapshot file and stdout carries the per-section summary
    // plus the durable paths.
    const sections = Object.values(value.sections ?? {});
    const eventPath = value.scan?.eventPath;
    let persistedSnapshotKind = null;
    try {
      persistedSnapshotKind =
        JSON.parse(readFileSync(value.snapshotPath, 'utf8')).kind;
    } catch {}
    const shapeErrors = [
      persistedSnapshotKind !== 'autoloop-repository-snapshot'
        && 'persisted snapshot file is absent or not a repository snapshot',
      sections.length === 0 && 'summary has no snapshot sections',
      (typeof value.bundlePath !== 'string' || !existsSync(value.bundlePath))
        && 'persisted prime bundle is absent',
      (typeof eventPath !== 'string' || !existsSync(eventPath))
        && 'retained scan event file is absent',
      value.run?.requestedRoute !== `${host}.native`
        && `run.requestedRoute is ${bounded(String(value.run?.requestedRoute))}, `
          + `expected ${host}.native`,
    ].filter(Boolean);
    if (shapeErrors.length > 0) {
      return {
        ok: false,
        detail: `prime summary shape is invalid: ${shapeErrors.join('; ')}`,
      };
    }
    summary = value;
    outcome.sessionFingerprint = value.run.sessionFingerprint ?? null;
    const complete = sections.filter((section) => section.complete === true);
    return {
      ok: true,
      detail: `run open; snapshot sections ${complete.length}/${sections.length} `
        + 'complete (offline scan degrades typed-incomplete)',
    };
  });
  if (!primed) return outcome;

  const probed = timed('probe-routes', () => {
    const result = runToolJson(
      'run-scope.mjs --probe-json',
      [tool('run-scope.mjs'), '--probe-json', '-'],
      {
        root,
        environment,
        stepTimeoutMs,
        input: JSON.stringify({
          hostEvidence: summary.hostEvidence,
          run: summary.run,
          routes: [summary.run.requestedRoute],
          cwd: root,
        }),
      },
    );
    if (!result.ok) return result;
    const value = result.value;
    if (
      result.status !== 0
      || value.ok !== true
      || value.value?.kind !== 'autoloop-capability-snapshot'
      || typeof value.value.facts !== 'object'
    ) {
      return {
        ok: false,
        detail: `probe did not return a typed capability snapshot: ${
          bounded(JSON.stringify(value))}`,
      };
    }
    const facts = value.value.facts;
    const available = Object.values(facts).filter(Boolean).length;
    outcome.probe = { facts };
    return {
      ok: true,
      detail: `typed snapshot: ${available}/${Object.keys(facts).length} `
        + 'capabilities available',
    };
  });
  if (!probed) return outcome;

  timed('finish-guardrail', () => {
    const result = runToolJson(
      'run-scope.mjs --finish-json',
      [tool('run-scope.mjs'), '--finish-json', '-'],
      {
        root,
        environment,
        stepTimeoutMs,
        input: JSON.stringify({
          run: summary.run,
          progress: {
            reason: 'guardrail-failure',
            unitsCompleted: 0,
            queueEvidence: null,
          },
        }),
      },
    );
    if (!result.ok) return result;
    if (result.status !== 0 || result.value.ok !== true) {
      return {
        ok: false,
        detail: `finish failed: ${bounded(JSON.stringify(result.value))}`,
      };
    }
    if (result.value.value?.action !== 'stop') {
      return {
        ok: false,
        detail: `guardrail finish returned action ${
          bounded(String(result.value.value?.action))}, expected stop`,
      };
    }
    return { ok: true, detail: 'run closed; broker session retired' };
  });
  return outcome;
}

function runFixtureHostSteps(context, scratch, budgetMs = SMOKE_BUDGET_MS) {
  const contextPath = join(scratch, 'smoke-host-context.json');
  writeFileSync(contextPath, JSON.stringify(context));
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--smoke-host', contextPath],
    {
      argv0: 'claude',
      cwd: context.root,
      encoding: 'utf8',
      env: context.environment,
      maxBuffer: MAX_CHILD_OUTPUT_BYTES,
      timeout: budgetMs,
      windowsHide: true,
    },
  );
  if (result.error) {
    return {
      steps: [failStep('smoke-host', `fixture host: ${result.error.message}`)],
      sessionFingerprint: null,
      probe: null,
    };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      steps: [failStep(
        'smoke-host',
        `fixture host exit ${result.status}; stdout ${bounded(result.stdout)}; `
        + `stderr ${bounded(result.stderr)}`,
      )],
      sessionFingerprint: null,
      probe: null,
    };
  }
}

function expectedSessionFingerprint(host, sessionId) {
  return createHash('sha256')
    .update(JSON.stringify({
      activeHost: host,
      integration: `${host}.user-prompt-hook`,
      sessionId,
    }))
    .digest('hex');
}

// One broker per host session is the authority model, so the smoke cannot run
// inside a session whose broker is already live (a mid-run verify). That is a
// structural exclusion, not a failure: report it and pass. Hostless CI — the
// environment this gate exists for — never has a live broker and never skips.
function liveBrokerOwnsHostSession(binding) {
  try {
    const leasePath = join(
      brokerDirectory(),
      `host-${binding.fingerprint}.lease`,
    );
    if (!existsSync(leasePath)) return false;
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
    const commandLine = processCommandLine(lease.pid);
    return commandLine.includes('--authority-broker')
      && commandLine.some((part) => basename(part) === 'run-scope.mjs');
  } catch {
    return false;
  }
}

function processCommandLine(pid) {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    }
    const result = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return result.status === 0 ? String(result.stdout).trim().split(/\s+/) : [];
  } catch {
    return [];
  }
}

// The finish step's terminal stop is the designed broker teardown. This is the
// belt-and-suspenders path for failed runs: terminate exactly a process that
// still holds this smoke session's registry AND presents the authority-broker
// command line for that registry's socket.
function terminateLeakedBroker(sessionFingerprint) {
  const registryPath = join(brokerDirectory(), `${sessionFingerprint}.json`);
  try {
    if (!existsSync(registryPath)) return;
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const commandLine = processCommandLine(registry.pid);
    if (
      !commandLine.includes('--authority-broker')
      || !commandLine.includes(registry.socketPath)
      || !commandLine.some((part) => basename(part) === 'run-scope.mjs')
    ) {
      return;
    }
    process.kill(registry.pid, 'SIGTERM');
    const gate = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!existsSync(registryPath)) return;
      Atomics.wait(gate, 0, 0, 100);
    }
  } catch {}
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

  const liveBinding = detectHostProcessBinding();
  if (liveBinding !== null && liveBrokerOwnsHostSession(liveBinding)) {
    console.log(
      'loop smoke · skipped: a live authority broker already owns this host '
      + 'session (one broker per session by design); run the smoke from a '
      + 'session without an active run',
    );
    return true;
  }
  const host = liveBinding?.host ?? 'claude';
  const hostMode = liveBinding === null
    ? 'fixture-host (argv0 claude)'
    : `live-host (${host})`;
  const mode = realEngine
    ? `real-engine · ${hostMode}`
    : hostMode;
  // The real-engine gate exists to prove a real dispatch inside the authority
  // sandbox. Preconditions it cannot substitute for are a hard failure, not a
  // skip: a silent pass here would be exactly the false negative this mode was
  // added to eliminate.
  if (realEngine) {
    const missing = [
      !existsSync('/usr/bin/bwrap') && '/usr/bin/bwrap is absent',
      process.platform !== 'linux'
        && `platform ${process.platform} has no process-authority sandbox`,
    ].filter(Boolean);
    if (missing.length > 0) {
      console.error(`real-engine smoke cannot run: ${missing.join('; ')}`);
      return false;
    }
  }
  const sessionId = `loop-smoke-${randomUUID()}`;
  const scratch = mkdtempSync(join(tmpdir(), 'autoloop-loop-smoke-'));
  const sessionFingerprints = new Set([
    expectedSessionFingerprint(host, sessionId),
  ]);
  let allOk = false;
  try {
    const ghConfigDir = join(scratch, 'gh-config');
    mkdirSync(ghConfigDir, { recursive: true });
    // Real-engine mode is defined by the ABSENCE of the shims: the probe has to
    // resolve and dispatch the host's actual engine CLI.
    const environment = smokeEnvironment(
      ghConfigDir,
      realEngine ? null : writeEngineShims(scratch),
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

    if (setup.ok) {
      const context = {
        root: fixture.root,
        host,
        sessionId,
        environment,
        stepTimeoutMs,
      };
      const outcome = liveBinding === null
        ? runFixtureHostSteps(context, scratch, budgetMs)
        : runSmokeSteps(context);
      for (const step of outcome.steps) {
        phases.push({
          name: step.name,
          ms: step.ms ?? 0,
          ok: step.ok,
          detail: step.detail ?? '',
        });
      }
      if (typeof outcome.sessionFingerprint === 'string') {
        sessionFingerprints.add(outcome.sessionFingerprint);
      }
      // The assertion the shimmed smoke structurally cannot make: a shimmed
      // probe reports typed-unavailable facts and passes. Here every capability
      // the route declares must be observed available, or the isolated posture
      // cannot dispatch this engine.
      if (realEngine) {
        await timedPhase('real-engine-capabilities', async () => {
          const facts = outcome.probe?.facts ?? null;
          if (facts === null || Object.keys(facts).length === 0) {
            return { ok: false, detail: 'probe returned no capability facts' };
          }
          const unavailable = Object.entries(facts)
            .filter(([, available]) => available !== true)
            .map(([requirement]) => requirement);
          return unavailable.length === 0
            ? {
              ok: true,
              detail: `${Object.keys(facts).length}/${Object.keys(facts).length} `
                + `available for ${host}.native`,
            }
            : {
              ok: false,
              detail: `unavailable for ${host}.native: ${unavailable.join(', ')}`,
            };
        });
      }
    }

    await timedPhase('teardown', async () => {
      for (const fingerprint of sessionFingerprints) {
        terminateLeakedBroker(fingerprint);
      }
      return { ok: true, detail: 'broker registry clear' };
    });

    const totalMs = Date.now() - startedAt;
    const withinBudget = totalMs < budgetMs;
    allOk = phases.every((phase) => phase.ok) && withinBudget;

    console.log(`loop smoke · ${mode}`);
    console.log('phase             ms      result');
    for (const phase of phases) {
      const status = phase.ok ? 'ok' : 'FAIL';
      console.log(
        `${phase.name.padEnd(18)}${String(phase.ms).padStart(6)}  ${status}`
        + `${phase.detail ? `  ${phase.detail}` : ''}`,
      );
    }
    console.log(
      `${'total'.padEnd(18)}${String(totalMs).padStart(6)}  `
      + `${withinBudget ? 'ok' : 'FAIL'}  budget ${budgetMs}ms`,
    );
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
    // Manual pre-release gate for `posture: isolated`. Never wired into
    // `--self-test`, `verify.mjs`, or CI: it spends real model budget.
    const passed = await selfTest({ realEngine: true });
    console.log(
      passed
        ? 'real-engine smoke OK (isolated posture dispatches a live engine)'
        : 'real-engine smoke FAILED',
    );
    process.exit(passed ? 0 : 1);
  } else if (
    process.argv.length === 4
    && process.argv[2] === '--smoke-host'
  ) {
    // Internal fixture-host mode: this process stands in as the single host
    // ancestor (named through argv0) for the smoke's step children.
    const context = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    process.stdout.write(`${JSON.stringify(runSmokeSteps(context))}\n`);
  } else {
    console.error('loop-smoke: expected --self-test or --real-engine-smoke');
    process.exit(2);
  }
}
