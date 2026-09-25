#!/usr/bin/env node

// Self-resolving unit dispositions: the two outcomes a run used to hand to a
// human even though nothing about them needs one.
//
//   --obsolete  The premise is already delivered. The tool checks the cited
//               evidence (a PR merged into the configured base, or a commit
//               the remote base contains), then comments it, labels the issue
//               `loop-obsolete` and closes it as not planned. Reopening undoes it.
//   --wait      The unit waits on another issue, on a red base, or for a time
//               (a step the host keeps killing backs off instead of blocking). A machine
//               comment records the condition and the issue is labelled
//               `loop-waiting`, which the queue skips. Prime calls liftWaits
//               before every scan and removes the label once the condition has
//               cleared, so the unit comes back without a human.
//
//   --block     A genuine human decision: trust, an irreversible act, or a product
//               value no source states. A machine comment records the reason
//               code and the one-line question; the labels swap to loop-blocked
//               plus the gate label in one edit, and loop-ready stays. A human
//               answers with `/answer <decision>` on the issue.
//
//   --decide    A judgment call the loop made itself: the recommended option,
//               its alternatives and why. A machine comment records it and the
//               issue is labelled `loop-decided`; a human reverses it by replying
//               `/answer <what instead>`.
//
//   --digest    Every decision waiting on a human, one row each: open loop-blocked
//               issues and human:authorize PRs, then the loop's own decisions of
//               the last seven days. `--post` rewrites the body of the one open
//               `loop-digest` issue (created and pinned when absent), so the list
//               is always current. Prime posts it at every close and park.
//
// Neither disposition edits the issue body: an edit after `loop-ready` makes
// the issue ineligible, which is the stop this tool exists to remove. Nor do
// they touch `loop-ready`, so the queue provenance is unchanged.
//
// Usage:
//   node tools/agentic/unit.mjs --obsolete --issue <N> (--pr <M> | --commit <sha>) [--note <text>]
//   node tools/agentic/unit.mjs --wait --issue <N> (--on-issue <M> | --on-base-red | --minutes <1..720>) [--note <text>]
//   node tools/agentic/unit.mjs --block --issue <N> --reason <CODE> --question <one line> [--gate human:authorize] [--note <text>]
//   node tools/agentic/unit.mjs --decide --issue <N> --choice <text> --why <text> [--alternatives "<a>; <b>"]
//   node tools/agentic/unit.mjs --lift
//   node tools/agentic/unit.mjs --digest [--post]
//   node tools/agentic/unit.mjs --self-test

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractConfig } from './config-contract.mjs';

const TIMEOUT_MS = 30_000;
const WAIT_MARKER_RE = /<!-- autoloop-waiting-v1 (\{[^\n]*?\}) -->/gu;
const DECISION_MARKER_RE = /<!-- autoloop-decision-v1 (\{[^\n]*?\}) -->/gu;
const BLOCK_MARKER_RE = /<!-- autoloop-block-v1 (\{[^\n]*?\}) -->/gu;
const REASON_RE = /^[A-Z][A-Z0-9_]*$/u;
const BLOCK_GATES = Object.freeze(['human:decide', 'human:authorize']);
const DECISION_WINDOW_MS = 7 * 24 * 60 * 60_000;
const SHA_RE = /^[0-9a-f]{7,40}$/u;
const MAX_WAIT_MINUTES = 720;
const LABELS = Object.freeze({
  'loop-waiting': { color: 'fbca04', description: 'autoloop: waits on a recorded condition; lifted automatically' },
  'loop-obsolete': { color: 'cfd3d7', description: 'autoloop: premise already delivered; closed with evidence' },
  'loop-decided': { color: 'c5def5', description: 'autoloop: took the recommended option on a judgment call; reversible with /answer' },
  'loop-digest': { color: '5319e7', description: 'autoloop: the decisions waiting on a human, rewritten at every close and park' },
});
const GATE_LABEL_RE = /^(?:human:|needs-)/u;
const QUESTION_MAX = 160;

function positive(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && String(number) === String(value) ? number : null;
}

export function realRun(root) {
  return (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
    return {
      ok: result.status === 0 && !result.error,
      stdout: String(result.stdout ?? '').trim(),
      stderr: result.error?.message ?? String(result.stderr ?? '').trim(),
    };
  };
}

function refusal(code, message) {
  return { ok: false, code, message };
}

/** Pure: the newest parseable waiting condition in a set of comment bodies, or null. */
export function waitCondition(bodies) {
  let newest = null;
  for (const body of [].concat(bodies ?? [])) {
    for (const match of String(body ?? '').matchAll(WAIT_MARKER_RE)) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed?.on === 'issue' && positive(parsed.number)) newest = { on: 'issue', number: parsed.number };
        else if (parsed?.on === 'base' && SHA_RE.test(parsed.oid ?? '')) newest = { on: 'base', oid: parsed.oid };
        else if (parsed?.on === 'time' && Number.isFinite(Date.parse(parsed.until))) newest = { on: 'time', until: parsed.until };
      } catch {
        // An unparseable marker is not a condition; an earlier valid one still stands.
      }
    }
  }
  return newest;
}

export function waitMarker(condition) {
  return `<!-- autoloop-waiting-v1 ${JSON.stringify(condition)} -->`;
}

/** Pure: the reason a condition has cleared, or null while it still holds.
 *  facts: { issueStates: {[number]: 'OPEN'|'CLOSED'}, baseOid, now (ms) } */
export function waitCleared(condition, facts) {
  if (condition?.on === 'issue') {
    return facts?.issueStates?.[condition.number] === 'CLOSED' ? `#${condition.number} is closed` : null;
  }
  if (condition?.on === 'base') {
    const oid = facts?.baseOid;
    return typeof oid === 'string' && SHA_RE.test(oid) && oid !== condition.oid
      ? `the base moved off ${condition.oid.slice(0, 12)}`
      : null;
  }
  if (condition?.on === 'time') {
    return Number.isFinite(facts?.now) && facts.now >= Date.parse(condition.until)
      ? `its wait ended at ${condition.until}`
      : null;
  }
  return null;
}

function baseBranch(root) {
  return extractConfig(readFileSync(join(root, 'docs', 'agentic', 'STATE.md'), 'utf8')).baseBranch;
}

function remoteBaseOid(run, base) {
  const result = run('git', ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`]);
  return result.ok && SHA_RE.test(result.stdout) ? result.stdout : null;
}

function issueState(run, number) {
  const result = run('gh', ['issue', 'view', String(number), '--json', 'state', '--jq', '.state']);
  return result.ok ? result.stdout : null;
}

// A repository set up before this tool existed has no such label; create it
// and retry once rather than hand the disposition back to a human.
function withLabel(run, label, apply) {
  const result = apply();
  if (result.ok) return result;
  const { color, description } = LABELS[label];
  run('gh', ['label', 'create', label, '--color', color, '--description', description]);
  return apply();
}

function addLabel(run, issue, label) {
  return withLabel(run, label, () => run('gh', ['issue', 'edit', String(issue), '--add-label', label]));
}

export function markObsolete({ issue, pr = null, commit = null, note = '', base, run }) {
  if (!positive(issue)) return refusal('INVALID_ARGS', '--issue: expected a positive issue number');
  if ((pr === null) === (commit === null)) return refusal('INVALID_ARGS', 'expected exactly one of --pr or --commit');
  if (issueState(run, issue) !== 'OPEN') return refusal('ISSUE_NOT_OPEN', `#${issue} is not an open issue`);
  let evidence;
  if (pr !== null) {
    if (!positive(pr)) return refusal('INVALID_ARGS', '--pr: expected a positive PR number');
    const view = run('gh', ['pr', 'view', String(pr), '--json', 'state,baseRefName,mergeCommit,url']);
    let facts = null;
    try { facts = view.ok ? JSON.parse(view.stdout) : null; } catch { facts = null; }
    if (facts?.state !== 'MERGED' || facts.baseRefName !== base) {
      return refusal('EVIDENCE_NOT_DELIVERED', `PR #${pr} is not merged into ${base}`);
    }
    evidence = `PR #${pr} (${facts.url}), merged into \`${base}\` as ${facts.mergeCommit?.oid ?? 'an unrecorded commit'}`;
  } else {
    if (!SHA_RE.test(commit)) return refusal('INVALID_ARGS', '--commit: expected a hex commit id');
    const contained = run('git', ['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${base}`]);
    if (!contained.ok) return refusal('EVIDENCE_NOT_DELIVERED', `${commit} is not contained in origin/${base}`);
    evidence = `commit ${commit}, contained in \`origin/${base}\``;
  }
  const body = [
    `**autoloop: premise already delivered** — ${evidence}.`,
    ...(note ? ['', note] : []),
    '',
    'Closed as not planned with label `loop-obsolete`. Reopen the issue to put it back in the queue.',
  ].join('\n');
  for (const [step, result] of [
    ['comment', () => run('gh', ['issue', 'comment', String(issue), '--body', body])],
    ['label', () => addLabel(run, issue, 'loop-obsolete')],
    ['close', () => run('gh', ['issue', 'close', String(issue), '--reason', 'not planned'])],
  ]) {
    const outcome = result();
    if (!outcome.ok) return refusal('GH_FAILED', `${step} on #${issue} failed: ${outcome.stderr}`);
  }
  return { ok: true, issue, disposition: 'obsolete', evidence };
}

export function markWaiting({ issue, onIssue = null, onBaseRed = false, minutes = null, note = '', base, run, now = Date.now() }) {
  if (!positive(issue)) return refusal('INVALID_ARGS', '--issue: expected a positive issue number');
  if ([onIssue !== null, onBaseRed, minutes !== null].filter(Boolean).length !== 1) {
    return refusal('INVALID_ARGS', 'expected exactly one of --on-issue, --on-base-red or --minutes');
  }
  let condition;
  let reason;
  if (onIssue !== null) {
    if (!positive(onIssue)) return refusal('INVALID_ARGS', '--on-issue: expected a positive issue number');
    if (onIssue === issue) return refusal('SELF_WAIT', `#${issue} cannot wait on itself`);
    const state = issueState(run, onIssue);
    if (state !== 'OPEN') return refusal('NOTHING_TO_WAIT_ON', `#${onIssue} is ${state === null ? 'unreadable' : 'not open'}`);
    condition = { on: 'issue', number: onIssue };
    reason = `waits on #${onIssue}; the label is lifted when it closes`;
  } else if (minutes !== null) {
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_WAIT_MINUTES) {
      return refusal('INVALID_ARGS', `--minutes: expected a whole number 1..${MAX_WAIT_MINUTES}`);
    }
    condition = { on: 'time', until: new Date(now + minutes * 60_000).toISOString() };
    reason = `waits until ${condition.until}; the label is lifted then`;
  } else {
    const oid = remoteBaseOid(run, base);
    if (oid === null) return refusal('BASE_UNREADABLE', `origin/${base} does not resolve`);
    condition = { on: 'base', oid };
    reason = `waits on a red \`${base}\` at ${oid.slice(0, 12)}; the label is lifted when the base moves`;
  }
  const body = [
    waitMarker(condition),
    `**autoloop: waiting** — this unit ${reason}.`,
    ...(note ? ['', note] : []),
  ].join('\n');
  const comment = run('gh', ['issue', 'comment', String(issue), '--body', body]);
  if (!comment.ok) return refusal('GH_FAILED', `comment on #${issue} failed: ${comment.stderr}`);
  const label = addLabel(run, issue, 'loop-waiting');
  if (!label.ok) return refusal('GH_FAILED', `label on #${issue} failed: ${label.stderr}`);
  return { ok: true, issue, disposition: 'waiting', condition };
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function decisionMarker(decision) {
  return `<!-- autoloop-decision-v1 ${JSON.stringify(decision)} -->`;
}

/** Pure: the newest well-formed decision in a comment body, or null. */
export function parseDecision(body) {
  let newest = null;
  for (const match of String(body ?? '').matchAll(DECISION_MARKER_RE)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (
        positive(parsed?.issue) && text(parsed.choice) && text(parsed.why)
        && Array.isArray(parsed.alternatives) && parsed.alternatives.every((entry) => typeof entry === 'string')
        && Number.isFinite(Date.parse(parsed.at))
      ) newest = parsed;
    } catch {
      // An unparseable marker is not a decision; an earlier valid one still stands.
    }
  }
  return newest;
}

export function markDecided({ issue, choice, alternatives = [], why, run, now = Date.now() }) {
  if (!positive(issue)) return refusal('INVALID_ARGS', '--issue: expected a positive issue number');
  if (!text(choice) || !text(why)) return refusal('INVALID_ARGS', 'expected a non-empty --choice and --why');
  if (issueState(run, issue) !== 'OPEN') return refusal('ISSUE_NOT_OPEN', `#${issue} is not an open issue`);
  const decision = {
    issue,
    choice: text(choice),
    alternatives: alternatives.map((entry) => entry.trim()).filter(Boolean),
    why: text(why),
    at: new Date(now).toISOString(),
  };
  const body = [
    decisionMarker(decision),
    `**autoloop: decided** — ${decision.choice}`,
    '',
    `Why: ${decision.why}`,
    ...(decision.alternatives.length > 0 ? [`Alternatives: ${decision.alternatives.join('; ')}`] : []),
    '',
    'The loop took the recommended option and kept going. Reply `/answer <what instead>` to reverse it.',
  ].join('\n');
  const comment = run('gh', ['issue', 'comment', String(issue), '--body', body]);
  if (!comment.ok) return refusal('GH_FAILED', `comment on #${issue} failed: ${comment.stderr}`);
  const label = addLabel(run, issue, 'loop-decided');
  if (!label.ok) return refusal('GH_FAILED', `label on #${issue} failed: ${label.stderr}`);
  return { ok: true, issue, disposition: 'decided', decision };
}

export function blockMarker(block) {
  return `<!-- autoloop-block-v1 ${JSON.stringify(block)} -->`;
}

/** Pure: the newest well-formed block in a comment body, or null. */
export function parseBlock(body) {
  let newest = null;
  for (const match of String(body ?? '').matchAll(BLOCK_MARKER_RE)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (
        positive(parsed?.issue) && parsed.class === 'human' && REASON_RE.test(parsed.reason ?? '')
        && text(parsed.question) && !parsed.question.includes('\n') && Number.isFinite(Date.parse(parsed.at))
      ) newest = parsed;
    } catch {
      // An unparseable marker is not a block; an earlier valid one still stands.
    }
  }
  return newest;
}

export function markBlocked({ issue, reason, question, gate = 'human:decide', note = '', run, now = Date.now() }) {
  if (!positive(issue)) return refusal('INVALID_ARGS', '--issue: expected a positive issue number');
  if (!REASON_RE.test(reason ?? '')) return refusal('INVALID_ARGS', '--reason: expected an UPPER_SNAKE reason code');
  if (!text(question) || question.includes('\n')) return refusal('INVALID_ARGS', '--question: expected one non-empty line');
  if (!BLOCK_GATES.includes(gate)) return refusal('INVALID_ARGS', `--gate: expected one of ${BLOCK_GATES.join(', ')}`);
  const view = run('gh', ['issue', 'view', String(issue), '--json', 'state,labels']);
  let facts = null;
  try { facts = view.ok ? JSON.parse(view.stdout) : null; } catch { facts = null; }
  if (facts?.state !== 'OPEN') return refusal('ISSUE_NOT_OPEN', `#${issue} is not an open issue`);
  const block = { issue, class: 'human', reason, question: text(question), at: new Date(now).toISOString() };
  const body = [
    blockMarker(block),
    `**autoloop: blocked — needs a human decision** (\`${reason}\`)`,
    '',
    block.question,
    ...(note ? ['', note] : []),
    '',
    'Reply `/answer <your decision>` on this issue. The loop resumes it first at its next start; nothing else needs changing.',
  ].join('\n');
  const comment = run('gh', ['issue', 'comment', String(issue), '--body', body]);
  if (!comment.ok) return refusal('GH_FAILED', `comment on #${issue} failed: ${comment.stderr}`);
  const stale = (facts.labels ?? []).map((label) => label?.name ?? label)
    .filter((name) => name === 'loop-started' || name.startsWith('loop:'));
  const edit = ['issue', 'edit', String(issue), '--add-label', `loop-blocked,${gate}`,
    ...(stale.length > 0 ? ['--remove-label', stale.join(',')] : [])];
  const labelled = run('gh', edit);
  if (!labelled.ok) return refusal('GH_FAILED', `labels on #${issue} failed: ${labelled.stderr}`);
  return { ok: true, issue, disposition: 'blocked', block };
}

/** Lift every wait whose condition has cleared. Never throws: a failure is
 *  reported and the waiting issue stays waiting, which is the safe side. */
export function liftWaits({ base, run, now = Date.now() }) {
  const listed = run('gh', ['issue', 'list', '--label', 'loop-waiting', '--state', 'open', '--limit', '100', '--json', 'number,comments']);
  if (!listed.ok) return { lifted: [], waiting: [], errors: [`list: ${listed.stderr}`] };
  let issues;
  try { issues = JSON.parse(listed.stdout); } catch { return { lifted: [], waiting: [], errors: ['list: unparseable'] }; }
  const lifted = [];
  const waiting = [];
  const errors = [];
  const baseOid = remoteBaseOid(run, base);
  const issueStates = {};
  for (const issue of issues) {
    const condition = waitCondition((issue.comments ?? []).map((comment) => comment.body));
    if (condition === null) {
      waiting.push({ number: issue.number, reason: 'no parseable waiting marker' });
      continue;
    }
    if (condition.on === 'issue' && !(condition.number in issueStates)) {
      issueStates[condition.number] = issueState(run, condition.number);
    }
    const cleared = waitCleared(condition, { issueStates, baseOid, now });
    if (cleared === null) {
      const holding = { issue: `#${condition.number} is open`, base: 'the base has not moved', time: `until ${condition.until}` };
      waiting.push({ number: issue.number, reason: holding[condition.on] });
      continue;
    }
    const removed = run('gh', ['issue', 'edit', String(issue.number), '--remove-label', 'loop-waiting']);
    if (removed.ok) lifted.push({ number: issue.number, reason: cleared });
    else errors.push(`#${issue.number}: ${removed.stderr}`);
  }
  return { lifted, waiting, errors };
}

/** Pure: the first prose line of a comment, without markers or markdown decoration. */
function questionLine(body) {
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.replace(/<!--.*?-->/gu, '').replace(/\*\*/gu, '').replace(/^[\s#>*-]+/u, '').trim();
    if (line) return line.length > QUESTION_MAX ? `${line.slice(0, QUESTION_MAX - 1)}…` : line;
  }
  return null;
}

/** Pure: one row per waiting decision, ordered by number. */
export function digestRows(issues, prs) {
  return [...(issues ?? []), ...(prs ?? [])]
    .map((item) => {
      const marked = (item.comments ?? []).map((comment) => parseBlock(comment.body))
        .findLast((entry) => entry !== null)?.question ?? null;
      const comments = (item.comments ?? [])
        .filter((comment) => waitCondition([comment.body]) === null && parseDecision(comment.body) === null);
      const question = marked ?? comments.map((comment) => questionLine(comment.body))
        .findLast((line) => line !== null) ?? null;
      return {
        number: item.number,
        title: item.title,
        labels: (item.labels ?? []).map((label) => label?.name ?? label).filter((name) => GATE_LABEL_RE.test(name)),
        question: question ?? 'no reason recorded',
      };
    })
    .sort((left, right) => left.number - right.number);
}

/** Pure: one row per decision the loop took in the last seven days, newest first. */
export function decisionRows(issues, now) {
  return (issues ?? [])
    .map((item) => {
      const decision = (item.comments ?? []).map((comment) => parseDecision(comment.body))
        .findLast((entry) => entry !== null) ?? null;
      return decision && now - Date.parse(decision.at) <= DECISION_WINDOW_MS
        ? { number: item.number, title: item.title, choice: decision.choice, at: decision.at }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

export function digestBody(rows, at, decided = []) {
  return [
    '<!-- autoloop-digest-v1 -->',
    `**Decisions waiting on a human** — updated ${at}`,
    '',
    ...(rows.length === 0
      ? ['Nothing waiting.']
      : rows.map((row) => `- #${row.number}${row.labels.length > 0 ? ` [${row.labels.join(', ')}]` : ''} ${row.title} — ${row.question}`)),
    ...(decided.length === 0
      ? []
      : ['', '**Decided by the loop** — the recommended option, taken without waiting', '',
        ...decided.map((row) => `- #${row.number} ${row.title} — decided, reversible: ${row.choice}`)]),
    '',
    'The loop rewrites this at every close and park. Answer on each unit, not here.',
  ].join('\n');
}

function readJson(run, args) {
  const result = run('gh', args);
  if (!result.ok) throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export function collectDigest({ run }) {
  const fields = ['--state', 'open', '--limit', '100', '--json', 'number,title,labels,comments'];
  return digestRows(
    readJson(run, ['issue', 'list', '--label', 'loop-blocked', ...fields]),
    readJson(run, ['pr', 'list', '--label', 'human:authorize', ...fields]),
  );
}

export function collectDecisions({ run, now = Date.now() }) {
  return decisionRows(
    readJson(run, ['issue', 'list', '--label', 'loop-decided', '--state', 'all', '--limit', '50', '--search', 'sort:updated-desc', '--json', 'number,title,comments']),
    now,
  );
}

/** Rewrite the tracking issue. Never throws: a digest must not fail a close. */
export function postDigest({ run, now = Date.now() }) {
  try {
    const rows = collectDigest({ run });
    let decided = [];
    try {
      decided = collectDecisions({ run, now });
    } catch {
      // Recorded decisions are a courtesy list; the questions must still post.
    }
    const body = digestBody(rows, new Date(now).toISOString(), decided);
    let issue = readJson(run, ['issue', 'list', '--label', 'loop-digest', '--state', 'open', '--limit', '1', '--json', 'number'])[0]?.number ?? null;
    if (issue === null) {
      const created = withLabel(run, 'loop-digest', () => run('gh', [
        'issue', 'create', '--title', 'autoloop: decisions waiting', '--body', body, '--label', 'loop-digest',
      ]));
      issue = created.ok ? positive(/\/issues\/([1-9][0-9]*)/u.exec(created.stdout)?.[1]) : null;
      if (issue === null) throw new Error(`issue create: ${created.stderr || created.stdout}`);
      run('gh', ['issue', 'pin', String(issue)]);
    } else {
      const edited = run('gh', ['issue', 'edit', String(issue), '--body', body]);
      if (!edited.ok) throw new Error(`issue edit: ${edited.stderr}`);
    }
    return { ok: true, issue, rows, decided };
  } catch (error) {
    return { ok: false, issue: null, rows: [], decided: [], error: String(error?.message ?? error) };
  }
}

export function parseArgs(args) {
  const parsed = { mode: null, issue: null, pr: null, commit: null, onIssue: null, onBaseRed: false, minutes: null, post: false, note: '', choice: null, why: null, alternatives: [], reason: null, question: null, gate: 'human:decide', error: null };
  const value = (index) => args[index + 1];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (['--obsolete', '--wait', '--block', '--decide', '--lift', '--digest', '--self-test'].includes(flag)) {
      if (parsed.mode !== null) return { ...parsed, error: 'expected one mode' };
      parsed.mode = flag.slice(2);
    } else if (flag === '--on-base-red') {
      parsed.onBaseRed = true;
    } else if (flag === '--post') {
      parsed.post = true;
    } else if (['--issue', '--pr', '--on-issue', '--minutes'].includes(flag)) {
      const number = positive(value(index));
      if (number === null) return { ...parsed, error: `${flag}: expected a positive number` };
      parsed[{ '--issue': 'issue', '--pr': 'pr', '--on-issue': 'onIssue', '--minutes': 'minutes' }[flag]] = number;
      index += 1;
    } else if (['--commit', '--note', '--choice', '--why', '--reason', '--question', '--gate'].includes(flag)) {
      if (value(index) === undefined) return { ...parsed, error: `${flag}: expected a value` };
      parsed[flag.slice(2)] = value(index);
      index += 1;
    } else if (flag === '--alternatives') {
      if (value(index) === undefined) return { ...parsed, error: `${flag}: expected a value` };
      parsed.alternatives = value(index).split(';').map((entry) => entry.trim()).filter(Boolean);
      index += 1;
    } else {
      return { ...parsed, error: `unknown argument ${flag}` };
    }
  }
  if (parsed.mode === null) return { ...parsed, error: 'expected --obsolete, --wait, --block, --decide, --lift, --digest or --self-test' };
  return parsed;
}

function fakeRun(responses) {
  const calls = [];
  const run = (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    const hit = responses.find(([prefix]) => line.startsWith(prefix));
    return hit ? { ok: hit[1] !== false, stdout: typeof hit[1] === 'string' ? hit[1] : '', stderr: hit[1] === false ? 'failed' : '' } : { ok: false, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls };
}

function selfTest() {
  const failures = [];
  let count = 0;
  const check = (name, passed) => {
    count += 1;
    if (!passed) failures.push(name);
  };
  const oid = 'a'.repeat(40);
  const moved = 'b'.repeat(40);

  check('a marker round-trips, the newest wins, junk is skipped',
    JSON.stringify(waitCondition([waitMarker({ on: 'issue', number: 4 })])) === '{"on":"issue","number":4}'
    && waitCondition([waitMarker({ on: 'issue', number: 4 }), `x\n${waitMarker({ on: 'base', oid })}`]).on === 'base'
    && waitCondition(['<!-- autoloop-waiting-v1 {nope} -->', 'plain']) === null
    && waitCondition([waitMarker({ on: 'issue', number: 4 }), waitMarker({ on: 'issue', number: 0 })]).number === 4);
  check('a wait clears on a closed dependency or a moved base, not otherwise',
    waitCleared({ on: 'issue', number: 4 }, { issueStates: { 4: 'CLOSED' } }) === '#4 is closed'
    && waitCleared({ on: 'issue', number: 4 }, { issueStates: { 4: 'OPEN' } }) === null
    && waitCleared({ on: 'issue', number: 4 }, { issueStates: { 4: null } }) === null
    && waitCleared({ on: 'base', oid }, { baseOid: moved }) !== null
    && waitCleared({ on: 'base', oid }, { baseOid: oid }) === null
    && waitCleared({ on: 'base', oid }, { baseOid: null }) === null);

  const selfWait = fakeRun([]);
  check('waiting on itself is refused before any call',
    markWaiting({ issue: 5, onIssue: 5, base: 'main', run: selfWait.run }).code === 'SELF_WAIT' && selfWait.calls.length === 0);
  const closedDep = fakeRun([['gh issue view 4', 'CLOSED']]);
  check('waiting on a closed issue is refused',
    markWaiting({ issue: 5, onIssue: 4, base: 'main', run: closedDep.run }).code === 'NOTHING_TO_WAIT_ON');
  const waits = fakeRun([['gh issue view 4', 'OPEN'], ['gh issue comment 5', ''], ['gh issue edit 5 --add-label loop-waiting', '']]);
  const waited = markWaiting({ issue: 5, onIssue: 4, base: 'main', run: waits.run });
  check('a wait comments the marker then labels, and never edits the body',
    waited.ok && waits.calls[1].includes('autoloop-waiting-v1 {"on":"issue","number":4}')
    && waits.calls[2] === 'gh issue edit 5 --add-label loop-waiting'
    && !waits.calls.some((call) => call.includes('--body-file') || call.includes('loop-ready')));
  const until = '2026-01-01T13:00:00.000Z';
  check('a timed wait round-trips, clears at its time, and holds before it',
    JSON.stringify(waitCondition([waitMarker({ on: 'time', until })])) === `{"on":"time","until":"${until}"}`
    && waitCondition([waitMarker({ on: 'time', until: 'soon' })]) === null
    && waitCleared({ on: 'time', until }, { now: Date.parse(until) }) !== null
    && waitCleared({ on: 'time', until }, { now: Date.parse(until) - 1 }) === null
    && waitCleared({ on: 'time', until }, {}) === null);
  const timed = fakeRun([['gh issue comment 5', ''], ['gh issue edit 5', '']]);
  const timedWait = markWaiting({ issue: 5, minutes: 60, base: 'main', run: timed.run, now: Date.parse('2026-01-01T12:00:00Z') });
  check('a timed wait records its end and needs no other read',
    timedWait.ok && timedWait.condition.until === until && timed.calls.length === 2
    && markWaiting({ issue: 5, minutes: 0, base: 'main', run: timed.run }).code === 'INVALID_ARGS'
    && markWaiting({ issue: 5, minutes: 721, base: 'main', run: timed.run }).code === 'INVALID_ARGS'
    && markWaiting({ issue: 5, minutes: 60, onBaseRed: true, base: 'main', run: timed.run }).code === 'INVALID_ARGS');
  const baseWait = fakeRun([['git rev-parse', oid], ['gh issue comment 5', ''], ['gh issue edit 5', '']]);
  check('a red-base wait records the remote base oid',
    markWaiting({ issue: 5, onBaseRed: true, base: 'main', run: baseWait.run }).condition.oid === oid);
  let labelTries = 0;
  const missingLabel = {
    calls: [],
    run(command, args) {
      const line = [command, ...args].join(' ');
      this.calls.push(line);
      if (line.startsWith('gh issue edit')) return { ok: (labelTries += 1) > 1, stdout: '', stderr: 'label not found' };
      return { ok: true, stdout: line.startsWith('gh issue view') ? 'OPEN' : '', stderr: '' };
    },
  };
  check('a missing label is created and the add retried once',
    markWaiting({ issue: 5, onIssue: 4, base: 'main', run: missingLabel.run.bind(missingLabel) }).ok
    && missingLabel.calls.some((call) => call.startsWith('gh label create loop-waiting')));

  const unmerged = fakeRun([['gh issue view 5', 'OPEN'], ['gh pr view 9', '{"state":"OPEN","baseRefName":"main","url":"u"}']]);
  check('obsolete refuses an unmerged PR and touches nothing',
    markObsolete({ issue: 5, pr: 9, base: 'main', run: unmerged.run }).code === 'EVIDENCE_NOT_DELIVERED'
    && !unmerged.calls.some((call) => /issue (comment|edit|close)/u.test(call)));
  const otherBase = fakeRun([['gh issue view 5', 'OPEN'], ['gh pr view 9', '{"state":"MERGED","baseRefName":"release","url":"u"}']]);
  check('obsolete refuses a PR merged into another branch',
    markObsolete({ issue: 5, pr: 9, base: 'main', run: otherBase.run }).code === 'EVIDENCE_NOT_DELIVERED');
  const stray = fakeRun([['gh issue view 5', 'OPEN'], ['git merge-base', false]]);
  check('obsolete refuses a commit the base does not contain',
    markObsolete({ issue: 5, commit: 'c'.repeat(40), base: 'main', run: stray.run }).code === 'EVIDENCE_NOT_DELIVERED');
  const done = fakeRun([
    ['gh issue view 5', 'OPEN'],
    ['gh pr view 9', `{"state":"MERGED","baseRefName":"main","url":"u","mergeCommit":{"oid":"${oid}"}}`],
    ['gh issue', ''],
  ]);
  const closed = markObsolete({ issue: 5, pr: 9, base: 'main', run: done.run });
  check('obsolete comments the evidence, labels, then closes not planned',
    closed.ok && done.calls.slice(-3).map((call) => call.split(' ').slice(0, 3).join(' ')).join('|')
      === 'gh issue comment|gh issue edit|gh issue close'
    && done.calls.at(-1).endsWith('--reason not planned') && done.calls.at(-3).includes(oid));
  const closedIssue = fakeRun([['gh issue view 5', 'CLOSED']]);
  check('obsolete refuses an issue that is not open',
    markObsolete({ issue: 5, pr: 9, base: 'main', run: closedIssue.run }).code === 'ISSUE_NOT_OPEN');

  const list = JSON.stringify([
    { number: 10, comments: [{ body: waitMarker({ on: 'issue', number: 4 }) }] },
    { number: 11, comments: [{ body: waitMarker({ on: 'issue', number: 6 }) }] },
    { number: 12, comments: [{ body: waitMarker({ on: 'base', oid }) }] },
    { number: 13, comments: [{ body: 'no marker' }] },
  ]);
  const lifting = fakeRun([
    ['gh issue list', list], ['git rev-parse', moved],
    ['gh issue view 4', 'CLOSED'], ['gh issue view 6', 'OPEN'], ['gh issue edit', ''],
  ]);
  const lift = liftWaits({ base: 'main', run: lifting.run });
  check('prime lifts cleared waits and keeps the rest, reporting a markerless one',
    lift.lifted.map((entry) => entry.number).join(',') === '10,12'
    && lift.waiting.map((entry) => entry.number).join(',') === '11,13'
    && lift.errors.length === 0
    && lifting.calls.filter((call) => call.startsWith('gh issue edit')).every((call) => call.endsWith('--remove-label loop-waiting')));
  const listFails = fakeRun([['gh issue list', false]]);
  check('a failed listing lifts nothing and reports it',
    liftWaits({ base: 'main', run: listFails.run }).errors.length === 1);

  const digestIssues = [
    {
      number: 21,
      title: 'Cap reached',
      labels: [{ name: 'loop-ready' }, { name: 'loop-blocked' }, { name: 'human:decide' }],
      comments: [
        { body: 'old reason' },
        { body: '## **Blocked:** raise the cap to 6, re-plan, or carve the predicate?\nmore' },
        { body: waitMarker({ on: 'issue', number: 3 }) },
      ],
    },
    { number: 20, title: 'Silent', labels: [{ name: 'loop-blocked' }], comments: [{ body: '\n  \n' }] },
  ];
  const digestPrs = [{ number: 30, title: 'Touch CI', labels: [{ name: 'human:authorize' }], comments: [] }];
  const rows = digestRows(digestIssues, digestPrs);
  check('digest rows carry gate labels and the newest reason line, skipping markers and blanks',
    rows.map((row) => row.number).join(',') === '20,21,30'
    && rows[1].labels.join(',') === 'human:decide'
    && rows[1].question === 'Blocked: raise the cap to 6, re-plan, or carve the predicate?'
    && rows[0].question === 'no reason recorded'
    && rows[2].labels.join(',') === 'human:authorize');
  check('the digest body lists every row, or says nothing is waiting',
    digestBody(rows, 'T').includes('- #21 [human:decide] Cap reached — Blocked: raise the cap')
    && digestBody(rows, 'T').includes('- #30 [human:authorize] Touch CI')
    && digestBody([], 'T').includes('Nothing waiting.'));
  const lists = [
    ['gh issue list --label loop-blocked', JSON.stringify(digestIssues)],
    ['gh pr list --label human:authorize', JSON.stringify(digestPrs)],
  ];
  const existing = fakeRun([...lists, ['gh issue list --label loop-digest', '[{"number":99}]'], ['gh issue edit 99', '']]);
  const posted = postDigest({ run: existing.run, now: 0 });
  check('--post rewrites the existing tracking issue body and adds no comment',
    posted.ok && posted.issue === 99 && posted.rows.length === 3
    && existing.calls.some((call) => call.startsWith('gh issue edit 99 --body'))
    && !existing.calls.some((call) => call.startsWith('gh issue comment')));
  const absent = fakeRun([
    ...lists,
    ['gh issue list --label loop-digest', '[]'],
    ['gh issue create', 'https://github.com/o/r/issues/101'],
    ['gh issue pin 101', false],
  ]);
  const created = postDigest({ run: absent.run, now: 0 });
  check('--post creates and pins the tracking issue when absent, tolerating a pin failure',
    created.ok && created.issue === 101
    && absent.calls.some((call) => call.startsWith('gh issue create') && call.includes('--label loop-digest'))
    && !absent.calls.some((call) => call.includes('loop-ready')));
  const withDecisions = fakeRun([
    ...lists,
    ['gh issue list --label loop-decided', JSON.stringify([{ number: 40, title: 'Recent', comments: [{ body: decisionMarker({ issue: 40, choice: 'c', alternatives: [], why: 'w', at: '2026-09-25T00:00:00.000Z' }) }] }])],
    ['gh issue list --label loop-digest', '[{"number":99}]'],
    ['gh issue edit 99', ''],
  ]);
  const postedDecisions = postDigest({ run: withDecisions.run, now: Date.parse('2026-09-26T00:00:00Z') });
  check('--post lists recent decisions, and a failed decision read still posts the questions',
    postedDecisions.ok && postedDecisions.decided.map((row) => row.number).join(',') === '40'
    && withDecisions.calls.some((call) => call.startsWith('gh issue edit 99') && call.includes('decided, reversible: c'))
    && posted.ok && posted.decided.length === 0);
  check('a failed digest read reports instead of throwing',
    postDigest({ run: fakeRun([]).run }).ok === false);

  const decidedAt = '2026-09-25T10:00:00.000Z';
  const decision = { issue: 5, choice: 'derive the bits from the locked construction', alternatives: ['whitelist the constant', 'block'], why: 'e_hypot.c:80-81 builds it', at: decidedAt };
  check('a decision marker round-trips, the newest wins, junk is skipped',
    JSON.stringify(parseDecision(decisionMarker(decision))) === JSON.stringify(decision)
    && parseDecision(`${decisionMarker(decision)}\n${decisionMarker({ ...decision, choice: 'later' })}`).choice === 'later'
    && parseDecision('<!-- autoloop-decision-v1 {nope} -->') === null
    && parseDecision(decisionMarker({ ...decision, why: '' })) === null
    && parseDecision('plain') === null);
  const undecided = fakeRun([]);
  check('a decision without a choice or a why is refused before any call',
    markDecided({ issue: 5, choice: '', why: 'w', run: undecided.run }).code === 'INVALID_ARGS'
    && markDecided({ issue: 5, choice: 'c', why: '  ', run: undecided.run }).code === 'INVALID_ARGS'
    && undecided.calls.length === 0);
  const decidedClosed = fakeRun([['gh issue view 5', 'CLOSED']]);
  check('a decision on an issue that is not open is refused',
    markDecided({ issue: 5, choice: 'c', why: 'w', run: decidedClosed.run }).code === 'ISSUE_NOT_OPEN');
  const deciding = fakeRun([['gh issue view 5', 'OPEN'], ['gh issue comment 5', ''], ['gh issue edit 5 --add-label loop-decided', '']]);
  const decided = markDecided({ issue: 5, choice: decision.choice, alternatives: decision.alternatives, why: decision.why, run: deciding.run, now: Date.parse(decidedAt) });
  check('a decision comments the marker with the reversal form, labels, and never edits the body',
    decided.ok && decided.disposition === 'decided'
    && parseDecision(deciding.calls[1]).choice === decision.choice
    && deciding.calls[1].includes('/answer')
    && deciding.calls[2] === 'gh issue edit 5 --add-label loop-decided'
    && !deciding.calls.some((call) => call.includes('--body-file') || call.includes('loop-ready')));
  const decidedIssues = [
    { number: 40, title: 'Recent', comments: [{ body: decisionMarker({ ...decision, issue: 40 }) }] },
    { number: 41, title: 'Stale', comments: [{ body: decisionMarker({ ...decision, issue: 41, at: '2026-09-01T00:00:00.000Z' }) }] },
    { number: 42, title: 'Unmarked', comments: [{ body: 'no marker' }] },
  ];
  const decidedRows = decisionRows(decidedIssues, Date.parse('2026-09-26T00:00:00Z'));
  check('decision rows keep the last seven days of marked decisions',
    decidedRows.map((row) => row.number).join(',') === '40'
    && decidedRows[0].choice === decision.choice);
  check('the digest lists decisions apart from the questions, as reversible',
    digestBody([], 'T', decidedRows).includes('Nothing waiting.')
    && digestBody([], 'T', decidedRows).includes('- #40 Recent — decided, reversible: derive the bits')
    && !digestBody([], 'T', []).includes('Decided by the loop'));
  const blockedThenDecided = digestRows([{
    number: 21, title: 'x', labels: [],
    comments: [{ body: 'Blocked: what length?' }, { body: decisionMarker({ ...decision, issue: 21 }) }],
  }], []);
  check('a decision comment is never read as a blocked unit\'s question',
    blockedThenDecided[0].question === 'Blocked: what length?');

  const block = { issue: 7, class: 'human', reason: 'UNSPECIFIED_VALUE', question: 'What maximum device-label length applies?', at: decidedAt };
  check('a block marker round-trips, the newest wins, junk is skipped',
    JSON.stringify(parseBlock(blockMarker(block))) === JSON.stringify(block)
    && parseBlock(`${blockMarker(block)}\n${blockMarker({ ...block, question: 'later?' })}`).question === 'later?'
    && parseBlock(blockMarker({ ...block, class: 'fix' })) === null
    && parseBlock(blockMarker({ ...block, reason: 'lower case' })) === null
    && parseBlock('<!-- autoloop-block-v1 {nope} -->') === null);
  const unblockable = fakeRun([]);
  check('a block without a reason code or a one-line question is refused before any call',
    markBlocked({ issue: 7, reason: '', question: 'q?', run: unblockable.run }).code === 'INVALID_ARGS'
    && markBlocked({ issue: 7, reason: 'X', question: 'two\nlines', run: unblockable.run }).code === 'INVALID_ARGS'
    && markBlocked({ issue: 7, reason: 'X', question: 'q?', gate: 'loop-ready', run: unblockable.run }).code === 'INVALID_ARGS'
    && unblockable.calls.length === 0);
  const blocking = fakeRun([
    ['gh issue view 7', JSON.stringify({ state: 'OPEN', labels: [{ name: 'loop-ready' }, { name: 'loop-started' }, { name: 'loop:05-implement' }] })],
    ['gh issue comment 7', ''],
    ['gh issue edit 7', ''],
  ]);
  const blocked = markBlocked({ issue: 7, reason: block.reason, question: block.question, run: blocking.run, now: Date.parse(decidedAt) });
  const labelEdit = blocking.calls.find((call) => call.startsWith('gh issue edit 7'));
  check('a block comments the marker with the /answer form, then swaps labels in one edit, keeping loop-ready',
    blocked.ok && blocked.disposition === 'blocked'
    && JSON.stringify(parseBlock(blocking.calls.find((call) => call.startsWith('gh issue comment 7')))) === JSON.stringify(block)
    && blocking.calls.find((call) => call.startsWith('gh issue comment 7')).includes('/answer')
    && blocking.calls.indexOf(labelEdit) > blocking.calls.findIndex((call) => call.startsWith('gh issue comment 7'))
    && labelEdit === 'gh issue edit 7 --add-label loop-blocked,human:decide --remove-label loop-started,loop:05-implement'
    && !blocking.calls.some((call) => call.includes('--body-file')));
  const authorizing = fakeRun([['gh issue view 8', '{"state":"OPEN","labels":[]}'], ['gh issue comment 8', ''], ['gh issue edit 8', '']]);
  check('a protected-path block carries human:authorize and removes nothing it did not find',
    markBlocked({ issue: 8, reason: 'PROTECTED_PATH', question: 'May this unit touch .github/workflows?', gate: 'human:authorize', run: authorizing.run }).ok
    && authorizing.calls.at(-1) === 'gh issue edit 8 --add-label loop-blocked,human:authorize');
  const blockClosed = fakeRun([['gh issue view 7', '{"state":"CLOSED","labels":[]}']]);
  check('a block on an issue that is not open is refused',
    markBlocked({ issue: 7, reason: 'X', question: 'q?', run: blockClosed.run }).code === 'ISSUE_NOT_OPEN');
  const markedRows = digestRows([{
    number: 7, title: 'Labels', labels: [{ name: 'human:decide' }],
    comments: [{ body: `${blockMarker(block)}\n**autoloop: blocked**` }, { body: 'a later note' }],
  }], []);
  check('the digest reads a marked block\'s own question first',
    markedRows[0].question === block.question);

  check('arguments parse and refuse',
    parseArgs(['--block', '--issue', '7', '--reason', 'X', '--question', 'q?', '--gate', 'human:authorize']).gate === 'human:authorize'
    && parseArgs(['--decide', '--issue', '5', '--choice', 'c', '--why', 'w', '--alternatives', 'a; b']).alternatives.join('|') === 'a|b'
    && parseArgs(['--wait', '--issue', '5', '--on-issue', '4']).onIssue === 4
    && parseArgs(['--obsolete', '--issue', '5', '--commit', 'abc1234']).commit === 'abc1234'
    && parseArgs(['--wait', '--issue', '5', '--minutes', '60']).minutes === 60
    && parseArgs(['--digest', '--post']).post === true
    && parseArgs(['--wait', '--lift']).error !== null
    && parseArgs(['--issue', '05']).error !== null
    && parseArgs([]).error !== null);

  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0 ? `self-test OK (${count} cases)` : `self-test FAILED (${failures.length}/${count})`);
  return failures.length === 0;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`unit: ${parsed.error}`);
    console.error('usage: unit.mjs --obsolete --issue N (--pr M | --commit SHA) [--note T] | --wait --issue N (--on-issue M | --on-base-red | --minutes 1..720) [--note T] | --block --issue N --reason CODE --question T [--gate human:authorize] [--note T] | --decide --issue N --choice T --why T [--alternatives "A; B"] | --lift | --digest [--post] | --self-test');
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);
  const root = realRun(process.cwd())('git', ['rev-parse', '--show-toplevel']).stdout || process.cwd();
  const run = realRun(root);
  if (parsed.mode === 'decide' || parsed.mode === 'block') {
    const outcome = parsed.mode === 'decide' ? markDecided({ ...parsed, run }) : markBlocked({ ...parsed, run });
    console.log(JSON.stringify(outcome, null, 1));
    process.exit(outcome.ok ? 0 : 1);
  }
  if (parsed.mode === 'digest') {
    let outcome;
    try {
      outcome = parsed.post ? postDigest({ run }) : { ok: true, rows: collectDigest({ run }) };
    } catch (error) {
      outcome = refusal('GH_FAILED', String(error?.message ?? error));
    }
    console.log(JSON.stringify(outcome, null, 1));
    process.exit(outcome.ok ? 0 : 1);
  }
  let base;
  try {
    base = baseBranch(root);
  } catch (error) {
    console.log(JSON.stringify(refusal('PROJECT_CONFIG_UNREADABLE', error.message)));
    process.exit(1);
  }
  const outcome = parsed.mode === 'obsolete'
    ? markObsolete({ ...parsed, base, run })
    : parsed.mode === 'wait'
      ? markWaiting({ ...parsed, base, run })
      : { ok: true, ...liftWaits({ base, run }) };
  console.log(JSON.stringify(outcome, null, 1));
  process.exit(outcome.ok ? 0 : 1);
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
