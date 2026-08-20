from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


sector_path = Path('api/sector-hot.js')
sector = sector_path.read_text()

sector = replace_once(
    sector,
    """    var individualMessagePreviews = [];
    var individualSendableCount = 0;
    var individualSentCount = 0;
""",
    """    var individualMessagePreviews = [];
    var individualSendableCount = 0;
    var individualSentCount = 0;
    var individualFailedCount = 0;
    var individualFailures = [];
""",
    'monitor counters'
)

sector = replace_once(
    sector,
    """      // WRITE SUPPRESSION: dry-run never touches telegram_daily_picks (status, hit_* timestamps, last_checked_at).
      if (!dryRun) await supabase.from('telegram_daily_picks').update(update).eq('id', pck.id);

      // Attempt AI note for significant status updates (note-only: appended to template)
""",
    """      // Persistence is intentionally deferred until after an immediate significant-hit
      // Telegram delivery attempt. A failed send must not consume hit_* idempotency
      // markers or terminal state, otherwise the next monitor run can never retry.

      // Attempt AI note for significant status updates (note-only: appended to template)
""",
    'early monitor persistence'
)

sector = replace_once(
    sector,
    """      if (significantHit) {
        individualSendableCount++;
        // Use premium short monitor hit format for significant events
        var hitMsg = telegramTemplates.formatMonitorHitMessage(pck, ev, px);
        if (monitorAiNote) hitMsg += '\\nCatatan AI: ' + monitorAiNote;
        // TELEGRAM SUPPRESSION: dry-run records the message it WOULD send instead of sending.
        if (dryRun) {
          individualMessagePreviews.push({ ticker: pck.ticker, source: resolveMonitorSource(pck), status: ev.status, message: hitMsg });
        } else {
          var hitResult = await telegramNotifier.sendTelegramMessage(hitMsg, { timeout_ms: 3000 });
          if (hitResult.sent) individualSentCount++;
        }
      }

      // HOURLY BATCH DIGEST ROW — a compact status block for EVERY deduplicated
""",
    """      var hitResult = null;
      if (significantHit) {
        individualSendableCount++;
        // Use premium short monitor hit format for significant events
        var hitMsg = telegramTemplates.formatMonitorHitMessage(pck, ev, px);
        if (monitorAiNote) hitMsg += '\\nCatatan AI: ' + monitorAiNote;
        // TELEGRAM SUPPRESSION: dry-run records the message it WOULD send instead of sending.
        if (dryRun) {
          individualMessagePreviews.push({ ticker: pck.ticker, source: resolveMonitorSource(pck), status: ev.status, message: hitMsg });
        } else {
          hitResult = await telegramNotifier.sendTelegramMessage(hitMsg, { timeout_ms: 3000 });
          if (hitResult.sent) individualSentCount++;
        }
      }

      // Commit the hit marker / terminal transition only after a successful
      // immediate delivery. On failure persist only last_checked_at so the row
      // remains eligible and the same significant event can be retried by the
      // next monitor invocation instead of disappearing permanently.
      if (!dryRun) {
        var persistedUpdate = update;
        if (significantHit && (!hitResult || !hitResult.sent)) {
          individualFailedCount++;
          individualFailures.push({
            ticker: pck.ticker,
            status: ev.status,
            reason: hitResult && hitResult.reason ? hitResult.reason : 'delivery_failed',
            http_status: hitResult && hitResult.status != null ? hitResult.status : null,
            retry_after_seconds: hitResult && hitResult.retry_after_seconds != null ? hitResult.retry_after_seconds : null
          });
          persistedUpdate = { last_checked_at: update.last_checked_at };
        }
        var persistResult = await supabase.from('telegram_daily_picks').update(persistedUpdate).eq('id', pck.id);
        if (persistResult && persistResult.error) throw new Error(persistResult.error.message || 'monitor state persistence failed');
      }

      // HOURLY BATCH DIGEST ROW — a compact status block for EVERY deduplicated
""",
    'significant-hit delivery'
)

sector = replace_once(
    sector,
    """    return res.status(200).json({ success: true, skipped: false, forced: force, weekend_bypassed: weekendBypassed, hourly_batch_due: hourlyBatchDue, batch_suppressed_by_cadence: !hourlyBatchDue, batch_send_reason: batchSendReason, sent_count: (hourlyBatchDue && sendResult.sent) ? 1 : 0, individual_sent_count: individualSentCount, checked_count: rows.length, shown_count: shown, ai_narration: aiNarrationResults.length > 0 ? aiNarrationResults : undefined, error: null, telegram: sendResult });
""",
    """    var individualDeliveryOk = individualFailedCount === 0;
    return res.status(200).json({ success: individualDeliveryOk, skipped: false, forced: force, weekend_bypassed: weekendBypassed, hourly_batch_due: hourlyBatchDue, batch_suppressed_by_cadence: !hourlyBatchDue, batch_send_reason: batchSendReason, sent_count: (hourlyBatchDue && sendResult.sent) ? 1 : 0, individual_sent_count: individualSentCount, individual_failed_count: individualFailedCount, individual_failures: individualFailures.length > 0 ? individualFailures : undefined, checked_count: rows.length, shown_count: shown, ai_narration: aiNarrationResults.length > 0 ? aiNarrationResults : undefined, error: individualDeliveryOk ? null : 'individual_monitor_delivery_failed', telegram: sendResult });
""",
    'monitor response'
)

sector = replace_once(
    sector,
    """  var secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    var got = req.headers['x-telegram-bot-api-secret-token'];
    if (got !== secret) return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
""",
    """  var secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  // Fail closed. A missing secret is a server misconfiguration, never permission
  // to accept unauthenticated Telegram updates.
  if (!secret) return res.status(503).json({ success: false, error: 'Telegram webhook secret is not configured.' });
  var got = req.headers['x-telegram-bot-api-secret-token'];
  if (typeof got !== 'string' || got.length !== secret.length) return res.status(401).json({ success: false, error: 'Unauthorized' });
  var gotBuf = Buffer.from(got, 'utf8');
  var secretBuf = Buffer.from(secret, 'utf8');
  if (!crypto.timingSafeEqual(gotBuf, secretBuf)) return res.status(401).json({ success: false, error: 'Unauthorized' });
""",
    'webhook secret'
)

sector_path.write_text(sector)


notifier_path = Path('lib/telegram-notifier.js')
notifier = notifier_path.read_text()
notifier = replace_once(
    notifier,
    """      if (!response.ok) {
        var errBody = '';
        try { errBody = await response.text(); } catch (readErr) { /* ignore */ }
        var errMsg = 'HTTP ' + response.status;
        if (errBody && errBody.length < 200) errMsg += ': ' + errBody;
        return { ok: false, sent: false, skipped: false, reason: 'api_error', status: response.status, error_message: errMsg, chunks_total: chunks.length, chunks_sent: sentCount };
      }
""",
    """      if (!response.ok) {
        var errBody = '';
        try { errBody = await response.text(); } catch (readErr) { /* ignore */ }
        var errMsg = 'HTTP ' + response.status;
        if (errBody && errBody.length < 200) errMsg += ': ' + errBody;
        if (response.status === 429) {
          var retryAfter = null;
          try {
            var parsed429 = errBody ? JSON.parse(errBody) : null;
            retryAfter = parsed429 && parsed429.parameters ? Number(parsed429.parameters.retry_after) : null;
          } catch (parseErr) { /* ignore */ }
          if (!Number.isFinite(retryAfter) || retryAfter < 0) {
            retryAfter = response.headers && response.headers.get ? Number(response.headers.get('retry-after')) : null;
          }
          if (!Number.isFinite(retryAfter) || retryAfter < 0) retryAfter = null;
          return { ok: false, sent: false, skipped: false, reason: 'rate_limited', status: 429, retry_after_seconds: retryAfter, error_message: errMsg, chunks_total: chunks.length, chunks_sent: sentCount };
        }
        return { ok: false, sent: false, skipped: false, reason: 'api_error', status: response.status, error_message: errMsg, chunks_total: chunks.length, chunks_sent: sentCount };
      }
""",
    'Telegram sendMessage API error'
)
notifier_path.write_text(notifier)


Path('test/telegram-monitor-delivery-order.test.js').write_text("""'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');

test('significant monitor hits are delivered before terminal markers are persisted', () => {
  const start = source.indexOf('var update = { status: ev.status');
  const end = source.indexOf('// HOURLY BATCH DIGEST ROW', start);
  assert.ok(start >= 0 && end > start, 'monitor block not found');
  const block = source.slice(start, end);
  const send = block.indexOf('sendTelegramMessage(hitMsg');
  const persist = block.indexOf(\"update(persistedUpdate).eq('id', pck.id)\");
  assert.ok(send >= 0, 'immediate Telegram send not found');
  assert.ok(persist > send, 'monitor state must be persisted only after the delivery attempt');
  assert.ok(block.includes(\"persistedUpdate = { last_checked_at: update.last_checked_at }\"), 'failed sends must not consume terminal/hit markers');
});

test('monitor response surfaces an individual delivery failure instead of reporting success true', () => {
  assert.match(source, /success:\\s*individualDeliveryOk/);
  assert.match(source, /individual_failed_count:\\s*individualFailedCount/);
  assert.match(source, /individual_monitor_delivery_failed/);
});

test('Telegram webhook fails closed when its secret is absent', () => {
  const start = source.indexOf('async function handleTelegramWebhook');
  const end = source.indexOf('var body = req.body || {}', start);
  const block = source.slice(start, end);
  assert.match(block, /if \\(!secret\\) return res\\.status\\(503\\)/);
  assert.match(block, /crypto\\.timingSafeEqual/);
});
""")

Path('test/telegram-notifier-rate-limit.test.js').write_text("""'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const notifier = require('../lib/telegram-notifier');

test('sendTelegramMessage exposes Telegram 429 retry_after metadata', async () => {
  const saved = {
    enabled: process.env.TELEGRAM_ENABLED,
    token: process.env.TELEGRAM_BOT_TOKEN,
    chat: process.env.TELEGRAM_CHAT_ID,
    fetch: global.fetch
  };
  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '123';
  global.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: async () => JSON.stringify({ ok: false, parameters: { retry_after: 7 } })
  });
  try {
    const result = await notifier.sendTelegramMessage('test', { timeout_ms: 100 });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'rate_limited');
    assert.equal(result.status, 429);
    assert.equal(result.retry_after_seconds, 7);
  } finally {
    if (saved.enabled === undefined) delete process.env.TELEGRAM_ENABLED; else process.env.TELEGRAM_ENABLED = saved.enabled;
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = saved.token;
    if (saved.chat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = saved.chat;
    global.fetch = saved.fetch;
  }
});
""")
