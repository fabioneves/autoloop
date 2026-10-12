#!/usr/bin/env node

// Self-resolving unit dispositions: the two outcomes a run used to hand to a
// human even though nothing about them needs one.
//
//   --obsolete  The premise is already delivered. The tool checks the cited
//               evidence (a PR merged into the configured base, or a commit
//               the remote base contains), then comments it, labels the issue
//               `loop-obsolete` and closes it as not planned. Reopening undoes it.
//   --wait      The unit waits on another issue, on a red base, for a time
//               (a step the host keeps killing backs off instead of blocking),
//               or on a delivered pull request whose changed paths overlap the
//               plan boundary. A machine comment records the condition and the
//               issue is labelled `loop-waiting`, which the queue skips. Prime
//               calls liftWaits before every scan and removes the label once
//               the condition has cleared, so the unit comes back without a
//               human; a lifted PR wait is reported `resumed`, and the unit
//               re-plans once on the merged base.
//
//   --overlap   The pure check before a claim: the plan boundary against the
//               delivered set (open loop PRs at ready-head or premerge-record,
//               with their changed paths, from the retained snapshot). A hit
//               names the PR and the overlapping paths for `--wait --on-pr`.
//
//   --block     An authorization only the human can give: an irreversible
//               external act (IRREVERSIBLE_ACTION) or a secret, dependency,
//               permission or policy exception (POLICY_DENIED). A machine
//               comment records the reason code and the one-line question; the
//               labels swap to loop-blocked plus the gate label in one edit, and
//               loop-ready stays. A human answers with `/answer <decision>` on
//               the issue. TRUST_REQUIRED and UNSPECIFIED_VALUE are retired: a
//               specification gap is decided (33 premise blocks on one project
//               waited for a human on gaps the loop could decide).
//
//   --repair    Work a unit needs that is outside its own lane: an issue the loop
//               files itself, labelled `loop-repair` (never `loop-ready`) with a
//               body marker copying the parent's trusted `loop-ready` provenance,
//               which is what makes it eligible. At most three open per parent,
//               one level deep. `--blocks-parent` also puts the parent on
//               `loop-waiting` until the repair closes.
//
//   --decide    A judgment call the loop made itself: the question, the
//               recommended option, its alternatives and the evidence. A machine
//               comment records it and the issue is labelled `loop-decided`; a
//               human reverses it by replying `/answer <what instead>`.
//
//   --decisions Every decision of one unit with its comment link, and the
//               `## Decisions` section the PR body and the run record carry.
//               A block whose reason is now retired, lifted by `/answer`, is
//               listed as decided by that answer.
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
//   node <plugin-tools>/unit.mjs --obsolete --issue <N> (--pr <M> | --commit <sha>) [--note <text>]
//   node <plugin-tools>/unit.mjs --wait --issue <N> (--on-issue <M> | --on-base-red | --minutes <1..720> | --on-pr <M> --paths <a,b/>) [--note <text>]
//   node <plugin-tools>/unit.mjs --overlap --issue <N> --boundary-file <path> --snapshot <path>
//   node <plugin-tools>/unit.mjs --block --issue <N> --reason <CODE> --question <one line> [--gate human:authorize] [--note <text>]
//   node <plugin-tools>/unit.mjs --repair --parent <N> --title <text> --body-file <path> [--blocks-parent]
//   node <plugin-tools>/unit.mjs --decide --issue <N> --question <one line> --choice <text> --why <text> [--alternatives "<a>; <b>"]
//   node <plugin-tools>/unit.mjs --decisions --issue <N> [--out <path>]
//   node <plugin-tools>/unit.mjs --lift
//   node <plugin-tools>/unit.mjs --digest [--post]
//   node <plugin-tools>/unit.mjs --self-test

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_CONFIG, resolveProjectConfig } from './config-contract.mjs';
import { updateStepRecord } from './dispatch-return-association.mjs';
import { inLane } from './lane-contract.mjs';
import {
  SNAPSHOT_SECTIONS, completeSection, createSnapshot, deliveredPullRequests, invalidateSnapshot, snapshotProblem,
  verifySnapshot,
} from './snapshot-contract.mjs';

const TIMEOUT_MS = 30_000;
const WAIT_MARKER_RE = /<!-- autoloop-waiting-v1 (\{[^\n]*?\}) -->/gu;
const DECISION_MARKER_RE = /<!-- autoloop-decision-v1 (\{[^\n]*?\}) -->/gu;
const BLOCK_MARKER_RE = /<!-- autoloop-block-v1 (\{[^\n]*?\}) -->/gu;
const REASON_RE = /^[A-Z][A-Z0-9_]*$/u;
const BLOCK_GATES = Object.freeze(['human:decide', 'human:authorize']);
const HUMAN_BLOCK_REASONS = new Set(['IRREVERSIBLE_ACTION', 'POLICY_DENIED']);
// Reasons that carried specification gaps to a human; a gap is decided now.
const RETIRED_BLOCK_REASONS = new Set(['TRUST_REQUIRED', 'UNSPECIFIED_VALUE']);
const RESUMED_MARKER_RE = /<!-- autoloop-resumed-v1 (\{[^\n]*?\}) -->/gu;
const REPAIR_MARKER_RE = /<!-- autoloop-repair-v1 (\{[^\n]*?\}) -->/gu;
const REPAIRS_PER_PARENT = 3;
const LAST_READY_LABEL_JQ = '[.[] | select(.event == "labeled" and .label.name == "loop-ready") | {by: .actor.login, at: .created_at}] | last // empty';
const BLOCK_LABEL_WINDOW_MS = 5 * 60_000;
const ANSWER_RE = /^\s*\/answer(?:\s+([\s\S]*))?$/u;
const WRITE_PERMISSIONS = Object.freeze(['admin', 'maintain', 'write']);
const LAST_BLOCKED_LABEL_JQ = '[.[] | select(.event == "labeled" and .label.name == "loop-blocked") | .created_at] | last // empty';
const DECISION_WINDOW_MS = 7 * 24 * 60 * 60_000;
const SHA_RE = /^[0-9a-f]{7,40}$/u;
const MAX_WAIT_MINUTES = 720;
const LABELS = Object.freeze({
  'loop-waiting': { color: 'fbca04', description: 'autoloop: waits on a recorded condition; lifted automatically' },
  'loop-obsolete': { color: 'cfd3d7', description: 'autoloop: premise already delivered; closed with evidence' },
  'loop-repair': { color: 'd4c5f9', description: 'autoloop: work the loop filed for a loop-ready parent; eligible through the parent' },
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
        else if (parsed?.on === 'pr' && positive(parsed.number) && pathList(parsed.paths) !== null) {
          // `until` caps the wait (0.69.0); a marker without it holds until the PR settles.
          newest = { on: 'pr', number: parsed.number, paths: parsed.paths,
            ...(Number.isFinite(Date.parse(parsed.until)) ? { until: parsed.until } : {}) };
        }
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

/** Pure: a non-empty list of non-empty path strings, or null. */
function pathList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((path) => typeof path === 'string' && path.length > 0)
    ? value
    : null;
}

/** Pure: the first delivered PR whose changed files intersect the boundary,
 *  with the intersecting paths, or null. The boundary is a lane: an entry
 *  ending in `/` is a directory prefix; any other entry matches one path exactly. */
export function overlapWith(boundary, deliveredPrs) {
  const lane = (Array.isArray(boundary) ? boundary : []).filter((entry) => typeof entry === 'string' && entry.length > 0);
  for (const delivered of Array.isArray(deliveredPrs) ? deliveredPrs : []) {
    const paths = (delivered?.files ?? []).filter((path) => inLane(path, lane));
    if (paths.length > 0) return { pr: delivered.pr, paths };
  }
  return null;
}

/** Pure: the boundary inside a plan dispatch result, a plan, or a bare list; null when absent. */
export function boundaryOf(value) {
  const found = Array.isArray(value) ? value : value?.plan?.boundary ?? value?.boundary;
  return pathList(found);
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
  if (condition?.on === 'pr') {
    const state = facts?.prStates?.[condition.number];
    if (state === 'MERGED' || state === 'CLOSED') return `PR #${condition.number} ${state.toLowerCase()}`;
    // A PR wait is capped like a timed wait: a PR nobody merges must not hold
    // the unit for ever. The lift is still a resume, so the unit re-plans.
    return condition.until !== undefined && Number.isFinite(facts?.now) && facts.now >= Date.parse(condition.until)
      ? `PR #${condition.number} still open after ${MAX_WAIT_MINUTES} min; re-plan`
      : null;
  }
  return null;
}

function baseBranch(root) {
  const resolved = resolveProjectConfig(root);
  if (!resolved?.ok) throw new Error(`project config: ${resolved?.errors?.join('; ') ?? NO_CONFIG}`);
  return resolved.config.baseBranch;
}

function remoteBaseOid(run, base) {
  const result = run('git', ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`]);
  return result.ok && SHA_RE.test(result.stdout) ? result.stdout : null;
}

function issueFacts(run, number, fields) {
  const view = run('gh', ['issue', 'view', String(number), '--json', fields]);
  try {
    return view.ok ? JSON.parse(view.stdout) : null;
  } catch {
    return null;
  }
}

function issueState(run, number) {
  const result = run('gh', ['issue', 'view', String(number), '--json', 'state', '--jq', '.state']);
  return result.ok ? result.stdout : null;
}

function prState(run, number) {
  const result = run('gh', ['pr', 'view', String(number), '--json', 'state', '--jq', '.state']);
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

// The parked view (step.mjs) shows a waiting unit as waiting: the wait is
// recorded on the unit's open step, which its next step or dispatch clears
// (LFE run 2026-09-30: #427 waited on #587 and read "07 diff-review r3
// returned · 58m"). A unit with no open record is left alone.
export function noteWaitOnStep({ commonDir, issue, what, nowMs = Date.now() }) {
  const path = join(commonDir, 'autoloop', 'steps', `${issue}.json`);
  try {
    const result = updateStepRecord(path, (record) => {
      const last = record?.steps?.at(-1);
      if (!last || record.closed || record.issue !== issue) return { changed: false, ok: false };
      last.waiting = { on: what, atMs: nowMs };
      return { changed: true, ok: true, record };
    });
    return result.ok;
  } catch {
    return false;
  }
}

function commonDirOf(run) {
  const result = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return result?.ok ? String(result.stdout).trim() : null;
}

export function markWaiting({ issue, onIssue = null, onBaseRed = false, minutes = null, onPr = null, paths = [], note = '', base, run, now = Date.now() }) {
  if (!positive(issue)) return refusal('INVALID_ARGS', '--issue: expected a positive issue number');
  if ([onIssue !== null, onBaseRed, minutes !== null, onPr !== null].filter(Boolean).length !== 1) {
    return refusal('INVALID_ARGS', 'expected exactly one of --on-issue, --on-base-red, --minutes or --on-pr');
  }
  let condition;
  let reason;
  if (onPr !== null) {
    if (!positive(onPr)) return refusal('INVALID_ARGS', '--on-pr: expected a positive PR number');
    if (pathList(paths) === null) return refusal('INVALID_ARGS', '--paths: expected the overlapping paths, comma-separated');
    const state = prState(run, onPr);
    if (state !== 'OPEN') return refusal('NOTHING_TO_WAIT_ON', `PR #${onPr} is ${state === null ? 'unreadable' : 'not open'}`);
    condition = { on: 'pr', number: onPr, paths, until: new Date(now + MAX_WAIT_MINUTES * 60_000).toISOString() };
    reason = `waits on PR #${onPr}, which changes ${paths.join(', ')} inside this plan's boundary; the label is lifted when it merges or closes (or at ${condition.until}), and the unit re-plans on the new base`;
  } else if (onIssue !== null) {
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
  try {
    const commonDir = commonDirOf(run);
    const what = condition.on === 'issue' ? `#${condition.number}`
      : condition.on === 'pr' ? `PR #${condition.number} (${condition.paths.join(', ')})`
        : condition.on === 'time' ? `${minutes} min` : `a green ${base}`;
    if (commonDir !== null) noteWaitOnStep({ commonDir, issue, what, nowMs: now });
  } catch {
    // The parked view is a courtesy; the wait stands.
  }
  return { ok: true, issue, disposition: 'waiting', condition };
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function decisionMarker(decision) {
  return `<!-- autoloop-decision-v1 ${JSON.stringify(decision)} -->`;
}

/** Pure: the newest marker payload in a body that `valid` accepts, or null.
 *  An unparseable or invalid marker is skipped; an earlier valid one still stands. */
function newestMarker(pattern, body, valid) {
  let newest = null;
  for (const match of String(body ?? '').matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (valid(parsed)) newest = parsed;
    } catch {
      // not a marker
    }
  }
  return newest;
}

// A marker before 0.69.0 has no question; it still parses.
export function parseDecision(body) {
  return newestMarker(DECISION_MARKER_RE, body, (parsed) =>
    positive(parsed?.issue) && text(parsed.choice) && text(parsed.why)
    && (parsed.question === undefined || (text(parsed.question) && !parsed.question.includes('\n')))
    && Array.isArray(parsed.alternatives) && parsed.alternatives.every((entry) => typeof entry === 'string')
    && Number.isFinite(Date.parse(parsed.at)));
}

// The parked line and the closing card (step.mjs) count a unit's decisions
// from its record. A unit with no open record is left alone.
export function noteDecisionOnStep({ commonDir, issue }) {
  const path = join(commonDir, 'autoloop', 'steps', `${issue}.json`);
  try {
    const result = updateStepRecord(path, (record) => {
      if (!record?.steps?.length || record.closed || record.issue !== issue) return { changed: false, ok: false };
      record.decisions = (Number.isSafeInteger(record.decisions) ? record.decisions : 0) + 1;
      return { changed: true, ok: true, record };
    });
    return result.ok;
  } catch {
    return false;
  }
}

export function markDecided({ issue, question, choice, alternatives = [], why, run, now = Date.now() }) {
  if (!positive(issue)) return refusal('INVALID_ARGS', '--issue: expected a positive issue number');
  if (!text(question) || question.includes('\n')) return refusal('INVALID_ARGS', '--question: expected one non-empty line');
  if (!text(choice) || !text(why)) return refusal('INVALID_ARGS', 'expected a non-empty --choice and --why');
  if (issueState(run, issue) !== 'OPEN') return refusal('ISSUE_NOT_OPEN', `#${issue} is not an open issue`);
  const decision = {
    issue,
    question: text(question),
    choice: text(choice),
    alternatives: alternatives.map((entry) => entry.trim()).filter(Boolean),
    why: text(why),
    at: new Date(now).toISOString(),
  };
  const body = [
    decisionMarker(decision),
    `**autoloop: decided** — ${decision.choice}`,
    '',
    `Question: ${decision.question}`,
    `Why: ${decision.why}`,
    ...(decision.alternatives.length > 0 ? [`Alternatives: ${decision.alternatives.join('; ')}`] : []),
    '',
    'The loop took the recommended option and kept going. Reply `/answer <what instead>` to reverse it.',
  ].join('\n');
  const comment = run('gh', ['issue', 'comment', String(issue), '--body', body]);
  if (!comment.ok) return refusal('GH_FAILED', `comment on #${issue} failed: ${comment.stderr}`);
  const label = addLabel(run, issue, 'loop-decided');
  if (!label.ok) return refusal('GH_FAILED', `label on #${issue} failed: ${label.stderr}`);
  try {
    const commonDir = commonDirOf(run);
    if (commonDir !== null) noteDecisionOnStep({ commonDir, issue });
  } catch {
    // The parked view is a courtesy; the decision stands.
  }
  const url = /https?:\/\/\S+/u.exec(String(comment.stdout ?? ''))?.[0] ?? null;
  return { ok: true, issue, disposition: 'decided', decision, url };
}

/** Pure: a unit's decisions in comment order, from the loop's own markers.
 *  Each carries its comment link and the newest later `/answer`. A block
 *  whose reason is retired, lifted by an answer, is the decision that answer
 *  took. The list is informational: the premise step applies the trust check
 *  before planning from an answer. */
export function unitDecisions(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const own = (comment) => comment?.viewerDidAuthor === true;
  // An answer reverses the newest decision before it: scan to the next decision.
  const answerAfterIndex = (index) => {
    const rest = list.slice(index + 1);
    const next = rest.findIndex((comment) => own(comment) && parseDecision(comment.body) !== null);
    const later = (next === -1 ? rest : rest.slice(0, next))
      .map((comment) => ({ match: ANSWER_RE.exec(String(comment?.body ?? '')), by: comment?.author?.login ?? 'unknown', url: comment?.url ?? null }))
      .findLast(({ match }) => match !== null);
    return later ? { by: later.by, text: (later.match[1] ?? '').trim(), url: later.url } : null;
  };
  const decisions = [];
  list.forEach((comment, index) => {
    if (!own(comment)) return;
    const decision = parseDecision(comment.body);
    if (decision !== null) {
      decisions.push({ kind: 'decision', question: decision.question ?? null, choice: decision.choice, alternatives: decision.alternatives,
        why: decision.why, at: decision.at, url: comment.url ?? null, answer: answerAfterIndex(index) });
      return;
    }
    const resumed = newestMarker(RESUMED_MARKER_RE, comment.body, (parsed) => positive(parsed?.issue) && text(parsed.by) && typeof parsed.answer === 'string');
    if (resumed === null) return;
    const block = list.slice(0, index).filter(own).map((entry) => parseBlock(entry.body)).findLast((entry) => entry !== null);
    if (!block || !RETIRED_BLOCK_REASONS.has(block.reason)) return;
    const answer = list.slice(0, index).findLast((entry) => entry?.author?.login === resumed.by && ANSWER_RE.test(String(entry?.body ?? '')));
    decisions.push({ kind: 'answer', question: block.question, choice: resumed.answer, alternatives: [], why: `@${resumed.by} answered the ${block.reason} block`,
      at: resumed.at, url: answer?.url ?? comment.url ?? null, by: resumed.by, answer: null });
  });
  return decisions;
}

/** Pure: the `## Decisions` section of a PR body or run record; empty without decisions. */
export function decisionsSection(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) return '';
  const link = (entry) => (entry.kind === 'answer'
    ? `[answer](${entry.url}) by @${entry.by}`
    : `[decision](${entry.url})`);
  return ['## Decisions', '', ...decisions.map((entry) => [
    `- ${entry.question ?? 'Question not recorded'} → ${entry.choice} (${link(entry)})`,
    ...(entry.alternatives.length > 0 ? [`alternatives: ${entry.alternatives.join('; ')}`] : []),
    `evidence: ${entry.why}`,
    ...(entry.answer ? [`reversed by @${entry.answer.by}: ${entry.answer.text}`] : []),
  ].join('; '))].join('\n');
}

/** Pure: the `## Scope changes` section of a PR body, from the review
 *  evidence's `scopeChanges` (SPEC-elastic-scope); empty without widenings. */
export function scopeChangesSection(scopeChanges) {
  if (!Array.isArray(scopeChanges) || scopeChanges.length === 0) return '';
  return ['## Scope changes', '', ...scopeChanges.map((change) =>
    `- ${change.findingId}: ${change.paths.join(', ')} — ${change.rationale}`)].join('\n');
}

/** Pure: the `## Open findings` section of a draft PR body, from the review
 *  transition's `openFindings` ledger (SPEC-review-rounds §4); empty without entries. */
export function openFindingsSection(openFindings) {
  if (!Array.isArray(openFindings) || openFindings.length === 0) return '';
  return ['## Open findings', '', ...openFindings.map((entry) =>
    `- ${entry.id} (${entry.severity}, ${entry.predicate}, raised in ${entry.raisings} round${entry.raisings === 1 ? '' : 's'}): `
    + `${entry.summary} — ${entry.evidence}`)].join('\n');
}

/** Pure: the `## Minor findings` section of a PR body (SPEC-review-rounds §6:
 *  Minors ride into the PR, never hold it); empty without Minors. */
export function minorFindingsSection(minors) {
  const listed = (Array.isArray(minors) ? minors : []).filter((entry) => entry?.severity === 'Minor');
  if (listed.length === 0) return '';
  return ['## Minor findings', '', ...listed.map((entry) => `- ${entry.id}: ${entry.summary} — ${entry.evidence}`)].join('\n');
}

/** Every decision of one unit from GitHub, with the section the PR body carries. */
export function collectUnitDecisions({ issue, run }) {
  if (!positive(issue)) return refusal('INVALID_ARGS', '--issue: expected a positive issue number');
  const viewed = run('gh', ['issue', 'view', String(issue), '--json', 'comments']);
  if (!viewed.ok) return refusal('GH_FAILED', `view of #${issue} failed: ${viewed.stderr}`);
  let comments;
  try { comments = JSON.parse(viewed.stdout).comments; } catch { return refusal('GH_FAILED', `view of #${issue}: unparseable`); }
  const decisions = unitDecisions(comments);
  return { ok: true, issue, decisions, section: decisionsSection(decisions) };
}

export function blockMarker(block) {
  return `<!-- autoloop-block-v1 ${JSON.stringify(block)} -->`;
}

export function parseBlock(body) {
  return newestMarker(BLOCK_MARKER_RE, body, (parsed) =>
    positive(parsed?.issue) && parsed.class === 'human' && REASON_RE.test(parsed.reason ?? '')
    && text(parsed.question) && !parsed.question.includes('\n') && Number.isFinite(Date.parse(parsed.at)));
}

export function markBlocked({ issue, reason, question, gate = 'human:decide', note = '', run, now = Date.now() }) {
  if (!positive(issue)) return refusal('INVALID_ARGS', '--issue: expected a positive issue number');
  if (!REASON_RE.test(reason ?? '')) return refusal('INVALID_ARGS', '--reason: expected an UPPER_SNAKE reason code');
  if (!text(question) || question.includes('\n')) return refusal('INVALID_ARGS', '--question: expected one non-empty line');
  if (!BLOCK_GATES.includes(gate)) return refusal('INVALID_ARGS', `--gate: expected one of ${BLOCK_GATES.join(', ')}`);
  if (RETIRED_BLOCK_REASONS.has(reason)) {
    return refusal('BLOCK_REASON_RETIRED',
      `--reason ${reason} is retired: a contradiction, a missing value, a design or scope choice is decided with --decide --question --choice --why --alternatives. Block only for ${[...HUMAN_BLOCK_REASONS].join(' or ')}.`);
  }
  if (!HUMAN_BLOCK_REASONS.has(reason)) {
    return refusal('NON_HUMAN_BLOCK_REASON',
      `--reason: expected one of ${[...HUMAN_BLOCK_REASONS].join(', ')}. Tool faults require fix or decide, not a human block. Do not rename a tool fault to a human reason.`);
  }
  const facts = issueFacts(run, issue, 'state,labels');
  if (facts?.state !== 'OPEN') return refusal('ISSUE_NOT_OPEN', `#${issue} is not an open issue`);
  const block = { issue, class: 'human', reason, question: text(question), at: new Date(now).toISOString() };
  const body = [
    blockMarker(block),
    `**autoloop: blocked — needs a human authorization** (\`${reason}\`)`,
    '',
    block.question,
    ...(note ? ['', note] : []),
    '',
    'Reply `/answer <your decision>` on this issue. The loop resumes it first at its next start; nothing else needs changing.',
  ].join('\n');
  const comment = run('gh', ['issue', 'comment', String(issue), '--body', body]);
  if (!comment.ok) return refusal('GH_FAILED', `comment on #${issue} failed: ${comment.stderr}`);
  const stale = (facts.labels ?? []).map((label) => label?.name ?? label)
    .filter((name) => name === 'loop-started' || name === 'loop-delivered' || name.startsWith('loop:'));
  const edit = ['issue', 'edit', String(issue), '--add-label', `loop-blocked,${gate}`,
    ...(stale.length > 0 ? ['--remove-label', stale.join(',')] : [])];
  const labelled = run('gh', edit);
  if (!labelled.ok) return refusal('GH_FAILED', `labels on #${issue} failed: ${labelled.stderr}`);
  return { ok: true, issue, disposition: 'blocked', block };
}

export function repairMarker(repair) {
  return `<!-- autoloop-repair-v1 ${JSON.stringify(repair)} -->`;
}

/** Pure: the one well-formed repair marker in an issue body, or null. Two
 *  markers are ambiguous provenance, and depth is always one. */
export function parseRepair(body) {
  const matches = [...String(body ?? '').matchAll(REPAIR_MARKER_RE)];
  if (matches.length !== 1) return null;
  try {
    const parsed = JSON.parse(matches[0][1]);
    return positive(parsed?.parent) && text(parsed.parentLabeledBy)
      && Number.isFinite(Date.parse(parsed.parentLabeledAt)) && parsed.depth === 1
      ? parsed
      : null;
  } catch {
    return null;
  }
}

// `gh api --paginate --jq` prints one result per page; the last page's answer is the newest.
function lastLine(stdout) {
  return String(stdout).split('\n').filter(Boolean).at(-1) ?? '';
}

function writePermission(run, login) {
  const answer = run('gh', ['api', `repos/{owner}/{repo}/collaborators/${encodeURIComponent(login)}/permission`, '--jq', '.permission']);
  return answer.ok && WRITE_PERMISSIONS.includes(answer.stdout);
}

export function markRepair({ parent, title, body, blocksParent = false, run }) {
  if (!positive(parent)) return refusal('INVALID_ARGS', '--parent: expected a positive issue number');
  if (!text(title) || !text(body)) return refusal('INVALID_ARGS', 'expected a non-empty --title and --body-file');
  const facts = issueFacts(run, parent, 'state,labels,body');
  const labels = (facts?.labels ?? []).map((label) => label?.name ?? label);
  if (parseRepair(facts?.body) !== null || labels.includes('loop-repair')) {
    return refusal('REPAIR_DEPTH_EXCEEDED', `#${parent} is itself a repair; file its follow-up as an ordinary issue`);
  }
  if (facts?.state !== 'OPEN' || !labels.includes('loop-ready')) {
    return refusal('REPAIR_PARENT_UNTRUSTED', `#${parent} is not an open loop-ready issue`);
  }
  if (labels.includes('loop-blocked')) {
    return refusal('REPAIR_PARENT_BLOCKED', `#${parent} is blocked for a human; its repairs wait for the answer`);
  }
  const events = run('gh', ['api', `repos/{owner}/{repo}/issues/${parent}/events?per_page=100`, '--paginate', '--jq', LAST_READY_LABEL_JQ]);
  let labeled = null;
  try { labeled = events.ok ? JSON.parse(lastLine(events.stdout)) : null; } catch { labeled = null; }
  if (!text(labeled?.by) || !Number.isFinite(Date.parse(labeled?.at)) || !writePermission(run, labeled.by)) {
    return refusal('REPAIR_PARENT_UNTRUSTED', `#${parent}'s loop-ready was not applied by a trusted actor`);
  }
  const open = run('gh', ['issue', 'list', '--label', 'loop-repair', '--state', 'open', '--limit', '100', '--json', 'number,body']);
  let siblings;
  try { siblings = open.ok ? JSON.parse(open.stdout) : null; } catch { siblings = null; }
  if (siblings === null) return refusal('GH_FAILED', `listing open repairs failed: ${open.stderr}`);
  if (siblings.filter((issue) => parseRepair(issue.body)?.parent === parent).length >= REPAIRS_PER_PARENT) {
    return refusal('REPAIR_BUDGET_EXHAUSTED', `#${parent} already has ${REPAIRS_PER_PARENT} open repairs; fold this into one of them`);
  }
  const repair = { parent, parentLabeledBy: labeled.by, parentLabeledAt: labeled.at, depth: 1, blocksParent };
  const created = withLabel(run, 'loop-repair', () => run('gh', [
    'issue', 'create', '--title', text(title), '--body', `${text(body)}\n\nRepair for #${parent}.\n\n${repairMarker(repair)}`, '--label', 'loop-repair',
  ]));
  const issue = created.ok ? positive(/\/issues\/([1-9][0-9]*)/u.exec(created.stdout)?.[1]) : null;
  if (issue === null) return refusal('GH_FAILED', `issue create failed: ${created.stderr || created.stdout}`);
  if (blocksParent) {
    const condition = { on: 'issue', number: issue };
    const comment = run('gh', ['issue', 'comment', String(parent), '--body',
      `${waitMarker(condition)}\n**autoloop: waiting** — this unit waits on its repair #${issue}; the label is lifted when it closes.`]);
    const label = comment.ok ? addLabel(run, parent, 'loop-waiting') : comment;
    if (!label.ok) return { ok: false, code: 'GH_FAILED', message: `#${issue} filed, but the parent's wait failed: ${label.stderr}`, issue };
  }
  return { ok: true, issue, parent, disposition: 'repair', repair, blocksParent };
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
  const prStates = {};
  for (const issue of issues) {
    const condition = waitCondition((issue.comments ?? []).map((comment) => comment.body));
    if (condition === null) {
      waiting.push({ number: issue.number, reason: 'no parseable waiting marker' });
      continue;
    }
    if (condition.on === 'issue' && !(condition.number in issueStates)) {
      issueStates[condition.number] = issueState(run, condition.number);
    }
    if (condition.on === 'pr' && !(condition.number in prStates)) {
      prStates[condition.number] = prState(run, condition.number);
    }
    const cleared = waitCleared(condition, { issueStates, prStates, baseOid, now });
    if (cleared === null) {
      const holding = { issue: `#${condition.number} is open`, base: 'the base has not moved', time: `until ${condition.until}`, pr: `PR #${condition.number} is open` };
      waiting.push({ number: issue.number, reason: holding[condition.on] });
      continue;
    }
    const removed = run('gh', ['issue', 'edit', String(issue.number), '--remove-label', 'loop-waiting']);
    // A lifted PR wait is resumed: the unit re-plans once on the merged base
    // before it claims, and prime points the host at it first.
    if (removed.ok) lifted.push({ number: issue.number, reason: cleared, ...(condition.on === 'pr' ? { resumed: true } : {}) });
    else errors.push(`#${issue.number}: ${removed.stderr}`);
  }
  return { lifted, waiting, errors };
}

/** The overlap check for one unit: the boundary against the delivered set of
 *  a verified, complete snapshot. The unit's own PR (a re-plan) never overlaps
 *  itself. Refuses, rather than claims, when the delivered set is unknown. */
export function overlapCheck({ issue, boundaryFile, snapshotPath }) {
  if (!positive(issue)) return refusal('INVALID_ARGS', '--issue: expected a positive issue number');
  let boundary;
  let snapshot;
  try {
    boundary = boundaryOf(JSON.parse(readFileSync(boundaryFile ?? '', 'utf8')));
  } catch (error) {
    return refusal('INVALID_ARGS', `--boundary-file: ${error.message}`);
  }
  if (boundary === null) return refusal('INVALID_ARGS', '--boundary-file: expected a plan result with a non-empty boundary');
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath ?? '', 'utf8'));
  } catch (error) {
    return refusal('INVALID_ARGS', `--snapshot: ${error.message}`);
  }
  if (!verifySnapshot(snapshot)) return refusal('SNAPSHOT_INVALID', `--snapshot: ${snapshotProblem(snapshot)}`);
  const delivered = deliveredPullRequests(snapshot);
  if (delivered === null) return refusal('SNAPSHOT_INCOMPLETE', 'openPrs or lifecycleMarkers is incomplete or invalidated; re-prime before the claim');
  const overlap = overlapWith(boundary, delivered.filter((entry) => entry.issue !== issue));
  return { ok: true, issue, overlap, delivered: delivered.map((entry) => entry.pr) };
}

/** Pure: the newest `/answer` a trusted actor posted after the block, or null. */
export function answerAfter(block, comments, trusted) {
  let newest = null;
  for (const comment of comments ?? []) {
    const match = ANSWER_RE.exec(String(comment?.body ?? ''));
    const at = Date.parse(comment?.createdAt);
    if (!match || !Number.isFinite(at) || at <= Date.parse(block.at)) continue;
    const by = comment.author?.login;
    if (typeof by !== 'string' || !trusted(by)) continue;
    if (newest === null || at >= Date.parse(newest.at)) {
      newest = { by, text: (match[1] ?? '').trim(), at: comment.createdAt };
    }
  }
  return newest;
}

/** Resume every loop block a trusted human has answered with `/answer`.
 *  Never throws: anything unreadable leaves the unit blocked, the safe side. A
 *  block counts only when its marker was posted within five minutes before the
 *  latest `loop-blocked` label event, so an old marker cannot reopen a block a
 *  human applied later by hand. */
export function triageBlocks({ run, now = Date.now() }) {
  const listed = run('gh', ['issue', 'list', '--label', 'loop-blocked', '--state', 'open', '--limit', '100', '--json', 'number,title,labels,comments']);
  if (!listed.ok) return { resumed: [], waiting: [], held: [], errors: [`list: ${listed.stderr}`] };
  let issues;
  try { issues = JSON.parse(listed.stdout); } catch { return { resumed: [], waiting: [], held: [], errors: ['list: unparseable'] }; }
  const resumed = [];
  const waiting = [];
  const held = [];
  const errors = [];
  const permissions = {};
  const trusted = (login) => {
    if (!(login in permissions)) permissions[login] = writePermission(run, login);
    return permissions[login];
  };
  for (const issue of issues) {
    // Only a marker the loop itself posted, for this issue, counts; its instant
    // is GitHub's createdAt, never the runner's clock written into the marker.
    const marked = (issue.comments ?? [])
      .filter((comment) => comment.viewerDidAuthor === true)
      .map((comment) => ({ block: parseBlock(comment.body), postedAt: comment.createdAt }))
      .findLast(({ block: entry }) => entry !== null && entry.issue === issue.number) ?? null;
    if (marked === null || !Number.isFinite(Date.parse(marked.postedAt))) {
      held.push({ number: issue.number, reason: 'no loop marker' });
      continue;
    }
    const block = { ...marked.block, at: marked.postedAt };
    const events = run('gh', ['api', `repos/{owner}/{repo}/issues/${issue.number}/events?per_page=100`, '--paginate', '--jq', LAST_BLOCKED_LABEL_JQ]);
    const labeledAt = events.ok ? Date.parse(lastLine(events.stdout)) : Number.NaN;
    if (!Number.isFinite(labeledAt)) {
      held.push({ number: issue.number, reason: 'label history unreadable' });
      if (!events.ok) errors.push(`#${issue.number}: ${events.stderr}`);
      continue;
    }
    const gap = labeledAt - Date.parse(block.at);
    if (gap < 0 || gap > BLOCK_LABEL_WINDOW_MS) {
      held.push({ number: issue.number, reason: 'the marker predates the current block' });
      continue;
    }
    const answer = answerAfter(block, issue.comments, trusted);
    if (answer === null) {
      waiting.push({ number: issue.number, question: block.question });
      continue;
    }
    const gates = (issue.labels ?? []).map((label) => label?.name ?? label).filter((name) => BLOCK_GATES.includes(name));
    const lifted = run('gh', ['issue', 'edit', String(issue.number), '--remove-label', ['loop-blocked', ...gates].join(',')]);
    if (!lifted.ok) {
      errors.push(`#${issue.number}: ${lifted.stderr}`);
      continue;
    }
    const record = { issue: issue.number, by: answer.by, answer: answer.text, at: new Date(now).toISOString() };
    const body = [
      `<!-- autoloop-resumed-v1 ${JSON.stringify(record)} -->`,
      `**autoloop: resumed** — @${answer.by} answered \`${block.reason}\`. The loop takes this unit first, with the answer as its premise.`,
    ].join('\n');
    const commented = run('gh', ['issue', 'comment', String(issue.number), '--body', body]);
    if (!commented.ok) errors.push(`#${issue.number}: resumed, but the record failed: ${commented.stderr}`);
    resumed.push({ number: issue.number, by: answer.by, answer: answer.text });
  }
  return { resumed, waiting, held, errors };
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
      const comments = item.comments ?? [];
      const index = comments.findLastIndex((comment) => parseDecision(comment.body) !== null);
      if (index === -1) return null;
      const decision = parseDecision(comments[index].body);
      if (now - Date.parse(decision.at) > DECISION_WINDOW_MS) return null;
      // The digest is informational and unverified here: it names who answered,
      // and the premise applies the trust check before acting on it.
      const answered = comments.slice(index + 1)
        .map((comment) => ({ match: ANSWER_RE.exec(String(comment.body ?? '')), by: comment.author?.login ?? 'unknown' }))
        .findLast(({ match }) => match !== null);
      return {
        number: item.number,
        title: item.title,
        choice: decision.choice,
        at: decision.at,
        answer: answered ? (answered.match[1] ?? '').trim() : null,
        answeredBy: answered?.by ?? null,
      };
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
        ...decided.map((row) => (row.answer === null
          ? `- #${row.number} ${row.title} — decided, reversible: ${row.choice}`
          : `- #${row.number} ${row.title} — decided: ${row.choice}; @${row.answeredBy} answered: ${row.answer}`))]),
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
  const parsed = { mode: null, issue: null, pr: null, commit: null, onIssue: null, onBaseRed: false, minutes: null, onPr: null, paths: [], boundaryFile: null, snapshot: null, post: false, note: '', choice: null, why: null, alternatives: [], reason: null, question: null, gate: 'human:decide', parent: null, title: null, bodyFile: null, blocksParent: false, out: null, error: null };
  const value = (index) => args[index + 1];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (['--obsolete', '--wait', '--block', '--repair', '--decide', '--decisions', '--lift', '--digest', '--overlap', '--self-test'].includes(flag)) {
      if (parsed.mode !== null) return { ...parsed, error: 'expected one mode' };
      parsed.mode = flag.slice(2);
    } else if (flag === '--on-base-red') {
      parsed.onBaseRed = true;
    } else if (flag === '--post') {
      parsed.post = true;
    } else if (flag === '--blocks-parent') {
      parsed.blocksParent = true;
    } else if (['--issue', '--pr', '--on-issue', '--minutes', '--parent', '--on-pr'].includes(flag)) {
      const number = positive(value(index));
      if (number === null) return { ...parsed, error: `${flag}: expected a positive number` };
      parsed[{ '--issue': 'issue', '--pr': 'pr', '--on-issue': 'onIssue', '--minutes': 'minutes', '--parent': 'parent', '--on-pr': 'onPr' }[flag]] = number;
      index += 1;
    } else if (['--commit', '--note', '--choice', '--why', '--reason', '--question', '--gate', '--title', '--body-file', '--out', '--boundary-file', '--snapshot'].includes(flag)) {
      if (value(index) === undefined) return { ...parsed, error: `${flag}: expected a value` };
      parsed[{ '--body-file': 'bodyFile', '--boundary-file': 'boundaryFile' }[flag] ?? flag.slice(2)] = value(index);
      index += 1;
    } else if (flag === '--alternatives' || flag === '--paths') {
      if (value(index) === undefined) return { ...parsed, error: `${flag}: expected a value` };
      parsed[flag.slice(2)] = value(index).split(flag === '--paths' ? ',' : ';').map((entry) => entry.trim()).filter(Boolean);
      index += 1;
    } else {
      return { ...parsed, error: `unknown argument ${flag}` };
    }
  }
  if (parsed.mode === null) return { ...parsed, error: 'expected --obsolete, --wait, --block, --repair, --decide, --decisions, --lift, --digest, --overlap or --self-test' };
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
  // LFE run 2026-09-30: #427 waited on #587 and the parked view still read
  // "07 diff-review r3 returned · 58m". A wait is recorded on the step.
  check('a wait is recorded on the unit\'s open step, and only there',
    (() => {
      const scratch = mkdtempSync(join(tmpdir(), 'unit-wait-'));
      try {
        const steps = join(scratch, 'autoloop', 'steps');
        mkdirSync(steps, { recursive: true });
        writeFileSync(join(steps, '427.json'), JSON.stringify({ issue: 427, steps: [{ step: '07-diff-review', startedAtMs: 1 }] }));
        writeFileSync(join(steps, '9.json'), JSON.stringify({ issue: 9, steps: [{ step: '05-implement', startedAtMs: 1 }], closed: { outcome: 'blocked', atMs: 2 } }));
        const noted = noteWaitOnStep({ commonDir: scratch, issue: 427, what: '#587', nowMs: 5000 });
        const closed = noteWaitOnStep({ commonDir: scratch, issue: 9, what: '#1', nowMs: 5000 });
        const missing = noteWaitOnStep({ commonDir: scratch, issue: 10, what: '#1', nowMs: 5000 });
        const last = JSON.parse(readFileSync(join(steps, '427.json'), 'utf8')).steps.at(-1);
        return noted === true && closed === false && missing === false
          && JSON.stringify(last.waiting) === JSON.stringify({ on: '#587', atMs: 5000 });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    })());
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
    // Two GitHub calls, no reads; the one local git call finds the step record.
    timedWait.ok && timedWait.condition.until === until && timed.calls.filter((call) => call.startsWith('gh ')).length === 2
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

  // Flow 2026-10: on one project nine open loop PRs formed two conflict groups
  // because units on the same files were planned while an earlier one was
  // delivered and unmerged. A boundary that overlaps a delivered PR waits.
  const delivered = [
    { pr: 70, issue: 7, phase: 'ready-head', files: ['src/a.mjs', 'docs/x.md'] },
    { pr: 80, issue: 8, phase: 'premerge-record', files: ['src/b/c.mjs', 'src/b/d.mjs'] },
  ];
  check('overlapWith names the first delivered PR whose files intersect the boundary, and the paths',
    JSON.stringify(overlapWith(['src/a.mjs', 'src/b/d.mjs'], delivered)) === '{"pr":70,"paths":["src/a.mjs"]}'
    && JSON.stringify(overlapWith(['src/b/'], delivered)) === '{"pr":80,"paths":["src/b/c.mjs","src/b/d.mjs"]}'
    && overlapWith(['src/b', 'src/a.mjs.bak', 'src/'.slice(0, 3)], delivered) === null
    && overlapWith(['src/z.mjs', 'lib/'], delivered) === null
    && overlapWith([], delivered) === null
    && overlapWith(['src/a.mjs'], []) === null
    && overlapWith(['src/a.mjs'], null) === null);
  const prWaitClosed = fakeRun([['gh pr view 70', 'MERGED']]);
  check('waiting on a PR that is not open is refused',
    markWaiting({ issue: 5, onPr: 70, paths: ['src/a.mjs'], base: 'main', run: prWaitClosed.run }).code === 'NOTHING_TO_WAIT_ON'
    && markWaiting({ issue: 5, onPr: 70, paths: [], base: 'main', run: fakeRun([]).run }).code === 'INVALID_ARGS'
    && markWaiting({ issue: 5, onPr: 70, paths: ['src/a.mjs'], onIssue: 4, base: 'main', run: fakeRun([]).run }).code === 'INVALID_ARGS');
  check('a PR wait is recorded on the step as "PR #M (paths)", which the parked card prints as "waits on PR #M (paths)"',
    (() => {
      const scratch = mkdtempSync(join(tmpdir(), 'unit-pr-wait-'));
      try {
        const steps = join(scratch, 'autoloop', 'steps');
        mkdirSync(steps, { recursive: true });
        writeFileSync(join(steps, '5.json'), JSON.stringify({ issue: 5, steps: [{ step: '03-plan-review', startedAtMs: 1 }] }));
        const prWait = fakeRun([['gh pr view 70', 'OPEN'], ['gh issue comment 5', ''], ['gh issue edit 5 --add-label loop-waiting', ''], ['git rev-parse', scratch]]);
        const waited = markWaiting({ issue: 5, onPr: 70, paths: ['src/a.mjs', 'src/b/'], base: 'main', run: prWait.run, now: 7000 });
        const last = JSON.parse(readFileSync(join(steps, '5.json'), 'utf8')).steps.at(-1);
        const until = new Date(7000 + 720 * 60_000).toISOString();
        return waited.ok === true
          && JSON.stringify(waited.condition) === `{"on":"pr","number":70,"paths":["src/a.mjs","src/b/"],"until":"${until}"}`
          && prWait.calls[1].includes(`autoloop-waiting-v1 {"on":"pr","number":70,"paths":["src/a.mjs","src/b/"],"until":"${until}"}`)
          && prWait.calls[1].includes('waits on PR #70')
          && prWait.calls[1].includes('src/a.mjs, src/b/')
          && JSON.stringify(last.waiting) === JSON.stringify({ on: 'PR #70 (src/a.mjs, src/b/)', atMs: 7000 });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    })());
  // Review of the flow release: `--minutes` is capped at 720 and `--on-pr` was
  // not, so a PR nobody merged held its unit for ever.
  check('a PR wait lifts after 720 minutes with a re-plan reason, and is resumed',
    (() => {
      const capped = { on: 'pr', number: 80, paths: ['src/a.mjs'], until: '2026-01-01T12:00:00.000Z' };
      const marked = waitCondition([waitMarker(capped)]);
      const listed = JSON.stringify([{ number: 9, comments: [{ body: waitMarker(capped) }] }]);
      const lifting = fakeRun([['gh issue list', listed], ['git rev-parse', oid], ['gh pr view 80', 'OPEN'], ['gh issue edit', '']]);
      const lift = liftWaits({ base: 'main', run: lifting.run, now: Date.parse('2026-01-01T12:00:00.000Z') });
      return marked.until === '2026-01-01T12:00:00.000Z'
        && waitCleared(capped, { prStates: { 80: 'OPEN' }, now: Date.parse('2026-01-01T11:59:59.000Z') }) === null
        && waitCleared(capped, { prStates: { 80: 'OPEN' }, now: Date.parse('2026-01-01T12:00:00.000Z') }) === 'PR #80 still open after 720 min; re-plan'
        && waitCleared(capped, { prStates: { 80: 'MERGED' }, now: Date.parse('2026-01-01T12:00:00.000Z') }) === 'PR #80 merged'
        && JSON.stringify(lift.lifted) === JSON.stringify([{ number: 9, reason: 'PR #80 still open after 720 min; re-plan', resumed: true }]);
    })());
  check('a PR wait round-trips and clears when the PR merges or closes, not while it is open',
    JSON.stringify(waitCondition([waitMarker({ on: 'pr', number: 70, paths: ['src/a.mjs'] })])) === '{"on":"pr","number":70,"paths":["src/a.mjs"]}'
    && waitCondition([waitMarker({ on: 'pr', number: 70, paths: 'src/a.mjs' })]) === null
    && waitCleared({ on: 'pr', number: 70, paths: ['src/a.mjs'] }, { prStates: { 70: 'MERGED' } }) === 'PR #70 merged'
    && waitCleared({ on: 'pr', number: 70, paths: ['src/a.mjs'] }, { prStates: { 70: 'CLOSED' } }) === 'PR #70 closed'
    && waitCleared({ on: 'pr', number: 70, paths: ['src/a.mjs'] }, { prStates: { 70: 'OPEN' } }) === null
    && waitCleared({ on: 'pr', number: 70, paths: ['src/a.mjs'] }, { prStates: {} }) === null);
  const prList = JSON.stringify([
    { number: 14, comments: [{ body: waitMarker({ on: 'pr', number: 70, paths: ['src/a.mjs'] }) }] },
    { number: 15, comments: [{ body: waitMarker({ on: 'pr', number: 80, paths: ['src/b/'] }) }] },
    { number: 16, comments: [{ body: waitMarker({ on: 'issue', number: 4 }) }] },
  ]);
  const prLifting = fakeRun([
    ['gh issue list', prList], ['git rev-parse', oid],
    ['gh pr view 70', 'MERGED'], ['gh pr view 80', 'OPEN'], ['gh issue view 4', 'CLOSED'], ['gh issue edit', ''],
  ]);
  const prLift = liftWaits({ base: 'main', run: prLifting.run });
  check('prime lifts a PR wait on merge, marks it resumed for a re-plan, and holds it while the PR is open',
    JSON.stringify(prLift.lifted) === JSON.stringify([
      { number: 14, reason: 'PR #70 merged', resumed: true },
      { number: 16, reason: '#4 is closed' },
    ])
    && JSON.stringify(prLift.waiting) === JSON.stringify([{ number: 15, reason: 'PR #80 is open' }])
    && prLift.errors.length === 0
    && prLifting.calls.filter((call) => call.startsWith('gh pr view')).length === 2);
  check('the overlap check reads the boundary from a plan result file or a bare list',
    JSON.stringify(boundaryOf({ ok: true, plan: { boundary: ['a'] } })) === '["a"]'
    && JSON.stringify(boundaryOf({ boundary: ['b'] })) === '["b"]'
    && JSON.stringify(boundaryOf(['c'])) === '["c"]'
    && boundaryOf({ plan: {} }) === null
    && boundaryOf(['', 1]) === null);
  const markerBody = (issue, pr) => '<!-- autoloop-lifecycle-v1\n' + JSON.stringify({
    branch: `feat/gh-${issue}-unit`, headOid: oid, intentSource: 'invocation', issue, issueBodyHash: 'b'.repeat(64),
    mergePolicy: 'manual', phase: 'ready-head', planHash: 'c'.repeat(64), plannedBaseOid: oid, pr,
    runIntentHash: 'd'.repeat(64), selector: 'native', v: 1,
  }) + '\n-->';
  const prItem = (issue, number, files) => ({
    number, title: 'unit', body: `Closes #${issue}`, isDraft: false, reviewDecision: null,
    headRefName: `feat/gh-${issue}-unit`, headRefOid: oid, baseRefName: 'main', mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE', mergedAt: null, updatedAt: '2026-01-01T00:00:00Z', author: 'autoloop',
    headRepository: 'owner/repo', statusCheckState: null, statusCheckRollup: [], files, issue,
    orphanCandidate: false, ownership: 'loop',
  });
  const markerItem = (issue, pr) => ({
    issueNumber: issue, id: `IC_${issue}`, tipId: `IC_${issue}`, sequence: 0, author: 'autoloop', authorAssociation: 'MEMBER',
    body: markerBody(issue, pr), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', url: null,
  });
  // A verified snapshot whose delivered set is the given [issue, pr, files] rows.
  const snapshotWith = (prs) => {
    const sections = Object.fromEntries(SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]));
    sections.repo = completeSection([{ owner: 'owner', name: 'repo', nameWithOwner: 'owner/repo', defaultBranch: 'main' }]);
    sections.tree = completeSection([{ dirtyEntries: [], dirtyPaths: 0, branch: 'main', headOid: oid }]);
    sections.openPrs = completeSection(prs.map(([issue, pr, files]) => prItem(issue, pr, files)));
    sections.lifecycleMarkers = completeSection(prs.map(([issue, pr]) => markerItem(issue, pr)));
    return createSnapshot({ scannedAt: '2026-01-01T00:00:01.000Z', sections });
  };
  check('--overlap reads a plan result and a retained snapshot, skips the unit\'s own PR, and refuses an invalidated snapshot',
    (() => {
      const scratch = mkdtempSync(join(tmpdir(), 'unit-overlap-'));
      try {
        const snapshot = snapshotWith([[7, 70, ['src/a.mjs']], [8, 80, ['src/b/c.mjs']]]);
        const snapshotPath = join(scratch, 'snapshot.json');
        const stalePath = join(scratch, 'stale.json');
        const planPath = join(scratch, 'plan.json');
        writeFileSync(snapshotPath, JSON.stringify(snapshot));
        writeFileSync(stalePath, JSON.stringify(invalidateSnapshot(snapshot, 'PR_MUTATION')));
        writeFileSync(planPath, JSON.stringify({ ok: true, role: 'plan', plan: { title: 't', prBody: 'Closes #9', body: 'b', boundary: ['src/b/'] } }));
        const hit = overlapCheck({ issue: 9, boundaryFile: planPath, snapshotPath });
        const own = overlapCheck({ issue: 8, boundaryFile: planPath, snapshotPath });
        const stale = overlapCheck({ issue: 9, boundaryFile: planPath, snapshotPath: stalePath });
        const missing = overlapCheck({ issue: 9, boundaryFile: join(scratch, 'none.json'), snapshotPath });
        return snapshot.sections.openPrs.complete === true && snapshot.sections.lifecycleMarkers.complete === true
          && hit.ok === true && JSON.stringify(hit.overlap) === '{"pr":80,"paths":["src/b/c.mjs"]}'
          && JSON.stringify(hit.delivered) === '[70,80]'
          && own.ok === true && own.overlap === null
          && stale.code === 'SNAPSHOT_INCOMPLETE'
          && missing.code === 'INVALID_ARGS';
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    })());

  // The lane is exact or a `/` prefix: `src/x` never covers `src/xy/a.mjs`.
  check('a lane entry without a trailing slash matches its exact path only',
    !inLane('src/xy/a.mjs', ['src/x']) && inLane('src/x', ['src/x']) && inLane('src/x/a.mjs', ['src/x/']));
  // SPEC-overlap-wait end to end with one fake run: the hit waits, the merge
  // lifts it as resumed, and the re-check on the new delivered set claims.
  check('an overlap hit waits on the PR, the merge lifts it resumed, the re-check against the new snapshot is clear, and an older snapshot names its version',
    (() => {
      const scratch = mkdtempSync(join(tmpdir(), 'unit-overlap-chain-'));
      try {
        const before = join(scratch, 'before.json');
        const after = join(scratch, 'after.json');
        const planPath = join(scratch, 'plan.json');
        writeFileSync(before, JSON.stringify(snapshotWith([[8, 80, ['src/b/c.mjs']]])));
        writeFileSync(after, JSON.stringify(snapshotWith([])));
        writeFileSync(planPath, JSON.stringify({ ok: true, plan: { boundary: ['src/b/'] } }));
        const steps = join(scratch, 'autoloop', 'steps');
        mkdirSync(steps, { recursive: true });
        writeFileSync(join(steps, '9.json'), JSON.stringify({ issue: 9, steps: [{ step: '03-plan-review', startedAtMs: 1 }] }));
        const calls = [];
        let listed = '[]';
        let prState80 = 'OPEN';
        const run = (command, args) => {
          const line = [command, ...args].join(' ');
          calls.push(line);
          if (line.startsWith('gh pr view 80')) return { ok: true, stdout: prState80, stderr: '' };
          if (line.startsWith('gh issue list')) return { ok: true, stdout: listed, stderr: '' };
          if (command === 'git') return { ok: true, stdout: args.includes('--git-common-dir') ? scratch : oid, stderr: '' };
          return { ok: true, stdout: '', stderr: '' };
        };
        const hit = overlapCheck({ issue: 9, boundaryFile: planPath, snapshotPath: before });
        const waited = hit.ok === true && hit.overlap !== null
          ? markWaiting({ issue: 9, onPr: hit.overlap.pr, paths: hit.overlap.paths, base: 'main', run, now: 7000 })
          : { ok: false };
        const comment = calls.find((call) => call.startsWith('gh issue comment 9 --body ')) ?? '';
        listed = JSON.stringify([{ number: 9, comments: [{ body: comment.slice('gh issue comment 9 --body '.length) }] }]);
        prState80 = 'MERGED';
        const lift = liftWaits({ base: 'main', run, now: 8000 });
        const clear = overlapCheck({ issue: 9, boundaryFile: planPath, snapshotPath: after });
        // A retained snapshot from 0.68 (version 2) is refused by its version.
        const older = join(scratch, 'older.json');
        writeFileSync(older, JSON.stringify({ ...snapshotWith([]), version: 2 }));
        const refused = overlapCheck({ issue: 9, boundaryFile: planPath, snapshotPath: older });
        return refused.code === 'SNAPSHOT_INVALID' && refused.message === '--snapshot: snapshot version 2, expected 3; re-prime'
          && JSON.stringify(hit.overlap) === '{"pr":80,"paths":["src/b/c.mjs"]}'
          && waited.ok === true && waited.condition.number === 80
          && JSON.stringify(lift.lifted) === JSON.stringify([{ number: 9, reason: 'PR #80 merged', resumed: true }])
          && calls.includes('gh issue edit 9 --remove-label loop-waiting')
          && clear.ok === true && clear.overlap === null;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    })());
  check('the PR body sections list open findings with predicate and raisings, and Minors, and are empty without entries',
    openFindingsSection([
      { id: 'gate-null', severity: 'Major', predicate: 'rule:gate', raisings: 5, summary: 'The gate passes null', evidence: 'src/gate.mjs:9' },
      { id: 'late-1', severity: 'Major', predicate: 'late-1', raisings: 1, summary: 'Off by one', evidence: 'src/x.mjs:3' },
    ]) === '## Open findings\n\n- gate-null (Major, rule:gate, raised in 5 rounds): The gate passes null — src/gate.mjs:9\n'
      + '- late-1 (Major, late-1, raised in 1 round): Off by one — src/x.mjs:3'
    && openFindingsSection([]) === '' && openFindingsSection(undefined) === ''
    && minorFindingsSection([
      { id: 'minor-1', severity: 'Minor', summary: 'A nit', evidence: 'src/a.mjs:7' },
      { id: 'major-1', severity: 'Major', summary: 'Not a minor', evidence: 'src/a.mjs:8' },
    ]) === '## Minor findings\n\n- minor-1: A nit — src/a.mjs:7'
    && minorFindingsSection([]) === '' && minorFindingsSection(null) === '');

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
  const decision = { issue: 5, question: 'Which bits does the constant need?', choice: 'derive the bits from the locked construction', alternatives: ['whitelist the constant', 'block'], why: 'e_hypot.c:80-81 builds it', at: decidedAt };
  const { question: _question, ...legacyDecision } = decision;
  check('a decision marker round-trips question, choice, alternatives and evidence; the newest wins, junk is skipped',
    JSON.stringify(parseDecision(decisionMarker(decision))) === JSON.stringify(decision)
    && parseDecision(`${decisionMarker(decision)}\n${decisionMarker({ ...decision, choice: 'later' })}`).choice === 'later'
    && parseDecision('<!-- autoloop-decision-v1 {nope} -->') === null
    && parseDecision(decisionMarker({ ...decision, why: '' })) === null
    && parseDecision(decisionMarker({ ...decision, question: 7 })) === null
    && parseDecision('plain') === null);
  check('a decision marker without a question (before 0.69.0) still parses',
    JSON.stringify(parseDecision(decisionMarker(legacyDecision))) === JSON.stringify(legacyDecision));
  const undecided = fakeRun([]);
  check('a decision without a question, a choice or a why is refused before any call',
    markDecided({ issue: 5, question: 'q?', choice: '', why: 'w', run: undecided.run }).code === 'INVALID_ARGS'
    && markDecided({ issue: 5, question: 'q?', choice: 'c', why: '  ', run: undecided.run }).code === 'INVALID_ARGS'
    && markDecided({ issue: 5, choice: 'c', why: 'w', run: undecided.run }).code === 'INVALID_ARGS'
    && markDecided({ issue: 5, question: 'two\nlines', choice: 'c', why: 'w', run: undecided.run }).code === 'INVALID_ARGS'
    && undecided.calls.length === 0);
  const decidedClosed = fakeRun([['gh issue view 5', 'CLOSED']]);
  check('a decision on an issue that is not open is refused',
    markDecided({ issue: 5, question: 'q?', choice: 'c', why: 'w', run: decidedClosed.run }).code === 'ISSUE_NOT_OPEN');
  const decisionUrl = 'https://github.com/o/r/issues/5#issuecomment-77';
  const deciding = fakeRun([['gh issue view 5', 'OPEN'], ['gh issue comment 5', decisionUrl], ['gh issue edit 5 --add-label loop-decided', '']]);
  const decided = markDecided({ issue: 5, question: decision.question, choice: decision.choice, alternatives: decision.alternatives, why: decision.why, run: deciding.run, now: Date.parse(decidedAt) });
  check('a decision comments the marker with the question, the reversal form and its link, labels, and never edits the body',
    decided.ok && decided.disposition === 'decided'
    && JSON.stringify(parseDecision(deciding.calls[1])) === JSON.stringify(decision)
    && deciding.calls[1].includes(`Question: ${decision.question}`)
    && deciding.calls[1].includes('/answer')
    && deciding.calls[2] === 'gh issue edit 5 --add-label loop-decided'
    && decided.url === decisionUrl
    && !deciding.calls.some((call) => call.includes('--body-file') || call.includes('loop-ready')));
  check('a decision is counted on the unit\'s open step record, and only there',
    (() => {
      const scratch = mkdtempSync(join(tmpdir(), 'unit-decide-'));
      try {
        const steps = join(scratch, 'autoloop', 'steps');
        mkdirSync(steps, { recursive: true });
        writeFileSync(join(steps, '5.json'), JSON.stringify({ issue: 5, steps: [{ step: '01-premise', startedAtMs: 1 }] }));
        writeFileSync(join(steps, '9.json'), JSON.stringify({ issue: 9, steps: [{ step: '05-implement', startedAtMs: 1 }], closed: { outcome: 'blocked', atMs: 2 } }));
        const first = noteDecisionOnStep({ commonDir: scratch, issue: 5 });
        const second = noteDecisionOnStep({ commonDir: scratch, issue: 5 });
        const closed = noteDecisionOnStep({ commonDir: scratch, issue: 9 });
        const missing = noteDecisionOnStep({ commonDir: scratch, issue: 10 });
        return first === true && second === true && closed === false && missing === false
          && JSON.parse(readFileSync(join(steps, '5.json'), 'utf8')).decisions === 2
          && JSON.parse(readFileSync(join(steps, '9.json'), 'utf8')).decisions === undefined;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    })());
  const laterAt = '2026-09-25T11:00:00.000Z';
  const unitComments = [
    { viewerDidAuthor: true, url: decisionUrl, createdAt: decidedAt, body: `${decisionMarker(decision)}\n**autoloop: decided**` },
    { viewerDidAuthor: true, url: 'https://github.com/o/r/issues/5#issuecomment-78', createdAt: laterAt,
      body: decisionMarker({ ...decision, question: 'Which label length applies?', choice: '64 characters', alternatives: [], why: 'the form field is 64 wide', at: laterAt }) },
    { viewerDidAuthor: false, url: 'https://github.com/o/r/issues/5#issuecomment-79', createdAt: laterAt, body: decisionMarker({ ...decision, choice: 'forged' }) },
    { author: { login: 'owner' }, url: 'https://github.com/o/r/issues/5#issuecomment-80', createdAt: '2026-09-25T12:00:00.000Z', body: '/answer 128 characters' },
  ];
  const listed = unitDecisions(unitComments);
  const section = decisionsSection(listed);
  check('a unit\'s decisions are its loop-authored markers in order, each with its comment link and any later /answer',
    listed.length === 2
    && listed[0].url === decisionUrl && listed[0].question === decision.question && listed[0].answer === null
    && listed[1].choice === '64 characters' && listed[1].answer.by === 'owner' && listed[1].answer.text === '128 characters');
  check('the PR body section lists every decision under ## Decisions with its link, and is empty without decisions',
    section.startsWith('## Decisions\n')
    && section.includes(`- Which bits does the constant need? → derive the bits from the locked construction ([decision](${decisionUrl}))`)
    && section.includes('alternatives: whitelist the constant; block')
    && section.includes('evidence: e_hypot.c:80-81 builds it')
    && section.includes('- Which label length applies? → 64 characters ([decision](https://github.com/o/r/issues/5#issuecomment-78))')
    && section.includes('reversed by @owner: 128 characters')
    && !section.includes('forged')
    && decisionsSection([]) === '');
  // SPEC-elastic-scope: the PR body lists each widening with its finding id.
  check('the PR body section lists every widening under ## Scope changes with its finding id, and is empty without widenings',
    scopeChangesSection([
      { findingId: 'implement:extra-1', paths: ['lib/shared.mjs'], rationale: 'task 2 cannot pass its test without the helper' },
      { findingId: 'guard-null', paths: ['lib/guard.mjs', 'lib/guard.test.mjs'], rationale: 'the guard lives in lib' },
    ]) === '## Scope changes\n\n- implement:extra-1: lib/shared.mjs — task 2 cannot pass its test without the helper\n- guard-null: lib/guard.mjs, lib/guard.test.mjs — the guard lives in lib'
    && scopeChangesSection([]) === ''
    && scopeChangesSection(undefined) === '');
  const retiredBlockAt = '2026-09-20T10:00:00.000Z';
  const liftedByAnswer = unitDecisions([
    { viewerDidAuthor: true, url: 'https://github.com/o/r/issues/5#issuecomment-60', createdAt: retiredBlockAt,
      body: blockMarker({ issue: 5, class: 'human', reason: 'TRUST_REQUIRED', question: 'Which spec wins?', at: retiredBlockAt }) },
    { author: { login: 'owner' }, url: 'https://github.com/o/r/issues/5#issuecomment-61', createdAt: '2026-09-20T11:00:00.000Z', body: '/answer the issue text' },
    { viewerDidAuthor: true, url: 'https://github.com/o/r/issues/5#issuecomment-62', createdAt: '2026-09-20T12:00:00.000Z',
      body: `<!-- autoloop-resumed-v1 ${JSON.stringify({ issue: 5, by: 'owner', answer: 'the issue text', at: '2026-09-20T12:00:00.000Z' })} -->` },
  ]);
  check('a resumed block whose reason is now retired is listed as decided by the /answer that lifted it',
    liftedByAnswer.length === 1 && liftedByAnswer[0].question === 'Which spec wins?'
    && liftedByAnswer[0].choice === 'the issue text' && liftedByAnswer[0].url === 'https://github.com/o/r/issues/5#issuecomment-61'
    && decisionsSection(liftedByAnswer).includes('- Which spec wins? → the issue text ([answer](https://github.com/o/r/issues/5#issuecomment-61) by @owner)'));
  const decidedIssues = [
    { number: 40, title: 'Recent', comments: [{ body: decisionMarker({ ...decision, issue: 40 }) }] },
    { number: 41, title: 'Stale', comments: [{ body: decisionMarker({ ...decision, issue: 41, at: '2026-09-01T00:00:00.000Z' }) }] },
    { number: 42, title: 'Unmarked', comments: [{ body: 'no marker' }] },
  ];
  const decidedRows = decisionRows(decidedIssues, Date.parse('2026-09-26T00:00:00Z'));
  const answeredRows = decisionRows([{ number: 43, title: 'Reversed', comments: [
    { body: decisionMarker({ ...decision, issue: 43 }), createdAt: decidedAt },
    { author: { login: 'owner' }, body: '/answer use the whitelist instead', createdAt: '2026-09-25T11:00:00.000Z' },
  ] }], Date.parse('2026-09-26T00:00:00Z'));
  check('a decision answered afterwards shows the answer, not as still reversible',
    answeredRows[0].answer === 'use the whitelist instead'
    && digestBody([], 'T', answeredRows).includes('- #43 Reversed — decided: derive the bits from the locked construction; @owner answered: use the whitelist instead')
    && decidedRows[0].answer === null);
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

  const block = { issue: 7, class: 'human', reason: 'POLICY_DENIED', question: 'May the unit install the new dependency?', at: decidedAt };
  check('a block marker round-trips, the newest wins, junk is skipped',
    JSON.stringify(parseBlock(blockMarker(block))) === JSON.stringify(block)
    && parseBlock(`${blockMarker(block)}\n${blockMarker({ ...block, question: 'later?' })}`).question === 'later?'
    && parseBlock(blockMarker({ ...block, class: 'fix' })) === null
    && parseBlock(blockMarker({ ...block, reason: 'lower case' })) === null
    && parseBlock('<!-- autoloop-block-v1 {nope} -->') === null);
  for (const reason of ['X', 'LIFECYCLE_MARKER_INVALID', 'ARTIFACT_IDENTITY_MISMATCH', 'REVISION_REQUIRED', 'REVISE_CAP_REACHED']) {
    const nonHuman = fakeRun([
      ['gh issue view 7', '{"state":"OPEN","labels":[]}'],
      ['gh issue comment 7', ''], ['gh issue edit 7', ''],
    ]);
    const result = markBlocked({ issue: 7, reason, question: 'How should this tool fault be repaired?', run: nonHuman.run });
    check(`${reason} cannot create a human block or make a GitHub call`,
      result.code === 'NON_HUMAN_BLOCK_REASON' && nonHuman.calls.length === 0
      && result.message.includes('POLICY_DENIED') && result.message.includes('fix or decide'));
  }
  // Flow release: 33 premise blocks on one project waited for a human on
  // specification gaps the loop can decide. The two reasons that carried them
  // are retired; the remedy names --decide.
  for (const reason of ['TRUST_REQUIRED', 'UNSPECIFIED_VALUE']) {
    const retired = fakeRun([
      ['gh issue view 7', '{"state":"OPEN","labels":[]}'],
      ['gh issue comment 7', ''], ['gh issue edit 7', ''],
    ]);
    const result = markBlocked({ issue: 7, reason, question: 'Which specification wins?', run: retired.run });
    check(`${reason} is refused as retired, names --decide, and makes no GitHub call`,
      result.code === 'BLOCK_REASON_RETIRED' && retired.calls.length === 0
      && result.message.includes('--decide') && result.message.includes(reason)
      && result.message.includes('POLICY_DENIED'));
  }
  for (const reason of ['IRREVERSIBLE_ACTION', 'POLICY_DENIED']) {
    const human = fakeRun([
      ['gh issue view 7', '{"state":"OPEN","labels":[]}'],
      ['gh issue comment 7', ''], ['gh issue edit 7', ''],
    ]);
    const note = 'Permission denied: protected path.\nKeep this exact evidence.';
    const result = markBlocked({ issue: 7, reason, question: 'May the requested action proceed?', note, run: human.run });
    check(`${reason} creates a human block and preserves its evidence`,
      result.ok && result.block.reason === reason
      && human.calls.some((call) => call.startsWith('gh issue comment 7') && call.includes(note))
      && human.calls.at(-1) === 'gh issue edit 7 --add-label loop-blocked,human:decide');
  }
  const legacyBlock = { ...block, reason: 'LIFECYCLE_MARKER_INVALID' };
  const legacyRows = digestRows([{ number: 7, title: 'Legacy block', labels: [],
    comments: [{ body: blockMarker(legacyBlock) }],
  }], []);
  check('legacy human reasons remain readable and visible in the digest',
    parseBlock(blockMarker(legacyBlock))?.reason === legacyBlock.reason
    && legacyRows[0].question === legacyBlock.question);
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
  const revising = fakeRun([
    ['gh issue view 9', '{"state":"OPEN","labels":[{"name":"loop-ready"},{"name":"loop-delivered"},{"name":"loop:revising"}]}'],
    ['gh issue comment 9', ''], ['gh issue edit 9', ''],
  ]);
  check('a block of a unit under revision drops loop-delivered and the revising label too',
    markBlocked({ issue: 9, reason: 'POLICY_DENIED', question: 'May the denied action proceed?', run: revising.run }).ok
    && revising.calls.at(-1) === 'gh issue edit 9 --add-label loop-blocked,human:decide --remove-label loop-delivered,loop:revising');
  const authorizing = fakeRun([['gh issue view 8', '{"state":"OPEN","labels":[]}'], ['gh issue comment 8', ''], ['gh issue edit 8', '']]);
  check('a protected-path block carries human:authorize and removes nothing it did not find',
    markBlocked({ issue: 8, reason: 'POLICY_DENIED', question: 'May this unit touch .github/workflows?', gate: 'human:authorize', run: authorizing.run }).ok
    && authorizing.calls.at(-1) === 'gh issue edit 8 --add-label loop-blocked,human:authorize');
  const blockClosed = fakeRun([['gh issue view 7', '{"state":"CLOSED","labels":[]}']]);
  check('a block on an issue that is not open is refused',
    markBlocked({ issue: 7, reason: 'POLICY_DENIED', question: 'q?', run: blockClosed.run }).code === 'ISSUE_NOT_OPEN');
  const markedRows = digestRows([{
    number: 7, title: 'Labels', labels: [{ name: 'human:decide' }],
    comments: [{ body: `${blockMarker(block)}\n**autoloop: blocked**` }, { body: 'a later note' }],
  }], []);
  check('the digest reads a marked block\'s own question first',
    markedRows[0].question === block.question);

  const blockAt = '2026-09-25T10:00:00.000Z';
  const later = (minutes) => new Date(Date.parse(blockAt) + minutes * 60_000).toISOString();
  const marked = { issue: 7, class: 'human', reason: 'LIFECYCLE_MARKER_INVALID', question: 'What length?', at: blockAt };
  const trustedOnly = (login) => login === 'owner';
  check('an answer is a trusted /answer comment after the block, the newest winning',
    answerAfter(marked, [
      { author: { login: 'owner' }, body: '/answer 64', createdAt: later(1) },
      { author: { login: 'owner' }, body: '/answer 128 chars\nand "Unnamed device"', createdAt: later(2) },
    ], trustedOnly).text === '128 chars\nand "Unnamed device"'
    && answerAfter(marked, [{ author: { login: 'owner' }, body: '/answer 64', createdAt: later(-1) }], trustedOnly) === null
    && answerAfter(marked, [{ author: { login: 'stranger' }, body: '/answer 64', createdAt: later(1) }], trustedOnly) === null
    && answerAfter(marked, [{ author: { login: 'owner' }, body: 'I think 64 /answer', createdAt: later(1) }], trustedOnly) === null
    && answerAfter(marked, [{ author: { login: 'owner' }, body: '/answers are hard', createdAt: later(1) }], trustedOnly) === null);

  const blockedList = JSON.stringify([
    { number: 7, title: 'Answered', labels: [{ name: 'loop-ready' }, { name: 'loop-blocked' }, { name: 'human:decide' }],
      comments: [{ author: { login: 'owner' }, viewerDidAuthor: true, body: blockMarker(marked), createdAt: blockAt },
        { author: { login: 'owner' }, body: '/answer 128', createdAt: later(30) }] },
    { number: 8, title: 'Unanswered', labels: [{ name: 'loop-blocked' }],
      comments: [{ author: { login: 'owner' }, viewerDidAuthor: true, body: blockMarker({ ...marked, issue: 8 }), createdAt: blockAt },
        { author: { login: 'owner' }, body: 'looking at it', createdAt: later(30) }] },
    { number: 9, title: 'Hand-blocked', labels: [{ name: 'loop-blocked' }],
      comments: [{ author: { login: 'owner' }, body: 'blocked by hand', createdAt: blockAt }] },
    { number: 10, title: 'Stale marker', labels: [{ name: 'loop-blocked' }],
      comments: [{ author: { login: 'owner' }, viewerDidAuthor: true, body: blockMarker({ ...marked, issue: 10 }), createdAt: blockAt },
        { author: { login: 'owner' }, body: '/answer go', createdAt: later(30) }] },
    { number: 11, title: 'Stranger', labels: [{ name: 'loop-blocked' }],
      comments: [{ author: { login: 'owner' }, viewerDidAuthor: true, body: blockMarker({ ...marked, issue: 11 }), createdAt: blockAt },
        { author: { login: 'stranger' }, body: '/answer go', createdAt: later(30) }] },
    { number: 12, title: 'Forged', labels: [{ name: 'loop-blocked' }],
      comments: [{ author: { login: 'outsider' }, viewerDidAuthor: false, body: blockMarker({ ...marked, issue: 12 }), createdAt: blockAt },
        { author: { login: 'owner' }, body: '/answer go', createdAt: later(30) }] },
    { number: 13, title: 'Skewed clock', labels: [{ name: 'loop-blocked' }, { name: 'human:decide' }],
      comments: [{ author: { login: 'owner' }, viewerDidAuthor: true, body: blockMarker({ ...marked, issue: 13, at: later(0.2) }), createdAt: blockAt },
        { author: { login: 'owner' }, body: '/answer 64', createdAt: later(30) }] },
    { number: 14, title: 'Quoted marker', labels: [{ name: 'loop-blocked' }],
      comments: [{ author: { login: 'owner' }, viewerDidAuthor: true, body: blockMarker(marked), createdAt: blockAt },
        { author: { login: 'owner' }, body: '/answer go', createdAt: later(30) }] },
    { number: 15, title: 'Retired reason', labels: [{ name: 'loop-blocked' }, { name: 'human:decide' }],
      comments: [{ author: { login: 'owner' }, viewerDidAuthor: true, body: blockMarker({ ...marked, issue: 15, reason: 'TRUST_REQUIRED' }), createdAt: blockAt },
        { author: { login: 'owner' }, body: '/answer the issue text wins', createdAt: later(30) }] },
  ]);
  const triaging = fakeRun([
    ['gh issue list --label loop-blocked', blockedList],
    ['gh api repos/{owner}/{repo}/issues/7/events', later(0.1)],
    ['gh api repos/{owner}/{repo}/issues/8/events', later(0.1)],
    ['gh api repos/{owner}/{repo}/issues/10/events', later(60 * 24)],
    ['gh api repos/{owner}/{repo}/issues/11/events', later(0.1)],
    ['gh api repos/{owner}/{repo}/issues/12/events', later(0.1)],
    ['gh api repos/{owner}/{repo}/issues/13/events', later(0.1)],
    ['gh api repos/{owner}/{repo}/issues/14/events', later(0.1)],
    ['gh api repos/{owner}/{repo}/issues/15/events', later(0.1)],
    ['gh issue edit 15', ''],
    ['gh issue comment 15', ''],
    ['gh issue edit 13', ''],
    ['gh issue comment 13', ''],
    ['gh api repos/{owner}/{repo}/collaborators/owner/permission', 'admin'],
    ['gh api repos/{owner}/{repo}/collaborators/stranger/permission', 'read'],
    ['gh issue edit 7', ''],
    ['gh issue comment 7', ''],
  ]);
  const triage = triageBlocks({ run: triaging.run, now: Date.parse(later(60)) });
  check('prime resumes an answered loop block, and holds the rest with their reason',
    triage.resumed.map((entry) => `${entry.number}:${entry.by}:${entry.answer}`).join(',') === '7:owner:128,13:owner:64,15:owner:the issue text wins'
    && triage.waiting.map((entry) => `${entry.number}:${entry.question}`).join(',') === '8:What length?,11:What length?'
    && triage.held.map((entry) => entry.number).join(',') === '9,10,12,14'
    && triage.errors.length === 0);
  check('a resume lifts the block and gate labels, then records the answer, touching nothing else',
    triaging.calls.includes('gh issue edit 7 --remove-label loop-blocked,human:decide')
    && triaging.calls.some((call) => call.startsWith('gh issue comment 7') && call.includes('autoloop-resumed-v1'))
    && !triaging.calls.some((call) => /gh issue (edit|comment) (8|9|10|11|12|14)\b/u.test(call))
    && triaging.calls.includes('gh issue edit 15 --remove-label loop-blocked,human:decide')
    && !triaging.calls.some((call) => call.includes('loop-ready')));
  check('a failed listing resumes nothing and reports it',
    triageBlocks({ run: fakeRun([['gh issue list', false]]).run }).errors.length === 1);
  const eventsFail = fakeRun([['gh issue list --label loop-blocked', blockedList]]);
  check('an unreadable label history holds the unit instead of resuming it',
    triageBlocks({ run: eventsFail.run }).resumed.length === 0
    && !eventsFail.calls.some((call) => call.startsWith('gh issue edit')));

  const provenance = { by: 'owner', at: '2026-09-20T09:00:00Z' };
  const repair = { parent: 248, parentLabeledBy: 'owner', parentLabeledAt: provenance.at, depth: 1 };
  check('a repair marker round-trips and refuses depth 2 and junk',
    JSON.stringify(parseRepair(`body\n\n${repairMarker(repair)}`)) === JSON.stringify(repair)
    && parseRepair(repairMarker({ ...repair, depth: 2 })) === null
    && parseRepair(`${repairMarker(repair)}\n${repairMarker({ ...repair, parent: 9 })}`) === null
    && parseRepair('<!-- autoloop-repair-v1 {nope} -->') === null);
  const parentView = JSON.stringify({ state: 'OPEN', labels: [{ name: 'loop-ready' }], body: 'parent body' });
  const repairRuns = (overrides = []) => fakeRun([
    ...overrides,
    ['gh issue view 248', parentView],
    ['gh api repos/{owner}/{repo}/issues/248/events', JSON.stringify(provenance)],
    ['gh api repos/{owner}/{repo}/collaborators/owner/permission', 'admin'],
    ['gh issue list --label loop-repair', '[]'],
    ['gh issue create', 'https://github.com/o/r/issues/330'],
    ['gh issue comment 248', ''],
    ['gh issue edit 248 --add-label loop-waiting', ''],
  ]);
  const filing = repairRuns();
  const filed = markRepair({ parent: 248, title: 'Patch the audit advisories', body: 'Fix the advisories.', blocksParent: true, run: filing.run });
  const create = filing.calls.find((call) => call.startsWith('gh issue create'));
  check('a repair is filed with the parent provenance, loop-repair and never loop-ready, then the parent waits on it',
    filed.ok && filed.issue === 330 && filed.disposition === 'repair'
    && JSON.stringify(parseRepair(create)) === JSON.stringify({ ...repair, blocksParent: true })
    && create.includes('--label loop-repair') && !create.includes('loop-ready')
    && filing.calls.some((call) => call.startsWith('gh issue comment 248') && call.includes('"number":330'))
    && filing.calls.includes('gh issue edit 248 --add-label loop-waiting'));
  const parentWait = filing.calls.find((call) => call.startsWith('gh issue comment 248')).slice('gh issue comment 248 --body '.length);
  const chained = fakeRun([
    ['gh issue list', JSON.stringify([{ number: 248, comments: [{ body: parentWait }] }])],
    ['git rev-parse', oid], ['gh issue view 330', 'CLOSED'], ['gh issue edit 248', ''],
  ]);
  check('the parent a blocking repair filed comes back once the repair closes',
    liftWaits({ base: 'main', run: chained.run }).lifted.map((entry) => `${entry.number}:${entry.reason}`).join(',') === '248:#330 is closed');
  const independent = repairRuns();
  check('a repair the parent does not need leaves the parent in the queue',
    markRepair({ parent: 248, title: 't', body: 'b', run: independent.run }).ok
    && !independent.calls.some((call) => call.includes('loop-waiting')));
  const untrustedParent = repairRuns([['gh api repos/{owner}/{repo}/collaborators/owner/permission', 'read']]);
  check('a parent whose loop-ready came from an untrusted actor refuses, filing nothing',
    markRepair({ parent: 248, title: 't', body: 'b', run: untrustedParent.run }).code === 'REPAIR_PARENT_UNTRUSTED'
    && !untrustedParent.calls.some((call) => call.startsWith('gh issue create')));
  const blockedParent = repairRuns([['gh issue view 248', JSON.stringify({ state: 'OPEN', labels: [{ name: 'loop-ready' }, { name: 'loop-blocked' }], body: '' })]]);
  check('a parent blocked for a human refuses a repair: the loop may not route around its block',
    markRepair({ parent: 248, title: 't', body: 'b', run: blockedParent.run }).code === 'REPAIR_PARENT_BLOCKED'
    && !blockedParent.calls.some((call) => call.startsWith('gh issue create')));
  const unlabeledParent = repairRuns([['gh issue view 248', JSON.stringify({ state: 'OPEN', labels: [], body: '' })]]);
  check('a parent without loop-ready refuses',
    markRepair({ parent: 248, title: 't', body: 'b', run: unlabeledParent.run }).code === 'REPAIR_PARENT_UNTRUSTED');
  const nestedParent = repairRuns([['gh issue view 248', JSON.stringify({ state: 'OPEN', labels: [{ name: 'loop-repair' }], body: repairMarker({ ...repair, parent: 1 }) })]]);
  check('a repair of a repair refuses: depth is one',
    markRepair({ parent: 248, title: 't', body: 'b', run: nestedParent.run }).code === 'REPAIR_DEPTH_EXCEEDED');
  const fullBudget = repairRuns([['gh issue list --label loop-repair', JSON.stringify([1, 2, 3].map((number) => ({ number, body: repairMarker(repair) })))]]);
  check('a fourth open repair of one parent refuses',
    markRepair({ parent: 248, title: 't', body: 'b', run: fullBudget.run }).code === 'REPAIR_BUDGET_EXHAUSTED'
    && !fullBudget.calls.some((call) => call.startsWith('gh issue create')));
  check('a repair without a title or body refuses before any call',
    markRepair({ parent: 248, title: '', body: 'b', run: fakeRun([]).run }).code === 'INVALID_ARGS'
    && markRepair({ parent: 248, title: 't', body: ' ', run: fakeRun([]).run }).code === 'INVALID_ARGS');

  check('arguments parse and refuse',
    parseArgs(['--repair', '--parent', '248', '--title', 't', '--body-file', 'b.md', '--blocks-parent']).blocksParent === true
    && parseArgs(['--block', '--issue', '7', '--reason', 'X', '--question', 'q?', '--gate', 'human:authorize']).gate === 'human:authorize'
    && parseArgs(['--decide', '--issue', '5', '--question', 'q?', '--choice', 'c', '--why', 'w', '--alternatives', 'a; b']).alternatives.join('|') === 'a|b'
    && parseArgs(['--decisions', '--issue', '5', '--out', 'd.md']).out === 'd.md'
    && parseArgs(['--wait', '--issue', '5', '--on-issue', '4']).onIssue === 4
    && parseArgs(['--wait', '--issue', '5', '--on-pr', '70', '--paths', 'src/a.mjs, src/b/']).paths.join('|') === 'src/a.mjs|src/b/'
    && parseArgs(['--wait', '--issue', '5', '--on-pr', '70', '--paths', 'src/a.mjs']).onPr === 70
    && parseArgs(['--overlap', '--issue', '5', '--boundary-file', 'plan.json', '--snapshot', 'snap.json']).snapshot === 'snap.json'
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
    console.error('usage: unit.mjs --obsolete --issue N (--pr M | --commit SHA) [--note T] | --wait --issue N (--on-issue M | --on-base-red | --minutes 1..720 | --on-pr M --paths A,B/) [--note T] | --overlap --issue N --boundary-file PATH --snapshot PATH | --repair --parent N --title T --body-file PATH [--blocks-parent] | --block --issue N --reason CODE --question T [--gate human:authorize] [--note T] | --decide --issue N --question T --choice T --why T [--alternatives "A; B"] | --decisions --issue N [--out PATH] | --lift | --digest [--post] | --self-test');
    console.error(`human block reasons: ${[...HUMAN_BLOCK_REASONS].join(', ')}; retired (use --decide): ${[...RETIRED_BLOCK_REASONS].join(', ')}`);
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);
  if (parsed.mode === 'overlap') {
    const outcome = overlapCheck({ issue: parsed.issue, boundaryFile: parsed.boundaryFile, snapshotPath: parsed.snapshot });
    console.log(JSON.stringify(outcome, null, 1));
    process.exit(outcome.ok ? 0 : 1);
  }
  const root = realRun(process.cwd())('git', ['rev-parse', '--show-toplevel']).stdout || process.cwd();
  const run = realRun(root);
  if (parsed.mode === 'repair') {
    let body;
    try {
      body = readFileSync(parsed.bodyFile ?? '', 'utf8');
    } catch (error) {
      console.log(JSON.stringify(refusal('INVALID_ARGS', `--body-file: ${error.message}`)));
      process.exit(1);
    }
    const outcome = markRepair({ ...parsed, body, run });
    console.log(JSON.stringify(outcome, null, 1));
    process.exit(outcome.ok ? 0 : 1);
  }
  if (parsed.mode === 'decide' || parsed.mode === 'block') {
    const outcome = parsed.mode === 'decide' ? markDecided({ ...parsed, run }) : markBlocked({ ...parsed, run });
    console.log(JSON.stringify(outcome, null, 1));
    process.exit(outcome.ok ? 0 : 1);
  }
  if (parsed.mode === 'decisions') {
    const outcome = collectUnitDecisions({ issue: parsed.issue, run });
    if (outcome.ok && parsed.out !== null) {
      try {
        writeFileSync(parsed.out, `${outcome.section}\n`);
      } catch (error) {
        console.log(JSON.stringify(refusal('INVALID_ARGS', `--out: ${error.message}`)));
        process.exit(1);
      }
    }
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
