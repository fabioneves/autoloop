#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG_VERSION, effectiveChecklistPath, resolveProjectConfig } from './config-contract.mjs';
import { vendoredLeftovers } from './hook-root.mjs';
import { duplicateProtectedGlobs } from './lane-contract.mjs';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const SELF_TEST_PATTERN = /(?:async\s+)?function\s+selfTest\s*\(/;
export const UNIVERSAL_TOOL_FILES = Object.freeze([
  'attestation-contract.mjs',
  'checkout-contract.mjs',
  'claim-contract.mjs',
  'command-guard.mjs',
  'edit-guard.mjs',
  'config-contract.mjs',
  'contract-lint.mjs',
  'delivery-contract.mjs',
  'dispatch-render.mjs',
  'dispatch-return-association.mjs',
  'dispatch.mjs',
  'escalate-paths.mjs',
  'events-contract.mjs',
  'hook-root.mjs',
  'inherited-dispatch.mjs',
  'run-markers.mjs',
  'run-state-guard.mjs',
  'git-budget.mjs',
  'label-swap-reminder.mjs',
  'lane-contract.mjs',
  'models-config.mjs',
  'lifecycle-contract.mjs',
  'lifecycle-driver.mjs',
  'loop-scope.mjs',
  'loop-smoke.mjs',
  'overlap-report.mjs',
  'parked-disposition.mjs',
  'prime.mjs',
  'publish-verdict.mjs',
  'release-verify.mjs',
  'review-contract.mjs',
  'scan.mjs',
  'setup.mjs',
  'sizing-contract.mjs',
  'snapshot-contract.mjs',
  'stats.mjs',
  'status.mjs',
  'step.mjs',
  'subagent-transcript.mjs',
  'unit.mjs',
  'verify.mjs',
  'writeback-check.mjs',
]);
const PLUGIN_TOOL_FILES = Object.freeze([
  ...UNIVERSAL_TOOL_FILES,
  'auto-merge.mjs',
  'merge-authorization-contract.mjs',
]);
// Global install: the plugin ships these hooks in hooks/hooks.json, each
// running the plugin's own copy. Exactly one handler per tool, on its event
// and matcher, with exactly this command, and no statusMessage (it prints in
// every session). The command guard fails closed only for a session that owns
// a run: a crashed guard refuses there, while a broken plugin never refuses
// commands in any other session.
const PLUGIN_TOOLS = '${CLAUDE_PLUGIN_ROOT}/tools';
export const PLUGIN_HOOKS = Object.freeze([
  { name: 'session-preflight.sh', event: 'SessionStart', matcher: null, command: `bash "${PLUGIN_TOOLS}/session-preflight.sh"` },
  { name: 'edit-guard.mjs', event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit', command: `node "${PLUGIN_TOOLS}/edit-guard.mjs"` },
  {
    name: 'command-guard.mjs',
    event: 'PreToolUse',
    matcher: 'Bash|AskUserQuestion',
    // The guard's own verdict (0 or 2) is final; a guard that throws decides
    // by ownership itself. Anything else is a guard that could not start: it
    // refuses while the session's Claude process — $PPID, the hook shell's
    // parent — holds a latch, decided by the latch file alone with no git
    // call. Closed or not: the shell cannot read the hook input's session,
    // and a closed run stays guarded until /clear.
    command: `node "${PLUGIN_TOOLS}/command-guard.mjs"; s=$?; [ $s -eq 0 ] && exit 0; [ $s -eq 2 ] && exit 2; `
      + 'l="$HOME/.claude/autoloop/run-latches/$PPID.json"; '
      + 'if [ -e "$l" ] || [ -L "$l" ]; then exit 2; fi; exit 0',
  },
  { name: 'label-swap-reminder.mjs', event: 'PostToolUse', matcher: 'Bash', command: `node "${PLUGIN_TOOLS}/label-swap-reminder.mjs"` },
  { name: 'subagent-transcript.mjs', event: 'SubagentStop', matcher: null, command: `node "${PLUGIN_TOOLS}/subagent-transcript.mjs"` },
  { name: 'writeback-check.mjs', event: 'Stop', matcher: null, command: `node "${PLUGIN_TOOLS}/writeback-check.mjs"` },
].map((entry) => Object.freeze(entry)));

export function pluginHookProblems(document, toolsDir) {
  const problems = [];
  const handlers = [];
  for (const [event, groups] of Object.entries(document?.hooks ?? {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (handler?.type !== 'command' || typeof handler.command !== 'string') {
          problems.push(`hooks.${event}: expected command handlers only`);
          continue;
        }
        if (handler.statusMessage !== undefined) problems.push(`hooks.${event}: a statusMessage prints in every session`);
        handlers.push({ event, matcher: group.matcher ?? null, command: handler.command });
      }
    }
  }
  for (const entry of PLUGIN_HOOKS) {
    const matches = handlers.filter((handler) => handler.command === entry.command);
    if (matches.length !== 1) {
      problems.push(`${entry.name}: expected exactly one handler running \`${entry.command}\`, found ${matches.length}`);
    } else if (matches[0].event !== entry.event || matches[0].matcher !== entry.matcher) {
      problems.push(`${entry.name}: expected ${entry.event}${entry.matcher === null ? '' : ` matcher ${entry.matcher}`}`);
    }
    if (!existsSync(resolve(toolsDir, entry.name))) problems.push(`${entry.name}: not in the plugin tools`);
  }
  for (const handler of handlers) {
    if (!PLUGIN_HOOKS.some((entry) => entry.command === handler.command)) {
      problems.push(`unexpected hook \`${handler.command}\` on ${handler.event}`);
    }
  }
  return problems;
}

function checkPluginHooks(root) {
  try {
    const problems = pluginHookProblems(
      JSON.parse(readFileSync(resolve(root, 'hooks', 'hooks.json'), 'utf8')),
      resolve(root, 'tools'),
    );
    return { ok: problems.length === 0, detail: problems.join('; ') };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    // Contract self-tests spawn Git and Node repeatedly, and a macOS runner is
    // slow enough at process creation to exceed a two-minute ceiling that Linux
    // clears in seconds. The bound still catches a genuine hang.
    timeout: 600000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return {
    ok: result.status === 0 && !result.error,
    detail: [
      result.error?.message,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join('\n'),
  };
}

// A self-test runs as its own process group, so its whole tree can be found
// and killed: on 2026-10-12 a recursive self-test outlived its killed parent
// and filled three 8 GiB session cgroups with orphans (PPid 1).
const SELF_TEST_TIMEOUT_MS = 600000;
const CLEANUP_WAIT_MS = 5000;
// A descendant killed just before its test exits can still be dying, or be a
// zombie init has not reaped yet; only what outlives this is a leftover.
const SETTLE_MS = 1000;
const RUN_ID = randomUUID();
const selfTestProcesses = { launched: 0, exited: 0, timedOut: 0, leftovers: 0, uncleaned: 0, groups: [] };
let activeGroup = null;
// Set in --self-test mode: verify.mjs never starts its own self-test from
// inside it, so the gate's run of it cannot recurse.
let selfTesting = false;
const OWN_PATH = fileURLToPath(import.meta.url);

function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function killProcessGroup(pgid) {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// A signal is no proof of exit: the group is polled until empty, within a
// bound, and a group that will not empty is reported, never assumed gone.
// The settle window starts at the test's exit: a descendant that holds its
// output keeps 'close' away until the timeout.
export function runSelfTest(path, cwd, {
  timeoutMs = SELF_TEST_TIMEOUT_MS, cleanupWaitMs = CLEANUP_WAIT_MS, settleMs = SETTLE_MS, tally = selfTestProcesses,
  groupAlive = processGroupAlive, killGroup = killProcessGroup,
} = {}) {
  if (selfTesting && realOrSelf(path) === realOrSelf(OWN_PATH)) {
    return Promise.resolve({ ok: false, cleanupFailed: false, detail: 'verify.mjs never runs its own self-test from inside it' });
  }
  const groupGone = async (pgid, waitMs) => {
    const until = Date.now() + waitMs;
    while (groupAlive(pgid)) {
      if (Date.now() >= until) return false;
      await new Promise((done) => setTimeout(done, 25));
    }
    return true;
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path, '--self-test'], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      // Labels the test's processes, so /proc/<pid>/environ attributes them to this run.
      env: { ...process.env, AUTOLOOP_VERIFY_RUN_ID: RUN_ID },
    });
    const pgid = child.pid ?? null;
    let output = '';
    let timedOut = false;
    let finished = false;
    let exitWait = null;
    let closed = false;
    let onClose = () => {};
    const collect = (chunk) => {
      if (output.length < MAX_OUTPUT_BYTES) output += chunk;
    };
    const closedWithin = (waitMs) => new Promise((done) => {
      if (closed) {
        done();
        return;
      }
      const timer = setTimeout(done, waitMs);
      onClose = () => {
        clearTimeout(timer);
        done();
      };
    });
    const finish = async (code, signal, exited) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(exitWait);
      if (exited) tally.exited += 1;
      const leftovers = exited && !timedOut && !(await groupGone(pgid, settleMs));
      if (leftovers) {
        tally.leftovers += 1;
        killGroup(pgid);
      }
      const gone = await groupGone(pgid, cleanupWaitMs);
      if (!gone) tally.uncleaned += 1;
      await closedWithin(cleanupWaitMs);
      if (activeGroup === pgid) activeGroup = null;
      const problems = [
        timedOut && `timed out after ${timeoutMs / 1000}s; its process group was killed`,
        leftovers && 'exited but left processes in its group; they were killed',
        !gone && `cleanup FAILED: process group ${pgid} still has members ${cleanupWaitMs}ms after SIGKILL`,
      ].filter(Boolean);
      const record = `process: run ${RUN_ID} pgid ${pgid} exit ${code ?? '-'} signal ${signal ?? '-'} `
        + `timed-out ${timedOut} leftovers ${leftovers} cleanup ${gone ? 'confirmed' : 'FAILED'}`;
      resolve({
        ok: exited && code === 0 && problems.length === 0,
        cleanupFailed: !gone,
        detail: [output.trim(), ...problems, ...(problems.length || code !== 0 ? [record] : [])]
          .filter(Boolean).join('\n'),
      });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      tally.timedOut += 1;
      killGroup(pgid);
      exitWait = setTimeout(() => finish(null, 'SIGKILL', false), cleanupWaitMs);
    }, timeoutMs);
    if (pgid === null) {
      child.on('error', (error) => {
        clearTimeout(deadline);
        resolve({ ok: false, cleanupFailed: false, detail: error.message });
      });
      return;
    }
    tally.launched += 1;
    tally.groups.push(pgid);
    activeGroup = pgid;
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', (code, signal) => finish(code, signal, true));
    child.on('close', () => {
      closed = true;
      onClose();
    });
  });
}

function checkJson(path) {
  try {
    JSON.parse(readFileSync(path, 'utf8'));
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

// The committed CI policy is retired (docs/specs/simple-delivery.md); a copy
// left behind reads as authoritative configuration, so its absence is verified.
function checkRetiredCiPolicy(root) {
  return existsSync(resolve(root, '.autoloop', 'ci-policy.json'))
    ? {
        ok: false,
        detail: '.autoloop/ci-policy.json is retired — run scaffold reconcile to remove it',
      }
    : { ok: true, detail: '' };
}

// The release contract never passes `--release-mode` here.
function checkReleaseContract(root) {
  const result = run(
    process.execPath,
    [resolve(root, 'tools', 'release-verify.mjs'), '--check-root', root],
    root,
  );
  return result.ok ? { ok: true, detail: '' } : result;
}

function checkExists(path) {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink()
      ? { ok: true, detail: '' }
      : { ok: false, detail: `${path}: required artifact is not a regular file` };
  } catch {
    return { ok: false, detail: `${path}: required artifact is missing` };
  }
}

function checkConfiguredChecklist(root) {
  try {
    const resolved = resolveProjectConfig(root);
    if (!resolved?.ok) {
      return {
        ok: false,
        detail: `ProjectConfig is invalid: ${resolved?.errors?.join('; ') ?? 'no autoloop configuration'}`,
      };
    }
    return checkExists(effectiveChecklistPath(root, resolved.config));
  } catch (error) {
    return { ok: false, detail: `cannot resolve configured checklist: ${error.message}` };
  }
}

function pluginChecks(root) {
  const toolsDir = resolve(root, 'tools');
  const checks = toolChecks(root, toolsDir, PLUGIN_TOOL_FILES);

  for (const relativePath of [
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
  ]) {
    checks.push({
      name: `json ${relativePath}`,
      execute: () => checkJson(resolve(root, relativePath)),
    });
  }
  checks.push({ name: 'plugin hooks hooks/hooks.json', execute: () => checkPluginHooks(root) });
  checks.push({
    name: 'shell session-preflight',
    execute: () => run(
      'bash',
      ['-n', resolve(root, 'tools', 'session-preflight.sh')],
      root,
    ),
  });
  checks.push({
    name: 'shell dispatch-stream',
    execute: () => run(
      'bash',
      ['-n', resolve(root, 'tools', 'dispatch-stream.sh')],
      root,
    ),
  });
  checks.push({
    name: 'guard corpus replay',
    execute: () => run(
      process.execPath,
      [resolve(root, 'tools', 'command-guard.mjs'), '--corpus'],
      root,
    ),
  });
  checks.push({
    name: 'release contract',
    execute: () => checkReleaseContract(root),
  });
  checks.push({
    name: 'forward contract lint',
    execute: () => run(
      process.execPath,
      [resolve(root, 'tools', 'contract-lint.mjs'), '--check-root', root],
      root,
    ),
  });
  checks.push({
    name: 'skill byte budgets',
    execute: () => checkSkillBudgets(root),
  });
  checks.push({
    name: 'skill model invocation',
    execute: () => checkSkillInvocation(root),
  });
  return checks;
}

// Autoloop's skills run when invoked by name or by the loop, never because a
// request resembles their description (operator, 2026-10-12). Pitcrew stays
// model-invocable — Dev calls it with the Skill tool — and its description
// names Autoloop-owned pull requests only. Role briefs read lean-code by path.
export const EXPLICIT_ONLY_SKILLS = Object.freeze(['codebase-design', 'dev', 'lean-code', 'queue-trace', 'setup', 'shape']);

export function skillInvocationProblems(frontmatters) {
  return Object.entries(frontmatters).sort(([left], [right]) => left.localeCompare(right)).flatMap(([skill, text]) => {
    const disabled = /^disable-model-invocation: true$/mu.test(text);
    if (EXPLICIT_ONLY_SKILLS.includes(skill)) return disabled ? [] : [`SKILL_MODEL_INVOCABLE ${skill}`];
    if (skill === 'pitcrew') {
      return !disabled && /^description: .*Autoloop-owned pull requests only/mu.test(text) ? [] : ['SKILL_PITCREW_SCOPE pitcrew'];
    }
    return [`SKILL_INVOCATION_UNDECIDED ${skill}`];
  });
}

function checkSkillInvocation(root) {
  const skills = resolve(root, 'skills');
  const frontmatters = {};
  for (const name of existsSync(skills) ? readdirSync(skills) : []) {
    const path = join(skills, name, 'SKILL.md');
    if (existsSync(path)) frontmatters[name] = /^---\n([\s\S]*?)\n---\n/u.exec(readFileSync(path, 'utf8'))?.[1] ?? '';
  }
  const problems = skillInvocationProblems(frontmatters);
  return problems.length === 0 ? { ok: true, detail: '' } : { ok: false, detail: problems.join('\n') };
}

// Every skill loads whole into the session that invokes it, and again after
// every compaction: on LFE the dev skill added ~50k tokens to a 70k floor, re-
// read on each of 69 calls. Budgets are bytes and only ratchet down — shrink a
// skill and lower its budget in the same commit; raising one is a visible edit.
export const SKILL_BUDGETS = Object.freeze({
  'codebase-design': 6442,
  dev: 57266, // +334 (0.71.0, operator raised it): ribbon once, paused and the control prompt, --pr on publish, prime's controls keys; -235 (0.69.0): removed-rule prose dropped, decisions prose added; -103: work-size guidance removed; +46 (0.66.0): --resumed --result, the finished line; +97 (0.65.9): a reconcile MERGE_PENDING runs auto-merge once; +176 (0.65.1): base worktrees by commit, the lifecycle root's node id, no ANTHROPIC_BASE_URL on a dispatch
  'lean-code': 3873,
  pitcrew: 19587, // -197 (0.69.0): removed-rule prose dropped, retired block reasons
  'queue-trace': 6929,
  setup: 13860,
  shape: 26272,
});

export function skillBudgetProblems(sizes, budgets = SKILL_BUDGETS) {
  return Object.entries(sizes).sort(([left], [right]) => left.localeCompare(right)).flatMap(([skill, bytes]) => {
    if (!Object.hasOwn(budgets, skill)) return [`SKILL_BUDGET_MISSING ${skill}`];
    return bytes > budgets[skill] ? [`SKILL_OVER_BUDGET ${skill} ${bytes}/${budgets[skill]} bytes`] : [];
  });
}

function checkSkillBudgets(root) {
  const skills = resolve(root, 'skills');
  const sizes = {};
  for (const name of existsSync(skills) ? readdirSync(skills) : []) {
    const path = join(skills, name, 'SKILL.md');
    if (existsSync(path)) sizes[name] = lstatSync(path).size;
  }
  const problems = skillBudgetProblems(sizes);
  return problems.length === 0 ? { ok: true, detail: '' } : { ok: false, detail: problems.join('\n') };
}

function toolChecks(root, toolsDir, requiredFiles) {
  const checks = [];
  for (const name of requiredFiles) {
    checks.push({
      name: `required tool ${name}`,
      execute: () => checkExists(resolve(toolsDir, name)),
    });
  }
  const toolNames = existsSync(toolsDir) ? readdirSync(toolsDir)
    .filter((name) => name.endsWith('.mjs'))
    .sort() : [];
  for (const name of toolNames) {
    const path = join(toolsDir, name);
    checks.push({
      name: `syntax ${name}`,
      execute: () => run(process.execPath, ['--check', path], root),
    });
    // verify.mjs's own self-test too: its --self-test mode builds none of
    // these checks and refuses to start itself (runSelfTest), so it cannot recurse.
    if (!SELF_TEST_PATTERN.test(readFileSync(path, 'utf8'))) continue;
    checks.push({
      name: `self-test ${name}`,
      execute: () => runSelfTest(path, root),
    });
  }
  return checks;
}

// A devendored repository carries none of the tool (hook-root's one
// definition): no shipped file under tools/agentic/ and no hook running one.
// A repository's own file there — a gate script — is not a leftover.
function checkNoVendoredLayout(root) {
  const { files, hooks } = vendoredLeftovers(root);
  const leftovers = [
    ...files.map((name) => `tools/agentic/${name}`),
    ...hooks.map(({ file, command }) => `${file} hook \`${command}\``),
  ];
  return leftovers.length === 0
    ? { ok: true, detail: '' }
    : {
      ok: false,
      detail: `vendored layout remains: ${leftovers.join(', ')} — remove it (tracked files in a PR; `
        + '.claude/settings.local.json by hand)',
    };
}

// A loop runs for hours in one session, and every call re-reads the whole
// context: the LFE run (2026-09-30) grew from 70k to 682k tokens over 577
// calls. Neither the model nor a hook can compact on demand; the operator's
// settings can make it happen earlier. Advice, never a failure.
export function checkCompaction(env = process.env) {
  const configured = ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'].some((name) => (env[name] ?? '') !== '');
  return configured
    ? { ok: true, detail: '' }
    : {
      ok: true,
      note: 'long loop sessions compact late by default; set CLAUDE_CODE_AUTO_COMPACT_WINDOW="400000" '
        + 'in the environment the loop session starts with (measured on a 10-hour run: ~37% lower '
        + 'cost for two compactions; a lower CLAUDE_AUTOCOMPACT_PCT_OVERRIDE stacks on top of it, '
        + 'so set only the window). Dispatched sessions inherit it. The SessionStart preflight '
        + 're-injects STATE after a compaction',
    };
}

// A project protectedPaths glob that a built-in family already covers is
// redundant, not broken: the union is unchanged, so this is a note.
function checkProtectedPathsOverlap(root) {
  const resolved = resolveProjectConfig(root);
  if (!resolved?.ok) return { ok: false, detail: 'ProjectConfig is invalid' };
  const duplicates = duplicateProtectedGlobs(resolved.config.protectedPaths ?? []);
  return duplicates.length === 0
    ? { ok: true, detail: '' }
    : {
      ok: true,
      note: `protectedPaths ${duplicates.join(', ')}: a built-in family (secrets, .github/workflows, `
        + 'the loop control roots) already protects these; the entry can be removed',
    };
}

// A gate command naming a repository script (a relative path with an
// extension) that is not there fails every gate; say so before a run does.
function checkGateScripts(root) {
  const resolved = resolveProjectConfig(root);
  if (!resolved?.ok) return { ok: false, detail: 'ProjectConfig is invalid' };
  const commands = ['command', 'quickCommand', 'setupCommand']
    .map((key) => resolved.config.gate[key]).filter((value) => typeof value === 'string');
  const scripts = commands.flatMap((command) => command.split(/[\s;&|()]+/u))
    .map((token) => token.replace(/^\.\//u, ''))
    .filter((token) => /^[A-Za-z0-9_.][^:$~]*\/[^:$]*\.[A-Za-z0-9]{1,5}$/u.test(token));
  const missing = [...new Set(scripts)].filter((path) => !existsSync(resolve(root, path)));
  return missing.length === 0
    ? { ok: true, detail: '' }
    : { ok: false, detail: `gate scripts missing: ${missing.join(', ')}` };
}

// The project doctor: the repository's own data, checked against the plugin
// that runs it. Every tool lives in the plugin, so nothing here self-tests.
function projectChecks(root) {
  const toolsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
  return [
    {
      name: 'ProjectConfig',
      execute: () => run(process.execPath, [resolve(toolsDir, 'config-contract.mjs'), '--root', root], root),
    },
    { name: 'configured review checklist', execute: () => checkConfiguredChecklist(root) },
    { name: 'retired CI policy absent', execute: () => checkRetiredCiPolicy(root) },
    { name: 'gate scripts present', execute: () => checkGateScripts(root) },
    { name: 'protectedPaths overlap', execute: () => checkProtectedPathsOverlap(root) },
    { name: 'no vendored layout', execute: () => checkNoVendoredLayout(root) },
    { name: 'session compaction', execute: () => checkCompaction() },
  ];
}

// Each fixture starts at most one child, so a broken runner cannot multiply.
async function processCases() {
  const scratch = mkdtempSync(join(tmpdir(), 'autoloop-verify-processes-'));
  const fixture = (name, body) => {
    const path = join(scratch, name);
    writeFileSync(path, `import { spawn } from 'node:child_process';\n${body}\n`);
    return path;
  };
  const lingering = "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });"
    + ' child.unref(); console.log(`child ${child.pid}`);';
  const pidOf = (detail) => Number(/child (\d+)/u.exec(detail)?.[1]);
  const gone = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return Number.isSafeInteger(pid) && error.code === 'ESRCH';
    }
  };
  const tally = { launched: 0, exited: 0, timedOut: 0, leftovers: 0, uncleaned: 0, groups: [] };
  const options = { timeoutMs: 400, cleanupWaitMs: 2000, tally };
  try {
    const passed = await runSelfTest(fixture('pass.mjs', "console.log('self-test OK');"), scratch, options);
    const failed = await runSelfTest(fixture('fail.mjs', 'process.exit(4);'), scratch, options);
    const hung = await runSelfTest(fixture('hang.mjs', `${lingering} setInterval(() => {}, 1000);`), scratch, options);
    const leaked = await runSelfTest(fixture('leak.mjs', lingering), scratch, options);
    // A descendant holding the test's stdout keeps 'close' from ever firing:
    // it waited out the whole timeout before (review O3).
    const holdingAt = Date.now();
    const holding = await runSelfTest(fixture('holding.mjs', lingering.replace("stdio: 'ignore'", "stdio: 'inherit'")),
      scratch, { ...options, timeoutMs: 15000 });
    const holdingMs = Date.now() - holdingAt;
    // A group that never empties is reported, and the gate stops on it.
    const stuck = { launched: 0, exited: 0, timedOut: 0, leftovers: 0, uncleaned: 0, groups: [] };
    const unconfirmed = await runSelfTest(join(scratch, 'pass.mjs'), scratch, {
      ...options, tally: stuck, settleMs: 50, cleanupWaitMs: 200, groupAlive: () => true, killGroup: () => {},
    });
    const ran = [];
    const gate = await runChecks([
      { name: 'stuck', execute: () => unconfirmed },
      { name: 'next', execute: () => ran.push('next') && { ok: true } },
    ], { log: () => {}, error: () => {} });
    return [
      ['a clean self-test passes with its cleanup confirmed', passed.ok && !passed.cleanupFailed],
      ['a failing self-test fails with its process record', !failed.ok && /process: run .* exit 4 /u.test(failed.detail)],
      ['a timed-out self-test loses its whole process group, child included', !hung.ok && !hung.cleanupFailed
        && /timed out/u.test(hung.detail) && gone(pidOf(hung.detail))],
      ['a self-test that leaves a descendant fails and the descendant is killed', !leaked.ok && !leaked.cleanupFailed
        && /left processes/u.test(leaked.detail) && gone(pidOf(leaked.detail))],
      ['a descendant holding the test\'s output is reported as left processes within seconds, not as a timeout',
        !holding.ok && !holding.cleanupFailed && /left processes/u.test(holding.detail) && !/timed out/u.test(holding.detail)
          && holdingMs < 8000 && gone(pidOf(holding.detail))],
      ['a group that cannot be confirmed gone fails as a cleanup failure, and the gate stops there',
        !unconfirmed.ok && unconfirmed.cleanupFailed && stuck.uncleaned === 1 && gate.stopped && gate.failures.length === 1
          && ran.length === 0],
      ['every launched group is accounted for', tally.launched === 5 && tally.exited === 5 && tally.timedOut === 1
        && tally.leftovers === 2 && tally.uncleaned === 0 && tally.groups.every((pgid) => !processGroupAlive(pgid))],
    ];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function selfTest() {
  const success = run(process.execPath, ['--version'], process.cwd());
  const failure = run(process.execPath, ['--definitely-not-a-node-option'], process.cwd());
  const toolsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
  // The project doctor: a devendored repository passes; any vendored layout
  // left behind fails and names devendor.
  const projectRoot = mkdtempSync(join(tmpdir(), 'autoloop-project-'));
  let devendoredPasses;
  let vendoredToolsFail;
  let vendoredWiringFails;
  let missingChecklistFails;
  let duplicateProtectedPathNoted;
  let repositoryFilePasses;
  let missingGateScriptFails;
  try {
    mkdirSync(join(projectRoot, '.autoloop'));
    writeFileSync(join(projectRoot, '.autoloop', 'config.json'), JSON.stringify({
      version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' },
    }));
    const doctor = () => projectChecks(projectRoot).map((check) => ({ name: check.name, ...check.execute() }));
    devendoredPasses = doctor().every((result) => result.ok);
    mkdirSync(join(projectRoot, '.claude'));
    writeFileSync(join(projectRoot, '.claude', 'settings.json'), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node tools/agentic/writeback-check.mjs"}]}]}}');
    vendoredWiringFails = doctor().some((result) => result.name === 'no vendored layout' && !result.ok
      && result.detail.includes('node tools/agentic/writeback-check.mjs'));
    rmSync(join(projectRoot, '.claude'), { recursive: true, force: true });
    // A repository's own file under tools/agentic (a gate script) is not the
    // vendored layout; a shipped tool left behind is.
    mkdirSync(join(projectRoot, 'tools', 'agentic'), { recursive: true });
    writeFileSync(join(projectRoot, 'tools', 'agentic', 'gate.mjs'), '// the repository\'s own\n');
    repositoryFilePasses = doctor().every((result) => result.ok);
    writeFileSync(join(projectRoot, 'tools', 'agentic', 'prime.mjs'), '// shipped\n');
    vendoredToolsFail = doctor().some((result) => result.name === 'no vendored layout' && !result.ok
      && result.detail.includes('tools/agentic/prime.mjs'));
    rmSync(join(projectRoot, 'tools'), { recursive: true, force: true });
    // A gate whose repository script is missing fails before a run finds out.
    writeFileSync(join(projectRoot, '.autoloop', 'config.json'), JSON.stringify({
      version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'node tools/agentic/gate.mjs && ./scripts/lint.sh' },
    }));
    const missingGate = doctor().find((result) => result.name === 'gate scripts present');
    missingGateScriptFails = missingGate?.ok === false && missingGate.detail.includes('tools/agentic/gate.mjs')
      && missingGate.detail.includes('scripts/lint.sh');
    // No checklist of its own: the plugin's is used. A path the repository
    // configured explicitly must exist.
    writeFileSync(join(projectRoot, '.autoloop', 'config.json'), JSON.stringify({
      version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' },
      review: { checklistPath: 'docs/review-checklist.md' },
    }));
    missingChecklistFails = doctor().some((result) => result.name === 'configured review checklist' && !result.ok);
    // A project glob a built-in family covers is noted, never failed.
    writeFileSync(join(projectRoot, '.autoloop', 'config.json'), JSON.stringify({
      version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'true' },
      protectedPaths: ['spec/**', '.env*'],
    }));
    const overlap = doctor().find((result) => result.name === 'protectedPaths overlap');
    duplicateProtectedPathNoted = overlap?.ok === true && overlap.note?.includes('.env*') && !overlap.note.includes('spec/**');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
  // Global install: the plugin's own hooks.json. Each tool has exactly one
  // handler, on its event and matcher, running the plugin's copy.
  const pluginHookDocument = (entries = PLUGIN_HOOKS) => {
    const hooks = {};
    for (const entry of entries) {
      (hooks[entry.event] ??= []).push({
        ...(entry.matcher === null ? {} : { matcher: entry.matcher }),
        hooks: [{ type: 'command', command: entry.command }],
      });
    }
    return { hooks };
  };
  const pluginProblems = (document) => pluginHookProblems(document, toolsDir);
  const withGuard = (command) => PLUGIN_HOOKS.map((entry) =>
    (entry.name === 'command-guard.mjs' ? { ...entry, command } : entry));
  const guardEntry = PLUGIN_HOOKS.find((entry) => entry.name === 'command-guard.mjs');
  // A crashed guard refuses only while the session's Claude process (here
  // the shell's parent: this process) holds an open latch; a broken plugin
  // must not refuse every command in every session.
  const crashRoot = mkdtempSync(join(tmpdir(), 'autoloop-hook-crash-'));
  let crashWithoutRun;
  let crashOwned;
  let crashClosed;
  let crashOddLatch;
  let refusalKept;
  try {
    const stub = join(crashRoot, 'plugin', 'tools', 'command-guard.mjs');
    mkdirSync(dirname(stub), { recursive: true });
    mkdirSync(join(crashRoot, 'project', '.autoloop'), { recursive: true });
    writeFileSync(join(crashRoot, 'project', '.autoloop', 'config.json'), '{}');
    const latches = join(crashRoot, 'home', '.claude', 'autoloop', 'run-latches');
    const latch = join(latches, `${process.pid}.json`);
    const guardExits = (code) => {
      writeFileSync(stub, `process.exit(${code});\n`);
      return spawnSync('sh', ['-c', guardEntry.command], {
        timeout: 15000,
        env: { ...process.env, HOME: join(crashRoot, 'home'), CLAUDE_PLUGIN_ROOT: join(crashRoot, 'plugin'), CLAUDE_PROJECT_DIR: join(crashRoot, 'project') },
      }).status;
    };
    crashWithoutRun = guardExits(1);
    mkdirSync(latches, { recursive: true });
    writeFileSync(latch, JSON.stringify({ version: 2, owner: process.pid, baseBranch: 'main', sessionId: 'S' }));
    crashOwned = guardExits(1);
    // The guard's own verdict is final wherever it happens.
    refusalKept = guardExits(0) === 0 && guardExits(2) === 2;
    writeFileSync(latch, JSON.stringify({ version: 2, owner: process.pid, baseBranch: 'main', sessionId: 'S', closedAt: '2026-10-12T00:00:00.000Z' }));
    crashClosed = guardExits(1);
    rmSync(latch);
    mkdirSync(latch);
    crashOddLatch = guardExits(1);
  } finally {
    rmSync(crashRoot, { recursive: true, force: true });
  }
  const processes = await processCases();
  const own = fileURLToPath(import.meta.url);
  const scheduled = toolChecks(process.cwd(), dirname(own), []).map(({ name }) => name);
  const nested = await runSelfTest(own, process.cwd(), { timeoutMs: 5000 });
  const cases = [
    ...processes,
    ['the gate runs verify.mjs\'s own self-test in its own group, and a self-test never starts it again',
      scheduled.includes(`self-test ${basename(own)}`) && !nested.ok && /never runs its own self-test/u.test(nested.detail)
        && !selfTestProcesses.groups.length],
    ['the plugin hook document passes its contract', pluginProblems(pluginHookDocument()).length === 0],
    ['a missing plugin hook is named',
      pluginProblems(pluginHookDocument(PLUGIN_HOOKS.slice(1))).some((problem) => problem.includes(PLUGIN_HOOKS[0].name))],
    ['a plugin hook on the wrong matcher is refused',
      pluginProblems(pluginHookDocument(PLUGIN_HOOKS.map((entry) =>
        (entry.name === 'command-guard.mjs' ? { ...entry, matcher: 'Bash' } : entry)))).length > 0],
    ['a command guard without its fail-closed branch is refused',
      pluginProblems(pluginHookDocument(withGuard('node "${CLAUDE_PLUGIN_ROOT}/tools/command-guard.mjs"')))
        .some((problem) => problem.includes('command-guard.mjs'))],
    ['a hook outside the contract is refused',
      pluginProblems(pluginHookDocument([...PLUGIN_HOOKS,
        { name: 'x', event: 'Stop', matcher: null, command: 'echo hi' }])).some((problem) => problem.includes('echo hi'))],
    ['a vendored tool path is refused',
      pluginProblems(pluginHookDocument(withGuard('node "$CLAUDE_PROJECT_DIR/tools/agentic/command-guard.mjs" || exit 2'))).length > 0],
    ['a plugin guard that cannot start refuses while the session\'s Claude process ($PPID) holds a latch, closed too, and allows without one',
      crashOwned === 2 && crashWithoutRun === 0 && crashClosed === 2],
    ['the guard\'s own verdict is never turned around', refusalKept],
    ['a crash beside a latch that is not a plain file still refuses', crashOddLatch === 2],
    ['a hook with a statusMessage is refused',
      pluginProblems({ hooks: { Stop: [{ hooks: [{ type: 'command', command: PLUGIN_HOOKS.at(-1).command, statusMessage: 'x' }] }] } })
        .some((problem) => problem.includes('statusMessage'))],
    ['a loop-only skill the model may invoke, or a pitcrew description wider than Autoloop-owned PRs, fails',
      JSON.stringify(skillInvocationProblems({
        dev: 'name: dev\ndisable-model-invocation: true',
        shape: 'name: shape',
        pitcrew: 'name: pitcrew\ndescription: Service pull requests after failing CI.',
        novel: 'name: novel',
      })) === JSON.stringify(['SKILL_INVOCATION_UNDECIDED novel', 'SKILL_PITCREW_SCOPE pitcrew', 'SKILL_MODEL_INVOCABLE shape'])
        && skillInvocationProblems({ pitcrew: 'description: Service Autoloop-owned pull requests only, after CI fails.' }).length === 0],
    // 0.56.0: a skill loads whole into the session that invokes it and again
    // after every compaction (LFE: the dev skill added ~50k tokens to a 70k
    // floor, re-read on every one of 69 calls). A skill never grows silently.
    ['a skill over its byte budget, or with none, fails; within budget passes',
      JSON.stringify(skillBudgetProblems({ dev: 60001, setup: 100, novel: 5 }, { dev: 60000, setup: 100 }))
        === JSON.stringify(['SKILL_OVER_BUDGET dev 60001/60000 bytes', 'SKILL_BUDGET_MISSING novel'])
        && skillBudgetProblems({ dev: 60000 }, { dev: 60000 }).length === 0],
    ['structured command success', success.ok && success.detail.length > 0],
    ['structured command failure', !failure.ok && failure.detail.length > 0],
    ['invalid JSON is rejected', checkJson(fileURLToPath(import.meta.url)).ok === false],
    ['a devendored project passes the doctor', devendoredPasses],
    ['vendored hook wiring left behind fails the doctor and names the hook', vendoredWiringFails],
    ['a shipped tool left in tools/agentic fails the doctor, naming it', vendoredToolsFail],
    ['a repository\'s own file in tools/agentic passes the doctor', repositoryFilePasses],
    ['a gate command whose repository script is missing fails the doctor', missingGateScriptFails],
    ['a missing explicitly configured checklist fails the doctor', missingChecklistFails],
    ['a protectedPaths entry a built-in family covers is noted by the doctor', duplicateProtectedPathNoted],
    ['unset compaction settings are a note, never a failure; either setting satisfies it',
      checkCompaction({}).ok === true && /CLAUDE_CODE_AUTO_COMPACT_WINDOW/u.test(checkCompaction({}).note ?? '')
        && checkCompaction({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60' }).note === undefined
        && checkCompaction({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }).note === undefined],
  ];
  const failures = cases.filter(([, passed]) => !passed);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(
    failures.length === 0
      ? `self-test OK (${cases.length} cases)`
      : `self-test FAILED (${failures.length}/${cases.length})`,
  );
  return failures.length === 0;
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { mode: 'self-test', root: null, full: false, error: null };
  }
  if (args.length === 2 && args[0] === '--plugin-root' && args[1]) {
    return { mode: 'plugin', root: args[1], full: false, error: null };
  }
  if (args.length === 2 && args[0] === '--project-root' && args[1]) {
    return { mode: 'project', root: args[1], full: false, error: null };
  }
  return {
    mode: null,
    root: null,
    full: false,
    error: 'expected --plugin-root <path>, --project-root <path>, or --self-test',
  };
}

function selfTestProcessSummary() {
  const { launched, exited, timedOut, leftovers, uncleaned, groups } = selfTestProcesses;
  return `self-test processes: run ${RUN_ID}; launched ${launched}, exited ${exited}, timed out ${timedOut}, `
    + `leftovers killed ${leftovers}, cleanup failures ${uncleaned}; process groups ${groups.join(' ') || 'none'}`;
}

// An interrupted verify takes its running self-test group with it; the exit
// is reported as unconfirmed rather than assumed.
function killActiveGroupOn(signal, code) {
  process.once(signal, () => {
    if (activeGroup !== null) {
      killProcessGroup(activeGroup);
      console.error(`verify: ${signal}; killed self-test process group ${activeGroup} (exit not confirmed)`);
    }
    console.error(selfTestProcessSummary());
    process.exit(code);
  });
}

export async function runChecks(checks, { log = console.log, error = console.error } = {}) {
  const failures = [];
  for (const check of checks) {
    const startedAt = process.hrtime.bigint();
    const result = await check.execute();
    const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    // A check's duration prints on its own line, so a slow self-test names
    // itself instead of the log stalling on the previous check's PASS line.
    const timing = elapsedMs >= 1000 ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
    if (result.ok && result.note) {
      log(`NOTE ${check.name}${timing}: ${result.note}`);
    } else if (result.ok) {
      log(`PASS ${check.name}${timing}`);
      // A passing child's stdout is otherwise discarded, which swallowed the
      // self-tests' diagnostic attribution — surface every such line.
      for (const line of result.detail?.match(/^(?:slow checks|matrix phases): .+$/gmu) ?? []) {
        log(`  ${line}`);
      }
    } else {
      error(`FAIL ${check.name}${timing}`);
      if (result.detail) error(result.detail);
      failures.push(check.name);
      // A group that would not empty may still hold memory or processes:
      // launching the next self-test on top of it is how orphans pile up.
      if (result.cleanupFailed) {
        error('verify: stopped; a self-test process group could not be confirmed gone');
        return { failures, stopped: true };
      }
    }
  }
  return { failures, stopped: false };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`verify: ${parsed.error}`);
    process.exit(2);
  }
  killActiveGroupOn('SIGINT', 130);
  killActiveGroupOn('SIGTERM', 143);
  killActiveGroupOn('SIGHUP', 129);
  if (parsed.mode === 'self-test') {
    selfTesting = true;
    process.exit(await selfTest() ? 0 : 1);
  }

  const root = resolve(parsed.root);
  const checks = parsed.mode === 'plugin'
    ? pluginChecks(root)
    : projectChecks(root);
  const { failures } = await runChecks(checks);
  if (selfTestProcesses.launched > 0) console.log(selfTestProcessSummary());
  if (failures.length > 0) {
    console.error(`verification failed (${failures.length} check(s))`);
    process.exit(1);
  }
  console.log('verification passed');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) await main();
