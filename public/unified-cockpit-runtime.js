// Auto-Cuan Unified AI Cockpit Runtime (PR 2: Tata Letak Terpadu & Auto-Sync Ticker)
(function (root) {
  'use strict';

  var _activeSubTab = 'text'; // 'text' | 'vision'
  var _lastLoadedChartTicker = '';
  var _lastBandarSyncTicker = '';
  var _loadingChart = false;

  function byId(id) { return document.getElementById(id); }

  var POPULAR_NAMES = {
    'BBCA': 'Bank Central Asia Tbk.',
    'BBRI': 'Bank Rakyat Indonesia (Persero) Tbk.',
    'BMRI': 'Bank Mandiri (Persero) Tbk.',
    'BBNI': 'Bank Negara Indonesia (Persero) Tbk.',
    'TLKM': 'Telkom Indonesia (Persero) Tbk.',
    'ASII': 'Astra International Tbk.',
    'UNVR': 'Unilever Indonesia Tbk.',
    'ICBP': 'Indofood CBP Sukses Makmur Tbk.',
    'INDF': 'Indofood Sukses Makmur Tbk.',
    'AMMN': 'Amman Mineral Internasional Tbk.',
    'BREN': 'Barito Renewables Energy Tbk.',
    'BRPT': 'Barito Pacific Tbk.',
    'TPIA': 'Chandra Asri Pacific Tbk.',
    'PGAS': 'Perusahaan Gas Negara Tbk.',
    'PTBA': 'Bukit Asam Tbk.',
    'ADRO': 'Alamtri Resources Indonesia Tbk.',
    'ITMG': 'Indo Tambangraya Megah Tbk.',
    'MEDC': 'Medco Energi Internasional Tbk.',
    'ANTM': 'Aneka Tambang Tbk.',
    'INCO': 'Vale Indonesia Tbk.',
    'MDKA': 'Merdeka Copper Gold Tbk.',
    'GOTO': 'GoTo Gojek Tokopedia Tbk.',
    'KLBF': 'Kalbe Farma Tbk.',
    'CPIN': 'Charoen Pokphand Indonesia Tbk.',
    'IHSG': 'Indeks Harga Saham Gabungan'
  };

  var POPULAR_SECTORS = {
    'BBCA': 'Financials', 'BBRI': 'Financials', 'BMRI': 'Financials', 'BBNI': 'Financials', 'BBTN': 'Financials', 'BDMN': 'Financials', 'BRIS': 'Financials', 'ARTO': 'Financials',
    'TLKM': 'Infrastructure', 'ISAT': 'Infrastructure', 'EXCL': 'Infrastructure', 'TOWR': 'Infrastructure', 'TBIG': 'Infrastructure', 'JSMR': 'Infrastructure', 'PGAS': 'Infrastructure',
    'ASII': 'Industrials', 'UNTR': 'Industrials',
    'ADRO': 'Energy', 'PTBA': 'Energy', 'ITMG': 'Energy', 'MEDC': 'Energy', 'AKRA': 'Energy', 'ENRG': 'Energy',
    'ANTM': 'Basic Materials', 'INCO': 'Basic Materials', 'MDKA': 'Basic Materials', 'TPIA': 'Basic Materials', 'BRPT': 'Basic Materials', 'MBMA': 'Basic Materials', 'AMMN': 'Basic Materials', 'INKP': 'Basic Materials', 'TKIM': 'Basic Materials',
    'UNVR': 'Consumer Non-Cyclical', 'ICBP': 'Consumer Non-Cyclical', 'INDF': 'Consumer Non-Cyclical', 'MYOR': 'Consumer Non-Cyclical', 'CMRY': 'Consumer Non-Cyclical', 'HMSP': 'Consumer Non-Cyclical', 'GGRM': 'Consumer Non-Cyclical', 'CPIN': 'Consumer Non-Cyclical', 'JPFA': 'Consumer Non-Cyclical',
    'ACES': 'Consumer Cyclical', 'MAPI': 'Consumer Cyclical', 'MAPA': 'Consumer Cyclical', 'ERAA': 'Consumer Cyclical', 'AUTO': 'Consumer Cyclical',
    'KLBF': 'Healthcare', 'MIKA': 'Healthcare', 'HEAL': 'Healthcare', 'SILO': 'Healthcare', 'SIDO': 'Healthcare',
    'GOTO': 'Technology', 'BUKA': 'Technology', 'EMTK': 'Technology', 'WIRG': 'Technology',
    'CTRA': 'Properties', 'BSDE': 'Properties', 'PWON': 'Properties', 'SMRA': 'Properties', 'ASRI': 'Properties',
    'BIRD': 'Transportation', 'SMDR': 'Transportation', 'ASSA': 'Transportation',
    'BREN': 'Energy',
    'IHSG': 'Index'
  };

  function getCompanyName(ticker) {
    if (!ticker) return '';
    if (typeof window !== 'undefined' && window.IDX_TICKERS && window.IDX_TICKERS[ticker]) {
      return window.IDX_TICKERS[ticker];
    }
    if (POPULAR_NAMES[ticker]) return POPULAR_NAMES[ticker];
    return ticker + ' · IDX';
  }

  function getCompanySector(ticker) {
    if (!ticker) return '';
    if (POPULAR_SECTORS[ticker]) return POPULAR_SECTORS[ticker];
    return ticker === 'IHSG' ? 'Market Index' : 'IDX Equities';
  }

  function cleanTicker(val) {
    return String(val || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Returns the ticker the Analisis workspace is currently focused on, or ''
  // when the user has not chosen one. It deliberately has no BBCA fallback: an
  // invented default would be written into the URL and would fire per-emiten
  // requests on pages that never asked for a stock (the Dashboard 504 path).
  function getActiveTicker() {
    var fromWindow = cleanTicker(root.activeTicker);
    var fromInput = byId('analisisInput') ? cleanTicker(byId('analisisInput').value) : '';
    var fromChartInput = byId('chartTickerInput') ? cleanTicker(byId('chartTickerInput').value) : '';
    return fromWindow || fromInput || fromChartInput || '';
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

  async function loadUnifiedChart(ticker, options) {
    options = options || {};
    var safeTicker = cleanTicker(ticker);
    if (!safeTicker) return;

    var container = byId('unifiedChartContainer');
    if (!container) return;

    _lastLoadedChartTicker = safeTicker;
    _loadingChart = true;

    root.activeTicker = safeTicker;
    var inp = byId('analisisInput');
    if (inp && inp.value !== safeTicker) inp.value = safeTicker;
    var badge = byId('unifiedActiveTickerBadge');
    if (badge) badge.textContent = safeTicker;
    var sym = byId('unifiedActiveTickerSymbol');
    if (sym) sym.textContent = safeTicker;
    var compNameEl = byId('unifiedActiveCompanyName');
    if (compNameEl) compNameEl.textContent = getCompanyName(safeTicker);
    var compSectorEl = byId('unifiedActiveCompanySector');
    if (compSectorEl) compSectorEl.textContent = getCompanySector(safeTicker);

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
      '<div class="flex items-center gap-1.5 flex-wrap">' +
      '<button id="' + chartId + '_ai" onclick="UnifiedCockpit.handleUnifiedChartAiSubmit()" class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-blue-300 border border-blue-500/30 hover:bg-blue-500/10 transition" aria-label="Analisis chart ' + safeTicker + ' dengan AI">🤖 Analisis AI</button>' +
      '<button id="' + chartId + '_fs" onclick="UnifiedCockpit.openFullscreen()" class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-sky-300 border border-sky-500/30 hover:bg-sky-500/10 transition" aria-label="Buka chart ' + safeTicker + ' layar penuh">' + _fsIcon + 'Layar Penuh</button>' +
      '<button id="' + chartId + '_dl" onclick="downloadChartPng(\'' + chartId + '\',\'' + safeTicker + '\',this)" class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/10 transition" aria-label="Download chart ' + safeTicker + ' sebagai PNG">' + _dlIcon + 'Download PNG</button>' +
      '</div>' +
      '</div>' +
      '<div id="' + chartId + '_container" style="height:' + _pd.main + 'px;width:100%"><div class="h-full p-4 space-y-3"><div class="skeleton-card h-full flex flex-col justify-end gap-3"><div class="skeleton-line w-2/3"></div><div class="skeleton-line w-full"></div><div class="skeleton-line w-5/6"></div><p class="text-xs text-gray-500 pt-2"><span class="spinner-sm"></span>Memuat candlestick ' + safeTicker + '...</p></div></div></div>' +
      '<div id="' + chartId + '_rsi" class="border-t border-dark-600/20" style="display:none;height:' + _pd.rsi + 'px;width:100%"></div>' +
      '<div id="' + chartId + '_metrics" class="px-3 py-2 border-t border-dark-600/20 grid grid-cols-4 sm:grid-cols-8 gap-1 text-[10px]" style="display:none"></div>' +
      '<div class="unified-chart-legend" style="display:none"><span class="text-emerald-400 font-semibold">MA20</span><span class="text-yellow-400 font-semibold">MA50</span><span class="text-blue-400 font-semibold">MA100</span><span class="text-purple-400 font-semibold">MA200</span><span class="text-orange-400 font-semibold">RSI14</span><span class="text-amber-400/80 font-semibold">Fibonacci</span></div>';

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
      if (data && data.candles && data.candles.length > 0) {
        var lastC = data.candles[data.candles.length - 1];
        var prevC = data.candles.length > 1 ? data.candles[data.candles.length - 2] : null;
        var quoteEl = byId('unifiedActiveTickerQuote');
        if (quoteEl) {
          var closePrice = (lastC && lastC.close != null && lastC.close !== '') ? Number(lastC.close) : null;
          if (closePrice != null && Number.isFinite(closePrice) && closePrice > 0) {
            var prevClose = (prevC && prevC.close != null && Number.isFinite(Number(prevC.close)) && Number(prevC.close) > 0) ? Number(prevC.close) : closePrice;
            var diff = closePrice - prevClose;
            var pct = prevClose > 0 ? (diff / prevClose) * 100 : 0;
            // Canvas header: last price without "Rp", then change and percent
            // (Indonesian decimals, U+2212 minus) coloured by direction.
            var sign = diff > 0 ? '+' : (diff < 0 ? '\u2212' : '');
            quoteEl.className = 'ana-quote num mono ' + (diff > 0 ? 'is-up' : (diff < 0 ? 'is-down' : 'is-flat'));
            quoteEl.innerHTML = '<span class="ana-px">' + closePrice.toLocaleString('id-ID') + '</span><span class="ana-chg">' + sign + Math.abs(diff).toLocaleString('id-ID') + ' (' + sign + Math.abs(pct).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%)</span>';
          } else {
            quoteEl.className = 'ana-quote num mono is-flat';
            quoteEl.textContent = 'Harga belum tersedia';
          }
        }
        var activeBadge = byId('unifiedActiveTickerBadge');
        if (activeBadge) activeBadge.textContent = safeTicker;
        var activeSym = byId('unifiedActiveTickerSymbol');
        if (activeSym) activeSym.textContent = safeTicker;
      }

      var loadLwc = (typeof root.loadLightweightCharts === 'function') ? root.loadLightweightCharts :
                    (typeof window !== 'undefined' && typeof window.loadLightweightCharts === 'function') ? window.loadLightweightCharts : null;
      var renderLwc = (typeof root.renderLightweightChart === 'function') ? root.renderLightweightChart :
                      (typeof window !== 'undefined' && typeof window.renderLightweightChart === 'function') ? window.renderLightweightChart : null;

      if (loadLwc) await loadLwc();
      if (renderLwc) {
        await renderLwc(chartId, data.candles, data.metrics || null, safeTicker, { variant: 'page' });
        if (options && options.preset && root.AutoCuanChartWorkstation && typeof root.AutoCuanChartWorkstation.applyPreset === 'function') {
          root.AutoCuanChartWorkstation.applyPreset(chartId, options.preset);
        }
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
    if (tickerChanged && root.AutoCuanLifecycleGuard && typeof root.AutoCuanLifecycleGuard.onTickerSwitch === 'function') {
      root.AutoCuanLifecycleGuard.onTickerSwitch(ticker);
    }

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

    // 1. Sync input elements across all primary analysis surfaces silently without feedback loops
    var primaryInputs = ['analisisInput', 'chartTickerInput', 'newsTickerInput', 'financialTickerInput', 'marketStructureTickerInput'];
    primaryInputs.forEach(function(id) {
      var inp = byId(id);
      if (inp && inp.value !== ticker) {
        inp.value = ticker;
      }
    });

    // Sync badges across views
    var finBadge = byId('financialTickerBadge');
    if (finBadge) finBadge.textContent = ticker;
    var msBadge = byId('marketStructureTickerBadge');
    if (msBadge) msBadge.textContent = ticker;

    // URL ticker synchronization (FINAL-RISK-005) - replaceState only, no pushState loop.
    // A ticker belongs in the address bar only while the Analisis workspace is the
    // active page. On Dashboard and every other route the parameter is removed so
    // the URL cannot leak a stock symbol (and with it, per-emiten fetches) into a
    // page that is supposed to load macro data only.
    if (!options.skipUrlSync && typeof window !== 'undefined' && window.location && window.history && window.history.replaceState) {
      try {
        var url = new URL(window.location.href);
        var onAnalisisPage = document.getElementById('page-analisis') &&
          !document.getElementById('page-analisis').classList.contains('hidden');
        if (onAnalisisPage) {
          if (url.searchParams.get('ticker') !== ticker) {
            url.searchParams.set('ticker', ticker);
            window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
          }
        } else if (url.searchParams.has('ticker')) {
          url.searchParams.delete('ticker');
          window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
        }
      } catch (_) {}
    }

    // 2. Update badges & labels
    var badge = byId('unifiedActiveTickerBadge');
    if (badge) badge.textContent = ticker;
    var sym = byId('unifiedActiveTickerSymbol');
    if (sym) sym.textContent = ticker;

    var compNameEl = byId('unifiedActiveCompanyName');
    if (compNameEl) {
      compNameEl.textContent = getCompanyName(ticker);
    }
    var compSectorEl = byId('unifiedActiveCompanySector');
    if (compSectorEl) {
      compSectorEl.textContent = getCompanySector(ticker);
    }
    var quoteEl = byId('unifiedActiveTickerQuote');
    if (quoteEl) {
      quoteEl.textContent = '';
      if (!options.loadChart) {
        fetch('/api/quote?action=financial-snapshot&ticker=' + encodeURIComponent(ticker), {
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'XMLHttpRequest' }
        })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var activeBadge = byId('unifiedActiveTickerBadge');
            if (activeBadge && activeBadge.textContent !== ticker) return;
            var rawLast = (data && data.success && data.snapshot && data.snapshot.price) ? data.snapshot.price.last : null;
            if (rawLast != null && rawLast !== '' && Number.isFinite(Number(rawLast)) && Number(rawLast) > 0) {
              var p = Number(rawLast);
              // Price only: the snapshot carries no previous close, so no
              // change is shown (it used to print a made-up "(0.00%)").
              quoteEl.className = 'ana-quote num mono is-flat';
              quoteEl.innerHTML = '<span class="ana-px">' + p.toLocaleString('id-ID') + '</span>';
            } else {
              quoteEl.className = 'ana-quote num mono is-flat';
              quoteEl.textContent = 'Harga belum tersedia';
            }
          })
          .catch(function() {
            quoteEl.className = 'ana-quote num mono is-flat';
            quoteEl.textContent = 'Harga belum tersedia';
          });
      }
    }

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

    // 2c. Second URL pass kept for legacy callers; it follows the same rule as
    // above so it can never re-introduce the parameter on a non-Analisis page.
    try {
      if (typeof window !== 'undefined' && window.location) {
        var currentUrl = new URL(window.location.href);
        var onAnalisisForUrl = document.getElementById('page-analisis') &&
          !document.getElementById('page-analisis').classList.contains('hidden');
        if (onAnalisisForUrl) {
          if (currentUrl.searchParams.get('ticker') !== ticker) {
            currentUrl.searchParams.set('ticker', ticker);
            window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
          }
        } else if (currentUrl.searchParams.has('ticker')) {
          currentUrl.searchParams.delete('ticker');
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

    // 4c. Keep financial and intel in sync if currently viewing those tabs
    var currentSubtab = root.__ACTIVE_ANALISIS_SUBTAB__;
    if (!options.preserveTab && !options.skipFinancialSync && currentSubtab === 'financial' && typeof root.loadFinancialStructureTab === 'function') {
      root.loadFinancialStructureTab('financial', ticker);
    } else if (currentSubtab === 'intel' && root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadBandarmologiIntel === 'function') {
      var intelContainer = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
      if (intelContainer) {
        root.BandarmologiRuntime.loadBandarmologiIntel(ticker, intelContainer);
      }
    }

    // 4d. Keep market structure tab and detail pane in sync with active ticker
    var marketStructureCtrl = root.AutoCuanMarketStructure || (typeof window !== 'undefined' ? window.AutoCuanMarketStructure : null);
    if (marketStructureCtrl && typeof marketStructureCtrl.selectRow === 'function' && marketStructureCtrl.selectedTicker !== ticker) {
      marketStructureCtrl.selectRow(ticker, false);
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

    // The URL ticker is only honoured when the Analisis workspace is the page
    // that is actually open. On /dashboard?ticker=BBCA (a legacy link) the
    // parameter is ignored here and the router strips it, so the Dashboard
    // never adopts a stock context it was not asked to show.
    var analisisPage = byId('page-analisis');
    var analisisVisible = analisisPage && !analisisPage.classList.contains('hidden');
    try {
      if (analisisVisible && typeof window !== 'undefined' && window.location) {
        var urlParams = new URLSearchParams(window.location.search);
        var urlTicker = cleanTicker(urlParams.get('ticker'));
        if (urlTicker) {
          root.activeTicker = urlTicker;
        }
      }
    } catch (_) {}
    // Auto-load the chart only for the Analisis workspace.
    var current = getActiveTicker();
    if (current && analisisVisible) {
      loadUnifiedChart(current);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCockpit);
  } else {
    initCockpit();
  }
})(typeof window !== 'undefined' ? window : globalThis);
