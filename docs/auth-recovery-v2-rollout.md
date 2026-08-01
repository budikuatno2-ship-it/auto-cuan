# Auth Recovery V2 Rollout

This change is intentionally deployed in stages. Do not switch the Telegram webhook before the new API revision is live.

1. Review and merge the application code.
2. Apply `supabase/auth-telegram-recovery-v1-migration.sql` to the production database.
3. Apply `supabase/auth-telegram-recovery-v1-device-retirement-hotfix.sql` immediately after the base migration.
4. Deploy the merged website/API revision while the verification bot still points to the existing webhook. Existing registration and channel verification continue normally during this step.
5. Verify that `/api/reset-password` serves the new session-status action and that the website loads `/auth-v2.js`.
6. Switch the existing verification bot webhook to `/api/reset-password?action=telegram-verify-webhook-v3` using the existing webhook secret. The new route processes recovery updates first and delegates every non-recovery update to the current registration/channel verification handler.
7. On the VPS, source the existing runtime environment and run `node scripts/create-budi-telegram-enrollment.js` once.
8. Send the displayed `AR-XXXX-XXXX` code to `AutoCuanVerificationBot` from the intended administrator Telegram account.
9. From the website, request password recovery for `budi`, approve it in the bot, and create a new password through the one-time website link.
10. Confirm that the password reset also clears historical device bindings, permanently disabling the old `budi + .` compatibility route.
11. Validate login from a browser with cleared localStorage. Device ID must not be required.
12. Validate that a deleted account cannot be restored from stale localStorage.

Safety notes:

- The enrollment command does not change the password, approval state, role, or device fields.
- The successful password-reset transaction changes the password and atomically retires old device bindings.
- Raw enrollment codes and reset tokens are never stored in the database.
- Existing registration approval and channel join flows continue through the same verification bot.
- The old `/api/reset-password` device-bound behavior is replaced only after this revision is deployed.
- The old Telegram webhook remains available until the new route has been deployed and verified.
