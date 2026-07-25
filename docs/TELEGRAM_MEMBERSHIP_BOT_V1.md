# Telegram Membership Bot V1

## Scope

V1 provides the complete membership lifecycle without coupling it to the
recommendation bot:

1. Registration creates a short-lived, one-time verification code.
2. The verification bot binds that code to a private Telegram identity.
3. An administrator approves only a verified account.
4. Approval creates and privately delivers a short-lived join-request link.
5. The webhook approves only the matching Telegram identity, channel, and
   unexpired stored invite; all mismatches fail closed.
6. Daily lifecycle processing sends bounded verification reminders and a single
   30-day review request using leased, idempotent database jobs.

The implementation deliberately keeps the existing 12 direct `api/*.js`
functions. The verification webhook is multiplexed through
`POST /api/login-user?action=telegram-verify-webhook`; membership administration
is multiplexed through `/api/admin-users`.

## Components

- `lib/telegram-verification.js`: code generation, webhook orchestration,
  identity binding, invite delivery, join-request validation, and rating flow.
- `lib/telegram-verify-bot.js`: isolated Telegram client that reads only
  `TELEGRAM_VERIFY_BOT_TOKEN`.
- `lib/telegram-lifecycle.js`: retryable reminder and review delivery.
- `lib/telegram-analytics.js`: server-derived membership metrics.
- `supabase/telegram-verification-v2-migration.sql`: fresh-install schema and
  service-role RPCs.
- `supabase/telegram-verification-v2-approval-gate-hotfix.sql`,
  `supabase/telegram-invite-message-cleanup-hotfix.sql`, and
  `supabase/telegram-member-lifecycle-hotfix.sql`: additive upgrade migrations.
- `tools/run-telegram-lifecycle.js`: dry-run-by-default lifecycle runner.
- `tools/run-telegram-lifecycle.sh`: locked wrapper that requires an external,
  owner-only environment file.

## Required server environment

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only access for membership RPCs. |
| `TELEGRAM_VERIFY_CODE_SECRET` | HMAC secret for one-time verification codes. |
| `TELEGRAM_VERIFY_BOT_TOKEN` | Token used only by the membership bot. |
| `TELEGRAM_VERIFY_WEBHOOK_SECRET` | Secret-token header required by the webhook. |
| `TELEGRAM_VERIFY_CHANNEL_ID` | Membership channel validated by join requests. |
| `TELEGRAM_VERIFY_ADMIN_CHAT_ID` | Private destination for lifecycle notices. |
| `SESSION_SECRET` | Signs admin sessions used by approval operations. |

Never substitute `TELEGRAM_BOT_TOKEN`; it belongs to the recommendation bot.
Do not commit secret values.

## Safe rollout checklist

1. Apply the SQL migrations in order in a non-production Supabase project.
2. Configure separate test-bot and test-channel values for all `TELEGRAM_VERIFY_*`
   variables.
3. Run the local mocked suite:

   ```sh
   npm run test:telegram-membership-v1
   ```

4. Confirm the direct API JavaScript count is unchanged:

   ```sh
   find api -maxdepth 1 -type f -name '*.js' | wc -l
   ```

   The expected value is `12`.

5. Exercise the registration, approval, join-request, duplicate-update, failed
   delivery, reminder, and rating paths with test identities only.
6. Run lifecycle discovery without writes or Telegram delivery:

   ```sh
   node tools/run-telegram-lifecycle.js --json
   ```

Webhook registration, production migration, production entitlements, and member
removal are operational actions outside this repository change. V1 does not
perform any of them automatically.
