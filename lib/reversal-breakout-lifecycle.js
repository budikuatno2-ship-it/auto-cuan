'use strict';

const VERSION = 'reversal-breakout-lifecycle-v1';
const PHASES = Object.freeze({
  REVERSAL_EARLY: 'REVERSAL_EARLY',
  PRE_BREAKOUT: 'PRE_BREAKOUT',
  BREAKOUT_CONFIRMED: 'BREAKOUT_CONFIRMED',
  POST_BREAKOUT_CONTINUATION: 'POST_BREAKOUT_CONTINUATION',
  NONE: 'NONE',
  INVALIDATED: 'INVALIDATED'
});

const PHASE_NUMBER = Object.freeze({
  REVERSAL_EARLY: 1,
  PRE_BREAKOUT: 2,
  BREAKOUT_CONFIRMED: 3,
  POST_BREAKOUT_CONTINUATION: 4,
  NONE: 0,
  INVALIDATED: 0
});

const PHASE_LABEL = Object.freeze({
  REVERSAL_EARLY: 'Fase 1/4 — Reversal Awal',
  PRE_BREAKOUT: 'Fase 2/4 — Pre-Breakout',
  BREAKOUT_CONFIRMED: 'Fase 3/4 — Breakout Terkonfirmasi',
  POST_BREAKOUT_CONTINUATION: 'Fase 4/4 — Continuation Setelah Breakout',
  NONE: 'Belum masuk fase reversal/breakout',
  INVALIDATED: 'Lifecycle tidak valid / diblokir safety'
});

function finite(value) {
  var number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function upper(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function firstFinite(row, keys) {
  for (var i = 0; i < keys.length; i += 1) {
    var value = finite((row || {})[keys[i]]);
    if (value != null) return value;
  }
  return null;
}

function resolveMode(row, context) {
  var requested = String(context && context.mode || '').toLowerCase();
  if (requested === 'daytrade' || requested === 'day_trade') return 'daytrade';
  if (requested === 'swing') return 'swing';
  if (finite(row && row.daytrade_score) != null) return 'daytrade';
  return 'swing';
}

function deriveInputs(row) {
  row = row || {};
  var price = firstFinite(row, ['last_price', 'current_price', 'latest_price', 'price']);
  var resistance = firstFinite(row, ['resistance', 'breakout_level', 'resistance_level']);
  var support = firstFinite(row, ['support', 'swingLow5']);
  var entryHigh = firstFinite(row, ['entry_high', 'entryHigh']);
  var volumeRatio = firstFinite(row, ['effective_volume_ratio', 'volume_signal_ratio', 'volume_ratio_20d', 'volume_ratio_avg20']);
  var distanceToBreakout = firstFinite(row, ['distance_to_breakout_pct']);
  if (distanceToBreakout == null && price != null && price > 0 && resistance != null && resistance > 0) {
    distanceToBreakout = (resistance - price) / price * 100;
  }
  var chaseDistance = firstFinite(row, ['chase_distance_pct']);
  if (chaseDistance == null && price != null && price > 0 && entryHigh != null && entryHigh > 0) {
    chaseDistance = Math.max(0, (price - entryHigh) / entryHigh * 100);
  }
  return {
    price: price,
    resistance: resistance,
    support: support,
    entryHigh: entryHigh,
    volumeRatio: volumeRatio,
    rsi14: firstFinite(row, ['rsi14', 'rsi']),
    changePct: firstFinite(row, ['change_pct', 'changePercent']) || 0,
    distanceToBreakout: distanceToBreakout,
    chaseDistance: chaseDistance,
    status: upper(row.status || row.final_status || row.swing_tier || row.entry_status),
    setup: upper(row.setup || row.setup_label || row.setup_type || row.primary_smart_setup && row.primary_smart_setup.setup_type),
    breakoutStatus: upper(row.breakout_confirmation_status),
    volumePhase: upper(row.volume_phase),
    riskLabel: upper(row.risk_label_v2 || row.risk_label),
    nearAra: row.near_ara === true
  };
}

function isBlocked(row, context, input) {
  if (context && context.blocked === true) return true;
  if (!row) return true;
  if (row.data_quality_valid === false || row.data_quality_needs_revalidation === true) return true;
  if (upper(row.corporate_action_guard) === 'BLOCKED') return true;
  if (/AVOID|INVALID|INVALID_BELOW_SL|TP1_HIT|TP2_HIT/.test(input.status)) return true;
  if (/VERY HIGH RISK/.test(input.riskLabel)) return true;
  return false;
}

function volumeQuality(volumeRatio) {
  if (volumeRatio == null) return 'UNKNOWN';
  if (volumeRatio >= 1.5) return 'STRONG';
  if (volumeRatio >= 1.2) return 'VALID';
  if (volumeRatio >= 0.8) return 'BUILDING';
  return 'WEAK';
}

function chaseRisk(input) {
  if (input.nearAra) return 'HIGH';
  var distance = input.chaseDistance;
  var change = input.changePct || 0;
  if ((distance != null && distance >= 5) || change >= 7 ||
      (input.price != null && input.resistance != null && input.resistance > 0 && input.price >= input.resistance * 1.07)) return 'HIGH';
  if ((distance != null && distance >= 3) || change >= 4.5 ||
      (input.price != null && input.resistance != null && input.resistance > 0 && input.price >= input.resistance * 1.04)) return 'MEDIUM';
  return 'LOW';
}

function derivePhase(row, context) {
  var input = deriveInputs(row);
  var blocked = isBlocked(row, context, input);
  var volQuality = volumeQuality(input.volumeRatio);
  var chase = chaseRisk(input);

  if (blocked) {
    return {
      phase: PHASES.INVALIDATED,
      phase_number: 0,
      phase_label: PHASE_LABEL.INVALIDATED,
      confidence: 100,
      reason: 'Safety/data-quality guard memblokir lifecycle sebagai sinyal aktif.',
      volume_quality: volQuality,
      breakout_quality: 'BLOCKED',
      chase_risk: chase
    };
  }

  var priceAboveResistance = input.price != null && input.resistance != null && input.resistance > 0 && input.price >= input.resistance;
  var confirmed = input.breakoutStatus === 'BREAKOUT_CONFIRMED';
  var postByStatus = /MOMENTUM_CONTINUATION|CONTINUATION_AFTER_BREAKOUT|POST_BREAKOUT/.test(input.status + ' ' + input.setup);
  var readyByStatus = /READY_BREAKOUT|TRADE_CANDIDATE|A_PLUS_SETUP|A_PLUS_SWING/.test(input.status);
  var preByStatus = /EARLY_RADAR|PRE_SPIKE_WATCH|PRE_BREAKOUT|RESISTANCE_PRESSURE|VCP/.test(input.status + ' ' + input.setup);
  var reversalByStatus = /RECLAIM_CANDIDATE|REBOUND_CANDIDATE|REBOUND SPECULATIVE|BULLISH_HARAMI|DOUBLE_BOTTOM|INVERSE_HEAD|FALLING_WEDGE/.test(input.status + ' ' + input.setup);
  var extendedFollowThrough = confirmed && priceAboveResistance &&
    input.price >= input.resistance * 1.03 &&
    input.volumeRatio != null && input.volumeRatio >= 1.0 &&
    input.changePct >= 2.5 &&
    input.chaseDistance != null && input.chaseDistance >= 3;

  var phase = PHASES.NONE;
  var reason = 'Belum ada evidence yang cukup untuk fase reversal/breakout.';
  var confidence = 45;

  if (postByStatus || extendedFollowThrough) {
    phase = PHASES.POST_BREAKOUT_CONTINUATION;
    confidence = 68;
    reason = 'Harga sudah melewati fase breakout dan menunjukkan continuation/follow-through.';
  } else if (confirmed || (readyByStatus && priceAboveResistance && input.volumeRatio != null && input.volumeRatio >= 1.0)) {
    phase = PHASES.BREAKOUT_CONFIRMED;
    confidence = 72;
    reason = 'Breakout dikonfirmasi oleh status/level harga dengan volume yang memadai.';
  } else if (preByStatus || (input.distanceToBreakout != null && input.distanceToBreakout <= 3 && input.distanceToBreakout >= -1 && input.volumeRatio != null && input.volumeRatio >= 0.8)) {
    phase = PHASES.PRE_BREAKOUT;
    confidence = 64;
    reason = 'Harga menekan area resistance dengan volume mulai membangun, tetapi breakout belum final.';
  } else if (reversalByStatus || (input.support != null && input.price != null && input.price > input.support && input.rsi14 != null && input.rsi14 >= 30 && input.rsi14 <= 50 && input.changePct >= 0)) {
    phase = PHASES.REVERSAL_EARLY;
    confidence = 58;
    reason = 'Ada tanda awal pembalikan/reclaim dari area support, masih butuh konfirmasi lanjutan.';
  }

  if (phase !== PHASES.NONE) {
    if (volQuality === 'STRONG') confidence += 10;
    else if (volQuality === 'VALID') confidence += 6;
    else if (volQuality === 'WEAK') confidence -= 10;
    if (input.changePct > 0) confidence += 3;
    if (confirmed) confidence += 8;
    if (chase === 'HIGH') confidence -= 8;
    else if (chase === 'MEDIUM') confidence -= 3;
  }

  var breakoutQuality = 'UNCONFIRMED';
  if (phase === PHASES.BREAKOUT_CONFIRMED) {
    breakoutQuality = confirmed && volQuality === 'STRONG' ? 'STRONG' : (confirmed || volQuality === 'VALID' || volQuality === 'STRONG' ? 'VALID' : 'WEAK');
  } else if (phase === PHASES.POST_BREAKOUT_CONTINUATION) {
    breakoutQuality = volQuality === 'STRONG' ? 'FOLLOW_THROUGH_STRONG' : 'FOLLOW_THROUGH';
  } else if (phase === PHASES.PRE_BREAKOUT) {
    breakoutQuality = 'PRESSURE_BUILDING';
  } else if (phase === PHASES.REVERSAL_EARLY) {
    breakoutQuality = 'EARLY_REVERSAL';
  }

  return {
    phase: phase,
    phase_number: PHASE_NUMBER[phase] || 0,
    phase_label: PHASE_LABEL[phase] || PHASE_LABEL.NONE,
    confidence: clamp(Math.round(confidence), 0, 100),
    reason: reason,
    volume_quality: volQuality,
    breakout_quality: breakoutQuality,
    chase_risk: chase
  };
}

function scoreAdjustment(result) {
  if (!result || result.phase === PHASES.NONE || result.phase === PHASES.INVALIDATED) return 0;
  var adjustment = 0;
  if (result.phase === PHASES.REVERSAL_EARLY) adjustment = 1;
  else if (result.phase === PHASES.PRE_BREAKOUT) adjustment = 2;
  else if (result.phase === PHASES.BREAKOUT_CONFIRMED) adjustment = 3;
  else if (result.phase === PHASES.POST_BREAKOUT_CONTINUATION) adjustment = 1;

  if (result.chase_risk === 'HIGH') adjustment -= 2;
  else if (result.chase_risk === 'MEDIUM' && result.phase === PHASES.POST_BREAKOUT_CONTINUATION) adjustment -= 1;
  if (result.volume_quality === 'WEAK' && (result.phase === PHASES.BREAKOUT_CONFIRMED || result.phase === PHASES.POST_BREAKOUT_CONTINUATION)) adjustment -= 2;
  if (result.confidence < 60) adjustment = Math.min(adjustment, 1);
  return clamp(adjustment, -2, 3);
}

function applyLifecycle(row, context) {
  if (!row || typeof row !== 'object') return row;
  if (row.lifecycle_version === VERSION) return row;

  var mode = resolveMode(row, context);
  var result = derivePhase(row, context);
  var adjustment = scoreAdjustment(result);
  var applyScore = !(context && context.applyScore === false);

  row.lifecycle_version = VERSION;
  row.setup_phase = result.phase;
  row.setup_phase_number = result.phase_number;
  row.setup_phase_label = result.phase_label;
  row.phase_confidence = result.confidence;
  row.phase_reason = result.reason;
  row.breakout_quality = result.breakout_quality;
  row.volume_quality = result.volume_quality;
  row.chase_risk = result.chase_risk;
  row.lifecycle_score_adjustment = adjustment;
  row.lifecycle_score_applied = applyScore && adjustment !== 0;
  row.lifecycle_active = result.phase !== PHASES.NONE && result.phase !== PHASES.INVALIDATED;

  if (applyScore && mode === 'daytrade') {
    var daytradeScore = finite(row.daytrade_score);
    if (daytradeScore != null) {
      row.daytrade_score_before_lifecycle = daytradeScore;
      row.daytrade_score = clamp(daytradeScore + adjustment, 0, 100);
    }
  } else if (applyScore && mode === 'swing') {
    var swingScore = finite(row.score);
    if (swingScore != null) {
      row.score_before_lifecycle = swingScore;
      row.score = clamp(swingScore + adjustment, 0, 100);
    }
  }
  return row;
}

module.exports = {
  VERSION: VERSION,
  PHASES: PHASES,
  deriveInputs: deriveInputs,
  derivePhase: derivePhase,
  scoreAdjustment: scoreAdjustment,
  applyLifecycle: applyLifecycle
};