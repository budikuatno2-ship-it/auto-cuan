---
name: writing-plans
description: Create an implementation plan for multi-step Auto-Cuan work before editing code. Use for changes spanning multiple files, state transitions, migrations, workflows, or safety-sensitive behavior.
---

# Writing Plans

Produce a plan that another engineer could execute without guessing.

Include:

- current behavior and the exact target behavior;
- relevant files/modules and why each matters;
- invariants that must remain unchanged;
- ordered implementation steps with concrete code locations;
- tests to add or update for each changed behavior;
- commands or CI gates that will validate the work;
- rollback or compatibility concerns when the change affects persistence, auth, scheduling, Telegram, or production APIs.

Keep the plan proportional to the task. Do not turn a one-file fix into an architecture project.
