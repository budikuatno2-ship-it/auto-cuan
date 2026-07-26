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
  var state = { messages: [], sending: false, timers: [] };

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
    state.messages = Array.isArray(rows) ? rows.slice(-20).filter(function (row) {
      return row && (row.role === 'user' || row.role === 'assistant') && String(row.content || '').trim();
    }) : [];
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
    return div.innerHTML.replace(/\n/g, '<br>');
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
          ? 'Lagi sinkron harga terbaru untuk posisi yang masih kosong.'
          : 'Data posisi dan harga sudah siap dipakai.';
    }
  }

  function renderChat() {
    var host = byId('aiMessages');
    if (!host) return;
    host.innerHTML = '';

    if (!state.messages.length) {
      var intro = document.createElement('div');
      intro.className = 'ai-message ai-system';
      intro.textContent = 'Tanya apa aja soal posisi, risiko, alokasi, atau kekhawatiranmu. Sistem bakal pakai data yang tersedia dan jujur kalau datanya belum cukup.';
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
      loading.innerHTML = '<span id="aiLoadingText">Lagi baca data portofoliomu dulu…</span><span class="ai-loading-dot"></span><span class="ai-loading-dot"></span><span class="ai-loading-dot"></span>';
      host.appendChild(loading);
    }
    host.scrollTop = host.scrollHeight;
  }

  function addMessage(role, content) {
    state.messages.push({ role: role, content: String(content || '') });
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
    if (send) send.disabled = active;
    renderChat();
    if (!active) return;

    state.timers.push(setTimeout(function () {
      var text = byId('aiLoadingText');
      if (text) text.textContent = 'Masih diproses ya, lagi nyari jalur AI yang sehat…';
    }, 7000));
    state.timers.push(setTimeout(function () {
      var text = byId('aiLoadingText');
      if (text) text.textContent = 'Agak lama nih, tapi request-mu masih jalan. Santai bentar ya…';
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

  async function syncMissingPrices(force) {
    var now = Date.now();
    var lastSync = Number(localStorage.getItem(syncKey) || 0);
    if (!force && lastSync && now - lastSync < 5 * 60 * 1000) return 0;

    var context = contextNow();
    var prices = readJson(pricesKey, {});
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) prices = {};
    var missing = context.plans.filter(function (plan) { return !positive(prices[plan.ticker]); }).slice(0, 12);
    if (!missing.length) {
      localStorage.setItem(syncKey, String(now));
      return 0;
    }

    var results = await Promise.all(missing.map(async function (plan) {
      return { ticker: plan.ticker, price: await fetchPrice(plan.ticker) };
    }));
    var updated = 0;
    results.forEach(function (row) {
      if (row.price) {
        prices[row.ticker] = Math.round(row.price);
        updated += 1;
      }
    });
    if (updated) writeJson(pricesKey, prices);
    localStorage.setItem(syncKey, String(now));
    renderSummary();
    return updated;
  }

  function localFallback(question, context) {
    var plans = context.plans || [];
    var summary = context.summary || {};
    if (!plans.length) {
      return 'Belum ada posisi atau rencana yang bisa dibaca. Isi dulu ticker, harga entry, jumlah lot, dan stop loss. Setelah itu sistem bisa menghitung risiko, konsentrasi modal, dan posisi yang paling perlu diperhatikan.';
    }

    var largest = plans.slice().sort(function (a, b) {
      return Number(b.estimatedMaxLossIdr || 0) - Number(a.estimatedMaxLossIdr || 0);
    })[0];
    var riskPct = Number(summary.total_position_value) > 0
      ? (Number(summary.total_estimated_risk || 0) / Number(summary.total_position_value) * 100)
      : null;

    var lines = [
      'AI cloud-nya lagi kurang kooperatif, tapi datamu tetap bisa dibaca lewat **mode data lokal**.',
      '',
      '### Ringkasan portofolio',
      '- Posisi/rencana tersimpan: **' + plans.length + '**',
      '- Nilai posisi rencana: **' + money(summary.total_position_value) + '**',
      '- Estimasi risiko maksimum: **' + money(summary.total_estimated_risk) + '**' + (riskPct != null ? ' atau sekitar **' + riskPct.toFixed(2) + '%** dari nilai posisi.' : '.'),
      '- Posisi yang sudah punya harga terbaru: **' + Number(summary.positions_with_price || 0) + '**',
      '- Harga yang masih kosong: **' + Number(summary.positions_missing_price || 0) + '**',
      '',
      '### Yang paling perlu diperhatikan'
    ];

    if (largest) {
      lines.push('- Risiko nominal terbesar saat ini ada di **' + largest.ticker + '**, sekitar **' + money(largest.estimatedMaxLossIdr) + '**.');
      if (largest.entryPriceIdr && largest.stopLossIdr) {
        var distance = (largest.entryPriceIdr - largest.stopLossIdr) / largest.entryPriceIdr * 100;
        lines.push('- Jarak entry ke stop loss **' + largest.ticker + '** sekitar **' + distance.toFixed(2) + '%**.');
      }
    }

    if (Number(summary.positions_missing_price || 0) > 0) {
      lines.push('- P/L berjalan belum bisa dinilai penuh karena masih ada harga terbaru yang kosong. Sistem sedang mencoba sinkron otomatis.');
    }

    lines.push('', '### Saran paling masuk akal sekarang');
    lines.push('- Pastikan stop loss setiap posisi memang level invalidasi, bukan sekadar angka biar kelihatan aman.');
    lines.push('- Jangan tambah posisi baru sebelum total risiko gabungan masih sesuai batas yang kamu sanggupi.');
    lines.push('- Untuk keputusan spesifik seperti average down atau cut loss, cek harga terbaru dan validitas setup dulu—jangan cuma lihat harga merah/hijau.');
    lines.push('', '_Pertanyaanmu: “' + String(question || '').slice(0, 180) + '”_');
    return lines.join('\n');
  }

  async function sendMessage(text) {
    text = String(text || '').trim();
    if (!text || state.sending) return;

    addMessage('user', text);
    var input = byId('aiInput');
    var status = byId('aiStatus');
    if (input) input.value = '';
    if (status) status.textContent = 'Lagi baca data dan nyusun jawaban…';
    setSending(true);

    try {
      await syncMissingPrices(false);
      var context = contextNow();
      var history = state.messages.slice(0, -1).slice(-6);
      var response = await fetch('/api/analyze', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'portfolio_chat',
          chatMessage: text,
          context: context,
          history: history
        })
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data.success || !data.reply) {
        throw new Error(data.error || 'AI cloud lagi nggak bisa dipakai.');
      }
      addMessage('assistant', data.reply);
      if (status) status.textContent = 'Jawaban dibuat dari data portofolio yang tersedia.';
    } catch (error) {
      var fallbackContext = contextNow();
      addMessage('assistant', localFallback(text, fallbackContext));
      if (status) status.textContent = 'AI cloud lagi ngadat, jadi sistem pakai mode data lokal biar kamu tetap dapat jawaban.';
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

    if (send) send.addEventListener('click', function (event) {
      event.preventDefault();
      sendMessage(input && input.value);
    });
    if (input) input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage(input.value);
      }
    });
    if (clear) clear.addEventListener('click', function (event) {
      event.preventDefault();
      state.messages = [];
      saveChat();
      renderChat();
      if (byId('aiStatus')) byId('aiStatus').textContent = 'Chat sudah dibersihkan.';
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

  async function init() {
    loadChat();
    bindCleanControls();
    renderChat();
    renderSummary();
    var status = byId('aiStatus');
    if (status) status.textContent = 'AI siap. Harga posisi akan disinkronkan otomatis.';
    var updated = await syncMissingPrices(false);
    if (updated && status) status.textContent = updated + ' harga posisi berhasil disinkronkan. AI siap dipakai.';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
