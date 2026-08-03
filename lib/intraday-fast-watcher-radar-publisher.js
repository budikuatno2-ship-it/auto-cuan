'use strict';

const path = require('node:path');
const telegramNotifier = require('./telegram-notifier');
const confirmedPublisher = require('./intraday-fast-watcher-publisher');

const DEFAULT_RADAR_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-published', 'radar');
const MAX_RADAR_PUBLISH = 3;
const MIN_RADAR_WATCH_SCORE = 55;
const ALWAYS_BLOCKING_REASONS = new Set([
  'engine_hard_reject',
  'tp1_already_reached',
  'invalid_tp1',
  'stale',
  'stale_data',
  'stop_touched',
  'stop_loss_touched',
  'invalid_current_price',
  'invalid_entry_zone',
  'invalid_levels',
  'missing_stop_loss',
  'invalid_stop_loss'
]);
const CHASE_REASONS = new Set([
  'adaptive_advance_chase',
  'above_adaptive_entry_tolerance'
]);

function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength || 180);
}

function formatPrice(value) {
  const number = numberOrNull(value);
  return number == null
    ? '-'
    : `Rp${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(number)}`;
}

function formatScore(value) {
  const number = numberOrNull(value);
  return number == null ? '-' : String(Math.round(number));
}

function formatRatio(value) {
  const number = numberOrNull(value);
  return number == null ? '-' : `${number.toFixed(2).replace('.', ',')}x`;
}

function planFrom(ticker, item) {
  const observation = item && item.last_observation || {};
  const metrics = item && item.last_metrics || {};
  const currentPrice = numberOrNull(observation.current_price ?? observation.last_price ?? observation.price ?? metrics.current_price);
  const entryLow = numberOrNull(observation.entry_low ?? observation.buy_low ?? metrics.entry_low);
  const entryHigh = numberOrNull(observation.entry_high ?? observation.buy_high ?? metrics.entry_high);
  const tp1 = numberOrNull(observation.tp1 ?? observation.target_1 ?? metrics.tp1);
  const tp2 = numberOrNull(observation.tp2 ?? observation.target_2 ?? metrics.tp2);
  const stopLoss = numberOrNull(observation.stop_loss ?? observation.sl ?? metrics.stop_loss);
  const riskReward = numberOrNull(observation.risk_reward ?? observation.rr ?? metrics.risk_reward);
  const relativeVolume = numberOrNull(
    observation.intraday_volume_pace_ratio
    ?? metrics.intraday_volume_pace_ratio
    ?? observation.effective_volume_ratio
    ?? metrics.relative_volume
    ?? observation.relative_volume
    ?? observation.volume_ratio_20d
  );
  const watchScore = numberOrNull(item && item.last_watch_score);
  const publishScore = numberOrNull(item && item.last_publish_score);
  const internalStatus = safeText(item && item.status, 32).toUpperCase();
  const sourceStatus = safeText(item && item.source_status, 32).toUpperCase();
  const status = internalStatus === 'SPIKE_RADAR'
    ? 'SPIKE TERDETEKSI'
    : internalStatus === 'READY_PENDING'
      ? 'KONFIRMASI 1/2'
      : sourceStatus === 'WAIT_PULLBACK' ? 'WAIT_PULLBACK' : 'WATCHING';
  const reasons = Array.isArray(item && item.last_reasons) ? item.last_reasons.map(reason => String(reason)) : [];
  return {
    ticker: safeText(ticker, 5).toUpperCase(),
    status,
    internal_status: internalStatus,
    source_status: sourceStatus,
    current_price: currentPrice,
    entry_low: entryLow,
    entry_high: entryHigh,
    tp1,
    tp2,
    stop_loss: stopLoss,
    risk_reward: riskReward,
    relative_volume: relativeVolume,
    volume_signal_source: safeText(metrics.volume_signal_source || observation.volume_signal_source, 40) || null,
    watch_score: watchScore,
    publish_score: publishScore,
    reasons
  };
}

function validRadarPlan(plan) {
  if (!plan.ticker || !['WATCHING', 'KONFIRMASI 1/2', 'WAIT_PULLBACK', 'SPIKE TERDETEKSI'].includes(plan.status)) return false;
  if (!['READY_PENDING', 'WATCHING', 'SPIKE_RADAR'].includes(plan.internal_status)) return false;
  if (plan.internal_status !== 'READY_PENDING' && (plan.watch_score == null || plan.watch_score < MIN_RADAR_WATCH_SCORE)) return false;
  if ([plan.current_price, plan.entry_low, plan.entry_high, plan.tp1, plan.stop_loss].some(value => value == null)) return false;
  if (!(plan.entry_low > 0 && plan.entry_high >= plan.entry_low && plan.stop_loss < plan.entry_low && plan.tp1 > plan.entry_high)) return false;
  if (plan.current_price <= plan.stop_loss || plan.current_price >= plan.tp1) return false;
  if (plan.reasons.some(reason => ALWAYS_BLOCKING_REASONS.has(reason))) return false;

  if (plan.internal_status === 'SPIKE_RADAR') {
    if (!plan.reasons.some(reason => CHASE_REASONS.has(reason))) return false;
    if (!plan.reasons.includes('spike_detected_informational_only')) return false;
    return true;
  }

  if (plan.reasons.some(reason => CHASE_REASONS.has(reason))) return false;
  return true;
}

function selectRadarCandidates(state, limit) {
  const maximum = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_RADAR_PUBLISH) : MAX_RADAR_PUBLISH;
  const rows = Object.entries(state && state.tickers || {})
    .filter(([, item]) => item && item.active === true)
    .map(([ticker, item]) => planFrom(ticker, item))
    .filter(validRadarPlan)
    .sort((a, b) => {
      const aPending = a.internal_status === 'READY_PENDING' ? 2 : (a.internal_status === 'SPIKE_RADAR' ? 1 : 0);
      const bPending = b.internal_status === 'READY_PENDING' ? 2 : (b.internal_status === 'SPIKE_RADAR' ? 1 : 0);
      return bPending - aPending
        || (b.watch_score || 0) - (a.watch_score || 0)
        || (b.publish_score || 0) - (a.publish_score || 0)
        || a.ticker.localeCompare(b.ticker);
    });
  return rows.slice(0, maximum);
}

function actionText(item) {
  if (item.internal_status === 'SPIKE_RADAR') return 'Spike terdeteksi — bukan sinyal beli. Jangan chase.';
  if (item.internal_status === 'READY_PENDING') return 'Pantau sambil menunggu konfirmasi kedua.';
  if (item.current_price > item.entry_high) {
    return `Pantau area ${formatPrice(item.entry_low)}–${formatPrice(item.entry_high)}. Jangan beli kalau harganya sudah terlalu tinggi.`;
  }
  return `Pantau reaksi harga di area ${formatPrice(item.entry_low)}–${formatPrice(item.entry_high)}.`;
}

function buildRadarTelegramMessage(items, sampleDate, scheduledTime) {
  const candidates = Array.isArray(items) ? items.slice(0, MAX_RADAR_PUBLISH) : [];
  const lines = [
    '📡 AUTO-CUAN DAY TRADE RADAR',
    '⚠️ Pantauan, belum sinyal beli',
    ''
  ];
  candidates.forEach((item, index) => {
    const tpText = item.tp2 != null ? `${formatPrice(item.tp1)} / ${formatPrice(item.tp2)}` : formatPrice(item.tp1);
    const rrText = item.risk_reward == null ? '' : ` | R/R ${formatRatio(item.risk_reward)}`;
    lines.push(
      `${index + 1}. 🇮🇩 ${item.ticker} — ${item.status}`,
      `Harga ${formatPrice(item.current_price)} | Entry ${formatPrice(item.entry_low)}–${formatPrice(item.entry_high)}`,
      `TP ${tpText} | SL ${formatPrice(item.stop_loss)}${rrText}`,
      actionText(item),
      `Score ${formatScore(item.watch_score)} | Vol ${formatRatio(item.relative_volume)}`,
      ''
    );
  });
  lines.push(
    `Update: ${sampleDate} ${scheduledTime} WIB`,
    'Entry hanya setelah konfirmasi momentum.'
  );
  return lines.join('\n');
}

function radarKey(item) {
  return [
    item.status,
    item.entry_low,
    item.entry_high,
    item.tp1,
    item.tp2 == null ? '-' : item.tp2,
    item.stop_loss
  ].join('|');
}

function shouldSend(item, prior) {
  if (!prior) return true;
  if (prior.key !== radarKey(item)) return true;
  const previousScore = numberOrNull(prior.watch_score);
  return previousScore != null && item.watch_score != null && item.watch_score >= previousScore + 8;
}

async function publishRadar(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const liveEnabled = String(env.FAST_WATCHER_LIVE_ENABLED || '') === '1';
  const publishEnabled = String(env.FAST_WATCHER_PUBLISH_ENABLED || '') === '1';
  const telegramEnabled = String(env.FAST_WATCHER_TELEGRAM_ENABLED || '') === '1';
  const radarEnabled = String(env.FAST_WATCHER_RADAR_TELEGRAM_ENABLED || '') === '1';
  if (!liveEnabled || !publishEnabled || !telegramEnabled || !radarEnabled) {
    const reason = !liveEnabled
      ? 'live_kill_switch_off'
      : !publishEnabled
        ? 'publish_kill_switch_off'
        : !telegramEnabled
          ? 'telegram_kill_switch_off'
          : 'radar_kill_switch_off';
    return { attempted: false, telegram_attempted: false, telegram_sent: 0, radar_items_sent: 0, reason };
  }

  const sampleDate = opts.sampleDate;
  const scheduledTime = opts.scheduledTime;
  const candidates = Array.isArray(opts.candidates)
    ? opts.candidates.slice(0, MAX_RADAR_PUBLISH)
    : selectRadarCandidates(opts.state, MAX_RADAR_PUBLISH);
  if (!candidates.length) {
    return { attempted: false, telegram_attempted: false, telegram_sent: 0, radar_items_sent: 0, reason: 'nothing_radar_worthy' };
  }

  const radarDir = opts.radarDir || DEFAULT_RADAR_DIR;
  const ledgerFile = path.join(radarDir, `${sampleDate}.json`);
  const ledger = await confirmedPublisher.readJson(ledgerFile, { date: sampleDate, tickers: {} });
  const sendable = candidates.filter(item => shouldSend(item, ledger.tickers[item.ticker])).slice(0, MAX_RADAR_PUBLISH);
  if (!sendable.length) {
    return { attempted: false, telegram_attempted: false, telegram_sent: 0, radar_items_sent: 0, reason: 'radar_unchanged', ledger_file: ledgerFile };
  }

  const send = opts.notifyFn || telegramNotifier.sendTelegramMessage;
  const chatId = env.FAST_WATCHER_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;
  let result;
  try {
    result = await send(buildRadarTelegramMessage(sendable, sampleDate, scheduledTime), {
      chat_id: chatId,
      disable_web_page_preview: true,
      timeout_ms: 5000
    });
  } catch (_) {
    result = { sent: false, reason: 'telegram_exception' };
  }

  if (result && result.sent) {
    const sentAt = new Date().toISOString();
    for (const item of sendable) {
      ledger.tickers[item.ticker] = {
        key: radarKey(item),
        status: item.status,
        watch_score: item.watch_score,
        sent_at: sentAt,
        scheduled_time: scheduledTime
      };
    }
    await confirmedPublisher.writeJsonAtomic(ledgerFile, ledger);
  }

  return {
    attempted: true,
    telegram_attempted: true,
    telegram_sent: result && result.sent ? 1 : 0,
    radar_items_sent: result && result.sent ? sendable.length : 0,
    reason: result && result.sent ? 'radar_sent' : safeText(result && result.reason || 'telegram_failed', 80),
    ledger_file: ledgerFile
  };
}

module.exports = {
  DEFAULT_RADAR_DIR,
  MAX_RADAR_PUBLISH,
  MIN_RADAR_WATCH_SCORE,
  ALWAYS_BLOCKING_REASONS,
  CHASE_REASONS,
  planFrom,
  validRadarPlan,
  selectRadarCandidates,
  buildRadarTelegramMessage,
  publishRadar,
  radarKey,
  shouldSend
};
