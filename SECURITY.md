# Security Policy

Auto-Cuan treats source security, deployment boundaries, and regression prevention as engineering responsibilities. This policy is not a claim of external certification.

## Reporting a vulnerability

Use the repository **Security** area for security-related reporting when the available GitHub security/advisory flow supports the report:

https://github.com/budikuatno2-ship-it/auto-cuan/security

Do not include production credentials, session cookies, private user data, access tokens, or exploit material that would expose users in a public issue or discussion.

For non-sensitive bugs that do not expose security details, a normal repository issue may be appropriate.

## Please include

When safe to disclose, include:

- affected surface/file/route;
- expected vs actual behavior;
- minimum reproduction steps;
- impact and preconditions;
- whether the issue is reproducible without privileged credentials;
- a proposed mitigation if known.

## Security-sensitive areas

Review changes especially carefully when they affect:

- authentication/session handling;
- admin access or account lifecycle;
- subscription/entitlement enforcement;
- API caching or private response handling;
- database persistence;
- financial calculations or market-data freshness;
- Telegram/automation delivery containing user or trading context;
- HTML/AI rendering boundaries;
- secrets or environment configuration.

## Delivery controls

The protected production branch requires pull-request/status-check flow. CI includes repository security checks, CodeQL analysis, web-hardening/build regression, and focused PostgreSQL harnesses.

A passing CI run lowers regression risk but does not guarantee that software is vulnerability-free.

## Public trust reference

See the public Trust Center:

https://autocuan.web.id/trust.html

The machine-readable disclosure pointer is published at:

https://autocuan.web.id/.well-known/security.txt
