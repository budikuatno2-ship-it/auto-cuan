# Auth Recovery V2 Rollout

This change is intentionally deployed in stages.

1. Review and merge application code.
2. Apply `supabase/auth-telegram-recovery-v1-migration.sql` to the production database.
3. Set the Telegram bot webhook to `/api/reset-password?action=telegram-verify-webhook-v3` using the existing verification bot secret.
4. Deploy the merged website/API revision.
5. On the VPS, source the existing runtime environment and run `node scripts/create-budi-telegram-enrollment.js` once.
6. Send the displayed `AR-XXXX-XXXX` code to `AutoCuanVerificationBot` from the intended administrator Telegram account.
7. From the website, request password recovery for `budi`, approve it in the bot, and create a new password through the one-time website link.
8. Validate login from a browser with cleared localStorage. Device ID must not be required.
9. Validate that a deleted account cannot be restored from stale localStorage.

Safety notes:

- The enrollment command does not change the password or device fields.
- Raw enrollment codes and reset tokens are never stored in the database.
- Existing registration approval and channel join flows continue through the same verification bot.
- The old `/api/reset-password` device-bound behavior is replaced only after this revision is deployed.
