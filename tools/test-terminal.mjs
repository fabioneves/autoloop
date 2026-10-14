// Test-only PTY transport. BSD script requires a terminal on stdin; Node's
// child-process pipes do not supply one. pty.fork creates the controlling
// terminal before exec, without changing admission checks or the environment.
import { spawn } from 'node:child_process';

const adapter = `import errno, os, pty, select, signal, sys

pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

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
    # The child has not been reaped, so its process-group ID cannot be reused.
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(master)
    _, status = os.waitpid(pid, 0)

code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

export function spawnTestTerminal(argv, { env = process.env } = {}) {
  const child = spawn('python3', ['-I', '-u', '-c', adapter, ...argv], {
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
  const deadline = Date.now() + 15000;
  const timeout = setTimeout(() => {
    child.errors += 'Terminal fixture timed out.';
    child.cleanup();
  }, 15000);
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
