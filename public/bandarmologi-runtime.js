(function (root) {
  'use strict';

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatIDR(num) {
    if (num == null || isNaN(num)) return '—';
    var abs = Math.abs(num);
    if (abs >= 1e12) return (num / 1e12).toFixed(2) + ' T';
    if (abs >= 1e9) return (num / 1e9).toFixed(2) + ' M';
    if (abs >= 1e6) return (num / 1e6).toFixed(1) + ' jt';
    return new Intl.NumberFormat('id-ID').format(num);
  }

  function formatNumber(num) {
    if (num == null || isNaN(num)) return '—';
    return new Intl.NumberFormat('id-ID').format(num);
  }

  var currentBandarTicker = 'BBCA';
  var currentBandarDate = '';

  async function loadBandarmologiTab(ticker, date) {
    var clean = String(ticker || currentBandarTicker || 'BBCA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) clean = 'BBCA';
    currentBandarTicker = clean;
    if (date != null) currentBandarDate = date;

    var container = byId('bandarmologiContent');
    if (!container) return;

    var badgeTicker = byId('bandarActiveTickerTag');
    if (badgeTicker) badgeTicker.textContent = clean;

    container.innerHTML = '<div class="flex flex-col items-center justify-center py-12"><div class="spinner"></div><p class="text-xs text-gray-400 mt-3">Mengambil data Bandarmologi &amp; Insider ' + escapeHtml(clean) + '...</p></div>';

    try {
      var url = '/api/sector-hot?action=bandarmologi&ticker=' + encodeURIComponent(clean);
      if (currentBandarDate) {
        url += '&date=' + encodeURIComponent(currentBandarDate);
      }
      var res = await fetch(url);
      var data = await res.json();

      if (!data || !data.success) {
        container.innerHTML = '<div class="p-6 text-center text-rose-400 text-xs">Gagal memuat data bandarmologi: ' + escapeHtml((data && data.error) || 'Terjadi kesalahan.') + '</div>';
        return;
      }

      renderBandarmologiUI(container, data);
    } catch (err) {
      container.innerHTML = '<div class="p-6 text-center text-rose-400 text-xs">Error memuat data bandarmologi: ' + escapeHtml(err.message || String(err)) + '</div>';
    }
  }

  function renderBandarmologiUI(container, data) {
    var ticker = data.ticker || currentBandarTicker;
    var bSum = data.broker_summary || {};
    var bAcc = data.broker_accumulation || {};
    var insiders = Array.isArray(data.insiders) ? data.insiders : [];

    var isDemoBadge = data.is_demo
      ? '<span class="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 font-mono">DEMO PREVIEW</span>'
      : '<span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono">LIVE / BACKFILL</span>';

    var netStatusTone = 'text-emerald-400';
    var netStatusBg = 'bg-emerald-500/10 border-emerald-500/30';
    var netLabel = bSum.net_label || bSum.net_status || 'AKUMULASI';
    if (String(netLabel).toUpperCase().includes('DIST')) {
      netStatusTone = 'text-rose-400';
      netStatusBg = 'bg-rose-500/10 border-rose-500/30';
    }

    var html = '';

    // Header info bar
    html += '<div class="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-dark-700/60 border border-dark-600/40 rounded-2xl mb-4">';
    html += '  <div class="flex items-center gap-2">';
    html += '    <span class="text-sm font-bold text-white tracking-wide">' + escapeHtml(ticker) + '</span>';
    html += '    ' + isDemoBadge;
    html += '    <span class="text-xs px-2.5 py-0.5 rounded-lg border font-semibold ' + netStatusTone + ' ' + netStatusBg + '">' + escapeHtml(netLabel) + '</span>';
    html += '  </div>';
    html += '  <div class="flex items-center gap-2 text-xs text-gray-400">';
    html += '    <span>Tanggal:</span>';
    html += '    <input id="bandarDatePicker" type="date" value="' + escapeHtml(bSum.date || '2026-09-04') + '" onchange="BandarmologiRuntime.loadBandarmologiTab(null, this.value)" class="px-2.5 py-1 rounded-lg bg-dark-800 border border-dark-600 text-gray-200 text-xs focus:outline-none focus:border-emerald-500">';
    html += '    <button type="button" onclick="BandarmologiRuntime.loadBandarmologiTab(null, null)" class="px-2.5 py-1 rounded-lg bg-dark-600/80 hover:bg-dark-500 text-gray-300 text-xs transition">Reset</button>';
    html += '  </div>';
    html += '</div>';

    var series = bAcc.series || [];
    var availableDates = Array.isArray(data.available_dates) && data.available_dates.length > 0
      ? data.available_dates
      : series.map(function (s) { return s.date; }).filter(Boolean).reverse();

    // Quick date pills in header if available
    var quickDates = availableDates.slice(0, 5);
    if (quickDates.length > 0) {
      html += '<div class="flex flex-wrap items-center gap-1.5 mb-3">';
      html += '  <span class="text-[11px] text-gray-400 mr-1">Pilih Cepat Tanggal:</span>';
      for (var qd = 0; qd < quickDates.length; qd++) {
        var dt = quickDates[qd];
        var isCurrent = dt === (bSum.date || currentBandarDate);
        var pillStyle = isCurrent
          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold'
          : 'bg-dark-700 text-gray-300 border-dark-600/60 hover:bg-dark-600 hover:text-white';
        html += '  <button type="button" onclick="BandarmologiRuntime.loadBandarmologiTab(null, \'' + escapeHtml(dt) + '\')" class="px-2 py-0.5 text-[11px] rounded-md border font-mono transition ' + pillStyle + '">' + escapeHtml(dt) + '</button>';
      }
      html += '</div>';
    }

    // 1. BROKER SUMMARY (BANDARMOLOGI) SECTION - DETAILED CARD FOR SELECTED DATE
    html += '<div class="mb-5">';
    html += '  <div class="flex items-center justify-between mb-2.5">';
    html += '    <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">📊</span> Broker Summary Detail — Tanggal: <span class="text-emerald-400 font-mono">' + escapeHtml(bSum.date || 'Terbaru') + '</span></h3>';
    html += '    <span class="text-[11px] text-gray-400">Breakdown Top 5 Sekuritas Harian</span>';
    html += '  </div>';

    html += '  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">';

    // Top Buyers
    html += '    <div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3">';
    html += '      <div class="text-[11px] font-bold text-emerald-400 mb-2 flex items-center justify-between pb-1.5 border-b border-dark-600/40">';
    html += '        <span>🟢 TOP BUYERS (' + escapeHtml(bSum.date || '') + ')</span><span>NET VALUE</span>';
    html += '      </div>';
    html += '      <div class="space-y-1.5 text-xs">';
    var buyers = bSum.top_buyers || [];
    if (buyers.length === 0) {
      html += '      <div class="text-gray-500 text-center py-4 text-xs">Tidak ada data buyer</div>';
    } else {
      for (var b = 0; b < buyers.length; b++) {
        var item = buyers[b];
        html += '      <div class="flex items-center justify-between py-1 px-1.5 rounded hover:bg-dark-600/30 transition">';
        html += '        <div class="flex items-center gap-2">';
        html += '          <span class="w-5 text-gray-500 font-mono text-[10px]">' + (b + 1) + '</span>';
        html += '          <span class="font-bold font-mono text-emerald-300">' + escapeHtml(item.broker) + '</span>';
        if (item.broker_name) {
          html += '          <span class="text-gray-400 text-[10px] truncate max-w-[120px]" title="' + escapeHtml(item.broker_name) + '">' + escapeHtml(item.broker_name) + '</span>';
        }
        if (item.avg_price) {
          html += '          <span class="text-gray-400 text-[11px]">@ ' + formatNumber(item.avg_price) + '</span>';
        }
        html += '        </div>';
        html += '        <span class="font-mono font-semibold text-emerald-400">+' + formatIDR(item.net_val || item.buy_val) + '</span>';
        html += '      </div>';
      }
    }
    html += '      </div>';
    html += '    </div>';

    // Top Sellers
    html += '    <div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3">';
    html += '      <div class="text-[11px] font-bold text-rose-400 mb-2 flex items-center justify-between pb-1.5 border-b border-dark-600/40">';
    html += '        <span>🔴 TOP SELLERS (' + escapeHtml(bSum.date || '') + ')</span><span>NET VALUE</span>';
    html += '      </div>';
    html += '      <div class="space-y-1.5 text-xs">';
    var sellers = bSum.top_sellers || [];
    if (sellers.length === 0) {
      html += '      <div class="text-gray-500 text-center py-4 text-xs">Tidak ada data seller</div>';
    } else {
      for (var s = 0; s < sellers.length; s++) {
        var sItem = sellers[s];
        html += '      <div class="flex items-center justify-between py-1 px-1.5 rounded hover:bg-dark-600/30 transition">';
        html += '        <div class="flex items-center gap-2">';
        html += '          <span class="w-5 text-gray-500 font-mono text-[10px]">' + (s + 1) + '</span>';
        html += '          <span class="font-bold font-mono text-rose-300">' + escapeHtml(sItem.broker) + '</span>';
        if (sItem.broker_name) {
          html += '          <span class="text-gray-400 text-[10px] truncate max-w-[120px]" title="' + escapeHtml(sItem.broker_name) + '">' + escapeHtml(sItem.broker_name) + '</span>';
        }
        if (sItem.avg_price) {
          html += '          <span class="text-gray-400 text-[11px]">@ ' + formatNumber(sItem.avg_price) + '</span>';
        }
        html += '        </div>';
        html += '        <span class="font-mono font-semibold text-rose-400">-' + formatIDR(Math.abs(sItem.net_val || sItem.sell_val)) + '</span>';
        html += '      </div>';
      }
    }
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';
    html += '</div>';

    // 2. DAILY BROKER SUMMARY BREAKDOWN TABLE (PER HARI)
    html += '<div class="mb-5 bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5">';
    html += '  <div class="flex items-center justify-between mb-3">';
    html += '    <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">📅</span> Riwayat Harian Broker Summary (Breakdown Per Hari)</h3>';
    html += '    <span class="text-[11px] text-gray-400">Setiap tanggal memiliki data tersendiri</span>';
    html += '  </div>';

    if (series.length === 0) {
      html += '  <div class="text-gray-500 text-center py-4 text-xs">Belum ada riwayat harian untuk emiten ini.</div>';
    } else {
      html += '  <div class="overflow-x-auto max-h-72 overflow-y-auto">';
      html += '    <table class="w-full text-left text-xs">';
      html += '      <thead>';
      html += '        <tr class="text-[11px] text-gray-400 border-b border-dark-600/40 sticky top-0 bg-dark-800/90 backdrop-blur z-10">';
      html += '          <th class="py-2 px-2.5">Tanggal</th>';
      html += '          <th class="py-2 px-2 text-center">Status Bandar</th>';
      html += '          <th class="py-2 px-2 text-right">Net Flow (IDR)</th>';
      html += '          <th class="py-2 px-2 text-center">Top Buyer</th>';
      html += '          <th class="py-2 px-2 text-center">Top Seller</th>';
      html += '          <th class="py-2 px-2 text-center">Aksi</th>';
      html += '        </tr>';
      html += '      </thead>';
      html += '      <tbody class="divide-y divide-dark-600/20">';

      var revSeries = series.slice().reverse();
      for (var di = 0; di < revSeries.length; di++) {
        var dayRow = revSeries[di];
        var isSelected = dayRow.date === (bSum.date || currentBandarDate);
        var isPositive = (dayRow.net_val || 0) >= 0;
        var statusBadge = isPositive
          ? '<span class="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-semibold text-[10px]">AKUMULASI</span>'
          : '<span class="px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 font-semibold text-[10px]">DISTRIBUSI</span>';

        var rowBg = isSelected
          ? 'bg-emerald-500/10 border-l-2 border-emerald-500 font-medium'
          : 'hover:bg-dark-600/20 transition';

        html += '        <tr class="' + rowBg + '">';
        html += '          <td class="py-2 px-2.5 font-mono text-[11px] text-gray-200">';
        html += '            ' + escapeHtml(dayRow.date);
        if (isSelected) {
          html += '          <span class="ml-1.5 text-[9px] px-1.5 py-0.2 rounded bg-emerald-500 text-dark-900 font-bold">DILIHAT</span>';
        }
        html += '          </td>';
        html += '          <td class="py-2 px-2 text-center">' + statusBadge + '</td>';
        html += '          <td class="py-2 px-2 font-mono text-right font-semibold ' + (isPositive ? 'text-emerald-400' : 'text-rose-400') + '">' + (isPositive ? '+' : '-') + formatIDR(Math.abs(dayRow.net_val || 0)) + '</td>';
        html += '          <td class="py-2 px-2 text-center font-mono font-bold text-emerald-300">' + escapeHtml(dayRow.top_buyer || '—') + '</td>';
        html += '          <td class="py-2 px-2 text-center font-mono font-bold text-rose-300">' + escapeHtml(dayRow.top_seller || '—') + '</td>';
        html += '          <td class="py-2 px-2 text-center">';
        html += '            <button type="button" onclick="BandarmologiRuntime.loadBandarmologiTab(null, \'' + escapeHtml(dayRow.date) + '\')" class="px-2 py-1 text-[10px] rounded bg-dark-600 hover:bg-emerald-600 hover:text-white text-gray-300 transition">Lihat Top 5</button>';
        html += '          </td>';
        html += '        </tr>';
      }
      html += '      </tbody>';
      html += '    </table>';
      html += '  </div>';
    }
    html += '</div>';

    // 3. HISTORICAL BROKER ACCUMULATION (BAR CHART)
    html += '<div class="mb-5 bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5">';
    html += '  <div class="flex items-center justify-between mb-3">';
    html += '    <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">📈</span> Grafik Tren Akumulasi vs Distribusi Historis</h3>';
    if (bAcc.accumulation_score != null) {
      html += '    <span class="text-[11px] font-mono px-2 py-0.5 rounded bg-dark-600 text-emerald-400 border border-emerald-500/20">Acc Score: ' + bAcc.accumulation_score + '/100</span>';
    }
    html += '  </div>';

    if (series.length === 0) {
      html += '  <div class="text-gray-500 text-center py-4 text-xs">Belum ada data series akumulasi</div>';
    } else {
      html += '  <div class="space-y-2">';
      var maxAbs = 1;
      for (var k = 0; k < series.length; k++) {
        var val = Math.abs(series[k].net_val || 0);
        if (val > maxAbs) maxAbs = val;
      }
      for (var si = 0; si < series.length; si++) {
        var day = series[si];
        var isPositive = (day.net_val || 0) >= 0;
        var barWidth = Math.max(8, Math.min(100, Math.round((Math.abs(day.net_val || 0) / maxAbs) * 100)));
        var barColor = isPositive ? 'bg-emerald-500' : 'bg-rose-500';

        html += '    <div class="flex items-center gap-3 text-xs">';
        html += '      <span class="w-20 text-[11px] font-mono text-gray-400 shrink-0">' + escapeHtml(day.date) + '</span>';
        html += '      <div class="flex-1 bg-dark-800/80 rounded-full h-3 overflow-hidden flex items-center px-0.5">';
        html += '        <div class="h-2 rounded-full ' + barColor + ' transition-all" style="width:' + barWidth + '%"></div>';
        html += '      </div>';
        html += '      <span class="w-24 text-right font-mono font-semibold text-[11px] ' + (isPositive ? 'text-emerald-400' : 'text-rose-400') + ' shrink-0">' + (isPositive ? '+' : '-') + formatIDR(Math.abs(day.net_val || 0)) + '</span>';
        html += '    </div>';
      }
      html += '  </div>';
    }
    html += '</div>';

    // 3. INSIDER TRANSACTIONS SECTION
    html += '<div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5">';
    html += '  <div class="flex items-center justify-between mb-3">';
    html += '    <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">👥</span> Transaksi Insider (Orang Dalam)</h3>';
    html += '    <span class="text-[11px] text-gray-400">' + insiders.length + ' transaksi tercatat</span>';
    html += '  </div>';

    if (insiders.length === 0) {
      html += '  <div class="text-gray-500 text-center py-6 text-xs">Tidak ada riwayat transaksi insider untuk ticker ini.</div>';
    } else {
      html += '  <div class="overflow-x-auto">';
      html += '    <table class="w-full text-left text-xs">';
      html += '      <thead>';
      html += '        <tr class="text-[11px] text-gray-400 border-b border-dark-600/40">';
      html += '          <th class="py-2 px-2">Tanggal</th>';
      html += '          <th class="py-2 px-2">Nama Insider</th>';
      html += '          <th class="py-2 px-2">Jabatan</th>';
      html += '          <th class="py-2 px-2 text-center">Aksi</th>';
      html += '          <th class="py-2 px-2 text-right">Lembar Saham</th>';
      html += '          <th class="py-2 px-2 text-right">Perubahan %</th>';
      html += '        </tr>';
      html += '      </thead>';
      html += '      <tbody class="divide-y divide-dark-600/20">';
      for (var ins = 0; ins < insiders.length; ins++) {
        var row = insiders[ins];
        var isBuy = String(row.action_type || row.type || 'BUY').toUpperCase().includes('BUY');
        var actionTag = isBuy
          ? '<span class="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-bold text-[10px]">BELI</span>'
          : '<span class="px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 font-bold text-[10px]">JUAL</span>';

        html += '        <tr class="hover:bg-dark-600/20 transition">';
        html += '          <td class="py-2.5 px-2 font-mono text-[11px] text-gray-300">' + escapeHtml(row.date || '—') + '</td>';
        html += '          <td class="py-2.5 px-2 font-medium text-gray-100">' + escapeHtml(row.name || '—') + '</td>';
        html += '          <td class="py-2.5 px-2 text-gray-400 text-[11px]">' + escapeHtml(row.position || '—') + '</td>';
        html += '          <td class="py-2.5 px-2 text-center">' + actionTag + '</td>';
        html += '          <td class="py-2.5 px-2 font-mono text-right text-gray-200">' + formatNumber(row.shares || row.volume || 0) + '</td>';
        html += '          <td class="py-2.5 px-2 font-mono text-right ' + (isBuy ? 'text-emerald-400' : 'text-rose-400') + '">' + escapeHtml(row.pct_change || '—') + '</td>';
        html += '        </tr>';
      }
      html += '      </tbody>';
      html += '    </table>';
      html += '  </div>';
    }
    html += '</div>';

    container.innerHTML = html;
  }

  root.BandarmologiRuntime = {
    loadBandarmologiTab: loadBandarmologiTab
  };

  root.loadBandarmologiTab = loadBandarmologiTab;

})(typeof window !== 'undefined' ? window : this);
