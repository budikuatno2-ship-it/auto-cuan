/**
 * Auto-Cuan Market Intelligence Runtime (Fase 7)
 * - Dashboard Market Breadth & Deterministic Daily Summary
 * - Smart Broker Summary (2-Column Net Buy vs Net Sell + Concentration Ratios)
 * - 8 Screener Presets & Interactive Popover Info
 * - Bi-Directional Controller Network Integration
 *
 * AntiSlop compliance:
 * - Zero em-dashes
 * - Pure Indonesian financial formats (Jt, Mrd, T, koma desimal)
 * - High contrast accessible markup
 */
(function (root) {
  'use strict';

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }

  function formatRupiahCompact(val) {
    var n = Number(val || 0);
    var abs = Math.abs(n);
    var sign = n < 0 ? '-' : '';
    if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2).replace('.', ',') + ' T';
    if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(1).replace('.', ',') + ' Mrd';
    if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1).replace('.', ',') + ' Jt';
    return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
  }

  // ============================================================
  // 1. DASHBOARD MARKET BREADTH
  // ============================================================
  async function renderMarketBreadth(containerId) {
    var container = byId(containerId);
    if (!container) return;

    container.innerHTML = '<div class="ac-breadth-loading text-center py-6 text-gray-500 text-xs">' +
      '<span class="spinner-sm"></span> Memuat analisis Market Breadth IDX...' +
      '</div>';

    try {
      var resp = await fetch('/api/sector-hot?action=market-breadth');
      var data = await resp.json();
      if (!data || !data.success) {
        container.innerHTML = '<div class="text-xs text-gray-500 p-4 text-center">Gagal memuat ringkasan pasar.</div>';
        return;
      }

      var html = '<div class="ac-market-breadth-card">' +
        '  <div class="ac-breadth-header">' +
        '    <div class="flex items-center gap-2">' +
        '      <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>' +
        '      <h2 class="text-sm font-bold text-white tracking-wide">Ringkasan Pasar & Market Breadth IDX</h2>' +
        '      <span class="ac-breadth-sentiment-badge" style="background-color: ' + data.sentimentColor + '20; color: ' + data.sentimentColor + '; border: 1px solid ' + data.sentimentColor + '40;">' + escapeHtml(data.sentiment) + '</span>' +
        '    </div>' +
        '    <div class="text-xs text-gray-400 font-mono">' + escapeHtml(data.asOfDisplay) + '</div>' +
        '  </div>' +
        '  <div class="ac-breadth-stats-grid">' +
        '    <div class="ac-breadth-stat-tile is-gainer">' +
        '      <div class="ac-stat-label">Saham Naik (Gainers)</div>' +
        '      <div class="ac-stat-value text-emerald-400">' + data.gainers.toLocaleString('id-ID') + ' <span class="text-xs font-normal">(' + data.gainerPct.toFixed(1).replace('.', ',') + '%)</span></div>' +
        '    </div>' +
        '    <div class="ac-breadth-stat-tile is-loser">' +
        '      <div class="ac-stat-label">Saham Turun (Losers)</div>' +
        '      <div class="ac-stat-value text-rose-400">' + data.losers.toLocaleString('id-ID') + ' <span class="text-xs font-normal">(' + data.loserPct.toFixed(1).replace('.', ',') + '%)</span></div>' +
        '    </div>' +
        '    <div class="ac-breadth-stat-tile is-flat">' +
        '      <div class="ac-stat-label">Stagnan / Tetap</div>' +
        '      <div class="ac-stat-value text-slate-300">' + data.unchanged.toLocaleString('id-ID') + ' <span class="text-xs font-normal">(' + data.unchangedPct.toFixed(1).replace('.', ',') + '%)</span></div>' +
        '    </div>' +
        '    <div class="ac-breadth-stat-tile is-turnover">' +
        '      <div class="ac-stat-label">Total Turnover Harian</div>' +
        '      <div class="ac-stat-value text-sky-400">' + escapeHtml(data.totalTurnoverDisplay) + '</div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="ac-breadth-bar-wrap">' +
        '    <div class="ac-breadth-bar">' +
        '      <div class="ac-bar-gainer" style="width: ' + data.gainerPct + '%;" title="Naik: ' + data.gainerPct + '%"></div>' +
        '      <div class="ac-bar-flat" style="width: ' + data.unchangedPct + '%;" title="Stagnan: ' + data.unchangedPct + '%"></div>' +
        '      <div class="ac-bar-loser" style="width: ' + data.loserPct + '%;" title="Turun: ' + data.loserPct + '%"></div>' +
        '    </div>' +
        '    <div class="ac-breadth-bar-legend">' +
        '      <span class="text-emerald-400">&bull; Naik ' + data.gainerPct.toFixed(1).replace('.', ',') + '%</span>' +
        '      <span class="text-slate-400">&bull; Stagnan ' + data.unchangedPct.toFixed(1).replace('.', ',') + '%</span>' +
        '      <span class="text-rose-400">&bull; Turun ' + data.loserPct.toFixed(1).replace('.', ',') + '%</span>' +
        '    </div>' +
        '  </div>' +
        '  <div class="ac-breadth-footer-meta">' +
        '    <span>Volume: <strong>' + escapeHtml(data.totalVolumeDisplay) + '</strong></span>' +
        '    <span>Frekuensi: <strong>' + escapeHtml(data.totalFrequencyDisplay) + '</strong></span>' +
        '    <span>Status Asing: <strong>' + escapeHtml(data.foreignFlowStatus) + '</strong></span>' +
        '  </div>' +
        '</div>';

      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = '<div class="text-xs text-rose-400 p-4 text-center">Gagal memuat Market Breadth: ' + escapeHtml(err.message) + '</div>';
    }
  }

  // ============================================================
  // 2. SMART BROKER SUMMARY 2 KOLOM
  // ============================================================
  async function renderSmartBrokerSummary(containerId, ticker, date) {
    var container = byId(containerId);
    if (!container) return;

    var safeTicker = String(ticker || (root.activeTicker || 'BBCA')).trim().toUpperCase();

    container.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs">' +
      '<span class="spinner-sm"></span> Menghitung Smart Broker Summary 2-Kolom ' + safeTicker + '...' +
      '</div>';

    try {
      var url = '/api/sector-hot?action=broker-summary-smart&ticker=' + encodeURIComponent(safeTicker);
      if (date) url += '&date=' + encodeURIComponent(date);

      var resp = await fetch(url);
      var data = await resp.json();
      if (!data || !data.success) {
        container.innerHTML = '<div class="text-xs text-gray-500 p-4 text-center">Data Broker Summary ' + safeTicker + ' belum tersedia.</div>';
        return;
      }

      var html = '<div class="ac-smart-broksum-wrap">' +
        '  <div class="ac-smart-broksum-top-header">' +
        '    <div class="flex items-center gap-2 flex-wrap">' +
        '      <span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono font-bold text-xs border border-emerald-500/30">' + safeTicker + '</span>' +
        '      <span class="text-sm font-bold text-white">Smart Broker Summary</span>' +
        '      <span class="ac-bandar-status-badge ' + data.bandarStatusClass + '">' + escapeHtml(data.bandarStatus) + '</span>' +
        '    </div>' +
        '    <div class="text-xs text-gray-400 font-mono">Snapshot: ' + escapeHtml(data.date) + '</div>' +
        '  </div>' +
        '  <div class="ac-broksum-concentration-row">' +
        '    <div class="ac-conc-tile">' +
        '      <span class="ac-conc-label">Top 1 Buyer Ratio</span>' +
        '      <span class="ac-conc-val text-white">' + data.top1Ratio.toFixed(1).replace('.', ',') + '%</span>' +
        '    </div>' +
        '    <div class="ac-conc-tile is-highlight">' +
        '      <span class="ac-conc-label">Top 3 Concentration</span>' +
        '      <span class="ac-conc-val text-emerald-400">' + data.top3Ratio.toFixed(1).replace('.', ',') + '%</span>' +
        '    </div>' +
        '    <div class="ac-conc-tile">' +
        '      <span class="ac-conc-label">Top 5 Concentration</span>' +
        '      <span class="ac-conc-val text-white">' + data.top5Ratio.toFixed(1).replace('.', ',') + '%</span>' +
        '    </div>' +
        '    <div class="ac-conc-narrative">' +
        '      <p class="text-xs text-gray-300">' + escapeHtml(data.bandarSummaryText) + '</p>' +
        '    </div>' +
        '  </div>' +
        '  <div class="ac-smart-broksum-grid">' +
        '    <div class="ac-broksum-column is-buyer">' +
        '      <div class="ac-col-header text-emerald-400">' +
        '        <div class="flex items-center gap-1.5 font-bold text-xs">' +
        '          <span class="w-2 h-2 rounded-full bg-emerald-400"></span>' +
        '          TOP NET BUYER (AKUMULASI)' +
        '        </div>' +
        '        <div class="text-[11px] font-mono text-emerald-300/80">' + formatRupiahCompact(data.totalBuyValue) + '</div>' +
        '      </div>' +
        '      <div class="ac-broksum-table-scroll">' +
        '        <table class="ac-broksum-table">' +
        '          <thead>' +
        '            <tr>' +
        '              <th style="width: 25%;">Broker</th>' +
        '              <th style="width: 22%;" class="text-right">Lot</th>' +
        '              <th style="width: 23%;" class="text-right">Avg (Rp)</th>' +
        '              <th style="width: 30%;" class="text-right">Nilai (Rp)</th>' +
        '            </tr>' +
        '          </thead>' +
        '          <tbody>';

      if (data.topBuyers && data.topBuyers.length > 0) {
        data.topBuyers.forEach(function (b) {
          var originBadge = b.isForeign ?
            '<span class="ac-broker-origin is-foreign">ASING</span>' :
            '<span class="ac-broker-origin is-domestic">DOM</span>';

          html += '<tr>' +
            '  <td><div class="flex items-center gap-1.5"><strong class="font-mono text-white text-xs">' + escapeHtml(b.code) + '</strong>' + originBadge + '</div></td>' +
            '  <td class="text-right font-mono text-xs text-gray-300">' + b.netLot.toLocaleString('id-ID') + '</td>' +
            '  <td class="text-right font-mono text-xs text-emerald-400 font-semibold">' + b.avgPrice.toLocaleString('id-ID') + '</td>' +
            '  <td class="text-right font-mono text-xs text-white font-semibold">' + formatRupiahCompact(b.netValue) + '</td>' +
            '</tr>';
        });
      } else {
        html += '<tr><td colspan="4" class="text-center text-gray-500 py-4 text-xs">Tidak ada net buyer.</td></tr>';
      }

      html += '          </tbody>' +
        '        </table>' +
        '      </div>' +
        '    </div>' +
        '    <div class="ac-broksum-column is-seller">' +
        '      <div class="ac-col-header text-rose-400">' +
        '        <div class="flex items-center gap-1.5 font-bold text-xs">' +
        '          <span class="w-2 h-2 rounded-full bg-rose-400"></span>' +
        '          TOP NET SELLER (DISTRIBUSI)' +
        '        </div>' +
        '        <div class="text-[11px] font-mono text-rose-300/80">' + formatRupiahCompact(data.totalSellValue) + '</div>' +
        '      </div>' +
        '      <div class="ac-broksum-table-scroll">' +
        '        <table class="ac-broksum-table">' +
        '          <thead>' +
        '            <tr>' +
        '              <th style="width: 25%;">Broker</th>' +
        '              <th style="width: 22%;" class="text-right">Lot</th>' +
        '              <th style="width: 23%;" class="text-right">Avg (Rp)</th>' +
        '              <th style="width: 30%;" class="text-right">Nilai (Rp)</th>' +
        '            </tr>' +
        '          </thead>' +
        '          <tbody>';

      if (data.topSellers && data.topSellers.length > 0) {
        data.topSellers.forEach(function (s) {
          var originBadge = s.isForeign ?
            '<span class="ac-broker-origin is-foreign">ASING</span>' :
            '<span class="ac-broker-origin is-domestic">DOM</span>';

          html += '<tr>' +
            '  <td><div class="flex items-center gap-1.5"><strong class="font-mono text-white text-xs">' + escapeHtml(s.code) + '</strong>' + originBadge + '</div></td>' +
            '  <td class="text-right font-mono text-xs text-gray-300">' + s.netLot.toLocaleString('id-ID') + '</td>' +
            '  <td class="text-right font-mono text-xs text-rose-400 font-semibold">' + s.avgPrice.toLocaleString('id-ID') + '</td>' +
            '  <td class="text-right font-mono text-xs text-white font-semibold">' + formatRupiahCompact(s.netValue) + '</td>' +
            '</tr>';
        });
      } else {
        html += '<tr><td colspan="4" class="text-center text-gray-500 py-4 text-xs">Tidak ada net seller.</td></tr>';
      }

      html += '          </tbody>' +
        '        </table>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '</div>';

      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = '<div class="text-xs text-rose-400 p-4 text-center">Gagal memuat Broker Summary: ' + escapeHtml(err.message) + '</div>';
    }
  }

  // ============================================================
  // 3. 8 SCREENER PRESETS DENGAN POPOVER INFO
  // ============================================================
  var _activePopoverId = null;

  async function render8ScreenerPresets(containerId, onSelectCallback) {
    var container = byId(containerId);
    if (!container) return;

    try {
      var resp = await fetch('/api/sector-hot?action=screener-presets');
      var data = await resp.json();
      if (!data || !data.success || !Array.isArray(data.presets)) return;

      var presets = data.presets;
      var html = '<div class="ac-presets-header flex items-center justify-between mb-2">' +
        '  <span class="text-xs font-semibold text-gray-300">8 Preset Screener Bandar Metrics:</span>' +
        '  <span class="text-[11px] text-gray-500">Klik ikon (i) untuk membaca formula</span>' +
        '</div>' +
        '<div class="ac-presets-container flex items-center gap-2 flex-wrap">';

      presets.forEach(function (p) {
        html += '<div class="ac-preset-pill-wrap relative">' +
          '  <button type="button" class="ac-preset-btn" data-preset-id="' + escapeHtml(p.id) + '" onclick="AutoCuanMarketIntelligence.applyPreset(\'' + escapeHtml(p.id) + '\')">' +
          '    <span class="ac-preset-badge" style="background-color: ' + p.badgeColor + '25; color: ' + p.badgeColor + ';">' + escapeHtml(p.badge) + '</span>' +
          '    <span class="ac-preset-name">' + escapeHtml(p.name) + '</span>' +
          '  </button>' +
          '  <button type="button" class="ac-preset-info-btn" aria-label="Informasi preset ' + escapeHtml(p.name) + '" onclick="AutoCuanMarketIntelligence.togglePopover(\'' + escapeHtml(p.id) + '\', event)">' +
          '    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>' +
          '  </button>' +
          '  <div id="popover_' + escapeHtml(p.id) + '" class="ac-preset-popover" style="display: none;">' +
          '    <div class="ac-popover-header">' +
          '      <div>' +
          '        <div class="text-xs font-bold text-white">' + escapeHtml(p.name) + '</div>' +
          '        <div class="text-[10px] text-emerald-400 font-semibold">' + escapeHtml(p.category) + ' &bull; ' + escapeHtml(p.timeframe) + '</div>' +
          '      </div>' +
          '      <button type="button" class="text-gray-400 hover:text-white" onclick="AutoCuanMarketIntelligence.closePopovers()">&times;</button>' +
          '    </div>' +
          '    <div class="ac-popover-body space-y-2 text-xs">' +
          '      <div>' +
          '        <span class="text-gray-400 text-[11px] font-semibold">Tujuan Strategi:</span>' +
          '        <p class="text-gray-200 mt-0.5">' + escapeHtml(p.description) + '</p>' +
          '      </div>' +
          '      <div>' +
          '        <span class="text-gray-400 text-[11px] font-semibold">Formula Filter Kuantitatif:</span>' +
          '        <p class="text-emerald-300 font-mono text-[11px] mt-0.5 p-1.5 rounded bg-dark-800 border border-dark-600/50">' + escapeHtml(p.formula) + '</p>' +
          '      </div>' +
          '      <div>' +
          '        <span class="text-gray-400 text-[11px] font-semibold">Risk Gate Minimum:</span>' +
          '        <p class="text-amber-300 text-[11px] mt-0.5">' + escapeHtml(p.riskGate) + '</p>' +
          '      </div>' +
          '      <button type="button" class="w-full mt-2 py-1.5 px-3 rounded-lg bg-emerald-500 text-black font-semibold text-xs hover:bg-emerald-400 transition" onclick="AutoCuanMarketIntelligence.applyPreset(\'' + escapeHtml(p.id) + '\')">Terapkan Preset Ini</button>' +
          '    </div>' +
          '  </div>' +
          '</div>';
      });

      html += '</div>';
      container.innerHTML = html;

      // Close popover when clicking outside
      document.addEventListener('click', function (e) {
        if (!e.target.closest('.ac-preset-pill-wrap')) {
          closePopovers();
        }
      });
    } catch (_) {}
  }

  function togglePopover(presetId, event) {
    if (event) event.stopPropagation();

    var target = byId('popover_' + presetId);
    if (!target) return;

    var wasOpen = target.style.display === 'block';
    closePopovers();

    if (!wasOpen) {
      target.style.display = 'block';
      _activePopoverId = presetId;
    }
  }

  function closePopovers() {
    var all = document.querySelectorAll('.ac-preset-popover');
    for (var i = 0; i < all.length; i++) {
      all[i].style.display = 'none';
    }
    _activePopoverId = null;
  }

  async function applyPreset(presetId) {
    closePopovers();

    // Visual highlight on preset button
    var allBtns = document.querySelectorAll('.ac-preset-btn');
    for (var i = 0; i < allBtns.length; i++) {
      if (allBtns[i].getAttribute('data-preset-id') === presetId) {
        allBtns[i].classList.add('is-active');
      } else {
        allBtns[i].classList.remove('is-active');
      }
    }

    if (typeof root.showToast === 'function') {
      root.showToast(`Menerapkan preset: ${presetId.replace(/_/g, ' ')}`, 'info');
    }

    try {
      var resp = await fetch('/api/sector-hot?action=screener-presets&preset=' + encodeURIComponent(presetId));
      var data = await resp.json();
      if (data && data.success && Array.isArray(data.results)) {
        renderPresetResults(data);
      }
    } catch (_) {}
  }

  function renderPresetResults(data) {
    var resultsWrap = byId('screenerPresetResultsContainer') || byId('screenerTableContainer');
    if (!resultsWrap) return;

    var html = '<div class="ac-preset-results-card mb-4">' +
      '  <div class="flex items-center justify-between pb-3 border-b border-dark-600/40">' +
      '    <div>' +
      '      <span class="text-xs font-bold text-emerald-400">Hasil Filter Preset: ' + escapeHtml(data.preset.name) + '</span>' +
      '      <div class="text-[11px] text-gray-400 mt-0.5">' + escapeHtml(data.preset.formula) + '</div>' +
      '    </div>' +
      '    <span class="text-xs font-semibold text-white px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/30">' + data.totalFound + ' Saham Lolos</span>' +
      '  </div>' +
      '  <div class="overflow-x-auto mt-2">' +
      '    <table class="w-full text-xs text-left">' +
      '      <thead>' +
      '        <tr class="text-gray-400 border-b border-dark-600/20">' +
      '          <th class="py-2 px-3">Ticker</th>' +
      '          <th class="py-2 px-3">Nama Perusahaan</th>' +
      '          <th class="py-2 px-3 text-right">Harga (Rp)</th>' +
      '          <th class="py-2 px-3 text-right">Perubahan</th>' +
      '          <th class="py-2 px-3 text-right">Turnover</th>' +
      '          <th class="py-2 px-3">Alasan Lolos Filter</th>' +
      '          <th class="py-2 px-3 text-center">Aksi</th>' +
      '        </tr>' +
      '      </thead>' +
      '      <tbody>';

    if (data.results && data.results.length > 0) {
      data.results.forEach(function (r) {
        var chgColor = r.change > 0 ? 'text-emerald-400' : (r.change < 0 ? 'text-rose-400' : 'text-gray-300');
        var chgSign = r.change > 0 ? '+' : '';

        html += '<tr class="border-b border-dark-700/20 hover:bg-dark-700/30 transition cursor-pointer" onclick="AutoCuanMarketIntelligence.selectStockRow(\'' + escapeHtml(r.ticker) + '\')">' +
          '  <td class="py-2 px-3 font-mono font-bold text-emerald-400">' + escapeHtml(r.ticker) + '</td>' +
          '  <td class="py-2 px-3 text-gray-300 max-w-[200px] truncate">' + escapeHtml(r.companyName) + '</td>' +
          '  <td class="py-2 px-3 text-right font-mono font-semibold text-white">' + r.close.toLocaleString('id-ID') + '</td>' +
          '  <td class="py-2 px-3 text-right font-mono font-semibold ' + chgColor + '">' + chgSign + r.changePct.toFixed(2).replace('.', ',') + '%</td>' +
          '  <td class="py-2 px-3 text-right font-mono text-gray-300">' + escapeHtml(r.turnoverDisplay) + '</td>' +
          '  <td class="py-2 px-3 text-gray-400 max-w-[260px] truncate">' + escapeHtml(r.matchReason) + '</td>' +
          '  <td class="py-2 px-3 text-center">' +
          '    <button type="button" class="px-2 py-1 rounded bg-emerald-500/20 text-emerald-300 text-[11px] font-semibold hover:bg-emerald-500/30" onclick="event.stopPropagation(); AutoCuanMarketIntelligence.selectStockRow(\'' + escapeHtml(r.ticker) + '\')">Buka Chart &rarr;</button>' +
          '  </td>' +
          '</tr>';
      });
    } else {
      html += '<tr><td colspan="7" class="py-6 text-center text-gray-500">Tidak ada saham yang memenuhi kriteria preset ini saat ini.</td></tr>';
    }

    html += '      </tbody>' +
      '    </table>' +
      '  </div>' +
      '</div>';

    resultsWrap.insertAdjacentHTML('afterbegin', html);
  }

  // ============================================================
  // 4. BI-DIRECTIONAL CONTROLLER NETWORK
  // ============================================================
  function selectStockRow(ticker) {
    var safeTicker = String(ticker || '').trim().toUpperCase();
    if (!safeTicker) return;

    // Dispatch global event
    var event = new CustomEvent('autocuan:ticker-select', {
      detail: { ticker: safeTicker, source: 'screener-row' },
      bubbles: true
    });
    window.dispatchEvent(event);

    // Sync to UnifiedCockpit
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(safeTicker, {
        loadChart: true,
        forceChartReload: true,
        preserveTab: false
      });
    }

    // Switch chart workstation
    if (root.AutoCuanChartWorkstation && typeof root.AutoCuanChartWorkstation.switchTicker === 'function') {
      root.AutoCuanChartWorkstation.switchTicker(safeTicker);
    }

    // Update broker summary if present
    if (byId('smartBrokerSummaryContainer')) {
      renderSmartBrokerSummary('smartBrokerSummaryContainer', safeTicker);
    }

    // Show toast feedback
    if (typeof root.showToast === 'function') {
      root.showToast(`Saham terpilih: ${safeTicker}`, 'info');
    }
  }

  // Listen to global ticker changes
  window.addEventListener('autocuan:ticker-select', function (e) {
    if (e && e.detail && e.detail.ticker) {
      var t = e.detail.ticker;
      if (byId('smartBrokerSummaryContainer')) {
        renderSmartBrokerSummary('smartBrokerSummaryContainer', t);
      }
    }
  });

  // Expose API
  root.AutoCuanMarketIntelligence = {
    renderMarketBreadth: renderMarketBreadth,
    renderSmartBrokerSummary: renderSmartBrokerSummary,
    render8ScreenerPresets: render8ScreenerPresets,
    togglePopover: togglePopover,
    closePopovers: closePopovers,
    applyPreset: applyPreset,
    selectStockRow: selectStockRow
  };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
