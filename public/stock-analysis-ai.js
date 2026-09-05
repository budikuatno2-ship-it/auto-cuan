(function () {
  'use strict';

  if (window.__AUTOCUAN_STOCK_ANALYSIS_AI__) return;
  window.__AUTOCUAN_STOCK_ANALYSIS_AI__ = true;

  var sending = false;
  var timers = [];
  var lastQuestion = '';
  var controller = null;
  // Above the router's own ceiling so a request the server is still about to
  // answer is never thrown away client-side.
  var REQUEST_TIMEOUT_MS = 70000;

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
    if (window.UnifiedCockpit && typeof window.UnifiedCockpit.getActiveTicker === 'function') {
      var t = window.UnifiedCockpit.getActiveTicker();
      if (/^(IHSG|[A-Z]{3,5})$/.test(t)) return t;
    }
    var active = String(window.activeTicker || '').trim().toUpperCase();
    var input = byId('analisisInput');
    var typed = input ? String(input.value || '').trim().toUpperCase().replace(/\.JK$/i, '') : '';
    var ticker = active || typed;
    return /^(IHSG|[A-Z]{3,5})$/.test(ticker) ? ticker : '';
  }
  function analysisSnapshot() {
    var root = byId('analisisResult');
    var primary = root ? (root.querySelector('.ai-content:not(.ai-followup)') || root.querySelector('.ai-content')) : null;
    if (!primary) {
      var visionWrap = byId('unifiedAiChartResultWrap') || byId('aiChartAnalysisResultWrap');
      if (visionWrap && visionWrap.innerText && visionWrap.innerText.trim().length > 20) {
        return visionWrap.innerText.trim().slice(0, 18000);
      }
      return '';
    }
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
  function getChatRoot() {
    return byId('unifiedChatMessages') || byId('analisisResult');
  }
  function scrollBottom() {
    var root = getChatRoot();
    if (root) root.scrollTop = root.scrollHeight;
  }
  function appendUser(message) {
    var root = getChatRoot(); if (!root) return;
    root.insertAdjacentHTML('beforeend', '<div class="mt-3 flex justify-end fade-in-up stock-ai-followup"><div class="bg-emerald-500/10 border border-emerald-500/15 rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[88%]"><p class="text-sm text-gray-100" style="white-space:pre-wrap">' + escapeHtml(message) + '</p></div></div>');
    scrollBottom();
  }
  function appendLoading() {
    var root = getChatRoot(); if (!root) return;
    root.insertAdjacentHTML('beforeend', '<div id="stockAiLoading" class="mt-3 flex gap-3 fade-in-up stock-ai-followup"><div class="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0"><span class="spinner-sm"></span></div><div class="bg-dark-700/60 border border-dark-600/30 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[88%]"><p id="stockAiLoadingText" class="text-sm text-blue-200">Lagi baca datanya dan nyari jalur AI yang paling pas…</p></div></div>');
    timers.push(setTimeout(function () { var el = byId('stockAiLoadingText'); if (el) el.textContent = 'Masih diproses ya, lagi cek jalur cadangan yang sehat…'; }, 9000));
    timers.push(setTimeout(function () { var el = byId('stockAiLoadingText'); if (el) el.textContent = 'Sedikit lebih lama nih—traffic lagi ramai, tapi pertanyaanmu masih jalan…'; }, 20000));
    scrollBottom();
  }
  function removeLoading() {
    clearTimers(); var el = byId('stockAiLoading'); if (el) el.remove();
  }
  function appendAssistant(text, options) {
    var root = getChatRoot(); if (!root) return;
    var local = Boolean(options && options.local);
    // A deterministic snapshot summary is labelled as such. Presenting it as a
    // model answer would make the fallback indistinguishable from the real one.
    var badge = local
      ? '<div class="mb-2 inline-block px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-[10px] font-bold text-amber-300">Ringkasan lokal — bukan jawaban AI</div>'
      : '';
    var shell = local
      ? 'ai-content ai-followup ai-rich-text bg-amber-500/5 border border-amber-500/20 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[92%]'
      : 'ai-content ai-followup ai-rich-text bg-dark-700/60 border border-dark-600/30 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[92%]';
    root.insertAdjacentHTML('beforeend', '<div class="mt-3 flex gap-3 fade-in-up stock-ai-followup"><div class="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0"><svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg></div><div class="' + shell + '">' + badge + renderAnswer(friendly(text)) + '</div></div>');
    scrollBottom();
  }
  function appendNotice(text, retryable) {
    var root = getChatRoot(); if (!root) return;
    removeRetry();
    var retryHtml = retryable
      ? '<button type="button" id="stockAiRetry" class="mt-2 px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-bold text-emerald-300">Coba lagi</button>'
      : '';
    root.insertAdjacentHTML('beforeend', '<div id="stockAiNotice" class="mt-3 stock-ai-followup"><div class="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3.5 py-2.5"><p class="text-xs text-amber-200">' + escapeHtml(text) + '</p>' + retryHtml + '</div></div>');
    var button = byId('stockAiRetry');
    if (button) button.addEventListener('click', function (event) {
      event.preventDefault();
      if (sending || !lastQuestion) return;
      var question = lastQuestion;
      removeRetry();
      send(question, { retry: true });
    });
    scrollBottom();
  }
  function removeRetry() {
    var notice = byId('stockAiNotice');
    if (notice) notice.remove();
  }
  function appendStreamingBubble() {
    var root = getChatRoot(); if (!root) return null;
    root.insertAdjacentHTML('beforeend', '<div id="stockAiStreamWrap" class="mt-3 flex gap-3 fade-in-up stock-ai-followup"><div class="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0"><svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg></div><div id="stockAiStreamBody" class="ai-content ai-followup bg-dark-700/60 border border-dark-600/30 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[92%] whitespace-pre-wrap text-sm text-gray-200"></div></div>');
    scrollBottom();
    return byId('stockAiStreamBody');
  }
  function removeStreamingBubble() {
    var el = byId('stockAiStreamWrap');
    if (el) el.remove();
  }
  // Parses one or more "data: {...}\n\n" SSE frames out of a decoded text
  // buffer, same wire format lib/context-ai-router-v7.js writes
  // (sendSSEChunk/sendSSEDone). Returns the unconsumed remainder so partial
  // frames split across reader.read() calls are carried into the next chunk.
  function consumeSSELines(buffer, onChunkPayload) {
    var lines = buffer.split('\n');
    var remainder = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.indexOf('data:') !== 0) continue;
      var payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try { onChunkPayload(JSON.parse(payload)); } catch (_) {}
    }
    return remainder;
  }
  function setBusy(active) {
    sending = active;
    var input = byId('analysisChatInput'); var button = byId('analysisSendBtn');
    if (input) input.disabled = active;
    if (button) {
      button.disabled = active;
      button.setAttribute('aria-busy', active ? 'true' : 'false');
    }
  }
  // Only a genuine provider/transport failure may be answered with a fallback.
  // Session, quota and server-configuration problems are reported as themselves
  // so the user is told what to actually do about them.
  function describeFailure(response, data, error) {
    var code = data && data.code;
    var status = response ? response.status : 0;
    if (error && error.name === 'AbortError') return { retryable: true, text: 'Permintaan dihentikan karena terlalu lama. Coba lagi ya.' };
    if (!response) return { retryable: true, text: 'Koneksi ke server AI gagal. Cek jaringan lalu coba lagi.' };
    if (status === 401) return { retryable: false, text: 'Sesi kamu sudah berakhir. Muat ulang halaman dan login lagi.' };
    if (status === 403) return { retryable: false, text: (data && data.error) || 'Akses AI ditolak untuk akun ini.' };
    if (status === 402 || code === 'SUBSCRIPTION_REQUIRED') return { retryable: false, text: (data && data.error) || 'Subscription aktif diperlukan untuk menggunakan fitur ini.' };
    if (status === 429 || code === 'AI_RATE_LIMITED') {
      var wait = Number(data && data.retry_after_seconds);
      return { retryable: false, text: 'Terlalu banyak pertanyaan dalam waktu singkat.' + (Number.isFinite(wait) && wait > 0 ? ' Coba lagi sekitar ' + wait + ' detik lagi.' : ' Tunggu sebentar lalu coba lagi.') };
    }
    if (code === 'AI_NOT_CONFIGURED') return { retryable: false, text: 'Asisten AI belum diaktifkan di server. Hubungi admin.' };
    // Same class as AI_NOT_CONFIGURED: a server-side configuration problem that
    // retrying cannot clear, so no retry button is offered.
    if (code === 'AI_KEY_OR_BALANCE_ERROR') return { retryable: false, text: 'Konfigurasi akses AI di server bermasalah (API key atau saldo). Hubungi admin.' };
    if (code === 'AI_STOCK_SNAPSHOT_MISSING') return { retryable: false, text: 'Jalankan analisis tickernya dulu, baru lanjut tanya di sini.' };
    // Reached only when no deterministic local summary could be built, so it must
    // not claim one is on screen. The wording that does promise a local analysis
    // belongs to the branch below that actually renders one.
    if (code === 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE') return { retryable: true, text: 'Provider AI sedang mengalami gangguan sementara. Coba lagi sebentar.' };
    return { retryable: true, text: (data && data.error) || 'Jawaban AI belum bisa diambil. Coba lagi sebentar.' };
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
  async function send(retryMessage, options) {
    if (sending) return;
    var input = byId('analysisChatInput');
    var message = retryMessage != null
      ? String(retryMessage || '').trim()
      : (input ? String(input.value || '').trim() : '');
    if (!message) return;
    var ticker = currentTicker(); var snapshot = analysisSnapshot();
    if (!ticker || !snapshot) {
      appendNotice('Analisis tickernya dulu ya. Setelah hasilnya muncul, baru lanjut tanya di sini.', false);
      return;
    }
    var isRetry = Boolean(options && options.retry);
    var history = readHistory(ticker);
    lastQuestion = message;
    removeRetry();
    if (!isRetry) appendUser(message);
    if (input && retryMessage == null) input.value = '';
    setBusy(true); appendLoading();

    var abortController = typeof AbortController === 'function' ? new AbortController() : null;
    controller = abortController;
    var abortTimer = abortController ? setTimeout(function () { abortController.abort(); }, REQUEST_TIMEOUT_MS) : null;
    var response = null;
    var data = {};

    try {
      response = await fetch('/api/analyze', {
        method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json', 'Accept':'text/event-stream, application/json'},
        signal: abortController ? abortController.signal : undefined,
        body:JSON.stringify({
          source:'stock_analysis_followup',
          chatMessage:message,
          context:{ ticker:ticker, analysis_text:snapshot, captured_at:new Date().toISOString() },
          history:history,
          retry:isRetry,
          stream:true
        })
      });

      // lib/context-ai-router-v7.js honors stream:true by responding with
      // text/event-stream (cache hit, live Gemini call, and local-fallback all
      // stream); every rejection path (auth/session/validation errors from
      // api/analyze.js or the router's own 400s) still replies with plain JSON,
      // so only a text/event-stream + ok response is read as a stream.
      var contentType = (response.headers && response.headers.get('content-type')) || '';
      var isStream = response.ok && contentType.indexOf('text/event-stream') !== -1 &&
        response.body && typeof response.body.getReader === 'function';

      if (isStream) {
        removeLoading();
        var reader = response.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var streamBuffer = '';
        var replyText = '';
        var localFallback = false;
        var isStreamError = false;
        var streamErrorCode = null;
        var bubble = appendStreamingBubble();
        var streamError = null;
        try {
          while (true) {
            var chunkResult = await reader.read();
            if (chunkResult.done) break;
            streamBuffer += decoder.decode(chunkResult.value, { stream: true });
            streamBuffer = consumeSSELines(streamBuffer, function (parsed) {
              if (parsed && typeof parsed.chunk === 'string') {
                replyText += parsed.chunk;
                if (bubble) bubble.textContent = replyText;
              }
              if (parsed && parsed.local_fallback === true) localFallback = true;
              if (parsed && (parsed.error === true || parsed.code === 'AI_KEY_INVALID' || parsed.code === 'AI_RATE_LIMITED' || parsed.code === 'AI_TIMEOUT' || parsed.code === 'QUOTA_EXCEEDED')) {
                isStreamError = true;
                streamErrorCode = parsed.code;
              }
            });
          }
        } catch (err) {
          // A dropped connection or the client-side abort timeout rejects
          // reader.read() mid-stream. The partial, unverified text already
          // shown in the bubble must never be presented as the final answer,
          // and the bubble itself must not be left stuck on screen — both are
          // handled by the finally below and the early return here.
          streamError = err;
        } finally {
          removeStreamingBubble();
        }
        if (streamError) {
          var midStreamFailure = describeFailure(response, {}, streamError);
          appendNotice(midStreamFailure.text, midStreamFailure.retryable);
          return;
        }
        if (!replyText) {
          var streamFailure = describeFailure(response, {}, null);
          appendNotice(streamFailure.text, streamFailure.retryable);
          return;
        }
        if (isStreamError) {
          var canRetry = streamErrorCode === 'AI_RATE_LIMITED' || streamErrorCode === 'AI_TIMEOUT';
          appendNotice(replyText || 'Gagal memproses permintaan AI.', canRetry);
          return;
        }
        if (localFallback) {
          appendNotice('Provider AI sedang mengalami gangguan sementara. Analisis lokal ditampilkan sementara.', true);
        }
        appendAssistant(replyText, { local: localFallback });
        if (!localFallback) {
          history.push({ role:'user', content:message }, { role:'assistant', content:replyText });
          writeHistory(ticker, history);
        }
        return;
      }

      // An HTML error page from the platform used to reach the user as a raw
      // "Unexpected token '<'" SyntaxError rendered in the assistant bubble.
      data = await response.json().catch(function () { return {}; });
      // Clear the placeholder before anything is appended, so the answer never
      // renders underneath a spinner. The finally block repeats it as a safety
      // net for any path that throws; removeLoading() is idempotent.
      removeLoading();
      if (!response.ok || !data.success || !data.reply) {
        var failure = describeFailure(response, data, null);
        appendNotice(failure.text, failure.retryable);
        return;
      }
      // The provider outage is named before the local summary is shown, so the
      // user knows why the answer is deterministic rather than from a model. The
      // summary itself still carries its own "bukan jawaban AI" badge.
      if (data.local_fallback === true && data.provider_code === 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE') {
        appendNotice('Provider AI sedang mengalami gangguan sementara. Analisis lokal ditampilkan sementara.', true);
      }
      appendAssistant(data.reply, { local: data.local_fallback === true });
      // Only a real model answer becomes conversation history; a deterministic
      // local summary must not be replayed back to the model as its own turn.
      if (data.local_fallback !== true) {
        history.push({ role:'user', content:message }, { role:'assistant', content:data.reply });
        writeHistory(ticker, history);
      }
    } catch (error) {
      var transport = describeFailure(response, data, error);
      appendNotice(transport.text, transport.retryable);
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      controller = null;
      removeLoading();
      setBusy(false);
    }
  }

  function rankingNavButtonHtml() {
    return '<button type="button" onclick="openDailyRankingPage()" class="nav-btn" data-page="ranking" aria-label="Ranking Pasar Harian">' +
      '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3v18h18M7 16l4-4 3 3 5-7"/>' +
      '</svg><span>Ranking</span></button>';
  }

  function ensureRankingNavButtons() {
    var desktop = document.querySelector('.desktop-nav');
    var mobile = byId('mainNav');

    if (desktop && !desktop.querySelector('[data-page="ranking"]')) {
      var analisisDesktop = desktop.querySelector('[data-page="analisis"]');
      if (analisisDesktop) analisisDesktop.insertAdjacentHTML('afterend', rankingNavButtonHtml());
      else desktop.insertAdjacentHTML('beforeend', rankingNavButtonHtml());
    }

    if (mobile && !mobile.querySelector('[data-page="ranking"]')) {
      var analisisMobile = mobile.querySelector('[data-page="analisis"]');
      if (analisisMobile) analisisMobile.insertAdjacentHTML('afterend', rankingNavButtonHtml());
      else mobile.insertAdjacentHTML('beforeend', rankingNavButtonHtml());
    }
  }

  function ensureRankingPageShell() {
    var page = byId('page-ranking');
    if (page) return page;

    var dashboard = byId('dashboardScreen');
    if (!dashboard) return null;

    page = document.createElement('div');
    page.id = 'page-ranking';
    page.className = 'page-content hidden flex-1 max-w-[1180px] w-full mx-auto px-3 sm:px-5 py-5 sm:py-7';
    page.innerHTML =
      '<div class="mb-5 sm:mb-6">' +
        '<div id="marketContextSessionBadge" class="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-emerald-500/15 bg-emerald-500/5 text-[10px] font-bold uppercase tracking-[.12em] text-emerald-300">Memuat sesi&hellip;</div>' +
        '<div class="mt-3 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">' +
          '<div>' +
            '<h2 class="text-xl sm:text-2xl font-bold text-white tracking-tight">Ranking Pasar Harian</h2>' +
            '<p class="mt-1 text-xs sm:text-sm text-gray-500">Bandingkan RSI 14, jarak 52W high, volume, dan aliran foreign seluruh saham dalam satu halaman khusus.</p>' +
          '</div>' +
          '<div class="text-[11px] text-gray-600">Terpisah dari Analisis Saham</div>' +
        '</div>' +
      '</div>' +
      '<div id="dailyRankingMount"></div>';

    var header = dashboard.querySelector('header');
    if (header && header.nextSibling) dashboard.insertBefore(page, header.nextSibling);
    else dashboard.appendChild(page);
    return page;
  }

  function configureRankingColumns() {
    if (!Array.isArray(window.RANKING_COLUMNS)) return;
    window.RANKING_COLUMNS = [
      { key:'ticker', label:'Ticker', align:'left', sortable:true },
      { key:'last_price', label:'Harga', align:'right', fmt:window.mktCtxFmtPrice },
      { key:'rsi_14', label:'RSI 14', align:'right', fmt:function(v){ return Number(v).toFixed(1); } },
      { key:'week52_high_dist_pct', label:'Jarak 52W High', align:'right', fmt:window.mktCtxFmtPct },
      { key:'volume_ratio_vs_7d_avg', label:'Vol vs 7D', align:'right', fmt:window.mktCtxFmtRatio },
      { key:'foreign_net_today', label:'Foreign Terakhir', align:'right', fmt:window.mktCtxFmtIDR, colorize:true },
      { key:'foreign_net_3d', label:'Foreign 3D', align:'right', fmt:window.mktCtxFmtIDR, colorize:true },
      { key:'foreign_net_7d', label:'Foreign 7D', align:'right', fmt:window.mktCtxFmtIDR, colorize:true }
    ];
  }

  function mountRankingCardOnOwnPage() {
    var search = byId('rankingSearchInput');
    var tableWrap = byId('rankingTableWrap');
    var page = ensureRankingPageShell();
    var mount = byId('dailyRankingMount');
    if (!search || !tableWrap || !page || !mount) return false;

    configureRankingColumns();

    var card = tableWrap.closest('.unified-card') || tableWrap.parentElement;
    if (!card) return false;

    // Safety guard: NEVER move structural cockpit columns (.unified-primary-col, #page-analisis, etc.)
    var outer = card.parentElement;
    var nodeToMove = (outer && outer !== mount && outer.classList && outer.classList.contains('ranking-card-wrapper')) ? outer : card;

    if (nodeToMove.parentElement !== mount) mount.appendChild(nodeToMove);

    nodeToMove.dataset.rankingPolished = 'true';
    nodeToMove.classList.remove('border-b', 'flex-shrink-0');
    nodeToMove.style.paddingTop = '0';
    nodeToMove.style.paddingBottom = '0';
    nodeToMove.style.marginTop = '0';
    nodeToMove.style.borderBottom = '0';

    card.style.background = 'linear-gradient(180deg, rgba(18,24,34,.97), rgba(11,14,20,.995))';
    card.style.border = '1px solid rgba(52,211,153,.16)';
    card.style.borderRadius = '18px';
    card.style.boxShadow = '0 20px 55px rgba(0,0,0,.26)';
    // No vertical max-height here: the table must grow to its natural height so the
    // document stays the single vertical scroll owner (mouse wheel/touchpad/swipe
    // must not get trapped inside a small inner scrollport). Only horizontal
    // overflow (for narrow viewports with many columns) is handled by the wrap.
    tableWrap.style.minHeight = '420px';
    search.placeholder = 'Cari ticker di ranking…';

    var title = card.querySelector('h3');
    var desc = card.querySelector('h3 + p');
    if (title) {
      title.id = title.id || 'rankingCardTitle';
      title.style.fontSize = '15px';
      title.style.letterSpacing = '-0.01em';
    }
    if (desc) {
      desc.textContent = 'Klik judul kolom untuk urut terbesar ↔ terkecil. Foreign Terakhir, 3D, dan 7D memakai data upload terbaru.';
      desc.style.color = '#718096';
    }

    wrapRenderRankingTableForSessionLabel();
    if (typeof window.renderRankingTable === 'function') window.renderRankingTable();
    updateRankingSessionLabel();
    return true;
  }

  // ===== Session label: the ranking table and market-context badge must
  // reflect the REAL as_of_trade_date already present in the fetched data,
  // never a hardcoded "T-1" claim. Confirmed bug (12 Aug 2026 audit): both
  // labels were static strings that stayed "T-1" even after the collector
  // had already persisted a completed same-day EOD snapshot (BELL/TIRA
  // prices matching the closed 12 Aug session at ~16:23 WIB, well past the
  // 16:00 WIB settle cutoff in lib/daily-history-collector.js). The
  // as_of_trade_date on every ranking row is authoritative — read it instead
  // of asserting a fixed offset. See lib/daily-market-context-builder.js's
  // buildRankingRowFromFeatureRow for the field's provenance.
  var MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  function formatSessionDateID(dateKey) {
    if (!dateKey) return null;
    var parts = String(dateKey).split('-');
    if (parts.length !== 3) return dateKey;
    var y = parts[0];
    var m = parseInt(parts[1], 10);
    var d = parseInt(parts[2], 10);
    if (!m || m < 1 || m > 12 || !d) return dateKey;
    return d + ' ' + MONTHS_ID[m - 1] + ' ' + y;
  }

  /**
   * Determine the latest completed session date from the ranking rows
   * actually loaded, and whether the batch is a coherent single-date
   * snapshot or a mixed-date one (some tickers' features not yet refreshed
   * to the latest session). Never blends dates into one silent average —
   * mixed dates are surfaced as an explicit warning per the audit spec
   * ("If ranking rows have mixed as_of_trade_date, detect it").
   */
  function computeRankingSessionInfo(rows) {
    rows = Array.isArray(rows) ? rows.filter(Boolean) : [];
    var dates = rows.map(function (r) { return r && r.as_of_trade_date; }).filter(Boolean);

    if (!dates.length) {
      return {
        label: 'Sesi belum tersedia',
        mixed: false,
        latest: null,
        warning: null,
        notice: null,
        older_count: 0,
        stale_older_count: 0,
        refreshed_older_count: 0
      };
    }

    var counts = {};
    dates.forEach(function (d) { counts[d] = (counts[d] || 0) + 1; });

    var uniqueDates = Object.keys(counts).sort();
    var latest = uniqueDates[uniqueDates.length - 1];
    var mixed = uniqueDates.length > 1;
    var label = 'Sesi terakhir selesai: ' + formatSessionDateID(latest);

    var olderRows = rows.filter(function (r) {
      return r && r.as_of_trade_date && r.as_of_trade_date !== latest;
    });

    var latestUpdateMs = null;
    rows.forEach(function (r) {
      var ms = Date.parse(r && r.updated_at ? r.updated_at : '');
      if (Number.isFinite(ms) && (latestUpdateMs == null || ms > latestUpdateMs)) {
        latestUpdateMs = ms;
      }
    });

    // A feature row refreshed in the same collector batch may legitimately
    // keep an older as_of date when Yahoo has no newer candle for that ticker
    // (zero-trade / suspended / otherwise no published daily candle).
    // Live VPS validation on 12 Aug 2026 proved exactly this for all 19
    // mixed-date tickers: 19/19 Yahoo series also ended on 11 Aug.
    //
    // A materially older updated_at is different: that means the row itself
    // did not participate in the newest feature refresh and should remain a
    // real stale-data warning.
    var REFRESH_BATCH_TOLERANCE_MS = 10 * 60 * 1000;
    var refreshedOlder = [];
    var staleOlder = [];

    olderRows.forEach(function (r) {
      var ms = Date.parse(r && r.updated_at ? r.updated_at : '');
      if (
        latestUpdateMs != null &&
        Number.isFinite(ms) &&
        Math.abs(latestUpdateMs - ms) <= REFRESH_BATCH_TOLERANCE_MS
      ) {
        refreshedOlder.push(r);
      } else {
        staleOlder.push(r);
      }
    });

    var warning = null;
    var notice = null;

    if (mixed && staleOlder.length) {
      var staleDates = {};
      staleOlder.forEach(function (r) {
        staleDates[r.as_of_trade_date] = true;
      });
      warning =
        'Peringatan data tertinggal: ' +
        staleOlder.length +
        ' dari ' +
        rows.length +
        ' ticker belum ikut refresh terbaru (sesi terakhir: ' +
        Object.keys(staleDates).sort().map(formatSessionDateID).join(', ') +
        ').';
    }

    if (mixed && refreshedOlder.length) {
      var refreshedDates = {};
      refreshedOlder.forEach(function (r) {
        refreshedDates[r.as_of_trade_date] = true;
      });
      notice =
        'Catatan sesi: ' +
        refreshedOlder.length +
        ' dari ' +
        rows.length +
        ' ticker tidak memiliki candle lebih baru pada snapshot terbaru; ' +
        'sesi terakhir ticker tersebut: ' +
        Object.keys(refreshedDates).sort().map(formatSessionDateID).join(', ') +
        '.';
    }

    return {
      label: label,
      mixed: mixed,
      latest: latest,
      warning: warning,
      notice: notice,
      older_count: olderRows.length,
      stale_older_count: staleOlder.length,
      refreshed_older_count: refreshedOlder.length
    };
  }

  function updateRankingSessionLabel() {
    var rows = (window.rankingState && window.rankingState.rows) || [];
    var info = computeRankingSessionInfo(rows);

    var badge = byId('marketContextSessionBadge');
    if (badge) badge.textContent = info.label;

    var title = byId('rankingCardTitle');
    if (title) {
      title.textContent = info.latest
        ? ('Data Ranking — ' + formatSessionDateID(info.latest))
        : 'Data Ranking';
    }

    var tableWrap = byId('rankingTableWrap');
    var messageEl = byId('rankingSessionMixedWarning');
    var message = info.warning || info.notice;

    if (message) {
      if (!messageEl && tableWrap && tableWrap.parentElement) {
        messageEl = document.createElement('div');
        messageEl.id = 'rankingSessionMixedWarning';
        tableWrap.parentElement.insertBefore(messageEl, tableWrap);
      }

      if (messageEl) {
        messageEl.className = info.warning
          ? 'px-3.5 py-2 text-[11px] text-amber-300 bg-amber-500/10 border-b border-amber-500/20'
          : 'px-3.5 py-2 text-[11px] text-slate-300 bg-slate-500/10 border-b border-slate-500/20';
        messageEl.textContent = message;
        messageEl.style.display = '';
      }
    } else if (messageEl) {
      messageEl.style.display = 'none';
    }
  }

  function wrapRenderRankingTableForSessionLabel() {
    if (typeof window.renderRankingTable !== 'function' || window.renderRankingTable.__sessionLabelWrapped) return;
    var original = window.renderRankingTable;
    var wrapped = function () {
      original();
      updateRankingSessionLabel();
    };
    wrapped.__sessionLabelWrapped = true;
    window.renderRankingTable = wrapped;
  }

  function setRankingNavActive() {
    document.querySelectorAll('.nav-btn').forEach(function(button) {
      button.classList.toggle('active', button.getAttribute('data-page') === 'ranking');
    });
  }

  function openDailyRankingPage() {
    ensureRankingNavButtons();
    mountRankingCardOnOwnPage();

    var page = byId('page-ranking');
    if (!page) return;

    document.querySelectorAll('.page-content').forEach(function(el) {
      if (el !== page) el.classList.add('hidden');
    });
    page.classList.remove('hidden');
    setRankingNavActive();

    if (typeof window.ensureRankingTableLoaded === 'function') {
      window.ensureRankingTableLoaded();
    } else if (typeof window.fetchRankingTable === 'function') {
      window.fetchRankingTable();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  window.openDailyRankingPage = openDailyRankingPage;
  // Exposed so the Ranking Harian tab (index.html / analisis-saham-runtime.js)
  // can wire up the same "catatan sesi" banner as the dedicated Ranking page,
  // instead of only showing it after the user navigates to that page.
  window.wrapRenderRankingTableForSessionLabel = wrapRenderRankingTableForSessionLabel;
  window.updateRankingSessionLabel = updateRankingSessionLabel;

  function enhanceDailyRanking() {
    ensureRankingNavButtons();
    ensureRankingPageShell();
    return mountRankingCardOnOwnPage();
  }

  function bind() {
    var input = byId('analysisChatInput'); var button = byId('analysisSendBtn');
    if (!input || !button || button.dataset.stockAiBound === 'true') return;
    button.dataset.stockAiBound = 'true';
    button.removeAttribute('onclick'); input.removeAttribute('onkeydown');
    button.addEventListener('click', function (event) { event.preventDefault(); send(); });
    input.addEventListener('keydown', function (event) {
      // isComposing guards IME input: Enter while a candidate list is open must
      // commit the candidate, not send a half-typed question.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
    });
    addScopeNote();
  }
  function init() {
    bind();
    enhanceDailyRanking();
    var attempts = 0;
    var timer = setInterval(function () {
      bind();
      enhanceDailyRanking();
      attempts += 1;
      if (attempts >= 30) clearInterval(timer);
    }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
