// Auto-Cuan Standalone Analisis Saham Runtime
(function (root) {
  'use strict';

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function htmlToCleanText(html) {
    var temp = document.createElement('div');
    temp.innerHTML = html;
    return (temp.textContent || temp.innerText || '').trim();
  }

  // Server prompts tell the model to output real HTML and never markdown
  // stars, but LLMs occasionally ignore that and leave literal **bold**
  // markers in otherwise-valid HTML. Converting any that slip through is a
  // no-op when the text is clean, so it's safe to always run.
  function convertStrayMarkdownBold(html) {
    return String(html || '').replace(/\*\*([^*<>\n]+)\*\*/g, '<strong>$1</strong>');
  }

  // ===== TOAST NOTIFICATIONS =====
  root.showToast = function (message, type) {
    var container = byId('toastContainer');
    if (!container) return;
    var toast = document.createElement('div');
    var bgClass = type === 'danger' ? 'bg-rose-500/90 text-white' :
                  type === 'warning' ? 'bg-amber-500/90 text-black font-medium' :
                  type === 'good' ? 'bg-emerald-500/90 text-black font-semibold' :
                  'bg-dark-700/95 text-gray-100 border border-dark-600/40';
    toast.className = 'px-4 py-2.5 rounded-xl shadow-lg text-xs flex items-center gap-2 transition-all duration-300 pointer-events-auto ' + bgClass;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
      setTimeout(function () { toast.remove(); }, 320);
    }, 3200);
  };

  // ===== FORMATTERS =====
  root.mktCtxFmtPrice = function (v) {
    if (!Number.isFinite(v)) return '—';
    return 'Rp ' + Math.round(v).toLocaleString('id-ID');
  };
  root.mktCtxFmtPct = function (v) {
    if (!Number.isFinite(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  };
  root.mktCtxFmtRatio = function (v) {
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(2) + 'x';
  };
  root.mktCtxFmtIDR = function (v) {
    if (!Number.isFinite(v)) return '—';
    var abs = Math.abs(v);
    var sign = v >= 0 ? '+' : '-';
    if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + ' T';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + ' M';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + ' jt';
    return sign + Math.round(abs).toLocaleString('id-ID');
  };

  // ===== RANKING TABLE STATE & LOGIC =====
  // Same column set as configureRankingColumns() in stock-analysis-ai.js (the
  // dedicated "Ranking" menu page) so the Ranking Harian tab shows the
  // identical, fuller table instead of a second, simpler one.
  var RANKING_COLUMNS = [
    { key: 'ticker', label: 'Ticker', align: 'left', sortable: true },
    { key: 'last_price', label: 'Harga', align: 'right', fmt: root.mktCtxFmtPrice },
    { key: 'rsi_14', label: 'RSI 14', align: 'right', fmt: function(v) { return Number(v).toFixed(1); } },
    { key: 'week52_high_dist_pct', label: 'Jarak 52W High', align: 'right', fmt: root.mktCtxFmtPct },
    { key: 'volume_ratio_vs_7d_avg', label: 'Vol vs 7D', align: 'right', fmt: root.mktCtxFmtRatio },
    { key: 'foreign_net_today', label: 'Foreign Terakhir', align: 'right', fmt: root.mktCtxFmtIDR, colorize: true },
    { key: 'foreign_net_3d', label: 'Foreign 3D', align: 'right', fmt: root.mktCtxFmtIDR, colorize: true },
    { key: 'foreign_net_7d', label: 'Foreign 7D', align: 'right', fmt: root.mktCtxFmtIDR, colorize: true }
  ];
  root.RANKING_COLUMNS = RANKING_COLUMNS;

  var rankingState = {
    rows: [],
    loading: false,
    loaded: false,
    error: null,
    searchQuery: '',
    sortKey: 'week52_high_dist_pct',
    sortDirection: 'desc',
    selectedTicker: null
  };
  root.rankingState = rankingState;

  function rankingCellHtml(row, col) {
    if (col.key === 'ticker') {
      var isSelected = rankingState.selectedTicker && row.ticker === rankingState.selectedTicker;
      return '<span class="font-semibold text-gray-200">' + escapeHtml(row.ticker) + '</span>' +
        (isSelected ? ' <span class="text-emerald-400" title="Sedang dipilih">&bull;</span>' : '');
    }
    var raw = row[col.key];
    if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) {
      return '<span class="text-gray-600">N/A</span>';
    }
    var num = Number(raw);
    var text = col.fmt(num);
    if (col.colorize) {
      var colorClass = num > 0 ? 'text-emerald-400' : (num < 0 ? 'text-rose-400' : 'text-gray-300');
      return '<span class="' + colorClass + '">' + text + '</span>';
    }
    if (col.key === 'week52_high_dist_pct') {
      if (num >= -3.0 && num <= 0.5) {
        return '<span class="text-emerald-300 font-semibold px-1.5 py-0.5 rounded text-[11px] bg-emerald-500/15 border border-emerald-500/30">' + text + ' 🔥</span>';
      }
    }
    if (col.key === 'rsi_14') {
      if (num <= 30) {
        return '<span class="text-blue-300 font-semibold px-1.5 py-0.5 rounded text-[11px] bg-blue-500/15 border border-blue-500/30">' + text + ' OS</span>';
      } else if (num >= 70) {
        return '<span class="text-amber-300 font-semibold px-1.5 py-0.5 rounded text-[11px] bg-amber-500/15 border border-amber-500/30">' + text + ' OB</span>';
      }
    }
    return '<span class="text-gray-300">' + text + '</span>';
  }

  function renderRankingTable() {
    var wrap = byId('rankingTableWrap');
    if (!wrap) return;

    if (rankingState.loading && !rankingState.rows.length) {
      wrap.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs"><span class="spinner-sm"></span> Memuat ranking harian...</div>';
      return;
    }
    if (rankingState.error && !rankingState.rows.length) {
      wrap.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs">' + escapeHtml(rankingState.error) + '</div>';
      return;
    }
    if (!rankingState.rows.length) {
      wrap.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs">Ranking harian belum tersedia.</div>';
      return;
    }

    var query = (rankingState.searchQuery || '').trim().toUpperCase();
    var filtered = query ? rankingState.rows.filter(function (r) { return String(r.ticker || '').indexOf(query) !== -1; }) : rankingState.rows.slice();

    var key = rankingState.sortKey;
    var dir = rankingState.sortDirection === 'asc' ? 1 : -1;
    filtered.sort(function (a, b) {
      if (key === 'ticker') return dir * String(a.ticker || '').localeCompare(String(b.ticker || ''));
      var av = a[key], bv = b[key];
      var aNull = av === null || av === undefined || !Number.isFinite(Number(av));
      var bNull = bv === null || bv === undefined || !Number.isFinite(Number(bv));
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      return dir * (Number(av) - Number(bv));
    });

    if (!filtered.length) {
      wrap.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs">Tidak ada ticker yang cocok dengan pencarian.</div>';
      return;
    }

    var html = '<table class="w-full text-xs border-collapse">';
    html += '<thead class="sticky top-0 z-10 bg-dark-800/95 backdrop-blur"><tr class="border-b border-dark-600/30">';
    RANKING_COLUMNS.forEach(function (col) {
      var active = rankingState.sortKey === col.key;
      var arrow = active ? (rankingState.sortDirection === 'asc' ? '&#9650;' : '&#9660;') : '';
      html += '<th class="px-3 py-2 text-' + col.align + ' font-medium select-none cursor-pointer whitespace-nowrap transition ' +
        (active ? 'text-emerald-400 bg-emerald-500/5' : 'text-gray-500 hover:text-gray-300') + '" ' +
        'onclick="setRankingSort(\'' + col.key + '\')" title="Urutkan berdasarkan ' + col.label + '">' +
        '<span class="inline-flex items-center gap-1' + (col.align === 'right' ? ' flex-row-reverse' : '') + '">' +
        col.label + (arrow ? '<span class="text-[9px]">' + arrow + '</span>' : '') + '</span></th>';
    });
    html += '</tr></thead><tbody>';

    filtered.forEach(function (row) {
      var isSelected = rankingState.selectedTicker && row.ticker === rankingState.selectedTicker;
      html += '<tr class="border-b border-dark-600/10 hover:bg-dark-600/20 transition cursor-pointer ' +
        (isSelected ? 'bg-emerald-500/10' : '') + '" onclick="quickAnalisis(\'' + escapeHtml(row.ticker) + '\')" title="Analisis ' + escapeHtml(row.ticker) + '">';
      RANKING_COLUMNS.forEach(function (col) {
        html += '<td class="px-3 py-1.5 text-' + col.align + ' whitespace-nowrap">' + rankingCellHtml(row, col) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }
  root.renderRankingTable = renderRankingTable;

  root.onRankingSearchInput = function (value) {
    rankingState.searchQuery = value;
    renderRankingTable();
  };

  root.setRankingSort = function (key) {
    if (rankingState.sortKey === key) {
      rankingState.sortDirection = rankingState.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      rankingState.sortKey = key;
      rankingState.sortDirection = key === 'ticker' ? 'asc' : 'desc';
    }
    renderRankingTable();
  };

  // ===== SUB-TAB SWITCHER (POLA CONSOLIDATED TAB) =====
  var currentAnalisisSubTab = 'ai'; // 'ai' or 'chart'

  function switchAnalisisSubTab(subTab) {
    currentAnalisisSubTab = (subTab === 'chart') ? 'chart' : 'ai';
    var isChart = currentAnalisisSubTab === 'chart';

    var btnAI = byId('tabAnalisisText');
    var btnChart = byId('tabAnalisisVision');
    if (btnAI) {
      if (btnAI.classList && btnAI.classList.toggle) btnAI.classList.toggle('active', !isChart);
      if (typeof btnAI.setAttribute === 'function') btnAI.setAttribute('aria-selected', !isChart ? 'true' : 'false');
    }
    if (btnChart) {
      if (btnChart.classList && btnChart.classList.toggle) btnChart.classList.toggle('active', isChart);
      if (typeof btnChart.setAttribute === 'function') btnChart.setAttribute('aria-selected', isChart ? 'true' : 'false');
    }

    var pAnalisis = byId('panel-tab-analisis');
    var pChart = byId('panel-tab-chart');

    if (pAnalisis) pAnalisis.style.display = isChart ? 'none' : 'block';
    if (pChart) pChart.style.display = isChart ? 'block' : 'none';

    if (isChart) {
      var ticker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
        ? root.UnifiedCockpit.getActiveTicker() : (root.activeTicker || 'BBCA');
      if (root.UnifiedCockpit && typeof root.UnifiedCockpit.loadUnifiedChart === 'function') {
        root.UnifiedCockpit.loadUnifiedChart(ticker);
      }
      if (typeof setTimeout === 'function') {
        setTimeout(function () {
          try { window.dispatchEvent(new Event('resize')); } catch (_) {}
        }, 50);
      }
    }
  }
  root.switchAnalisisSubTab = switchAnalisisSubTab;

  function switchAnalisisTab(tabName) {
    var parentTab = tabName;
    if (tabName === 'analisis' || tabName === 'chart') {
      parentTab = 'analisis-chart';
    } else if (tabName === 'akumulasi') {
      parentTab = 'bandarmologi';
    } else if (tabName === 'intel' || tabName === 'bandarmologi-intel' || tabName === 'sinyal-intelijen') {
      parentTab = 'intel';
    } else if (tabName === 'insider' || tabName === 'network') {
      parentTab = 'insider';
    }

    var validParentTabs = ['analisis-chart', 'bandarmologi', 'intel', 'hunter', 'insider', 'ranking', 'pattern'];
    if (validParentTabs.indexOf(parentTab) < 0) parentTab = 'analisis-chart';

    if (typeof document !== 'undefined' && document.querySelectorAll) {
      document.querySelectorAll('.analisis-tab').forEach(function (btn) {
        var btnTab = btn.dataset ? btn.dataset.tab : (btn.getAttribute ? btn.getAttribute('data-tab') : null);
        var isActive = btnTab === parentTab || (parentTab === 'analisis-chart' && (btnTab === 'analisis-chart' || btnTab === 'analisis'));
        if (btn.classList && btn.classList.toggle) btn.classList.toggle('active', isActive);
        if (btn.setAttribute) btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }

    var pHeader = byId('analisisChartHeader');
    var pAnalisis = byId('panel-tab-analisis');
    var pChart = byId('panel-tab-chart');
    var pBandarmologi = byId('panel-tab-bandarmologi');
    var pIntel = byId('panel-tab-intel');
    var pHunter = byId('panel-tab-hunter');
    var pInsider = byId('panel-tab-insider');
    var pRanking = byId('panel-tab-ranking');
    var pPattern = byId('panel-tab-pattern');

    if (parentTab === 'analisis-chart') {
      if (pHeader) pHeader.style.display = 'block';
      if (pBandarmologi) pBandarmologi.style.display = 'none';
      if (pIntel) pIntel.style.display = 'none';
      if (pHunter) pHunter.style.display = 'none';
      if (pInsider) pInsider.style.display = 'none';
      if (pRanking) pRanking.style.display = 'none';
      if (pPattern) pPattern.style.display = 'none';

      if (tabName === 'chart') {
        if (pAnalisis) pAnalisis.style.display = 'none';
        if (pChart) pChart.style.display = 'block';
        switchAnalisisSubTab('chart');
      } else if (tabName === 'analisis') {
        if (pAnalisis) pAnalisis.style.display = 'block';
        if (pChart) pChart.style.display = 'none';
        switchAnalisisSubTab('ai');
      } else {
        if (currentAnalisisSubTab === 'chart') {
          if (pAnalisis) pAnalisis.style.display = 'none';
          if (pChart) pChart.style.display = 'block';
          switchAnalisisSubTab('chart');
        } else {
          if (pAnalisis) pAnalisis.style.display = 'block';
          if (pChart) pChart.style.display = 'none';
          switchAnalisisSubTab('ai');
        }
      }
    } else {
      if (pHeader) pHeader.style.display = 'none';
      if (pAnalisis) pAnalisis.style.display = 'none';
      if (pChart) pChart.style.display = 'none';
      if (pBandarmologi) pBandarmologi.style.display = (parentTab === 'bandarmologi' ? 'block' : 'none');
      if (pIntel) pIntel.style.display = (parentTab === 'intel' ? 'block' : 'none');
      if (pHunter) pHunter.style.display = (parentTab === 'hunter' ? 'block' : 'none');
      if (pInsider) pInsider.style.display = (parentTab === 'insider' ? 'block' : 'none');
      if (pRanking) pRanking.style.display = (parentTab === 'ranking' ? 'block' : 'none');
      if (pPattern) pPattern.style.display = (parentTab === 'pattern' ? 'block' : 'none');
    }

    // Sync tab param in URL
    try {
      if (typeof window !== 'undefined' && window.location) {
        var currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('tab', tabName);
        window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
      }
    } catch (_) {}

    if (parentTab === 'analisis-chart') {
      if (tabName === 'chart') {
        switchAnalisisSubTab('chart');
      } else if (tabName === 'analisis') {
        switchAnalisisSubTab('ai');
      } else {
        switchAnalisisSubTab(currentAnalisisSubTab);
      }
    } else if (parentTab === 'ranking') {
      root.ensureRankingTableLoaded();
    } else if (parentTab === 'bandarmologi') {
      var currentSection = (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.getBandarSection === 'function')
        ? root.BandarmologiRuntime.getBandarSection() : 'summary';
      var bandarSection = (tabName === 'akumulasi' || currentSection === 'akumulasi') ? 'akumulasi' : 'summary';
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.setBandarSection === 'function') {
        root.BandarmologiRuntime.setBandarSection(bandarSection);
      }
      if (typeof root.loadBandarmologiTab === 'function') {
        var bandarTicker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
          ? root.UnifiedCockpit.getActiveTicker() : (root.activeTicker || 'BBCA');
        root.loadBandarmologiTab(bandarTicker);
      }
    } else if (parentTab === 'intel') {
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.setBandarSection === 'function') {
        root.BandarmologiRuntime.setBandarSection('intel');
      }
      var intelContainer = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
      var activeIntelTicker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
        ? root.UnifiedCockpit.getActiveTicker() : (root.activeTicker || 'BBCA');
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadBandarmologiIntel === 'function') {
        root.BandarmologiRuntime.loadBandarmologiIntel(activeIntelTicker, intelContainer);
      } else if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.renderBandarmologiIntelUI === 'function') {
        root.BandarmologiRuntime.renderBandarmologiIntelUI(intelContainer, activeIntelTicker);
      }
    } else if (parentTab === 'hunter') {
      var hunterContainer = byId('brokerHunterContent') || byId('bandarmologiContent');
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadBrokerHunter === 'function') {
        root.BandarmologiRuntime.loadBrokerHunter(hunterContainer);
      }
    } else if (parentTab === 'insider') {
      var insiderContainer = byId('insiderNetworkDedicatedContent') || byId('bandarmologiContent');
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadInsiderNetwork === 'function') {
        root.BandarmologiRuntime.loadInsiderNetwork(insiderContainer);
      }
    } else if (parentTab === 'pattern') {
      loadPatternRadarTab();
    }
  }
  root.switchAnalisisTab = switchAnalisisTab;

  function handleIndependentTabSearch(tabName, rawTicker) {
    var ticker = String(rawTicker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!ticker) return;

    root.activeTicker = ticker;

    // 1. Sync URL query parameter (?ticker=...&tab=...) seamlessly
    try {
      if (typeof window !== 'undefined' && window.location) {
        var currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('ticker', ticker);
        if (tabName) currentUrl.searchParams.set('tab', tabName);
        window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
      }
    } catch (_) {}

    // 2. Synchronize active ticker across cockpit (inputs & badges) without leaving current tab
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(ticker, {
        loadChart: true,
        forceChartReload: false,
        preserveTab: true,
        runAnalysis: false
      });
    } else {
      var inp = byId('analisisInput');
      if (inp && inp.value !== ticker) inp.value = ticker;
      var cInp = byId('chartTickerInput');
      if (cInp && cInp.value !== ticker) cInp.value = ticker;
      var badge = byId('unifiedActiveTickerBadge');
      if (badge) badge.textContent = ticker;
      var bandarTag = byId('bandarActiveTickerTag');
      if (bandarTag) bandarTag.textContent = ticker;
      var intelTag = byId('intelActiveTickerTag');
      if (intelTag) intelTag.textContent = ticker;
    }

    // 3. Update all independent search inputs
    ['bandarTickerSearchInput', 'intelSearchInput', 'akumulasiTickerSearchInput', 'bandarSummarySearchInput', 'rankingTickerSearchInput', 'patternTickerSearchInput'].forEach(function (id) {
      var el = byId(id);
      if (el && el.value !== ticker) el.value = ticker;
    });

    // 4. Reload data specific to the active tab without leaving the tab!
    if (tabName === 'bandarmologi') {
      var activeSec = (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.getBandarSection === 'function')
        ? root.BandarmologiRuntime.getBandarSection() : 'summary';
      var safeSec = (activeSec === 'akumulasi') ? 'akumulasi' : 'summary';
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.setBandarSection === 'function') {
        root.BandarmologiRuntime.setBandarSection(safeSec);
      }
      if (typeof root.loadBandarmologiTab === 'function') {
        root.loadBandarmologiTab(ticker);
      }
    } else if (tabName === 'akumulasi') {
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.setBandarSection === 'function') {
        root.BandarmologiRuntime.setBandarSection('akumulasi');
      }
      if (typeof root.loadBandarmologiTab === 'function') {
        root.loadBandarmologiTab(ticker);
      }
    } else if (tabName === 'intel' || tabName === 'bandarmologi-intel') {
      var intelContainer = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadBandarmologiIntel === 'function') {
        root.BandarmologiRuntime.loadBandarmologiIntel(ticker, intelContainer);
      } else if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.renderBandarmologiIntelUI === 'function') {
        root.BandarmologiRuntime.renderBandarmologiIntelUI(intelContainer, ticker);
      }
    } else if (tabName === 'ranking') {
      rankingState.selectedTicker = ticker;
      renderRankingTable();
    } else if (tabName === 'pattern') {
      if (root.filterPatternRadarTicker && typeof root.filterPatternRadarTicker === 'function') {
        root.filterPatternRadarTicker(ticker);
      } else if (root.PatternRadarRuntime && typeof root.PatternRadarRuntime.filterOrScanTicker === 'function') {
        root.PatternRadarRuntime.filterOrScanTicker(ticker);
      }
    }
  }
  root.handleIndependentTabSearch = handleIndependentTabSearch;

  var patternRadarTimer = null;

  function renderPatternRadarError(container, message) {
    var globalLoader = byId('patternRadarGlobalLoader');
    if (globalLoader) {
      globalLoader.style.display = 'none';
    }
    if (!container) return;
    container.innerHTML = '<div class="p-8 text-center text-gray-400 text-xs space-y-3">' +
      '<div class="text-rose-400 font-semibold text-sm">Gagal Menyiapkan Pattern Radar</div>' +
      '<p class="text-gray-400 max-w-md mx-auto leading-relaxed">' + (message || 'Permintaan waktu habis atau modul Pattern Radar belum siap.') + '</p>' +
      '<div class="pt-2">' +
      '<button type="button" onclick="loadPatternRadarTab(true)" class="px-4 py-2 rounded-xl bg-dark-700 hover:bg-dark-600 text-emerald-400 border border-emerald-500/30 text-xs font-semibold transition inline-flex items-center gap-1.5">' +
      '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>' +
      ' Coba Lagi</button>' +
      '</div></div>';
  }

  function loadPatternRadarTab(forceRetry) {
    var panel = byId('panel-tab-pattern');
    if (panel) {
      panel.style.display = 'block';
      panel.classList.remove('hidden');
    }
    var container = byId('patternSubTabContainer');
    if (!container) return;

    if (forceRetry) {
      container.innerHTML = '<div class="p-8 text-center text-gray-500 text-xs">' +
        '<span class="spinner-sm"></span> Menyiapkan Pattern Radar...</div>';
    }

    if (patternRadarTimer) {
      clearTimeout(patternRadarTimer);
      patternRadarTimer = null;
    }

    var start = Date.now();
    var timeoutMs = 12000;

    function pollMount() {
      try {
        if (typeof root.ensurePatternRadarMounted === 'function') {
          root.ensurePatternRadarMounted(container);
          var pNode = byId('page-pattern');
          if (pNode) {
            pNode.classList.remove('hidden');
            pNode.style.display = 'block';
          }
          return;
        }

        if (Date.now() - start >= timeoutMs) {
          renderPatternRadarError(container, 'Waktu memuat Pattern Radar habis (timeout). Layanan sedang lambat atau tidak merespons.');
          return;
        }

        patternRadarTimer = setTimeout(pollMount, 100);
      } catch (err) {
        renderPatternRadarError(container, 'Terjadi kesalahan saat memuat Pattern Radar: ' + (err && err.message ? err.message : 'Unknown error'));
      }
    }

    pollMount();
  }
  root.loadPatternRadarTab = loadPatternRadarTab;
  root.renderPatternRadarError = renderPatternRadarError;

  function checkPatternTabVisibility() {
    var tabPattern = byId('tabAnalisisPattern');
    if (!tabPattern) return;
    var user = '';
    try { user = (localStorage.getItem('autocuan_user') || '').toLowerCase().trim(); } catch (_) {}
    var isAdmin = false;
    try {
      isAdmin = localStorage.getItem('autocuan_is_admin') === 'true' ||
        Boolean(root.premiumAccessState && (root.premiumAccessState.isAdmin === true || root.premiumAccessState.accessLevel === 'admin'));
    } catch (_) {}
    var isBudi = user === 'budi' || isAdmin;
    if (isBudi) {
      tabPattern.classList.remove('hidden');
      tabPattern.style.display = 'inline-flex';
    } else {
      tabPattern.classList.add('hidden');
      tabPattern.style.display = 'none';
      var panelPattern = byId('panel-tab-pattern');
      if (panelPattern && panelPattern.style.display !== 'none') {
        switchAnalisisTab('analisis-chart');
      }
    }
  }
  root.checkPatternTabVisibility = checkPatternTabVisibility;

  // ===== SUBSCRIPTION & PAYWALL LOGIC =====
  function isSubscribedUser() {
    if (localStorage.getItem('autocuan_is_admin') === 'true') return true;
    if (window.premiumAccessState && typeof window.premiumAccessState === 'object') {
      var s = window.premiumAccessState;
      if (s.premium === true) return true;
      if (s.accessLevel === 'admin' || s.accessLevel === 'premium' || s.accessLevel === 'lifetime') return true;
    }
    return false;
  }
  root.isSubscribedUser = isSubscribedUser;

  function updateRankingPaywallUi() {
    var isSubscribed = isSubscribedUser();
    var paywallGate = byId('rankingPaywallGate');
    var contentWrap = byId('rankingContentWrap');
    var lockIcon = byId('rankingLockIcon');

    if (paywallGate) paywallGate.style.display = isSubscribed ? 'none' : 'block';
    if (contentWrap) contentWrap.style.display = isSubscribed ? 'block' : 'none';
    if (lockIcon) lockIcon.style.display = isSubscribed ? 'none' : 'inline-block';
  }
  root.updateRankingPaywallUi = updateRankingPaywallUi;

  async function verifySubscriptionStatus() {
    var storedUser = '';
    try { storedUser = (localStorage.getItem('autocuan_user') || '').trim(); } catch (_) {}
    if (isSubscribedUser() && storedUser && storedUser.toLowerCase() !== 'guest') {
      syncHeaderUsername();
      checkPatternTabVisibility();
      updateRankingPaywallUi();
      return true;
    }
    try {
      var resp = await fetch('/api/reset-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'account-profile' })
      });
      var data = await resp.json().catch(function () { return {}; });
      if (data && data.success && data.profile) {
        var p = data.profile;
        var sub = p.subscription || {};
        var ent = sub.entitlement || {};
        var isAdmin = p.is_admin === true;
        var isPrem = isAdmin || (p.is_approved === true && ent.premium === true);
        window.premiumAccessState = {
          state: 'ready',
          premium: isPrem,
          isAdmin: isAdmin,
          accessLevel: isAdmin ? 'admin' : (isPrem ? (ent.access_level || 'premium') : 'free')
        };
        try {
          if (p.username) localStorage.setItem('autocuan_user', p.username);
          localStorage.setItem('autocuan_is_admin', isAdmin ? 'true' : 'false');
        } catch (_) {}
        syncHeaderUsername();
        checkPatternTabVisibility();
        updateRankingPaywallUi();
        return isPrem;
      }
    } catch (_) {}
    syncHeaderUsername();
    checkPatternTabVisibility();
    updateRankingPaywallUi();
    return false;
  }
  root.verifySubscriptionStatus = verifySubscriptionStatus;

  root.fetchRankingTable = async function () {
    if (!isSubscribedUser()) {
      await verifySubscriptionStatus();
      if (!isSubscribedUser()) {
        updateRankingPaywallUi();
        return;
      }
    }
    updateRankingPaywallUi();
    if (rankingState.loading) return;
    // Same session-note wiring as the standalone "Ranking" menu page
    // (stock-analysis-ai.js), so the Ranking Harian tab shows the identical
    // "catatan sesi" banner instead of nothing.
    if (typeof root.wrapRenderRankingTableForSessionLabel === 'function') root.wrapRenderRankingTableForSessionLabel();
    rankingState.loading = true;
    rankingState.error = null;
    renderRankingTable();
    try {
      var resp = await fetch('/api/quote?action=daily-market-context-list', { credentials: 'same-origin' });
      var body = await resp.json();
      if (body && body.success && Array.isArray(body.rows)) {
        rankingState.rows = body.rows;
        rankingState.loaded = true;
      } else {
        rankingState.error = (body && body.error) || 'Ranking harian belum tersedia saat ini.';
      }
    } catch (e) {
      rankingState.error = 'Gagal memuat ranking harian.';
    }
    rankingState.loading = false;
    renderRankingTable();
  };

  root.ensureRankingTableLoaded = function () {
    if (!isSubscribedUser()) {
      updateRankingPaywallUi();
      return;
    }
    if (!rankingState.loaded && !rankingState.loading) {
      root.fetchRankingTable();
    }
  };

  root.refreshRankingTable = function () {
    rankingState.loaded = false;
    root.fetchRankingTable();
  };


  // ===== STOCK ANALYSIS (TEXT FORMAT) VIA /api/analyze =====
  var _analisisRequestSeq = 0;
  var ANALISIS_REQUEST_TIMEOUT_MS = 70000;

  function describeAnalisisFailure(response, data, error) {
    var code = data && data.code;
    var status = response ? response.status : 0;
    if (error && error.name === 'AbortError') return { retryable: true, text: 'Analisis dihentikan karena terlalu lama. Coba lagi ya.' };
    if (!response) return { retryable: true, text: 'Koneksi ke server AI gagal. Cek jaringan lalu coba lagi.' };
    // Anonymous/guest browsing has no server session at all, so a 401 here is
    // never "your session expired" — AI analysis requires a registered
    // account (no free guest tier). requiresAuth drives the CTA button in
    // renderAnalisisFailure below.
    if (status === 401) return { retryable: false, requiresAuth: true, text: 'Fitur AI Analisis Saham khusus untuk akun terdaftar. Daftar atau masuk dulu (gratis) untuk mulai.' };
    if (status === 403) return { retryable: false, text: (data && data.error) || 'Akses AI ditolak untuk akun ini.' };
    if (status === 402 || code === 'SUBSCRIPTION_REQUIRED') return { retryable: false, text: (data && data.error) || 'Subscription aktif diperlukan untuk menggunakan fitur ini.' };
    if (status === 429 || code === 'AI_RATE_LIMITED') {
      var wait = Number(data && data.retry_after_seconds);
      return { retryable: false, text: 'Terlalu banyak permintaan analisis dalam waktu singkat.' + (Number.isFinite(wait) && wait > 0 ? ' Coba lagi sekitar ' + wait + ' detik lagi.' : ' Tunggu sebentar lalu coba lagi.') };
    }
    if (code === 'AI_NOT_CONFIGURED') return { retryable: false, text: 'Asisten AI belum diaktifkan di server. Hubungi admin.' };
    if (code === 'AI_KEY_OR_BALANCE_ERROR') return { retryable: false, text: 'Konfigurasi akses AI di server bermasalah. Hubungi admin.' };
    if (code === 'PREMIUM_ACCESS_UNAVAILABLE') return { retryable: true, text: (data && data.error) || 'Status langganan belum bisa dibaca. Coba lagi sebentar.' };
    if (status >= 500) return { retryable: true, text: (data && data.error) || 'Server AI sedang bermasalah. Coba lagi sebentar.' };
    return { retryable: true, text: (data && data.error) || 'Analisis belum berhasil. Coba lagi.' };
  }

  function renderAnalisisFailure(resultArea, failure) {
    if (!resultArea) return;
    resultArea.innerHTML = '<div class="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center space-y-2" role="alert">' +
      '<p class="text-sm text-red-400"></p>' +
      (failure.requiresAuth ? '<a href="/dashboard" class="inline-block mt-1 px-4 py-2 rounded-xl bg-emerald-500 text-black font-semibold text-xs hover:bg-emerald-400 transition">Daftar / Masuk</a>' :
        (failure.retryable ? '<p class="text-xs text-gray-500">Kamu bisa mencoba lagi.</p>' : '')) +
      '</div>';
    var messageEl = resultArea.querySelector('p');
    if (messageEl) messageEl.textContent = failure.text;
  }

  root.runAnalisisFromDashboard = async function (tickerOrQuery) {
    var resultArea = byId('analisisResult');
    var followUp = byId('analisisFollowUp');
    if (!resultArea) return;

    var ticker = String(tickerOrQuery || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!ticker) return;

    var analisisRequestId = ++_analisisRequestSeq;
    function isStaleRun() { return analisisRequestId !== _analisisRequestSeq; }

    resultArea.innerHTML = '<div class="flex flex-col items-center justify-center py-12"><div class="spinner"></div><p class="text-sm text-gray-500 mt-4 loading-stage-text">Membaca struktur trend, MA, RSI, volume ' + escapeHtml(ticker) + '...</p></div>';

    // Highlight row in ranking table if present
    rankingState.selectedTicker = ticker;
    renderRankingTable();

    // Update URL query string seamlessly without reload
    try {
      var newUrl = window.location.pathname + '?ticker=' + encodeURIComponent(ticker);
      window.history.replaceState({}, '', newUrl);
    } catch (_) {}

    var stageEl = resultArea.querySelector('.loading-stage-text');
    var stages = ['Membaca level support & resistance...', 'Menyusun analisis teknikal & prospek...'];
    var stageIdx = 0;
    var stageTimer = setInterval(function () {
      if (stageIdx < stages.length && stageEl) {
        stageEl.textContent = stages[stageIdx];
        stageIdx++;
      } else {
        clearInterval(stageTimer);
      }
    }, 2500);

    try {
      var controller = (typeof AbortController === 'function') ? new AbortController() : null;
      var abortTimer = controller ? setTimeout(function () { try { controller.abort(); } catch (_) {} }, ANALISIS_REQUEST_TIMEOUT_MS) : null;

      // Same enrichment as the Dashboard chat's runAnalisisFromDashboard()
      // (public/index.html), via the shared fetchQuoteContext() in
      // public/market-feature-runtime.js: a bare ticker with no [Auto-Cuan
      // Market Data]/[Auto-Cuan Fibonacci Intelligence] block makes the server
      // fall back to a 90-day Yahoo-only quote that can't produce MA100/MA200
      // or a real Fibonacci swing high/low. See PR #529 follow-up.
      var company = (typeof getCompanyName === 'function') ? getCompanyName(ticker) : null;
      var enrichedMsg = ticker + (company ? '\n[Info: ' + ticker + ' = ' + company + ']' : '');
      if (typeof fetchQuoteContext === 'function') {
        var quoteCtx = await fetchQuoteContext(ticker, true);
        if (quoteCtx) enrichedMsg += quoteCtx;
      }

      var response;
      try {
        response = await fetch('/api/analyze', {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            chatMessage: enrichedMsg,
            source: 'chat_mode',
            isInitialAnalysis: true,
            username: localStorage.getItem('autocuan_user') || '',
            isAdmin: localStorage.getItem('autocuan_is_admin') === 'true',
            context: {}
          })
        });
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
      }

      clearInterval(stageTimer);
      if (isStaleRun()) return;

      if (!response.ok) {
        var failureData = await response.json().catch(function () { return {}; });
        renderAnalisisFailure(resultArea, describeAnalisisFailure(response, failureData, null));
        return;
      }

      var data = await response.json().catch(function () { return {}; });
      if (isStaleRun()) return;

      var rawOutput = data.html || data.reply || '';
      if (rawOutput) {
        var html = convertStrayMarkdownBold(rawOutput.replace(/^```html\s*/i, '').replace(/```\s*$/i, ''));
        resultArea.innerHTML = '<div class="ai-content bg-dark-700/40 border border-dark-600/20 rounded-2xl p-4 sm:p-5 fade-in-up">' + html + '</div>' +
          '<div class="mt-3 flex flex-wrap gap-2">' +
          '<button onclick="switchAnalisisTab(\'chart\')" class="px-3 py-1.5 rounded-lg text-xs text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/10 transition inline-flex items-center gap-1 font-semibold">📈 Buka Chart</button>' +
          '<button onclick="UnifiedCockpit.openFullscreen()" class="px-3 py-1.5 rounded-lg text-xs text-sky-400 border border-sky-500/30 hover:bg-sky-500/10 transition inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4m11-5v4a1 1 0 01-1 1h-4"/></svg>Chart Layar Penuh</button>' +
          '<button onclick="copyAnalisisResult()" class="px-3 py-1.5 rounded-lg text-xs text-gray-400 border border-gray-500/30 hover:bg-gray-500/10 transition inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>Salin Hasil</button>' +
          '<button onclick="window.print()" class="px-3 py-1.5 rounded-lg text-xs text-rose-400 border border-rose-500/30 hover:bg-rose-500/10 transition inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>Cetak / PDF</button>' +
          '</div>';

        if (followUp) followUp.classList.remove('hidden');
      } else {
        throw new Error('Tidak ada hasil analisis yang diterima.');
      }
    } catch (e) {
      clearInterval(stageTimer);
      if (isStaleRun()) return;
      renderAnalisisFailure(resultArea, describeAnalisisFailure(null, {}, e));
    }
  };

  root.quickAnalisis = function (ticker) {
    if (typeof root.switchAnalisisTab === 'function') {
      root.switchAnalisisTab('analisis');
    }
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(ticker, { loadChart: true, forceChartReload: true, runAnalysis: true });
    } else {
      root.runAnalisisFromDashboard(ticker);
    }
  };

  root.copyAnalisisResult = function () {
    var resultArea = byId('analisisResult');
    if (!resultArea) return;
    var contentEl = resultArea.querySelector('.ai-content');
    if (!contentEl) return;
    var text = htmlToCleanText(contentEl.innerHTML);
    // AutoCuanAI.copyText (public/ai-chat-renderer.js) guards a missing
    // navigator.clipboard and falls back to document.execCommand('copy'),
    // same as every other "Salin Hasil" button in the app.
    var copyFn = (window.AutoCuanAI && typeof window.AutoCuanAI.copyText === 'function')
      ? window.AutoCuanAI.copyText
      : function (t) { return (navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText(t).then(function () { return true; }).catch(function () { return false; }) : Promise.resolve(false); };
    copyFn(text).then(function (ok) {
      if (ok) root.showToast('Hasil analisis berhasil disalin ke clipboard.', 'good');
      else root.showToast('Gagal menyalin hasil.', 'danger');
    });
  };

  // ===== PAGE BOOTSTRAP =====
  function initStandaloneAnalisisPage() {
    verifySubscriptionStatus();
    checkPatternTabVisibility();

    try {
      window.addEventListener('autocuan:premium-access', function (ev) {
        if (ev && ev.detail && (ev.detail.accessLevel === 'admin' || ev.detail.isAdmin)) {
          try { localStorage.setItem('autocuan_is_admin', 'true'); } catch (_) {}
        }
        syncHeaderUsername();
        updateRankingPaywallUi();
        checkPatternTabVisibility();
        if (isSubscribedUser()) {
          root.ensureRankingTableLoaded();
        }
      });
    } catch (_) {}

    var params = (typeof URLSearchParams !== 'undefined' && window.location && window.location.search)
      ? new URLSearchParams(window.location.search)
      : { get: function () { return null; } };
    var tickerParam = params.get('ticker');
    var tabParam = params.get('tab');
    var initialTicker = (tickerParam || 'BBCA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'BBCA';

    if (tabParam) {
      switchAnalisisTab(tabParam);
    } else if (window.location && window.location.hash === '#pattern') {
      switchAnalisisTab('pattern');
    }

    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(initialTicker, {
        loadChart: true,
        forceChartReload: true,
        preserveTab: Boolean(tabParam && tabParam !== 'analisis'),
        runAnalysis: Boolean(tickerParam && (!tabParam || tabParam === 'analisis'))
      });
    }

    ['bandarTickerSearchInput', 'akumulasiTickerSearchInput', 'bandarSummarySearchInput', 'rankingTickerSearchInput', 'patternTickerSearchInput'].forEach(function (id) {
      var el = byId(id);
      if (el) el.value = initialTicker;
    });

    if (isSubscribedUser()) {
      root.ensureRankingTableLoaded();
    }

    syncHeaderUsername();
  }

  if (!root.navigateTo) {
    root.navigateTo = function (name) {
      if (name === 'chart' || name === 'analisis' || name === 'analisis-chart') {
        switchAnalisisTab(name === 'chart' ? 'chart' : 'analisis-chart');
      } else if (name === 'pattern') {
        switchAnalisisTab('pattern');
      }
    };
  }

  async function handleAnalisisLogout() {
    try {
      await fetch('/api/login-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'logout' })
      });
    } catch (_) {}
    try {
      localStorage.setItem('autocuan_user', 'guest');
      localStorage.setItem('autocuan_is_admin', 'false');
      localStorage.removeItem('autocuan_logged_in');
      localStorage.removeItem('autocuan_login_time');
      localStorage.removeItem('autocuan_is_review');
      localStorage.removeItem('autocuan_user_id');
    } catch (_) {}
    window.location.href = '/';
  }
  root.handleAnalisisLogout = handleAnalisisLogout;
  if (!root.logout) root.logout = handleAnalisisLogout;

  function syncHeaderUsername() {
    var u = 'guest';
    try { u = (localStorage.getItem('autocuan_user') || '').trim(); } catch (_) {}
    var isAdmin = false;
    try {
      isAdmin = localStorage.getItem('autocuan_is_admin') === 'true' ||
        Boolean(root.premiumAccessState && (root.premiumAccessState.isAdmin === true || root.premiumAccessState.accessLevel === 'admin'));
    } catch (_) {}
    var isBudi = (u && u.toLowerCase() === 'budi') || isAdmin;
    var isSubscribed = (typeof isSubscribedUser === 'function' ? isSubscribedUser() : false) ||
      (isAdmin || Boolean(root.premiumAccessState && (root.premiumAccessState.premium === true || root.premiumAccessState.accessLevel === 'admin' || root.premiumAccessState.accessLevel === 'premium' || root.premiumAccessState.accessLevel === 'lifetime')));

    var userEl = byId('headerUsername');
    var labelEl = byId('headerUserLabel');
    var tierBadgeEl = byId('headerTierBadge');
    var logoutEl = byId('logoutBtn');
    var accountSection = byId('headerAccountSection');
    if (accountSection) accountSection.style.display = 'inline-flex';

    var isGuest = !u || u.toLowerCase() === 'guest';

    if (isGuest) {
      if (userEl) userEl.textContent = 'Guest';
      if (logoutEl) {
        logoutEl.textContent = 'Login';
        logoutEl.onclick = function () { window.location.href = '/?login=1'; };
      }
      if (tierBadgeEl) {
        tierBadgeEl.className = 'text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-dark-600/60 border border-dark-600 text-gray-400 shrink-0 cursor-pointer hover:opacity-80 transition-all';
        tierBadgeEl.textContent = 'FREE';
        tierBadgeEl.classList.remove('hidden');
        tierBadgeEl.style.display = 'inline-block';
      }
    } else {
      if (userEl) userEl.textContent = u;
      if (logoutEl) {
        logoutEl.textContent = 'Logout';
        logoutEl.onclick = handleAnalisisLogout;
      }
      if (tierBadgeEl) {
        if (isBudi || isAdmin) {
          tierBadgeEl.className = 'text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 shrink-0 cursor-pointer hover:opacity-80 transition-all';
          tierBadgeEl.textContent = '👑 ADMIN';
        } else if (isSubscribed) {
          tierBadgeEl.className = 'text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 shrink-0 cursor-pointer hover:opacity-80 transition-all';
          tierBadgeEl.textContent = '⭐ PRO';
        } else {
          tierBadgeEl.className = 'text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-dark-600/60 border border-dark-600 text-gray-400 shrink-0 cursor-pointer hover:opacity-80 transition-all';
          tierBadgeEl.textContent = 'FREE';
        }
        tierBadgeEl.classList.remove('hidden');
        tierBadgeEl.style.display = 'inline-block';
      }
    }

    if (tierBadgeEl && !tierBadgeEl.__boundClick && typeof tierBadgeEl.addEventListener === 'function') {
      tierBadgeEl.__boundClick = true;
      tierBadgeEl.addEventListener('click', function () {
        if (labelEl && typeof labelEl.click === 'function') labelEl.click();
      });
    }
  }
  root.syncHeaderUsername = syncHeaderUsername;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStandaloneAnalisisPage);
  } else {
    initStandaloneAnalisisPage();
  }
})(typeof window !== 'undefined' ? window : globalThis);
