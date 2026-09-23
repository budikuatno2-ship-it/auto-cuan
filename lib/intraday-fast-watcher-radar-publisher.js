'use strict';

const path = require('node:path');
const telegramNotifier = require('./telegram-notifier');
const confirmedPublisher = require('./intraday-fast-watcher-publisher');
const marketHoursGuard = require('./market-hours-guard');

const DEFAULT_RADAR_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-published', 'radar');
const MAX_RADAR_PUBLISH = 3;
const MIN_RADAR_WATCH_SCORE = 55;

// Jumlah konfirmasi Fast Watcher yang dianggap "lengkap" untuk publikasi
// Telegram. Pool menyimpan progres di `ready_streak`; kartu sinyal menampilkan
// progres sebagai N/2, jadi 2 konfirmasi = konfirmasi penuh.
const REQUIRED_RADAR_CONFIRMATIONS = 2;

// Status yang SUDAH terkonfirmasi penuh (bukan lagi pantauan mentah).
// Hanya status inilah yang boleh dipublikasikan ke channel Telegram.
const CONFIRMED_PUBLISH_STATUSES = new Set([
  'READY_CONFIRMED',
  'A_PLUS_SETUP',
  'TRADE_CANDIDATE',
  'READY_BREAKOUT'
]);

// Status pra-konfirmasi: EARLY WATCH (0/2) dan RADAR PRIORITAS (1/2).
// Ini yang sebelumnya membanjiri channel dan sekarang dilarang.
const PRECONFIRMATION_RADAR_STATUSES = new Set([
  'READY_PENDING',
  'PENDING_VELOCITY',
  'WAIT_PULLBACK',
  'WATCHING',
  'SPIKE_RADAR'
]);

// Override darurat (default OFF). Hanya untuk observability terkontrol; bukan
// jalur normal produksi. Tanpa flag ini, radar pra-konfirmasi TIDAK dikirim.
const PRECONFIRMATION_OVERRIDE_ENV = 'FAST_WATCHER_RADAR_ALLOW_PRECONFIRMATION_TELEGRAM';

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

/**
 * Menghitung progres konfirmasi Fast Watcher.
 *
 * Menerima DUA bentuk input, supaya helper yang sama bisa dipakai di kedua
 * sisi pipeline tanpa cutoff baru:
 *   - pool item (pool.js): `ready_streak`
 *   - radar plan (planFrom()): `confirmation_count`
 *
 * @returns {number|null} null bila tidak ada bukti progres sama sekali
 */
function confirmationCountOf(item) {
  const streak = numberOrNull(item && item.ready_streak);
  if (streak != null) return Math.max(0, Math.round(streak));
  const count = numberOrNull(item && item.confirmation_count);
  return count == null ? null : Math.max(0, Math.round(count));
}

/**
 * True bila item sudah mencapai konfirmasi penuh (2/2) sehingga boleh
 * dipublikasikan sebagai sinyal Day Trade mandiri ke Telegram.
 *
 * Bukti yang diterima (salah satu cukup):
 *   - status pool terkonfirmasi (READY_CONFIRMED / A_PLUS_SETUP /
 *     TRADE_CANDIDATE / READY_BREAKOUT), atau
 *   - flag `is_fully_confirmed` yang sudah dihitung dari pool item, atau
 *   - progres konfirmasi >= 2 (2/2 Terkonfirmasi).
 */
function isFullyConfirmedItem(item) {
  if (!item) return false;
  if (item.is_fully_confirmed === true) return true;
  const internalStatus = safeText(item.status, 32).toUpperCase();
  const sourceStatus = safeText(item.source_status, 32).toUpperCase();
  if (CONFIRMED_PUBLISH_STATUSES.has(internalStatus) || CONFIRMED_PUBLISH_STATUSES.has(sourceStatus)) return true;
  const confirmations = confirmationCountOf(item);
  return confirmations != null && confirmations >= REQUIRED_RADAR_CONFIRMATIONS;
}

/**
 * True bila item masih pra-konfirmasi: EARLY WATCH (0/2) atau
 * RADAR PRIORITAS (1/2). Item seperti ini dilarang dikirim ke Telegram.
 */
function isPreConfirmationItem(item) {
  if (isFullyConfirmedItem(item)) return false;
  const internalStatus = safeText(item && item.status, 32).toUpperCase();
  if (PRECONFIRMATION_RADAR_STATUSES.has(internalStatus)) return true;
  const confirmations = confirmationCountOf(item);
  return confirmations == null || confirmations < REQUIRED_RADAR_CONFIRMATIONS;
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
    ? 'SPIKE TERDETEKSI — JANGAN CHASE'
    : (internalStatus === 'READY_PENDING' || internalStatus === 'PENDING_VELOCITY')
      ? 'RADAR PRIORITAS — 1/2 KONFIRMASI'
      : (sourceStatus === 'WAIT_PULLBACK' || internalStatus === 'WAIT_PULLBACK')
        ? 'RADAR PULLBACK — TUNGGU AREA'
        : 'RADAR AKTIF — PANTAU';
  const reasons = Array.isArray(item && item.last_reasons) ? item.last_reasons.map(reason => String(reason)) : [];
  const confirmations = confirmationCountOf(item);
  return {
    ticker: safeText(ticker, 5).toUpperCase(),
    status,
    internal_status: internalStatus,
    source_status: sourceStatus,
    confirmation_count: confirmations,
    is_fully_confirmed: isFullyConfirmedItem(item),
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
  if (!plan.ticker || ![
    'RADAR AKTIF — PANTAU',
    'RADAR PRIORITAS — 1/2 KONFIRMASI',
    'RADAR PULLBACK — TUNGGU AREA',
    'SPIKE TERDETEKSI — JANGAN CHASE'
  ].includes(plan.status)) return false;
  if (!['READY_PENDING', 'PENDING_VELOCITY', 'WAIT_PULLBACK', 'WATCHING', 'SPIKE_RADAR'].includes(plan.internal_status)) return false;
  // Temuan #7: score floor berlaku ketat untuk semua status non-SPIKE.
  // Sebelumnya READY_PENDING/PENDING_VELOCITY/WAIT_PULLBACK dikecualikan,
  // sehingga skor 35 lolos broadcast.
  if (plan.internal_status !== 'SPIKE_RADAR' && (plan.watch_score == null || plan.watch_score < MIN_RADAR_WATCH_SCORE)) return false;
  // Temuan #7: R/R di bawah 1.0x jangan broadcast (mis. PGAS 0.86x).
  // Missing RR tidak blocking (no evidence).
  if (plan.risk_reward != null && plan.risk_reward < 1.0) return false;
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
  if (item.internal_status === 'SPIKE_RADAR') {
    return 'Momentum sudah bergerak. Bukan sinyal entry baru; jangan mengejar harga.';
  }

  if (item.internal_status === 'READY_PENDING') {
    return 'Peluang sedang menguat, tetapi baru 1 dari 2 konfirmasi. Tunggu snapshot berikutnya.';
  }

  if (item.source_status === 'WAIT_PULLBACK') {
    return `Setup masih menarik. Tunggu pullback ke area ${formatPrice(item.entry_low)}–${formatPrice(item.entry_high)}.`;
  }

  if (item.current_price > item.entry_high) {
    return `Peluang ada, tetapi harga di atas area ${formatPrice(item.entry_low)}–${formatPrice(item.entry_high)}. Jangan chase.`;
  }

  return `Peluang ada. Pantau reaksi harga di area ${formatPrice(item.entry_low)}–${formatPrice(item.entry_high)}.`;
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
    const confirmText = item.confirmation_count == null ? '' : ` | Konfirmasi ${item.confirmation_count}/${REQUIRED_RADAR_CONFIRMATIONS}`;
    lines.push(
      `${index + 1}. 🇮🇩 ${item.ticker} — ${item.status}`,
      `Harga ${formatPrice(item.current_price)} | Entry ${formatPrice(item.entry_low)}–${formatPrice(item.entry_high)}`,
      `TP ${tpText} | SL ${formatPrice(item.stop_loss)}${rrText}`,
      actionText(item),
      `Score ${formatScore(item.watch_score)} | Vol ${formatRatio(item.relative_volume)}${confirmText}`,
      ''
    );
  });
  lines.push(
    `Update: ${sampleDate} ${scheduledTime} WIB`,
    'Radar dapat bergerak lebih dulu, tetapi belum setara Signal Terkonfirmasi. Sesuaikan risiko dan jangan chase.'
  );
  return lines.join('\n');
}

function radarKey(item) {
  return [
    item.internal_status || item.status,
    item.source_status || '-',
    item.entry_low,
    item.entry_high,
    item.tp1,
    item.tp2 == null ? '-' : item.tp2,
    item.stop_loss
  ].join('|');
}

function getMarketSession(time) {
  if (!time) return 'SESSION_1';
  const parts = String(time).split(':').map(Number);
  const total = (parts[0] || 0) * 60 + (parts[1] || 0);
  return total >= 13 * 60 ? 'SESSION_2' : 'SESSION_1';
}

function shouldSend(item, prior, currentSession) {
  if (!prior) return true;
  const priorSession = prior.session || getMarketSession(prior.scheduled_time);
  if (currentSession && priorSession && currentSession !== priorSession) {
    return true;
  }
  if (prior.key !== radarKey(item)) return true;
  const previousScore = numberOrNull(prior.watch_score);
  return previousScore != null && item.watch_score != null && item.watch_score >= previousScore + 8;
}

/**
 * Gerbang waktu radar Day Trade (AFTERNOON_EXIT rule).
 *
 * `scheduledTime` (HH:MM WIB) adalah waktu tick terjadwal dan menjadi acuan
 * utama; bila tidak tersedia, jam WIB sekarang dipakai. Dua kondisi memblokir
 * pengiriman radar BARU:
 *   1. Di luar sesi bursa (BREAK/CLOSED/PRE/weekend).
 *   2. Sudah lewat 14:30 WIB — sisa sesi terlalu pendek untuk eksekusi, dan
 *      radar 15:37 WIB menjelang closing hanya menghasilkan noise.
 *
 * @returns {{ allowed: boolean, reason: string, session: string, wib_time: string, cutoff_passed: boolean }}
 */
function evaluateRadarTimeWindow(scheduledTime) {
  const raw = String(scheduledTime == null ? '' : scheduledTime).trim();
  const hasClock = /^\d{1,2}:\d{2}/.test(raw);
  if (hasClock) {
    const parts = raw.split(':').map(Number);
    const total = (parts[0] || 0) * 60 + (parts[1] || 0);
    const session = getMarketSession(raw);
    if (total > marketHoursGuard.DAYTRADE_RADAR_CUTOFF_MINUTES) {
      return {
        allowed: false,
        reason: 'after_1430_wib_cutoff',
        session,
        wib_time: raw.slice(0, 5),
        cutoff_passed: true
      };
    }
    return { allowed: true, reason: 'within_radar_window', session, wib_time: raw.slice(0, 5), cutoff_passed: false };
  }
  const guard = marketHoursGuard.evaluateDayTradeRadarWindow();
  return {
    allowed: guard.allowed,
    reason: guard.allowed ? 'within_radar_window' : guard.reason,
    session: guard.session,
    wib_time: guard.wib_time,
    cutoff_passed: guard.reason === 'after_1430_wib_cutoff'
  };
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
  const currentSession = getMarketSession(scheduledTime);
  const candidates = Array.isArray(opts.candidates)
    ? opts.candidates.slice(0, MAX_RADAR_PUBLISH)
    : selectRadarCandidates(opts.state, MAX_RADAR_PUBLISH);
  if (!candidates.length) {
    return { attempted: false, telegram_attempted: false, telegram_sent: 0, radar_items_sent: 0, reason: 'nothing_radar_worthy' };
  }

  const radarDir = opts.radarDir || DEFAULT_RADAR_DIR;
  const ledgerFile = path.join(radarDir, `${sampleDate}.json`);
  const ledger = await confirmedPublisher.readJson(ledgerFile, { date: sampleDate, tickers: {} });

  // === GERBANG WAKTU: hard cut-off 14:30 WIB (AFTERNOON_EXIT rule) ===
  // Tidak ada radar BARU setelah 14:30 WIB, termasuk 15:37 WIB menjelang
  // closing. Ledger tetap ditulis supaya observability web/riset utuh.
  const timeWindow = evaluateRadarTimeWindow(scheduledTime);
  if (!timeWindow.allowed) {
    const blockedAt = new Date().toISOString();
    for (const item of candidates) {
      ledger.tickers[item.ticker] = Object.assign({}, ledger.tickers[item.ticker], {
        key: radarKey(item),
        status: item.status,
        watch_score: item.watch_score,
        scheduled_time: scheduledTime,
        session: currentSession,
        telegram_suppressed_at: blockedAt,
        telegram_suppressed_reason: timeWindow.reason
      });
    }
    await confirmedPublisher.writeJsonAtomic(ledgerFile, ledger);
    return {
      attempted: false,
      telegram_attempted: false,
      telegram_sent: 0,
      radar_items_sent: 0,
      reason: timeWindow.reason,
      session: timeWindow.session,
      wib_time: timeWindow.wib_time,
      radar_candidates_suppressed: candidates.map(item => item.ticker),
      ledger_file: ledgerFile
    };
  }

  // === GERBANG KONFIRMASI: hanya sinyal TERKONFIRMASI PENUH yang boleh
  // dikirim ke channel Telegram. Radar pra-konfirmasi (EARLY WATCH 0/2 dan
  // RADAR PRIORITAS 1/2) berhenti membanjiri channel; datanya tetap dicatat
  // di ledger radar untuk observability, tanpa kiriman Telegram.
  const allowPreConfirmation = String(env[PRECONFIRMATION_OVERRIDE_ENV] || '') === '1';
  const preConfirmationBlocked = [];
  const sendableCandidates = candidates.filter(item => {
    if (allowPreConfirmation || !isPreConfirmationItem(item)) return true;
    preConfirmationBlocked.push({
      ticker: item.ticker,
      status: item.status,
      confirmation_count: item.confirmation_count
    });
    return false;
  });

  const sendable = sendableCandidates
    .filter(item => shouldSend(item, ledger.tickers[item.ticker], currentSession))
    .slice(0, MAX_RADAR_PUBLISH);

  if (!sendable.length) {
    const reason = preConfirmationBlocked.length && !sendableCandidates.length
      ? 'preconfirmation_radar_blocked'
      : 'radar_unchanged';
    if (preConfirmationBlocked.length) {
      const blockedAt = new Date().toISOString();
      for (const item of candidates) {
        ledger.tickers[item.ticker] = Object.assign({}, ledger.tickers[item.ticker], {
          key: radarKey(item),
          status: item.status,
          watch_score: item.watch_score,
          scheduled_time: scheduledTime,
          session: currentSession,
          telegram_suppressed_at: blockedAt,
          telegram_suppressed_reason: 'preconfirmation_radar_blocked'
        });
      }
      await confirmedPublisher.writeJsonAtomic(ledgerFile, ledger);
    }
    return {
      attempted: false,
      telegram_attempted: false,
      telegram_sent: 0,
      radar_items_sent: 0,
      reason,
      preconfirmation_blocked: preConfirmationBlocked.length ? preConfirmationBlocked : undefined,
      ledger_file: ledgerFile
    };
  }

  const send = opts.notifyFn || telegramNotifier.sendTelegramMessage;
  const chatId = env.FAST_WATCHER_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;
  let result;
  try {
    result = await send(buildRadarTelegramMessage(sendable, sampleDate, scheduledTime), {
      chat_id: chatId,
      disable_web_page_preview: true,
      timeout_ms: 8000,
      ticker: sendable[0] ? sendable[0].ticker : undefined,
      alert_key: sendable[0] ? ('RADAR:' + sendable[0].ticker) : undefined,
      status: sendable[0] ? sendable[0].internal_status : undefined
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
        scheduled_time: scheduledTime,
        session: currentSession
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
    preconfirmation_blocked: preConfirmationBlocked.length ? preConfirmationBlocked : undefined,
    ledger_file: ledgerFile
  };
}

module.exports = {
  DEFAULT_RADAR_DIR,
  MAX_RADAR_PUBLISH,
  MIN_RADAR_WATCH_SCORE,
  REQUIRED_RADAR_CONFIRMATIONS,
  CONFIRMED_PUBLISH_STATUSES,
  PRECONFIRMATION_RADAR_STATUSES,
  PRECONFIRMATION_OVERRIDE_ENV,
  ALWAYS_BLOCKING_REASONS,
  CHASE_REASONS,
  confirmationCountOf,
  isFullyConfirmedItem,
  isPreConfirmationItem,
  planFrom,
  validRadarPlan,
  selectRadarCandidates,
  buildRadarTelegramMessage,
  evaluateRadarTimeWindow,
  publishRadar,
  radarKey,
  shouldSend,
  getMarketSession
};
