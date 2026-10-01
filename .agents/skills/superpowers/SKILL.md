---
name: superpowers
description: Meta workflow for non-trivial Auto-Cuan coding tasks. Use to choose the right planning, debugging, testing, review, UI, or security workflow before editing code.
---

# Superpowers for Auto-Cuan

Use this skill for non-trivial repository work before making changes.

## Workflow

1. Read the task and inspect the relevant repository state before proposing edits.
2. Classify the task: feature, bug, regression, refactor, UI/UX, security-sensitive, data/persistence, or review-only.
3. Load the most relevant project skill instead of improvising a workflow.
4. For risky changes, identify invariants and failure modes before editing.
5. Make the smallest coherent change that solves the stated problem.
6. Add or update regression coverage for changed behavior.
7. Run focused tests first, then the appropriate broader gate.
8. Use `verification-before-completion` before claiming success.

## Auto-Cuan safety rules

- Never fabricate market data, prices, portfolio data, database state, or external responses.
- Treat authentication, admin access, voucher activation, Telegram delivery, persistence, trading recommendations, and scheduling as high-risk surfaces.
- Preserve idempotency, authorization boundaries, freshness checks, and existing safety gates unless the task explicitly changes them.
- Do not weaken tests or security controls merely to make a change pass.
- Prefer evidence from code, tests, logs, and actual diffs over assumptions.
