(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanPortfolioPlannerV1 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'portfolio-planner-v1';
  var LOT_SIZE = 100n;
  var BPS_DENOMINATOR = 10000n;
  var MAX_MONEY_IDR = 1000000000000000n;
  var MAX_POSITIONS = 20;

  var RISK_PRESETS = Object.freeze({
    LOW: Object.freeze({ label: 'Rendah', defaultRiskBps: 50, maxRiskBps: 100, defaultMaxPositions: 3 }),
    MEDIUM: Object.freeze({ label: 'Sedang', defaultRiskBps: 100, maxRiskBps: 150, defaultMaxPositions: 4 }),
    HIGH: Object.freeze({ label: 'Tinggi', defaultRiskBps: 150, maxRiskBps: 200, defaultMaxPositions: 5 })
  });

  function invalid(code, message, field) {
    return { ok: false, version: VERSION, errors: [{ code: code, message: message, field: field || null }] };
  }

  function parseInteger(value, field, opts) {
    var raw = typeof value === 'bigint' ? value.toString() : String(value == null ? '' : value).trim();
    if (!/^-?\d+$/.test(raw)) return { ok: false, error: field + ' harus bilangan bulat.' };
    var n;
    try { n = BigInt(raw); } catch (e) { return { ok: false, error: field + ' tidak valid.' }; }
    if (opts && opts.positive && n <= 0n) return { ok: false, error: field + ' harus lebih dari 0.' };
    if (opts && opts.nonNegative && n < 0n) return { ok: false, error: field + ' tidak boleh negatif.' };
    if (opts && opts.max != null && n > opts.max) return { ok: false, error: field + ' terlalu besar.' };
    return { ok: true, value: n };
  }

  function parseBoundedInteger(value, field, min, max) {
    var n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      return { ok: false, error: field + ' harus antara ' + min + ' dan ' + max + '.' };
    }
    return { ok: true, value: n };
  }

  function safeNumber(n) {
    if (typeof n !== 'bigint') return n;
    if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) return null;
    return Number(n);
  }

  function moneyResult(n) {
    return { value: safeNumber(n), exact: n.toString() };
  }

  function ratioResult(numerator, denominator) {
    if (numerator == null || denominator <= 0n) return null;
    var bps = (numerator * BPS_DENOMINATOR) / denominator;
    return { bps: safeNumber(bps), exactBps: bps.toString() };
  }

  function normalizeProfile(value) {
    var key = String(value || '').trim().toUpperCase();
    return RISK_PRESETS[key] ? key : null;
  }

  function calculate(input) {
    input = input || {};
    var profile = normalizeProfile(input.riskProfile);
    if (!profile) return invalid('INVALID_RISK_PROFILE', 'Profil risiko tidak valid.', 'riskProfile');
    var preset = RISK_PRESETS[profile];

    var capital = parseInteger(input.capitalIdr, 'Modal', { positive: true, max: MAX_MONEY_IDR });
    if (!capital.ok) return invalid('INVALID_CAPITAL', capital.error, 'capitalIdr');
    var entry = parseInteger(input.entryPriceIdr, 'Harga entry', { positive: true, max: MAX_MONEY_IDR });
    if (!entry.ok) return invalid('INVALID_ENTRY', entry.error, 'entryPriceIdr');
    var stop = parseInteger(input.stopLossIdr, 'Stop loss', { positive: true, max: MAX_MONEY_IDR });
    if (!stop.ok) return invalid('INVALID_STOP', stop.error, 'stopLossIdr');
    if (stop.value >= entry.value) return invalid('STOP_NOT_BELOW_ENTRY', 'Stop loss harus lebih rendah dari harga entry.', 'stopLossIdr');

    var reserve = parseBoundedInteger(input.reserveBps == null ? 0 : input.reserveBps, 'Dana cadangan', 0, 9000);
    if (!reserve.ok) return invalid('INVALID_RESERVE', reserve.error, 'reserveBps');
    var risk = parseBoundedInteger(input.riskBps == null ? preset.defaultRiskBps : input.riskBps, 'Risiko per transaksi', 1, preset.maxRiskBps);
    if (!risk.ok) return invalid('RISK_LIMIT_EXCEEDED', 'Risiko per transaksi melewati batas profil ' + preset.label + ' (' + (preset.maxRiskBps / 100).toFixed(2) + '%).', 'riskBps');
    var maxPositions = parseBoundedInteger(input.maxPositions == null ? preset.defaultMaxPositions : input.maxPositions, 'Maksimal posisi', 1, MAX_POSITIONS);
    if (!maxPositions.ok) return invalid('INVALID_MAX_POSITIONS', maxPositions.error, 'maxPositions');

    var tp1 = null;
    var tp2 = null;
    if (input.tp1Idr != null && String(input.tp1Idr).trim() !== '') {
      var parsedTp1 = parseInteger(input.tp1Idr, 'TP1', { positive: true, max: MAX_MONEY_IDR });
      if (!parsedTp1.ok) return invalid('INVALID_TP1', parsedTp1.error, 'tp1Idr');
      if (parsedTp1.value <= entry.value) return invalid('TP1_NOT_ABOVE_ENTRY', 'TP1 harus lebih tinggi dari harga entry.', 'tp1Idr');
      tp1 = parsedTp1.value;
    }
    if (input.tp2Idr != null && String(input.tp2Idr).trim() !== '') {
      var parsedTp2 = parseInteger(input.tp2Idr, 'TP2', { positive: true, max: MAX_MONEY_IDR });
      if (!parsedTp2.ok) return invalid('INVALID_TP2', parsedTp2.error, 'tp2Idr');
      if (parsedTp2.value <= entry.value) return invalid('TP2_NOT_ABOVE_ENTRY', 'TP2 harus lebih tinggi dari harga entry.', 'tp2Idr');
      if (tp1 != null && parsedTp2.value <= tp1) return invalid('TP2_NOT_ABOVE_TP1', 'TP2 harus lebih tinggi dari TP1.', 'tp2Idr');
      tp2 = parsedTp2.value;
    }

    var capitalValue = capital.value;
    var usableCapital = (capitalValue * (BPS_DENOMINATOR - BigInt(reserve.value))) / BPS_DENOMINATOR;
    var riskBudget = (usableCapital * BigInt(risk.value)) / BPS_DENOMINATOR;
    var maxPositionCapital = usableCapital / BigInt(maxPositions.value);
    var riskPerShare = entry.value - stop.value;
    var sharesByRisk = riskBudget / riskPerShare;
    var sharesByCapital = maxPositionCapital / entry.value;
    var rawShares = sharesByRisk < sharesByCapital ? sharesByRisk : sharesByCapital;
    var recommendedShares = (rawShares / LOT_SIZE) * LOT_SIZE;
    var recommendedLots = recommendedShares / LOT_SIZE;

    if (recommendedLots <= 0n) {
      return {
        ok: false,
        version: VERSION,
        errors: [{ code: 'INSUFFICIENT_FOR_ONE_LOT', message: 'Modal atau batas risiko belum cukup untuk membeli 1 lot secara aman.', field: null }],
        guidance: {
          maxPriceForOneLotIdr: moneyResult(usableCapital / LOT_SIZE),
          maxPricePerPositionOneLotIdr: moneyResult(maxPositionCapital / LOT_SIZE)
        }
      };
    }

    var positionValue = recommendedShares * entry.value;
    var estimatedLoss = recommendedShares * riskPerShare;
    var remainingCash = usableCapital - positionValue;
    var allocationBps = usableCapital > 0n ? (positionValue * BPS_DENOMINATOR) / usableCapital : 0n;
    var maxPriceOneLot = usableCapital / LOT_SIZE;
    var maxPricePositionOneLot = maxPositionCapital / LOT_SIZE;
    var affordable = entry.value <= maxPricePositionOneLot;

    var warnings = [];
    if (!affordable) warnings.push({ code: 'PRICE_ABOVE_POSITION_BAND', message: 'Harga saham berada di atas batas alokasi 1 posisi untuk modal ini.' });
    if (allocationBps > (BPS_DENOMINATOR / BigInt(maxPositions.value))) {
      warnings.push({ code: 'ALLOCATION_LIMIT', message: 'Alokasi posisi melewati pembagian modal yang dipilih.' });
    }

    return {
      ok: true,
      version: VERSION,
      input: {
        riskProfile: profile,
        riskBps: risk.value,
        reserveBps: reserve.value,
        maxPositions: maxPositions.value,
        capitalIdr: moneyResult(capitalValue),
        entryPriceIdr: moneyResult(entry.value),
        stopLossIdr: moneyResult(stop.value),
        tp1Idr: tp1 == null ? null : moneyResult(tp1),
        tp2Idr: tp2 == null ? null : moneyResult(tp2)
      },
      result: {
        usableCapitalIdr: moneyResult(usableCapital),
        riskBudgetIdr: moneyResult(riskBudget),
        riskPerShareIdr: moneyResult(riskPerShare),
        maxPositionCapitalIdr: moneyResult(maxPositionCapital),
        sharesByRisk: moneyResult(sharesByRisk),
        sharesByCapital: moneyResult(sharesByCapital),
        recommendedShares: moneyResult(recommendedShares),
        recommendedLots: moneyResult(recommendedLots),
        positionValueIdr: moneyResult(positionValue),
        estimatedStopLossIdr: moneyResult(estimatedLoss),
        remainingCashIdr: moneyResult(remainingCash),
        allocationBps: moneyResult(allocationBps),
        rewardRiskTp1: tp1 == null ? null : ratioResult(tp1 - entry.value, riskPerShare),
        rewardRiskTp2: tp2 == null ? null : ratioResult(tp2 - entry.value, riskPerShare)
      },
      guidance: {
        maxPriceForOneLotIdr: moneyResult(maxPriceOneLot),
        maxPricePerPositionOneLotIdr: moneyResult(maxPricePositionOneLot),
        entryWithinPositionBand: affordable
      },
      warnings: warnings
    };
  }

  return {
    VERSION: VERSION,
    LOT_SIZE: Number(LOT_SIZE),
    RISK_PRESETS: RISK_PRESETS,
    calculate: calculate,
    normalizeProfile: normalizeProfile
  };
});
