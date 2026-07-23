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
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Strip heredoc bodies so text INSIDE a body (e.g. a PR description that quotes
// "gh pr merge") never false-positives.
export function stripHeredocs(cmd) {
  return cmd.replace(
    /<<[-~]?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1[^\n]*\r?\n[\s\S]*?\r?\n[ \t]*\2(?![A-Za-z0-9_-])/g,
    '',
  );
}

// Branches that take PRs only. Covers the common defaults; add long-lived
// release/integration branches your repo protects.
const PERMANENT = new Set(['main', 'master', 'develop']);

/**
 * Pure rule evaluation — returns { block: boolean, reason?: string }.
 * `branch` is the CURRENT git branch (null when unknown → branch rules skip).
 */
export function evaluate(rawCmd, branch) {
  if (typeof rawCmd !== 'string' || rawCmd.length === 0) return { block: false };
  const cmd = stripHeredocs(rawCmd);

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

  const isCommit = /\bgit\b[^\n]*\bcommit\b/.test(cmd);

  // 2. no commits on permanent branches (unless the command itself switches first)
  if (
    isCommit &&
    branch &&
    PERMANENT.has(branch) &&
    !/\bgit\s+(switch|checkout)\b/.test(cmd)
  ) {
    return {
      block: true,
      reason:
        `Blocked: \`git commit\` on "${branch}" — permanent branches take PRs only. ` +
        'Create a working branch first: <type>/gh-<N>-<slug> (autoloop:dev step 4).',
    };
  }

  // 3. no co-author trailers (checked on the RAW command: the trailer rides in -m text)
  if (isCommit && /Co-Authored-By:/i.test(rawCmd)) {
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
  if (
    /\bgh\s+(pr|issue)\s+(create|comment|review|edit)\b/.test(cmd) &&
    /(^|\s)(--body(?!-file)|-b)(\s|=)/.test(cmd)
  ) {
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
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function selfTest() {
  const cases = [
    // [cmd, branch, expectBlock]
    ['gh pr merge 42', 'feat/gh-1-x', true],
    ['gh --repo o/r pr merge 42 --squash', 'feat/gh-1-x', true],
    ['gh pr view 42 --json mergeStateStatus,mergeable', 'develop', false], // no \bmerge\b
    ['gh pr list --search draft:false', 'main', false],
    ['git commit -m "feat: x"', 'develop', true],
    ['git commit -m "feat: x"', 'main', true],
    ['git commit -m "feat: x"', 'master', true],
    ['git commit -m "feat: x"', 'feat/gh-2-y', false],
    ['git switch -c feat/gh-3-z && git commit --allow-empty -m "chore: claim #3"', 'main', false],
    ['git commit -m "fix: y" -m "Co-Authored-By: Claude <n@a.com>"', 'feat/gh-2-y', true],
    ['git push --force origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -f', 'feat/gh-2-y', true],
    ['git push --force-with-lease origin feat/gh-2-y', 'feat/gh-2-y', false],
    ['git push origin +main', 'feat/gh-2-y', true], // +refspec force
    ["git push origin '+refs/heads/main'", 'main', true], // quoted +refspec force
    ['git push origin feat/gh-2-y', 'feat/gh-2-y', false], // normal push, no force
    ['git push --set-upstream origin feat/gh-2-y', 'feat/gh-2-y', false],
    ['gh pr create --draft --title "t" --body "inline"', 'feat/gh-2-y', true],
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
  for (const [cmd, branch, expect] of cases) {
    const got = evaluate(cmd, branch).block;
    if (got !== expect) {
      console.error(`FAIL [expect block=${expect}, got ${got}]: ${cmd.split('\n')[0]}`);
      ok = false;
    }
  }
  console.log(ok ? `self-test OK (${cases.length} cases)` : 'self-test FAILED');
  return ok;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // fail-open: no parseable payload, nothing to judge
  }
  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== 'string') process.exit(0);

  const verdict = evaluate(cmd, currentBranch());
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
