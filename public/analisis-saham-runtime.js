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
  var RANKING_COLUMNS = [
    { key: 'ticker', label: 'Ticker', align: 'left', sortable: true },
    { key: 'last_price', label: 'Harga', align: 'right', fmt: root.mktCtxFmtPrice },
    { key: 'change_pct', label: 'Perubahan', align: 'right', fmt: root.mktCtxFmtPct, colorize: true },
    { key: 'rsi_14', label: 'RSI 14', align: 'right', fmt: function(v) { return Number(v).toFixed(1); } },
    { key: 'week52_high_dist_pct', label: 'Jarak 52W High', align: 'right', fmt: root.mktCtxFmtPct },
    { key: 'volume_ratio_vs_7d_avg', label: 'Vol vs 7D', align: 'right', fmt: root.mktCtxFmtRatio },
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

  // ===== SUB-TAB SWITCHER (POLA PORTFOLIO) =====
  function switchAnalisisTab(tabName) {
    var validTabs = ['analisis', 'chart', 'ranking'];
    if (validTabs.indexOf(tabName) < 0) tabName = 'analisis';

    document.querySelectorAll('.analisis-tab').forEach(function (btn) {
      var isActive = btn.dataset.tab === tabName;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    var pAnalisis = byId('panel-tab-analisis');
    var pChart = byId('panel-tab-chart');
    var pRanking = byId('panel-tab-ranking');

    if (pAnalisis) pAnalisis.style.display = (tabName === 'analisis' ? 'block' : 'none');
    if (pChart) pChart.style.display = (tabName === 'chart' ? 'block' : 'none');
    if (pRanking) pRanking.style.display = (tabName === 'ranking' ? 'block' : 'none');

    if (tabName === 'chart') {
      var ticker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
        ? root.UnifiedCockpit.getActiveTicker() : 'BBCA';
      if (root.UnifiedCockpit && typeof root.UnifiedCockpit.loadUnifiedChart === 'function') {
        root.UnifiedCockpit.loadUnifiedChart(ticker);
      }
      if (typeof setTimeout === 'function') {
        setTimeout(function () {
          try { window.dispatchEvent(new Event('resize')); } catch (_) {}
        }, 50);
      }
    } else if (tabName === 'ranking') {
      root.ensureRankingTableLoaded();
    }
  }
  root.switchAnalisisTab = switchAnalisisTab;

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
    if (isSubscribedUser()) {
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
          accessLevel: isAdmin ? 'admin' : (isPrem ? (ent.access_level || 'premium') : 'free')
        };
        updateRankingPaywallUi();
        return isPrem;
      }
    } catch (_) {}
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
    if (status === 401) return { retryable: false, text: 'Sesi kamu sudah berakhir. Silakan login kembali.' };
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
      (failure.retryable ? '<p class="text-xs text-gray-500">Kamu bisa mencoba lagi.</p>' : '') +
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
            chatMessage: ticker,
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
        resultArea.innerHTML = '<div class="ai-content bg-dark-700/40 border border-dark-600/20 rounded-2xl p-4 sm:p-5 fade-in-up">' + html + '</div>' +
          '<div class="mt-3 flex flex-wrap gap-2">' +
          '<button onclick="switchAnalisisTab(\'chart\')" class="px-3 py-1.5 rounded-lg text-xs text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/10 transition inline-flex items-center gap-1 font-semibold">📈 Buka Chart</button>' +
          '<button onclick="UnifiedCockpit.handleUnifiedChartAiSubmit()" class="px-3 py-1.5 rounded-lg text-xs text-blue-400 border border-blue-500/30 hover:bg-blue-500/10 transition inline-flex items-center gap-1 font-semibold">🤖 Analisis Chart (AI)</button>' +
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
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        root.showToast('Hasil analisis berhasil disalin ke clipboard.', 'good');
      }).catch(function () {
        root.showToast('Gagal menyalin hasil.', 'danger');
      });
    }
  };

  // ===== PAGE BOOTSTRAP =====
  function initStandaloneAnalisisPage() {
    verifySubscriptionStatus();

    try {
      window.addEventListener('autocuan:premium-access', function () {
        updateRankingPaywallUi();
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
    }

    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(initialTicker, {
        loadChart: true,
        forceChartReload: true,
        runAnalysis: Boolean(tickerParam)
      });
    }

    if (isSubscribedUser()) {
      root.ensureRankingTableLoaded();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStandaloneAnalisisPage);
  } else {
    initStandaloneAnalisisPage();
  }
})(typeof window !== 'undefined' ? window : globalThis);
