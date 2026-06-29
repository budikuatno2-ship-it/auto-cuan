/**
 * IDX Tick Size Normalization + Risk Label + Volume-Price Action + Multi-Timeframe Context
 * Deterministic shared helper. No AI, no SQL, no cron.
 */

'use strict';

function toNum(v, fallback) {
  if (fallback == null) fallback = 0;
  if (v == null || v === '') return fallback;
  var n = Number(v);
  return isFinite(n) ? n : fallback;
}

function round2(n) {
  n = toNum(n, 0);
  return Math.round(n * 100) / 100;
}

function getIdxTickSize(price) {
  price = toNum(price, null);
  if (price == null || !isFinite(price) || price <= 0) return null;
  if (price < 200) return 1;
  if (price < 500) return 2;
  if (price < 2000) return 5;
  if (price < 5000) return 10;
  return 25;
}

function roundToIdxTick(price, mode) {
  price = toNum(price, null);
  if (price == null || !isFinite(price) || price <= 0) return null;
  mode = mode || 'nearest';
  if (mode === 'up') mode = 'ceil';
  if (mode === 'down') mode = 'floor';
  var tick = getIdxTickSize(price);
  if (!tick) return null;
  if (mode === 'ceil') return Math.ceil(price / tick) * tick;
  if (mode === 'floor') return Math.floor(price / tick) * tick;
  return Math.round(price / tick) * tick;
}

function normalizeIdxPriceLevel(price, mode) {
  return roundToIdxTick(price, mode || 'nearest');
}

function isValidIdxPriceLevel(price) {
  price = toNum(price, null);
  if (price == null || !isFinite(price) || price <= 0) return false;
  var tick = getIdxTickSize(price);
  return !!tick && Math.abs(price / tick - Math.round(price / tick)) < 1e-9;
}

function firstNum(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (obj && obj[keys[i]] != null && obj[keys[i]] !== '') {
      var n = toNum(obj[keys[i]], null);
      if (n != null && isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function addLevelWarning(candidate, text) {
  if (!candidate || !text) return;
  var existing = candidate.level_validation_note || candidate.validation_note || candidate.status_note || '';
  candidate.level_validation_note = existing && existing.indexOf(text) === -1 ? (existing + '; ' + text) : (existing || text);
}


function deriveEntryStatus(candidate) {
  candidate = candidate || {};
  var price = firstNum(candidate, ['current_price', 'last_price', 'lastn', 'close']);
  var rawLow = firstNum(candidate, ['entry_low', 'entry1', 'entry_1']);
  var rawHigh = firstNum(candidate, ['entry_high', 'entry2', 'entry_2']);
  var entries = [];
  if (rawLow != null) entries.push(rawLow);
  if (rawHigh != null) entries.push(rawHigh);
  var entryLow = entries.length ? Math.min.apply(Math, entries) : null;
  var entryHigh = entries.length ? Math.max.apply(Math, entries) : null;
  var sl = firstNum(candidate, ['stop_loss', 'sl']);
  var tp1 = firstNum(candidate, ['target_1', 'tp1n', 'tp1', 'target1']);
  var tp2 = firstNum(candidate, ['target_2', 'tp2n', 'tp2', 'target2']);
  var distancePct = null;
  if (price != null && entryHigh != null && entryHigh > 0) distancePct = round2(((price - entryHigh) / entryHigh) * 100);

  function out(status, label, note, chase) {
    return {
      entry_status: status,
      entry_status_label: label,
      entry_status_note: note,
      entry_distance_pct: distancePct,
      chase_risk_label: chase || 'Normal'
    };
  }

  if (price == null || entryLow == null || entryHigh == null) {
    return out('NO_DATA', 'Data terbatas', 'Harga atau area entry belum tersedia.', 'Unknown');
  }
  if (sl != null && price <= sl) return out('INVALID_BELOW_SL', 'Invalid / SL kena', 'Harga sudah menyentuh atau berada di bawah SL.', 'Invalid');
  if (tp2 != null && price >= tp2) return out('TP2_HIT', 'TP2 tercapai', 'Harga sudah mencapai TP2.', 'Final');
  if (tp1 != null && price >= tp1) return out('TP1_HIT', 'TP1 tercapai', 'Harga sudah mencapai TP1.', 'High');
  if (tp1 != null && tp1 > 0 && price < tp1 && ((tp1 - price) / tp1) * 100 <= 1.5) {
    return out('TP1_NEAR', 'Dekat TP1', 'Risk-reward entry baru mulai kurang menarik.', 'High');
  }
  if (price >= entryLow && price <= entryHigh) return out('IN_ENTRY_AREA', 'Masuk area entry', 'Harga berada di area entry rencana.', 'Normal');
  if (price < entryLow) return out('BELOW_ENTRY', 'Di bawah area entry', 'Pantau risiko, tunggu reclaim area entry.', 'Low');

  var abovePct = entryHigh > 0 ? ((price - entryHigh) / entryHigh) * 100 : 0;
  if (abovePct > 5) return out('EXTENDED', 'Extended', 'Harga sudah terlalu jauh dari area entry, tunggu pullback.', 'Very High');
  if (abovePct > 3) return out('CHASE_RISK', 'Chase risk', 'Harga sudah menjauh dari area entry, lebih aman tunggu pullback.', 'High');
  if (abovePct <= 1.5) return out('NEAR_ENTRY', 'Sedikit di atas entry', 'Masih bisa dipantau, jangan agresif tanpa konfirmasi.', 'Medium');
  return out('ABOVE_ENTRY', 'Sedikit di atas entry', 'Masih bisa dipantau, jangan agresif tanpa konfirmasi.', 'Medium');
}

function normalizeTradingPlanLevels(candidate) {
  if (!candidate) return candidate;
  var out = Object.assign({}, candidate);

  var entry1 = normalizeIdxPriceLevel(firstNum(out, ['entry_1', 'entry1', 'entry_low']), 'nearest');
  var entry2 = normalizeIdxPriceLevel(firstNum(out, ['entry_2', 'entry2', 'entry_high']), 'nearest');
  var sl = normalizeIdxPriceLevel(firstNum(out, ['stop_loss', 'sl']), 'floor');
  var tp1 = normalizeIdxPriceLevel(firstNum(out, ['target_1', 'tp1n', 'tp1', 'target1']), 'ceil');
  var tp2 = normalizeIdxPriceLevel(firstNum(out, ['target_2', 'tp2n', 'tp2', 'target2']), 'ceil');
  var support = normalizeIdxPriceLevel(firstNum(out, ['support']), 'floor');
  var resistance = normalizeIdxPriceLevel(firstNum(out, ['resistance']), 'ceil');
  var trigger = normalizeIdxPriceLevel(firstNum(out, ['breakout_trigger', 'trigger_price', 'reclaim_level']), 'ceil');

  var entryValues = [];
  if (entry1 != null) entryValues.push(entry1);
  if (entry2 != null) entryValues.push(entry2);
  var entry_low = entryValues.length ? Math.min.apply(Math, entryValues) : null;
  var entry_high = entryValues.length ? Math.max.apply(Math, entryValues) : null;

  // Preserve displayed E1/E2 labels, but expose normalized low/high aliases for internal checks.
  if (entry1 != null) { out.entry1 = entry1; out.entry_1 = entry1; }
  if (entry2 != null) { out.entry2 = entry2; out.entry_2 = entry2; }
  if (entry_low != null) out.entry_low = entry_low;
  if (entry_high != null) out.entry_high = entry_high;
  if (sl != null) { out.sl = sl; out.stop_loss = sl; }
  if (tp1 != null) { out.tp1n = tp1; out.tp1 = tp1; out.target_1 = tp1; }
  if (tp2 != null) { out.tp2n = tp2; out.tp2 = tp2; out.target_2 = tp2; }
  if (support != null) out.support = support;
  if (resistance != null) out.resistance = resistance;
  if (trigger != null) {
    if (out.breakout_trigger != null) out.breakout_trigger = trigger;
    if (out.trigger_price != null) out.trigger_price = trigger;
    if (out.reclaim_level != null) out.reclaim_level = trigger;
  }

  var valid = true;
  if (entry1 != null && !isValidIdxPriceLevel(entry1)) valid = false;
  if (entry2 != null && !isValidIdxPriceLevel(entry2)) valid = false;
  if (entry_low != null && sl != null && sl >= entry_low) valid = false;
  if (entry_high != null && tp1 != null && tp1 <= entry_high) valid = false;
  if (entry_high != null && tp2 != null && tp2 <= entry_high) valid = false;
  if (tp1 != null && tp2 != null && tp2 < tp1) valid = false;
  if (support != null && resistance != null && resistance < support) valid = false;
  if (support != null && trigger != null && trigger < support) valid = false;

  // Conservative long setup math: use the upper entry boundary, never the lower label only.
  var rrEntryRef = entry_high;
  if (rrEntryRef != null && sl != null && tp1 != null && sl < entry_low && tp1 > rrEntryRef) {
    out.risk_reward = round2((tp1 - rrEntryRef) / (rrEntryRef - sl));
    out.tp1_upside = round2((tp1 - rrEntryRef) / rrEntryRef * 100);
    if (tp2 != null) out.tp2_upside = round2((tp2 - rrEntryRef) / rrEntryRef * 100);
    out.sl_risk = round2((sl - rrEntryRef) / rrEntryRef * 100);
    out.rr_reference_price = rrEntryRef;
  }

  out.tick_normalized = true;
  out.level_validation_valid = valid;
  if (!valid) {
    out.tick_normalized = false;
    addLevelWarning(out, 'Level harga belum valid');
    addLevelWarning(out, 'Trading plan perlu validasi ulang');
    if (!out.telegram_verdict) out.telegram_verdict = 'Wait - Level belum rapi';
    if (out.action && String(out.action).toLowerCase().indexOf('buy') !== -1) out.action = 'Wait - Level belum rapi';
  }
  return out;
}

function normalizeLevelsToIdxTicks(levels, opts) {
  if (!levels) return levels;
  var normalized = normalizeTradingPlanLevels(Object.assign({}, levels, {
    entry1: levels.entry_low,
    entry2: levels.entry_high,
    sl: levels.stop_loss,
    tp1n: levels.tp1,
    tp2n: levels.tp2
  }));
  return {
    entry_low: normalized.entry_low,
    entry_high: normalized.entry_high,
    stop_loss: normalized.stop_loss,
    tp1: normalized.tp1,
    tp2: normalized.tp2,
    risk_reward: normalized.risk_reward != null ? normalized.risk_reward : levels.risk_reward,
    support: normalized.support,
    resistance: normalized.resistance,
    tick_normalized: normalized.level_validation_valid !== false,
    tick_notes: normalized.level_validation_note || null
  };
}

function classifyCandle(candle, prevCandle) {
  if (!candle) return { bias: 'neutral', label: 'No data', highVolRed: false };
  var o = toNum(candle.open, 0), h = toNum(candle.high, 0), l = toNum(candle.low, 0), c = toNum(candle.close, 0), v = toNum(candle.volume, 0);
  var range = h - l;
  var body = Math.abs(c - o);
  var isGreen = c > o;
  var bodyRatio = range > 0 ? body / range : 0;
  var closePos = range > 0 ? (c - l) / range : 0.5;
  var bias = 'neutral';
  var label = 'Netral';
  var highVolRed = false;

  if (isGreen && bodyRatio > 0.5 && closePos > 0.7) {
    bias = 'bullish'; label = 'Bullish candle (close near high)';
  } else if (!isGreen && bodyRatio > 0.5 && closePos < 0.3) {
    bias = 'bearish'; label = 'Bearish candle (close near low)'; highVolRed = true;
  } else if (bodyRatio < 0.2) {
    label = 'Doji/indecision';
  } else if (isGreen) {
    bias = 'bullish'; label = 'Green candle';
  } else {
    bias = 'bearish'; label = 'Red candle'; highVolRed = true;
  }

  return { bias: bias, label: label, highVolRed: highVolRed, closePos: closePos, bodyRatio: bodyRatio, volume: v };
}

function classifyAggregatedCandles(slice) {
  if (!slice || !slice.length) return { bias: 'neutral', label: 'No data', highVolRed: false, downtrend: false };
  var first = slice[0], last = slice[slice.length - 1];
  var open = toNum(first.open, 0);
  var close = toNum(last.close, 0);
  var high = -Infinity, low = Infinity, volume = 0;
  for (var i = 0; i < slice.length; i++) {
    high = Math.max(high, toNum(slice[i].high, 0));
    low = Math.min(low, toNum(slice[i].low, 0));
    volume += toNum(slice[i].volume, 0);
  }
  if (!isFinite(high)) high = close;
  if (!isFinite(low)) low = close;
  var pct = open > 0 ? ((close - open) / open) * 100 : 0;
  var range = high - low;
  var body = Math.abs(close - open);
  var closePos = range > 0 ? (close - low) / range : 0.5;
  var bodyRatio = range > 0 ? body / range : 0;
  var bias = 'neutral';
  var label = 'Sideways';
  var highVolRed = false;
  var downtrend = false;

  if (pct >= 2.5) { bias = 'bullish'; label = 'Bullish (' + pct.toFixed(1) + '%)'; }
  else if (pct <= -2.5) { bias = 'bearish'; label = 'Bearish (' + pct.toFixed(1) + '%)'; highVolRed = true; }
  else if (pct > 0.5) { bias = 'bullish'; label = 'Slight bullish'; }
  else if (pct < -0.5) { bias = 'bearish'; label = 'Slight bearish'; highVolRed = true; }

  if (closePos < 0.35 && pct < 0) downtrend = true;
  if (bodyRatio < 0.18) label = 'Doji/sideways';

  return { bias: bias, label: label, highVolRed: highVolRed, downtrend: downtrend, pct: pct, closePos: closePos, bodyRatio: bodyRatio, volume: volume };
}

function deriveMultiTimeframeContext(candles) {
  if (!candles || candles.length < 2) {
    return { tf_1d_context: 'Belum cukup data', tf_2d_context: 'Belum cukup data', tf_3d_context: 'Belum cukup data', tf_5d_context: 'Belum cukup data', tf_10d_context: 'Belum cukup data', tf_20d_context: 'Belum cukup data', multi_timeframe_bias: 'unknown', multi_timeframe_notes: 'Data kurang', mtf_source: 'none', _daily: null, _weekly: null, _monthly: null };
  }
  var len = candles.length;
  var tf1d = classifyCandle(candles[len - 1], len >= 2 ? candles[len - 2] : null);
  var tf2d = len >= 2 ? classifyAggregatedCandles(candles.slice(-2)) : { bias: 'neutral', label: 'Belum cukup data' };
  var tf3d = len >= 3 ? classifyAggregatedCandles(candles.slice(-3)) : { bias: 'neutral', label: 'Belum cukup data' };
  var tf5d = len >= 5 ? classifyAggregatedCandles(candles.slice(-5)) : { bias: 'neutral', label: 'Belum cukup data' };
  var tf10d = len >= 10 ? classifyAggregatedCandles(candles.slice(-10)) : { bias: 'neutral', label: 'Belum cukup data' };
  var tf20d = len >= 20 ? classifyAggregatedCandles(candles.slice(-20)) : { bias: 'neutral', label: 'Belum cukup data' };

  var bias = 'neutral';
  var mtfNotes = [];
  if (tf1d.bias === 'bullish' && tf5d.bias === 'bullish') { bias = 'bullish'; mtfNotes.push('1D+5D bullish aligned'); }
  else if (tf1d.bias === 'bullish' && tf5d.bias === 'bearish') { bias = 'mixed_caution'; mtfNotes.push('1D bullish tapi 5D bearish — konfirmasi lemah'); }
  else if (tf1d.bias === 'bearish' && tf5d.bias === 'bearish') { bias = 'bearish'; mtfNotes.push('1D+5D bearish aligned — tekanan jual dominan'); }
  else if (tf1d.bias === 'bearish' && tf5d.bias === 'bullish') { bias = 'pullback'; mtfNotes.push('1D bearish tapi 5D bullish — potensi pullback sehat'); }

  if (tf20d.bias === 'bearish' && bias !== 'bearish') {
    mtfNotes.push('20D bearish — big picture tekanan turun');
    if (bias === 'bullish') bias = 'mixed_caution';
  } else if (tf20d.bias === 'bullish' && bias !== 'bullish') {
    mtfNotes.push('20D bullish — big picture masih positif');
  }
  if (tf5d.highVolRed) mtfNotes.push('5D red candle high-volume — swing risk');
  if (tf20d.downtrend) mtfNotes.push('20D downtrend — hindari agresif');

  return {
    tf_1d_context: tf1d.label,
    tf_2d_context: tf2d.label,
    tf_3d_context: tf3d.label,
    tf_5d_context: tf5d.label + ' (5D Approx)',
    tf_10d_context: tf10d.label,
    tf_20d_context: tf20d.label + ' (20D Approx)',
    multi_timeframe_bias: bias,
    multi_timeframe_notes: mtfNotes.length ? mtfNotes.join('; ') : null,
    mtf_source: 'daily_aggregation',
    _daily: tf1d,
    _weekly: tf5d,
    _monthly: tf20d
  };
}

function analyzeVolumePriceAction(p) {
  p = p || {};
  var volumeToday = toNum(p.volume_today, 0);
  var avg20 = toNum(p.avg_volume_20d, 0);
  var avg3 = toNum(p.volume_3d_avg, avg20 || volumeToday);
  var avg7 = toNum(p.volume_7d_avg, avg20 || volumeToday);
  var changePct = toNum(p.change_pct, 0);
  var closePos = p.close_position != null ? toNum(p.close_position, 0.5) : 0.5;
  var bodyRatio = p.body_ratio != null ? toNum(p.body_ratio, 0.5) : 0.5;
  var isGreen = !!p.is_green;
  var nearResistance = !!p.near_resistance;
  var failedBreakout = !!p.failed_breakout;
  var volRatio20 = avg20 > 0 ? volumeToday / avg20 : 1;
  var volRatio3 = avg3 > 0 ? volumeToday / avg3 : volRatio20;
  var volRatio7 = avg7 > 0 ? volumeToday / avg7 : volRatio20;
  var isHighVol = volRatio20 >= 1.8 || volRatio7 >= 1.8 || volRatio3 >= 1.8;
  var isLowVol = volRatio20 < 0.7;
  var signal = 'NORMAL';
  var phase = 'NORMAL';
  var notes = [];
  var score = 0;

  if (isHighVol && !isGreen && closePos < 0.4) {
    signal = 'DISTRIBUTION'; phase = 'DISTRIBUTION_RISK'; score = -15;
    notes.push('Vol tinggi + red close weak: distribusi/tekanan jual');
  } else if (isHighVol && isGreen && closePos > 0.65) {
    signal = 'MARKUP'; phase = 'MARKUP_CONFIRMATION'; score = 10;
    notes.push('Vol tinggi + green close near high: markup/akumulasi');
    if (changePct > 5) { score = 3; notes.push('Tapi sudah extended +' + changePct.toFixed(1) + '%'); }
  } else if (isHighVol && bodyRatio < 0.3) {
    signal = 'ABSORPTION'; phase = 'ABSORPTION'; score = 0;
    notes.push('Vol tinggi + narrow body/long wicks: absorption/battle zone');
  } else if (isHighVol && failedBreakout) {
    signal = 'FAILED_BREAKOUT'; phase = 'FAILED_BREAKOUT_RISK'; score = -18;
    notes.push('Vol tinggi + failed breakout: bull trap/distribution risk');
  } else if (isHighVol && nearResistance && closePos < 0.5) {
    signal = 'REJECTION'; phase = 'FAILED_BREAKOUT_RISK'; score = -12;
    notes.push('Vol tinggi dekat resistance + rejection: waspadai bull trap');
  } else if (isLowVol && changePct > 0.5) {
    signal = 'WEAK_RALLY'; phase = 'WEAK_VOLUME'; score = -5;
    notes.push('Vol rendah + naik: rally lemah, bukan breakout kuat');
  } else if (isLowVol && changePct < 0 && changePct > -2) {
    signal = 'NORMAL_PULLBACK'; phase = 'NORMAL'; score = 0;
    notes.push('Vol rendah + turun ringan: pullback normal jika support hold');
  } else if (volRatio3 >= 1.3 && volRatio7 >= 1.2 && isGreen) {
    signal = 'VOLUME_BUILDUP'; phase = 'ACCUMULATION_WATCH'; score = 5;
    notes.push('Volume build-up 3D/7D: possible accumulation');
  }

  return { volume_signal: signal, volume_phase: phase, volume_notes: notes.join('; '), volume_score: score, volume_today_vs_3d: round2(volRatio3), volume_today_vs_7d: round2(volRatio7), volume_today_vs_20d: round2(volRatio20) };
}

function calculateRiskLabel(p) {
  if (!p) return { risk_label: 'High Risk', risk_score: 70, risk_notes: ['No data'] };
  var score = 0;
  var notes = [];
  var mode = p.mode || 'swing';
  var isSwing = (mode !== 'daytrade');
  var minRR = isSwing ? 1.5 : 1.2;

  var rr = toNum(p.risk_reward, 0);
  if (rr < 1.0) { score += 25; notes.push('RR sangat rendah (' + rr.toFixed(2) + ')'); }
  else if (rr < minRR) { score += 15; notes.push('RR < min ' + minRR + ' (' + rr.toFixed(2) + ')'); }
  else if (!isSwing && rr < 1.5) { score += 14; notes.push('RR day trade belum ideal (' + rr.toFixed(2) + ')'); }
  else if (rr >= 2.5) { score -= 5; }

  if (p.weekly_bias === 'bearish') { score += isSwing ? 12 : 8; notes.push('5D/weekly bearish'); }
  else if (p.weekly_bias === 'bullish') { score -= 3; }

  if (p.monthly_bias === 'bearish') { score += isSwing ? 10 : 8; notes.push('20D/monthly bearish'); }
  if (p.monthly_downtrend) { score += isSwing ? 5 : 4; notes.push('20D/monthly downtrend'); }

  if (p.volume_phase === 'DISTRIBUTION_RISK') { score += 18; notes.push('Distribusi terdeteksi'); }
  else if (p.volume_phase === 'FAILED_BREAKOUT_RISK') { score += 15; notes.push('Failed breakout risk'); }
  else if (p.volume_phase === 'ABSORPTION') { score += 6; notes.push('Volume spike belum clean'); }

  var chaseDistPct = toNum(p.chase_distance_pct, 0);
  if (chaseDistPct > 5) { score += 20; notes.push('Chase risk tinggi (+' + chaseDistPct.toFixed(1) + '%)'); }
  else if (chaseDistPct > 3) { score += 10; notes.push('Harga di atas entry +' + chaseDistPct.toFixed(1) + '%'); }

  if (p.supply_nearby) { score += 8; notes.push('Supply/resistance dekat'); }

  var atrPct = toNum(p.atr_pct, 0);
  if (atrPct > 5 && isSwing) { score += 8; notes.push('Volatilitas tinggi (ATR ' + atrPct.toFixed(1) + '%)'); }

  var volRatio = p.volume_ratio_20d != null ? toNum(p.volume_ratio_20d, null) : null;
  if (p.avg_tx_value_7d != null && toNum(p.avg_tx_value_7d, 0) < 500000000) {
    score += 10; notes.push('Likuiditas rendah');
  } else if (volRatio != null && volRatio < 0.5) {
    score += 10; notes.push('Volume sangat rendah');
  }
  if (volRatio != null && volRatio >= 4) {
    score += isSwing ? 8 : 14;
    notes.push('Volume spike ' + volRatio.toFixed(2) + 'x — rawan chase');
  } else if (volRatio != null && volRatio >= 2.5 && !isSwing) {
    score += 6;
    notes.push('Volume tinggi — tunggu pullback valid');
  }

  if (p.board === 'AKSELERASI') { score += 15; notes.push('Papan Akselerasi'); }
  else if (p.board === 'PEMANTAUAN_KHUSUS' || p.is_fca) { score += 30; notes.push('FCA/Pemantauan Khusus'); }

  if (p.data_stale) { score += 8; notes.push('Data stale'); }
  if (p.candle_failed_breakout) { score += 12; notes.push('Candle failed breakout'); }

  var rsi = p.rsi14 != null ? toNum(p.rsi14, null) : null;
  if (rsi != null && rsi > 80) { score += 8; notes.push('RSI overbought ' + Math.round(rsi)); }
  else if (rsi != null && rsi < 25) { score += 5; notes.push('RSI sangat oversold'); }

  if (p.multi_timeframe_bias === 'mixed_caution') { score += isSwing ? 8 : 6; notes.push('Multi-timeframe mixed'); }
  else if (p.multi_timeframe_bias === 'bearish') { score += isSwing ? 12 : 8; notes.push('Multi-timeframe bearish'); }

  if (volRatio != null && volRatio < 0.8 && volRatio >= 0.5) { score += isSwing ? 5 : 6; notes.push('Volume di bawah rata-rata'); }

  if (p.volume_phase === 'MARKUP_CONFIRMATION' && rr >= minRR && !(volRatio != null && volRatio >= 4)) { score -= 5; }
  if (p.multi_timeframe_bias === 'bullish' && rr >= (isSwing ? 1.5 : 1.7)) { score -= 5; }

  score = Math.max(0, Math.min(100, score));

  var label;
  if (score >= 60) label = 'Very High Risk';
  else if (score >= 40) label = 'High Risk';
  else if (score >= 20) label = 'Medium Risk';
  else label = 'Low Risk';

  return { risk_label: label, risk_score: score, risk_notes: notes.length ? notes : ['Tidak ada faktor risiko signifikan'] };
}

function calculateQualityGrade(p) {
  if (!p) return { grade: 'C', grade_reason: 'No data' };
  var mode = p.mode || 'swing';
  var minRR = mode === 'daytrade' ? 1.2 : 1.5;
  var rr = toNum(p.risk_reward, 0);
  var riskLabel = p.risk_label || 'Medium Risk';
  var volPhase = p.volume_phase || 'NORMAL';
  var mtfBias = p.multi_timeframe_bias || 'neutral';
  var tickNormalized = p.tick_normalized !== false;
  var chaseDistPct = toNum(p.chase_distance_pct, 0);

  if (riskLabel === 'Very High Risk') return { grade: 'Avoid', grade_reason: 'Risk sangat tinggi' };
  if (volPhase === 'DISTRIBUTION_RISK') return { grade: 'Avoid', grade_reason: 'Distribusi terdeteksi' };
  if (volPhase === 'FAILED_BREAKOUT_RISK') return { grade: 'Avoid', grade_reason: 'Failed breakout' };
  if (rr < 1.0) return { grade: 'Avoid', grade_reason: 'RR tidak valid (<1.0)' };
  if (p.data_stale) return { grade: 'C', grade_reason: 'Data stale — perlu validasi' };
  if (!tickNormalized) return { grade: 'C', grade_reason: 'Tick normalization gagal — level tidak valid' };

  var isA = rr >= minRR && tickNormalized && (riskLabel === 'Low Risk' || riskLabel === 'Medium Risk') && volPhase !== 'WEAK_VOLUME' && volPhase !== 'DISTRIBUTION_RISK' && volPhase !== 'FAILED_BREAKOUT_RISK' && (mtfBias === 'bullish' || mtfBias === 'pullback' || mtfBias === 'neutral') && chaseDistPct <= 3 && (p.volume_ratio_20d == null || toNum(p.volume_ratio_20d, 0) >= 0.8);
  if (isA && riskLabel === 'Low Risk' && rr >= 2.0 && mtfBias === 'bullish') return { grade: 'A', grade_reason: 'Setup kuat — RR baik, MTF aligned, volume ok' };
  if (isA) return { grade: 'A', grade_reason: 'Setup valid — RR ok, risk terkontrol, konfirmasi cukup' };

  var isB = rr >= minRR * 0.8 && riskLabel !== 'Very High Risk' && riskLabel !== 'High Risk' && volPhase !== 'DISTRIBUTION_RISK' && volPhase !== 'FAILED_BREAKOUT_RISK' && chaseDistPct <= 5;
  if (isB) {
    var bReason = [];
    if (rr < minRR) bReason.push('RR sedikit di bawah ideal');
    if (mtfBias === 'mixed_caution') bReason.push('MTF mixed');
    if (chaseDistPct > 3) bReason.push('sedikit extended');
    if (p.volume_ratio_20d != null && toNum(p.volume_ratio_20d, 0) < 0.8) bReason.push('volume kurang');
    return { grade: 'B', grade_reason: bReason.length ? bReason.join(', ') : 'Setup usable, ada weakness' };
  }

  if (riskLabel === 'High Risk') return { grade: 'C', grade_reason: 'High risk — watchlist only, perlu konfirmasi' };
  return { grade: 'C', grade_reason: 'Setup belum lengkap — tunggu konfirmasi' };
}

module.exports = {
  getIdxTickSize: getIdxTickSize,
  roundToIdxTick: roundToIdxTick,
  normalizeIdxPriceLevel: normalizeIdxPriceLevel,
  normalizeTradingPlanLevels: normalizeTradingPlanLevels,
  deriveEntryStatus: deriveEntryStatus,
  normalizeLevelsToIdxTicks: normalizeLevelsToIdxTicks,
  deriveMultiTimeframeContext: deriveMultiTimeframeContext,
  classifyCandle: classifyCandle,
  classifyAggregatedCandles: classifyAggregatedCandles,
  analyzeVolumePriceAction: analyzeVolumePriceAction,
  calculateRiskLabel: calculateRiskLabel,
  calculateQualityGrade: calculateQualityGrade
};
