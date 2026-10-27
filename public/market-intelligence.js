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
  // `preloaded` lets the Dashboard pass the payload it already fetched for the
  // market strip, so the detail card does not request it a second time.
  async function renderMarketBreadth(containerId, preloaded) {
    var container = byId(containerId);
    if (!container) return;

    if (!preloaded) {
      container.innerHTML = '<div class="ac-breadth-loading text-center py-6 text-gray-500 text-xs">' +
        '<span class="spinner-sm"></span> Memuat analisis Market Breadth IDX...' +
        '</div>';
    }

    try {
      var data = preloaded;
      if (!data) {
        var resp = await fetch('/api/sector-hot?action=market-breadth');
        data = await resp.json();
      }
      if (!data || !data.success) {
        container.innerHTML = '<div class="text-xs text-gray-500 p-4 text-center">Gagal memuat ringkasan pasar.</div>';
        return;
      }
      if (data.data_available === false || data.gainerPct == null) {
        container.innerHTML = '<div class="text-xs text-gray-500 p-4 text-center">Data pasar belum tersedia.</div>';
        return;
      }

      var dash = '<span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">&mdash;</span>';
      var narrative = data.narrativeSummary || '';
      var html = '<div class="ac-market-breadth-card">' +
        '  <div class="ac-breadth-header">' +
        '    <div class="flex items-center gap-2">' +
        '      <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>' +
        '      <h2 class="text-sm font-bold tracking-wide" style="color: #f8fafc !important;">Ringkasan Pasar & Market Breadth IDX</h2>' +
        '      <span class="ac-breadth-sentiment-badge" style="background-color: ' + data.sentimentColor + '20; color: ' + data.sentimentColor + '; border: 1px solid ' + data.sentimentColor + '40;">' + escapeHtml(data.sentiment) + '</span>' +
        '    </div>' +
        '    <div class="text-xs font-mono" style="color: #cbd5e1 !important;">' + escapeHtml(data.asOfDisplay) + '</div>' +
        '  </div>' +
        '  <div class="ac-breadth-narrative mt-1 mb-3 p-2.5 rounded-lg bg-slate-800/80 border border-slate-700/60 text-xs leading-relaxed font-sans" style="color: #f1f5f9 !important;">' +
        '    ' + escapeHtml(narrative) +
        '  </div>' +
        '  <div class="ac-breadth-stats-grid">' +
        '    <div class="ac-breadth-stat-tile is-gainer">' +
        '      <div class="ac-stat-label" style="color: #cbd5e1 !important;">Saham Naik (Gainers)</div>' +
        '      <div class="ac-stat-value text-emerald-400">' + data.gainers.toLocaleString('id-ID') + ' <span class="text-xs font-normal">(' + data.gainerPct.toFixed(1).replace('.', ',') + '%)</span></div>' +
        '    </div>' +
        '    <div class="ac-breadth-stat-tile is-loser">' +
        '      <div class="ac-stat-label" style="color: #cbd5e1 !important;">Saham Turun (Losers)</div>' +
        '      <div class="ac-stat-value text-rose-400">' + data.losers.toLocaleString('id-ID') + ' <span class="text-xs font-normal">(' + data.loserPct.toFixed(1).replace('.', ',') + '%)</span></div>' +
        '    </div>' +
        '    <div class="ac-breadth-stat-tile is-flat">' +
        '      <div class="ac-stat-label" style="color: #cbd5e1 !important;">Stagnan / Tetap</div>' +
        '      <div class="ac-stat-value text-slate-300">' + data.unchanged.toLocaleString('id-ID') + ' <span class="text-xs font-normal">(' + data.unchangedPct.toFixed(1).replace('.', ',') + '%)</span></div>' +
        '    </div>' +
        '    <div class="ac-breadth-stat-tile is-turnover">' +
        '      <div class="ac-stat-label" style="color: #cbd5e1 !important;">Total Turnover Harian</div>' +
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
        '  <div class="ac-breadth-footer-meta" style="color: #cbd5e1 !important;">' +
        '    <span>Volume: <strong>' + escapeHtml(data.totalVolumeDisplay) + '</strong></span>' +
        '    <span>Frekuensi: <strong>' + (data.totalFrequencyDisplay ? escapeHtml(data.totalFrequencyDisplay) : dash) + '</strong></span>' +
        '    <span>Status Asing: <strong>' + (data.foreignFlowStatus ? escapeHtml(data.foreignFlowStatus) : dash) + '</strong></span>' +
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

      var dateLabel = data.dateDisplay || (data.date ? data.date.replace(/(\d{4})-(\d{2})-(\d{2})/, function(_, y, m, d) {
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
        return d + ' ' + (months[parseInt(m, 10) - 1] || m) + ' ' + y;
      }) : '14 Okt 2026');

      var html = '<div class="ac-smart-broksum-wrap">' +
        '  <div class="ac-smart-broksum-top-header">' +
        '    <div class="flex items-center gap-2 flex-wrap">' +
        '      <span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono font-bold text-xs border border-emerald-500/30">' + safeTicker + '</span>' +
        '      <span class="text-sm font-bold" style="color: #f8fafc !important;">Smart Broker Summary</span>' +
        '      <span class="ac-bandar-status-badge ' + data.bandarStatusClass + '">' + escapeHtml(data.bandarStatus) + '</span>' +
        '    </div>' +
        '    <div class="text-xs text-gray-400 font-mono">Snapshot: ' + escapeHtml(dateLabel) + '</div>' +
        '  </div>' +
        '  <div class="ac-broksum-concentration-row">' +
        '    <div class="ac-conc-tile">' +
        '      <span class="ac-conc-label">Top 1 Buyer Ratio</span>' +
        '      <span class="ac-conc-val" style="color: #f8fafc !important;">' + data.top1Ratio.toFixed(1).replace('.', ',') + '%</span>' +
        '    </div>' +
        '    <div class="ac-conc-tile is-highlight">' +
        '      <span class="ac-conc-label">Top 3 Concentration</span>' +
        '      <span class="ac-conc-val text-emerald-400">' + data.top3Ratio.toFixed(1).replace('.', ',') + '%</span>' +
        '    </div>' +
        '    <div class="ac-conc-tile">' +
        '      <span class="ac-conc-label">Top 5 Concentration</span>' +
        '      <span class="ac-conc-val" style="color: #f8fafc !important;">' + data.top5Ratio.toFixed(1).replace('.', ',') + '%</span>' +
        '    </div>' +
        '    <div class="ac-conc-narrative">' +
        '      <p class="text-xs" style="color: #cbd5e1 !important;">' + escapeHtml(data.bandarSummaryText) + '</p>' +
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
        '            <tr style="background-color: #1e293b !important;">' +
        '              <th style="width: 25%; background-color: #1e293b !important; color: #94a3b8 !important;">BROKER</th>' +
        '              <th style="width: 22%; background-color: #1e293b !important; color: #94a3b8 !important;" class="text-right">LOT</th>' +
        '              <th style="width: 23%; background-color: #1e293b !important; color: #94a3b8 !important;" class="text-right">AVG</th>' +
        '              <th style="width: 30%; background-color: #1e293b !important; color: #94a3b8 !important;" class="text-right">NILAI (RP)</th>' +
        '            </tr>' +
        '          </thead>' +
        '          <tbody>';

      if (data.topBuyers && data.topBuyers.length > 0) {
        data.topBuyers.forEach(function (b) {
          var originBadge = b.isForeign ?
            '<span class="ac-broker-origin is-foreign">ASING</span>' :
            '<span class="ac-broker-origin is-domestic">DOM</span>';

          html += '<tr>' +
            '  <td style="color: #f8fafc !important;"><div class="flex items-center gap-1.5"><strong class="font-mono text-xs" style="color: #f8fafc !important;">' + escapeHtml(b.code) + '</strong>' + originBadge + '</div></td>' +
            '  <td class="text-right font-mono text-xs" style="color: #f8fafc !important;">' + b.netLot.toLocaleString('id-ID') + '</td>' +
            '  <td class="text-right font-mono text-xs text-emerald-400 font-semibold">' + b.avgPrice.toLocaleString('id-ID') + '</td>' +
            '  <td class="text-right font-mono text-xs font-semibold" style="color: #f8fafc !important;">' + formatRupiahCompact(b.netValue) + '</td>' +
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
        '            <tr style="background-color: #1e293b !important;">' +
        '              <th style="width: 25%; background-color: #1e293b !important; color: #94a3b8 !important;">BROKER</th>' +
        '              <th style="width: 22%; background-color: #1e293b !important; color: #94a3b8 !important;" class="text-right">LOT</th>' +
        '              <th style="width: 23%; background-color: #1e293b !important; color: #94a3b8 !important;" class="text-right">AVG</th>' +
        '              <th style="width: 30%; background-color: #1e293b !important; color: #94a3b8 !important;" class="text-right">NILAI (RP)</th>' +
        '            </tr>' +
        '          </thead>' +
        '          <tbody>';

      if (data.topSellers && data.topSellers.length > 0) {
        data.topSellers.forEach(function (s) {
          var originBadge = s.isForeign ?
            '<span class="ac-broker-origin is-foreign">ASING</span>' :
            '<span class="ac-broker-origin is-domestic">DOM</span>';

          html += '<tr>' +
            '  <td style="color: #f8fafc !important;"><div class="flex items-center gap-1.5"><strong class="font-mono text-xs" style="color: #f8fafc !important;">' + escapeHtml(s.code) + '</strong>' + originBadge + '</div></td>' +
            '  <td class="text-right font-mono text-xs" style="color: #f8fafc !important;">' + s.netLot.toLocaleString('id-ID') + '</td>' +
            '  <td class="text-right font-mono text-xs text-rose-400 font-semibold">' + s.avgPrice.toLocaleString('id-ID') + '</td>' +
            '  <td class="text-right font-mono text-xs font-semibold" style="color: #f8fafc !important;">' + formatRupiahCompact(s.netValue) + '</td>' +
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
        var displayName = p.nameWithCount || (p.count != null ? (p.name + ' (' + p.count + ')') : p.name);
        html += '<div class="ac-preset-pill-wrap relative">' +
          '  <button type="button" class="ac-preset-btn" data-preset-id="' + escapeHtml(p.id) + '" onclick="AutoCuanMarketIntelligence.applyPreset(\'' + escapeHtml(p.id) + '\')">' +
          '    <span class="ac-preset-badge" style="background-color: ' + p.badgeColor + '25; color: ' + p.badgeColor + ';">' + escapeHtml(p.badge) + '</span>' +
          '    <span class="ac-preset-name">' + escapeHtml(displayName) + '</span>' +
          '  </button>' +
          '  <button type="button" class="ac-preset-info-btn" aria-label="Informasi preset ' + escapeHtml(p.name) + '" onclick="AutoCuanMarketIntelligence.togglePopover(\'' + escapeHtml(p.id) + '\', event)">' +
          '    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>' +
          '  </button>' +
          '  <div id="popover_' + escapeHtml(p.id) + '" class="ac-preset-popover" style="display: none; background-color: #0f172a !important; border: 1px solid #334155 !important;">' +
          '    <div class="ac-popover-header" style="background-color: #0f172a !important; border-bottom: 1px solid #1e293b !important;">' +
          '      <div>' +
          '        <div class="text-xs font-bold" style="color: #f8fafc !important;">' + escapeHtml(p.name) + '</div>' +
          '        <div class="text-[10px] text-emerald-400 font-semibold">' + escapeHtml(p.category) + ' &bull; ' + escapeHtml(p.timeframe) + '</div>' +
          '      </div>' +
          '      <button type="button" class="text-gray-400 hover:text-white" onclick="AutoCuanMarketIntelligence.closePopovers()">&times;</button>' +
          '    </div>' +
          '    <div class="ac-popover-body space-y-2 text-xs" style="background-color: #0f172a !important;">' +
          '      <div>' +
          '        <span class="text-[11px] font-semibold" style="color: #94a3b8 !important;">Tujuan Strategi:</span>' +
          '        <p class="mt-0.5" style="color: #e2e8f0 !important;">' + escapeHtml(p.description) + '</p>' +
          '      </div>' +
          '      <div>' +
          '        <span class="text-[11px] font-semibold" style="color: #94a3b8 !important;">Formula Filter Kuantitatif:</span>' +
          '        <p class="font-mono text-[11px] mt-0.5 p-1.5 rounded" style="background-color: #1e293b !important; color: #34d399 !important; border: 1px solid #334155 !important;">' + escapeHtml(p.formula) + '</p>' +
          '      </div>' +
          '      <div>' +
          '        <span class="text-[11px] font-semibold" style="color: #94a3b8 !important;">Risk Gate Minimum:</span>' +
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

    // FIX-22: remember the active screener preset so the chart handoff can
    // apply the exact same indicator layer set the trader was screening with.
    _activeScreenerPreset = String(presetId || 'simpel');
    root.__acActiveScreenerPreset = _activeScreenerPreset;

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
        // FIX-22: keep the last preset payload addressable so the chart handoff
        // can look up the clicked row without a second network round trip.
        root.__acLastPresetResults = data.results;
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
      '          <th class="py-2 px-3 text-right">RSI 14</th>' +
      '          <th class="py-2 px-3 text-right">Vol / Avg20</th>' +
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
        var rsiVal = r.rsi14 != null ? Number(r.rsi14).toFixed(1) : (r.rsi != null ? Number(r.rsi).toFixed(1) : '-');
        var volVal = r.vol_vs_avg20 != null ? Number(r.vol_vs_avg20).toFixed(2) + 'x' : (r.volAvgRatio != null ? Number(r.volAvgRatio).toFixed(2) + 'x' : '-');

        html += '<tr class="border-b border-dark-700/20 hover:bg-dark-700/30 transition cursor-pointer" onclick="AutoCuanMarketIntelligence.selectStockRow(\'' + escapeHtml(r.ticker) + '\')">' +
          '  <td class="py-2 px-3 font-mono font-bold text-emerald-400">' + escapeHtml(r.ticker) + '</td>' +
          '  <td class="py-2 px-3 text-gray-300 max-w-[200px] truncate">' + escapeHtml(r.companyName) + '</td>' +
          '  <td class="py-2 px-3 text-right font-mono font-semibold text-white">' + (r.last_price != null ? r.last_price.toLocaleString('id-ID') : r.close.toLocaleString('id-ID')) + '</td>' +
          '  <td class="py-2 px-3 text-right font-mono font-semibold ' + chgColor + '">' + chgSign + r.changePct.toFixed(2).replace('.', ',') + '%</td>' +
          '  <td class="py-2 px-3 text-right font-mono text-gray-200">' + rsiVal + '</td>' +
          '  <td class="py-2 px-3 text-right font-mono text-gray-200">' + volVal + '</td>' +
          '  <td class="py-2 px-3 text-right font-mono text-gray-300">' + escapeHtml(r.turnoverDisplay) + '</td>' +
          '  <td class="py-2 px-3 text-gray-400 max-w-[260px] truncate">' + escapeHtml(r.matchReason) + '</td>' +
          '  <td class="py-2 px-3 text-center">' +
          '    <button type="button" class="px-2 py-1 rounded bg-emerald-500/20 text-emerald-300 text-[11px] font-semibold hover:bg-emerald-500/30" onclick="event.stopPropagation(); AutoCuanMarketIntelligence.selectStockRow(\'' + escapeHtml(r.ticker) + '\')">Buka Chart &rarr;</button>' +
          '  </td>' +
          '</tr>';
      });
    } else {
      html += '<tr><td colspan="9" class="py-6 text-center text-gray-500">Tidak ada saham yang memenuhi kriteria preset ini saat ini.</td></tr>';
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
  var _activeScreenerPreset = 'simpel';

  /**
   * FIX-22: derive Entry / SL / TP levels from the deterministic row payload
   * that the screener already computed server side. We never invent numbers:
   * if the payload has no usable structure we return null so the chart simply
   * draws no price lines (AntiSlop: null over a fabricated level).
   */
  function buildPlanLevelsFromRow(ticker) {
    var row = null;
    try {
      if (root.ScreenerLatestStore && typeof root.ScreenerLatestStore.getRow === 'function') {
        row = root.ScreenerLatestStore.getRow(ticker);
      }
      if (!row && root.__acLastPresetResults) {
        var list = root.__acLastPresetResults;
        for (var i = 0; i < list.length; i++) {
          if (String(list[i] && list[i].ticker || '').toUpperCase() === ticker) { row = list[i]; break; }
        }
      }
    } catch (_) { row = null; }

    if (!row) return null;

    function num() {
      for (var i = 0; i < arguments.length; i++) {
        var v = Number(arguments[i]);
        if (Number.isFinite(v) && v > 0) return v;
      }
      return null;
    }

    // Real screener rows carry entry_low/entry_high/stop_loss/tp1/tp2 (see
    // api/sector-hot.js) so those names are preferred over any convenience alias.
    var entryLow = num(row.entry_low, row.entryLow, row.buy_low);
    var entryHigh = num(row.entry_high, row.entryHigh, row.buy_high);
    var entry = num(row.entry, row.buyArea, entryHigh, entryLow, row.last_price, row.close);
    var sl = num(row.sl, row.stopLoss, row.stop_loss);
    var tp1 = num(row.tp1, row.target1, row.tp1n);
    var tp2 = num(row.tp2, row.target2, row.tp2n);

    if (!entry || !sl || !tp1) return null;
    if (!tp2) tp2 = tp1;

    return { entry: entry, sl: sl, tp1: tp1, tp2: tp2 };
  }

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

    // FIX-22: route the trader straight into the dedicated Chart Workstation
    // lens. Reading the screener row is a chart-intent action, so the shell
    // must switch tab instead of leaving the user on the AI narrative.
    var chartPreset = _activeScreenerPreset || 'simpel';
    var chartPlanLevels = buildPlanLevelsFromRow(safeTicker);

    if (typeof root.navigateTo === 'function') {
      try { root.navigateTo('analisis', 'chart'); } catch (_) {}
    }
    var chartTabBtn = typeof document !== 'undefined' && document
      ? document.getElementById('tabChartWorkstation')
      : null;
    if (chartTabBtn && typeof chartTabBtn.click === 'function' && !chartTabBtn.classList.contains('is-active')) {
      chartTabBtn.click();
    }

    // Switch chart workstation with the screener preset + plan levels so the
    // Entry/SL/TP1/TP2 price lines are drawn immediately (no second click).
    if (root.AutoCuanChartWorkstation && typeof root.AutoCuanChartWorkstation.switchTicker === 'function') {
      root.AutoCuanChartWorkstation.switchTicker('mainChart', safeTicker, {
        preset: chartPreset,
        planLevels: chartPlanLevels,
        source: 'screener-row'
      });
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
