'use strict';

/**
 * Telegram Templates v2 — Premium Deterministic Signal Card Format
 *
 * Clean, structured templates for all signal types:
 *   - Day Trade Signal
 *   - Swing Konglo Signal
 *   - Swing Non-Konglo Signal
 *   - Daily Top 5 / Watchlist
 *   - Monitor Hit Notifications (Entry/TP1/TP2/SL)
 *
 * All text/levels/data come from system logic. No AI dependency.
 * AI narration (if enabled) is appended separately by caller.
 */

// ============================================================
// FORMATTING HELPERS
// ============================================================

function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string') {
    var n = Number(v.trim().replace(/,/g, '.'));
    return isFinite(n) ? n : null;
  }
  return null;
}

function fmtPrice(v) {
  var n = toNum(v);
  if (n == null || n <= 0) return '-';
  return 'Rp' + n.toLocaleString('id-ID');
}

function fmtRR(v) {
  var n = toNum(v);
  return n != null ? n.toFixed(1) + 'x' : '-';
}

function fmtPct(v) {
  var n = toNum(v);
  if (n == null) return '-';
  return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
}

function fmtRatio(v) {
  var n = toNum(v);
  return n != null ? n.toFixed(1) + 'x' : '-';
}

function fmtValue(v) {
  var n = toNum(v);
  if (n == null || n <= 0) return '-';
  if (n >= 1e12) return 'Rp' + (n / 1e12).toFixed(1).replace('.', ',') + ' T';
  if (n >= 1e9) return 'Rp' + (n / 1e9).toFixed(1).replace('.', ',') + ' M';
  if (n >= 1e6) return 'Rp' + (n / 1e6).toFixed(0) + ' jt';
  return 'Rp' + Math.round(n).toLocaleString('id-ID');
}

function safe(value, fallback) {
  if (value == null || value === '' || value === 'undefined' || value === 'null') return fallback || '-';
  var s = String(value).replace(/[\r\n\t]+/g, ' ').replace(/<[^>]*>/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!s || s === 'undefined' || s === 'null' || s === '[object Object]') return fallback || '-';
  return s;
}

function shortenStatus(status) {
  if (!status) return '-';
  return String(status).replace(/_/g, ' ').replace(/^READY BREAKOUT$/, 'READY').replace(/^PRE SPIKE WATCH$/, 'PRE-SPIKE').replace(/^EARLY RADAR$/, 'EARLY RADAR').replace(/^MOMENTUM CONTINUATION$/, 'MOMENTUM').replace(/^WAIT PULLBACK$/, 'WAIT PULLBACK').replace(/^RECLAIM CANDIDATE$/, 'RECLAIM').replace(/^A PLUS SETUP$/, 'A+ SETUP').replace(/^TRADE CANDIDATE$/, 'TRADE CANDIDATE');
}

function classifySignalLabel(r) {
  var status = safe(r.status || r.final_status, '').toUpperCase().replace(/_/g, ' ');
  if (status.indexOf('A PLUS') >= 0 || status.indexOf('TRADE CANDIDATE') >= 0) return 'READY';
  if (status.indexOf('READY') >= 0) return 'READY';
  if (status.indexOf('EARLY RADAR') >= 0 || status.indexOf('PRE SPIKE') >= 0) return 'EARLY RADAR';
  if (status.indexOf('SWING READY') >= 0) return 'READY';
  if (status.indexOf('WATCHLIST') >= 0) return 'WATCHLIST';
  if (status.indexOf('WAIT PULLBACK') >= 0) return 'WATCHLIST';
  return 'WATCHLIST';
}

function getRiskShort(r) {
  var risk = safe(r.risk_label_v2 || r.risk_label || r.verified_risk_label, '');
  if (!risk || risk === '-') return 'Medium';
  if (/very\s*high/i.test(risk)) return 'Very High';
  if (/high/i.test(risk)) return 'High';
  if (/low/i.test(risk)) return 'Low';
  return 'Medium';
}

function getLiqLabel(r) {
  var liq = safe(r.liquidity_label, '');
  if (/liquid/i.test(liq) && !/tipis|lemah/i.test(liq)) return 'Liquid';
  if (/tipis|lemah/i.test(liq)) return 'Tipis';
  if (/sedang/i.test(liq)) return 'Sedang';
  return 'Liquid';
}

function getTrendShort(r) {
  var parts = [];
  var tf1 = safe(r.tf_1d_context || r.daily_candle_context, '');
  var tf5 = safe(r.tf_5d_context || r.weekly_candle_context, '');
  if (tf1 && tf1 !== '-') parts.push('1D ' + tf1.replace(/\s*\(.*?\)\s*/g, ''));
  if (tf5 && tf5 !== '-') parts.push('5D ' + tf5.replace(/\s*\(.*?\)\s*/g, ''));
  return parts.length > 0 ? parts.join(' \u00B7 ') : '-';
}

function getBreakoutShort(r) {
  var label = safe(r.breakout_confirmation_label, '');
  if (!label || label === '-') return null;
  var res = toNum(r.resistance);
  if (res && res > 0) return 'Needs close > ' + fmtPrice(res);
  return label.replace(/^Breakout\s*/i, '');
}

function getPatternShort(r) {
  var parts = [];
  var candle = safe(r.candle_pattern || r.candle_bias, '');
  if (candle && candle !== '-') parts.push(candle);
  var pattern = safe(r.pattern_label, '');
  if (pattern && pattern !== '-' && pattern !== 'No Clear Pattern' && pattern !== 'Insufficient Data') parts.push(pattern);
  return parts.length > 0 ? parts.join(' \u00B7 ') : null;
}

function getPlanNote(r) {
  var notes = [];
  var entryNote = safe(r.entry_status_note || r.entry_safety_note, '');
  if (entryNote && entryNote !== '-' && entryNote.length > 5) {
    notes.push(entryNote.charAt(0).toLowerCase() + entryNote.slice(1));
  }
  var verdict = safe(r.telegram_verdict || r.signal_verdict || r.verdict, '');
  if (verdict && verdict !== '-' && verdict.length > 5 && notes.indexOf(verdict) < 0) {
    notes.push(verdict);
  }
  if (notes.length === 0) return 'konfirmasi manual wajib sebelum entry.';
  return notes[0].length > 120 ? notes[0].slice(0, 119) + '\u2026' : notes[0];
}

function getWibTimeStr() {
  var now = new Date();
  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);
  var wib = new Date(wibMs);
  var months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
  return wib.getUTCDate() + ' ' + months[wib.getUTCMonth()] + ' ' + wib.getUTCFullYear() + ', ' + wib.toISOString().slice(11, 16) + ' WIB';
}

// ============================================================
// PREMIUM SIGNAL CARD — Day Trade / Swing / Non-Konglo
// ============================================================

/**
 * Format a single candidate as a premium signal card block.
 * @param {object} r - Enriched candidate row
 * @param {number} idx - 1-based index
 * @param {string} mode - 'daytrade' | 'swing' | 'swing_non_konglo'
 * @returns {string} Formatted text block
 */
function formatSignalCard(r, idx, mode) {
  var entryLow = toNum(r.entry_low);
  var entryHigh = toNum(r.entry_high);
  var e1 = Math.max(entryLow || 0, entryHigh || 0);
  var e2 = Math.min(entryLow || 0, entryHigh || 0);
  if (e2 <= 0) e2 = e1;
  var tp1 = toNum(r.tp1 || r.tp1n);
  var tp2 = toNum(r.tp2 || r.tp2n);
  var sl = toNum(r.stop_loss || r.sl);
  var last = toNum(r.last_price || r.lastn);
  var vol = toNum(r.volume_ratio_20d || r.volume_ratio_avg20);
  var value = toNum(r.tx_value_1d || r.value_today || r.avg_tx_value_7d || r.avg_value_7d);
  var rr = toNum(r.risk_reward);
  var signalLabel = classifySignalLabel(r);
  var ticker = safe(r.ticker, '-').toUpperCase();

  var lines = [];

  // Header
  lines.push(idx + '. \uD83C\uDDEE\uD83C\uDDE9 ' + ticker);
  lines.push('Signal: ' + signalLabel);
  lines.push('');

  // Trading Plan
  lines.push('\uD83C\uDFAF Trading Plan');
  lines.push('Entry: ' + fmtPrice(e1) + ' / ' + fmtPrice(e2));
  lines.push('Take Profit: ' + fmtPrice(tp1) + (tp2 && tp2 > 0 ? ' / ' + fmtPrice(tp2) : ''));
  lines.push('Stop Loss: ' + fmtPrice(sl));
  lines.push('Risk/Reward: ' + fmtRR(rr));
  lines.push('');

  // Technical Context
  lines.push('\uD83D\uDCCA Technical Context');
  lines.push('Price: ' + fmtPrice(last));
  if (vol != null) lines.push('Volume: ' + fmtRatio(vol));
  if (value && value > 0) lines.push('Value: ' + fmtValue(value));
  lines.push('Trend: ' + getTrendShort(r));
  var breakout = getBreakoutShort(r);
  if (breakout) lines.push('Breakout: ' + breakout);
  lines.push('Liquidity: ' + getLiqLabel(r));
  lines.push('Risk: ' + getRiskShort(r));
  lines.push('');

  // Pattern / Setup
  var pattern = getPatternShort(r);
  var planNote = getPlanNote(r);
  lines.push('\uD83D\uDC41 Pattern / Setup');
  if (pattern) lines.push('Chart: ' + pattern);
  lines.push('Plan: ' + planNote);

  return lines.join('\n');
}

// ============================================================
// FULL MESSAGE FORMATTERS
// ============================================================

/**
 * Format Day Trade Signal message (header + cards + disclaimer)
 */
function formatDayTradeSignalMessage(results, options) {
  options = options || {};
  var lines = [];
  lines.push('\uD83C\uDDEE\uD83C\uDDE9 AUTO-CUAN IDX DAY TRADE SIGNAL');
  lines.push('Update: ' + getWibTimeStr());
  if (options.headerNote) lines.push(options.headerNote);
  lines.push('');

  for (var i = 0; i < results.length; i++) {
    lines.push(formatSignalCard(results[i], i + 1, 'daytrade'));
    if (i < results.length - 1) lines.push('');
  }

  lines.push('');
  lines.push('\u26A0\uFE0F Note:');
  lines.push('Bukan rekomendasi beli/jual. Konfirmasi manual wajib.');
  return lines.join('\n');
}

/**
 * Format Swing Konglo Signal message
 */
function formatSwingKongloSignalMessage(results, options) {
  options = options || {};
  var lines = [];
  lines.push('\uD83C\uDDEE\uD83C\uDDE9 AUTO-CUAN IDX SWING KONGLO SIGNAL');
  lines.push('Update: ' + getWibTimeStr());
  if (options.headerNote) lines.push(options.headerNote);
  lines.push('');

  for (var i = 0; i < results.length; i++) {
    lines.push(formatSignalCard(results[i], i + 1, 'swing'));
    if (i < results.length - 1) lines.push('');
  }

  lines.push('');
  lines.push('\u26A0\uFE0F Note:');
  lines.push('Bukan rekomendasi beli/jual. Konfirmasi manual wajib.');
  return lines.join('\n');
}

/**
 * Format Swing Non-Konglo Signal message
 */
function formatSwingNonKongloSignalMessage(results, options) {
  options = options || {};
  var lines = [];
  lines.push('\uD83C\uDDEE\uD83C\uDDE9 AUTO-CUAN IDX SWING NON-KONGLO SIGNAL');
  lines.push('Update: ' + getWibTimeStr());
  if (options.headerNote) lines.push(options.headerNote);
  lines.push('');

  for (var i = 0; i < results.length; i++) {
    lines.push(formatSignalCard(results[i], i + 1, 'swing_non_konglo'));
    if (i < results.length - 1) lines.push('');
  }

  lines.push('');
  lines.push('\u26A0\uFE0F Note:');
  lines.push('Bukan rekomendasi beli/jual. Konfirmasi manual wajib.');
  return lines.join('\n');
}

/**
 * Format Daily Top 5 / Watchlist message
 */
function formatDailyTop5Message(results, date, options) {
  options = options || {};
  var lines = [];
  lines.push('\uD83C\uDDEE\uD83C\uDDE9 AUTO-CUAN SAHAM PILIHAN');
  lines.push('Tanggal: ' + (date || getWibTimeStr()));
  if (options.watchlistMode) {
    lines.push('Mode: WATCHLIST / Pantauan');
    lines.push('Bukan sinyal entry langsung.');
  }
  lines.push('');

  for (var i = 0; i < results.length; i++) {
    lines.push(formatSignalCard(results[i], i + 1, options.mode || 'swing'));
    if (i < results.length - 1) lines.push('');
  }

  lines.push('');
  lines.push('\u26A0\uFE0F Note:');
  lines.push('Bukan rekomendasi beli/jual. Konfirmasi manual wajib.');
  return lines.join('\n');
}

// ============================================================
// MONITOR HIT TEMPLATES (short format)
// ============================================================

/**
 * Format a monitor hit notification (Entry/TP1/TP2/SL)
 * @param {object} pick - The monitored pick row
 * @param {object} ev - Evaluation result { status, label, note }
 * @param {object} px - Price data { last, high, low }
 * @returns {string} Short formatted message
 */
function formatMonitorHitMessage(pick, ev, px) {
  var ticker = safe(pick.ticker, '-').toUpperCase();
  var status = ev.status || 'UNKNOWN';
  var last = toNum(px && px.last);
  var entry1 = toNum(pick.entry1);
  var tp1 = toNum(pick.tp1);
  var tp2 = toNum(pick.tp2);
  var sl = toNum(pick.sl);

  var emoji = '\uD83D\uDCCC'; // default pin
  var statusLabel = ev.label || status;
  var targetLine = '';
  var profitLine = '';
  var catatan = '';

  if (status === 'TP1_HIT') {
    emoji = '\uD83C\uDFC6';
    statusLabel = 'TP1 HIT';
    targetLine = 'Entry: ' + fmtPrice(entry1) + ' \u2192 TP1: ' + fmtPrice(tp1);
    if (entry1 && tp1 && entry1 > 0) {
      var pct1 = ((tp1 - entry1) / entry1) * 100;
      profitLine = 'Profit: +' + pct1.toFixed(1) + '%';
    }
    catatan = 'Sinyal pantauan mencapai target TP1. Pantau TP2 atau amankan profit sesuai plan.';
  } else if (status === 'TP2_HIT') {
    emoji = '\uD83C\uDFC6\uD83C\uDFC6';
    statusLabel = 'TP2 HIT';
    targetLine = 'Entry: ' + fmtPrice(entry1) + ' \u2192 TP2: ' + fmtPrice(tp2);
    if (entry1 && tp2 && entry1 > 0) {
      var pct2 = ((tp2 - entry1) / entry1) * 100;
      profitLine = 'Profit: +' + pct2.toFixed(1) + '%';
    }
    catatan = 'Target TP2 tercapai. Amankan profit. Setup selesai.';
  } else if (status === 'SL_HIT') {
    emoji = '\u26A0\uFE0F';
    statusLabel = 'SL HIT';
    targetLine = 'Entry: ' + fmtPrice(entry1) + ' \u2192 SL: ' + fmtPrice(sl);
    if (entry1 && sl && entry1 > 0) {
      var pctSl = ((sl - entry1) / entry1) * 100;
      profitLine = 'Loss: ' + pctSl.toFixed(1) + '%';
    }
    catatan = 'Stop loss tersentuh. Setup dianggap gagal. Evaluasi kembali.';
  } else if (status === 'IN_ENTRY_ZONE' || status === 'RUNNING') {
    emoji = '\uD83D\uDFE2';
    statusLabel = status === 'IN_ENTRY_ZONE' ? 'ENTRY ZONE' : 'RUNNING';
    targetLine = 'Entry: ' + fmtPrice(entry1) + ' | TP1: ' + fmtPrice(tp1) + ' | SL: ' + fmtPrice(sl);
    catatan = status === 'IN_ENTRY_ZONE' ? 'Harga memasuki area entry. Konfirmasi volume/chart wajib.' : 'Entry sudah tersentuh; monitor TP/SL aktif.';
  } else {
    statusLabel = ev.label || 'UPDATE';
    targetLine = 'Entry: ' + fmtPrice(entry1) + ' | TP1: ' + fmtPrice(tp1) + ' | SL: ' + fmtPrice(sl);
    catatan = ev.note || 'Status update.';
  }

  var lines = [];
  lines.push(emoji + ' TARGET HIT');
  lines.push('Saham: ' + ticker);
  lines.push('Status: ' + statusLabel);
  if (targetLine) lines.push(targetLine);
  lines.push('Harga sekarang: ' + fmtPrice(last));
  if (profitLine) lines.push(profitLine);
  lines.push('Catatan: ' + catatan);
  return lines.join('\n');
}

/**
 * Format the full monitor update message (periodic check, multiple picks)
 */
function formatMonitorUpdateMessage(picks, hour, isFinal) {
  var lines = [];
  lines.push((isFinal ? '\uD83C\uDFC1' : '\u23F1') + ' AUTO-CUAN MONITOR ' + (hour || getWibTimeStr()));
  lines.push('');

  for (var i = 0; i < picks.length; i++) {
    var p = picks[i];
    lines.push(p.ticker + ' \u2014 ' + (p.statusLabel || p.status || '-'));
    lines.push(p.note || '');
    lines.push('Entry: ' + fmtPrice(p.entry1) + ' | Last: ' + fmtPrice(p.last));
    lines.push('TP: ' + fmtPrice(p.tp1) + ' / ' + fmtPrice(p.tp2) + ' | SL: ' + fmtPrice(p.sl));
    if (p.isFinal && !isFinal) lines.push('Status: selesai.');
    lines.push('');
  }

  if (picks.length === 0) lines.push('Tidak ada ticker aktif yang perlu dimonitor.');
  lines.push('Bukan rekomendasi beli/jual. DYOR.');
  return lines.join('\n');
}

// ============================================================
// RADAR / WATCHLIST DIGEST (for when no signal candidates pass)
// ============================================================

function formatRadarDigestMessage(results, title) {
  var lines = [];
  lines.push('[RADAR \u2014 BUKAN SINYAL ENTRY]');
  lines.push(safe(title, 'Radar'));
  lines.push('Update: ' + getWibTimeStr());
  lines.push('');
  lines.push('Pantauan, bukan sinyal entry.');
  lines.push('Konfirmasi manual wajib.');
  lines.push('');

  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var entryLow = toNum(r.entry_low);
    var entryHigh = toNum(r.entry_high);
    var e1 = Math.max(entryLow || 0, entryHigh || 0);
    var e2 = Math.min(entryLow || 0, entryHigh || 0);
    var sl = toNum(r.stop_loss || r.sl);
    var tp1 = toNum(r.tp1 || r.tp1n);

    lines.push((i + 1) + '. ' + safe(r.ticker, '-'));
    lines.push('Entry: ' + fmtPrice(e1) + (e2 > 0 ? '/' + fmtPrice(e2) : '') + ' | SL: ' + fmtPrice(sl) + ' | TP: ' + fmtPrice(tp1));
    lines.push('RR: ' + fmtRR(r.risk_reward) + ' | Risk: ' + getRiskShort(r));
    lines.push('');
  }

  if (lines[lines.length - 1] === '') lines.pop();
  lines.push('Bukan rekomendasi beli. Pantauan saja.');
  return lines.join('\n');
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  formatSignalCard: formatSignalCard,
  formatDayTradeSignalMessage: formatDayTradeSignalMessage,
  formatSwingKongloSignalMessage: formatSwingKongloSignalMessage,
  formatSwingNonKongloSignalMessage: formatSwingNonKongloSignalMessage,
  formatDailyTop5Message: formatDailyTop5Message,
  formatMonitorHitMessage: formatMonitorHitMessage,
  formatMonitorUpdateMessage: formatMonitorUpdateMessage,
  formatRadarDigestMessage: formatRadarDigestMessage,
  // Helpers exposed for testing
  fmtPrice: fmtPrice,
  fmtRR: fmtRR,
  fmtValue: fmtValue,
  fmtRatio: fmtRatio,
  classifySignalLabel: classifySignalLabel,
  getRiskShort: getRiskShort,
  getLiqLabel: getLiqLabel,
  getTrendShort: getTrendShort,
  getWibTimeStr: getWibTimeStr
};
