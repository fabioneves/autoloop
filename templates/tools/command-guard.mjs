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
//     7. creating, applying, or renaming `loop-ready`; release-tag pushes; and
//        GitHub release mutations — prompt transport grants none of that authority.
//     8. active shell expansion, inline interpreter source, and unknown Git/GitHub
//        subcommands — opaque syntax can conceal any rule above.
//
//   ALLOW other literal canonical commands (exit 0). An invalid hook payload fails
//   closed because it cannot prove which command the host is about to execute.
//
// Usage:  (hook) reads the PreToolUse payload on stdin
//         node tools/agentic/command-guard.mjs --self-test

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MIGRATABLE_CONFIG_VERSIONS,
  extractConfig,
  validateConfig,
} from './config-contract.mjs';
import { LOOP_BRANCH_RE } from './claim-contract.mjs';

const BRANCH_CREATION_FLAGS = new Set([
  '-c',
  '-C',
  '-b',
  '-B',
  '--create',
  '--force-create',
  '--orphan',
]);
const CURRENT_BRANCH_REFS = new Set(['HEAD', '@']);
const BULK_PUSH_FLAGS = new Set([
  '--all',
  '--branches',
  '--follow-tags',
  '--mirror',
  '--tags',
]);
const GIT_COMMANDS = new Set([
  'add',
  'am',
  'apply',
  'archive',
  'bisect',
  'blame',
  'branch',
  'bundle',
  'cat-file',
  'checkout',
  'cherry',
  'cherry-pick',
  'check-attr',
  'check-ignore',
  'clean',
  'clone',
  'commit',
  'config',
  'describe',
  'diff',
  'diff-tree',
  'fetch',
  'for-each-ref',
  'format-patch',
  'fsck',
  'gc',
  'grep',
  'help',
  'init',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge',
  'merge-base',
  'merge-tree',
  'mv',
  'notes',
  'pull',
  'push',
  'range-diff',
  'rebase',
  'reflog',
  'remote',
  'reset',
  'restore',
  'rev-list',
  'rev-parse',
  'revert',
  'rm',
  'shortlog',
  'show',
  'show-ref',
  'sparse-checkout',
  'stash',
  'status',
  'submodule',
  'switch',
  'tag',
  'update-index',
  'verify-commit',
  'verify-tag',
  'version',
  'worktree',
]);
const GH_COMMANDS = new Set([
  'alias',
  'api',
  'attestation',
  'auth',
  'browse',
  'cache',
  'codespace',
  'completion',
  'config',
  'extension',
  'gist',
  'gpg-key',
  'help',
  'issue',
  'label',
  'org',
  'pr',
  'project',
  'release',
  'repo',
  'ruleset',
  'run',
  'search',
  'secret',
  'ssh-key',
  'status',
  'variable',
  'workflow',
]);

// Strip heredoc bodies so text INSIDE a body (e.g. a PR description that quotes
// "gh pr merge") never false-positives.
export function stripHeredocs(cmd) {
  return cmd.replace(
    /<<[-~]?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1[^\n]*\r?\n[\s\S]*?\r?\n[ \t]*\2(?![A-Za-z0-9_-])/g,
    '',
  );
}

function executableShellStructure(cmd) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < cmd.length; index += 1) {
    const char = cmd[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '`' || (char === '$' && cmd[index + 1] === '(')) return true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '`' || char === '(' || char === ')' || char === '{' || char === '}') {
      return true;
    }
  }
  return false;
}

function decodeAnsiCBody(body) {
  const escapes = new Map([
    ['a', '\x07'],
    ['b', '\b'],
    ['e', '\x1b'],
    ['E', '\x1b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
    ['v', '\v'],
  ]);
  let output = '';
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '\\') {
      output += body[index];
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === '\r' && body[index + 2] === '\n') {
      index += 2;
      continue;
    }
    if (escaped === '\n') {
      index += 1;
      continue;
    }
    if (escapes.has(escaped)) {
      output += escapes.get(escaped);
      index += 1;
      continue;
    }
    if (escaped === 'x' || escaped === 'u' || escaped === 'U') {
      const maximum = escaped === 'x' ? 2 : escaped === 'u' ? 4 : 8;
      const digits = body.slice(index + 2).match(
        new RegExp(`^[0-9a-fA-F]{1,${maximum}}`, 'u'),
      )?.[0] ?? '';
      const codePoint = Number.parseInt(digits, 16);
      if (
        digits.length > 0
        && Number.isSafeInteger(codePoint)
        && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        output += String.fromCodePoint(codePoint);
        index += digits.length + 1;
        continue;
      }
    }
    if (/^[0-7]$/u.test(escaped ?? '')) {
      const digits = body.slice(index + 1).match(/^[0-7]{1,3}/u)?.[0] ?? '';
      output += String.fromCodePoint(Number.parseInt(digits, 8));
      index += digits.length;
      continue;
    }
    output += escaped ?? '\\';
    if (escaped !== undefined) index += 1;
  }
  return output;
}

function decodeAnsiCQuotes(cmd) {
  return cmd.replace(
    /\$'((?:\\[\s\S]|[^'])*)'/gu,
    (_match, body) => decodeAnsiCBody(body),
  );
}

function executableLexicalText(cmd) {
  const decoded = decodeAnsiCQuotes(cmd);
  let output = '';
  for (let index = 0; index < decoded.length; index += 1) {
    const char = decoded[index];
    if (char === '\\') {
      if (decoded[index + 1] === '\r' && decoded[index + 2] === '\n') {
        index += 2;
      } else if (decoded[index + 1] === '\n') {
        index += 1;
      } else if (index + 1 < decoded.length) {
        output += decoded[index + 1];
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"') continue;
    if (
      char === '$'
      && (decoded[index + 1] === "'" || decoded[index + 1] === '"')
    ) {
      continue;
    }
    output += char;
  }
  return output;
}

function structuredGitMutation(cmd) {
  if (!executableShellStructure(cmd)) return false;
  const visible = executableLexicalText(cmd);
  return /(?:^|[\s;&|(`{}])(?:\/[^\s;&|(`{}]+\/)*git\b(?:(?![;&|\n]).)*\b(?:commit|push)\b/u
    .test(visible);
}

function hasActiveShellExpansion(cmd) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < cmd.length; index += 1) {
    const char = cmd[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === '"') {
      if (quote === '"') quote = null;
      else if (quote === null) quote = '"';
      continue;
    }
    if (
      char === '`'
      || char === '<' && cmd[index + 1] === '('
      || char === '>' && cmd[index + 1] === '('
      || (
        char === '$'
        && !new Set(["'", '"']).has(cmd[index + 1])
        && /[({A-Za-z_0-9@*#?$!_-]/u.test(cmd[index + 1] ?? '')
      )
    ) {
      return true;
    }
  }
  return false;
}

// A live run wrote `S=/tmp/x; sha256sum $S/plan.md` and was refused as opaque,
// every session, because the guard cannot judge what it cannot read. Refusing
// is not the only way to become able to read it: when a variable is assigned a
// literal in the same command, the guard substitutes it and judges the REAL
// command. That is strictly stronger than refusal — `verb=merge; gh pr $verb 42`
// now blocks on the merge rule itself rather than on shape. Anything not
// statically resolvable (command substitution, environment, values carrying
// whitespace or metacharacters) stays opaque and stays blocked.
const RESOLVABLE_VALUE = /^[A-Za-z0-9_./:@%+,=-]+$/u;

function literalAssignments(cmd) {
  const values = new Map();
  // `m` is load-bearing: a newline separates commands exactly as `;` does, and
  // without it `^` matched only the very start of the string — so an assignment
  // was recognised on the first line and nowhere else. A live audit battery ran
  // fine as `T=...` on line 1 and was refused as opaque the moment a `cd` was
  // added above it.
  const pattern = /(?:^|[;&|]|&&|\|\|)\s*([A-Za-z_][A-Za-z0-9_]*)=("[^"$`\\\n]*"|'[^'\n]*'|[^\s;&|()<>"'`$\\]*)/gmu;
  for (const match of String(cmd).matchAll(pattern)) {
    const [, name, raw] = match;
    const value = /^["']/u.test(raw) ? raw.slice(1, -1) : raw;
    if (!RESOLVABLE_VALUE.test(value)) {
      values.set(name, null);
      continue;
    }
    values.set(name, values.has(name) ? null : value);
  }
  return values;
}

// A `for` over a LITERAL word list is not opaque — it is N literal commands
// written once. The guard already resolves `S=/tmp/x; sha256sum $S/plan.md` by
// substituting and judging the real command; a loop is the same operation
// repeated, and refusing it while accepting the assignment was inconsistent.
//
// Three live runs lost a round to this shape: `for n in 222 223 224; do gh issue
// view $n …; done` and a spec sweep over eight named files. The advice they got
// — "write the iterations as literal commands" — is correct and is exactly what
// this does mechanically, so the guard was asking the reader to perform an
// expansion the guard could perform itself.
//
// Only a fully literal list expands. A word carrying `$`, a command
// substitution, or a glob stays unexpanded and the loop stays refused, because
// what those iterate over is not knowable here. The bound keeps a pathological
// list from turning one refusal into a thousand judgements.
const MAX_LOOP_EXPANSION = 32;

export function expandLiteralForLoops(cmd) {
  const pattern =
    /(^|[\s;&|])for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+?)\s*;\s*do\s+([\s\S]*?)\s*;?\s*done(?=$|[\s;&|\n])/u;
  let text = String(cmd);
  let changed = false;
  for (let guard = 0; guard < 4; guard += 1) {
    const match = pattern.exec(text);
    if (match === null) break;
    const [whole, lead, name, listText, body] = match;
    const words = shellWords(listText);
    if (words.length === 0 || words.length > MAX_LOOP_EXPANSION) return null;
    if (!words.every((word) => RESOLVABLE_VALUE.test(word))) return null;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const iterations = words.map((word) => body
      .replace(new RegExp(`\\$\\{${escaped}\\}`, 'gu'), word)
      .replace(new RegExp(`\\$${escaped}(?![A-Za-z0-9_])`, 'gu'), word)
      .trim()
      .replace(/;+$/u, ''));
    text = text.slice(0, match.index)
      + lead
      + iterations.join('; ')
      + text.slice(match.index + whole.length);
    changed = true;
  }
  return changed ? text : null;
}

function resolveShellExpansions(cmd) {
  const unrolled = expandLiteralForLoops(cmd);
  const source = unrolled ?? String(cmd);
  const values = literalAssignments(source);
  if (values.size === 0) {
    if (unrolled === null) return null;
    return hasActiveShellExpansion(stripQuotedHeredocBodies(unrolled)) ? null : unrolled;
  }
  let resolved = source;
  for (const [name, value] of values) {
    if (value === null) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    resolved = resolved
      .replace(new RegExp(`\\$\\{${escaped}\\}`, 'gu'), value)
      .replace(new RegExp(`\\$${escaped}(?![A-Za-z0-9_])`, 'gu'), value);
  }
  // Judge resolvability on the SAME text the detector judges: a quoted heredoc
  // body is inert, so a `$?` or `$(date)` sitting in prose there must not defeat
  // resolution. The detector was taught this (see stripQuotedHeredocBodies
  // below) and this path was not, so `SP=/tmp/x` + `cat > $SP/msg.txt <<'EOF'`
  // was refused whenever the MESSAGE mentioned a command substitution — which is
  // exactly what a commit message describing shell work does. Same bug as the
  // backticked-prose refusal that comment records, one call site later.
  return hasActiveShellExpansion(stripQuotedHeredocBodies(resolved)) ? null : resolved;
}

// A heredoc whose delimiter is quoted (`<<'EOF'`, `<<"EOF"`) has a LITERAL body:
// the shell performs no expansion and no command substitution inside it. Scanning
// that body for expansion syntax therefore reads prose as code — a reconcile
// commit message carrying backticks around `m` and `scaffold.mjs --reconcile` was
// refused as command substitution, and the loop could not write its own commit.
//
// Only the quoted form is stripped. An UNQUOTED `<<EOF` body genuinely does
// expand, so it stays in the text the expansion check sees; `stripHeredocs`
// removes both kinds alike and is deliberately not reused here, because doing so
// would turn `<<EOF` with `$(...)` into a blind spot.
export function stripQuotedHeredocBodies(cmd) {
  return String(cmd).replace(
    /<<[-~]?[ \t]*(['"])([A-Za-z_][A-Za-z0-9_-]*)\1[^\n]*\r?\n[\s\S]*?\r?\n[ \t]*\2(?![A-Za-z0-9_-])/g,
    (match) => match.slice(0, match.indexOf('\n')),
  );
}

function opaqueMutationSyntax(cmd) {
  return hasActiveShellExpansion(stripQuotedHeredocBodies(cmd));
}

function interpreterHeredoc(cmd) {
  const interpreters =
    /(?:^|[\s;&|])(?:\/[^\s;&|]+\/)*(?:ba|da|k|z)?sh(?:\s|$)|(?:^|[\s;&|])(?:\/[^\s;&|]+\/)*(?:node|nodejs|bun|deno|perl|php|ruby|python(?:\d+(?:\.\d+)?)?)(?:\s|$)/u;
  const shellSources =
    /(?:^|[\s;&|])(?:source(?=\s|$)|\.(?=\s|$))/u;
  const logicalLines = String(cmd).replace(/\\\r?\n/gu, ' ');
  return logicalLines.split(/\r?\n/u).some((line) =>
    /<<[-~]?[ \t]*(?:['"]?)[A-Za-z_][A-Za-z0-9_-]*(?:['"]?)/u.test(line)
    && (
      interpreters.test(executableLexicalText(line))
      || shellSources.test(executableLexicalText(line))
    ));
}

function inlineInterpreterSource(cmd) {
  const sourceFlags = new Set([
    '-c',
    '-e',
    '-E',
    '-p',
    '-r',
    '--eval',
    '--print',
  ]);
  // Flags that make an interpreter print and exit without reading any source.
  // Long forms only, and deliberately: `-v` is the version flag for node, ruby,
  // php and perl but means "verbose" for python, where a script is still read
  // from stdin. The long spelling is unambiguous for every interpreter below.
  const terminalFlags = new Set(['--version', '--help']);
  const interpreters = new Set([
    'bash',
    'bun',
    'dash',
    'deno',
    'ksh',
    'lua',
    'luajit',
    'node',
    'nodejs',
    'osascript',
    'perl',
    'php',
    'python',
    'python2',
    'python3',
    'ruby',
    'R',
    'Rscript',
    'sh',
    'tclsh',
    'wish',
    'zsh',
  ]);
  return shellSegments(executableLexicalText(cmd)).some(({ command }) => {
    const words = shellWords(command);
    if (isLookupSegment(words)) return false;
    const shellSource = words.findIndex((word) =>
      word === 'source' || word === '.');
    if (
      shellSource !== -1
      && words.slice(shellSource + 1).some((argument) =>
        argument === '-'
        || /^\/dev\/(?:stdin|fd\/[0-9]+)$/u.test(argument)
        || /^\/proc\/(?:self|thread-self|[0-9]+)\/fd\/[0-9]+$/u.test(argument))
    ) {
      return true;
    }
    return words.some((word, index) => {
      const executable = word.slice(word.lastIndexOf('/') + 1);
      if (
        !interpreters.has(executable)
        && !/^python\d+(?:\.\d+)?$/u.test(executable)
      ) {
        return false;
      }
      const argumentsAfterExecutable = words.slice(index + 1);
      if (argumentsAfterExecutable.some(
        (argument) =>
          sourceFlags.has(argument)
          || argument === '-'
          || /^\/dev\/(?:stdin|fd\/[0-9]+)$/u.test(argument)
          || /^\/proc\/(?:self|thread-self|[0-9]+)\/fd\/[0-9]+$/u.test(argument)
          || /^-[A-Za-z]*[ceEpr][A-Za-z]*$/u.test(argument),
      )) {
        return true;
      }
      // A word that merely NAMES an interpreter is data, not an invocation —
      // `git log | grep node` searches for a string; refusing it reads a grep
      // pattern as an interpreter waiting on stdin (same lesson as
      // EXEC_WRAPPERS below). The source-flag shapes above stay position-
      // blind, so `find . -exec node -e …` remains opaque wherever the name
      // sits.
      if (!invokedAt(words, index)) return false;
      if (argumentsAfterExecutable.length === 0) return true;
      // A probe that only prints a version or a usage banner executes nothing,
      // so it is not the no-script-argument stdin shape the return below cat-
      // ches. Checked after the source-flag test, so `node --version -e '...'`
      // still blocks on the `-e`.
      if (argumentsAfterExecutable.every((argument) => terminalFlags.has(argument))) {
        return false;
      }
      return !argumentsAfterExecutable.some((argument) => !argument.startsWith('-'));
    });
  });
}

// Returns the SHAPE that fired, not just a boolean, so the refusal can name the
// command to run instead. A refusal that names only its category makes the
// reader reverse-engineer the guard: a live session lost a round to
// `ls -d … | xargs -n1 basename` -- a plain listing -- because the advice
// ("use literal canonical commands") never said which literal command that was.
function opaqueCommandAssembler(cmd) {
  return shellSegments(executableLexicalText(cmd)).reduce((found, { command }) => {
    if (found !== null) return found;
    const words = shellWords(command);
    if (isLookupSegment(words)) return found;
    // Positional for the same reason as inlineInterpreterSource: an assembler
    // NAME in argument position is data (`git log --grep xargs`), not a fan-out.
    const invokes = (executable) => {
      const index = executableIndex(words, executable);
      return index !== -1 && invokedAt(words, index) ? index : -1;
    };
    if (invokes('xargs') !== -1 || invokes('parallel') !== -1) {
      return 'fanout';
    }
    for (const executable of ['awk', 'gawk', 'mawk', 'nawk']) {
      const index = invokes(executable);
      if (index === -1) continue;
      const argumentsAfterExecutable = words.slice(index + 1);
      const fileBacked = argumentsAfterExecutable.some(
        (argument) =>
          argument === '-f'
          || argument === '--file'
          || argument.startsWith('--file='),
      );
      if (!fileBacked) return 'awk';
    }
    return null;
  }, null);
}

// Names the token that defeated resolution, and the remedy for the SHAPE that
// produced it. The old text said "can hide a mutation. Use literal canonical
// commands; split discovery and mutation into separate tool calls." — generic,
// and worse than generic on a read-only measurement: it warns about a mutation
// that is not there while saying nothing about the loop variable that actually
// blocked. A live run lost rounds to `for s in …; do sed …; done` reading it.
const LOOP_KEYWORD = /(?:^|[\s;&|(])(?:for|while|until)(?=\s)/u;

// Joins the named tokens as English, not as a comma-splice. A live refusal read
// "`$p`, a command substitution cannot be resolved statically", which parses as
// one garbled subject and buries the fact that TWO different things must be
// fixed. The count is also stated rather than truncated: naming three of five
// and stopping sends the reader back for a second refusal having fixed
// everything the message mentioned — the same silent-cap failure the workflow
// rules forbid elsewhere.
const MAX_NAMED_TOKENS = 3;

export function nameList(tokens) {
  if (tokens.length === 0) return '';
  const shown = tokens.slice(0, MAX_NAMED_TOKENS);
  const hidden = tokens.length - shown.length;
  if (hidden > 0) {
    return `${shown.join(', ')} and ${hidden} more unresolved ${hidden === 1 ? 'token' : 'tokens'}`;
  }
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

export function unresolvedExpansionReason(rawCmd) {
  const text = stripQuotedHeredocBodies(String(rawCmd));
  const assigned = new Set(
    [...literalAssignments(text).keys()].filter((name) => literalAssignments(text).get(name) !== null),
  );
  const tokens = [...text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?|\$\(|`|\$([?$!*@#-]|\d)/gu)]
    .map((match) => {
      if (match[0].startsWith('$(') || match[0] === '`') return 'a command substitution';
      if (match[2] !== undefined) return `\`$${match[2]}\``;
      return assigned.has(match[1]) ? null : `\`$${match[1]}\``;
    })
    .filter((token) => token !== null);
  const named = nameList([...new Set(tokens)]);
  const what = named === ''
    ? 'this command carries an expansion the guard cannot read'
    : `${named} cannot be resolved statically`;
  // 2026-07-29: `for f in <dir>/*.json; do jq -c <filter> "$f"; done` — the loop
  // was pure ceremony, because jq (like rg, wc, cat, grep) takes many paths at
  // once and the glob can simply be the argument. Advising "one tool call each"
  // for a case that needs exactly one call is the shape-shaped advice the
  // assembler remedies were already taught out of, so the no-loop spelling
  // comes first and the per-iteration fallback stays for loops that need it.
  if (LOOP_KEYWORD.test(text)) {
    return `${what} — a loop variable takes a new value each iteration, so the guard `
      + 'cannot know what runs. Most file loops need no loop at all: `jq`, `rg`, `grep`, `wc` and '
      + '`cat` each take many paths at once, so pass the glob as the argument — '
      + '`jq -c <filter> <dir>/*.json` reads every file in ONE call. Otherwise write the '
      + 'iterations as literal commands (one tool call each is fine), or put the loop in a '
      + 'reviewed program file and run that.';
  }
  // `$?` has no literal to assign, so the generic "assign it in the same
  // command" advice is impossible rather than merely unhelpful. The exit status
  // is already available twice over without it.
  if (/\$\?/u.test(text)) {
    return `${what}. An exit status has no literal form: the tool runner already reports a `
      + 'non-zero exit, and the typed tools carry their outcome in their own output '
      + '(`ok: false` beside the reason) — read that instead of capturing it.';
  }
  // A command substitution has no literal to assign either — its value is
  // whatever the inner command PRINTS, which is exactly what cannot be known
  // before running it. Telling the reader to "assign it a literal" is advice
  // they cannot follow, the same defect the `$?` branch above exists to avoid.
  // A live run measuring per-package sizes hit this and had nowhere to go.
  // 2026-07-29: the alternatives named were BOTH measurements, so a session
  // wanting one method body — grep for the signature, feed its line number to
  // `sed -n` — was answered with `wc -l` and `git diff --shortstat` and had
  // nowhere to go again. Locating a definition and reading around it is the
  // commonest reason to reach for a substitution at all, and unlike a
  // measurement it has an exact one-command answer, so it is named first.
  if (tokens.every((token) => token === 'a command substitution')) {
    return `${what}, because its value is whatever the inner command prints and that is not `
      + 'knowable before running it. Run the inner command as its own call and use the value it '
      + 'returns, or pick a spelling that needs no substitution. To read the region around a '
      + 'match — the usual reason to feed `grep -n` into `sed` — `rg -n -A<lines> <pattern> '
      + '<file>` prints the match and what follows in one pass, and the host file-reading tool '
      + 'takes an offset and a line count directly. To measure, `wc -l <paths>` and '
      + '`git diff --shortstat` print their numbers directly. A real program goes in a file.';
  }
  return `${what}, so command policy cannot judge what would run. Assign it a literal in the `
    + 'SAME command and the guard substitutes it and judges the real thing; otherwise use '
    + 'literal canonical commands, or a reviewed program file.';
}

const ASSEMBLER_REMEDY = Object.freeze({
  fanout: '`xargs` and `parallel` build commands out of data the guard cannot read. '
    + 'To LIST, run the plain command alone (`ls -1 <dir>`) — the output is yours to '
    + 'read directly. To ACT on each entry, write a reviewed program file and run it.',
  // Naming only the file form made the remedy read as "do something absurd":
  // a live run was blocked extracting a number from `git diff --stat` and
  // authoring an awk FILE for that is more ceremony than the measurement. The
  // fanout remedy above already learned this — name the command to run instead.
  awk: 'Inline `awk` program text is source code in an argument. Most loop uses of it are a '
    + 'measurement with a plainer spelling: `git diff --shortstat` for insert/delete counts, '
    + '`wc -l` for a line count, `cut -f<n>` for a column, `sort | uniq -c` for a tally. '
    // 2026-07-29: `sed -n <range>p file | cat -n | awk '{print $1+<offset>, ...}'` — the awk
    // existed only to undo `cat -n` renumbering from 1, which happens only because `sed` ran
    // FIRST. Number before slicing and the arithmetic disappears, so the remedy names the
    // pipeline order rather than a plainer measurement, none of which reads a region.
    + 'To read a NUMBERED region, number before slicing — `cat -n <file> | sed -n <first>,<last>p` '
    + 'keeps the real line numbers, while slicing first makes `cat -n` restart at 1 and is the '
    + 'usual reason to reach for `awk` arithmetic here. The host file-reading tool takes an offset '
    + 'and a line count directly. '
    + 'To total a diff while EXCLUDING paths — the reviewable-surface measurement that most often '
    + 'reaches for `awk` over `--numstat` — git does it natively: '
    + "`git diff --shortstat <range> -- . ':(exclude)<glob>'`. "
    + 'To splice one file into another — a findings block into a prompt template — do not template '
    + 'at all: write the parts and `cat head.md findings.md tail.md > prompt.md`, or for JSON use '
    + '`jq -n --rawfile <name> <file>`. A placeholder line that has to be found and replaced is an '
    + 'interpreter program; a file boundary is not. '
    + 'For a real program, put it in a file and run `awk -f <file>`.',
});

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

function executableIndex(words, executable) {
  return words.findIndex(
    (word) => word === executable || word.endsWith(`/${executable}`),
  );
}

// Wrappers that pass execution through to their argument; anything else in
// front of `git`/`gh` means the word is an ARGUMENT, not an invocation — a live
// section banner (`echo "=== git diffstat ==="`) read as an unknown subcommand
// because the executable was found anywhere in the segment.
// Every entry runs the command that FOLLOWS it, so the word after one is still
// an invocation. The list is load-bearing in both directions: too narrow and
// `time xargs …` slips past the rules below by sitting one word off the front.
const EXEC_WRAPPERS = new Set([
  'command',
  'doas',
  'env',
  'exec',
  'ionice',
  'nice',
  'nohup',
  'setsid',
  'stdbuf',
  'sudo',
  'time',
  'timeout',
]);

// find(1) hands the words after these flags to the kernel verbatim, so the
// word after the flag is an invocation even though it is not segment-initial.
const EXEC_FORWARDING_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

function invokedAt(words, index) {
  return inExecutablePosition(words, index)
    || EXEC_FORWARDING_FLAGS.has(words[index - 1]);
}

// `command -v php` ASKS WHERE php IS. It does not run it — that is the entire
// difference `-v`/`-V` make to the builtin. But `command` is a passthrough
// wrapper, so without this the name behind it reads as an invocation with no
// script argument, which is the stdin shape, and a discoverability probe gets
// refused as inline interpreter source. A live setup lost a round to
// `command -v php` while checking whether its configured gate still resolves —
// the check this plugin's own setup skill asks for. `which php` and
// `type -p python3` were never affected: neither is a wrapper, so the name
// after them was already in argument position.
function isLookupSegment(words) {
  const index = executableIndex(words, 'command');
  if (index === -1 || !inExecutablePosition(words, index)) return false;
  return words.slice(index + 1).some((word) => /^-[A-Za-z]*[vV][A-Za-z]*$/u.test(word));
}

function inExecutablePosition(words, position) {
  for (let index = 0; index < position; index += 1) {
    const word = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;      // VAR=value prefix
    if (EXEC_WRAPPERS.has(word.slice(word.lastIndexOf('/') + 1))) continue;
    if (/^-/.test(word)) continue;                             // wrapper flags
    if (/^[0-9]+[smhd]?$/.test(word)) continue;                // timeout duration
    return false;
  }
  return true;
}

function commandAfterGlobalOptions(words, executable, optionsWithValues) {
  const executablePosition = executableIndex(words, executable);
  if (executablePosition === -1) return null;
  if (!inExecutablePosition(words, executablePosition)) return null;
  for (let index = executablePosition + 1; index < words.length; index += 1) {
    const word = words[index];
    if (optionsWithValues.has(word)) {
      index += 1;
      continue;
    }
    if (
      [...optionsWithValues].some((option) => word.startsWith(`${option}=`))
      || word.startsWith('-')
    ) {
      continue;
    }
    return word;
  }
  return null;
}

function unknownAmbientAliasSyntax(cmd) {
  return shellSegments(cmd).some(({ command }) => {
    const words = shellWords(command);
    const gitCommand = commandAfterGlobalOptions(
      words,
      'git',
      new Set([
        '-C',
        '-c',
        '--config-env',
        '--exec-path',
        '--git-dir',
        '--namespace',
        '--super-prefix',
        '--work-tree',
      ]),
    );
    if (gitCommand !== null && !GIT_COMMANDS.has(gitCommand)) return true;
    const ghCommand = commandAfterGlobalOptions(
      words,
      'gh',
      new Set(['-R', '--hostname', '--repo']),
    );
    return ghCommand !== null && !GH_COMMANDS.has(ghCommand);
  });
}

function gitSubcommandIndex(words, subcommand) {
  const git = executableIndex(words, 'git');
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

function hasCommandLineGitAlias(words) {
  const git = executableIndex(words, 'git');
  if (git === -1) return false;
  for (let index = git + 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === '-c') {
      const setting = words[index + 1] ?? '';
      if (/^(?:alias\.|include(?:if\..+)?\.path(?:=|$))/i.test(setting)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (
      /^-calias\./i.test(word)
      || /^-cinclude(?:if\..+)?\.path(?:=|$)/i.test(word)
      || /^--config-env=(?:alias\.|include(?:if\..+)?\.path=)/i.test(word)
    ) {
      return true;
    }
    if (!word.startsWith('-')) return false;
  }
  return false;
}

function hasCommandLineGitConfig(words) {
  const git = executableIndex(words, 'git');
  if (git === -1) return false;
  return words.slice(0, git).some((word) => /^GIT_CONFIG(?:_|=)/u.test(word))
    || words.slice(git + 1).some(
      (word) =>
        word === '-c'
        || /^-c.+/u.test(word)
        || word === '--config-env'
        || word.startsWith('--config-env='),
    );
}

function switchTarget(words, baseBranch) {
  const switchIndex = gitSubcommandIndex(words, 'switch');
  const checkoutIndex = gitSubcommandIndex(words, 'checkout');
  const index = switchIndex === -1 ? checkoutIndex : switchIndex;
  if (index === -1) return null;
  const checkout = checkoutIndex !== -1;
  if (checkout && words.slice(index + 1).includes('--')) return null;
  const tracking = words.slice(index + 1).some(
    (word) => word === '-t' || word === '--track' || word.startsWith('--track='),
  );
  for (let i = index + 1; i < words.length; i += 1) {
    const word = words[i];
    if (BRANCH_CREATION_FLAGS.has(word)) return words[i + 1] ?? null;
    const branchFlag = [...BRANCH_CREATION_FLAGS].find((flag) => word.startsWith(`${flag}=`));
    if (branchFlag) return word.slice(branchFlag.length + 1) || null;
    if (word === '--detach') return null;
    if (word.startsWith('-')) continue;
    if (!checkout) return word === '-' ? baseBranch : tracking ? trackedBranch(word) : word;
    if (tracking) return trackedBranch(word);
    const target = normalizedBranch(word);
    if (target === baseBranch || LOOP_BRANCH_RE.test(target) || word.startsWith('refs/heads/')) {
      return word;
    }
    return word === '-' ? baseBranch : null;
  }
  return null;
}

function normalizedBranch(ref) {
  return String(ref ?? '').replace(/^refs\/heads\//, '');
}

function refTargetsBranch(ref, branch) {
  const pattern = normalizedBranch(ref);
  const wildcard = pattern.indexOf('*');
  if (wildcard === -1) return pattern === branch;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  return (
    branch.length >= prefix.length + suffix.length
    && branch.startsWith(prefix)
    && branch.endsWith(suffix)
  );
}

function longOptionPrefix(argument, option) {
  const name = String(argument ?? '').split('=', 1)[0];
  return name.startsWith('--')
    && name.length >= 3
    && option.startsWith(name);
}

function trackedBranch(ref) {
  const remoteRef = String(ref ?? '').replace(/^refs\/remotes\//, '');
  const separator = remoteRef.indexOf('/');
  return separator === -1 ? remoteRef : remoteRef.slice(separator + 1);
}

function pushTargetsBase(words, branches, baseBranch) {
  const index = gitSubcommandIndex(words, 'push');
  if (index === -1) return false;
  const args = words.slice(index + 1);
  if (args.some((arg) =>
    [...BULK_PUSH_FLAGS].some((flag) => longOptionPrefix(arg, flag)))) {
    return true;
  }
  const deleteMode = args.includes('--delete') || args.includes('-d');
  const optionsWithValues = [
    '--repo',
    '--receive-pack',
    '--exec',
    '--push-option',
    '-o',
  ];
  const positional = [];
  let repositoryFromOption = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const option = optionsWithValues.find((candidate) =>
      longOptionPrefix(arg, candidate));
    if (option && !arg.includes('=')) {
      if (option === '--repo') repositoryFromOption = true;
      i += 1;
      continue;
    }
    if (option && arg.includes('=')) {
      if (option === '--repo') repositoryFromOption = true;
      continue;
    }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  const refspecs = positional.slice(repositoryFromOption ? 0 : 1);
  if (refspecs.length === 0) return true;
  return refspecs.some((refspec) => {
    const clean = refspec.replace(/^\+/, '');
    if (clean === ':') return true;
    const colon = clean.lastIndexOf(':');
    if (colon === -1 && CURRENT_BRANCH_REFS.has(clean) && branches.has(baseBranch)) {
      return true;
    }
    const destination = colon === -1 ? clean : clean.slice(colon + 1);
    if (!destination && !deleteMode) return false;
    return refTargetsBranch(destination, baseBranch);
  });
}

function pushesReleaseTag(words) {
  const index = gitSubcommandIndex(words, 'push');
  if (index === -1) return false;
  return words.slice(index + 1).some((argument) => {
    const value = argument.replace(/^\+/, '');
    return longOptionPrefix(value, '--tags')
      || longOptionPrefix(value, '--follow-tags')
      || value.includes('refs/tags/')
      || value.split(':').some((ref) =>
        /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(ref));
  });
}

function isInlineGhBody(words) {
  const gh = executableIndex(words, 'gh');
  if (gh === -1) return false;
  const scope = words.findIndex((word, index) => index > gh && (word === 'pr' || word === 'issue'));
  const action = words[scope + 1];
  if (scope === -1 || !new Set(['create', 'comment', 'review', 'edit']).has(action)) return false;
  return words.some(
    (word) =>
      word === '--body'
      || word === '-b'
      || /^-[^-]*b.*$/u.test(word)
      || (word.startsWith('--body=') && !word.startsWith('--body-file=')),
  );
}

function hasGhScopedAction(words, scope, action) {
  const gh = executableIndex(words, 'gh');
  if (gh === -1) return false;
  const scopeIndex = words.indexOf(scope, gh + 1);
  return scopeIndex !== -1 && words.indexOf(action, scopeIndex + 1) !== -1;
}

function optionValues(words, option, shortOption) {
  const values = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === option || word === shortOption) {
      values.push(words[index + 1] ?? '');
      index += 1;
    } else if (word.startsWith(`${option}=`)) {
      values.push(word.slice(option.length + 1));
    } else if (
      shortOption !== undefined
      && word.startsWith(shortOption)
      && word.length > shortOption.length
    ) {
      values.push(word.slice(shortOption.length));
    }
  }
  return values;
}

const PROTECTED_LIFECYCLE_LABELS = new Set([
  'loop-delivered',
  'loop-ready',
]);

function protectedLifecycleLabel(value) {
  return PROTECTED_LIFECYCLE_LABELS.has(value.trim().toLowerCase());
}

function addsProtectedLifecycleLabel(words) {
  const edit =
    hasGhScopedAction(words, 'issue', 'edit')
    || hasGhScopedAction(words, 'pr', 'edit');
  return edit && optionValues(words, '--add-label').some((value) =>
    value.split(',').some(protectedLifecycleLabel));
}

function renamesProtectedLifecycleLabel(words) {
  return hasGhScopedAction(words, 'label', 'edit')
    && optionValues(words, '--name', '-n').some(
      protectedLifecycleLabel,
    );
}

function createsProtectedLifecycleLabel(words) {
  if (!hasGhScopedAction(words, 'label', 'create')) return false;
  const label = words.indexOf('label');
  const create = words.indexOf('create', label + 1);
  return create !== -1
    && (words[create + 1] ?? '').trim().toLowerCase() === 'loop-ready';
}

function mutatingGhApi(words) {
  const gh = executableIndex(words, 'gh');
  const api = words.indexOf('api', gh + 1);
  if (gh === -1 || api === -1) return false;
  const args = words.slice(api + 1);
  let method = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '-X' || argument === '--method') {
      method = args[index + 1]?.toUpperCase() ?? null;
      index += 1;
    } else if (/^-X[A-Za-z]+$/u.test(argument)) {
      method = argument.slice(2).toUpperCase();
    } else if (argument.startsWith('--method=')) {
      method = argument.slice('--method='.length).toUpperCase();
    }
  }
  if (method === null && args.some((argument) =>
    argument === '--input'
    || argument.startsWith('--input=')
    || argument === '-f'
    || argument === '-F'
    || argument === '--field'
    || argument === '--raw-field'
    || /^-[fF].+/u.test(argument)
    || argument.startsWith('--field=')
    || argument.startsWith('--raw-field='))) {
    method = 'POST';
  }
  return method !== null && !new Set(['GET', 'HEAD']).has(method);
}

function normalizedGithubApiEndpoint(value) {
  if (typeof value !== 'string') return null;
  const prefix = 'https://api.github.com/';
  let endpoint;
  if (value.startsWith(prefix)) {
    endpoint = value.slice(prefix.length);
  } else {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return null;
    endpoint = value.replace(/^\/+/u, '');
  }
  endpoint = endpoint.split(/[?#]/u, 1)[0];
  if (!endpoint || /\s/u.test(endpoint)) return null;
  try {
    const segments = endpoint.split('/').map((segment) =>
      decodeURIComponent(segment));
    return segments.every((segment) => segment.length > 0) ? segments : null;
  } catch {
    return null;
  }
}

function githubApiEndpoints(words) {
  const gh = executableIndex(words, 'gh');
  const api = words.indexOf('api', gh + 1);
  if (gh === -1 || api === -1) return [];
  return words
    .slice(api + 1)
    .map(normalizedGithubApiEndpoint)
    .filter((endpoint) => endpoint !== null);
}

function githubApiFieldAssignments(words) {
  const gh = executableIndex(words, 'gh');
  const api = words.indexOf('api', gh + 1);
  if (gh === -1 || api === -1) return [];
  const args = words.slice(api + 1);
  const assignments = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (['-f', '-F', '--field', '--raw-field'].includes(argument)) {
      assignments.push(args[index + 1] ?? '');
      index += 1;
    } else if (/^-[fF].+/u.test(argument)) {
      assignments.push(argument.slice(2));
    } else {
      const match = argument.match(/^--(?:field|raw-field)=(.*)$/u);
      if (match) assignments.push(match[1]);
    }
  }
  return assignments.map((assignment) => {
    const separator = assignment.indexOf('=');
    return {
      name: separator === -1 ? assignment : assignment.slice(0, separator),
      value: separator === -1 ? '' : assignment.slice(separator + 1),
    };
  });
}

function hasInputOption(words) {
  return words.some(
    (word) => word === '--input' || word.startsWith('--input='),
  );
}

function opaqueIssueLabelApiMutation(words) {
  if (!mutatingGhApi(words)) return false;
  const endpoint = githubApiEndpoints(words).find((segments) =>
    segments.length >= 5
    && segments[0] === 'repos'
    && segments[1].length > 0
    && segments[2].length > 0
    && segments[3] === 'issues'
    && /^[1-9][0-9]*$/u.test(segments[4]));
  if (!endpoint) return false;
  if (endpoint.length === 6 && endpoint[5] === 'labels') return true;
  if (endpoint.length !== 5) return false;
  return hasInputOption(words)
    || githubApiFieldAssignments(words).some(
      ({ name }) => name === 'labels' || name === 'labels[]',
    )
    || words.some((word) => word.toLowerCase().includes('loop-delivered'));
}

function terminalLabelApiRename(words) {
  if (!mutatingGhApi(words)) return false;
  const endpoint = githubApiEndpoints(words).some((segments) =>
    segments.length === 5
    && segments[0] === 'repos'
    && segments[1].length > 0
    && segments[2].length > 0
    && segments[3] === 'labels'
    && segments[4].length > 0);
  if (!endpoint) return false;
  if (hasInputOption(words)) return true;
  return githubApiFieldAssignments(words).some(
    ({ name, value }) =>
      name === 'new_name'
      && (
        protectedLifecycleLabel(value)
        || value.startsWith('@')
      ),
  );
}

function protectedLabelApiCreate(words) {
  if (!mutatingGhApi(words)) return false;
  const endpoint = githubApiEndpoints(words).some((segments) =>
    segments.length === 4
    && segments[0] === 'repos'
    && segments[1].length > 0
    && segments[2].length > 0
    && segments[3] === 'labels');
  if (!endpoint) return false;
  if (hasInputOption(words)) return true;
  return githubApiFieldAssignments(words).some(
    ({ name, value }) =>
      name === 'name'
      && (
        value.startsWith('@')
        || value.trim().toLowerCase() === 'loop-ready'
      ),
  );
}

function decodeUnicodeEscapes(value) {
  const decode = (match, digits) => {
    const codePoint = Number.parseInt(digits, 16);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  };
  return value
    .replace(/\\?u\{([0-9a-fA-F]{1,6})\}/gu, decode)
    .replace(/\\?u([0-9a-fA-F]{4})/gu, decode);
}

function terminalGraphqlMutation(command) {
  const words = shellWords(command);
  const gh = executableIndex(words, 'gh');
  const api = words.indexOf('api', gh + 1);
  const graphql = words.indexOf('graphql', api + 1);
  if (gh === -1 || api === -1 || graphql === -1) return false;
  const fields = githubApiFieldAssignments(words);
  const decodedCommand = decodeUnicodeEscapes(command);
  const updateIssueLabels = /\bupdateIssue\b/u.test(command)
    && (
      /\b(?:labels|labelIds)\s*:/u.test(command)
      || /\$(?:labels|labelIds)\b/u.test(command)
      || fields.some(({ name }) => name === 'labels' || name === 'labelIds')
    );
  const updateLabelName = /\bupdateLabel\b/u.test(command)
    && (
      /\bloop-(?:delivered|ready)\b/iu.test(decodedCommand)
      || fields.some(
        ({ name, value }) =>
          name === 'name'
          && (
            protectedLifecycleLabel(value)
            || value.startsWith('@')
          ),
      )
    );
  const createReadyLabel = /\bcreateLabel\b/u.test(command)
    && (
      /\bloop-ready\b/iu.test(decodedCommand)
      || fields.some(
        ({ name, value }) =>
          name === 'name'
          && (
            value.trim().toLowerCase() === 'loop-ready'
            || value.startsWith('@')
          ),
      )
    );
  return updateIssueLabels || updateLabelName || createReadyLabel;
}

function hasOpaqueGraphqlInput(words) {
  const gh = executableIndex(words, 'gh');
  const api = words.indexOf('api', gh + 1);
  const graphql = words.indexOf('graphql', api + 1);
  if (gh === -1 || api === -1 || graphql === -1) return false;
  const args = words.slice(api + 1);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--input' || argument.startsWith('--input=')) return true;
    if (
      ['-F', '--field'].includes(argument)
      && /^query=@/u.test(args[index + 1] ?? '')
    ) {
      return true;
    }
    if (/^(?:-F|--field=)query=@/u.test(argument)) return true;
  }
  return false;
}

/**
 * Pure rule evaluation — returns { block: boolean, reason?: string }.
 * `branch` is the current Git branch; null keeps branch-sensitive mutations fail-closed.
 */
export function evaluate(rawCmd, branch, options = {}) {
  if (typeof rawCmd !== 'string' || rawCmd.length === 0) return { block: false };
  if (interpreterHeredoc(rawCmd)) {
    return {
      block: true,
      reason:
        'autoloop guard — a shell or language interpreter reading a heredoc is opaque to '
        + 'command policy. Write the script to a file and run it, or use the typed tool commands.',
    };
  }
  // "Write the script to a file" names no command, which is the shape-shaped
  // advice the assembler remedies were already taught out of: authoring a file
  // to inspect an alias is more ceremony than the question. 2026-07-29:
  // `zsh -ic 'alias | grep -i <name>; whence -w <name>'` — asking a live
  // interactive shell what a name resolves to, when the definition is sitting
  // in a file that can simply be read.
  if (inlineInterpreterSource(rawCmd)) {
    return {
      block: true,
      reason:
        'autoloop guard — inline shell or language-interpreter source is opaque to command '
        + 'policy. To learn what a shell name resolves to or what a startup file does, read the '
        + 'file — `rg -n <name> ~/.zshrc` — instead of starting an interactive shell to ask it. '
        + 'To check that a file parses, the interpreter does it directly: `zsh -n <file>`, '
        + '`node --check <file>`. For a real program, write it to a file and run that.',
    };
  }
  const assembler = opaqueCommandAssembler(rawCmd);
  if (assembler !== null) {
    return {
      block: true,
      reason:
        'autoloop guard — inline command assembly is opaque to command policy. '
        + ASSEMBLER_REMEDY[assembler],
    };
  }
  if (opaqueMutationSyntax(rawCmd)) {
    // Resolve literal assignments once and judge the substituted command. The
    // recursion cannot loop: the resolved text carries no expansion left to
    // resolve (resolveShellExpansions returns null otherwise).
    const resolved = options.expansionResolved ? null : resolveShellExpansions(rawCmd);
    if (resolved !== null) {
      return evaluate(resolved, branch, { ...options, expansionResolved: true });
    }
    // Report on what is ACTUALLY unresolvable. A literal loop expands, so a
    // refusal that still names its loop variable sends the reader to fix the
    // one part that was never the problem: `for d in a b; do echo $(wc -l $d);
    // done` blocks on the command substitution alone, and naming `$d` beside it
    // — with the loop remedy attached — describes a command the guard would
    // otherwise have accepted. Expansion is best-effort here: if it cannot
    // unroll, the raw text is still the honest subject.
    const reportSubject = expandLiteralForLoops(rawCmd) ?? rawCmd;
    return {
      block: true,
      reason: `autoloop guard — ${unresolvedExpansionReason(reportSubject)}`,
    };
  }
  const cmd = stripHeredocs(rawCmd);
  const lexicalCmd = executableLexicalText(cmd);
  const baseBranch = options.baseBranch ?? 'main';

  if (unknownAmbientAliasSyntax(lexicalCmd)) {
    return {
      block: true,
      reason:
        'autoloop guard — an unknown Git or GitHub CLI command may resolve through an ambient '
        + 'alias. Use a canonical built-in subcommand.',
    };
  }

  if (structuredGitMutation(cmd)) {
    return {
      block: true,
      reason:
        'autoloop guard — grouped or substituted Git commit/push syntax can hide branch and '
        + 'destination state. Run the canonical Git command without shell grouping or '
        + 'substitution.',
    };
  }

  // 1. never merge — structural: `pr` then `merge` must be gh's positional
  // subcommand words. A free-text scan also matched option arguments, so a PR
  // *title* containing "merge policy" tripped L2 (live run 3bdd6e5e). Expansion,
  // substitution, and inline-interpreter evasions are blocked before this rule.
  const ghPrMergeInvocation = shellSegments(lexicalCmd).some(({ command }) => {
    const words = shellWords(command);
    const options = new Set(['-R', '--hostname', '--repo']);
    const executablePosition = executableIndex(words, 'gh');
    if (executablePosition === -1) return false;
    const positionals = [];
    for (
      let index = executablePosition + 1;
      index < words.length && positionals.length < 2;
      index += 1
    ) {
      const word = words[index];
      if (options.has(word)) {
        index += 1;
        continue;
      }
      if (
        [...options].some((option) => word.startsWith(`${option}=`))
        || word.startsWith('-')
      ) {
        continue;
      }
      positionals.push(word);
    }
    return positionals[0] === 'pr' && positionals[1] === 'merge';
  });
  if (ghPrMergeInvocation) {
    return {
      block: true,
      reason:
        'autoloop guard — `gh pr merge` is outside loop authority: the loop/agent never '
        + 'merges directly (docs/agentic/STATE.md → Autonomy). Leave the merge to a human, or '
        + 'to the repo-ratified tools/agentic/auto-merge.mjs policy gate.',
    };
  }

  const segments = shellSegments(lexicalCmd);
  // `--undo` REMOVES readiness: it returns a pull request to draft, which is the
  // state the loop is supposed to hold — one draft opened at claim, kept draft
  // until the terminal finalizer marks it ready under an exact-head binding. So
  // blocking it was direction-blind, the same defect as the `+<refspec>` force
  // test: the safe direction refused, with the message for the unsafe one. A
  // draft cannot be merged, so drafting can never deliver anything, and
  // returning a PR to draft is exactly what servicing one after a red check
  // wants. Matched as the exact token rather than a prefix: an abbreviation gh
  // rejects is a command that does nothing, but an abbreviation gh accepts and
  // this test misses would be a readiness mutation waved through.
  if (segments.some(({ command }) => {
    const words = shellWords(command);
    return hasGhScopedAction(words, 'pr', 'ready') && !words.includes('--undo');
  })) {
    return {
      block: true,
      reason:
        'autoloop guard — raw pull-request readiness mutation is outside loop authority. '
        + 'Use the exact-head Autoloop terminal finalizer. Returning a PR to draft is allowed '
        + '(`gh pr ready <N> --undo`) — it removes readiness rather than granting it.',
    };
  }
  if (segments.some(({ command }) =>
    addsProtectedLifecycleLabel(shellWords(command))
    || renamesProtectedLifecycleLabel(shellWords(command))
    || createsProtectedLifecycleLabel(shellWords(command)))) {
    return {
      block: true,
      reason:
        'autoloop guard — raw protected lifecycle-label mutation is outside loop authority. '
        + 'Ask a maintainer to apply `loop-ready`; deliver `loop-delivered` through the '
        + 'exact-head Autoloop terminal finalizer.',
    };
  }
  if (segments.some(({ command }) =>
    hasGhScopedAction(shellWords(command), 'release', 'create')
    || hasGhScopedAction(shellWords(command), 'release', 'delete')
    || hasGhScopedAction(shellWords(command), 'release', 'edit')
    || hasGhScopedAction(shellWords(command), 'release', 'upload')
    || pushesReleaseTag(shellWords(command)))) {
    return {
      block: true,
      reason:
        'autoloop guard — release and tag publication require an independent maintainer '
        + 'action; best-effort Autoloop invocation intent grants no release authority. '
        + 'Report release readiness and leave publication to the maintainer.',
    };
  }
  let states = [{ branch: branch ?? null, succeeded: null }];
  let previousOperator = null;
  for (const segment of segments) {
    const executes = states.filter(({ succeeded }) =>
      previousOperator === null
      || previousOperator === ';'
      || (previousOperator === '&&' && succeeded === true)
      || (previousOperator === '||' && succeeded === false));
    const skipped = states.filter((state) => !executes.includes(state));
    const possibleBranches = new Set(
      executes.map((state) => state.branch).filter(Boolean),
    );
    const words = shellWords(segment.command);
    if (hasCommandLineGitAlias(words)) {
      return {
        block: true,
        reason:
          'autoloop guard — command-scoped Git aliases or config includes can hide a protected '
          + 'mutation. Run the canonical Git subcommand without an alias override.',
      };
    }
    if (
      gitSubcommandIndex(words, 'push') !== -1
      && hasCommandLineGitConfig(words)
    ) {
      return {
        block: true,
        reason:
          'autoloop guard — command-scoped Git configuration can hide push destinations or '
          + 'force semantics. Run canonical `git push` without configuration overrides.',
      };
    }
    if (
      gitSubcommandIndex(words, 'commit') !== -1
      && (
        possibleBranches.has(baseBranch)
        || executes.some((state) => state.branch === null)
      )
    ) {
      return {
        block: true,
        reason:
          `autoloop guard — \`git commit\` may target configured base "${baseBranch}"; the `
          + 'base takes PRs only and the current branch must be proven. Create a working '
          + 'branch first: <type>/gh-<N>-<slug> (autoloop:dev step 4).',
      };
    }
    if (pushTargetsBase(words, possibleBranches, baseBranch)) {
      return {
        block: true,
        reason:
          `autoloop guard — \`git push\` targets or can resolve to configured base `
          + `"${baseBranch}"; the base takes PRs only. Push an explicit non-base refspec `
          + 'instead.',
      };
    }
    const target = switchTarget(words, baseBranch);
    const outcomes = [...skipped];
    for (const state of executes) {
      outcomes.push({
        branch: target ? normalizedBranch(target) : state.branch,
        succeeded: true,
      });
      outcomes.push({ branch: state.branch, succeeded: false });
    }
    states = [...new Map(
      outcomes.map((state) => [
        `${state.branch ?? ''}\0${state.succeeded}`,
        state,
      ]),
    ).values()];
    previousOperator = segment.next;
  }

  // 3. no co-author trailers (checked on the RAW command: the trailer rides in -m text)
  if (
    segments.some(
      ({ command }) => gitSubcommandIndex(shellWords(command), 'commit') !== -1,
    )
    && /Co-Authored-By:/i.test(executableLexicalText(rawCmd))
  ) {
    return {
      block: true,
      reason:
        'autoloop guard — this repo forbids Co-Authored-By trailers on commits (autoloop '
        + 'hard rules). Re-run the same commit without the trailer.',
    };
  }

  // 4. force pushes: only --force-with-lease. Catches both the `--force`/`-f` flags AND the
  //    `+<refspec>` force syntax (`git push origin +main`, incl. a quoted `'+refs/…'`), which
  //    force-updates a ref with neither flag.
  if (/\bgit\b[^\n]*\bpush\b/.test(lexicalCmd)) {
    const flagForce = segments.some(({ command }) => {
      const words = shellWords(command);
      const push = gitSubcommandIndex(words, 'push');
      return push !== -1 && words.slice(push + 1).some(
        (word) =>
          longOptionPrefix(word, '--force')
          || /^-[^-]*f[^-]*$/u.test(word),
      );
    });
    // Scoped to the words AFTER `push`, exactly as flagForce above is. Testing
    // the whole command line meant any `+`-prefixed token in ANY segment read as
    // a force refspec: 2026-07-29 a plain
    // `git push origin HEAD:refs/heads/<branch>; …; date +%H:%M` was refused as
    // destructive, because `+%H:%M` matched. shellWords strips quotes, so a
    // quoted `'+refs/…'` still resolves to a `+`-leading word and is still caught.
    const refspecForce = segments.some(({ command }) => {
      const words = shellWords(command);
      const push = gitSubcommandIndex(words, 'push');
      return push !== -1 && words.slice(push + 1).some((word) => /^\+\S/u.test(word));
    });
    if (flagForce || refspecForce) {
      return {
        block: true,
        reason:
          'autoloop guard — force pushes (`--force`/-f or a `+<refspec>` force-update) are '
          + 'destructive and outside policy. Use --force-with-lease, and only on loop '
          + 'branches after a rebase (autoloop:pitcrew step 7).',
      };
    }
  }

  // 5. gh bodies go via --body-file, never inline
  if (segments.some(({ command }) => isInlineGhBody(shellWords(command)))) {
    return {
      block: true,
      reason:
        'autoloop guard — untrusted text never rides inline in shell source (STATE → '
        + 'Lessons), so --body/-b on gh commands is out of policy. Write the body to a '
        + 'scratch file with the host\'s safe file-editing surface and pass --body-file.',
    };
  }

  // 6. `gh api` must not merge or mutate branch protection. Reads stay allowed —
  //    issue timeline, collaborator role_name, and GraphQL queries/resolveReviewThread
  //    are all read-shaped and pass.
  if (/\bgh\b[^\n]*\bapi\b/.test(lexicalCmd)) {
    if (segments.some(({ command }) =>
      hasOpaqueGraphqlInput(shellWords(command)))) {
      return {
        block: true,
        reason:
          'autoloop guard — GraphQL query input from a file or stdin is opaque to the merge '
          + 'guard. Pass a visible read-only query inline.',
      };
    }
    if (/\/(pulls\/[^\s/]+\/merge|merges)\b/.test(lexicalCmd)) {
      return {
        block: true,
        reason:
          'autoloop guard — the `gh api` merge endpoint is outside loop authority: the '
          + 'loop/agent never merges directly, via any raw surface (docs/agentic/STATE.md → '
          + 'Autonomy). Leave the merge to a human or the repo-ratified policy gate.',
      };
    }
    // Verdict statuses are PAT-writable, so a hand-typed POST would forge
    // delivery evidence the merge gate trusts. Reads (/commits/<sha>/status)
    // stay allowed; only the mutating status endpoint is fenced.
    if (
      /\/statuses\//.test(lexicalCmd)
      && segments.some(({ command }) => mutatingGhApi(shellWords(command)))
    ) {
      return {
        block: true,
        reason:
          'autoloop guard — posting a commit status by hand forges verdict evidence: '
          + 'agentic statuses come only from tools/agentic/publish-verdict.mjs, which binds '
          + 'them to the gate/review it actually executed on the exact clean head.',
      };
    }
    if (
      /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|enqueuePullRequest)\b/
        .test(lexicalCmd)
    ) {
      return {
        block: true,
        reason:
          'autoloop guard — GraphQL merge mutations are outside loop authority: the '
          + 'loop/agent never merges directly, via any raw surface (docs/agentic/STATE.md → '
          + 'Autonomy). Leave the merge to a human or the repo-ratified policy gate.',
      };
    }
    if (
      /\bmarkPullRequestReadyForReview\b/u.test(lexicalCmd)
      || /\baddLabelsToLabelable\b/u.test(lexicalCmd)
      || segments.some(({ command }) => terminalGraphqlMutation(command))
    ) {
      return {
        block: true,
        reason:
          'autoloop guard — raw terminal GraphQL mutation is outside loop authority. '
          + 'Use the exact-head Autoloop terminal finalizer.',
      };
    }
    if (segments.some(({ command }) =>
      opaqueIssueLabelApiMutation(shellWords(command))
      || terminalLabelApiRename(shellWords(command))
      || protectedLabelApiCreate(shellWords(command)))) {
      return {
        block: true,
        reason:
          'autoloop guard — raw issue or label mutation could bypass terminal delivery '
          + 'policy. Apply labels with `gh issue edit <number> --add-label <label>` — '
          + 'canonical, works on PRs too, and avoids the Projects-classic GraphQL failure '
          + 'that breaks `gh pr edit` on older gh — or use the Autoloop terminal finalizer.',
      };
    }
    if (segments.some(({ command }) => {
      const words = shellWords(command);
      if (!mutatingGhApi(words)) return false;
      return githubApiEndpoints(words).some((path) =>
        path.length >= 4
        && path[0] === 'repos'
        && (
          path[3] === 'releases'
          || (
            path[3] === 'git'
            && ['refs', 'tags'].includes(path[4])
          )
        ));
    })) {
      return {
        block: true,
        reason:
          'autoloop guard — raw release/tag API mutation requires an independent maintainer '
          + 'release action. Report release readiness and leave publication to the maintainer.',
      };
    }
    if (
      /\/(?:protection|rulesets?(?:\/|\b))/.test(lexicalCmd) &&
      (
        /(^|\s)(-X|--method|-f|-F|--field|--raw-field|--input)(\s|=)/
          .test(lexicalCmd)
        || /(^|\s)-X(?:DELETE|PATCH|POST|PUT)(?:\s|$)/iu.test(lexicalCmd)
        || /(^|\s)-[fF]\S+/u.test(lexicalCmd)
      )
    ) {
      return {
        block: true,
        reason:
          'autoloop guard — the branch/ruleset protection baseline is the human\'s control; '
          + 'the loop only reads it (docs/agentic/STATE.md → Autonomy). Report the mismatch '
          + 'instead of mutating protection.',
      };
    }
    if (
      /\b(?:create|update|delete)(?:RepositoryRuleset|BranchProtectionRule)\b/u
        .test(lexicalCmd)
    ) {
      return {
        block: true,
        reason:
          'autoloop guard — the branch/ruleset protection baseline is the human\'s control; '
          + 'the loop only reads it. Report the mismatch instead of mutating protection.',
      };
    }
  }

  return { block: false };
}

function currentBranch() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

// The guard is defense-in-depth for commands a run issues; repository rules are
// the enforcement boundary. Applying it to every Bash call in the project turns
// ordinary development into a fight with a policy that was never aimed at it, so
// it enforces only while a run is actually open.
//
// An open run is evidenced by a durable run marker that `prime.mjs` writes and
// binds to the ancestry it observed. The marker names live PIDs; a run whose
// orchestrator has exited leaves nothing alive to match, so the evidence
// disappears with the run without needing a daemon to revoke it. Anything
// unreadable or ambiguous means "no run": a guard that cannot establish an open
// run must not block a human.
export function runMarkerDirectory(cwd = process.cwd()) {
  const result = spawnSync(
    'git',
    ['-C', cwd, 'rev-parse', '--git-path', 'autoloop/run'],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true },
  );
  if (result.status !== 0 || result.error) return null;
  const path = String(result.stdout ?? '').trim();
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function ancestorPids(limit = 64) {
  const pids = new Set();
  let pid = process.ppid;
  for (let depth = 0; depth < limit && pid > 1; depth += 1) {
    pids.add(pid);
    let parent;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch {
      return pids;
    }
    if (!Number.isSafeInteger(parent) || parent <= 0) return pids;
    pid = parent;
  }
  return pids;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function loopRunIsOpen(cwd = process.cwd()) {
  const directory = runMarkerDirectory(cwd);
  if (directory === null) return false;
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return false;
  }
  const ancestors = ancestorPids();
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let marker;
    try {
      marker = JSON.parse(readFileSync(join(directory, entry), 'utf8'));
    } catch {
      continue;
    }
    if (marker?.version !== 1 || !Array.isArray(marker.pids)) continue;
    if (marker.pids.some((pid) =>
      Number.isSafeInteger(pid)
      && pid > 1
      && ancestors.has(pid)
      && processAlive(pid))) {
      return true;
    }
  }
  return false;
}

export function loadConfiguredBase(statePath) {
  const config = extractConfig(readFileSync(statePath, 'utf8'));
  const errors = validateConfig(config);
  if (errors.length > 0) {
    // A configuration awaiting migration is not a hostile one. Refusing here
    // blocks every command in the repository, including the ones Setup needs to
    // perform the migration, so report the remedy and let the command through.
    // No loop can run under an unmigrated schema — Runtime rejects it at open —
    // so nothing the guard exists to protect is reachable in this state.
    if (MIGRATABLE_CONFIG_VERSIONS.includes(config?.version)) {
      throw Object.assign(
        new Error(
          `repository configuration is schema ${config.version}; `
          + 'run autoloop:setup to migrate. The command guard is inactive until then',
        ),
        { migrationPending: true },
      );
    }
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

// Corpus replay: real command shapes from live sessions, each tagged with the
// incident that earned it a place. Unit fixtures test what we imagined; the
// corpus tests what sessions actually typed — five of one day's bugs were guard
// verdicts on commands no fixture contained. Exposed as `--corpus` because the
// release-proven manifest fast-path may skip an unchanged tool's self-test,
// and a corpus edit must always be re-proven.
export function replayCorpus() {
  const failures = [];
  let total = 0;
  try {
    const corpusPath = join(dirname(fileURLToPath(import.meta.url)), 'guard-corpus.json');
    const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
    for (const entry of corpus.cases) {
      const verdict = evaluate(entry.cmd, entry.branch, { baseBranch: 'main' });
      const got = verdict.block ? 'block' : 'allow';
      if (got !== entry.expect) {
        failures.push(
          `FAIL [corpus: expect ${entry.expect}, got ${got}] (${entry.why}): `
          + entry.cmd.split('\n')[0]);
      }
    }
    total = corpus.cases.length;
  } catch (error) {
    failures.push(`FAIL [corpus unreadable]: ${error.message}`);
  }
  return { total, failures };
}

function selfTest() {
  let corpusCount = 0;
  const cases = [
    // [cmd, branch, expectBlock, baseBranch]
    // 2026-07-28: a live `scaffold.mjs --reconcile` pipeline was refused as
    // inline interpreter source. A word that merely NAMES an interpreter or an
    // assembler in argument position is data, not an invocation.
    ['cd /r\nnode /p/scaffold.mjs --reconcile . 2>&1 | head -80', 'feat/gh-1-x', false],
    ['git log --oneline | grep node', 'feat/gh-1-x', false],
    ['rg -c sh docs/agentic/STATE.md', 'feat/gh-1-x', false],
    ['git log --grep xargs --oneline', 'feat/gh-1-x', false],
    ['rg -n awk templates/tools/command-guard.mjs', 'feat/gh-1-x', false],
    // Forwarded execution is still an invocation, wherever the name sits.
    ['find . -name "*.js" -exec node -e "x" {} +', 'feat/gh-1-x', true],
    ['find . -exec awk "{system(1)}" {} +', 'feat/gh-1-x', true],
    ['sudo node -e "x"', 'feat/gh-1-x', true],
    ['echo data | node', 'feat/gh-1-x', true],
    ['env node', 'feat/gh-1-x', true],
    // 2026-07-29: `command -v php` ASKS WHERE php is; `-v` is the whole
    // difference. A live setup lost a round to it while checking that its
    // configured gate still resolves — the probe this plugin's setup skill
    // asks for. `command` without `-v` still launders nothing.
    ['command -v php', 'feat/gh-1-x', false],
    ['command -v node', 'feat/gh-1-x', false],
    ['command -v awk', 'feat/gh-1-x', false],
    ['ls -d .ddev >/dev/null 2>&1 && echo present; command -v php', 'feat/gh-1-x', false],
    ['which php', 'feat/gh-1-x', false],
    ['type -p python3', 'feat/gh-1-x', false],
    ['command php -r "x"', 'feat/gh-1-x', true],
    ['command node', 'feat/gh-1-x', true],
    // A passthrough wrapper must not launder the word behind it.
    ['time xargs -n1 gh', 'feat/gh-1-x', true],
    ['exec node -e "x"', 'feat/gh-1-x', true],
    ['stdbuf -oL awk "{print}"', 'feat/gh-1-x', true],
    // 2026-07-29: three live runs lost a round to a `for` over a LITERAL list —
    // `for n in 222 223 224` and a sweep over eight named spec files. A literal
    // list is N literal commands written once, and the guard already resolves a
    // literal assignment the same way; refusing one while accepting the other
    // was inconsistent. The remedy it printed ("write the iterations as literal
    // commands") is exactly what expansion does mechanically.
    ['for f in a.md b.md; do rg -n "^## " $f; done', 'feat/gh-1-x', false],
    ['for n in 222 223 224; do gh issue view $n --json title; done', 'feat/gh-1-x', false],
    ['for s in a b; do wc -c ${s}; done', 'feat/gh-1-x', false],
    // Expansion is STRONGER than refusal: the real command becomes visible, so
    // this blocks on merge authority rather than on shape.
    ['for f in 41 42; do gh pr merge $f; done', 'feat/gh-1-x', true],
    // A list that is not literal stays refused — what it iterates over is not
    // knowable here.
    ['for f in $(ls); do rm $f; done', 'feat/gh-1-x', true],
    ['for f in *.md; do rm $f; done', 'feat/gh-1-x', true],
    ['while read l; do echo $l; done', 'feat/gh-1-x', true],
    ['gh pr merge 42', 'feat/gh-1-x', true],
    // A literal path variable is resolvable, so the guard substitutes and judges
    // the real command instead of refusing the shape (the friction every live
    // run hit). Anything it cannot resolve stays blocked as opaque.
    ['S=/tmp/scratch; sha256sum $S/plan.md', 'feat/gh-1-x', false],
    ['S=/tmp/scratch; sha256sum ${S}/plan.md', 'feat/gh-1-x', false],
    ['D=docs; rg -n autoloop $D/agentic/STATE.md', 'feat/gh-1-x', false],
    // Substitution makes evasion detectable rather than merely refused: this
    // now blocks on the merge rule itself.
    ['verb=merge; gh pr $verb 42', 'feat/gh-1-x', true],
    ['V=$(printf merge); gh pr $V 42', 'feat/gh-1-x', true],
    ['S="/tmp/a b"; ls $S', 'feat/gh-1-x', true],
    ['ls $UNSET_PATH/x', 'feat/gh-1-x', true],
    ['B=main; git push origin --delete $B', 'feat/gh-1-x', true, 'main'],
    ['gh --repo o/r pr merge 42 --squash', 'feat/gh-1-x', true],
    ['gh pr merge --auto 42', 'feat/gh-1-x', true],
    // The word "merge" inside an option argument is not a merge invocation: a PR
    // about merge policy must be creatable (live false positive, run 3bdd6e5e).
    ['gh pr create --fill --title "chore: migrate scaffold and enable auto merge policy"', 'chore/autoloop-migrate', false],
    ['gh pr edit 180 --title "enable auto merge policy"', 'feat/gh-2-y', false],
    ['verb=merge; gh pr $verb 42', 'feat/gh-1-x', true],
    ['gh pr m$(printf erge) 42', 'feat/gh-1-x', true],
    ['a=g; b=h; c=m; d=erge; "$a$b" pr "$c$d" 42', 'feat/gh-1-x', true],
    ['a=g; b=h; c=m; d=erge; eval "$a$b pr $c$d 42"', 'feat/gh-1-x', true],
    ['x=$(printf \\\\147\\\\150); y=$(printf \\\\155\\\\145\\\\162\\\\147\\\\145); $x pr $y 42', 'feat/gh-1-x', true],
    ["python3 -c 'import os; os.system(\"g\"+\"h pr m\"+\"erge 42\")'", 'feat/gh-1-x', true],
    ["node -e 'require(\"child_process\").execFileSync(\"g\"+\"h\",[\"pr\",\"m\"+\"erge\",\"42\"])'", 'feat/gh-1-x', true],
    ["perl -e 'system(\"g\".\"h\", \"pr\", \"m\".\"erge\", 42)'", 'feat/gh-1-x', true],
    // A version or help probe runs no source at all. The rule below treats an
    // interpreter with no script argument as reading from stdin, which is right
    // for a bare `node` and wrong for `node --version` — and the setup audit
    // battery is exactly `gh auth status && node --version && codex --version`.
    // A newline is a command separator like `;` is. The resolver anchored on
    // `^` without the `m` flag, so only an assignment on the FIRST line counted:
    // a live battery worked as `T=...` on line 1 and was refused the moment a
    // `cd` was added above it, with the expansion reported as opaque.
    ['T=/tmp/x\nnode $T/a.mjs --audit .', 'feat/gh-1-x', false],
    ['cd /repo\nT=/tmp/x\nnode $T/a.mjs --audit .', 'feat/gh-1-x', false],
    ['cd /repo\nverb=merge\ngh pr $verb 42', 'feat/gh-1-x', true],
    // A QUOTED heredoc body is literal by shell semantics — no expansion, no
    // command substitution. The expansion check ran on the raw command, so a
    // commit message containing backticks (`m` flag, `scaffold.mjs --reconcile`)
    // was read as command substitution and the whole commit refused. Observed
    // live: the loop could not write its own reconcile commit message.
    ["git commit -q -F - <<'EOF'\nmsg with `m` backticks\nEOF", 'feat/gh-1-x', false],
    ["git add -A && git commit -q -F - <<'EOF' && git log --oneline -1\nmsg `x` and $(pwd) literal\nEOF", 'feat/gh-1-x', false],
    // An UNQUOTED heredoc body really does expand, so it stays opaque. Stripping
    // both kinds alike before the check would have opened exactly this hole.
    ['git commit -q -F - <<EOF\nmsg with $(pwd) live\nEOF', 'feat/gh-1-x', true],
    ['git commit -q -F - <<EOF\nmsg with `pwd` live\nEOF', 'feat/gh-1-x', true],
    // `git` as an ARGUMENT is data, not an invocation: the alias rule found
    // `git` anywhere in a segment, so quote-stripped prose — a live run's
    // `echo "=== git diffstat ==="` section banner — read as an unknown
    // subcommand and sank an innocent compound. Executable position only.
    ['echo "=== git diffstat ==="', 'feat/gh-1-x', false],
    ['echo "gh pr-mangle is not a thing"', 'feat/gh-1-x', false],
    ['git diffstat', 'feat/gh-1-x', true],
    ['env git diffstat', 'feat/gh-1-x', true],
    ['A=1 git status --short', 'feat/gh-1-x', false],
    ['timeout 30 git fetch origin main', 'feat/gh-1-x', false],
    ['node --version', 'feat/gh-1-x', false],
    ['python3 --version', 'feat/gh-1-x', false],
    ['deno --help', 'feat/gh-1-x', false],
    ['echo probe && gh auth status && node --version', 'feat/gh-1-x', false],
    // Short forms stay opaque on purpose: `-v` is the version flag for node and
    // ruby but means "verbose" for python, where it still reads a script from
    // stdin. The long form is unambiguous everywhere and costs nothing to write.
    ['node -v', 'feat/gh-1-x', true],
    ['node', 'feat/gh-1-x', true],
    ["node --version -e 'require(\"child_process\").execFileSync(\"g\"+\"h\")'", 'feat/gh-1-x', true],
    ["printf '\\\\147\\\\150\\\\040\\\\160\\\\162\\\\040\\\\155\\\\145\\\\162\\\\147\\\\145\\\\040\\\\064\\\\062\\\\012' | sh", 'feat/gh-1-x', true],
    ["printf '\\\\147\\\\151\\\\164\\\\040\\\\160\\\\165\\\\163\\\\150\\\\040\\\\157\\\\162\\\\151\\\\147\\\\151\\\\156\\\\040\\\\110\\\\105\\\\101\\\\104\\\\072\\\\164\\\\162\\\\165\\\\156\\\\153\\\\012' | bash", 'feat/gh-1-x', true],
    ["printf 'import os\\\\nos.system(chr(103)+chr(104)+\" pr \"+\"merge 42\")\\\\n' | python3", 'feat/gh-1-x', true],
    ["printf 'require(\"child_process\").execFileSync(String.fromCharCode(103,104),[\"pr\",\"merge\",\"42\"])\\\\n' | node", 'feat/gh-1-x', true],
    ["printf '\\\\147\\\\150\\\\040\\\\160\\\\162\\\\040\\\\155\\\\145\\\\162\\\\147\\\\145\\\\040\\\\064\\\\062\\\\012' | sh /dev/stdin", 'feat/gh-1-x', true],
    ["printf '\\\\147\\\\151\\\\164\\\\040\\\\160\\\\165\\\\163\\\\150\\\\040\\\\157\\\\162\\\\151\\\\147\\\\151\\\\156\\\\040\\\\110\\\\105\\\\101\\\\104\\\\072\\\\164\\\\162\\\\165\\\\156\\\\153\\\\012' | bash /dev/fd/0", 'feat/gh-1-x', true],
    ["printf 'import os\\\\nos.system(chr(103)+chr(104)+\" pr \"+\"merge 42\")\\\\n' | python3 /dev/stdin", 'feat/gh-1-x', true],
    ["printf 'require(\"child_process\").execFileSync(String.fromCharCode(103,104),[\"pr\",\"merge\",\"42\"])\\\\n' | node /dev/stdin", 'feat/gh-1-x', true],
    ["awk 'BEGIN { system(sprintf(\"%c%c\",103,104) \" pr \" \"merge 42\") }'", 'feat/gh-1-x', true],
    ["printf '\\\\147\\\\150\\\\0pr\\\\0merge\\\\00042\\\\0' | xargs -0", 'feat/gh-1-x', true],
    ['gh m 42', 'feat/gh-1-x', true],
    ["gh pr view 42 --jq '$.mergeable'", 'feat/gh-1-x', false],
    ["printf '%s\\n' '$HOME'", 'feat/gh-1-x', false],
    ['g""h p""r m""erge 42', 'feat/gh-1-x', true],
    ['g\\\nh pr merge 42', 'feat/gh-1-x', true],
    ["$'g\\x68' pr merge 42", 'feat/gh-1-x', true],
    ['gh pr view 42 --json mergeStateStatus,mergeable', 'develop', false], // no \bmerge\b
    ['gh pr list --search draft:false', 'main', false],
    ['git commit -m "feat: x"', 'develop', true, 'develop'],
    ['git commit -m "feat: x"', 'main', true],
    ['git commit -m "feat: x"', 'master', true, 'master'],
    ['git commit -m "feat: unknown branch"', null, true, 'trunk'],
    ['git commit -m "feat: x"', 'feat/gh-2-y', false],
    ['git c\\\nommit -m "unsafe continued token"', 'trunk', true, 'trunk'],
    ["$'g\\151t' commit -m \"unsafe encoded token\"", 'trunk', true, 'trunk'],
    ['(git commit -m "unsafe grouped")', 'trunk', true, 'trunk'],
    ['$(git commit -m "unsafe substitution")', 'trunk', true, 'trunk'],
    ['$("git" commit -m "unsafe quoted substitution")', 'trunk', true, 'trunk'],
    ['`git commit -m "unsafe backtick"`', 'trunk', true, 'trunk'],
    ['("git" commit -m "unsafe quoted group")', 'trunk', true, 'trunk'],
    ['`"git" commit -m "unsafe quoted backtick"`', 'trunk', true, 'trunk'],
    ['echo "$(git commit -m unsafe)"', 'trunk', true, 'trunk'],
    ['{ git commit -m "unsafe brace"; }', 'trunk', true, 'trunk'],
    ['(git \\\ncommit -m "unsafe continued")', 'trunk', true, 'trunk'],
    ["('git' commit -m \"unsafe quoted executable\")", 'trunk', true, 'trunk'],
    ['(g\\it commit -m "unsafe escaped executable")', 'trunk', true, 'trunk'],
    ['(git switch -c feat/gh-3-z && git commit -m "opaque")', 'trunk', true, 'trunk'],
    ['git switch -c feat/gh-3-z && git commit --allow-empty -m "chore: claim #3"', 'main', false],
    ['git commit -m "unsafe first" && git switch feat/gh-3-z', 'trunk', true, 'trunk'],
    ['git switch trunk && git commit -m "unsafe target"', 'feat/gh-3-z', true, 'trunk'],
    ['git switch feat/gh-3-z || git commit -m "unsafe fallback"', 'trunk', true, 'trunk'],
    ['git switch trunk || git switch feat/gh-3-z && git commit -m "unsafe"', 'trunk', true, 'trunk'],
    ['git checkout trunk || git switch feat/gh-3-z && git push origin HEAD', 'trunk', true, 'trunk'],
    ['git switch feat/gh-3-z; git commit -m "unsafe after uncertain switch"', 'trunk', true, 'trunk'],
    ['git switch feat/gh-3-z | git commit -m "unsafe pipeline"', 'trunk', true, 'trunk'],
    ['git switch feat/gh-3-z && git commit -m "safe target"', 'trunk', false, 'trunk'],
    ['git checkout feat/gh-3-z && git commit -m "safe target"', 'trunk', false, 'trunk'],
    ['git checkout -b feat/gh-3-z && git commit -m "safe target"', 'trunk', false, 'trunk'],
    ['git checkout README.md && git commit -m "unsafe path restore"', 'trunk', true, 'trunk'],
    ['git checkout ./README.md && git commit -m "unsafe path restore"', 'trunk', true, 'trunk'],
    ['git checkout . && git commit -m "unsafe path restore"', 'trunk', true, 'trunk'],
    ['git checkout HEAD -- README.md && git commit -m "unsafe path restore"', 'trunk', true, 'trunk'],
    ['git -C . checkout README.md && git -C . commit -m "unsafe path restore"', 'trunk', true, 'trunk'],
    ['git checkout --track origin/trunk && git commit -m "unsafe tracked base"', 'feat/gh-3-z', true, 'trunk'],
    ['git switch --track origin/trunk && git commit -m "unsafe tracked base"', 'feat/gh-3-z', true, 'trunk'],
    ['git switch --track origin/feat/gh-3-z && git commit -m "safe tracked unit"', 'trunk', false, 'trunk'],
    ['git commit -m "allowed on main"', 'main', false, 'trunk'],
    ['git commit -m "fix: y" -m "Co-Authored-By: Claude <n@a.com>"', 'feat/gh-2-y', true],
    ['git push --force origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push --fo""rce origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push --fo\\\nrce origin feat/gh-2-y', 'feat/gh-2-y', true],
    ["git push --$'f\\x6frce' origin feat/gh-2-y", 'feat/gh-2-y', true],
    ['git push --for origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -uf origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -fq origin feat/gh-2-y', 'feat/gh-2-y', true],
    ['git push -f', 'feat/gh-2-y', true],
    ['git push --force-with-lease origin feat/gh-2-y', 'feat/gh-2-y', false],
    ['git push origin +main', 'feat/gh-2-y', true], // +refspec force
    ["git push origin '+refs/heads/main'", 'main', true], // quoted +refspec force
    ['git push origin feat/gh-2-y', 'feat/gh-2-y', false], // normal push, no force
    ['git push --set-upstream origin feat/gh-2-y', 'feat/gh-2-y', false],
    ['git push origin HEAD', 'trunk', true, 'trunk'],
    ['git push origin @', 'trunk', true, 'trunk'],
    ['git push origin HEAD', 'feat/gh-2-y', false, 'trunk'],
    ['git push', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin', 'feat/gh-2-y', true, 'trunk'],
    ['git switch feat/gh-2-y && git push origin HEAD', 'trunk', false, 'trunk'],
    ['git push --all origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --al origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --branches origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --bra origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --mirror origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --tags origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push --follow-tags origin feat/gh-2-y', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin v0.40.0', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin refs/tags/v0.40.0', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin HEAD:refs/tags/v0.40.0', 'feat/gh-2-y', true, 'trunk'],
    ['git push --mi origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin :', 'feat/gh-2-y', true, 'trunk'],
    ["git push origin 'refs/heads/*:refs/heads/*'", 'feat/gh-2-y', true, 'trunk'],
    ["git push origin 'refs/heads/feat/*:refs/heads/feat/*'", 'feat/gh-2-y', false, 'trunk'],
    ['git push origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin HEAD:refs/heads/trunk', 'feat/gh-2-y', true, 'trunk'],
    ['verb=push; git $verb origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git p$(printf ush) origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['g=git; $g push origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['a=g; b=it; c=p; d=ush; "$a$b" "$c$d" origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git ship origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git ci -m x', 'trunk', true, 'trunk'],
    ['(git push origin HEAD:trunk)', 'feat/gh-2-y', true, 'trunk'],
    ['$(git push origin HEAD:trunk)', 'feat/gh-2-y', true, 'trunk'],
    ['echo "`git push origin HEAD:trunk`"', 'feat/gh-2-y', true, 'trunk'],
    ['{ git push origin HEAD:trunk; }', 'feat/gh-2-y', true, 'trunk'],
    ["(g'i't push origin HEAD:trunk)", 'feat/gh-2-y', true, 'trunk'],
    ['/usr/bin/git push origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --repo origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --repo=origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --rep=origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git -c alias.ship=push ship origin HEAD:trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git -c remote.origin.push=HEAD:trunk push origin', 'feat/gh-2-y', true, 'trunk'],
    ['git -c remote.origin.push=+HEAD:trunk push origin', 'feat/gh-2-y', true, 'trunk'],
    ['git -c push.default=matching push origin', 'feat/gh-2-y', true, 'trunk'],
    ['git push origin :trunk', 'feat/gh-2-y', true, 'trunk'],
    ['git push --delete origin trunk', 'feat/gh-2-y', true, 'trunk'],
    ['gh pr create --draft --title "t" --body "inline"', 'feat/gh-2-y', true],
    ['gh --repo o/r pr create --title "t" --body "inline"', 'feat/gh-2-y', true],
    ['gh --hostname github.example pr comment 4 -b "inline"', 'feat/gh-2-y', true],
    ['gh issue comment 5 -b "hi"', 'feat/gh-2-y', true],
    ['gh pr create --title "t" -binline', 'feat/gh-2-y', true],
    ['gh pr create -dbinline --title "t"', 'feat/gh-2-y', true],
    ['gh pr comment 4 -binline', 'feat/gh-2-y', true],
    ['gh issue comment 5 -binline', 'feat/gh-2-y', true],
    ['/usr/bin/gh issue comment 5 -b "hi"', 'feat/gh-2-y', true],
    ['gh pr create --draft --title "t" --body-file /tmp/b.md', 'feat/gh-2-y', false],
    ['gh pr review 5 --request-changes --body-file /tmp/r.md', 'main', false],
    ['gh pr ready 42', 'feat/gh-2-y', true],
    ['gh --repo o/r pr ready 42', 'feat/gh-2-y', true],
    ['gh issue edit 7 --add-label loop-delivered', 'feat/gh-2-y', true],
    ['gh issue edit 7 --add-label loop-ready,loop-delivered', 'feat/gh-2-y', true],
    ['gh issue edit 7 --add-label loop-ready', 'feat/gh-2-y', true],
    ['gh issue edit 7 --add-label=LOOP-READY', 'feat/gh-2-y', true],
    ['gh pr edit 42 --add-label=loop-delivered', 'feat/gh-2-y', true],
    ['gh issue edit 7 --remove-label loop-ready', 'feat/gh-2-y', false],
    ['gh issue edit 7 --remove-label loop-delivered', 'feat/gh-2-y', false],
    ['gh issue edit 218 --add-label human:authorize', 'feat/gh-2-y', false],
    ['gh pr edit 218 --add-label human:authorize', 'feat/gh-2-y', false],
    ['gh label edit old-name --name loop-delivered', 'feat/gh-2-y', true],
    ['gh label edit old-name --name loop-ready', 'feat/gh-2-y', true],
    ['gh label edit old-name -nloop-delivered', 'feat/gh-2-y', true],
    ['gh label create loop-ready --description authority', 'feat/gh-2-y', true],
    ['gh label create loop-delivered --description terminal', 'feat/gh-2-y', false],
    ['gh release create v0.40.0 --notes-file /tmp/notes.md', 'feat/gh-2-y', true],
    ['gh release edit v0.40.0 --title changed', 'feat/gh-2-y', true],
    ['gh release delete v0.40.0 --yes', 'feat/gh-2-y', true],
    ['gh release upload v0.40.0 /tmp/asset.tgz', 'feat/gh-2-y', true],
    ['gh release view v0.40.0', 'feat/gh-2-y', false],
    ['gh release list', 'feat/gh-2-y', false],
    // gh api: merge/protection mutations blocked, reads pass
    ['gh api repos/o/r/pulls/42/merge -X PUT', 'feat/gh-2-y', true],
    ['gh api repos/o/r/pulls/42/mer\\\nge -X PUT', 'feat/gh-2-y', true],
    ["gh api repos/o/r/pulls/42/$'m\\x65rge' -X PUT", 'feat/gh-2-y', true],
    ['gh api repos/o/r/merges -f base=main -f head=feat/gh-2-y', 'feat/gh-2-y', true],
    // commit statuses: hand-posting forges verdict evidence; reads pass
    [`gh api repos/o/r/statuses/${'a'.repeat(40)} -f state=success -f context=agentic/gate`, 'feat/gh-2-y', true],
    [`gh api repos/o/r/statuses/${'a'.repeat(40)} --method POST --input /tmp/s.json`, 'feat/gh-2-y', true],
    [`gh api repos/o/r/commits/${'a'.repeat(40)}/status`, 'feat/gh-2-y', false],
    [`gh api repos/o/r/commits/${'a'.repeat(40)}/statuses`, 'feat/gh-2-y', false],
    ["gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"})}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{enqueuePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", 'feat/gh-2-y', true],
    ['gh api graphql --input /tmp/merge.json', 'feat/gh-2-y', true],
    ['gh api graphql --input=/tmp/merge.json', 'feat/gh-2-y', true],
    ['gh api graphql -Fquery=@/tmp/merge.graphql', 'feat/gh-2-y', true],
    ['gh api --input /tmp/merge.json graphql', 'feat/gh-2-y', true],
    ['gh api --input=/tmp/merge.json graphql', 'feat/gh-2-y', true],
    ['gh api -Fquery=@/tmp/merge.graphql graphql', 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"x\"})}'", 'feat/gh-2-y', false],
    ["gh api graphql -f query='mutation{markPullRequestReadyForReview(input:{pullRequestId:\"x\"}){pullRequest{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{addLabelsToLabelable(input:{labelableId:\"I_x\",labelIds:[\"LA_x\"]}){clientMutationId}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{updateIssue(input:{id:\"I_x\",labelIds:[\"LA_x\"]}){issue{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{updateIssue(input:{id:\"I_x\",title:\"x\"}){issue{labels{nodes{id}}}}}'", 'feat/gh-2-y', false],
    ["gh api graphql -f query='mutation{updateLabel(input:{id:\"LA_x\",name:\"loop-delivered\"}){label{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{updateLabel(input:{id:\"LA_x\",name:\"loop-ready\"}){label{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{updateLabel(input:{id:\"LA_x\",name:\"loop\\u002ddelivered\"}){label{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation($name:String!){updateLabel(input:{id:\"LA_x\",name:$name}){label{id}}}' -Fname=@/tmp/name.txt", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{createLabel(input:{repositoryId:\"R_x\",name:\"loop-ready\",color:\"fff\"}){label{id}}}'", 'feat/gh-2-y', true],
    ["gh api graphql -f query='mutation{updateLabel(input:{id:\"LA_x\",name:\"ordinary\"}){label{id}}}'", 'feat/gh-2-y', false],
    ["gh api graphql -f query='mutation{clearLabelsFromLabelable(input:{labelableId:\"I_x\"}){clientMutationId}}'", 'feat/gh-2-y', false],
    ['gh api repos/o/r/issues/7/labels -X POST --input /tmp/labels.json', 'feat/gh-2-y', true],
    ['gh api /repos/o/r/issues/7/labels -X POST --input /tmp/labels.json', 'feat/gh-2-y', true],
    ['gh api https://api.github.com/repos/o/r/issues/7/labels -X POST --input /tmp/labels.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/issues/7/labels?per_page=100 -X POST --input /tmp/labels.json', 'feat/gh-2-y', true],
    ["gh api /repos/o/r/issues/7/labels?per_page=100 --jq '.[].name'", 'feat/gh-2-y', false],
    ['gh api repos/o/r/issues/7 -X PATCH --input /tmp/issue.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/issues/7 -X PATCH -f labels[]=loop-delivered', 'feat/gh-2-y', true],
    ["gh api repos/o/r/issues/7 -X PATCH -F 'labels[]=@/tmp/label.txt'", 'feat/gh-2-y', true],
    ["gh api repos/o/r/issues/7 -X PATCH --field 'labels=@/tmp/labels.json'", 'feat/gh-2-y', true],
    ['gh api repos/o/r/issues/7 -X PATCH -Flabels[]=@/tmp/label.txt', 'feat/gh-2-y', true],
    ["gh api /repos/o/r/issues/7 -X PATCH -F 'labels[]=@/tmp/label.txt'", 'feat/gh-2-y', true],
    ["gh api https://api.github.com/repos/o/r/issues/7 -X PATCH --field 'labels=@/tmp/labels.json'", 'feat/gh-2-y', true],
    ['gh api repos/o/r/issues/7?state=open -X PATCH -Flabels[]=@/tmp/label.txt', 'feat/gh-2-y', true],
    ['gh api repos/o/r/issues/7/labels/loop-delivered -X DELETE', 'feat/gh-2-y', false],
    ['gh api repos/o/r/labels/old-name -X PATCH -f new_name=loop-delivered', 'feat/gh-2-y', true],
    ['gh api repos/o/r/labels/old-name -X PATCH -f new_name=loop-ready', 'feat/gh-2-y', true],
    ['gh api /repos/o/r/labels/old%20name -X PATCH -f new_name=loop-delivered', 'feat/gh-2-y', true],
    ['gh api %72epos/o/r/labels/old-name -X PATCH -Fnew_name=@/tmp/name.txt', 'feat/gh-2-y', true],
    ['gh api repos/o/r/labels/old-name?locale=en -X PATCH -f new_name=loop-delivered', 'feat/gh-2-y', true],
    ['gh api https://api.github.com/repos/o/r/labels/old-name -X PATCH -f new_name=loop-delivered', 'feat/gh-2-y', true],
    ['gh api repos/o/r/labels/old-name -X PATCH -f color=ffffff', 'feat/gh-2-y', false],
    ['gh api repos/o/r/labels -X POST -f name=loop-ready -f color=ffffff', 'feat/gh-2-y', true],
    ['gh api repos/o/r/labels -X POST -f name=ordinary -f color=ffffff', 'feat/gh-2-y', false],
    ['gh api repos/o/r/releases -X POST --input /tmp/release.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/7 -X PATCH --input /tmp/release.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/7 -X DELETE', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/7/assets -X POST --input /tmp/asset.json', 'feat/gh-2-y', true],
    ['gh api repos/o/r/releases/assets/9 -X DELETE', 'feat/gh-2-y', true],
    ['gh api repos/o/r/git/refs -X POST -f ref=refs/tags/v0.40.0 -f sha=abc', 'feat/gh-2-y', true],
    ['gh api repos/o/r/branches/main/protection -X DELETE', 'main', true],
    ['gh api repos/o/r/branches/main/protection -XDELETE', 'main', true],
    ['gh api repos/o/r/branches/main/protection -f enforce_admins=false', 'main', true],
    ['gh api repos/o/r/branches/main/protection -fenforce_admins=false', 'main', true],
    ['gh api repos/o/r/branches/main/protection -Frequired_status_checks=null', 'main', true],
    ['gh api repos/o/r/rulesets/123 -X DELETE', 'main', true],
    ['gh api repos/o/r/rulesets/123 -X PATCH -f enforcement=disabled', 'main', true],
    ["gh api graphql -f query='mutation{deleteRepositoryRuleset(input:{repositoryRulesetId:\"x\"}){clientMutationId}}'", 'main', true],
    ["gh api repos/o/r/branches/main/protection --jq '.enforce_admins.enabled'", 'main', false],
    ["gh api repos/o/r/issues/5/timeline --jq '.[]'", 'main', false],
    ['gh api repos/o/r/collaborators/alice/permission --jq .role_name', 'main', false],
    // heredoc body quoting a forbidden command must NOT trip the guard
    ['cat <<\'EOF\' > /tmp/x\ngh pr merge 42\nEOF', 'main', false],
    ['git commit -F - <<\'MSG\'\nfeat: x\nMSG', 'feat/gh-2-y', false],
    ['bash <<\'EOF\'\ngh pr merge 42\nEOF', 'feat/gh-2-y', true],
    ['sh <<\'EOF\'\ngit push origin HEAD:trunk\nEOF', 'feat/gh-2-y', true, 'trunk'],
    ['source /dev/stdin <<\'EOF\'\ngh pr ready 42\nEOF', 'feat/gh-2-y', true],
    ['. /dev/stdin <<\'EOF\'\ngh issue edit 7 --add-label loop-delivered\nEOF', 'feat/gh-2-y', true],
    ['source /dev/stdin \\\n<<\'EOF\'\ngh pr ready 42\nEOF', 'feat/gh-2-y', true],
    ['bash \\\n<<\'EOF\'\ngh pr ready 42\nEOF', 'feat/gh-2-y', true],
    ["printf '\\x67\\x68 pr ready 42\\n' | source /dev/stdin", 'feat/gh-2-y', true],
    ['. /dev/fd/0 < /tmp/opaque.sh', 'feat/gh-2-y', true],
    ['source scripts/reviewed.sh', 'feat/gh-2-y', false],
  ];
  let ok = true;
  for (const [cmd, branch, expect, baseBranch] of cases) {
    const got = evaluate(cmd, branch, { baseBranch }).block;
    if (got !== expect) {
      console.error(`FAIL [expect block=${expect}, got ${got}]: ${cmd.split('\n')[0]}`);
      ok = false;
    }
  }
  // Every refusal must read as policy: a consistent guard identity prefix and a
  // closing sentence naming the sanctioned alternative, never an error dump.
  let messageChecks = 0;
  {
    messageChecks += 1;
    const offPolicy = cases
      .filter(([, , expect]) => expect)
      .map(([cmd, branch, , baseBranch]) => [
        cmd,
        evaluate(cmd, branch, { baseBranch }).reason ?? '',
      ])
      .filter(([, reason]) =>
        !reason.startsWith('autoloop guard — ') || !reason.trimEnd().endsWith('.'));
    for (const [cmd] of offPolicy) {
      console.error(`FAIL [block reason is not policy-shaped]: ${cmd.split('\n')[0]}`);
      ok = false;
    }
    messageChecks += 1;
    const inlineReason = evaluate(
      "node -e 'console.log(1)'",
      'feat/gh-1-x',
    ).reason;
    const expectedInlineReason =
      'autoloop guard — inline shell or language-interpreter source is opaque to command '
      + 'policy. To learn what a shell name resolves to or what a startup file does, read the '
      + 'file — `rg -n <name> ~/.zshrc` — instead of starting an interactive shell to ask it. '
      + 'To check that a file parses, the interpreter does it directly: `zsh -n <file>`, '
      + '`node --check <file>`. For a real program, write it to a file and run that.';
    if (inlineReason !== expectedInlineReason) {
      console.error('FAIL [inline-interpreter block is the exact policy message]');
      ok = false;
    }
    // 2026-07-29: `zsh -ic 'alias | grep -i <name>; whence -w <name>'` was told to
    // write a script file to inspect an alias. The remedy must name a command.
    messageChecks += 1;
    const shellIntrospection = evaluate(
      "zsh -ic 'alias | grep -i claudep; whence -w claudep'",
      'feat/gh-1-x',
    ).reason ?? '';
    if (
      !shellIntrospection.includes('rg -n <name> ~/.zshrc')
      || !shellIntrospection.includes('zsh -n <file>')
    ) {
      console.error('FAIL [an inline-interpreter refusal names a command, not just a file]');
      ok = false;
    }
    // 2026-07-29: `sed -n <range>p f | cat -n | awk '{print $1+<offset>}'` got only
    // measurement spellings back, none of which reads a region. The awk was undoing
    // `cat -n` renumbering caused by slicing first; naming the order removes it.
    messageChecks += 1;
    const regionAwk = evaluate(
      "sed -n '160,215p' /home/dev/.zshrc | cat -n | awk '{printf \"%d\\t%s\\n\", $1+159, $0}'",
      'feat/gh-1-x',
    ).reason ?? '';
    if (
      !regionAwk.includes('cat -n <file> | sed -n <first>,<last>p')
      || !regionAwk.includes('restart at 1')
    ) {
      console.error('FAIL [an inline-awk refusal names the numbered-region spelling]');
      ok = false;
    }
    // 2026-07-28: a live refusal read "`$p`, a command substitution cannot be
    // resolved statically" -- a comma splice that parses as one garbled subject
    // and hides that TWO things need fixing. Named tokens join as English, and
    // an over-long list states its remainder rather than truncating silently,
    // which would send the reader back for a second refusal having already
    // fixed everything the first one mentioned.
    messageChecks += 1;
    const listCases = [
      [[], ''],
      [['`$p`'], '`$p`'],
      [['`$p`', 'a command substitution'], '`$p` and a command substitution'],
      [['`$p`', '`$q`', 'a command substitution'], '`$p`, `$q` and a command substitution'],
      [['`$a`', '`$b`', '`$c`', '`$d`'], '`$a`, `$b`, `$c` and 1 more unresolved token'],
      [['`$a`', '`$b`', '`$c`', '`$d`', '`$e`'], '`$a`, `$b`, `$c` and 2 more unresolved tokens'],
    ];
    for (const [tokens, expected] of listCases) {
      if (nameList(tokens) !== expected) {
        console.error(`FAIL [named-token list reads as English]: got ${nameList(tokens)}`);
        ok = false;
      }
    }
    messageChecks += 1;
    if (!unresolvedExpansionReason('ls $p $(date)')
      .startsWith('`$p` and a command substitution cannot be resolved statically')) {
      console.error('FAIL [two unresolved tokens are joined, not comma-spliced]');
      ok = false;
    }
    // 2026-07-28: a live session lost a round to `ls -d … | xargs -n1 basename`
    // -- a plain listing -- because the refusal named its category and left the
    // reader to guess the command. Shape-shaped advice is not advice; each
    // assembler shape must name the command to run instead.
    // 2026-07-28: the expansion refusal said "can hide a mutation. Use literal
    // canonical commands; split discovery and mutation into separate tool
    // calls." on a read-only `for s in …; do sed …; done` byte count — warning
    // about a mutation that was not there, silent about the loop variable that
    // actually blocked. Each shape must name its own token and its own remedy.
    messageChecks += 1;
    // 2026-07-29: `for d in kernel field …; do echo "$(wc -l …)"; done` was
    // refused naming `$d` AND the substitution, with the loop remedy attached —
    // but the loop expands fine and the substitution is the only blocker, so
    // the message sent the reader to fix the one part that was never wrong.
    messageChecks += 1;
    const mixedReason = evaluate(
      'for d in a b; do echo "$(wc -l $d)"; done',
      'feat/gh-1-x',
    ).reason ?? '';
    if (
      mixedReason.includes('`$d`')
      || mixedReason.includes('loop variable')
      || !mixedReason.includes('command substitution')
      || !mixedReason.includes('inner command prints')
    ) {
      console.error('FAIL [an expandable loop is not blamed for its body\'s substitution]');
      ok = false;
    }
    // A GLOB list, deliberately: a literal list expands and is judged, so the
    // loop remedy only has to read well for the loops that stay unresolvable.
    const loopReason = evaluate(
      'for s in *.md; do wc -c $s; done',
      'feat/gh-1-x',
    ).reason ?? '';
    if (
      !loopReason.includes('`$s`')
      || !loopReason.includes('loop variable')
      || !loopReason.includes('reviewed program file')
      || loopReason.includes('hide a mutation')
    ) {
      console.error('FAIL [a loop refusal names the loop variable and the loop remedy]');
      ok = false;
    }
    // 2026-07-29: a session wanting the body of one PHP method wrote
    // `sed -n "$(grep -n '<signature>' f | cut -d: -f1),+40p" f` and the remedy
    // offered only `wc -l` and `git diff --shortstat` — measurements, when the
    // reader was navigating. A region read has an exact spelling; name it.
    messageChecks += 1;
    const regionReason = evaluate(
      'sed -n "$(grep -n \'private function credentials(\' a.php | cut -d: -f1),+40p" a.php',
      'feat/gh-1-x',
    ).reason ?? '';
    if (
      !regionReason.includes('command substitution')
      || !regionReason.includes('-A<lines>')
      || !regionReason.includes('offset')
    ) {
      console.error('FAIL [a substitution refusal names the region-read spelling]');
      ok = false;
    }
    // 2026-07-29: `for f in <dir>/*.json; do jq -c <filter> "$f"; done` was told to
    // write one tool call per iteration, when jq takes the glob and needs exactly one.
    messageChecks += 1;
    const fileLoop = evaluate(
      'for f in .git/autoloop/run/*.json; do jq -c \'{pid}\' "$f"; done',
      'feat/gh-1-x',
    ).reason ?? '';
    if (
      !fileLoop.includes('take many paths at once')
      || !fileLoop.includes('reviewed program file')
    ) {
      console.error('FAIL [a file loop is offered the no-loop multi-path spelling]');
      ok = false;
    }
    messageChecks += 1;
    const exitReason = evaluate('node x.mjs; echo $?', 'feat/gh-1-x').reason ?? '';
    if (
      !exitReason.includes('`$?`')
      || !exitReason.includes('no literal form')
      || !exitReason.includes('ok: false')
    ) {
      console.error('FAIL [an exit-status refusal points at the report, not at assignment]');
      ok = false;
    }
    messageChecks += 1;
    const varReason = evaluate('wc -c $TARGET/x.md', 'feat/gh-1-x').reason ?? '';
    if (
      !varReason.includes('`$TARGET`')
      || !varReason.includes('SAME command')
      || varReason.includes('loop variable')
    ) {
      console.error('FAIL [a bare-variable refusal names the variable and the substitution path]');
      ok = false;
    }
    messageChecks += 1;
    const fanout = evaluate('ls -d /x/*/ | xargs -n1 basename', 'feat/gh-1-x').reason ?? '';
    if (!fanout.includes('ls -1 <dir>') || !fanout.includes('reviewed program file')) {
      console.error('FAIL [fanout refusal names the listing command to use instead]');
      ok = false;
    }
    messageChecks += 1;
    const awkReason = evaluate("ps aux | awk 'NR==1'", 'feat/gh-1-x').reason ?? '';
    // 2026-07-28: a live run was blocked pulling a number out of `git diff
    // --stat` and told to author an awk FILE — more ceremony than the
    // measurement it was making. A remedy that is absurd for the common case
    // is not a remedy, so the plainer spellings are named before the file form.
    if (
      !awkReason.includes('awk -f <file>')
      || !awkReason.includes('--shortstat')
      || !awkReason.includes('wc -l')
    ) {
      console.error('FAIL [inline-awk refusal names plainer spellings and the file-backed form]');
      ok = false;
    }
    messageChecks += 1;
    if (fanout === awkReason) {
      console.error('FAIL [distinct assembler shapes give distinct remedies]');
      ok = false;
    }
  }
  const corpusResult = replayCorpus();
  corpusCount = corpusResult.total;
  if (corpusResult.failures.length > 0) {
    ok = false;
    for (const line of corpusResult.failures) console.error(line);
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
  for (const [name, payload, accepted] of [
    ['canonical hook payload', { tool_input: { command: 'echo ok' } }, true],
    ['missing tool input', {}, false],
    ['non-string hook command', { tool_input: { command: ['echo', 'unsafe'] } }, false],
  ]) {
    const command = payload?.tool_input?.command;
    const passed = (typeof command === 'string') === accepted;
    if (!passed) {
      console.error(`FAIL [${name}]`);
      ok = false;
    }
  }
  // The scoping decides whether `evaluate` is consulted at all, so prove both
  // that a fabricated marker cannot activate the guard and that its evidence is
  // exactly a live process in this hook's own ancestry.
  {
    const scratch = mkdtempSync(join(tmpdir(), 'autoloop-guard-run-'));
    try {
      spawnSync('git', ['init', '--quiet', scratch], { encoding: 'utf8' });
      const directory = runMarkerDirectory(scratch);
      if (directory === null) {
        console.error('FAIL [a checkout resolves its run marker directory]');
        ok = false;
      } else {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const marker = join(directory, 'selftest.json');
        if (loopRunIsOpen(scratch) !== false) {
          console.error('FAIL [an empty marker directory does not open a run]');
          ok = false;
        }
        writeFileSync(marker, JSON.stringify({ version: 1, pids: [999_999_999] }));
        if (loopRunIsOpen(scratch) !== false) {
          console.error('FAIL [a marker outside this ancestry does not open a run]');
          ok = false;
        }
        writeFileSync(marker, JSON.stringify({ version: 2, pids: [process.ppid] }));
        if (loopRunIsOpen(scratch) !== false) {
          console.error('FAIL [an unknown marker version does not open a run]');
          ok = false;
        }
        writeFileSync(marker, 'not json');
        if (loopRunIsOpen(scratch) !== false) {
          console.error('FAIL [an unreadable marker does not open a run]');
          ok = false;
        }
        writeFileSync(marker, JSON.stringify({ version: 1, pids: [process.ppid] }));
        if (process.platform === 'linux' && loopRunIsOpen(scratch) !== true) {
          console.error('FAIL [a live marker in this ancestry opens a run]');
          ok = false;
        }
      }
    } catch {
      // An unwritable scratch directory is not a guard defect.
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  console.log(
    ok
      ? `self-test OK (${corpusCount} corpus + ${cases.length + messageChecks} cases)`
      : 'self-test FAILED',
  );
  return ok;
}

// A refusal is a policy decision, not a malfunction — and it has to READ that way.
//
// Blocking with stderr and exit 2 alone makes the host render every refusal as
// "PreToolUse:Bash hook error", identical to a crashed hook. A correct decision
// then looks like a broken tool, which invites working around it instead of
// reading it. Emitting the structured decision as well makes the host present
// the reason on its own terms; measured against claude 2.1.220, the error
// framing disappears and the reason survives verbatim.
//
// All three parts are load-bearing. The JSON removes the error framing. `exit 2`
// keeps the refusal failing CLOSED on any host that does not parse this shape —
// Codex and opencode run this same guard, and JSON with exit 0 would fail OPEN
// there, which is a security regression rather than a cosmetic change. stderr
// keeps the reason visible on exactly those hosts.
function refuse(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function main() {
  if (process.argv.includes('--corpus')) {
    const { total, failures } = replayCorpus();
    for (const line of failures) console.error(line);
    console.log(failures.length === 0
      ? `corpus OK (${total} cases)`
      : `corpus FAILED (${failures.length}/${total})`);
    process.exit(failures.length === 0 ? 0 : 1);
  }
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    refuse(
      `autoloop guard — invalid guard invocation (${parsed.error}), so no command can be `
      + 'proven safe. Re-run autoloop:setup to repair the hook wiring.',
    );
  }
  if (parsed.selfTest) process.exit(selfTest() ? 0 : 1);

  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch (error) {
    refuse(
      `autoloop guard — the hook payload was unreadable (${error.message}), so the command `
      + 'cannot be proven safe. Re-run the command; if this repeats, re-run autoloop:setup '
      + 'to repair the hook wiring.',
    );
  }
  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== 'string') {
    refuse(
      'autoloop guard — the hook payload omitted the Bash command, so it cannot be proven '
      + 'safe. Re-run the command; if this repeats, re-run autoloop:setup to repair the '
      + 'hook wiring.',
    );
  }

  // Ordered before configuration loading: with no run open there is nothing to
  // guard, so a configuration problem must not block a human's command either.
  if (!loopRunIsOpen()) process.exit(0);

  let baseBranch;
  try {
    baseBranch = loadConfiguredBase(parsed.statePath);
  } catch (error) {
    if (error.migrationPending === true) {
      console.error(`command-guard: ${error.message}`);
      process.exit(0);
    }
    refuse(
      `autoloop guard — the configured base branch cannot be resolved (${error.message}), `
      + 'so branch-sensitive rules cannot be proven. Run autoloop:setup to repair '
      + 'docs/agentic/STATE.md.',
    );
  }
  const verdict = evaluate(cmd, currentBranch(), { baseBranch });
  if (verdict.block) refuse(verdict.reason);
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
