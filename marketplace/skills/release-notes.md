---
name: release-notes
description: Draft user-facing release notes from the commits and merged changes since the last tag
---
1. Find the range: `git describe --tags --abbrev=0` for the last tag, then `git log --oneline <tag>..HEAD`.
2. Group changes into New, Improved, Fixed and Breaking. Drop internal-only changes (refactors, CI, tests) unless they affect users.
3. Write each entry from the user's point of view in one sentence, starting with a verb.
4. Call out breaking changes and required migrations first, with the exact steps.
5. Output Markdown ready to paste into a GitHub release.
