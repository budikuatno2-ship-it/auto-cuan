---
name: systematic-debugging
description: Root-cause workflow for Auto-Cuan bugs, regressions, flaky behavior, failing tests, API errors, and production mismatches. Use before patching a symptom.
---

# Systematic Debugging

Find the root cause before changing code.

1. Reproduce or precisely characterize the failure from available evidence.
2. Identify the first point where actual behavior diverges from expected behavior.
3. Trace inputs, state transitions, persistence, async boundaries, and external calls involved.
4. Form one concrete hypothesis at a time and test it against code/log/test evidence.
5. Distinguish primary cause from downstream symptoms.
6. Add a regression test that fails for the diagnosed cause when practical.
7. Implement the smallest fix that restores the intended invariant.
8. Re-run the reproducer, focused regression tests, and relevant broader gates.

Avoid speculative multi-fix patches. If evidence is incomplete, say what is known, what remains uncertain, and what observation would resolve it.
