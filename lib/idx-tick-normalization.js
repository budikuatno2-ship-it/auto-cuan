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

function isStaleCandidate(candidate) {
  var txt = [
    candidate && candidate.data_stale ? 'stale' : '',
    candidate && candidate.is_stale ? 'stale' : '',
    candidate && candidate.freshness_is_stale ? 'stale' : '',
    candidate && candidate.stale_label,
    candidate && candidate.stale_notes,
    candidate && candidate.freshness_label
  ].filter(Boolean).join(' ').toLowerCase();
  return txt.indexOf('stale') >= 0;
}

function addLevelWarning(candidate, text) {
  if (!candidate || !text) return;
  var existing = candidate.level_validation_note || candidate.validation_note || candidate.status_note || '';
  candidate.level_validation_note = existing && existing.indexOf(text) === -1 ? (existing + '; ' + text) : (existing || text);
}

function derivePlanQuality(candidate) {
  candidate = candidate || {};
  var entryLow = firstNum(candidate, ['entry_low', 'entry1', 'entry_1']);
  var entryHigh = firstNum(candidate, ['entry_high', 'entry2', 'entry_2']);
  if (entryLow != null && entryHigh != null && entryLow > entryHigh) {
    var tmp = entryLow; entryLow = entryHigh; entryHigh = tmp;
  }
  var entryRef = entryHigh || entryLow || firstNum(candidate, ['current_price', 'last_price', 'close']);
  var sl = firstNum(candidate, ['stop_loss', 'sl']);
  var tp1 = firstNum(candidate, ['tp1', 'tp1n', 'target_1', 'target1']);
  var tp2 = firstNum(candidate, ['tp2', 'tp2n', 'target_2', 'target2']);
  var support = firstNum(candidate, ['support']);
  var resistance = firstNum(candidate, ['resistance']);
  var rr = candidate.risk_reward != null ? toNum(candidate.risk_reward, null) : null;
  var tp1Upside = candidate.tp1_upside != null ? toNum(candidate.tp1_upside, null) : (entryRef && tp1 ? round2((tp1 - entryRef) / entryRef * 100) : null);
  var mode = String(candidate.mode || candidate.category || '').toLowerCase();
  var isDay = mode.indexOf('day') >= 0;
  var minRR = candidate.rr_minimum != null ? toNum(candidate.rr_minimum, isDay ? 1.2 : 1.5) : (isDay ? 1.2 : 1.5);

  var slLabel = 'Data terbatas';
  var tpLabel = 'Data terbatas';
  var rrLabel = 'RR sehat';
  var notes = [];

  if (!entryLow || !entryRef || !sl) {
    slLabel = 'Data terbatas';
    notes.push('Data entry/SL terbatas.');
  } else {
    var slRiskPct = ((entryRef - sl) / entryRef) * 100;
    if (sl >= entryLow) {
      slLabel = 'SL invalid';
      notes.push('SL berada di atas atau sama dengan batas bawah entry.');
    } else if (slRiskPct < 1) {
      slLabel = 'SL terlalu mepet';
      notes.push('Jarak SL dari entry kurang dari 1%.');
    } else if (slRiskPct > 12) {
      slLabel = 'SL terlalu jauh';
      notes.push('Jarak SL dari entry lebih dari 12%.');
    } else if (support && sl > support) {
      slLabel = 'SL rawan noise';
      notes.push('SL masih di atas support, rawan tersentuh noise.');
    } else {
      slLabel = 'SL wajar';
    }
  }

  if (!entryRef || !tp1) {
    tpLabel = 'Data terbatas';
    notes.push('Data entry/TP terbatas.');
  } else if (tp1 <= entryRef) {
    tpLabel = 'TP invalid';
    notes.push('TP1 tidak berada di atas entry.');
  } else if (tp2 && tp2 < tp1) {
    tpLabel = 'TP invalid';
    notes.push('TP2 lebih rendah dari TP1.');
  } else if (tp1Upside != null && isDay && tp1Upside > 20) {
    tpLabel = 'TP terlalu jauh';
    notes.push('TP1 upside di atas 20% untuk day trade.');
  } else if (tp1Upside != null && !isDay && tp1Upside > 35) {
    tpLabel = 'TP ambisius';
    notes.push('TP1 upside di atas 35% untuk swing.');
  } else if (resistance && tp1 > resistance * 1.08) {
    tpLabel = 'TP ambisius';
    notes.push('TP1 lebih dari 8% di atas resistance.');
  } else {
    tpLabel = 'TP realistis';
  }

  if (rr != null && rr < minRR) {
    rrLabel = 'RR kurang menarik';
    notes.push('RR di bawah minimum kategori (' + minRR + ':1).');
  }

  var status = 'OK';
  var label = 'Plan realistis';
  if (slLabel === 'SL invalid' || tpLabel === 'TP invalid') { status = 'INVALID'; label = 'Wait / Invalid'; }
  else if (rrLabel === 'RR kurang menarik') { status = 'POOR_RR'; label = 'Wait - Poor RR'; }
  else if (slLabel !== 'SL wajar' || (tpLabel !== 'TP realistis' && tpLabel !== 'Data terbatas')) { status = 'WARNING'; label = 'Plan perlu hati-hati'; }
  else if (slLabel === 'Data terbatas' || tpLabel === 'Data terbatas') { status = 'LIMITED'; label = 'Data terbatas'; }

  return {
    plan_quality_status: status,
    plan_quality_label: label,
    plan_quality_note: notes.join(' ') || 'SL, TP, dan RR masih realistis terhadap entry/support/resistance.',
    sl_quality_label: slLabel,
    tp_quality_label: tpLabel,
    rr_quality_label: rrLabel
  };
}

function deriveInvalidationDistance(candidate) {
  candidate = candidate || {};
  var price = firstNum(candidate, ['current_price', 'last_price', 'lastn', 'close']);
  var sl = firstNum(candidate, ['stop_loss', 'sl', 'invalidation', 'invalidation_level']);
  var distancePct = (price != null && sl != null && price > 0) ? round2(((price - sl) / price) * 100) : null;
  var status = 'NO_DATA';
  var label = 'Data terbatas';
  var note = 'Harga atau level invalidasi/SL belum tersedia.';
  if (price != null && sl != null) {
    if (price <= sl) {
      status = 'INVALID_BELOW_SL';
      label = 'Invalid / Below SL';
      note = 'Harga sudah berada di bawah/menyentuh invalidation level; setup tidak boleh dianggap entry-ready.';
    } else if (distancePct <= 1) {
      status = 'TOO_CLOSE_TO_SL';
      label = 'Too Close to SL';
      note = 'Jarak harga ke SL terlalu mepet; risiko noise tinggi, tunggu level lebih rapi.';
    } else if (distancePct <= 2.5) {
      status = 'INVALIDATION_NEAR';
      label = 'Invalidation Near';
      note = 'Harga dekat invalidation level; wajib revalidasi support dan volume.';
    } else {
      status = 'HEALTHY_BUFFER';
      label = 'Healthy Buffer';
      note = 'Jarak harga ke invalidation level masih memberi buffer risiko.';
    }
  }
  return {
    invalidation_distance_pct: distancePct,
    invalidation_distance_status: status,
    invalidation_distance_label: label,
    invalidation_note: note
  };
}

function validateTradingPlanSanity(candidate) {
  candidate = candidate || {};
  var entryLow = firstNum(candidate, ['entry_low', 'entry1', 'entry_1']);
  var entryHigh = firstNum(candidate, ['entry_high', 'entry2', 'entry_2']);
  if (entryLow != null && entryHigh != null && entryLow > entryHigh) {
    var tmp = entryLow; entryLow = entryHigh; entryHigh = tmp;
  }
  var entry = entryHigh || entryLow;
  var sl = firstNum(candidate, ['stop_loss', 'sl']);
  var tp1 = firstNum(candidate, ['tp1', 'tp1n', 'target_1', 'target1']);
  var tp2 = firstNum(candidate, ['tp2', 'tp2n', 'target_2', 'target2']);
  var rr = candidate.risk_reward != null ? toNum(candidate.risk_reward, null) : null;
  var levels = [entryLow, entryHigh, sl, tp1, tp2];
  var invalid = [];
  if (!entryLow || !entryHigh || !sl || !tp1 || !tp2) invalid.push('Ada level entry/SL/TP kosong.');
  if (entry != null && sl != null && !(sl < entry)) invalid.push('SL harus di bawah Entry.');
  if (entry != null && tp1 != null && !(tp1 > entry)) invalid.push('TP1 harus di atas Entry.');
  if (tp1 != null && tp2 != null && !(tp2 >= tp1)) invalid.push('TP2 harus sama/di atas TP1.');
  if (rr == null || !isFinite(rr) || rr <= 0) invalid.push('RR tidak valid.');
  for (var i = 0; i < levels.length; i++) {
    if (levels[i] == null || !isFinite(levels[i]) || !isValidIdxPriceLevel(levels[i])) {
      invalid.push('Level harga belum sesuai tick size IDX.');
      break;
    }
  }
  var ok = invalid.length === 0;
  return {
    trading_plan_valid: ok,
    trading_plan_status: ok ? 'VALID' : 'INVALID',
    trading_plan_note: ok ? 'Trading plan lolos sanity check: SL < Entry, TP valid, RR valid, dan level sesuai tick IDX.' : invalid.join(' '),
    action_guard_label: ok ? null : 'Wait / Level belum rapi'
  };
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
    if (isStaleCandidate(candidate)) {
      status = 'NEEDS_REVALIDATION';
      label = 'Needs Revalidation';
      note = 'Data stale — validasi ulang harga/volume sebelum entry. Tidak boleh dianggap Entry/Ready.';
      chase = 'Stale';
    }
    return {
      entry_status: status,
      entry_status_label: label,
      entry_status_note: note,
      entry_quality_status: status,
      entry_quality_label: label,
      entry_safety_note: note,
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

function deriveBreakoutConfirmation(candidate) {
  candidate = candidate || {};
  var close = firstNum(candidate, ['close', 'last_price', 'current_price', 'lastn']);
  var high = firstNum(candidate, ['high_price', 'high']);
  var resistance = firstNum(candidate, ['breakout_trigger', 'trigger_price', 'reclaim_level', 'resistance']);
  var label = 'Needs Close Confirmation';
  var status = 'NEEDS_CLOSE_CONFIRMATION';
  var note = 'Resistance/trigger atau close belum lengkap; tunggu konfirmasi close.';
  var falseRisk = false;

  if (close != null && resistance != null) {
    if (close > resistance) {
      status = 'BREAKOUT_CONFIRMED';
      label = 'Breakout Confirmed';
      note = 'Close sudah berada di atas resistance/trigger ' + resistance + '.';
    } else if (high != null && high > resistance && close <= resistance) {
      status = 'FALSE_BREAKOUT_RISK';
      label = 'False Breakout Risk';
      falseRisk = true;
      note = 'High sempat pierce resistance ' + resistance + ', tetapi close gagal bertahan di atasnya.';
    } else {
      status = 'BREAKOUT_WATCH';
      label = close >= resistance * 0.985 ? 'Breakout Watch' : 'Needs Close Confirmation';
      note = 'Belum breakout confirmed; butuh close di atas ' + resistance + '.';
    }
  }
  return {
    breakout_confirmation_status: status,
    breakout_confirmation_label: label,
    breakout_confirmation_note: note,
    false_breakout_risk: falseRisk
  };
}

function deriveSetupFreshness(candidate, opts) {
  candidate = candidate || {};
  opts = opts || {};
  var ts = candidate.freshness_timestamp || candidate.calculated_at || candidate.run_at || candidate.updated_at || candidate.last_checked_at || candidate.created_at || candidate.first_sent_at || opts.freshness_timestamp || opts.calculated_at || opts.run_at || opts.updated_at || opts.last_checked_at || opts.created_at || opts.first_sent_at || null;
  var price = firstNum(candidate, ['current_price', 'last_price', 'lastn', 'close']);
  var entryLow = firstNum(candidate, ['entry_low', 'entry2', 'entry_2']);
  var entryHigh = firstNum(candidate, ['entry_high', 'entry1', 'entry_1']);
  if (entryLow != null && entryHigh != null && entryLow > entryHigh) { var t = entryLow; entryLow = entryHigh; entryHigh = t; }
  var sl = firstNum(candidate, ['stop_loss', 'sl']);
  var ageMinutes = null;
  var status = 'NEEDS_REVALIDATION';
  var label = 'Needs Revalidation';
  var note = 'Timestamp setup tidak jelas; validasi ulang harga/volume.';

  if (ts) {
    var d = new Date(ts);
    if (!isNaN(d.getTime())) {
      var nowMs = opts.now != null ? new Date(opts.now).getTime() : Date.now();
      if (isNaN(nowMs)) nowMs = Date.now();
      ageMinutes = Math.max(0, Math.round((nowMs - d.getTime()) / 60000));
      if (price != null && sl != null && price <= sl) {
        status = 'EXPIRED'; label = 'Expired'; note = 'Setup invalid karena harga sudah menyentuh/di bawah SL.';
      } else if (price != null && entryHigh != null && price > entryHigh * 1.05) {
        status = 'EXPIRED'; label = 'Expired'; note = 'Harga sudah terlalu jauh dari entry; tunggu pullback/revalidasi.';
      } else if (ageMinutes > 240) {
        status = 'EXPIRED'; label = 'Expired'; note = 'Setup terlalu lama untuk konteks intraday; perlu scan baru.';
      } else if (ageMinutes > 90) {
        status = 'AGING'; label = 'Aging'; note = 'Setup mulai menua tetapi belum invalid; wajib cek ulang harga/volume.';
      } else {
        status = 'FRESH'; label = 'Fresh'; note = 'Setup baru dan belum menunjukkan kondisi invalid.';
      }
    }
  }
  return {
    setup_age_minutes: ageMinutes,
    setup_age_hours: ageMinutes != null ? round2(ageMinutes / 60) : null,
    setup_freshness_status: status,
    setup_freshness_label: label,
    setup_expiry_note: note
  };
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
  Object.assign(out, validateTradingPlanSanity(out));
  if (!out.trading_plan_valid) valid = false;
  if (!valid) {
    out.tick_normalized = false;
    addLevelWarning(out, 'Level harga belum valid');
    addLevelWarning(out, 'Trading plan perlu validasi ulang');
    if (!out.telegram_verdict) out.telegram_verdict = 'Wait - Level belum rapi';
    if (out.action && String(out.action).toLowerCase().indexOf('buy') !== -1) out.action = 'Wait - Level belum rapi';
  }
  Object.assign(out, derivePlanQuality(out));
  if (!out.trading_plan_valid) {
    out.plan_quality_status = 'INVALID';
    out.plan_quality_label = 'Wait / Level belum rapi';
    out.plan_quality_note = out.trading_plan_note;
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


function deriveRiskLabelV2(candidate) {
  var p = candidate || {};
  var score = 0;
  var factors = [];
  function add(points, note) { score += points; if (note && factors.indexOf(note) < 0) factors.push(note); }
  function norm(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/[\s-]+/g, '_'); }
  function label(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

  var entry = norm(p.entry_status);
  if (entry === 'BELOW_ENTRY') add(10, 'Harga di bawah entry');
  else if (entry === 'ABOVE_ENTRY') add(15, 'Harga di atas entry');
  else if (entry === 'CHASE_RISK') add(30, 'Harga sudah chase');
  else if (entry === 'EXTENDED') add(40, 'Harga sudah extended');
  else if (entry === 'TP1_NEAR' || entry === 'TP1_HIT' || entry === 'TP2_HIT') add(35, 'Harga dekat/di target');
  else if (entry === 'INVALID_BELOW_SL') add(80, 'Harga sudah invalid');
  else if (entry === 'IN_ENTRY_AREA' || entry === 'NEAR_ENTRY') add(0, null);

  var plan = norm(p.plan_quality_status || p.plan_quality_label);
  if (plan === 'LIMITED') add(10, 'Plan terbatas');
  else if (plan === 'WARNING') add(20, 'Plan perlu waspada');
  else if (plan === 'POOR_RR') add(35, 'RR kurang menarik');
  else if (plan === 'INVALID') add(80, 'Plan invalid');

  var sl = label(p.sl_quality_label);
  if (sl === 'sl rawan noise') add(15, 'SL rawan noise');
  else if (sl === 'sl terlalu mepet') add(20, 'SL terlalu mepet');
  else if (sl === 'sl terlalu jauh') add(20, 'SL terlalu jauh');
  else if (sl === 'sl invalid') add(80, 'SL invalid');

  var rr = label(p.rr_quality_label);
  var tp = label(p.tp_quality_label);
  if (rr === 'rr kurang menarik') add(30, 'RR kurang menarik');
  if (tp === 'tp ambisius') add(15, 'TP ambisius');
  else if (tp === 'tp terlalu jauh') add(25, 'TP terlalu jauh');
  else if (tp === 'tp invalid') add(80, 'TP invalid');

  var liq = label(p.liquidity_label || p.liquidity);
  if (liq === 'likuiditas sedang' || liq === 'medium liquidity') add(10, 'Likuiditas sedang');
  else if (liq.indexOf('tipis') >= 0 || liq.indexOf('illiquid') >= 0 || liq.indexOf('thin') >= 0) add(30, 'Likuiditas tipis');
  var stale = label(p.stale_label || p.stale_notes || (p.data_stale ? 'data stale' : ''));
  if (stale.indexOf('stale') >= 0) add(25, 'Data stale');
  else if (stale.indexOf('terbatas') >= 0 || stale.indexOf('limited') >= 0) add(10, 'Data terbatas');

  var vol = label(p.volume_label || p.volume_confirmation_label || p.volume_notes);
  if (vol.indexOf('belum konfirmasi') >= 0) add(15, 'Volume belum konfirmasi');
  else if (vol.indexOf('lemah') >= 0 || vol.indexOf('weak') >= 0) add(10, 'Volume lemah');

  var board = label(p.board || p.papan);
  if (board.indexOf('pengembangan') >= 0 || board.indexOf('development') >= 0) add(10, 'Papan Pengembangan');
  else if (board.indexOf('akselerasi') >= 0 || board.indexOf('acceleration') >= 0 || board.indexOf('watchlist') >= 0 || board.indexOf('pemantauan') >= 0) add(20, 'Papan risiko tinggi');

  score = Math.max(0, Math.min(100, Math.round(score)));
  var riskLabel = score >= 76 ? 'Very High Risk' : (score >= 51 ? 'High Risk' : (score >= 26 ? 'Medium Risk' : 'Low Risk'));
  return {
    risk_label_v2: riskLabel,
    risk_score_v2: score,
    risk_notes_v2: factors.length ? factors.join('; ') : 'Tidak ada faktor risiko v2 signifikan',
    risk_factors_v2: factors
  };
}


function capConfidenceGrade(value, maxGrade) {
  var v = String(value || '').trim().toUpperCase();
  if (!v) return value;
  var order = { 'AVOID': 0, 'C': 1, 'B': 2, 'A': 3, 'A+': 4 };
  var max = order[String(maxGrade || '').toUpperCase()];
  if (max == null || order[v] == null || order[v] <= max) return value;
  return maxGrade;
}

function deriveSignalVerdict(candidate) {
  var r = candidate || {};
  var entry = String(r.entry_quality_status || r.entry_status || '').toUpperCase();
  var plan = String(r.plan_quality_status || r.trading_plan_status || '').toUpperCase();
  var risk = String(r.risk_label_v2 || r.risk_label || r.verified_risk_label || '').toLowerCase();
  var rr = String(r.rr_quality_label || '').toLowerCase();
  var sl = String(r.sl_quality_label || '').toLowerCase();
  var tp = String(r.tp_quality_label || '').toLowerCase();
  var liq = String(r.liquidity_label || r.liquidity || '').toLowerCase();
  var vol = String(r.volume_label || r.volume_confirmation_label || r.volume_phase || '').toLowerCase();
  var trend = String(r.trend_label || r.multi_timeframe_bias || '').toLowerCase();
  var stale = String(r.stale_label || r.stale_notes || '').toLowerCase();
  var respect = String(r.respect_quality_label || '').toLowerCase();
  var respectInvalid = String(r.respect_invalid_reason || '').toLowerCase();
  var half = String(r.half_candle_label || r.half_candle_status || '').toLowerCase();
  var noteText = [r.notes, r.status_reason, r.entry_timing, r.time_plan, r.telegram_verdict, r.candle_note, r.respect_zone_notes, r.entry_status_note, r.plan_quality_note, r.liquidity_notes, r.stale_notes, r.chase_risk_label].filter(Boolean).join(' ').toLowerCase();
  var badges = [];
  function addBadge(b) { if (b && badges.indexOf(b) === -1) badges.push(b); }
  function hasAny(text, words) { return words.some(function(w) { return text.indexOf(w) >= 0; }); }
  function buildPlan(action, reason) {
    var label = 'Watchlist, konfirmasi belum lengkap.';
    var planReason = reason || 'Setup masih perlu konfirmasi tambahan.';
    if (action === 'Hindari') label = 'Hindari, risiko terlalu tinggi.';
    else if (action === 'Entry') label = 'Entry area valid, ikuti plan dengan SL disiplin.';
    else if (hasAny(noteText, ['half-candle debt', '1/2 candle debt', 'bayar 1/2', 'bayar half'])) label = 'Tunggu bayar 1/2 candle sebelum entry.';
    else if (hasAny(noteText, ['reclaim 1/2', 'reclaim half', 'reclaim midpoint'])) label = 'Tunggu reclaim 1/2 candle.';
    else if (entry === 'BELOW_ENTRY') label = 'Tunggu reclaim area entry.';
    else if (entry === 'CHASE_RISK' || entry === 'EXTENDED' || hasAny(noteText, ['pullback', 'menjauh dari entry', 'chase'])) label = 'Tunggu pullback ke Entry 1/Entry 2.';
    else if (action === 'Wait') label = 'Tunggu konfirmasi/pullback ke area entry.';
    if (sl === 'sl rawan noise' || sl === 'sl terlalu mepet') {
      label = 'SL rawan noise, kecilkan sizing atau tunggu area lebih aman.';
      planReason = 'Stop loss terlalu dekat dengan harga/entry sehingga mudah tersentuh noise.';
    }
    return { plan_label: label, plan_reason: planReason, plan_priority: action === 'Hindari' ? 90 : (action === 'Entry' ? 50 : (action === 'Wait' ? 40 : 30)) };
  }
  function out(signalAction, actionLabel, reason, priority, maxGrade) {
    var planOut = buildPlan(actionLabel, reason);
    var verdict = actionLabel + ' — ' + reason;
    return {
      signal_action: signalAction,
      signal_verdict: verdict,
      signal_reason: reason,
      signal_priority: priority,
      signal_badges: badges,
      signal_action_label: actionLabel,
      signal_confidence: capConfidenceGrade(r.confidence || r.grade || r.quality_grade, maxGrade),
      action_label: actionLabel,
      action_reason: reason,
      action_priority: priority,
      plan_label: planOut.plan_label,
      plan_reason: planOut.plan_reason,
      plan_priority: planOut.plan_priority
    };
  }

  var invalidRespect = respect === 'weak / ignore' || respectInvalid || hasAny(noteText, ['failed respect', 'gagal respect', 'weak ignore']);
  var planValid = plan === 'OK' || plan === 'VALID';
  var chaseExtended = entry === 'CHASE_RISK' || entry === 'EXTENDED' || hasAny(noteText, ['chase', 'extended', 'long candle']);
  var staleData = stale.indexOf('stale') >= 0 || stale.indexOf('terbatas') >= 0 || r.data_stale || r.is_stale;
  var weakLiquidity = liq.indexOf('tipis') >= 0 || liq.indexOf('illiquid') >= 0 || liq.indexOf('thin') >= 0 || liq.indexOf('weak') >= 0;
  var supportBreak = entry === 'INVALID_BELOW_SL' || hasAny(noteText, ['below support', 'break support', 'breakdown support', 'half-candle low', 'di bawah support']);

  if (entry === 'INVALID_BELOW_SL' || plan === 'INVALID' || sl === 'sl invalid' || tp === 'tp invalid') {
    addBadge('Plan invalid');
    return out('AVOID', 'Hindari', 'Trading plan invalid atau level kunci sudah jebol.', 100, 'C');
  }
  if (risk === 'very high risk') { addBadge('Very High Risk'); return out('AVOID', 'Hindari', 'Risk Label Very High Risk.', 95, 'C'); }
  if (invalidRespect) { addBadge('Respect invalid'); return out('AVOID', 'Hindari', r.respect_invalid_reason || 'Respect candle gagal/Weak Ignore.', 92, 'C'); }
  if (chaseExtended) { addBadge('Anti-chase'); return out('WAIT_PULLBACK', 'Hindari', 'Harga chase/extended setelah candle panjang.', 88, entry === 'CHASE_RISK' ? 'B' : 'C'); }
  if (rr === 'rr kurang menarik' || plan === 'POOR_RR') { addBadge('Poor RR'); return out('WAIT_CONFIRMATION', 'Hindari', 'RR terlalu rendah untuk entry baru.', 84, 'C'); }
  if (staleData) { addBadge('Data stale'); return out('DATA_LIMITED', 'Hindari', 'Data stale/terbatas, perlu validasi ulang.', 82, 'C'); }
  if (weakLiquidity) { addBadge('Likuiditas lemah'); return out('AVOID', 'Hindari', 'Likuiditas terlalu lemah untuk eksekusi aman.', 80, 'C'); }
  if (supportBreak) { addBadge('Support break'); return out('AVOID', 'Hindari', 'Harga break support/half-candle low.', 78, 'C'); }

  if ((entry === 'IN_ENTRY_AREA' || entry === 'NEAR_ENTRY') && planValid && (risk === 'low risk' || risk === 'medium risk') && rr !== 'rr kurang menarik' && !chaseExtended && !staleData && (respect === '' || respect === 'valid respect' || respect === 'strong respect')) {
    addBadge(risk === 'low risk' ? 'Low Risk' : 'Medium Risk');
    return out('ENTRY_AREA', 'Entry', 'Harga berada di area entry, risiko terkendali, RR acceptable.', 55, null);
  }
  if (entry === 'BELOW_ENTRY' || entry === 'WAIT_PULLBACK' || half.indexOf('debt') >= 0 || hasAny(noteText, ['waiting for pullback', 'tunggu pullback', 'bayar 1/2', 'reclaim 1/2'])) {
    addBadge('Wait setup');
    return out('WAIT_PULLBACK', 'Wait', 'Setup cukup, tetapi entry/konfirmasi belum lengkap.', 45, null);
  }
  if (respect === 'watchlist respect' || respect === 'valid respect' || risk === 'medium risk' || risk === 'high risk' || vol.indexOf('belum') >= 0 || vol.indexOf('weak') >= 0 || vol.indexOf('lemah') >= 0 || trend.indexOf('weak') >= 0 || trend.indexOf('lemah') >= 0 || trend.indexOf('bearish') >= 0) {
    addBadge('Watchlist');
    return out('WATCHLIST', 'Watchlist', 'Setup pantauan; konfirmasi volume/trend/context belum lengkap.', 35, null);
  }
  return out('WATCHLIST', 'Watchlist', 'Fallback konservatif, tunggu konfirmasi.', 25, null);
}

function applyRiskV2ConfidenceGuard(candidate) {
  var r = candidate || {};
  var risk = r.risk_label_v2 || (deriveRiskLabelV2(r).risk_label_v2);
  if (risk === 'Very High Risk') {
    if (r.confidence === 'A+' || r.confidence === 'A' || r.confidence === 'B') r.confidence = 'C';
    if (!r.telegram_verdict || /buy|beli|siap/i.test(r.telegram_verdict)) r.telegram_verdict = 'Wait/Avoid — Risk v2 sangat tinggi.';
  } else if (risk === 'High Risk') {
    if (r.confidence === 'A+' || r.confidence === 'A') r.confidence = 'B';
  }
  return r;
}


function getIdxAutoRejectBand(referencePrice, opts) {
  opts = opts || {};
  var ref = toNum(referencePrice, null);
  if (ref == null || !isFinite(ref) || ref <= 0) return null;
  var label = 'normal_board_assumption';
  var board = String(opts.board || opts.board_type || '').toUpperCase();
  if (board && board !== 'UNKNOWN') label = 'normal_board';
  var ara = 0.35;
  if (ref > 5000) ara = 0.20;
  else if (ref > 200) ara = 0.25;
  return { ara_pct: round2(ara * 100), arb_pct: -15, ara_multiplier: 1 + ara, arb_multiplier: 0.85, ara_band_label: label };
}

function deriveIdxAutoRejectLevels(input) {
  input = input || {};
  var refKeys = ['reference_price', 'previous_close', 'prev_close', 'prior_close', 'close_prev', 'prevClose', 'previousClose'];
  var ref = null;
  var source = 'missing_reference';
  for (var ri = 0; ri < refKeys.length; ri++) {
    var key = refKeys[ri];
    var val = firstNum(input, [key]);
    if (val != null) { ref = val; source = key; break; }
  }
  var band = getIdxAutoRejectBand(ref, input);
  if (!band) return {
    ara_price: null, arb_price: null, ara_pct: null, arb_pct: null, ara_room_pct: null, arb_room_pct: null,
    ara_band_label: 'insufficient_reference', ara_arb_source: 'missing_reference',
    ara_arb_note: 'ARA/ARB belum dihitung karena prev close/reference price tidak tersedia.',
    near_ara: false, near_arb: false, tp1_beyond_ara: false, tp2_beyond_ara: false, sl_below_arb: false,
    intraday_realistic_cap: null, tp1_intraday_realistic: null, tp2_intraday_realistic: null,
    tp_realism_note: 'ARA/ARB belum tersedia; baca TP dari candle potential saja.'
  };
  var ara = roundToIdxTick(ref * band.ara_multiplier, 'floor');
  var arb = roundToIdxTick(ref * band.arb_multiplier, 'ceil');
  var last = firstNum(input, ['current_price', 'last_price', 'lastn', 'close']);
  var tp1 = firstNum(input, ['tp1', 'tp1n', 'target_1', 'target1']);
  var tp2 = firstNum(input, ['tp2', 'tp2n', 'target_2', 'target2']);
  var sl = firstNum(input, ['stop_loss', 'sl']);
  var araRoom = last && ara ? round2((ara - last) / last * 100) : null;
  var arbRoom = last && arb ? round2((arb - last) / last * 100) : null;
  var out = {
    ara_price: ara, arb_price: arb, ara_pct: band.ara_pct, arb_pct: band.arb_pct,
    ara_room_pct: araRoom, arb_room_pct: arbRoom, ara_band_label: band.ara_band_label,
    ara_arb_source: source,
    ara_arb_note: 'ARA/ARB dihitung dari reference price ' + ref + ' memakai band normal IDX dan tick size.',
    near_ara: araRoom != null ? araRoom <= 3 : false,
    near_arb: arbRoom != null ? arbRoom >= -3 : false,
    tp1_beyond_ara: !!(tp1 && ara && tp1 > ara),
    tp2_beyond_ara: !!(tp2 && ara && tp2 > ara),
    sl_below_arb: !!(sl && arb && sl < arb),
    intraday_realistic_cap: ara,
    tp1_intraday_realistic: tp1 && ara ? tp1 <= ara : null,
    tp2_intraday_realistic: tp2 && ara ? tp2 <= ara : null,
    tp_realism_note: null
  };
  if (out.tp1_beyond_ara) out.tp_realism_note = 'TP1 melewati ARA hari ini; target intraday terbatas.';
  else if (out.tp2_beyond_ara) out.tp_realism_note = 'TP1 realistis · TP2 lanjutan/multi-day.';
  else if (out.tp1_intraday_realistic) out.tp_realism_note = out.tp2_intraday_realistic ? 'TP1 realistis · TP2 realistis intraday jika momentum lanjut.' : 'TP1 realistis.';
  if (out.near_ara) out.ara_arb_note += ' Harga dekat ARA; jangan chase agresif.';
  return out;
}

function deriveCandlePotentialRange(input) {
  input = input || {};
  var guard = deriveIdxAutoRejectLevels(input);
  var last = firstNum(input, ['current_price', 'last_price', 'lastn', 'close']);
  var high = firstNum(input, ['high_price', 'high']);
  var low = firstNum(input, ['low_price', 'low']);
  var atr = firstNum(input, ['atr14', 'atr', 'average_true_range']);
  var resistance = firstNum(input, ['resistance', 'resistance1', 'r1']);
  var support = firstNum(input, ['support', 'support1', 's1']);
  if (!last && !high && !low) return Object.assign({}, guard, {
    candle_potential_low: null, candle_potential_high: null, candle_potential_label: 'Data terbatas',
    candle_potential_note: 'Potensi candle belum cukup data.'
  });
  var baseLow = low || support || last;
  var baseHigh = high || resistance || last;
  var room = atr || (high && low ? Math.max(1, high - low) : (last ? last * 0.03 : 0));
  var potLow = Math.min(baseLow, last ? last - room * 0.35 : baseLow);
  var potHigh = Math.max(baseHigh, last ? last + room * 0.65 : baseHigh);
  if (resistance) potHigh = Math.max(potHigh, resistance);
  if (support) potLow = Math.min(potLow, support);
  if (guard.ara_price) potHigh = Math.min(potHigh, guard.ara_price);
  if (guard.arb_price) potLow = Math.max(potLow, guard.arb_price);
  potLow = roundToIdxTick(potLow, 'floor');
  potHigh = roundToIdxTick(potHigh, 'ceil');
  var note = 'Potensi candle konservatif berbasis OHLC/range/resistance-support yang tersedia.';
  var tp1 = firstNum(input, ['tp1', 'tp1n', 'target_1', 'target1']);
  var tp2 = firstNum(input, ['tp2', 'tp2n', 'target_2', 'target2']);
  var tp1Real = tp1 && potHigh && guard.ara_price ? (tp1 <= potHigh && tp1 <= guard.ara_price) : guard.tp1_intraday_realistic;
  var tp2Real = tp2 && potHigh && guard.ara_price ? (tp2 <= potHigh && tp2 <= guard.ara_price) : guard.tp2_intraday_realistic;
  var realism = guard.tp_realism_note;
  if (guard.ara_arb_source === 'missing_reference') realism = 'ARA/ARB belum tersedia; baca TP dari candle potential saja.';
  if (tp1 && potHigh && tp1 > potHigh) realism = guard.ara_arb_source === 'missing_reference' ? 'ARA/ARB belum tersedia; baca TP dari candle potential saja. TP1 butuh breakout lanjutan; potensi candle belum mendukung.' : 'TP1 butuh breakout lanjutan; potensi candle belum mendukung.';
  else if (tp2Real) realism = 'TP1 realistis · TP2 realistis intraday jika momentum lanjut.';
  else if (tp1Real && (tp2 || guard.tp2_beyond_ara)) realism = 'TP1 realistis · TP2 lanjutan/multi-day.';
  else if (guard.tp2_beyond_ara) realism = 'TP1 realistis · TP2 lanjutan/multi-day.';
  else if (tp1Real) realism = 'TP1 realistis.';
  return Object.assign({}, guard, {
    candle_potential_low: potLow,
    candle_potential_high: potHigh,
    candle_potential_label: potLow && potHigh ? (potLow + '–' + potHigh) : 'Data terbatas',
    candle_potential_note: note,
    tp1_intraday_realistic: tp1Real,
    tp2_intraday_realistic: tp2Real,
    tp_realism_note: realism || guard.tp_realism_note,
    entry_basis_note: input.entry_basis_note || 'Entry basis mengikuti level deterministic screener.'
  });
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
  deriveBreakoutConfirmation: deriveBreakoutConfirmation,
  deriveSetupFreshness: deriveSetupFreshness,
  derivePlanQuality: derivePlanQuality,
  deriveEntryStatus: deriveEntryStatus,
  deriveInvalidationDistance: deriveInvalidationDistance,
  validateTradingPlanSanity: validateTradingPlanSanity,
  normalizeLevelsToIdxTicks: normalizeLevelsToIdxTicks,
  deriveMultiTimeframeContext: deriveMultiTimeframeContext,
  classifyCandle: classifyCandle,
  classifyAggregatedCandles: classifyAggregatedCandles,
  analyzeVolumePriceAction: analyzeVolumePriceAction,
  calculateRiskLabel: calculateRiskLabel,
  deriveRiskLabelV2: deriveRiskLabelV2,
  applyRiskV2ConfidenceGuard: applyRiskV2ConfidenceGuard,
  deriveSignalVerdict: deriveSignalVerdict,
  calculateQualityGrade: calculateQualityGrade,
  getIdxAutoRejectBand: getIdxAutoRejectBand,
  deriveIdxAutoRejectLevels: deriveIdxAutoRejectLevels,
  deriveCandlePotentialRange: deriveCandlePotentialRange
};
