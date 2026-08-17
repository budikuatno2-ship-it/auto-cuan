---
name: security-guidance
description: Secure-by-default guidance for Auto-Cuan code changes. Use when touching auth, admin operations, secrets, input parsing, database access, web handlers, file/path handling, redirects, uploads, external requests, or other trust boundaries.
---

# Security Guidance

Apply security checks while making the normal change rather than as an afterthought.

1. Identify trust boundaries and attacker-controlled inputs.
2. Preserve authorization checks; authentication alone is not authorization.
3. Validate untrusted input and prefer allowlists for bounded values.
4. Use parameterized database operations and safe subprocess APIs.
5. Avoid unsafe dynamic code, shell interpolation, path traversal, SSRF, open redirects, and unescaped HTML sinks.
6. Keep secrets, tokens, cookies, private keys, and sensitive personal/account data out of source, logs, and user-facing errors.
7. Preserve CSRF/session protections and origin assumptions already present in the application.
8. For admin, voucher, payment, Telegram, destructive, or privilege-changing actions, verify replay/idempotency and failure behavior.
9. Add regression coverage for security-sensitive behavior when feasible.
10. Never weaken a security control just to make a feature or test pass.

Report security findings only when supported by a realistic input/path and concrete impact.
