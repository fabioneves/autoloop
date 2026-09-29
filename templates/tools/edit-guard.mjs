#!/usr/bin/env node
// autoloop — edit-guard.mjs
//
// PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit. While a loop run is
// live, it refuses edits to the repository's hook wiring —
// `.claude/settings.json` and `.claude/settings.local.json` — the one edit
// that can switch the session's own guard off mid-run (repository settings can
// still disable plugin hooks). Everything else stays editable: loop
// configuration and prose (.autoloop/, .claude/skills) are built through the
// queue and flagged `human:authorize` at merge, which is STATE's standing
// policy (operator, 2026-09-29).
//
// A separate file from command-guard because the payload differs (an Edit
// carries no Bash command).
//
//   node <plugin-tools>/edit-guard.mjs --self-test

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopRunIsLive } from './command-guard.mjs';
import { activeAutoloopRoot } from './hook-root.mjs';

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
  return `autoloop guard — ${relativePath} is this session's hook wiring, and a live run never `
    + 'edits it: the edit could switch the guard itself off. A change there is autoloop:setup\'s, '
    + 'run after the loop closes (`prime.mjs --close-run`), or a human\'s.';
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
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'edit-guard-')));
  try {
    mkdirSync(join(scratch, 'real', '.claude'), { recursive: true });
    symlinkSync(join(scratch, 'real'), join(scratch, 'link'));
    check('a path reached through a symlink is compared by its real location',
      blocked(join(scratch, 'link', '.claude', 'settings.json'), true, join(scratch, 'real'))
        && blocked(join(scratch, 'real', '.claude', 'settings.local.json'), true, join(scratch, 'link')));
    const hook = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(scratch, 'real', '.claude', 'settings.json') } }),
      cwd: scratch,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: join(scratch, 'real') },
    });
    check('the hook entry allows the edit when no loop run is live', hook.status === 0);
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
  // Plugin hooks fire in every repository; this one guards only a devendored
  // autoloop repository, found from CLAUDE_PROJECT_DIR (hook-root.mjs).
  const repoRoot = activeAutoloopRoot();
  if (repoRoot === null) process.exit(0);
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // not an edit this guard can read; the command guard still gates the shell
  }
  if (!EDIT_TOOLS.includes(payload?.tool_name)) process.exit(0);
  const problem = hookWiringEditProblem(
    payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path,
    repoRoot,
    loopRunIsLive(),
  );
  if (problem !== null) {
    console.error(problem);
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
