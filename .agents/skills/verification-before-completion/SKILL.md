---
name: verification-before-completion
description: Final evidence gate before saying an Auto-Cuan task is fixed, complete, safe, or ready to merge.
---

# Verification Before Completion

Do not claim completion from code inspection alone.

Before the final status:

1. Inspect the final diff and repository status.
2. Run the focused tests that directly cover the changed behavior.
3. Run the relevant broader build, lint, security, or regression gate available for the touched area.
4. Check that no unrelated files, generated secrets, temporary artifacts, or debug code were introduced.
5. Re-check high-risk invariants: authorization, idempotency, stale/freshness handling, persistence boundaries, notification deduplication, and scheduling when applicable.
6. Report exactly what was verified and any residual limitation that was not exercised.

Never use phrases such as "all good" or "100% safe" unless the supporting checks actually justify that claim.
