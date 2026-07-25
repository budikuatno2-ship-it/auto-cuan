# Telegram Membership staging environment

Set `AUTO_CUAN_ENV=staging` for the branch-specific staging deployment. Configure
each of the following as a staging-scoped secret or setting; never copy values
from Production and never commit values to the repository:

- `STAGING_SUPABASE_URL`
- `STAGING_SUPABASE_SERVICE_ROLE_KEY`
- `STAGING_TELEGRAM_VERIFY_BOT_TOKEN`
- `STAGING_TELEGRAM_VERIFY_CHANNEL_ID`
- `STAGING_TELEGRAM_VERIFY_WEBHOOK_SECRET`
- `STAGING_TELEGRAM_VERIFY_CODE_SECRET`
- `STAGING_TELEGRAM_VERIFY_BOT_USERNAME`
- `STAGING_TELEGRAM_VERIFY_ADMIN_CHAT_ID`
- `STAGING_ADMIN_TELEGRAM_BIND_PEPPER`
- `STAGING_VOUCHER_CODE_PEPPER`
- `STAGING_CHANNEL_INVITE_PEPPER`
- `STAGING_MEMBERSHIP_BANK_INSTRUCTIONS`
- `STAGING_MEMBERSHIP_ADMIN_CONTACT`
- `STAGING_CHANNEL_DESTRUCTIVE_ENFORCEMENT_ENABLED`

Use a separate staging Supabase project, Telegram verification bot, channel,
webhook secret, code secret, and independently generated peppers. The bot
username may include one leading `@`. Leave destructive enforcement unset while
validating; enabling it requires the exact value `1` and the explicit runtime
confirmation `REMOVE_EXPIRED_MEMBERS`.

Unset `AUTO_CUAN_ENV` (or set it to `production`) to retain canonical Production
variable names. Any other selector is rejected. Staging never falls back to a
canonical Production variable.
