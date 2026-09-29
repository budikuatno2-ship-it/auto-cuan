/**
 * Auto-Cuan Position Sizing Calculator (E1)
 * Kalkulator ukuran posisi dan alokasi risiko otomatis untuk kartu sinyal
 * (Day Trade, Swing Konglo, Swing Non-Konglo, Top 5) dan modal detail.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(typeof globalThis !== 'undefined' ? globalThis : root);
  } else {
    var inst = factory(root);
    root.PositionSizing = inst;
    if (typeof window !== 'undefined') window.PositionSizing = inst;
    if (typeof globalThis !== 'undefined') globalThis.PositionSizing = inst;
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  root = root || (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}));

  var STORAGE_KEY_CAPITAL = 'autocuan_trading_capital';
  var STORAGE_KEY_RISK_PCT = 'autocuan_risk_pct';
  var DEFAULT_CAPITAL = 10000000; // Rp 10.000.000
  var DEFAULT_RISK_PCT = 1.0;     // 1.0%

  // F5-B3-03/F5-B3-04: the supported input band. `saveSettings` already clamped
  // the stored values to this band, but `calculate` accepted anything a caller
  // passed in, so a 500%-risk request was sized as-is and a 1e308 capital
  // produced lots = 2e302 with profitTp1Idr = Infinity while still reporting
  // isValid: true. One band, enforced on every path.
  var MIN_CAPITAL_IDR = 100000;        // Rp 100.000
  var MAX_CAPITAL_IDR = 1e15;          // Rp 1 quadrillion — far beyond any retail account
  var MIN_RISK_PCT = 0.1;
  var MAX_RISK_PCT = 10;

  /**
   * Normalisasi angka dari input pengguna.
   * - Mode default (rupiah/harga): "10.000.000" dan "10.000" dibaca sebagai ribuan.
   * - Mode decimal (persentase/rasio): "0.500" tetap 0.5 (BUG-F7-001).
   * Titik desimal hanya dianggap pemisah ribuan bila ada >= 2 titik, atau
   * tepat 3 digit di belakang titik dengan grup depan bukan nol (mis. 10.000).
   */
  function sanitizeNumber(val, fallback, options) {
    if (val === null || val === undefined || val === '') return fallback;
    if (typeof val === 'number') return isFinite(val) ? val : fallback;
    var s = String(val).trim();
    var decimalMode = !!(options && options.decimal);

    // F5-B3-02: exponential notation is NOT part of this input contract. The
    // old pipeline deleted the "e" and re-read "1e400" as "1400", turning an
    // overflowing/garbage entry into a plausible-looking number. Refuse it.
    if (/\d\s*[eE]\s*[+-]?\s*\d/.test(s)) return fallback;

    // F5-B3-01: strip the currency/sign prefix BEFORE the separator heuristic.
    // Previously "-Rp 10.000" kept its "Rp" (the prefix regex excluded "-"),
    // so the groups were ["-Rp 10","000"] and the thousand separator was not
    // recognised: minus ten thousand collapsed to minus ten.
    var firstDigit = s.search(/[0-9]/);
    if (firstDigit < 0) return fallback;
    var isNegative = s.slice(0, firstDigit).indexOf('-') >= 0;
    var body = s.slice(firstDigit);

    var dotCount = (body.match(/\./g) || []).length;
    if (dotCount > 1) {
      body = body.replace(/\./g, '');
    } else if (dotCount === 1 && !decimalMode) {
      var groups = body.split('.');
      if (/^\d{1,3}$/.test(groups[0]) && /^\d{3}$/.test(groups[1]) && !/^0/.test(groups[0])) {
        body = body.replace(/\./g, '');
      }
    }
    body = body.replace(/,/g, '.').replace(/[^0-9.]/g, '');
    if (!body) return fallback;
    var n = Number(body);
    if (!isFinite(n)) return fallback;
    return isNegative && n > 0 ? -n : n;
  }

  /**
   * Fraksi tick harga IDX (Regular Board).
   * < 200 : Rp 1 | 200 - < 500 : Rp 2 | 500 - < 2000 : Rp 5
   * 2000 - < 5000 : Rp 10 | >= 5000 : Rp 25
   */
  function idxTickSize(price, board, isFca, ticker) {
    var p = Number(price);
    if (!isFinite(p) || p <= 0) return 0;
    if (typeof board === 'object' && board !== null) { ticker = board.ticker; isFca = board.isFca != null ? board.isFca : board.is_fca; board = board.board || board.papan; }
    try {
      if (typeof require === 'function') {
        var idxLocal = require('../lib/idx-tick-normalization');
        var sz = idxLocal.getIdxTickSize(p, board, isFca, ticker);
        if (sz != null) return sz;
      } else if (typeof root !== 'undefined' && root.getIdxTickSize) {
        var sz2 = root.getIdxTickSize(p, board, isFca, ticker);
        if (sz2 != null) return sz2;
      }
    } catch (_) {}
    if (isFca === true || isFca === 1 || (typeof isFca === 'string' && /^(true|1|yes|y)$/i.test(String(isFca).trim())) || String(board||'').toUpperCase().indexOf('AKSELERASI')>=0 || String(board||'').toUpperCase().indexOf('PEMANTAUAN')>=0) return 1;
    if (p < 200) return 1;
    if (p < 500) return 2;
    if (p < 2000) return 5;
    if (p < 5000) return 10;
    return 25;
  }

  /**
   * Validasi harga terhadap fraksi tick IDX (BUG-F7-002).
   * Harga pecahan desimal dan harga yang tidak kelipatan tick dinyatakan tidak valid.
   */
  function isValidIdxTick(price, board, isFca, ticker) {
    var raw = Number(price);
    if (!isFinite(raw) || raw <= 0) return false;
    var p = Math.round(raw);
    if (Math.abs(raw - p) > 1e-9) return false;
    if (typeof board === 'object' && board !== null) { ticker = board.ticker; isFca = board.isFca != null ? board.isFca : board.is_fca; board = board.board || board.papan; }
    var tick = idxTickSize(p, board, isFca, ticker);
    if (tick <= 0) return false;
    return p % tick === 0;
  }

  /**
   * Auto-snap level harga ke fraksi tick IDX valid terdekat.
   * Menghindari lemparan error ke user jika level Stop Loss atau Entry berada di bawah Rp 5.000
   * tetapi bukan kelipatan 10 (misal 4.925 otomatis di-snap ke 4.930 atau 4.920).
   */
  function snapToTick(price, mode, board, isFca, ticker) {
    var raw = Number(price);
    if (!isFinite(raw) || raw <= 0) return 0;
    var tick = idxTickSize(raw, board, isFca, ticker);
    if (tick <= 0) return Math.round(raw);
    mode = mode || 'nearest';
    if (mode === 'up' || mode === 'ceil') return Math.ceil(raw / tick) * tick;
    if (mode === 'down' || mode === 'floor') return Math.floor(raw / tick) * tick;
    return Math.round(raw / tick) * tick;
  }


  function getSettings() {
    var storedCapital = null;
    var storedRisk = null;
    try {
      if (typeof localStorage !== 'undefined') {
        storedCapital = localStorage.getItem(STORAGE_KEY_CAPITAL);
        storedRisk = localStorage.getItem(STORAGE_KEY_RISK_PCT);
      }
    } catch (_) {}

    var capital = sanitizeNumber(storedCapital, null);
    var riskPct = sanitizeNumber(storedRisk, null, { decimal: true });
    var isCustom = capital !== null && capital > 0;

    return {
      capital: isCustom ? capital : DEFAULT_CAPITAL,
      riskPct: riskPct !== null && riskPct > 0 ? riskPct : DEFAULT_RISK_PCT,
      isCustom: isCustom
    };
  }

  function saveSettings(capital, riskPct) {
    var c = Math.max(MIN_CAPITAL_IDR, Math.min(MAX_CAPITAL_IDR, sanitizeNumber(capital, DEFAULT_CAPITAL)));
    var r = Math.max(MIN_RISK_PCT, Math.min(MAX_RISK_PCT, sanitizeNumber(riskPct, DEFAULT_RISK_PCT, { decimal: true })));
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY_CAPITAL, String(c));
        localStorage.setItem(STORAGE_KEY_RISK_PCT, String(r));
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('autocuan:settings-updated', { detail: { capital: c, riskPct: r } }));
      }
    } catch (_) {}
    return { capital: c, riskPct: r, isCustom: true };
  }

  function fmtRp(val) {
    var n = Math.round(Number(val) || 0);
    return 'Rp ' + n.toLocaleString('id-ID');
  }

  function fmtRpCompact(val) {
    var n = Number(val) || 0;
    var abs = Math.abs(n);
    var sign = n < 0 ? '-' : '';
    if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(1).replace('.', ',') + 'M';
    if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1).replace('.', ',') + 'jt';
    if (abs >= 1e3) return sign + 'Rp ' + Math.round(abs / 1e3) + 'rb';
    return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
  }

  function calculate(params) {
    params = params || {};
    var settings = getSettings();
    var capital = sanitizeNumber(params.capital, settings.capital);
    var riskPct = sanitizeNumber(params.riskPct, settings.riskPct, { decimal: true });
    var entry = sanitizeNumber(params.entry || params.entry1 || params.e1, 0);
    var sl = sanitizeNumber(params.sl, 0);
    var tp1 = sanitizeNumber(params.tp1 || params.t1, 0);
    var tp2 = sanitizeNumber(params.tp2 || params.t2, 0);
    var kini = sanitizeNumber(params.kini != null ? params.kini : (params.currentPrice != null ? params.currentPrice : (params.last_price != null ? params.last_price : params.last)), entry);

    if (!(capital > 0)) capital = DEFAULT_CAPITAL;
    capital = Math.max(MIN_CAPITAL_IDR, Math.min(MAX_CAPITAL_IDR, capital));
    if (!(riskPct > 0)) riskPct = DEFAULT_RISK_PCT;
    riskPct = Math.max(MIN_RISK_PCT, Math.min(MAX_RISK_PCT, riskPct));

    // Guard: jika SL atau Entry kosong atau bernilai "-" atau <= 0
    if (entry <= 0 || sl <= 0 || params.entry === '-' || params.sl === '-' || params.entry === '—' || params.sl === '—') {
      return {
        isValid: false,
        emptySl: true,
        reason: 'Level Entry atau Stop Loss belum valid atau belum terdefinisi.',
        capital: capital,
        riskPct: riskPct
      };
    }

    var calcBoard = params.board || params.papan || null;
    var calcIsFca = params.is_fca != null ? params.is_fca : (params.isFca != null ? params.isFca : null);
    var calcTicker = params.ticker || null;

    // Auto-snap entry dan sl jika diminta (misal dari widget UI atau mode snapToTick)
    // BUG-F7-002 / F11-02: Jika tidak dalam mode snapToTick, tolak harga yang tidak sesuai fraksi tick IDX
    if (params.snapToTick || params.autoSnap) {
      if (!isValidIdxTick(entry, calcBoard, calcIsFca, calcTicker)) {
        entry = snapToTick(entry, 'nearest', calcBoard, calcIsFca, calcTicker);
      }
      if (!isValidIdxTick(sl, calcBoard, calcIsFca, calcTicker)) {
        sl = snapToTick(sl, 'nearest', calcBoard, calcIsFca, calcTicker);
      }
      if (kini > 0 && !isValidIdxTick(kini, calcBoard, calcIsFca, calcTicker)) {
        kini = snapToTick(kini, 'nearest', calcBoard, calcIsFca, calcTicker);
      }
    } else {
      if (!isValidIdxTick(entry, calcBoard, calcIsFca, calcTicker)) {
        return {
          isValid: false,
          reason: 'Harga Entry (' + entry + ') tidak sesuai fraksi tick IDX.',
          capital: capital,
          riskPct: riskPct
        };
      }
      if (!isValidIdxTick(sl, calcBoard, calcIsFca, calcTicker)) {
        return {
          isValid: false,
          reason: 'Harga Stop Loss (' + sl + ') tidak sesuai fraksi tick IDX.',
          capital: capital,
          riskPct: riskPct
        };
      }
    }

    var deltaP = entry - sl;
    if (deltaP <= 0) {
      return {
        isValid: false,
        reason: 'Stop Loss (' + sl + ') harus lebih rendah dari Entry (' + entry + ').',
        capital: capital,
        riskPct: riskPct
      };
    }

    // Toleransi risiko dalam rupiah
    var maxRiskBudget = capital * (riskPct / 100);
    // 1 lot = 100 lembar
    var riskPerLotEntry = 100 * deltaP;
    var costPerLotEntry = 100 * entry;

    var deltaKini = (kini > sl) ? (kini - sl) : deltaP;
    var riskPerLotKini = 100 * deltaKini;
    var costPerLotKini = 100 * (kini > 0 ? kini : entry);

    var lotsByRiskKini = riskPerLotKini > 0 ? Math.floor(maxRiskBudget / riskPerLotKini) : 0;
    var lotsByCapitalKini = costPerLotKini > 0 ? Math.floor(capital / costPerLotKini) : 0;
    var lotsAtCurrent = Math.min(lotsByRiskKini, lotsByCapitalKini);

    var deltaEntry = deltaP;
    var riskPerLotEntry = 100 * deltaEntry;
    var costPerLotEntry = 100 * entry;
    var lotsByRiskEntry = riskPerLotEntry > 0 ? Math.floor(maxRiskBudget / riskPerLotEntry) : 0;
    var lotsByCapitalEntry = costPerLotEntry > 0 ? Math.floor(capital / costPerLotEntry) : 0;
    var lotsAtEntry1 = Math.min(lotsByRiskEntry, lotsByCapitalEntry);

    var lots = lotsAtCurrent;
    var cappedByCapital = lotsByCapitalKini < lotsByRiskKini && lotsByCapitalKini > 0;

    var positionValue = lots * costPerLotKini;
    
    // Label 1: Skenario Tunggu Entry 1 (lotsAtEntry1 x 100 x (Entry1 - SL))
    var riskAtEntry1 = lotsAtEntry1 * riskPerLotEntry;
    var riskAtEntry1Pct = capital > 0 ? (riskAtEntry1 / capital) * 100 : 0;
    
    // Label 2: Skenario Beli Sekarang di Harga Kini (lotsAtCurrent x 100 x (Kini - SL))
    var riskAtCurrent = lotsAtCurrent * riskPerLotKini;
    var riskAtCurrentPct = capital > 0 ? (riskAtCurrent / capital) * 100 : 0;

    var scenarioNowText = 'Beli Sekarang (Harga Kini): ' + lotsAtCurrent + ' Lot (Risiko ' + fmtRp(riskAtCurrent) + ' / ' + riskAtCurrentPct.toFixed(2).replace('.', ',') + '%)';
    var scenarioPullbackText = 'Tunggu Entry 1: ' + lotsAtEntry1 + ' Lot (Risiko ' + fmtRp(riskAtEntry1) + ' / ' + riskAtEntry1Pct.toFixed(2).replace('.', ',') + '%)';

    var cashRemaining = Math.max(0, capital - positionValue);
    var allocationPct = capital > 0 ? (positionValue / capital) * 100 : 0;

    // Unifikasi formula R/R:
    // R/R awal = (TP1 - Entry 1) / (Entry 1 - SL)
    var rrAwal = (tp1 > entry && deltaP > 0) ? ((tp1 - entry) / deltaP) : 0;
    // Sisa R/R = (TP1 - Kini) / (Kini - SL)
    var rrSisa = (tp1 > kini && kini > sl) ? ((tp1 - kini) / (kini - sl)) : 0;
    var isRemainingRrAdequate = rrSisa >= 1.3;

    var profitTp1Idr = tp1 > entry ? lots * 100 * (tp1 - entry) : 0;
    var profitTp1Pct = capital > 0 ? (profitTp1Idr / capital) * 100 : 0;
    var profitTp2Idr = tp2 > entry ? lots * 100 * (tp2 - entry) : 0;
    var profitTp2Pct = capital > 0 ? (profitTp2Idr / capital) * 100 : 0;

    var minCapitalFor1Lot = costPerLotKini;
    var minCapitalFor1LotRisk = Math.ceil(riskPerLotKini / (riskPct / 100));

    return {
      isValid: true,
      capital: capital,
      riskPct: riskPct,
      isCustomCapital: settings.isCustom,
      entry: entry,
      sl: sl,
      kini: kini,
      tp1: tp1,
      tp2: tp2,
      deltaP: deltaP,
      deltaKini: deltaKini,
      riskPerLot: riskPerLotEntry,
      riskPerLotEntry: riskPerLotEntry,
      riskPerLotKini: riskPerLotKini,
      costPerLot: costPerLotKini,
      lots: lots,
      lotsAtCurrent: lotsAtCurrent,
      lotsAtEntry1: lotsAtEntry1,
      shares: lots * 100,
      positionValue: positionValue,
      actualRiskIdr: riskAtCurrent,
      actualRiskPct: riskAtCurrentPct,
      riskAtEntry1: riskAtEntry1,
      riskAtEntry1Pct: riskAtEntry1Pct,
      riskAtCurrent: riskAtCurrent,
      riskAtCurrentPct: riskAtCurrentPct,
      scenarioNowText: scenarioNowText,
      scenarioPullbackText: scenarioPullbackText,
      rrAwal: rrAwal,
      rrSisa: rrSisa,
      isRemainingRrAdequate: isRemainingRrAdequate,
      cashRemaining: cashRemaining,
      allocationPct: allocationPct,
      profitTp1Idr: profitTp1Idr,
      profitTp1Pct: profitTp1Pct,
      profitTp2Idr: profitTp2Idr,
      profitTp2Pct: profitTp2Pct,
      cappedByCapital: cappedByCapital,
      minCapitalFor1Lot: minCapitalFor1Lot,
      minCapitalFor1LotRisk: minCapitalFor1LotRisk
    };
  }

  function renderCardWidget(r, options) {
    options = options || {};
    var levels = options.levels;
    if (!levels && typeof root.normalizeDisplayLevels === 'function') {
      levels = root.normalizeDisplayLevels(r);
    }
    var entry = (levels && (levels.e1 || levels.entry1)) || r.entry_low || r.entry1 || r.last_price || 0;
    var sl = (levels && levels.sl) || r.stop_loss || r.sl || 0;
    var tp1 = (levels && levels.t1) || r.tp1 || 0;
    var tp2 = (levels && levels.t2) || r.tp2 || 0;
    var kini = (levels && (levels.kini || levels.last_price || levels.currentPrice)) || r.last_price || r.current_price || r.last || entry;

    // Kondisi SL / Entry kosong: render "-" bersih tanpa kalkulasi risiko palsu
    if (entry === '-' || sl === '-' || entry === '—' || sl === '—' || !entry || !sl) {
      return '<div class="ac-pos-calc-box ac-pos-empty" style="margin-top:8px;padding:6px 10px;background:rgba(15,23,42,0.4);border:1px dashed rgba(148,163,184,0.15);border-radius:8px;font-size:10px;color:#94a3b8">' +
        '<span>Saran Posisi: <strong>—</strong> <span style="color:#64748b;font-size:9px">(Level SL/Entry belum terdefinisi)</span></span></div>';
    }

    var calc = calculate({ entry: entry, sl: sl, tp1: tp1, tp2: tp2, kini: kini });
    if (!calc.isValid) {
      return '<div class="ac-pos-calc-box ac-pos-empty" style="margin-top:8px;padding:6px 10px;background:rgba(15,23,42,0.4);border:1px dashed rgba(148,163,184,0.15);border-radius:8px;font-size:10px;color:#94a3b8">' +
        '<span>Saran Posisi: <strong>—</strong> <span style="color:#64748b;font-size:9px">(' + (calc.reason || 'Data level belum lengkap') + ')</span></span></div>';
    }

    var isDefault = !calc.isCustomCapital;
    var capitalFmt = fmtRpCompact(calc.capital);

    var lotText = calc.lots > 0
      ? '<strong style="color:#6ee7b7;font-size:12px">' + calc.lots.toLocaleString('id-ID') + ' Lot</strong> (' + fmtRpCompact(calc.positionValue) + ')'
      : '<span style="color:#f87171;font-weight:600">0 Lot</span> <span style="color:#94a3b8;font-size:9px">(Modal/risk butuh min ' + fmtRpCompact(calc.minCapitalFor1LotRisk) + ')</span>';

    var html = '<div class="ac-pos-calc-box" onclick="event.stopPropagation()" style="margin-top:10px;padding:8px 10px;background:rgba(15,23,42,0.65);border:1px solid rgba(59,130,246,0.22);border-radius:9px;font-size:10px;line-height:1.4">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px">';
    html += '<div style="display:flex;align-items:center;gap:5px">';
    html += '<span style="font-weight:700;color:#93c5fd">Saran Posisi:</span> ' + lotText;
    html += '</div>';
    html += '<button type="button" onclick="PositionSizing.openModal(event)" style="background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);color:#93c5fd;font-size:9px;font-weight:600;padding:2px 6px;border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;gap:3px" title="Atur modal trading & toleransi risiko">';
    html += (isDefault ? 'Atur Modal' : capitalFmt + ' (' + calc.riskPct + '%)');
    html += '</button>';
    html += '</div>';

    if (calc.lots > 0) {
      html += '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:5px 12px;font-size:9.5px;color:#9ca3af">';
      html += '<span>Risiko di Entry 1: <strong style="color:#fca5a5">-' + fmtRpCompact(calc.riskAtEntry1) + '</strong> (' + calc.riskAtEntry1Pct.toFixed(1) + '%)</span>';
      html += '<span>Risiko di Harga Kini: <strong style="color:#fca5a5">-' + fmtRpCompact(calc.riskAtCurrent) + '</strong> (' + calc.riskAtCurrentPct.toFixed(1) + '%)</span>';
      if (calc.rrAwal > 0) {
        html += '<span>R/R Awal: <strong style="color:#93c5fd">' + calc.rrAwal.toFixed(1) + '</strong></span>';
      }
      if (calc.rrSisa > 0) {
        var sisaColor = calc.isRemainingRrAdequate ? '#6ee7b7' : '#f59e0b';
        html += '<span>Sisa R/R: <strong style="color:' + sisaColor + '">' + calc.rrSisa.toFixed(1) + (calc.isRemainingRrAdequate ? '' : ' (!)') + '</strong></span>';
      }
      if (calc.profitTp1Idr > 0) {
        html += '<span>TP1: <strong style="color:#6ee7b7">+' + fmtRpCompact(calc.profitTp1Idr) + '</strong> (+' + calc.profitTp1Pct.toFixed(1) + '%)</span>';
      }
      if (calc.profitTp2Idr > 0) {
        html += '<span>TP2: <strong style="color:#6ee7b7">+' + fmtRpCompact(calc.profitTp2Idr) + '</strong> (+' + calc.profitTp2Pct.toFixed(1) + '%)</span>';
      }
      if (!calc.isRemainingRrAdequate && calc.rrSisa > 0) {
        html += '<span style="color:#fbbf24;font-size:9px;font-weight:700">R/R TIPIS (&lt; 1,3)</span>';
      }
      if (calc.cappedByCapital) {
        html += '<span style="color:#fbbf24;font-size:9px">Lot dibatasi plafon modal</span>';
      }
      html += '</div>';

      if (calc.lotsAtCurrent !== calc.lotsAtEntry1 || calc.kini !== calc.entry) {
        html += '<div class="ac-pos-scenario-box" style="margin-top:6px;padding:5px 8px;border-radius:6px;font-size:9.5px;display:flex;flex-direction:column;gap:3px;line-height:1.35">';
        html += '<div><span class="ac-pos-scenario-a" style="font-weight:600">Skenario A:</span> ' + calc.scenarioNowText + '</div>';
        html += '<div><span class="ac-pos-scenario-b" style="font-weight:600">Skenario B:</span> ' + calc.scenarioPullbackText + '</div>';
        html += '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  function renderDetailSection(r) {
    var levels = typeof root.normalizeDisplayLevels === 'function' ? root.normalizeDisplayLevels(r) : null;
    var entry = (levels && levels.e1) || r.entry1 || r.last_price || 0;
    var sl = (levels && levels.sl) || r.stop_loss || r.sl || 0;
    var tp1 = (levels && levels.t1) || r.tp1 || 0;
    var tp2 = (levels && levels.t2) || r.tp2 || 0;
    var kini = (levels && (levels.kini || levels.last_price)) || r.last_price || r.current_price || entry;

    if (entry === '-' || sl === '-' || entry === '—' || sl === '—' || !entry || !sl) {
      return '<div class="ac-pos-detail-section" style="margin-bottom:16px;padding:14px;background:rgba(15,23,42,0.6);border:1px dashed rgba(148,163,184,0.18);border-radius:12px">' +
        '<div style="font-size:11px;color:#94a3b8">Kalkulator Ukuran Posisi: Komponen harga (Entry / Stop Loss) belum terdefinisi.</div></div>';
    }

    var calc = calculate({ entry: entry, sl: sl, tp1: tp1, tp2: tp2, kini: kini });
    var html = '<div class="ac-pos-detail-section" style="margin-bottom:16px;padding:14px;background:rgba(15,23,42,0.6);border:1px solid rgba(59,130,246,0.25);border-radius:12px">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">';
    html += '<div style="display:flex;align-items:center;gap:8px"><div><div style="font-size:11px;font-weight:700;color:#93c5fd;text-transform:uppercase;letter-spacing:0.8px">Kalkulator Ukuran Posisi</div><div style="font-size:10px;color:#94a3b8">Berdasarkan toleransi risiko akun Anda</div></div></div>';
    html += '<button type="button" onclick="PositionSizing.openModal(event)" class="ac-btn" data-size="sm" style="font-size:10px;padding:4px 9px;border-radius:7px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.4);color:#93c5fd;cursor:pointer">Ubah Modal / Risiko</button>';
    html += '</div>';

    if (!calc.isValid) {
      html += '<div style="font-size:11px;color:#fca5a5;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);padding:10px;border-radius:8px">' + (calc.reason || 'Level sinyal tidak lengkap.') + '</div>';
      html += '</div>';
      return html;
    }

    if (calc.lotsAtCurrent !== calc.lotsAtEntry1 || calc.kini !== calc.entry) {
      html += '<div style="margin-bottom:12px;padding:8px 12px;background:rgba(30,41,59,0.5);border:1px solid rgba(59,130,246,0.3);border-radius:8px;font-size:11px;color:#e2e8f0;display:flex;flex-direction:column;gap:4px">';
      html += '<div style="font-weight:700;color:#93c5fd;margin-bottom:2px">Skenario Posisi:</div>';
      html += '<div><span style="color:#93c5fd;font-weight:600">Skenario A:</span> ' + calc.scenarioNowText + '</div>';
      html += '<div><span style="color:#a7f3d0;font-weight:600">Skenario B:</span> ' + calc.scenarioPullbackText + '</div>';
      html += '</div>';
    }

    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:8px;margin-bottom:12px">';
    html += '<div style="background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:9px;padding:10px"><div style="font-size:9px;color:#4ead8a;margin-bottom:2px;font-weight:600">Saran Pembelian</div><div style="font-size:17px;font-weight:800;color:#6ee7b7">' + calc.lots.toLocaleString('id-ID') + ' Lot</div><div style="font-size:10px;color:#9ca3af">' + fmtRpCompact(calc.positionValue) + ' (' + calc.allocationPct.toFixed(1) + '% modal)</div></div>';
    html += '<div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:9px;padding:10px"><div style="font-size:9px;color:#d87171;margin-bottom:2px;font-weight:600">Risiko di Entry 1</div><div style="font-size:17px;font-weight:800;color:#fca5a5">-' + fmtRpCompact(calc.riskAtEntry1) + '</div><div style="font-size:10px;color:#9ca3af">-' + calc.riskAtEntry1Pct.toFixed(1) + '% dari modal</div></div>';
    html += '<div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:9px;padding:10px"><div style="font-size:9px;color:#d87171;margin-bottom:2px;font-weight:600">Risiko di Harga Kini</div><div style="font-size:17px;font-weight:800;color:#fca5a5">-' + fmtRpCompact(calc.riskAtCurrent) + '</div><div style="font-size:10px;color:#9ca3af">-' + calc.riskAtCurrentPct.toFixed(1) + '% dari modal</div></div>';
    html += '<div style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.2);border-radius:9px;padding:10px"><div style="font-size:9px;color:#6b9fd8;margin-bottom:2px;font-weight:600">Potensi TP1 (' + (calc.tp1 ? calc.tp1.toLocaleString('id-ID') : '-') + ')</div><div style="font-size:17px;font-weight:800;color:#93c5fd">+' + fmtRpCompact(calc.profitTp1Idr) + '</div><div style="font-size:10px;color:#9ca3af">+' + calc.profitTp1Pct.toFixed(1) + '% dari modal</div></div>';
    html += '<div style="background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.2);border-radius:9px;padding:10px"><div style="font-size:9px;color:#a78bfa;margin-bottom:2px;font-weight:600">Potensi TP2 (' + (calc.tp2 ? calc.tp2.toLocaleString('id-ID') : '-') + ')</div><div style="font-size:17px;font-weight:800;color:#c4b5fd">+' + fmtRpCompact(calc.profitTp2Idr) + '</div><div style="font-size:10px;color:#9ca3af">+' + calc.profitTp2Pct.toFixed(1) + '% dari modal</div></div>';
    html += '</div>';

    html += '<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;font-size:10px;color:#9ca3af;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);gap:6px">';
    html += '<span>Modal Aktif: <strong style="color:#e2e8f0">' + fmtRp(calc.capital) + '</strong> · Toleransi Risiko: <strong style="color:#e2e8f0">' + calc.riskPct + '%</strong></span>';
    html += '<span>R/R Awal: <strong style="color:#93c5fd">' + (calc.rrAwal > 0 ? calc.rrAwal.toFixed(1) : '—') + '</strong> · Sisa R/R: <strong style="color:' + (calc.isRemainingRrAdequate ? '#6ee7b7' : '#f59e0b') + '">' + (calc.rrSisa > 0 ? calc.rrSisa.toFixed(1) : '—') + (calc.isRemainingRrAdequate ? '' : ' (R/R TIPIS)') + '</strong></span>';
    html += '<span>Sisa Kas Rencana: <strong style="color:#e2e8f0">' + fmtRp(calc.cashRemaining) + '</strong></span>';
    html += '</div>';
    if (!calc.isRemainingRrAdequate && calc.rrSisa > 0) {
      html += '<div style="margin-top:6px;font-size:10px;color:#fbbf24">Sisa Risk/Reward (' + calc.rrSisa.toFixed(1) + ') di bawah batas minimum 1,3. Pertimbangkan menunggu pullback ke area Entry 1 sebelum mengeksekusi pembelian.</div>';
    }
    if (calc.cappedByCapital) {
      html += '<div style="margin-top:6px;font-size:10px;color:#fbbf24">Jumlah lot disesuaikan ke bawah karena dibatasi oleh total modal trading yang tersedia.</div>';
    }
    html += '</div>';
    return html;
  }


  function ensureModalHtml() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('posCalcModal')) return;

    var modal = document.createElement('div');
    modal.id = 'posCalcModal';
    modal.className = 'hidden fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'posCalcModalTitle');
    modal.onclick = function (e) {
      if (e.target === modal) closeModal();
    };

    modal.innerHTML = [
      '<div class="w-full max-w-sm rounded-2xl border border-dark-600/80 bg-[#111827] p-5 sm:p-6 shadow-2xl space-y-4" onclick="event.stopPropagation()">',
      '  <div class="flex items-center justify-between border-b border-gray-800 pb-3">',
      '    <div class="flex items-center gap-2">',
      '      <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>',
      '      <h3 id="posCalcModalTitle" class="text-base font-bold text-white">Atur Modal &amp; Toleransi Risiko</h3>',
      '    </div>',
      '    <button type="button" onclick="PositionSizing.closeModal()" class="text-gray-500 hover:text-gray-300 text-xl leading-none" aria-label="Tutup modal">&times;</button>',
      '  </div>',
      '  <div class="space-y-3.5 text-xs">',
      '    <div>',
      '      <label for="posCalcCapitalInput" class="block text-xs font-semibold text-gray-300 mb-1">Total Modal Trading (Rp)</label>',
      '      <input type="text" id="posCalcCapitalInput" inputmode="numeric" placeholder="Contoh: 10.000.000" class="w-full px-3.5 py-2.5 rounded-xl bg-[#0b0e14] border border-gray-700 text-gray-100 font-semibold focus:outline-none focus:border-blue-500 text-sm">',
      '      <p class="mt-1 text-[10px] text-gray-400">Digunakan sebagai basis perhitungan lot dan batasan risiko.</p>',
      '    </div>',
      '    <div>',
      '      <label for="posCalcRiskInput" class="block text-xs font-semibold text-gray-300 mb-1">Maksimal Risiko per Trade (%)</label>',
      '      <div class="flex items-center gap-2 mb-2">',
      '        <button type="button" onclick="PositionSizing.setRiskPreset(0.5)" class="pos-risk-preset px-2.5 py-1 rounded-lg border border-gray-700 hover:border-blue-500 text-gray-300 hover:text-white transition">0.5%</button>',
      '        <button type="button" onclick="PositionSizing.setRiskPreset(1.0)" class="pos-risk-preset px-2.5 py-1 rounded-lg border border-gray-700 hover:border-blue-500 text-gray-300 hover:text-white transition">1.0% (Disarankan)</button>',
      '        <button type="button" onclick="PositionSizing.setRiskPreset(1.5)" class="pos-risk-preset px-2.5 py-1 rounded-lg border border-gray-700 hover:border-blue-500 text-gray-300 hover:text-white transition">1.5%</button>',
      '        <button type="button" onclick="PositionSizing.setRiskPreset(2.0)" class="pos-risk-preset px-2.5 py-1 rounded-lg border border-gray-700 hover:border-blue-500 text-gray-300 hover:text-white transition">2.0%</button>',
      '      </div>',
      '      <input type="number" id="posCalcRiskInput" step="0.1" min="0.1" max="10" placeholder="1.0" class="w-full px-3.5 py-2 rounded-xl bg-[#0b0e14] border border-gray-700 text-gray-100 font-semibold focus:outline-none focus:border-blue-500 text-xs">',
      '      <p class="mt-1 text-[10px] text-gray-400">Aturan profesional standar industri: 0.5% - 2.0% per posisi.</p>',
      '    </div>',
      '    <div id="posCalcPreview" class="p-3 rounded-xl bg-dark-800/80 border border-gray-800 text-[11px] text-gray-300 space-y-1">',
      '    </div>',
      '  </div>',
      '  <div class="flex items-center justify-end gap-2 pt-2 border-t border-gray-800">',
      '    <button type="button" onclick="PositionSizing.closeModal()" class="px-4 py-2 rounded-xl text-xs font-medium text-gray-400 hover:text-white border border-gray-700 transition">Batal</button>',
      '    <button type="button" onclick="PositionSizing.saveFromModal()" class="px-4 py-2 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-500 transition shadow-lg shadow-blue-600/20">Simpan Pengaturan</button>',
      '  </div>',
      '</div>'
    ].join('\n');

    document.body.appendChild(modal);

    var capInput = document.getElementById('posCalcCapitalInput');
    var riskInput = document.getElementById('posCalcRiskInput');
    if (capInput) {
      capInput.addEventListener('input', function () {
        var num = sanitizeNumber(capInput.value, 0);
        if (num > 0) capInput.value = num.toLocaleString('id-ID');
        updateModalPreview();
      });
    }
    if (riskInput) {
      riskInput.addEventListener('input', updateModalPreview);
    }
  }

  function updateModalPreview() {
    if (typeof document === 'undefined') return;
    var preview = document.getElementById('posCalcPreview');
    var capInput = document.getElementById('posCalcCapitalInput');
    var riskInput = document.getElementById('posCalcRiskInput');
    if (!preview || !capInput || !riskInput) return;

    var c = sanitizeNumber(capInput.value, DEFAULT_CAPITAL);
    var r = sanitizeNumber(riskInput.value, DEFAULT_RISK_PCT, { decimal: true });
    var riskMoney = c * (r / 100);

    preview.innerHTML = '<div>Maksimal rupiah yang boleh rugi per trade: <strong class="text-red-400">' + fmtRp(riskMoney) + '</strong></div>' +
      '<div class="text-[10px] text-gray-500">Jika SL terkena, saldo Anda berkurang maksimal ' + r + '%.</div>';
  }

  function openModal(e) {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    ensureModalHtml();
    var modal = document.getElementById('posCalcModal');
    if (!modal) return;
    var settings = getSettings();
    var capInput = document.getElementById('posCalcCapitalInput');
    var riskInput = document.getElementById('posCalcRiskInput');
    if (capInput) capInput.value = settings.capital.toLocaleString('id-ID');
    if (riskInput) riskInput.value = String(settings.riskPct);
    updateModalPreview();
    modal.classList.remove('hidden');
  }

  function closeModal() {
    if (typeof document === 'undefined') return;
    var modal = document.getElementById('posCalcModal');
    if (modal) modal.classList.add('hidden');
  }

  function setRiskPreset(pct) {
    var riskInput = document.getElementById('posCalcRiskInput');
    if (riskInput) {
      riskInput.value = String(pct);
      updateModalPreview();
    }
  }

  function saveFromModal() {
    var capInput = document.getElementById('posCalcCapitalInput');
    var riskInput = document.getElementById('posCalcRiskInput');
    var c = capInput ? sanitizeNumber(capInput.value, DEFAULT_CAPITAL) : DEFAULT_CAPITAL;
    var r = riskInput ? sanitizeNumber(riskInput.value, DEFAULT_RISK_PCT, { decimal: true }) : DEFAULT_RISK_PCT;
    saveSettings(c, r);
    closeModal();
    if (typeof root.showToast === 'function') {
      root.showToast('Pengaturan modal trading berhasil disimpan (' + fmtRp(c) + ' · ' + r + '%).', 'success');
    }
    // Re-render current card views if available
    refreshActiveViews();
  }

  function refreshActiveViews() {
    try {
      if (typeof root.renderDtCardGrid === 'function' && root._lastDtResults) {
        root.renderDtCardGrid(root._lastDtResults);
      }
      if (typeof root.renderKgCardGrid === 'function' && root._lastKgResults) {
        root.renderKgCardGrid(root._lastKgResults);
      }
      if (typeof root.renderNkCardGrid === 'function' && root._lastNkResults) {
        root.renderNkCardGrid(root._lastNkResults);
      }
      if (typeof root.renderDashboardTop5 === 'function' && root._dashboardTop5Cache && root._dashboardTop5Cache.data) {
        var picks = root._dashboardTop5Cache.data.top5 || root._dashboardTop5Cache.data.picks || [];
        root.renderDashboardTop5(picks);
      }
    } catch (_) {}
  }

  function calculatePosition(signal, options) {
    if (!signal) return { isValid: false, emptySl: true, reason: 'Data sinyal tidak ada' };
    options = options || {};
    var entry = sanitizeNumber(signal.entry || signal.entry1 || signal.e1 || signal.entry_low, 0);
    var sl = sanitizeNumber(signal.sl || signal.stop_loss || signal.stopLoss, 0);
    var tp1 = sanitizeNumber(signal.tp1 || signal.target_price || signal.targetPrice || signal.t1, 0);
    var tp2 = sanitizeNumber(signal.tp2 || signal.t2, 0);
    var kini = sanitizeNumber(signal.kini != null ? signal.kini : (signal.currentPrice != null ? signal.currentPrice : (signal.current_price != null ? signal.current_price : (signal.last_price != null ? signal.last_price : (signal.last != null ? signal.last : (signal.close != null ? signal.close : entry))))), entry);

    var calcParams = Object.assign({}, options, {
      ticker: signal.ticker || signal.symbol,
      board: signal.board || signal.papan,
      isFca: signal.is_fca != null ? signal.is_fca : signal.isFca,
      entry: entry,
      sl: sl,
      tp1: tp1,
      tp2: tp2,
      kini: kini
    });
    return calculate(calcParams);
  }

  return {
    getSettings: getSettings,
    saveSettings: saveSettings,
    calculate: calculate,
    calculatePosition: calculatePosition,
    snapToTick: snapToTick,
    MIN_CAPITAL_IDR: MIN_CAPITAL_IDR,
    MAX_CAPITAL_IDR: MAX_CAPITAL_IDR,
    MIN_RISK_PCT: MIN_RISK_PCT,
    MAX_RISK_PCT: MAX_RISK_PCT,
    sanitizeNumber: sanitizeNumber,
    idxTickSize: idxTickSize,
    isValidIdxTick: isValidIdxTick,
    fmtRp: fmtRp,
    fmtRpCompact: fmtRpCompact,
    renderCardWidget: renderCardWidget,
    renderDetailSection: renderDetailSection,
    openModal: openModal,
    closeModal: closeModal,
    setRiskPreset: setRiskPreset,
    saveFromModal: saveFromModal,
    refreshActiveViews: refreshActiveViews
  };
});
