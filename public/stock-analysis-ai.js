(function () {
  'use strict';

  if (window.__AUTOCUAN_STOCK_ANALYSIS_AI__) return;
  window.__AUTOCUAN_STOCK_ANALYSIS_AI__ = true;

  var sending = false;
  var timers = [];

  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char];
    });
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
    root.insertAdjacentHTML('beforeend', '<div id="stockAiLoading" class="mt-3 flex gap-3 fade-in-up stock-ai-followup"><div class="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0"><span class="spinner-sm"></span></div><div class="bg-dark-700/60 border border-dark-600/30 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[88%]"><p id="stockAiLoadingText" class="text-sm text-blue-200">Memuat data analisis dan memilih model terbaik…</p></div></div>');
    timers.push(setTimeout(function () { var el = byId('stockAiLoadingText'); if (el) el.textContent = 'Masih memproses data dan mencoba model cadangan…'; }, 6000));
    timers.push(setTimeout(function () { var el = byId('stockAiLoadingText'); if (el) el.textContent = 'Mohon bersabar ya, traffic model sedang ramai…'; }, 13000));
    scrollBottom();
  }
  function removeLoading() {
    clearTimers(); var el = byId('stockAiLoading'); if (el) el.remove();
  }
  function appendAssistant(text, model) {
    var root = byId('analisisResult'); if (!root) return;
    var modelHtml = model ? '<div class="mt-2 text-[10px] text-gray-600">Model: ' + escapeHtml(model) + '</div>' : '';
    root.insertAdjacentHTML('beforeend', '<div class="mt-3 flex gap-3 fade-in-up stock-ai-followup"><div class="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0"><svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg></div><div class="ai-content ai-followup bg-dark-700/60 border border-dark-600/30 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[92%]"><div class="text-sm text-gray-200" style="white-space:pre-wrap">' + escapeHtml(text) + '</div>' + modelHtml + '</div></div>');
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
    note.textContent = 'Tanya lanjutan khusus ticker dan hasil analisis yang sedang tampil. Pertanyaan alokasi seluruh posisi ada di Asisten AI Portofolio.';
    wrap.insertBefore(note, wrap.firstChild);
  }
  async function send() {
    if (sending) return;
    var input = byId('analysisChatInput');
    var message = input ? String(input.value || '').trim() : '';
    if (!message) return;
    var ticker = currentTicker(); var snapshot = analysisSnapshot();
    if (!ticker || !snapshot) {
      appendAssistant('Jalankan analisis ticker dulu ya. Setelah hasilnya muncul, baru kirim pertanyaan lanjutan di sini.');
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
      removeLoading(); appendAssistant(data.reply, data.model_used);
      history.push({ role:'user', content:message }, { role:'assistant', content:data.reply }); writeHistory(ticker, history);
    } catch (error) {
      removeLoading(); appendAssistant(String(error && error.message || 'AI Analisis Saham sedang gangguan. Coba lagi sebentar ya.'));
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
  function init() {
    bind();
    var attempts = 0;
    var timer = setInterval(function () { bind(); attempts += 1; if (attempts >= 30) clearInterval(timer); }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
