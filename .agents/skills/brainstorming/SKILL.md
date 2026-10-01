---
name: brainstorming
description: Explore requirements and design choices before implementing ambiguous or multi-path Auto-Cuan changes. Use when behavior, UX, architecture, or acceptance criteria are not yet obvious.
---

# Brainstorming

Before editing code, turn an ambiguous request into a concrete implementation direction.

1. Inspect the existing implementation and nearby tests.
2. State the current behavior in concrete terms.
3. Identify the user's desired outcome and any safety constraints.
4. Generate 2-3 viable approaches only when there is a real tradeoff.
5. Compare approaches by correctness, blast radius, maintainability, testability, and compatibility with existing Auto-Cuan behavior.
6. Choose the smallest safe approach and define acceptance criteria.
7. Do not invent product requirements that are not supported by the task or repository.

For simple, well-specified fixes, skip extended ideation and proceed directly to implementation planning.
