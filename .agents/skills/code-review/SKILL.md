---
name: code-review
description: Review Auto-Cuan diffs, PRs, commits, or working changes for correctness, regressions, security, data integrity, races, error handling, compatibility, and missing tests.
---

# Code Review

Prioritize findings in this order:

1. correctness and user-visible regressions;
2. authorization/security boundaries;
3. data integrity and destructive behavior;
4. race conditions, retries, idempotency, stale state, and duplicate side effects;
5. error handling and observability;
6. API/schema/backward compatibility;
7. missing or misleading regression tests;
8. material performance problems supported by evidence.

## Review rules

- Findings first; do not pad with compliments.
- Trace the relevant execution path before reporting a bug.
- Give file/line evidence when available.
- Explain the concrete failure scenario and smallest practical fix.
- Distinguish definite bugs from risks/questions.
- Check that tests cover behavior, not merely lines.
- Review the final diff/state, not an earlier description of it.
- If no actionable findings remain, say so clearly and mention residual validation gaps.
