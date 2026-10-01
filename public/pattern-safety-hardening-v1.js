(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.AutoCuanPatternSafetyHardening = api;
    api.install(root);
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260813-pattern-safety-hardening-v1';

  // Pattern decisions may only consume explicit numeric values. JavaScript's
  // Number(null) / Number('') / Number(false) coercions all produce zero, which
  // makes missing data look like a real market level. Only a finite number or a
  // non-blank numeric string is accepted here.
  function safeFinite(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    var text = value.trim();
    if (!text) return null;
    var number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function tradePlanDirection(plan) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return 'unknown';
    var low = safeFinite(plan.entry_low);
    var high = safeFinite(plan.entry_high);
    var stop = safeFinite(plan.stop_loss);
    var tp1 = safeFinite(plan.tp1);
    var tp2 = safeFinite(plan.tp2);

    // A one-sided entry range is incomplete. Do not invent the missing edge by
    // copying the other side: an incomplete plan cannot be directional confluence.
    if (low == null || high == null || stop == null || tp1 == null) return 'unknown';

    var entryLow = Math.min(low, high);
    var entryHigh = Math.max(low, high);
    var bullish = stop < entryLow && tp1 > entryHigh && (tp2 == null || tp2 >= tp1);
    var bearish = stop > entryHigh && tp1 < entryLow && (tp2 == null || tp2 <= tp1);
    if (bullish === bearish) return 'unknown';
    return bullish ? 'bullish' : 'bearish';
  }

  function evaluateAbcdLevels(values, direction) {
    var current = safeFinite(values && values.current);
    var confirmation = safeFinite(values && values.confirmation);
    var invalidation = safeFinite(values && values.invalidation);
    var tp1 = safeFinite(values && values.tp1);
    var tp2 = safeFinite(values && values.tp2);
    var reasons = [];

    if ([current, confirmation, invalidation, tp1, tp2].some(function (value) { return value == null; })) {
      return { actionable:false, reason:'incomplete_levels', reasons:['incomplete_levels'] };
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

  function evaluateRowWith(api, row, plan) {
    var direction = api.patternDirection(row);
    var candidate = row && row.candidate;
    var labels = api.filterLabelsForDirection((plan && plan.labels) || [], direction);
    var planDirection = plan ? tradePlanDirection(plan) : 'unknown';
    var planCompatible = plan ? api.directionsCompatible(direction, planDirection) : false;

    if (!candidate) {
      return {
        direction: direction,
        status: api.STATUS.CONTEXT_ONLY,
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
      current: safeFinite(candidate.currentPrice != null ? candidate.currentPrice : row.currentPrice),
      confirmation: safeFinite(candidate.confirmation),
      invalidation: safeFinite(candidate.invalidation),
      tp1: safeFinite(candidate.tp1),
      tp2: safeFinite(candidate.tp2)
    };
    var evaluated = evaluateAbcdLevels(values, direction);
    var status;

    if (evaluated.actionable) {
      status = candidate.status === 'confirmed' ? api.STATUS.ACTIONABLE : api.STATUS.AWAITING;
    } else if (evaluated.reasons && evaluated.reasons.indexOf('invalidation_reached') >= 0) {
      status = api.STATUS.INVALIDATED;
    } else if (evaluated.reasons && evaluated.reasons.indexOf('inconsistent_level_order') >= 0) {
      status = api.STATUS.INCONSISTENT;
    } else if (evaluated.reason === 'incomplete_levels') {
      status = api.STATUS.INCOMPLETE;
    } else {
      status = api.STATUS.TARGET_REACHED;
    }

    return {
      direction: direction,
      status: status,
      actionable: status === api.STATUS.ACTIONABLE,
      reasons: evaluated.reasons || (evaluated.reason ? [evaluated.reason] : []),
      levels: values,
      plan: plan || null,
      planDirection: planDirection,
      planCompatible: planCompatible,
      labels: labels
    };
  }

  function patch(api) {
    if (!api || typeof api !== 'object') return api;
    if (api.__missingValueHardeningVersion === VERSION) return api;

    api.finite = safeFinite;
    api.tradePlanDirection = tradePlanDirection;
    api.evaluateAbcdLevels = evaluateAbcdLevels;
    api.evaluateRow = function (row, plan) { return evaluateRowWith(api, row, plan); };
    api.__missingValueHardeningVersion = VERSION;
    return api;
  }

  // Install before pattern-direction-safety.js is requested. The setter patches
  // the API synchronously at assignment time, so Pattern runtime can never see
  // the unsafe coercing implementation, even though the remaining Pattern
  // dependencies still load in parallel.
  function install(targetRoot) {
    if (!targetRoot) return false;
    if (targetRoot.AutoCuanPatternSafety) {
      patch(targetRoot.AutoCuanPatternSafety);
      return true;
    }

    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(targetRoot, 'AutoCuanPatternSafety'); } catch (_) { descriptor = null; }
    if (descriptor && descriptor.configurable === false) return false;

    try {
      Object.defineProperty(targetRoot, 'AutoCuanPatternSafety', {
        configurable: true,
        enumerable: true,
        get: function () { return undefined; },
        set: function (value) {
          var hardened = patch(value);
          Object.defineProperty(targetRoot, 'AutoCuanPatternSafety', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: hardened
          });
        }
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  return {
    version: VERSION,
    safeFinite: safeFinite,
    tradePlanDirection: tradePlanDirection,
    evaluateAbcdLevels: evaluateAbcdLevels,
    evaluateRowWith: evaluateRowWith,
    patch: patch,
    install: install
  };
});
