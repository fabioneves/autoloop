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
//   node <plugin-tools>/dispatch.mjs --role <plan|plan-review|implement|code-review|doubt-review> \
//     --prompt-file <path> [--tools <csv>] [--output-file <path>] [--json]
//   node <plugin-tools>/dispatch.mjs --self-test
//
// Exit 0 on a typed success, 1 on a typed failure, 2 on a usage error.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  renameSync,
  unlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_VERSION, effectiveChecklistPath, PLUGIN_CHECKLIST, repositoryRoot, resolveProjectConfig,
} from './config-contract.mjs';
import { pinModels, readPinnedModels, resolveModels } from './models-config.mjs';
import { pinnedModelsPath, pluginRunMarkers } from './run-markers.mjs';

const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// A dispatch is a model round trip on a real task, not a mechanical step. The
// bound exists to stop a WEDGED child from hanging a loop forever — nothing
// else. It is therefore per posture, because the two postures fail differently
// and a single number cannot serve both.
//
// The old flat 30 minutes assumed "the longest observed healthy implement
// dispatch is minutes, and a run that needs more than half an hour has a
// different problem". A live run falsified that: a writer grinding a Go task
// landed two real commits and was killed at the ceiling mid-third. Its tokens
// were spent and unrecoverable, and the work it was holding died with it —
// the effects already committed survived only because it had committed them.
//
// Raising the flat number would buy that back by making every wedged reviewer
// cost four times as much to notice. A writer legitimately grinds: it reads,
// edits, runs tests, and commits, bounded by its plan's tasks rather than the
// clock. A reviewer reads and returns one typed verdict; the longest healthy
// one observed took 13 minutes, so a reviewer still running at 45
// minutes is not thinking, it is stuck.
const DISPATCH_TIMEOUT_MS = Object.freeze({
  writer: 120 * 60 * 1000,
  reviewer: 45 * 60 * 1000,
});

export function timeoutMsFor(role) {
  return DISPATCH_TIMEOUT_MS[ROLES[role]?.posture] ?? DISPATCH_TIMEOUT_MS.reviewer;
}

// The mutating tools, granted explicitly in the settings allow list rather than
// left to the permission mode alone. The grant is derived from the posture's own
// `--tools` ceiling, so a posture grants exactly what it declares and the
// reviewer grants nothing at all. Read-only tools (Glob/Grep/Read) need no
// entry, so the deny list below stays the only statement this contract makes
// about reads.
const TOOLS_REQUIRING_GRANT = Object.freeze(['Bash', 'Edit', 'Write']);

// The reasoning ladder claude takes as `--effort <level>`.
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

// `simplify` (step 06) and `fix` (step 08) write exactly like `implement`, and
// `diff-review` (step 07) judges exactly like `code-review`. They are separate
// roles so each carries its own route and fallback: a role never inherits
// another role's model (SPEC-model-routing.md).
export const ROLES = Object.freeze({
  plan: Object.freeze({ posture: 'reviewer', result: 'plan' }),
  'plan-review': Object.freeze({ posture: 'reviewer', result: 'review-verdict' }),
  implement: Object.freeze({ posture: 'writer', result: 'text' }),
  simplify: Object.freeze({ posture: 'writer', result: 'text' }),
  'diff-review': Object.freeze({ posture: 'reviewer', result: 'review-verdict' }),
  'code-review': Object.freeze({ posture: 'reviewer', result: 'review-verdict' }),
  'doubt-review': Object.freeze({ posture: 'reviewer', result: 'review-verdict' }),
  fix: Object.freeze({ posture: 'writer', result: 'text' }),
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

// `validReviewVerdict` answers yes or no, and "structured output is not a valid
// review verdict" sent a live run to scrape 462 KB of event stream to find out
// which rule broke. Twice, on consecutive rounds, for the same reason: the brief
// said to fail on "at least one finding", the reviewer returned `fail` with only
// Minors, and the internal-consistency rule rejected the envelope. Both rounds'
// findings were real and the work was thrown away.
//
// So the failure names the rule AND carries the rejected verdict, the way an
// unpublishable plan keeps its body in `rejectedPlan`. The envelope is invalid;
// the findings inside it are still evidence.
export function reviewVerdictProblem(value) {
  if (validReviewVerdict(value)) return null;
  const findings = Array.isArray(value?.findings) ? value.findings : null;
  if (findings !== null && ['pass', 'fail'].includes(value.verdict)) {
    const gating = findings.filter(({ severity }) =>
      ['Critical', 'Major'].includes(severity));
    if (value.verdict === 'pass' && gating.length > 0) {
      return `the verdict is \`pass\` but ${gating.length} finding(s) are `
        + 'Critical or Major. A gating finding means `fail`';
    }
    if (value.verdict === 'fail' && gating.length === 0) {
      return 'the verdict is `fail` but no finding is Critical or Major. '
        + '`fail` requires at least one gating finding; a round that found only '
        + 'Minors is a `pass` that lists them. Tell the reviewer this rule in '
        + 'the brief — "fail if you find anything" produces exactly this '
        + 'envelope, and the round is lost';
    }
  }
  return 'structured output is not a valid review verdict';
}

// A headless engine asks before its first read outside its working directory,
// and with nobody to answer, the read is denied (LFE #356: every input of a
// writer's brief under /tmp, and the skills it names under the plugin cache).
// Each root is granted read-only: `--add-dir` would also let a writer edit it.
export function pluginsDir(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'plugins');
}

// The hook wiring a writer must never touch: the settings files that run the
// session's guard (operator, 2026-09-29: the wiring alone — other loop
// infrastructure is built through the queue and flagged human:authorize). A
// writer child runs with hooks off and Edit allowed, so these deny rules keep
// it off them (an Edit deny also refuses Write; verified live). Both the
// dispatch's own worktree and the MAIN checkout are covered: the hooks run
// the main checkout's copy. A Bash write is not covered here.
const HOOK_WIRING = Object.freeze(['.claude/settings.json', '.claude/settings.local.json']);

export function hookWiringRoots(cwd) {
  const git = (args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : '';
  };
  const worktree = git(['rev-parse', '--show-toplevel']) || resolve(cwd);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const main = common ? dirname(common) : worktree;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return [...new Set([real(worktree), real(main)])];
}

function processSettings(tools, readRoots = [], wiringRoots = []) {
  return {
    permissions: {
      allow: [
        ...tools.filter((tool) => TOOLS_REQUIRING_GRANT.includes(tool)),
        ...readRoots.map((root) => `Read(/${root}/**)`),
      ],
      deny: [
        'Read(~/.config/gh/**)',
        'Read(~/.git-credentials)',
        'Read(~/.gitconfig)',
        'Read(~/.netrc)',
        'Read(~/.ssh/**)',
        // A root with permission-rule metacharacters would corrupt the rule.
        ...wiringRoots.filter((root) => !/[()*[\]]/u.test(root))
          .flatMap((root) => HOOK_WIRING.map((path) => `Edit(/${root}/${path})`)),
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
export function dispatchArgv(role, tools, readRoots = [], wiringRoots = []) {
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
    JSON.stringify(processSettings(tools, readRoots, wiringRoots)),
    '--permission-mode',
    POSTURES[posture].permissionMode,
    '--tools',
    tools.join(','),
  ];
}

// The one engine is Claude Code, recognised by the binary's own name so a
// fixture shim on a path and an installed binary resolve the same way. Other
// models are reached through a proxied route, never a second CLI. Codex was a
// second engine until 0.51.0 and is refused by name.
function claudeArgv(role, tools, model, effort, readRoots = [], wiringRoots = []) {
  return [
    ...dispatchArgv(role, tools, readRoots, wiringRoots),
    ...(model === null ? [] : ['--model', model]),
    ...(effort === null ? [] : ['--effort', effort]),
  ];
}

// Claude's stream-json ends with exactly one `result` event.
function claudePayload(role, stdout) {
  const event = parseResultEvent(stdout);
  // A usage limit arrives as `subtype: success` with `is_error: true` and
  // the refusal as its result text — not a result this tool can stand behind.
  if (event === null || event.subtype !== 'success' || event.is_error === true) return null;
  return RESULT_SCHEMAS[ROLES[role].result] !== undefined
    ? { structured: event.structured_output }
    : { text: typeof event.result === 'string' ? event.result : '' };
}

// Each role's model, effort and fallback come from one resolved table
// (models-config.mjs, docs/specs/SPEC-model-config.md): built-in defaults, the
// operator's global config, then this checkout's project `models`. There is no
// proxy here: the session command decides which models are reachable, and a
// dispatch inherits its environment. A table that would let a reviewer run on
// its writer's model is refused before anything runs.
// A run's dispatches run the table prime pinned: a writer that edits its
// branch's config cannot move its own reviewers, and what prime reported is
// what runs (review of the model config). With no pin (no run), the checkout
// resolves its own, and an invalid project config refuses.
function unpinnedModels(cwd) {
  const root = repositoryRoot(cwd);
  const project = resolveProjectConfig(root);
  if (!project?.ok && existsSync(join(root, '.autoloop', 'config.json'))) {
    return { ok: false, errors: [`project config: ${project?.errors?.join('; ') ?? 'unreadable'}`] };
  }
  return resolveModels({ projectModels: project?.ok ? project.config.models : undefined });
}

export function resolveRoute(role, cwd) {
  if (ROLES[role] === undefined) {
    return { error: { code: 'ENGINE_ROLE_UNSUPPORTED', message: `${role}: not a dispatch role` } };
  }
  const pin = pinnedModelsPath(cwd);
  const pinned = pin === null ? null : readPinnedModels(pin);
  const resolved = pinned ?? unpinnedModels(cwd);
  if (!resolved.ok) return { error: { code: 'MODELS_INVALID', message: resolved.errors.join('; ') } };
  const entry = resolved.models[role];
  return {
    engine: 'claude',
    model: entry.model,
    effort: entry.effort,
    fallback: entry.fallback === null ? null : Object.freeze({ model: entry.fallback }),
    source: pinned === null ? 'config' : 'pinned',
  };
}

function resolvedField(role, cwd, field, fallback) {
  const route = resolveRoute(role, cwd);
  return route.error === undefined ? route[field] : fallback;
}

export function resolveDefaultEngine(role, cwd) {
  return resolvedField(role, cwd, 'engine', 'claude');
}

export function resolveDefaultModel(role, cwd) {
  return resolvedField(role, cwd, 'model', null);
}

// Review is the step where depth converts directly into rounds not spent.
export function resolveDefaultEffort(role, cwd) {
  return resolvedField(role, cwd, 'effort', null);
}

// The child inherits this process's environment, plus one setting: every
// Bash call returns to the checkout the dispatch launched in. A writer that
// cd'd into a package kept failing on paths named from the repository root
// (LFE run 2026-09-30); a `cd` inside one call still works.
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 used to be set here to satisfy the broker
// capability `claude.subprocess.credentials-scrubbed`; v0.42.0 deleted the
// broker, and with it both that predicate and the cleanup that swept the stub
// files scrub mode creates. Setting it now buys nothing and costs three things
// the self-test pins: the child ignores `--permission-mode`, the checkout gains
// seventeen zero-byte stubs nobody removes, and every Bash call dies at sandbox
// start on `/home/.mcp.json`.
// A dispatch runs where the session runs: a session started on a gateway
// reaches its models through it, and one that cannot reach a model falls back.
export function dispatchEnvironment() {
  return { ...process.env, CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' };
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

// The checkout's branch, so a log entry can be tied to its unit afterwards.
// null on a detached head or any read failure: accounting stays fail-open.
function currentBranch(cwd) {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  const branch = result.status === 0 ? String(result.stdout ?? '').trim() : '';
  return branch === '' ? null : branch;
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

// The verdict envelope rules are MACHINE-SUPPLIED, never left to the brief.
// `reviewVerdictProblem` has carried "tell the reviewer this rule in the brief"
// since the second time a brief invited `fail` beside only Minors — and a third
// live round was lost to exactly that invitation anyway, its real findings
// recovered by hand from the raw event stream. A rule that every brief must
// restate is a rule the dispatcher should state itself, the same reasoning that
// put the context stamp below on every prompt. The rebut clause rides along
// because it has the same failure shape: a reviewer spent `rebuts` answering
// the brief's own prose concerns, and the chain the rounds were meant to form
// would not validate.
export function reviewEnvelopeStamp(role) {
  if (ROLES[role]?.result !== 'review-verdict') return '';
  return '\n\n<!-- autoloop-review-envelope-v1\n'
    + 'Verdict envelope rules, enforced mechanically on this review\'s output —\n'
    + 'a verdict that breaks them is rejected and the round is lost:\n'
    + '- `fail` requires at least one Critical or Major finding. A round whose\n'
    + '  findings are all Minor or Suggestion is a `pass` that lists them.\n'
    + '- `pass` beside a Critical or Major finding is invalid.\n'
    + '- `rebuts` adjudicates only finding ids recorded in earlier rounds and\n'
    + '  named by this brief. Answer a concern raised in the brief\'s own prose\n'
    + '  with a finding or not at all, never with a rebut; a rejected rebuttal\n'
    + '  keeps the original finding id rather than re-filing the defect as new.\n'
    + 'These rules override any instruction elsewhere in this prompt that\n'
    + 'disagrees with them (for example "fail if you find anything").\n-->\n';
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
export function dispatchContextStamp(cwd, role, readCheckout = checkoutFingerprint, promptFile = null) {
  const fingerprint = readCheckout(cwd);
  if (fingerprint === null) return '';
  const [head, ...rest] = fingerprint.split('\n');
  if (!/^[0-9a-f]{40}$/u.test(head)) return '';
  const clean = rest.join('\n').trim().length === 0;
  const checklist = checklistLine(cwd);
  return '\n\n<!-- autoloop-dispatch-context-v1\n'
    + `role: ${role}\n`
    + `revision: ${head}\n`
    + `checkout: ${clean ? 'clean' : 'dirty'}\n`
    + checklist
    + (promptFile === null ? '' : `brief: ${promptFile}\n`)
    + `working directory: ${cwd} (every Bash call starts here; name paths from it, or cd within the same call)\n`
    + 'This stamp is written by dispatch.mjs from the checkout it launched in.\n'
    + 'It is the authority for the revision under review; a revision named\n'
    + 'anywhere else in this prompt that disagrees with it is a transcription\n'
    + 'error, and this stamp wins.\n-->\n';
}

// The checklist file the briefs read, named by dispatch rather than the
// prompt author: the repository's own (repository-relative), or the plugin's
// when the repository keeps none. No readable config → no line.
function checklistLine(cwd) {
  const root = repositoryRoot(cwd);
  const resolved = resolveProjectConfig(root);
  if (!resolved?.ok) return '';
  const file = effectiveChecklistPath(root, resolved.config);
  return `checklist: ${file === PLUGIN_CHECKLIST ? file : relative(root, file)}\n`;
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

// A usage limit is a resource refusal, not a defect: rerunning the same route
// is refused again, and its fallback is the only useful next attempt. Read
// only where an engine reports its own failure — stderr, and the error-bearing
// final events of either stream — never the transcript body, which a reviewer
// fills with the very code under review (and code mentions rate limits). A 429
// counts only where an engine renders a status (reason phrase, `status code`,
// `API Error:`): bare, it is a stack frame's line number as often as a status.
const USAGE_LIMIT_RE =
  /usage limit|(?:hit|reached) your (?:[\w-]+ )*limit|rate[_ -]?limit|\b429 (?:Too Many Requests|status code)\b|API Error: 429\b|last status: 429\b|quota exceeded|insufficient_quota/iu;

export function usageLimitIn(stderr, stdout) {
  const reports = [String(stderr ?? '')];
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const failed = (event?.type === 'result' && (event.is_error === true || event.subtype !== 'success'))
      || event?.type === 'error';
    if (failed) reports.push(line);
  }
  return USAGE_LIMIT_RE.test(reports.join('\n'));
}

// A model the session cannot serve (not on its gateway, a typo, no access)
// refuses at once, before any work: the engine reports `model_not_found`
// (measured: exit 1, zero tokens, "There's an issue with the selected
// model"). Its fallback is the only useful next attempt. Only the top-level
// run counts — a subagent's refusal the parent recovered from is not one —
// and a final result that shows any tokens or turns did work, so it is not
// an unavailable model whatever its text says (review of the model config).
const MODEL_UNAVAILABLE_TEXT = /There's an issue with the selected model/u;

export function modelUnavailableIn(stderr, stdout) {
  let final = null;
  let refused = false;
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.parent_tool_use_id) continue;
    if (event?.type === 'result') final = event;
    if (event?.type === 'assistant' && event.error === 'model_not_found') refused = true;
  }
  if (final !== null) {
    const usage = final.usage ?? {};
    if ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) > 0 || (final.num_turns ?? 0) > 1) return false;
    if (final.is_error === true && MODEL_UNAVAILABLE_TEXT.test(String(final.result ?? ''))) return true;
  }
  return refused || /\[claude-code:unrecognized_model\]/u.test(String(stderr ?? ''));
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

function routeFor(options, cwd) {
  const route = resolveRoute(options.role, cwd);
  if (route.error !== undefined || !options.fallback) return route;
  const { fallback } = route;
  if (fallback === null) {
    return {
      error: {
        code: 'ROUTE_FALLBACK_MISSING',
        message: `${options.role}: --fallback given but its config names no fallback model`,
      },
    };
  }
  return { ...route, model: fallback.model };
}

function dispatchOnce(options, cwd) {
  const windowStartedAtMs = Date.now();
  const route = routeFor(options, cwd);
  const engineBinary = options.engine ?? route.engine ?? 'claude';
  const resolvedModel = options.model ?? route.model ?? null;
  const resolvedEffort = options.effort ?? route.effort ?? null;
  const result = route.error !== undefined
    ? failure('route', route.error.code, route.error.message, { ms: 0, startupMs: 0, stderr: '' })
    : executeDispatch({
      ...options,
      engine: engineBinary,
      model: resolvedModel,
      effort: resolvedEffort,
    });
  const engine = hostName(engineBinary);
  const model = resolvedModel;
  const effort = resolvedEffort;
  const stamp = {
    ...(options.fallback && route.error === undefined ? { fallback: true } : {}),
  };
  const branch = currentBranch(cwd);
  recordDispatchWindow(cwd, {
    role: options.role,
    engine,
    ...(branch === null ? {} : { branch }),
    ...(Number.isSafeInteger(options.issue) ? { issue: options.issue } : {}),
    ...(model === null ? {} : { model }),
    ...(effort === null ? {} : { effort }),
    startedAtMs: windowStartedAtMs,
    ms: Date.now() - windowStartedAtMs,
    ok: result.ok === true,
    ...(result.ok === true ? {} : { code: result.error.code }),
    ...(result.error?.usageLimit === true ? { usageLimit: true } : {}),
    ...(result.error?.modelUnavailable === true ? { modelUnavailable: true } : {}),
    ...(stamp.fallback === true ? { fallback: true } : {}),
  });
  // Stamped once here so no return path inside the dispatch can omit it.
  return result.ok
    ? {
      ...result,
      engine,
      ...(model === null ? {} : { model }),
      ...(effort === null ? {} : { effort }),
      ...stamp,
    }
    : {
      ...result,
      error: {
        ...result.error,
        engine,
        ...(model === null ? {} : { model }),
        ...(effort === null ? {} : { effort }),
        ...stamp,
      },
    };
}

// Failures an effect-free dispatch may simply run again: the engine died or
// answered nothing. Every other code is either a defect of the request
// (prompt, route, role) or carries salvageable output (a rejected verdict or
// plan), and rerunning either costs a round trip to learn nothing.
const TRANSIENT_CODES = new Set([
  'ENGINE_EXIT_NONZERO',
  'ENGINE_RESULT_MISSING',
  'ENGINE_RESULT_EMPTY',
  'DISPATCH_TIMEOUT',
]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;

// What a failed dispatch does next: 'retry' the same route, move to the
// route's 'fallback', or stop (null). Only a reviewer-posture role is ever run
// again — it holds no write tool, so a rerun cannot double an effect. A writer
// may have committed before it died; the orchestrator reconciles it by
// inspecting the branch. A usage limit never retries the same route (it will
// refuse again), and two consecutive failures on one route move to its
// fallback when it records one (SPEC-self-healing.md, dispatch-resilience).
export function nextAttempt(role, error, { attempts, timeouts, onFallback, fallbackAvailable }) {
  const canFallBack = fallbackAvailable && !onFallback;
  // A model that could not be served did nothing, so any role, a writer too,
  // moves to its fallback (SPEC-model-config.md).
  if (error.modelUnavailable === true) return canFallBack ? 'fallback' : null;
  if (ROLES[role]?.posture !== 'reviewer') return null;
  if (error.usageLimit === true) return canFallBack ? 'fallback' : null;
  if (!TRANSIENT_CODES.has(error.code) || attempts >= MAX_ATTEMPTS) return null;
  if (canFallBack && attempts >= 2) return 'fallback';
  // A reviewer ceiling is 45 minutes; a second wedge on the same route is not
  // bad luck.
  if (error.code === 'DISPATCH_TIMEOUT' && timeouts >= 2) return null;
  return 'retry';
}

function sleepMs(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Every attempt — typed success or typed failure alike — contributes its window
// to the log, so idle wall-clock cannot be understated by a run that only counts
// the dispatches that worked. The final result names every earlier attempt's
// failure, so a collection line can say why the fallback ran.
export function runDispatch(options) {
  const cwd = options.cwd ?? process.cwd();
  const primary = resolveRoute(options.role, cwd);
  const fallbackAvailable = primary.error === undefined
    && primary.fallback !== null
    && options.model === undefined
    && hostName(options.engine ?? primary.engine ?? 'claude') === 'claude';
  let onFallback = options.fallback === true;
  let timeouts = 0;
  const earlier = [];
  for (let attempts = 1; ; attempts += 1) {
    const result = dispatchOnce({ ...options, fallback: onFallback }, cwd);
    if (result.ok) return earlier.length === 0 ? result : { ...result, earlierAttempts: earlier };
    const { error } = result;
    if (error.code === 'DISPATCH_TIMEOUT') timeouts += 1;
    const next = nextAttempt(options.role, error, {
      attempts, timeouts, onFallback, fallbackAvailable,
    });
    if (next === null) {
      return earlier.length === 0
        ? result
        : { ...result, error: { ...error, earlierAttempts: earlier } };
    }
    const why = error.usageLimit === true ? ' (usage limit)' : error.modelUnavailable === true ? ' (model unavailable)' : '';
    earlier.push(`${error.code}${why}`
      + ` on ${error.model ?? error.engine}`);
    if (next === 'fallback') onFallback = true;
    else sleepMs((options.retryDelayMs ?? RETRY_DELAY_MS) * attempts);
  }
}

// A reviewer holds `Glob,Grep,Read` and never Bash — `resolveTools` refuses it
// outright. So a command in a reviewer's brief is not a slow instruction, it is
// an unexecutable one, and the reviewer spends its budget trying anyway: two
// round-4 attempts on a live unit died having searched the filesystem for a
// commit the brief told them to `git show`. The skill has said "never a command
// it cannot run" since 0.47 and the briefs kept carrying them, so the rule needs
// a mechanism rather than more prose.
//
// Fenced shell blocks only. That is the shape a brief uses to TELL a reviewer to
// run something, it is unambiguous, and a command quoted as evidence has a
// remedy that costs nothing: fence it as `text`.
const SHELL_FENCE_RE =
  /^[ \t]*(?:`{3,}|~{3,})[ \t]*(bash|sh|shell|zsh|console|shell-session|shellsession)\b/gimu;

// Each role's standing instructions are a plugin file, put ahead of the unit
// facts the orchestrator writes. Dispatch always runs from the plugin's tools,
// so the templates resolve beside this file.
const BRIEFS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'briefs');

// A dispatched process has no Skill tool, so a template names skill FILES.
// Their paths come from Claude Code's installed-plugin record: the install it
// loads in this repo (a local or project pin) first, then the user-scope one,
// then any other. A vendored dispatch sits in <repo>/tools/agentic, so a path
// relative to this file is only a fallback for running from the plugin itself.
function installedSkills(installed, prefix, cwd) {
  const rank = (entry) => (entry.projectPath === cwd ? 0 : entry.scope === 'user' ? 1 : 2);
  return Object.entries(installed.plugins ?? {})
    .filter(([name]) => name.startsWith(prefix))
    .flatMap(([, entries]) => entries)
    .filter((entry) => typeof entry.installPath === 'string')
    .sort((left, right) => rank(left) - rank(right))
    .map((entry) => join(entry.installPath, 'skills'))
    .find((path) => existsSync(path)) ?? null;
}

export function skillRoots(plugins = pluginsDir(), cwd = process.cwd()) {
  let installed = {};
  try {
    installed = JSON.parse(readFileSync(join(plugins, 'installed_plugins.json'), 'utf8'));
  } catch {
    installed = {};
  }
  const own = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
  return {
    'agent-skills': installedSkills(installed, 'agent-skills@', cwd),
    'autoloop-skills': installedSkills(installed, 'autoloop@', cwd)
      ?? (existsSync(join(own, 'dev', 'SKILL.md')) ? own : null),
  };
}

export function composeBrief(role, prompt, briefsDir = BRIEFS_DIR, roots = skillRoots()) {
  const path = join(briefsDir, `${role}.md`);
  let template;
  try {
    template = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, code: 'BRIEF_TEMPLATE_MISSING', message: `${role}: no role brief template at ${path}` };
  }
  const resolved = template.replace(/\{(agent-skills|autoloop-skills)\}/gu, (token, name) =>
    roots[name] ?? `the ${name.replace('-skills', '')}${name === 'agent-skills' ? '-skills' : ''} plugin's skills directory`);
  return {
    ok: true,
    prompt: `${resolved.trimEnd()}\n\n---\n\n${prompt}`,
    sha256: createHash('sha256').update(template).digest('hex'),
  };
}

export function reviewerPromptProblem(role, prompt) {
  if (ROLES[role]?.posture !== 'reviewer') return null;
  const text = String(prompt);
  SHELL_FENCE_RE.lastIndex = 0;
  const match = SHELL_FENCE_RE.exec(text);
  if (match === null) return null;
  const line = text.slice(0, match.index).split('\n').length;
  return `the prompt carries a ${match[1]} code fence at line ${line}, but a `
    + `${role} reviewer holds no Bash and cannot run it. Paste what you want `
    + 'reviewed — the diff, the output, a path with a line range — instead of '
    + 'the command that would produce it; if a command must appear as evidence, '
    + 'fence it as `text`.';
}

function executeDispatch(options) {
  const {
    role,
    prompt,
    tools,
    cwd = process.cwd(),
    timeoutMs = timeoutMsFor(role),
    engine = 'claude',
    startedAtMs = PROCESS_START_MS,
  } = options;
  const brief = ROLES[role] === undefined ? { ok: true, prompt, sha256: null }
    : composeBrief(role, prompt, options.briefsDir ?? BRIEFS_DIR, skillRoots(pluginsDir(), options.cwd));
  if (!brief.ok) {
    return failure('prompt', brief.code, brief.message, { ms: 0, startupMs: 0, stderr: '' });
  }
  const promptProblem = reviewerPromptProblem(role, brief.prompt);
  if (promptProblem !== null) {
    return failure(
      'prompt',
      'REVIEWER_PROMPT_NOT_EXECUTABLE',
      `${role}: ${promptProblem}`,
      { ms: 0, startupMs: 0, stderr: '' },
    );
  }
  const name = hostName(engine);
  if (name !== 'claude') {
    const removed = name === 'codex';
    return failure('spawn', removed ? 'ENGINE_REMOVED' : 'ENGINE_UNKNOWN', removed
      ? `${role}: ${name} is no longer a dispatch engine; run the model on the claude engine (the session decides which models it reaches)`
      : `${role}: unknown engine ${name}`, {
      ms: 0,
      startupMs: 0,
      stderr: '',
    });
  }
  if (ROLES[role] === undefined) {
    return failure(
      'spawn',
      'ENGINE_ROLE_UNSUPPORTED',
      `${role}: ${hostName(engine)} does not run this role`,
      { ms: 0, startupMs: 0, stderr: '' },
    );
  }
  const result = runEngine({
    role, prompt: brief.prompt, tools, cwd, timeoutMs, engine, startedAtMs,
    liveFile: options.liveFile ?? null,
    model: options.model ?? null,
    effort: options.effort ?? null,
    readRoots: options.readRoots ?? [],
    promptFile: options.promptFile ?? null,
  });
  return brief.sha256 === null ? result : { ...result, briefSha256: brief.sha256 };
}

// Engine stdout goes to disk as the engine emits it, so a running dispatch can
// be watched: `tail -f` the newest file under `autoloop/dispatch-live/` in the
// common Git directory. A 13-minute review used to run as a sealed box —
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
  role, prompt, tools, cwd, timeoutMs, engine, startedAtMs, liveFile, model, effort, readRoots, promptFile,
}) {
  const argv = claudeArgv(role, tools, model ?? null, effort ?? null, readRoots ?? [], hookWiringRoots(cwd));
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
      env: dispatchEnvironment(),
      input: `${prompt}${reviewEnvelopeStamp(role)}${dispatchContextStamp(cwd, role, checkoutFingerprint, promptFile ?? null)}`,
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
  // A writer that changed the checkout did work, so it never reads as an
  // unavailable model: its fallback would run the brief again on top.
  const untouched = checkoutBefore === null || checkoutFingerprint(cwd) === checkoutBefore;
  const limited = {
    ...(usageLimitIn(stderr, result.stdout) ? { usageLimit: true } : {}),
    ...(untouched && modelUnavailableIn(stderr, result.stdout) ? { modelUnavailable: true } : {}),
  };
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    return failure(
      'dispatch',
      'DISPATCH_TIMEOUT',
      `${role}: the engine did not finish within the ${Math.round(timeoutMs / 60_000)}-minute `
      + `${ROLES[role]?.posture ?? 'reviewer'} ceiling. A writer killed here may have committed `
      + 'real work before it died — reconcile by inspecting the branch, never by blind retry.',
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
      { ms, startupMs, exitCode: result.status, stderr, ...limited },
    );
  }
  const payload = claudePayload(role, result.stdout ?? '');
  if (payload === null) {
    return failure(
      'result',
      'ENGINE_RESULT_MISSING',
      `${role}: the engine produced no single successful result`,
      { ms, startupMs, stderr, ...limited },
    );
  }
  if (ROLES[role].result === 'review-verdict') {
    const verdict = payload.structured;
    const problem = reviewVerdictProblem(verdict);
    if (problem !== null) {
      return failure(
        'result',
        'INVALID_REVIEW_VERDICT',
        `${role}: ${problem}`,
        {
          ms,
          startupMs,
          stderr,
          // The findings survive even when the envelope cannot: disposition
          // them, fix, and re-review. Do NOT re-run the round for the envelope.
          ...(verdict !== null && typeof verdict === 'object'
            ? { rejectedVerdict: verdict }
            : {}),
        },
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
      { ms, startupMs, stderr, ...limited },
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
    issue: null,
    json: false,
    fallback: false,
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
    if (flag === '--fallback') {
      parsed.fallback = true;
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
    else if (flag === '--issue') {
      const issue = Number(value);
      if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(issue)) {
        return { ...parsed, error: '--issue: expected a positive issue number' };
      }
      parsed.issue = issue;
    } else return { ...parsed, error: `unknown flag ${flag}` };
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

// A prompt file written before this run opened is a leftover: an LFE run
// (2026-09-30) nearly dispatched yesterday's plan-review prompt, aimed at an
// old base, because a Write to the same path in the same batch was refused.
// runStartMs: the earliest open time of this run's markers (null: no run).
export function stalePromptProblem(path, runStartMs, stat = statSync) {
  if (path === '-' || !Number.isSafeInteger(runStartMs)) return null;
  const mtimeMs = stat(path).mtimeMs;
  return mtimeMs < runStartMs
    ? `the prompt file ${path} was written before this run opened (${new Date(mtimeMs).toISOString()}) — `
      + 'a leftover from an earlier run; write this dispatch\'s prompt, then dispatch it'
    : null;
}

function currentRunStartMs(cwd = process.cwd()) {
  const starts = pluginRunMarkers([cwd]).filter(({ marker }) => marker.closedAt === undefined)
    .map(({ marker }) => marker.openedAtMs).filter(Number.isSafeInteger);
  return starts.length === 0 ? null : Math.min(...starts);
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
    ROLE_NAMES.length === 8
    && ROLE_NAMES.every((role) => POSTURES[ROLES[role].posture] !== undefined)
    && ['implement', 'simplify', 'fix'].every((role) => ROLES[role].posture === 'writer')
    && ['plan', 'plan-review', 'diff-review', 'code-review', 'doubt-review']
      .every((role) => ROLES[role].posture === 'reviewer'),
  );

  // #350's briefs were about half standing role text the orchestrator rewrote
  // from memory each time; the template carries it now.
  {
    const briefs = mkdtempSync(join(tmpdir(), 'dispatch-briefs-'));
    writeFileSync(join(briefs, 'plan-review.md'), 'Adversarial plan review.\n');
    const composed = (() => {
      try {
        return composeBrief('plan-review', 'Plan: /tmp/p.md', briefs);
      } catch (error) {
        return { ok: false, message: `THREW ${error.message}` };
      }
    })();
    const missing = (() => {
      try {
        return composeBrief('implement', 'x', briefs);
      } catch (error) {
        return { ok: true, message: `THREW ${error.message}` };
      }
    })();
    rmSync(briefs, { recursive: true, force: true });
    check(
      'a role brief template comes first, then the unit facts, and its hash is stamped',
      composed.ok === true
        && composed.prompt === 'Adversarial plan review.\n\n---\n\nPlan: /tmp/p.md'
        && /^[0-9a-f]{64}$/u.test(composed.sha256),
    );
    const tokened = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'dispatch-briefs-'));
      writeFileSync(join(dir, 'fix.md'), 'Read {agent-skills}/tdd/SKILL.md and {autoloop-skills}/lean-code/SKILL.md.');
      try {
        return [
          composeBrief('fix', 'x', dir, { 'agent-skills': '/p/agent/skills', 'autoloop-skills': '/p/auto/skills' }).prompt,
          composeBrief('fix', 'x', dir, { 'agent-skills': null, 'autoloop-skills': null }).prompt,
        ];
      } catch (error) {
        return [`THREW ${error.message}`, ''];
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
    check('skill paths in a template resolve to the installed plugins, or say where to look',
      tokened[0].startsWith('Read /p/agent/skills/tdd/SKILL.md and /p/auto/skills/lean-code/SKILL.md.')
        && tokened[1].includes('the agent-skills plugin\'s skills directory/tdd/SKILL.md'));
    // A repo can pin its own plugin versions (LFE runs a local-scope autoloop
    // 0.53.0 install), so the copy Claude Code loads in that repo wins over
    // the user-scope one. A vendored dispatch sits in <repo>/tools/agentic,
    // where a path relative to this file is the host's, not the plugin's.
    const roots = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'dispatch-roots-'));
      const install = (name) => {
        mkdirSync(join(dir, name, 'skills'), { recursive: true });
        return join(dir, name);
      };
      writeFileSync(join(dir, 'installed_plugins.json'), JSON.stringify({ plugins: {
        'agent-skills@m': [
          { scope: 'local', projectPath: '/elsewhere', installPath: install('agent-other') },
          { scope: 'user', projectPath: null, installPath: install('agent-user') },
          { scope: 'local', projectPath: '/repo', installPath: install('agent-repo') },
        ],
        'autoloop@m': [{ scope: 'user', projectPath: null, installPath: install('auto-user') }],
      } }));
      try {
        return [skillRoots(dir, '/repo'), skillRoots(dir, '/other-repo'), skillRoots(join(dir, 'none'), '/repo')];
      } catch (error) {
        return [{ threw: error.message }, {}, {}];
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
    check('skill roots come from the install Claude Code loads in the repo, then the user-scope one',
      roots[0]['agent-skills']?.endsWith('/agent-repo/skills')
        && roots[0]['autoloop-skills']?.endsWith('/auto-user/skills')
        && roots[1]['agent-skills']?.endsWith('/agent-user/skills')
        && roots[2]['agent-skills'] === null);
    check('a missing role brief template is a typed refusal', missing.ok === false
      && missing.code === 'BRIEF_TEMPLATE_MISSING' && missing.message.includes('implement'));
    check('every role has a template in the plugin, and no reviewer template carries a shell fence',
      ROLE_NAMES.every((role) => {
        const brief = (() => {
          try {
            return composeBrief(role, 'x');
          } catch {
            return { ok: false };
          }
        })();
        return brief.ok === true && reviewerPromptProblem(role, brief.prompt) === null;
      }));
  }

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
    'an inconsistent verdict names the rule it broke',
    reviewVerdictProblem({
      verdict: 'fail',
      findings: [{ id: 'f1', severity: 'Minor', summary: 's', evidence: 'e' }],
      rebuts: [],
    })?.includes('a round that found only Minors is a `pass`')
    && reviewVerdictProblem({
      verdict: 'pass',
      findings: [{ id: 'f1', severity: 'Major', summary: 's', evidence: 'e' }],
      rebuts: [],
    })?.includes('A gating finding means `fail`')
    && reviewVerdictProblem(PASSING_VERDICT) === null
    && reviewVerdictProblem(null) === 'structured output is not a valid review verdict',
  );

  check(
    'a reviewer brief carrying a shell fence is refused before the engine starts',
    reviewerPromptProblem('code-review', 'Review the diff.\n\n```bash\ngit show HEAD\n```')
      ?.includes('holds no Bash')
    && reviewerPromptProblem('plan-review', '~~~sh\nls\n~~~') !== null
    && reviewerPromptProblem('doubt-review', '```console\n$ go test\n```') !== null
    // The evidence spelling stays open, and a writer may be told to run things.
    && reviewerPromptProblem('code-review', '```text\ngit show HEAD\n```') === null
    && reviewerPromptProblem('code-review', '```diff\n+const x = 1;\n```') === null
    && reviewerPromptProblem('implement', '```bash\ngo test ./...\n```') === null,
  );
  check(
    'the refusal names the fence and its line',
    reviewerPromptProblem('code-review', 'a\nb\n```bash\nls\n```')
      === 'the prompt carries a bash code fence at line 3, but a code-review '
        + 'reviewer holds no Bash and cannot run it. Paste what you want '
        + 'reviewed — the diff, the output, a path with a line range — instead '
        + 'of the command that would produce it; if a command must appear as '
        + 'evidence, fence it as `text`.',
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
  cases.push([
    'a prompt file written before the run opened is refused as a leftover; stdin and no run are not judged',
    stalePromptProblem('/p', 2_000, () => ({ mtimeMs: 1_000 }))?.includes('before this run opened') === true
      && stalePromptProblem('/p', 2_000, () => ({ mtimeMs: 3_000 })) === null
      && stalePromptProblem('-', 2_000, () => ({ mtimeMs: 1_000 })) === null
      && stalePromptProblem('/p', null, () => ({ mtimeMs: 1_000 })) === null,
  ]);

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
      && readFileSync(stdinPath, 'utf8')
        === `${composeBrief('code-review', 'review the delta').prompt}${reviewEnvelopeStamp('code-review')}`
      && reviewed.briefSha256 === composeBrief('code-review', 'x').sha256
      && launchedArgv.includes('--permission-mode plan')
      && launchedArgv.includes('--tools Glob,Grep,Read'),
    );
    check(
      'every reviewer prompt carries the envelope rules and no writer prompt does',
      ['plan-review', 'code-review', 'doubt-review'].every((role) =>
        reviewEnvelopeStamp(role).includes('at least one Critical or Major')
        && reviewEnvelopeStamp(role).includes('rebuts'))
      && ['plan', 'implement'].every((role) => reviewEnvelopeStamp(role) === '')
      && readFileSync(stdinPath, 'utf8').includes('autoloop-review-envelope-v1'),
    );
    // LFE, 2026-09-28: #356's headless writer was denied every read of its
    // /tmp inputs ("requested permissions to read … you haven't granted it")
    // and of the skills its brief names under the plugin cache. The grant is
    // read-only: `--add-dir` would also have let a writer edit all of /tmp.
    runDispatch({
      role: 'implement',
      prompt: 'implement',
      tools: resolveTools('implement'),
      cwd: scratch,
      engine,
      readRoots: ['/tmp/unit-356', '/home/op/.claude/plugins'],
    });
    const writerArgv = readFileSync(argvPath, 'utf8');
    check('a dispatch grants read-only access to its brief\'s directory and the plugin skills',
      writerArgv.includes('Read(//tmp/unit-356/**)')
      && writerArgv.includes('Read(//home/op/.claude/plugins/**)')
      && !writerArgv.includes('--add-dir')
      && !launchedArgv.includes('unit-356'));
    // sibling loop project comparison, 2026-09-29: a writer child runs with hooks off
    // (--safe-mode) and Edit/Write allowed, so nothing kept it off the hook
    // wiring that runs the session's guard. Deny beats the allow list
    // (verified live: an Edit(...) deny also refuses Write). Review of
    // 0.55.5: a unit worktree's writer must be kept off the MAIN checkout's
    // wiring, which is what the hooks actually run.
    const wiringRoots = (() => {
      const repo = mkdtempSync(join(tmpdir(), 'dispatch-wiring-'));
      try {
        spawnSync('git', ['init', '-q', '-b', 'main', repo]);
        spawnSync('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@x', 'commit', '-q', '--allow-empty', '-m', 'x']);
        const worktree = join(repo, '.claude', 'worktrees', 'unit');
        spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'unit', worktree]);
        const roots = hookWiringRoots(worktree);
        const argv = dispatchArgv('implement', resolveTools('implement'), [], roots).join(' ');
        return { repo: realpathSync(repo), worktree: realpathSync(worktree), roots, argv };
      } catch (error) {
        return { error: error.message };
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    })();
    check('a dispatch denies edits to the hook wiring of its worktree and its main checkout',
      JSON.stringify(wiringRoots.roots) === JSON.stringify([wiringRoots.worktree, wiringRoots.repo])
        && ['.claude/settings.json', '.claude/settings.local.json'].every((path) =>
          wiringRoots.argv.includes(`Edit(/${wiringRoots.repo}/${path})`)
          && wiringRoots.argv.includes(`Edit(/${wiringRoots.worktree}/${path})`))
        && !wiringRoots.argv.includes('tools/agentic')
        && dispatchArgv('implement', resolveTools('implement'), [], ['/a(b)']).join(' ').includes('/a(b)') === false);
    check('the plugin skills root defaults to ~/.claude/plugins and follows CLAUDE_CONFIG_DIR',
      pluginsDir({}) === join(homedir(), '.claude', 'plugins')
      && pluginsDir({ CLAUDE_CONFIG_DIR: '/cfg' }) === '/cfg/plugins');
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
      && !readFileSync(stdinPath, 'utf8').includes('autoloop-review-envelope-v1')
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
      issue: 7,
    });
    check(
      'an implement that moves the checkout still succeeds',
      busyWriter.ok === true && busyWriter.text === 'implemented the slice',
    );
    // Codex was a second engine until 0.51.0; naming it is refused, typed,
    // never silently run on claude.
    check(
      'a removed engine is refused by name',
      (() => {
        const removedDir = join(scratch, 'removedbin');
        writeEngineShim(removedDir, shimBody('exit 0'), 'codex');
        return runDispatch({
          role: 'plan-review', prompt: 'x', tools: reviewerTools, cwd: repoScratch,
          engine: join(removedDir, 'codex'),
        }).error?.code === 'ENGINE_REMOVED';
      })(),
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
    mkdirSync(join(repoScratch, '.git', 'autoloop'), { recursive: true });
    check(
      'the CLI passes --engine and --live-file through to the dispatch',
      // The flags parsed clean since 0.44.0 and were dropped at this exact
      // seam: main() built runDispatch options from role/prompt/tools only.
      // Every self-test called runDispatch directly, so a live loop found it
      // first. This case goes through the real argv boundary with a PATH that
      // holds no claude at all, so a dropped --engine cannot even spawn.
      (() => {
        const cliDir = join(scratch, 'cli-seam');
        mkdirSync(cliDir, { recursive: true });
        const onlyHere = join(cliDir, 'bin');
        writeEngineShim(onlyHere, [
          '#!/bin/sh',
          'printf \'%s\' "$*" > "$AUTOLOOP_SHIM_ARGV"',
          // Builtins only: PATH holds just node's directory here, and a shim
          // that cannot drain stdin (\`cat\` is not on it) exits before the
          // prompt is written — an intermittent EPIPE under load.
          'while IFS= read -r line || [ -n "$line" ]; do :; done',
          `printf '%s\\n' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: PASSING_VERDICT })}'`,
          '',
        ].join('\n'));
        const promptPath = join(cliDir, 'p.md');
        writeFileSync(promptPath, 'review');
        const chosen = join(cliDir, 'cli-live.jsonl');
        const configDir = join(cliDir, 'config');
        const run = spawnSync(process.execPath, [
          fileURLToPath(import.meta.url),
          '--role', 'plan-review',
          '--prompt-file', promptPath,
          '--engine', join(onlyHere, 'claude'),
          '--model', 'gpt-test-model',
          '--live-file', chosen,
          '--json',
        ], {
          cwd: repoScratch,
          encoding: 'utf8',
          env: { ...process.env, PATH: dirname(process.execPath), CLAUDE_CONFIG_DIR: configDir },
        });
        const argvSeen = readFileSync(argvPath, 'utf8');
        let cliResult;
        try {
          cliResult = JSON.parse(run.stdout);
        } catch {
          // usage error: empty stdout is a failed check, not a crash — say why
          console.error(`  cli seam: exit ${run.status} ${run.signal ?? ''} stderr ${String(run.stderr).slice(0, 400)}`);
          return false;
        }
        if (run.status !== 0) {
          console.error(`  cli seam: exit ${run.status} error ${JSON.stringify(cliResult.error ?? cliResult).slice(0, 600)}`);
        }
        return run.status === 0
          && argvSeen.includes('--model gpt-test-model')
          && argvSeen.includes(`Read(/${cliDir}/**)`)
          && argvSeen.includes(`Read(/${join(configDir, 'plugins')}/**)`)
          && existsSync(chosen)
          && cliResult.engine === 'claude'
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
    // SPEC-model-config: every role runs the model, effort and fallback its
    // resolved table names; with no global file, the defaults are written.
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    const globalFile = join(configDir, 'autoloop', 'config.json');
    const setModels = (models) => {
      mkdirSync(dirname(globalFile), { recursive: true });
      writeFileSync(globalFile, JSON.stringify({ version: '1', models }));
    };
    const resetModels = () => rmSync(globalFile, { force: true });
    check(
      'with no global config the defaults are written and every role resolves its own entry',
      (() => {
        resetModels();
        const want = {
          plan: ['gpt-6-astra[1m]', 'xhigh', 'claude-opus-5-5[1m]'],
          'plan-review': ['claude-fable-5-1[1m]', 'xhigh', 'claude-sonnet-5[1m]'],
          implement: ['claude-opus-5-5[1m]', null, 'claude-fable-5-1[1m]'],
          fix: ['claude-opus-5-5[1m]', null, 'claude-fable-5-1[1m]'],
          simplify: ['claude-fable-5-1[1m]', null, 'claude-opus-5-5[1m]'],
          'diff-review': ['gpt-6-astra[1m]', 'xhigh', 'claude-sonnet-5[1m]'],
          'code-review': ['gpt-6-astra[1m]', 'xhigh', 'claude-sonnet-5[1m]'],
          'doubt-review': ['gpt-6-astra[1m]', 'xhigh', 'claude-sonnet-5[1m]'],
        };
        const resolved = ROLE_NAMES.every((role) => {
          const route = resolveRoute(role, repoScratch);
          const [model, effort, fallbackModel] = want[role];
          return route.error === undefined && route.engine === 'claude' && route.model === model
            && route.effort === effort && (route.fallback?.model ?? null) === fallbackModel;
        });
        return ROLE_NAMES.length === 8 && resolved && existsSync(globalFile);
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
          && delivered.startsWith(composeBrief('code-review', 'review the artifact at revision deadbeef').prompt);
      })(),
    );
    check(
      'the stamp names the checklist file the briefs read: the repository\'s, or the plugin\'s',
      (() => {
        const project = mkdtempSync(join(tmpdir(), 'dispatch-checklist-'));
        try {
          const stub = () => `${'a'.repeat(40)}\n`;
          const stamp = () => dispatchContextStamp(project, 'code-review', stub);
          const none = stamp();
          mkdirSync(join(project, '.autoloop'));
          writeFileSync(join(project, '.autoloop', 'config.json'),
            JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' } }));
          const plugin = stamp();
          writeFileSync(join(project, '.autoloop', 'checklist.md'), '# mine\n');
          const own = stamp();
          return !none.includes('checklist:') && plugin.includes(`checklist: ${PLUGIN_CHECKLIST}\n`)
            && own.includes('checklist: .autoloop/checklist.md\n');
        } finally {
          rmSync(project, { recursive: true, force: true });
        }
      })(),
    );
    // LFE run 2026-09-30: a writer cd'd into a package, then named paths
    // from the repository root ("No such file"), and looked for its own
    // transcript (never persisted) to re-read a finding from its brief.
    check(
      'the stamp names the brief\'s file and the directory every Bash call starts in',
      (() => {
        const stamp = dispatchContextStamp(repoScratch, 'implement', () => `${'a'.repeat(40)}\n`, '/tmp/autoloop-9/fix-prompt.md');
        return stamp.includes('brief: /tmp/autoloop-9/fix-prompt.md\n')
          && stamp.includes(`working directory: ${repoScratch}`)
          && !dispatchContextStamp(repoScratch, 'implement', () => `${'a'.repeat(40)}\n`).includes('brief:');
      })(),
    );
    check(
      'every dispatch returns each Bash call to the checkout it launched in',
      dispatchEnvironment().CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR === '1'
        && dispatchEnvironment('http://127.0.0.1:1').CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR === '1',
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
      'a configured effort pins a dispatch and reaches the engine argv; a writer without one passes none',
      (() => {
        resetModels();
        writeEngineShim(shimDirectory, shimBody(resultEvent({ structured_output: PASSING_VERDICT })));
        const pinned = runDispatch({
          role: 'code-review', prompt: 'review', tools: reviewerTools, cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
        });
        const argv = readFileSync(argvPath, 'utf8');
        return pinned.ok === true && pinned.effort === 'xhigh' && argv.includes('--effort xhigh')
          && argv.includes('--model gpt-6-astra[1m]')
          && resolveDefaultEffort('implement', repoScratch) === null;
      })(),
    );
    check(
      'an invalid model table fails the dispatch closed, typed, and names why',
      (() => {
        setModels({ 'code-review': { effort: 'extreme' } });
        const badEffort = runDispatch({
          role: 'code-review', prompt: 'x', tools: reviewerTools, cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
        });
        // No artifact is judged by the model that wrote it: a table that lets
        // one happen never runs.
        setModels({ 'plan-review': { model: 'gpt-6-astra[1m]' } });
        const clash = runDispatch({
          role: 'implement', prompt: 'x', tools: writerTools, cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
        });
        resetModels();
        return badEffort.ok === false && badEffort.error.code === 'MODELS_INVALID'
          && badEffort.error.message.includes('models.code-review.effort')
          && clash.ok === false && clash.error.code === 'MODELS_INVALID'
          && clash.error.message.includes('plan-review could run on gpt-6-astra[1m]');
      })(),
    );
    check(
      'the CLI carries --effort through to the engine, and rejects an unknown level',
      (() => {
        if (parseArgs(['--role', 'code-review', '--prompt-file', '/p', '--effort', 'nope'])
          .error === null) {
          return false;
        }
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
      'every role runs on the claude engine',
      resolveDefaultEngine('code-review', repoScratch) === 'claude'
      && resolveDefaultEngine('implement', repoScratch) === 'claude',
    );
    check(
      'every dispatch records its own window in the dispatch log',
      logged.length === 3
      && logged.every((entry) =>
        Number.isSafeInteger(entry.startedAtMs)
        && entry.startedAtMs > 0
        && Number.isSafeInteger(entry.ms)
        && entry.ms >= 0
        && typeof entry.ok === 'boolean')
      // Roles, engines and outcomes are all recorded, so overlap accounting can
      // tell a review apart from a writer after the fact.
      && logged.map(({ role, engine, ok }) => `${role}/${engine}/${ok}`).join(' ')
        === 'implement/claude/false implement/claude/true plan-review/codex/false',
    );
    // The branch ties a dispatch to its unit (a loop branch names its issue), so
    // the run record can itemize a unit's dispatches from this log alone.
    check(
      'every dispatch log entry names the branch it ran on',
      logged.length > 0 && logged.every(({ branch }) => branch === 'main'),
    );
    // Plan and plan-review run before the unit's branch exists, often while the
    // checkout sits on another unit's branch, so the issue is passed explicitly.
    check(
      'a dispatch given --issue logs it, and one without logs none',
      logged[1]?.issue === 7 && logged[0]?.issue === undefined
      && parseArgs(['--role', 'plan', '--prompt-file', '/p', '--issue', '42']).issue === 42
      && parseArgs(['--role', 'plan', '--prompt-file', '/p', '--issue', '0']).error !== null
      && parseArgs(['--role', 'plan', '--prompt-file', '/p', '--issue', 'x']).error !== null,
    );

    // Each role resolves ONLY its own entry: the 2026-08 incident was a plan
    // that inherited the review model because one recording served every role.
    resetModels();
    const routedEnv = (role, extra = {}) => {
      writeEngineShim(shimDirectory, shimBody(ROLES[role].result === 'text'
        ? `printf x > "routed-$$.txt"\n${resultEvent({ result: 'done' })}`
        : resultEvent({ structured_output: role === 'plan'
          ? { title: 'Plan', prBody: 'p', body: 'b' }
          : PASSING_VERDICT })));
      const saved = process.env.ANTHROPIC_BASE_URL;
      process.env.ANTHROPIC_BASE_URL = 'http://session-wide.invalid';
      try {
        const result = runDispatch({
          role,
          prompt: 'route me',
          tools: resolveTools(role),
          cwd: repoScratch,
          engine: join(shimDirectory, 'claude'),
          ...extra,
        });
        const env = readFileSync(envPath, 'utf8');
        const url = /^ANTHROPIC_BASE_URL=(.*)$/mu.exec(env)?.[1] ?? null;
        return { result, url, argv: readFileSync(argvPath, 'utf8') };
      } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
        else process.env.ANTHROPIC_BASE_URL = saved;
      }
    };
    // The proxy is the session's: a dispatch inherits the session's
    // environment untouched, whatever model it runs.
    check(
      'every dispatch inherits the session\'s ANTHROPIC_BASE_URL and runs its own role\'s model',
      (() => {
        const plan = routedEnv('plan');
        const review = routedEnv('code-review');
        const write = routedEnv('implement');
        return [plan, review, write].every(({ url }) => url === 'http://session-wide.invalid')
          && plan.argv.includes('--model gpt-6-astra[1m]') && review.argv.includes('--model gpt-6-astra[1m]')
          && write.argv.includes('--model claude-opus-5-5[1m]') && write.result.route === undefined;
      })(),
    );
    check(
      'a --model override runs as given',
      routedEnv('code-review', { model: 'claude-opus-5-5' }).argv.includes('--model claude-opus-5-5'),
    );
    check(
      '--fallback runs the configured fallback model, stamped; a null fallback fails typed',
      (() => {
        const simplify = routedEnv('simplify', { fallback: true });
        const planReview = routedEnv('plan-review', { fallback: true });
        setModels({ implement: { fallback: null } });
        const refused = runDispatch({
          role: 'implement', prompt: 'x', tools: writerTools, cwd: repoScratch,
          engine: join(shimDirectory, 'claude'), fallback: true,
        });
        resetModels();
        return simplify.result.ok === true && simplify.argv.includes('--model claude-opus-5-5[1m]')
          && simplify.result.fallback === true && simplify.result.model === 'claude-opus-5-5[1m]'
          && planReview.argv.includes('--model claude-sonnet-5[1m]')
          && refused.ok === false && refused.error.code === 'ROUTE_FALLBACK_MISSING';
      })(),
    );
    // Review of the model config: a run's dispatches run the table prime
    // pinned, so a writer editing its branch's config cannot move its own
    // reviewers; with no pin, an invalid project config refuses.
    check(
      'a pinned table wins over the checkout\'s config; unpinned, an invalid project config refuses',
      (() => {
        const projectConfig = join(repoScratch, '.autoloop', 'config.json');
        mkdirSync(dirname(projectConfig), { recursive: true });
        writeFileSync(projectConfig, JSON.stringify({
          version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' },
          models: { 'code-review': { model: 'claude-haiku-4-5' } },
        }));
        const pin = pinnedModelsPath(repoScratch);
        pinModels(pin, resolveModels({ projectModels: undefined }));
        const pinnedRoute = resolveRoute('code-review', repoScratch);
        rmSync(pin);
        const unpinned = resolveRoute('code-review', repoScratch);
        writeFileSync(projectConfig, JSON.stringify({
          version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' },
          models: { 'code-review': { effort: 'extreme' } },
        }));
        const invalid = resolveRoute('code-review', repoScratch);
        rmSync(join(repoScratch, '.autoloop'), { recursive: true, force: true });
        return pinnedRoute.model === 'gpt-6-astra[1m]' && pinnedRoute.source === 'pinned'
          && unpinned.model === 'claude-haiku-4-5' && unpinned.source === 'config'
          && invalid.error?.code === 'MODELS_INVALID';
      })(),
    );
    check(
      'the project config overrides the global one per field',
      (() => {
        setModels({ implement: { effort: 'high' } });
        const projectConfig = join(repoScratch, '.autoloop', 'config.json');
        mkdirSync(dirname(projectConfig), { recursive: true });
        writeFileSync(projectConfig, JSON.stringify({
          version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' },
          models: { implement: { model: 'claude-opus-5-5' } },
        }));
        const route = resolveRoute('implement', repoScratch);
        rmSync(join(repoScratch, '.autoloop'), { recursive: true, force: true });
        resetModels();
        return route.model === 'claude-opus-5-5' && route.effort === 'high'
          && route.fallback?.model === 'claude-fable-5-1[1m]';
      })(),
    );
    check(
      'simplify and fix write; diff-review reads and returns a verdict',
      ROLES.simplify.posture === 'writer' && ROLES.fix.posture === 'writer'
      && ROLES['diff-review'].posture === 'reviewer'
      && ROLES['diff-review'].result === 'review-verdict'
      && resolveTools('diff-review', 'Read,Write') === null
      && resolveTools('simplify', 'Edit,Read') !== null,
    );
    check(
      'the CLI carries --fallback',
      parseArgs(['--role', 'simplify', '--prompt-file', 'p', '--fallback']).fallback === true,
    );

    // dispatch-resilience (SPEC-self-healing.md). Runs stopped on failures that
    // a rerun would have cleared: a reviewer that died mid-stream, a planner at
    // its usage limit with a recorded fallback it never took.
    resetModels();
    const countFile = join(scratch, 'spawns.txt');
    const spawnsOf = (role, script, extra = {}) => {
      rmSync(countFile, { force: true });
      writeEngineShim(shimDirectory, shimBody(`echo x >> "${countFile}"\n${script}`));
      const result = runDispatch({
        role,
        prompt: 'resilience',
        tools: resolveTools(role),
        cwd: repoScratch,
        engine: join(shimDirectory, 'claude'),
        retryDelayMs: 0,
        ...extra,
      });
      return { result, spawns: readFileSync(countFile, 'utf8').trim().split('\n').length };
    };
    const verdictOnSecond = `[ "$(wc -l < "${countFile}")" -ge 2 ] || exit 7\n`
      + resultEvent({ structured_output: PASSING_VERDICT });
    check(
      'an effect-free role retries a transient failure unchanged, and logs each code',
      (() => {
        const { result, spawns } = spawnsOf('code-review', verdictOnSecond);
        const tail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-2)
          .map((line) => JSON.parse(line));
        return result.ok === true && spawns === 2
          && result.earlierAttempts?.[0] === 'ENGINE_EXIT_NONZERO on gpt-6-astra[1m]'
          && tail[0].ok === false && tail[0].code === 'ENGINE_EXIT_NONZERO'
          && tail[1].ok === true && tail[1].code === undefined;
      })(),
    );
    check(
      'a route without a fallback retries at most twice, then fails typed',
      (() => {
        setModels({ 'code-review': { fallback: null } });
        const { result, spawns } = spawnsOf('code-review', 'exit 7');
        resetModels();
        return result.ok === false && spawns === 3
          && result.error.code === 'ENGINE_EXIT_NONZERO'
          && result.error.earlierAttempts.length === 2;
      })(),
    );
    check(
      'a writer is never rerun by the tool: it may have committed before it died',
      ['implement', 'fix', 'simplify'].every((role) => {
        const { result, spawns } = spawnsOf(role, 'exit 7');
        return result.ok === false && spawns === 1;
      }),
    );
    const limitedOnAstra = 'case "$*" in *gpt-6-astra*) '
      + `printf 'You have hit your usage limit\\n' >&2; exit 1;; esac\n`
      + resultEvent({ structured_output: { title: 'Plan', prBody: 'p', body: 'b' } });
    check(
      'a usage limit moves an effect-free role straight to its fallback, stamped',
      (() => {
        const { result, spawns } = spawnsOf('plan', limitedOnAstra);
        const last = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').at(-1));
        return result.ok === true && spawns === 2
          && result.fallback === true && result.model === 'claude-opus-5-5[1m]'
          && result.earlierAttempts[0] === 'ENGINE_EXIT_NONZERO (usage limit) on gpt-6-astra[1m]'
          && last.fallback === true;
      })(),
    );
    check(
      'a usage limit moves a reviewer to its configured fallback; a pinned model is not rerouted',
      (() => {
        const limitedReview = 'case "$*" in *gpt-6-astra*) '
          + `printf 'You have hit your usage limit\\n' >&2; exit 1;; esac\n`
          + resultEvent({ structured_output: PASSING_VERDICT });
        const review = spawnsOf('code-review', limitedReview);
        const pinned = spawnsOf('plan', limitedOnAstra, { model: 'gpt-6-astra' });
        return review.result.ok === true && review.spawns === 2
          && review.result.model === 'claude-sonnet-5[1m]' && review.result.fallback === true
          // An explicit --model is the caller's choice; the tool does not reroute it.
          && pinned.result.ok === false && pinned.spawns === 1;
      })(),
    );
    check(
      'a writer at its limit is flagged for the orchestrator, not rerouted',
      (() => {
        const limitedOnOpus = 'case "$*" in *claude-opus-5-5*) '
          + `printf 'You have hit your usage limit\\n' >&2; exit 1;; esac\n`
          + resultEvent({ result: 'done' });
        const { result, spawns } = spawnsOf('fix', limitedOnOpus);
        return result.ok === false && spawns === 1 && result.error.usageLimit === true
          && result.fallback === undefined;
      })(),
    );
    check(
      'two consecutive failures on a route move to its fallback, once',
      (() => {
        const failsOnFable = 'case "$*" in *claude-fable-5-1*) exit 7;; esac\n'
          + resultEvent({ structured_output: PASSING_VERDICT });
        const moved = spawnsOf('plan-review', failsOnFable);
        const nowhere = spawnsOf('plan-review', 'exit 7');
        return moved.result.ok === true && moved.spawns === 3
          && moved.result.model === 'claude-sonnet-5[1m]' && moved.result.fallback === true
          && nowhere.result.ok === false && nowhere.spawns === 3
          && nowhere.result.error.fallback === true;
      })(),
    );
    check(
      'a result the engine flags as an error is never accepted as a result',
      (() => {
        const { result, spawns } = spawnsOf('code-review', resultEvent({
          is_error: true, result: 'Claude AI usage limit reached|1760000000',
        }));
        // The limit moves it to its fallback once; that attempt is refused
        // the same way and is not accepted either.
        return result.ok === false && spawns === 2 && result.fallback === undefined
          && result.error.code === 'ENGINE_RESULT_MISSING' && result.error.usageLimit === true;
      })(),
    );
    check(
      'the limit detector reads failure reports, never the transcript body',
      usageLimitIn("You've reached your weekly limit", '')
      && usageLimitIn('', '{"type":"error","message":"429 rate_limit_error"}')
      && !usageLimitIn('', JSON.stringify({
        type: 'assistant', message: { content: 'the proxy returns 429 on rate limit' },
      }))
      && !usageLimitIn('', JSON.stringify({ type: 'result', subtype: 'success', result: 'rate limit' }))
      && !usageLimitIn('engine blew up', 'not json')
      // A bare 429 is a line number as often as a status: a stack frame in
      // stderr must not move the retry onto the fallback model.
      && usageLimitIn('exceeded retry limit, last status: 429 Too Many Requests', '')
      // A proxy answering 429 with no body carries no rate-limit words at all.
      && usageLimitIn('API Error: 429 status code (no body)', '')
      && !usageLimitIn('TypeError: x is undefined\n    at run (/srv/app.js:429:12)', ''),
    );
    check(
      'only reviewer-posture roles, transient codes, and the attempt bound allow a rerun',
      nextAttempt('code-review', { code: 'INVALID_REVIEW_VERDICT' },
        { attempts: 1, timeouts: 0, onFallback: false, fallbackAvailable: true }) === null
      && nextAttempt('code-review', { code: 'DISPATCH_TIMEOUT' },
        { attempts: 2, timeouts: 2, onFallback: false, fallbackAvailable: false }) === null
      && nextAttempt('plan', { code: 'DISPATCH_TIMEOUT' },
        { attempts: 1, timeouts: 1, onFallback: false, fallbackAvailable: true }) === 'retry'
      && nextAttempt('plan', { code: 'ENGINE_RESULT_EMPTY' },
        { attempts: 3, timeouts: 0, onFallback: true, fallbackAvailable: true }) === null
      && nextAttempt('implement', { code: 'ENGINE_EXIT_NONZERO', usageLimit: true },
        { attempts: 1, timeouts: 0, onFallback: false, fallbackAvailable: true }) === null,
    );
    // SPEC-model-config: a model the session cannot serve did nothing, so any
    // role, a writer too, moves to its fallback (measured: exit 1, zero
    // tokens, `"error":"model_not_found"`).
    const unavailableOn = (model, success) => `case "$*" in *${model}*) `
      + `printf '[claude-code:unrecognized_model] {"model":"${model}"}\\n' >&2; `
      + `printf '%s\\n' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'the selected model is unavailable' })}'; exit 1;; esac\n`
      + success;
    check(
      'an unavailable model moves any role, a writer too, to its fallback once, stamped',
      (() => {
        const plan = spawnsOf('plan', unavailableOn('gpt-6-astra', resultEvent({ structured_output: { title: 'Plan', prBody: 'p', body: 'b' } })));
        const writer = spawnsOf('fix', unavailableOn('claude-opus-5-5', `printf x > "fell-back-$$.txt"\n${resultEvent({ result: 'done' })}`));
        const both = spawnsOf('fix', unavailableOn('claude-', resultEvent({ result: 'done' })));
        return plan.result.ok === true && plan.spawns === 2 && plan.result.model === 'claude-opus-5-5[1m]'
          && plan.result.fallback === true
          && plan.result.earlierAttempts[0] === 'ENGINE_EXIT_NONZERO (model unavailable) on gpt-6-astra[1m]'
          && writer.result.ok === true && writer.spawns === 2 && writer.result.model === 'claude-fable-5-1[1m]'
          && both.result.ok === false && both.spawns === 2 && both.result.error.modelUnavailable === true;
      })(),
    );
    check(
      'a writer that changed the checkout is never sent to its fallback, whatever it reports',
      (() => {
        const worked = `printf x > "worked-$$.txt"\n${unavailableOn('claude-opus-5-5', resultEvent({ result: 'done' })).replace(/^case/u, 'case')}`;
        const { result, spawns } = spawnsOf('fix', worked);
        return result.ok === false && spawns === 1 && result.error.modelUnavailable === undefined;
      })(),
    );
    check(
      'the unavailable-model detector reads failure reports, never the transcript body',
      modelUnavailableIn('[claude-code:unrecognized_model] {"model":"x"}', '')
      && modelUnavailableIn('', JSON.stringify({ type: 'assistant', error: 'model_not_found', message: { model: '<synthetic>' } }))
      && modelUnavailableIn('', JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "There's an issue with the selected model (x)." }))
      && !modelUnavailableIn('', JSON.stringify({ type: 'assistant', message: { content: 'model_not_found is what the API says' } }))
      && !modelUnavailableIn('', JSON.stringify({ type: 'result', subtype: 'success', result: "There's an issue with the selected model" }))
      // Review of the model config: a run that did work is not an unavailable
      // model, whatever a subagent or the final text says.
      && !modelUnavailableIn('[claude-code:unrecognized_model] {"model":"haiku"}', [
        JSON.stringify({ type: 'assistant', parent_tool_use_id: 't1', error: 'model_not_found', message: { model: '<synthetic>' } }),
        JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 80, usage: { input_tokens: 90000, output_tokens: 4000 } }),
      ].join('\n'))
      && !modelUnavailableIn('', JSON.stringify({ type: 'assistant', parent_tool_use_id: 't1', error: 'model_not_found' }))
      && modelUnavailableIn('', JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 }, result: "There's an issue with the selected model (x)." }))
      && nextAttempt('implement', { code: 'ENGINE_EXIT_NONZERO', modelUnavailable: true },
        { attempts: 1, timeouts: 0, onFallback: false, fallbackAvailable: true }) === 'fallback'
      && nextAttempt('implement', { code: 'ENGINE_EXIT_NONZERO', modelUnavailable: true },
        { attempts: 2, timeouts: 0, onFallback: true, fallbackAvailable: true }) === null,
    );
    resetModels();
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
    // 2026-07-28: a writer grinding a Go task landed two commits and was killed
    // at a flat 30-minute ceiling. The bound exists for WEDGED children, and the
    // two postures wedge differently — a writer legitimately grinds through its
    // plan's tasks, a reviewer returns one verdict and is stuck if it has not.
    check(
      'the ceiling is per posture: a writer grinds, a reviewer should not',
      timeoutMsFor('implement') === 120 * 60 * 1000
      && timeoutMsFor('plan') === 45 * 60 * 1000
      && timeoutMsFor('code-review') === 45 * 60 * 1000
      && timeoutMsFor('implement') > timeoutMsFor('code-review'),
    );
    check(
      'an unknown role gets the tighter ceiling, never the writer budget',
      timeoutMsFor('not-a-role') === 45 * 60 * 1000,
    );
    check(
      'a timeout names its ceiling and warns against a blind retry',
      timedOut.error.message.includes('writer ceiling')
      && timedOut.error.message.includes('never by blind retry'),
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

  check(
    'a wait ends early only when the recorded dispatch is gone without a result',
    (() => {
      const directory = mkdtempSync(join(tmpdir(), 'autoloop-wait-'));
      try {
        const result = join(directory, 'r.json');
        const none = waitState(result);
        writeFileSync(`${result}.pid`, '4242\n');
        const running = waitState(result, () => true);
        const gone = waitState(result, () => false);
        writeFileSync(`${result}.pid`, 'garbage\n');
        const unreadable = waitState(result, () => false);
        writeFileSync(result, '{}');
        const done = waitState(result, () => false);
        return none === 'waiting' && running === 'waiting' && gone === 'gone'
          && unreadable === 'waiting' && done === 'done';
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    })(),
  );

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

// dispatch-stream.sh detaches the dispatch and records its pid beside the
// result, so a killed stream task no longer means a dead dispatch. `gone` is
// the one state a wait can end on early: the recorded process no longer exists
// and left no result. Anything unreadable is `waiting` — the bound still ends it.
export function waitState(path, alive = processAlive) {
  if (existsSync(path)) return 'done';
  let pid;
  try {
    pid = Number(readFileSync(`${path}.pid`, 'utf8').trim());
  } catch {
    return 'waiting';
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || alive(pid)) return 'waiting';
  // The result is renamed into place before the process exits; look once more.
  return existsSync(path) ? 'done' : 'gone';
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function runWaitCli(parsed) {
  const deadline = Date.now() + parsed.timeoutSeconds * 1000;
  const poll = () => {
    const state = waitState(parsed.path);
    if (state === 'done') {
      console.log(`wait: ${parsed.path} exists`);
      process.exit(0);
    }
    if (state === 'gone') {
      console.error(`wait: the dispatch recorded in ${parsed.path}.pid ended without writing `
        + `${parsed.path} — a killed dispatch; run the kill drill`);
      process.exit(3);
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
      + '[--tools <csv>] [--engine <name>] [--model <name>] [--fallback] '
      + `[--effort <${[...EFFORTS].join('|')}>] [--output-file <path>] [--json]\n`
      + '       models, efforts and fallbacks: ~/.claude/autoloop/config.json, overridden by .autoloop/config.json `models`',
    );
    process.exit(2);
  }
  if (parsed.mode === 'self-test') {
    // Every dispatch resolves models, which writes the global config when it
    // is missing: a self-test must never write the operator's own.
    const configDir = mkdtempSync(join(tmpdir(), 'dispatch-config-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const passed = selfTest();
    rmSync(configDir, { recursive: true, force: true });
    process.exit(passed ? 0 : 1);
  }

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
    const stale = stalePromptProblem(parsed.promptFile, currentRunStartMs());
    if (stale !== null) throw new Error(stale);
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
    ...(parsed.fallback ? { fallback: true } : {}),
    ...(parsed.issue === null ? {} : { issue: parsed.issue }),
    readRoots: [dirname(resolve(parsed.promptFile)), pluginsDir()],
    promptFile: resolve(parsed.promptFile),
  });
  const serialized = `${JSON.stringify(result, null, 1)}\n`;
  if (parsed.outputFile !== null) {
    const path = resolve(parsed.outputFile);
    mkdirSync(dirname(path), { recursive: true });
    // Renamed into place, so a waiter polling for the file never reads half of it.
    writeFileSync(`${path}.tmp`, serialized);
    renameSync(`${path}.tmp`, path);
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
