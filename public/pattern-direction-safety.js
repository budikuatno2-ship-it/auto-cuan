(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260731-pattern-direction-safety-v1';
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

  function textOf(node) {
    return String(node && node.textContent || '').trim();
  }

  function levelsFromCard(card) {
    var result = {};
    Array.prototype.forEach.call(card.querySelectorAll('.ps-level'), function (level) {
      var label = textOf(level.querySelector('span')).toLowerCase();
      var value = parseLocalizedNumber(textOf(level.querySelector('b')));
      if (label.indexOf('harga terakhir') >= 0) result.current = value;
      else if (label.indexOf('konfirmasi') >= 0) result.confirmation = value;
      else if (label.indexOf('invalidasi') >= 0) result.invalidation = value;
      else if (label === 'tp1' || label.indexOf('target') >= 0 && /1\b/.test(label)) result.tp1 = value;
      else if (label === 'tp2' || label.indexOf('target') >= 0 && /2\b/.test(label)) result.tp2 = value;
    });
    return result;
  }

  function planFromBox(box) {
    var result = {};
    Array.prototype.forEach.call(box.querySelectorAll('.ps-screener-level'), function (level) {
      var label = textOf(level.querySelector('span')).toLowerCase();
      var raw = textOf(level.querySelector('b'));
      if (label === 'entry') {
        var range = parseRange(raw);
        result.entry_low = range.low;
        result.entry_high = range.high;
      } else if (label.indexOf('stop') >= 0) result.stop_loss = parseLocalizedNumber(raw);
      else if (label === 'tp1') result.tp1 = parseLocalizedNumber(raw);
      else if (label === 'tp2') result.tp2 = parseLocalizedNumber(raw);
    });
    return result;
  }

  function ensureWarning(card, kind, message) {
    var warning = card.querySelector('.ps-direction-warning[data-warning-kind="' + kind + '"]');
    if (!warning) {
      warning = card.ownerDocument.createElement('div');
      warning.className = 'ps-direction-warning';
      warning.setAttribute('data-warning-kind', kind);
      var actions = card.querySelector('.ps-card-actions');
      actions ? card.insertBefore(warning, actions) : card.appendChild(warning);
    }
    warning.textContent = message;
    return warning;
  }

  function normalizeAbcdCard(card, direction) {
    var name = textOf(card.querySelector('.ps-name'));
    if (!/\bABCD\b/i.test(name)) return;
    Array.prototype.forEach.call(card.querySelectorAll('.ps-level span'), function (node) {
      node.textContent = normalizeLevelLabel(node.textContent, direction);
    });
    var safety = evaluateAbcdLevels(levelsFromCard(card), direction);
    if (safety.actionable) {
      card.removeAttribute('data-pattern-safety');
      var old = card.querySelector('.ps-direction-warning[data-warning-kind="pattern-levels"]');
      if (old) old.remove();
      return;
    }
    card.setAttribute('data-pattern-safety', safety.reason || 'not_actionable');
    var badge = card.querySelector('.ps-badge');
    if (badge) badge.textContent = 'Tidak actionable';
    ensureWarning(card, 'pattern-levels', safety.reason === 'target_already_reached'
      ? 'Target pattern sudah terlewati. Kartu ini hanya menjadi catatan pola, bukan area entry baru.'
      : 'Urutan atau status level pattern tidak lagi aman untuk entry. Verifikasi ulang di Chart sebelum mengambil keputusan.');
  }

  function filterSetupChips(card, direction) {
    var rejected = 0;
    var accepted = 0;
    Array.prototype.forEach.call(card.querySelectorAll('.ps-setup-chip'), function (chip) {
      var bias = labelDirection(chip.textContent);
      var conflict = (direction === 'bullish' && bias === 'bearish') || (direction === 'bearish' && bias === 'bullish');
      chip.hidden = conflict;
      chip.setAttribute('data-label-direction', bias);
      if (conflict) rejected += 1; else accepted += 1;
    });
    var source = card.querySelector('.ps-setup-source');
    if (source && rejected > 0) {
      source.textContent = accepted > 0
        ? 'Hanya label Screener yang searah ditampilkan; ' + rejected + ' label berlawanan arah disembunyikan.'
        : 'Konteks Screener berlawanan arah dengan Pattern; ' + rejected + ' label disembunyikan agar tidak terlihat sebagai konfirmasi.';
    }
  }

  function guardScreenerPlan(card, direction) {
    var box = card.querySelector('.ps-screener-plan');
    if (!box || box.getAttribute('data-direction-checked') === '1') return;
    var planDirection = tradePlanDirection(planFromBox(box));
    box.setAttribute('data-direction-checked', '1');
    box.setAttribute('data-plan-direction', planDirection);
    if (directionsCompatible(direction, planDirection)) {
      var title = box.querySelector('.ps-screener-plan-title');
      if (title && planDirection !== 'unknown' && title.textContent.indexOf('· ' + planDirection) < 0) {
        title.textContent += ' · ' + (planDirection === 'bullish' ? 'Bullish/Long' : 'Bearish/Short');
      }
      return;
    }
    var source = textOf(box.querySelector('.ps-screener-plan-title')).replace(/^Level Screener\s*·\s*/i, '') || 'Screener';
    box.classList.add('direction-conflict');
    box.setAttribute('data-direction-conflict', '1');
    box.innerHTML = '<div class="ps-screener-plan-title">Konflik arah · level Screener disembunyikan</div>' +
      '<p class="ps-screener-conflict-text">Pattern ' + direction + ', sedangkan rencana ' + source + ' bersifat ' +
      (planDirection === 'bullish' ? 'bullish/long' : (planDirection === 'bearish' ? 'bearish/short' : 'tidak konsisten')) +
      '. Keduanya tidak digabung sebagai setup masuk.</p>';
  }

  function processCard(card) {
    if (!card || !card.querySelector) return;
    var direction = cardDirection(card);
    normalizeAbcdCard(card, direction);
    filterSetupChips(card, direction);
    guardScreenerPlan(card, direction);
    card.setAttribute('data-direction-safety-version', VERSION);
  }

  function processScope(scope) {
    if (!scope || !scope.querySelectorAll) return;
    if (scope.matches && scope.matches('#page-pattern .ps-card')) processCard(scope);
    Array.prototype.forEach.call(scope.querySelectorAll('#page-pattern .ps-card'), processCard);
  }

  function install(root) {
    if (!root || !root.document || root.__AUTOCUAN_PATTERN_DIRECTION_SAFETY__) return false;
    root.__AUTOCUAN_PATTERN_DIRECTION_SAFETY__ = VERSION;
    var doc = root.document;
    var style = doc.createElement('style');
    style.id = 'patternDirectionSafetyStyles';
    style.textContent = [
      '.ps-direction-warning{margin-top:10px;padding:9px 10px;border:1px solid rgba(251,191,36,.28);border-radius:10px;background:rgba(245,158,11,.08);color:#fcd34d;font-size:10px;line-height:1.5}',
      '.ps-screener-plan.direction-conflict{border-color:rgba(248,113,113,.28);background:rgba(239,68,68,.07)}',
      '.ps-screener-plan.direction-conflict .ps-screener-plan-title{color:#fca5a5}',
      '.ps-screener-conflict-text{margin:0;color:#fecaca;font-size:10px;line-height:1.55}',
      '.ps-setup-chip[data-label-direction="bearish"]{border-color:rgba(248,113,113,.24);background:rgba(239,68,68,.07);color:#fecaca}'
    ].join('');
    doc.head.appendChild(style);

    var scheduled = false;
    function schedule(scope) {
      if (scheduled) return;
      scheduled = true;
      root.setTimeout(function () {
        scheduled = false;
        processScope(scope && scope.querySelectorAll ? scope : doc);
      }, 30);
    }
    processScope(doc);
    new root.MutationObserver(function (records) {
      records.forEach(function (record) {
        Array.prototype.forEach.call(record.addedNodes || [], function (node) {
          if (node && node.nodeType === 1) schedule(node);
        });
      });
      schedule(doc);
    }).observe(doc.body, { childList:true, subtree:true });
    return true;
  }

  return {
    version:VERSION,
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
    install:install
  };
});
