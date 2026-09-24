# AUDIT LOG — FASE 10 (23 SEPT)
# Telegram Notification Delivery, Rate Limiting, Deduplication/Anti-Spam Gate, & Template Formatting

**Method:** Zero-trust, test-first. Every subsystem treated as a *hypothesis* until proven on the
current code. Findings were proven by a **failing unit test** before each fix, then re-verified
**PASS 2× consecutive**, then the whole repo suite was run green.

**Regression suite:** [`test/audit-fase10-telegram-gate-bugs.test.js`](test/audit-fase10-telegram-gate-bugs.test.js:1) — 9 tests, 9 PASS ×2.
**Full repo suite:** `527 test files passed successfully` (`node tools/run-build-test-suite.js --full`).
**Syntax:** `888 .js files parsed cleanly` · curated list `527 entries, 0 missing`.

---

## 1. REAL DEPENDENCY MAPPING (traversed, not assumed)

The Telegram send/template/dedup chain was mapped by grepping the real `require` graph, not from
historical audit notes.

### 1.1 Canonical sender (single choke point)

[`lib/telegram-notifier.js`](lib/telegram-notifier.js:280) — `sendTelegramMessage()`
is the one outbound HTTP path every alert funnels through (`https://api.telegram.org/bot<token>/sendMessage`).
It owns:

| Concern | Symbol | Location |
|---|---|---|
| Market-hours gate | `isMarketOpen` (from `market-hours-guard`) | [:284](lib/telegram-notifier.js:284) |
| Stateful anti-spam / cooldown | `checkAlertCooldown` / `recordAlertCooldown` | [:302](lib/telegram-notifier.js:302) · [:389](lib/telegram-notifier.js:389) |
| Outbound throttle queue | `acquireSendSlot` | [:178](lib/telegram-notifier.js:178) |
| 429 `retry_after` backoff | `handle429RateLimit` / `applyRateLimitBackoff` | [:623](lib/telegram-notifier.js:623) · [:202](lib/telegram-notifier.js:202) |
| Chunking | `splitTelegramMessage` | [:243](lib/telegram-notifier.js:243) |

Sibling senders `sendTelegramDocument`/`sendTelegramPhoto`/`sendTelegramPhotoUrl`
[:401](lib/telegram-notifier.js:401) reuse the same throttle + 429 path.

### 1.2 Dependent modules (callers of the canonical sender)

| Module | Role | Reference |
|---|---|---|
| [`lib/telegram-templates.js`](lib/telegram-templates.js:1) | Formats every signal card / hit message | `formatSignalCard`, `formatMonitorHitMessage`, `fmt*` helpers |
| [`lib/telegram-delivery.js`](lib/telegram-delivery.js:19) | Classifies send results into delivery states (idempotent monitor registration) | `classifyTelegramResult`, `finalizePreparedDelivery` |
| [`lib/webhook-alert-engine.js`](lib/webhook-alert-engine.js:455) | **Second, independent** Telegram dispatch path (screeners) + its own cooldown cache | `dispatchTelegram`, `checkCooldown` |
| [`lib/intraday-fast-watcher-publisher.js`](lib/intraday-fast-watcher-publisher.js:312) | Fast-watcher publisher → `publishConfirmed` → `telegramNotifier.sendTelegramMessage` | dedup ledger + `registerConfirmedPicksForMonitoring` |
| [`lib/intraday-fast-watcher-guarded-live.js`](lib/intraday-fast-watcher-guarded-live.js:122) | Dispatch orchestration — routes to publisher/radar/early-watch | kill-switch chain |
| [`lib/foreign-flow-recap.js`](lib/foreign-flow-recap.js:256) | Daily foreign-flow recap, **HTML parse_mode** | `sendForeignFlowRecap` → notifier with `parse_mode:'HTML'` |
| [`lib/telegram-lifecycle.js`](lib/telegram-lifecycle.js:1) | Verification reminders / review requests — deliberately **isolated** (uses `telegram-verify-bot`, never `TELEGRAM_BOT_TOKEN`) | two-phase claim→send→commit |

### 1.3 Two parallel anti-spam caches (important)

- `alertCooldownCache` in [`lib/telegram-notifier.js`](lib/telegram-notifier.js:37) (keyed by `alert_key`/`ticker`; bypass on *drastic* status change).
- `cooldownCache` in [`lib/webhook-alert-engine.js`](lib/webhook-alert-engine.js:40) (keyed by ticker; bypass on *drastic* status change).

Both share the same `isConfirmedBuyStatus` idiom — which is exactly where the substring bug (F10-01) lives in **both** copies.

---

## 2. CHECKLIST RESULTS (line-by-line)

### 2.1 Idempotency & anti-spam loop

- **Dedup key.** Both caches key on **ticker only** (upper-cased). A same-ticker re-alert inside the
  20-minute window is suppressed unless `isDrasticAlertStatusChange` fires.
  - `normalizeAlertStatus` collapses `-`/spaces to `_`.
  - Bypass set: key-action statuses (`TP1_HIT`…`BEP_CLOSED`), neutral→confirmed-buy, normal→AVOID/SL_HIT.
  - **Verdict:** the status axis is handled correctly; the *status-classifier* had a false positive (F10-01).
- **`NOT_READY` false positive (F10-01).** `s.includes('READY')` matches **`NOT_READY`** (and
  `NOT_READY_*`). A neutral→`NOT_READY` transition was therefore treated as a *confirmed-buy upgrade*,
  bypassing the cooldown and emitting a fresh alert for a **non-buy** state. Present in **both**
  [`lib/telegram-notifier.js`](lib/telegram-notifier.js:43) and
  [`lib/webhook-alert-engine.js`](lib/webhook-alert-engine.js:97).
- **Fast-watcher ledger dedup** ([`publisher`](lib/intraday-fast-watcher-publisher.js:160)):
  keyed on `ticker|monitor_source|plan_lock_id` and a session-scoped `planLockId`, with a
  prior-session escape hatch. Correct and unchanged.
- **Monitor-row idempotency** ([`lib/telegram-delivery.js`](lib/telegram-delivery.js:731)): per-row
  `row_results` → `WAITING`/`DELIVERY_UNCERTAIN`/`DELIVERY_FAILED`/`DELIVERY_RETRYABLE`. Correct.

### 2.2 Telegram API error handling & HTTP 429

- **Canonical sender 429.** [`handle429RateLimit`](lib/telegram-notifier.js:623) parses
  `parameters.retry_after`, falls back to the `Retry-After` header, parks the gate via
  [`applyRateLimitBackoff`](lib/telegram-notifier.js:202) and returns
  `{reason:'rate_limited', retry_after_seconds, backoff_ms}`. Messages are **not** silently dropped
  (partially-sent batches report `chunks_sent/chunks_total`). Proven by
  `telegram-notifier-rate-limit.test.js` + `telegram-notifier-throttling.test.js` (both green).
- **Second path gap (F10-03).** [`webhook-alert-engine.dispatchTelegram`](lib/webhook-alert-engine.js:455)
  returned a generic `{error:'Telegram bot HTTP 429: …'}` with **no** `retry_after` extraction and no
  `rate_limited` reason — the screener path could not pace or back off. Fixed.
- **Invalid token / bad chat / timeout.** Canonical sender returns `missing_token`, `missing_chat_id`,
  `telegram_timeout`, `fetch_error` without throwing. Webhook engine wraps fetch in try/catch
  (`{sent:false,error}`). No unhandled rejection reaches the watcher/screener. Verified by F10-06.

### 2.3 Special-character sanitisation & parse-mode crash

- **Parse modes in use:** `HTML` (`foreign-flow-recap`, `voucher-admin-sender`), `Markdown`
  (`admin-device-approval`), plain text (signal cards → no parse_mode).
- **Signal cards are plain text** → reserved chars `_ * [ ] ( ) ~ \` > # + - = | { } . !` are safe.
- **HTML path gap (F10-04).** [`formatForeignFlowRecapMessage`](lib/foreign-flow-recap.js:203) interpolated
  `item.ticker` straight into `<b>…</b>`. A ticker (or future data) containing `&`/`<`/`>` produces
  invalid HTML → Telegram `400 Bad Request: can't parse entities`, dropping the recap. Fixed with an
  `escapeHtml` guard.
- **`fmtPrice`/`fmtValue`/`fmtSignedValue`** already defensively return `-` for `null`/`0`/non-finite.
  But `fmtSignedValue` special-cased **strings** and returned them verbatim (F10-02).

### 2.4 Financial-value sanitation & display consistency

- **`fmtSignedValue` string leak (F10-02).** `if (typeof v === 'string') return v;` let `'NaN'`,
  `'undefined'`, `'null'`, `'[object Object]'` reach the recap/card. Fixed to sanitise these sentinels.
- **F9-08 orderbook label** ([`getDayTradeMetrics`](lib/telegram-templates.js:470)) is present in the
  working tree: numeric `0` no longer collapses to `'Bid Dominant'`; produces
  `Offer Dominant`/`Bid Dominant`/`Balanced`.
- **`null%`/`NaN%` guards.** `formatSignalCardSummary`/`pctFrom` return `null` when `refEntry` is
  absent, so no `null%` label is emitted (covered by F10-04b).
- **R:R / tick fractions** flow through `fmtRR` / `toNum`, returning `-` for non-finite input.

---

## 3. METRICS

| Metric | Value |
|---|---|
| Files audited (read fully) | 8 (`telegram-notifier`, `telegram-templates`, `telegram-delivery`, `webhook-alert-engine`, `intraday-fast-watcher-publisher`, `intraday-fast-watcher-guarded-live`, `foreign-flow-recap`, `telegram-lifecycle`) |
| Bugs found & fixed | 6 (2× NOT_READY substring, 1× fmtSignedValue, 1× webhook 429, 1× HTML escape, 1× whitespace chunk) |
| New tests | 9 (`audit-fase10-telegram-gate-bugs.test.js`) |
| Fix footprint | **+54 / −5** across 4 lib files |
| Curated-list delta | +1 (`527 entries, 0 missing`) |
| Full-suite result | **527/527 test files passed** |
| Syntax validation | **888/888 JS files parsed cleanly** |

---

## 4. ERROR-HANDLING MATRIX (post-fix)

| Scenario | Canonical sender | Webhook engine |
|---|---|---|
| Disabled / missing token / missing chat | skip, no throw | skip (`missing_telegram_credentials`) |
| Market closed | `skipped: market_closed` | `skipped: market_session_closed` |
| Duplicate inside cooldown | `skipped: duplicate_suppressed` | `skipped: in_cooldown` |
| HTTP 429 | `rate_limited` + `retry_after_seconds` + gate parked | `rate_limited` + `retry_after_seconds` (post-F10-03) |
| Timeout / network error | `telegram_timeout` / `fetch_error`, no throw | `{sent:false,error}` |
| 400/401/403/404 | classified `permanent` by `telegram-delivery` | `{sent:false,status,error}` |
| Partial multi-chunk failure | `chunks_sent/chunks_total` + `partial` semantics | returns early, no duplicate resend |
