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
//   node tools/agentic/dispatch.mjs --role <plan|plan-review|implement|code-review|doubt-review> \
//     --prompt-file <path> [--tools <csv>] [--output-file <path>] [--json]
//   node tools/agentic/dispatch.mjs --self-test
//
// Exit 0 on a typed success, 1 on a typed failure, 2 on a usage error.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
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

// Both CLIs expose the same reasoning ladder under different spellings: claude
// takes `--effort <level>`, codex the `model_reasoning_effort` config override.
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

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
  plan: Object.freeze({ posture: 'reviewer', result: 'plan' }),
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

// The plan a dispatched planner returns, in exactly the shape the lifecycle
// driver's request wants: `title` printable-ASCII like the driver's own check,
// `body` the frozen plan the orchestrator hashes, `prBody` carrying the claim.
export const PLAN_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 256 },
    prBody: { type: 'string', minLength: 1, maxLength: 65535 },
    body: { type: 'string', minLength: 1, maxLength: 65535 },
  },
  required: ['title', 'prBody', 'body'],
  additionalProperties: false,
});

// Names the field and the reason, because "not a valid plan" made a live run
// spend ~40 minutes of opus rediscovering that an em-dash in the TITLE was the
// whole problem. A model writing in this repository's own prose style hits the
// ASCII rule naturally.
export function planResultProblem(value) {
  if (!isPlainObject(value)) return 'result is not an object';
  if (!hasExactKeys(value, ['title', 'prBody', 'body'])) {
    return `keys must be exactly title, prBody, body (got ${
      Object.keys(value).sort().join(', ') || 'none'})`;
  }
  for (const field of ['title', 'prBody', 'body']) {
    if (typeof value[field] !== 'string') return `${field} must be a string`;
  }
  if (value.title.length < 1 || value.title.length > 256) {
    return `title must be 1-256 characters (got ${value.title.length})`;
  }
  const offending = [...value.title].filter((char) => !/^[\x20-\x7e]$/.test(char));
  if (offending.length > 0) {
    return `title must be printable ASCII only; replace ${
      [...new Set(offending)].map((char) =>
        `${JSON.stringify(char)} (U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`)
        .join(', ')}`;
  }
  for (const field of ['prBody', 'body']) {
    if (value[field].length < 1) return `${field} must not be empty`;
    if (value[field].length > 65535) {
      return `${field} must be at most 65535 characters (got ${value[field].length})`;
    }
  }
  return null;
}

// True when every field holds. Kept as the boolean predicate callers already use.
export function validPlanResult(value) {
  return planResultProblem(value) === null;
}

// A title that is merely non-ASCII is the ONE problem the caller can fix without
// paying for the dispatch again: composing the title from a safe allowlist is the
// orchestrator's job, and the body — the expensive artifact — is the model's.
// Discarding a sound 48 KB body over a punctuation mark in a field the
// orchestrator is supposed to author anyway inverts that split.
export function planIsSalvageableByRetitling(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ['title', 'prBody', 'body'])) return false;
  const problem = planResultProblem(value);
  return problem !== null && problem.startsWith('title must be printable ASCII');
}

const RESULT_SCHEMAS = Object.freeze({
  'review-verdict': REVIEW_VERDICT_SCHEMA,
  plan: PLAN_SCHEMA,
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
    ...(RESULT_SCHEMAS[result] !== undefined
      ? ['--json-schema', JSON.stringify(RESULT_SCHEMAS[result])]
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

// Two engines, chosen by the binary's own name so a fixture shim on a path and
// an installed binary resolve the same way.
//
// Reviews run on a different engine from the writer on purpose. A reviewer
// sharing the writer's model shares its priors and its blind spots; a fresh
// process gives identity separation but not cognitive separation. Codex supplies
// the second, and `--sandbox read-only` is an OS-enforced boundary rather than a
// tool allowlist, so the reviewer's read-only posture is stronger there than it
// is under Claude.
const ENGINES = Object.freeze({
  claude: Object.freeze({
    supports: (role) => ROLES[role] !== undefined,
    argv: (role, tools, scratch, cwd, model, effort) => [
      ...dispatchArgv(role, tools),
      ...(model === null ? [] : ['--model', model]),
      ...(effort === null ? [] : ['--effort', effort]),
    ],
    // Claude's stream-json ends with exactly one `result` event.
    payload: (role, stdout) => {
      const event = parseResultEvent(stdout);
      if (event === null || event.subtype !== 'success') return null;
      return RESULT_SCHEMAS[ROLES[role].result] !== undefined
        ? { structured: event.structured_output }
        : { text: typeof event.result === 'string' ? event.result : '' };
    },
  }),
  codex: Object.freeze({
    // Verdict roles only, and refused rather than approximated: a writing role
    // would need a writable sandbox and a commit contract this tool does not
    // model, and `plan` is AUTHORED work — it shares the reviewer posture for
    // sandboxing, not for identity, so handing it to the second engine would
    // invert the standing role split (Claude writes, codex reviews).
    supports: (role) => ROLES[role]?.result === 'review-verdict',
    argv: (role, tools, scratch, cwd, model, effort) => {
      writeFileSync(
        join(scratch, 'schema.json'),
        JSON.stringify(RESULT_SCHEMAS[ROLES[role].result] ?? REVIEW_VERDICT_SCHEMA),
      );
      return [
        'exec',
        ...(model === null ? [] : ['-m', model]),
        // codex has no --effort flag; the same knob is a config override.
        ...(effort === null ? [] : ['-c', `model_reasoning_effort="${effort}"`]),
        '--json',
        '--output-schema',
        join(scratch, 'schema.json'),
        '-o',
        join(scratch, 'last.json'),
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--skip-git-repo-check',
        '-C',
        cwd,
      ];
    },
    // Codex writes its final message to the --output-last-message file, so the
    // verdict is read from disk instead of recovered from an event stream.
    payload: (role, stdout, scratch) => {
      try {
        return { structured: JSON.parse(readFileSync(join(scratch, 'last.json'), 'utf8')) };
      } catch {
        return null;
      }
    },
  }),
});

// The orchestrating host is the default for every role. Running reviews on a
// second engine is a real choice with real cost — another CLI to install and
// authenticate, another vendor in the loop — so it is opt-in at the invocation
// (`/autoloop:dev with codex`) and passed through as `--engine`, never assumed.
// v0.44.0 defaulted reviewers to codex and was wrong to: it made an absent codex
// break a plain run that had asked for nothing unusual.
export function defaultEngineFor() {
  return 'claude';
}

// The invocation's engine choice, made durable. `with codex` is prose at the
// top of a session; by the first reviewer dispatch it is forty minutes and a
// hundred thousand tokens up-context, the tool default is the host engine, and
// a forgotten `--engine` silently reviews on the writer's own model — with
// nothing on the line to say so. The skill records the choice once, in
// `autoloop/review-engine` beside the dispatch log, and this tool reads it per
// dispatch. Reviewer roles only: the writer stays on the host in every mode,
// and an unrecognised or absent recording falls back to the host engine.
// The recording is one line: `<engine>` or `<engine> <model>`. The second token
// serves the proxy mode — reviews on the claude HARNESS but a proxied model
// (`claude gpt-5.6-sol`), which keeps structured output and live streaming
// while decorrelating the reviewer model from the writer. Reviewer roles only,
// and an unrecognised engine discards the whole line.
function recordedReviewChoice(cwd) {
  try {
    const logPath = resolveDispatchLogPath(cwd);
    if (logPath === null) return null;
    const recorded = readFileSync(join(dirname(logPath), 'review-engine'), 'utf8').trim();
    const [engine, ...rest] = recorded.split(/\s+/).filter(Boolean);
    if (ENGINES[engine] === undefined) return null;
    let model = null;
    let baseUrl = null;
    let effort = null;
    for (const token of rest) {
      if (token.startsWith('@')) {
        if (baseUrl !== null || !/^@https?:\/\/\S+$/u.test(token)) return null;
        baseUrl = token.slice(1);
      } else if (token.startsWith('!')) {
        if (effort !== null || !EFFORTS.has(token.slice(1))) return null;
        effort = token.slice(1);
      } else if (model === null) {
        model = token;
      } else {
        return null;
      }
    }
    return { engine, model, baseUrl, effort };
  } catch {
    return null;
  }
}

// Verdict roles, not reviewer POSTURE: `plan` sits in the reviewer posture so
// its sandbox is read-only, but its result is authored work, and a live run
// proved the difference matters — a recorded `claude gpt-5.6-sol` review proxy
// silently moved PLANNING onto the review model. The plan stays on the host
// engine and model exactly like implement; only verdicts follow the recording.
function followsReviewChoice(role) {
  return ROLES[role]?.result === 'review-verdict';
}

export function resolveDefaultEngine(role, cwd) {
  if (!followsReviewChoice(role)) return 'claude';
  return recordedReviewChoice(cwd)?.engine ?? 'claude';
}

export function resolveDefaultModel(role, cwd) {
  if (!followsReviewChoice(role)) return null;
  return recordedReviewChoice(cwd)?.model ?? null;
}

// A recorded `@<url>` routes proxied review dispatches to the proxy DIRECTLY:
// the dispatch injects ANTHROPIC_BASE_URL into the reviewer child, so proxy
// mode no longer depends on how the host session happened to be launched — a
// live run refused a healthy proxy because the SESSION lacked the variable.
// Writer roles never read the recording, so a writer can never be proxied.
export function resolveDefaultBaseUrl(role, cwd) {
  if (!followsReviewChoice(role)) return null;
  return recordedReviewChoice(cwd)?.baseUrl ?? null;
}

// A recorded `!<level>` pins reviewer reasoning effort: review is the step where
// depth converts directly into rounds not spent.
export function resolveDefaultEffort(role, cwd) {
  if (!followsReviewChoice(role)) return null;
  return recordedReviewChoice(cwd)?.effort ?? null;
}

function resolveEngine(binary) {
  return ENGINES[hostName(binary)] ?? null;
}

// The child inherits this process's environment and nothing is added to it.
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 used to be set here to satisfy the broker
// capability `claude.subprocess.credentials-scrubbed`; v0.42.0 deleted the
// broker, and with it both that predicate and the cleanup that swept the stub
// files scrub mode creates. Setting it now buys nothing and costs three things
// the self-test pins: the child ignores `--permission-mode`, the checkout gains
// seventeen zero-byte stubs nobody removes, and every Bash call dies at sandbox
// start on `/home/.mcp.json`.
function dispatchEnvironment(baseUrl = null) {
  return {
    ...process.env,
    ...(baseUrl === null ? {} : { ANTHROPIC_BASE_URL: baseUrl }),
  };
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

// The revision under dispatch is MACHINE-SUPPLIED, never typed into a prompt.
// A live orchestrator hand-transcribed a head OID, invented one character, and
// the reviewer correctly refused to attach a verdict to a revision it could not
// match — ten minutes of reviewer time for a typo no human should have been
// asked to avoid. Every prompt therefore ends with a stamp dispatch derived
// itself from the checkout it is about to launch in, and the skill makes that
// stamp the only authority for the reviewed head.
// Fail-open: an unreadable checkout appends nothing rather than failing a
// dispatch that would otherwise have run.
export function dispatchContextStamp(cwd, role, readCheckout = checkoutFingerprint) {
  const fingerprint = readCheckout(cwd);
  if (fingerprint === null) return '';
  const [head, ...rest] = fingerprint.split('\n');
  if (!/^[0-9a-f]{40}$/u.test(head)) return '';
  const clean = rest.join('\n').trim().length === 0;
  return '\n\n<!-- autoloop-dispatch-context-v1\n'
    + `role: ${role}\n`
    + `revision: ${head}\n`
    + `checkout: ${clean ? 'clean' : 'dirty'}\n`
    + 'This stamp is written by dispatch.mjs from the checkout it launched in.\n'
    + 'It is the authority for the revision under review; a revision named\n'
    + 'anywhere else in this prompt that disagrees with it is a transcription\n'
    + 'error, and this stamp wins.\n-->\n';
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
  const cwd = options.cwd ?? process.cwd();
  const engineBinary = options.engine ?? resolveDefaultEngine(options.role, cwd);
  const resolvedModel = options.model ?? resolveDefaultModel(options.role, cwd);
  const resolvedEffort = options.effort ?? resolveDefaultEffort(options.role, cwd);
  const result = executeDispatch({
    ...options,
    engine: engineBinary,
    model: resolvedModel,
    effort: resolvedEffort,
  });
  const engine = hostName(engineBinary);
  const model = resolvedModel;
  const effort = resolvedEffort;
  recordDispatchWindow(options.cwd ?? process.cwd(), {
    role: options.role,
    engine,
    ...(model === null ? {} : { model }),
    ...(effort === null ? {} : { effort }),
    startedAtMs: windowStartedAtMs,
    ms: Date.now() - windowStartedAtMs,
    ok: result.ok === true,
  });
  // Stamped once here so no return path inside the dispatch can omit it.
  return result.ok
    ? {
      ...result,
      engine,
      ...(model === null ? {} : { model }),
      ...(effort === null ? {} : { effort }),
    }
    : {
      ...result,
      error: {
        ...result.error,
        engine,
        ...(model === null ? {} : { model }),
        ...(effort === null ? {} : { effort }),
      },
    };
}

function executeDispatch(options) {
  const {
    role,
    prompt,
    tools,
    cwd = process.cwd(),
    timeoutMs = DISPATCH_TIMEOUT_MS,
    engine = 'claude',
    startedAtMs = PROCESS_START_MS,
  } = options;
  const adapter = resolveEngine(engine);
  if (adapter === null) {
    return failure('spawn', 'ENGINE_UNKNOWN', `${role}: unknown engine ${hostName(engine)}`, {
      ms: 0,
      startupMs: 0,
      stderr: '',
    });
  }
  if (!adapter.supports(role)) {
    return failure(
      'spawn',
      'ENGINE_ROLE_UNSUPPORTED',
      `${role}: ${hostName(engine)} does not run this role`,
      { ms: 0, startupMs: 0, stderr: '' },
    );
  }
  // Only the engines that need side files get a scratch directory, and it is
  // removed on every path out.
  const scratch = mkdtempSync(join(tmpdir(), 'autoloop-dispatch-io-'));
  try {
    return runEngine({
      adapter, role, prompt, tools, cwd, timeoutMs, engine, startedAtMs, scratch,
      liveFile: options.liveFile ?? null,
      model: options.model ?? null,
      effort: options.effort ?? null,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Engine stdout goes to disk as the engine emits it, so a running dispatch can
// be watched: `tail -f` the newest file under `autoloop/dispatch-live/` in the
// common Git directory. A 13-minute codex review used to run as a sealed box —
// spawnSync buffered the stream in memory and --ephemeral persisted nothing.
// Fail-open: when the live file cannot be opened, the stream stays in memory
// and the dispatch proceeds exactly as before.
const LIVE_KEEP_FILES = 20;

function openLiveEventLog(cwd, role, chosenPath = null) {
  try {
    let path = chosenPath;
    if (path === null) {
      const logPath = resolveDispatchLogPath(cwd);
      if (logPath === null) return null;
      const directory = join(dirname(logPath), 'dispatch-live');
      mkdirSync(directory, { recursive: true });
      for (const stale of readdirSync(directory).sort().slice(0, -(LIVE_KEEP_FILES - 1))) {
        try { unlinkSync(join(directory, stale)); } catch { /* pruning is best-effort */ }
      }
      path = join(directory, `${Date.now()}-${role}.jsonl`);
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    const fd = openSync(path, 'w');
    // stderr, so a backgrounded caller sees where to tail before results exist.
    process.stderr.write(`dispatch: live engine events -> ${path}\n`);
    return { fd, path };
  } catch {
    return null;
  }
}

function runEngine({
  adapter, role, prompt, tools, cwd, timeoutMs, engine, startedAtMs, scratch, liveFile, model,
  effort,
}) {
  const argv = adapter.argv(role, tools, scratch, cwd, model ?? null, effort ?? null);
  const checkoutBefore =
    ROLES[role].posture === 'writer' ? checkoutFingerprint(cwd) : null;
  const live = openLiveEventLog(cwd, role, liveFile ?? null);
  const started = Date.now();
  const startupMs = started - startedAtMs;
  let result;
  try {
    result = spawnSync(engine, argv, {
      cwd,
      encoding: 'utf8',
      env: dispatchEnvironment(
        adapter === ENGINES.claude ? resolveDefaultBaseUrl(role, cwd) : null,
      ),
      input: `${prompt}${dispatchContextStamp(cwd, role)}`,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: timeoutMs,
      windowsHide: true,
      ...(live === null ? {} : { stdio: ['pipe', live.fd, 'pipe'] }),
    });
  } finally {
    if (live !== null) closeSync(live.fd);
  }
  if (live !== null && result.stdout == null) {
    try {
      result.stdout = readFileSync(live.path, 'utf8');
    } catch {
      result.stdout = '';
    }
  }
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
  const payload = adapter.payload(role, result.stdout ?? '', scratch);
  if (payload === null) {
    return failure(
      'result',
      'ENGINE_RESULT_MISSING',
      `${role}: the engine produced no single successful result`,
      { ms, startupMs, stderr },
    );
  }
  if (ROLES[role].result === 'review-verdict') {
    const verdict = payload.structured;
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
  if (ROLES[role].result === 'plan') {
    const plan = payload.structured;
    const problem = planResultProblem(plan);
    if (problem !== null) {
      const salvageable = planIsSalvageableByRetitling(plan);
      return failure(
        'result',
        salvageable ? 'INVALID_PLAN_TITLE' : 'INVALID_PLAN_RESULT',
        `${role}: ${problem}`,
        {
          ms,
          startupMs,
          stderr,
          ...(salvageable
            ? {
              // The body is sound and cost real time. Compose a compliant ASCII
              // title yourself and proceed — do NOT re-run the dispatch.
              rejectedPlan: plan,
            }
            : {}),
        },
      );
    }
    return { ok: true, role, tools, startupMs, ms, plan };
  }
  const text = typeof payload.text === 'string' ? payload.text : '';
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
    engine: null,
    model: null,
    effort: null,
    liveFile: null,
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
    if (flag === '--engine') parsed.engine = value;
    else if (flag === '--model') parsed.model = value;
    else if (flag === '--effort') parsed.effort = value;
    else if (flag === '--live-file') parsed.liveFile = value;
    else if (flag === '--role') parsed.role = value;
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
  if (parsed.effort !== null && !EFFORTS.has(parsed.effort)) {
    return {
      ...parsed,
      error: `--effort: expected one of ${[...EFFORTS].join(', ')}`,
    };
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
function writeEngineShim(directory, body, name = 'claude') {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
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
    ROLE_NAMES.length === 5
    && ROLE_NAMES.every((role) => POSTURES[ROLES[role].posture] !== undefined)
    && ROLES.implement.posture === 'writer'
    && ['plan', 'plan-review', 'code-review', 'doubt-review']
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
    // Codex is the reviewer engine: a reviewer sharing the writer's model shares
    // its blind spots, so the decorrelation has to be structural. Its result
    // arrives in the --output-last-message file rather than an event stream,
    // which is a cleaner contract than parsing stdout for a single event.
    const codexShimDirectory = join(scratch, 'codexbin');
    writeEngineShim(codexShimDirectory, [
      '#!/bin/sh',
      'printf \'%s\' "$*" > "$AUTOLOOP_SHIM_ARGV"',
      'env > "$AUTOLOOP_SHIM_ENV"',
      'cat > "$AUTOLOOP_SHIM_STDIN"',
      'out=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done',
      'printf \'%s\' \'{"verdict":"pass","findings":[],"rebuts":[]}\' > "$out"',
      'printf \'%s\\n\' \'{"type":"turn.completed"}\'',
      '',
    ].join('\n'), 'codex');
    const codexReviewed = runDispatch({
      role: 'plan-review',
      prompt: 'review the plan',
      tools: reviewerTools,
      cwd: repoScratch,
      engine: join(codexShimDirectory, 'codex'),
    });
    const codexArgvLaunched = readFileSync(argvPath, 'utf8');
    check(
      'a codex review returns the verdict from its output-last-message file',
      codexReviewed.ok === true
      && codexReviewed.verdict.verdict === 'pass'
      && codexReviewed.engine === 'codex',
    );
    check(
      'a codex reviewer runs under an OS read-only sandbox, not a tool allowlist',
      codexArgvLaunched.includes('exec')
      && codexArgvLaunched.includes('--sandbox read-only')
      && codexArgvLaunched.includes('--output-schema')
      && !codexArgvLaunched.includes('--permission-mode'),
    );
    check(
      'codex refuses a writing role rather than pretending to sandbox it',
      runDispatch({
        role: 'implement',
        prompt: 'x',
        tools: writerTools,
        cwd: repoScratch,
        engine: join(codexShimDirectory, 'codex'),
      }).error?.code === 'ENGINE_ROLE_UNSUPPORTED',
    );
    check(
      'codex refuses to author a plan, which is writing under a reading posture',
      runDispatch({
        role: 'plan',
        prompt: 'x',
        tools: reviewerTools,
        cwd: repoScratch,
        engine: join(codexShimDirectory, 'codex'),
      }).error?.code === 'ENGINE_ROLE_UNSUPPORTED',
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
    // The invocation's engine choice must survive 40 minutes of context: `with
    // codex` was prose, the tool default is claude, and a forgotten --engine at
    // step 8 silently reviewed on the writer's model. The choice is now a file
    // the skill writes at run start and this tool reads per dispatch.
    const engineFile = join(repoScratch, '.git', 'autoloop', 'review-engine');
    mkdirSync(dirname(engineFile), { recursive: true });
    writeFileSync(engineFile, 'codex\n');
    check(
      'the CLI passes --engine and --live-file through to the dispatch',
      // The flags parsed clean since 0.44.0 and were dropped at this exact
      // seam: main() built runDispatch options from role/prompt/tools only.
      // Every self-test called runDispatch directly, so a live loop found it
      // first — a review requested on codex silently ran claude, labeled
      // [CODEX] by a banner that trusted the flag. This case goes through the
      // real argv boundary: a PATH holding ONLY a codex shim, so if the engine
      // is dropped the claude fallback cannot even spawn.
      (() => {
        const cliDir = join(scratch, 'cli-seam');
        mkdirSync(cliDir, { recursive: true });
        const codexOnly = join(cliDir, 'bin');
        writeEngineShim(codexOnly, [
          '#!/bin/sh',
          'printf \'%s\' "$*" > "$AUTOLOOP_SHIM_ARGV"',
          'cat > /dev/null',
          'out=""; prev=""',
          'for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done',
          `printf '%s' '${JSON.stringify(PASSING_VERDICT)}' > "$out"`,
          'printf \'{"type":"turn.completed"}\\n\'',
          '',
        ].join('\n'), 'codex');
        const promptPath = join(cliDir, 'p.md');
        writeFileSync(promptPath, 'review');
        const chosen = join(cliDir, 'cli-live.jsonl');
        const run = spawnSync(process.execPath, [
          fileURLToPath(import.meta.url),
          '--role', 'plan-review',
          '--prompt-file', promptPath,
          '--engine', 'codex',
          '--model', 'gpt-test-model',
          '--live-file', chosen,
          '--json',
        ], {
          cwd: repoScratch,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${codexOnly}:${process.env.PATH}` },
        });
        const argvSeen = readFileSync(argvPath, 'utf8');
        let cliResult;
        try {
          cliResult = JSON.parse(run.stdout);
        } catch {
          return false; // usage error: empty stdout is a failed check, not a crash
        }
        return run.status === 0
          && argvSeen.includes('--sandbox read-only')
          // --model crosses the same seam --engine once fell through:
          // codex spells it -m.
          && argvSeen.includes('-m gpt-test-model')
          && existsSync(chosen)
          && cliResult.engine === 'codex'
          && cliResult.model === 'gpt-test-model';
      })(),
    );
    check(
      'a plan dispatch returns the typed plan and is read-only postured',
      (() => {
        writeEngineShim(shimDirectory, shimBody(
          resultEvent({ structured_output: {
            title: 'feat: enforce replay cadence',
            prBody: 'Closes #7',
            body: '## Plan\n\n1. slice one',
          } }),
        ));
        const planned = runDispatch({
          role: 'plan',
          prompt: 'plan issue #7',
          tools: resolveTools('plan'),
          cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
        });
        const argvSeen = readFileSync(argvPath, 'utf8');
        return planned.ok === true
          && planned.plan.title === 'feat: enforce replay cadence'
          && planned.plan.prBody === 'Closes #7'
          && argvSeen.includes('--permission-mode plan')
          && !/--tools \S*(?:Write|Edit|Bash)/.test(argvSeen)
          && argvSeen.includes('--json-schema');
      })(),
    );
    check(
      'a malformed plan is a typed failure, not evidence',
      (() => {
        writeEngineShim(shimDirectory, shimBody(
          resultEvent({ structured_output: { title: '', prBody: '', body: '' } }),
        ));
        const bad = runDispatch({
          role: 'plan',
          prompt: 'plan issue #7',
          tools: resolveTools('plan'),
          cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
        });
        return bad.ok === false && bad.error.code === 'INVALID_PLAN_RESULT';
      })(),
    );
    check(
      'a pinned model reaches the claude argv and the typed result',
      (() => {
        writeEngineShim(shimDirectory, shimBody(
          resultEvent({ structured_output: PASSING_VERDICT }),
        ));
        const pinned = runDispatch({
          role: 'plan-review',
          prompt: 'review',
          tools: reviewerTools,
          cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
          model: 'opus-test',
        });
        return pinned.ok === true
          && pinned.model === 'opus-test'
          && readFileSync(argvPath, 'utf8').includes('--model opus-test');
      })(),
    );
    check(
      'a caller-named live file receives the event stream at that exact path',
      // The auto-named live file cannot be tailed in advance — its name has a
      // timestamp in it. A caller that wants a watcher (a `tail -F` background
      // shell in the host UI) names the path first and arms the tail before
      // the dispatch starts.
      (() => {
        const chosen = join(repoScratch, 'chosen-live.jsonl');
        writeEngineShim(shimDirectory, shimBody(
          resultEvent({ structured_output: PASSING_VERDICT }),
        ));
        const routed = runDispatch({
          role: 'plan-review',
          prompt: 'review',
          tools: reviewerTools,
          cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
          liveFile: chosen,
        });
        return routed.ok === true
          && existsSync(chosen)
          && readFileSync(chosen, 'utf8').includes('"type"');
      })(),
    );
    check(
      'a dispatch streams its engine events to a live file while running',
      // A 13-minute codex review ran as a sealed box: spawnSync buffered the
      // event stream in memory and --ephemeral persisted nothing, so there was
      // nothing to tail. Events now land on disk as the engine emits them.
      (() => {
        const liveDir = join(repoScratch, '.git', 'autoloop', 'dispatch-live');
        if (!existsSync(liveDir)) return false;
        const files = readdirSync(liveDir);
        return files.length > 0
          && files.every((name) => /-(?:plan|implement|plan-review|code-review|doubt-review)\.jsonl$/.test(name))
          && readFileSync(join(liveDir, files[0]), 'utf8').includes('"type"');
      })(),
    );
    check(
      'a recorded review-engine choice routes verdict-role defaults only',
      resolveDefaultEngine('plan-review', repoScratch) === 'codex'
      && resolveDefaultEngine('code-review', repoScratch) === 'codex'
      && resolveDefaultEngine('implement', repoScratch) === 'claude'
      // The plan is authored work: it never follows the review recording.
      && resolveDefaultEngine('plan', repoScratch) === 'claude',
    );
    check(
      'a recorded engine may carry a model, routing proxied reviews',
      (() => {
        writeFileSync(engineFile, 'claude gpt-5.6-sol\n');
        return resolveDefaultEngine('code-review', repoScratch) === 'claude'
          && resolveDefaultModel('code-review', repoScratch) === 'gpt-5.6-sol'
          && resolveDefaultModel('implement', repoScratch) === null
          // A live run planned on the review proxy model; the plan stays on
          // the host model like the writer.
          && resolveDefaultModel('plan', repoScratch) === null
          && resolveDefaultBaseUrl('plan', repoScratch) === null
          && resolveDefaultEffort('plan', repoScratch) === null;
      })(),
    );
    check(
      'a bare recorded engine carries no model',
      (() => {
        writeFileSync(engineFile, 'codex\n');
        return resolveDefaultModel('code-review', repoScratch) === null;
      })(),
    );
    check(
      'a recorded proxy URL is injected into reviewer dispatches only',
      (() => {
        writeFileSync(engineFile, 'claude gpt-5.6-sol @http://127.0.0.1:18765\n');
        if (
          resolveDefaultBaseUrl('code-review', repoScratch) !== 'http://127.0.0.1:18765'
          || resolveDefaultBaseUrl('implement', repoScratch) !== null
          || resolveDefaultBaseUrl('plan', repoScratch) !== null
          || resolveDefaultModel('code-review', repoScratch) !== 'gpt-5.6-sol'
        ) {
          return false;
        }
        writeEngineShim(shimDirectory, shimBody(
          resultEvent({ structured_output: PASSING_VERDICT }),
        ));
        const proxied = runDispatch({
          role: 'code-review',
          prompt: 'review',
          tools: reviewerTools,
          cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
        });
        return proxied.ok === true
          && readFileSync(envPath, 'utf8')
            .includes('ANTHROPIC_BASE_URL=http://127.0.0.1:18765');
      })(),
    );
    check(
      'every dispatch stamps the checkout revision it launched in onto the prompt',
      (() => {
        writeEngineShim(shimDirectory, shimBody(
          resultEvent({ structured_output: PASSING_VERDICT }),
        ));
        const stamped = runDispatch({
          role: 'code-review',
          prompt: 'review the artifact at revision deadbeef',
          tools: reviewerTools,
          cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
        });
        const head = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repoScratch,
          encoding: 'utf8',
        }).trim();
        const delivered = readFileSync(stdinPath, 'utf8');
        return stamped.ok === true
          && delivered.includes('autoloop-dispatch-context-v1')
          && delivered.includes(`revision: ${head}`)
          && /checkout: (?:clean|dirty)\n/u.test(delivered)
          && delivered.startsWith('review the artifact at revision deadbeef');
      })(),
    );
    check(
      'an unreadable checkout stamps nothing rather than failing the dispatch',
      dispatchContextStamp('/nonexistent', 'code-review', () => null) === ''
      && dispatchContextStamp('/nonexistent', 'code-review', () => 'not-a-sha\n') === '',
    );
    check(
      'a dirty checkout is stamped as dirty',
      dispatchContextStamp(
        repoScratch,
        'implement',
        () => `${'a'.repeat(40)}\n M src/x.mjs\n`,
      ).includes('checkout: dirty'),
    );
    check(
      'a recorded effort pins reviewer dispatches and reaches the engine argv',
      (() => {
        writeFileSync(engineFile, 'claude gpt-5.6-sol !xhigh\n');
        if (
          resolveDefaultEffort('code-review', repoScratch) !== 'xhigh'
          || resolveDefaultEffort('implement', repoScratch) !== null
          || resolveDefaultEffort('plan', repoScratch) !== null
          || resolveDefaultModel('code-review', repoScratch) !== 'gpt-5.6-sol'
        ) {
          return false;
        }
        writeEngineShim(shimDirectory, shimBody(
          resultEvent({ structured_output: PASSING_VERDICT }),
        ));
        const pinned = runDispatch({
          role: 'code-review',
          prompt: 'review',
          tools: reviewerTools,
          cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
        });
        return pinned.ok === true
          && pinned.effort === 'xhigh'
          && readFileSync(argvPath, 'utf8').includes('--effort xhigh');
      })(),
    );
    check(
      'an unknown recorded effort fails the whole recording closed',
      (() => {
        writeFileSync(engineFile, 'claude gpt-5.6-sol !extreme\n');
        return resolveDefaultEffort('code-review', repoScratch) === null
          && resolveDefaultModel('code-review', repoScratch) === null;
      })(),
    );
    check(
      'the CLI carries --effort through to the engine, and rejects an unknown level',
      (() => {
        if (parseArgs(['--role', 'code-review', '--prompt-file', '/p', '--effort', 'nope'])
          .error === null) {
          return false;
        }
        rmSync(engineFile, { force: true });
        writeEngineShim(shimDirectory, shimBody(
          resultEvent({ structured_output: PASSING_VERDICT }),
        ));
        const parsedCli = parseArgs([
          '--role', 'code-review', '--prompt-file', '/p', '--effort', 'xhigh',
        ]);
        const viaCli = runDispatch({
          role: 'code-review',
          prompt: 'review',
          tools: reviewerTools,
          cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
          ...(parsedCli.effort === null ? {} : { effort: parsedCli.effort }),
        });
        return parsedCli.error === null
          && viaCli.ok === true
          && readFileSync(argvPath, 'utf8').includes('--effort xhigh');
      })(),
    );
    check(
      // 2026-07-28: "structured output is not a valid plan" named neither the
      // field nor the reason, and a live run spent ~40 minutes of opus finding
      // that an em-dash in the TITLE was the whole problem.
      'a rejected plan names the field, the reason, and the offending character',
      (() => {
        const sound = { title: 'feat: a thing', prBody: 'pr', body: 'plan' };
        const emdash = { ...sound, title: 'feat: a thing — with prose' };
        const titleProblem = planResultProblem(emdash) ?? '';
        return planResultProblem(sound) === null
          && titleProblem.startsWith('title must be printable ASCII')
          && titleProblem.includes('U+2014')
          && (planResultProblem({ title: 'a', body: 'b' }) ?? '').startsWith('keys must be exactly')
          && planResultProblem({ ...sound, body: '' }) === 'body must not be empty'
          && (planResultProblem({ ...sound, prBody: 'x'.repeat(65536) }) ?? '')
            .includes('65536');
      })(),
    );
    check(
      // Composing a safe title is the ORCHESTRATOR's job and the body is the
      // model's, so a punctuation mark in the title must not cost the artifact.
      'only a non-ASCII title is salvageable by retitling, and it keeps the body',
      (() => {
        const sound = { title: 'feat: a thing', prBody: 'pr', body: 'plan' };
        return planIsSalvageableByRetitling({ ...sound, title: 'a — b' })
          && !planIsSalvageableByRetitling(sound)
          && !planIsSalvageableByRetitling({ ...sound, body: '' })
          && !planIsSalvageableByRetitling({ title: 'a', body: 'b' });
      })(),
    );
    check(
      'a malformed recorded proxy URL fails closed',
      (() => {
        writeFileSync(engineFile, 'claude gpt-5.6-sol @ftp://elsewhere\n');
        const scheme = resolveDefaultBaseUrl('code-review', repoScratch) === null
          && resolveDefaultModel('code-review', repoScratch) === null;
        writeFileSync(engineFile, 'claude gpt-5.6-sol @http://a @http://b\n');
        const duplicate = resolveDefaultBaseUrl('code-review', repoScratch) === null;
        return scheme && duplicate;
      })(),
    );
    writeFileSync(engineFile, 'weird-engine\n');
    check(
      'an unrecognised recorded choice falls back to the host engine',
      resolveDefaultEngine('code-review', repoScratch) === 'claude',
    );
    rmSync(engineFile);
    check(
      'no recorded choice means the host engine for every role',
      resolveDefaultEngine('code-review', repoScratch) === 'claude'
      && resolveDefaultEngine('implement', repoScratch) === 'claude',
    );
    check(
      'every dispatch records its own window in the dispatch log',
      logged.length === 5
      && logged.every((entry) =>
        Number.isSafeInteger(entry.startedAtMs)
        && entry.startedAtMs > 0
        && Number.isSafeInteger(entry.ms)
        && entry.ms >= 0
        && typeof entry.ok === 'boolean')
      // Roles, engines and outcomes are all recorded, so overlap accounting can
      // tell a codex review apart from a claude writer after the fact.
      && logged.map(({ role, engine, ok }) => `${role}/${engine}/${ok}`).join(' ')
        === 'implement/claude/false implement/claude/true '
          + 'plan-review/codex/true implement/codex/false plan/codex/false',
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
      engine: join(shimDirectory, 'absent', 'claude'),
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

// The typed in-turn wait: `--wait-file <path> [--timeout-seconds N]` blocks
// until the file exists or the bound expires (exit 0 / exit 1). It exists so
// the orchestrator's fallback wait needs no `bash -c 'until …'` — inline
// interpreter source the guard rightly refuses; a live run was blocked by its
// own skill's idiom.
export function parseWaitArgs(args) {
  if (args[0] !== '--wait-file') return null;
  const parsed = { path: null, timeoutSeconds: 600, error: null };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (index === 1 && flag && !flag.startsWith('-')) {
      parsed.path = flag;
      continue;
    }
    if (
      flag === '--timeout-seconds'
      && /^[1-9][0-9]{0,3}$/u.test(value ?? '')
    ) {
      parsed.timeoutSeconds = Number(value);
      index += 1;
      continue;
    }
    parsed.error = `unknown, duplicate, or incomplete wait option: ${flag ?? 'missing'}`;
    return parsed;
  }
  if (parsed.path === null) parsed.error = '--wait-file requires a path';
  return parsed;
}

function runWaitCli(parsed) {
  const deadline = Date.now() + parsed.timeoutSeconds * 1000;
  const poll = () => {
    if (existsSync(parsed.path)) {
      console.log(`wait: ${parsed.path} exists`);
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      console.error(`wait: ${parsed.path} absent after ${parsed.timeoutSeconds}s`);
      process.exit(1);
    }
    setTimeout(poll, 2000);
  };
  poll();
}

function main() {
  const wait = parseWaitArgs(process.argv.slice(2));
  if (wait) {
    if (wait.error) {
      console.error(`dispatch: ${wait.error}`);
      process.exit(2);
    }
    runWaitCli(wait);
    return;
  }
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`dispatch: ${parsed.error}`);
    console.error(
      'usage: dispatch.mjs --role <'
      + `${ROLE_NAMES.join('|')}> --prompt-file <path|-> `
      + '[--tools <csv>] [--engine <name>] [--model <name>] '
      + `[--effort <${[...EFFORTS].join('|')}>] [--output-file <path>] [--json]`,
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

  // Every parsed option crosses this seam. --engine parsed clean for six
  // releases and was dropped exactly here — a review requested on codex
  // silently ran claude, and a live loop found it before any test did.
  const result = runDispatch({
    role: parsed.role,
    prompt,
    tools,
    ...(parsed.engine === null ? {} : { engine: parsed.engine }),
    ...(parsed.model === null ? {} : { model: parsed.model }),
    ...(parsed.effort === null ? {} : { effort: parsed.effort }),
    ...(parsed.liveFile === null ? {} : { liveFile: parsed.liveFile }),
  });
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
