'use strict';

/**
 * V3-F04 UI toggle — "Tampilkan seluruh universe mentah".
 * ========================================================
 * Satu-satunya toggle eksplisit yang boleh membuka universe mentah
 * (default: filter ketat V3-F03 aktif, publishedCount <= ceil(universe*0.35)).
 * Dipakai 3 tab: konglo / nonkonglo / daytrade.
 * Tanpa toggle ini, tabel hanya menampilkan hasil filter ketat (anti 165/165).
 */

(function (root) {
  var SHOW_RAW_LABEL = 'Tampilkan seluruh universe mentah';
  var state = { konglo: false, nonkonglo: false, daytrade: false };

  function isShowRaw(mode) {
    return state[mode] === true;
  }

  function setShowRaw(mode, on) {
    state[mode] = on === true;
    try {
      if (typeof root.applyScreenerUiFilters === 'function') {
        root.applyScreenerUiFilters(mode);
      }
    } catch (_) {}
    return state[mode];
  }

  function toggleShowRaw(mode) {
    return setShowRaw(mode, !isShowRaw(mode));
  }

  function filterRows(mode, rows) {
    if (isShowRaw(mode)) return rows || [];
    return (rows || []).filter(function (r) {
      if (!r) return false;
      if (r.v3f04_strict_pass === true) return true;
      // Kompatibel mundur: baris lama tanpa flag V3-F04 tetap tampil bila
      // memenuhi ambang kasar (skor>=62, RR>=1.5) agar tidak blank total.
      var score = Number(r.score != null ? r.score : r.daytrade_score);
      var rr = Number(r.risk_reward != null ? r.risk_reward : r.rr);
      return score >= 62 && rr >= 1.5;
    });
  }

  root.V3F04ShowRaw = {
    SHOW_RAW_LABEL: SHOW_RAW_LABEL,
    isShowRaw: isShowRaw,
    setShowRaw: setShowRaw,
    toggleShowRaw: toggleShowRaw,
    filterRows: filterRows
  };
})(typeof window !== 'undefined' ? window : globalThis);
