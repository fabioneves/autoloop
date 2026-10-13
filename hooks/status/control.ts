// The controls (docs/specs/SPEC-central.md item 16, SPEC-events items 7 to
// 12): pause, unpause, cancel, answer, merge and label. The mod holds no
// path and writes no file: it runs `tools/status.mjs --control`, which
// validates the control and writes it atomically for the session that owns
// the run. The answer is toasted, and a parked session is woken with one
// prompt, so the loop's prime applies the control. The mod never runs gh,
// git or a loop tool for a control.
import type { Runner } from './read'

export const CONTROL_TIMEOUT_MS = 2000
/** The prompt that wakes a parked session: the dev skill reads it as "run prime, which applies the control". */
export const WAKE_PROMPT = 'autoloop: control'

export type Control =
  | { kind: 'pause' }
  | { kind: 'unpause' }
  | { kind: 'cancel'; dispatch: string; issue: number | null }
  | { kind: 'answer'; issue: number; text: string }
  | { kind: 'merge'; pr: number }
  | { kind: 'label'; pr: number }

/** The producer's argv for one control: the kind and its fields as `--kind`, `--pr`, `--issue`, `--dispatch`, `--text`. */
export function controlArgv(pluginRoot: string, sessionId: string, control: Control): string[] {
  const argv = ['node', `${pluginRoot}/tools/status.mjs`, '--control', '--session', sessionId, '--kind', control.kind]
  if (control.kind === 'cancel') argv.push('--dispatch', control.dispatch, ...(control.issue === null ? [] : ['--issue', String(control.issue)]))
  if (control.kind === 'answer') argv.push('--issue', String(control.issue), '--text', control.text)
  if (control.kind === 'merge' || control.kind === 'label') argv.push('--pr', String(control.pr))
  return argv
}

/** The control as the toasts name it: `pause`, `cancel #517`, `answer #417`, `merge PR #700`, `label PR #701`. */
export function controlName(control: { kind: string | null; pr?: number | null; issue?: number | null; dispatch?: string }): string {
  const kind = control.kind ?? 'control'
  if (control.pr !== null && control.pr !== undefined) return `${kind} PR #${control.pr}`
  if (control.issue !== null && control.issue !== undefined) return `${kind} #${control.issue}`
  return control.dispatch === undefined ? kind : `${kind} ${control.dispatch}`
}

/** The toast for a control the loop refused (SPEC-central item 16). */
export function refusedText(refused: { kind: string | null; pr: number | null; issue: number | null; reason: string }): string {
  return `✗ ${controlName(refused)} refused: ${refused.reason}`
}

/** The producer's answer, or the reason it is not one. */
export function parseControlAnswer(result: { exitCode: number; stdout: string }): { ok: true; name: string } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { ok: false, error: result.exitCode === 0 ? 'the producer printed no answer' : `the producer exited ${result.exitCode}` }
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  if (record['ok'] === true && typeof record['name'] === 'string') return { ok: true, name: record['name'] }
  return { ok: false, error: typeof record['error'] === 'string' ? record['error'] : 'the producer refused the control' }
}

/** The host beneath a control, injected by register.tsx: the producer's runner, the toasts, the prompt queue, the plugin root and the session id. */
export type ControlHost = {
  run: Runner
  toast: (text: string) => void
  submit: (text: string) => Promise<unknown>
  pluginRoot: string
  sessionId: () => Promise<string>
}

/**
 * One control: run the producer, toast the outcome, and on success queue
 * the wake prompt (a turn of its own once the session is idle, so a parked
 * loop primes and applies the control). Never throws: a host call that
 * rejects is the toast's text.
 */
export async function sendControl(host: ControlHost, control: Control): Promise<void> {
  const name = controlName(control)
  try {
    const answer = parseControlAnswer(await host.run(controlArgv(host.pluginRoot, await host.sessionId(), control), { timeoutMs: CONTROL_TIMEOUT_MS }))
    if (!answer.ok) {
      host.toast(`✗ ${name}: ${answer.error}`)
      return
    }
    host.toast(`✓ ${name} sent`)
    // Not awaited: the call resolves when the queued turn starts, which
    // waits on a running turn.
    host.submit(WAKE_PROMPT).catch(() => undefined)
  } catch (error) {
    host.toast(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
