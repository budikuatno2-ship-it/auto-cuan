(function () {
  'use strict';

  if (window.__AUTOCUAN_STOCK_ANALYSIS_AI__) return;
  window.__AUTOCUAN_STOCK_ANALYSIS_AI__ = true;

  var sending = false;
  var timers = [];

  var dailyContextRows = [];
  var dailyContextAsOf = null;
  var dailyContextQuery = '';
  var dailyContextSort = {
    key: 'foreign_net_7d',
    direction: 'desc'
  };
  var DAILY_CONTEXT_DISPLAY_LIMIT = 200;

  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char];
    });
  }
  function renderAnswer(value) {
    if (window.AutoCuanAI && typeof window.AutoCuanAI.renderMarkdown === 'function') {
      return window.AutoCuanAI.renderMarkdown(value);
    }
    return '<p style="white-space:pre-wrap">' + escapeHtml(value) + '</p>';
  }
  function friendly(value) {
    if (window.AutoCuanAI && typeof window.AutoCuanAI.friendlyText === 'function') {
      return window.AutoCuanAI.friendlyText(value);
    }
    return String(value == null ? '' : value);
  }
  function currentTicker() {
    var active = String(window.activeTicker || '').trim().toUpperCase();
    var input = byId('analisisInput');
    var typed = input ? String(input.value || '').trim().toUpperCase().replace(/\.JK$/i, '') : '';
    var ticker = active || typed;
    return /^(IHSG|[A-Z]{3,5})$/.test(ticker) ? ticker : '';
  }
  function analysisSnapshot() {
    var root = byId('analisisResult');
    if (!root) return '';
    var primary = root.querySelector('.ai-content:not(.ai-followup)') || root.querySelector('.ai-content');
    if (!primary) return '';
    var text = typeof window.htmlToCleanText === 'function' ? window.htmlToCleanText(primary.innerHTML) : primary.textContent;
    return String(text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 18000);
  }
  function historyKey(ticker) {
    var uid = String(localStorage.getItem('autocuan_user_id') || localStorage.getItem('autocuan_user') || 'guest');
    return 'autocuan_stock_ai_history_' + uid + '_' + ticker;
  }
  function readHistory(ticker) {
    try {
      var rows = JSON.parse(localStorage.getItem(historyKey(ticker)) || '[]');
      return Array.isArray(rows) ? rows.slice(-10) : [];
    } catch (_) { return []; }
  }
  function writeHistory(ticker, rows) {
    try { localStorage.setItem(historyKey(ticker), JSON.stringify(rows.slice(-10))); } catch (_) {}
  }
  function clearTimers() {
    timers.forEach(function (timer) { clearTimeout(timer); });
    timers = [];
  }
  function scrollBottom() {
    var root = byId('analisisResult');
    if (root) root.scrollTop = root.scrollHeight;
  }
  function appendUser(message) {
    var root = byId('analisisResult'); if (!root) return;
    root.insertAdjacentHTML('beforeend', '<div class="mt-3 flex justify-end fade-in-up stock-ai-followup"><div class="bg-emerald-500/10 border border-emerald-500/15 rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[88%]"><p class="text-sm text-gray-100" style="white-space:pre-wrap">' + escapeHtml(message) + '</p></div></div>');
    scrollBottom();
  }
  function appendLoading() {
    var root = byId('analisisResult'); if (!root) return;
    root.insertAdjacentHTML('beforeend', '<div id="stockAiLoading" class="mt-3 flex gap-3 fade-in-up stock-ai-followup"><div class="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0"><span class="spinner-sm"></span></div><div class="bg-dark-700/60 border border-dark-600/30 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[88%]"><p id="stockAiLoadingText" class="text-sm text-blue-200">Lagi baca datanya dan nyari jalur AI yang paling pas…</p></div></div>');
    timers.push(setTimeout(function () { var el = byId('stockAiLoadingText'); if (el) el.textContent = 'Masih diproses ya, lagi cek jalur cadangan yang sehat…'; }, 9000));
    timers.push(setTimeout(function () { var el = byId('stockAiLoadingText'); if (el) el.textContent = 'Sedikit lebih lama nih—traffic lagi ramai, tapi pertanyaanmu masih jalan…'; }, 20000));
    scrollBottom();
  }
  function removeLoading() {
    clearTimers(); var el = byId('stockAiLoading'); if (el) el.remove();
  }
  function appendAssistant(text) {
    var root = byId('analisisResult'); if (!root) return;
    root.insertAdjacentHTML('beforeend', '<div class="mt-3 flex gap-3 fade-in-up stock-ai-followup"><div class="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0"><svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg></div><div class="ai-content ai-followup ai-rich-text bg-dark-700/60 border border-dark-600/30 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[92%]">' + renderAnswer(friendly(text)) + '</div></div>');
    scrollBottom();
  }
  function setBusy(active) {
    sending = active;
    var input = byId('analysisChatInput'); var button = byId('analysisSendBtn');
    if (input) input.disabled = active;
    if (button) button.disabled = active;
  }
  function addScopeNote() {
    var wrap = byId('analisisFollowUp');
    if (!wrap || byId('stockAiScopeNote')) return;
    var note = document.createElement('div');
    note.id = 'stockAiScopeNote';
    note.className = 'mb-2 text-[11px] text-blue-200 bg-blue-500/5 border border-blue-500/15 rounded-lg px-3 py-2';
    note.textContent = 'Tanya lanjutan khusus ticker dan hasil analisis yang sedang tampil. Buat bahas semua posisi sekaligus, pakai Asisten AI Portofolio ya.';
    wrap.insertBefore(note, wrap.firstChild);
  }
  async function send() {
    if (sending) return;
    var input = byId('analysisChatInput');
    var message = input ? String(input.value || '').trim() : '';
    if (!message) return;
    var ticker = currentTicker(); var snapshot = analysisSnapshot();
    if (!ticker || !snapshot) {
      appendAssistant('Analisis tickernya dulu ya. Setelah hasilnya muncul, baru lanjut tanya di sini.');
      return;
    }
    var history = readHistory(ticker);
    appendUser(message); if (input) input.value = ''; setBusy(true); appendLoading();
    try {
      var response = await fetch('/api/analyze', {
        method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          source:'stock_analysis_followup',
          chatMessage:message,
          context:{ ticker:ticker, analysis_text:snapshot, captured_at:new Date().toISOString() },
          history:history
        })
      });
      var data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'AI Analisis Saham belum tersedia.');
      removeLoading(); appendAssistant(data.reply);
      history.push({ role:'user', content:message }, { role:'assistant', content:data.reply }); writeHistory(ticker, history);
    } catch (error) {
      removeLoading(); appendAssistant(friendly(String(error && error.message || 'AI-nya lagi gangguan. Coba lagi bentar ya.')));
    } finally { setBusy(false); }
  }
  function bind() {
    var input = byId('analysisChatInput'); var button = byId('analysisSendBtn');
    if (!input || !button || button.dataset.stockAiBound === 'true') return;
    button.dataset.stockAiBound = 'true';
    button.removeAttribute('onclick'); input.removeAttribute('onkeydown');
    button.addEventListener('click', function (event) { event.preventDefault(); send(); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    });
    addScopeNote();
  }

  function dailyContextNumber(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function dailyContextPrice(value) {
    var n = dailyContextNumber(value);
    return n == null ? 'N/A' : Math.round(n).toLocaleString('id-ID');
  }

  function dailyContextPct(value) {
    var n = dailyContextNumber(value);
    if (n == null) return 'N/A';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function dailyContextRatio(value) {
    var n = dailyContextNumber(value);
    return n == null ? 'N/A' : n.toFixed(2) + 'x';
  }

  function dailyContextRsi(value) {
    var n = dailyContextNumber(value);
    return n == null ? 'N/A' : n.toFixed(1);
  }

  function dailyContextMoney(value) {
    var n = dailyContextNumber(value);
    if (n == null) return 'N/A';

    var sign = n > 0 ? '+' : n < 0 ? '-' : '';
    var abs = Math.abs(n);

    if (abs >= 1e12) {
      return sign + 'Rp' + (abs / 1e12).toFixed(2).replace('.', ',') + ' T';
    }
    if (abs >= 1e9) {
      return sign + 'Rp' + (abs / 1e9).toFixed(2).replace('.', ',') + ' M';
    }
    if (abs >= 1e6) {
      return sign + 'Rp' + (abs / 1e6).toFixed(1).replace('.', ',') + ' Jt';
    }

    return sign + 'Rp' + Math.round(abs).toLocaleString('id-ID');
  }

  function dailyContextValueClass(value, kind) {
    var n = dailyContextNumber(value);
    if (n == null) return 'text-gray-500';

    if (kind === 'foreign') {
      return n > 0 ? 'text-emerald-400' :
        n < 0 ? 'text-red-400' : 'text-gray-300';
    }

    if (kind === 'rsi') {
      if (n <= 30) return 'text-emerald-400';
      if (n >= 70) return 'text-red-400';
    }

    if (kind === 'volume' && n >= 1.5) {
      return 'text-yellow-300';
    }

    return 'text-gray-300';
  }

  function dailyContextSortRows(rows) {
    var key = dailyContextSort.key;
    var direction = dailyContextSort.direction === 'asc' ? 1 : -1;

    return rows.slice().sort(function(a, b) {
      var av = key === 'ticker' ? String(a.ticker || '') : dailyContextNumber(a[key]);
      var bv = key === 'ticker' ? String(b.ticker || '') : dailyContextNumber(b[key]);

      // N/A must always remain at the bottom, regardless of direction.
      var aMissing = key === 'ticker' ? !av : av == null;
      var bMissing = key === 'ticker' ? !bv : bv == null;

      if (aMissing && bMissing) {
        return String(a.ticker || '').localeCompare(String(b.ticker || ''));
      }
      if (aMissing) return 1;
      if (bMissing) return -1;

      if (key === 'ticker') {
        return av.localeCompare(bv) * direction;
      }

      if (av === bv) {
        return String(a.ticker || '').localeCompare(String(b.ticker || ''));
      }

      return (av - bv) * direction;
    });
  }

  function dailyContextArrow(key) {
    if (dailyContextSort.key !== key) return '↕';
    return dailyContextSort.direction === 'asc' ? '↑' : '↓';
  }

  function renderDailyContextRanking() {
    var body = byId('dailyContextRankingBody');
    var meta = byId('dailyContextRankingMeta');
    if (!body || !meta) return;

    var q = dailyContextQuery.trim().toUpperCase();

    var filtered = dailyContextRows.filter(function(row) {
      return !q || String(row.ticker || '').indexOf(q) !== -1;
    });

    var sorted = dailyContextSortRows(filtered);
    var visible = sorted.slice(0, DAILY_CONTEXT_DISPLAY_LIMIT);

    meta.textContent =
      'As of ' + (dailyContextAsOf || '-') +
      ' • ' + filtered.length + ' saham' +
      (filtered.length > visible.length
        ? ' • menampilkan ' + visible.length + ' teratas'
        : '');

    var rowsHtml = visible.map(function(row) {
      var dist = dailyContextNumber(row.distance_to_high_52w_pct);

      var highText = dist == null
        ? 'N/A'
        : dailyContextPct(dist);

      var highSub = row.high_52w == null
        ? ''
        : '<div class="text-[10px] text-gray-600">High ' +
          dailyContextPrice(row.high_52w) + '</div>';

      return '<tr class="border-b border-dark-600/20 hover:bg-dark-700/40">' +
        '<td class="px-3 py-2 whitespace-nowrap">' +
          '<button type="button" data-daily-context-ticker="' +
            escapeHtml(row.ticker) +
            '" class="font-semibold text-emerald-400 hover:text-emerald-300">' +
            escapeHtml(row.ticker) +
          '</button>' +
        '</td>' +
        '<td class="px-3 py-2 text-right text-gray-200">' +
          dailyContextPrice(row.last_price) +
        '</td>' +
        '<td class="px-3 py-2 text-right ' +
          dailyContextValueClass(row.rsi_14, 'rsi') + '">' +
          dailyContextRsi(row.rsi_14) +
        '</td>' +
        '<td class="px-3 py-2 text-right text-gray-300">' +
          highText + highSub +
        '</td>' +
        '<td class="px-3 py-2 text-right ' +
          dailyContextValueClass(row.volume_ratio_vs_7d_avg, 'volume') + '">' +
          dailyContextRatio(row.volume_ratio_vs_7d_avg) +
        '</td>' +
        '<td class="px-3 py-2 text-right ' +
          dailyContextValueClass(row.foreign_net_today, 'foreign') + '">' +
          dailyContextMoney(row.foreign_net_today) +
        '</td>' +
        '<td class="px-3 py-2 text-right ' +
          dailyContextValueClass(row.foreign_net_7d, 'foreign') + '">' +
          dailyContextMoney(row.foreign_net_7d) +
        '</td>' +
      '</tr>';
    }).join('');

    body.innerHTML = rowsHtml ||
      '<tr><td colspan="7" class="px-3 py-6 text-center text-xs text-gray-500">' +
      'Ticker tidak ditemukan.</td></tr>';

    var sortButtons = document.querySelectorAll('[data-daily-context-sort]');
    sortButtons.forEach(function(button) {
      var key = button.getAttribute('data-daily-context-sort');
      var arrow = button.querySelector('[data-sort-arrow]');
      if (arrow) arrow.textContent = dailyContextArrow(key);
    });

    body.querySelectorAll('[data-daily-context-ticker]').forEach(function(button) {
      button.addEventListener('click', function() {
        var ticker = button.getAttribute('data-daily-context-ticker');
        if (typeof window.quickAnalisis === 'function') {
          window.quickAnalisis(ticker);
        } else {
          var input = byId('analisisInput');
          if (input) input.value = ticker;
        }
      });
    });
  }

  async function loadDailyContextRanking() {
    var status = byId('dailyContextRankingStatus');
    if (status) {
      status.textContent = 'Memuat data pasar harian…';
      status.className = 'text-[11px] text-emerald-400';
    }

    try {
      var headers = typeof window.getAuthHeaders === 'function'
        ? window.getAuthHeaders()
        : {};

      var response = await fetch(
        '/api/quote?action=daily-market-context-list',
        {
          method: 'GET',
          headers: headers
        }
      );

      var data = await response.json();

      if (!response.ok || !data.success || !Array.isArray(data.rows)) {
        throw new Error(data.error || 'Data konteks pasar belum tersedia.');
      }

      dailyContextRows = data.rows;
      dailyContextAsOf = data.as_of || null;

      if (status) {
        status.textContent =
          data.count + ' saham • data terakhir ' + (dailyContextAsOf || '-');
        status.className = 'text-[11px] text-gray-500';
      }

      renderDailyContextRanking();
    } catch (error) {
      if (status) {
        status.textContent =
          String(error && error.message || 'Gagal memuat konteks pasar.');
        status.className = 'text-[11px] text-red-400';
      }
    }
  }

  function buildDailyContextRankingPanel() {
    var result = byId('analisisResult');
    if (!result || byId('dailyContextRankingPanel')) return;

    var panel = document.createElement('section');
    panel.id = 'dailyContextRankingPanel';
    panel.className =
      'mb-4 rounded-2xl border border-dark-600/30 bg-dark-800/35 overflow-hidden';

    panel.innerHTML =
      '<div class="px-4 py-3 border-b border-dark-600/30">' +
        '<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">' +
          '<div>' +
            '<h3 class="text-sm font-semibold text-gray-200">Konteks Pasar Harian</h3>' +
            '<p id="dailyContextRankingStatus" class="text-[11px] text-emerald-400">' +
              'Memuat data pasar harian…' +
            '</p>' +
          '</div>' +
          '<div class="flex items-center gap-2">' +
            '<input id="dailyContextRankingSearch" type="text" placeholder="Cari ticker…" ' +
              'class="w-32 sm:w-40 rounded-lg bg-dark-700/60 border border-dark-600/40 ' +
              'px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-emerald-500/40">' +
            '<button id="dailyContextRankingRefresh" type="button" ' +
              'class="px-2.5 py-1.5 rounded-lg text-xs text-emerald-400 border ' +
              'border-emerald-500/25 hover:bg-emerald-500/10">Refresh</button>' +
          '</div>' +
        '</div>' +
        '<p id="dailyContextRankingMeta" class="mt-2 text-[10px] text-gray-600">—</p>' +
      '</div>' +

      '<div class="overflow-auto max-h-[380px]">' +
        '<table class="w-full min-w-[820px] text-xs">' +
          '<thead class="sticky top-0 bg-[#111720] z-10 text-gray-500">' +
            '<tr>' +
              '<th class="px-3 py-2 text-left">' +
                '<button type="button" data-daily-context-sort="ticker">Ticker <span data-sort-arrow>↕</span></button>' +
              '</th>' +
              '<th class="px-3 py-2 text-right">' +
                '<button type="button" data-daily-context-sort="last_price">Harga <span data-sort-arrow>↕</span></button>' +
              '</th>' +
              '<th class="px-3 py-2 text-right">' +
                '<button type="button" data-daily-context-sort="rsi_14">RSI 14 <span data-sort-arrow>↕</span></button>' +
              '</th>' +
              '<th class="px-3 py-2 text-right">' +
                '<button type="button" data-daily-context-sort="distance_to_high_52w_pct">Jarak 52W High <span data-sort-arrow>↕</span></button>' +
              '</th>' +
              '<th class="px-3 py-2 text-right">' +
                '<button type="button" data-daily-context-sort="volume_ratio_vs_7d_avg">Vol/7D <span data-sort-arrow>↕</span></button>' +
              '</th>' +
              '<th class="px-3 py-2 text-right">' +
                '<button type="button" data-daily-context-sort="foreign_net_today">Foreign Terbaru <span data-sort-arrow>↕</span></button>' +
              '</th>' +
              '<th class="px-3 py-2 text-right">' +
                '<button type="button" data-daily-context-sort="foreign_net_7d">Foreign 7D <span data-sort-arrow>↓</span></button>' +
              '</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody id="dailyContextRankingBody">' +
            '<tr><td colspan="7" class="px-3 py-6 text-center text-xs text-gray-500">' +
              'Memuat…' +
            '</td></tr>' +
          '</tbody>' +
        '</table>' +
      '</div>';

    result.parentNode.insertBefore(panel, result);

    panel.querySelectorAll('[data-daily-context-sort]').forEach(function(button) {
      button.addEventListener('click', function() {
        var key = button.getAttribute('data-daily-context-sort');

        if (dailyContextSort.key === key) {
          dailyContextSort.direction =
            dailyContextSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
          dailyContextSort.key = key;
          dailyContextSort.direction =
            key === 'ticker' ? 'asc' : 'desc';
        }

        renderDailyContextRanking();
      });
    });

    var search = byId('dailyContextRankingSearch');
    if (search) {
      search.addEventListener('input', function() {
        dailyContextQuery = String(search.value || '');
        renderDailyContextRanking();
      });
    }

    var refresh = byId('dailyContextRankingRefresh');
    if (refresh) {
      refresh.addEventListener('click', function() {
        loadDailyContextRanking();
      });
    }
  }

  // The old implementation hid RSI/volume/foreign/PBV behind a per-analysis
  // "Konteks Pasar" button. The ranking panel above replaces that interaction,
  // so remove the legacy button whenever an analysis result inserts it.
  function removeLegacyMarketContextButtons() {
    var root = byId('analisisResult');
    if (!root) return;

    root.querySelectorAll(
      'button[onclick*="openMarketContextFromAnalisis"]'
    ).forEach(function(button) {
      button.remove();
    });
  }

  function observeLegacyMarketContextButtons() {
    var root = byId('analisisResult');
    if (!root || root.dataset.dailyContextObserver === 'true') return;

    root.dataset.dailyContextObserver = 'true';

    var observer = new MutationObserver(function() {
      removeLegacyMarketContextButtons();
    });

    observer.observe(root, {
      childList: true,
      subtree: true
    });

    removeLegacyMarketContextButtons();
  }

  function initDailyContextRanking() {
    buildDailyContextRankingPanel();
    observeLegacyMarketContextButtons();
    loadDailyContextRanking();
  }

  function init() {
    bind();
    initDailyContextRanking();
    var attempts = 0;
    var timer = setInterval(function () { bind(); attempts += 1; if (attempts >= 30) clearInterval(timer); }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
