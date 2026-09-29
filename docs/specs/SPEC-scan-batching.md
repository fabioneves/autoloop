# Spec: scan-batching

## Objective

Prime reads the repository in about ten GitHub calls, not several hundred. Snapshot contents,
completeness semantics and failure direction do not change.

Measured on living-football-engine on 2026-09-28 with v0.52.0 (139 open issues, 138 queue
candidates, 210 merged PRs):
- `prime.mjs --json` took 78–81s on each of four calls in 35 minutes, of which `scanMs` was 78s. The
  skill re-primes after every mutation and wait boundary, so this cost repeats within a unit.
- One read-only `scan.mjs` run under a `gh` logging shim made 478 calls. That is 275 call-seconds at
  `MAX_CONCURRENCY = 4` (`scan.mjs:33`), 75s wall.

| Calls | Fetcher | Line |
|---|---|---|
| 245 (139 open + 106 closed) | `fetchIssueComments` for every open issue and every merged PR's issue | `scan.mjs:601`, from `fetchLifecycleMarkers` `:734-742` |
| 138 | `fetchIssueTimeline` for every queue candidate | `scan.mjs:862`, from `fetchQueue` `:920` |
| 86 | `fetchDependencyIssue`, one per referenced dependency | `scan.mjs:582`, from `fetchQueue` `:892-896` |
| 9 | repo, open/merged PR lists, open issue list, collaborator role | — |

- Rate limit: each of those issue reads is its own GraphQL query costing 1 point, so a scan costs about 470 of the
  5,000-point hourly budget. After this session's scans, `rateLimit.remaining` was 2,436.
- Measured alternative: one aliased query over 50 issues, carrying the first page of both comments
  and the label timeline, returned in 2.0s at a cost of 1 point (25 issues: 1.3s, 1 point).

## Behaviour

1. **Batched first pages.** A new batching layer in `scan.mjs` fetches, for a list of issue numbers
   and a set of parts (`comments`, `timeline`, `dependency`), the first page of each part in aliased
   queries. Aliases are `i<number>: issue(number:<n>){…}`, with at most `ISSUE_BATCH_SIZE = 25` issues
   per query. The field selections are exactly those of `ISSUE_COMMENTS_QUERY`,
   `ISSUE_TIMELINE_QUERY` and `DEPENDENCY_ISSUE_QUERY`, so every normalizer downstream is unchanged.
2. **Continuation.** When a batched connection reports `hasNextPage`, that issue's part continues
   through the existing per-issue paginated fetcher, starting from the batched `endCursor`. Items are
   concatenated in order, and the existing `MAX_PAGES` and `MAX_ITEMS` bounds apply to the combined
   result.
3. **Partial errors are per issue.**
   - A GraphQL `errors` entry whose `path[0]` is `repository` and `path[1]` is an alias fails only
     that issue's part.
   - For `dependency`, that is the same `DEPENDENCY_ISSUE_INVALID` or `DEPENDENCY_ISSUE_FETCH_FAILED`
     section the per-issue fetch produces today. For example, a PR number referenced as a dependency
     resolves to "Could not resolve to an Issue".
   - An error without an alias path, or a failed command after the existing transient retries, fails
     every issue in that batch with the section error today's per-issue fetch would give.
   - Absence is never concluded from a failed batch.
4. **Wiring.**
   - `fetchLifecycleMarkers` requests `comments` for its issue numbers.
   - `fetchQueue` requests `timeline` for loop-ready candidates, and `dependency` for referenced
     numbers.
   - The open-issue comments and candidate timelines share one batched query per issue: one alias
     carries both parts.
   - The loop-repair path (`REPAIR_FACTS_QUERY` and the parent timeline) stays per issue. It is rare,
     and its facts are cross-issue.
5. **Unchanged:** `MAX_CONCURRENCY`, retries, section shapes, `complete`/`error` semantics, the order of
   items, the open-PR fetchers (`fetchCheckContexts`, `fetchUnresolvedThreads`, `fetchReviewEvidence`),
   and the snapshot contract.

## Boundaries

- Always:
  - The batched path returns sections byte-identical to the per-issue path for the same GitHub
    data.
  - Every GraphQL request stays a read.
- Never:
  - Mark a section complete when any page of it failed.
  - Raise `MAX_CONCURRENCY` as a substitute for batching.
  - Inline issue numbers anywhere except as integer literals validated by `Number.isSafeInteger`.
- Ask first: batching the open-PR fetchers. LFE had 0 open PRs, so they were not measured.

## Tests (failing first)

`scan.mjs --self-test`, with the batch layer taking an injected `graphql(query)` function:
- The query builder emits one alias per issue with only the requested parts, rejects non-integer
  numbers, and splits 60 numbers into batches of 25, 25 and 10.
- A single-page response yields sections equal to what the per-issue path produces from the same
  fixtures.
- `hasNextPage` on one alias continues through the per-issue fetcher from `endCursor`, and the items
  are concatenated.
- A partial error on one alias fails only that issue: a `dependency` → `DEPENDENCY_ISSUE_INVALID`,
  and the other aliases stay complete.
- A whole-query failure → every issue in the batch is incomplete, and the other batches are unaffected.

Live measurement (read-only) on LFE after the change: `scan.mjs` under the same shim. Record the call
count, wall time and `rateLimit.cost` in the commit message.

Full gate: `node templates/tools/verify.mjs --plugin-root .`

## Success criteria

- LFE scan: ≤ 25 `gh` calls, wall time ≤ 15s, down from 478 calls and 75s.
- The snapshot of an unchanged repository is identical before and after the change, apart from
  `scannedAt`, the generation and the fingerprint. Check this by diffing `.sections` from two runs taken
  seconds apart.
- `verify.mjs` is green.

## Open questions

- None blocking. `ISSUE_BATCH_SIZE` is a constant. 25 is chosen because a 25-issue query holds up to
  2,500 comment bodies, and the measured 2.0s at 50 issues leaves headroom under GitHub's 10s query
  timeout for comment-heavy issues.
