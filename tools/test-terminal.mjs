// Test-only PTY transport. BSD script requires a terminal on stdin; Node's
// child-process pipes do not supply one. pty.fork creates the controlling
// terminal before exec, without changing admission checks or the environment.
import { spawn } from 'node:child_process';

const adapter = `import errno, os, pty, select, signal, subprocess, sys, time

# Share the existing fixture deadline; observation must not extend it.
deadline = time.monotonic() + max(0, float(sys.argv[1]) / 1000 - time.time())
pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])

def require_zombie_only_group():
    # XNU closes the PTY before publishing the exit to waitid. WNOWAIT
    # reserves the child's PID while that observation becomes available.
    while True:
        exited = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if exited is not None:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('The PTY child exit is not observable before the fixture deadline.')
        time.sleep(min(0.01, remaining))
    if exited.si_pid != pid:
        raise RuntimeError('The PTY exit observation names another child.')
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError('The PTY group proof reached the fixture deadline.')
    snapshot = subprocess.check_output(['ps', '-axo', 'pid=,pgid=,stat='], text=True, timeout=min(5, remaining))
    found_child = False
    for line in snapshot.splitlines():
        fields = line.split()
        if len(fields) != 3 or not fields[0].isdigit() or not fields[1].isdigit():
            raise RuntimeError('The PTY group snapshot is invalid.')
        member, group, state = fields
        if int(group) == pid:
            if not state.startswith('Z'):
                raise RuntimeError('The PTY group has a live or unknown member: ' + line.strip())
            found_child = found_child or int(member) == pid
    if not found_child:
        raise RuntimeError('The PTY group snapshot does not contain the owned zombie.')

def stop(signum, frame):
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    inputs = [master, 0]
    while True:
        ready, _, _ = select.select(inputs, [], [])
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break
            while data:
                data = data[os.write(master, data):]
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    # Keep the child unreaped through every group check and signal.
    try:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            # XNU can return EPERM during exit or for a zombie-only group.
            # Require a published exit and no live group member before reaping.
            require_zombie_only_group()
    except Exception as error:
        # Reap the owned child on failure, but do not claim group cleanup.
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            os.waitpid(pid, os.WNOHANG)
            raise RuntimeError('The PTY child and group cleanup are unverified.') from error
        _, status = os.waitpid(pid, 0)
        raise RuntimeError('The PTY group cleanup is unverified; child exit ' +
                           str(os.waitstatus_to_exitcode(status)) + '.') from error
    finally:
        os.close(master)
    _, status = os.waitpid(pid, 0)

code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

export function spawnTestTerminal(argv, { env = process.env } = {}) {
  const deadline = Date.now() + 15000;
  const child = spawn('python3', ['-I', '-u', '-c', adapter, String(deadline), ...argv], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.output = '';
  child.errors = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.errors += chunk; });
  child.on('error', (error) => { child.errors += error.message; });
  // A closed pipe is possible when the command exits before an answer arrives.
  child.stdin.on('error', (error) => { child.errors += error.message; });
  child.closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
  child.cleanup = () => child.kill('SIGTERM');
  const timeout = setTimeout(() => {
    child.errors += 'Terminal fixture timed out.';
    child.cleanup();
  }, Math.max(0, deadline - Date.now()));
  child.closed.then(() => clearTimeout(timeout));
  child.waitForOutput = async (text) => {
    while (!child.output.includes(text)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
        throw new Error(`Terminal did not print ${JSON.stringify(text)}: ${child.output}${child.errors}`);
      }
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  return child;
}
