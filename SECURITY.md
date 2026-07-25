# Security policy

Autoloop coordinates coding agents, local tools, Git, and GitHub. A defect in its operational
instructions or vendored guards can therefore have a larger effect than an ordinary documentation
bug.

## Supported versions

Security fixes target the latest tagged release. Upgrade before reporting a problem that is already
fixed there. Older releases may receive guidance, but they are not maintained as separate security
branches.

## Reporting a vulnerability

Please use [GitHub's private vulnerability-reporting
form](https://github.com/fabioneves/autoloop/security/advisories/new). Do not open a public issue
for a vulnerability that could expose credentials, bypass a command or merge guard, weaken reviewer
isolation, turn untrusted issue text into instructions, or mutate a repository without the intended
human authority.

Include:

- the affected Autoloop version and active host;
- the smallest safe reproduction, including the selected route;
- the expected and observed security boundary;
- whether credentials, repository state, or GitHub state were exposed or changed; and
- any suggested mitigation, if known.

You should receive an acknowledgement within three business days and an initial assessment within
seven. These are best-effort targets, not a service-level agreement. Please allow time for a fix and
coordinated disclosure before publishing details.

For non-sensitive hardening ideas and ordinary defects, use a public GitHub issue.
