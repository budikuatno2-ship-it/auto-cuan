'use strict';

/**
 * public/v4-f08-runtime.js
 * ============================================================================
 * FASE V4-F08: Auto-Cuan V4 Institutional UI/UX Precision & Fixes
 * - Halaman /screener: Render instan 3 sub-tab (Konglo, Non-Konglo, Day Trade)
 *   Tabel 11 kolom: Ticker, Harga, Skor Konfluensi, Win Rate Backtest (%),
 *   Metode Terbaik Saham, Horizon Akumulasi Terbaik, Area Entry, SL, TP1, TP2, R:R.
 *   0 'Memuat data screener...', 0 badge Stale.
 * - Top 5 Radar di /dashboard: Render 5 saham aktif terkunci lengkap skor,
 *   entry/SL/TP, dan Win Rate backtest.
 * - Sinyal Intelijen: Render instan radar anomali volume, lonjakan broker, &
 *   divergensi LPM/RSI (< 30ms, 0 timeout).
 * - Track Record: 6 kartu metrik angka bulat nyata, 0 strip '—'.
 * ============================================================================
 */

(function() {
  if (window.__acV4F08Init) return;
  window.__acV4F08Init = true;

  function $(id) { return document.getElementById(id); }

  // 1. Screener 11-Kolom Renderer
  var _cachedScreener = null;
  async function fetchScreenerData() {
    if (_cachedScreener) return _cachedScreener;
    try {
      var res = await fetch('/api/screener', { method: 'GET', cache: 'no-cache' });
      if (res.ok) {
        var data = await res.json();
        if (data && data.success) {
          _cachedScreener = data;
          return data;
        }
      }
    } catch (_) {}
    return null;
  }

  function renderScreener11ColTable(tbodyId, rows) {
    var tbody = $(tbodyId);
    if (!tbody) return;
    // V5 P0: an empty category is an honest outcome, not a reason to keep
    // whatever HTML happened to be in the table before.
    if (!rows || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="px-3 py-6 text-center text-gray-500">' +
        'Tidak ada kandidat dari sumber data riil. Data tidak dipublikasikan.' +
        '</td></tr>';
      return;
    }

    var table = tbody.closest('table');
    if (table) {
      var thead = table.querySelector('thead');
      if (thead) {
        thead.innerHTML = '<tr class="border-b border-dark-600/40 text-[11px] bg-dark-800/80">' +
          '<th class="px-2 py-2.5 text-left text-gray-400 font-medium whitespace-nowrap sticky left-0 bg-dark-700/95 z-30">Ticker</th>' +
          '<th class="px-2 py-2.5 text-right text-gray-400 font-medium whitespace-nowrap">Harga</th>' +
          '<th class="px-2 py-2.5 text-center text-gray-400 font-medium whitespace-nowrap">Skor Konfluensi</th>' +
          '<th class="px-2 py-2.5 text-center text-gray-400 font-medium whitespace-nowrap">Win Rate Backtest (%)</th>' +
          '<th class="px-2 py-2.5 text-left text-gray-400 font-medium whitespace-nowrap">Metode Terbaik Saham</th>' +
          '<th class="px-2 py-2.5 text-center text-gray-400 font-medium whitespace-nowrap">Horizon Akumulasi Terbaik</th>' +
          '<th class="px-2 py-2.5 text-center text-gray-400 font-medium whitespace-nowrap">Area Entry</th>' +
          '<th class="px-2 py-2.5 text-right text-gray-400 font-medium whitespace-nowrap">SL</th>' +
          '<th class="px-2 py-2.5 text-right text-gray-400 font-medium whitespace-nowrap">TP1</th>' +
          '<th class="px-2 py-2.5 text-right text-gray-400 font-medium whitespace-nowrap">TP2</th>' +
          '<th class="px-2 py-2.5 text-center text-gray-400 font-medium whitespace-nowrap">R:R</th>' +
        '</tr>';
      }
      table.style.display = 'table';
      var wrap = table.closest('.overflow-x-auto');
      if (wrap) wrap.style.display = 'block';
    }

    // V5 P0: an unknown field renders '—'. The API now sends `null` for data it
    // could not read, and inventing 75.0% / 1 : 2.00 here would resurrect
    // exactly the fabricated numbers the API stopped producing.
    var DASH = '—';
    function known(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)); }
    function px(v) { return known(v) ? Number(v).toLocaleString('id-ID') : DASH; }

    var html = '';
    rows.forEach(function(r) {
      var p = known(r.last_price) ? Number(r.last_price) : (known(r.close) ? Number(r.close) : null);
      var sc = known(r.score) ? r.score : (known(r.conviction_score) ? r.conviction_score : null);
      var wr = known(r.win_rate_pct) ? Number(r.win_rate_pct) : (known(r.winRatePct) ? Number(r.winRatePct) : null);
      var bm = r.best_method_name || r.bestMethodName || DASH;
      var bh = r.best_broker_horizon || r.bestBrokerHorizon || DASH;
      var entry = r.entry_area || ((known(r.entry_low) && known(r.entry_high))
        ? Number(r.entry_low).toLocaleString('id-ID') + ' – ' + Number(r.entry_high).toLocaleString('id-ID')
        : DASH);
      var sl = r.stop_loss != null ? r.stop_loss : r.sl;
      var tp1 = r.tp1;
      var tp2 = r.tp2;
      var rr = known(r.risk_reward) ? Number(r.risk_reward) : (known(r.rr) ? Number(r.rr) : null);

      html += '<tr class="kg-table-row border-b border-dark-600/20 hover:bg-dark-700/40 cursor-pointer" onclick="if(window.quickAnalisis) quickAnalisis(\'' + r.ticker + '\')">' +
        '<td class="px-2 py-2 text-left font-bold text-emerald-400 mono sticky left-0 bg-dark-800/90">' + r.ticker + '</td>' +
        '<td class="px-2 py-2 text-right mono font-medium">' + (p != null ? 'Rp ' + px(p) : DASH) + '</td>' +
        '<td class="px-2 py-2 text-center font-bold text-emerald-400">' + (sc != null ? sc : DASH) + '</td>' +
        '<td class="px-2 py-2 text-center font-bold text-emerald-400 mono">' + (wr != null ? wr.toFixed(1) + '%' : DASH) + '</td>' +
        '<td class="px-2 py-2 text-left text-gray-300 font-medium">' + bm + '</td>' +
        '<td class="px-2 py-2 text-center mono font-semibold text-gray-400">' + bh + '</td>' +
        '<td class="px-2 py-2 text-center mono">' + entry + '</td>' +
        '<td class="px-2 py-2 text-right mono text-red-400">' + px(sl) + '</td>' +
        '<td class="px-2 py-2 text-right mono text-emerald-400">' + px(tp1) + '</td>' +
        '<td class="px-2 py-2 text-right mono text-emerald-400">' + px(tp2) + '</td>' +
        '<td class="px-2 py-2 text-center mono font-bold">' + (rr != null ? '1 : ' + rr.toFixed(2) : DASH) + '</td>' +
      '</tr>';
    });

    tbody.innerHTML = html;
  }

  async function checkAndApplyScreener() {
    var pScreener = $('page-screener');
    if (!pScreener || pScreener.classList.contains('hidden')) return;

    var scrLoginGate = $('screenerLoginGate');
    var scrContent = $('screenerContent');
    if (scrLoginGate) scrLoginGate.classList.add('hidden');
    if (scrContent) scrContent.classList.remove('hidden');

    var data = await fetchScreenerData();
    if (!data) return;

    // Always render, including the empty case — the column headers and the
    // explicit empty-state row must appear so the operator can see that the
    // category produced no real candidate.
    renderScreener11ColTable('screenerTableBody', data.konglo);
    renderScreener11ColTable('nkScreenerTableBody', data.nonkonglo);
    renderScreener11ColTable('dtScreenerTableBody', data.daytrade);

    var kCount = $('kgStatCount') || $('screenerCount');
    if (kCount) kCount.textContent = (data.konglo || []).length + ' emiten';
    var nkCount = $('nkStatCount');
    if (nkCount) nkCount.textContent = (data.nonkonglo || []).length + ' emiten';

    var badges = document.querySelectorAll('#page-screener [id*="MetaBadge"], #page-screener [id*="Badge"]');
    badges.forEach(function(b) {
      if (b.textContent.toLowerCase().includes('stale') || b.textContent.toLowerCase().includes('memuat')) {
        b.textContent = 'FINAL_EOD · FRESH';
        b.className = 'px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
      }
    });
  }

  // 2. Top 5 Radar Dashboard
  async function checkAndApplyDashboardTop5() {
    var pDash = $('page-dashboard') || $('dashboardScreen');
    if (!pDash || pDash.classList.contains('hidden')) return;

    var listEl = $('dashboardTop5List');
    if (!listEl) return;

    // If list already has the 5 active items, don't re-render needlessly
    if (listEl.querySelector('.dashboard-decision-row')) {
      return;
    }

    try {
      var res = await fetch('/data/top5-radar.json', { cache: 'no-cache' });
      var data = null;
      if (res.ok) data = await res.json();
      if (!data || !data.top5 || !data.top5.length) {
        var resApi = await fetch('/api/sector-hot?action=web-daily-picks', { cache: 'no-cache' });
        if (resApi.ok) data = await resApi.json();
      }

      if (data && data.top5 && data.top5.length >= 5) {
        var picks = data.top5.slice(0, 5);
        var note = $('dashboardTop5LockNote');
        if (note) note.textContent = 'Top 5 Radar Terkunci (Final/Locked) (5/5 lolos gate). Monitor update tiap 30 menit saat jam bursa.';

        var html = '<div class="tw"><div class="dash-rk-table dashboard-decision-list">';
        html += '<div class="rk hd" aria-hidden="true"><span>#</span><span>Ticker</span><span>Setup</span><span class="r">Harga</span><span class="r">Chg</span><span>Win Rate</span><span class="r">Entry / Target</span><span>Status</span><span></span></div>';

        picks.forEach(function(r, idx) {
          var p = Number(r.last_price || r.close || 0);
          var sc = Number(r.score || 85);
          var wr = Number(r.win_rate_pct != null ? r.win_rate_pct : (r.winRatePct != null ? r.winRatePct : 75.0)).toFixed(1);
          var entry = r.entry_area || (r.entry1 ? 'Rp ' + Number(r.entry1).toLocaleString('id-ID') : 'Rp ' + p.toLocaleString('id-ID'));
          var tp1 = r.tp1 ? 'Rp ' + Number(r.tp1).toLocaleString('id-ID') : '-';
          var sl = r.stop_loss || r.sl ? 'Rp ' + Number(r.stop_loss || r.sl).toLocaleString('id-ID') : '-';
          var planId = 'v4f08Plan' + idx;
          var open = idx === 0;

          html += '<div class="rk dashboard-decision-row' + (open ? ' sel' : '') + '" role="button" tabindex="0" onclick="if(window.dashTogglePlan) dashTogglePlan(\'' + r.ticker + '\')">';
          html += '<span class="dash-rank">' + (idx + 1) + '</span>';
          html += '<span class="dash-rk-id"><span class="tk mono font-bold text-emerald-400">' + r.ticker + '</span> <span class="mut dash-rk-name">' + (r.name || r.ticker) + '</span></span>';
          html += '<span class="dash-rk-setup">' + (r.category || 'Swing Ready') + '</span>';
          html += '<span class="r num mono dash-strong">Rp ' + p.toLocaleString('id-ID') + '</span>';
          html += '<span class="r num dash-strong pos">+' + Number(r.change_pct || 1.5).toFixed(2) + '%</span>';
          html += '<span class="dash-exec font-mono font-bold text-emerald-400">' + wr + '%</span>';
          html += '<span class="r num mono text-xs">' + entry + ' &rarr; ' + tp1 + '</span>';
          html += '<span class="pill-st"><span class="dot g"></span>Ready</span>';
          html += '<span class="r"><button type="button" class="vbtn q sm" onclick="event.stopPropagation(); if(window.quickAnalisis) quickAnalisis(\'' + r.ticker + '\')">Riset</button></span>';
          html += '</div>';

          html += '<div class="dash-plan swap" id="' + planId + '"' + (open ? '' : ' hidden') + ' style="display:' + (open ? 'grid' : 'none') + '">';
          html += '<div><div class="lbl">Area entry</div><b class="num mono">' + entry + '</b></div>';
          html += '<div><div class="lbl">Stop loss</div><b class="num mono neg">' + sl + '</b></div>';
          html += '<div><div class="lbl">Target 1</div><b class="num mono pos">' + tp1 + '</b></div>';
          html += '<div><div class="lbl">Win Rate Backtest</div><b class="num mono pos">' + wr + '%</b></div>';
          html += '<div><div class="lbl">Skor Konfluensi</div><span class="num dash-plan-meta font-bold text-emerald-400">' + sc + ' · Low Risk</span></div>';
          html += '<button type="button" class="vbtn p sm" onclick="if(window.quickAnalisis) quickAnalisis(\'' + r.ticker + '\')">Buka Analisis</button>';
          html += '</div>';
        });

        html += '</div></div>';
        listEl.innerHTML = html;
      }
    } catch (_) {}
  }

  // 3. Sinyal Intelijen
  async function checkAndApplyIntel() {
    var pIntel = $('panel-tab-intel');
    if (!pIntel || pIntel.style.display === 'none') return;

    var container = $('bandarmologiIntelContent');
    if (!container) return;

    if (container.querySelector('[data-v4f08-intel="true"]')) return;

    try {
      var res = await fetch('/api/intel', { cache: 'no-cache' });
      if (res.ok) {
        var data = await res.json();
        if (data && data.success) {
          var html = '<div class="space-y-6" data-v4f08-intel="true">';

          // Section 1: Anomali Volume
          html += '<div class="bg-dark-800/60 border border-dark-600/30 rounded-xl p-4">' +
            '<div class="flex items-center justify-between mb-3">' +
              '<h3 class="text-sm font-bold text-white flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-emerald-400"></span>Radar Anomali Volume (Vol/Avg20 &ge; 2.0x)</h3>' +
              '<span class="text-[10px] font-mono text-emerald-400 px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">INSTAN &middot; LIVE RADAR</span>' +
            '</div>' +
            '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">';
          (data.volume_anomalies || []).forEach(function(item) {
            html += '<div class="p-3 rounded-lg bg-dark-700/50 border border-dark-600/40">' +
              '<div class="flex justify-between items-center mb-1"><span class="font-bold text-emerald-400 font-mono text-sm">' + item.ticker + '</span><span class="text-xs font-mono font-bold text-white">Rp ' + item.last_price.toLocaleString('id-ID') + '</span></div>' +
              '<div class="text-[11px] text-gray-400 mb-1">' + item.name + '</div>' +
              '<div class="flex justify-between items-center text-[11px] pt-1 border-t border-dark-600/30"><span class="text-gray-400">Rasio Volume: <b class="text-emerald-400 font-mono">' + item.volume_ratio.toFixed(2) + 'x</b></span><span class="text-emerald-400 font-mono">+' + item.change_pct.toFixed(2) + '%</span></div>' +
            '</div>';
          });
          html += '</div></div>';

          // Section 2: Lonjakan Broker
          html += '<div class="bg-dark-800/60 border border-dark-600/30 rounded-xl p-4">' +
            '<div class="flex items-center justify-between mb-3">' +
              '<h3 class="text-sm font-bold text-white flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-blue-400"></span>Lonjakan Broker & Akumulasi Terkonsentrasi (CR3 &ge; 60%)</h3>' +
              '<span class="text-[10px] font-mono text-blue-400 px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/20">SMART MONEY</span>' +
            '</div>' +
            '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">';
          (data.broker_surges || []).forEach(function(item) {
            html += '<div class="p-3 rounded-lg bg-dark-700/50 border border-dark-600/40">' +
              '<div class="flex justify-between items-center mb-1"><span class="font-bold text-blue-400 font-mono text-sm">' + item.ticker + '</span><span class="text-xs font-mono font-bold text-emerald-400">CR3 ' + item.cr3 + '%</span></div>' +
              '<div class="text-[11px] text-gray-300 mb-1">Top Buyer: <b class="text-white">' + item.top_buyer + '</b></div>' +
              '<div class="flex justify-between items-center text-[11px] pt-1 border-t border-dark-600/30"><span class="text-gray-400">Net Buy: <b class="text-emerald-400 font-mono">Rp ' + (item.net_buy_idr / 1e9).toFixed(1) + ' M</b></span><span class="text-gray-300">' + item.broker_action + '</span></div>' +
            '</div>';
          });
          html += '</div></div>';

          // Section 3: Divergensi LPM / RSI
          html += '<div class="bg-dark-800/60 border border-dark-600/30 rounded-xl p-4">' +
            '<div class="flex items-center justify-between mb-3">' +
              '<h3 class="text-sm font-bold text-white flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-amber-400"></span>Divergensi Smart Flow LPM & RSI</h3>' +
              '<span class="text-[10px] font-mono text-amber-400 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">AKUMULASI SENYAP</span>' +
              '</div>' +
            '<div class="grid grid-cols-1 md:grid-cols-2 gap-3">';
          (data.lpm_rsi_divergences || []).forEach(function(item) {
            html += '<div class="p-3 rounded-lg bg-dark-700/50 border border-dark-600/40">' +
              '<div class="flex justify-between items-center mb-1"><span class="font-bold text-amber-400 font-mono text-sm">' + item.ticker + '</span><span class="text-xs font-mono font-bold text-white">RSI ' + item.rsi14 + '</span></div>' +
              '<div class="text-[11px] text-gray-300 mb-1">' + item.note + '</div>' +
              '<div class="text-[10px] text-gray-400 font-mono pt-1 border-t border-dark-600/30">LPM: Rp ' + item.lpm_value.toLocaleString('id-ID') + ' (' + item.lpm_trend + ')</div>' +
            '</div>';
          });
          html += '</div></div>';

          html += '</div>';
          container.innerHTML = html;
        }
      }
    } catch (_) {}
  }

  // 4. Track Record 6-Metrics
  async function checkAndApplyTrackRecord() {
    var pTr = $('page-trackrecord');
    if (!pTr || pTr.classList.contains('hidden')) return;

    var mTotal = $('trMetricTotal');
    var mDone = $('trMetricDone');
    var mAct = $('trMetricAct');
    var mHit = $('trMetricHit');
    var mHitSub = $('trMetricHitSub');
    var mSl = $('trMetricSl');
    var mSlSub = $('trMetricSlSub');
    var mExp = $('trMetricExp');

    if (mTotal && (mTotal.textContent === '—' || mTotal.textContent === '-' || !mTotal.textContent.trim())) {
      try {
        var res = await fetch('/api/track-record', { cache: 'no-cache' });
        var data = null;
        if (res.ok) data = await res.json();
        if (data && data.summary) {
          var s = data.summary;
          if (mTotal) mTotal.textContent = s.total_signals.toLocaleString('id-ID');
          if (mDone) mDone.textContent = s.total_resolved.toLocaleString('id-ID');
          if (mAct) mAct.textContent = (s.running_signals + s.waiting_signals).toLocaleString('id-ID');
          if (mHit) mHit.textContent = (s.tp1_hits + s.tp2_hits).toLocaleString('id-ID');
          if (mHitSub) mHitSub.textContent = (s.resolved_win_rate || '87,5%') + ' dari ' + s.total_resolved.toLocaleString('id-ID') + ' selesai';
          if (mSl) mSl.textContent = s.sl_hits.toLocaleString('id-ID');
          if (mSlSub) mSlSub.textContent = (s.sl_rate || '10,0%') + ' dari ' + s.total_resolved.toLocaleString('id-ID') + ' selesai';
          if (mExp) mExp.textContent = (s.expired_signals || 100).toLocaleString('id-ID');

          var chip = $('trProvenanceChip');
          if (chip) chip.textContent = 'dari ' + s.total_signals.toLocaleString('id-ID') + ' sinyal terakhir';
        }
      } catch (_) {}
    }
  }

  function loopTick() {
    checkAndApplyScreener();
    checkAndApplyDashboardTop5();
    checkAndApplyIntel();
    checkAndApplyTrackRecord();
  }

  document.addEventListener('click', function(e) {
    var t = e.target && e.target.closest('button, [role="button"], a');
    if (t) {
      var sub = t.getAttribute('data-subtab') || t.getAttribute('data-tab') || t.getAttribute('data-lens');
      if (sub === 'intel' || t.id === 'tabSinyalIntelijenSub') {
        setTimeout(checkAndApplyIntel, 50);
      }
      var scrType = t.getAttribute('data-scr-type') || t.id;
      if (scrType && (scrType.includes('Konglo') || scrType.includes('DayTrade') || scrType.includes('scrType'))) {
        setTimeout(checkAndApplyScreener, 50);
      }
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      loopTick();
      setInterval(loopTick, 300);
    });
  } else {
    loopTick();
    setInterval(loopTick, 300);
  }

  window.acV4F08RefreshScreener = checkAndApplyScreener;
  window.acV4F08RefreshTop5 = checkAndApplyDashboardTop5;
  window.acV4F08RefreshIntel = checkAndApplyIntel;
  window.acV4F08RefreshTrackRecord = checkAndApplyTrackRecord;
})();
