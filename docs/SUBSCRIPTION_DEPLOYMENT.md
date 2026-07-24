# Subscription Runtime Deployment Checklist (Phase 6A)

This checklist enables the **read-only** subscription catalogue and account-status UI. It does not enable payment processing, Midtrans, or browser-side entitlement changes.

## Where to configure server variables

Configure these variables in the deployment platform's **server/runtime environment-variable settings**. For Vercel, add them in **Project Settings → Environment Variables** and select every environment that should offer subscriptions:

| Variable | Required value | Development | Preview | Production | Browser exposure |
| --- | --- | --- | --- | --- | --- |
| `SUBSCRIPTION_FEATURE_ENABLED` | `true` | required when testing locally | required for subscription previews | required | server only |
| `SUPABASE_URL` | `<your-supabase-project-url>` | required | required | required | server only |
| `SUPABASE_SERVICE_ROLE_KEY` | `<your-supabase-service-role-key>` | required | required | required | **never expose** |

Use the platform's local environment mechanism for development (for example, a gitignored `.env.local`), not `public/index.html`, a `NEXT_PUBLIC_*`-style variable, browser storage, or committed files. Do not log values. A deployment that should intentionally hide subscriptions may omit or set `SUBSCRIPTION_FEATURE_ENABLED` to anything other than the exact string `true`.

`SUPABASE_SERVICE_ROLE_KEY` is required only by serverless handlers. It must never be prefixed as a public variable or returned by an API response.

## Database prerequisites

Apply migrations deliberately with the service-role/database deployment process; application code does not apply them.

1. `supabase/subscription-phase-2-migration.sql` is required for `subscription_plans`, `subscription_plan_prices`, `user_entitlements`, and the subscription trial constraints/RPC.
2. The Phase 5C migrations (`subscription-phase-5c-voucher-admin-migration.sql`, `subscription-phase-5c-lifecycle-correction.sql`, `subscription-phase-5c-admin-command-correction.sql`, and `subscription-phase-5c-redemption-correction.sql`) remain required for the existing voucher-admin lifecycle, but are not a prerequisite for the read-only catalogue/status endpoints themselves.
3. Create/publish active server-owned rows for the supported paid codes only: `PREMIUM_1_MONTH`, `PREMIUM_2_MONTHS`, `PREMIUM_3_MONTHS`, and `LIFETIME`. Each displayed paid plan needs an active price row. Do not invent seed prices to make a deployment appear ready.
4. The 10-day trial is server-owned: the Phase 2 migration constrains trial expiry to `starts_at + interval '10 days'`. Free and Trial 10 Hari are presentation cards; they are not paid catalogue rows.

## Readiness and expected responses

`POST /api/login-user?action=subscription-plans` is public. It returns HTTP 200 only when all of the following are true:

- `SUBSCRIPTION_FEATURE_ENABLED` is exactly `true`;
- both Supabase server variables are present;
- the readiness probe against `subscription_plans` succeeds; and
- the active catalogue query succeeds.

The readiness probe checks that `subscription_plans` can be read. It does not validate a non-empty result; an empty but readable catalogue is an HTTP 200 with `plans: []`, which the UI displays as no available plans. A disabled feature, missing credentials, failed readiness probe, or failed active-catalogue query returns HTTP 503 with a generic safe error.

`POST /api/login-user?action=subscription-status` has the same feature/credential/readiness requirements and additionally requires a valid signed `ac_sess` cookie. After the feature gate is enabled, a guest request should return HTTP 401. A valid session returns HTTP 200 with safe account and entitlement fields; no secret, voucher internals, or service-role key is returned.

## Owner verification steps

Run these against the intended Preview and Production URL after configuring the variables and applying migrations. Replace placeholders locally; do not paste secrets or signed cookies into tickets, logs, or source control.

```bash
# Expected: HTTP 200; inspect only plan codes and public display fields.
curl --silent --show-error --output /tmp/subscription-plans.json --write-out 'HTTP %{http_code}\n' \
  --request POST 'https://<deployment-host>/api/login-user?action=subscription-plans' \
  --header 'content-type: application/json' --data '{"action":"subscription-plans"}'

# Expected after enablement: HTTP 401 for a guest.
curl --silent --show-error --output /tmp/subscription-status-guest.json --write-out 'HTTP %{http_code}\n' \
  --request POST 'https://<deployment-host>/api/login-user?action=subscription-status' \
  --header 'content-type: application/json' --data '{"action":"subscription-status"}'

# Expected: HTTP 200 with a sanitized entitlement shape. Keep the cookie private.
curl --silent --show-error --output /tmp/subscription-status-user.json --write-out 'HTTP %{http_code}\n' \
  --request POST 'https://<deployment-host>/api/login-user?action=subscription-status' \
  --header 'content-type: application/json' --header 'Cookie: ac_sess=<signed-session-cookie>' \
  --data '{"action":"subscription-status"}'
```

Then open `/subscription` in a browser. Guests must see Free, Trial 10 Hari, and all four paid server-catalogue cards, plus a login prompt for personal status. Confirm Premium 2 Bulan is **Paling Populer**, Premium 3 Bulan is **Lebih Hemat**, Lifetime retains its shared seven-seat explanation, and an active trial displays remaining time from the API's `expires_at`.

## Local and deployment status

This repository does not contain subscription runtime credentials or a Vercel project linkage. Local execution without the three variables intentionally returns HTTP 503 and cannot prove a real hosted catalogue. Preview/Production verification is therefore pending repository-owner configuration; do not treat a static HTML preview as endpoint validation.
