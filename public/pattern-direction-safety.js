(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanPatternSafety = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // This module is the Pattern safety *model*. It used to also be a DOM patcher:
  // install() registered a MutationObserver on document.body, re-read every
  // rendered level by scraping `.ps-level b` text, parsed those Indonesian
  // number strings back into floats, and then wrote labels, badges and warning
  // text back into the cards.
  //
  // Two measured defects came out of that:
  //   1. Every write it performed (textContent on each level label, on the
  //      badge, on the warning) was itself a mutation, so the observer refired
  //      and rescheduled a full-document rescan 30 ms later, forever. Measured
  //      on a scanned Pattern page: 7014 DOM mutations in 4 idle seconds versus
  //      44 on the same build before Pattern was opened — and because the
  //      observer watched document.body, the loop kept running at ~5500/4s
  //      after navigating back to the Dashboard, for the rest of the session.
  //   2. Actionability was decided from re-parsed display strings. `num()`
  //      formats with maximumFractionDigits:2, so a level of 1015.8437 became
  //      "1.015,84" and came back as 1015.84. Safety comparisons such as
  //      `current >= tp1` were therefore evaluated on rounded copies of numbers
  //      the renderer already held exactly.
  //
  // The renderer now calls evaluateRow() with the authoritative candidate object
  // and renders a card that is correct on first paint. No observer, no scraping,
  // no re-parsing. The pure functions below are unchanged and remain the single
  // definition of direction and actionability.
  var VERSION = '20260813-pattern-direction-safety-v2';
  var BULLISH_LABEL = /\b(?:bull(?:ish)?|uptrend|ascending|double bottom|inverse head|cup and handle|vcp|before rally|reclaim)\b/i;
  var BEARISH_LABEL = /\b(?:bear(?:ish)?|downtrend|descending|double top|head and shoulders|rising wedge|inverted cup|distribution)\b/i;

  function finite(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function parseLocalizedNumber(value) {
    var text = String(value == null ? '' : value)
      .replace(/\s+/g, '')
      .replace(/[^0-9,.-]/g, '');
    if (!text || text === '-' || text === '—') return null;
    if (text.indexOf(',') >= 0 && text.indexOf('.') >= 0) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else if (text.indexOf(',') >= 0) {
      text = text.replace(',', '.');
    } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(text)) {
      text = text.replace(/\./g, '');
    }
    return finite(text);
  }

  function parseRange(value) {
    var parts = String(value == null ? '' : value).split(/[–—-]/).map(parseLocalizedNumber).filter(function (number) {
      return number != null;
    });
    if (!parts.length) return { low:null, high:null };
    if (parts.length === 1) return { low:parts[0], high:parts[0] };
    return { low:Math.min(parts[0], parts[1]), high:Math.max(parts[0], parts[1]) };
  }

  function cardDirection(card) {
    if (!card || !card.classList) return 'unknown';
    if (card.classList.contains('bullish')) return 'bullish';
    if (card.classList.contains('bearish')) return 'bearish';
    if (card.classList.contains('bilateral')) return 'bilateral';
    return 'unknown';
  }

  function labelDirection(value) {
    var text = String(value == null ? '' : value).trim();
    var bullish = BULLISH_LABEL.test(text);
    var bearish = BEARISH_LABEL.test(text);
    if (bullish && !bearish) return 'bullish';
    if (bearish && !bullish) return 'bearish';
    return 'neutral';
  }

  function filterLabelsForDirection(labels, direction) {
    var accepted = [];
    var rejected = [];
    (Array.isArray(labels) ? labels : []).forEach(function (label) {
      var bias = labelDirection(label);
      if ((direction === 'bullish' && bias === 'bearish') || (direction === 'bearish' && bias === 'bullish')) rejected.push(label);
      else accepted.push(label);
    });
    return { accepted:accepted, rejected:rejected };
  }

  function tradePlanDirection(plan) {
    if (!plan) return 'unknown';
    var low = finite(plan.entry_low);
    var high = finite(plan.entry_high);
    if (low == null && high != null) low = high;
    if (high == null && low != null) high = low;
    if (low == null || high == null) return 'unknown';
    var entryLow = Math.min(low, high);
    var entryHigh = Math.max(low, high);
    var stop = finite(plan.stop_loss);
    var tp1 = finite(plan.tp1);
    var tp2 = finite(plan.tp2);
    if (stop == null || tp1 == null) return 'unknown';

    var bullish = stop < entryLow && tp1 > entryHigh && (tp2 == null || tp2 >= tp1);
    var bearish = stop > entryHigh && tp1 < entryLow && (tp2 == null || tp2 <= tp1);
    if (bullish === bearish) return 'unknown';
    return bullish ? 'bullish' : 'bearish';
  }

  function directionsCompatible(patternDirection, planDirection) {
    if (patternDirection === 'bilateral') return planDirection === 'bullish' || planDirection === 'bearish';
    if (patternDirection === 'unknown' || planDirection === 'unknown') return false;
    return patternDirection === planDirection;
  }

  function normalizeLevelLabel(label, direction) {
    var text = String(label == null ? '' : label).trim();
    var lower = text.toLowerCase();
    if (lower.indexOf('harga terakhir') >= 0 || lower === 'prz' || lower === 'bias' || lower.indexOf('keyakinan') >= 0) return text;
    if (lower.indexOf('konfirmasi') >= 0) {
      if (direction === 'bearish') return 'Konfirmasi Turun';
      if (direction === 'bullish') return 'Entry / Konfirmasi';
      return 'Konfirmasi Pattern';
    }
    if (lower.indexOf('invalidasi') >= 0) {
      if (direction === 'bearish') return 'Batas Invalidasi Atas';
      if (direction === 'bullish') return 'Stop Loss / Invalidasi';
      return 'Batas Invalidasi';
    }
    if (lower === 'tp1' || /target.*1/.test(lower)) return direction === 'bearish' ? 'Target Turun 1' : (direction === 'bullish' ? 'Target Naik 1' : 'Target 1');
    if (lower === 'tp2' || /target.*2/.test(lower)) return direction === 'bearish' ? 'Target Turun 2' : (direction === 'bullish' ? 'Target Naik 2' : 'Target 2');
    return text;
  }

  function evaluateAbcdLevels(values, direction) {
    var current = finite(values && values.current);
    var confirmation = finite(values && values.confirmation);
    var invalidation = finite(values && values.invalidation);
    var tp1 = finite(values && values.tp1);
    var tp2 = finite(values && values.tp2);
    var reasons = [];
    if ([current, confirmation, invalidation, tp1, tp2].some(function (value) { return value == null; })) {
      return { actionable:false, reason:'incomplete_levels' };
    }
    if (direction === 'bullish') {
      if (!(invalidation < confirmation && tp1 > confirmation && tp2 >= tp1)) reasons.push('inconsistent_level_order');
      if (current <= invalidation) reasons.push('invalidation_reached');
      if (current >= tp1) reasons.push('target_already_reached');
    } else if (direction === 'bearish') {
      if (!(invalidation > confirmation && tp1 < confirmation && tp2 <= tp1)) reasons.push('inconsistent_level_order');
      if (current >= invalidation) reasons.push('invalidation_reached');
      if (current <= tp1) reasons.push('target_already_reached');
    }
    return { actionable:reasons.length === 0, reason:reasons[0] || null, reasons:reasons };
  }

  // ---------------------------------------------------------------------------
  // Model entry point used by the renderer.
  //
  // `row` is the object the Pattern scan already holds: { ticker, candidate,
  // classicPatterns, context, dataDate, currentPrice }. `plan` is the Screener
  // trade plan for the same ticker, or null. Every number read below comes from
  // those objects directly — never from rendered text.
  // ---------------------------------------------------------------------------

  var STATUS = {
    ACTIONABLE: 'actionable',
    AWAITING: 'awaiting_confirmation',
    TARGET_REACHED: 'target_already_reached',
    INVALIDATED: 'invalidation_reached',
    INCONSISTENT: 'inconsistent_level_order',
    INCOMPLETE: 'incomplete_levels',
    CONTEXT_ONLY: 'context_only'
  };

  var STATUS_TEXT = {
    actionable: {
      badge: 'Siap dipantau',
      tone: 'ok',
      note: 'Harga masih berada di antara invalidasi dan target pertama. Konfirmasi manual tetap diperlukan sebelum entry.'
    },
    awaiting_confirmation: {
      badge: 'Menunggu konfirmasi',
      tone: 'wait',
      note: 'Pola sudah terbentuk, tetapi harga belum menembus level konfirmasi.'
    },
    target_already_reached: {
      badge: 'Target terlewati',
      tone: 'muted',
      note: 'Harga sudah melewati target pertama. Kartu ini menjadi catatan pola, bukan area entry baru.'
    },
    invalidation_reached: {
      badge: 'Sudah invalid',
      tone: 'danger',
      note: 'Harga sudah menembus batas invalidasi, jadi rencana pola ini tidak berlaku lagi.'
    },
    inconsistent_level_order: {
      badge: 'Level tidak konsisten',
      tone: 'danger',
      note: 'Urutan konfirmasi, invalidasi, dan target tidak masuk akal untuk arah pola ini. Periksa ulang di Chart.'
    },
    incomplete_levels: {
      badge: 'Level tidak lengkap',
      tone: 'muted',
      note: 'Sebagian level pola tidak tersedia, jadi kelayakan entry tidak dapat dinilai.'
    },
    context_only: {
      badge: 'Konteks pola',
      tone: 'muted',
      note: 'Pola klasik tidak membawa level entry. Gunakan sebagai konteks arah, bukan rencana masuk.'
    }
  };

  function patternDirection(row) {
    var candidate = row && row.candidate;
    if (candidate && candidate.name) return labelDirection(candidate.name) === 'bearish' ? 'bearish' : 'bullish';
    var primary = (row && row.classicPatterns && row.classicPatterns[0]) || null;
    if (!primary) return 'unknown';
    var bias = labelDirection(primary.bias || primary.label || primary.type);
    return bias === 'neutral' ? 'bilateral' : bias;
  }

  // Confirmation is a *state*, not just a level: the engine already reports
  // whether a close confirmed the pattern. A pattern whose price sits between
  // invalidation and TP1 but has not confirmed is "awaiting", not "actionable".
  function evaluateRow(row, plan) {
    var direction = patternDirection(row);
    var candidate = row && row.candidate;
    var labels = filterLabelsForDirection((plan && plan.labels) || [], direction);
    var planDirection = plan ? tradePlanDirection(plan) : 'unknown';
    var planCompatible = plan ? directionsCompatible(direction, planDirection) : false;

    if (!candidate) {
      return {
        direction: direction,
        status: STATUS.CONTEXT_ONLY,
        actionable: false,
        reasons: [],
        levels: null,
        plan: plan || null,
        planDirection: planDirection,
        planCompatible: planCompatible,
        labels: labels
      };
    }

    var values = {
      current: finite(candidate.currentPrice != null ? candidate.currentPrice : row.currentPrice),
      confirmation: finite(candidate.confirmation),
      invalidation: finite(candidate.invalidation),
      tp1: finite(candidate.tp1),
      tp2: finite(candidate.tp2)
    };
    var evaluated = evaluateAbcdLevels(values, direction);
    var status;
    if (evaluated.actionable) {
      status = candidate.status === 'confirmed' ? STATUS.ACTIONABLE : STATUS.AWAITING;
    } else if (evaluated.reasons && evaluated.reasons.indexOf('invalidation_reached') >= 0) {
      status = STATUS.INVALIDATED;
    } else if (evaluated.reasons && evaluated.reasons.indexOf('inconsistent_level_order') >= 0) {
      status = STATUS.INCONSISTENT;
    } else if (evaluated.reason === 'incomplete_levels') {
      status = STATUS.INCOMPLETE;
    } else {
      status = STATUS.TARGET_REACHED;
    }

    return {
      direction: direction,
      status: status,
      actionable: status === STATUS.ACTIONABLE,
      reasons: evaluated.reasons || (evaluated.reason ? [evaluated.reason] : []),
      levels: values,
      plan: plan || null,
      planDirection: planDirection,
      planCompatible: planCompatible,
      labels: labels
    };
  }

  function statusText(status) {
    return STATUS_TEXT[status] || STATUS_TEXT.context_only;
  }

  // Ordering the grid by decision value: what a user can act on comes first,
  // then what is still forming, then what is only a record of something past.
  var RANK = {
    actionable: 0,
    awaiting_confirmation: 1,
    context_only: 2,
    target_already_reached: 3,
    incomplete_levels: 4,
    inconsistent_level_order: 5,
    invalidation_reached: 6
  };
  function statusRank(status) {
    return RANK[status] == null ? 9 : RANK[status];
  }

  return {
    version:VERSION,
    STATUS:STATUS,
    finite:finite,
    parseLocalizedNumber:parseLocalizedNumber,
    parseRange:parseRange,
    cardDirection:cardDirection,
    labelDirection:labelDirection,
    filterLabelsForDirection:filterLabelsForDirection,
    tradePlanDirection:tradePlanDirection,
    directionsCompatible:directionsCompatible,
    normalizeLevelLabel:normalizeLevelLabel,
    evaluateAbcdLevels:evaluateAbcdLevels,
    patternDirection:patternDirection,
    evaluateRow:evaluateRow,
    statusText:statusText,
    statusRank:statusRank
  };
});
