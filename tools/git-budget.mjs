#!/usr/bin/env node
// autoloop — git-budget.mjs
//
// Every git call a hook makes, under one wall-clock budget. The host kills a
// hook at 15 s and then lets the command run, so a guard whose git calls can
// stall (a FIFO at .git/config blocks `git rev-parse` indefinitely; security
// audit after 0.60.0) fails open unless it refuses first. A hook sets the
// deadline once; each call gets what remains (at most PER_CALL_MS), is killed
// when that runs out, and records the stall — the hook then refuses instead of
// reading "no git answer" as "no run". Tools that set no deadline keep a
// generous per-call timeout.
//
//   node <plugin-tools>/git-budget.mjs --self-test

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PER_CALL_MS = 4000;
// Below the host's 15 s hook timeout even for a caller that set no deadline.
const UNBUDGETED_MS = 10000;

let deadline = Infinity;
let stalled = false;

export function setGitDeadline(at) {
  deadline = at;
  stalled = false;
}

export function gitStalled() {
  return stalled;
}

export function boundedGit(args, options = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    stalled = true;
    return { status: null, stdout: '', stderr: '', error: new Error('git budget spent') };
  }
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
    timeout: deadline === Infinity ? UNBUDGETED_MS : Math.min(PER_CALL_MS, remaining),
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL') stalled = true;
  return result;
}

function selfTest() {
  const failures = [];
  const check = (name, passed) => {
    if (!passed) failures.push(name);
  };
  setGitDeadline(Infinity);
  const version = boundedGit(['--version']);
  check('an unbudgeted call runs', version.status === 0 && /git version/u.test(version.stdout) && !gitStalled());
  setGitDeadline(Date.now() - 1);
  const spent = boundedGit(['--version']);
  check('a spent budget refuses to call git and records the stall', spent.status === null && gitStalled());
  setGitDeadline(Infinity);
  check('a new deadline clears the stall', !gitStalled());
  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0 ? 'self-test OK (3 cases)' : `self-test FAILED (${failures.length}/3)`);
  return failures.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.error('usage: git-budget.mjs --self-test');
  process.exit(2);
}
