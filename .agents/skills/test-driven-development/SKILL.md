---
name: test-driven-development
description: Regression-first workflow for behavior changes and bug fixes in Auto-Cuan. Use when a change can be captured with an automated test before or alongside implementation.
---

# Test-Driven Development

Use tests to lock down the intended behavior, not merely implementation details.

1. Identify the observable behavior or invariant being changed.
2. Find the closest existing test style and fixture pattern.
3. Add the smallest regression test that demonstrates the missing or broken behavior.
4. Confirm the test meaningfully exercises the target path.
5. Implement the minimum production change needed to satisfy the test.
6. Add boundary cases for high-risk branches such as stale data, duplicates, auth failures, retries, expiry, or idempotency when relevant.
7. Run focused tests, then the broader gate appropriate to the touched area.

Do not rewrite a valid test to accommodate incorrect production behavior. Do not over-mock away the state transition that the test is meant to protect.
