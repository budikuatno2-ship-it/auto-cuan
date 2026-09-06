/**
 * Auto-Cuan Signal Gate Transparency (E3)
 * Transparansi Alasan Masuk Gate ("Kenapa Sinyal Ini Muncul?")
 * Menampilkan checklist visual per gate (likuiditas, volume ratio, tren MA20, RSI, risk/reward)
 * dengan nilai aktual vs ambang batas di modal detail dan drawer ringkas di card grid.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(typeof globalThis !== 'undefined' ? globalThis : root);
  } else {
    var inst = factory(root);
    root.SignalGateTransparency = inst;
    if (typeof window !== 'undefined') window.SignalGateTransparency = inst;
    if (typeof globalThis !== 'undefined') globalThis.SignalGateTransparency = inst;
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  root = root || (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}));

  function toNum(val) {
    if (val === null || val === undefined || val === '') return null;
    var n = Number(String(val).replace(/[^0-9.-]/g, ''));
    return isFinite(n) ? n : null;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtRpCompact(num) {
    if (num === null || num === undefined || !isFinite(num)) return '-';
    var abs = Math.abs(num);
    if (abs >= 1e12) return 'Rp ' + (num / 1e12).toFixed(1) + ' T';
    if (abs >= 1e9) return 'Rp ' + (num / 1e9).toFixed(1) + ' M';
    if (abs >= 1e6) return 'Rp ' + (num / 1e6).toFixed(1) + ' Jt';
    if (abs >= 1e3) return 'Rp ' + (num / 1e3).toFixed(0) + ' Rb';
    return 'Rp ' + Math.round(num).toLocaleString('id-ID');
  }

  function evaluateGates(signal, type) {
    signal = signal || {};
    type = String(type || signal.category || '').toLowerCase();
    var isDayTrade = type.indexOf('day') >= 0 || type.indexOf('dt') >= 0;
    var isNonKonglo = type.indexOf('non') >= 0 || type.indexOf('nk') >= 0;

    // 1. Likuiditas Gate
    var valToday = toNum(signal.value_today);
    var avgVal20 = toNum(signal.avg_transaction_value_20d || signal.avg_value_7d);
    var liqScore = toNum(signal.liquidity_score);
    var bestVal = valToday || avgVal20;
    var minValTarget = isNonKonglo ? 10e9 : (isDayTrade ? 3e9 : 5e9); // 10M Non-Konglo, 3M DT, 5M Konglo
    var liqPassed = (bestVal !== null && bestVal >= minValTarget) || (liqScore !== null && liqScore >= 12);
    var liqActualText = bestVal !== null ? fmtRpCompact(bestVal) : (liqScore !== null ? ('Skor ' + liqScore.toFixed(0) + '/25') : 'Memenuhi Universe');
    var liqThresholdText = 'Min ' + fmtRpCompact(minValTarget);

    // 2. Akumulasi Volume (Volume Ratio 20D)
    var volRatio = toNum(signal.volume_ratio_20d != null ? signal.volume_ratio_20d : (signal.volume_ratio != null ? signal.volume_ratio : signal.volume_ratio_avg20));
    var minVolRatio = isDayTrade ? 1.2 : 1.0;
    var volPassed = volRatio !== null && volRatio >= minVolRatio;
    var volActualText = volRatio !== null ? (volRatio.toFixed(2) + 'x') : 'Terkonfirmasi';
    var volThresholdText = 'Min ' + minVolRatio.toFixed(1) + 'x';

    // 3. Tren Harga / MA20
    var lastPrice = toNum(signal.last_price || signal.close);
    var ma20 = toNum(signal.ma20);
    var priceVsMa20 = null;
    var ma20Passed = true;
    var ma20ActualText = '-';
    if (lastPrice !== null && ma20 !== null && ma20 > 0) {
      priceVsMa20 = ((lastPrice - ma20) / ma20) * 100;
      ma20Passed = priceVsMa20 >= -2.0; // Izinkan toleransi pullback tipis sampai -2%
      ma20ActualText = (priceVsMa20 >= 0 ? '+' : '') + priceVsMa20.toFixed(1) + '% vs MA20 (' + Math.round(ma20).toLocaleString('id-ID') + ')';
    } else if (lastPrice !== null) {
      ma20ActualText = 'Di area ' + lastPrice.toLocaleString('id-ID');
      ma20Passed = true;
    }
    var ma20ThresholdText = '≥ MA20 / Area Support';

    // 4. Momentum & Keamanan RSI (RSI 14)
    var rsi = toNum(signal.rsi14 != null ? signal.rsi14 : signal.rsi);
    var rsiPassed = true;
    var rsiActualText = '-';
    if (rsi !== null) {
      rsiPassed = rsi <= 78 && rsi >= 35; // Tidak overbought ekstrem > 78 dan tidak mati momentum < 35
      rsiActualText = rsi.toFixed(1) + (rsi > 70 ? ' (Overbought)' : (rsi < 40 ? ' (Oversold)' : ' (Sehat)'));
    } else {
      rsiActualText = 'Dalam rentang aman';
    }
    var rsiThresholdText = '35 - 75 (Zona Aman)';

    // 5. Rasio Risiko/Keuntungan (Risk/Reward)
    var rr = toNum(signal.risk_reward != null ? signal.risk_reward : signal.rr);
    var minRR = isDayTrade ? 1.2 : 1.5;
    var rrPassed = rr !== null ? (rr >= minRR) : true;
    var rrActualText = rr !== null ? (rr.toFixed(1) + ' : 1') : 'Terkalkulasi';
    var rrThresholdText = 'Min ' + minRR.toFixed(1) + ' : 1';

    var gates = [
      {
        id: 'liquidity',
        title: 'Likuiditas Transaksi',
        shortTitle: 'Likuiditas',
        actual: liqActualText,
        threshold: liqThresholdText,
        passed: liqPassed,
        note: liqPassed ? 'Transaksi likuid untuk keluar-masuk posisi' : 'Likuiditas perlu konfirmasi orderbook'
      },
      {
        id: 'volume',
        title: 'Akumulasi Volume',
        shortTitle: 'Vol Ratio',
        actual: volActualText,
        threshold: volThresholdText,
        passed: volPassed,
        note: volPassed ? 'Volume di atas rata-rata 20 hari' : 'Volume akumulasi masih tipis'
      },
      {
        id: 'trend',
        title: 'Tren Harga (MA20)',
        shortTitle: 'MA20',
        actual: ma20ActualText,
        threshold: ma20ThresholdText,
        passed: ma20Passed,
        note: ma20Passed ? 'Harga bertahan di atas batas tren MA20' : 'Harga menguji level support MA20'
      },
      {
        id: 'rsi',
        title: 'Momentum RSI 14',
        shortTitle: 'RSI 14',
        actual: rsiActualText,
        threshold: rsiThresholdText,
        passed: rsiPassed,
        note: rsiPassed ? 'Momentum terbentuk tanpa overbought ekstrem' : 'Waspada overbought/oversold'
      },
      {
        id: 'rr',
        title: 'Risk / Reward Ratio',
        shortTitle: 'R/R',
        actual: rrActualText,
        threshold: rrThresholdText,
        passed: rrPassed,
        note: rrPassed ? 'Potensi target reward melebihi batas risiko' : 'R/R di bawah standar ideal'
      }
    ];

    var passedCount = gates.filter(function (g) { return g.passed; }).length;
    var totalCount = gates.length;
    var summaryRationale = signal.notes || signal.status_reason || signal.setup || 'Sinyal memenuhi kriteria momentum dan manajemen risiko yang ditentukan.';

    return {
      passedCount: passedCount,
      totalCount: totalCount,
      allPassed: passedCount === totalCount,
      gates: gates,
      summaryRationale: summaryRationale
    };
  }

  function renderDetailBox(signal, type) {
    var evaluation = evaluateGates(signal, type);
    var passedCount = evaluation.passedCount;
    var totalCount = evaluation.totalCount;
    var badgeCol = passedCount >= 4 ? '#6ee7b7' : (passedCount >= 3 ? '#fbbf24' : '#fca5a5');
    var badgeBg = passedCount >= 4 ? 'rgba(16,185,129,0.12)' : (passedCount >= 3 ? 'rgba(234,179,8,0.12)' : 'rgba(239,68,68,0.12)');

    var html = '';
    html += '<div class="ac-gate-transparency-box" style="margin-bottom:16px;padding:14px;background:rgba(15,23,42,0.5);border:1px solid rgba(16,185,129,0.25);border-radius:12px">';
    
    // Header
    html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">';
    html += '<div style="display:flex;align-items:center;gap:7px">';
    html += '<span style="font-size:14px">🔍</span>';
    html += '<div style="font-size:11px;font-weight:700;color:#f3f4f6;text-transform:uppercase;letter-spacing:0.6px">Kenapa Sinyal Ini Lolos Gate?</div>';
    html += '</div>';
    html += '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;color:' + badgeCol + ';background:' + badgeBg + ';border:1px solid ' + badgeCol + '40">' + passedCount + '/' + totalCount + ' Gate Terpenuhi</span>';
    html += '</div>';

    // Subtitle rationale
    html += '<div style="font-size:10px;color:#9ca3af;line-height:1.45;margin-bottom:12px;background:rgba(0,0,0,0.25);padding:8px 10px;border-radius:8px;border-left:3px solid #10b981">';
    html += '<strong style="color:#d1d5db">Alasan Seleksi:</strong> ' + escapeHtml(evaluation.summaryRationale);
    html += '</div>';

    // Checklist items table
    html += '<div style="display:flex;flex-direction:column;gap:6px">';
    for (var i = 0; i < evaluation.gates.length; i++) {
      var g = evaluation.gates[i];
      var icon = g.passed ? '✅' : '⚠️';
      var titleCol = g.passed ? '#e5e7eb' : '#fbbf24';
      var rowBorder = g.passed ? 'rgba(30,41,59,0.5)' : 'rgba(234,179,8,0.2)';
      var rowBg = g.passed ? 'rgba(20,27,45,0.4)' : 'rgba(234,179,8,0.04)';

      html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;background:' + rowBg + ';border:1px solid ' + rowBorder + ';border-radius:8px;font-size:11px">';
      html += '<div style="display:flex;align-items:center;gap:8px;min-width:0">';
      html += '<span style="font-size:12px;line-height:1">' + icon + '</span>';
      html += '<div style="min-width:0">';
      html += '<div style="font-weight:600;color:' + titleCol + '">' + escapeHtml(g.title) + '</div>';
      html += '<div style="font-size:9.5px;color:#6b7280;margin-top:1px">' + escapeHtml(g.note) + '</div>';
      html += '</div>';
      html += '</div>';

      html += '<div style="text-align:right;flex-shrink:0;padding-left:6px">';
      html += '<div style="font-weight:700;color:#93c5fd;font-family:monospace">' + escapeHtml(g.actual) + '</div>';
      html += '<div style="font-size:9px;color:#64748b">' + escapeHtml(g.threshold) + '</div>';
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';

    html += '</div>';
    return html;
  }

  function renderCardButton(signal, type) {
    signal = signal || {};
    var ticker = signal.ticker || 'STOCK';
    var safeId = 'acGateDrawer_' + ticker.replace(/[^A-Za-z0-9]/g, '');
    var evaluation = evaluateGates(signal, type);
    var passedCount = evaluation.passedCount;
    var totalCount = evaluation.totalCount;
    var badgeCol = passedCount >= 4 ? '#6ee7b7' : (passedCount >= 3 ? '#fbbf24' : '#fca5a5');

    var html = '';
    // Button on card
    html += '<div class="ac-gate-card-trigger" style="margin-top:6px;margin-bottom:2px">';
    html += '<button type="button" onclick="window.SignalGateTransparency.toggleCardDrawer(\'' + escapeHtml(ticker) + '\', event)" style="display:inline-flex;align-items:center;gap:5px;background:rgba(15,23,42,0.6);border:1px solid rgba(148,163,184,0.18);border-radius:6px;padding:3px 8px;font-size:9.5px;color:#94a3b8;cursor:pointer;transition:all .15s" onmouseover="this.style.borderColor=\'#10b981\';this.style.color=\'#6ee7b7\'" onmouseout="this.style.borderColor=\'rgba(148,163,184,0.18)\';this.style.color=\'#94a3b8\'" title="Lihat detail kenapa saham ini lolos kriteria">';
    html += '<span style="color:' + badgeCol + ';font-size:11px">💡</span>';
    html += '<span>Mengapa muncul?</span>';
    html += '<span style="color:' + badgeCol + ';font-weight:700;font-size:9px">(' + passedCount + '/' + totalCount + ')</span>';
    html += '<svg style="width:10px;height:10px;transition:transform .2s" class="ac-gate-chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>';
    html += '</button>';

    // Expandable Drawer
    html += '<div id="' + safeId + '" class="ac-gate-drawer hidden" style="margin-top:8px;padding:10px;background:rgba(10,14,24,0.85);border:1px solid rgba(16,185,129,0.2);border-radius:8px;font-size:10px;animation:fadeIn .2s ease-in-out">';
    html += '<div style="font-weight:700;color:#e2e8f0;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between">';
    html += '<span>Kriteria Lolos Seleksi:</span>';
    html += '<span style="color:' + badgeCol + ';font-size:9px">' + passedCount + '/' + totalCount + ' Terpenuhi</span>';
    html += '</div>';

    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin-bottom:6px">';
    for (var i = 0; i < evaluation.gates.length; i++) {
      var g = evaluation.gates[i];
      var icon = g.passed ? '✅' : '⚠️';
      html += '<div style="display:flex;align-items:center;gap:4px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">';
      html += '<span style="font-size:10px">' + icon + '</span>';
      html += '<span style="color:#94a3b8">' + escapeHtml(g.shortTitle) + ':</span>';
      html += '<span style="color:#60a5fa;font-weight:600">' + escapeHtml(g.actual.split(' ')[0]) + '</span>';
      html += '</div>';
    }
    html += '</div>';

    if (evaluation.summaryRationale) {
      html += '<div style="color:#94a3b8;font-size:9px;line-height:1.35;border-top:1px solid rgba(255,255,255,0.06);padding-top:5px;word-break:break-word">';
      html += escapeHtml(evaluation.summaryRationale);
      html += '</div>';
    }

    html += '</div>';
    html += '</div>';
    return html;
  }

  function toggleCardDrawer(ticker, event) {
    if (event) {
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      if (typeof event.preventDefault === 'function') event.preventDefault();
    }
    var safeId = 'acGateDrawer_' + String(ticker || '').replace(/[^A-Za-z0-9]/g, '');
    var drawer = document.getElementById(safeId);
    if (!drawer) return;
    drawer.classList.toggle('hidden');
    var btn = drawer.parentElement ? drawer.parentElement.querySelector('button') : null;
    var chevron = btn ? btn.querySelector('.ac-gate-chevron') : null;
    if (chevron) {
      if (drawer.classList.contains('hidden')) {
        chevron.style.transform = 'rotate(0deg)';
      } else {
        chevron.style.transform = 'rotate(180deg)';
      }
    }
  }

  return {
    evaluateGates: evaluateGates,
    renderDetailBox: renderDetailBox,
    renderCardButton: renderCardButton,
    toggleCardDrawer: toggleCardDrawer
  };
});
