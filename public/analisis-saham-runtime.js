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
    if (v === 0 || Math.round(v) === 0) return 'Rp 0';
    var abs = Math.abs(v);
    var sign = v > 0 ? '+' : '-';
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

  var _rankingSearchTimer = null;
  root.onRankingSearchInput = function (value) {
    if (_rankingSearchTimer) clearTimeout(_rankingSearchTimer);
    _rankingSearchTimer = setTimeout(function () {
      rankingState.searchQuery = value;
      renderRankingTable();
    }, 300);
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

  var _isSwitchingTab = false;
  function switchAnalisisTab(tabName) {
    if (_isSwitchingTab) return;
    _isSwitchingTab = true;
    try {
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

    var validParentTabs = ['analisis-chart', 'bandarmologi', 'intel', 'hunter', 'insider', 'ranking', 'financial', 'market-structure', 'pattern'];
    if (validParentTabs.indexOf(parentTab) < 0) parentTab = 'analisis-chart';
    root.__ACTIVE_ANALISIS_SUBTAB__ = parentTab;
    var workspace = byId('page-analisis');
    if (workspace && !workspace.classList.contains('hidden') && typeof root.syncWorkspaceSidebarActive === 'function') root.syncWorkspaceSidebarActive('analisis');
    var workspaceTitle = byId('analysisWorkspaceTitle');
    if (workspaceTitle) workspaceTitle.textContent = ({ 'analisis-chart':'Analisis Saham', bandarmologi:'Bandarmologi', intel:'Sinyal Intelijen', hunter:'Broker Hunter', insider:'Jejaring Insider', ranking:'Ranking Harian', financial:'Financial', 'market-structure':'Struktur Pasar', pattern:'Pattern Radar' })[parentTab];
    var subtitle = workspace && workspace.querySelector && workspace.querySelector('.page-subtitle');
    if (subtitle) subtitle.textContent = parentTab === 'financial' ? 'Data fundamental, valuasi, dan sumber laporan untuk saham yang dipilih.' : parentTab === 'market-structure' ? 'Free float, status HSC, dan kelengkapan data struktur kepemilikan.' : 'Chart interaktif, analisis teknikal komprehensif, dan pembacaan visual AI.';


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
    var pFinancial = byId('panel-tab-financial');
    var pMarketStructure = byId('panel-tab-market-structure');
    var pPattern = byId('panel-tab-pattern');

    if (parentTab === 'analisis-chart') {
      if (pHeader) pHeader.style.display = 'block';
      if (pBandarmologi) pBandarmologi.style.display = 'none';
      if (pIntel) pIntel.style.display = 'none';
      if (pHunter) pHunter.style.display = 'none';
      if (pInsider) pInsider.style.display = 'none';
      if (pRanking) pRanking.style.display = 'none';
      if (pFinancial) pFinancial.style.display = 'none';
      if (pMarketStructure) pMarketStructure.style.display = 'none';
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
      if (pFinancial) pFinancial.style.display = (parentTab === 'financial' ? 'block' : 'none');
      if (pMarketStructure) pMarketStructure.style.display = (parentTab === 'market-structure' ? 'block' : 'none');
      if (pPattern) pPattern.style.display = (parentTab === 'pattern' ? 'block' : 'none');
    }
    if (root.AutoCuanFinalUiux) root.AutoCuanFinalUiux.enterPanel(byId('panel-tab-' + parentTab));

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
      if (!isSubscribedUser()) {
        updateRankingPaywallUi();
        return;
      }
      root.ensureRankingTableLoaded();
    } else if (parentTab === 'financial') {
      var activeResearchTicker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
        ? root.UnifiedCockpit.getActiveTicker() : (root.activeTicker || 'BBCA');
      root.loadFinancialStructureTab('financial', activeResearchTicker);
    } else if (parentTab === 'market-structure') {
      root.loadStrukturPasarUniverse();
    } else if (parentTab === 'bandarmologi') {
      var currentSection = (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.getBandarSection === 'function')
        ? root.BandarmologiRuntime.getBandarSection() : 'summary';
      var bandarSection = (tabName === 'akumulasi' || currentSection === 'akumulasi') ? 'akumulasi' : 'summary';
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.setBandarSection === 'function') {
        root.BandarmologiRuntime.setBandarSection(bandarSection);
      }
      if (!isSubscribedUser()) {
        renderTabPaywall('bandarmologiContent', 'Bandarmologi Terkunci', 'Akses Broker Summary, Akumulasi Bandar harian, dan aliran modal bandar hanya tersedia untuk member berlangganan.');
        return;
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
      if (!isSubscribedUser()) {
        var intelTarget = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
        renderTabPaywall(intelTarget ? intelTarget.id : 'bandarmologiContent', 'Sinyal Intelijen Terkunci', 'Akses 4 Sinyal Strategis Intelijen Bandar (Akumulasi Senyap, Harga di Bawah Bandar, Ritel Cutloss vs Bandar, dan Screening Pasar) hanya tersedia untuk member berlangganan.');
        return;
      }
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.updateIntelSearchBarVisibility === 'function') {
        root.BandarmologiRuntime.updateIntelSearchBarVisibility();
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
      if (!isSubscribedUser()) {
        var hunterTarget = byId('brokerHunterContent') || byId('bandarmologiContent');
        renderTabPaywall(hunterTarget ? hunterTarget.id : 'bandarmologiContent', 'Broker Hunter Terkunci', 'Akses pelacak broker institusi, smart money tracker, dan deteksi pergerakan broker asing hanya tersedia untuk member berlangganan.');
        return;
      }
      var hunterContainer = byId('brokerHunterContent') || byId('bandarmologiContent');
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadBrokerHunter === 'function') {
        root.BandarmologiRuntime.loadBrokerHunter(hunterContainer);
      }
    } else if (parentTab === 'insider') {
      if (!isSubscribedUser()) {
        var insiderTarget = byId('insiderNetworkDedicatedContent') || byId('bandarmologiContent');
        renderTabPaywall(insiderTarget ? insiderTarget.id : 'bandarmologiContent', 'Jejaring Insider Terkunci', 'Daftar Pemegang Saham lengkap, transaksi kepemilikan orang dalam, dan graf jejaring lintas emiten hanya tersedia untuk member berlangganan.');
        return;
      }
      var insiderContainer = byId('insiderNetworkDedicatedContent') || byId('bandarmologiContent');
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadInsiderNetwork === 'function') {
        root.BandarmologiRuntime.loadInsiderNetwork(insiderContainer);
      }
    } else if (parentTab === 'pattern') {
      if (!isAdminUser()) {
        renderTabPaywall('panel-tab-pattern', 'Pattern Radar Khusus Administrator', 'Fitur Pattern Radar dengan deteksi pola teknikal multi-frame saat ini hanya tersedia secara eksklusif untuk Administrator.', true);
        return;
      }
      loadPatternRadarTab();
    }
    } finally {
      _isSwitchingTab = false;
    }
  }

  function researchTicker(raw) {
    return String(raw || '').trim().toUpperCase().replace(/\.JK$/i, '').replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  function researchText(id, value) {
    var el = byId(id);
    if (el) el.textContent = value == null || value === '' ? '—' : String(value);
  }

  function researchNumber(value, decimals) {
    if (!researchHasNumber(value)) return '—';
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    try {
      return new Intl.NumberFormat('id-ID', {
        maximumFractionDigits: decimals == null ? 2 : decimals
      }).format(n);
    } catch (_) {
      return String(n);
    }
  }

  function researchIdr(value) {
    if (!researchHasNumber(value)) return '—';
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    try {
      return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        maximumFractionDigits: 0
      }).format(n);
    } catch (_) {
      return 'Rp ' + Math.round(n).toLocaleString('id-ID');
    }
  }

  function researchCompact(value) {
    if (!researchHasNumber(value)) return '—';
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    try {
      return new Intl.NumberFormat('id-ID', {
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: 2
      }).format(n);
    } catch (_) {
      return researchNumber(n, 0);
    }
  }

  var MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT = 15;
  root.MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT = MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT;

  var ENUM_PRESENTATION_MAP = {
    'NORMAL': 'Normal',
    'CAUTION': 'Perhatian',
    'UNKNOWN': 'Belum diketahui',
    'STRUCTURE_VERIFIED': 'Struktur terverifikasi',
    'LOW_FREE_FLOAT': 'Free Float rendah',
    'HIGH_SHAREHOLDING_CONCENTRATION': 'Konsentrasi kepemilikan tinggi',
    'FREE_FLOAT_VERIFIED_HSC_UNKNOWN': 'Free Float terverifikasi, HSC belum diketahui',
    'HSC_VERIFIED_FREE_FLOAT_UNKNOWN': 'HSC terverifikasi, Free Float belum diketahui',
    'DATA_INCOMPLETE': 'Data belum lengkap',
    'NOT_EVALUATED': 'Tidak dievaluasi'
  };

  function formatEnumPresentation(val) {
    if (!val) return '—';
    var k = String(val).trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(ENUM_PRESENTATION_MAP, k)) {
      return ENUM_PRESENTATION_MAP[k];
    }
    return 'Status belum dikenali';
  }

  function researchHasNumber(value) {
    return value != null && String(value).trim() !== '' && Number.isFinite(Number(value));
  }
  var researchGeneration = 0;
  var financialCache = {};
  var financialRenderedTicker = null;

  var marketStructureUniverse = [];
  var marketStructureFilter = 'all';
  var marketStructureSort = 'free_float_asc';
  var marketStructureSearchQuery = '';
  var marketStructureSelectedTicker = null;
  var marketStructureLoading = false;
  var marketStructureLastFocusedElement = null;
  var marketStructureUniverseLoaded = false;
  var marketStructureBoundEvents = false;
  var marketStructureDetailToken = 0;

  function getFilteredMarketStructureItems() {
    var items = marketStructureUniverse.slice();

    // 1. Search Query filter
    if (marketStructureSearchQuery) {
      var q = marketStructureSearchQuery.trim().toUpperCase();
      items = items.filter(function (it) {
        return it.ticker && it.ticker.toUpperCase().includes(q);
      });
    }

    // 2. Category Chip filter
    if (marketStructureFilter === 'low-ff') {
      // Strict < reference rule: only valid numbers where free_float_pct < MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT.
      items = items.filter(function (it) {
        return researchHasNumber(it.free_float_pct) && Number(it.free_float_pct) < MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT;
      });
    } else if (marketStructureFilter === 'hsc') {
      // Explicitly flagged HSC only
      items = items.filter(function (it) {
        return it.hsc_flag === true;
      });
    } else if (marketStructureFilter === 'incomplete') {
      // INCOMPLETE_RECORD_RULE
      items = items.filter(function (it) {
        return it.free_float_pct == null ||
          it.hsc_flag == null ||
          it.market_structure_status === 'DATA_INCOMPLETE' ||
          it.market_structure_guard === 'UNKNOWN';
      });
    }

    // 3. Sorting
    items.sort(function (a, b) {
      if (marketStructureSort === 'free_float_asc') {
        var aHas = researchHasNumber(a.free_float_pct);
        var bHas = researchHasNumber(b.free_float_pct);
        if (aHas && bHas) {
          var diff = Number(a.free_float_pct) - Number(b.free_float_pct);
          if (diff !== 0) return diff;
          return a.ticker.localeCompare(b.ticker);
        }
        // Missing free float values MUST sort LAST
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        return a.ticker.localeCompare(b.ticker);
      } else if (marketStructureSort === 'ticker_asc') {
        return a.ticker.localeCompare(b.ticker);
      } else if (marketStructureSort === 'hsc_first') {
        // Flagged (true) -> 0, Non-flagged (false) -> 1, Unknown (null/other) -> 2
        var aRank = a.hsc_flag === true ? 0 : (a.hsc_flag === false ? 1 : 2);
        var bRank = b.hsc_flag === true ? 0 : (b.hsc_flag === false ? 1 : 2);
        if (aRank !== bRank) return aRank - bRank;
        return a.ticker.localeCompare(b.ticker);
      }
      return 0;
    });

    return items;
  }

  function renderMarketStructureTable() {
    var tbody = byId('marketStructureTableBody');
    if (!tbody) return;

    var items = getFilteredMarketStructureItems();
    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="ac-table-empty text-center py-8 text-xs">Tidak ada saham yang sesuai dengan filter.</td></tr>';
      return;
    }

    var html = items.map(function (item) {
      var isSelected = marketStructureSelectedTicker && marketStructureSelectedTicker.toUpperCase() === item.ticker.toUpperCase();
      var ffStr = researchHasNumber(item.free_float_pct) ? researchNumber(item.free_float_pct, 2) + '%' : '—';

      var hscBadge;
      if (item.hsc_flag === true) {
        hscBadge = '<span class="ac-badge ac-badge-warning">HSC Aktif</span>';
      } else if (item.hsc_flag === false) {
        hscBadge = '<span class="ac-badge ac-badge-neutral">Non-HSC</span>';
      } else {
        hscBadge = '<span class="ac-badge ac-badge-dim">Belum terverifikasi</span>';
      }

      var guardBadge;
      var g = String(item.market_structure_guard || '').toUpperCase();
      var guardLabel = formatEnumPresentation(item.market_structure_guard);
      if (g === 'NORMAL') {
        guardBadge = '<span class="ac-badge ac-badge-good">' + escapeHtml(guardLabel) + '</span>';
      } else if (g === 'CAUTION') {
        guardBadge = '<span class="ac-badge ac-badge-warning">' + escapeHtml(guardLabel) + '</span>';
      } else {
        guardBadge = '<span class="ac-badge ac-badge-dim">' + escapeHtml(guardLabel) + '</span>';
      }

      var dateStr = item.as_of_trade_date || (item.free_float_as_of || '—');

      return '<tr class="ac-table-row cursor-pointer transition' + (isSelected ? ' is-selected' : '') + '" data-ticker="' + escapeHtml(item.ticker) + '" tabindex="0" role="button" aria-pressed="' + (isSelected ? 'true' : 'false') + '" aria-label="Lihat struktur pasar ' + escapeHtml(item.ticker) + '">' +
        '<td class="py-2.5 px-3 font-mono font-bold ac-cell-ticker">' + escapeHtml(item.ticker) + '</td>' +
        '<td class="py-2.5 px-3 font-mono ac-cell-value">' + ffStr + '</td>' +
        '<td class="py-2.5 px-3">' + hscBadge + '</td>' +
        '<td class="py-2.5 px-3">' + guardBadge + '</td>' +
        '<td class="py-2.5 px-3 text-xs ac-cell-date">' + escapeHtml(dateStr) + '</td>' +
      '</tr>';
    }).join('');

    tbody.innerHTML = html;

    var rows = tbody.querySelectorAll('tr[data-ticker]');
    rows.forEach(function (row) {
      var t = row.getAttribute('data-ticker');
      row.addEventListener('click', function () {
        selectMarketStructureRow(t, row, true);
      });
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectMarketStructureRow(t, row, true);
        }
      });
    });
  }

  function populateMarketStructureDetail(item) {
    if (!item) return;

    var ffText = researchHasNumber(item.free_float_pct) ? researchNumber(item.free_float_pct, 2) + '%' : '—';
    var ffAsOfText = item.free_float_as_of ? 'As of ' + item.free_float_as_of : 'As of —';
    var hscText = item.hsc_flag === true ? 'HSC Aktif' : (item.hsc_flag === false ? 'Non-HSC' : 'Belum terverifikasi');
    var hscAsOfText = item.hsc_as_of ? 'As of ' + item.hsc_as_of : 'As of —';
    var guardText = formatEnumPresentation(item.market_structure_guard);
    var statusText = formatEnumPresentation(item.market_structure_status);
    var ffSourceText = item.free_float_source || 'Belum tersedia';
    var hscSourceText = item.hsc_source || 'Belum tersedia';
    var refPct = researchHasNumber(item.low_free_float_reference_pct) ? Number(item.low_free_float_reference_pct) : MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT;
    var refText = refPct + '%';
    var complianceText = formatEnumPresentation(item.regulatory_compliance_status);
    var noteText = item.market_structure_note || 'Data struktur pasar belum lengkap.';

    // Desktop elements
    researchText('marketStructureDetailTickerBadge', item.ticker);
    researchText('marketStructureDetailTitle', 'Detail Struktur ' + item.ticker);
    researchText('marketStructureFreeFloat', ffText);
    researchText('marketStructureFreeFloatAsOf', ffAsOfText);
    researchText('marketStructureHsc', hscText);
    researchText('marketStructureHscAsOf', hscAsOfText);
    researchText('marketStructureGuard', guardText);
    researchText('marketStructureStatus', statusText);
    researchText('marketStructureFreeFloatSource', ffSourceText);
    researchText('marketStructureHscSource', hscSourceText);
    researchText('marketStructureReference', refText);
    researchText('marketStructureCompliance', complianceText);
    researchText('marketStructureNote', noteText);

    // Mobile sheet elements (Dedicated IDs to prevent duplicate IDs in DOM)
    researchText('marketStructureSheetTickerBadge', item.ticker);
    researchText('marketStructureSheetTitle', 'Detail Struktur Pasar — ' + item.ticker);
    researchText('marketStructureSheetFreeFloat', ffText);
    researchText('marketStructureSheetFreeFloatAsOf', ffAsOfText);
    researchText('marketStructureSheetHsc', hscText);
    researchText('marketStructureSheetHscAsOf', hscAsOfText);
    researchText('marketStructureSheetGuard', guardText);
    researchText('marketStructureSheetStatus', statusText);
    researchText('marketStructureSheetFreeFloatSource', ffSourceText);
    researchText('marketStructureSheetHscSource', hscSourceText);
    researchText('marketStructureSheetReference', refText);
    researchText('marketStructureSheetCompliance', complianceText);
    researchText('marketStructureSheetNote', noteText);

    var content = byId('marketStructureDataContent');
    if (content) content.hidden = false;
  }

  function openMarketStructureMobileSheet(ticker) {
    var sheet = byId('marketStructureDetailSheet');
    if (!sheet) return;
    sheet.hidden = false;

    var bgWrapper = byId('marketStructureBackgroundWrapper') || byId('marketStructureMainRegion');
    if (bgWrapper) {
      bgWrapper.setAttribute('aria-hidden', 'true');
      try { bgWrapper.inert = true; } catch (_) {}
    }

    var closeBtn = byId('marketStructureSheetClose');
    if (closeBtn && typeof closeBtn.focus === 'function') {
      try { closeBtn.focus(); } catch (_) {}
    }
  }

  function closeMarketStructureMobileSheet() {
    var sheet = byId('marketStructureDetailSheet');
    if (!sheet) return;
    sheet.hidden = true;

    var bgWrapper = byId('marketStructureBackgroundWrapper') || byId('marketStructureMainRegion');
    if (bgWrapper) {
      bgWrapper.removeAttribute('aria-hidden');
      try { bgWrapper.inert = false; } catch (_) {}
    }
  }

  function selectMarketStructureRow(ticker, originElement, syncCockpit) {
    if (!ticker) return;
    ticker = ticker.trim().toUpperCase();
    marketStructureSelectedTicker = ticker;
    if (originElement) {
      marketStructureLastFocusedElement = originElement;
    }

    var tbody = byId('marketStructureTableBody');
    if (tbody) {
      var rows = tbody.querySelectorAll('tr[data-ticker]');
      rows.forEach(function (row) {
        var isThis = row.getAttribute('data-ticker') === ticker;
        if (isThis) {
          row.classList.add('is-selected');
          row.setAttribute('aria-pressed', 'true');
        } else {
          row.classList.remove('is-selected');
          row.setAttribute('aria-pressed', 'false');
        }
      });
    }

    var item = marketStructureUniverse.find(function (it) {
      return it.ticker && it.ticker.toUpperCase() === ticker;
    });

    if (item) {
      populateMarketStructureDetail(item);
    }

    var isMobile = (typeof window !== 'undefined' && window.innerWidth < 1024);
    var pane = byId('marketStructureDetailPane');
    var sheet = byId('marketStructureDetailSheet');

    if (isMobile) {
      if (pane) pane.hidden = true;
      openMarketStructureMobileSheet(ticker);
    } else {
      closeMarketStructureMobileSheet();
      if (pane) pane.hidden = false;
    }

    if (syncCockpit && root.activeTicker !== ticker) {
      root.activeTicker = ticker;
      if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
        root.UnifiedCockpit.syncActiveTicker(ticker, { loadChart: false, preserveTab: true, runAnalysis: false });
      }
    }

    // Lazy load authoritative single-ticker context with race condition protection
    var currentDetailToken = ++marketStructureDetailToken;
    fetch('/api/quote?action=daily-market-context&ticker=' + encodeURIComponent(ticker), {
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; });
    }).then(function (payload) {
      if (currentDetailToken !== marketStructureDetailToken) return; // Discard stale response
      if (marketStructureSelectedTicker !== ticker) return;
      if (!payload || !payload.success || !payload.context) return;

      var ms = payload.context.market_structure || {};
      if (researchHasNumber(ms.low_free_float_reference_pct)) {
        var refStr = researchNumber(ms.low_free_float_reference_pct, 0) + '%';
        researchText('marketStructureReference', refStr);
        researchText('marketStructureSheetReference', refStr);
      }
      if (ms.regulatory_compliance_status) {
        var compLabel = formatEnumPresentation(ms.regulatory_compliance_status);
        researchText('marketStructureCompliance', compLabel);
        researchText('marketStructureSheetCompliance', compLabel);
      }
      if (ms.market_structure_guard) {
        var guardLabel = formatEnumPresentation(ms.market_structure_guard);
        researchText('marketStructureGuard', guardLabel);
        researchText('marketStructureSheetGuard', guardLabel);
      }
      if (ms.market_structure_status) {
        var statLabel = formatEnumPresentation(ms.market_structure_status);
        researchText('marketStructureStatus', statLabel);
        researchText('marketStructureSheetStatus', statLabel);
      }
      if (ms.market_structure_note) {
        researchText('marketStructureNote', ms.market_structure_note);
        researchText('marketStructureSheetNote', ms.market_structure_note);
      }
    }).catch(function () {});
  }

  function closeMarketStructureDetail() {
    marketStructureSelectedTicker = null;
    var pane = byId('marketStructureDetailPane');
    if (pane) pane.hidden = true;
    closeMarketStructureMobileSheet();

    var tbody = byId('marketStructureTableBody');
    if (tbody) {
      var rows = tbody.querySelectorAll('tr[data-ticker]');
      rows.forEach(function (row) {
        row.classList.remove('is-selected');
        row.setAttribute('aria-pressed', 'false');
      });
    }

    if (marketStructureLastFocusedElement && typeof marketStructureLastFocusedElement.focus === 'function') {
      try { marketStructureLastFocusedElement.focus(); } catch (_) {}
    }
  }
  root.closeMarketStructureDetail = closeMarketStructureDetail;

  function bindMarketStructureEventsOnce() {
    if (marketStructureBoundEvents) return;
    marketStructureBoundEvents = true;

    // Search input
    var searchInput = byId('marketStructureSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', function (e) {
        marketStructureSearchQuery = (e && e.target && e.target.value != null ? e.target.value : (searchInput ? searchInput.value : '')) || '';
        renderMarketStructureTable();
      });
    }

    // Filter Chips
    var lowFfBtn = byId('marketStructureFilterLowFF');
    if (lowFfBtn) {
      lowFfBtn.textContent = '[FF Rendah <' + MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT + '%]';
    }

    var filterBtns = [
      { id: 'marketStructureFilterAll', filter: 'all' },
      { id: 'marketStructureFilterLowFF', filter: 'low-ff' },
      { id: 'marketStructureFilterHsc', filter: 'hsc' },
      { id: 'marketStructureFilterIncomplete', filter: 'incomplete' }
    ];
    filterBtns.forEach(function (btnDef) {
      var el = byId(btnDef.id);
      if (el) {
        el.addEventListener('click', function () {
          marketStructureFilter = btnDef.filter;
          filterBtns.forEach(function (b) {
            var o = byId(b.id);
            if (!o) return;
            if (b.filter === marketStructureFilter) {
              o.classList.add('is-active');
            } else {
              o.classList.remove('is-active');
            }
          });
          renderMarketStructureTable();
        });
      }
    });

    // Sort select
    var sortSelect = byId('marketStructureSortSelect');
    if (sortSelect) {
      sortSelect.addEventListener('change', function (e) {
        marketStructureSort = (e && e.target && e.target.value ? e.target.value : (sortSelect ? sortSelect.value : 'free_float_asc')) || 'free_float_asc';
        renderMarketStructureTable();
      });
    }

    // Close buttons
    var detailCloseBtn = byId('marketStructureDetailClose');
    if (detailCloseBtn) {
      detailCloseBtn.addEventListener('click', closeMarketStructureDetail);
    }
    var sheetCloseBtn = byId('marketStructureSheetClose');
    if (sheetCloseBtn) {
      sheetCloseBtn.addEventListener('click', closeMarketStructureDetail);
    }
    var sheetBackdrop = byId('marketStructureSheetBackdrop');
    if (sheetBackdrop) {
      sheetBackdrop.addEventListener('click', closeMarketStructureDetail);
    }

    // Sheet keyboard focus trap & Escape handling
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var openSheet = byId('marketStructureDetailSheet');
        var openPane = byId('marketStructureDetailPane');
        if ((openSheet && !openSheet.hidden) || (openPane && !openPane.hidden)) {
          e.preventDefault();
          closeMarketStructureDetail();
        }
      }
    });

    var sheet = byId('marketStructureDetailSheet');
    if (sheet) {
      sheet.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') {
          var focusable = sheet.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (!focusable || focusable.length === 0) return;
          var first = focusable[0];
          var last = focusable[focusable.length - 1];
          if (e.shiftKey) {
            if (document.activeElement === first) {
              e.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }
      });
    }

    // Refresh button
    var refreshBtn = byId('marketStructureRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadStrukturPasarUniverse(marketStructureSelectedTicker);
      });
    }
  }

  async function loadStrukturPasarUniverse(selectTicker) {
    if (marketStructureLoading) return;
    marketStructureLoading = true;
    bindMarketStructureEventsOnce();

    var state = byId('marketStructureDataState');
    var container = byId('marketStructureTableContainer');
    var refreshBanner = byId('marketStructureRefreshBanner');

    if (!marketStructureUniverseLoaded && state) {
      state.hidden = false;
      state.innerHTML = '<span class="spinner-sm"></span> Memuat daftar struktur pasar…';
    } else if (refreshBanner) {
      refreshBanner.hidden = false;
      refreshBanner.innerHTML = '<span class="ac-refresh-banner-text"><span class="spinner-sm"></span> Memperbarui daftar struktur pasar…</span>';
    }

    try {
      var response = await fetch('/api/quote?action=daily-market-context-list', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      var payload = await response.json().catch(function () { return {}; });
      var list = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.rows)
          ? payload.rows
          : null;

      if (!response.ok || !payload.success || !list) {
        throw new Error((payload && payload.error) || 'Gagal memuat daftar struktur pasar.');
      }

      marketStructureUniverse = list;
      marketStructureUniverseLoaded = true;

      if (state) state.hidden = true;
      if (container) container.hidden = false;
      if (refreshBanner) refreshBanner.hidden = true;

      renderMarketStructureTable();

      if (selectTicker) {
        selectMarketStructureRow(selectTicker, null, false);
      }
    } catch (err) {
      if (!marketStructureUniverseLoaded && state) {
        state.hidden = false;
        state.textContent = (err && err.message) || 'Gagal memuat struktur pasar.';
      } else if (refreshBanner) {
        refreshBanner.hidden = false;
        refreshBanner.innerHTML = '<span class="ac-refresh-banner-text is-error">Gagal memperbarui: ' + escapeHtml((err && err.message) || 'Koneksi terputus') + '</span>';
      }
    } finally {
      marketStructureLoading = false;
    }
  }
  root.loadStrukturPasarUniverse = loadStrukturPasarUniverse;
  root.refreshStrukturPasarUniverse = function () {
    loadStrukturPasarUniverse(marketStructureSelectedTicker);
  };

  function renderFinancialFundamental(ticker, f) {
    if (!f) return;
    researchText('financialTickerBadge', ticker);
    researchText('financialPbv', researchHasNumber(f.pbv) ? researchNumber(f.pbv, 2) + 'x' : '—');
    researchText('financialPbvPrice', researchHasNumber(f.pbv_as_of_price) ? 'Harga acuan ' + researchIdr(f.pbv_as_of_price) : 'Harga acuan —');
    researchText('financialBvps', researchHasNumber(f.book_value_per_share) ? researchIdr(f.book_value_per_share) : '—');
    researchText('financialShares', researchHasNumber(f.shares_outstanding) ? researchCompact(f.shares_outstanding) : '—');
    researchText('financialMarketCap', researchHasNumber(f.market_cap) ? researchIdr(f.market_cap) : '—');
    researchText('financialMarketCapAsOf', f.market_cap_as_of ? 'As of ' + f.market_cap_as_of : 'Belum tersedia');
    researchText('financialPeriod', f.fundamental_period || 'Belum tersedia');
    researchText('financialPeriodHero', f.fundamental_period ? 'Periode ' + f.fundamental_period : 'Periode belum tersedia');
    researchText('financialSource', f.fundamental_source || 'Belum tersedia');
    researchText('financialMarketCapSource', f.market_cap_source || 'Belum tersedia');
    researchText('financialUpdatedAt', f.fundamental_updated_at || 'Belum tersedia');

    var coverageValues = [f.pbv, f.book_value_per_share, f.shares_outstanding, f.market_cap];
    var coverageCount = coverageValues.reduce(function (count, value) {
      return count + (researchHasNumber(value) ? 1 : 0);
    }, 0);
    researchText('financialCoverage', coverageCount + ' / 4');
    var coverageBar = byId('financialCoverageBar');
    if (coverageBar && coverageBar.style && coverageBar.style.setProperty) {
      coverageBar.style.setProperty('--ac-financial-coverage', (coverageCount * 25) + '%');
    }

    var allUnavailEl = byId('financialAllUnavailableState');
    var metricGrid = byId('financialMetricGrid');
    if (coverageCount === 0) {
      if (allUnavailEl) allUnavailEl.hidden = false;
      if (metricGrid) metricGrid.hidden = true;
    } else {
      if (allUnavailEl) allUnavailEl.hidden = true;
      if (metricGrid) metricGrid.hidden = false;
    }
  }

  async function loadFinancialStructureTab(tabName, rawTicker) {
    var generation = ++researchGeneration;
    var ticker = researchTicker(rawTicker || (root.UnifiedCockpit && root.UnifiedCockpit.getActiveTicker ? root.UnifiedCockpit.getActiveTicker() : root.activeTicker));
    if (!ticker) return;

    var isFinancial = tabName === 'financial';
    if (!isFinancial) {
      return root.loadStrukturPasarUniverse(ticker);
    }

    root.activeTicker = ticker;
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(ticker, { loadChart: false, preserveTab: true, runAnalysis: false });
    }
    var financialInput = byId('financialTickerInput');
    if (financialInput) financialInput.value = ticker;

    var state = byId('financialDataState');
    var content = byId('financialDataContent');
    var refreshBanner = byId('financialRefreshBanner');
    var allUnavailEl = byId('financialAllUnavailableState');

    var isSameTickerRefresh = financialRenderedTicker === ticker;
    var cachedFundamental = financialCache[ticker];

    if (!isSameTickerRefresh) {
      // Cross-ticker safety: hide different ticker's metrics immediately
      if (cachedFundamental) {
        renderFinancialFundamental(ticker, cachedFundamental);
        financialRenderedTicker = ticker;
        if (state) state.hidden = true;
        if (content) content.hidden = false;
        if (refreshBanner) {
          refreshBanner.hidden = false;
          refreshBanner.innerHTML = '<span class="ac-refresh-banner-text"><span class="spinner-sm"></span> Memperbarui data fundamental ' + escapeHtml(ticker) + '…</span>';
        }
      } else {
        financialRenderedTicker = null;
        if (content) content.hidden = true;
        if (allUnavailEl) allUnavailEl.hidden = true;
        if (refreshBanner) refreshBanner.hidden = true;
        if (state) {
          state.hidden = false;
          state.textContent = 'Memuat ' + ticker + '…';
        }
      }
    } else {
      if (refreshBanner) {
        refreshBanner.hidden = false;
        refreshBanner.innerHTML = '<span class="ac-refresh-banner-text"><span class="spinner-sm"></span> Memperbarui data fundamental ' + escapeHtml(ticker) + '…</span>';
      }
    }

    try {
      var response = await fetch('/api/quote?action=daily-market-context&ticker=' + encodeURIComponent(ticker), {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      var payload = await response.json().catch(function () { return {}; });
      if (generation !== researchGeneration) return;
      if (!response.ok || !payload.success || !payload.context) {
        throw new Error(payload.error || 'Data belum tersedia.');
      }

      var ctx = payload.context || {};
      var f = ctx.fundamental || {};

      financialCache[ticker] = f;
      financialRenderedTicker = ticker;
      renderFinancialFundamental(ticker, f);

      if (state) state.hidden = true;
      if (refreshBanner) refreshBanner.hidden = true;
      if (content) {
        content.hidden = false;
        if (root.AutoCuanFinalUiux && typeof root.AutoCuanFinalUiux.enterPanel === 'function') {
          root.AutoCuanFinalUiux.enterPanel(content);
        }
      }
    } catch (error) {
      if (generation !== researchGeneration) return;
      if (isSameTickerRefresh && refreshBanner) {
        refreshBanner.hidden = false;
        refreshBanner.innerHTML = '<span class="ac-refresh-banner-text is-error">Gagal memperbarui: ' + escapeHtml((error && error.message) || 'Koneksi terputus') + '. Menampilkan data tersimpan.</span>';
      } else {
        if (state) {
          state.hidden = false;
          state.textContent = (error && error.message) || 'Gagal memuat data.';
        }
        if (content) content.hidden = true;
      }
    }
  }
  root.loadFinancialStructureTab = loadFinancialStructureTab;

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

  function isAdminUser() {
    var user = '';
    try { user = (localStorage.getItem('autocuan_user') || '').toLowerCase().trim(); } catch (_) {}
    if (user === 'budi') return true;
    try {
      if (localStorage.getItem('autocuan_is_admin') === 'true') return true;
      if (root.premiumAccessState && (root.premiumAccessState.isAdmin === true || root.premiumAccessState.accessLevel === 'admin' || root.premiumAccessState.role === 'admin')) {
        return true;
      }
    } catch (_) {}
    return false;
  }
  root.isAdminUser = isAdminUser;

  function checkPatternTabVisibility() {
    var tabPattern = byId('tabAnalisisPattern');
    if (!tabPattern) return;
    if (isAdminUser()) {
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
    if (isAdminUser()) return true;
    if (window.premiumAccessState && typeof window.premiumAccessState === 'object') {
      var s = window.premiumAccessState;
      // Do not determine paywall restriction while subscription check is still in-flight
      if (s.state === 'loading') return false;
      if (s.premium === true) return true;
      if (s.accessLevel === 'admin' || s.accessLevel === 'premium' || s.accessLevel === 'lifetime') return true;
    }
    return false;
  }
  root.isSubscribedUser = isSubscribedUser;

  function renderTabPaywall(containerId, title, description, isAdminOnly) {
    var container = byId(containerId);
    if (!container) return;
    var badgeText = isAdminOnly ? 'Khusus Administrator' : 'Fitur Eksklusif Member Berlangganan';
    var icon = isAdminOnly ? '👑' : '🔒';
    var buttonHtml = isAdminOnly
      ? '<a href="/dashboard" class="px-6 py-2.5 rounded-xl bg-dark-700 border border-dark-600 text-gray-300 font-bold text-xs sm:text-sm hover:bg-dark-600 transition text-center">← Kembali ke Dashboard</a>'
      : '<a href="/dashboard" onclick="if(window.openAccountSubscription){window.openAccountSubscription();return false;}" class="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 text-black font-bold text-xs sm:text-sm shadow-lg shadow-emerald-500/20 hover:brightness-110 transition text-center">💎 Upgrade ke Bulanan / Lifetime</a>';

    container.innerHTML = [
      '<div class="analisis-paywall-gate p-8 sm:p-12 text-center rounded-2xl bg-gradient-to-b from-dark-800/90 to-dark-900/95 border border-amber-500/30 shadow-2xl max-w-xl mx-auto my-8 relative z-20 backdrop-blur-md">',
      '  <div class="w-14 h-14 mx-auto mb-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-2xl text-amber-400">',
      '    ' + icon,
      '  </div>',
      '  <span class="inline-block px-3 py-1 rounded-full text-[11px] font-bold tracking-wider uppercase bg-amber-500/15 text-amber-300 border border-amber-500/30 mb-3">',
      '    ' + badgeText,
      '  </span>',
      '  <h3 class="text-lg sm:text-xl font-bold text-white mb-2">',
      '    ' + escapeHtml(title),
      '  </h3>',
      '  <p class="text-xs sm:text-sm text-gray-400 leading-relaxed max-w-md mx-auto mb-6">',
      '    ' + escapeHtml(description),
      '  </p>',
      '  <div class="flex flex-col sm:flex-row items-center justify-center gap-3">',
      '    ' + buttonHtml,
      '  </div>',
      '  <p class="text-[11px] text-gray-500 mt-4">',
      '    ' + (isAdminOnly ? 'Halaman ini dilindungi otentikasi khusus administrator.' : 'Sudah berlangganan? Pastikan Anda sudah login dengan akun aktif Anda.'),
      '  </p>',
      '</div>'
    ].join('');
  }
  root.renderTabPaywall = renderTabPaywall;

  function updateRankingPaywallUi() {
    var isLoading = window.premiumAccessState && window.premiumAccessState.state === 'loading';
    if (isLoading) return;
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
    if (!window.premiumAccessState || window.premiumAccessState.state !== 'ready') {
      window.premiumAccessState = { state: 'loading' };
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
  var _activeAnalisisAbortController = null;
  var ANALISIS_REQUEST_TIMEOUT_MS = 70000;

  function describeAnalisisFailure(response, data, error) {
    var code = data && data.code;
    var status = response ? response.status : 0;
    if (error && error.name === 'AbortError') return { retryable: true, text: 'Analisis dihentikan atau digantikan request baru.' };
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

    // Cancel any previous in-flight AI analysis immediately
    if (_activeAnalisisAbortController) {
      try { _activeAnalisisAbortController.abort(); } catch (_) {}
      _activeAnalisisAbortController = null;
    }

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
      _activeAnalisisAbortController = controller;
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
        var html = rawOutput.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
        // F-086: index.html always sanitizes AI HTML before the bold transform;
        // this was the only AI sink that skipped it. Sanitize first, then bold.
        if (typeof sanitizeAIHtml === 'function') html = sanitizeAIHtml(html);
        html = convertStrayMarkdownBold(html);
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
      if (e && e.name === 'AbortError' && isStaleRun()) return;
      renderAnalisisFailure(resultArea, describeAnalisisFailure(null, {}, e));
    } finally {
      if (_activeAnalisisAbortController === controller) {
        _activeAnalisisAbortController = null;
      }
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
  var analysisMountInput = null;
  var analysisAccessListenerBound = false;
  function initStandaloneAnalisisPage() {
    // The SPA runtime also loads before its partial. Do not request data for
    // unmounted UI, or bind another premium listener every time a tab opens.
    var mountInput = byId('analisisInput');
    if (!mountInput || analysisMountInput === mountInput) return;
    analysisMountInput = mountInput;
    verifySubscriptionStatus();
    checkPatternTabVisibility();

    try {
      if (!analysisAccessListenerBound) window.addEventListener('autocuan:premium-access', function (ev) {
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
      analysisAccessListenerBound = true;
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

    ['bandarTickerSearchInput', 'akumulasiTickerSearchInput', 'bandarSummarySearchInput', 'rankingTickerSearchInput', 'financialTickerInput', 'marketStructureTickerInput', 'patternTickerSearchInput'].forEach(function (id) {
      var el = byId(id);
      if (el) el.value = initialTicker;
    });

    // Debounce (300ms) input pencarian ticker utama agar UI sinkron secara mulus tanpa lag
    var analisisInputEl = byId('analisisInput');
    if (analisisInputEl && !analisisInputEl.__boundDebounce && typeof analisisInputEl.addEventListener === 'function') {
      analisisInputEl.__boundDebounce = true;
      var _analisisInputDebounceTimer = null;
      analisisInputEl.addEventListener('input', function (e) {
        if (_analisisInputDebounceTimer) clearTimeout(_analisisInputDebounceTimer);
        var val = (e.target && e.target.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        _analisisInputDebounceTimer = setTimeout(function () {
          var badge = byId('unifiedActiveTickerBadge');
          if (badge && val) badge.textContent = val;
        }, 300);
      });
    }

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

  function sanitizeUsername(val) {
    if (!val) return 'guest';
    if (typeof val === 'object') {
      var cand = val.username || val.user || val.name || val.email || 'guest';
      return typeof cand === 'string' ? sanitizeUsername(cand) : 'guest';
    }
    var str = String(val).trim();
    if (!str || str === 'null' || str === 'undefined') return 'guest';
    if (str.startsWith('{') && str.endsWith('}')) {
      try {
        var parsed = JSON.parse(str);
        if (parsed && typeof parsed === 'object') {
          if (parsed.role === 'ADMIN' || parsed.isAdmin === true) {
            try { localStorage.setItem('autocuan_is_admin', 'true'); } catch (_) {}
          }
          var extracted = parsed.username || parsed.user || parsed.name || parsed.email || 'guest';
          try { localStorage.setItem('autocuan_user', String(extracted).trim()); } catch (_) {}
          return String(extracted).trim();
        }
      } catch (_) {}
      return 'guest';
    }
    return str.replace(/[^\w\s@.-]/gi, '').slice(0, 50) || 'guest';
  }
  root.sanitizeUsername = sanitizeUsername;

  function syncHeaderUsername() {
    var u = 'guest';
    try {
      var raw = localStorage.getItem('autocuan_user') || '';
      u = sanitizeUsername(raw).trim();
    } catch (_) {}
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
  root.jalankanAnalisisSaham = function () {
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.handleUnifiedAnalisisSubmit === 'function') {
      root.UnifiedCockpit.handleUnifiedAnalisisSubmit();
    } else {
      var input = byId('analisisInput');
      var val = input ? input.value.trim() : '';
      if (val) root.runAnalisisFromDashboard(val);
    }
  };
  root.syncHeaderUsername = syncHeaderUsername;
  root.initStandaloneAnalisisPage = initStandaloneAnalisisPage;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStandaloneAnalisisPage);
  } else {
    initStandaloneAnalisisPage();
  }
})(typeof window !== 'undefined' ? window : globalThis);
