# Spec: permission-surface (module of SPEC-self-healing.md)

## Objective

The loop never needs a classifier judgement for its own bookkeeping.

The evidence comes from 27 LFE session transcripts, 08-23 to 09-23, which contain 29 classifier blocks, 1 stage-2 error, and 2 cases of the classifier being unavailable.

| Group | Denials | Remedy |
|---|---|---|
| Review evidence improvised in `/tmp`: generated `build-review-evidence-*.mjs`, `.jq` programs, skeleton JSON, `jq … > evidence.json` | 9, including the 10.3h halt (8f7b) | A plugin tool builds every round (behaviour 1) |
| Loop tools inside compound commands (`&&`, `\|`, `> file`, `cd X &&`), which the classifier judges as a whole | 5 of 8 loop-tool denials | One bare tool call per command (behaviour 2) |
| Transient: stage-2 error, classifier unavailable | 3 | Retry once, unchanged (behaviour 3) |
| Correct gates: `git push`, `gh api PATCH`, `auto-merge.mjs`, a write into `.git/`, `~/.zshrc`, `update-config` | 9 | Stay gated. **Not** allow-listed, because merge and settings stay human |

The docs (`code.claude.com/docs/en/permission-modes`, "How the classifier evaluates actions") settle two points:
- Narrow `permissions.allow` rules resolve before the classifier.
- `.git/` is a protected path, and writes there always reach the classifier whatever the rules say.

Allow rules would cover about 7 of the 29 blocks, and only for bare calls. They also depend on a mid-path version wildcard that has not been verified. So allow rules are **deferred** to the live-acceptance run, and not built blind.

## Behaviour

1. **`review-contract.mjs --append-round`** builds every ordinary round. The existing `--append-escalation-round` still handles the closing escalation round.
   - **First round** (`--first-round`) takes:
     - `--result-file`, `--plan-fingerprint <sha256>` (the frozen plan's `contentHash`), `--author <identity>` (the writer's stamp, `engine:model`), and `--state <base STATE.md>`;
     - optionally `--base-oid` (default `origin/<baseBranch>` in the checkout), `--checkout <dir>` (default cwd), `--annotations-file`, and `--out`.
   - **Round n** takes:
     - `--evidence-file`, `--result-file`, and `--scope full|delta`;
     - `--dispositions-file`, required when the previous round raised gating findings: `[{findingId, disposition: fix|rebut, rationale, claim?, evidence?}]`;
     - optionally `--annotations-file`, `--checkout`, and `--out`.
   - The tool derives everything that is not judgement, as follows.

     | Field | Source |
     |---|---|
     | Checkout and repository fingerprint | `snapshotExecutionCheckout` |
     | `headOid` | The checkout |
     | `artifactFingerprint` | `hashValue({tree})` of `HEAD^{tree}`, so identical bytes give an identical fingerprint |
     | `artifactVersion` | The previous version + 1 |
     | `dispatchId` | The result file's mtime |
     | `reviewerIdentity` | The result's `engine:model` stamp |
     | `configFingerprint` | `hashValue(projectConfig)` |
     | Ledger carry-forward and `openRebuttals` | From the dispositions |
     | `deltaBaseOid` | The configured base on round 1, the previous head after |

   - It refuses in these cases, each with a typed code:
     - a dirty checkout;
     - an invalid result;
     - a missing disposition;
     - a `rebut` without claim/evidence.
   - The appended evidence is handed to `reviewTransition` before it is written. A contract error is returned instead of the evidence.
   - `--out <file>` writes the file itself, so the command needs no shell redirect.
2. **Prose (`SKILL.md`):**
   - Review evidence is only ever built by `--append-round` / `--append-escalation-round`, with no `jq`, Write, or generated script.
   - Every plugin-tool call is one bare command: no `&&`, `;`, pipe, `cd X &&`, or `> file`. Use `--out` or the tool's own flags.
   - Never write under `.git/` with Write/Edit or a redirect. Recordings there go through a tool.
3. **Transient classifier errors (prose):** a "stage 2 classifier error" or "classifier unavailable" is retried once unchanged, and it is never read as a policy denial. A policy denial of a loop tool blocks the unit with the verbatim reason (`human:decide`) and the run continues.

## Boundaries

- Keep: every `reviewTransition` rule, and `--append-escalation-round` unchanged.
- Never: allow-list merges, pushes, `gh api` writes, or settings writes; stamp a finding verified (annotations stay caller-supplied).

## Tests (failing first, `review-contract.mjs --self-test`)

- The first round from a fixture checkout and result gives evidence that `reviewTransition` accepts as round 1.
- Round 2 with `fix` dispositions carries the ledger and closes the fixed findings on the next round.
- A `rebut` disposition becomes an `openRebuttal` with claim and evidence.
- A previous gating finding without a disposition is refused `DISPOSITION_REQUIRED`.
- A dirty checkout is refused `CHECKOUT_DIRTY`.
- The same tree gives the same `artifactFingerprint`, and a new commit gives a new one.
- A clean delta result followed by `--append-escalation-round` still closes, so the two tools chain.
- `regression-index.mjs`: an incident for the improvised-evidence denials, pinned to `--append-round`.
