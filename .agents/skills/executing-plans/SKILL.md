---
name: executing-plans
description: Execute an approved multi-step Auto-Cuan implementation plan with checkpoints, focused validation, and minimal deviation.
---

# Executing Plans

When a plan already exists:

1. Re-read the plan and current branch state before editing.
2. Execute steps in dependency order.
3. After each meaningful step, run the narrowest useful validation.
4. If repository evidence contradicts the plan, stop and update the plan instead of forcing the implementation.
5. Keep unrelated cleanup out of the change unless it is required for correctness.
6. Preserve existing behavior outside the stated scope.
7. Finish with the full relevant verification gate and inspect the final diff.

For risky changes, explicitly note any step that alters auth, persistence, scheduling, notifications, trading logic, or external API behavior.
