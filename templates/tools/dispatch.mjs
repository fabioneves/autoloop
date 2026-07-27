#!/usr/bin/env node

// One role dispatch, one call, one typed result.
//
// The invariant that matters is process identity: a writer and a reviewer are
// never the same process, and a reviewer is never handed a tool that can write.
// That is enforced here by construction — the role picks a frozen tool ceiling
// and permission mode, and there is no path that widens either.
//
// Everything the old dispatch path carried around this — a signing daemon, host
// evidence, live posture smokes, a closed route catalog, plans, receipts, and
// one-use cryptographic envelopes — existed to make a dispatch attributable
// across machines for unattended merging. This tool is for a supervised
// operator on their own machine, so it spawns the engine directly.
//
// Usage:
//   node tools/agentic/dispatch.mjs --role <plan-review|implement|code-review|doubt-review> \
//     --prompt-file <path> [--tools <csv>] [--output-file <path>] [--json]
//   node tools/agentic/dispatch.mjs --self-test
//
// Exit 0 on a typed success, 1 on a typed failure, 2 on a usage error.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// A dispatch is a model round trip on a real task, not a mechanical step. The
// bound exists to stop a wedged child from hanging a loop forever, so it is
// deliberately generous: the longest observed healthy implement dispatch is
// minutes, and a run that needs more than half an hour has a different problem.
const DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;

// The mutating tools, granted explicitly in the settings allow list rather than
// left to the permission mode alone. The grant is derived from the posture's own
// `--tools` ceiling, so a posture grants exactly what it declares and the
// reviewer grants nothing at all. Read-only tools (Glob/Grep/Read) need no
// entry, so the deny list below stays the only statement this contract makes
// about reads.
const TOOLS_REQUIRING_GRANT = Object.freeze(['Bash', 'Edit', 'Write']);

// The two postures, carried over unchanged from the route adapter they used to
// live in. `writer` is the only posture that can mutate the checkout; `reviewer`
// cannot name a write tool at all, which is the invariant the self-test pins.
export const POSTURES = Object.freeze({
  writer: Object.freeze({
    tools: Object.freeze(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']),
    permissionMode: 'acceptEdits',
  }),
  reviewer: Object.freeze({
    tools: Object.freeze(['Glob', 'Grep', 'Read']),
    permissionMode: 'plan',
  }),
});

export const ROLES = Object.freeze({
  'plan-review': Object.freeze({ posture: 'reviewer', result: 'review-verdict' }),
  implement: Object.freeze({ posture: 'writer', result: 'text' }),
  'code-review': Object.freeze({ posture: 'reviewer', result: 'review-verdict' }),
  'doubt-review': Object.freeze({ posture: 'reviewer', result: 'review-verdict' }),
});

export const ROLE_NAMES = Object.freeze(Object.keys(ROLES));

// The structured verdict schema, carried over from the deleted route adapter.
// Every review role returns exactly this shape or fails typed.
export const REVIEW_VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    findings: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          severity: {
            type: 'string',
            enum: ['Critical', 'Major', 'Minor', 'Suggestion'],
          },
          summary: { type: 'string', minLength: 1, maxLength: 4096 },
          evidence: { type: 'string', maxLength: 16384 },
        },
        required: ['id', 'severity', 'summary', 'evidence'],
        additionalProperties: false,
      },
    },
    rebuts: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        properties: {
          findingId: { type: 'string', minLength: 1, maxLength: 128 },
          status: { type: 'string', enum: ['accepted', 'rejected'] },
          evidence: { type: 'string', minLength: 1, maxLength: 16384 },
        },
        required: ['findingId', 'status', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'findings', 'rebuts'],
  additionalProperties: false,
});

const FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

// The same validator the review contract applies to a recorded round, so a
// verdict that would be rejected downstream is rejected here instead of being
// carried forward as if it were evidence.
export function validReviewVerdict(value) {
  return hasExactKeys(value, ['verdict', 'findings', 'rebuts'])
    && ['pass', 'fail'].includes(value.verdict)
    && Array.isArray(value.findings)
    && value.findings.length <= 100
    && new Set(value.findings.map(({ id }) => id)).size === value.findings.length
    && value.findings.every((finding) =>
      hasExactKeys(finding, ['id', 'severity', 'summary', 'evidence'])
      && FINDING_ID_RE.test(finding.id)
      && ['Critical', 'Major', 'Minor', 'Suggestion'].includes(finding.severity)
      && typeof finding.summary === 'string'
      && finding.summary.length >= 1
      && finding.summary.length <= 4096
      && typeof finding.evidence === 'string'
      && finding.evidence.length <= 16384)
    && Array.isArray(value.rebuts)
    && value.rebuts.length <= 100
    && new Set(value.rebuts.map(({ findingId }) => findingId)).size
      === value.rebuts.length
    && value.rebuts.every((rebut) =>
      hasExactKeys(rebut, ['findingId', 'status', 'evidence'])
      && FINDING_ID_RE.test(rebut.findingId)
      && ['accepted', 'rejected'].includes(rebut.status)
      && typeof rebut.evidence === 'string'
      && rebut.evidence.length >= 1
      && rebut.evidence.length <= 16384)
    && (
      value.verdict === 'pass'
        ? !value.findings.some(({ severity }) =>
          ['Critical', 'Major'].includes(severity))
        : value.findings.some(({ severity }) =>
          ['Critical', 'Major'].includes(severity))
    );
}

function processSettings(tools) {
  return {
    permissions: {
      allow: tools.filter((tool) => TOOLS_REQUIRING_GRANT.includes(tool)),
      deny: [
        'Read(~/.config/gh/**)',
        'Read(~/.git-credentials)',
        'Read(~/.gitconfig)',
        'Read(~/.netrc)',
        'Read(~/.ssh/**)',
      ],
    },
  };
}

// The role's tool ceiling. `requested` may narrow it and can never widen it: a
// tool outside the posture is a usage error, not a silently dropped entry.
export function resolveTools(role, requested = null) {
  const posture = POSTURES[ROLES[role].posture];
  if (requested === null) return [...posture.tools];
  const wanted = requested
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  if (wanted.length === 0) return null;
  if (new Set(wanted).size !== wanted.length) return null;
  if (wanted.some((tool) => !posture.tools.includes(tool))) return null;
  return posture.tools.filter((tool) => wanted.includes(tool));
}

// Pure: the exact argv a dispatch launches, so the self-test can pin the
// posture without spawning anything.
export function dispatchArgv(role, tools) {
  const { posture, result } = ROLES[role];
  return [
    '--print',
    '--safe-mode',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(result === 'review-verdict'
      ? ['--json-schema', JSON.stringify(REVIEW_VERDICT_SCHEMA)]
      : []),
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--settings',
    JSON.stringify(processSettings(tools)),
    '--permission-mode',
    POSTURES[posture].permissionMode,
    '--tools',
    tools.join(','),
  ];
}

// The child inherits this process's environment and nothing is added to it.
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 used to be set here to satisfy the broker
// capability `claude.subprocess.credentials-scrubbed`; v0.42.0 deleted the
// broker, and with it both that predicate and the cleanup that swept the stub
// files scrub mode creates. Setting it now buys nothing and costs three things
// the self-test pins: the child ignores `--permission-mode`, the checkout gains
// seventeen zero-byte stubs nobody removes, and every Bash call dies at sandbox
// start on `/home/.mcp.json`.
function dispatchEnvironment() {
  return { ...process.env };
}

function failure(step, code, message, detail = {}) {
  return { ok: false, step, error: { code, message, ...detail } };
}

// The dispatch log lives in the COMMON Git directory, so every linked worktree
// writes to one file: overlap runs units from separate worktrees and their
// windows have to be comparable. Inside `.git` it can never be committed or
// dirty a tree — the same reasoning `subagent-transcript.mjs` uses.
export function resolveDispatchLogPath(cwd, readCommonDir = (directory) => spawnSync(
  'git',
  ['rev-parse', '--git-common-dir'],
  { cwd: directory, encoding: 'utf8', timeout: 15000 },
).stdout) {
  const raw = String(readCommonDir(cwd) ?? '').trim();
  if (!raw) return null;
  const common = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  return join(common, 'autoloop', 'dispatch-log.jsonl');
}

// One line per dispatch, so a run's idle wall-clock is a measurement rather than
// a claim. Fail-open in every direction: accounting must never cost a dispatch.
function recordDispatchWindow(cwd, entry) {
  try {
    const path = resolveDispatchLogPath(cwd);
    if (path === null) return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // A repo-less cwd, a read-only .git, a race on mkdir — none of it is worth
    // failing a model round trip over.
  }
}

// What the writer is supposed to have moved: the committed history plus the
// working tree. `null` means there is nothing to compare — the cwd is not a Git
// work tree, or carries no commit yet — and this tool does not invent a
// requirement it cannot observe.
function checkoutFingerprint(cwd) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (head.status !== 0) return null;
  const tree = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (tree.status !== 0) return null;
  return `${head.stdout.trim()}\n${tree.stdout}`;
}

// Claude's stream-json output ends with exactly one `result` event. More than
// one, none, or a non-success subtype means the child did not produce a result
// this tool can stand behind.
export function parseResultEvent(stdout) {
  if (typeof stdout !== 'string') return null;
  let resultEvent = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (event?.type !== 'result') continue;
    if (resultEvent !== null) return null;
    resultEvent = event;
  }
  return resultEvent;
}

// Wall clock at module load. `startupMs` on every result is the distance from
// here to the engine spawn — this tool's own overhead, with model time
// excluded — so a regression in the wrapper is visible without a profiler.
const PROCESS_START_MS = Date.now();

// The binary that actually produced the result, reduced to its name. Which host
// reviewed something is a property of the review — a Claude reviewer and an
// external one are not interchangeable evidence — so it is reported from the
// spawn rather than asserted by whoever narrates the round.
function hostName(engine) {
  const value = String(engine ?? 'claude');
  return value.slice(value.lastIndexOf('/') + 1);
}

// Every dispatch — typed success or typed failure alike — contributes its window
// to the log, so idle wall-clock cannot be understated by a run that only counts
// the dispatches that worked.
export function runDispatch(options) {
  const windowStartedAtMs = Date.now();
  const result = executeDispatch(options);
  const engine = hostName(options.engine);
  recordDispatchWindow(options.cwd ?? process.cwd(), {
    role: options.role,
    engine,
    startedAtMs: windowStartedAtMs,
    ms: Date.now() - windowStartedAtMs,
    ok: result.ok === true,
  });
  // Stamped once here so no return path inside the dispatch can omit it.
  return result.ok
    ? { ...result, engine }
    : { ...result, error: { ...result.error, engine } };
}

function executeDispatch({
  role,
  prompt,
  tools,
  cwd = process.cwd(),
  timeoutMs = DISPATCH_TIMEOUT_MS,
  engine = 'claude',
  startedAtMs = PROCESS_START_MS,
}) {
  const argv = dispatchArgv(role, tools);
  const checkoutBefore =
    ROLES[role].posture === 'writer' ? checkoutFingerprint(cwd) : null;
  const started = Date.now();
  const startupMs = started - startedAtMs;
  const result = spawnSync(engine, argv, {
    cwd,
    encoding: 'utf8',
    env: dispatchEnvironment(),
    input: prompt,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const ms = Date.now() - started;
  const stderr = String(result.stderr ?? '');
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    return failure(
      'dispatch',
      'DISPATCH_TIMEOUT',
      `${role}: the engine did not finish within ${timeoutMs}ms`,
      { ms, startupMs, stderr },
    );
  }
  if (result.error) {
    return failure(
      'spawn',
      'ENGINE_SPAWN_FAILED',
      `${role}: ${result.error.message}`,
      { ms, startupMs, stderr },
    );
  }
  if (result.status !== 0) {
    return failure(
      'dispatch',
      'ENGINE_EXIT_NONZERO',
      `${role}: engine exited ${result.status}`,
      { ms, startupMs, exitCode: result.status, stderr },
    );
  }
  const resultEvent = parseResultEvent(result.stdout ?? '');
  if (resultEvent === null || resultEvent.subtype !== 'success') {
    return failure(
      'result',
      'ENGINE_RESULT_MISSING',
      `${role}: the engine produced no single successful result event`,
      { ms, startupMs, stderr },
    );
  }
  if (ROLES[role].result === 'review-verdict') {
    const verdict = resultEvent.structured_output;
    if (!validReviewVerdict(verdict)) {
      return failure(
        'result',
        'INVALID_REVIEW_VERDICT',
        `${role}: structured output is not a valid review verdict`,
        { ms, startupMs, stderr },
      );
    }
    return { ok: true, role, tools, startupMs, ms, verdict };
  }
  const text = typeof resultEvent.result === 'string' ? resultEvent.result : '';
  if (text.length === 0) {
    return failure(
      'result',
      'ENGINE_RESULT_EMPTY',
      `${role}: the engine returned an empty result`,
      { ms, startupMs, stderr },
    );
  }
  if (checkoutBefore !== null && checkoutFingerprint(cwd) === checkoutBefore) {
    return failure(
      'result',
      'WRITER_MADE_NO_CHANGE',
      `${role}: the engine answered but the checkout is unchanged`,
      { ms, startupMs, stderr, text },
    );
  }
  return { ok: true, role, tools, startupMs, ms, text };
}

export function parseArgs(args) {
  const parsed = {
    mode: 'dispatch',
    role: null,
    promptFile: null,
    tools: null,
    outputFile: null,
    json: false,
    error: null,
  };
  if (args.length === 1 && args[0] === '--self-test') {
    return { ...parsed, mode: 'self-test' };
  }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') {
      parsed.json = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ...parsed, error: `${flag}: expected a value` };
    }
    index += 1;
    if (flag === '--role') parsed.role = value;
    else if (flag === '--prompt-file') parsed.promptFile = value;
    else if (flag === '--tools') parsed.tools = value;
    else if (flag === '--output-file') parsed.outputFile = value;
    else return { ...parsed, error: `unknown flag ${flag}` };
  }
  if (parsed.role === null || !ROLE_NAMES.includes(parsed.role)) {
    return {
      ...parsed,
      error: `--role: expected one of ${ROLE_NAMES.join(', ')}`,
    };
  }
  if (parsed.promptFile === null) {
    return { ...parsed, error: '--prompt-file: required' };
  }
  return parsed;
}

function readPrompt(path) {
  const bytes = readFileSync(path === '-' ? 0 : path);
  if (bytes.length === 0) throw new Error('prompt is empty');
  if (bytes.length > MAX_PROMPT_BYTES) {
    throw new Error(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  }
  return bytes.toString('utf8');
}

function report(result) {
  if (result.ok !== true) {
    return [
      `dispatch ${result.step} FAILED  ${result.error.code}`,
      result.error.message,
      ...(result.error.stderr ? [`stderr: ${result.error.stderr.trim()}`] : []),
    ].join('\n');
  }
  const lines = [
    `dispatch ${result.role} ok  ${result.tools.join(',')}  `
    + `${result.ms}ms (${result.startupMs}ms wrapper overhead)`,
  ];
  if (result.verdict) {
    const gating = result.verdict.findings.filter(({ severity }) =>
      ['Critical', 'Major'].includes(severity));
    lines.push(
      `verdict ${result.verdict.verdict}  findings ${result.verdict.findings.length}`
      + ` (${gating.length} gating)  rebuts ${result.verdict.rebuts.length}`,
    );
    for (const finding of result.verdict.findings) {
      lines.push(`  ${finding.severity.padEnd(10)} ${finding.id}  ${finding.summary}`);
    }
  } else {
    lines.push(result.text.length > 2000 ? `${result.text.slice(0, 2000)}…` : result.text);
  }
  return lines.join('\n');
}

// A fake engine on PATH: every posture assertion below runs against a real
// spawn, so the argv this tool builds is the argv the self-test inspects.
function writeEngineShim(directory, body) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'claude');
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return directory;
}

const PASSING_VERDICT = {
  verdict: 'pass',
  findings: [],
  rebuts: [],
};

function shimBody(script) {
  return `#!/bin/sh\nprintf '%s' "$*" > "$AUTOLOOP_SHIM_ARGV"\nenv > "$AUTOLOOP_SHIM_ENV"\ncat > "$AUTOLOOP_SHIM_STDIN"\n${script}\n`;
}

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };

  check(
    'every role maps to exactly one posture',
    ROLE_NAMES.length === 4
    && ROLE_NAMES.every((role) => POSTURES[ROLES[role].posture] !== undefined)
    && ROLES.implement.posture === 'writer'
    && ['plan-review', 'code-review', 'doubt-review']
      .every((role) => ROLES[role].posture === 'reviewer'),
  );

  const writerTools = resolveTools('implement');
  const reviewerTools = resolveTools('code-review');
  check(
    'the writer posture carries the writing tool set',
    writerTools.join(',') === 'Bash,Edit,Glob,Grep,Read,Write',
  );
  check(
    'no reviewer role can ever name a write tool',
    ['plan-review', 'code-review', 'doubt-review'].every((role) => {
      const tools = resolveTools(role);
      return tools.join(',') === 'Glob,Grep,Read'
        && !tools.some((tool) => TOOLS_REQUIRING_GRANT.includes(tool));
    }),
  );
  check(
    '--tools may narrow a posture and can never widen it',
    resolveTools('code-review', 'Read,Grep').join(',') === 'Grep,Read'
    && resolveTools('code-review', 'Read,Write') === null
    && resolveTools('code-review', 'Bash') === null
    && resolveTools('implement', 'Read,Read') === null
    && resolveTools('implement', '') === null
    && resolveTools('implement', 'Edit,Read').join(',') === 'Edit,Read',
  );

  const writerArgv = dispatchArgv('implement', writerTools);
  const reviewerArgv = dispatchArgv('code-review', reviewerTools);
  const argvValue = (argv, flag) => argv[argv.indexOf(flag) + 1];
  check(
    'the writer argv accepts edits and grants only its declared write tools',
    argvValue(writerArgv, '--permission-mode') === 'acceptEdits'
    && argvValue(writerArgv, '--tools') === 'Bash,Edit,Glob,Grep,Read,Write'
    && JSON.parse(argvValue(writerArgv, '--settings')).permissions.allow.join(',')
      === 'Bash,Edit,Write'
    && !writerArgv.includes('--json-schema'),
  );
  check(
    'the reviewer argv plans, declares read-only tools, and grants none',
    argvValue(reviewerArgv, '--permission-mode') === 'plan'
    && argvValue(reviewerArgv, '--tools') === 'Glob,Grep,Read'
    && JSON.parse(argvValue(reviewerArgv, '--settings')).permissions.allow.length === 0
    && JSON.parse(argvValue(reviewerArgv, '--json-schema')).required.join(',')
      === 'verdict,findings,rebuts',
  );
  check(
    'every posture denies ambient credential reads and persists no session',
    [writerArgv, reviewerArgv].every((argv) =>
      argv.includes('--no-session-persistence')
      && argv.includes('--safe-mode')
      && argv.includes('--strict-mcp-config')
      && argv.includes('--disable-slash-commands')
      && JSON.parse(argvValue(argv, '--settings')).permissions.deny
        .includes('Read(~/.ssh/**)')),
  );

  check(
    'a review verdict must be internally consistent to parse',
    validReviewVerdict(PASSING_VERDICT)
    && !validReviewVerdict({
      ...PASSING_VERDICT,
      findings: [{
        id: 'f1', severity: 'Major', summary: 's', evidence: 'e',
      }],
    })
    && validReviewVerdict({
      verdict: 'fail',
      findings: [{ id: 'f1', severity: 'Major', summary: 's', evidence: 'e' }],
      rebuts: [],
    })
    && !validReviewVerdict({ verdict: 'pass', findings: [] })
    && !validReviewVerdict(null),
  );

  check(
    'argument parsing rejects unknown roles, flags, and missing values',
    parseArgs(['--role', 'implement', '--prompt-file', '/p']).error === null
    && parseArgs(['--role', 'refactor', '--prompt-file', '/p']).error !== null
    && parseArgs(['--role', 'implement']).error !== null
    && parseArgs(['--role', 'implement', '--prompt-file', '/p', '--wat', 'x'])
      .error !== null
    && parseArgs(['--role', 'implement', '--prompt-file']).error !== null
    && parseArgs(['--role', 'implement', '--prompt-file', '/p', '--json']).json === true,
  );

  const scratch = mkdtempSync(join(tmpdir(), 'autoloop-dispatch-'));
  try {
    const argvPath = join(scratch, 'argv.txt');
    const stdinPath = join(scratch, 'stdin.txt');
    const envPath = join(scratch, 'env.txt');
    process.env.AUTOLOOP_SHIM_ARGV = argvPath;
    process.env.AUTOLOOP_SHIM_STDIN = stdinPath;
    process.env.AUTOLOOP_SHIM_ENV = envPath;

    const shimDirectory = join(scratch, 'bin');
    const engine = join(shimDirectory, 'claude');
    const resultEvent = (extra) =>
      `printf '%s\\n' '${JSON.stringify({ type: 'result', subtype: 'success', ...extra })}'`;

    writeEngineShim(shimDirectory, shimBody(
      resultEvent({ structured_output: PASSING_VERDICT }),
    ));
    const reviewed = runDispatch({
      role: 'code-review',
      prompt: 'review the delta',
      tools: reviewerTools,
      cwd: scratch,
      engine,
    });
    const launchedArgv = readFileSync(argvPath, 'utf8');
    check(
      'a review dispatch parses the structured verdict and forwards the prompt on stdin',
      reviewed.ok === true
      && reviewed.role === 'code-review'
      && reviewed.verdict.verdict === 'pass'
      && readFileSync(stdinPath, 'utf8') === 'review the delta'
      && launchedArgv.includes('--permission-mode plan')
      && launchedArgv.includes('--tools Glob,Grep,Read'),
    );
    check(
      'a live reviewer spawn never receives a write tool',
      !/--tools \S*(?:Write|Edit|Bash)/.test(launchedArgv),
    );
    // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 made the child ignore
    // `--permission-mode` (claude 2.1.220 prints "Permission mode forced to
    // default"), pre-create seventeen zero-byte stub files in the checkout, and
    // — measured on 0.42.1 — fail every Bash call at sandbox start with
    // "bwrap: Can't create file at /home/.mcp.json: Permission denied", which
    // blocked a live run at 05/11 IMPLEMENT. It was set to satisfy the broker's
    // `claude.subprocess.credentials-scrubbed` capability and the broker cleaned
    // the stubs it caused; v0.42.0 deleted both. Nothing is left but the costs.
    check(
      'the dispatch environment never forces the child out of its posture',
      !readFileSync(envPath, 'utf8')
        .split('\n')
        .some((line) => line.startsWith('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=')),
    );
    check(
      'every result reports the wrapper overhead separately from the engine time',
      Number.isInteger(reviewed.startupMs)
      && reviewed.startupMs >= 0
      && Number.isInteger(reviewed.ms),
    );

    writeEngineShim(shimDirectory, shimBody(
      resultEvent({ result: 'implemented the slice' }),
    ));
    const implemented = runDispatch({
      role: 'implement',
      prompt: 'implement the plan',
      tools: writerTools,
      cwd: scratch,
      engine,
    });
    check(
      'an implement dispatch returns the terminal text and the writing tool set',
      implemented.ok === true
      && implemented.text === 'implemented the slice'
      && readFileSync(argvPath, 'utf8').includes('--permission-mode acceptEdits'),
    );

    // `ok` for a review role means a schema-valid verdict. For the writer it
    // meant only that the engine answered, so an implement whose sandbox never
    // started returned `ok: true` carrying its own error as prose — which is how
    // a live 0.42.1 run reported a no-op implement as a success. The checkout is
    // the evidence the envelope lacks.
    const repoScratch = mkdtempSync(join(tmpdir(), 'autoloop-dispatch-repo-'));
    spawnSync('git', ['init', '-q', '-b', 'main', repoScratch]);
    spawnSync(
      'git',
      [
        '-c',
        'user.name=Base',
        '-c',
        'user.email=base@example.invalid',
        'commit',
        '--allow-empty',
        '-q',
        '-m',
        'base',
      ],
      { cwd: repoScratch },
    );
    writeEngineShim(shimDirectory, shimBody(
      resultEvent({ result: 'claimed to implement the slice' }),
    ));
    const idleWriter = runDispatch({
      role: 'implement',
      prompt: 'implement the plan',
      tools: writerTools,
      cwd: repoScratch,
      engine,
    });
    check(
      'an implement that leaves the checkout untouched is a typed failure',
      idleWriter.ok === false
      && idleWriter.step === 'result'
      && idleWriter.error.code === 'WRITER_MADE_NO_CHANGE',
    );
    writeEngineShim(shimDirectory, shimBody(
      `printf 'work\\n' > implemented.txt\n${resultEvent({ result: 'implemented the slice' })}`,
    ));
    const busyWriter = runDispatch({
      role: 'implement',
      prompt: 'implement the plan',
      tools: writerTools,
      cwd: repoScratch,
      engine,
    });
    check(
      'an implement that moves the checkout still succeeds',
      busyWriter.ok === true && busyWriter.text === 'implemented the slice',
    );
    // Overlap accounting is only trustworthy if it is measured rather than
    // narrated: the 0.39 `overlap:` line was self-reported, and the behaviour it
    // described died in v0.40.0 without anyone noticing for three minor
    // versions. Every dispatch records its own window here instead.
    const logPath = join(repoScratch, '.git', 'autoloop', 'dispatch-log.jsonl');
    const logged = existsSync(logPath)
      ? readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      : [];
    check(
      'a result names the host that produced it',
      busyWriter.engine === 'claude' && idleWriter.error.engine === 'claude',
    );
    check(
      'every dispatch records its own window in the dispatch log',
      logged.length === 2
      && logged.every((entry) =>
        entry.role === 'implement'
        && Number.isSafeInteger(entry.startedAtMs)
        && entry.startedAtMs > 0
        && Number.isSafeInteger(entry.ms)
        && entry.ms >= 0
        && entry.engine === 'claude'
        && typeof entry.ok === 'boolean')
      && logged[0].ok === false
      && logged[1].ok === true,
    );
    rmSync(repoScratch, { recursive: true, force: true });

    writeEngineShim(shimDirectory, shimBody(
      resultEvent({ structured_output: { verdict: 'maybe' } }),
    ));
    const malformed = runDispatch({
      role: 'code-review',
      prompt: 'review',
      tools: reviewerTools,
      cwd: scratch,
      engine,
    });
    check(
      'a malformed structured verdict is a typed failure, never a pass',
      malformed.ok === false
      && malformed.step === 'result'
      && malformed.error.code === 'INVALID_REVIEW_VERDICT',
    );

    writeEngineShim(shimDirectory, shimBody("printf 'no result event\\n'"));
    const resultless = runDispatch({
      role: 'implement',
      prompt: 'implement',
      tools: writerTools,
      cwd: scratch,
      engine,
    });
    check(
      'a missing result event is a typed failure',
      resultless.ok === false
      && resultless.error.code === 'ENGINE_RESULT_MISSING',
    );

    writeEngineShim(shimDirectory, shimBody(
      "printf 'engine blew up\\n' >&2\nexit 3",
    ));
    const exited = runDispatch({
      role: 'implement',
      prompt: 'implement',
      tools: writerTools,
      cwd: scratch,
      engine,
    });
    check(
      'a non-zero exit is typed and preserves the child stderr',
      exited.ok === false
      && exited.step === 'dispatch'
      && exited.error.code === 'ENGINE_EXIT_NONZERO'
      && exited.error.exitCode === 3
      && exited.error.stderr.includes('engine blew up'),
    );

    writeEngineShim(shimDirectory, shimBody('sleep 30'));
    const timedOut = runDispatch({
      role: 'implement',
      prompt: 'implement',
      tools: writerTools,
      cwd: scratch,
      engine,
      timeoutMs: 250,
    });
    check(
      'exceeding the budget is a typed timeout, never a silent success',
      timedOut.ok === false
      && timedOut.step === 'dispatch'
      && timedOut.error.code === 'DISPATCH_TIMEOUT',
    );

    writeEngineShim(shimDirectory, shimBody('exit 0'));
    const missingEngine = runDispatch({
      role: 'implement',
      prompt: 'implement',
      tools: writerTools,
      cwd: scratch,
      engine: join(shimDirectory, 'not-installed'),
    });
    check(
      'an absent engine is a typed spawn failure',
      missingEngine.ok === false
      && missingEngine.step === 'spawn'
      && missingEngine.error.code === 'ENGINE_SPAWN_FAILED',
    );

    check(
      'a failing dispatch reports its typed error without a verdict',
      report(exited).includes('ENGINE_EXIT_NONZERO')
      && report(reviewed).includes('verdict pass'),
    );
  } finally {
    delete process.env.AUTOLOOP_SHIM_ARGV;
    delete process.env.AUTOLOOP_SHIM_STDIN;
    rmSync(scratch, { recursive: true, force: true });
  }

  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(
    failures.length === 0
      ? `self-test OK (${cases.length} cases)`
      : `self-test FAILED (${failures.length}/${cases.length})`,
  );
  return failures.length === 0;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`dispatch: ${parsed.error}`);
    console.error(
      'usage: dispatch.mjs --role <'
      + `${ROLE_NAMES.join('|')}> --prompt-file <path|-> `
      + '[--tools <csv>] [--output-file <path>] [--json]',
    );
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);

  const tools = resolveTools(parsed.role, parsed.tools);
  if (tools === null) {
    console.error(
      `dispatch: --tools must be a distinct non-empty subset of the ${parsed.role} `
      + `posture (${POSTURES[ROLES[parsed.role].posture].tools.join(',')})`,
    );
    process.exit(2);
  }
  let prompt;
  try {
    prompt = readPrompt(parsed.promptFile);
  } catch (error) {
    console.error(`dispatch: unable to read the prompt: ${error.message}`);
    process.exit(2);
  }

  const result = runDispatch({ role: parsed.role, prompt, tools });
  const serialized = `${JSON.stringify(result, null, 1)}\n`;
  if (parsed.outputFile !== null) {
    const path = resolve(parsed.outputFile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized);
  }
  process.stdout.write(parsed.json ? serialized : `${report(result)}\n`);
  process.exit(result.ok === true ? 0 : 1);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url))
      === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
