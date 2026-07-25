#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHostProcessBinding } from './route-adapter-contract.mjs';

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
export const INTENT_PROVENANCE = 'best-effort-unverified';
const INTENT_PATTERN =
  /^\s*(?:[$/]autoloop:(?:dev|pitcrew|doctor)\b|[$/]autoloop:setup\b[^\r\n]*\bdoctor\b)/i;
const RECORD_KEYS = [
  'capturedAtMs',
  'fingerprint',
  'host',
  'hostProcessFingerprint',
  'hostProcessStart',
  'hostPid',
  'intentProvenance',
  'kind',
  'nonce',
  'prompt',
  'repositoryRoot',
  'sessionId',
  'turnId',
  'version',
];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

function gitOutput(cwd, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return execFileSync('git', [
    '--no-replace-objects',
    '--no-optional-locks',
    '-C',
    cwd,
    '-c',
    'core.hooksPath=/dev/null',
    ...args,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
    },
  }).trim();
}

function repositoryRoot(cwd) {
  return realpathSync(gitOutput(cwd, ['rev-parse', '--show-toplevel']));
}

function intentDirectory(root) {
  const candidate = gitOutput(root, [
    'rev-parse',
    '--git-path',
    'autoloop/intents/v1',
  ]);
  const path = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const stats = lstatSync(path);
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || typeof process.getuid === 'function' && stats.uid !== process.getuid()
  ) {
    throw new Error('intent store is not a private owned directory');
  }
  return realpathSync(path);
}

function recordPath(directory, binding, sessionId) {
  return join(directory, `${fingerprint({
    host: binding.host,
    hostProcessFingerprint: binding.fingerprint,
    sessionId,
  })}.json`);
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validRecord(record, binding, root, sessionId) {
  if (
    !exactKeys(record, RECORD_KEYS)
    || record.kind !== 'autoloop-host-intent'
    || record.version !== 1
    || record.host !== binding.host
    || record.hostProcessFingerprint !== binding.fingerprint
    || record.hostPid !== binding.pid
    || record.hostProcessStart !== binding.processStart
    || record.intentProvenance !== INTENT_PROVENANCE
    || record.repositoryRoot !== root
    || record.sessionId !== sessionId
    || !(record.turnId === null || SAFE_ID.test(record.turnId))
    || typeof record.prompt !== 'string'
    || Buffer.byteLength(record.prompt) < 1
    || Buffer.byteLength(record.prompt) > MAX_PROMPT_BYTES
    || !INTENT_PATTERN.test(record.prompt)
    || !Number.isSafeInteger(record.capturedAtMs)
    || record.capturedAtMs < 0
    || !HASH.test(record.nonce)
    || !HASH.test(record.fingerprint)
  ) {
    return false;
  }
  const unsigned = { ...record };
  delete unsigned.fingerprint;
  return record.fingerprint === fingerprint(unsigned);
}

function commandInvocation(input) {
  if (
    !SAFE_ID.test(input.command ?? '')
    || typeof input.arguments !== 'string'
    || Buffer.byteLength(input.arguments) > MAX_PROMPT_BYTES
  ) {
    throw new Error('opencode command intent is invalid');
  }
  const command = input.command.toLowerCase();
  const separator = input.arguments.length === 0 || /^\s/u.test(input.arguments)
    ? ''
    : ' ';
  let prompt = null;
  if (['dev', 'pitcrew', 'doctor'].includes(command)) {
    prompt = `/autoloop:${command}${separator}${input.arguments}`;
  } else if (
    command === 'setup'
    && /^\s*doctor(?:\s|$)/iu.test(input.arguments)
  ) {
    prompt = `/autoloop:setup${separator}${input.arguments}`;
  }
  if (prompt !== null && Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    throw new Error('opencode command intent exceeds 64 KiB');
  }
  return {
    prompt,
    selectedAutoloop: ['dev', 'pitcrew', 'doctor', 'setup'].includes(command),
  };
}

function hookInput(input) {
  const event = input?.hook_event_name;
  const opencodePrompt = event === 'opencode.user-prompt';
  const opencodeCommand = event === 'opencode.command';
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || ![
      'UserPromptSubmit',
      'opencode.user-prompt',
      'opencode.command',
    ].includes(event)
    || !SAFE_ID.test(input.session_id ?? '')
    || !(input.turn_id === undefined || SAFE_ID.test(input.turn_id))
    || typeof input.cwd !== 'string'
    || (
      !opencodeCommand
      && (
        typeof input.prompt !== 'string'
        || Buffer.byteLength(input.prompt) < 1
        || Buffer.byteLength(input.prompt) > MAX_PROMPT_BYTES
      )
    )
    || (opencodePrompt && input.turn_id === undefined)
    || (opencodeCommand && input.turn_id !== undefined)
  ) {
    throw new Error('host prompt hook input is invalid');
  }
  const command = opencodeCommand ? commandInvocation(input) : null;
  return {
    sessionId: input.session_id,
    turnId: input.turn_id ?? null,
    cwd: input.cwd,
    prompt: opencodeCommand ? command.prompt : input.prompt,
    selectedAutoloop: command?.selectedAutoloop ?? false,
  };
}

export function captureHostIntent(input, options = {}) {
  const parsed = hookInput(input);
  if (parsed.prompt === null || !INTENT_PATTERN.test(parsed.prompt)) {
    return {
      captured: false,
      reason: parsed.selectedAutoloop
        ? 'non-runtime-autoloop-command'
        : 'not-autoloop-intent',
    };
  }
  const binding = options.binding ?? detectHostProcessBinding();
  if (binding === null) throw new Error('host process binding is unavailable');
  const root = repositoryRoot(options.cwd ?? parsed.cwd);
  const directory = intentDirectory(root);
  const path = recordPath(directory, binding, parsed.sessionId);
  const unsigned = {
    kind: 'autoloop-host-intent',
    version: 1,
    intentProvenance: INTENT_PROVENANCE,
    host: binding.host,
    hostProcessFingerprint: binding.fingerprint,
    hostPid: binding.pid,
    hostProcessStart: binding.processStart,
    sessionId: parsed.sessionId,
    turnId: parsed.turnId,
    repositoryRoot: root,
    prompt: parsed.prompt,
    capturedAtMs: options.now ?? Date.now(),
    nonce: randomBytes(32).toString('hex'),
  };
  const record = { ...unsigned, fingerprint: fingerprint(unsigned) };
  let descriptor;
  try {
    descriptor = openSync(
      path,
      'wx',
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(path, 0o600);
    return { captured: true, record };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !validRecord(existing, binding, root, parsed.sessionId)
      || existing.prompt !== parsed.prompt
      || existing.turnId !== parsed.turnId
    ) {
      throw new Error('host intent is already sealed for this session');
    }
    return { captured: false, reason: 'already-sealed', record: existing };
  }
}

export function consumeHostIntent(input, options = {}) {
  if (!SAFE_ID.test(input?.sessionId ?? '')) {
    throw new Error('host intent session is invalid');
  }
  const binding = options.binding ?? detectHostProcessBinding();
  if (binding === null) throw new Error('host process binding is unavailable');
  const root = repositoryRoot(options.cwd ?? process.cwd());
  const directory = intentDirectory(root);
  const path = recordPath(directory, binding, input.sessionId);
  const stats = lstatSync(path);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size > MAX_INPUT_BYTES
    || typeof process.getuid === 'function' && stats.uid !== process.getuid()
  ) {
    throw new Error('host intent record is not a private owned file');
  }
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (!validRecord(record, binding, root, input.sessionId)) {
    throw new Error('host intent record failed provenance validation');
  }
  const consumed = `${path}.${record.nonce}.consumed`;
  renameSync(path, consumed);
  rmSync(consumed, { force: true });
  return Object.freeze({ ...record });
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'autoloop-intent-'));
  const binding = {
    host: 'codex',
    pid: 1234,
    processStart: 'start',
    fingerprint: 'a'.repeat(64),
  };
  const input = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-1',
    turn_id: 'turn-1',
    cwd: root,
    prompt: '$autoloop:dev with codex only #7',
  };
  try {
    execFileSync('git', ['init', '-q', root], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10000,
    });
    const captured = captureHostIntent(input, {
      binding,
      cwd: root,
      now: 1,
    });
    const duplicate = captureHostIntent(input, {
      binding,
      cwd: root,
      now: 2,
    });
    let conflicting = false;
    try {
      captureHostIntent({
        ...input,
        prompt: '$autoloop:dev with opencode',
      }, {
        binding,
        cwd: root,
        now: 3,
      });
    } catch {
      conflicting = true;
    }
    const consumed = consumeHostIntent(
      { sessionId: input.session_id },
      { binding, cwd: root },
    );
    let replay = false;
    try {
      consumeHostIntent(
        { sessionId: input.session_id },
        { binding, cwd: root },
      );
    } catch {
      replay = true;
    }
    const unconstrainedProse = [
      ['session-dev', 'dev take one issue and stop'],
      ['session-pitcrew', 'pitcrew revise the current pull request'],
      ['session-doctor', 'doctor this failure'],
    ];
    const proseRejected = unconstrainedProse.every(([sessionId, prompt], index) => {
      const result = captureHostIntent({
        ...input,
        session_id: sessionId,
        turn_id: `turn-bare-${index}`,
        prompt,
      }, {
        binding: { ...binding, host: 'opencode' },
        cwd: root,
        now: 10 + index,
      });
      return !result.captured && result.reason === 'not-autoloop-intent';
    });
    const referencedCommandsRejected = [
      'What does /autoloop:dev mean?',
      'Please explain this example: $autoloop:pitcrew',
      'Quoted documentation says “/autoloop:setup doctor”.',
    ].every((prompt, index) => {
      const result = captureHostIntent({
        ...input,
        session_id: `session-reference-${index}`,
        turn_id: `turn-reference-${index}`,
        prompt,
      }, {
        binding,
        cwd: root,
        now: 15 + index,
      });
      return !result.captured && result.reason === 'not-autoloop-intent';
    });
    const commandCaptured = captureHostIntent({
      hook_event_name: 'opencode.command',
      session_id: 'session-command',
      cwd: root,
      command: 'dev',
      arguments: 'take one issue and stop with codex',
    }, {
      binding: { ...binding, host: 'opencode' },
      cwd: root,
      now: 20,
    });
    const commandIntent = consumeHostIntent(
      { sessionId: 'session-command' },
      { binding: { ...binding, host: 'opencode' }, cwd: root },
    );
    const doctorCommandCaptured = captureHostIntent({
      hook_event_name: 'opencode.command',
      session_id: 'session-command-doctor',
      cwd: root,
      command: 'setup',
      arguments: 'doctor check the native route',
    }, {
      binding: { ...binding, host: 'opencode' },
      cwd: root,
      now: 21,
    });
    const doctorCommandIntent = consumeHostIntent(
      { sessionId: 'session-command-doctor' },
      { binding: { ...binding, host: 'opencode' }, cwd: root },
    );
    return captured.captured
      && duplicate.reason === 'already-sealed'
      && conflicting
      && consumed.prompt === input.prompt
      && replay
      && proseRejected
      && referencedCommandsRejected
      && consumed.intentProvenance === INTENT_PROVENANCE
      && commandCaptured.captured
      && commandIntent.prompt
        === '/autoloop:dev take one issue and stop with codex'
      && doctorCommandCaptured.captured
      && doctorCommandIntent.prompt === '/autoloop:setup doctor check the native route'
      && captureHostIntent({
        hook_event_name: 'opencode.command',
        session_id: 'session-command-setup',
        cwd: root,
        command: 'setup',
        arguments: 'reconfigure',
      }, {
        binding: { ...binding, host: 'opencode' },
        cwd: root,
      }).reason === 'non-runtime-autoloop-command'
      && captureHostIntent({
        ...input,
        session_id: 'session-2',
        turn_id: 'turn-2',
        prompt: 'ordinary request',
      }, { binding, cwd: root }).reason === 'not-autoloop-intent';
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readStdin() {
  const bytes = readFileSync(0);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error('input exceeds 128 KiB');
  return JSON.parse(bytes.toString('utf8'));
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
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') {
      const passed = selfTest();
      console.log(passed ? 'self-test OK (14 cases)' : 'self-test FAILED');
      process.exit(passed ? 0 : 1);
    }
    if (
      process.argv.length !== 3
      || !['--capture-hook', '--capture-hook-json'].includes(process.argv[2])
    ) {
      throw new Error(
        'expected --capture-hook, --capture-hook-json, or --self-test',
      );
    }
    const result = captureHostIntent(readStdin());
    if (process.argv[2] === '--capture-hook-json') {
      console.log(JSON.stringify({
        captured: result.captured,
        reason: result.reason ?? null,
      }));
    }
  } catch (error) {
    console.error(`intent-contract: ${error.message}`);
    process.exit(2);
  }
}
