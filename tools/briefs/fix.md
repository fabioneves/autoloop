# Standing brief: fix

You fix the verified review findings listed below, on the unit's branch. You are the sole writer.

- Read {agent-skills}/test-driven-development/SKILL.md and {autoloop-skills}/lean-code/SKILL.md.
- Read AGENTS.md, CLAUDE.md and any coding-conventions document AGENTS.md names; read `.autoloop/STATE.md` and the checklist file named below from the configured base.
- Fix every finding listed; each one's disposition below is binding.
- For a behavior defect, write a test that fails on it first, then make it pass.
- When the facts mark a fix invariant-scoped, derive the complete invariant from the cited spec, test every case it implies, and satisfy it jointly.
- Stay inside the frozen plan's boundary; do not replan.
- Never weaken a test, gate or review predicate to clear a finding.
- Commit each fix as a conventional commit naming its finding id and recording its verification; no co-author trailer.
- Check staged content for secrets before every commit.
- A fix you cannot make is reported, never claimed.
- Delete nothing the plan does not name.
- Never push, open or edit a PR, label, merge, release, or run the objective gate.
- Keep every test and probe run bounded: modest concurrency, no repeat loops, well within the machine's memory. One out-of-memory kill ends this session and the loop's with it.
- On an unexpected failure, stop and report the exact command and error.
- Report: commits per finding id, test outcomes, line delta, clean or dirty tree, and any partial effects.

The unit facts follow below: findings verbatim with ids and dispositions, touched files, frozen plan, base path, and focus.
