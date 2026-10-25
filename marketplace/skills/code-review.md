---
name: code-review
description: Review a diff or branch for bugs, security issues and maintainability before it is merged
---
1. Find the change: `git diff <base>...HEAD` (or the files the user named). Read the surrounding code, not only the hunks.
2. Look first for correctness: wrong conditions, missing error handling, races, off-by-one, null/undefined paths, broken invariants.
3. Then security: untrusted input reaching shell/SQL/HTML/paths, secrets in code or logs, missing auth checks.
4. Then tests: is the new behaviour covered? Would the tests fail without the change?
5. Report findings ordered by severity. For each: file:line, what is wrong, why it matters, and a concrete fix. Skip pure style nits unless asked.
6. End with a one-line verdict: ready to merge, or what must change first.
