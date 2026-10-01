# BUG FINDINGS — FASE 10 (23 SEPT)
# Telegram Notification Delivery, Rate Limiting, Deduplication/Anti-Spam Gate, & Template Formatting

**Method:** Zero-trust, test-first. Every finding below was proven by a **failing unit test**
*before* the fix, then re-verified **PASS 2× consecutive**, then the full repo suite was run green.

**Regression suite:** [`test/audit-fase10-telegram-gate-bugs.test.js`](test/audit-fase10-telegram-gate-bugs.test.js:1)
**Diff footprint:** +54 / −5 across 4 lib files + 1 curated-list file.
**Verification:** `9/9 PASS ×2` · `527/527 test files passed` · `888 JS files parsed cleanly`.

| ID | Severity | Subsystem | One-line summary |
|---|---|---|---|
| F10-01 | HIGH | Anti-spam gate (×2 modules) | `NOT_READY` matched `READY` substring → bypassed cooldown as a "confirmed buy" |
| F10-02 | MEDIUM | Template formatting | `fmtSignedValue` returned raw `'NaN'`/`'undefined'`/`'null'` strings verbatim |
| F10-03 | HIGH | Rate limiting (webhook path) | 429 returned no `retry_after` → screener path could not back off |
| F10-04 | HIGH | HTML parse mode | Unescaped ticker → `400 can't parse entities`, recap dropped |
| F10-05 | LOW | Chunking | Whitespace-only input produced a whitespace-only chunk |
| F10-06 | — (guard) | Dispatch resilience | Network error must not throw out of `dispatchTelegram` (verified, no change needed) |

---

## F10-01 — `NOT_READY` false-positive in `isConfirmedBuyStatus` (substring bug)

**Severity:** HIGH · **Class:** Logic / substring matching · **Files:**
[`lib/telegram-notifier.js`](lib/telegram-notifier.js:43),
[`lib/webhook-alert-engine.js`](lib/webhook-alert-engine.js:97)

### Root cause

```js
function isConfirmedBuyStatus(status) {
  const s = normalizeAlertStatus(status);
  return s.includes('A_PLUS') || s.includes('READY') || s.includes('TRADE_CANDIDATE') || s.includes('CONFIRMED');
}
```

`s.includes('READY')` is true for **`NOT_READY`** (and any `NOT_READY_*`). Both anti-spam caches use
this function inside their *drastic status change* bypass: a neutral status such as `WATCHLIST`
transitioning to `NOT_READY` was therefore classified as an **upgrade to a confirmed buy**, bypassing
the 20-minute cooldown and emitting a fresh alert for a signal that is explicitly **not** a buy.

Two independent cache implementations share the bug: `checkAlertCooldown` (notifier) and
`checkCooldown` (webhook engine).

### Proof (pre-fix)

```
test/audit-fase10-telegram-gate-bugs.test.js:24
  AssertionError [ERR_ASSERTION]: WATCHLIST -> NOT_READY must NOT be considered drastic upgrade
  (NOT_READY contains READY substring bug)
  actual: true   expected: false

test/audit-fase10-telegram-gate-bugs.test.js:33
  AssertionError [ERR_ASSERTION]: NOT_READY should NOT bypass WATCHLIST cooldown (substring bug)
  actual: false  expected: true
```

### Fix (minimal diff — negate the sentinel before the substring test)

```diff
 function isConfirmedBuyStatus(status) {
   const s = normalizeAlertStatus(status);
+  if (s === 'NOT_READY' || s.indexOf('NOT_READY') === 0) return false;
   return s.includes('A_PLUS') || s.includes('READY') || s.includes('TRADE_CANDIDATE') || s.includes('CONFIRMED');
 }
```

Applied identically in `lib/webhook-alert-engine.js` (`normalizeStatus`).

**Tests:** `F10-01`, `F10-01b`

---

## F10-02 — `fmtSignedValue` leaks raw `'NaN'` / `'undefined'` / `'null'` strings

**Severity:** MEDIUM · **Class:** Type/representation leak · **File:**
[`lib/telegram-templates.js`](lib/telegram-templates.js:66)

### Root cause

```js
function fmtSignedValue(v) {
  if (typeof v === 'string') return v;   // verbatim — even for sentinel strings
  ...
}
```

The string fast-path was meant to pass through already-formatted values (e.g. `'+Rp 1 M'`), but it
also passed through `'NaN'`, `'undefined'`, `'null'` and `'[object Object]'`. Those sentinels reach
`formatSignalCard` / `formatForeignFlowRecapMessage` output and show the user a corrupted financial
line instead of the honest `-` placeholder used everywhere else.

### Proof (pre-fix)

```
test/audit-fase10-telegram-gate-bugs.test.js:42
  AssertionError [ERR_ASSERTION]: NaN string must be sanitized to -
  actual: 'NaN'   expected: '-'
```

### Fix

```diff
 function fmtSignedValue(v) {
-  if (typeof v === 'string') return v;
+  if (typeof v === 'string') {
+    var t = v.trim().toLowerCase();
+    if (t === 'nan' || t === 'undefined' || t === 'null' || t === '[object object]' || t === '') return '-';
+    return v;
+  }
   var n = toNum(v);
   ...
 }
```

**Tests:** `F10-02`, `F10-02b`

---

## F10-03 — Webhook `dispatchTelegram` ignored 429 `retry_after`

**Severity:** HIGH · **Class:** Rate-limit handling / queue safety · **File:**
[`lib/webhook-alert-engine.js`](lib/webhook-alert-engine.js:455)

### Root cause

The canonical sender parses `retry_after` and parks a shared throttle gate
([`handle429RateLimit`](lib/telegram-notifier.js:623)), but the **second** dispatch path used by the
screeners returned a generic error only:

```js
if (!response.ok) {
  const errText = await response.text().catch(() => '');
  return { sent: false, status: response.status,
           error: `Telegram bot HTTP ${response.status}: ${errText.slice(0, 150)}` };
}
```

A `429` surfaced as an opaque string. Callers could neither read `retry_after` nor distinguish
throttling from a genuine API error, so a screener burst tripping Telegram's limit had **no backoff**:
subsequent alerts kept hammering the endpoint.

### Proof (pre-fix)

```
test/audit-fase10-telegram-gate-bugs.test.js:73
  AssertionError [ERR_ASSERTION]: retry_after_seconds must be 5, got
  {"sent":false,"status":429,"error":"Telegram bot HTTP 429: {\"ok\":false,\"parameters\":{\"retry_after\":5}}"}
  actual: undefined   expected: 5
```

### Fix

```diff
       if (!response.ok) {
         const errText = await response.text().catch(() => '');
+        let retryAfter = null;
+        try {
+          const parsed = errText ? JSON.parse(errText) : null;
+          retryAfter = parsed && parsed.parameters ? Number(parsed.parameters.retry_after) : null;
+        } catch (_) {}
+        if (!Number.isFinite(retryAfter) || retryAfter < 0) {
+          retryAfter = response.headers && response.headers.get ? Number(response.headers.get('retry-after')) : null;
+        }
+        if (!Number.isFinite(retryAfter) || retryAfter < 0) retryAfter = null;
+        if (response.status === 429) {
+          return {
+            sent: false,
+            status: 429,
+            reason: 'rate_limited',
+            retry_after_seconds: retryAfter,
+            error: `Telegram bot HTTP 429 rate_limited retry_after=${retryAfter}: ${errText.slice(0, 150)}`
+          };
+        }
         return {
           sent: false,
           status: response.status,
           error: `Telegram bot HTTP ${response.status}: ${errText.slice(0, 150)}`
         };
       }
```

Mirrors the canonical sender's contract: body (`parameters.retry_after`) → header (`Retry-After`).

**Tests:** `F10-03`

---

## F10-04 — Unescaped ticker breaks HTML parse mode (`400 can't parse entities`)

**Severity:** HIGH · **Class:** Output encoding / parse-mode crash · **File:**
[`lib/foreign-flow-recap.js`](lib/foreign-flow-recap.js:203)

### Root cause

`formatForeignFlowRecapMessage` builds a message that is sent with `parse_mode: 'HTML'`
([:273](lib/foreign-flow-recap.js:273)) but interpolated the raw ticker into a bold tag:

```js
lines.push(`${rank}. <b>${item.ticker}</b>: <code>+Rp ${formatIDR(item.net_val)}</code>${brokers}`);
```

Any `&`, `<`, `>` in the interpolated value produces invalid HTML entities. Telegram then rejects the
**entire** message with `400 Bad Request: can't parse entities`, silently dropping the daily recap.

### Proof (pre-fix)

```
test/audit-fase10-telegram-gate-bugs.test.js:93
  AssertionError [ERR_ASSERTION]: Raw & inside <b> must be escaped to & for HTML parse_mode
  actual: '... 1. <b>A&B</b>: <code>+Rp 500.0 jt</code> (AK) ...'
  expected: doesNotMatch /<b>A&B<\/b>/
```

### Fix

Added a dedicated encoder and applied it to both accumulation and distribution rows:

```diff
+function escapeHtml(s) {
+  return String(s == null ? String(s) : s).replace(/&/g, String.fromCharCode(38)+"amp;").replace(/</g, String.fromCharCode(38)+"lt;").replace(/>/g, String.fromCharCode(38)+"gt;");
+}
+
 function formatIDR(num) {
```

```diff
-      lines.push(`${rank}. <b>${item.ticker}</b>: <code>+Rp ${formatIDR(item.net_val)}</code>${brokers}`);
+      lines.push(`${rank}. <b>${escapeHtml(item.ticker)}</b>: <code>+Rp ${formatIDR(item.net_val)}</code>${brokers}`);
```

```diff
-      lines.push(`${rank}. <b>${item.ticker}</b>: <code>-Rp ${formatIDR(Math.abs(item.net_val))}</code>${brokers}`);
+      lines.push(`${rank}. <b>${escapeHtml(item.ticker)}</b>: <code>-Rp ${formatIDR(Math.abs(item.net_val))}</code>${brokers}`);
```

**Tests:** `F10-04` (plus `F10-04b` guarding `NaN`/`undefined`/`null%` in signal cards)

---

## F10-05 — Whitespace-only input produced a whitespace-only chunk

**Severity:** LOW · **Class:** Input normalisation · **File:**
[`lib/telegram-notifier.js`](lib/telegram-notifier.js:243)

### Root cause

```js
function splitTelegramMessage(text, maxLen) {
  var clean = String(text || '');
  if (clean.length <= maxLen) return [clean];   // '   \n\n   ' returned as-is
```

A whitespace-only message returned a single all-whitespace chunk. `sendTelegramMessage` guards
`empty_message` on the *trimmed* input, but any caller reaching `splitTelegramMessage` directly (or a
padded-but-effectively-empty payload) could still attempt a meaningless send.

### Proof (pre-fix)

```
test/audit-fase10-telegram-gate-bugs.test.js:123
  AssertionError [ERR_ASSERTION]: chunk must not be whitespace-only: "   \n\n   "
```

### Fix

```diff
 function splitTelegramMessage(text, maxLen) {
   maxLen = maxLen || 3600;
-  var clean = String(text || '');
+  var clean = String(text || '').trim();
+  if (!clean) return [];
   if (clean.length <= maxLen) return [clean];
```

**Tests:** `F10-05`

---

## F10-06 — Dispatch resilience on network error (verified, no code change)

**Severity:** guard · **Class:** verification-only

`webhook-alert-engine.dispatchTelegram` already wraps the fetch loop in `try/catch` and returns
`{sent:false, error}`. The test asserts this contract so a future refactor cannot regress it into a
thrown promise that would kill the watcher/screener loop.

**Test:** `F10-06`

---

## VERIFICATION EVIDENCE

### FAIL before fix (excerpt)

```
✖ F10-01  WATCHLIST -> NOT_READY must NOT be considered drastic upgrade   (true !== false)
✖ F10-01b NOT_READY should NOT bypass WATCHLIST cooldown                 (false !== true)
✖ F10-02  NaN string must be sanitized to -                              ('NaN' !== '-')
✖ F10-03  retry_after_seconds must be 5, got {...}                       (undefined !== 5)
✖ F10-04  Raw & inside <b> must be escaped for HTML parse_mode
✖ F10-05  chunk must not be whitespace-only: "   \n\n   "
ℹ pass 3   ℹ fail 6
```

### PASS after fix — run 1

```
✔ F10-01  ✔ F10-01b  ✔ F10-02  ✔ F10-02b  ✔ F10-03  ✔ F10-04  ✔ F10-04b  ✔ F10-05  ✔ F10-06
ℹ tests 9   ℹ pass 9   ℹ fail 0
```

### PASS after fix — run 2 (consecutive)

```
✔ F10-01  ✔ F10-01b  ✔ F10-02  ✔ F10-02b  ✔ F10-03  ✔ F10-04  ✔ F10-04b  ✔ F10-05  ✔ F10-06
ℹ tests 9   ℹ pass 9   ℹ fail 0
```

### Regression + repository suite

```
Telegram regression (8 files, incl. rate-limit/throttling/delivery/templates):
  ℹ tests 88   ℹ pass 88   ℹ fail 0

Full syntax check: 888 .js files parsed.
Curated test list: 527 entries, 0 missing.
All .js files parsed cleanly.
node tools/run-build-test-suite.js --full:
  All 527 test files passed successfully!
```

### Registration

`tools/curated-build-tests.json` — added `test/audit-fase10-telegram-gate-bugs.test.js` as the first
entry; list now `527 entries, 0 missing` (verified via `require()`).
