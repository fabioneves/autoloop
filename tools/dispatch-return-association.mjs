#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function newAssociationId() {
  return randomUUID();
}

export function validReceipt(result, issue) {
  const receipt = result?.receipt;
  return (result?.ok === true || result?.ok === false)
    && Number.isSafeInteger(issue) && issue > 0
    && receipt?.issue === issue && ID.test(receipt.stepId ?? '')
    && ID.test(receipt.dispatchId ?? '') && typeof receipt.role === 'string'
    && receipt.role.length > 0 && receipt.role === result.role
    ? receipt : null;
}

export function readStepBinding(path, issue) {
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const last = Array.isArray(record?.steps) ? record.steps.at(-1) : null;
  if (record?.issue !== issue || record.closed || !last || (last.stepId && !ID.test(last.stepId))) return null;
  return {
    stepId: last.stepId ?? null,
    index: record.steps.length - 1,
    startedAtMs: last.startedAtMs,
    dispatchId: last.dispatchId ?? null,
  };
}

export function updateStepRecord(path, change, { waitMs = 300 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    let record = null;
    try {
      record = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const outcome = change(record);
    if (outcome?.changed) {
      const staged = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(staged, `${JSON.stringify(outcome.record, null, 1)}\n`);
        renameSync(staged, path);
      } catch (error) {
        try { unlinkSync(staged); } catch { /* No staged file to remove. */ }
        throw error;
      }
    }
    return outcome;
  } finally {
    rmdirSync(lock);
  }
}

async function selfTest() {
  if (process.env[WORKER_ENV]) throw new Error('the self-test never runs inside its own worker');
  const tally = { launched: 0, settled: 0, timedOut: 0, cancelled: 0, uncleaned: 0 };
  const worker = boundedWorker(tally);
  const self = fileURLToPath(import.meta.url);
  const root = mkdtempSync(join(tmpdir(), 'dispatch-return-'));
  const path = join(root, 'steps', '7.json');
  const checks = [];
  try {
    const stepId = newAssociationId();
    const dispatchId = newAssociationId();
    const result = { ok: false, role: 'fix', receipt: { issue: 7, stepId, dispatchId, role: 'fix' } };
    checks.push(['the receipt needs exact issue, role, and opaque ids', validReceipt(result, 7) === result.receipt
      && validReceipt(result, 8) === null && validReceipt({ ...result, role: 'plan' }, 7) === null
      && validReceipt({ ...result, receipt: { ...result.receipt, dispatchId: 'old' } }, 7) === null
      && validReceipt({ ...result, ok: 'true' }, 7) === null]);
    updateStepRecord(path, (record) => ({ changed: true, record: { issue: 7, steps: [{ stepId, startedAtMs: 1 }] } }));
    const binding = readStepBinding(path, 7);
    checks.push(['the binding names the last step and its attempt', binding.stepId === stepId
      && binding.index === 0 && binding.dispatchId === null]);
    const earlier = JSON.parse(readFileSync(path, 'utf8'));
    updateStepRecord(path, (record) => ({ changed: true,
      record: { ...record, steps: [...record.steps, { stepId: newAssociationId(), startedAtMs: 2 }] } }));
    updateStepRecord(path, (record) => ({ changed: true,
      record: { ...record, steps: record.steps.map((step, index) => index === 1 ? { ...step, waiting: 'newer' } : step) } }));
    const current = JSON.parse(readFileSync(path, 'utf8'));
    checks.push(['a later writer preserves earlier data', current.steps.length === 2
      && current.steps[0].stepId === earlier.steps[0].stepId && current.steps[1].waiting === 'newer']);
    const before = readFileSync(path, 'utf8');
    mkdirSync(`${path}.lock`);
    try {
      let blocked = false;
      try { updateStepRecord(path, () => ({ changed: true, record: {} }), { waitMs: 0 }); }
      catch (error) { blocked = error.code === 'EEXIST'; }
      checks.push(['an owned lock blocks a second writer without being reclaimed', blocked
        && readFileSync(path, 'utf8') === before]);
    } finally {
      rmdirSync(`${path}.lock`);
    }
    let invalid = false;
    writeFileSync(join(root, 'steps', '8.json'), 'not JSON');
    try { updateStepRecord(join(root, 'steps', '8.json'), () => ({ changed: true, record: {} })); }
    catch (error) { invalid = error instanceof SyntaxError; }
    checks.push(['unreadable state is not replaced', invalid
      && readFileSync(join(root, 'steps', '8.json'), 'utf8') === 'not JSON']);
    const concurrent = join(root, 'steps', '9.json');
    updateStepRecord(concurrent, () => ({ changed: true, record: { issue: 9, steps: [], counter: 0 } }));
    const writer = `const { updateStepRecord } = await import(process.argv[1]);
      updateStepRecord(process.argv[2], (record) => {
        const counter = record.counter;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        return { changed: true, record: { ...record, counter: counter + 1 } };
      });`;
    const writers = await Promise.all([worker([...MODULE_EVAL, writer, self, concurrent]), worker([...MODULE_EVAL, writer, self, concurrent])]);
    checks.push(['concurrent writers retain both updates', writers.every(({ code }) => code === 0)
      && JSON.parse(readFileSync(concurrent, 'utf8')).counter === 2]);
    // An importer whose argv[1] is this module once re-entered the self-test,
    // and each worker spawned two more until the cgroup ran out of memory.
    const imported = await worker([...MODULE_EVAL, 'await import(process.argv[1]); process.stdout.write("imported")', self],
      { nested: false });
    checks.push(['importing with this module as argv[1] never starts the self-test', imported.code === 0
      && imported.stdout === 'imported']);
    const refused = await worker([self, '--self-test']);
    checks.push(['the self-test refuses to run inside its own worker', refused.code === 2
      && refused.stdout === '' && /own worker/u.test(refused.stderr)]);
    const hung = await worker(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 });
    checks.push(['a timed-out worker is killed and confirmed gone', hung.timedOut && hung.closed && gone(hung.pid)]);
    const abort = new AbortController();
    const cancelling = worker(['-e', 'setInterval(() => {}, 1000)'], { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    const cancelled = await cancelling;
    checks.push(['a cancelled worker is killed and confirmed gone', cancelled.cancelled && cancelled.closed
      && gone(cancelled.pid)]);
    const failed = await worker(['-e', 'process.exit(3)']);
    const unlaunched = await worker([], { executable: join(root, 'missing-node') });
    checks.push(['a failing or unlaunchable worker is reported, not replaced', failed.code === 3 && failed.closed
      && unlaunched.error === 'ENOENT' && unlaunched.closed && tally.launched === tally.settled]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  checks.push(['every worker was accounted for and none needed cleanup it could not confirm',
    tally.launched === WORKER_BUDGET && tally.settled === tally.launched && tally.uncleaned === 0]);
  for (const [name, passed] of checks) if (!passed) console.error(`FAIL ${name}`);
  const failures = checks.filter(([, passed]) => !passed).length;
  const workers = `workers launched ${tally.launched}, settled ${tally.settled}, timed out ${tally.timedOut}, `
    + `cancelled ${tally.cancelled}, uncleaned ${tally.uncleaned}`;
  console.log(failures ? `self-test FAILED (${failures}/${checks.length}; ${workers})`
    : `self-test OK (${checks.length} cases; ${workers})`);
  return failures === 0;
}

const WORKER_ENV = 'AUTOLOOP_ASSOCIATION_WORKER';
const WORKER_BUDGET = 8;
const MODULE_EVAL = Object.freeze(['--input-type=module', '-e']);

function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

// One bounded child of the self-test: a fixed budget, a deadline, SIGKILL on
// timeout or cancellation, and a bounded wait for the exit that proves it.
function boundedWorker(tally) {
  return (args, { timeoutMs = 10_000, signal = null, nested = true, executable = process.execPath, closeWaitMs = 2_000 } = {}) =>
    new Promise((resolve) => {
      const outcome = { pid: null, code: null, signal: null, stdout: '', stderr: '', timedOut: false,
        cancelled: false, closed: false, error: null };
      if (tally.launched >= WORKER_BUDGET) {
        resolve({ ...outcome, error: 'WORKER_BUDGET_EXHAUSTED' });
        return;
      }
      tally.launched += 1;
      let settled = false;
      let deadline = null;
      let closeWait = null;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(closeWait);
        signal?.removeEventListener('abort', cancel);
        tally.settled += 1;
        if (!outcome.closed) tally.uncleaned += 1;
        resolve(outcome);
      };
      const child = spawn(executable, args, {
        env: { ...process.env, ...(nested ? { [WORKER_ENV]: '1' } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      outcome.pid = child.pid ?? null;
      const stop = (reason) => {
        if (outcome.closed) return;
        outcome[reason] = true;
        tally[reason] += 1;
        child.kill('SIGKILL');
        closeWait = setTimeout(settle, closeWaitMs);
      };
      const cancel = () => stop('cancelled');
      child.stdout.on('data', (chunk) => { outcome.stdout += chunk; });
      child.stderr.on('data', (chunk) => { outcome.stderr += chunk; });
      child.on('error', (error) => {
        outcome.error = error.code ?? error.message;
        if (outcome.pid === null) {
          outcome.closed = true;
          settle();
        }
      });
      child.on('close', (code, exitSignal) => {
        Object.assign(outcome, { code, signal: exitSignal, closed: true });
        settle();
      });
      deadline = setTimeout(() => stop('timedOut'), timeoutMs);
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
}

const isMain = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();
if (isMain && process.argv.length === 3 && process.argv[2] === '--self-test') {
  if (process.env[WORKER_ENV]) {
    console.error('dispatch-return-association: the self-test never runs inside its own worker');
    process.exit(2);
  }
  process.exit(await selfTest() ? 0 : 1);
}
