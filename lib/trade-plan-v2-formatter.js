'use strict';

/**
 * Trade Plan V2 — Shared Formatter / Input Contract
 * =================================================
 *
 * ONE input contract consumed by BOTH the website and Telegram so the displayed
 * numeric values can never diverge. Presentation code must NOT recalculate any
 * price — every number is read directly from the canonical trade_plan_v2 object
 * produced by lib/trade-plan-v2.js.
 *
 * `extractCanonicalNumbers(plan)` is the single source of the numeric contract.
 * Both `buildWebViewModel` and `buildTelegramViewModel` embed the SAME extracted
 * numbers, so a parity test can assert byte-equal numeric fields across channels.
 *
 * Public safety: `selectPublicTradePlan()` returns the LEGACY payload UNCHANGED
 * whenever TRADE_PLAN_V2_PUBLIC_ENABLED is false, so no public output changes
 * until the flag is explicitly enabled.
 */

const flags = require('./trade-plan-v2-flags');

// The numeric fields that MUST match between website and Telegram.
const CANONICAL_NUMERIC_FIELDS = Object.freeze([
  'entry_zone_low',
  'entry_zone_high',
  'entry_trigger',
  'support',
  'resistance',
  'stop_loss',
  'stop_anchor_price',
  'structural_invalidation',
  'emergency_stop',
  'emergency_anchor_price',
  'stop_distance_pct',
  'tp1',
  'tp1_target_r',
  'nearest_local_resistance',
  'tp2',
  'major_resistance',
  'trailing_activation',
  'trailing_reference',
  'trailing_atr_multiplier',
  'risk_amount',
  'reward_to_tp1',
  'reward_to_tp2',
  'rr_to_tp1',
  'rr_to_tp2'
]);

// The non-numeric contract fields that must also match across channels.
const CANONICAL_LABEL_FIELDS = Object.freeze([
  'plan_version',
  'screener_type',
  'ticker',
  'trailing_method',
  'support_source',
  'resistance_source',
  'support_test_state',
  'resistance_test_state',
  'status',
  // Reason strings are part of the shared contract so both channels show the
  // SAME stop-loss / take-profit rationale (read straight from the plan).
  'stop_loss_reason',
  'stop_anchor_type',
  'emergency_anchor_type',
  'tp1_anchor_type',
  'tp2_anchor_type',
  'tp1_reason',
  'tp2_reason',
  'entry_reason',
  'reject_reason',
  // ADDITIVE observable liquidity-sweep / exit-state labels.
  'trailing_sweep_state',
  'soft_exit_state',
  'hard_exit_state',
  'structure_confirmation_required'
]);

// ADDITIVE structured (object/array) contract fields — deep-compared for parity.
const CANONICAL_STRUCTURED_FIELDS = Object.freeze([
  'common_trailing_zones',
  'trailing_zone_events',
  'candle_structure',
  'active_gap_areas',
  'nearest_demand_gap',
  'nearest_supply_gap',
  'liquidity_sweep_evidence'
]);

/**
 * Extract the canonical numeric + label contract from a plan. This is the ONLY
 * place values are read; formatters must call this rather than recompute.
 */
function extractCanonicalNumbers(plan) {
  plan = plan || {};
  const out = {};
  for (const f of CANONICAL_NUMERIC_FIELDS) {
    out[f] = plan[f] === undefined ? null : plan[f];
  }
  for (const f of CANONICAL_LABEL_FIELDS) {
    out[f] = plan[f] === undefined ? null : plan[f];
  }
  // ADDITIVE structured fields are carried through by reference so BOTH channels
  // read the identical object (they must never recompute them).
  for (const f of CANONICAL_STRUCTURED_FIELDS) {
    out[f] = plan[f] === undefined ? null : plan[f];
  }
  // Warnings are part of the contract (array copy, same order).
  out.warnings = Array.isArray(plan.warnings) ? plan.warnings.slice() : [];
  out.trailing_activation_present = plan.trailing_activation != null;
  return out;
}

// ---------------------------------------------------------------------------
// Display helpers (formatting only — never numeric derivation)
// ---------------------------------------------------------------------------
function fmtPrice(v) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  return 'Rp' + Number(v).toLocaleString('id-ID');
}

function fmtRR(v) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  return Number(v).toFixed(2) + 'x';
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
}

/**
 * Build the website view-model. Numbers come straight from the canonical
 * contract; only display strings are added.
 */
function buildWebViewModel(plan) {
  const canonical = extractCanonicalNumbers(plan);
  return {
    channel: 'web',
    plan_version: canonical.plan_version,
    canonical,
    display: {
      entry_zone: fmtPrice(canonical.entry_zone_low) + ' – ' + fmtPrice(canonical.entry_zone_high),
      stop_loss: fmtPrice(canonical.stop_loss),
      stop_anchor: (canonical.stop_anchor_type || '-') + ' @ ' + fmtPrice(canonical.stop_anchor_price),
      emergency_stop: fmtPrice(canonical.emergency_stop),
      emergency_anchor: (canonical.emergency_anchor_type || '-') + ' @ ' + fmtPrice(canonical.emergency_anchor_price),
      tp1: fmtPrice(canonical.tp1),
      tp1_anchor: (canonical.tp1_anchor_type || '-') + ' (' + (canonical.tp1_target_r != null ? Number(canonical.tp1_target_r).toFixed(2) + 'R' : '-') + ')',
      tp2: canonical.tp2 != null ? fmtPrice(canonical.tp2) : '—',
      nearest_local_resistance: fmtPrice(canonical.nearest_local_resistance),
      major_resistance: fmtPrice(canonical.major_resistance),
      support: fmtPrice(canonical.support),
      resistance: fmtPrice(canonical.resistance),
      trailing_activation: fmtPrice(canonical.trailing_activation),
      trailing_reference: fmtPrice(canonical.trailing_reference),
      rr_to_tp1: fmtRR(canonical.rr_to_tp1),
      rr_to_tp2: fmtRR(canonical.rr_to_tp2),
      stop_distance: fmtPct(canonical.stop_distance_pct),
      stop_loss_reason: canonical.stop_loss_reason || '-',
      tp1_reason: canonical.tp1_reason || '-',
      tp2_reason: canonical.tp2_reason || '-',
      plan_version: canonical.plan_version || '-',
      trailing_sweep_state: canonical.trailing_sweep_state || '-',
      soft_exit_state: canonical.soft_exit_state || '-',
      hard_exit_state: canonical.hard_exit_state || '-',
      candle_pattern: (canonical.candle_structure && canonical.candle_structure.pattern) || '-',
      demand_gap: (canonical.nearest_demand_gap && canonical.nearest_demand_gap.gap_status) || '-',
      supply_gap: (canonical.nearest_supply_gap && canonical.nearest_supply_gap.gap_status) || '-'
    }
  };
}

/**
 * Build the Telegram view-model from the SAME canonical contract.
 */
function buildTelegramViewModel(plan) {
  const canonical = extractCanonicalNumbers(plan);
  return {
    channel: 'telegram',
    plan_version: canonical.plan_version,
    canonical,
    display: {
      entry_zone: fmtPrice(canonical.entry_zone_low) + ' / ' + fmtPrice(canonical.entry_zone_high),
      stop_loss: fmtPrice(canonical.stop_loss),
      stop_anchor: (canonical.stop_anchor_type || '-') + ' @ ' + fmtPrice(canonical.stop_anchor_price),
      emergency_stop: fmtPrice(canonical.emergency_stop),
      emergency_anchor: (canonical.emergency_anchor_type || '-') + ' @ ' + fmtPrice(canonical.emergency_anchor_price),
      tp1: fmtPrice(canonical.tp1),
      tp1_anchor: (canonical.tp1_anchor_type || '-') + ' (' + (canonical.tp1_target_r != null ? Number(canonical.tp1_target_r).toFixed(2) + 'R' : '-') + ')',
      tp2: canonical.tp2 != null ? fmtPrice(canonical.tp2) : '-',
      nearest_local_resistance: fmtPrice(canonical.nearest_local_resistance),
      major_resistance: fmtPrice(canonical.major_resistance),
      support: fmtPrice(canonical.support),
      resistance: fmtPrice(canonical.resistance),
      trailing_activation: fmtPrice(canonical.trailing_activation),
      trailing_reference: fmtPrice(canonical.trailing_reference),
      rr_to_tp1: fmtRR(canonical.rr_to_tp1),
      rr_to_tp2: fmtRR(canonical.rr_to_tp2),
      stop_distance: fmtPct(canonical.stop_distance_pct),
      stop_loss_reason: canonical.stop_loss_reason || '-',
      tp1_reason: canonical.tp1_reason || '-',
      tp2_reason: canonical.tp2_reason || '-',
      plan_version: canonical.plan_version || '-',
      trailing_sweep_state: canonical.trailing_sweep_state || '-',
      soft_exit_state: canonical.soft_exit_state || '-',
      hard_exit_state: canonical.hard_exit_state || '-',
      candle_pattern: (canonical.candle_structure && canonical.candle_structure.pattern) || '-',
      demand_gap: (canonical.nearest_demand_gap && canonical.nearest_demand_gap.gap_status) || '-',
      supply_gap: (canonical.nearest_supply_gap && canonical.nearest_supply_gap.gap_status) || '-'
    }
  };
}

/**
 * Render a plain-text Telegram card from the canonical contract (shadow only).
 */
function formatTelegramTradePlanV2Card(plan) {
  const vm = buildTelegramViewModel(plan);
  const c = vm.canonical;
  const lines = [];
  lines.push('[TRADE PLAN V2 · SHADOW] ' + (c.ticker || '-') + ' · ' + (c.screener_type || '-'));
  lines.push('Entry: ' + vm.display.entry_zone);
  lines.push('SL: ' + vm.display.stop_loss + ' (dist ' + vm.display.stop_distance + ')');
  lines.push('Emergency: ' + vm.display.emergency_stop);
  lines.push('TP1: ' + vm.display.tp1 + (c.tp2 != null ? ' · TP2: ' + vm.display.tp2 : ''));
  lines.push('Support: ' + vm.display.support + ' · Resistance: ' + vm.display.resistance);
  lines.push('RR TP1: ' + vm.display.rr_to_tp1 + (c.rr_to_tp2 != null ? ' · RR TP2: ' + vm.display.rr_to_tp2 : ''));
  lines.push('Trailing: activate ' + vm.display.trailing_activation + ' · ref ' + vm.display.trailing_reference + ' · ' + (c.trailing_method || '-'));
  lines.push('Support test: ' + (c.support_test_state || '-') + ' · Resistance test: ' + (c.resistance_test_state || '-'));
  // ADDITIVE shadow sweep / candle / gap diagnostics (reads canonical only).
  lines.push('Sweep: ' + vm.display.trailing_sweep_state + ' · Soft: ' + vm.display.soft_exit_state + ' · Hard: ' + vm.display.hard_exit_state);
  lines.push('Candle: ' + vm.display.candle_pattern + ' · Demand gap: ' + vm.display.demand_gap + ' · Supply gap: ' + vm.display.supply_gap);
  return lines.join('\n');
}

/**
 * Compare two view-models (any channels) for numeric + label parity. Returns
 * { equal, mismatches } — never throws — so callers/tests can report cleanly.
 */
function diffViewModels(a, b) {
  const ca = (a && a.canonical) || {};
  const cb = (b && b.canonical) || {};
  const mismatches = [];
  const keys = CANONICAL_NUMERIC_FIELDS.concat(CANONICAL_LABEL_FIELDS);
  for (const k of keys) {
    if (ca[k] !== cb[k]) mismatches.push({ field: k, a: ca[k], b: cb[k] });
  }
  // Structured (object/array) fields — deep-compared via canonical JSON.
  for (const k of CANONICAL_STRUCTURED_FIELDS) {
    const sa = JSON.stringify(ca[k] === undefined ? null : ca[k]);
    const sb = JSON.stringify(cb[k] === undefined ? null : cb[k]);
    if (sa !== sb) mismatches.push({ field: k, a: ca[k], b: cb[k] });
  }
  // Warnings array equality (order-sensitive).
  const wa = Array.isArray(ca.warnings) ? ca.warnings : [];
  const wb = Array.isArray(cb.warnings) ? cb.warnings : [];
  if (wa.length !== wb.length || wa.some((w, i) => w !== wb[i])) {
    mismatches.push({ field: 'warnings', a: wa, b: wb });
  }
  return { equal: mismatches.length === 0, mismatches };
}

/**
 * Decide which trade plan the PUBLIC channel should display.
 *
 * While TRADE_PLAN_V2_PUBLIC_ENABLED is false (default), returns the LEGACY
 * payload UNCHANGED so no public output changes. Only when the flag is
 * explicitly true does it switch to the V2 view-model.
 *
 * @param {object} params { legacyPayload, planV2, channel ('web'|'telegram'), env }
 */
function selectPublicTradePlan(params) {
  params = params || {};
  const channel = params.channel === 'telegram' ? 'telegram' : 'web';
  if (!flags.isPublicEnabled(params.env)) {
    return {
      source: 'legacy',
      public_v2_enabled: false,
      payload: params.legacyPayload !== undefined ? params.legacyPayload : null
    };
  }
  const vm = channel === 'telegram'
    ? buildTelegramViewModel(params.planV2)
    : buildWebViewModel(params.planV2);
  return { source: 'trade_plan_v2', public_v2_enabled: true, payload: vm };
}

module.exports = {
  CANONICAL_NUMERIC_FIELDS,
  CANONICAL_LABEL_FIELDS,
  CANONICAL_STRUCTURED_FIELDS,
  extractCanonicalNumbers,
  buildWebViewModel,
  buildTelegramViewModel,
  formatTelegramTradePlanV2Card,
  diffViewModels,
  selectPublicTradePlan
};
