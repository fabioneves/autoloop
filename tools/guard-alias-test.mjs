#!/usr/bin/env node
// Real temporary filesystem and hook-entry regressions. No service is started.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalGuardPath, findActionCommands } from './run-state-guard.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function selfTest() {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'guard-alias-')));
  const failures = [];
  let checks = 0;
  const check = (name, action) => {
    checks += 1;
    try { action(); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  };
  try {
    for (const action of ['-exec', '-execdir', '-ok', '-okdir']) {
      check(`${action} consumes nested-looking command data and keeps sibling actions`, () => {
        const words = ['find', '.', action, 'printf', '%s', '-exec', 'systemctl', '--user', 'stop', 'ordinary.service', ';',
          '-exec', 'true', '{}', '+', '-execdir', 'cat', '{}', '\\;'];
        assert.deepEqual(findActionCommands(words, 1), [
          ['printf', '%s', '-exec', 'systemctl', '--user', 'stop', 'ordinary.service'], ['true', '{}'], ['cat', '{}'],
        ]);
      });
    }
    check('nested find has one outer child range', () => {
      assert.deepEqual(findActionCommands(['find', '.', '-exec', 'find', '.', '-exec', 'true', ';', ';'], 1),
        [['find', '.', '-exec', 'true']]);
    });
    check('a missing terminator consumes the remaining child range once', () => {
      assert.deepEqual(findActionCommands(['find', '.', '-exec', 'find', '.', '-exec', 'true'], 1),
        [['find', '.', '-exec', 'true']]);
    });
    const repo = join(scratch, 'repo');
    const home = join(scratch, 'os-home');
    const installed = join(scratch, '.claude/plugins/cache/fixture/autoloop/1');
    const source = join(scratch, 'source');
    mkdirSync(repo);
    mkdirSync(join(repo, 'ordinary-find'));
    const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', timeout: 10000 });
    assert.equal(init.status, 0, init.stderr);
    for (const base of [installed, source]) {
      cpSync(join(root, 'tools'), join(base, 'tools'), { recursive: true });
      mkdirSync(join(base, 'hooks'), { recursive: true });
      cpSync(join(root, 'hooks/hooks.json'), join(base, 'hooks/hooks.json'));
    }
    mkdirSync(join(source, '.git'));
    const protectedDir = join(repo, '.git/autoloop/scheduler');
    mkdirSync(join(protectedDir, 'nested'), { recursive: true });
    const checkpoint = join(protectedDir, 'checkpoint.json');
    writeFileSync(checkpoint, 'before');
    writeFileSync(join(repo, 'checkpoint.json'), 'ordinary lexical target');
    symlinkSync(join(protectedDir, 'nested'), join(repo, 'hop'));
    const raw = `${repo}/hop/../checkpoint.json`;
    check('deep missing suffix stays under the physical prefix', () => {
      const suffix = 'missing/'.repeat(20000) + 'leaf.json';
      assert.equal(canonicalGuardPath(`${repo}/hop/../${suffix}`), `${protectedDir}/${suffix}`);
    });
    check('native realpath follows a symlink before parent traversal', () => {
      assert.equal(realpathSync.native(raw), checkpoint);
      assert.notEqual(resolve(raw), checkpoint);
      writeFileSync(raw, 'physical');
      assert.equal(readFileSync(checkpoint, 'utf8'), 'physical');
      writeFileSync(checkpoint, 'before');
      const newRaw = `${repo}/hop/../created.json`;
      writeFileSync(newRaw, 'created');
      assert.equal(readFileSync(join(protectedDir, 'created.json'), 'utf8'), 'created');
      for (const pattern of ['hop*/../checkpoint.json', 'ho[[:lower:]]*/../checkpoint.json', 'ho[[.p.]]*/../checkpoint.json']) {
        const globWrite = spawnSync('bash', ['-c', `printf glob-physical > ${pattern}`], { cwd: repo, encoding: 'utf8', timeout: 5000 });
        assert.equal(globWrite.status, 0, globWrite.stderr);
        assert.equal(readFileSync(checkpoint, 'utf8'), 'glob-physical');
        writeFileSync(checkpoint, 'before');
      }
    });
    // Only the external OS account lookup is replaced. Guard policy is real.
    const preload = join(scratch, 'os-fixture.cjs');
    writeFileSync(preload, `const os = require('node:os'); const real = os.userInfo;
      os.userInfo = (...args) => ({ ...real(...args), homedir: ${JSON.stringify(home)} });
      require('node:module').syncBuiltinESMExports();\n`);
    const bin = join(scratch, 'bin');
    const calls = join(scratch, 'external-calls');
    mkdirSync(bin);
    for (const name of ['git', 'gh']) writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' ${name} >> '${calls}'\nexit 99\n`, { mode: 0o755 });
    const env = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: repo, CLAUDE_PLUGIN_ROOT: installed,
      NODE_OPTIONS: `--require=${preload}`, PATH: `${bin}:${process.env.PATH}`, AUTOLOOP_GUARD_BUDGET_MS: '2000' };
    const findProbe = `import assert from 'node:assert/strict';
      const tools = process.argv[1] + '/tools/';
      const { guardSegments } = await import(tools + 'command-guard.mjs');
      const { fallbackGuardSegments, executionCommandProblemFor } = await import(tools + 'run-state-guard.mjs');
      const depth = 4;
      const command = 'find . -exec '.repeat(depth) + 'true ' + (String.fromCharCode(92) + '; ').repeat(depth);
      const lexer = process.argv[2] === 'primary' ? guardSegments : fallbackGuardSegments;
      const segments = lexer(command);
      assert.equal(segments.length, 1);
      let visits = 0;
      assert.equal(executionCommandProblemFor(segments, { cwd: process.cwd(), env: {},
        observeCommand: () => { visits += 1; } }), null);
      assert.equal(visits, depth + 1, 'Each nested find and its leaf must be inspected once.');`;
    for (const lexer of ['primary', 'fallback']) check(`${lexer} nested find traversal stays linear`, () => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', findProbe, installed, lexer], {
        cwd: repo, env, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
    });
    const hooks = JSON.parse(readFileSync(join(installed, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse;
    const hookCommand = (kind) => hooks.find((entry) => entry.matcher.startsWith(kind === 'edit' ? 'Edit' : 'Bash')).hooks[0].command;
    const invoke = (base, mode, tool, input, extraEnv = {}) => {
      const kind = tool === 'Bash' ? 'command' : 'edit';
      const hook = mode === 'hook' || mode.startsWith('hook-');
      const args = hook ? ['-c', hookCommand(kind)]
        : [join(base, 'tools/loop-execution-admission.mjs'), '--guard-entry', kind];
      const result = spawnSync(hook ? 'bash' : process.execPath, args, {
        cwd: repo, input: JSON.stringify({ session_id: 'unowned-fixture', cwd: repo, tool_name: tool, tool_input: input }),
        env: { ...env, CLAUDE_PLUGIN_ROOT: base, ...extraEnv }, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
      });
      assert.equal(result.error, undefined, result.error?.message);
      return result;
    };
    const verdict = (name, base, mode, tool, input, status, extraEnv) => check(name, () => {
      const result = invoke(base, mode, tool, input, extraEnv);
      assert.equal(result.status, status, result.stderr);
    });
    const installedCheckpoint = join(installed, 'tools/run-state-guard.mjs');
    mkdirSync(join(installed, 'tools/nested'));
    symlinkSync(join(installed, 'tools/nested'), join(repo, 'tool-hop'));
    const installedAlias = `${repo}/tool-hop/../run-state-guard.mjs`;
    check('native realpath validates the installed-code alias', () => assert.equal(realpathSync.native(installedAlias), installedCheckpoint));
    const detached = join(scratch, 'outside/.git/autoloop/scheduler');
    mkdirSync(join(detached, 'nested'), { recursive: true });
    writeFileSync(join(detached, 'checkpoint.json'), 'outside');
    symlinkSync(join(detached, 'nested'), join(repo, 'outside-hop'));
    const outsideAlias = `${repo}/outside-hop/../checkpoint.json`;
    const aliases = [checkpoint, '.git/autoloop/scheduler/checkpoint.json', raw, 'hop/../checkpoint.json',
      `${repo}//hop//../checkpoint.json`, `${repo}/hop/../missing.json`, installedAlias, outsideAlias];
    const commands = [
      (path) => `printf forged > '${path}'`, (path) => `tee '${path}'`, (path) => `cp ordinary '${path}'`,
      (path) => `mv ordinary '${path}'`, (path) => `rm '${path}'`, (path) => `chmod 000 '${path}'`,
      (path) => `truncate -s0 '${path}'`, (path) => `sed -i s/a/b/ '${path}'`,
      (path) => `dd if=/dev/null of='${path}'`, (path) => `touch '${path}'`,
    ];
    for (const base of [source, installed]) {
      const contextAliases = base === installed ? aliases : aliases.filter((path) => path !== installedAlias);
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) for (const path of contextAliases) {
        verdict(`${base === source ? 'source' : 'installed'} ${tool} rejects ${path}`, base, 'primary', tool,
          { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: path }, 2);
      }
      const bashAliases = [raw, 'hop/../missing.json', 'hop/../*.json', 'hop*/../checkpoint.json', 'hop*/../missing.json',
        outsideAlias, ...(base === installed ? [installedAlias] : [])];
      for (const path of bashAliases) for (const command of commands) {
        verdict(`primary Bash rejects ${command(path)}`, base, 'primary', 'Bash', { command: command(path) }, 2);
      }
      verdict('normal state reads remain allowed', base, 'primary', 'Bash', { command: `cat '${raw}'` }, 0);
      verdict('unquoted glob-parent redirection is refused', base, 'primary', 'Bash', { command: 'printf forged > hop*/../checkpoint.json' }, 2);
      verdict('POSIX class glob-parent redirection is refused', base, 'primary', 'Bash', { command: 'printf forged > ho[[:lower:]]*/../checkpoint.json' }, 2);
      verdict('collating class glob-parent redirection is refused', base, 'primary', 'Bash', { command: 'printf forged > ho[[.p.]]*/../checkpoint.json' }, 2);
      verdict('glob-parent state reads remain allowed', base, 'primary', 'Bash', { command: 'cat hop*/../checkpoint.json' }, 0);
      verdict('unowned source edits remain allowed', base, 'primary', 'Write', { file_path: join(source, 'tools/run-state-guard.mjs') }, 0);
    }
    const selectors = ['autoloop-' + 'a'.repeat(64) + '.service', 'autoloop-*.service', '*', 'a*',
      'autoloop-' + '?'.repeat(64) + '.service', 'autoloop-[0-9a-f]*.service', 'autoloop-' + 'b'.repeat(64),
      'autoloo[p]-' + 'f'.repeat(64) + '.service', 'autoloop-[!0-8]*.service',
      'autoloop-' + '0'.repeat(63) + '[a-f].service', 'autoloop-[[:xdigit:]]*.service', 'autoloop-[[:digit:]]*.service',
      '[[:ascii:]]utoloop-' + 'a'.repeat(64) + '.service', 'autoloop-*[!*]service', 'autoloo[[.p.]]-' + 'a'.repeat(64) + '.service'];
    const unrelated = ['nginx.service', 'n*.service', 'autoloop-not-a-key.service', 'autoloop-[g-z]*.service',
      'autoloop-' + '?'.repeat(63) + '.service', 'autoloop-' + 'a'.repeat(65) + '.service', 'autoloop-[[:upper:]]*.service'];
    const serviceChecks = (mode) => {
      for (const executable of ['systemctl', 'systemd-run']) for (const option of ['--help', '--version']) {
        verdict(`${mode} permits ${executable} ${option}`, installed, mode, 'Bash',
          { command: `${executable} ${option}` }, 0);
      }
      for (const unit of ['autoloop-' + 'a'.repeat(64) + '.service', 'autoloop-' + 'b'.repeat(64), 'nginx.service', 'autoloop-not-a-key.service']) {
        for (const option of [`--unit=${unit}`, `--unit ${unit}`, `--un=${unit}`, `--un ${unit}`, `--uni=${unit}`, `--uni ${unit}`,
          `-u ${unit}`, `-u${unit}`, `-qu ${unit}`, `-qu${unit}`, `-Gqru${unit}`]) {
          const status = unit === 'nginx.service' || unit === 'autoloop-not-a-key.service' ? 0 : 2;
          verdict(`${mode} service launch unit option ${option}`, installed, mode, 'Bash',
            { command: `systemd-run --user ${option} /bin/true` }, status);
        }
      }
      for (const option of ['-H', '-M', '-C', '-EuNAME=', '-pDescription=']) {
        verdict(`${mode} permits unit-looking text in ${option} value`, installed, mode, 'Bash',
          { command: `systemd-run --user ${option}uautoloop-${'a'.repeat(64)}.service /bin/true` }, 0);
      }
      const protectedUnit = 'autoloop-' + 'a'.repeat(64) + '.service';
      for (const [command, status] of [
        [`find . -exec /bin/printf '%s' -exec systemctl --user stop '${protectedUnit}' \\;`, 0],
        [`find . -exec /bin/true \\; -exec systemctl --user stop '${protectedUnit}' \\;`, 2],
        [`find . -exec find . -exec systemctl --user stop '${protectedUnit}' \\; \\;`, 2],
        [`find . -exec systemctl --user status '${protectedUnit}' \\; -exec systemctl --user reset-failed \\;`, 2],
        [`find . -exec /bin/true {} + -exec systemctl --user stop '${protectedUnit}' \\;`, 2],
        [`find ordinary-find -exec systemctl --user status '${protectedUnit}' \\; -exec /bin/true \\;`, 0],
      ]) verdict(`${mode} respects find child-command ranges ${command}`, installed, mode, 'Bash', { command }, status);
      for (const depth of [4, 5, 8, 32]) {
        const prefix = 'systemd-run --user '.repeat(depth);
        for (const [command, status] of [
          [`systemctl --user stop '${protectedUnit}'`, 2],
          [`systemd-run --user -u${protectedUnit} /bin/true`, 2],
          [`systemctl --user status '${protectedUnit}'`, 0],
          ['systemctl --user restart nginx.service', 0],
          ['systemd-run --user --unit=nginx.service /bin/true', 0],
        ]) verdict(`${mode} nested service command depth ${depth}: ${command}`, installed, mode, 'Bash',
          { command: prefix + command }, status);
      }
      for (const [command, status] of [
        [`${'fd -x '.repeat(8)}systemctl --user status '${protectedUnit}'`, 0],
        [`${'fd -x '.repeat(8)}systemctl --user stop '${protectedUnit}'`, 2],
        [`fd -x /bin/printf '%s' -x systemctl --user stop '${protectedUnit}'`, 0],
      ]) verdict(`${mode} respects fd child-command boundaries ${command}`, installed, mode, 'Bash', { command }, status);
      for (const option of ['--verbose', '-v', '--no-pager', '--job-mode=replace', '--job-mode replace',
        '--pty-late', '-T', '--verb', '--no-p', '--job replace']) {
        for (const [unit, status] of [[protectedUnit, 2], ['nginx.service', 0]]) {
          verdict(`${mode} v258 unit option grammar ${option}: ${unit}`, installed, mode, 'Bash',
            { command: `systemd-run --user ${option} --unit=${unit} /bin/true` }, status);
        }
      }
      for (const command of [
        `systemd-run --user --future-service-option --unit=${protectedUnit} /bin/true`,
        'systemd-run --user --unit=nginx.service --future-service-option /bin/true',
        'systemd-run --user --future-service-option --help',
        'systemd-run --user --unit', 'systemd-run --user -u', 'systemd-run --user --unit=',
        'systemd-run --user --description', 'systemd-run --user --job-mode',
        `systemd-run --user --u=${protectedUnit} /bin/true`,
        `systemd-run --user --ver --unit=${protectedUnit} /bin/true`,
        'systemd-run --user --verbose=yes --unit=nginx.service /bin/true',
        'systemd-run --user --user=yes --unit=nginx.service /bin/true',
        'systemd-run --user --no-pager=yes --unit=nginx.service /bin/true',
        'systemd-run --user --version=yes', 'systemd-run --user -Z --unit=nginx.service /bin/true',
      ]) verdict(`${mode} refuses unverifiable service option ${command}`, installed, mode, 'Bash', { command }, 2);
      for (const command of [
        'systemd-run --help --future-service-option',
        `systemd-run --user --unit=${protectedUnit} --vers`,
        `systemd-run --user --unit=nginx.service -- --future-service-option -u${protectedUnit}`,
        `systemd-run --user --unit=nginx.service --description --help /bin/true`,
      ]) verdict(`${mode} proven service query or command boundary ${command}`, installed, mode, 'Bash', { command }, 0);
      for (const command of [
        `systemd-run --user --description --help --unit=${protectedUnit} /bin/true`,
        `systemd-run --user --description --version --unit=${protectedUnit} /bin/true`,
      ]) verdict(`${mode} query-looking service option value stays data ${command}`, installed, mode, 'Bash', { command }, 2);
      for (const option of ['--json=help', '--job-mode=help', '--job-mode help']) {
        verdict(`${mode} permits built-in service option-value query ${option}`, installed, mode, 'Bash',
          { command: `systemd-run --user --unit=${protectedUnit} ${option} /bin/true` }, 0);
      }
      for (const option of ['--type=help', '-thelp', '--output=help', '-ohelp', '--boot-loader-entry=help',
        '--state=help', '--preset-mode=help', '--what=help', '--timestamp=help']) {
        verdict(`${mode} permits built-in systemctl option-value query ${option}`, installed, mode, 'Bash',
          { command: `systemctl --user ${option} stop '${protectedUnit}'` }, 0);
      }
      for (const command of [
        'systemctl --user reset-failed --version',
        `systemctl --user --help stop '${protectedUnit}'`,
        `systemctl --user stop '${protectedUnit}' -h`,
        'systemctl --user -qlh reset-failed',
        `systemctl --user -hlp CPUWeight stop '${protectedUnit}'`,
        `systemctl --user --he stop '${protectedUnit}'`,
        `systemctl --user stop '${protectedUnit}' --vers`,
      ]) verdict(`${mode} permits genuine mixed systemctl query ${command}`, installed, mode, 'Bash', { command }, 0);
      for (const [command, status] of [
        [`POSIXLY_CORRECT=1 systemctl --user stop '${protectedUnit}' --help`, 2],
        [`env POSIXLY_CORRECT=1 systemctl --user stop '${protectedUnit}' --version`, 2],
        [`export POSIXLY_CORRECT=1; systemctl --user stop '${protectedUnit}' --help`, 2],
        [`POSIXLY_CORRECT=1 systemctl --user --help stop '${protectedUnit}'`, 0],
        [`POSIXLY_CORRECT=1 env -u POSIXLY_CORRECT systemctl --user stop '${protectedUnit}' --help`, 0],
        [`POSIXLY_CORRECT=1 env -i systemctl --user stop '${protectedUnit}' --help`, 0],
        [`systemd-run --user -E POSIXLY_CORRECT=1 systemctl --user stop '${protectedUnit}' --help`, 2],
        [`systemd-run --user --setenv=POSIXLY_CORRECT=1 systemctl --user stop '${protectedUnit}' --version`, 2],
      ]) verdict(`${mode} respects literal query option ordering ${command}`, installed, mode, 'Bash', { command }, status);
      for (const [command, status] of [
        [`POSIXLY_CORRECT=1 systemctl --user stop nginx.service --property '${protectedUnit}'`, 2],
        [`systemctl --user stop nginx.service --property '${protectedUnit}'`, 0],
        [`systemd-run --user systemctl --user stop nginx.service --property '${protectedUnit}'`, 2],
        [`systemd-run --user systemctl --user status nginx.service --property '${protectedUnit}'`, 0],
        [`systemd-run --user systemctl --user --help stop '${protectedUnit}'`, 0],
        [`systemd-run --user systemctl --user stop '${protectedUnit}' --help`, 2],
        [`systemd-run --user env -u POSIXLY_CORRECT systemctl --user stop nginx.service --property '${protectedUnit}'`, 0],
        [`systemd-run --user -E POSIXLY_CORRECT=1 systemctl --user stop nginx.service --property '${protectedUnit}'`, 2],
        [`systemd-run --user --unit=${protectedUnit} /bin/true --help`, 2],
        [`systemd-run --user --unit=nginx.service /bin/true --future-service-option --unit=${protectedUnit}`, 0],
        [`systemctl --user --ver stop '${protectedUnit}'`, 2],
        [`systemctl --user --verbose --verb -v status '${protectedUnit}'`, 0],
      ]) verdict(`${mode} keeps unknown service environment and option boundaries safe ${command}`, installed, mode, 'Bash', { command }, status);
      for (const command of [
        `systemctl --user --property --help stop '${protectedUnit}'`,
        `systemctl --user --property --version stop '${protectedUnit}'`,
        `systemctl --user -p--help stop '${protectedUnit}'`,
        `systemctl --user -lp--version stop '${protectedUnit}'`,
        `systemctl --user --pro --help reset-failed`,
        `systemctl --user -lph stop '${protectedUnit}'`,
        `systemctl --user -- stop '${protectedUnit}' --help`,
        `systemctl --user stop '${protectedUnit}' -- --version`,
      ]) verdict(`${mode} systemctl query-looking data is not a query ${command}`, installed, mode, 'Bash', { command }, 2);
      for (const command of [
        `systemd-run --user --unit=nginx.service --description '-qu${protectedUnit}' /bin/true`,
        `systemd-run --user --unit=nginx.service --description '${protectedUnit}' /bin/true`,
        `systemd-run --user --unit=nginx.service /bin/printf '-qu${protectedUnit}'`,
        `systemd-run --user --unit=nginx.service -p 'Description=${protectedUnit}' -E 'NAME=-qu${protectedUnit}' /bin/true`,
        `systemd-run --user --unit=${protectedUnit} --unit=nginx.service /bin/true`,
        `systemd-run --user -qu${protectedUnit} --help`,
        `systemd-run --user --unit=${protectedUnit} --version`,
        `systemd-run --user -hqu${protectedUnit}`,
      ]) verdict(`${mode} permits non-unit data or read-only exit ${command}`, installed, mode, 'Bash', { command }, 0);
      for (const command of [
        `systemd-run --user --unit=nginx.service -qu${protectedUnit} /bin/true`,
        'systemd-run --user -qu nginx.service systemctl --user reset-failed',
        `systemd-run --user --unit=nginx.service --description ordinary systemctl --user stop '${protectedUnit}'`,
        'systemd-run --user --unit=nginx.service -- /usr/bin/systemctl --user reset-failed',
        `systemd-run --user -p Description=ordinary -E NAME=value --unit=nginx.service node ${installed}/tools/loop.mjs run`,
      ]) verdict(`${mode} refuses final unit or nested mutation ${command}`, installed, mode, 'Bash', { command }, 2);
      for (const command of [
        'systemctl --user reset-failed', 'systemctl reset-failed --user',
        'systemctl --user reset-failed --no-pager', 'systemctl --user -- reset-failed',
        'systemctl --user --property stop reset-failed', 'systemctl --user --ty service reset-failed',
        'systemctl --user --pro CPUWeight reset-failed', 'systemctl --user -lp CPUWeight reset-failed',
        'systemctl --user reset-failed -lp CPUWeight', 'systemctl --user -lpCPUWeight reset-failed',
        'systemctl --user reset-failed -lpCPUWeight',
      ]) verdict(`${mode} refuses all-unit reset ${command}`, installed, mode, 'Bash', { command }, 2);
      verdict(`${mode} permits unrelated named-unit reset`, installed, mode, 'Bash',
        { command: 'systemctl --user reset-failed nginx.service' }, 0);
      for (const prefix of ['--ty service', '--pro CPUWeight', '-lp CPUWeight', '-lpCPUWeight']) {
        verdict(`${mode} permits unrelated reset with ${prefix}`, installed, mode, 'Bash',
          { command: `systemctl --user ${prefix} reset-failed nginx.service` }, 0);
      }
      for (const verb of ['status', 'show', 'is-failed']) verdict(`${mode} permits no-unit getter ${verb}`, installed, mode, 'Bash',
        { command: `systemctl --user ${verb}` }, 0);
      for (const verb of ['start', 'stop', 'restart', 'try-restart', 'reload', 'reload-or-restart', 'try-reload-or-restart', 'isolate',
        'kill', 'reset-failed', 'enable', 'link', 'disable', 'reenable', 'preset', 'mask', 'unmask', 'revert', 'add-wants', 'add-requires',
        'edit', 'set-property', 'clean', 'freeze', 'thaw', 'bind', 'mount-image']) {
        verdict(`${mode} refuses named-unit mutation ${verb}`, installed, mode, 'Bash',
          { command: `systemctl --user ${verb} 'autoloop-${'a'.repeat(64)}.service' CPUWeight=10` }, 2);
        verdict(`${mode} allows unrelated named-unit mutation ${verb}`, installed, mode, 'Bash',
          { command: `systemctl --user ${verb} nginx.service CPUWeight=10` }, 0);
      }
      for (const prefix of ['--user --property CPUWeight', '--user --ty service', '--user --pro CPUWeight',
        '--user -qP CPUWeight', '--user -qHhost', '--user --image-policy strict']) {
        verdict(`${mode} refuses valued-option service mutation ${prefix}`, installed, mode, 'Bash',
          { command: `systemctl ${prefix} stop 'autoloop-*.service'` }, 2);
      }
      verdict(`${mode} status operands do not become verbs`, installed, mode, 'Bash',
        { command: "systemctl --user status stop 'autoloop-*.service'" }, 0);
      for (const getter of ['status', 'show']) for (const command of [
        `systemctl --user --property stop ${getter} autoloop-*.service`,
        `systemctl --user ${getter} --property start autoloop-*.service`,
        `systemctl --user --pro reset-failed ${getter} autoloop-*.service`,
        `systemctl --user --ty start ${getter} autoloop-*.service`,
        `systemctl --user -lp reset-failed ${getter} autoloop-*.service`,
        `systemctl --user -lpstart ${getter} autoloop-*.service`,
      ]) verdict(`${mode} read getter with mutation-looking option value ${command}`, installed, mode, 'Bash', { command }, 0);
      for (const verb of ['service-log-level', 'service-log-target']) {
        verdict(`${mode} permits service log query ${verb}`, installed, mode, 'Bash',
          { command: `systemctl --user ${verb} 'autoloop-${'a'.repeat(64)}.service'` }, 0);
        verdict(`${mode} refuses service log setter ${verb}`, installed, mode, 'Bash',
          { command: `systemctl --user ${verb} 'autoloop-${'a'.repeat(64)}.service' debug` }, 2);
        for (const command of [
          `systemctl --user --property stop ${verb} autoloop-${'a'.repeat(64)}.service`,
          `systemctl --user ${verb} --no-pager autoloop-${'a'.repeat(64)}.service`,
          `systemctl --user ${verb} autoloop-${'a'.repeat(64)}.service --no-pager`,
        ]) verdict(`${mode} service log getter options ${command}`, installed, mode, 'Bash', { command }, 0);
        for (const command of [
          `systemctl --user --property stop ${verb} autoloop-${'a'.repeat(64)}.service debug`,
          `systemctl --user ${verb} --no-pager autoloop-${'a'.repeat(64)}.service debug`,
          `systemctl --user ${verb} autoloop-${'a'.repeat(64)}.service --no-pager debug`,
        ]) verdict(`${mode} service log setter options ${command}`, installed, mode, 'Bash', { command }, 2);
      }
      for (const verb of ['enable', 'link']) {
        verdict(`${mode} refuses protected unit-file basename ${verb}`, installed, mode, 'Bash',
          { command: `systemctl --user ${verb} ${scratch}/autoloop-${'a'.repeat(64)}.service` }, 2);
        verdict(`${mode} permits unrelated unit-file basename ${verb}`, installed, mode, 'Bash',
          { command: `systemctl --user ${verb} ${scratch}/nginx.service` }, 0);
      }
      for (const selector of selectors) verdict(`${mode} refuses service selector ${selector}`, installed, mode, 'Bash',
        { command: `systemctl --user stop '${selector}'` }, 2);
      for (const selector of [...selectors, ...unrelated]) verdict(`${mode} allows status selector ${selector}`, installed, mode, 'Bash',
        { command: `systemctl --user status '${selector}'` }, 0);
      for (const selector of unrelated) verdict(`${mode} allows unrelated service selector ${selector}`, installed, mode, 'Bash',
        { command: `systemctl --user restart '${selector}'` }, 0);
    };
    serviceChecks('primary');
    serviceChecks('hook-healthy');
    // Keep the bootstrap present to test its own primary-module fallback.
    const primaryGuard = join(installed, 'tools/command-guard.mjs');
    renameSync(primaryGuard, `${primaryGuard}.unavailable`);
    serviceChecks('primary-module-failure');
    serviceChecks('hook-module-failure');
    renameSync(`${primaryGuard}.unavailable`, primaryGuard);
    // The actual hook wrapper must replay the payload after bootstrap load failure.
    renameSync(join(installed, 'tools/loop-execution-admission.mjs'), join(installed, 'tools/loop-execution-admission.mjs.unavailable'));
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) for (const path of aliases) {
      verdict(`bootstrap failure ${tool} rejects ${path}`, installed, 'hook', tool,
        { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: path }, 2);
    }
    for (const path of [raw, installedAlias, outsideAlias]) for (const command of commands) {
      verdict(`bootstrap failure Bash rejects ${command(path)}`, installed, 'hook', 'Bash', { command: command(path) }, 2);
    }
    verdict('bootstrap failure Bash rejects physical-prefix glob', installed, 'hook', 'Bash', { command: "tee 'hop/../*.json'" }, 2);
    verdict('bootstrap failure rejects glob-parent redirection', installed, 'hook', 'Bash', { command: 'printf forged > hop*/../checkpoint.json' }, 2);
    verdict('bootstrap failure rejects POSIX glob-parent redirection', installed, 'hook', 'Bash', { command: 'printf forged > ho[[:lower:]]*/../checkpoint.json' }, 2);
    verdict('bootstrap failure rejects collating glob-parent redirection', installed, 'hook', 'Bash', { command: 'printf forged > ho[[.p.]]*/../checkpoint.json' }, 2);
    verdict('bootstrap failure permits glob-parent reads', installed, 'hook', 'Bash', { command: 'cat hop*/../checkpoint.json' }, 0);
    verdict('bootstrap failure permits normal state reads', installed, 'hook', 'Bash', { command: `cat '${raw}'` }, 0);
    verdict('bootstrap failure permits unowned source edits', installed, 'hook', 'Write', { file_path: join(source, 'tools/run-state-guard.mjs') }, 0);
    serviceChecks('hook');
    mkdirSync(join(source, 'nested'));
    writeFileSync(join(source, 'ordinary.mjs'), 'ordinary');
    symlinkSync(join(source, 'nested'), join(repo, 'source-hop'));
    mkdirSync(join(repo, 'bounded'));
    for (let index = 0; index < 65; index += 1) symlinkSync(join(protectedDir, 'nested'), join(repo, 'bounded', `hop${index}`));
    for (const mode of ['primary', 'hook']) {
      const base = mode === 'primary' ? source : installed;
      verdict(`${mode} permits proven source glob-parent writes`, base, mode, 'Bash', { command: 'tee source-hop*/../ordinary.mjs' }, 0);
      verdict(`${mode} refuses unprovable bounded glob-parent writes`, base, mode, 'Bash', { command: 'tee bounded/hop*/../checkpoint.json' }, 2);
      verdict(`${mode} refuses unprovable bounded glob-parent touch`, base, mode, 'Bash', { command: 'touch bounded/hop*/../checkpoint.json' }, 2);
      verdict(`${mode} permits bounded glob-parent reads`, base, mode, 'Bash', { command: 'cat bounded/hop*/../checkpoint.json' }, 0);
      verdict(`${mode} refuses recursive glob-parent writes`, base, mode, 'Bash', { command: 'tee bounded/**/../checkpoint.json' }, 2);
      verdict(`${mode} permits recursive glob-parent reads`, base, mode, 'Bash', { command: 'cat bounded/**/../checkpoint.json' }, 0);
    }
    for (const name of ['host-invocations', 'worker-bindings', 'execution-admission']) {
      const state = join(home, '.claude/autoloop', name);
      mkdirSync(join(state, 'nested'), { recursive: true });
      symlinkSync(join(state, 'nested'), join(repo, name));
      for (const mode of ['primary', 'hook']) {
        const base = mode === 'primary' ? source : installed;
        const path = `${repo}/${name}/../repo-key/daemon-authority.json`;
        verdict(`${mode} protects fixed OS-account ${name}`, base, mode, 'Write', { file_path: path }, 2, { HOME: join(scratch, 'other-home') });
        verdict(`${mode} Bash protects fixed OS-account ${name}`, base, mode, 'Bash', { command: `printf forged > '${path}'` }, 2, { HOME: join(scratch, 'other-home') });
      }
    }
    // An installed dev-mod spelling is protected, but its ordinary source target is not.
    const devmod = join(scratch, '.claude/plugins/cache/fixture/autoloop/devmod');
    mkdirSync(dirname(devmod), { recursive: true });
    symlinkSync(source, devmod);
    verdict('installed dev-mod spelling is refused', devmod, 'primary', 'Write', { file_path: `${devmod}/tools/run-state-guard.mjs` }, 2);
    verdict('ordinary source behind dev-mod remains editable', devmod, 'primary', 'Write', { file_path: join(source, 'tools/run-state-guard.mjs') }, 0);
    check('unowned guards do not invoke Git or GitHub', () => assert.equal(existsSync(calls), false));
    const importTemp = join(scratch, 'import-temp');
    mkdirSync(importTemp);
    check('import has no test effects or output', () => {
      const imported = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[2]);',
        'import-probe', fileURLToPath(import.meta.url)], {
        env: { ...env, TMPDIR: importTemp }, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
      });
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(imported.stdout, '');
      assert.equal(imported.stderr, '');
      assert.deepEqual(readdirSync(importTemp), []);
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures.length ? `self-test FAILED (${failures.length}/${checks})` : `self-test OK (${checks} checks)`);
  return failures.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
})();
if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') process.exit(selfTest() ? 0 : 1);
  console.error('usage: guard-alias-test.mjs --self-test');
  process.exit(2);
}
