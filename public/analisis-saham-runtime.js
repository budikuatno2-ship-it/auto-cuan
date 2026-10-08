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
      return '<span class="text-gray-500">—</span>';
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

    var html = '<table class="w-full text-xs border-collapse tabular-nums lining-nums">';
    html += '<thead class="sticky top-0 z-10 bg-dark-800/95 backdrop-blur"><tr class="border-b border-dark-600/30">';
    html += '<th class="px-2 py-2 text-center font-medium text-gray-500 w-10">#</th>';
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

    filtered.forEach(function (row, idx) {
      var isSelected = rankingState.selectedTicker && row.ticker === rankingState.selectedTicker;
      html += '<tr class="border-b border-dark-600/10 hover:bg-dark-600/20 transition cursor-pointer ' +
        (isSelected ? 'bg-emerald-500/10' : '') + '" onclick="quickAnalisis(\'' + escapeHtml(row.ticker) + '\')" title="Analisis ' + escapeHtml(row.ticker) + '">';
      html += '<td class="px-2 py-1.5 text-center text-gray-400 font-mono text-[11px] tabular-nums">' + (idx + 1) + '</td>';
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
    } else if (parentTab === 'financial' || parentTab === 'market-structure') {
      var activeResearchTicker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
        ? root.UnifiedCockpit.getActiveTicker() : (root.activeTicker || 'BBCA');
      root.loadFinancialStructureTab(parentTab, activeResearchTicker);
      if (parentTab === 'market-structure' && root.AutoCuanMarketStructure && typeof root.AutoCuanMarketStructure.loadUniverse === 'function') {
        root.AutoCuanMarketStructure.loadUniverse();
      }
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

  function formatIndonesianDateWithWib(isoStr) {
    if (!isoStr) return '—';
    if (typeof isoStr !== 'string') return String(isoStr);
    var cleanStr = isoStr.replace(/\s*WIB$/i, '').trim();
    var d = new Date(cleanStr);
    if (isNaN(d.getTime())) return isoStr;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    var day = ('0' + d.getDate()).slice(-2);
    var month = months[d.getMonth()];
    var year = d.getFullYear();
    if (isoStr.indexOf('T') !== -1 || isoStr.indexOf(':') !== -1) {
      var hours = ('0' + d.getHours()).slice(-2);
      var minutes = ('0' + d.getMinutes()).slice(-2);
      return day + ' ' + month + ' ' + year + ', ' + hours + ':' + minutes + ' WIB';
    }
    return day + ' ' + month + ' ' + year;
  }

  function formatIndonesianSharesCount(val) {
    if (!researchHasNumber(val)) return '—';
    var n = Number(val);
    if (n >= 1e12) {
      return (n / 1e12).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' triliun lembar';
    }
    if (n >= 1e9) {
      return (n / 1e9).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' miliar lembar';
    }
    if (n >= 1e6) {
      return (n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' juta lembar';
    }
    return n.toLocaleString('id-ID') + ' lembar';
  }

  function formatIndonesianMarketCap(val) {
    if (!researchHasNumber(val)) return '—';
    var n = Number(val);
    if (n >= 1e12) {
      return 'Rp ' + (n / 1e12).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' T';
    }
    if (n >= 1e9) {
      return 'Rp ' + (n / 1e9).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' M';
    }
    return 'Rp ' + n.toLocaleString('id-ID');
  }

  function formatMarketStructureStatus(status) {
    switch (status) {
      case 'STRUCTURE_VERIFIED': return 'Struktur Terverifikasi';
      case 'HIGH_SHAREHOLDING_CONCENTRATION': return 'Konsentrasi Kepemilikan Tinggi';
      case 'LOW_FREE_FLOAT': return 'Free Float Rendah';
      case 'DATA_INCOMPLETE': return 'Data Belum Lengkap';
      case 'NORMAL': return 'Normal';
      case 'CAUTION': return 'Perhatian';
      case 'WATCHLIST': return 'Pantauan';
      case 'NOT_EVALUATED': return 'Belum Dievaluasi';
      default: return status ? String(status).replace(/_/g, ' ') : 'Belum Dievaluasi';
    }
  }

  function formatMarketStructureGuard(guard) {
    switch (guard) {
      case 'NORMAL': return 'Normal';
      case 'CAUTION': return 'Perhatian';
      case 'RESTRICTED': return 'Terbatas';
      case 'HIGH_RISK': return 'Risiko Tinggi';
      case 'UNKNOWN':
      case 'NOT_EVALUATED': return 'Belum Dievaluasi';
      default: return guard ? String(guard).replace(/_/g, ' ') : 'Belum Dievaluasi';
    }
  }

  function formatComplianceStatus(status) {
    switch (status) {
      case 'NOT_EVALUATED': return 'Belum Dievaluasi';
      case 'COMPLIANT': return 'Memenuhi Acuan';
      case 'NON_COMPLIANT': return 'Di Bawah Acuan';
      default: return status ? String(status).replace(/_/g, ' ') : 'Belum Dievaluasi';
    }
  }

  function formatHscStatus(flag) {
    if (flag === true) return 'HSC Aktif';
    if (flag === false) return 'Tidak Terindikasi HSC';
    return 'Belum Terverifikasi';
  }

  function researchHasNumber(value) {
    return value != null && String(value).trim() !== '' && Number.isFinite(Number(value));
  }

  // ===== FINANCIAL STATEMENTS CONTROLLER (WAVE 4B, §79.2, §26) =====
  var AutoCuanFinancialStatements = {
    activeMode: 'income', // 'income' | 'balance' | 'cashflow' | 'ratios'
    activePeriod: 'quarterly', // 'quarterly' | 'annual'
    currentTicker: null,
    statementsData: null,

    setStatementMode: function (mode) {
      if (!mode) return;
      this.activeMode = mode;
      var group = byId('financialStatementModeGroup');
      if (group) {
        var btns = group.querySelectorAll('button[data-statement-mode]');
        btns.forEach(function (btn) {
          var isTarget = btn.getAttribute('data-statement-mode') === mode;
          if (isTarget) {
            btn.classList.add('is-active');
            btn.setAttribute('aria-selected', 'true');
            btn.setAttribute('tabindex', '0');
          } else {
            btn.classList.remove('is-active');
            btn.setAttribute('aria-selected', 'false');
            btn.setAttribute('tabindex', '-1');
          }
        });
      }
      this.renderTable();
    },

    setPeriodMode: function (period) {
      if (!period) return;
      this.activePeriod = period;
      var group = byId('financialPeriodModeGroup');
      if (group) {
        var btns = group.querySelectorAll('button[data-period-mode]');
        btns.forEach(function (btn) {
          var isTarget = btn.getAttribute('data-period-mode') === period;
          if (isTarget) {
            btn.classList.add('is-active');
            btn.setAttribute('aria-pressed', 'true');
          } else {
            btn.classList.remove('is-active');
            btn.setAttribute('aria-pressed', 'false');
          }
        });
      }
      this.renderTable();
    },

    loadStatements: function (ticker, context) {
      this.currentTicker = ticker;
      this.statementsData = this.normalizeStatements(context);
      this.renderTable();
    },

    normalizeStatements: function (context) {
      if (!context) return null;
      var raw = context.financial_statements || context.statements || (context.fundamental && context.fundamental.statements) || null;
      if (!raw) return null;

      return {
        quarterly: raw.quarterly || null,
        annual: raw.annual || null,
        source: raw.source || (context.fundamental && context.fundamental.fundamental_source) || 'IDX Financial Statement',
        updated_at: raw.updated_at || (context.fundamental && context.fundamental.fundamental_updated_at) || null
      };
    },

    renderTable: function () {
      var wrap = byId('financialStatementsTableWrap');
      var unavailable = byId('financialStatementUnavailable');
      var unavailTitle = byId('financialStatementUnavailableTitle');
      var unavailDesc = byId('financialStatementUnavailableDesc');
      var thead = byId('financialStatementsTableHead');
      var tbody = byId('financialStatementsTableBody');

      var catLabel = byId('financialStatementCategoryLabel');
      var freqLabel = byId('financialStatementFrequencyLabel');
      var unitLabel = byId('financialStatementUnitLabel');

      var mode = this.activeMode;
      var period = this.activePeriod;

      var modeName = mode === 'income' ? 'Laba Rugi' : (mode === 'balance' ? 'Neraca' : (mode === 'cashflow' ? 'Arus Kas' : 'Rasio'));
      var periodName = period === 'quarterly' ? 'Kuartalan' : 'Tahunan';

      if (catLabel) catLabel.textContent = modeName;
      if (freqLabel) freqLabel.textContent = periodName;
      if (unitLabel) unitLabel.textContent = mode === 'ratios' ? 'Rasio & Kelipatan' : 'Miliar IDR (kecuali rasio & EPS)';

      var periodData = this.statementsData ? this.statementsData[period] : null;
      var statementKey = mode === 'income' ? 'income_statement' : (mode === 'balance' ? 'balance_sheet' : (mode === 'cashflow' ? 'cash_flow' : 'ratios'));
      var statement = periodData ? (periodData[statementKey] || (mode === 'ratios' ? periodData.ratios : null)) : null;

      var hasData = statement && Array.isArray(statement.rows) && statement.rows.length > 0 && Array.isArray(statement.periods) && statement.periods.length > 0;

      if (!hasData) {
        if (wrap) wrap.hidden = true;
        if (unavailable) {
          unavailable.hidden = false;
          if (unavailTitle) unavailTitle.textContent = 'Data ' + modeName + ' rinci belum tersedia';
          if (unavailDesc) unavailDesc.textContent = 'Belum ada data laporan ' + modeName.toLowerCase() + ' resmi untuk mode ' + periodName.toLowerCase() + '. Data snapshot di atas tetap aktif dan valid.';
        }
        return;
      }

      if (unavailable) unavailable.hidden = true;
      if (wrap) wrap.hidden = false;

      // Render <thead>
      if (thead) {
        var headerHtml = '<tr><th scope="col" style="text-align: left;">Komponen</th>';
        statement.periods.forEach(function (p) {
          headerHtml += '<th scope="col">' + escapeHtml(p) + '</th>';
        });
        headerHtml += '</tr>';
        thead.innerHTML = headerHtml;
      }

      // Render <tbody>
      if (tbody) {
        tbody.innerHTML = '';
        var frag = document.createDocumentFragment();

        statement.rows.forEach(function (row) {
          var tr = document.createElement('tr');
          if (row.type === 'group') {
            tr.className = 'ac-fin-row-group';
            var td = document.createElement('td');
            td.setAttribute('colspan', String(statement.periods.length + 1));
            var stickyDiv = document.createElement('div');
            stickyDiv.className = 'ac-fin-group-label-sticky';
            var span = document.createElement('span');
            span.className = 'ac-fin-group-title';
            span.textContent = (row.label && row.label.startsWith('▸') ? '' : '▸ ') + row.label;
            stickyDiv.appendChild(span);
            td.appendChild(stickyDiv);
            tr.appendChild(td);
          } else {
            tr.className = row.type === 'total' ? 'ac-fin-row-total' : 'ac-fin-row-child';
            var tdLabel = document.createElement('td');
            tdLabel.textContent = row.label;
            tr.appendChild(tdLabel);

            var values = Array.isArray(row.values) ? row.values : [];
            for (var i = 0; i < statement.periods.length; i++) {
              var val = values[i];
              var tdVal = document.createElement('td');

              if (val == null || val === '—' || val === '') {
                tdVal.textContent = '—';
                tdVal.style.color = 'var(--ac-text-muted)';
              } else if (typeof val === 'number') {
                var isNegative = val < 0;
                var formatted = '';
                if (row.unit === 'pct' || row.unit === '%') {
                  formatted = val.toFixed(2) + '%';
                } else if (row.unit === 'x') {
                  formatted = val.toFixed(2) + 'x';
                } else if (row.unit === 'idr' || row.unit === 'currency') {
                  formatted = (isNegative ? '(' : '') + Math.abs(val).toLocaleString('id-ID') + (isNegative ? ')' : '');
                } else {
                  formatted = (isNegative ? '(' : '') + Math.abs(val).toLocaleString('id-ID') + (isNegative ? ')' : '');
                }

                if (isNegative) {
                  tdVal.innerHTML = '<span class="ac-fin-negative">' + escapeHtml(formatted) + '</span>';
                } else {
                  // Normal positive ink - never globally forced green!
                  tdVal.textContent = formatted;
                }
              } else {
                var strVal = String(val);
                if (strVal.startsWith('-') || strVal.startsWith('(')) {
                  tdVal.innerHTML = '<span class="ac-fin-negative">' + escapeHtml(strVal) + '</span>';
                } else {
                  tdVal.textContent = strVal;
                }
              }

              tr.appendChild(tdVal);
            }
          }
          frag.appendChild(tr);
        });

        tbody.appendChild(frag);
      }

      var wrap = byId('financialStatementsTableWrap');
      var hint = byId('financialScrollHint');
      if (wrap && hint && typeof wrap.addEventListener === 'function' && !wrap._hasScrollHintListener) {
        wrap._hasScrollHintListener = true;
        wrap.addEventListener('scroll', function () {
          if (wrap.scrollLeft > 24) {
            hint.classList.add('is-scrolled');
          } else {
            hint.classList.remove('is-scrolled');
          }
        }, { passive: true });
      }
    }
  };
  root.AutoCuanFinancialStatements = AutoCuanFinancialStatements;

  if (typeof document !== 'undefined') {
    var initTablistNav = function () {
      var stmtGroup = byId('financialStatementModeGroup');
      if (stmtGroup && typeof stmtGroup.addEventListener === 'function' && !stmtGroup._hasKeyNav) {
        stmtGroup._hasKeyNav = true;
        stmtGroup.addEventListener('keydown', function (e) {
          if (!e || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
          if (typeof stmtGroup.querySelectorAll !== 'function') return;
          var tabs = Array.from(stmtGroup.querySelectorAll('button[data-statement-mode]'));
          var activeTab = typeof stmtGroup.querySelector === 'function' ? stmtGroup.querySelector('button[data-statement-mode].is-active') : null;
          var idx = tabs.indexOf(activeTab);
          if (idx === -1) return;
          if (typeof e.preventDefault === 'function') e.preventDefault();
          var nextIdx = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
          var nextTab = tabs[nextIdx];
          if (nextTab) {
            if (typeof nextTab.focus === 'function') nextTab.focus();
            var mode = nextTab.getAttribute('data-statement-mode');
            AutoCuanFinancialStatements.setStatementMode(mode);
          }
        });
      }
    };
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', initTablistNav);
    } else {
      initTablistNav();
    }
  }

  var financialSnapshotCache = {};
  var researchGeneration = 0;
  async function loadFinancialStructureTab(tabName, rawTicker) {
    var generation = ++researchGeneration;
    var ticker = researchTicker(rawTicker || (root.UnifiedCockpit && root.UnifiedCockpit.getActiveTicker ? root.UnifiedCockpit.getActiveTicker() : root.activeTicker));
    if (!ticker) return;

    root.activeTicker = ticker;
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(ticker, { loadChart: false, preserveTab: true, runAnalysis: false });
    }
    var financialInput = byId('financialTickerInput');
    var marketInput = byId('marketStructureTickerInput');
    if (financialInput) financialInput.value = ticker;
    if (marketInput) marketInput.value = ticker;

    var isFinancial = tabName === 'financial';
    var state = byId(isFinancial ? 'financialDataState' : 'marketStructureDataState');
    var content = byId(isFinancial ? 'financialDataContent' : 'marketStructureDataContent');
    var unavailable = isFinancial ? byId('financialDataUnavailable') : null;

    if (state) {
      state.hidden = false;
      state.textContent = 'Memuat ' + ticker + '…';
    }
    if (isFinancial) {
      var initBadge = byId('financialStatusBadge');
      if (initBadge) {
        initBadge.textContent = 'Memuat...';
        initBadge.className = 'ac-status-badge ac-status-badge--neutral';
      }
      researchText('financialCoverage', '— / 4');
    }
    if (content) content.hidden = true;
    if (unavailable) unavailable.hidden = true;

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
      var m = ctx.market_structure || {};

      if (isFinancial) {
        var hasPbv = researchHasNumber(f.pbv);
        var hasBvps = researchHasNumber(f.book_value_per_share);
        var hasShares = researchHasNumber(f.shares_outstanding);
        var hasMarketCap = researchHasNumber(f.market_cap);
        var coverageCount = (hasPbv ? 1 : 0) + (hasBvps ? 1 : 0) + (hasShares ? 1 : 0) + (hasMarketCap ? 1 : 0);

        if (coverageCount === 0) {
          if (unavailable) unavailable.hidden = false;
          if (content) content.hidden = true;
          if (state) state.hidden = true;
          return;
        }

        financialSnapshotCache[ticker] = {
          ticker: ticker,
          fundamental: f,
          context: ctx,
          timestamp: Date.now()
        };

        if (unavailable) unavailable.hidden = true;
        researchText('financialTickerBadge', ticker);
        var companyNameEl = byId('financialCompanyName');
        if (companyNameEl) {
          companyNameEl.textContent = f.company_name || ('PT ' + ticker + ' Tbk');
        }
        researchText('financialPbv', hasPbv ? researchNumber(f.pbv, 2) + 'x' : '—');
        researchText('financialPbvPrice', researchHasNumber(f.pbv_as_of_price) ? 'Harga acuan ' + researchIdr(f.pbv_as_of_price) : 'Harga acuan —');
        researchText('financialBvps', hasBvps ? researchIdr(f.book_value_per_share) : '—');
        researchText('financialShares', researchHasNumber(f.shares_outstanding) ? formatIndonesianSharesCount(f.shares_outstanding) : '—');
        var mCapEl = byId('financialMarketCap');
        if (mCapEl) {
          mCapEl.textContent = researchHasNumber(f.market_cap) ? formatIndonesianMarketCap(f.market_cap) : '—';
          if (researchHasNumber(f.market_cap)) {
            mCapEl.title = 'Rp ' + Number(f.market_cap).toLocaleString('id-ID');
          }
        }
        researchText('financialMarketCapAsOf', f.market_cap_as_of ? 'Per ' + formatIndonesianDateWithWib(f.market_cap_as_of) : 'Belum tersedia');
        researchText('financialPeriod', f.fundamental_period || 'Belum tersedia');
        researchText('financialPeriodHero', f.fundamental_period ? 'Periode ' + f.fundamental_period : 'Periode belum tersedia');
        researchText('financialSource', f.fundamental_source || 'Belum tersedia');
        researchText('financialMarketCapSource', f.market_cap_source || 'Belum tersedia');
        researchText('financialUpdatedAt', f.fundamental_updated_at ? formatIndonesianDateWithWib(f.fundamental_updated_at) : 'Belum tersedia');

        researchText('financialCoverage', coverageCount + ' / 4');
        var coverageBar = byId('financialCoverageBar');
        if (coverageBar && coverageBar.style && coverageBar.style.setProperty) {
          coverageBar.style.setProperty('--ac-financial-coverage', (coverageCount * 25) + '%');
        }
        var statusBadge = byId('financialStatusBadge');
        if (statusBadge) {
          var hasVerifiedProvenance = Boolean(f.verified || f.provenance_verified);
          if (hasVerifiedProvenance) {
            statusBadge.textContent = 'Snapshot Terverifikasi';
            statusBadge.className = 'ac-status-badge ac-status-badge--positive';
          } else if (coverageCount >= 4) {
            statusBadge.textContent = 'Data Lengkap 4/4';
            statusBadge.className = 'ac-status-badge ac-status-badge--positive';
          } else if (coverageCount > 0) {
            statusBadge.textContent = 'Sebagian Lengkap ' + coverageCount + '/4';
            statusBadge.className = 'ac-status-badge ac-status-badge--warning';
          } else {
            statusBadge.textContent = 'Data Belum Lengkap';
            statusBadge.className = 'ac-status-badge ac-status-badge--neutral';
          }
        }

        // Load and render multi-period detailed statements (Wave 4B, §79.2, §26)
        if (root.AutoCuanFinancialStatements && typeof root.AutoCuanFinancialStatements.loadStatements === 'function') {
          root.AutoCuanFinancialStatements.loadStatements(ticker, ctx);
        }
      } else {
        researchText('marketStructureFreeFloat', researchHasNumber(m.free_float_pct) ? researchNumber(m.free_float_pct, 2) + '%' : '—');
        researchText('marketStructureFreeFloatAsOf', m.free_float_as_of ? 'Per ' + formatIndonesianDateWithWib(m.free_float_as_of) : 'Per —');
        researchText('marketStructureHsc', formatHscStatus(m.hsc_flag));
        researchText('marketStructureHscAsOf', m.hsc_as_of ? 'Per ' + formatIndonesianDateWithWib(m.hsc_as_of) : 'Per —');
        researchText('marketStructureGuard', formatMarketStructureGuard(m.market_structure_guard));
        researchText('marketStructureStatus', formatMarketStructureStatus(m.market_structure_status));
        researchText('marketStructureFreeFloatSource', m.free_float_source || 'Belum tersedia');
        researchText('marketStructureHscSource', m.hsc_source || 'Belum tersedia');
        researchText('marketStructureReference', researchHasNumber(m.low_free_float_reference_pct) ? researchNumber(m.low_free_float_reference_pct, 0) + '%' : '15%');
        researchText('marketStructureCompliance', formatComplianceStatus(m.regulatory_compliance_status));
        researchText('marketStructureNote', m.market_structure_note || 'Data struktur pasar belum lengkap.');

        if (root.AutoCuanMarketStructure && typeof root.AutoCuanMarketStructure.selectRow === 'function') {
          root.AutoCuanMarketStructure.selectRow(ticker, false);
        }
      }

      if (state) state.hidden = true;
      if (content) {
        content.hidden = false;
        if (root.AutoCuanFinalUiux && typeof root.AutoCuanFinalUiux.enterPanel === 'function') {
          root.AutoCuanFinalUiux.enterPanel(content);
        }
      }
    } catch (error) {
      if (generation !== researchGeneration) return;
      if (isFinancial && financialSnapshotCache[ticker]) {
        if (state) {
          state.hidden = false;
          state.textContent = 'Gagal memperbarui data: mempertahankan snapshot terakhir.';
        }
        if (content) content.hidden = false;
        if (typeof root.showToast === 'function') {
          root.showToast('Gagal memuat snapshot baru: menampilkan snapshot terakhir untuk ' + ticker, 'warning');
        }
        return;
      }
      if (state) {
        state.hidden = false;
        state.textContent = (error && error.message) || 'Gagal memuat data.';
      }
      if (content) content.hidden = true;
      if (unavailable) unavailable.hidden = true;
    }
  }
  root.loadFinancialStructureTab = loadFinancialStructureTab;

  // ===== AUTO-CUAN MARKET STRUCTURE CONTROLLER (WAVE 4, §79.3, LIST-FIRST) =====
  var AutoCuanMarketStructure = {
    universe: [],
    filteredUniverse: [],
    activeFilter: 'all',
    searchQuery: '',
    sortKey: 'ticker_asc',
    selectedTicker: null,
    lastSelectedRowEl: null,
    isLoading: false,
    hasLoaded: false,

    loadUniverse: async function (force) {
      if (this.isLoading) return;
      if (this.hasLoaded && !force) {
        if (!this.selectedTicker) {
          var curTicker = (root.UnifiedCockpit && root.UnifiedCockpit.getActiveTicker) ? root.UnifiedCockpit.getActiveTicker() : root.activeTicker;
          if (curTicker) this.selectRow(curTicker, false);
        }
        return;
      }

      this.isLoading = true;
      var skeleton = byId('marketStructureTableSkeleton');
      var wrap = byId('marketStructureTableWrap');
      var errBox = byId('marketStructureTableError');
      var emptyBox = byId('marketStructureTableEmpty');

      if (skeleton) skeleton.hidden = false;
      if (wrap) wrap.style.opacity = '0.5';
      if (errBox) errBox.hidden = true;
      if (emptyBox) emptyBox.hidden = true;

      try {
        var response = await fetch('/api/quote?action=daily-market-context-list', {
          credentials: 'same-origin',
          cache: 'no-store'
        });
        var payload = await response.json().catch(function () { return {}; });
        var list = Array.isArray(payload.universe) ? payload.universe : (Array.isArray(payload.rows) ? payload.rows : (Array.isArray(payload.data) ? payload.data : null));
        if (!response.ok || !payload.success || !list) {
          throw new Error(payload.error || 'Gagal memuat universe struktur pasar.');
        }

        this.universe = list;
        this.hasLoaded = true;
        this.applyFilters();

        var targetTicker = this.selectedTicker || (root.UnifiedCockpit && root.UnifiedCockpit.getActiveTicker ? root.UnifiedCockpit.getActiveTicker() : root.activeTicker) || (this.universe[0] && this.universe[0].ticker);
        if (targetTicker) {
          this.selectRow(targetTicker, false);
        }
      } catch (err) {
        if (errBox) {
          errBox.hidden = false;
          var msg = byId('marketStructureErrorMessage');
          if (msg) msg.textContent = (err && err.message) || 'Terjadi kendala saat mengambil data snapshot struktur pasar.';
        }
      } finally {
        this.isLoading = false;
        if (skeleton) skeleton.hidden = true;
        if (wrap) wrap.style.opacity = '1';
      }
    },

    setFilter: function (filterKey) {
      this.activeFilter = filterKey;
      var group = byId('marketStructureFilterGroup');
      if (group) {
        var btns = group.querySelectorAll('button[data-filter]');
        btns.forEach(function (btn) {
          if (btn.getAttribute('data-filter') === filterKey) {
            btn.classList.add('is-active');
          } else {
            btn.classList.remove('is-active');
          }
        });
      }
      this.applyFilters();
    },

    setSort: function (sortKey) {
      this.sortKey = sortKey;
      this.applyFilters();
    },

    onSearchInput: function (val) {
      this.searchQuery = String(val || '').trim().toLowerCase();
      this.applyFilters();
    },

    resetFilters: function () {
      this.searchQuery = '';
      this.activeFilter = 'all';
      this.sortKey = 'ticker_asc';
      var inp = byId('marketStructureSearchInput');
      if (inp) inp.value = '';
      var sel = byId('marketStructureSortSelect');
      if (sel) sel.value = 'ticker_asc';
      this.setFilter('all');
    },

    applyFilters: function () {
      var q = this.searchQuery;
      var f = this.activeFilter;
      var sort = this.sortKey;

      var rows = this.universe.slice();

      // 1. Search Query
      if (q) {
        rows = rows.filter(function (r) {
          var t = (r.ticker || '').toLowerCase();
          var name = (r.company_name || '').toLowerCase();
          var sec = (r.sector || '').toLowerCase();
          return t.indexOf(q) !== -1 || name.indexOf(q) !== -1 || sec.indexOf(q) !== -1;
        });
      }

      // 2. Filter Rules
      if (f === 'low_ff') {
        rows = rows.filter(function (r) {
          return r.free_float_pct != null && Number.isFinite(Number(r.free_float_pct)) && Number(r.free_float_pct) < 15;
        });
      } else if (f === 'hsc') {
        rows = rows.filter(function (r) {
          return r.hsc_flag === true;
        });
      } else if (f === 'incomplete') {
        rows = rows.filter(function (r) {
          return r.free_float_pct == null || !Number.isFinite(Number(r.free_float_pct)) || r.hsc_flag == null || r.market_structure_status === 'DATA_INCOMPLETE';
        });
      }

      // 3. Sorting (missing numbers sorted at end, never coerced to 0)
      rows.sort(function (a, b) {
        if (sort === 'ticker_asc') {
          return (a.ticker || '').localeCompare(b.ticker || '');
        }
        if (sort === 'ff_asc') {
          var aHas = a.free_float_pct != null && Number.isFinite(Number(a.free_float_pct));
          var bHas = b.free_float_pct != null && Number.isFinite(Number(b.free_float_pct));
          if (!aHas && !bHas) return 0;
          if (!aHas) return 1;
          if (!bHas) return -1;
          return Number(a.free_float_pct) - Number(b.free_float_pct);
        }
        if (sort === 'ff_desc') {
          var aHas = a.free_float_pct != null && Number.isFinite(Number(a.free_float_pct));
          var bHas = b.free_float_pct != null && Number.isFinite(Number(b.free_float_pct));
          if (!aHas && !bHas) return 0;
          if (!aHas) return 1;
          if (!bHas) return -1;
          return Number(b.free_float_pct) - Number(a.free_float_pct);
        }
        if (sort === 'status') {
          return (a.market_structure_status || '').localeCompare(b.market_structure_status || '');
        }
        return 0;
      });

      this.filteredUniverse = rows;
      this.renderTable();
    },

    renderTable: function () {
      var tbody = byId('marketStructureTableBody');
      var emptyBox = byId('marketStructureTableEmpty');
      var countText = byId('marketStructureCountText');

      if (countText) {
        countText.textContent = this.filteredUniverse.length + ' Saham';
      }

      if (!tbody) return;
      tbody.innerHTML = '';

      if (this.filteredUniverse.length === 0) {
        if (emptyBox) emptyBox.hidden = false;
        return;
      }
      if (emptyBox) emptyBox.hidden = true;

      var self = this;
      var frag = document.createDocumentFragment();

      this.filteredUniverse.forEach(function (row) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-ticker', row.ticker);
        tr.setAttribute('tabindex', '0');
        tr.setAttribute('role', 'button');
        tr.setAttribute('aria-label', 'Pilih saham ' + row.ticker);

        if (self.selectedTicker === row.ticker) {
          tr.classList.add('is-selected');
          self.lastSelectedRowEl = tr;
        }

        tr.onclick = function () {
          self.selectRow(row.ticker, true);
        };
        tr.onkeydown = function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            self.selectRow(row.ticker, true);
          }
        };

        var tdTicker = document.createElement('td');
        tdTicker.innerHTML = '<span class="ac-ticker-symbol">' + escapeHtml(row.ticker) + '</span>' +
          (row.company_name ? '<span class="ac-company-sub">' + escapeHtml(row.company_name) + '</span>' : '');
        tr.appendChild(tdTicker);

        var tdFf = document.createElement('td');
        tdFf.style.textAlign = 'right';
        var hasFf = row.free_float_pct != null && Number.isFinite(Number(row.free_float_pct));
        var ffVal = hasFf ? Number(row.free_float_pct) : null;
        var ffHtml = hasFf ? '<span class="ac-num ' + (ffVal < 15 ? 'text-amber-400 font-semibold' : '') + '">' + ffVal.toFixed(2) + '%</span>' : '<span class="text-gray-500">—</span>';
        tdFf.innerHTML = ffHtml;
        tr.appendChild(tdFf);

        var tdHsc = document.createElement('td');
        var hscHtml = row.hsc_flag === true
          ? '<span class="ac-status-badge ac-status-badge--negative">HSC Aktif</span>'
          : (row.hsc_flag === false
            ? '<span class="ac-status-badge ac-status-badge--positive">Tidak Terindikasi HSC</span>'
            : '<span class="ac-status-badge ac-status-badge--neutral">Belum Lengkap</span>');
        tdHsc.innerHTML = hscHtml;
        tr.appendChild(tdHsc);

        var tdStatus = document.createElement('td');
        var st = row.market_structure_status || 'DATA_INCOMPLETE';
        var stLabel = formatMarketStructureStatus(st);
        var stBadge = (st === 'NORMAL' || st === 'STRUCTURE_VERIFIED')
          ? '<span class="ac-status-badge ac-status-badge--positive">' + escapeHtml(stLabel) + '</span>'
          : ((st === 'CAUTION' || st === 'WATCHLIST' || st === 'LOW_FREE_FLOAT' || st === 'HIGH_SHAREHOLDING_CONCENTRATION')
            ? '<span class="ac-status-badge ac-status-badge--warning">' + escapeHtml(stLabel) + '</span>'
            : '<span class="ac-status-badge ac-status-badge--neutral">' + escapeHtml(stLabel) + '</span>');
        tdStatus.innerHTML = stBadge;
        tr.appendChild(tdStatus);

        var tdDate = document.createElement('td');
        tdDate.style.fontSize = '11.5px';
        tdDate.style.color = 'var(--ac-text-secondary)';
        tdDate.textContent = formatIndonesianDateWithWib(row.free_float_as_of || row.updated_at || '—');
        tr.appendChild(tdDate);

        frag.appendChild(tr);
      });

      tbody.appendChild(frag);
    },

    selectRow: function (ticker, userInitiated) {
      if (!ticker) return;
      this.selectedTicker = ticker;

      var tbody = byId('marketStructureTableBody');
      if (tbody) {
        var rows = tbody.querySelectorAll('tr');
        rows.forEach(function (r) {
          if (r.getAttribute('data-ticker') === ticker) {
            r.classList.add('is-selected');
          } else {
            r.classList.remove('is-selected');
          }
        });
      }

      var activeRow = tbody ? tbody.querySelector('tr[data-ticker="' + ticker + '"]') : null;
      if (activeRow) {
        this.lastSelectedRowEl = activeRow;
      }

      var row = this.universe.find(function (r) { return r.ticker === ticker; }) || { ticker: ticker };

      var paneTicker = byId('marketStructureDetailTicker');
      if (paneTicker) paneTicker.textContent = ticker;
      var paneCompany = byId('marketStructureDetailCompanyName');
      if (paneCompany) paneCompany.textContent = row.company_name || ('PT ' + ticker + ' Tbk');

      var guardBadge = byId('marketStructureDetailGuardBadge');
      var guard = row.market_structure_guard || 'UNKNOWN';
      var guardLabel = formatMarketStructureGuard(guard);
      if (guardBadge) {
        guardBadge.textContent = guardLabel;
        guardBadge.className = 'ac-status-badge ' + (guard === 'NORMAL' ? 'ac-status-badge--positive' : (guard === 'RESTRICTED' || guard === 'HIGH_RISK' ? 'ac-status-badge--negative' : 'ac-status-badge--neutral'));
      }

      var hasFf = row.free_float_pct != null && Number.isFinite(Number(row.free_float_pct));
      researchText('marketStructureFreeFloat', hasFf ? Number(row.free_float_pct).toFixed(2) + '%' : '—');
      researchText('marketStructureFreeFloatAsOf', row.free_float_as_of ? 'Per ' + formatIndonesianDateWithWib(row.free_float_as_of) : 'Per —');
      researchText('marketStructureHsc', formatHscStatus(row.hsc_flag));
      researchText('marketStructureHscAsOf', row.hsc_as_of ? 'Per ' + formatIndonesianDateWithWib(row.hsc_as_of) : 'Per —');
      researchText('marketStructureGuard', guardLabel);
      researchText('marketStructureStatus', formatMarketStructureStatus(row.market_structure_status));
      researchText('marketStructureFreeFloatSource', row.free_float_source || 'IDX / KSEI');
      researchText('marketStructureHscSource', row.hsc_source || 'IDX');
      researchText('marketStructureReference', researchHasNumber(row.low_free_float_reference_pct) ? researchNumber(row.low_free_float_reference_pct, 0) + '%' : '15%');
      researchText('marketStructureCompliance', formatComplianceStatus(row.regulatory_compliance_status));
      researchText('marketStructureNote', row.market_structure_note || (hasFf && Number(row.free_float_pct) < 15 ? 'Free Float emiten berada di bawah batas referensi 15%. Likuiditas pasar dapat lebih tipis dari rata-rata.' : 'Data struktur kepemilikan terverifikasi dari keterbukaan IDX.'));

      var sheetTicker = byId('marketStructureSheetTicker');
      if (sheetTicker) sheetTicker.textContent = ticker;
      var sheetGuard = byId('marketStructureSheetGuardBadge');
      if (sheetGuard) {
        sheetGuard.textContent = guardLabel;
        sheetGuard.className = 'ac-status-badge ' + (guard === 'NORMAL' ? 'ac-status-badge--positive' : 'ac-status-badge--neutral');
      }
      var sheetBody = byId('marketStructureSheetBody');
      var deskBody = byId('marketStructureDetailBody');
      if (sheetBody && deskBody) {
        sheetBody.innerHTML = deskBody.innerHTML;
      }

      if (typeof window !== 'undefined' && window.innerWidth < 1024 && userInitiated) {
        var sheet = byId('marketStructureMobileSheet');
        if (sheet) {
          sheet.classList.add('is-open');
          var closeBtn = byId('marketStructureSheetCloseBtn');
          if (closeBtn) closeBtn.focus();
        }
      }

      if (userInitiated) {
        root.activeTicker = ticker;
        if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
          root.UnifiedCockpit.syncActiveTicker(ticker, { loadChart: false, preserveTab: true, runAnalysis: false });
        }
      }
    },

    closeDetail: function () {
      var sheet = byId('marketStructureMobileSheet');
      if (sheet) {
        sheet.classList.remove('is-open');
      }
      if (this.lastSelectedRowEl && typeof this.lastSelectedRowEl.focus === 'function') {
        this.lastSelectedRowEl.focus();
      }
    },

    bukaAnalisisSaham: function () {
      if (!this.selectedTicker) return;
      this.closeDetail();
      if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
        root.UnifiedCockpit.syncActiveTicker(this.selectedTicker, { loadChart: true, preserveTab: false });
      }
      if (typeof root.switchAnalisisTab === 'function') {
        root.switchAnalisisTab('analisis-chart');
      }
    }
  };

  root.AutoCuanMarketStructure = AutoCuanMarketStructure;

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
