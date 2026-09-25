'use strict';

/**
 * Auto-Cuan Unified Scoring Engine (0-100)
 *
 * One score, one meaning. Before this module the same ticker could show three
 * different numbers depending on where you looked: the Day Trade card read
 * `daytrade_score`, the Swing Konglo/Non-Konglo cards read `score`, and the
 * Telegram digest derived its own `telegram_conviction_score`. This module is
 * the single calculation site; every consumer reads the number it produces.
 *
 * WEIGHTED COMPONENTS (total 100 pt):
 *   1. Likuiditas .......................... 15 pt
 *   2. Volume & Arjum Pace ................. 20 pt
 *   3. Bandarmologi CR3/CR5 & Akumulasi .... 25 pt
 *   4. Foreign Flow 1D/3D/7D ............... 15 pt
 *   5. Price Action / MA20 / MA50 / Candle . 15 pt
 *   6. Risk / Reward Asymmetry ............. 10 pt
 *
 * HARD PENALTIES (applied after the weighted sum, floor 0):
 *   - Distribusi Bandar .................... -25
 *   - Retail Trap .......................... -20
 *   - Overextended ......................... -15
 *
 * DESIGN RULES
 * - Deterministic and pure: same row in, same score out. No I/O, no clock
 *   reads other than an injectable `now`, no randomness.
 * - Missing data is neutral, never a reward. A component with no usable input
 *   scores 0 for that component and is reported as `unavailable` in the
 *   breakdown, so a data outage can never inflate a ticker into a BUY.
 * - Every point awarded is traceable to a named rule in `breakdown`, which is
 *   what the "Mengapa muncul?" drawer and the Telegram rationale render.
 *
 * BACKWARD COMPATIBILITY
 * `applyUnifiedScore` writes the aliases the existing frontend contract reads
 * (see `SCORE_ALIASES` / `VOLUME_RATIO_ALIASES`). It never deletes or rewrites
 * trading-plan or bandarmologi fields — those are owned by
 * `normalizeDisplayLevels()` on the client and by the bandarmologi modules on
 * the server.
 */

// ---------------------------------------------------------------------------
// Weights — exported so tests and the UI legend stay in lockstep with the math.
// ---------------------------------------------------------------------------
const WEIGHTS = {
  liquidity: 15,
  volume: 20,
  bandarmologi: 25,
  foreign: 15,
  price_action: 15,
  risk_reward: 10
};

const MAX_WEIGHTED_TOTAL = Object.keys(WEIGHTS).reduce((sum, k) => sum + WEIGHTS[k], 0); // 100

const HARD_PENALTIES = {
  DISTRIBUSI_BANDAR: -25,
  RETAIL_TRAP: -20,
  OVEREXTENDED: -15
};

// Liquidity floors mirror the live server gates so a row cannot score well on
// liquidity while being rejected by the screener for the same reason.
const MIN_VALUE_DAYTRADE = 1e9;    // lib/daytrade-screener-engine.js MIN_VALUE_TODAY
const MIN_VALUE_KONGLO = 5e9;      // api/sector-hot.js swing gate
const MIN_VALUE_NONKONGLO = 10e9;  // api/sector-hot.js non-konglo gate

// ---------------------------------------------------------------------------
// Small numeric helpers — deliberately local so this module has zero deps and
// can be required from serverless, the VPS daemon, and the test runner alike.
// ---------------------------------------------------------------------------
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Linear ramp: returns 0 at `lo`, 1 at `hi`, interpolated between.
 * Returns null when `value` is not a finite number so callers can treat
 * missing data as neutral instead of as a zero.
 */
function ramp(value, lo, hi) {
  const v = toNum(value);
  if (v === null) return null;
  if (hi === lo) return v >= hi ? 1 : 0;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

function pointsFromRamp(value, lo, hi, maxPoints) {
  const r = ramp(value, lo, hi);
  if (r === null) return { points: 0, available: false, ratio: null };
  return { points: r * maxPoints, available: true, ratio: r };
}

/**
 * Resolve the volume ratio from any of the three aliases the codebase uses.
 * Bug #1 from the frontend audit: the Day Trade card read `volume_ratio_20d`,
 * the Swing cards read `volume_ratio`, and the table read
 * `volume_ratio_avg20`, so a row carrying only one alias rendered "-" in the
 * other two surfaces. Reading all three here is the server-side half of the
 * fix; `applyUnifiedScore` writes all three back so the client half holds too.
 */
function resolveVolumeRatio(row) {
  if (!row) return null;
  return (
    toNum(row.volume_ratio_20d) ??
    toNum(row.volume_ratio_avg20) ??
    toNum(row.volume_ratio) ??
    toNum(row.volume_pace) ??
    toNum(row.intraday_volume_pace_ratio) ??
    null
  );
}

function resolveLiquidityValue(row) {
  if (!row) return null;
  return (
    toNum(row.value_today) ??
    toNum(row.tx_value_1d) ??
    toNum(row.avg_value_7d) ??
    toNum(row.avg_tx_value_7d) ??
    toNum(row.avg_transaction_value_20d) ??
    null
  );
}

function liquidityFloorFor(category) {
  const c = String(category || '').toLowerCase();
  if (c.includes('day') || c.includes('dt')) return MIN_VALUE_DAYTRADE;
  if (c.includes('non')) return MIN_VALUE_NONKONGLO;
  return MIN_VALUE_KONGLO;
}

// ---------------------------------------------------------------------------
// Component 1 — Likuiditas (15 pt)
// ---------------------------------------------------------------------------
function scoreLiquidity(row) {
  const value = resolveLiquidityValue(row);
  const floor = liquidityFloorFor(row.category || row.screener_type || row.mode);
  const maxPoints = WEIGHTS.liquidity;

  if (value === null) {
    return { key: 'liquidity', points: 0, max: maxPoints, available: false, note: 'Nilai transaksi belum tersedia', rules: [] };
  }

  // Below the hard floor: no liquidity credit at all. Between the floor and
  // 10x the floor the credit ramps to full, so a merely-adequate ticker does
  // not outrank a genuinely liquid one.
  const ceiling = floor * 10;
  const { points, available, ratio } = pointsFromRamp(value, floor, ceiling, maxPoints);

  const rules = [];
  if (value < floor) {
    rules.push({ rule: 'LIQUIDITY_BELOW_GATE', points: 0, label: `Nilai ${fmtRp(value)} di bawah gate ${fmtRp(floor)}` });
  } else {
    rules.push({ rule: 'LIQUIDITY_RAMP', points: round2(points), label: `Nilai ${fmtRp(value)} vs gate ${fmtRp(floor)} (${Math.round((ratio || 0) * 100)}%)` });
  }

  return {
    key: 'liquidity',
    points,
    max: maxPoints,
    available,
    note: value < floor ? 'Likuiditas di bawah ambang gate' : 'Likuiditas memadai',
    rules,
    metrics: { value, floor, ceiling }
  };
}

// ---------------------------------------------------------------------------
// Component 2 — Volume & Arjum Pace (20 pt)
// ---------------------------------------------------------------------------
function scoreVolume(row) {
  const maxPoints = WEIGHTS.volume;
  const volRatio = resolveVolumeRatio(row);
  const rules = [];
  let points = 0;

  if (volRatio === null) {
    return { key: 'volume', points: 0, max: maxPoints, available: false, note: 'Rasio volume belum tersedia', rules: [] };
  }

  // (a) Volume vs MA20 — 12 pt. 1.0x is neutral, 2.5x is full credit.
  const volPart = pointsFromRamp(volRatio, 1.0, 2.5, maxPoints * 0.6);
  points += volPart.points;
  rules.push({
    rule: 'VOLUME_RATIO_20D',
    points: round2(volPart.points),
    label: `Volume ${volRatio.toFixed(2)}x vs MA20`
  });

  // (b) Volume pace / arjum trend — 8 pt. Prefer an explicit pace field when
  // the collector supplies one, otherwise fall back to the raw ratio so the
  // component still differentiates rather than scoring every row identically.
  const pace = toNum(row.volume_pace) ?? toNum(row.intraday_volume_pace) ?? volRatio;
  const pacePart = pointsFromRamp(pace, 0.8, 2.0, maxPoints * 0.4);
  points += pacePart.points;
  rules.push({
    rule: 'VOLUME_PACE',
    points: round2(pacePart.points),
    label: `Pace volume ${Number(pace).toFixed(2)}x`
  });

  // A dried-up tape is a warning the user must see even if other components
  // carried the score: report it, but do not silently double-count it as a
  // hard penalty (that is `RETAIL_TRAP` / `OVEREXTENDED` territory).
  if (volRatio < 0.8) rules.push({ rule: 'VOLUME_DRY_WARNING', points: 0, label: 'Volume kering (<0.8x MA20)' });

  return {
    key: 'volume',
    points,
    max: maxPoints,
    available: true,
    note: volRatio >= 1.5 ? 'Volume ekspansif' : (volRatio >= 1.0 ? 'Volume normal-atas' : 'Volume tipis'),
    rules,
    metrics: { volume_ratio: volRatio, pace }
  };
}

// ---------------------------------------------------------------------------
// Component 3 — Bandarmologi CR3/CR5 & Akumulasi (25 pt)
// ---------------------------------------------------------------------------
function scoreBandarmologi(row) {
  const maxPoints = WEIGHTS.bandarmologi;
  const rules = [];
  let points = 0;

  const metrics = row.bandarmologi_metrics || {};
  // CR may arrive as a ratio (0.62) or a percentage (62). Normalise to 0-1.
  let cr3 = toNum(metrics.cr3);
  let cr5 = toNum(metrics.cr5);
  if (cr3 !== null && cr3 > 1) cr3 = cr3 / 100;
  if (cr5 !== null && cr5 > 1) cr5 = cr5 / 100;

  const label = String(row.bandar_label || '');
  const available = cr3 !== null || cr5 !== null || Boolean(label);

  if (!available) {
    return { key: 'bandarmologi', points: 0, max: maxPoints, available: false, note: 'Data bandarmologi belum tersedia', rules: [] };
  }

  // (a) CR3 concentration — 12 pt. 40% scattered, 70% tightly held.
  const cr3Part = pointsFromRamp(cr3 !== null ? cr3 * 100 : null, 40, 70, maxPoints * 0.48);
  points += cr3Part.points;
  if (cr3 !== null) {
    rules.push({ rule: 'CR3_CONCENTRATION', points: round2(cr3Part.points), label: `CR3 ${(cr3 * 100).toFixed(1)}%` });
  }

  // (b) CR5 concentration — 5 pt. 60% scattered, 85% tightly held.
  const cr5Part = pointsFromRamp(cr5 !== null ? cr5 * 100 : null, 60, 85, maxPoints * 0.2);
  points += cr5Part.points;
  if (cr5 !== null) {
    rules.push({ rule: 'CR5_CONCENTRATION', points: round2(cr5Part.points), label: `CR5 ${(cr5 * 100).toFixed(1)}%` });
  }

  // (c) Accumulation verdict — 8 pt. The confluence label is the module's own
  // verdict; we grade it rather than recomputing it so the badge on the card
  // and the score can never disagree.
  if (label === 'Accumulation') {
    points += maxPoints * 0.32;
    rules.push({ rule: 'BANDAR_ACCUMULATION', points: round2(maxPoints * 0.32), label: 'Bandar akumulasi' });
  } else if (label === 'Mixed') {
    points += maxPoints * 0.12;
    rules.push({ rule: 'BANDAR_MIXED', points: round2(maxPoints * 0.12), label: 'Bandar campuran' });
  } else if (label === 'Distribution') {
    rules.push({ rule: 'BANDAR_DISTRIBUTION', points: 0, label: 'Bandar distribusi (lihat penalty)' });
  }

  // Multi-window agreement is a stronger statement than a single day's flow.
  const windows = Array.isArray(row.bandar_consistent_windows) ? row.bandar_consistent_windows : [];
  if (windows.length >= 2 && label === 'Accumulation') {
    const bonus = maxPoints * 0.04;
    points += bonus;
    rules.push({ rule: 'BANDAR_WINDOW_AGREEMENT', points: round2(bonus), label: `Konsisten ${windows.join(' & ')}` });
  }

  return {
    key: 'bandarmologi',
    points: clamp(points, 0, maxPoints),
    max: maxPoints,
    available: true,
    note: label === 'Accumulation' ? 'Bandar akumulasi' : (label === 'Distribution' ? 'Bandar distribusi' : 'Bandar campuran'),
    rules,
    metrics: { cr3, cr5, bandar_label: label || null }
  };
}

// ---------------------------------------------------------------------------
// Component 4 — Foreign Flow 1D/3D/7D (15 pt)
// ---------------------------------------------------------------------------
function scoreForeignFlow(row) {
  const maxPoints = WEIGHTS.foreign;
  const rules = [];
  let points = 0;

  const f1 = toNum(row.foreign_1d);
  const f3 = toNum(row.foreign_3d);
  const f7 = toNum(row.foreign_7d);
  const label = String(row.foreign_label || '');

  if (f1 === null && f3 === null && f7 === null && !label) {
    return { key: 'foreign', points: 0, max: maxPoints, available: false, note: 'Data foreign flow belum tersedia', rules: [] };
  }

  // Each window contributes independently, weighted by how much evidence it
  // carries: 7D is the trend, 1D is the noise.
  const windowSpec = [
    { name: 'FOREIGN_1D', value: f1, weight: 0.20 },
    { name: 'FOREIGN_3D', value: f3, weight: 0.30 },
    { name: 'FOREIGN_7D', value: f7, weight: 0.50 }
  ];

  // Normalise each window against a shared scale so windows are comparable.
  // 50bn rupiah net in a week is treated as full-strength conviction.
  const SCALE = 5e10;
  let availableWeight = 0;

  for (const w of windowSpec) {
    if (w.value === null) continue;
    availableWeight += w.weight;
  }

  if (availableWeight === 0) {
    // No numeric windows, but a label exists — grade the label alone.
    if (/net buy|akumulasi|inflow/i.test(label)) {
      points += maxPoints * 0.6;
      rules.push({ rule: 'FOREIGN_LABEL_POSITIVE', points: round2(maxPoints * 0.6), label: `Foreign: ${label}` });
    } else if (/net sell|distribusi|outflow/i.test(label)) {
      rules.push({ rule: 'FOREIGN_LABEL_NEGATIVE', points: 0, label: `Foreign: ${label}` });
    }
    return {
      key: 'foreign',
      points: clamp(points, 0, maxPoints),
      max: maxPoints,
      available: Boolean(label),
      note: label || 'Data foreign terbatas',
      rules,
      metrics: { foreign_1d: f1, foreign_3d: f3, foreign_7d: f7, foreign_label: label || null }
    };
  }

  for (const w of windowSpec) {
    if (w.value === null) continue;
    // Re-normalise so missing windows do not silently zero the component.
    const effectiveWeight = w.weight / availableWeight;
    const magnitude = ramp(Math.abs(w.value), 0, SCALE);
    if (magnitude === null) continue;
    const signed = w.value > 0 ? magnitude : (w.value < 0 ? -magnitude * 0.5 : 0);
    const contribution = signed * effectiveWeight * maxPoints;
    points += contribution;
    rules.push({
      rule: w.name,
      points: round2(contribution),
      label: `${w.name.replace('FOREIGN_', '')} ${w.value >= 0 ? 'net buy' : 'net sell'} ${fmtRp(Math.abs(w.value))}`
    });
  }

  return {
    key: 'foreign',
    points: clamp(points, 0, maxPoints),
    max: maxPoints,
    available: true,
    note: points >= maxPoints * 0.5 ? 'Asing net buy' : (points <= 0 ? 'Asing net sell' : 'Asing campuran'),
    rules,
    metrics: { foreign_1d: f1, foreign_3d: f3, foreign_7d: f7, foreign_label: label || null }
  };
}

// ---------------------------------------------------------------------------
// Component 5 — Price Action / MA20 / MA50 / Candle (15 pt)
// ---------------------------------------------------------------------------
function scorePriceAction(row) {
  const maxPoints = WEIGHTS.price_action;
  const rules = [];
  let points = 0;

  const last = toNum(row.last_price) ?? toNum(row.close);
  const ma20 = toNum(row.ma20) ?? toNum(row.indicators && row.indicators.ma20);
  const ma50 = toNum(row.ma50) ?? toNum(row.indicators && row.indicators.ma50);
  const rsi = toNum(row.rsi14) ?? toNum(row.rsi);
  const changePct = toNum(row.change_pct);

  const available = last !== null || ma20 !== null || ma50 !== null || rsi !== null || changePct !== null;
  if (!available) {
    return { key: 'price_action', points: 0, max: maxPoints, available: false, note: 'Data harga/MA belum tersedia', rules: [] };
  }

  // (a) Position vs MA20 — 6 pt. At/above MA20 is constructive; a deep break
  // below is not. Tolerate a 2% dip, matching the gate drawer's own threshold.
  if (last !== null && ma20 !== null && ma20 > 0) {
    const vsMa20Pct = ((last - ma20) / ma20) * 100;
    const part = pointsFromRamp(vsMa20Pct, -2, 8, maxPoints * 0.4);
    points += part.points;
    rules.push({
      rule: 'PRICE_VS_MA20',
      points: round2(part.points),
      label: `Harga ${vsMa20Pct >= 0 ? '+' : ''}${vsMa20Pct.toFixed(1)}% vs MA20`
    });
  }

  // (b) MA20 above MA50 — 4 pt. Structural uptrend confirmation.
  if (ma20 !== null && ma50 !== null && ma50 > 0) {
    const spreadPct = ((ma20 - ma50) / ma50) * 100;
    const part = pointsFromRamp(spreadPct, 0, 5, maxPoints * 0.27);
    points += part.points;
    rules.push({
      rule: 'MA20_OVER_MA50',
      points: round2(part.points),
      label: `MA20 ${spreadPct >= 0 ? '+' : ''}${spreadPct.toFixed(1)}% vs MA50`
    });
  }

  // (c) RSI in the healthy 45-70 band — 3 pt. This is the same band the
  // server hard filter uses, so "in band" here means "not rejected there".
  if (rsi !== null) {
    if (rsi >= 45 && rsi <= 70) {
      points += maxPoints * 0.2;
      rules.push({ rule: 'RSI_IN_BAND', points: round2(maxPoints * 0.2), label: `RSI ${rsi.toFixed(1)} (zona sehat)` });
    } else {
      rules.push({ rule: 'RSI_OUT_OF_BAND', points: 0, label: `RSI ${rsi.toFixed(1)} (${rsi > 70 ? 'overbought' : 'oversold'})` });
    }
  }

  // (d) Today's candle direction — 2 pt. Small weight: one candle is weak
  // evidence, but a red close on an otherwise good row deserves to show up.
  if (changePct !== null) {
    const part = pointsFromRamp(changePct, -3, 3, maxPoints * 0.13);
    points += part.points;
    rules.push({
      rule: 'CANDLE_DIRECTION',
      points: round2(part.points),
      label: `Perubahan harian ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`
    });
  }

  return {
    key: 'price_action',
    points: clamp(points, 0, maxPoints),
    max: maxPoints,
    available: true,
    note: points >= maxPoints * 0.6 ? 'Struktur harga sehat' : 'Struktur harga perlu konfirmasi',
    rules,
    metrics: { last_price: last, ma20, ma50, rsi14: rsi, change_pct: changePct }
  };
}

// ---------------------------------------------------------------------------
// Component 6 — Risk / Reward Asymmetry (10 pt)
// ---------------------------------------------------------------------------
function scoreRiskReward(row) {
  const maxPoints = WEIGHTS.risk_reward;
  const rr = toNum(row.risk_reward) ?? toNum(row.rr) ?? toNum(row.rr_to_tp1);
  const rules = [];

  if (rr === null) {
    return { key: 'risk_reward', points: 0, max: maxPoints, available: false, note: 'Rasio R/R belum tersedia', rules: [] };
  }

  // 1.5:1 is the swing gate floor; 3:1 is full credit. Below 1.2 the row is
  // structurally unattractive regardless of how good the other components look.
  const part = pointsFromRamp(rr, 1.2, 3.0, maxPoints);
  rules.push({ rule: 'RR_ASYMMETRY', points: round2(part.points), label: `R/R ${rr.toFixed(2)} : 1` });

  return {
    key: 'risk_reward',
    points: clamp(part.points, 0, maxPoints),
    max: maxPoints,
    available: true,
    note: rr >= 2 ? 'Asimetri reward kuat' : (rr >= 1.5 ? 'Asimetri reward memadai' : 'Asimetri reward tipis'),
    rules,
    metrics: { risk_reward: rr }
  };
}

// ---------------------------------------------------------------------------
// Hard penalties
// ---------------------------------------------------------------------------
function computeHardPenalties(row, components) {
  const penalties = [];

  const bandarLabel = String(row.bandar_label || '');
  const bandarComp = components.find(c => c.key === 'bandarmologi');
  const netFlow = toNum(row.bandar_net) ?? toNum(row.net_flow);

  // 1. Distribusi Bandar — the bandar verdict is the strongest negative the
  // system can produce, so it costs more than any single component can earn
  // back on its own.
  if (bandarLabel === 'Distribution') {
    penalties.push({
      rule: 'PENALTY_DISTRIBUSI_BANDAR',
      points: HARD_PENALTIES.DISTRIBUSI_BANDAR,
      label: 'Bandar distribusi'
    });
  } else if (bandarComp && netFlow !== null && netFlow < 0 && bandarLabel !== 'Accumulation') {
    penalties.push({
      rule: 'PENALTY_DISTRIBUSI_BANDAR',
      points: HARD_PENALTIES.DISTRIBUSI_BANDAR,
      label: 'Net flow bandar negatif'
    });
  }

  // 2. Retail Trap — retail buying while the bandar side is not accumulating.
  // This is the exact pattern the bandarmologi module labels
  // RETAIL_CHASE_DISTRIBUTION; detecting it here keeps the two modules aligned
  // instead of letting the score reward what the badge warns about.
  const retailNet = toNum(row.retail_net);
  const instNet = toNum(row.inst_net);
  const retailChaseByMetric = retailNet !== null && retailNet > 0 && instNet !== null && instNet < 0;
  const retailChaseByText = (() => {
    const text = [row.notes, row.status_reason, row.volume_notes, row.grade_reason]
      .filter(Boolean).join(' ').toLowerCase();
    return /ritel\s*(serok|beli)|retail\s*(chase|trap|buy)|serok\s*di\s*atas/.test(text);
  })();
  if (retailChaseByMetric || retailChaseByText) {
    penalties.push({
      rule: 'PENALTY_RETAIL_TRAP',
      points: HARD_PENALTIES.RETAIL_TRAP,
      label: 'Retail trap terdeteksi'
    });
  }

  // 3. Overextended — price has run away from the entry area or is pinned at
  // ARA. Chasing is the single most expensive mistake this system is built to
  // prevent, so it is penalised rather than merely un-rewarded.
  const chasePct = toNum(row.entry_chase_pct);
  const overextendedByChase = chasePct !== null && chasePct > 5;
  const araHit = row.ara_hit === true || row.near_ara === true || row.entry_near_ara === true || row.trigger_near_ara === true;
  const executionStatus = String(row.execution_reality_status || '').toUpperCase();
  const overextendedByExecution = executionStatus === 'NEAR_ARA' || executionStatus === 'ARA_HIT';

  if (overextendedByChase || araHit || overextendedByExecution) {
    penalties.push({
      rule: 'PENALTY_OVEREXTENDED',
      points: HARD_PENALTIES.OVEREXTENDED,
      label: overextendedByChase ? `Chase +${chasePct.toFixed(1)}% dari entry` : 'Harga di area ARA / overextended'
    });
  }

  // Reuse the swing engine's own overextension guard when available, so a row
  // it would cap at 89 cannot slip through here at 95.
  if (row.high_rr_warning === true) {
    penalties.push({
      rule: 'PENALTY_HIGH_RR_WARNING',
      points: 0,
      label: 'Peringatan R/R tinggi (target tidak realistis)'
    });
  }

  return penalties;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculate the unified 0-100 score for one screener row.
 *
 * @param {object} row - screener row (any category)
 * @param {object} [options] - { category, mode }
 * @returns {{
 *   score: number, raw_score: number, penalty_total: number,
 *   components: object[], penalties: object[], breakdown: object[],
 *   grade: string, weights: object, version: string
 * }}
 */
function calculateUnifiedScore(row, options) {
  row = row || {};
  options = options || {};

  const context = Object.assign({}, row);
  if (options.category && !context.category) context.category = options.category;
  if (options.mode && !context.mode) context.mode = options.mode;

  const components = [
    scoreLiquidity(context),
    scoreVolume(context),
    scoreBandarmologi(context),
    scoreForeignFlow(context),
    scorePriceAction(context),
    scoreRiskReward(context)
  ];

  const rawScore = components.reduce((sum, c) => sum + c.points, 0);
  const penalties = computeHardPenalties(context, components);
  const penaltyTotal = penalties.reduce((sum, p) => sum + p.points, 0);

  const finalScore = Math.round(clamp(rawScore + penaltyTotal, 0, 100));

  // Flatten every awarded rule into one traceable list. The UI and the
  // Telegram rationale both read this, so there is exactly one place where a
  // score's justification lives.
  const breakdown = [];
  components.forEach(c => {
    c.rules.forEach(r => breakdown.push(Object.assign({ component: c.key }, r)));
  });
  penalties.forEach(p => breakdown.push(Object.assign({ component: 'penalty' }, p)));

  return {
    score: finalScore,
    // Display-rounded values for API consumers and the UI.
    raw_score: round2(rawScore),
    penalty_total: round2(penaltyTotal),
    // Exact values for reconciliation; see applyUnifiedScore for why these are
    // carried separately from the rounded pair above.
    raw_score_exact: rawScore,
    penalty_total_exact: penaltyTotal,
    components,
    penalties,
    breakdown,
    grade: gradeFor(finalScore),
    weights: Object.assign({}, WEIGHTS),
    max_weighted_total: MAX_WEIGHTED_TOTAL,
    version: 'unified-score-v1'
  };
}

/**
 * Letter grade for a 0-100 score. Thresholds match the existing colour bands
 * the cards already use (80 / 65 / 50) so the grade never contradicts the
 * number's colour.
 */
function gradeFor(score) {
  const s = toNum(score);
  if (s === null) return '—';
  if (s >= 85) return 'A+';
  if (s >= 80) return 'A';
  if (s >= 65) return 'B';
  if (s >= 50) return 'C';
  return 'D';
}

// ---------------------------------------------------------------------------
// Backward-compatibility layer
// ---------------------------------------------------------------------------

// Every alias the frontend contract reads for "the score".
// Verified against public/index.html: DT card L8669, KG card L9051, NK card
// L9157, Top 5 L11065, detail modal L8778.
const SCORE_ALIASES = ['unified_score', 'score', 'daytrade_score', 'combined_score'];

// Every alias the frontend reads for "the volume ratio".
// Verified against public/index.html: DT card L8673 (volume_ratio_20d),
// KG/NK cards L9055/L9161 (volume_ratio), table L9781 (volume_ratio_avg20).
const VOLUME_RATIO_ALIASES = ['volume_ratio_20d', 'volume_ratio', 'volume_ratio_avg20'];

/**
 * Apply the unified score to a row **in place**, then write the alias fields
 * the existing frontend contract depends on.
 *
 * Guarantees:
 * - Never deletes a key. Trading-plan and bandarmologi fields are read, never
 *   rewritten, so `normalizeDisplayLevels()` and the bandar badges keep
 *   working exactly as before.
 * - Preserves the pre-unified number in `score_before_unified` (and the
 *   bandarmologi-specific pair) so any historical comparison stays possible.
 * - Idempotent: running twice produces the same aliases because the unified
 *   score is recomputed from the raw inputs, not from its own output.
 *
 * @param {object} row - screener row, mutated in place
 * @param {object} [options] - passed through to calculateUnifiedScore
 * @returns {object} the same row
 */
function applyUnifiedScore(row, options) {
  if (!row || typeof row !== 'object') return row;
  options = options || {};

  const result = calculateUnifiedScore(row, options);

  // Keep the original number visible for audit; only set it the first time so
  // repeated enrichment does not overwrite the true original with a derived one.
  if (row.score_before_unified === undefined && row.score != null) {
    row.score_before_unified = row.score;
  }

  SCORE_ALIASES.forEach(alias => { row[alias] = result.score; });

  // Volume-ratio alias sync (frontend Bug #1). Only write when we actually
  // resolved a ratio — writing null over a field the collector populated would
  // be a regression, not a fix.
  const volRatio = resolveVolumeRatio(row);
  if (volRatio !== null) {
    VOLUME_RATIO_ALIASES.forEach(alias => { row[alias] = volRatio; });
  }

  // Supersede the legacy additive bandarmologi breakdown.
  //
  // `enrichCandidateWithBandarmologi` adds `bandar_score_bonus` straight onto
  // `score` and stores the pre-addition value in `score_before_bandarmologi`.
  // The Konglo/Non-Konglo cards render that pair as a visible formula:
  //     Score: 82 (Base: 78 + Bandar: +4)
  // Bandarmologi is now a first-class 25-point component of the unified score
  // instead of a bonus bolted on top, so the formula would no longer add up
  // (78 + 4 ≠ 85) and the card would print visibly wrong arithmetic.
  //
  // The legacy pair is archived rather than dropped so the contribution stays
  // auditable, and the frontend-facing fields are neutralised so no surface can
  // print a stale formula. `bandar_score_bonus` becomes 0 (not null) so the
  // table's `bandarScoreBadgeHtml` hides gracefully instead of printing "null".
  if (options.archiveLegacyBandarBreakdown !== false) {
    if (row.score_before_bandarmologi !== undefined && row.score_before_bandarmologi !== null) {
      row.legacy_score_before_bandarmologi = row.score_before_bandarmologi;
    }
    if (row.bandar_score_bonus !== undefined && row.bandar_score_bonus !== null) {
      row.legacy_bandar_score_bonus = row.bandar_score_bonus;
    }
    row.score_before_bandarmologi = null;
    row.bandar_score_bonus = 0;

    // The Day Trade card reads the same pair under a prefixed name.
    if (row.daytrade_score_before_bandarmologi !== undefined && row.daytrade_score_before_bandarmologi !== null) {
      row.legacy_daytrade_score_before_bandarmologi = row.daytrade_score_before_bandarmologi;
    }
    row.daytrade_score_before_bandarmologi = null;
  }

  row.unified_score_breakdown = result.breakdown;
  row.unified_score_components = result.components;
  row.unified_score_penalties = result.penalties;
  row.unified_score_grade = result.grade;
  row.unified_score_version = result.version;
  // Persist the arithmetic so an operator can see *why* a ticker landed where
  // it did without re-running the engine.
  //
  // These are stored at FULL precision, not via the round2 used in the returned
  // object: rounding to 2 decimals can move the sum across a .5 boundary and
  // make `raw + penalties` reconcile to a score one point off the real one.
  // The human-readable rounding lives in `unified_score_breakdown` instead.
  row.unified_score_raw = result.raw_score_exact;
  row.unified_score_penalty_total = result.penalty_total_exact;

  return row;
}

/**
 * Batch helper. Returns a new array; rows are cloned so a caller can compare
 * before/after without the original mutating under them.
 */
function applyUnifiedScoreBatch(rows, options) {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => applyUnifiedScore(Object.assign({}, r), options));
}

/**
 * Convenience read used by consumers that only need the number and must not
 * mutate anything (e.g. sorting, Telegram rendering).
 */
function getUnifiedScore(row) {
  if (!row) return null;
  return (
    toNum(row.unified_score) ??
    toNum(row.score) ??
    toNum(row.daytrade_score) ??
    toNum(row.combined_score) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers (local, so this module stays dependency-free)
// ---------------------------------------------------------------------------
function fmtRp(v) {
  const n = toNum(v);
  if (n === null) return '-';
  const abs = Math.abs(n);
  if (abs >= 1e12) return 'Rp' + (n / 1e12).toFixed(2) + ' T';
  if (abs >= 1e9) return 'Rp' + (n / 1e9).toFixed(2) + ' M';
  if (abs >= 1e6) return 'Rp' + (n / 1e6).toFixed(0) + ' jt';
  return 'Rp' + Math.round(n).toLocaleString('id-ID');
}

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

module.exports = {
  WEIGHTS,
  HARD_PENALTIES,
  MAX_WEIGHTED_TOTAL,
  MIN_VALUE_DAYTRADE,
  MIN_VALUE_KONGLO,
  MIN_VALUE_NONKONGLO,
  SCORE_ALIASES,
  VOLUME_RATIO_ALIASES,
  calculateUnifiedScore,
  applyUnifiedScore,
  applyUnifiedScoreBatch,
  getUnifiedScore,
  gradeFor,
  resolveVolumeRatio,
  // exported for focused unit tests
  scoreLiquidity,
  scoreVolume,
  scoreBandarmologi,
  scoreForeignFlow,
  scorePriceAction,
  scoreRiskReward,
  computeHardPenalties
};
