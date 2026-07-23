#!/usr/bin/env node
// Deterministic escalate-path classifier (vendored by autoloop:setup).
// "Did this diff touch an escalate path" must not be a judgment call reading a diff —
// a miss silently drops the `human:authorize` flag the human merger relies on. This
// transcribes docs/agentic/STATE.md → Escalate-list into globs, PLUS self-protection:
// the loop flags changes to its own guardrails (tools/, .claude/, .codex/, .agents/,
// AGENTS.override.md, AGENTS.md, CLAUDE.md, docs/agentic/).
// The script is the mechanical floor; the orchestrator's judgment can add paths, never remove.
//
// ADAPT ME: the list below ships with only the universal entries. Add your project's
// escalate paths (auth, secrets, schema, safety boundaries, deploy) — keep it in sync
// with STATE.md → Escalate-list, and extend the self-test when you do.
//
// Usage:
//   node tools/agentic/escalate-paths.mjs [<git range>]   # default: origin/<base>...HEAD
//     → prints matched files; exit 1 if any escalate path was touched, 0 if none
//   node tools/agentic/escalate-paths.mjs --working-tree   # uncommitted + untracked paths
//     → for the Prime dirty-tree attribution check (is a killed implementer's WIP clear of
//       escalate paths?); same exit contract (1 if any escalate path is dirty, 0 if none)
//   node tools/agentic/escalate-paths.mjs --self-test

import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ESCALATE_PATHS = [
  // --- universal: secrets / env (root AND nested — a nested .env is the same secret surface) ---
  '.env*',
  '**/.env*',
  // --- universal: deploy / ops / CI (root and nested) ---
  '.github/workflows/**',
  'Dockerfile*',
  '**/Dockerfile*',
  'docker-compose*',
  '**/docker-compose*',
  // --- universal: the loop's own guardrails and process definitions ---
  'tools/**',
  '.claude/**',
  '.codex/**',
  '.agents/**',
  '.githooks/**',
  // Guidance files at ANY depth — both hosts honor nested per-directory AGENTS.md/CLAUDE.md,
  // so a nested file is the same injection surface as the root one.
  'AGENTS.override.md',
  'AGENTS.md',
  'CLAUDE.md',
  '**/AGENTS.override.md',
  '**/AGENTS.md',
  '**/CLAUDE.md',
  'docs/agentic/STATE.md',
  // --- PROJECT-SPECIFIC (add yours; examples): ---
  // 'src/auth/**',
  // 'src/db/schema/**',
  // 'src/payments/**',
];

// Minimal glob → regex: '**' = any path segment(s), '*' = within a segment.
export function globToRe(glob) {
  const re = glob
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return part.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    })
    .join('');
  // Case-insensitive to match auto-merge's protected floor and to stay robust on
  // case-insensitive filesystems (a `TOOLS/` or `.Env` must not slip past the escalate flag).
  return new RegExp(`^${re}$`, 'i');
}

const RES = ESCALATE_PATHS.map((g) => ({ glob: g, re: globToRe(g) }));

export function matchEscalate(files) {
  const hits = [];
  for (const f of files ?? []) {
    const m = RES.find(({ re }) => re.test(f));
    if (m) hits.push({ file: f, glob: m.glob });
  }
  return hits;
}

function selfTest() {
  const cases = [
    ['.env.example', true],
    ['apps/web/.env.local', true], // nested env — same secret surface
    ['.ENV.local', true], // case-insensitive
    ['.github/workflows/ci.yml', true],
    ['Dockerfile', true],
    ['deploy/Dockerfile.prod', true], // nested Dockerfile
    ['docker-compose.yml', true],
    ['k8s/docker-compose.prod.yml', true], // nested compose
    ['tools/agentic/command-guard.mjs', true],
    ['.claude/settings.json', true],
    ['.codex/hooks.json', true],
    ['.agents/plugins/marketplace.json', true],
    ['AGENTS.override.md', true],
    ['AGENTS.md', true],
    ['CLAUDE.md', true],
    ['src/AGENTS.md', true],
    ['packages/web/CLAUDE.md', true],
    ['deep/nested/dir/AGENTS.override.md', true],
    ['src/MYAGENTS.md', false],
    ['docs/agentic/STATE.md', true],
    ['docs/agentic/LOOP.md', false],
    ['src/index.ts', false],
    ['README.md', false],
  ];
  let ok = true;
  for (const [file, expect] of cases) {
    const got = matchEscalate([file]).length > 0;
    if (got !== expect) {
      console.error(`FAIL [expect ${expect}, got ${got}]: ${file}`);
      ok = false;
    }
  }
  console.log(ok ? `self-test OK (${cases.length} cases)` : 'self-test FAILED');
  return ok;
}

function baseRange() {
  try {
    const base = execSync('gh repo view --json defaultBranchRef -q .defaultBranchRef.name', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).trim();
    if (base) return `origin/${base}...HEAD`;
  } catch {
    /* fall through */
  }
  return 'origin/main...HEAD';
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  let files;
  if (args.includes('--working-tree')) {
    // Uncommitted + untracked paths, for the Prime dirty-tree attribution check.
    try {
      const tracked = execSync('git diff --name-only HEAD', { encoding: 'utf8' }).split('\n').filter(Boolean);
      const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean);
      files = [...new Set([...tracked, ...untracked])];
    } catch (e) {
      console.error(`escalate-paths: git working-tree read failed: ${e.message}`);
      process.exit(2);
    }
  } else {
    const range = args.find((a) => !a.startsWith('-')) ?? baseRange();
    try {
      files = execSync(`git diff --name-only ${range}`, { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch (e) {
      console.error(`escalate-paths: git diff failed for range "${range}": ${e.message}`);
      process.exit(2);
    }
  }
  const hits = matchEscalate(files);
  for (const { file, glob } of hits) console.log(`ESCALATE  ${file}  (matched ${glob})`);
  if (hits.length > 0) {
    console.log('→ self-apply the `human:authorize` label and call it out in the PR body (STATE → Escalate-list)');
    process.exit(1);
  }
  console.log('no escalate paths touched');
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
