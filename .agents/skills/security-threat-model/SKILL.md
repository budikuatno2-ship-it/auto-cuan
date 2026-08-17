---
name: security-threat-model
description: Lightweight threat modeling for Auto-Cuan features that cross trust boundaries or change privileged behavior. Use before implementing new auth/admin/payment/voucher/webhook/Telegram/persistence flows or material external integrations.
---

# Security Threat Model

Keep the model concrete and scoped to the feature.

1. List assets that matter: account access, admin privilege, premium entitlement, secrets, portfolio/trading data, notification channels, database integrity, and service availability as relevant.
2. Identify actors and trust boundaries: browser, authenticated user, admin, Telegram user, Vercel/API runtime, database, external provider, scheduled runner, and GitHub/VPS components as applicable.
3. Trace the state-changing request from input to authorization to persistence to side effects.
4. Consider abuse cases: spoofing, privilege escalation, replay, duplicate delivery, stale state, race conditions, tampering, injection, data leakage, SSRF, and denial of service.
5. Record existing controls and whether the proposed change bypasses or weakens any of them.
6. Define the minimum mitigations and regression tests needed for the realistic high-impact threats.

Do not produce a generic checklist detached from the actual code path.
