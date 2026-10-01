---
name: caveman-review
description: Skeptical evidence-based review for Auto-Cuan diffs, PRs, and final implementation states. Use to find real regressions without inventing issues.
---

# Caveman Review

Review like a hostile but fair maintainer.

1. Read the task/PR intent and the full relevant diff.
2. Trace changed execution paths into surrounding code where necessary.
3. Check correctness, regressions, race conditions, stale-state handling, idempotency, persistence, auth, notifications, scheduling, and data provenance as applicable.
4. Verify tests actually exercise the claimed behavior and failure modes.
5. Report only findings supported by a concrete failure scenario.
6. Include file/line evidence when possible and explain the smallest practical fix.
7. Separate definite defects from residual risks or questions.
8. If no actionable findings remain, say so and list any validation gap that could not be exercised.

Do not manufacture findings to make a review look useful.
