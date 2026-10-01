---
name: security-best-practices
description: Focused secure coding review for Auto-Cuan implementation work. Use for authentication, authorization, API handlers, database queries, secret handling, validation, serialization, and dependency-sensitive code.
---

# Security Best Practices

When security is relevant, verify the concrete implementation against these principles:

- authorization is checked at the server-side action boundary;
- untrusted input is parsed, bounded, and normalized before use;
- database access cannot turn user input into executable query structure;
- sensitive responses expose only the minimum required data;
- errors do not leak secrets, tokens, SQL, stack internals, or privileged state;
- credentials come from approved environment/config sources and are never committed;
- state-changing operations have appropriate replay/idempotency protections;
- external URLs/redirects are constrained when user-influenced;
- file and path operations cannot escape intended roots;
- retries do not duplicate payments, activations, notifications, orders, or persistence writes;
- security-sensitive tests cover denied/invalid paths as well as success.

Prefer a small explicit fix over a broad security rewrite unless the task requires architectural change.
