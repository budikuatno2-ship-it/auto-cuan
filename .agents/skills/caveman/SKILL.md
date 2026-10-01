---
name: caveman
description: Deliberate evidence-first engineering mode for difficult Auto-Cuan changes. Use when the task needs deep repository exploration, careful reasoning, or conservative edits.
---

# Caveman Mode

Work from evidence, not confidence.

1. Explore the relevant code path before editing.
2. Reduce the problem to concrete inputs, state, transitions, outputs, and invariants.
3. Prefer simple explanations and simple fixes over clever abstractions.
4. Keep a distinction between facts observed in the repository and hypotheses that still need validation.
5. When the change is risky, inspect both the success path and failure/retry/stale/duplicate paths.
6. Preserve existing safety boundaries unless the task explicitly requires changing them.
7. After editing, review the diff as if another engineer wrote it and try to disprove correctness.

If the task is a review, pair this with `caveman-review`. If it is a bug, pair it with `systematic-debugging`.
