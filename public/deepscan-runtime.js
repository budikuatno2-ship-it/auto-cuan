/**
 * Auto-Cuan Macro DeepScan Runtime
 * Swing jangka panjang (1–3 bulan) berbasis akumulasi bandar 3–6 bulan.
 * Visualisasi Buy on Weakness, Stop Loss (hingga batas Rp1), dan target fleksibel (TP1/TP2).
 */
(function(window) {
  'use strict';

  var deepScanData = null;
  var deepScanLoading = false;

  function formatRp(val) {
    if (val == null || !Number.isFinite(Number(val))) return '—';
    return 'Rp ' + Number(val).toLocaleString('id-ID');
  }

  function formatNumber(val) {
    if (val == null || !Number.isFinite(Number(val))) return '—';
    return Number(val).toLocaleString('id-ID');
  }

  function getScoreBadgeClass(score) {
    if (score >= 80) return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    if (score >= 65) return 'bg-blue-500/20 text-blue-300 border-blue-500/40';
    if (score >= 50) return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    return 'bg-dark-600/60 text-gray-400 border-dark-500/30';
  }

  function renderDeepScanCards(picks) {
    var container = document.getElementById('deepscanCardsGrid');
    if (!container) return;

    if (!picks || picks.length === 0) {
      container.innerHTML = '<div class="col-span-full py-12 text-center text-gray-500 text-xs">Belum ada kandidat DeepScan. Klik "Pindai Ulang" untuk memuat analisa.</div>';
      return;
    }

    var html = '';
    picks.forEach(function(item, idx) {
      var scoreBadge = getScoreBadgeClass(item.score);
      var rrTp1 = item.rr_to_tp1 != null ? '1 : ' + item.rr_to_tp1 : '—';
      var rrTp2 = item.rr_to_tp2 != null ? '1 : ' + item.rr_to_tp2 : '—';
      var cr3Str = item.cr3 != null ? item.cr3 + '%' : 'Akumulasi Stabil';
      var rsiNote = (item.rsi_threshold && item.rsi_threshold.note) || 'RSI ' + (item.rsi14 || '—');

      html += '<div class="bg-dark-800/80 border border-dark-600/40 hover:border-emerald-500/40 rounded-2xl p-4 sm:p-5 transition shadow-lg relative flex flex-col justify-between">';
      html += '  <div>';
      html += '    <div class="flex items-start justify-between gap-2 mb-3">';
      html += '      <div>';
      html += '        <div class="flex items-center gap-2">';
      html += '          <span class="text-xs font-mono font-bold text-gray-400">#' + (idx + 1) + '</span>';
      html += '          <h3 class="text-xl font-black text-white tracking-wide">' + item.ticker + '</h3>';
      html += '          <span class="px-2 py-0.5 rounded text-[11px] font-bold border ' + scoreBadge + '">Score ' + item.score + '/100</span>';
      html += '        </div>';
      html += '        <p class="text-xs text-emerald-400 font-medium mt-1">Lantai Akumulasi 3–6 Bulan: ' + formatRp(item.accumulation_floor) + '</p>';
      html += '      </div>';
      html += '      <button onclick="if(window.UnifiedCockpit){window.UnifiedCockpit.syncActiveTicker(\'' + item.ticker + '\', {loadChart:true});window.location.assign(\'/analisis-saham?ticker=' + item.ticker + '\');}" class="px-2.5 py-1 text-[11px] font-semibold text-gray-300 bg-dark-700 hover:bg-emerald-500/20 hover:text-emerald-300 rounded-lg border border-dark-600 transition">Chart &rarr;</button>';
      html += '    </div>';

      // Price & Entry Area (Buy on Weakness)
      html += '    <div class="grid grid-cols-2 gap-2 bg-dark-900/70 border border-dark-700/60 rounded-xl p-3 mb-3 text-xs">';
      html += '      <div>';
      html += '        <p class="text-[10px] text-gray-500 uppercase tracking-wider">Harga Terakhir</p>';
      html += '        <p class="text-sm font-bold text-white mt-0.5">' + formatRp(item.last_price || item.close) + '</p>';
      html += '      </div>';
      html += '      <div>';
      html += '        <p class="text-[10px] text-emerald-400 uppercase tracking-wider font-semibold">Area Beli (BoW)</p>';
      html += '        <p class="text-sm font-bold text-emerald-300 mt-0.5">' + formatNumber(item.entry_low) + ' – ' + formatNumber(item.entry_high) + '</p>';
      html += '      </div>';
      html += '    </div>';

      // SL and Targets
      html += '    <div class="space-y-2 mb-3 text-xs">';
      html += '      <div class="flex items-center justify-between p-2 rounded-lg bg-rose-500/10 border border-rose-500/20">';
      html += '        <span class="text-rose-300 font-medium flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>Stop Loss (Valid s/d Rp1)</span>';
      html += '        <span class="font-bold text-rose-300 font-mono">' + formatRp(item.stop_loss) + '</span>';
      html += '      </div>';

      html += '      <div class="flex items-center justify-between p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">';
      html += '        <span class="text-emerald-300 font-medium">Target TP1 (R:R ' + rrTp1 + ')</span>';
      html += '        <span class="font-bold text-emerald-300 font-mono">' + formatRp(item.tp1) + '</span>';
      html += '      </div>';

      html += '      <div class="flex items-center justify-between p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20">';
      html += '        <span class="text-cyan-300 font-medium">Target TP2 Mayor (R:R ' + rrTp2 + ')</span>';
      html += '        <span class="font-bold text-cyan-300 font-mono">' + formatRp(item.tp2) + '</span>';
      html += '      </div>';
      html += '    </div>';

      // Context row: Bandar accumulation & RSI
      html += '    <div class="flex flex-wrap items-center justify-between text-[11px] text-gray-400 pt-2 border-t border-dark-600/30">';
      html += '      <span>Akumulasi Bandar: <strong class="text-gray-200">' + cr3Str + '</strong></span>';
      html += '      <span>RSI (14): <strong class="text-gray-200">' + (item.rsi14 || '—') + '</strong></span>';
      html += '    </div>';
      html += '  </div>';
      html += '</div>';
    });

    container.innerHTML = html;
  }

  function renderDeepScanTable(results) {
    var tbody = document.getElementById('deepscanTableBody');
    if (!tbody) return;

    if (!results || results.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="text-center py-8 text-gray-500">Tidak ada data analisa DeepScan.</td></tr>';
      return;
    }

    var html = '';
    results.forEach(function(r, idx) {
      var scoreBadge = getScoreBadgeClass(r.score);
      html += '<tr class="hover:bg-dark-700/40 transition border-b border-dark-700/50">';
      html += '  <td class="px-3 py-2.5 font-mono text-gray-400 text-center">' + (idx + 1) + '</td>';
      html += '  <td class="px-3 py-2.5 font-bold text-white cursor-pointer hover:text-emerald-400" onclick="window.location.assign(\'/analisis-saham?ticker=' + r.ticker + '\')">' + r.ticker + '</td>';
      html += '  <td class="px-3 py-2.5 text-center"><span class="px-2 py-0.5 rounded text-[10px] font-bold border ' + scoreBadge + '">' + r.score + '</span></td>';
      html += '  <td class="px-3 py-2.5 text-right font-mono text-gray-200">' + formatRp(r.last_price || r.close) + '</td>';
      html += '  <td class="px-3 py-2.5 text-right font-mono text-emerald-300 font-semibold">' + formatNumber(r.entry_low) + ' – ' + formatNumber(r.entry_high) + '</td>';
      html += '  <td class="px-3 py-2.5 text-right font-mono text-rose-400 font-semibold">' + formatRp(r.stop_loss) + '</td>';
      html += '  <td class="px-3 py-2.5 text-right font-mono text-emerald-400 font-semibold">' + formatRp(r.tp1) + '</td>';
      html += '  <td class="px-3 py-2.5 text-right font-mono text-cyan-400 font-semibold">' + formatRp(r.tp2) + '</td>';
      html += '  <td class="px-3 py-2.5 text-center font-mono text-gray-300">1 : ' + (r.rr_to_tp1 || '—') + '</td>';
      html += '  <td class="px-3 py-2.5 text-center text-gray-400">' + (r.cr3 != null ? r.cr3 + '%' : 'Lantai Akumulasi') + '</td>';
      html += '</tr>';
    });

    tbody.innerHTML = html;
  }

  window.loadDeepScan = async function(force) {
    if (deepScanLoading) return;
    deepScanLoading = true;

    var badge = document.getElementById('deepscanMetaBadge');
    if (badge) badge.textContent = 'Memuat DeepScan...';

    try {
      var res = await fetch('/api/sector-hot?action=deepscan' + (force ? '&refresh=1' : ''), {
        headers: { 'Accept': 'application/json' }
      });
      var json = await res.json();

      if (json && json.success && json.data) {
        deepScanData = json.data;
        var dateStr = deepScanData.date || new Date().toISOString().slice(0, 10);
        if (badge) badge.textContent = 'Data: ' + dateStr + ' · ' + (deepScanData.total_candidates || 0) + ' Kandidat';

        renderDeepScanCards(deepScanData.top_picks || []);
        renderDeepScanTable(deepScanData.all_results || deepScanData.top_picks || []);
      } else {
        if (badge) badge.textContent = 'DeepScan Standby';
        renderDeepScanCards([]);
        renderDeepScanTable([]);
      }
    } catch (err) {
      console.warn('[DEEPSCAN UI] Gagal memuat data:', err);
      if (badge) badge.textContent = 'Gagal memuat';
    } finally {
      deepScanLoading = false;
    }
  };

})(window);
