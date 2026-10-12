#!/usr/bin/env node
// autoloop — edit-guard.mjs
//
// PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit. While this session
// owns a run (from its prime to --close-run or /clear), it refuses edits to
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
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedRun, processStart, protectedPaths, sessionOwnerPid } from './run-markers.mjs';
import { hookRoot } from './hook-root.mjs';
import { gitStalled, setGitDeadline } from './git-budget.mjs';

const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const HOOK_WIRING = Object.freeze(['.claude/settings.json', '.claude/settings.local.json']);

// A path through a symlink must not fail open: the file (or, for a new file,
// its directory) is compared by its real location.
function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

export function hookWiringEditProblem(filePath, repoRoot, live) {
  if (!live || typeof filePath !== 'string' || filePath.length === 0) return null;
  const root = canonical(repoRoot);
  const target = canonical(resolve(repoRoot, filePath));
  const relativePath = relative(root, target).split(sep).join('/');
  if (!HOOK_WIRING.includes(relativePath.toLowerCase())) return null;
  return `autoloop guard — ${relativePath} is this session's hook wiring, and a session that ran `
    + 'the loop never edits it: the edit could switch the guard itself off. A change there is a '
    + 'human\'s, or autoloop:setup\'s in a new session.';
}

export function runStateEditProblem(filePath, repoRoot, protectedDirs, live) {
  if (!live || typeof filePath !== 'string' || filePath.length === 0) return null;
  const target = canonical(resolve(repoRoot, filePath));
  const hit = protectedDirs.filter((dir) => typeof dir === 'string')
    .find((dir) => [dir, canonical(dir)].some((form) => target === form || target.startsWith(`${form}${sep}`)));
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

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  // The same budget the command guard keeps: a stalled git (a FIFO for
  // .git/config) must refuse before the host's timeout lets the edit through.
  setGitDeadline(Date.now() + Math.min(10_000, Number(process.env.AUTOLOOP_GUARD_BUDGET_MS) || 10_000));
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // not an edit this guard can read; the command guard still gates the shell
  }
  if (!EDIT_TOOLS.includes(payload?.tool_name)) process.exit(0);
  // Plugin hooks fire in every session; this one guards only the session
  // that owns a run (run-markers.mjs ownedRun), before any git call, and
  // then whatever the checkout says (an unreadable latch of its own too).
  if (ownedRun({ sessionId: payload?.session_id }) === null) process.exit(0);
  const repoRoot = hookRoot();
  const filePath = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
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
if (isMain) main();
