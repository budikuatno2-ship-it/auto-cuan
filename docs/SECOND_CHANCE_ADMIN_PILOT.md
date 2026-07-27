# Second Chance Intraday Pilot (experimental, admin only)

`BALANCED_CONFIRM_2_ANTI_CHASE_V1` is a server-only evaluator of existing, read-only OOS observations. It is not production validation, a public signal, or an automatic order. The OOS collector remains sample-only.

Defaults are `SECOND_CHANCE_ADMIN_PILOT_ENABLED=false` and `SECOND_CHANCE_ADMIN_PILOT_MODE=shadow`. Modes are `shadow` and `send`; any other value fails closed. Shadow never calls Telegram. Send also requires the explicit feature flag, the current Asia/Jakarta date, the existing unambiguous `TELEGRAM_VERIFY_ADMIN_CHAT_ID` (distinct from public/channel destinations), valid existing Telegram configuration, the daily lock, and no prior daily record. Historical dates never send. Dates are validated as real Gregorian calendar dates; this evaluator does not provide IDX public-holiday awareness.

Each observation must have `CORPORATE_ACTION_RISK`, score >=23, improvement >=10 from the first score, relative volume >=1.50, strictly growing cumulative volume, non-falling price, price inside the inclusive entry zone, non-stale data, stop below price, TP1 above price, TP2 above TP1, exact TP1 risk/reward >=1, and time <=13:45 WIB. The immediately previous and current observations must each pass the complete rule. Anti-chase then requires advance from the first price <=6% and no sampled price through qualification reaching the first plan's TP1. The earliest first confirmation wins; equal-time ties use score descending, relative volume descending, then ticker ascending. At most one durable record exists per date.

Required numbers must be actual finite JSON numbers. Numeric strings, whitespace, booleans, arrays, objects, `NaN`, and infinities are rejected. Before Telegram invocation the evaluator durably records `send_in_progress`. A confirmed `sent:false` result is recorded as retryable; a thrown/uncertain result is recorded as `delivery_uncertain` and blocks automatic resend. If Telegram confirms success but final persistence fails, the durable `send_in_progress` record remains and also blocks resend. Locks contain PID and timestamp: live locks are preserved, while sufficiently old dead-owner locks may be recovered without bypassing durable delivery uncertainty.

```bash
# Historical BAJA reproduction: read-only, no state, no Telegram
node tools/run-second-chance-admin-pilot.js --sample-root test/fixtures/second-chance --sample-date 2026-07-27 --through-time 10:00 --dry-run --json

# Current-date shadow (replace the date with today's Asia/Jakarta date)
node tools/run-second-chance-admin-pilot.js --sample-date YYYY-MM-DD --shadow --json
```

Stable statuses include `no_qualifying_alert`, `selected_dry_run`, `selected_shadow_recorded`, `already_recorded`, `already_sent`, `sent`, `blocked_feature_disabled`, `blocked_missing_admin`, `blocked_historical_send`, `blocked_invalid_mode`, `blocked_delivery_uncertain`, `source_missing`, `source_invalid`, `invalid_input`, `lock_busy`, and `failed`. Explicitly blocked `--send` operations exit non-zero while still emitting complete JSON with `--json`.
