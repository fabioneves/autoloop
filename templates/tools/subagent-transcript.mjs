#!/usr/bin/env node
// Subagent transcript capture for the autoloop (Codex SubagentStop hook + opencode plugin).
// Codex's SubagentStop hook payload carries `transcript_path` (manual, hooks "Common input
// fields"). This hook copies that file plus the raw payload into the repository's common Git
// directory under `autoloop/subagent-transcripts/` so captures can never be committed or dirty
// any linked worktree. A Codex host-child route is unavailable when its typed agent/fresh-session
// surface cannot be proven; transcript capture does not turn prompt-level isolation into a safe
// fallback.
//
// CAVEAT the consumer must respect (autoloop:dev Prime): the manual describes `transcript_path`
// as "the session transcript" and subagent hooks reuse the PARENT session id, so whether the
// file holds the child's turns or the parent's is NOT verified. The orchestrator must confirm
// a capture contains the child's activity (e.g. the reviewer's own verdict text) before
// treating it as isolation evidence; otherwise record `transcript: unavailable` as before.
//
// Loop-safety: fail-open — a capture failure warns on stderr and exits 0; a subagent stop must
// never wedge the turn. Prunes oldest captures beyond KEEP_FILES. --self-test runs the
// pure-function fixtures.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEEP_FILES = 40; // ISO-stamped names sort chronologically; oldest pruned first

export function resolveCaptureDirectory(root, readCommonDir = (cwd) => execFileSync(
  'git',
  ['rev-parse', '--git-common-dir'],
  {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)) {
  const commonRaw = String(readCommonDir(root) ?? '').trim();
  if (!commonRaw) throw new Error('Git common directory is unavailable');
  const common = isAbsolute(commonRaw)
    ? resolve(commonRaw)
    : resolve(root, commonRaw);
  return join(common, 'autoloop', 'subagent-transcripts');
}

export function planCapture(payload, stamp, existingFiles) {
  const hasPath = payload && typeof payload.transcript_path === 'string' && payload.transcript_path;
  // opencode child payload: the plugin ships the child's messages inline (SDK
  // session.children/messages) instead of a file path; an EMPTY array is still captured —
  // an empty child transcript is itself evidence.
  const hasMessages = payload && Array.isArray(payload.messages);
  const plan = {
    payloadFile: `${stamp}-payload.json`,
    transcriptCopy: hasPath || hasMessages ? `${stamp}-transcript.jsonl` : null,
    prune: [],
  };
  const total = existingFiles.length + 1 + (plan.transcriptCopy ? 1 : 0);
  if (total > KEEP_FILES) {
    plan.prune = [...existingFiles].sort().slice(0, total - KEEP_FILES);
  }
  return plan;
}

export function normalizedMetadata(payload) {
  const { messages, ...metadata } = payload ?? {};
  if (
    metadata.hook_event_name === 'SubagentStop'
    && ['Explore', 'explore'].includes(
      metadata.agent_type ?? metadata.agentType,
    )
  ) {
    metadata.read_only = true;
    metadata.permissions = {
      ...(metadata.permissions ?? {}),
      write: false,
    };
  }
  return metadata;
}

function capture() {
  const captureDir = resolveCaptureDirectory(ROOT);
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch { /* no stdin */ }
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write('autoloop: SubagentStop hook received unparseable stdin — payload not captured\n');
  }
  mkdirSync(captureDir, { recursive: true });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const plan = planCapture(payload, stamp, readdirSync(captureDir));
  const meta = payload === null ? null : normalizedMetadata(payload);
  writeFileSync(join(captureDir, plan.payloadFile), JSON.stringify(meta, null, 2) ?? 'null');
  if (plan.transcriptCopy) {
    if (Array.isArray(payload?.messages)) {
      writeFileSync(
        join(captureDir, plan.transcriptCopy),
        payload.messages.map((message) => JSON.stringify(message)).join('\n')
          + (payload.messages.length ? '\n' : ''),
      );
    } else if (existsSync(payload.transcript_path)) {
      copyFileSync(payload.transcript_path, join(captureDir, plan.transcriptCopy));
    } else {
      process.stderr.write(`autoloop: transcript_path ${payload.transcript_path} not readable — payload captured without transcript\n`);
    }
  }
  for (const f of plan.prune) rmSync(join(captureDir, f), { force: true });
}

function selfTest() {
  const cases = [
    { name: 'payload+transcript', payload: { transcript_path: '/tmp/t.jsonl' }, existing: [], want: { transcript: true, prune: 0 } },
    { name: 'no transcript_path', payload: { hook_event_name: 'SubagentStop' }, existing: [], want: { transcript: false, prune: 0 } },
    { name: 'null payload', payload: null, existing: [], want: { transcript: false, prune: 0 } },
    { name: 'opencode child payload', payload: { sessionID: 'ses_x', agent: 'autoloop-reviewer', messages: [{ info: { role: 'user' } }] }, existing: [], want: { transcript: true, prune: 0 } },
    { name: 'opencode empty messages still captured', payload: { sessionID: 'ses_x', agent: 'build', messages: [] }, existing: [], want: { transcript: true, prune: 0 } },
    { name: 'opencode messages not an array', payload: { sessionID: 'ses_x', messages: 'nope' }, existing: [], want: { transcript: false, prune: 0 } },
    { name: 'prunes oldest beyond cap', payload: { transcript_path: '/tmp/t.jsonl' }, existing: Array.from({ length: KEEP_FILES }, (_, i) => `2026-01-01T00-00-${String(i).padStart(2, '0')}-1-payload.json`), want: { transcript: true, prune: 2, oldestPruned: '2026-01-01T00-00-00-1-payload.json' } },
  ];
  let ok = true;
  for (const c of cases) {
    const plan = planCapture(c.payload, 'stamp', c.existing);
    const got = { transcript: Boolean(plan.transcriptCopy), prune: plan.prune.length };
    if (got.transcript !== c.want.transcript || got.prune !== c.want.prune ||
        (c.want.oldestPruned && plan.prune[0] !== c.want.oldestPruned)) {
      ok = false;
      console.log(`self-test case failed: ${c.name} → ${JSON.stringify(plan)}`);
    }
  }
  const directoryCases = [
    {
      name: 'regular checkout',
      root: '/srv/repo',
      common: '.git\n',
      want: '/srv/repo/.git/autoloop/subagent-transcripts',
    },
    {
      name: 'linked worktree',
      root: '/srv/worktrees/change',
      common: '/srv/repo/.git\n',
      want: '/srv/repo/.git/autoloop/subagent-transcripts',
    },
  ];
  for (const c of directoryCases) {
    const got = resolveCaptureDirectory(c.root, () => c.common);
    if (got !== c.want) {
      ok = false;
      console.log(`self-test case failed: ${c.name} → ${got}`);
    }
  }
  const explore = normalizedMetadata({
    hook_event_name: 'SubagentStop',
    agent_type: 'Explore',
    messages: [],
  });
  if (
    explore.messages !== undefined
    || explore.read_only !== true
    || explore.permissions?.write !== false
  ) {
    ok = false;
    console.log('self-test case failed: Claude Explore metadata normalization');
  }
  // Git reports realpaths, so a macOS TMPDIR reached through /var -> /private/var
  // would make the fixture root and the CLI's resolved root disagree.
  const cliRoot = mkdtempSync(join(realpathSync(tmpdir()), 'autoloop-subagent-cli-'));
  const cliToolDirectory = join(cliRoot, 'tools', 'agentic');
  mkdirSync(cliToolDirectory, { recursive: true });
  const cliEntrypoint = join(cliToolDirectory, 'subagent-transcript.mjs');
  copyFileSync(fileURLToPath(import.meta.url), cliEntrypoint);
  execFileSync('git', ['init', '-q', cliRoot], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 10000,
  });
  const captureDir = resolveCaptureDirectory(cliRoot);
  const inlineMessages = [
    { info: { role: 'user', agent: 'autoloop-reviewer' } },
    { info: { role: 'assistant', modelID: 'fixture-model' } },
  ];
  try {
    execFileSync(process.execPath, [cliEntrypoint], {
      input: JSON.stringify({
        sessionID: 'fixture-inline-session',
        agent: 'autoloop-reviewer',
        metadata: { tools: ['glob', 'grep', 'list', 'read'] },
        messages: inlineMessages,
      }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    const created = readdirSync(captureDir);
    const payloadFile = created.find((name) => name.endsWith('-payload.json'));
    const transcriptFile = created.find((name) =>
      name.endsWith('-transcript.jsonl'));
    const retainedPayload = payloadFile
      ? JSON.parse(readFileSync(join(captureDir, payloadFile), 'utf8'))
      : null;
    const retainedMessages = transcriptFile
      ? readFileSync(join(captureDir, transcriptFile), 'utf8')
        .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    if (
      created.length !== 2
      || retainedPayload?.agent !== 'autoloop-reviewer'
      || retainedPayload?.messages !== undefined
      || JSON.stringify(retainedMessages) !== JSON.stringify(inlineMessages)
    ) {
      ok = false;
      console.log('self-test case failed: inline-message CLI capture');
    }
  } catch {
    ok = false;
    console.log('self-test case failed: inline-message CLI capture');
  } finally {
    rmSync(cliRoot, { recursive: true, force: true });
  }
  console.log(ok ? 'self-test OK' : 'self-test FAILED');
  return ok;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  try {
    capture();
  } catch (e) {
    process.stderr.write(`autoloop: subagent transcript capture failed (${e.message}) — continuing\n`);
  }
  process.exit(0);
}
