#!/usr/bin/env node
// autoloop — edit-guard.mjs
//
// PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit. While this session
// owns a run (from its prime to /clear or exit; --close-run does not end
// it), it refuses edits to
// the repository's hook wiring —
// `.claude/settings.json` and `.claude/settings.local.json` — the one edit
// that can switch the session's own guard off mid-run (repository settings can
// still disable plugin hooks). Everything else stays editable: loop
// configuration and prose (.autoloop/, .claude/skills) are built through the
// queue and flagged `human:authorize` at merge, which is STATE's standing
// policy (operator, 2026-09-29).
//
// It also refuses edits to the run's own state — the run markers and the
// session latches — and to the guard's own code, the plugin's tools and hooks
// (run-state-guard.mjs says why): the Write-tool twin of the command guard's
// rule.
//
// A separate file from command-guard because the payload differs (an Edit
// carries no Bash command).
//
//   node <plugin-tools>/edit-guard.mjs --self-test

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heldLatch, ownedRun, processStart, protectedPaths, sessionOwnerPid, executionProtectedPaths } from './run-markers.mjs';
import { canonicalGuardPath as canonical, guardPathForms, rawGuardAbsolutePath, knownExecutionStatePath } from './run-state-guard.mjs';
import { workerToolContext } from './loop-execution-admission.mjs';
import { hookRoot } from './hook-root.mjs';
import { gitStalled, setGitDeadline } from './git-budget.mjs';

const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const HOOK_WIRING = Object.freeze(['.claude/settings.json', '.claude/settings.local.json']);

export function hookWiringEditProblem(filePath, repoRoot, live) {
  if (!live || typeof filePath !== 'string' || filePath.length === 0) return null;
  const root = canonical(repoRoot);
  const target = canonical(rawGuardAbsolutePath(filePath, repoRoot));
  const relativePath = relative(root, target).split(sep).join('/');
  if (!HOOK_WIRING.includes(relativePath.toLowerCase())) return null;
  return `autoloop guard — ${relativePath} is this session's hook wiring, and a session that ran `
    + 'the loop never edits it: the edit could switch the guard itself off. A change there is a '
    + 'human\'s, or autoloop:setup\'s in a new session.';
}

export function runStateEditProblem(filePath, repoRoot, protectedDirs, live, { codeAliases = true } = {}) {
  if (!live || typeof filePath !== 'string' || filePath.length === 0) return null;
  const targets = guardPathForms(filePath, repoRoot);
  const target = targets.at(-1);
  const hit = protectedDirs.filter((dir) => typeof dir === 'string')
    .find((dir) => (codeAliases ? [dir, canonical(dir)] : [dir])
      .some((form) => targets.some((path) => path === form || path.startsWith(`${form}${sep}`))));
  if (hit === undefined) return null;
  return `autoloop guard — ${target} is this run's own state (${hit}): the run markers and the session `
    + 'latch are how the guard knows a run is open, so a run never writes them.';
}

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };
  const blocked = (path, live = true, root = '/r') => hookWiringEditProblem(path, root, live) !== null;
  check('the hook wiring is refused during a live run, in any case and relative form',
    blocked('/r/.claude/settings.json') && blocked('/r/.claude/settings.local.json')
      && blocked('/r/.CLAUDE/Settings.JSON') && blocked('.claude/settings.json'));
  // Review of 0.55.5: a live run builds loop infrastructure through the queue,
  // and Claude Code nests agent worktrees under .claude/worktrees.
  check('everything else stays editable, including nested agent worktrees and loop tools',
    !blocked('/r/.claude/skills/foo/SKILL.md') && !blocked('/r/.claude/worktrees/a/src/x.ts')
      && !blocked('/r/.claude/worktrees/a/.claude/settings.json')
      && !blocked('/r/tools/agentic/command-guard.mjs') && !blocked('/r/docs/agentic/STATE.md')
      && !blocked('/elsewhere/.claude/settings.json'));
  check('nothing is refused without a live run, or without a path',
    !blocked('/r/.claude/settings.json', false) && !blocked(undefined) && !blocked(''));
  const stateDirs = ['/r/.git/autoloop/run', '/h/.claude/autoloop/run-latches', '/p/tools'];
  const stateBlocked = (path, live = true) => runStateEditProblem(path, '/r', stateDirs, live) !== null;
  check('the run state is refused during a run, the rest of the git dir and the repository are not',
    stateBlocked('/r/.git/autoloop/run/1.json') && stateBlocked('.git/autoloop/run/new.json')
      && stateBlocked('/h/.claude/autoloop/run-latches/x.json') && stateBlocked('/p/tools/command-guard.mjs')
      && !stateBlocked('/r/.git/autoloop/steps/1.json') && !stateBlocked('/r/src/run.ts')
      && !stateBlocked('/r/.git/autoloop/run/1.json', false));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'edit-guard-')));
  try {
    mkdirSync(join(scratch, 'real', '.claude'), { recursive: true });
    symlinkSync(join(scratch, 'real'), join(scratch, 'link'));
    check('a path reached through a symlink is compared by its real location',
      blocked(join(scratch, 'link', '.claude', 'settings.json'), true, join(scratch, 'real'))
        && blocked(join(scratch, 'real', '.claude', 'settings.local.json'), true, join(scratch, 'link')));
    // The latch prime writes, in a scratch HOME: the operator's own must not
    // decide these cases. Only the session it names is guarded.
    const home = join(scratch, 'home');
    const owner = sessionOwnerPid(process.pid);
    mkdirSync(join(home, '.claude', 'autoloop', 'run-latches'), { recursive: true });
    writeFileSync(join(home, '.claude', 'autoloop', 'run-latches', `${owner}.json`), JSON.stringify({
      version: 2, owner, ownerStart: processStart(owner), baseBranch: 'main', scope: join(scratch, 'real'), sessionId: 'S',
    }));
    const edit = (filePath, project, session = 'S') => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      input: JSON.stringify({ session_id: session, tool_name: 'Edit', tool_input: { file_path: filePath } }),
      cwd: project, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: project, AUTOLOOP_GUARD_BUDGET_MS: '2000' },
    });
    const wiring = join(scratch, 'real', '.claude', 'settings.json');
    check('the hook entry refuses a hook-wiring edit for the owning session and allows it for any other',
      edit(wiring, join(scratch, 'real')).status === 2 && edit(wiring, join(scratch, 'real'), 'T').status === 0);
    // Review L3: a payload that is unreadable or names no session may be the
    // owner's while this process holds a latch; H1: --close-run keeps this
    // session guarded until /clear.
    const latchFile = join(home, '.claude', 'autoloop', 'run-latches', `${owner}.json`);
    const raw = (input) => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      input, cwd: join(scratch, 'real'), encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: join(scratch, 'real'), AUTOLOOP_GUARD_BUDGET_MS: '2000' },
    }).status;
    const nameless = () => [raw('not json'), raw(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: wiring } })),
      raw(JSON.stringify({ session_id: '', tool_name: 'Edit', tool_input: { file_path: wiring } }))];
    const heldOpen = nameless();
    const openText = readFileSync(latchFile, 'utf8');
    writeFileSync(latchFile, JSON.stringify({ ...JSON.parse(openText), closedAt: '2026-10-12T00:00:00.000Z' }));
    const heldClosed = nameless();
    const closedOwn = edit(wiring, join(scratch, 'real')).status;
    const closedCleared = edit(wiring, join(scratch, 'real'), 'T').status;
    rmSync(latchFile);
    const unheld = nameless();
    writeFileSync(latchFile, openText);
    check('a closed run keeps the edit guard for its own session until /clear, and a payload naming no session is refused beside a latch',
      JSON.stringify([heldOpen, heldClosed, unheld, closedOwn, closedCleared]) === JSON.stringify([[2, 2, 2], [2, 2, 2], [0, 0, 0], 2, 0]));
    // A FIFO for .git/config stalls git: the owning session's guard refuses
    // within its budget instead of running past the host's timeout.
    const stalled = join(scratch, 'stalled');
    spawnSync('git', ['init', '-q', stalled], { timeout: 10000 });
    rmSync(join(stalled, '.git', 'config'));
    spawnSync('mkfifo', [join(stalled, '.git', 'config')], { timeout: 5000 });
    const stalledAt = Date.now();
    const stalledHook = edit(join(stalled, 'a.txt'), stalled);
    check('a stalled git refuses within the budget', stalledHook.status === 2 && Date.now() - stalledAt < 8000);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

export function runEditGuard({ workerDirectory, inputText, observe = () => {} } = {}) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  // The same budget the command guard keeps: a stalled git (a FIFO for
  // .git/config) must refuse before the host's timeout lets the edit through.
  setGitDeadline(Date.now() + Math.min(10_000, Number(process.env.AUTOLOOP_GUARD_BUDGET_MS) || 10_000));
  let payload = null;
  let guarded = false;
  process.on('uncaughtException', () => {
    const sessionId = payload?.session_id;
    try {
      if (guarded || workerToolContext({ sessionId, cwd: payload?.cwd ?? process.cwd(), workerDirectory }) !== null
        || (typeof sessionId === 'string' && sessionId !== '' ? ownedRun({ sessionId, includeClosed: true }) : heldLatch()) !== null) {
        console.error('autoloop guard — the edit guard failed for a guarded process.'); process.exit(2);
      }
    } catch { process.exit(1); }
    process.exit(0);
  });
  try {
    payload = JSON.parse(inputText ?? readFileSync(0, 'utf8'));
  } catch { /* names no session: decided below */ }
  const sessionId = typeof payload?.session_id === 'string' && payload.session_id !== '' ? payload.session_id : null;
  const worker = workerToolContext({ sessionId, cwd: payload?.cwd ?? process.cwd(), workerDirectory });
  guarded = worker !== null;
  observe('policy-ready');
  if (worker !== null) {
    if (worker.unreadable) { console.error('autoloop guard — the registered worker identity or attempt cannot be verified.'); process.exit(2); }
    if (EDIT_TOOLS.includes(payload?.tool_name)) {
      console.error('autoloop guard — this worker has no admitted write boundary.'); process.exit(2);
    }
  }
  // A payload that is unreadable or names no session may be the owner's
  // while this process holds a latch (open or closed): refused, as the
  // command guard refuses it.
  if (!EDIT_TOOLS.includes(payload?.tool_name) && sessionId !== null) process.exit(0);
  const earlyRoot = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  const filePath = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (typeof filePath === 'string' && guardPathForms(filePath, payload?.cwd ?? earlyRoot).some(knownExecutionStatePath)) {
    console.error('autoloop guard — model tools cannot change named scheduler execution state.'); process.exit(2);
  }
  const executionPaths = executionProtectedPaths({ projectRoot: earlyRoot, cwd: payload?.cwd ?? earlyRoot });
  const earlyProblem = runStateEditProblem(filePath, payload?.cwd ?? earlyRoot, executionPaths.state, true)
    ?? runStateEditProblem(filePath, payload?.cwd ?? earlyRoot, executionPaths.code, true, { codeAliases: false });
  if (earlyProblem !== null) { console.error(earlyProblem); process.exit(2); }
  if (sessionId === null) {
    if (heldLatch() === null) process.exit(0);
    console.error('autoloop guard — the hook payload is unreadable or names no session, so the edit cannot be checked.');
    process.exit(2);
  }
  // Plugin hooks fire in every session; this one guards only the session
  // that owns a run (run-markers.mjs ownedRun) — until /clear or exit, a
  // closed run too — before any git call, and then whatever the checkout
  // says (an unreadable latch of its own too).
  if (ownedRun({ sessionId, includeClosed: true }) === null) process.exit(0);
  const repoRoot = hookRoot();
  // The same paths the command guard protects (run-markers.mjs protectedPaths).
  const paths = protectedPaths({ projectRoot: repoRoot, cwd: payload?.cwd ?? repoRoot, runOpen: true });
  const problem = hookWiringEditProblem(filePath, repoRoot, true)
    ?? runStateEditProblem(filePath, repoRoot, [...paths.state, ...paths.code], true);
  if (problem !== null) {
    console.error(problem);
    process.exit(2);
  }
  // A stalled git hides what the run's paths are.
  if (gitStalled()) {
    console.error('autoloop guard — a git call timed out (a stalled git directory), so the edit cannot be checked.');
    process.exit(2);
  }
  process.exit(0);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) runEditGuard();
