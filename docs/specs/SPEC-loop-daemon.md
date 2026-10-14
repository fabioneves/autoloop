# Spec: Loop daemon

Module: `loop-daemon`. Providers: `events`, `central`. Index: [Scheduler](SPEC-scheduler.md).
Plan tasks 1–4 and the module specification task. This is an executable contract for module 1.

## Objective

Provide a supervised Node scheduler that survives its initiating Claude Code session.
The operator can discover, attach, pause, resume and stop it through Central or a trusted
terminal. Module 1 runs no production selection, unit model, or GitHub mutation.

Completion means real lifecycle, control, recovery and status behavior. An empty queue is not
reported as delivered work. Absent later-module operations are explicitly unsupported.
The existing `/autoloop:dev` production orchestration remains in use until final cutover.

## Tech stack and existing contracts

Use Node ESM and the project's supported Node versions. Linux daemon supervision uses a named
systemd user service. The foreground runner and state-machine tests work on Linux and macOS.
No package, proxy, model route, context-window or permission-setting change is implied.

Reuse `processStart`, `processAlive`, `readRegularFile`, `recordHostSession` and `takeHostSession`
from `tools/run-markers.mjs`, with stronger daemon identity validation. Do not copy the legacy
fallback that accepts missing start identity. Extend `tools/status.mjs` and `hooks/status/`.
`tools/events-contract.mjs` remains the legacy event/control provider.

## Commands

New commands below become executable when module 1 ships. Run them from the plugin root.
`/workspace/widgets` is a synthetic target checkout.

```bash
node tools/loop.mjs start --root /workspace/widgets --operator-terminal --json
node tools/loop.mjs status --root /workspace/widgets --json
node tools/loop.mjs pause --root /workspace/widgets --run <run-id> --request <request-id> --operator-terminal --json
node tools/loop.mjs resume --root /workspace/widgets --run <run-id> --request <request-id> --operator-terminal --json
node tools/loop.mjs stop --root /workspace/widgets --run <run-id> --request <request-id> --operator-terminal --json
node tools/loop.mjs stop --now --root /workspace/widgets --run <run-id> --request <request-id> --operator-terminal --json
node tools/loop.mjs request-status --root /workspace/widgets --run <run-id> --request <request-id> --json
node tools/loop.mjs run --root /workspace/widgets --foreground --operator-terminal
node tools/status.mjs --json --session <viewer-session-id> --root /workspace/widgets
node tools/status.mjs --discover --session <viewer-session-id> --root /workspace/widgets
node tools/status.mjs --attach --session <viewer-session-id> --run <run-id> --root /workspace/widgets --host-request
node tools/status.mjs --disconnect --session <viewer-session-id> --root /workspace/widgets --host-request
node tools/status.mjs --control --session <viewer-session-id> --run <run-id> --request <request-id> --kind pause --root /workspace/widgets --host-request
node tools/loop.mjs --self-test
node tools/scheduler-contract.mjs --self-test
node tools/loop-supervisor.mjs --self-test
node tools/run-markers.mjs --self-test
node tools/events-contract.mjs --self-test
node tools/status.mjs --self-test
claude plugin validate --strict .
claude plugin test .
node tools/verify.mjs --plugin-root .
```

`--host-request` reads one host invocation envelope from stdin. It is not an authorization flag
on its own. The same transport is available to `loop.mjs start` from the trusted mod.
`start` uses the tested default containment profile below. Optional
`--supervisor-profile <file>` accepts schema `autoloop.supervisor-profile/1` and all three
resource fields. Validate any override before launch. The trusted mod can pass an
operator-selected override; it does not write profiles or change machine-global settings.
The internal launcher reads the pinned resolved profile.
`run --supervised --run <run-id>` is an internal launcher operation, not an operator command.
Do not expose a production queue or test-effect command. Self-tests alone inject external fixtures.

Central commands are `/autoloop start`, `/autoloop attach`, `/autoloop disconnect`,
`/autoloop pause`, `/autoloop resume`, `/autoloop stop` and `/autoloop stop now`.
`/autoloop` and `/autoloop close` retain their pane behavior. Discovery alone never attaches.
Closing the pane alone does not disconnect or stop the daemon.

### Results and errors

A JSON command prints one object and a newline. Human diagnostics go to stderr.
Use these envelopes; never expose credentials or raw external output in an error.

```json
{"schema":"autoloop.loop/1","ok":true,"data":{"runId":"<uuid>","generation":1,"state":"running","queueEnabled":false}}
{"schema":"autoloop.loop/1","ok":false,"error":{"code":"UNSUPPORTED_ACTION","message":"Unit actions are not available in this module."}}
```

Exit codes: `0` for a successful read or durable accepted request; `2` for invalid input;
`3` for refusal/conflict; `4` for unavailable supervision or readiness failure;
`5` for state I/O or recovery failure. Acceptance is not completion of a control.
A control response contains `requestId`, `runId`, `status: pending|processing|applied|refused|unknown`
and `outcome: null|<receipt>`. `request-status` returns the same shape. Unknown request IDs return
`REQUEST_NOT_FOUND`, not a success. A reused ID with different content returns
`REQUEST_ID_CONFLICT`. A status read without a run returns `data: { state: "absent" }`.

Named refusal codes include `LEGACY_RUN_ACTIVE`, `SCHEDULER_ACTIVE`, `OWNER_UNVERIFIED`,
`HOST_AUTH_REQUIRED`, `RUN_MISMATCH`, `TARGET_MISMATCH`, `UNSUPPORTED_ACTION`,
`SUPERVISOR_UNAVAILABLE`, `READINESS_FAILED`, `STATE_INVALID`, `STATE_IO_FAILED` and
`OUTCOME_UNKNOWN`. Callers use codes, not message text.

## Project structure

- `tools/loop.mjs`: argument parsing, trusted operator entry, foreground event loop and lifecycle.
- `tools/scheduler-contract.mjs`: canonical identity, exclusive acquisition, reducers, schemas,
  checkpoint transactions, durable requests, outbox and recovery. Embedded self-tests.
- `tools/loop-supervisor.mjs`: systemd launch/readiness/process containment. Embedded tests.
- `tools/run-markers.mjs`, `tools/command-guard.mjs`, `tools/edit-guard.mjs`,
  `tools/run-state-guard.mjs`: separate daemon/worker/viewer predicates and protected state.
- `tools/prime.mjs`: mutual start exclusion only. Retain legacy scheduling and readers.
- `tools/status.mjs`, `hooks/status/{register.tsx,read.ts,control.ts}`,
  `types/index.d.ts`, producer fixtures and existing mod tests: compatible projection/attachment.
- `tools/verify.mjs`: register new tools and self-tests. Do not make a self-test call itself.

Resolve the repository with root-explicit Git commands and canonical `realpath` of
`git rev-parse --git-common-dir`. The same directory, reached from another linked worktree or
symlink, gives the same repository key: SHA-256 of its canonical UTF-8 path.

Protected durable state is `<common-dir>/autoloop/scheduler/`:

```text
lock                         exclusive repository lifetime lock
current.json                 { schema, runId } pointer
runs/<run-id>/checkpoint.json authoritative transaction, including outbox and receipts
runs/<run-id>/pins.json       immutable non-secret launch/config/model pins
runs/<run-id>/streams/        validated worker stream paths, when workers exist
launches/<launch-id>.json    immutable, private internal service handoff
launches/staged-<id>.json    retained publication link; no automatic pruning
```

Daemon controls use `<common-dir>/autoloop/control/v2/{requests,pending,processing,outcomes}/`.
`requests/<request-id>.json` is the immutable transport identity across all queue phases.
Legacy controls stay in the existing locations. Never pass a v2 request to `takeControls`' v1
consumer. Regular files and real directories only; no links, FIFOs or traversal components.
Create private directories/files with modes `0700`/`0600`. Verify type, owner and private
permissions on opened descriptors, including existing stores and records. Refuse unsafe paths;
never silently chmod them. Shared Git-admin/legacy ancestors may retain owned `0755` modes,
but daemon storage ancestors must not be writable by other accounts.
Protect scheduler, control and worktree Git-admin state through aliases as well as literal paths.

## Executable data contracts

All new protocol objects reject unknown fields and unsupported schema versions. UUIDs must be
canonical, integers safe and positive where required, and timestamps epoch milliseconds.
Use explicit `null`, not an absent required field. Hashes use SHA-256 lowercase hexadecimal.
Git OIDs use the repository's verified object format. Do not add size-of-work quotas.

### Identity, pins and checkpoint

`ProcessIdentity = { pid, start, bootId }`. `start` is the OS process-start identity;
`bootId` identifies this boot. If either cannot be established, ownership is unknown.
`generation`: a positive integer that increases on every daemon incarnation in the same run.
`ControlResponse = { requestId, runId, status, outcome }`, where `outcome` is nullable or the
validated `Outcome` receipt below. A submit reply adds `accepted: true` only after durable
publication; a refused admission uses the common error envelope. It never implies `applied`.

`Pins` uses schema `autoloop.scheduler-pins/1` with required fields:
`runId`, `repositoryKey`, `commonDir`, `coordinatorRoot`, `baseBranch`, `pluginRoot`,
`pluginVersion`, `pluginDigest`, `nodePath`, `enginePath`, `config`, `configDigest`, `models`,
`modelsDigest`, `supervisorProfile` and `createdAt`.
`config` is the validated, credential-free effective configuration. `models` contains resolved
role routes and allowed fallback policy. Record actual worker model identities separately.
A changed path, digest or effective configuration does not silently change an existing run.
If pinned executable content is missing or changed, refuse worker execution and show the reason.
Keep only necessary credential-free environment settings. Credentials remain in the host's
supported credential source. Do not store a full environment, auth file or credential command line.
`supervisorProfile = { memoryMaxBytes, memorySwapMaxBytes, tasksMax }`, with positive safe
integers for memory/tasks and a nonnegative safe integer for swap. Default to
`{ memoryMaxBytes: 6442450944, memorySwapMaxBytes: 0, tasksMax: 2048 }`: the prior gate's
tested 6 GiB memory, zero swap and TasksMax 2048 containment. Pin the resolved profile.
An incomplete or invalid override is refused. These limits contain processes; they are not
work-size quotas. Starting a live service still requires separate activation approval.

`Checkpoint` uses schema `autoloop.scheduler-checkpoint/1` with required fields:

| Field | Contract |
|---|---|
| `runId`, `repositoryKey`, `generation`, `revision` | Run identity; revision increases on each durable transaction. |
| `owner` | Verified `ProcessIdentity`, or `null` before readiness. |
| `initiator` | `{ kind: mod|terminal, sessionId: string|null, process: ProcessIdentity }`; historical, not writer ownership. |
| `pinsDigest` | Digest of immutable pins. |
| `state` | `starting|recovering|running|paused|draining|stopped|failed`. |
| `desiredState` | `running|paused|stopped`; retained through restart. |
| `stopMode` | `null|graceful|immediate`. |
| `queueEnabled` | `false` in module 1. No argument can enable it. |
| `units`, `reservations`, `workers` | Arrays; empty for a normal module 1 run. Versioned later-module records are not fabricated. |
| `requests` | Map from request UUID to `{ requestHash, request, status, claimedGeneration, outcome }`. |
| `outbox` | Map from operation UUID to the effect record below. |
| `createdAt`, `updatedAt`, `stoppedAt` | Epoch milliseconds; `stoppedAt` nullable. |
| `error` | `null` or `{ code, message }`. |

A future `WorkerBinding` requires `runId`, `generation`, `unitId`, `unitGeneration`, `attemptId`,
`sessionId`, `worktreeGitDir`, `process`, `pgid`, `groupLeader`, `role`, `posture`,
`actualModel`, `liveFile` and `cancelledByOperator`. Module 1 validates/reconciles fixture bindings;
it does not manufacture production workers. Register a binding before model tools can run.

Store each transaction as one complete checkpoint. Write an exclusive temporary regular file,
flush it, rename it atomically, then flush the parent directory before reporting durability.
Apply the same rule to pins and the current pointer. Publish pins/checkpoint before the pointer.
Flush the parent entry of each newly created authoritative directory before publishing anything
that depends on it. This includes run, lease, control and launch directories. Failed directory
flushes are state failures, not successful durability. Retried creation also establishes parent durability.
The checkpoint contains request claims, outcomes and outbox together; separate request files are
transport copies. A crash between files cannot create an applied request absent from the checkpoint.
An invalid authoritative checkpoint is a visible recovery failure, never an empty queue.

### Exclusive acquisition and legacy exclusion

The repository lifetime lock is exclusive and held through drain, reconciliation and final flush.
Use a verified OS locking primitive or equivalent atomic exclusion with fencing. A PID file,
check-then-create, timeout-based stale deletion, or untested copied stale-lock algorithm is insufficient.
Do not reclaim a lock merely because its timestamp is old. Concurrent starts must have one winner.

The short shared admission ledger lives in the protected OS-account runtime at
`.claude/autoloop/execution-admission/<repositoryKey>/`. It uses the same immutable election
and fencing. This moves only admission coordination, not checkpoints, lifetime leases or controls.
Before the first daemon lease, publish and flush immutable `daemon-authority.json` there.
Missing, corrupt or unsafe established Git authority is a recovery refusal, never absent state.
Do not prune or reset this marker. Never-daemon legacy repositories can keep existing `0775`
Git-admin modes for legacy startup and pure status reads; daemon activation still requires safe
ancestors and private daemon stores. An environment variable cannot redirect this authority.

Both start paths use the same atomic repository admission gate. Legacy prime publishes its owner
marker while holding the gate. Daemon start publishes its lock/starting record while holding it.
Each checks the other's verified owners and unresolved workers before admission. Inspect all linked
worktrees by common-directory identity, not only a foreign owner's current checkout prefix.
A daemon cannot start while a legacy loop is active. Legacy prime cannot open/reopen a run while
an active or recovering daemon owns it. Legacy `--close-run` cannot close the daemon.

The atomic exclusion guarantee applies to upgraded entry points that use this gate. An older
installed binary does not become cooperative when a new plugin is installed. Before live activation,
drain old-version legacy runs and their detached dispatches, verify their process groups have exited,
and restart participating sessions on the upgraded plugin. Known live or unresolved legacy workers
still refuse admission. Do not claim that the gate can prevent an old binary from starting later.

On dead-owner recovery, acquire exclusion first, validate boot/start identities, increase generation
and persist `recovering` before effects. Old-generation results cannot advance the run.
Retain live or uncertain children, reservations and occupied slots until reconciled. A live verified
child is observed or cancelled by its binding, not duplicated. A dead worker or leader does not
release its binding while its recorded group is alive or unknown. Group existence alone does not
authorize a signal after stored leader identity is lost. Cleanup requires confirmed process and
group absence. An unknown group is not killed.
Never infer a worker from an event line. No state reconstruction from logs.

### Controls, claims and outbox

A v2 control has exactly:

```json
{"schema":"autoloop.control/2","requestId":"<uuid>","runId":"<uuid>","kind":"pause","target":{"type":"run","generation":1},"payload":{},"submittedAt":1791849600000,"actor":{"kind":"mod","sessionId":"<uuid>","host":{"pid":123,"start":"<os-start>","bootId":"<boot-id>"},"invocationId":"<uuid>"}}
```

`actor` is set by the admitted producer, never trusted from a model result.
Supported module 1 kinds: `pause`, `resume`, `stop`, `stop-now` with run targets and empty payloads.
The future unit-action shapes are reserved as follows; they remain unsupported in module 1:

| Kind | Target | Payload |
|---|---|---|
| `cancel` | `{ type: unit, unitId, unitGeneration, attemptId }` | `{}` |
| `answer` | `{ type: unit, unitId, unitGeneration, issue }` | `{ text }` |
| `merge`, `label` | `{ type: pr, unitId, unitGeneration, pr, expectedHead }` | `{}` |

Validate these fields before reporting `UNSUPPORTED_ACTION`. They do not call `gh` or claim
success. Module 1 immediate run stop can cancel verified fixture workers through the lifecycle path.

Canonical hash covers schema, request ID, run, kind, target and payload. Atomically create the
immutable `requests/<request-id>.json` without overwrite, so request identity survives moves
between pending and processing. Same ID/hash returns the recorded pending or final result;
different content returns `REQUEST_ID_CONFLICT`. Publish the pending transport reference only
after the immutable request is durable. Recovery finds a durable request without a pending
reference and requeues it unless checkpoint already claims or settles it.
Atomically rename pending to processing without replacing an existing claim. Persist the
checkpoint claim before an effect. Only the exclusive daemon consumer can apply it. A claimed
transport file left after a crash is reconciled against the checkpoint. A pending duplicate must
never execute while the original is unknown. Retain outcomes through the entire run and all
recovery/retry paths; no seven-day pruning of authoritative daemon receipts.

`Outcome = { schema: autoloop.control-outcome/2, requestId, runId, requestHash, status,
code, appliedRevision: integer|null, operationId: uuid|null, completedAt: ms|null }`.
Final statuses are `applied` or `refused`. `unknown` remains unresolved, not successful.
Persist the outcome before acknowledging or publishing its transport copy. Old-run controls and
stale target generations are refused. A restart does not retarget them to a new generation.

`Effect = { operationId, requestId: uuid|null, runId, unitId: uuid|null, unitGeneration: integer|null,
kind, target, inputDigest, expectedHead: oid|null, phase, attempt, receipt, error }`.
`phase = prepared|in-flight|unknown|succeeded|failed`; `receipt` and `error` are nullable.
Persist `prepared`, then `in-flight`, before the external call. A crash after the call requires
readback of the actual target. Reconcile `applied|not-applied|unknown`; only verified not-applied
permits retry. Persist the receipt and linked outcome in one checkpoint transaction.
Local pause/stop intent can be replayed by reduction. Remote effects cannot.

Prepared, in-flight and unknown effects all prevent an unaccounted fresh run. Prepared means
not invoked; it must not be called unknown merely because it is retained. Under the current lease
and recorded desired-stopped intent, an uninvoked non-cancellation effect may be failed explicitly
as `STOPPED_BEFORE_LAUNCH`. Preserve its intent, attempt and receipts. Invoked/unknown effects
still require readback; prepared cancellation cannot take this abandonment path. Runtime stop,
launch selection, supervisor recovery and shared legacy admission use the same unresolved predicate.

Recovery has one narrow exception for a new explicit `stop-now` intent. A new `process.cancel`
effect at attempt 1 may be prepared and started while other effects are unknown only when:
- The stored request is processing, belongs to the current run, and was claimed in the current
  daemon generation. Its run target names that same generation. An old unknown request does
  not qualify.
- The checkpoint already records desired stopped and immediate mode. The complete registered
  worker target set is marked operator-cancelled and retained before the first signal.
- The effect binds one exact registered unit/generation/attempt and its process group. Actual
  process start, boot identity and group leadership match the binding before admission and
  immediately before each signal.

Starting, stopped and failed states still refuse new effects. `process.start`, ordinary cancel,
all other effects and unknown-operation retries remain blocked. No general recovery bypass flag
is permitted. Prior unknown operations retain their intents and outcomes until verified readback.
A stop-now outcome is applied only after every retained target group has confirmed exit. Unknown
or live targets keep the outcome processing/unknown; the first settled effect cannot complete it.
Process the full retained target set even if an earlier target is unknown. Stop each verified group,
retain unverified groups, and settle the aggregate only after the pass. The internal `deferControl`
settlement option applies only to the current processing immediate-stop request; it adds no signal
permission. Target ordering and a restart cannot cause a later verified group to be skipped.
If an exact retained cancellation target exits after preparation but before execution, reconcile
its desired state from confirmed process and group absence. Record `GROUP_ALREADY_EXITED`, not
successful signal delivery. This permits only prepared `process.cancel` attempt 1 with the same
stored run/request/unit/attempt binding and operator-cancelled intent. It does not permit a call,
retry, wrong binding, ordinary prepared effect, or a conclusion from unknown group state.

Module 1 supplies the outbox mechanism and process-effect reconciliation. External fake effect
integration tests exercise the crash-before-call, crash-after-effect and crash-before-ack cases.
No production GitHub adapter is registered yet. Do not call those tests proof of exactly-once
remote execution.

### Provider API

`tools/scheduler-contract.mjs` supplies these operations for the CLI and later modules:

```text
resolveRepository(root) -> { repositoryKey, commonDir, coordinatorRoot }
readProcessIdentity(pid?) -> ProcessIdentity
processIdentityState(identity) -> alive|dead|unknown
processGroupOf(pid) -> pgid|null
boundGroupState(worker) -> alive|empty|unknown
assertNoKnownLegacyOwner(repository) -> void or LEGACY_RUN_ACTIVE
acquireScheduler(repository, pins, initiator) -> { runId, generation, lease }
readCheckpoint(repository, runId) -> Checkpoint
commitTransition(lease, expectedRevision, transition) -> Checkpoint
submitControl(repository, admittedActor, request) -> ControlResponse
claimControl(lease, requestId) -> ControlResponse
prepareEffect(lease, expectedRevision, effect) -> Checkpoint
settleEffect(lease, operationId, observation) -> Checkpoint
readRequest(repository, runId, requestId) -> ControlResponse
registerWorker(lease, expectedRevision, binding) -> Checkpoint
```

`lease` is an in-process capability tied to the held lock, process identity and generation.
It is never serialized or accepted from worker JSON. All updates check generation and revision.
One event loop owns mutations. External calls run asynchronously; reducers receive validated
observations. There is no second worker checkpoint writer.

## Supervision and lifecycle

Use `autoloop-<repository-key>.service`, one stable systemd user unit per canonical repository.
The short launcher returns only after the service owns its lock and a validated checkpoint reports
readiness for the expected run/generation. An existing live matching run returns `alreadyRunning`
without a new run. A failed readiness probe returns failure and retains diagnostic state.

Pin the absolute Node/plugin paths. Use `Restart=on-failure` for unexpected exits. On restart,
enter recovery before reporting running. A successful stopped exit is not restarted. An explicit
stop records desired stopped before termination, including cancellation during recovery.
Retain resource containment with the resolved memory/swap/task profile. The launch must verify
`MemoryMax=6G`, `MemorySwapMax=0` and `TasksMax=2048` for the default, or the validated override.
Do not copy the verification job's finite `RuntimeMaxSec` into the daemon. No implicit unlimited
fallback, shell background task or tmux supervision. No service activation during this spec task.

The backend provider is `startSupervised({ repository, pins, initiator })`. It returns the common
run/generation/state data plus `unit` and `alreadyRunning`. This internal provider receives an
already-admitted initiating identity; it is not a mutation CLI or an authority issuer. Keep public
`loop.mjs start` closed until shared legacy admission and the model-tool guards are connected.

The service executes `run --supervised --run <run-id> --launch-receipt <launch-id>` with the pinned
absolute paths and root. `verifySupervisedLaunch({ repository, runId, launchReceipt })` returns
`{ repository, pins, initiator }` only after actual service verification. Then the CLI calls
`runLoop`. The supervisor does not import the CLI or write its checkpoint.

`autoloop.supervisor-launch/1` contains exactly `launchId`, `repositoryKey`, `runId`, `unit`, `pins`,
`initiator`, `launcher`, `systemctlPath`, `argv`, `minimumGeneration`, `createdAt`, `commandDigest`
and `schema`. Its digest covers the complete record without `commandDigest`. `launcher` is a
verified `ProcessIdentity`; `initiator` is historical. The private record can be read on a systemd
restart only with the same exact argv and verified named service identity. It is not an operator
receipt. Flags, environment variables and possession of a launch ID alone give no authority.

Readiness checks `systemctl` MainPID and service state, the actual process start/boot identity,
its `/proc/<pid>/cgroup` membership, and the cgroup's `memory.max`, `memory.swap.max` and
`pids.max`. The values must match the resolved pins. The authoritative lease/checkpoint must
name that same owner, run and generation. A copied service property cannot replace kernel
readback. Use `KillMode=process` and `TimeoutStopSec=infinity`: the runtime owns worker drain,
and an unexpected daemon exit must not erase workers before recovery. Transient unit collection
releases the service name after a completed exit; it does not prune durable scheduler state.

`start` refuses on an unsupported host, absent user manager, failed lock backend or ineffective
resource containment. It never falls back to foreground. `run --foreground` is explicit, stays
attached to its terminal, uses the same lock/recovery/reducer, and can be used for portable tests.
It is not claimed to survive its terminal. Required process/lock facilities are checked first.

The control tick is one second. A long scan, child or external request cannot block it. Persisted
controls must be claimed by the next available tick; integration tests bound the response to two
ticks when disk and supervisor respond. Run status can show ongoing reconciliation separately.

- `pause`: no new work admission; active work can finish. Idempotent when already paused.
- `resume`: resume admission only from paused. Refuse while draining, stopped or failed.
- Graceful `stop`: enter draining, admit no new work, and let active units reach completed or a
  durable waiting disposition. Do not wait for a human answer, CI, or PR merge indefinitely.
  Persist unresolved waits/effects; stop with a truthful waiting reason. With no units, stop directly.
- `stop --now`: persist stopped intent, then SIGTERM each verified group; after ten seconds,
  SIGKILL only if its leader start/boot identity and group ownership still match. Reconcile Git
  effects, store `cancelledByOperator`, and stop. Never signal unrelated reused PIDs/groups.
  Refuse signals when the daemon's own process group cannot be verified.
- An unexpected worker exit can enter recoverable waiting. Operator cancellation cannot become
  an automatic retry. Only a later explicitly authorized continuation can clear that disposition.
- SIGTERM requests graceful drain. SIGINT on the foreground runner requests drain. Supervisor
  shutdown cannot justify invented completion. A lost/unverified child is visible in recovery.

## Trusted host admission and viewer status

The supported mod surface is the actual host API: `next.origin` on `process.run` identifies the
calling plugin/tier. `$.process.run(argv, { stdin, timeoutMs })` supplies stdin. `$.session.id()`
provides the host session, not an environment variable. Only a user command/button/input can
initiate attach, start or controls. A timer, model event or automatic discovery cannot do so.

The trusted handler validates `next.origin` as this installed mod and the host session.
For `command.run`, accept only the host-stamped `e.origin.kind: composer` or `bridge` operator
origins. Refuse `sdk`, plugin, task-notification, scheduled and unclassified origins. Button/input
admission requires the matching host UI event, not a model-requested command.
It creates a fresh single-use invocation receipt, bound to the complete command
hash, session, host process start/boot identity and a ten-second expiry. Use the existing
host-session handoff pattern, extended for these bindings, in protected host runtime storage.
This is a local receipt, not an API credential or a secret-management service. Do not put it
in a shared environment or model transcript. The admitted subprocess consumes it atomically
and verifies its own trusted host process ancestry. JSON `actor`, `--host-request` and
`CLAUDE_CODE_SESSION_ID` alone cannot mint or validate one.
A private `tools/loop-host.mjs` helper creates the receipt with Node filesystem operations;
the mod does not depend on undocumented file-mode behavior in `$.fs.write`. The request has
exactly `{ schema: autoloop.host-request/1, route, invocationId, sessionId, root, operation,
runId, requestId, generation }`. `route` is a closed enum: `status` permits attach, disconnect,
pause, resume, stop and stop-now; `loop` permits start, pause, resume, stop and stop-now.
The helper derives executable paths, process identity, runtime storage and command digests.
A caller cannot supply any of those values. A one-use host gesture binds the complete request
and permits the helper through a separate `process.run` origin check. A second bound call
invokes the normalized backend directly, not as a child of the helper. The backend checks the
actual entrypoint, so a receipt issued for one route cannot authorize another route.

The stdin envelope is `{ schema: autoloop.host-invocation/1, invocationId, sessionId,
commandDigest, host: ProcessIdentity, issuedAt, expiresAt }`. Its exact values must match the
single-use runtime handoff. The command digest binds the executable/plugin identity, parsed
operation/root, target run/request and complete payload. A receipt for status cannot authorize
stop; a receipt from another host/session cannot attach. Claim the receipt before durable
control submission. An expired or already consumed receipt returns `HOST_AUTH_REQUIRED`.

Selective global tool guards deny direct and known wrapped model invocations of attestation,
attach, controls, service launch and scheduler-state writes, even without a run latch. Test the
supported command forms and existing path/alias protection. The mutation producer also refuses
registered worker/process roles and invalid host receipts. Do not expand this into a shell
interpreter or reverse the approved guard reduction. Arbitrary same-user interpreter execution
is outside this guarantee. These entry-point denials do not make ordinary viewers subject to
worker Stop hooks or unrelated command guards. The host admission helper is not a model tool.
Tests check the real entry path, not an environment variable used as a simulated operator.

Manual CLI mutations use `--operator-terminal`: require explicit operator confirmation on a
live controlling terminal and check known process roles/provenance. Refuse a bound worker,
known model-tool invocation or a caller that presents invalid host authority. A PTY or the flag
alone is not host proof; another same-user process can allocate a PTY. This is the supported
operator-confirmation route, not an impossible-to-forge attestation. Status/request-status are
read-only and need no operator handshake. A user can also run `/autoloop stop` through the
trusted host command when the band is disabled. Do not require an attached viewer for direct
terminal stop. The trust boundary remains defense-in-depth: arbitrary processes with the same
OS credentials can alter files outside the model harness. Do not claim OS isolation.

Viewer records bind host session/process, repository and explicit run, separately from workers.
`session.end` and `/clear` end attachment, not the daemon. Compaction keeps the same attachment.
Viewer records are private append-only revisions under
`<commonDir>/autoloop/viewers/<pid>-<host-identity-digest>/<session>/`.
`status.mjs --viewer-ended` records a reduction-only tombstone for the exact verified direct
host/session. It cannot create or restore attachment, revoke another host/session, enqueue a
control, or change daemon state. The mod invokes it only from its trusted session-end path,
without inventing an operator gesture. An absent or already-ended attachment is unchanged.
Ordinary unrelated session ends create no viewer state.
Two viewers can attach. Closing the initiator does not transfer writer ownership to either.
`--discover` returns an unattached candidate without private streams/control authority:
`{ schema: autoloop.loop/1, ok: true, data: { candidate: null|{ runId, generation, state,
queueEnabled }, attached: false } }`. Attach/disconnect return the same envelope with
`data: { runId, sessionId, attached: true|false }`. Repeated attach to the same run and repeated
disconnect are idempotent. Attach to a different run requires explicit disconnect first.
A viewer never supplies the daemon's owner PID or writer latch.

Keep `status.mjs --json --session <id>` schema `autoloop.status/1` and existing field types.
For daemon mode, retain `owned: true` as the legacy display-admission bit for an explicitly
attached viewer; it is not writer authority. Add optional `execution` and `attachment` objects:

```json
{"execution":{"mode":"daemon","runId":"<uuid>","generation":1,"state":"paused","queueEnabled":false,"lastCheckpointAt":1791849600000,"eventLogError":null},"attachment":{"kind":"viewer","sessionId":"<uuid>"}}
```

Keep legacy `run`, `phases`, `unit`, `units`, `counts`, `models`, `log`, `dispatches` and `controls`.
Daemon current state/worker activity comes from checkpoint; `log` is event history only.
Events missing, failed or rotated cannot erase a running worker or invent an outcome.
Add durable request receipts as `controls.requests: ControlResponse[]` without changing legacy
refused-entry types. `execution.supportedControls` is the explicit array of supported kind names;
in module 1 it is `["pause", "resume", "stop", "stop-now"]`. The mod hides other unit controls
and direct submissions receive `UNSUPPORTED_ACTION`. The daemon protocol uses `resume`; the
legacy UI's `unpause` maps to it only in daemon mode. Existing legacy requests remain v1.
Display starting, running, paused, draining, recovering, stopped and failed
without mapping them to guessed success. A missing/dead owner cannot display as running.
Daemon dispatch state is `running|died|unknown`, from group observation `alive|empty|unknown`.
Unknown bindings count as waiting and remain visible/selectable without log or cached output.
Unknown does not authorize tailing, cancellation, a running glyph or completion. Existing legacy
dispatch values and the `autoloop.status/1` envelope stay unchanged.
For daemon controls do not submit `autoloop: control` wake prompts. Legacy controls retain them.

## Code style

Use existing ESM style: single quotes, two-space indentation, explicit root parameters,
pure reducers and small named functions. Validate external boundaries and return typed results.
For example, a refusal is data, not an invented worker result:

```js
return { ok: false, error: { code: 'RUN_MISMATCH', message: 'The request names another run.' } };
```

Keep control-state logs separate from model streams. Use synthetic public fixtures.

## Testing strategy and specific acceptance

Embedded Node self-tests use real temporary Git repositories, linked worktrees, atomic file I/O
and child processes. Fake only external `claude`, `gh`, supervisor/host APIs or an external effect.
Use existing verification process-group cleanup and resource-capped test units. Never launch
recursive self-tests or target a live service. Test resources have unique names and scratch roots.
Supervisor positive lifecycle tests require the real default test cgroup cap. Without that cap,
they report a capability skip; refusal tests still run. macOS reports Linux-supervision skips.
The verifier surfaces those skip lines even when the child exits successfully. Linux CI also runs
`node tools/loop-supervisor.mjs --self-test --require-supervision` under the real test cap; this
mode fails rather than skipping positive supervision coverage. Read-only workflow permissions stay unchanged.
Prove the two-tick control-claim bound using the production one-second tick while real long child
work, delayed external effects or asynchronous cancellation remain active.

Account-dependent fixtures use the scoped test-account provider before any acquisition, including
parent processes and child Node processes. Restore OS exports, child preload settings and umask in
`finally`. Fixture isolation is not a production environment or command-line authority override.
Runtime and supervisor tests stop verified owned processes and retain scratch files when removal
is not permitted in the execution context. Each retained path is reported. Never remove projects,
live state, real worktrees, plugin caches or unrelated temporary data.

1. Concurrent daemon starts across main/linked worktrees yield one owner. Boot/start mismatch,
   reused PID, dead owner, uncertain child, corrupt checkpoint and interrupted write are tested.
2. Race daemon start against legacy prime in both orders. Exactly one path is admitted. A live
   legacy worker and a daemon in recovery also prevent new admission. No stale-lock borrowing.
3. A fake supervisor launches a real foreground child. The launcher/viewer exits; the daemon
   survives. Failed readiness and unsupported Linux/macOS daemon launch report failure.
4. Pause/resume/stop stay responsive during a long real child and delayed external effect.
   Graceful stop drains active work or stores waiting; immediate stop kills verified descendants
   and leaves an unrelated process alive. An operator-cancelled child is not restarted.
5. Two consumers, repeated IDs, changed payloads, stale targets, links/FIFOs and malformed
   controls cannot duplicate effects or redirect writes. Outcomes survive crash and restart.
6. With a fake external durable effect, crash after effect/before receipt and before ack.
   Readback reconciles the result; unknown readback does not trigger a second effect.
7. New/old producer shapes remain compatible. Remove/rotate/fail event writes: checkpoint status
   remains true. Module 1 `answer`, `cancel`, `merge` and `label` return unsupported, with no `gh` call.
8. Real user command/button admission succeeds through the host path; model tools with copied
   session/env/`by: ui` fail. Viewer attach does not create worker ownership. Test two viewers,
   `/clear`, exit, reattach and an unrelated session. Direct terminal stop works with the band off.
9. Register new tests in `tools/verify.mjs`; strict validation, plugin tests and both CI platforms
   pass. Show failing behavior before implementation and a deliberate mutation detected afterward.

## Boundaries

**Always:** keep one writer, durable-before-effect ordering, verified process identity, explicit
unsupported operations, protected state and legacy protocol compatibility.

**Ask first:** dependencies, production service activation/installation,
permission changes, paid model calls, GitHub mutations, migration and worktree deletion.

**Never:** production queue in module 1; false exactly-once claims; log-based recovery; passive
viewer ownership; model operator controls; uncapped supervision fallback; secrets in state;
termination of unverified processes; automatic restart of operator-cancelled work.
