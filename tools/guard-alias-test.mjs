#!/usr/bin/env node
// Real temporary filesystem and hook-entry regressions. No service is started.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalGuardPath } from './run-state-guard.mjs';

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
    const repo = join(scratch, 'repo');
    const home = join(scratch, 'os-home');
    const installed = join(scratch, '.claude/plugins/cache/fixture/autoloop/1');
    const source = join(scratch, 'source');
    mkdirSync(repo);
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
    const hooks = JSON.parse(readFileSync(join(installed, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse;
    const hookCommand = (kind) => hooks.find((entry) => entry.matcher.startsWith(kind === 'edit' ? 'Edit' : 'Bash')).hooks[0].command;
    const invoke = (base, mode, tool, input, extraEnv = {}) => {
      const kind = tool === 'Bash' ? 'command' : 'edit';
      const args = mode === 'hook' ? ['-c', hookCommand(kind)]
        : [join(base, 'tools/loop-execution-admission.mjs'), '--guard-entry', kind];
      const result = spawnSync(mode === 'hook' ? 'bash' : process.execPath, args, {
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
      for (const verb of ['start', 'stop', 'restart', 'try-restart', 'reload', 'reload-or-restart', 'try-reload-or-restart', 'isolate',
        'kill', 'reset-failed', 'enable', 'link', 'disable', 'reenable', 'preset', 'mask', 'unmask', 'revert', 'add-wants', 'add-requires',
        'edit', 'set-property', 'clean', 'freeze', 'thaw', 'bind', 'mount-image']) {
        verdict(`${mode} refuses named-unit mutation ${verb}`, installed, mode, 'Bash',
          { command: `systemctl --user ${verb} 'autoloop-${'a'.repeat(64)}.service' CPUWeight=10` }, 2);
        verdict(`${mode} allows unrelated named-unit mutation ${verb}`, installed, mode, 'Bash',
          { command: `systemctl --user ${verb} nginx.service CPUWeight=10` }, 0);
      }
      for (const prefix of ['--user --property CPUWeight', '--user -qP CPUWeight', '--user -qHhost', '--user --image-policy strict']) {
        verdict(`${mode} refuses valued-option service mutation ${prefix}`, installed, mode, 'Bash',
          { command: `systemctl ${prefix} stop 'autoloop-*.service'` }, 2);
      }
      verdict(`${mode} status operands do not become verbs`, installed, mode, 'Bash',
        { command: "systemctl --user status stop 'autoloop-*.service'" }, 0);
      for (const getter of ['status', 'show']) for (const command of [
        `systemctl --user --property stop ${getter} autoloop-*.service`,
        `systemctl --user ${getter} --property start autoloop-*.service`,
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
