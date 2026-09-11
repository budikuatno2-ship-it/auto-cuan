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

  function sanitizeNumber(val, fallback) {
    if (val === null || val === undefined || val === '') return fallback;
    if (typeof val === 'number') return isFinite(val) ? val : fallback;
    var s = String(val).trim();
    if (/\.\d{3}/.test(s) || (s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, '');
    }
    s = s.replace(/,/g, '.').replace(/[^0-9.-]/g, '');
    var n = Number(s);
    return isFinite(n) ? n : fallback;
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
    var riskPct = sanitizeNumber(storedRisk, null);
    var isCustom = capital !== null && capital > 0;

    return {
      capital: isCustom ? capital : DEFAULT_CAPITAL,
      riskPct: riskPct !== null && riskPct > 0 ? riskPct : DEFAULT_RISK_PCT,
      isCustom: isCustom
    };
  }

  function saveSettings(capital, riskPct) {
    var c = Math.max(100000, sanitizeNumber(capital, DEFAULT_CAPITAL));
    var r = Math.max(0.1, Math.min(10, sanitizeNumber(riskPct, DEFAULT_RISK_PCT)));
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
    var riskPct = sanitizeNumber(params.riskPct, settings.riskPct);
    var entry = sanitizeNumber(params.entry, 0);
    var sl = sanitizeNumber(params.sl, 0);
    var tp1 = sanitizeNumber(params.tp1, 0);
    var tp2 = sanitizeNumber(params.tp2, 0);

    if (capital <= 0) capital = DEFAULT_CAPITAL;
    if (riskPct <= 0) riskPct = DEFAULT_RISK_PCT;

    if (entry <= 0 || sl <= 0) {
      return {
        isValid: false,
        reason: 'Level Entry atau Stop Loss belum valid.',
        capital: capital,
        riskPct: riskPct
      };
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
    var riskPerLot = 100 * deltaP;
    var costPerLot = 100 * entry;

    var lotsByRisk = Math.floor(maxRiskBudget / riskPerLot);
    var lotsByCapital = Math.floor(capital / costPerLot);
    var lots = Math.min(lotsByRisk, lotsByCapital);
    var cappedByCapital = lotsByCapital < lotsByRisk && lotsByCapital > 0;

    var positionValue = lots * costPerLot;
    var actualRiskIdr = lots * riskPerLot;
    var actualRiskPct = capital > 0 ? (actualRiskIdr / capital) * 100 : 0;
    var cashRemaining = Math.max(0, capital - positionValue);
    var allocationPct = capital > 0 ? (positionValue / capital) * 100 : 0;

    var profitTp1Idr = tp1 > entry ? lots * 100 * (tp1 - entry) : 0;
    var profitTp1Pct = capital > 0 ? (profitTp1Idr / capital) * 100 : 0;
    var profitTp2Idr = tp2 > entry ? lots * 100 * (tp2 - entry) : 0;
    var profitTp2Pct = capital > 0 ? (profitTp2Idr / capital) * 100 : 0;

    var minCapitalFor1Lot = costPerLot;
    var minCapitalFor1LotRisk = Math.ceil(riskPerLot / (riskPct / 100));

    return {
      isValid: true,
      capital: capital,
      riskPct: riskPct,
      isCustomCapital: settings.isCustom,
      entry: entry,
      sl: sl,
      tp1: tp1,
      tp2: tp2,
      deltaP: deltaP,
      riskPerLot: riskPerLot,
      costPerLot: costPerLot,
      lots: lots,
      shares: lots * 100,
      positionValue: positionValue,
      actualRiskIdr: actualRiskIdr,
      actualRiskPct: actualRiskPct,
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

    var calc = calculate({ entry: entry, sl: sl, tp1: tp1, tp2: tp2 });
    if (!calc.isValid) {
      return '<div class="ac-pos-calc-box ac-pos-invalid" style="margin-top:8px;padding:6px 10px;background:rgba(30,41,59,0.4);border:1px dashed #334155;border-radius:8px;font-size:10px;color:#94a3b8">' +
        '<span>🧮 Kalkulator Posisi: ' + (calc.reason || 'Data level belum lengkap') + '</span></div>';
    }

    var isDefault = !calc.isCustomCapital;
    var capitalFmt = fmtRpCompact(calc.capital);

    var lotText = calc.lots > 0
      ? '<strong style="color:#6ee7b7;font-size:12px">' + calc.lots.toLocaleString('id-ID') + ' Lot</strong> (' + fmtRpCompact(calc.positionValue) + ')'
      : '<span style="color:#f87171;font-weight:600">0 Lot</span> <span style="color:#94a3b8;font-size:9px">(Modal/risk butuh min ' + fmtRpCompact(calc.minCapitalFor1LotRisk) + ')</span>';

    var html = '<div class="ac-pos-calc-box" onclick="event.stopPropagation()" style="margin-top:10px;padding:8px 10px;background:rgba(15,23,42,0.65);border:1px solid rgba(59,130,246,0.22);border-radius:9px;font-size:10px;line-height:1.4">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px">';
    html += '<div style="display:flex;align-items:center;gap:5px">';
    html += '<span style="font-size:11px">🧮</span><span style="font-weight:700;color:#93c5fd">Saran Posisi:</span> ' + lotText;
    html += '</div>';
    html += '<button type="button" onclick="PositionSizing.openModal(event)" style="background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);color:#93c5fd;font-size:9px;font-weight:600;padding:2px 6px;border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;gap:3px" title="Atur modal trading & toleransi risiko">';
    html += (isDefault ? '⚙️ Atur Modal' : '⚙️ ' + capitalFmt + ' (' + calc.riskPct + '%)');
    html += '</button>';
    html += '</div>';

    if (calc.lots > 0) {
      html += '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:9.5px;color:#9ca3af">';
      html += '<span>Risiko SL: <strong style="color:#fca5a5">-' + fmtRpCompact(calc.actualRiskIdr) + '</strong> (' + calc.actualRiskPct.toFixed(1) + '%)</span>';
      if (calc.profitTp1Idr > 0) {
        html += '<span>TP1: <strong style="color:#6ee7b7">+' + fmtRpCompact(calc.profitTp1Idr) + '</strong> (+' + calc.profitTp1Pct.toFixed(1) + '%)</span>';
      }
      if (calc.profitTp2Idr > 0) {
        html += '<span>TP2: <strong style="color:#6ee7b7">+' + fmtRpCompact(calc.profitTp2Idr) + '</strong> (+' + calc.profitTp2Pct.toFixed(1) + '%)</span>';
      }
      if (calc.cappedByCapital) {
        html += '<span style="color:#fbbf24;font-size:9px">⚠️ Lot dibatasi plafon modal</span>';
      }
      html += '</div>';
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

    var calc = calculate({ entry: entry, sl: sl, tp1: tp1, tp2: tp2 });
    var html = '<div class="ac-pos-detail-section" style="margin-bottom:16px;padding:14px;background:rgba(15,23,42,0.6);border:1px solid rgba(59,130,246,0.25);border-radius:12px">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">';
    html += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px">🧮</span><div><div style="font-size:11px;font-weight:700;color:#93c5fd;text-transform:uppercase;letter-spacing:0.8px">Kalkulator Ukuran Posisi</div><div style="font-size:10px;color:#94a3b8">Berdasarkan toleransi risiko akun Anda</div></div></div>';
    html += '<button type="button" onclick="PositionSizing.openModal(event)" class="ac-btn" data-size="sm" style="font-size:10px;padding:4px 9px;border-radius:7px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.4);color:#93c5fd;cursor:pointer">⚙️ Ubah Modal / Risiko</button>';
    html += '</div>';

    if (!calc.isValid) {
      html += '<div style="font-size:11px;color:#fca5a5;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);padding:10px;border-radius:8px">' + (calc.reason || 'Level sinyal tidak lengkap.') + '</div>';
      html += '</div>';
      return html;
    }

    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:8px;margin-bottom:12px">';
    html += '<div style="background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:9px;padding:10px"><div style="font-size:9px;color:#4ead8a;margin-bottom:2px;font-weight:600">Saran Pembelian</div><div style="font-size:17px;font-weight:800;color:#6ee7b7">' + calc.lots.toLocaleString('id-ID') + ' Lot</div><div style="font-size:10px;color:#9ca3af">' + fmtRpCompact(calc.positionValue) + ' (' + calc.allocationPct.toFixed(1) + '% modal)</div></div>';
    html += '<div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:9px;padding:10px"><div style="font-size:9px;color:#d87171;margin-bottom:2px;font-weight:600">Maksimal Risiko (SL)</div><div style="font-size:17px;font-weight:800;color:#fca5a5">-' + fmtRpCompact(calc.actualRiskIdr) + '</div><div style="font-size:10px;color:#9ca3af">-' + calc.actualRiskPct.toFixed(1) + '% dari modal</div></div>';
    html += '<div style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.2);border-radius:9px;padding:10px"><div style="font-size:9px;color:#6b9fd8;margin-bottom:2px;font-weight:600">Potensi TP1 (' + (calc.tp1 ? calc.tp1.toLocaleString('id-ID') : '-') + ')</div><div style="font-size:17px;font-weight:800;color:#93c5fd">+' + fmtRpCompact(calc.profitTp1Idr) + '</div><div style="font-size:10px;color:#9ca3af">+' + calc.profitTp1Pct.toFixed(1) + '% dari modal</div></div>';
    html += '<div style="background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.2);border-radius:9px;padding:10px"><div style="font-size:9px;color:#a78bfa;margin-bottom:2px;font-weight:600">Potensi TP2 (' + (calc.tp2 ? calc.tp2.toLocaleString('id-ID') : '-') + ')</div><div style="font-size:17px;font-weight:800;color:#c4b5fd">+' + fmtRpCompact(calc.profitTp2Idr) + '</div><div style="font-size:10px;color:#9ca3af">+' + calc.profitTp2Pct.toFixed(1) + '% dari modal</div></div>';
    html += '</div>';

    html += '<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;font-size:10px;color:#9ca3af;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06)">';
    html += '<span>Modal Aktif: <strong style="color:#e2e8f0">' + fmtRp(calc.capital) + '</strong> · Toleransi Risiko: <strong style="color:#e2e8f0">' + calc.riskPct + '%</strong></span>';
    html += '<span>Sisa Kas Rencana: <strong style="color:#e2e8f0">' + fmtRp(calc.cashRemaining) + '</strong></span>';
    html += '</div>';
    if (calc.cappedByCapital) {
      html += '<div style="margin-top:6px;font-size:10px;color:#fbbf24">⚠️ Jumlah lot disesuaikan ke bawah karena dibatasi oleh total modal trading yang tersedia.</div>';
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
      '      <span class="text-blue-400 text-lg">🧮</span>',
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
    var r = sanitizeNumber(riskInput.value, DEFAULT_RISK_PCT);
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
    var r = riskInput ? sanitizeNumber(riskInput.value, DEFAULT_RISK_PCT) : DEFAULT_RISK_PCT;
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

  return {
    getSettings: getSettings,
    saveSettings: saveSettings,
    calculate: calculate,
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
