// Auto-Cuan Unified AI Cockpit Runtime (PR 2: Tata Letak Terpadu & Auto-Sync Ticker)
(function (root) {
  'use strict';

  var _activeSubTab = 'text'; // 'text' | 'vision'
  var _lastLoadedChartTicker = '';
  var _lastBandarSyncTicker = '';
  var _loadingChart = false;

  function byId(id) { return document.getElementById(id); }

  function cleanTicker(val) {
    return String(val || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function getActiveTicker() {
    var fromWindow = cleanTicker(root.activeTicker);
    var fromInput = byId('analisisInput') ? cleanTicker(byId('analisisInput').value) : '';
    var fromChartInput = byId('chartTickerInput') ? cleanTicker(byId('chartTickerInput').value) : '';
    return fromWindow || fromInput || fromChartInput || 'BBCA';
  }

  function switchAnalysisSubTab(mode) {
    _activeSubTab = mode === 'vision' ? 'vision' : 'text';

    if (typeof root.switchAnalisisTab === 'function') {
      root.switchAnalisisTab(mode === 'vision' ? 'chart' : 'analisis');
      return;
    }

    var btnText = byId('tabAnalisisText');
    var btnVision = byId('tabAnalisisVision');
    var panelText = byId('panelAnalisisText');
    var panelVision = byId('panelAnalisisVision');

    if (btnText) {
      if (_activeSubTab === 'text') btnText.classList.add('active');
      else btnText.classList.remove('active');
    }
    if (btnVision) {
      if (_activeSubTab === 'vision') btnVision.classList.add('active');
      else btnVision.classList.remove('active');
    }
    if (panelText) {
      panelText.style.display = _activeSubTab === 'text' ? 'block' : 'none';
    }
    if (panelVision) {
      panelVision.style.display = _activeSubTab === 'vision' ? 'block' : 'none';
    }
  }

  async function loadUnifiedChart(ticker) {
    var safeTicker = cleanTicker(ticker);
    if (!safeTicker) return;

    var container = byId('unifiedChartContainer');
    if (!container) return;

    _lastLoadedChartTicker = safeTicker;
    _loadingChart = true;

    var chartId = 'unifiedchart_' + Date.now();
    var _pd = (typeof root.chartDims === 'function') ? root.chartDims('page') : { main: 340, rsi: 60 };
    var _fsIcon = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4m11-5v4a1 1 0 01-1 1h-4"/></svg>';
    var _dlIcon = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"/></svg>';

    container.innerHTML = '<div class="unified-card-header">' +
      '<div class="flex items-center gap-2 min-w-0">' +
      '<span class="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>' +
      '<h2 class="text-sm font-semibold text-gray-200 truncate">Chart Interaktif ' + safeTicker + '</h2>' +
      '<span class="text-xs text-gray-500 shrink-0">Data Historis T-1</span>' +
      '</div>' +
      '<div class="flex items-center gap-2 shrink-0">' +
      '<button id="' + chartId + '_ai" onclick="UnifiedCockpit.handleUnifiedChartAiSubmit()" class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-blue-300 border border-blue-500/30 hover:bg-blue-500/10 transition" aria-label="Analisis chart ' + safeTicker + ' dengan AI">🤖 Analisis AI</button>' +
      '<button id="' + chartId + '_fs" onclick="UnifiedCockpit.openFullscreen()" class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-sky-300 border border-sky-500/30 hover:bg-sky-500/10 transition" aria-label="Buka chart ' + safeTicker + ' layar penuh">' + _fsIcon + 'Layar Penuh</button>' +
      '<button id="' + chartId + '_dl" onclick="downloadChartPng(\'' + chartId + '\',\'' + safeTicker + '\',this)" class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/10 transition" aria-label="Download chart ' + safeTicker + ' sebagai PNG">' + _dlIcon + 'Download PNG</button>' +
      '</div>' +
      '</div>' +
      '<div id="' + chartId + '_container" style="height:' + _pd.main + 'px;width:100%"><div class="h-full p-4 space-y-3"><div class="skeleton-card h-full flex flex-col justify-end gap-3"><div class="skeleton-line w-2/3"></div><div class="skeleton-line w-full"></div><div class="skeleton-line w-5/6"></div><p class="text-xs text-gray-500 pt-2"><span class="spinner-sm"></span>Memuat candlestick ' + safeTicker + '...</p></div></div></div>' +
      '<div id="' + chartId + '_rsi" class="border-t border-dark-600/20" style="height:' + _pd.rsi + 'px;width:100%"></div>' +
      '<div id="' + chartId + '_metrics" class="px-3 py-2 border-t border-dark-600/20 grid grid-cols-4 sm:grid-cols-8 gap-1 text-[10px]"></div>' +
      '<div class="unified-chart-legend"><span class="text-emerald-400 font-semibold">MA20</span><span class="text-yellow-400 font-semibold">MA50</span><span class="text-blue-400 font-semibold">MA100</span><span class="text-purple-400 font-semibold">MA200</span><span class="text-orange-400 font-semibold">RSI14</span><span class="text-amber-400/80 font-semibold">Fibonacci</span></div>';

    try {
      var resp = await fetch('/api/candles?ticker=' + encodeURIComponent(safeTicker));
      var data = await resp.json();
      _loadingChart = false;

      if (!data || !data.success || !data.candles || data.candles.length === 0) {
        var errEl = byId(chartId + '_container');
        if (errEl) errEl.innerHTML = '<div class="flex items-center justify-center h-full text-gray-500 text-xs p-4 text-center">Data chart untuk ' + safeTicker + ' belum tersedia. Coba ticker lain.</div>';
        return;
      }

      root._chartPageData = data;
      var loadLwc = (typeof root.loadLightweightCharts === 'function') ? root.loadLightweightCharts :
                    (typeof window !== 'undefined' && typeof window.loadLightweightCharts === 'function') ? window.loadLightweightCharts : null;
      var renderLwc = (typeof root.renderLightweightChart === 'function') ? root.renderLightweightChart :
                      (typeof window !== 'undefined' && typeof window.renderLightweightChart === 'function') ? window.renderLightweightChart : null;

      if (loadLwc) await loadLwc();
      if (renderLwc) {
        await renderLwc(chartId, data.candles, data.metrics || null, safeTicker, { variant: 'page' });
      } else {
        var errEl2 = byId(chartId + '_container');
        if (errEl2) errEl2.innerHTML = '<div class="flex items-center justify-center h-full text-gray-500 text-xs p-4 text-center">Modul visual chart sedang disiapkan...</div>';
      }
    } catch (e) {
      _loadingChart = false;
      var errBox = byId(chartId + '_container');
      if (errBox) errBox.innerHTML = '<div class="flex items-center justify-center h-full text-gray-500 text-xs p-4 text-center">Chart gagal dimuat. Silakan muat ulang.</div>';
    }
  }

  function syncActiveTicker(rawTicker, options) {
    options = options || {};
    var ticker = cleanTicker(rawTicker);
    if (!ticker) return;

    var previousTicker = cleanTicker(root.activeTicker);
    var tickerChanged = previousTicker && previousTicker !== ticker;
    root.activeTicker = ticker;

    // Switching ticker context (without an explicit new AI run) makes the
    // previous ticker's AI result stale — clear it instead of leaving a
    // mismatched result on screen under the new "Aktif" badge.
    if (tickerChanged && !options.runAnalysis) {
      var resultBox = byId('analisisResult');
      if (resultBox) {
        resultBox.innerHTML = '<div class="text-center py-12 text-gray-500">' +
          '<svg class="w-10 h-10 mx-auto mb-2 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>' +
          '<p class="text-sm font-semibold text-gray-300">Belum ada analisis untuk ' + ticker + '</p>' +
          '<p class="text-xs text-gray-500 mt-1 max-w-sm mx-auto">Klik tombol <strong>Analisis Saham</strong> untuk menjalankan analisis AI ticker ini.</p>' +
          '<button type="button" onclick="UnifiedCockpit.handleUnifiedAnalisisSubmit()" class="mt-3 px-4 py-2 rounded-xl bg-emerald-500 text-black font-semibold text-xs hover:bg-emerald-400 transition">Jalankan Analisis Sekarang</button>' +
          '</div>';
      }
    }

    // 1. Sync input elements
    var analisisInput = byId('analisisInput');
    if (analisisInput && analisisInput.value !== ticker) analisisInput.value = ticker;

    var chartInput = byId('chartTickerInput');
    if (chartInput && chartInput.value !== ticker) chartInput.value = ticker;

    // 2. Update badges & labels
    var badge = byId('unifiedActiveTickerBadge');
    if (badge) badge.textContent = ticker;

    var chatTag = byId('chatActiveTickerTag');
    if (chatTag) chatTag.textContent = ticker;

    var analisisTag = byId('analisisActiveTickerTag');
    if (analisisTag) analisisTag.textContent = ticker;

    var bandarTag = byId('bandarActiveTickerTag');
    if (bandarTag) bandarTag.textContent = ticker;

    // 2b. Sync independent tab search inputs if present
    ['bandarTickerSearchInput', 'akumulasiTickerSearchInput', 'bandarSummarySearchInput', 'rankingTickerSearchInput', 'patternTickerSearchInput'].forEach(function (id) {
      var inp = byId(id);
      if (inp && inp.value !== ticker) inp.value = ticker;
    });

    // 2c. Update URL query parameter seamlessly
    try {
      if (typeof window !== 'undefined' && window.location) {
        var currentUrl = new URL(window.location.href);
        if (currentUrl.searchParams.get('ticker') !== ticker) {
          currentUrl.searchParams.set('ticker', ticker);
          window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
        }
      }
    } catch (_) {}

    // 3. Make follow-up composer visible in cockpit
    var followUp = byId('analisisFollowUp');
    if (followUp && followUp.classList.contains('hidden')) {
      followUp.classList.remove('hidden');
    }

    // 4. Auto-load chart if changed or requested
    if (options.loadChart !== false && (_lastLoadedChartTicker !== ticker || options.forceChartReload)) {
      loadUnifiedChart(ticker);
    }

    // 4b. Keep the Bandarmologi & Insider tab in sync with the active ticker
    // too, mirroring the chart reload above — a ticker switch must not leave
    // that tab showing the previous ticker's data.
    var loadBandarFn = (typeof root.loadBandarmologiTab === 'function') ? root.loadBandarmologiTab :
                        (typeof window !== 'undefined' && typeof window.loadBandarmologiTab === 'function') ? window.loadBandarmologiTab : null;
    if (loadBandarFn && (_lastBandarSyncTicker !== ticker || options.forceChartReload)) {
      _lastBandarSyncTicker = ticker;
      loadBandarFn(ticker);
    }

    // 5. Trigger analysis if specified (unless preserveTab is explicitly requested)
    if (!options.preserveTab) {
      var runFn = (typeof root.runAnalisisFromDashboard === 'function') ? root.runAnalisisFromDashboard :
                  (typeof window !== 'undefined' && typeof window.runAnalisisFromDashboard === 'function') ? window.runAnalisisFromDashboard : null;
      var visionFn = (typeof root.triggerAiChartAnalysis === 'function') ? root.triggerAiChartAnalysis :
                     (typeof window !== 'undefined' && typeof window.triggerAiChartAnalysis === 'function') ? window.triggerAiChartAnalysis : null;

      if (options.runAnalysis && runFn) {
        if (typeof root.switchAnalisisTab === 'function') root.switchAnalisisTab('analisis');
        else switchAnalysisSubTab('text');
        runFn(ticker);
      } else if (options.runChartVision && visionFn) {
        if (typeof root.switchAnalisisTab === 'function') root.switchAnalisisTab('chart');
        else switchAnalysisSubTab('vision');
        visionFn(ticker);
      }
    }
  }

  // Ticker input Enter key: switch the active ticker context ONLY (badge,
  // chart, Bandarmologi tab, etc). Does NOT trigger an AI run — that stays
  // exclusive to the explicit "Analisis Saham" button (handleUnifiedAnalisisSubmit),
  // since AI runs consume quota/BYOK and must be a deliberate action.
  function handleTickerInputEnter() {
    var input = byId('analisisInput');
    var ticker = input ? cleanTicker(input.value) : '';
    if (!ticker) {
      if (typeof root.showToast === 'function') root.showToast('Ketik ticker terlebih dahulu (misal: BBCA, BBRI).', 'warning');
      else alert('Ketik ticker terlebih dahulu (misal: BBCA, BBRI).');
      return;
    }
    syncActiveTicker(ticker, { loadChart: true, forceChartReload: true });
  }

  function handleUnifiedAnalisisSubmit() {
    var input = byId('analisisInput');
    var ticker = input ? cleanTicker(input.value) : '';
    if (!ticker) {
      ticker = getActiveTicker();
    }
    if (!ticker) {
      if (typeof root.showToast === 'function') root.showToast('Ketik ticker terlebih dahulu (misal: BBCA, BBRI).', 'warning');
      else alert('Ketik ticker terlebih dahulu (misal: BBCA, BBRI).');
      return;
    }
    if (typeof root.switchAnalisisTab === 'function') {
      root.switchAnalisisTab('analisis');
    }
    syncActiveTicker(ticker, { runAnalysis: true, loadChart: true });
  }

  function handleUnifiedChartAiSubmit() {
    var input = byId('analisisInput');
    var ticker = input ? cleanTicker(input.value) : '';
    if (!ticker) {
      ticker = getActiveTicker();
    }
    if (!ticker) {
      if (typeof root.showToast === 'function') root.showToast('Ketik ticker terlebih dahulu (misal: BBCA, BBRI).', 'warning');
      else alert('Ketik ticker terlebih dahulu (misal: BBCA, BBRI).');
      return;
    }
    if (typeof root.switchAnalisisTab === 'function') {
      root.switchAnalisisTab('chart');
    }
    syncActiveTicker(ticker, { runChartVision: true, loadChart: true });
  }

  function sendQuickPrompt(promptText) {
    var input = byId('analysisChatInput');
    if (!input) return;
    input.value = promptText;
    try { input.focus(); } catch (_) {}
    if (typeof root.handleSend === 'function') {
      root.handleSend();
    }
  }

  function clearAnalysisChatHistory() {
    var msgContainer = byId('unifiedChatMessages') || byId('analisisResult');
    if (msgContainer) {
      var followUps = msgContainer.querySelectorAll('.stock-ai-followup');
      followUps.forEach(function (el) { el.remove(); });
    }
    var ticker = getActiveTicker();
    var uid = String(localStorage.getItem('autocuan_user_id') || localStorage.getItem('autocuan_user') || 'guest');
    var key = 'autocuan_stock_ai_history_' + uid + '_' + ticker;
    try { localStorage.removeItem(key); } catch (_) {}
    if (typeof root.showToast === 'function') root.showToast('Riwayat chat ' + ticker + ' berhasil dibersihkan.', 'good');
  }

  function openFullscreen() {
    var data = root._chartPageData || (typeof window !== 'undefined' && window._chartPageData);
    if (typeof root.openChartPageFullscreen === 'function') {
      root.openChartPageFullscreen();
      return;
    }
    if (!data || !Array.isArray(data.candles) || !data.candles.length) {
      if (typeof root.showToast === 'function') root.showToast('Muat chart terlebih dahulu sebelum membuka layar penuh.', 'warning');
      return;
    }
    var viewer = (typeof root.openChartViewer === 'function') ? root.openChartViewer :
                 (typeof window !== 'undefined' && typeof window.openChartViewer === 'function') ? window.openChartViewer :
                 (root.AutoCuanChartViewer && typeof root.AutoCuanChartViewer.open === 'function') ? function(cfg) { return root.AutoCuanChartViewer.open(root, cfg); } : null;
    if (!viewer) {
      if (typeof root.showToast === 'function') root.showToast('Tampilan layar penuh sedang disiapkan. Coba lagi sesaat lagi.', 'warning');
      return;
    }
    viewer({
      title: 'Chart ' + (data.ticker || getActiveTicker() || ''),
      subtitle: 'Data historis T-1' + (data.actual_data_date ? ' · ' + data.actual_data_date : ''),
      ticker: data.ticker || getActiveTicker() || '',
      candles: data.candles,
      metrics: data.metrics || null
    });
  }

  // Export API
  root.UnifiedCockpit = {
    getActiveTicker: getActiveTicker,
    syncActiveTicker: syncActiveTicker,
    switchAnalysisSubTab: switchAnalysisSubTab,
    loadUnifiedChart: loadUnifiedChart,
    handleUnifiedAnalisisSubmit: handleUnifiedAnalisisSubmit,
    handleTickerInputEnter: handleTickerInputEnter,
    handleUnifiedChartAiSubmit: handleUnifiedChartAiSubmit,
    sendQuickPrompt: sendQuickPrompt,
    clearAnalysisChatHistory: clearAnalysisChatHistory,
    openFullscreen: openFullscreen,
    handleIndependentTabSearch: function (tab, ticker) {
      if (typeof root.handleIndependentTabSearch === 'function') {
        return root.handleIndependentTabSearch(tab, ticker);
      }
    }
  };

  // Wire events on DOM ready
  function initCockpit() {
    var input = byId('analisisInput');
    if (input && typeof input.addEventListener === 'function') {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleUnifiedAnalisisSubmit();
        }
      });
    }

    // Auto-sync initial ticker if present
    var current = getActiveTicker();
    if (current && byId('page-analisis') && !byId('page-analisis').classList.contains('hidden')) {
      loadUnifiedChart(current);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCockpit);
  } else {
    initCockpit();
  }
})(typeof window !== 'undefined' ? window : globalThis);
