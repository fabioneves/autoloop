#!/usr/bin/env node
// One-call Dev prime orchestrator.
//
// A live Dev run spent ~5.5 minutes hand-assembling the prime envelopes:
// discovering CLI shapes, composing attest/open inputs, reverse-engineering the
// bind-measurement declaration, and shaping stage-start/run-operation
// envelopes. Every one of those envelopes is mechanically derivable from the
// opened run plus ProjectConfig, so this tool derives them and drives the
// existing public CLI seams in order, stopping fail-closed at the first typed
// error:
//
//   1. run-scope.mjs --attest-host-json   {sessionId}
//   2. run-scope.mjs --open-json          {hostEvidence}
//   3. run-scope.mjs --bind-measurement-json {run,measurement}   (persists run-start)
//   4. measurement-contract.mjs --capture-event                  (selection stage-start)
//   5. measurement-contract.mjs --run-operation                  (measured startup scan)
//
// It shells out to the sibling tools exactly as the orchestrating model does
// today, so the broker authority model is unchanged: this tool has exactly the
// same standing as the model issuing the same commands, and it never imports
// broker internals. Continuations are not supported here — a continuation field
// in the input is a typed error directing the caller to the manual per-op path.
//
// --conclude-json is the matching one-call close for a guardrail-blocked run.
// A live Dev run spent minutes hand-assembling the same fixed sequence every
// time a human handoff ended the run's useful work: optional human
// wait-start/wait-end, the orchestrator-owned stage-end with typed-unavailable
// telemetry, the blocked run-finish with typed-unavailable evidence, then the
// guardrail-failure finish. Every one of those envelopes is mechanically
// derivable from the retained store plus the caller's blocked reason, so this
// mode composes them and drives the same public CLI seams in order
// (measurement-contract.mjs --capture-event, run-scope.mjs --finish-json),
// stopping fail-closed at the first typed error. v1 closes exactly the
// guardrail-failure stop; every other stop reason keeps the manual path.
//
// Usage:
//   node tools/agentic/prime.mjs --dev-json <path|->   # {"sessionId":"..."} or
//                                                      # {"sessionId":"...","scanArgs":[...]}
//   node tools/agentic/prime.mjs --conclude-json <path|->
//     # {"run":{...},"hostEvidence":{...},"reason":"guardrail-failure",
//     #  "stageId":"...","blockedReason":{"code":"...","reason":"..."},
//     #  "waitCategory":"human"?}
//   node tools/agentic/prime.mjs --self-test

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractConfig, validateProjectConfig } from './config-contract.mjs';
import { writeStdoutSync } from './snapshot-contract.mjs';

// Bumped by every release together with the other version literals; the
// release verifier requires this literal to equal VERSION. The endpoint
// manifest declares the toolchain version that ran the checkpoint, and the
// vendored copy of this tool is that toolchain.
const AUTOLOOP_VERSION = '0.41.4';

const WORKLOAD = 'autoloop-dev-unit';
const WORKLOAD_UNIT = 'one loop-ready issue from selection to delivered pull request';
const CHECKPOINT = 'safe-system';
const SELECTION_STAGE_ID = 'selection-1';
const SCAN_OPERATION_ID = 'startup-scan';
const SNAPSHOT_SECTION_COUNT = 10;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_ARGS = 8;
const CONTINUATION_KEYS = Object.freeze([
  'continuation',
  'continuationLease',
  'continuationState',
  'continuationAuthorization',
]);
const CONCLUDE_REASON = 'guardrail-failure';
const CONCLUDE_KEYS = Object.freeze([
  'run',
  'hostEvidence',
  'reason',
  'stageId',
  'blockedReason',
]);
const CONCLUDE_OPTIONAL_KEYS = Object.freeze(['measurementRunId', 'waitCategory']);
const CONCLUDE_WAIT_CATEGORIES = Object.freeze(['engine', 'ci', 'human']);
const CONCLUDE_WAIT_ID = 'guardrail-handoff-1';
// Mirrors measurement-contract's segment telemetry keys; the self-test
// validates every composed event through that contract's own validators, so
// drift fails there instead of at capture time.
const CONCLUDE_TELEMETRY_KEYS = Object.freeze([
  'provider',
  'model',
  'engine',
  'promptTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningTokens',
  'contextBytes',
  'costUsd',
]);
const STAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_/-]{0,79}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RUN_SCOPE = join(TOOL_DIRECTORY, 'run-scope.mjs');
const MEASUREMENT_CONTRACT = join(TOOL_DIRECTORY, 'measurement-contract.mjs');
const SCAN_TOOL = join(TOOL_DIRECTORY, 'scan.mjs');
// Broker cold start plus attestation stays in seconds; the measured scan is
// dominated by GitHub reads and inherits measurement-contract's own 30-minute
// child cap, so the wrapper spawn gets that cap plus slack.
const BROKER_STEP_TIMEOUT_MS = 60_000;
const SCAN_STEP_TIMEOUT_MS = 35 * 60 * 1000;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function failure(step, error) {
  return { ok: false, step, error };
}

export function validatePrimeInput(value) {
  if (!plainObject(value)) {
    return failure('input', {
      code: 'INVALID_PRIME_INPUT',
      message: 'expected a JSON object with {sessionId} and optional {scanArgs}',
    });
  }
  const continuation = CONTINUATION_KEYS.find((key) => Object.hasOwn(value, key));
  if (continuation !== undefined) {
    return failure('input', {
      code: 'CONTINUATION_UNSUPPORTED',
      message:
        `prime opens new invocations only; "${continuation}" requires the manual `
        + 'per-op path (run-scope.mjs --attest-host-json / --open-json with the '
        + 'atomic continuation bundle)',
    });
  }
  const unknown = Object.keys(value).find(
    (key) => key !== 'sessionId' && key !== 'scanArgs',
  );
  if (unknown !== undefined) {
    return failure('input', {
      code: 'INVALID_PRIME_INPUT',
      message: `unknown input field "${unknown}"; expected only sessionId and scanArgs`,
    });
  }
  if (
    typeof value.sessionId !== 'string'
    || value.sessionId.length < 1
    || value.sessionId.length > 256
    || /[\x00-\x1f\x7f]/.test(value.sessionId)
  ) {
    return failure('input', {
      code: 'INVALID_PRIME_INPUT',
      message: 'sessionId: expected a non-empty printable string of at most 256 bytes',
    });
  }
  const scanArgs = value.scanArgs ?? [];
  if (
    !Array.isArray(scanArgs)
    || scanArgs.length > MAX_SCAN_ARGS
    || scanArgs.some((argument) =>
      typeof argument !== 'string'
      || argument.length < 1
      || argument.length > 256
      || /[\x00-\x1f\x7f]/.test(argument))
  ) {
    return failure('input', {
      code: 'INVALID_PRIME_INPUT',
      message: `scanArgs: expected at most ${MAX_SCAN_ARGS} non-empty printable strings`,
    });
  }
  return { ok: true, sessionId: value.sessionId, scanArgs };
}

export function captureEnabled(config) {
  return config?.measurement?.capture === 'events';
}

export function repositorySlug(originUrl) {
  const match = /(?:^|[/:])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?\s*$/
    .exec(String(originUrl ?? ''));
  if (!match || match[1] === '.' || match[2] === '.') return null;
  return `${match[1]}/${match[2]}`;
}

// The declaration mirrors what the strict bind validator accepts: run UUID,
// workload/checkpoint identifiers, the SHA-256 of the exact retained bytes of
// one versioned workload manifest and one checkpoint-endpoint manifest, intent
// source/provenance, merge policy, and base-freshness strategy — and no
// capability, route, unit, lane, outage, repository, host, nonce, or authority
// fields. v0.41 enables exactly one non-manual base-freshness strategy
// (direct-strict), so the strategy is mechanical from the merge policy.
export function deriveMeasurementDeclaration({ config, run, repository, runId }) {
  const workloadManifest = JSON.stringify({
    version: 1,
    workload: WORKLOAD,
    repository,
    baseBranch: config.baseBranch,
    unit: WORKLOAD_UNIT,
    gateCommand: config.gate.command,
  });
  const endpointManifest = JSON.stringify({
    version: 1,
    checkpoint: CHECKPOINT,
    autoloopVersion: AUTOLOOP_VERSION,
    configVersion: run.configVersion,
    baseBranch: run.configuredBaseBranch,
    host: run.activeHost,
  });
  return {
    workloadManifest,
    endpointManifest,
    declaration: {
      version: 1,
      runId,
      workload: WORKLOAD,
      checkpoint: CHECKPOINT,
      comparisonContextFingerprint: sha256Hex(workloadManifest),
      checkpointEndpointFingerprint: sha256Hex(endpointManifest),
      intentSource: run.generation > 0 ? 'relaunch' : 'invocation',
      intentProvenance: run.intentProvenance,
      mergePolicy: config.merge.policy,
      baseFreshnessStrategy:
        config.merge.policy === 'manual' ? 'manual' : 'direct-strict',
    },
  };
}

export function verifySnapshotShape(snapshot) {
  if (!plainObject(snapshot) || snapshot.kind !== 'autoloop-repository-snapshot') {
    return ['snapshot: expected an autoloop-repository-snapshot object'];
  }
  if (!plainObject(snapshot.sections)) {
    return ['snapshot.sections: expected a section object'];
  }
  const errors = [];
  const names = Object.keys(snapshot.sections);
  if (names.length !== SNAPSHOT_SECTION_COUNT) {
    errors.push(
      `snapshot.sections: expected ${SNAPSHOT_SECTION_COUNT} sections, got ${names.length}`,
    );
  }
  for (const name of names) {
    const section = snapshot.sections[name];
    if (
      !plainObject(section)
      || Object.keys(section).sort().join(',') !== 'complete,error,items'
      || !Array.isArray(section.items)
      || typeof section.complete !== 'boolean'
      || (section.error !== null && !plainObject(section.error))
    ) {
      errors.push(`snapshot.sections.${name}: expected {items,complete,error}`);
    }
  }
  return errors;
}

function childFailure(step, label, result, typed) {
  return failure(step, {
    code: typeof typed?.error?.code === 'string'
      ? typed.error.code
      : 'CHILD_OPERATION_FAILED',
    message: result.status === 0
      ? `${label} produced no parseable typed result`
      : `${label} exited ${result.status ?? `signal ${result.signal}`}`,
    exitCode: result.status,
    signal: result.signal,
    typed,
    stderr: String(result.stderr ?? ''),
  });
}

function runToolJson(step, label, args, { cwd, input, timeout }) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    timeout,
    windowsHide: true,
  });
  if (result.error) {
    return failure(step, {
      code: 'CHILD_SPAWN_FAILED',
      message: `${label}: ${result.error.message}`,
    });
  }
  let typed = null;
  try {
    const parsed = JSON.parse(result.stdout);
    if (plainObject(parsed)) typed = parsed;
  } catch {}
  if (result.status !== 0 || typed === null || typed.ok !== true) {
    return childFailure(step, label, result, typed);
  }
  return { ok: true, value: typed };
}

function gitValue(step, root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_INPUT_BYTES,
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return failure(step, {
      code: 'GIT_EVIDENCE_UNAVAILABLE',
      message: `git ${args.join(' ')} failed: `
        + `${result.error?.message ?? String(result.stderr ?? '').trim()}`,
    });
  }
  return { ok: true, value: result.stdout.trim() };
}

export function primeDev(rawInput, cwd = process.cwd()) {
  const input = validatePrimeInput(rawInput);
  if (input.ok !== true) return input;
  const rootResult = gitValue('repository', cwd, ['rev-parse', '--show-toplevel']);
  if (rootResult.ok !== true) return rootResult;
  const root = realpathSync(rootResult.value);
  const temporary = mkdtempSync(join(tmpdir(), 'autoloop-prime-'));
  try {
    const writeOpInput = (name, value) => {
      const path = join(temporary, name);
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      return path;
    };

    // 1. Attest: the broker consumes the one-use hook-captured transport
    // record; a prose-shaped invocation fails here within seconds by design.
    const attest = runToolJson(
      'attest-host',
      'run-scope.mjs --attest-host-json',
      [
        RUN_SCOPE,
        '--attest-host-json',
        writeOpInput('attest-host.json', { sessionId: input.sessionId }),
      ],
      { cwd: root, timeout: BROKER_STEP_TIMEOUT_MS },
    );
    if (attest.ok !== true) return attest;
    const hostEvidence = attest.value.value;

    // 2. Open with exactly {hostEvidence}; the broker hydrates the captured
    // routing preference and validated ProjectConfig itself.
    const open = runToolJson(
      'open',
      'run-scope.mjs --open-json',
      [RUN_SCOPE, '--open-json', writeOpInput('open.json', { hostEvidence })],
      { cwd: root, timeout: BROKER_STEP_TIMEOUT_MS },
    );
    if (open.ok !== true) return open;
    const run = open.value.value;

    // 3. Re-read the same STATE the broker validated and derive the
    // measurement declaration from it plus the issued run.
    let config;
    try {
      config = extractConfig(
        readFileSync(join(root, 'docs', 'agentic', 'STATE.md'), 'utf8'),
      );
    } catch (error) {
      return failure('project-config', {
        code: 'PROJECT_CONFIG_UNREADABLE',
        message: error.message,
      });
    }
    const configErrors = validateProjectConfig(config);
    if (configErrors.length > 0) {
      return failure('project-config', {
        code: 'PROJECT_CONFIG_INVALID',
        message: configErrors.join('; '),
      });
    }
    if (
      config.version !== run.configVersion
      || config.baseBranch !== run.configuredBaseBranch
    ) {
      return failure('project-config', {
        code: 'PROJECT_CONFIG_DRIFT',
        message: 'STATE ProjectConfig does not match the opened run; '
          + 'STATE changed between open and measurement derivation',
      });
    }
    const origin = gitValue('derive-measurement', root, [
      'remote',
      'get-url',
      'origin',
    ]);
    if (origin.ok !== true) return origin;
    const repository = repositorySlug(origin.value);
    if (repository === null) {
      return failure('derive-measurement', {
        code: 'REPOSITORY_IDENTITY_UNAVAILABLE',
        message: `origin remote "${origin.value}" has no owner/name form`,
      });
    }
    // Capture is opt-in until the pipeline's producers can finalize a record:
    // with measurement.capture absent or 'off', prime is attest -> open -> a
    // plain scan, and no ledger is opened at all.
    const capture = captureEnabled(config);
    if (!capture) {
      const plainScan = spawnSync(
        process.execPath,
        [SCAN_TOOL, ...input.scanArgs],
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: MAX_CHILD_OUTPUT_BYTES,
          timeout: SCAN_STEP_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      if (plainScan.error || plainScan.status !== 0) {
        return failure('scan', {
          code: 'SCAN_FAILED',
          message: plainScan.error?.message
            ?? `scan.mjs exited ${plainScan.status}: ${String(plainScan.stderr ?? '').slice(0, 400)}`,
        });
      }
      let snapshot;
      try {
        snapshot = JSON.parse(plainScan.stdout);
      } catch (error) {
        return failure('snapshot', {
          code: 'SNAPSHOT_PARSE_FAILED',
          message: `scan stdout is not JSON: ${error.message}`,
        });
      }
      const snapshotErrors = verifySnapshotShape(snapshot);
      if (snapshotErrors.length > 0) {
        return failure('snapshot', {
          code: 'SNAPSHOT_SECTIONS_INVALID',
          message: snapshotErrors.join('; '),
        });
      }
      return {
        ok: true,
        run,
        measurementRunId: null,
        hostEvidence,
        boundaries: null,
        scan: { operationId: null, eventPath: null },
        snapshot,
      };
    }
    const measurementRunId = randomUUID();
    const { declaration } = deriveMeasurementDeclaration({
      config,
      run,
      repository,
      runId: measurementRunId,
    });

    // 4. Bind: the broker validates the exact run it issued and persists the
    // run-start boundary itself.
    const bind = runToolJson(
      'bind-measurement',
      'run-scope.mjs --bind-measurement-json',
      [
        RUN_SCOPE,
        '--bind-measurement-json',
        writeOpInput('bind-measurement.json', { run, measurement: declaration }),
      ],
      { cwd: root, timeout: BROKER_STEP_TIMEOUT_MS },
    );
    if (bind.ok !== true) return bind;

    // 5. Retain the selection stage start (public boundary, empty envelopes).
    const stageStartInput = {
      version: 1,
      runId: declaration.runId,
      kind: 'stage-start',
      payload: { id: SELECTION_STAGE_ID, stage: 'selection', round: 1 },
      envelopes: {},
    };
    writeOpInput('event-selection-start.json', stageStartInput);
    const stageStart = runToolJson(
      'stage-start',
      'measurement-contract.mjs --capture-event',
      [MEASUREMENT_CONTRACT, '--capture-event'],
      {
        cwd: root,
        input: JSON.stringify(stageStartInput),
        timeout: BROKER_STEP_TIMEOUT_MS,
      },
    );
    if (stageStart.ok !== true) return stageStart;

    // 6. Run the startup scan as a measured operation and require every
    // snapshot section to parse; completeness fallbacks stay with the caller.
    const scanInput = {
      version: 1,
      runId: declaration.runId,
      stageId: SELECTION_STAGE_ID,
      operationId: SCAN_OPERATION_ID,
      kind: 'subprocess',
      action: 'versioned startup snapshot for selection',
      command: {
        executable: 'node',
        args: ['tools/agentic/scan.mjs', ...input.scanArgs],
        cwd: root,
      },
    };
    writeOpInput('scan-operation.json', scanInput);
    const scan = runToolJson(
      'scan',
      'measurement-contract.mjs --run-operation',
      [MEASUREMENT_CONTRACT, '--run-operation'],
      {
        cwd: root,
        input: JSON.stringify(scanInput),
        timeout: SCAN_STEP_TIMEOUT_MS,
      },
    );
    if (scan.ok !== true) return scan;
    let snapshot;
    try {
      snapshot = JSON.parse(scan.value.command.stdout);
    } catch (error) {
      return failure('snapshot', {
        code: 'SNAPSHOT_PARSE_FAILED',
        message: `captured scan stdout is not JSON: ${error.message}`,
      });
    }
    const snapshotErrors = verifySnapshotShape(snapshot);
    if (snapshotErrors.length > 0) {
      return failure('snapshot', {
        code: 'SNAPSHOT_SECTIONS_INVALID',
        message: snapshotErrors.join('; '),
      });
    }

    const { ok, ...stageStartBoundary } = stageStart.value;
    return {
      ok: true,
      run,
      // Every one-shot measured operation and the conclude call bind to this id
      // explicitly, so orphaned ledgers from interrupted runs cannot make the
      // open-run derivation ambiguous (live failure: four candidates).
      measurementRunId,
      // The route probe and every later broker operation take the SAME host
      // evidence the manual path would have kept from its own attest call; the
      // intent record is one-use, so dropping this here would strand the run
      // with no way to probe (live block: "prime.mjs discards hostEvidence").
      hostEvidence,
      boundaries: {
        runStart: bind.value.value,
        stageStart: stageStartBoundary,
      },
      scan: {
        operationId: SCAN_OPERATION_ID,
        eventPath: scan.value.capture.path,
      },
      snapshot,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function boundedPrintable(value, maximum) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maximum
    && !/[\x00-\x1f\x7f]/.test(value);
}

function invalidConclude(message) {
  return failure('input', { code: 'INVALID_CONCLUDE_INPUT', message });
}

export function validateConcludeInput(value) {
  if (!plainObject(value)) {
    return invalidConclude(
      'expected a JSON object with {run,hostEvidence,reason,stageId,blockedReason} '
      + 'and optional {waitCategory}',
    );
  }
  const missing = CONCLUDE_KEYS.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    return invalidConclude(`missing input field "${missing}"`);
  }
  const unknown = Object.keys(value).find(
    (key) => !CONCLUDE_KEYS.includes(key) && !CONCLUDE_OPTIONAL_KEYS.includes(key),
  );
  if (unknown !== undefined) {
    return invalidConclude(`unknown input field "${unknown}"`);
  }
  if (value.reason !== CONCLUDE_REASON) {
    return failure('input', {
      code: 'CONCLUDE_REASON_UNSUPPORTED',
      message:
        `conclude closes exactly the "${CONCLUDE_REASON}" stop; every other stop `
        + 'keeps the manual event path (measurement-contract.mjs --capture-event '
        + 'boundaries plus run-scope.mjs --finish-json)',
    });
  }
  if (
    !plainObject(value.run)
    || typeof value.run.activeHost !== 'string'
    || !HEX_64_PATTERN.test(value.run.hostEvidenceFingerprint ?? '')
  ) {
    return invalidConclude('run: expected the exact broker-issued run artifact');
  }
  if (
    !plainObject(value.hostEvidence)
    || value.hostEvidence.fingerprint !== value.run.hostEvidenceFingerprint
  ) {
    return invalidConclude(
      'hostEvidence: fingerprint must match run.hostEvidenceFingerprint',
    );
  }
  if (
    Object.hasOwn(value.hostEvidence, 'sessionFingerprint')
    && value.hostEvidence.sessionFingerprint !== value.run.sessionFingerprint
  ) {
    return invalidConclude(
      'hostEvidence: sessionFingerprint must match run.sessionFingerprint',
    );
  }
  if (!STAGE_ID_PATTERN.test(value.stageId ?? '')) {
    return invalidConclude('stageId: invalid identifier');
  }
  if (
    !plainObject(value.blockedReason)
    || Object.keys(value.blockedReason).sort().join(',') !== 'code,reason'
    || !boundedPrintable(value.blockedReason.code, 80)
    || !boundedPrintable(value.blockedReason.reason, 500)
  ) {
    return invalidConclude(
      'blockedReason: expected {code,reason} with a bounded printable code '
      + '(80) and reason (500)',
    );
  }
  if (
    Object.hasOwn(value, 'waitCategory')
    && !CONCLUDE_WAIT_CATEGORIES.includes(value.waitCategory)
  ) {
    return invalidConclude(
      `waitCategory: expected one of ${CONCLUDE_WAIT_CATEGORIES.join(', ')}`,
    );
  }
  return {
    ok: true,
    run: value.run,
    hostEvidence: value.hostEvidence,
    stageId: value.stageId,
    blockedReason: value.blockedReason,
    waitCategory: value.waitCategory ?? null,
  };
}

// The composed inputs mirror the retained golden shapes from live blocked
// runs: empty-envelope human wait boundaries, an orchestrator-owned stage end
// whose degradation carries the caller's blocked reason with every telemetry
// field typed-unavailable, and a blocked run finish whose terminal, gate, and
// lifecycle evidence references are typed-unavailable until real producers
// exist. Every input goes through the public capture CLI, so the strict event
// validators apply unchanged.
export function composeConcludeEvents({
  runId,
  stageId,
  stage,
  route,
  blockedReason,
  waitCategory,
}) {
  const unavailable = (reason) => ({ status: 'unavailable', reason });
  const telemetryReason =
    'orchestrator-owned stage end; provider producer capture is unavailable';
  const events = [];
  if (waitCategory !== null && waitCategory !== undefined) {
    for (const kind of ['wait-start', 'wait-end']) {
      events.push({
        name: kind,
        input: {
          version: 1,
          runId,
          kind,
          payload: { stageId, waitId: CONCLUDE_WAIT_ID, category: waitCategory },
          envelopes: {},
        },
      });
    }
  }
  events.push({
    name: 'stage-end',
    input: {
      version: 1,
      runId,
      kind: 'stage-end',
      payload: {
        stageId,
        actualRoute: route,
        adapter: route,
        degradation: { code: blockedReason.code, reason: blockedReason.reason },
        telemetry: Object.fromEntries(
          CONCLUDE_TELEMETRY_KEYS.map((key) => [key, unavailable(telemetryReason)]),
        ),
      },
      envelopes: {
        providerEvidence: unavailable(
          'orchestrator-owned stage end; no provider accounting producer is installed',
        ),
      },
    },
  });
  events.push({
    name: 'run-finish',
    input: {
      version: 1,
      runId,
      kind: 'run-finish',
      payload: {
        terminal: { status: 'blocked', stage, reason: blockedReason.reason },
        gate: { result: 'not-run', localGreenCiRed: false },
        recovery: { resumeKind: 'fresh', recoveryKind: 'blocked' },
      },
      envelopes: {
        terminalEvidence: unavailable(
          'no producer-backed terminal seam is installed; the run stopped '
          + 'blocked before any terminal mutation',
        ),
        gateEvidence: unavailable(
          `the gate never ran; the run stopped blocked during ${stage}`,
        ),
        lifecycleEvidence: unavailable(
          'no lifecycle marker outcome was produced; the run stopped blocked '
          + 'before delivery',
        ),
      },
    },
  });
  return events;
}

export async function concludeDev(rawInput, cwd = process.cwd()) {
  const input = validateConcludeInput(rawInput);
  if (input.ok !== true) return input;
  const rootResult = gitValue('repository', cwd, ['rev-parse', '--show-toplevel']);
  if (rootResult.ok !== true) return rootResult;
  const root = realpathSync(rootResult.value);
  const storePath = gitValue('derive-run', root, [
    'rev-parse',
    '--git-path',
    'autoloop/measurements/v1',
  ]);
  if (storePath.ok !== true) return storePath;
  // An optional caller-supplied measurementRunId (from the prime summary) binds
  // the close explicitly, because orphaned ledgers from interrupted runs make
  // the bare one-open-run derivation ambiguous (live failure: four candidates).
  // Bare derivation stays for the single-open case; either way the id must name
  // a run with a retained run-start, no run-finish, and the caller's stage.
  const { deriveOpenMeasurementRun, currentMeasurementStage } =
    await import('./measurement-contract.mjs');
  let open;
  try {
    const store = resolve(root, storePath.value);
    if (typeof rawInput?.measurementRunId === 'string') {
      const active = currentMeasurementStage(store, rawInput.measurementRunId);
      open = active.ok === true
        ? { ok: true, runId: rawInput.measurementRunId, stage: active.stage }
        : { ok: false, errors: active.errors };
    } else {
      open = deriveOpenMeasurementRun(store);
    }
  } catch (error) {
    return failure('derive-run', {
      code: 'OPEN_RUN_UNDERIVABLE',
      message: error.message,
    });
  }
  if (open.ok !== true) {
    return failure('derive-run', {
      code: 'OPEN_RUN_UNDERIVABLE',
      message: open.errors.join('; '),
      ...(open.candidates === undefined ? {} : { candidates: open.candidates }),
    });
  }
  if (open.stage.id !== input.stageId) {
    return failure('derive-run', {
      code: 'STAGE_MISMATCH',
      message: `stageId "${input.stageId}" does not match the retained active `
        + `stage "${open.stage.id}"`,
    });
  }
  const composed = composeConcludeEvents({
    runId: open.runId,
    stageId: input.stageId,
    stage: open.stage.stage,
    route: `${input.run.activeHost}.native`,
    blockedReason: input.blockedReason,
    waitCategory: input.waitCategory,
  });
  const temporary = mkdtempSync(join(tmpdir(), 'autoloop-prime-'));
  try {
    const writeOpInput = (name, value) => {
      const path = join(temporary, name);
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      return path;
    };
    const events = [];
    for (const { name, input: eventInput } of composed) {
      writeOpInput(`event-${name}.json`, eventInput);
      const captured = runToolJson(
        name,
        `measurement-contract.mjs --capture-event (${name})`,
        [MEASUREMENT_CONTRACT, '--capture-event'],
        {
          cwd: root,
          input: JSON.stringify(eventInput),
          timeout: BROKER_STEP_TIMEOUT_MS,
        },
      );
      if (captured.ok !== true) return captured;
      events.push(captured.value.path);
    }
    const finish = runToolJson(
      'finish',
      'run-scope.mjs --finish-json',
      [
        RUN_SCOPE,
        '--finish-json',
        writeOpInput('finish.json', {
          run: input.run,
          progress: {
            reason: CONCLUDE_REASON,
            unitsCompleted: 0,
            queueEvidence: null,
          },
        }),
      ],
      { cwd: root, timeout: BROKER_STEP_TIMEOUT_MS },
    );
    if (finish.ok !== true) return finish;
    return { ok: true, finish: finish.value.value, events };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function readJsonInput(path) {
  const bytes = readFileSync(path === '-' ? 0 : path);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error('input exceeds 1 MiB');
  return JSON.parse(bytes.toString('utf8'));
}

function expect(failures, name, passed) {
  if (!passed) failures.push(name);
  return passed;
}

async function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    expect(failures, name, passed);
  };

  const fixtureConfig = {
    version: '0.25.0',
    baseBranch: 'main',
    gate: { command: 'npm test', quickCommand: null, setupCommand: null },
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
  const fixtureRun = {
    version: 1,
    configVersion: '0.25.0',
    invocationFlow: 'dev',
    originHost: 'claude',
    activeHost: 'claude',
    hostEvidenceFingerprint: '1'.repeat(64),
    sessionFingerprint: '2'.repeat(64),
    invocationNonce: '3'.repeat(64),
    selector: 'native',
    intentProvenance: 'best-effort-unverified',
    requestedEngine: 'claude',
    requestedRoute: 'claude.native',
    scope: { scope: 'queue' },
    generation: 0,
    runIntentHash: '4'.repeat(64),
    configuredBaseBranch: 'main',
    configFingerprint: '5'.repeat(64),
    instanceFingerprint: '6'.repeat(64),
    // Deliberately not a broker authorization: the run must fail run
    // validation without consulting a broker, isolating declaration checks.
    authorization: 'fixture-unauthorized',
  };
  check('fixture config is valid', validateProjectConfig(fixtureConfig).length === 0);
  check(
    'measurement capture is off unless the config opts into events',
    captureEnabled(fixtureConfig) === false
      && captureEnabled({ ...fixtureConfig, measurement: { capture: 'off' } }) === false
      && captureEnabled({ ...fixtureConfig, measurement: { capture: 'events' } }) === true,
  );

  const runId = randomUUID();
  const derived = deriveMeasurementDeclaration({
    config: fixtureConfig,
    run: fixtureRun,
    repository: 'owner/repo',
    runId,
  });
  const expectedWorkloadManifest =
    '{"version":1,"workload":"autoloop-dev-unit","repository":"owner/repo",'
    + '"baseBranch":"main","unit":"one loop-ready issue from selection to '
    + 'delivered pull request","gateCommand":"npm test"}';
  const expectedEndpointManifest =
    `{"version":1,"checkpoint":"safe-system","autoloopVersion":"${AUTOLOOP_VERSION}",`
    + '"configVersion":"0.25.0","baseBranch":"main","host":"claude"}';
  check('workload manifest bytes are exact', derived.workloadManifest === expectedWorkloadManifest);
  check('endpoint manifest bytes are exact', derived.endpointManifest === expectedEndpointManifest);
  check(
    'declaration fingerprints hash the exact manifest bytes',
    derived.declaration.comparisonContextFingerprint
      === createHash('sha256').update(expectedWorkloadManifest, 'utf8').digest('hex')
    && derived.declaration.checkpointEndpointFingerprint
      === createHash('sha256').update(expectedEndpointManifest, 'utf8').digest('hex'),
  );
  check(
    'declaration derives intent and policy fields mechanically',
    derived.declaration.version === 1
    && derived.declaration.runId === runId
    && derived.declaration.workload === WORKLOAD
    && derived.declaration.checkpoint === CHECKPOINT
    && derived.declaration.intentSource === 'invocation'
    && derived.declaration.intentProvenance === 'best-effort-unverified'
    && derived.declaration.mergePolicy === 'manual'
    && derived.declaration.baseFreshnessStrategy === 'manual',
  );
  const autoPolicy = deriveMeasurementDeclaration({
    config: { ...fixtureConfig, merge: { policy: 'auto', unverifiedInvocationAcknowledged: true } },
    run: fixtureRun,
    repository: 'owner/repo',
    runId,
  }).declaration;
  const relaunch = deriveMeasurementDeclaration({
    config: fixtureConfig,
    run: { ...fixtureRun, generation: 2 },
    repository: 'owner/repo',
    runId,
  }).declaration;
  check(
    'non-manual policy and relaunch generation derive their enums',
    autoPolicy.mergePolicy === 'auto'
    && autoPolicy.baseFreshnessStrategy === 'direct-strict'
    && relaunch.intentSource === 'relaunch',
  );

  // The production bind validator checks every declaration field before its
  // one combined run check; a deliberately unauthorized fixture run therefore
  // reduces its verdict to exactly that run error when — and only when — the
  // derived declaration passes every declaration check.
  const { bindRuntimeMeasurement, buildTypedMeasurementEvent } =
    await import('./measurement-contract.mjs');
  const accepted = bindRuntimeMeasurement(
    { run: fixtureRun, measurement: derived.declaration },
    TOOL_DIRECTORY,
  );
  check(
    'bind validator accepts the derived declaration',
    accepted.ok === false
    && Array.isArray(accepted.errors)
    && accepted.errors.length === 1
    && accepted.errors[0] === 'binding: Runtime run or intent source is invalid',
  );
  const badCheckpoint = bindRuntimeMeasurement(
    { run: fixtureRun, measurement: { ...derived.declaration, checkpoint: 'bogus' } },
    TOOL_DIRECTORY,
  );
  check(
    'bind validator rejects a corrupted checkpoint',
    badCheckpoint.ok === false
    && badCheckpoint.errors.some((error) =>
      error.startsWith('binding.measurement.checkpoint')),
  );
  const badFingerprint = bindRuntimeMeasurement(
    {
      run: fixtureRun,
      measurement: {
        ...derived.declaration,
        comparisonContextFingerprint: 'not-a-fingerprint',
      },
    },
    TOOL_DIRECTORY,
  );
  check(
    'bind validator rejects a corrupted manifest fingerprint',
    badFingerprint.ok === false
    && badFingerprint.errors.includes(
      'binding.measurement.comparisonContextFingerprint: expected sha256',
    ),
  );

  check(
    'valid input parses with default scan arguments',
    (() => {
      const parsed = validatePrimeInput({ sessionId: 'session-1' });
      return parsed.ok === true
        && parsed.sessionId === 'session-1'
        && Array.isArray(parsed.scanArgs)
        && parsed.scanArgs.length === 0;
    })(),
  );
  check(
    'scan arguments pass through validated',
    validatePrimeInput({ sessionId: 's', scanArgs: ['--pr', '7'] }).ok === true,
  );
  check(
    'a continuation field is a typed error naming the manual path',
    (() => {
      const refused = validatePrimeInput({ sessionId: 's', continuation: {} });
      return refused.ok === false
        && refused.step === 'input'
        && refused.error.code === 'CONTINUATION_UNSUPPORTED';
    })(),
  );
  check(
    'missing, unknown, and malformed inputs are typed errors',
    validatePrimeInput({}).ok === false
    && validatePrimeInput(null).ok === false
    && validatePrimeInput({ sessionId: 's', extra: 1 }).ok === false
    && validatePrimeInput({ sessionId: 's', scanArgs: [7] }).ok === false
    && validatePrimeInput({ sessionId: '' }).ok === false,
  );

  check(
    'repository slugs parse from SSH and HTTPS origins',
    repositorySlug('git@github.com:owner/repo.git') === 'owner/repo'
    && repositorySlug('https://github.com/owner/repo.git') === 'owner/repo'
    && repositorySlug('https://github.com/owner/repo') === 'owner/repo'
    && repositorySlug('ssh://git@github.com/owner/repo.git') === 'owner/repo'
    && repositorySlug('not-a-remote') === null,
  );

  const concludeFixtureInput = {
    run: fixtureRun,
    hostEvidence: {
      fingerprint: fixtureRun.hostEvidenceFingerprint,
      sessionFingerprint: fixtureRun.sessionFingerprint,
    },
    reason: CONCLUDE_REASON,
    stageId: 'selection-1',
    blockedReason: {
      code: 'FIXTURE_GUARDRAIL',
      reason: 'fixture human handoff ends the run',
    },
    waitCategory: 'human',
  };
  check(
    'a non-guardrail conclude reason is a typed error naming the manual path',
    (() => {
      const refused = validateConcludeInput({
        ...concludeFixtureInput,
        reason: 'queue-exhausted',
      });
      return refused.ok === false
        && refused.step === 'input'
        && refused.error.code === 'CONCLUDE_REASON_UNSUPPORTED'
        && refused.error.message.includes('manual event path');
    })(),
  );
  check(
    'missing, unknown, and malformed conclude inputs are typed errors',
    validateConcludeInput(null).ok === false
    && validateConcludeInput({}).ok === false
    && validateConcludeInput({ ...concludeFixtureInput, extra: 1 }).ok === false
    && validateConcludeInput({
      ...concludeFixtureInput,
      hostEvidence: { fingerprint: 'f'.repeat(64) },
    }).ok === false
    && validateConcludeInput({ ...concludeFixtureInput, stageId: '!' }).ok === false
    && validateConcludeInput({
      ...concludeFixtureInput,
      blockedReason: { code: 'x'.repeat(81), reason: 'r' },
    }).ok === false
    && validateConcludeInput({
      ...concludeFixtureInput,
      waitCategory: 'weekend',
    }).ok === false
    && (() => {
      const parsed = validateConcludeInput(concludeFixtureInput);
      const withoutWait = { ...concludeFixtureInput };
      delete withoutWait.waitCategory;
      return parsed.ok === true
        && parsed.waitCategory === 'human'
        && validateConcludeInput(withoutWait).waitCategory === null;
    })(),
  );
  {
    const composed = composeConcludeEvents({
      runId: randomUUID(),
      stageId: 'selection-1',
      stage: 'selection',
      route: 'claude.native',
      blockedReason: concludeFixtureInput.blockedReason,
      waitCategory: 'human',
    });
    const validated = composed.map(({ input }) => buildTypedMeasurementEvent(input));
    const withoutWait = composeConcludeEvents({
      runId: randomUUID(),
      stageId: 'selection-1',
      stage: 'selection',
      route: 'claude.native',
      blockedReason: concludeFixtureInput.blockedReason,
      waitCategory: null,
    });
    check(
      'composed conclude events pass the measurement contract validators',
      composed.map(({ name }) => name).join(',')
        === 'wait-start,wait-end,stage-end,run-finish'
      && validated.every((result) => result.ok === true)
      && withoutWait.map(({ name }) => name).join(',') === 'stage-end,run-finish'
      && composed[2].input.payload.degradation.code === 'FIXTURE_GUARDRAIL'
      && composed[3].input.payload.terminal.status === 'blocked'
      && composed[3].input.payload.terminal.stage === 'selection',
    );
  }

  const section = { items: [], complete: true, error: null };
  const sections = Object.fromEntries(
    Array.from({ length: SNAPSHOT_SECTION_COUNT }, (_, index) => [
      `section${index}`,
      section,
    ]),
  );
  check(
    'a ten-section snapshot passes shape verification',
    verifySnapshotShape({
      kind: 'autoloop-repository-snapshot',
      sections,
    }).length === 0,
  );
  check(
    'missing and malformed sections fail shape verification',
    verifySnapshotShape({
      kind: 'autoloop-repository-snapshot',
      sections: Object.fromEntries(Object.entries(sections).slice(0, 9)),
    }).length === 1
    && verifySnapshotShape({
      kind: 'autoloop-repository-snapshot',
      sections: { ...sections, section0: { items: [], complete: true } },
    }).length === 1
    && verifySnapshotShape({ kind: 'other', sections }).length === 1,
  );

  // Fail-closed live chain: a repository without a hook-captured transport
  // record must stop at attest-host with a typed error, and the temporary
  // input directory must not survive the run.
  const temporaryEntries = () => readdirSync(tmpdir())
    .filter((name) => name.startsWith('autoloop-prime-')).sort();
  const before = temporaryEntries();
  const fixtureRepo = mkdtempSync(join(tmpdir(), 'autoloop-selftest-repo-'));
  try {
    const initialized = spawnSync('git', ['init', '-q'], {
      cwd: fixtureRepo,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    check('fixture repository initializes', initialized.status === 0);
    const spawned = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--dev-json', '-'],
      {
        cwd: fixtureRepo,
        encoding: 'utf8',
        input: '{"sessionId":"prime-self-test"}',
        maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        timeout: 120_000,
        windowsHide: true,
      },
    );
    let typed = null;
    try {
      typed = JSON.parse(spawned.stdout);
    } catch {}
    check(
      'a repository without transport records fails closed at attest-host',
      spawned.status === 1
      && typed?.ok === false
      && typed.step === 'attest-host'
      && plainObject(typed.error)
      && typeof typed.error.code === 'string',
    );
    check(
      'the temporary input directory is removed',
      JSON.stringify(temporaryEntries()) === JSON.stringify(before),
    );
    const concluded = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--conclude-json', '-'],
      {
        cwd: fixtureRepo,
        encoding: 'utf8',
        input: JSON.stringify(concludeFixtureInput),
        maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        timeout: 120_000,
        windowsHide: true,
      },
    );
    let concludedTyped = null;
    try {
      concludedTyped = JSON.parse(concluded.stdout);
    } catch {}
    check(
      'a repository without an open measurement run fails conclude closed at derive-run',
      concluded.status === 1
      && concludedTyped?.ok === false
      && concludedTyped.step === 'derive-run'
      && concludedTyped.error.code === 'OPEN_RUN_UNDERIVABLE'
      && Array.isArray(concludedTyped.error.candidates)
      && concludedTyped.error.candidates.length === 0,
    );
  } finally {
    rmSync(fixtureRepo, { recursive: true, force: true });
  }

  {
    const bigSection = (n) => ({
      complete: true,
      items: Array.from({ length: n }, (unused, index) => ({
        number: index + 1,
        body: 'x'.repeat(2000),
      })),
      error: null,
    });
    const fullResult = {
      ok: true,
      run: { instanceFingerprint: '9'.repeat(64) },
      measurementRunId: 'e23e4567-e89b-42d3-a456-426614174000',
      hostEvidence: { fingerprint: 'f'.repeat(64), observedHosts: ['claude'] },
      boundaries: {
        runStart: { payload: { runId: 'e23e4567-e89b-42d3-a456-426614174000' } },
        stageStart: {},
      },
      scan: { operationId: 'op', eventPath: '/tmp/e.json' },
      snapshot: {
        kind: 'autoloop-repository-snapshot',
        sections: {
          queue: bigSection(60),
          openIssues: { complete: false, items: [], error: 'SCAN_FAILED' },
        },
      },
    };
    const scratch = mkdtempSync(join(tmpdir(), 'autoloop-prime-bundle-'));
    try {
      spawnSync('git', ['init', '-q', scratch], { encoding: 'utf8' });
      const compact = persistPrimeBundle(fullResult, scratch);
      const printedBytes = Buffer.byteLength(JSON.stringify(compact, null, 1), 'utf8');
      const persisted = JSON.parse(readFileSync(compact.bundlePath, 'utf8'));
      const rawSnapshot = JSON.parse(readFileSync(compact.snapshotPath, 'utf8'));
      check(
        'success stdout is decision-sized while the durable bundle keeps every byte',
        compact.snapshot === undefined
          && compact.hostEvidence.fingerprint === 'f'.repeat(64)
          && compact.sections.queue.complete === true
          && compact.sections.queue.items === 60
          && compact.sections.openIssues.error === 'SCAN_FAILED'
          && printedBytes < 8192
          && persisted.snapshot.sections.queue.items.length === 60
          && rawSnapshot.sections.queue.items.length === 60
          && compact.measurementRunId === 'e23e4567-e89b-42d3-a456-426614174000'
          && compact.bundlePath.includes(
            '.git/autoloop/prime/e23e4567-e89b-42d3-a456-426614174000',
          ),
      );
      // Capture-off runs have no measurement id and no boundaries; the bundle
      // must still get a stable unique name from the broker run artifact's
      // instanceFingerprint, with the 'run' literal only as the final fallback.
      const captureOff = persistPrimeBundle({
        ...fullResult,
        measurementRunId: null,
        boundaries: null,
        scan: { operationId: null, eventPath: null },
      }, scratch);
      const anonymous = persistPrimeBundle({
        ...fullResult,
        run: {},
        measurementRunId: null,
        boundaries: null,
      }, scratch);
      check(
        'capture-off bundles are named by the broker run instance fingerprint',
        captureOff.bundlePath.endsWith(`/${'9'.repeat(64)}.bundle.json`)
          && captureOff.snapshotPath.endsWith(`/${'9'.repeat(64)}.snapshot.json`)
          && anonymous.bundlePath.endsWith('/run.bundle.json'),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(
    failures.length === 0
      ? `self-test OK (${cases.length} cases)`
      : `self-test FAILED (${failures.length}/${cases.length})`,
  );
  return failures.length === 0;
}

// The full bundle inlines a ~300KB snapshot; a model-facing tool result is
// truncated far below that, which silently re-created the manual-scan
// archaeology prime exists to remove. The durable artifacts live under
// .git/autoloop/prime/ and stdout carries only decision-sized facts plus the
// paths; snapshot consumers already read from files.
export function sectionSummary(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot?.sections ?? {}).map(([name, section]) => [name, {
      complete: section?.complete === true,
      items: Array.isArray(section?.items) ? section.items.length : 0,
      ...(section?.error ? { error: section.error } : {}),
    }]),
  );
}

export function persistPrimeBundle(result, cwd = process.cwd()) {
  const directory = resolve(cwd, '.git', 'autoloop', 'prime');
  mkdirSync(directory, { recursive: true });
  // With capture on, the measurement run UUID names the bundle. With capture
  // off there is no measurement id, and the broker-issued run artifact carries
  // no `runId` field — its stable unique identifier is `instanceFingerprint`
  // (run-scope.mjs open result), which a live capture-off run proved when the
  // old `run.runId` lookup missed and every bundle collapsed onto the literal
  // 'run' name. The literal survives only as the final fail-safe.
  const runId = [
    result?.measurementRunId,
    result?.boundaries?.runStart?.payload?.runId,
    result?.run?.instanceFingerprint,
  ].find((value) =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    ?? 'run';
  const bundlePath = resolve(directory, `${runId}.bundle.json`);
  const snapshotPath = resolve(directory, `${runId}.snapshot.json`);
  const snapshotBytes = `${JSON.stringify(result.snapshot, null, 1)}\n`;
  writeFileSync(bundlePath, `${JSON.stringify(result, null, 1)}\n`);
  writeFileSync(snapshotPath, snapshotBytes);
  const { snapshot, ...compact } = result;
  return {
    ...compact,
    bundlePath,
    snapshotPath,
    snapshotBytes: Buffer.byteLength(snapshotBytes, 'utf8'),
    sections: sectionSummary(snapshot),
  };
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { mode: 'self-test', path: null, error: null };
  }
  if (args.length === 2 && args[0] === '--dev-json' && args[1]) {
    return { mode: 'dev', path: args[1], error: null };
  }
  if (args.length === 2 && args[0] === '--conclude-json' && args[1]) {
    return { mode: 'conclude', path: args[1], error: null };
  }
  return {
    mode: null,
    path: null,
    error: "expected --dev-json <path|->, --conclude-json <path|-> "
      + "('-' reads stdin), or --self-test",
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`prime: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(await selfTest() ? 0 : 1);
  let input;
  try {
    input = readJsonInput(parsed.path);
  } catch (error) {
    console.error(`prime: unable to read JSON input: ${error.message}`);
    process.exit(2);
  }
  if (parsed.mode === 'conclude') {
    const concluded = await concludeDev(input);
    writeStdoutSync(`${JSON.stringify(concluded, null, 1)}\n`);
    process.exit(concluded.ok === true ? 0 : 1);
  }
  const result = primeDev(input);
  const printed = result.ok === true ? persistPrimeBundle(result) : result;
  writeStdoutSync(`${JSON.stringify(printed, null, 1)}\n`);
  process.exit(result.ok === true ? 0 : 1);
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
