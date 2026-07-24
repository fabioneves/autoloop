#!/usr/bin/env node
// PreToolUse(Bash) guard — converts the autoloop NEVER rules from prose into blocks.
// Vendored by autoloop:setup and wired into the active host's project hooks
// (.claude/settings.json and/or .codex/hooks.json).
//
//   BLOCK (exit 2)
//     1. `gh pr merge` in any form            — L2: the loop/agent never merges (STATE.md).
//     2. `git commit` while on a permanent branch — permanent branches take PRs only.
//        Skipped when the same command switches branches first (git switch|checkout).
//     3. a commit message carrying Co-Authored-By — commits carry no co-author trailer.
//     4. `git push --force`/-f                — only --force-with-lease is allowed.
//     5. inline --body/-b on gh pr create|comment|review|edit / gh issue comment —
//        untrusted text never rides in shell source; use --body-file (STATE → Lessons).
//     6. `gh api` reaching a merge endpoint, a GraphQL merge mutation, or a mutating
//        call on branch protection — the REST/GraphQL bypass of rule 1 and of
//        "never edit the protection yourself".
//
//   ALLOW everything else (exit 0). Fail-open on anything unparseable: a guard that
//   wedges every Bash call is worse than no guard.
//
// Usage:  (hook) reads the PreToolUse payload on stdin
//         node tools/agentic/command-guard.mjs --self-test

import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  extractConfig,
  validateConfig,
} from './config-contract.mjs';

// Strip heredoc bodies so text INSIDE a body (e.g. a PR description that quotes
// "gh pr merge") never false-positives.
export function stripHeredocs(cmd) {
  return cmd.replace(
    /<<[-~]?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1[^\n]*\r?\n[\s\S]*?\r?\n[ \t]*\2(?![A-Za-z0-9_-])/g,
    '',
  );
}

function shellSegments(cmd) {
  const segments = [];
  let quote = null;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < cmd.length; i += 1) {
    const char = cmd[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const pair = cmd.slice(i, i + 2);
    const separator = pair === '&&' || pair === '||'
      ? pair
      : char === ';' || char === '\n' || char === '|' || char === '&'
        ? ';'
        : null;
    if (!separator) continue;
    segments.push({ command: cmd.slice(start, i).trim(), next: separator });
    i += separator.length - 1;
    start = i + 1;
  }
  segments.push({ command: cmd.slice(start).trim(), next: null });
  return segments.filter((segment) => segment.command);
}

function shellWords(command) {
  const words = [];
  let word = '';
  let quote = null;
  let escaped = false;
  let active = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
      active = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (active) words.push(word);
      word = '';
      active = false;
      continue;
    }
    word += char;
    active = true;
  }
  if (active) words.push(word);
  return words;
}

function gitSubcommandIndex(words, subcommand) {
  const git = words.indexOf('git');
  if (git === -1) return -1;
  const optionsWithValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
  for (let i = git + 1; i < words.length; i += 1) {
    const word = words[i];
    if (optionsWithValues.has(word)) {
      i += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return word === subcommand ? i : -1;
  }
  return -1;
}

function switchTarget(words) {
  const switchIndex = gitSubcommandIndex(words, 'switch');
  const checkoutIndex = gitSubcommandIndex(words, 'checkout');
  const index = switchIndex === -1 ? checkoutIndex : switchIndex;
  if (index === -1) return null;
  const branchFlags = new Set(['-c', '-C', '-b', '-B']);
  for (let i = index + 1; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') return null;
    if (branchFlags.has(word)) return words[i + 1] ?? null;
    if (word.startsWith('-')) continue;
    return word;
  }
  return null;
}

function normalizedBranch(ref) {
  return String(ref ?? '').replace(/^refs\/heads\//, '');
}

function pushTargetsBase(words, branches, baseBranch) {
  const index = gitSubcommandIndex(words, 'push');
  if (index === -1) return false;
  const args = words.slice(index + 1);
  const deleteMode = args.includes('--delete') || args.includes('-d');
  const optionsWithValues = new Set([
    '--repo',
    '--receive-pack',
    '--exec',
    '--push-option',
    '-o',
  ]);
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (optionsWithValues.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return branches.has(baseBranch);
  return refspecs.some((refspec) => {
    const clean = refspec.replace(/^\+/, '');
    const colon = clean.lastIndexOf(':');
    const destination = colon === -1 ? clean : clean.slice(colon + 1);
    if (!destination && !deleteMode) return false;
    return normalizedBranch(destination) === baseBranch;
  });
}

function isInlineGhBody(words) {
  const gh = words.indexOf('gh');
  if (gh === -1) return false;
  const scope = words.findIndex((word, index) => index > gh && (word === 'pr' || word === 'issue'));
  const action = words[scope + 1];
  if (scope === -1 || !new Set(['create', 'comment', 'review', 'edit']).has(action)) return false;
  return words.some(
    (word) => word === '--body' || word === '-b' || (word.startsWith('--body=') && !word.startsWith('--body-file=')),
  );
}

/**
 * Pure rule evaluation — returns { block: boolean, reason?: string }.
 * `branch` is the CURRENT git branch (null when unknown → branch rules skip).
 */
export function evaluate(rawCmd, branch, options = {}) {
  if (typeof rawCmd !== 'string' || rawCmd.length === 0) return { block: false };
  const cmd = stripHeredocs(rawCmd);
  const baseBranch = options.baseBranch ?? 'main';

  // 1. never merge
  if (/\bgh\b[^\n]*\bpr\b[^\n]*\bmerge\b/.test(cmd)) {
    return {
      block: true,
      reason:
        'Blocked: `gh pr merge` — L2: the loop/agent never merges directly ' +
        '(docs/agentic/STATE.md → Autonomy). A human merges, or the repo-ratified ' +
        'tools/agentic/auto-merge.mjs performs the sole sanctioned policy-gated exception.',
    };
  }

  const segments = shellSegments(cmd);
  let possibleBranches = new Set(branch ? [branch] : []);
  for (const segment of segments) {
    const words = shellWords(segment.command);
    if (gitSubcommandIndex(words, 'commit') !== -1 && possibleBranches.has(baseBranch)) {
      return {
        block: true,
        reason:
          `Blocked: \`git commit\` on configured base "${baseBranch}" — the base takes PRs only. ` +
          'Create a working branch first: <type>/gh-<N>-<slug> (autoloop:dev step 4).',
      };
    }
    if (pushTargetsBase(words, possibleBranches, baseBranch)) {
      return {
        block: true,
        reason:
          `Blocked: \`git push\` targets configured base "${baseBranch}" — the base takes PRs only.`,
      };
    }
    const target = switchTarget(words);
    if (target && segment.next === '&&') possibleBranches = new Set([normalizedBranch(target)]);
    else if (target && segment.next === ';') possibleBranches.add(normalizedBranch(target));
  }

  // 3. no co-author trailers (checked on the RAW command: the trailer rides in -m text)
  if (segments.some(({ command }) => gitSubcommandIndex(shellWords(command), 'commit') !== -1) && /Co-Authored-By:/i.test(rawCmd)) {
    return {
      block: true,
      reason:
        'Blocked: commit message carries a Co-Authored-By trailer — this repo forbids ' +
        'co-author trailers on commits (autoloop hard rules). Re-run without it.',
    };
  }

  // 4. force pushes: only --force-with-lease. Catches both the `--force`/`-f` flags AND the
  //    `+<refspec>` force syntax (`git push origin +main`, incl. a quoted `'+refs/…'`), which
  //    force-updates a ref with neither flag.
  if (/\bgit\b[^\n]*\bpush\b/.test(cmd)) {
    const deLeased = cmd.replace(/--force-with-lease(=\S+)?/g, '');
    const flagForce = /(^|\s)(--force|-f)(\s|$)/.test(deLeased);
    const refspecForce = /(?:^|[\s'"])\+\S/.test(cmd);
    if (flagForce || refspecForce) {
      return {
        block: true,
        reason:
          'Blocked: force push (`--force`/-f or a `+<refspec>` force-update) — destructive. Use ' +
          '--force-with-lease (and only on loop branches after a rebase, autoloop:pitcrew step 7).',
      };
    }
  }

  // 5. gh bodies go via --body-file, never inline
  if (segments.some(({ command }) => isInlineGhBody(shellWords(command)))) {
    return {
      block: true,
      reason:
        'Blocked: inline --body/-b on a gh command — untrusted text never rides in shell ' +
        'source (STATE → Lessons). Write the body to a scratch file with the host\'s safe file-editing surface ' +
        'and pass --body-file.',
    };
  }

  // 6. `gh api` must not merge or mutate branch protection. Reads stay allowed —
  //    issue timeline, collaborator role_name, and GraphQL queries/resolveReviewThread
  //    are all read-shaped and pass.
  if (/\bgh\b[^\n]*\bapi\b/.test(cmd)) {
    if (/\/(pulls\/[^\s/]+\/merge|merges)\b/.test(cmd)) {
      return {
        block: true,
        reason:
          'Blocked: `gh api` merge endpoint — L2: the loop/agent never merges directly, via any ' +
          'raw surface (docs/agentic/STATE.md → Autonomy). Use human merge or the repo-ratified policy gate.',
      };
    }
    if (/\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/.test(cmd)) {
      return {
        block: true,
        reason:
          'Blocked: GraphQL merge mutation — L2: the loop/agent never merges directly, via any ' +
          'raw surface (docs/agentic/STATE.md → Autonomy). Use human merge or the repo-ratified policy gate.',
      };
    }
    if (
      /\/protection\b/.test(cmd) &&
      /(^|\s)(-X|--method|-f|-F|--field|--raw-field|--input)(\s|=)/.test(cmd)
    ) {
      return {
        block: true,
        reason:
          'Blocked: mutating `gh api` call on branch protection — the protection ' +
          'baseline is the human\'s control; the loop only reads it ' +
          '(docs/agentic/STATE.md → Autonomy). Report the mismatch instead.',
      };
    }
  }

  return { block: false };
}

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export function loadConfiguredBase(statePath) {
  const config = extractConfig(readFileSync(statePath, 'utf8'));
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`invalid ProjectConfig: ${errors.join('; ')}`);
  }
  return config.baseBranch;
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { selfTest: true, statePath: null, error: null };
  }
  if (args.length === 0) {
    return {
      selfTest: false,
      statePath: 'docs/agentic/STATE.md',
      error: null,
    };
  }
  if (
    args.length === 2
    && args[0] === '--config'
    && typeof args[1] === 'string'
    && args[1].length > 0
  ) {
    return { selfTest: false, statePath: args[1], error: null };
  }
  return {
    selfTest: false,
    statePath: null,
    error: 'expected --config <STATE path> or --self-test',
  };
}

function selfTest() {
  const cases = [
    // [cmd, branch, expectBlock, baseBranch]
    ['gh pr merge 42', 'feat/gh-1-x', true],
    ['gh --repo o/r pr merge 42 --squash', 'feat/gh-1-x', true],
    ['gh pr view 42 --json mergeStateStatus,mergeable', 'develop', false], // no \bmerge\b
    ['gh pr list --search draft:false', 'main', false],
    ['git commit -m "feat: x"', 'develop', true, 'develop'],
    ['git commit -m "feat: x"', 'main', true],
    ['git commit -m "feat: x"', 'master', true, 'master'],
    ['git commit -m "feat: x"', 'feat/gh-2-y', false],
    ['git switch -c feat/gh-3-z && git commit --allow-empty -m "chore: claim #3"', 'main', false],
    ['git commit -m "unsafe first" && git switch feat/gh-3-z', 'trunk', true, 'trunk'],
    ['git switch trunk && git commit -m "unsafe target"', 'feat/gh-3-z', true, 'trunk'],
    ['git switch feat/gh-3-z || git commit -m "unsafe fallback"', 'trunk', true, 'trunk'],
    ['git switch feat/gh-3-z; git commit -m "unsafe after uncertain switch"', 'trunk', true, 'trunk'],
    ['git switch feat/gh-3-z | git commit -m "unsafe pipeline"', 'trunk', true, 'trunk'],
    ['git switch feat/gh-3-z && git commit -m "safe target"', 'trunk', false, 'trunk'],
    ['git commit -m "allowed on main"', 'main', false, 'trunk'],
    ['git commit -m "fix: y" -m "Co-Authored-By: Claude <n@a.com>"', 'feat/gh-2-y', true],
    ['git push --force origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -f', 'feat/gh-2-y', true],
    ['git push --force-with-lease origin feat/gh-2-y', 'feat/gh-2-y', false],
    ['git push origin +main', 'feat/gh-2-y', true], // +refspec force
    ["git push origin '+refs/heads/main'", 'main', true], // quoted +refspec force
    ['git push origin feat/gh-2-y', 'feat/gh-2-y', false], // normal push, no force
    ['git push --set-upstream origin feat/gh-2-y', 'feat/gh-2-y', false],
    ['git push origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin HEAD:refs/heads/trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin :trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --delete origin trunk', 'feat/gh-2-y', true, 'trunk'],
    ['gh pr create --draft --title "t" --body "inline"', 'feat/gh-2-y', true],
    ['gh --repo o/r pr create --title "t" --body "inline"', 'feat/gh-2-y', true],
    ['gh --hostname github.example pr comment 4 -b "inline"', 'feat/gh-2-y', true],
    ['gh issue comment 5 -b "hi"', 'feat/gh-2-y', true],
    ['gh pr create --draft --title "t" --body-file /tmp/b.md', 'feat/gh-2-y', false],
    ['gh pr review 5 --request-changes --body-file /tmp/r.md', 'main', false],
    // gh api: merge/protection mutations blocked, reads pass
    ['gh api repos/o/r/pulls/42/merge -X PUT', 'feat/gh-2-y', true],
    ['gh api repos/o/r/merges -f base=main -f head=feat/gh-2-y', 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"})}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"x\"})}'", 'feat/gh-2-y', false],
    ['gh api repos/o/r/branches/main/protection -X DELETE', 'main', true],
    ['gh api repos/o/r/branches/main/protection -f enforce_admins=false', 'main', true],
    ["gh api repos/o/r/branches/main/protection --jq '.enforce_admins.enabled'", 'main', false],
    ["gh api repos/o/r/issues/5/timeline --jq '.[]'", 'main', false],
    ['gh api repos/o/r/collaborators/alice/permission --jq .role_name', 'main', false],
    // heredoc body quoting a forbidden command must NOT trip the guard
    ['cat <<\'EOF\' > /tmp/x\ngh pr merge 42\nEOF', 'main', false],
    ['git commit -F - <<\'MSG\'\nfeat: x\nMSG', 'feat/gh-2-y', false],
  ];
  let ok = true;
  for (const [cmd, branch, expect, baseBranch] of cases) {
    const got = evaluate(cmd, branch, { baseBranch }).block;
    if (got !== expect) {
      console.error(`FAIL [expect block=${expect}, got ${got}]: ${cmd.split('\n')[0]}`);
      ok = false;
    }
  }
  const argCases = [
    ['default config path', [], 'docs/agentic/STATE.md'],
    ['explicit config path', ['--config', '/repo/STATE.md'], '/repo/STATE.md'],
    ['missing config value', ['--config'], null],
    ['legacy base injection rejected', ['--base', 'main'], null],
  ];
  for (const [name, args, expectedPath] of argCases) {
    const parsed = parseArgs(args);
    const passed = expectedPath === null
      ? parsed.error !== null
      : parsed.error === null && parsed.statePath === expectedPath;
    if (!passed) {
      console.error(`FAIL [${name}]`);
      ok = false;
    }
  }
  console.log(ok ? `self-test OK (${cases.length} cases)` : 'self-test FAILED');
  return ok;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`command-guard: ${parsed.error}`);
    process.exit(1);
  }
  if (parsed.selfTest) process.exit(selfTest() ? 0 : 1);

  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // fail-open: no parseable payload, nothing to judge
  }
  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== 'string') process.exit(0);

  let baseBranch;
  try {
    baseBranch = loadConfiguredBase(parsed.statePath);
  } catch (error) {
    console.error(`command-guard: cannot resolve configured base: ${error.message}`);
    process.exit(1);
  }
  const verdict = evaluate(cmd, currentBranch(), { baseBranch });
  if (verdict.block) {
    process.stderr.write(verdict.reason + '\n');
    process.exit(2);
  }
  process.exit(0);
}

// realpath compare — the naive `file://` string check fails open on encoded paths and symlinks.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
