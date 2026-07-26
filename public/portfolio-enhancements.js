(function () {
  'use strict';

  var access = window.__AUTOCUAN_PORTFOLIO_ACCESS__ || {};
  var uid = String(access.userId || localStorage.getItem('autocuan_user_id') || '');
  var chatKey = 'autocuan_portfolio_ai_chat_' + uid;
  var state = { messages: [], sending: false, timers: [] };

  function byId(id) { return document.getElementById(id); }
  function money(value) { var n = Number(value); return Number.isFinite(n) ? 'Rp ' + Math.round(n).toLocaleString('id-ID') : '—'; }
  function readJson(key, fallback) { try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } }
  function writeJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; } }
  function plansKey() { return 'autocuan_portfolio_plans_' + uid; }
  function pricesKey() { return 'autocuan_portfolio_prices_' + uid; }
  function safeTicker(value) { var ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/i, ''); return /^[A-Z]{3,5}$/.test(ticker) ? ticker : null; }
  function positiveNumber(value) { var n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }

  function currentContext() {
    var plans = readJson(plansKey(), []); if (!Array.isArray(plans)) plans = [];
    var prices = readJson(pricesKey(), {}); if (!prices || typeof prices !== 'object') prices = {};
    var withPrice = 0, missing = 0, totalRisk = 0, totalValue = 0;
    plans.forEach(function (p) {
      var ticker = String(p.ticker || '').toUpperCase(), price = Number(prices[ticker]);
      if (Number.isFinite(price) && price > 0) withPrice++; else missing++;
      totalRisk += Number(p.estimatedMaxLossIdr || p.riskBudgetIdr || 0) || 0;
      totalValue += (Number(p.entryPriceIdr || 0) || 0) * (Number(p.lots || 0) || 0) * 100;
    });
    return {
      plans: plans.slice(0, 30),
      prices: prices,
      summary: {
        plan_count: plans.length,
        positions_with_price: withPrice,
        positions_missing_price: missing,
        total_estimated_risk: totalRisk,
        total_position_value: totalValue
      }
    };
  }

  function injectStyles() {
    if (byId('portfolioEnhancementStyles')) return;
    var style = document.createElement('style');
    style.id = 'portfolioEnhancementStyles';
    style.textContent = [
      '.portfolio-help{margin:0 0 14px;padding:14px;border:1px solid rgba(52,211,153,.24);border-radius:14px;background:rgba(16,185,129,.06)}',
      '.portfolio-help h3{margin:0 0 8px;font-size:15px}.portfolio-help ol{margin:8px 0 0;padding-left:20px;color:#cbd5e1}.portfolio-help li{margin:5px 0}',
      '.entry-card{margin:0 0 14px;padding:14px;border:1px solid rgba(96,165,250,.25);border-radius:14px;background:rgba(30,64,175,.08)}',
      '.entry-card h3{margin:0 0 5px}.entry-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.entry-grid .full{grid-column:1/-1}',
      '.entry-note{font-size:11px;color:#94a3b8;margin:4px 0 12px}.entry-success{margin-top:10px;color:#a7f3d0}',
      '.ai-loading{display:flex;gap:8px;align-items:center;color:#bfdbfe}.ai-loading-dot{width:7px;height:7px;border-radius:999px;background:#60a5fa;animation:aiPulse 1s infinite alternate}.ai-loading-dot:nth-child(2){animation-delay:.2s}.ai-loading-dot:nth-child(3){animation-delay:.4s}',
      '@keyframes aiPulse{from{opacity:.25;transform:translateY(0)}to{opacity:1;transform:translateY(-3px)}}',
      '@media(max-width:640px){.entry-grid{grid-template-columns:1fr}.entry-grid .full{grid-column:auto}}'
    ].join('');
    document.head.appendChild(style);
  }

  function polishExistingUi() {
    var badge = document.querySelector('.badge'); if (badge) badge.textContent = 'Akses Disetujui';
    var title = document.querySelector('.brand h1'); if (title) title.textContent = 'Portfolio Decision Center';
    var sub = document.querySelector('.brand p'); if (sub) sub.textContent = 'Rencanakan posisi, pantau risiko, dan ambil keputusan dengan lebih tenang.';
    var tabs = document.querySelectorAll('.tab');
    var labels = ['Ringkasan', 'Rencana Posisi', 'Pantauan', 'Risiko & Avg Down', 'Pengingat Harga', 'Asisten AI'];
    tabs.forEach(function (tab, index) { if (labels[index]) tab.textContent = labels[index]; });
    document.querySelectorAll('h2').forEach(function (h) { if (h.textContent.trim() === 'Sektor Hot Setelah Close') h.textContent = 'Sektor Hot Terbaru'; });
    document.querySelectorAll('p').forEach(function (p) { if (p.textContent.indexOf('Membaca cache VPS') >= 0) p.textContent = 'Ringkasan sektor yang terakhir diperbarui setelah pasar tutup.'; });
    var json = byId('json'), imp = byId('import');
    if (json) {
      var heading = json.previousElementSibling;
      if (heading) {
        heading.textContent = 'Isi otomatis dari Screener';
        if (!heading.nextElementSibling || !heading.nextElementSibling.classList.contains('portfolio-friendly-note')) {
          heading.insertAdjacentHTML('afterend', '<div class="portfolio-friendly-note">Saat saham dibuka dari Screener, ticker dan level rencana akan terisi otomatis. Input manual tetap dapat digunakan.</div>');
        }
      }
      json.style.display = 'none';
    }
    if (imp) imp.style.display = 'none';
  }

  function injectPlannerHelp() {
    var planner = byId('p-planner');
    if (!planner || byId('plannerHowTo')) return;
    var layout = planner.querySelector('.layout');
    if (!layout) return;

    var help = document.createElement('section');
    help.id = 'plannerHowTo';
    help.className = 'portfolio-help';
    help.innerHTML = '<h3>Cara mengisi Rencana Posisi</h3>' +
      '<ol>' +
      '<li><b>Modal tersedia:</b> total uang yang memang siap dipakai, bukan seluruh tabungan.</li>' +
      '<li><b>Profil risiko:</b> Rendah lebih konservatif, Sedang seimbang, Tinggi memberi batas risiko lebih besar.</li>' +
      '<li><b>Risiko per transaksi:</b> maksimal kerugian yang kamu izinkan untuk satu saham. Contoh 1% dari Rp5 juta = Rp50 ribu.</li>' +
      '<li><b>Dana cadangan:</b> uang yang tidak ikut dipakai agar masih ada cash.</li>' +
      '<li><b>Maksimal posisi aktif:</b> berapa saham yang ingin dipegang bersamaan.</li>' +
      '<li><b>Ticker, Entry, Stop Loss, TP1, TP2:</b> isi kode saham dan level harga berdasarkan rencana atau hasil Screener.</li>' +
      '<li>Klik <b>Hitung</b>, cek lot, nilai posisi, maksimal rugi, sisa dana, dan rasio risk/reward sebelum menyimpan.</li>' +
      '</ol>';
    planner.insertBefore(help, layout);
  }

  function injectExistingEntryForm() {
    var planner = byId('p-planner');
    var layout = planner && planner.querySelector('.layout');
    if (!planner || !layout || byId('existingEntryCard')) return;

    var card = document.createElement('section');
    card.id = 'existingEntryCard';
    card.className = 'entry-card';
    card.innerHTML = '<h3>Sudah keburu entry? Catat posisi di sini</h3>' +
      '<p class="entry-note">Pakai harga beli rata-rata dan jumlah lot yang benar-benar sudah dimiliki. Posisi akan masuk ke Pantauan dan bisa dibaca Asisten AI.</p>' +
      '<div class="entry-grid">' +
      '<div><label for="ownedTicker">Ticker</label><input id="ownedTicker" maxlength="8" placeholder="BBRI"></div>' +
      '<div><label for="ownedLots">Jumlah lot yang dimiliki</label><input id="ownedLots" type="number" min="1" step="1" placeholder="10"></div>' +
      '<div><label for="ownedAvg">Harga beli rata-rata</label><input id="ownedAvg" type="number" min="1" step="1" placeholder="4500"></div>' +
      '<div><label for="ownedCurrent">Harga saat ini (opsional)</label><input id="ownedCurrent" type="number" min="1" step="1" placeholder="4550"></div>' +
      '<div><label for="ownedStop">Stop loss rencana</label><input id="ownedStop" type="number" min="1" step="1" placeholder="4300"></div>' +
      '<div><label for="ownedTp1">TP1 (opsional)</label><input id="ownedTp1" type="number" min="1" step="1" placeholder="4800"></div>' +
      '<div><label for="ownedTp2">TP2 (opsional)</label><input id="ownedTp2" type="number" min="1" step="1" placeholder="5100"></div>' +
      '<div class="full"><button id="saveOwnedPosition" class="btn primary" type="button">Simpan Posisi yang Sudah Entry</button><div id="ownedPositionStatus" class="entry-success"></div></div>' +
      '</div>';
    planner.insertBefore(card, layout);

    byId('saveOwnedPosition').onclick = function () {
      var ticker = safeTicker(byId('ownedTicker').value);
      var lots = positiveNumber(byId('ownedLots').value);
      var avg = positiveNumber(byId('ownedAvg').value);
      var current = positiveNumber(byId('ownedCurrent').value);
      var stop = positiveNumber(byId('ownedStop').value);
      var tp1 = positiveNumber(byId('ownedTp1').value);
      var tp2 = positiveNumber(byId('ownedTp2').value);
      var status = byId('ownedPositionStatus');

      if (!ticker || !Number.isInteger(lots) || !avg || !stop || stop >= avg) {
        status.style.color = '#fecaca';
        status.textContent = 'Cek lagi: ticker harus valid, lot bilangan bulat, dan stop loss harus di bawah harga beli rata-rata.';
        return;
      }
      if (tp1 && tp1 <= avg) { status.style.color = '#fecaca'; status.textContent = 'TP1 harus di atas harga beli rata-rata.'; return; }
      if (tp2 && (!tp1 || tp2 <= tp1)) { status.style.color = '#fecaca'; status.textContent = 'TP2 harus di atas TP1.'; return; }

      var plans = readJson(plansKey(), []); if (!Array.isArray(plans)) plans = [];
      var existingIndex = plans.findIndex(function (p) { return String(p.ticker || '').toUpperCase() === ticker; });
      var risk = Math.round(lots * 100 * (avg - stop));
      var plan = {
        ticker: ticker,
        entryPriceIdr: Math.round(avg),
        stopLossIdr: Math.round(stop),
        tp1Idr: tp1 ? Math.round(tp1) : null,
        tp2Idr: tp2 ? Math.round(tp2) : null,
        lots: Math.round(lots),
        estimatedMaxLossIdr: risk,
        riskBudgetIdr: risk,
        capitalIdr: Math.round(lots * 100 * avg),
        createdAt: Date.now(),
        source: 'MANUAL_ALREADY_ENTERED',
        positionStatus: 'ACTIVE'
      };
      if (existingIndex >= 0) plans[existingIndex] = plan; else plans.unshift(plan);
      if (!writeJson(plansKey(), plans.slice(0, 30))) {
        status.style.color = '#fecaca';
        status.textContent = 'Posisi gagal disimpan di browser.';
        return;
      }
      if (current) {
        var prices = readJson(pricesKey(), {}); if (!prices || typeof prices !== 'object') prices = {};
        prices[ticker] = Math.round(current);
        writeJson(pricesKey(), prices);
      }
      status.style.color = '#a7f3d0';
      status.textContent = ticker + ' tersimpan. Memuat ulang Pantauan…';
      setTimeout(function () { window.location.reload(); }, 600);
    };
  }

  function renderDataSummary() {
    var ctx = currentContext(), s = ctx.summary;
    if (byId('aiPlanCount')) byId('aiPlanCount').textContent = String(s.plan_count);
    if (byId('aiWithPrice')) byId('aiWithPrice').textContent = String(s.positions_with_price);
    if (byId('aiMissingPrice')) byId('aiMissingPrice').textContent = String(s.positions_missing_price);
    if (byId('aiTotalRisk')) byId('aiTotalRisk').textContent = money(s.total_estimated_risk);
    if (byId('aiTotalValue')) byId('aiTotalValue').textContent = money(s.total_position_value);
    var quality = byId('aiDataQuality');
    if (quality) quality.textContent = s.plan_count === 0 ? 'Belum ada posisi atau rencana tersimpan.' : (s.positions_missing_price > 0 ? 'Sebagian posisi belum memiliki harga terbaru.' : 'Data lokal cukup untuk analisis portofolio dasar.');
  }

  function saveChat() { try { localStorage.setItem(chatKey, JSON.stringify(state.messages.slice(-20))); } catch (_) {} }
  function loadChat() { var rows = readJson(chatKey, []); state.messages = Array.isArray(rows) ? rows.slice(-20) : []; }
  function addMessage(role, content, persist) { state.messages.push({ role: role, content: String(content || '') }); if (persist !== false) saveChat(); renderChat(); }

  function renderChat() {
    var host = byId('aiMessages'); if (!host) return;
    host.innerHTML = '';
    if (!state.messages.length) {
      var intro = document.createElement('div');
      intro.className = 'ai-message ai-system';
      intro.textContent = 'Tanyakan risiko, alokasi, posisi yang sudah entry, atau ceritakan kekhawatiranmu. Jawaban memakai data yang tersedia dan akan jujur ketika datanya belum cukup.';
      host.appendChild(intro);
    }
    state.messages.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'ai-message ' + (m.role === 'user' ? 'ai-user' : 'ai-assistant');
      div.textContent = m.content;
      host.appendChild(div);
    });
    if (state.sending) {
      var loading = document.createElement('div');
      loading.id = 'aiLoadingBubble';
      loading.className = 'ai-message ai-assistant ai-loading';
      loading.innerHTML = '<span id="aiLoadingText">Memuat data dan memilih model terbaik…</span><span class="ai-loading-dot"></span><span class="ai-loading-dot"></span><span class="ai-loading-dot"></span>';
      host.appendChild(loading);
    }
    host.scrollTop = host.scrollHeight;
  }

  function clearLoadingTimers() {
    state.timers.forEach(function (timer) { clearTimeout(timer); });
    state.timers = [];
  }

  function setLoading(active) {
    state.sending = active;
    clearLoadingTimers();
    renderChat();
    var input = byId('aiInput'), send = byId('aiSend');
    if (input) input.disabled = active;
    if (send) send.disabled = active;
    if (!active) return;

    state.timers.push(setTimeout(function () {
      var text = byId('aiLoadingText');
      if (text) text.textContent = 'Masih memproses data dan mencoba model cadangan…';
      var status = byId('aiStatus');
      if (status) status.textContent = 'Masih memproses. Sistem sedang mencari model yang sehat.';
    }, 6000));

    state.timers.push(setTimeout(function () {
      var text = byId('aiLoadingText');
      if (text) text.textContent = 'Mohon bersabar ya, traffic model sedang ramai…';
      var status = byId('aiStatus');
      if (status) status.textContent = 'Mohon bersabar, traffic model sedang ramai. Pertanyaanmu tetap diproses.';
    }, 13000));
  }

  async function fetchServerSnapshot() {
    try {
      var userId = String(localStorage.getItem('autocuan_user_id') || '');
      var username = String(localStorage.getItem('autocuan_user') || '');
      var response = await fetch('/api/sector-hot?action=web-daily-picks', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-User-Id': userId, 'X-Username': username }
      });
      var data = await response.json();
      if (!response.ok || !data || !data.success) return null;
      return {
        date: data.date || data.latest_locked_fallback_date || null,
        top5_locked: !!data.top5_locked,
        top5: Array.isArray(data.top5) ? data.top5.slice(0, 5).map(function (row) {
          return {
            ticker: row.ticker || null,
            entry: row.entry1 != null ? row.entry1 : row.entry,
            entry2: row.entry2 != null ? row.entry2 : null,
            tp1: row.tp1 != null ? row.tp1 : null,
            tp2: row.tp2 != null ? row.tp2 : null,
            stop_loss: row.sl != null ? row.sl : row.stop_loss,
            category: row.category || row.source || null,
            reason: row.top5_reason || row.alasan_top5 || row.reason || null
          };
        }) : []
      };
    } catch (_) {
      return null;
    }
  }

  function compactServerData(snapshot) {
    if (!snapshot) return 'DATA SERVER TAMBAHAN: tidak tersedia saat permintaan ini diproses.';
    return 'DATA SERVER TAMBAHAN (snapshot Final/Locked, bukan harga real-time): ' + JSON.stringify(snapshot);
  }

  async function sendMessage(text) {
    text = String(text || '').trim();
    if (!text || state.sending) return;
    addMessage('user', text, true);
    var input = byId('aiInput'), status = byId('aiStatus');
    if (input) input.value = '';
    if (status) status.textContent = 'Memuat data portofolio dan memilih model terbaik…';
    setLoading(true);

    try {
      var history = state.messages.slice(0, -1).slice(-10);
      var snapshot = await fetchServerSnapshot();
      var instruction = [
        text,
        '',
        'INSTRUKSI JAWABAN:',
        '- Jawab lengkap dan substantif; jangan terlalu pendek.',
        '- Gunakan seluruh data portofolio yang tersedia dan data server tambahan di bawah ini.',
        '- Jelaskan angka, logika, risiko, dan pilihan tindakan dengan bahasa manusia yang natural.',
        '- Bedakan data nyata, analisis logis, dan hal yang belum diketahui.',
        '- Jangan mengarang harga, berita, transaksi, atau kondisi real-time.',
        compactServerData(snapshot)
      ].join('\n');

      var response = await fetch('/api/analyze', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'portfolio_chat', chatMessage: instruction, context: currentContext(), history: history })
      });
      var data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Asisten AI belum tersedia.');
      setLoading(false);
      addMessage('assistant', data.reply, true);
      if (status) {
        var sourceText = data.portfolio_data_used ? 'Data portofolio digunakan.' : 'Belum ada data portofolio tersimpan.';
        var modelText = data.model_used ? ' Model: ' + data.model_used + '.' : '';
        status.textContent = sourceText + modelText;
      }
    } catch (error) {
      setLoading(false);
      addMessage('assistant', String(error && error.message || 'Asisten AI sedang tidak tersedia.'), true);
      if (status) status.textContent = 'Tidak ada data yang diubah.';
    } finally {
      setLoading(false);
      renderDataSummary();
    }
  }

  function initAi() {
    loadChat(); renderChat(); renderDataSummary();
    var send = byId('aiSend'), input = byId('aiInput'), clear = byId('aiClear');
    if (send) send.onclick = function () { sendMessage(input && input.value); };
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input.value); } });
    if (clear) clear.onclick = function () { state.messages = []; saveChat(); renderChat(); if (byId('aiStatus')) byId('aiStatus').textContent = 'Riwayat percakapan lokal dihapus.'; };
    document.querySelectorAll('[data-ai-prompt]').forEach(function (btn) { btn.onclick = function () { sendMessage(btn.getAttribute('data-ai-prompt')); }; });
    window.addEventListener('storage', renderDataSummary);
  }

  function init() {
    injectStyles();
    polishExistingUi();
    injectPlannerHelp();
    injectExistingEntryForm();
    initAi();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
