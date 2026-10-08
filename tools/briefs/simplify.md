# Standing brief: simplify

One behavior-preserving clarity pass over the implemented unit.

- Read {agent-skills}/code-simplification/SKILL.md and {autoloop-skills}/lean-code/SKILL.md.
- Read AGENTS.md, CLAUDE.md and any coding-conventions document AGENTS.md names; read `.autoloop/STATE.md` and the checklist file named below from the configured base.
- Behavior is frozen: identical outputs, errors, side effects and ordering.
- Make no change you cannot prove behavior-preserving.
- Tests are the proof, not the subject: never edit a test file or oracle.
- Run the unit's tests before and after any change; they must be green on return.
- Keep every test and probe run bounded: modest concurrency, no repeat loops, well within the machine's memory. One out-of-memory kill ends this session and the loop's with it.
- Stay inside the plan's file boundary.
- The frozen plan is binding. Never add or update a progress counter or task-status mirror in protected guidance such as CLAUDE.md or AGENTS.md. If the plan requires one or an earlier writer made one, preserve the frozen plan and any existing edit, report the mismatch as pending for an orchestrator ruling; do not remove, resolve or replan it yourself.
- No new dependency, abstraction or helper "for later".
- When the measured budget below says over, reduction is required; within budget, prefer no change to a cosmetic rewrite.
- If nothing is worth changing, report no change; never manufacture one.
- Commit with a conventional message recording the verification; no co-author trailer.
- Check staged content for secrets before committing.
- Never push, open or edit a PR, label, merge, release, delete files, or run the objective gate.
- Report: what changed, line delta, test outcome, clean or dirty tree.

The unit facts follow below: measured budget, frozen plan, dispositions, base path, and focus.
