(function () {
  'use strict';

  if (window.__AUTOCUAN_PORTFOLIO_AI_RUNTIME_V2__) return;
  window.__AUTOCUAN_PORTFOLIO_AI_RUNTIME_V2__ = true;

  var access = window.__AUTOCUAN_PORTFOLIO_ACCESS__ || {};
  var uid = String(access.userId || localStorage.getItem('autocuan_user_id') || '').trim();
  if (!uid) return;

  var chatKey = 'autocuan_portfolio_ai_chat_' + uid;
  var plansKey = 'autocuan_portfolio_plans_' + uid;
  var pricesKey = 'autocuan_portfolio_prices_' + uid;
  var syncKey = 'autocuan_portfolio_price_sync_v2_' + uid;
  var state = {
    messages: [],
    sending: false,
    timers: [],
    composing: false,
    userAtBottom: true
  };

  function byId(id) { return document.getElementById(id); }
  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }
  function money(value) {
    var n = Number(value);
    return Number.isFinite(n) ? 'Rp ' + Math.round(n).toLocaleString('id-ID') : '—';
  }
  function positive(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function tickerOf(value) {
    var ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
    return /^[A-Z]{3,5}$/.test(ticker) ? ticker : null;
  }
  function authHeaders() {
    return {
      'X-User-Id': uid,
      'X-Username': String(access.username || localStorage.getItem('autocuan_user') || '')
    };
  }

  function contextNow() {
    var plans = readJson(plansKey, []);
    var prices = readJson(pricesKey, {});
    if (!Array.isArray(plans)) plans = [];
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) prices = {};

    var withPrice = 0;
    var totalRisk = 0;
    var totalValue = 0;
    var normalized = plans.slice(0, 30).map(function (plan) {
      var ticker = tickerOf(plan && plan.ticker);
      if (!ticker) return null;
      var entry = positive(plan.entryPriceIdr != null ? plan.entryPriceIdr : plan.entry);
      var stop = positive(plan.stopLossIdr != null ? plan.stopLossIdr : plan.stop);
      var lots = positive(plan.lots);
      var current = positive(prices[ticker]);
      var risk = positive(plan.estimatedMaxLossIdr != null ? plan.estimatedMaxLossIdr : plan.riskBudgetIdr);
      var capital = positive(plan.capitalIdr) || (entry && lots ? entry * lots * 100 : null);
      if (current) withPrice += 1;
      totalRisk += risk || 0;
      totalValue += capital || 0;
      return {
        ticker: ticker,
        entryPriceIdr: entry,
        stopLossIdr: stop,
        tp1Idr: positive(plan.tp1Idr != null ? plan.tp1Idr : plan.tp1),
        tp2Idr: positive(plan.tp2Idr != null ? plan.tp2Idr : plan.tp2),
        lots: lots,
        currentPriceIdr: current,
        estimatedMaxLossIdr: risk,
        capitalIdr: capital,
        source: String(plan.source || '').slice(0, 40),
        positionStatus: String(plan.positionStatus || '').slice(0, 30)
      };
    }).filter(Boolean);

    return {
      plans: normalized,
      prices: prices,
      summary: {
        plan_count: normalized.length,
        positions_with_price: withPrice,
        positions_missing_price: Math.max(0, normalized.length - withPrice),
        total_estimated_risk: totalRisk,
        total_position_value: totalValue
      }
    };
  }

  function saveChat() { writeJson(chatKey, state.messages.slice(-20)); }
  function loadChat() {
    var rows = readJson(chatKey, []);
    var cleaned = Array.isArray(rows) ? rows.slice(-20).filter(function (row) {
      return row && (row.role === 'user' || row.role === 'assistant') && String(row.content || '').trim();
    }) : [];
    state.messages = cleaned.filter(function (row, index) {
      if (index === 0) return true;
      var previous = cleaned[index - 1];
      return previous.role !== row.role || String(previous.content).trim() !== String(row.content).trim();
    });
    saveChat();
  }

  function clearTimers() {
    state.timers.forEach(function (timer) { clearTimeout(timer); });
    state.timers = [];
  }

  function markdown(value) {
    if (window.AutoCuanAI && typeof window.AutoCuanAI.renderMarkdown === 'function') {
      return window.AutoCuanAI.renderMarkdown(value);
    }
    var div = document.createElement('div');
    div.textContent = String(value || '');
    return '<p>' + div.innerHTML.replace(/\n+/g, '</p><p>') + '</p>';
  }

  function renderSummary() {
    var context = contextNow();
    var summary = context.summary;
    if (byId('aiPlanCount')) byId('aiPlanCount').textContent = String(summary.plan_count);
    if (byId('aiWithPrice')) byId('aiWithPrice').textContent = String(summary.positions_with_price);
    if (byId('aiMissingPrice')) byId('aiMissingPrice').textContent = String(summary.positions_missing_price);
    if (byId('aiTotalRisk')) byId('aiTotalRisk').textContent = money(summary.total_estimated_risk);
    if (byId('aiTotalValue')) byId('aiTotalValue').textContent = money(summary.total_position_value);
    if (byId('aiDataQuality')) {
      byId('aiDataQuality').textContent = summary.plan_count === 0
        ? 'Belum ada posisi atau rencana tersimpan.'
        : summary.positions_missing_price > 0
          ? summary.positions_missing_price + ' posisi belum memiliki harga terbaru yang tersimpan.'
          : 'Data posisi dan harga tersimpan siap digunakan.';
    }
  }

  function nearBottom(host) {
    if (!host) return true;
    return host.scrollHeight - host.scrollTop - host.clientHeight < 72;
  }

  function jumpButton() {
    var button = byId('aiJumpLatest');
    if (button) return button;
    var chat = document.querySelector('.ai-chat');
    if (!chat) return null;
    button = document.createElement('button');
    button.id = 'aiJumpLatest';
    button.type = 'button';
    button.className = 'ai-jump-latest hidden';
    button.textContent = 'Pesan terbaru ↓';
    button.addEventListener('click', function () { scrollToLatest(true); });
    chat.appendChild(button);
    return button;
  }

  function updateJumpButton() {
    var button = jumpButton();
    if (!button) return;
    button.classList.toggle('hidden', state.userAtBottom || state.messages.length < 2);
  }

  function scrollToLatest(smooth) {
    var host = byId('aiMessages');
    if (!host) return;
    state.userAtBottom = true;
    var behavior = smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto';
    try { host.scrollTo({ top: host.scrollHeight, behavior: behavior }); }
    catch (_) { host.scrollTop = host.scrollHeight; }
    updateJumpButton();
  }

  function renderChat() {
    var host = byId('aiMessages');
    if (!host) return;
    var previousTop = host.scrollTop;
    var shouldFollow = state.userAtBottom || nearBottom(host) || !host.childElementCount;
    host.innerHTML = '';

    if (!state.messages.length) {
      var intro = document.createElement('div');
      intro.className = 'ai-message ai-system';
      intro.textContent = 'Tanyakan risiko, alokasi, atau prioritas posisi. Jawaban menggunakan data yang tersimpan dan akan menyebutkan jika datanya belum cukup.';
      host.appendChild(intro);
    }

    state.messages.forEach(function (message) {
      var bubble = document.createElement('div');
      bubble.className = 'ai-message ' + (message.role === 'user' ? 'ai-user' : 'ai-assistant ai-rich-text');
      if (message.role === 'user') bubble.textContent = message.content;
      else bubble.innerHTML = markdown(message.content);
      host.appendChild(bubble);
    });

    if (state.sending) {
      var loading = document.createElement('div');
      loading.className = 'ai-message ai-assistant ai-loading';
      loading.innerHTML = '<span id="aiLoadingText">Membaca data portofolio…</span><span class="ai-loading-dot"></span><span class="ai-loading-dot"></span><span class="ai-loading-dot"></span>';
      host.appendChild(loading);
    }

    requestAnimationFrame(function () {
      if (shouldFollow) scrollToLatest(false);
      else {
        host.scrollTop = previousTop;
        state.userAtBottom = nearBottom(host);
        updateJumpButton();
      }
    });
  }

  function addMessage(role, content) {
    var next = String(content || '').trim();
    if (!next) return;
    var previous = state.messages[state.messages.length - 1];
    if (previous && previous.role === role && String(previous.content).trim() === next) return;
    state.messages.push({ role: role, content: next });
    state.messages = state.messages.slice(-20);
    saveChat();
    renderChat();
  }

  function setSending(active) {
    state.sending = active;
    clearTimers();
    var input = byId('aiInput');
    var send = byId('aiSend');
    if (input) input.disabled = active;
    if (send) {
      send.disabled = active;
      send.textContent = active ? 'Memproses…' : 'Kirim';
    }
    renderChat();
    if (!active) return;

    state.timers.push(setTimeout(function () {
      var text = byId('aiLoadingText');
      if (text) text.textContent = 'Masih memproses dan memeriksa jalur AI yang tersedia…';
    }, 7000));
    state.timers.push(setTimeout(function () {
      var text = byId('aiLoadingText');
      if (text) text.textContent = 'Proses membutuhkan waktu lebih lama. Permintaan masih berjalan…';
    }, 17000));
  }

  async function fetchPrice(ticker) {
    try {
      var response = await fetch('/api/quote?ticker=' + encodeURIComponent(ticker) + '&portfolio=1', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: authHeaders()
      });
      var data = await response.json();
      if (!response.ok || !data || data.success === false) return null;
      return positive(data.last != null ? data.last : (data.price != null ? data.price : data.close));
    } catch (_) { return null; }
  }

  async function syncPortfolioPrices(force) {
    var now = Date.now();
    var lastSync = Number(localStorage.getItem(syncKey) || 0);
    if (!force && lastSync && now - lastSync < 5 * 60 * 1000) return 0;

    var context = contextNow();
    var prices = readJson(pricesKey, {});
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) prices = {};
    // Refresh every plan ticker on each sync window, not only ones with no cached
    // price yet. A price that is merely *stale* (fetched an hour/day ago) would
    // otherwise keep grounding the AI forever, since it already passes the
    // "has a price" check. Tickers with no price at all are sorted first so a
    // slow/interrupted sync still resolves genuinely-unpriced positions before
    // merely-stale ones.
    var seen = {};
    var tickers = context.plans.map(function (plan) { return plan.ticker; }).filter(function (ticker) {
      if (!ticker || seen[ticker]) return false;
      seen[ticker] = true;
      return true;
    });
    tickers.sort(function (a, b) { return (positive(prices[a]) ? 1 : 0) - (positive(prices[b]) ? 1 : 0); });
    if (!tickers.length) {
      localStorage.setItem(syncKey, String(now));
      return 0;
    }

    // Bounded concurrency over EVERY distinct ticker, not a fixed batch. A
    // manual portfolio has no hard ticker-count cap, and capping to e.g. the
    // first 12 would silently starve any ticker outside that batch forever —
    // the same ones sort first again on the next sync. A small fixed-size
    // worker pool keeps concurrent /api/quote requests bounded without ever
    // leaving a ticker permanently unrefreshed.
    var queue = tickers.slice();
    var updated = 0;
    async function worker() {
      while (queue.length) {
        var ticker = queue.shift();
        var price = await fetchPrice(ticker);
        if (price) {
          prices[ticker] = Math.round(price);
          updated += 1;
        }
      }
    }
    var workerCount = Math.min(8, tickers.length);
    var workers = [];
    for (var w = 0; w < workerCount; w++) workers.push(worker());
    await Promise.all(workers);

    if (updated) writeJson(pricesKey, prices);
    localStorage.setItem(syncKey, String(now));
    renderSummary();
    return updated;
  }

  function localFallback(question, context) {
    var plans = context.plans || [];
    var summary = context.summary || {};
    if (!plans.length) {
      return 'Belum ada posisi atau rencana yang dapat dinilai. Tambahkan ticker, harga entry, jumlah lot, dan batas risiko terlebih dahulu.';
    }

    var largest = plans.slice().sort(function (a, b) {
      return Number(b.estimatedMaxLossIdr || 0) - Number(a.estimatedMaxLossIdr || 0);
    })[0];
    var riskPct = Number(summary.total_position_value) > 0
      ? Number(summary.total_estimated_risk || 0) / Number(summary.total_position_value) * 100
      : null;
    var lines = ['Jalur AI utama sedang sibuk. Ringkasan berikut dibuat dari data portofolio yang tersimpan.'];

    if (largest) {
      lines.push('**Prioritas perhatian:** ' + largest.ticker + ' memiliki estimasi risiko nominal terbesar, sekitar **' + money(largest.estimatedMaxLossIdr) + '**.');
      if (largest.entryPriceIdr && largest.stopLossIdr) {
        var distance = (largest.entryPriceIdr - largest.stopLossIdr) / largest.entryPriceIdr * 100;
        lines.push('Jarak entry ke stop loss sekitar **' + distance.toFixed(2) + '%**. Pastikan level tersebut benar-benar menjadi batas invalidasi.');
      }
    }

    lines.push('Total estimasi risiko tersimpan adalah **' + money(summary.total_estimated_risk) + '**' + (riskPct != null ? ', sekitar **' + riskPct.toFixed(2) + '%** dari nilai posisi.' : '.'));
    if (Number(summary.positions_missing_price || 0) > 0) {
      lines.push('Sebagian harga belum tersedia, sehingga P/L berjalan belum dapat dinilai penuh.');
    }
    lines.push('Langkah praktis: periksa harga terbaru dan validitas stop loss sebelum menambah posisi atau melakukan average down.');
    return lines.join('\n\n');
  }

  async function sendMessage(text) {
    text = String(text || '').trim();
    if (!text || state.sending) return;

    addMessage('user', text);
    var input = byId('aiInput');
    var status = byId('aiStatus');
    if (input) input.value = '';
    if (status) status.textContent = 'Membaca data dan menyusun jawaban…';
    setSending(true);

    try {
      await syncPortfolioPrices(false);
      var context = contextNow();
      var history = state.messages.slice(0, -1).slice(-6);
      var response = await fetch('/api/analyze', {
        method: 'POST',
        credentials: 'same-origin',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({
          source: 'portfolio_chat',
          chatMessage: text,
          context: context,
          history: history
        })
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data.success || !data.reply) {
        throw new Error(data.error || 'Jalur AI belum tersedia.');
      }
      addMessage('assistant', data.reply);
      if (status) status.textContent = 'Jawaban menggunakan data portofolio yang tersedia.';
    } catch (error) {
      addMessage('assistant', localFallback(text, contextNow()));
      if (status) status.textContent = 'Jalur AI utama sedang sibuk. Ringkasan lokal ditampilkan.';
      console.warn('portfolio-ai cloud fallback', error && error.message);
    } finally {
      setSending(false);
      renderSummary();
    }
  }

  function replaceControl(id) {
    var old = byId(id);
    if (!old || !old.parentNode) return old;
    var clone = old.cloneNode(true);
    old.parentNode.replaceChild(clone, old);
    return clone;
  }

  function bindCleanControls() {
    var input = replaceControl('aiInput');
    var send = replaceControl('aiSend');
    var clear = replaceControl('aiClear');
    var messages = byId('aiMessages');

    if (messages) {
      messages.addEventListener('scroll', function () {
        state.userAtBottom = nearBottom(messages);
        updateJumpButton();
      }, { passive: true });
    }
    if (send) send.addEventListener('click', function (event) {
      event.preventDefault();
      sendMessage(input && input.value);
    });
    if (input) {
      input.addEventListener('compositionstart', function () { state.composing = true; });
      input.addEventListener('compositionend', function () { state.composing = false; });
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey && !state.composing && !event.isComposing) {
          event.preventDefault();
          sendMessage(input.value);
        }
      });
    }
    if (clear) clear.addEventListener('click', function (event) {
      event.preventDefault();
      state.messages = [];
      state.userAtBottom = true;
      saveChat();
      renderChat();
      if (byId('aiStatus')) byId('aiStatus').textContent = 'Percakapan telah dibersihkan.';
    });

    document.querySelectorAll('[data-ai-prompt]').forEach(function (oldButton) {
      var button = oldButton.cloneNode(true);
      oldButton.parentNode.replaceChild(button, oldButton);
      button.addEventListener('click', function (event) {
        event.preventDefault();
        sendMessage(button.getAttribute('data-ai-prompt'));
      });
    });
  }

  function installPremiumLayout() {
    if (!document.getElementById('portfolio-ai-premium-layout')) {
      var style = document.createElement('style');
      style.id = 'portfolio-ai-premium-layout';
      style.textContent = [
        '#page-ai{--ai-surface:#0b111b;--ai-surface-2:#101925;--ai-line:rgba(148,163,184,.16);--ai-accent:#34d399}',
        '#page-ai .ai-shell{max-width:none!important;display:grid!important;grid-template-columns:minmax(0,1.9fr) minmax(270px,.72fr)!important;gap:16px!important;align-items:stretch}',
        '#page-ai .ai-chat{position:relative;min-width:0;height:min(680px,calc(100dvh - 205px));min-height:520px;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto;overflow:hidden;padding:18px;background:linear-gradient(155deg,rgba(16,25,37,.98),rgba(8,13,22,.99));border-color:rgba(74,222,128,.18);box-shadow:0 22px 70px rgba(0,0,0,.28),inset 0 1px rgba(255,255,255,.025)}',
        '#page-ai .ai-chat>.between{padding-bottom:12px;border-bottom:1px solid rgba(148,163,184,.11)}',
        '#page-ai .ai-chat h2{font-size:1.08rem;margin-bottom:3px}',
        '#page-ai .ai-quick{margin:10px 0 8px;gap:7px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}',
        '#page-ai .ai-quick::-webkit-scrollbar{display:none}',
        '#page-ai .ai-quick .btn{border-radius:999px;background:rgba(15,23,42,.82);border-color:rgba(148,163,184,.16);color:#cbd5e1;box-shadow:none}',
        '#page-ai .ai-quick .btn:hover,#page-ai .ai-quick .btn:focus-visible{border-color:rgba(52,211,153,.5);color:#d1fae5;background:rgba(16,185,129,.09)}',
        '#page-ai .ai-messages{min-height:0!important;overflow-y:auto!important;overscroll-behavior:contain;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:10px;padding:12px 6px 16px 2px;scroll-behavior:smooth}',
        '#page-ai .ai-messages::-webkit-scrollbar{width:8px}#page-ai .ai-messages::-webkit-scrollbar-track{background:transparent}#page-ai .ai-messages::-webkit-scrollbar-thumb{background:rgba(100,116,139,.38);border-radius:999px}',
        '#page-ai .ai-message{box-shadow:none;font-size:13.5px;line-height:1.58}',
        '#page-ai .ai-user{max-width:min(520px,82%);background:linear-gradient(135deg,rgba(16,185,129,.16),rgba(6,95,70,.12));border-color:rgba(52,211,153,.24);color:#ecfdf5}',
        '#page-ai .ai-assistant{max-width:min(760px,96%);background:rgba(6,11,19,.78);border-color:rgba(148,163,184,.14);padding:14px 16px}',
        '#page-ai .ai-system{margin:auto;max-width:560px;padding:18px 14px;border:1px dashed rgba(148,163,184,.15);border-radius:14px;background:rgba(15,23,42,.3)}',
        '#page-ai .ai-compose{margin:0;padding-top:11px;border-top:1px solid rgba(148,163,184,.11);background:linear-gradient(180deg,rgba(8,13,22,0),rgba(8,13,22,.98) 24%)}',
        '#page-ai .ai-compose textarea{min-height:54px;max-height:130px;background:rgba(5,10,17,.92);border-color:rgba(148,163,184,.2);border-radius:13px;resize:none}',
        '#page-ai .ai-compose textarea:focus{border-color:rgba(52,211,153,.58);box-shadow:0 0 0 3px rgba(52,211,153,.08)}',
        '#page-ai .ai-compose .btn{min-width:92px;border-radius:12px}',
        '#page-ai .ai-status{margin:7px 2px 0;color:#7f9bb7;font-size:11.5px}',
        '#page-ai .ai-shell>aside{order:initial!important;align-self:stretch;padding:16px;background:linear-gradient(180deg,rgba(15,23,35,.95),rgba(9,15,24,.98));border-color:rgba(148,163,184,.14);box-shadow:0 18px 54px rgba(0,0,0,.2)}',
        '#page-ai .ai-data-grid{grid-template-columns:1fr!important;gap:8px}',
        '#page-ai .ai-data-card{padding:10px 11px;border-radius:10px;background:rgba(5,10,17,.62)}',
        '#page-ai .ai-data-card[style]{grid-column:auto!important}',
        '#page-ai .ai-jump-latest{position:absolute;z-index:5;right:26px;bottom:104px;padding:7px 11px;border:1px solid rgba(52,211,153,.35);border-radius:999px;background:rgba(6,78,59,.94);color:#d1fae5;font:700 11px/1.2 inherit;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.3)}',
        '#page-ai .ai-jump-latest.hidden{display:none}',
        '#page-ai button:focus-visible,#page-ai textarea:focus-visible{outline:2px solid rgba(110,231,183,.75);outline-offset:2px}',
        '@media(max-width:980px){#page-ai .ai-shell{grid-template-columns:1fr!important}#page-ai .ai-chat{height:clamp(540px,72dvh,680px)}#page-ai .ai-shell>aside{order:2!important}#page-ai .ai-data-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}}',
        '@media(max-width:620px){#page-ai .ai-chat{height:clamp(500px,70dvh,640px);min-height:500px;padding:13px}#page-ai .ai-chat>.between{align-items:flex-start}#page-ai .ai-chat>.between .btn{padding:7px 9px;min-height:34px}#page-ai .ai-quick{margin-top:8px}#page-ai .ai-user{max-width:92%}#page-ai .ai-assistant{max-width:98%;padding:12px 13px}#page-ai .ai-compose{grid-template-columns:minmax(0,1fr) auto!important}#page-ai .ai-compose .btn{width:auto!important;min-width:76px;padding:9px 12px}#page-ai .ai-data-grid{grid-template-columns:1fr 1fr!important}#page-ai .ai-jump-latest{right:18px;bottom:103px}}',
        '@media(prefers-reduced-motion:reduce){#page-ai .ai-messages{scroll-behavior:auto}#page-ai *{animation-duration:.01ms!important;transition-duration:.01ms!important}}'
      ].join('');
      document.head.appendChild(style);
    }

    var quicks = document.querySelectorAll('[data-ai-prompt]');
    var replacements = [
      { label: 'Ringkas risiko', prompt: 'Ringkas risiko portofolioku berdasarkan data yang tersedia.' },
      { label: 'Prioritas perhatian', prompt: 'Posisi mana yang paling perlu perhatian dan kenapa?' },
      { label: 'Cek alokasi', prompt: 'Apakah alokasi portofolioku terlalu berat di satu posisi?' },
      { label: 'Evaluasi objektif', prompt: 'Bantu saya menilai posisi secara tenang dan objektif berdasarkan data yang tersimpan.' }
    ];
    Array.prototype.forEach.call(quicks, function (button, index) {
      if (!replacements[index]) return;
      button.textContent = replacements[index].label;
      button.setAttribute('data-ai-prompt', replacements[index].prompt);
    });
    jumpButton();
  }

  async function init() {
    installPremiumLayout();
    loadChat();
    bindCleanControls();
    renderChat();
    renderSummary();
    var status = byId('aiStatus');
    if (status) status.textContent = 'AI siap. Harga tersimpan akan diperbarui bila tersedia.';
    var updated = await syncPortfolioPrices(false);
    if (updated && status) status.textContent = updated + ' harga posisi berhasil diperbarui.';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
