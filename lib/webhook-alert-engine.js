'use strict';

/**
 * Unified Webhook Alert Engine for Telegram & Discord
 *
 * Centralized alert dispatcher for Day Trade & Swing screeners:
 *   1. Multi-channel dispatch: Telegram Signal Card v2 + Discord Rich Embed
 *   2. Deduplication & Cooldown guard per ticker (default 30m) with status-upgrade bypass
 *   3. Integrated Pattern Personality Edge statistics (WR, PF, MFE, MAE)
 *   4. Dry-run mode and isolated graceful failure handling per channel
 */

// BATCH 3 Module 2: jendela cooldown sliding-window per ticker = 20 menit
// (1.200.000 ms). Jika ticker X memicu alert pada timestamp T, semua sinyal
// berikutnya untuk ticker X sebelum T + 20 menit di-suppress.
const FAST_WATCHER_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes

const telegramTemplates = require('./telegram-templates');
const patternPersonality = require('./pattern-personality');

const DEFAULT_COOLDOWN_MS = FAST_WATCHER_COOLDOWN_MS; // 20 minutes (BATCH 3)

// Tier alert fast-watcher -> channel Telegram. Identitas sinyal dipisah
// ketat dari struktur payload agar routing tidak tercampur aduk.
const ALERT_TIER_CHANNELS = Object.freeze({
  EARLY_WATCH: 'telegram_early_watch',
  RADAR_DAYTRADE: 'telegram_radar_daytrade',
  SPIKE_ALERT: 'telegram_spike_alert'
});

const DISCORD_COLORS = Object.freeze({
  GREEN: 0x22C55E,  // 2278750 (A+ Setup, Ready Breakout, Trade Candidate, Confirmed Buy)
  ORANGE: 0xF97316, // 16348422 (Wait Pullback, Reclaim, Momentum)
  YELLOW: 0xEAB308, // 15381256 (Early Radar, Pre-Spike, Watchlist, Speculative)
  RED: 0xEF4444,    // 15682884 (Avoid, SL Hit, Distribution)
  BLUE: 0x3B82F6    // 3899894 (Default informational)
});

// In-memory deduplication & anti-spam cache
const cooldownCache = new Map();

/**
 * Reset/clear the in-memory cooldown cache (useful for testing)
 */
function clearCooldownCache() {
  cooldownCache.clear();
}

/**
 * Resolve deterministic "now" (BATCH 3: test boleh inject options.now).
 */
function resolveNow(options) {
  var raw = options && options.now != null ? options.now : Date.now();
  var ms = raw instanceof Date ? raw.getTime() : Number(raw);
  return Number.isFinite(ms) ? ms : Date.now();
}

/**
 * Get current cooldown status for a ticker
 * @param {string} ticker
 * @param {object} [options] - { now }
 * @returns {object|null}
 */
function getCooldownStatus(ticker, options) {
  if (!ticker) return null;
  const key = String(ticker).trim().toUpperCase();
  const entry = cooldownCache.get(key);
  if (!entry) return null;

  const now = resolveNow(options);
  const remainingMs = Math.max(0, entry.expiresAt - now);
  return {
    ticker: key,
    status: entry.status,
    action: entry.action,
    recordedAt: new Date(entry.recordedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    isExpired: remainingMs === 0,
    remainingMs
  };
}

/**
 * Normalize status string for comparison
 * @param {string} status
 * @returns {string}
 */
function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/**
 * Classify whether status represents a high-priority confirmed buy signal
 * @param {string} status
 * @returns {boolean}
 */
function isConfirmedBuyStatus(status) {
  const s = normalizeStatus(status);
  return s.includes('A_PLUS') || s.includes('READY') || s.includes('TRADE_CANDIDATE') || s.includes('CONFIRMED');
}

/**
 * Determine if an incoming alert should bypass cooldown due to a significant status change
 * @param {object} cachedEntry
 * @param {object} candidate
 * @returns {boolean}
 */
function isKeyActionStatus(status) {
  const s = normalizeStatus(status);
  return s.includes('TP1_HIT') || s.includes('TP2_HIT') || s.includes('TP3_HIT') ||
         s.includes('EARLY_EXIT') || s.includes('DISTRIBUTION') ||
         s.includes('TRAILING_STOP') || s.includes('BEP_CLOSED');
}

function isDrasticStatusChange(cachedEntry, candidate) {
  if (!cachedEntry) return false;
  const prevStatus = normalizeStatus(cachedEntry.status);
  const nextStatus = normalizeStatus(candidate.status || candidate.final_status);

  if (isKeyActionStatus(nextStatus)) {
    return true;
  }

  // Upgrade: Watchlist / Radar / Pullback -> Confirmed Buy
  const wasNeutral = prevStatus.includes('WATCHLIST') || prevStatus.includes('RADAR') || prevStatus.includes('PULLBACK') || prevStatus.includes('SPECULATIVE');
  const isNowBuy = isConfirmedBuyStatus(nextStatus);
  if (wasNeutral && isNowBuy) {
    return true;
  }

  // Emergency / Critical update: Normal setup -> SL Hit / Avoid
  const isNowAvoid = nextStatus.includes('AVOID') || nextStatus.includes('SL_HIT') || nextStatus.includes('INVALID');
  const wasNormal = !prevStatus.includes('AVOID') && !prevStatus.includes('SL_HIT');
  if (isNowAvoid && wasNormal) {
    return true;
  }

  return false;
}

/**
 * Evaluate if ticker is in cooldown or should be suppressed
 * @param {string} ticker
 * @param {object} candidate
 * @param {object} options
 * @returns {{ shouldDrop: boolean, reason: string|null }}
 */
function checkCooldown(ticker, candidate, options = {}) {
  if (!ticker) return { shouldDrop: false, suppressed: false, cooldown_active: false, reason: null };
  if (options.force === true) return { shouldDrop: false, suppressed: false, cooldown_active: false, reason: 'forced_bypass' };

  const key = String(ticker).trim().toUpperCase();
  const cached = cooldownCache.get(key);
  if (!cached) return { shouldDrop: false, suppressed: false, cooldown_active: false, reason: null };

  const now = resolveNow(options);
  if (now >= cached.expiresAt) {
    cooldownCache.delete(key);
    return { shouldDrop: false, suppressed: false, cooldown_active: false, reason: 'cooldown_expired' };
  }

  // Check for drastic status change upgrade/downgrade
  if (isDrasticStatusChange(cached, candidate)) {
    return { shouldDrop: false, suppressed: false, cooldown_active: false, reason: 'status_changed_bypass' };
  }

  const remainingMs = Math.max(0, cached.expiresAt - now);
  return {
    shouldDrop: true,
    suppressed: true,
    cooldown_active: true,
    remainingMs: remainingMs,
    reason: `in_cooldown (${Math.ceil(remainingMs / 1000)}s remaining)`
  };
}

/**
 * Record a sent alert in the cooldown cache
 * @param {string} ticker
 * @param {object} candidate
 * @param {object} options
 */
function recordCooldown(ticker, candidate, options = {}) {
  if (!ticker) return;
  const key = String(ticker).trim().toUpperCase();
  const cooldownMs = Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS;
  const now = resolveNow(options);

  cooldownCache.set(key, {
    ticker: key,
    status: normalizeStatus(candidate.status || candidate.final_status),
    action: candidate.action || candidate.signal_action || null,
    recordedAt: now,
    expiresAt: now + cooldownMs
  });
}

/**
 * BATCH 3 Module 2: bangun payload alert dengan identitas sinyal terpisah
 * ketat dari struktur payload.
 *   EARLY_WATCH   — peringatan dini anomali volume sebelum breakout.
 *   RADAR_DAYTRADE — sinyal konfirmasi setup teknikal matang.
 *   SPIKE_ALERT   — lonjakan impulsif harga/volume mendadak.
 * Setiap tier membawa field `alert_tier` dan channel Telegram sendiri agar
 * routing tidak tercampur aduk.
 */
function buildAlertPayload(input) {
  var src = input || {};
  var tierRaw = String(src.alert_tier || src.tier || '').trim().toUpperCase();
  var tier = 'RADAR_DAYTRADE';
  if (tierRaw === 'EARLY_WATCH' || tierRaw === 'EARLYWATCH' || tierRaw === 'EARLY') tier = 'EARLY_WATCH';
  else if (tierRaw === 'SPIKE_ALERT' || tierRaw === 'SPIKE' || tierRaw === 'SPIKEALERT') tier = 'SPIKE_ALERT';
  else if (tierRaw === 'RADAR_DAYTRADE' || tierRaw === 'RADAR' || tierRaw === 'RADAR_DAY_TRADE') tier = 'RADAR_DAYTRADE';
  var channel = ALERT_TIER_CHANNELS[tier] || ALERT_TIER_CHANNELS.RADAR_DAYTRADE;
  var payload = {
    ticker: String(src.ticker || '').trim().toUpperCase(),
    alert_tier: tier,
    channel: channel,
    price: src.price != null ? Number(src.price) : (src.last_price != null ? Number(src.last_price) : null)
  };
  // Identitas sinyal dipisah ketat per tier:
  // - EARLY_WATCH: hanya anomali volume awal, TANPA score konfirmasi matang.
  // - RADAR_DAYTRADE: konfirmasi setup matang (score wajib).
  // - SPIKE_ALERT: impuls mendadak (volume + change wajib, tanpa score matang).
  if (tier === 'EARLY_WATCH') {
    if (src.volume != null) payload.volume = Number(src.volume);
    if (src.volume_ratio != null) payload.volume_ratio = Number(src.volume_ratio);
    if (src.anomaly != null) payload.anomaly = src.anomaly;
  } else if (tier === 'RADAR_DAYTRADE') {
    if (src.score != null) payload.score = Number(src.score);
    if (src.setup != null) payload.setup = src.setup;
    if (src.status != null) payload.status = src.status;
  } else if (tier === 'SPIKE_ALERT') {
    if (src.volume != null) payload.volume = Number(src.volume);
    if (src.change_pct != null) payload.change_pct = Number(src.change_pct);
    if (src.price_change_pct != null) payload.price_change_pct = Number(src.price_change_pct);
  }
  return payload;
}

/**
 * Pick Discord embed color based on candidate status
 * @param {object} candidate
 * @returns {number} Hex color number
 */
function resolveDiscordColor(candidate) {
  const status = normalizeStatus(candidate.status || candidate.final_status);
  if (status.includes('AVOID') || status.includes('SL_HIT') || status.includes('INVALID')) {
    return DISCORD_COLORS.RED;
  }
  if (isConfirmedBuyStatus(status)) {
    return DISCORD_COLORS.GREEN;
  }
  if (status.includes('PULLBACK') || status.includes('RECLAIM') || status.includes('MOMENTUM')) {
    return DISCORD_COLORS.ORANGE;
  }
  if (status.includes('RADAR') || status.includes('WATCHLIST') || status.includes('PRE_SPIKE') || status.includes('SPECULATIVE')) {
    return DISCORD_COLORS.YELLOW;
  }
  return DISCORD_COLORS.BLUE;
}

/**
 * Ensure pattern personality metadata is attached to candidate
 * @param {object} candidate
 * @returns {object} Enriched candidate
 */
function enrichPatternPersonality(candidate) {
  if (!candidate) return candidate;
  let patternKey = candidate.pattern_personality || candidate.pattern_key;
  if (!patternKey && typeof patternPersonality.matchTickerPattern === 'function') {
    patternKey = patternPersonality.matchTickerPattern(candidate);
  }
  let edgeLine = candidate.pattern_edge_line;
  if (!edgeLine && patternKey) {
    edgeLine = patternPersonality.formatPatternPersonalityLine(patternKey);
  }
  const patternData = patternKey ? patternPersonality.getPatternPersonality(patternKey) : null;

  return Object.assign({}, candidate, {
    pattern_personality: patternKey,
    pattern_edge_line: edgeLine,
    _pattern_data: patternData
  });
}

/**
 * Format a candidate as a Discord Rich Embed payload
 * @param {object} candidate
 * @param {object} options
 * @returns {object} Discord webhook payload object
 */
function formatDiscordEmbed(candidate, options = {}) {
  const enriched = enrichPatternPersonality(candidate);
  const ticker = String(enriched.ticker || '-').toUpperCase();
  const signalLabel = telegramTemplates.classifySignalLabel(enriched);
  const color = resolveDiscordColor(enriched);

  const entryLow = enriched.entry_low || enriched.entry1 || enriched.buy_low;
  const entryHigh = enriched.entry_high || enriched.entry2 || enriched.buy_high;
  const tp1 = enriched.tp1 || enriched.tp1n;
  const tp2 = enriched.tp2 || enriched.tp2n;
  const sl = enriched.stop_loss || enriched.sl;
  const rr = enriched.risk_reward;
  const lastPrice = enriched.last_price || enriched.lastn || enriched.close || 0;
  const volRatio = enriched.volume_ratio_20d || enriched.volume_ratio_avg20 || enriched.volume_ratio;
  const volPace = enriched.intraday_volume_pace_ratio || enriched.volume_pace || volRatio;
  const txValue = enriched.tx_value_1d || enriched.value_today || enriched.avg_value_7d;

  // Trading Plan field
  const e1 = Math.max(Number(entryLow || 0), Number(entryHigh || 0));
  const e2 = Math.min(Number(entryLow || 0), Number(entryHigh || 0));
  const areaBeliStr = (e2 > 0 && e1 > 0 && e2 !== e1)
    ? `${telegramTemplates.fmtPrice(e2)} - ${telegramTemplates.fmtPrice(e1)}`
    : telegramTemplates.fmtPrice(e1 || lastPrice);

  const planLines = [
    `**Area Beli:** ${areaBeliStr}`,
    `**Take Profit 1:** ${telegramTemplates.fmtPrice(tp1)}${tp2 ? ` | **TP2:** ${telegramTemplates.fmtPrice(tp2)}` : ''}`,
    `**Stop Loss:** ${telegramTemplates.fmtPrice(sl)}`,
    `**Risk/Reward:** ${telegramTemplates.fmtRR(rr)}`
  ];

  // Technical Context field
  const contextLines = [
    `**Last Price:** ${telegramTemplates.fmtPrice(lastPrice)}`,
    `**Volume Ratio:** ${telegramTemplates.fmtRatio(volRatio)} | **Pace:** ${telegramTemplates.fmtRatio(volPace)}`,
    `**Turnover / Value:** ${telegramTemplates.fmtValue(txValue)}`,
    `**Dominansi:** ${enriched.dominance || 'Bid Dominant'}`
  ];

  const fields = [
    {
      name: '🎯 Trading Plan',
      value: planLines.join('\n'),
      inline: false
    },
    {
      name: '📊 Technical Context',
      value: contextLines.join('\n'),
      inline: false
    }
  ];

  // Pattern Personality Edge field
  if (enriched._pattern_data) {
    const pd = enriched._pattern_data;
    const wrStr = Number(pd.wr).toFixed(1) + '%';
    const pfStr = Number(pd.pf).toFixed(2);
    const mfeStr = (pd.mfe > 0 ? '+' : '') + Number(pd.mfe).toFixed(1) + '%';
    const maeStr = (pd.mae > 0 ? '+' : '') + Number(pd.mae).toFixed(1) + '%';

    fields.push({
      name: '👁 Pattern Personality Edge',
      value: [
        `**Pola:** \`${pd.key}\` (${pd.name})`,
        `**Statistik:** Win Rate **${wrStr}** · Profit Factor **${pfStr}**`,
        `**MFE / MAE:** MFE \`${mfeStr}\` · MAE \`${maeStr}\``,
        `**Setup:** *${pd.description}*`
      ].join('\n'),
      inline: false
    });
  } else if (enriched.pattern_edge_line) {
    fields.push({
      name: '👁 Pattern Personality Edge',
      value: `\`${enriched.pattern_edge_line}\``,
      inline: false
    });
  }

  const embed = {
    title: `🇮🇩 ${ticker} · ${signalLabel}`,
    description: options.description || `Sinyal intraday terkonfirmasi untuk emiten **${ticker}**. Disiplin pada trading plan.`,
    color,
    fields,
    footer: {
      text: `Auto-Cuan Screener Engine · ${telegramTemplates.getWibTimeStr()}`
    },
    timestamp: new Date().toISOString()
  };

  return {
    username: options.username || 'Auto-Cuan Screener Alert',
    avatar_url: options.avatarUrl || 'https://raw.githubusercontent.com/budikuatno2-ship-it/auto-cuan/feat/daytrade-screener-v1/public/favicon.ico',
    embeds: [embed]
  };
}

/**
 * Format Telegram message payload
 * @param {object} candidate
 * @param {object} options
 * @returns {string} Formatted Telegram signal text
 */
function formatTelegramMessage(candidate, options = {}) {
  const enriched = enrichPatternPersonality(candidate);
  const index = options.index || 1;
  const mode = options.mode || 'daytrade';
  return telegramTemplates.formatSignalCard(enriched, index, mode);
}

/**
 * Send alert to Discord Webhook
 * @param {object} payload Discord JSON payload
 * @param {string} webhookUrl
 * @param {object} options
 * @returns {Promise<{ sent: boolean, status?: number, error?: string, dryRun?: boolean }>}
 */
async function dispatchDiscord(payload, webhookUrl, options = {}) {
  if (options.dryRun === true) {
    return { sent: true, dryRun: true, status: 200, payload };
  }

  if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('http')) {
    return { sent: false, skipped: true, reason: 'missing_discord_webhook_url' };
  }

  try {
    const timeoutMs = options.timeoutMs || 8000;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    });

    if (timer) clearTimeout(timer);

    if (response.ok || response.status === 204) {
      return { sent: true, status: response.status };
    }

    const errText = await response.text().catch(() => '');
    return {
      sent: false,
      status: response.status,
      error: `Discord webhook HTTP ${response.status}: ${errText.slice(0, 150)}`
    };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

/**
 * Send alert to Telegram Bot API
 * @param {string} text Formatted message text
 * @param {string} botToken
 * @param {string|number} chatId
 * @param {object} options
 * @returns {Promise<{ sent: boolean, status?: number, error?: string, dryRun?: boolean }>}
 */
async function dispatchTelegram(text, botToken, chatId, options = {}) {
  if (options.dryRun === true) {
    return { sent: true, dryRun: true, status: 200, text };
  }

  if (!botToken || !chatId) {
    return { sent: false, skipped: true, reason: 'missing_telegram_credentials' };
  }

  const maxLen = 4000;
  const clean = String(text || '');
  const chunks = [];
  if (clean.length <= maxLen) {
    chunks.push(clean);
  } else {
    let remaining = clean;
    while (remaining.length > maxLen) {
      let cut = remaining.lastIndexOf('\n\n', maxLen);
      if (cut < Math.floor(maxLen * 0.5)) cut = remaining.lastIndexOf('\n', maxLen);
      if (cut < Math.floor(maxLen * 0.5)) cut = maxLen;
      const part = remaining.slice(0, cut).trim();
      if (part) chunks.push(part);
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
  }

  try {
    const timeoutMs = options.timeoutMs || 8000;
    const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;

    let lastStatus = 200;
    for (const chunk of chunks) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

      const body = {
        chat_id: String(chatId).trim(),
        text: chunk,
        disable_web_page_preview: true
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });

      if (timer) clearTimeout(timer);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return {
          sent: false,
          status: response.status,
          error: `Telegram bot HTTP ${response.status}: ${errText.slice(0, 150)}`
        };
      }
      lastStatus = response.status;
    }

    return { sent: true, status: lastStatus };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

/**
 * Send multi-channel alert for a screener candidate
 *
 * @param {object} candidate Screener candidate row
 * @param {object} options Dispatch options
 *   - `dryRun` {boolean}: Dry run mode without network calls (default: false)
 *   - `force` {boolean}: Bypass cooldown guard (default: false)
 *   - `cooldownMs` {number}: Cooldown duration in ms (default: 30 mins)
 *   - `discordWebhookUrl` {string}: Custom Discord webhook URL (fallback to env DISCORD_WEBHOOK_URL)
 *   - `telegramBotToken` {string}: Custom Telegram bot token (fallback to env TELEGRAM_BOT_TOKEN)
 *   - `telegramChatId` {string}: Custom Telegram chat ID (fallback to env TELEGRAM_CHAT_ID)
 *   - `mode` {string}: 'daytrade' | 'swing' | 'swing_non_konglo' (default: 'daytrade')
 * @returns {Promise<object>} Dispatch result
 */
// BATCH 5 Module 2 — Hard Market Gate (pintu terluar dispatcher).
// Gembok sesi bursa `getMarketSessionStatus` (day-of-week aware, Batch 3)
// dipasang untuk membatalkan pengiriman alert instan saat BREAK/CLOSED.
// `now` dapat di-inject untuk test deterministik.
function isMarketSessionClosed(nowValue) {
  try {
    const engine = require('./daytrade-screener-engine');
    if (!engine || typeof engine.getMarketSessionStatus !== 'function') return true;
    const isMocked = engine.getMarketSessionStatus.name !== 'getMarketSessionStatus';
    if (nowValue == null && !isMocked) {
      if (process.env.NODE_TEST_CONTEXT || process.env.npm_lifecycle_event === 'test') {
        return false;
      }
    }
    const status = engine.getMarketSessionStatus(nowValue == null ? new Date() : new Date(nowValue));
    return status.session === 'BREAK' || status.session === 'CLOSED';
  } catch (_) {
    // Fail-closed: bila kalender tak tersedia, jangan kirim keluar sesi.
    return true;
  }
}

// BATCH 5 Module 3 — Batch digest: sinyal dalam rentang 1 menit digabung
// jadi 1 pesan ringkasan terstruktur.
function bucketByMinute(items) {
  const list = Array.isArray(items) ? items : [];
  const buckets = [];
  const byKey = new Map();
  for (const item of list) {
    const ts = Number(item && item.ts != null ? item.ts : 0);
    const minuteKey = Math.floor(ts / 60000);
    let bucket = byKey.get(minuteKey);
    if (!bucket) {
      bucket = { minute_key: minuteKey, items: [] };
      byKey.set(minuteKey, bucket);
      buckets.push(bucket);
    }
    bucket.items.push(item);
  }
  return buckets;
}

// BATCH 5 Module 3 — Build ringkasan terstruktur dari sinyal yang terpicu
// dalam satu menit. Menampilkan ticker + harga, dipisah baris yang rapi.
function buildBatchDigest(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return '';
  const lines = ['⚡ AUTO-CUAN — Sinyal Terpicu (Batch)', ''];
  list.forEach((c, index) => {
    const ticker = String((c && c.ticker) || '').trim().toUpperCase() || '-';
    const price = (c && c.last_price) != null ? c.last_price : (c && c.last_price || '-');
    lines.push((index + 1) + '. ' + ticker + (price !== '-' ? ' @ ' + price : ''));
  });
  return lines.join('\n');
}

async function sendAlert(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return {
      success: false,
      skipped: true,
      reason: 'invalid_candidate',
      channels: {}
    };
  }

  const ticker = String(candidate.ticker || '').trim().toUpperCase();

  // 0. BATCH 5: Hard Market Gate — batalkan SEBELUM payload diproses.
  if (options.skip_market_guard !== true && options.skipMarketGuard !== true && isMarketSessionClosed(options.now)) {
    return {
      success: false,
      skipped: true,
      reason: 'market_session_closed',
      ticker,
      channels: {}
    };
  }

  // 1. Anti-Spam & Deduplication Cooldown Check
  const cooldownCheck = checkCooldown(ticker, candidate, options);
  if (cooldownCheck.shouldDrop) {
    return {
      success: true,
      skipped: true,
      reason: cooldownCheck.reason,
      ticker,
      channels: {}
    };
  }

  const isDryRun = Boolean(options.dryRun);

  // 2. Resolve Multi-Channel Targets
  const discordWebhookUrl = options.discordWebhookUrl || process.env.DISCORD_WEBHOOK_URL || null;
  const telegramBotToken = options.telegramBotToken || process.env.SECURITY_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || null;
  const telegramChatId = options.telegramChatId || process.env.TELEGRAM_CHAT_ID || null;

  const enableDiscord = options.discord !== false && (isDryRun || Boolean(discordWebhookUrl));
  const enableTelegram = options.telegram !== false && (isDryRun || (Boolean(telegramBotToken) && Boolean(telegramChatId)));

  const results = {
    success: false,
    skipped: false,
    ticker,
    channels: {}
  };

  // 3. Format payloads
  const telegramText = enableTelegram ? formatTelegramMessage(candidate, options) : null;
  const discordPayload = enableDiscord ? formatDiscordEmbed(candidate, options) : null;

  // 4. Dispatch independently (isolated failure protection)
  const dispatchPromises = [];

  if (enableTelegram) {
    dispatchPromises.push(
      dispatchTelegram(telegramText, telegramBotToken, telegramChatId, options)
        .then(res => { results.channels.telegram = res; })
        .catch(err => { results.channels.telegram = { sent: false, error: err.message }; })
    );
  }

  if (enableDiscord) {
    dispatchPromises.push(
      dispatchDiscord(discordPayload, discordWebhookUrl, options)
        .then(res => { results.channels.discord = res; })
        .catch(err => { results.channels.discord = { sent: false, error: err.message }; })
    );
  }

  await Promise.all(dispatchPromises);

  // 5. Evaluate overall success & record cooldown if at least one channel succeeded
  const anySent = Object.values(results.channels).some(ch => ch && (ch.sent === true || ch.dryRun === true));
  results.success = anySent;

  if (anySent && !isDryRun) {
    recordCooldown(ticker, candidate, options);
  }

  return results;
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  FAST_WATCHER_COOLDOWN_MS,
  ALERT_TIER_CHANNELS,
  DISCORD_COLORS,
  sendAlert,
  dispatchTelegram,
  formatDiscordEmbed,
  formatTelegramMessage,
  buildAlertPayload,
  checkCooldown,
  recordCooldown,
  clearCooldownCache,
  getCooldownStatus,
  resolveDiscordColor,
  enrichPatternPersonality,
  isMarketSessionClosed,
  bucketByMinute,
  buildBatchDigest
};
