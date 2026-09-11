'use strict';

var atrHelpers = require('./atr-report-helpers');
var tradePlanV2Integration = require('./trade-plan-v2-integration');

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
  if (status.indexOf('A PLUS SETUP') >= 0 || status.indexOf('A PLUS') >= 0) return 'A+ Setup';
  if (status.indexOf('TRADE CANDIDATE') >= 0) return 'Trade Candidate';
  if (status.indexOf('READY BREAKOUT') >= 0 || status.indexOf('READY') >= 0 || status.indexOf('SWING READY') >= 0) return 'Ready Breakout';
  if (status.indexOf('PRE SPIKE WATCH') >= 0 || status.indexOf('PRE SPIKE') >= 0) return 'Pre-Spike Watch';
  if (status.indexOf('RECLAIM CANDIDATE') >= 0 || status.indexOf('RECLAIM') >= 0) return 'Reclaim Candidate';
  if (status.indexOf('MOMENTUM CONTINUATION') >= 0 || status.indexOf('MOMENTUM') >= 0) return 'Momentum Continuation';
  if (status.indexOf('WAIT PULLBACK') >= 0) return 'Tunggu Pullback';
  if (status.indexOf('EARLY RADAR') >= 0) return 'Early Radar';
  if (status.indexOf('SPECULATIVE') >= 0) return 'Speculative';
  if (status.indexOf('AVOID') >= 0) return 'Hindari';
  if (status.indexOf('WATCHLIST') >= 0) return 'Watchlist';
  return 'Watchlist';
}

function classifyActionLabel(r) {
  var action = safe(r.telegram_action_label || r.action_label || r.signal_action_label || r.action || r.signal_action, '');
  if (!action || action === '-') return '';
  if (/hindari|avoid|skip/i.test(action)) return 'Hindari / Tunggu konfirmasi';
  if (/tunggu\s*pullback/i.test(action)) return 'Tunggu pullback valid';
  if (/watchlist|pantau/i.test(action)) return 'Pantau / Tunggu konfirmasi';
  return action.length > 80 ? action.slice(0, 79) + '\u2026' : action;
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

function getAtrWarningNotes(r) {
  var notes = [];
  function add(note) {
    note = safe(note, '');
    if (note && note !== '-' && notes.indexOf(note) < 0) notes.push(note);
  }
  var custom = r && r.atr_warning_notes;
  if (Array.isArray(custom)) {
    for (var i = 0; i < custom.length; i++) add(custom[i]);
  } else if (typeof custom === 'string') {
    var trimmed = custom.trim();
    var parsed = null;
    if (trimmed.charAt(0) === '[') {
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        parsed = null;
      }
    }
    if (Array.isArray(parsed)) {
      for (var j = 0; j < parsed.length; j++) add(parsed[j]);
    } else {
      add(custom);
    }
  }
  if (safe(r && r.sl_atr_class, '') === 'SL_TOO_TIGHT' || safe(r && r.slClass, '') === 'SL_TOO_TIGHT') add('Risk: SL ketat vs volatilitas harian; rawan noise.');
  if (safe(r && r.tp1_atr_class, '') === 'TP1_STRETCHED' || safe(r && r.tp1Class, '') === 'TP1_STRETCHED') add('Target: TP1 cukup jauh vs ATR; butuh momentum kuat.');
  if (safe(r && r.tp2_atr_class, '') === 'TP2_STRETCHED' || safe(r && r.tp2Class, '') === 'TP2_STRETCHED') add('Target: TP2 agresif; anggap target lanjutan.');
  return notes;
}

function attachAtrWarningsIfEmbeddedOhlcv(r) {
  if (!r || typeof r !== 'object') return r;
  if (r.atr14 != null || r.sl_atr_class || r.tp1_atr_class || r.tp2_atr_class || r.slClass || r.tp1Class || r.tp2Class) return r;
  var candles = Array.isArray(r.candles) ? r.candles : (Array.isArray(r.ohlcv) ? r.ohlcv : (Array.isArray(r.ohlcv_candles) ? r.ohlcv_candles : null));
  if (!candles) return r;
  return atrHelpers.attachAtrWarningMetadata(r, candles);
}


function getMarketRegimeLine(r, mode) {
  if (mode === 'daytrade' || !r || !r.market_regime_label) return '';
  if (r.market_regime_label === 'RISK_ON') return 'Market: IHSG mendukung risk-on.';
  if (r.market_regime_label === 'NEUTRAL') return 'Market: netral, tetap selektif.';
  if (r.market_regime_label === 'RISK_OFF') return 'Market: risk-off; sizing dan validasi perlu lebih ketat.';
  return '';
}

function getWeeklyTfLine(r, mode) {
  if (mode === 'daytrade' || !r || !r.weekly_tf_label) return '';
  if (r.weekly_tf_label === 'WEEKLY_SUPPORT') return 'Weekly: trend mendukung swing.';
  if (r.weekly_tf_label === 'WEEKLY_NEUTRAL') return 'Weekly: netral, tunggu konfirmasi lanjutan.';
  if (r.weekly_tf_label === 'WEEKLY_WEAK') return 'Weekly: kurang mendukung; risiko swing lebih tinggi.';
  return '';
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
 * Format monitor hit message — shows trigger basis separately from current price.
 * @param {object} pick - Pick row from telegram_daily_picks (must have ticker, entry1, tp1, tp2, sl, category)
 * @param {object} ev - Evaluation result (status, label, note)
 * @param {object} px - Price data (last, high, low)
 * @returns {string} Formatted hit message
 */
function formatMonitorHitMessage(pick, ev, px) {
  var ticker = safe(pick.ticker, '-').toUpperCase();
  var status = ev.status || 'UNKNOWN';
  var last = toNum(px && px.last);
  var high = px && px.high != null ? toNum(px.high) : last;
  var low = px && px.low != null ? toNum(px.low) : last;
  var entry1 = toNum(pick.entry1);
  var entry2 = toNum(pick.entry2);
  var tp1 = toNum(pick.tp1);
  var tp2 = toNum(pick.tp2);
  var sl = toNum(pick.sl);
  var category = safe(pick.category, '').toLowerCase();
  var isDaytrade = category.indexOf('day') >= 0;

  var emoji = '\uD83D\uDCCC'; // default pin
  var statusLabel = ev.label || status;
  var triggerLine = '';
  var profitLine = '';
  var catatan = '';

  // Determine trigger basis based on status and price action
  function getTriggerBasis() {
    if (status === 'SL_HIT') {
      // SL hit: trigger was low touching SL
      if (low != null && sl != null) {
        return 'low menyentuh SL ' + fmtPrice(sl);
      }
      return 'SL tersentuh';
    } else if (status === 'TP1_HIT') {
      // TP1 hit: trigger was high touching TP1
      if (high != null && tp1 != null) {
        return 'high menyentuh TP1 ' + fmtPrice(tp1);
      }
      return 'TP1 tersentuh';
    } else if (status === 'TP2_HIT') {
      // TP2 hit: trigger was high touching TP2
      if (high != null && tp2 != null) {
        return 'high menyentuh TP2 ' + fmtPrice(tp2);
      }
      return 'TP2 tersentuh';
    } else if (status === 'IN_ENTRY_ZONE') {
      // Entry zone: trigger was price entering entry area
      if (entry1 != null && entry2 != null) {
        var eLow = Math.min(entry1, entry2);
        var eHigh = Math.max(entry1, entry2);
        return 'harga masuk area entry ' + fmtPrice(eLow) + '-' + fmtPrice(eHigh);
      }
      return 'harga memasuki area entry';
    }
    return ev.note || '';
  }

  if (status === 'TP1_HIT') {
    emoji = '\uD83C\uDFAF';
    statusLabel = 'TP1 HIT';
    triggerLine = 'Trigger: ' + getTriggerBasis();
    if (entry1 && tp1 && entry1 > 0) {
      var pct1 = ((tp1 - entry1) / entry1) * 100;
      profitLine = 'Profit: +' + pct1.toFixed(1) + '%';
    }
    catatan = 'Target TP1 tercapai! Peringatan: Jual 50-70% posisi & segera geser SL ke BEP (Entry + 1 tick).';
  } else if (status === 'TP2_HIT') {
    emoji = '\uD83D\uDE80';
    statusLabel = 'TP2 HIT';
    triggerLine = 'Trigger: ' + getTriggerBasis();
    if (entry1 && tp2 && entry1 > 0) {
      var pct2 = ((tp2 - entry1) / entry1) * 100;
      profitLine = 'Profit: +' + pct2.toFixed(1) + '%';
    }
    catatan = 'Target TP2 tercapai! Peringatan: Exit penuh seluruh sisa posisi atau pasang trailing stop sangat ketat. Setup selesai.';
  } else if (status === 'SL_HIT') {
    emoji = '\uD83D\uDED1';
    statusLabel = 'SL HIT — STOP LOSS';
    triggerLine = 'Trigger: ' + getTriggerBasis();
    if (entry1 && sl && entry1 > 0) {
      var pctSl = ((sl - entry1) / entry1) * 100;
      profitLine = 'Loss: ' + pctSl.toFixed(1) + '%';
    }
    catatan = 'Stop Loss tersentuh! Peringatan: Cut loss disiplin, jangan buyback sebelum ada setup baru (meskipun harga tampak rebound).';
  } else if (status === 'IN_ENTRY_ZONE' || status === 'RUNNING') {
    emoji = '\uD83D\uDFE2';
    statusLabel = status === 'IN_ENTRY_ZONE' ? 'ENTRY ZONE' : 'RUNNING';
    triggerLine = 'Trigger: ' + getTriggerBasis();
    catatan = status === 'IN_ENTRY_ZONE' ? 'Harga memasuki area entry. Konfirmasi volume/chart wajib.' : 'Entry sudah tersentuh; monitor TP/SL aktif.';
  } else if (status === 'EXPIRED') {
    emoji = '\u23F1';
    statusLabel = 'EXPIRED';
    triggerLine = '';
    // Use different wording based on source type
    if (isDaytrade) {
      catatan = 'Setup terlalu lama untuk konteks intraday; perlu scan baru.';
    } else {
      catatan = 'Setup melewati masa pantau; perlu revalidasi.';
    }
  } else if (status === 'NEEDS_REVALIDATION') {
    emoji = '\u2753';
    statusLabel = 'NEEDS REVALIDATION';
    triggerLine = '';
    catatan = ev.note || 'Data perlu divalidasi ulang.';
  } else {
    statusLabel = ev.label || 'UPDATE';
    triggerLine = '';
    catatan = ev.note || 'Status update.';
  }

  var lines = [];
  lines.push(emoji + ' ' + statusLabel);
  lines.push('Saham: ' + ticker);
  if (triggerLine) lines.push(triggerLine);
  lines.push('Last: ' + fmtPrice(last));
  if (profitLine) lines.push(profitLine);
  lines.push('Catatan: ' + catatan);
  return lines.join('\n');
}

function getRiskPctStr(entry, sl) {
  var e = toNum(entry);
  var s = toNum(sl);
  if (e && s && e > 0) {
    var pct = ((s - e) / e) * 100;
    return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
  }
  return null;
}

function getDayTradeMetrics(r) {
  var volPace = r.intraday_volume_pace_ratio != null ? fmtRatio(r.intraday_volume_pace_ratio) : (r.volume_pace != null ? fmtRatio(r.volume_pace) : (r.relative_volume != null ? fmtRatio(r.relative_volume) : (r.volume_ratio_20d != null ? fmtRatio(r.volume_ratio_20d) : '-')));
  var deltaTurnover = r.delta_turnover_5m != null ? fmtValue(r.delta_turnover_5m) : (r.turnover_delta != null ? fmtValue(r.turnover_delta) : (r.delta_turnover != null ? fmtValue(r.delta_turnover) : (r.tx_value_1d != null ? fmtValue(r.tx_value_1d) : (r.value_today != null ? fmtValue(r.value_today) : '-'))));
  var dominance = safe(r.bid_offer_dominance || r.bid_dominance || r.orderbook_dominance || r.dominance, 'Bid Dominant');
  return {
    volPace: volPace,
    deltaTurnover: deltaTurnover,
    dominance: dominance
  };
}

function getSwingBandarIntel(r) {
  var cr3 = r.cr3_flow || r.cr3_net || r.cr3;
  var cr5 = r.cr5_flow || r.cr5_net || r.cr5;
  var retail = r.retail_participation || r.retail_flow || r.retail_pct;
  var netFlow = r.bandar_net_flow || r.broker_net_flow || r.foreign_flow || r.net_flow;
  var bandarStatus = safe(r.bandar_flow_label || r.broker_accumulation_label || r.bandarmologi_status || r.bandar_status, '');

  var items = [];
  if (cr3 != null) items.push('CR3: ' + fmtValue(cr3));
  if (cr5 != null) items.push('CR5: ' + fmtValue(cr5));
  if (items.length === 0 && netFlow != null) items.push('Net Flow: ' + fmtValue(netFlow));
  if (retail != null) items.push('Partisipasi Ritel: ' + (typeof retail === 'number' ? retail.toFixed(1) + '%' : retail));
  if (bandarStatus && bandarStatus !== '-') items.push('Status: ' + bandarStatus);

  if (items.length === 0) {
    return 'CR3/CR5 net akumulasi positif · Partisipasi ritel terkendali';
  }
  return items.join(' · ');
}

/**
 * Format a single candidate as a premium signal card block.
 * @param {object} r - Enriched candidate row
 * @param {number} idx - 1-based index
 * @param {string} mode - 'daytrade' | 'swing' | 'swing_non_konglo'
 * @returns {string} Formatted text block
 */
function formatSignalCard(r, idx, mode) {
  r = attachAtrWarningsIfEmbeddedOhlcv(r);
  var entryLow = toNum(r.entry_low || r.entryLow || r.entry1 || r.buy_low);
  var entryHigh = toNum(r.entry_high || r.entryHigh || r.entry2 || r.buy_high);
  var e1 = Math.max(entryLow || 0, entryHigh || 0);
  var e2 = Math.min(entryLow || 0, entryHigh || 0);
  if (e2 <= 0) e2 = e1;
  if (e1 <= 0) e1 = e2;
  var tp1 = toNum(r.tp1 || r.tp1n);
  var tp2 = toNum(r.tp2 || r.tp2n);
  var sl = toNum(r.stop_loss || r.sl);
  var last = toNum(r.last_price || r.lastn);
  var vol = toNum(r.volume_ratio_20d || r.volume_ratio_avg20);
  var value = toNum(r.tx_value_1d || r.value_today || r.avg_tx_value_7d || r.avg_value_7d);
  var rr = toNum(r.risk_reward);
  var signalLabel = classifySignalLabel(r);
  var ticker = safe(r.ticker, '-').toUpperCase();
  var sector = safe(r.sector || r.sector_name, '');
  var convScore = r.conviction_score || r.daytrade_score || r.telegram_conviction_score || r.score || r.publish_score;

  var lines = [];

  // Header
  lines.push(idx + '. \uD83C\uDDEE\uD83C\uDDE9 ' + ticker);
  lines.push('Signal: ' + signalLabel);
  var actionLabel = classifyActionLabel(r);
  if (actionLabel) lines.push('Action: ' + actionLabel);
  if (sector && sector !== '-') lines.push('Sektor: ' + sector);
  if (convScore != null) lines.push('Skor Keyakinan: ' + convScore + '/100');
  lines.push('');

  // Trade Plan V2 — public selector. Returns the canonical view-model ONLY when
  // TRADE_PLAN_V2_PUBLIC_ENABLED is true and the V2 plan is usable; otherwise the
  // legacy block below renders byte-identically (public output unchanged).
  var _tpv2Public = null;
  try {
    var _tpv2Resolved = tradePlanV2Integration.resolvePublicTradePlan(r, {
      channel: 'telegram',
      mode: mode,
      env: (typeof process !== 'undefined' ? process.env : undefined)
    });
    if (_tpv2Resolved && _tpv2Resolved.source === 'trade_plan_v2') _tpv2Public = _tpv2Resolved.payload;
  } catch (e) { _tpv2Public = null; }

  // Trading Plan
  lines.push('\uD83C\uDFAF Trading Plan');
  var riskPct = getRiskPctStr(e2 > 0 ? e2 : e1, sl);
  var riskSuffix = riskPct ? ' (Risk: ' + riskPct + ')' : '';

  if (_tpv2Public) {
    var _c = _tpv2Public.canonical;
    var _d = _tpv2Public.display;
    var areaBeliV2 = _d.entry_zone || (fmtPrice(e2) + ' - ' + fmtPrice(e1));
    lines.push('Area Beli: ' + areaBeliV2 + ' (Entry: ' + _d.entry_zone + ')');
    lines.push('Support: ' + _d.support + ' / Resistance: ' + _d.resistance);
    lines.push('Stop Loss: ' + _d.stop_loss + riskSuffix);
    if (_c.stop_loss_reason) lines.push('SL Reason: ' + _c.stop_loss_reason);
    lines.push('Take Profit: ' + _d.tp1 + (_c.tp2 != null ? ' / ' + _d.tp2 : ''));
    if (mode === 'daytrade') {
      lines.push('Target Profit 1 (+4.5%): ' + _d.tp1 + (_c.tp2 != null ? ' / Target Profit 2 (+7.5%): ' + _d.tp2 : ''));
    } else {
      lines.push('Target Profit 1 (+5% s/d +6% Partial TP 50%): ' + _d.tp1 + (_c.tp2 != null ? ' / Target Profit 2 (Fib Extension): ' + _d.tp2 : ''));
    }
    lines.push('Risk/Reward (TP1): ' + _d.rr_to_tp1);
    lines.push('Trailing: activate ' + _d.trailing_activation);
    lines.push('Plan: ' + (_d.plan_version || _c.plan_version));
  } else {
    var areaBeliText = (e2 > 0 && e1 > 0 && e2 !== e1) ? fmtPrice(e2) + ' - ' + fmtPrice(e1) : fmtPrice(e1);
    lines.push('Area Beli: ' + areaBeliText + ' (Entry: ' + fmtPrice(e1) + ' / ' + fmtPrice(e2) + ')');
    lines.push('Take Profit: ' + fmtPrice(tp1) + (tp2 && tp2 > 0 ? ' / ' + fmtPrice(tp2) : ''));
    if (mode === 'daytrade') {
      var tp1Text = tp1 ? fmtPrice(tp1) : fmtPrice(Math.round(e1 * 1.045));
      var tp2Text = tp2 ? fmtPrice(tp2) : fmtPrice(Math.round(e1 * 1.075));
      lines.push('Target Profit 1 (+4.5%): ' + tp1Text + (tp2Text ? ' / Target Profit 2 (+7.5%): ' + tp2Text : ''));
    } else {
      var tp1SwingText = tp1 ? fmtPrice(tp1) : fmtPrice(Math.round(e1 * 1.055));
      var tp2SwingText = tp2 ? fmtPrice(tp2) : (r.fib_extension ? fmtPrice(r.fib_extension) : null);
      lines.push('Target Profit 1 (+5% s/d +6% Partial TP 50%): ' + tp1SwingText + (tp2SwingText ? ' / Target Profit 2 (Fib Extension): ' + tp2SwingText : ''));
    }
    lines.push('Stop Loss: ' + fmtPrice(sl) + riskSuffix);
    lines.push('Risk/Reward: ' + fmtRR(rr));
  }
  lines.push('');

  // Technical Context
  if (mode === 'daytrade') {
    var dtMetrics = getDayTradeMetrics(r);
    lines.push('\uD83D\uDCCA Technical Context & Metrik Transaksi');
    lines.push('Price: ' + fmtPrice(last));
    lines.push('Volume: ' + fmtRatio(vol) + ' | Volume Pace: ' + dtMetrics.volPace);
    lines.push('Delta 5m Turnover: ' + dtMetrics.deltaTurnover);
    lines.push('Dominasi Bid/Offer: ' + dtMetrics.dominance);
    if (value && value > 0) lines.push('Value: ' + fmtValue(value));
    lines.push('Trend: ' + getTrendShort(r));
    var dtBreakout = getBreakoutShort(r);
    if (dtBreakout) lines.push('Breakout: ' + dtBreakout);
    lines.push('Liquidity: ' + getLiqLabel(r));
    lines.push('Risk: ' + getRiskShort(r));
  } else {
    lines.push('\uD83D\uDCCA Technical Context & Intel Bandar');
    lines.push('Price: ' + fmtPrice(last));
    lines.push('Intel Bandar / Arus Dana: ' + getSwingBandarIntel(r));
    if (vol != null) lines.push('Volume: ' + fmtRatio(vol));
    if (value && value > 0) lines.push('Value: ' + fmtValue(value));
    lines.push('Trend: ' + getTrendShort(r));
    var swBreakout = getBreakoutShort(r);
    if (swBreakout) lines.push('Breakout: ' + swBreakout);
    lines.push('Liquidity: ' + getLiqLabel(r));
    lines.push('Risk: ' + getRiskShort(r));
  }
  lines.push('');

  // Pattern / Setup
  var pattern = getPatternShort(r);
  var planNote = getPlanNote(r);
  lines.push('\uD83D\uDC41 Pattern / Setup');
  if (pattern) lines.push('Chart: ' + pattern);
  lines.push('Plan: ' + planNote);
  var atrNotes = getAtrWarningNotes(r);
  for (var aw = 0; aw < atrNotes.length; aw++) lines.push(atrNotes[aw]);
  var weeklyLine = getWeeklyTfLine(r, mode);
  if (weeklyLine) lines.push(weeklyLine);
  var marketLine = getMarketRegimeLine(r, mode);
  if (marketLine) lines.push(marketLine);

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
  lines.push('⚡ AUTO-CUAN DAY TRADE — CONFIRMED BUY');
  lines.push('Kategori: Day Trade Signal');
  lines.push('Update: ' + getWibTimeStr());
  if (options.headerNote) lines.push(options.headerNote);
  lines.push('');

  for (var i = 0; i < results.length; i++) {
    lines.push(formatSignalCard(results[i], i + 1, 'daytrade'));
    if (i < results.length - 1) lines.push('');
  }

  lines.push('');
  lines.push('⚡ Protokol Aksi Day Trade:');
  lines.push('Entry hanya di area beli (dilarang HAKA di pucuk), otomatis geser SL ke BEP (Entry + 1 tick) jika floating >= +2.0%, dan tutup posisi saat sesi 2 berakhir jika belum capai TP1.');
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
  lines.push('🎯 AUTO-CUAN SWING TRADE — HIGH CONVICTION');
  lines.push('Kluster: Konglo | Horizon: 3-7 Hari');
  lines.push('Update: ' + getWibTimeStr());
  if (options.headerNote) lines.push(options.headerNote);
  lines.push('');

  for (var i = 0; i < results.length; i++) {
    lines.push(formatSignalCard(results[i], i + 1, 'swing'));
    if (i < results.length - 1) lines.push('');
  }

  lines.push('');
  lines.push('⚡ Protokol Aksi 3 Tahap:');
  lines.push('1. BEP lock di +2.5%: Geser SL ke BEP (Entry + 1 tick) saat running profit mencapai +2.5%.');
  lines.push('2. Partial TP 50% di TP1: Amankan profit 50% posisi saat menyentuh TP1 (+5% s/d +6%).');
  lines.push('3. Trailing Stop: Sisa lot gunakan trailing stop harian EMA9 Low menuju TP2 (Fib Extension).');
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
  lines.push('🎯 AUTO-CUAN SWING TRADE — HIGH CONVICTION');
  lines.push('Kluster: Non-Konglo | Horizon: 3-7 Hari');
  lines.push('Update: ' + getWibTimeStr());
  if (options.headerNote) lines.push(options.headerNote);
  lines.push('');

  for (var i = 0; i < results.length; i++) {
    lines.push(formatSignalCard(results[i], i + 1, 'swing_non_konglo'));
    if (i < results.length - 1) lines.push('');
  }

  lines.push('');
  lines.push('⚡ Protokol Aksi 3 Tahap:');
  lines.push('1. BEP lock di +2.5%: Geser SL ke BEP (Entry + 1 tick) saat running profit mencapai +2.5%.');
  lines.push('2. Partial TP 50% di TP1: Amankan profit 50% posisi saat menyentuh TP1 (+5% s/d +6%).');
  lines.push('3. Trailing Stop: Sisa lot gunakan trailing stop harian EMA9 Low menuju TP2 (Fib Extension).');
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
  var pickedCount = options.pickedCount != null ? options.pickedCount : (results || []).length;
  // Cap display between 0 and 5 for the "X/5" format
  pickedCount = Math.max(0, Math.min(5, Number(pickedCount) || 0));
  var lines = [];
  // Always show "lolos gate: X/5" to clarify why count may be < 5
  if (options.watchlistMode) {
    lines.push('\uD83C\uDDEE\uD83C\uDDE9 Top 5 Watchlist — lolos gate: ' + pickedCount + '/5');
  } else {
    lines.push('\uD83C\uDDEE\uD83C\uDDE9 AUTO-CUAN SAHAM PILIHAN — TOP 5 — lolos gate: ' + pickedCount + '/5');
  }
  lines.push('Tanggal: ' + (date || getWibTimeStr()));
  if (options.watchlistMode) {
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

function formatOpeningRadarMessage(results, options) {
  options = options || {};
  var lines = [];
  lines.push('👀 RADAR PEMBUKAAN — PANTAUAN, BUKAN SINYAL BUY');
  lines.push('Kategori: Day Trade Signal (Pantauan / Radar)');
  lines.push('Update: ' + getWibTimeStr());
  lines.push('');
  lines.push('⚠️ Volatilitas pembukaan tinggi. Saham dalam daftar ini sedang dipantau dan DILARANG HAKA sebelum ada konfirmasi resmi.');
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

function formatRadarDigestMessage(results, title) {
  var lines = [];
  lines.push('[RADAR \u2014 BUKAN SINYAL ENTRY]');
  lines.push('👀 RADAR PEMBUKAAN — PANTAUAN, BUKAN SINYAL BUY');
  lines.push(safe(title, 'Radar'));
  lines.push('Update: ' + getWibTimeStr());
  lines.push('');
  lines.push('⚠️ Volatilitas pembukaan tinggi. Saham dalam daftar ini sedang dipantau.');
  lines.push('DILARANG HAKA sebelum ada konfirmasi resmi.');
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
  formatOpeningRadarMessage: formatOpeningRadarMessage,
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
  getAtrWarningNotes: getAtrWarningNotes,
  attachAtrWarningsIfEmbeddedOhlcv: attachAtrWarningsIfEmbeddedOhlcv,
  getWibTimeStr: getWibTimeStr
};
