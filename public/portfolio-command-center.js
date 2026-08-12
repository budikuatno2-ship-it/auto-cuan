(function () {
  'use strict';

  var ACCESS_TIMEOUT_MS = 9000;
  var Model = window.AutoCuanPortfolioCommandModel;
  var Planner = window.AutoCuanPortfolioPlannerV1;
  if (!Model || !Planner) return;

  var state = {
    uid: '', username: '', plans: [], prices: {}, sectors: [], candidates: [],
    journal: [], changes: [], lastPlan: null, capacity: null, activeTicker: '', bound: false
  };

  function $(id) { return document.getElementById(id); }
  function show(id) { var el = $(id); if (el) el.classList.remove('hidden'); }
  function hide(id) { var el = $(id); if (el) el.classList.add('hidden'); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function num(value) { var n = Number(String(value == null ? '' : value).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : null; }
  function money(value) { var n = Number(value); return Number.isFinite(n) ? 'Rp ' + Math.round(n).toLocaleString('id-ID') : '—'; }
  // Profit and loss were rendered in the same neutral ink as every other figure,
  // so a portfolio down Rp 249.000 looked identical at a glance to one up the
  // same amount — the reader had to parse the minus sign to find out. This adds
  // the gain/loss tone that a financial surface is expected to carry. The sign
  // stays in the text, so colour is reinforcement rather than the only cue.
  function pnlClass(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return 'pnl pnl-unknown';
    if (n > 0) return 'pnl pnl-up';
    if (n < 0) return 'pnl pnl-down';
    return 'pnl pnl-flat';
  }
  function pct(value) { var n = Number(value); return Number.isFinite(n) ? n.toFixed(2) + '%' : '—'; }
  function ticker(value) { return Model.tickerOf(value); }
  function safeJson(key, fallback) { try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } }
  function saveJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; } }
  function plansKey() { return 'autocuan_portfolio_plans_' + state.uid; }
  function pricesKey() { return 'autocuan_portfolio_prices_' + state.uid; }
  function journalKey() { return 'autocuan_portfolio_journal_v1_' + state.uid; }
  function snapshotKey() { return 'autocuan_portfolio_command_snapshot_v1_' + state.uid; }
  function changesKey() { return 'autocuan_portfolio_command_changes_v1_' + state.uid; }
  function priceTimeKey() { return 'autocuan_portfolio_price_updated_v1_' + state.uid; }

  function toast(message) {
    var host = $('toastHost');
    if (!host) return;
    var node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    host.appendChild(node);
    setTimeout(function () { if (node.parentNode) node.remove(); }, 3200);
  }

  function fetchWithTimeout(url, options, timeout) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout);
    var opts = Object.assign({}, options || {}, { signal: controller.signal });
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  function authHeaders() {
    return { 'X-User-Id': state.uid, 'X-Username': state.username };
  }

  function setGateError(message) {
    $('accessGate').innerHTML = '<h2>Portfolio belum berhasil dibuka</h2><p class="muted">' + escapeHtml(message || 'Sesi tidak dapat diverifikasi.') + '</p><div class="actions" style="justify-content:center"><button id="retryAccess" class="btn primary">Coba Lagi</button><a class="btn" href="/">Login Ulang</a></div>';
    $('retryAccess').onclick = checkAccess;
  }

  function loadLocalState() {
    state.plans = safeJson(plansKey(), []);
    if (!Array.isArray(state.plans)) state.plans = [];
    state.prices = safeJson(pricesKey(), {});
    if (!state.prices || typeof state.prices !== 'object' || Array.isArray(state.prices)) state.prices = {};
    state.journal = safeJson(journalKey(), []);
    if (!Array.isArray(state.journal)) state.journal = [];
    state.changes = safeJson(changesKey(), []);
    if (!Array.isArray(state.changes)) state.changes = [];
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-command-src="' + src + '"]')) return resolve();
      var script = document.createElement('script');
      script.src = src;
      script.dataset.commandSrc = src;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Gagal memuat Asisten AI.')); };
      document.body.appendChild(script);
    });
  }

  async function checkAccess() {
    $('accessGate').innerHTML = '<span class="spinner" aria-hidden="true"></span><h2>Memeriksa akses aman…</h2><p class="muted">Maksimal 9 detik. Jika gagal, tombol coba lagi akan muncul.</p>';
    try {
      var response = await fetchWithTimeout('/api/admin-users', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({ action: 'portfolio_access' })
      }, ACCESS_TIMEOUT_MS);
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data || data.success !== true || !data.user_id) throw new Error(data.error || 'Akun belum mendapat akses.');
      state.uid = String(data.user_id);
      state.username = String(data.username || '');
      localStorage.setItem('autocuan_user_id', state.uid);
      if (state.username) localStorage.setItem('autocuan_user', state.username);
      window.__AUTOCUAN_PORTFOLIO_ACCESS__ = { userId: state.uid, username: state.username };
      loadLocalState();
      $('sessionChip').innerHTML = '<span class="status-dot"></span>' + escapeHtml(state.username || 'Sesi aktif');
      hide('accessGate'); show('app'); bind();
      await loadSectorHot();
      calculateBudget();
      renderAll();
      loadScript('/portfolio-ai-runtime-v2.js?v=20260727-premium-v2').catch(function (error) { $('aiStatus').textContent = error.message; });
      setTimeout(function () { loadLocalState(); renderAll(); }, 600);
    } catch (error) {
      setGateError(error && error.name === 'AbortError' ? 'Pemeriksaan akses terlalu lama. Coba lagi atau login ulang.' : error.message);
    }
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    document.querySelectorAll('[data-tab]').forEach(function (button) {
      button.addEventListener('click', function () { openTab(button.dataset.tab); });
      button.addEventListener('keydown', function (event) { navigateTabs(event, button); });
    });
    $('refreshToday').onclick = function () { refreshAllPrices(true); };
    $('captureSnapshot').onclick = captureSnapshot;
    $('calculateBudget').onclick = calculateBudget;
    $('checkBudgetTicker').onclick = checkBudgetTicker;
    $('budgetProfile').onchange = applyBudgetProfile;
    $('riskProfile').onchange = applyRiskProfile;
    $('calculatePlan').onclick = calculatePlan;
    $('resetPlan').onclick = resetPlanner;
    $('savePlan').onclick = saveCalculatedPlan;
    $('saveOwned').onclick = saveOwned;
    $('refreshPrices').onclick = function () { refreshAllPrices(true); };
    $('evaluateRisk').onclick = evaluateRisk;
    $('riskPlan').onchange = fillRiskDefaults;
    $('checkAlerts').onclick = checkAlertLevels;
    $('alertPrices').onchange = saveManualPrice;
    $('openJournalModal').onclick = function () { openJournalModal(); };
    $('closeJournalModal').onclick = closeJournalModal;
    $('cancelJournal').onclick = closeJournalModal;
    $('journalBackdrop').onclick = closeJournalModal;
    $('saveJournal').onclick = saveJournal;
    $('exportJournal').onclick = exportJournal;
    $('closeDrawer').onclick = closeDrawer;
    $('drawerBackdrop').onclick = closeDrawer;
    document.addEventListener('click', delegatedClick);
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { closeDrawer(); closeJournalModal(); } });
    window.addEventListener('focus', resyncLocalState);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) resyncLocalState(); });
  }

  function navigateTabs(event, button) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));
    var index = tabs.indexOf(button);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index].focus(); openTab(tabs[index].dataset.tab);
  }

  function openTab(name) {
    document.querySelectorAll('[data-tab]').forEach(function (button) {
      var active = button.dataset.tab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.page').forEach(function (page) { page.classList.remove('active'); });
    var page = $('page-' + name); if (page) page.classList.add('active');
    if (name === 'watch') renderWatch();
    if (name === 'risk') renderRiskOptions();
    if (name === 'alerts') renderAlerts();
    if (name === 'journal') renderJournal();
  }

  function delegatedClick(event) {
    var tickerButton = event.target.closest('[data-open-ticker]');
    if (tickerButton) return openTickerDrawer(tickerButton.getAttribute('data-open-ticker'));
    var remove = event.target.closest('[data-delete-plan]');
    if (remove) return deletePlan(remove.getAttribute('data-delete-plan'));
    var budgetUse = event.target.closest('[data-budget-use]');
    if (budgetUse) return useBudgetCandidate(budgetUse.getAttribute('data-budget-use'));
    var journal = event.target.closest('[data-journal-ticker]');
    if (journal) return openJournalModal(journal.getAttribute('data-journal-ticker'));
    var drawerAction = event.target.closest('[data-drawer-action]');
    if (drawerAction) return handleDrawerAction(drawerAction.getAttribute('data-drawer-action'));
    var removeJournal = event.target.closest('[data-delete-journal]');
    if (removeJournal) return deleteJournal(removeJournal.getAttribute('data-delete-journal'));
  }

  function resyncLocalState() { if (!state.uid) return; loadLocalState(); renderAll(); }
  function persistPlans() { saveJson(plansKey(), state.plans); renderAll(); }
  function persistJournal() { saveJson(journalKey(), state.journal.slice(0, 200)); renderJournal(); }

  function renderAll() {
    renderToday(); renderWatch(); renderRiskOptions(); renderAlerts(); renderJournal();
  }

  function renderToday() {
    var summary = Model.summarize(state.plans, state.prices);
    $('sumPlans').textContent = summary.planCount;
    $('sumPriced').textContent = summary.pricedCount + ' memiliki harga';
    $('sumAttention').textContent = summary.attentionCount;
    $('sumExposure').textContent = money(summary.totalExposureIdr);
    $('sumRisk').textContent = money(summary.totalRiskIdr);
    $('sumPnl').textContent = summary.totalPnlIdr == null ? 'P/L —' : 'P/L ' + money(summary.totalPnlIdr);
    $('sumPnl').className = pnlClass(summary.totalPnlIdr);
    $('postureLabel').textContent = summary.posture.label;
    $('postureCard').className = 'posture ' + summary.posture.tone;
    $('decisionTitle').textContent = summary.planCount ? summary.posture.note : 'Bangun rencana yang jelas sebelum mengambil posisi.';
    $('decisionNote').textContent = summary.planCount ? 'Prioritas dihitung dari entry, stop, target, harga tersimpan, dan risiko nominal.' : 'Mulai dari Budget-to-Stock Planner atau catat posisi yang sudah dimiliki.';
    $('qualityPriced').textContent = summary.pricedCount + ' / ' + summary.planCount;
    var updatedAt = Number(localStorage.getItem(priceTimeKey()) || 0);
    $('qualityUpdated').textContent = updatedAt ? new Date(updatedAt).toLocaleString('id-ID') : 'Belum ada';
    $('qualityNote').textContent = summary.missingPriceCount ? summary.missingPriceCount + ' posisi belum memiliki harga tersimpan.' : summary.planCount ? 'Semua posisi memiliki harga tersimpan. Tetap periksa waktu pembaruannya.' : 'Belum ada posisi yang dapat dinilai.';
    renderActions(summary.actions);
    renderTimeline();
  }

  function renderActions(actions) {
    if (!actions.length) { $('todayActions').className = 'empty'; $('todayActions').textContent = 'Belum ada posisi yang perlu tindakan.'; return; }
    $('todayActions').className = 'action-list';
    $('todayActions').innerHTML = actions.slice(0, 7).map(function (row, index) {
      var detail = row.currentPriceIdr ? 'Harga ' + money(row.currentPriceIdr) : 'Harga belum tersedia';
      return '<div class="action-item"><span class="action-rank">' + (index + 1) + '</span><div class="action-copy"><strong>' + escapeHtml(row.ticker) + ' · ' + escapeHtml(row.status.label) + '</strong><span>' + detail + ' · Entry ' + money(row.entryPriceIdr) + ' · Stop ' + money(row.stopLossIdr) + '</span></div><button class="btn small" data-open-ticker="' + escapeHtml(row.ticker) + '">Tinjau</button></div>';
    }).join('');
  }

  function captureSnapshot() {
    var current = Model.buildSnapshot(state.plans, state.prices);
    var previous = safeJson(snapshotKey(), null);
    var events = previous ? Model.compareSnapshots(previous, current) : [];
    if (!previous) events.push({ type: 'BASELINE', ticker: '', tone: 'neutral', text: 'Snapshot awal disimpan sebagai pembanding.' });
    var time = new Date().toISOString();
    state.changes = events.map(function (row) { return Object.assign({ at: time }, row); }).concat(state.changes).slice(0, 60);
    saveJson(snapshotKey(), current); saveJson(changesKey(), state.changes); renderTimeline();
    toast(events.length + ' perubahan dicatat.');
  }

  function renderTimeline() {
    if (!state.changes.length) { $('changeTimeline').className = 'empty'; $('changeTimeline').textContent = 'Belum ada snapshot pembanding.'; return; }
    $('changeTimeline').className = 'timeline';
    $('changeTimeline').innerHTML = state.changes.slice(0, 10).map(function (row) {
      return '<div class="timeline-item"><span class="timeline-mark ' + escapeHtml(row.tone || 'neutral') + '"></span><div class="timeline-copy"><strong>' + escapeHtml(row.ticker || row.type || 'Snapshot') + '</strong><span>' + escapeHtml(row.text) + ' · ' + new Date(row.at).toLocaleString('id-ID') + '</span></div></div>';
    }).join('');
  }

  async function loadSectorHot() {
    try {
      var response = await fetch('/api/sector-hot', { credentials: 'same-origin', cache: 'no-store' });
      var data = await response.json().catch(function () { return {}; });
      var groups = Array.isArray(data.groups) ? data.groups.slice() : [];
      groups.sort(function (a, b) { return Number(b.avg_change_pct || -999) - Number(a.avg_change_pct || -999); });
      state.sectors = groups.slice(0, 6);
      renderSectors();
      await seedSectorCandidates();
    } catch (_) { state.sectors = []; renderSectors(); }
  }

  function renderSectors() {
    if (!state.sectors.length) { $('sectorHotList').innerHTML = '<div class="empty">Cache sektor belum tersedia.</div>'; return; }
    $('sectorHotList').innerHTML = state.sectors.slice(0, 3).map(function (group) {
      return '<button class="sector-card ticker-link" data-open-ticker="' + escapeHtml(ticker(group.top_ticker) || '') + '"><strong>' + escapeHtml(group.group_name || group.group_code || 'Sektor') + '</strong><span>Avg ' + Number(group.avg_change_pct || 0).toFixed(2) + '% · Top ' + escapeHtml(group.top_ticker || '—') + '</span></button>';
    }).join('');
  }

  async function quote(symbol) {
    var t = ticker(symbol); if (!t) return null;
    try {
      var response = await fetch('/api/quote?ticker=' + encodeURIComponent(t) + '&portfolio=1', { credentials: 'same-origin', cache: 'no-store', headers: authHeaders() });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || data.success === false) return null;
      return num(data.last != null ? data.last : (data.price != null ? data.price : data.close));
    } catch (_) { return null; }
  }

  async function refreshAllPrices(force) {
    var symbols = [];
    state.plans.forEach(function (plan) { var t = ticker(plan.ticker); if (t && symbols.indexOf(t) < 0) symbols.push(t); });
    if (!symbols.length) { toast('Belum ada ticker untuk diperbarui.'); return; }
    var buttons = [$('refreshToday'), $('refreshPrices')].filter(Boolean);
    buttons.forEach(function (button) { button.disabled = true; button.textContent = 'Memuat…'; });
    try {
      var rows = await Promise.all(symbols.slice(0, 20).map(async function (t) { return [t, await quote(t)]; }));
      var updated = 0;
      rows.forEach(function (row) { if (row[1] && row[1] > 0) { state.prices[row[0]] = Math.round(row[1]); updated += 1; } });
      saveJson(pricesKey(), state.prices); localStorage.setItem(priceTimeKey(), String(Date.now()));
      renderAll(); if (force) captureSnapshot(); toast(updated + ' harga berhasil diperbarui.');
    } finally {
      buttons.forEach(function (button) { button.disabled = false; button.textContent = button.id === 'refreshToday' ? 'Refresh data' : 'Refresh Harga'; });
    }
  }

  function applyBudgetProfile() {
    var map = { LOW: 3, MEDIUM: 4, HIGH: 5 };
    $('budgetPositions').value = map[$('budgetProfile').value] || 4;
    calculateBudget();
  }

  function calculateBudget() {
    hide('budgetError');
    state.capacity = Model.budgetCapacity({ capitalIdr: $('budgetCapital').value, reservePct: $('budgetReserve').value, maxPositions: $('budgetPositions').value });
    if (!state.capacity.ok) { $('budgetError').textContent = state.capacity.error; show('budgetError'); $('budgetBands').innerHTML = ''; return; }
    $('budgetBands').innerHTML = [
      ['Minimal 1 lot', state.capacity.maxPriceOneLotIdr], ['Minimal 2 lot', state.capacity.maxPriceTwoLotsIdr], ['Minimal 4 lot', state.capacity.maxPriceFourLotsIdr]
    ].map(function (row) { return '<div class="budget-band"><span>' + row[0] + '</span><strong>Maks. ' + money(row[1]) + ' / saham</strong></div>'; }).join('');
    renderBudgetCandidates();
  }

  async function seedSectorCandidates() {
    var tickers = [];
    state.sectors.forEach(function (group) { var t = ticker(group.top_ticker); if (t && tickers.indexOf(t) < 0) tickers.push(t); });
    var rows = await Promise.all(tickers.slice(0, 6).map(async function (t) { return { ticker: t, price: await quote(t), source: 'Sektor Hot' }; }));
    rows.forEach(upsertCandidate); renderBudgetCandidates();
  }

  function upsertCandidate(row) {
    if (!row || !ticker(row.ticker)) return;
    var t = ticker(row.ticker); var existing = state.candidates.find(function (item) { return item.ticker === t; });
    if (existing) Object.assign(existing, row, { ticker: t });
    else state.candidates.push(Object.assign({}, row, { ticker: t }));
  }

  async function checkBudgetTicker() {
    calculateBudget();
    var t = ticker($('budgetTicker').value);
    if (!t) { $('budgetError').textContent = 'Ticker harus 3–5 huruf.'; show('budgetError'); return; }
    var button = $('checkBudgetTicker'); button.disabled = true; button.textContent = 'Memuat…';
    try {
      var price = await quote(t);
      if (!price) { $('budgetError').textContent = 'Harga ' + t + ' belum tersedia.'; show('budgetError'); return; }
      upsertCandidate({ ticker: t, price: Math.round(price), source: 'Cek manual' }); renderBudgetCandidates();
    } finally { button.disabled = false; button.textContent = 'Cek Ticker'; }
  }

  function renderBudgetCandidates() {
    if (!state.capacity || !state.capacity.ok) return;
    var rows = state.candidates.filter(function (row) { return row.price; }).map(function (row) { return Object.assign({}, row, { fit: Model.affordability(row.price, state.capacity) }); });
    rows.sort(function (a, b) { return (b.fit ? b.fit.lots : 0) - (a.fit ? a.fit.lots : 0); });
    if (!rows.length) { $('budgetCandidates').className = 'empty'; $('budgetCandidates').textContent = 'Belum ada kandidat dengan harga tersedia.'; return; }
    $('budgetCandidates').className = 'candidate-list';
    $('budgetCandidates').innerHTML = rows.map(function (row) {
      var fit = row.fit;
      return '<div class="candidate-item"><div class="candidate-main"><strong><button class="ticker-link" data-open-ticker="' + row.ticker + '">' + row.ticker + '</button></strong><div class="candidate-stat"><span>Harga</span><b>' + money(row.price) + '</b></div><div class="candidate-stat"><span>Kapasitas</span><b>' + (fit ? fit.lots : 0) + ' lot</b></div><div><span class="pill ' + (fit ? fit.tone : 'neutral') + '">' + (fit ? fit.label : '—') + '</span></div></div><button class="btn small" data-budget-use="' + row.ticker + '">Gunakan di Rencana</button></div>';
    }).join('');
  }

  function useBudgetCandidate(symbol) {
    var row = state.candidates.find(function (item) { return item.ticker === symbol; });
    openTab('planner'); $('ticker').value = symbol; $('entry').value = row && row.price ? Math.round(row.price) : '';
    $('capital').value = $('budgetCapital').value; $('reservePct').value = $('budgetReserve').value; $('maxPositions').value = $('budgetPositions').value;
    $('stop').value = ''; $('stop').focus(); toast('Ticker dan entry terisi. Tentukan stop loss dari analisis yang valid.');
  }

  function applyRiskProfile() {
    var preset = Planner.RISK_PRESETS[$('riskProfile').value]; if (!preset) return;
    $('riskPct').value = (preset.defaultRiskBps / 100).toFixed(2); $('maxPositions').value = preset.defaultMaxPositions;
  }

  function calculatePlan() {
    hide('plannerError'); hide('saveMessage');
    var t = ticker($('ticker').value);
    if (!t) { $('plannerError').textContent = 'Ticker harus 3–5 huruf.'; show('plannerError'); return; }
    var result = Planner.calculate({
      capitalIdr: $('capital').value, riskProfile: $('riskProfile').value,
      riskBps: Math.round(Number($('riskPct').value) * 100), reserveBps: Math.round(Number($('reservePct').value) * 100),
      maxPositions: Number($('maxPositions').value), entryPriceIdr: $('entry').value, stopLossIdr: $('stop').value,
      tp1Idr: $('tp1').value, tp2Idr: $('tp2').value
    });
    if (!result.ok) { $('plannerError').textContent = (result.errors || []).map(function (row) { return row.message; }).join(' '); show('plannerError'); return; }
    state.lastPlan = {
      id: 'plan_' + Date.now(), ticker: t, entryPriceIdr: result.input.entryPriceIdr.value,
      stopLossIdr: result.input.stopLossIdr.value, tp1Idr: result.input.tp1Idr && result.input.tp1Idr.value,
      tp2Idr: result.input.tp2Idr && result.input.tp2Idr.value, lots: result.result.recommendedLots.value,
      riskBudgetIdr: result.result.estimatedStopLossIdr.value, estimatedMaxLossIdr: result.result.estimatedStopLossIdr.value,
      capitalIdr: result.result.positionValueIdr.value, createdAt: new Date().toISOString(), source: 'planner', positionStatus: 'PLANNED'
    };
    $('outLots').textContent = result.result.recommendedLots.value + ' lot'; $('outValue').textContent = money(result.result.positionValueIdr.value);
    $('outLoss').textContent = money(result.result.estimatedStopLossIdr.value); $('outCash').textContent = money(result.result.remainingCashIdr.value);
    $('outAllocation').textContent = pct(result.result.allocationBps.value / 100); $('outRr1').textContent = result.result.rewardRiskTp1 ? (result.result.rewardRiskTp1.bps / 10000).toFixed(2) + 'x' : '—';
    $('outRr2').textContent = result.result.rewardRiskTp2 ? (result.result.rewardRiskTp2.bps / 10000).toFixed(2) + 'x' : '—'; $('outMaxPrice').textContent = money(result.guidance.maxPricePerPositionOneLotIdr.value);
    $('planWarnings').innerHTML = (result.warnings || []).map(function (row) { return '<div class="note">' + escapeHtml(row.message) + '</div>'; }).join('');
    hide('planEmpty'); show('planResult'); $('savePlan').disabled = false;
  }

  function resetPlanner() {
    ['ticker','entry','stop','tp1','tp2'].forEach(function (id) { $(id).value = ''; });
    state.lastPlan = null; hide('planResult'); show('planEmpty'); hide('plannerError'); $('savePlan').disabled = true;
  }

  function saveCalculatedPlan() {
    if (!state.lastPlan) return;
    state.plans.unshift(state.lastPlan); persistPlans(); $('saveMessage').textContent = state.lastPlan.ticker + ' berhasil disimpan.'; show('saveMessage'); $('savePlan').disabled = true; captureSnapshot();
  }

  function saveOwned() {
    hide('ownedMessage');
    var t = ticker($('ownedTicker').value), entry = num($('ownedEntry').value), lots = num($('ownedLots').value), stop = num($('ownedStop').value);
    if (!t || !entry || !lots || !stop || stop >= entry) { $('ownedMessage').textContent = 'Isi ticker, harga beli, lot, dan stop loss dengan benar.'; show('ownedMessage'); return; }
    state.plans.unshift({ id:'owned_' + Date.now(), ticker:t, entryPriceIdr:Math.round(entry), stopLossIdr:Math.round(stop), tp1Idr:num($('ownedTp1').value), tp2Idr:num($('ownedTp2').value), lots:Math.round(lots), riskBudgetIdr:Math.round((entry-stop)*lots*100), estimatedMaxLossIdr:Math.round((entry-stop)*lots*100), capitalIdr:Math.round(entry*lots*100), createdAt:new Date().toISOString(), source:'owned_position', positionStatus:'OWNED' });
    persistPlans(); $('ownedMessage').textContent = t + ' sudah dicatat.'; show('ownedMessage');
    ['ownedTicker','ownedEntry','ownedLots','ownedStop','ownedTp1','ownedTp2'].forEach(function (id) { $(id).value = ''; }); captureSnapshot();
  }

  function renderWatch() {
    var summary = Model.summarize(state.plans, state.prices);
    if (!summary.plans.length) { show('watchEmpty'); hide('watchTable'); $('watchCards').innerHTML = ''; return; }
    hide('watchEmpty'); show('watchTable');
    var rows = summary.plans.map(function (plan) {
      var current = num(state.prices[plan.ticker]); var status = Model.planStatus(plan, current);
      var pnl = current && plan.entryPriceIdr ? (current - plan.entryPriceIdr) * plan.lots * 100 : null;
      return { plan:plan, current:current, status:status, pnl:pnl };
    });
    $('watchBody').innerHTML = rows.map(function (row) { var p=row.plan; return '<tr><td><button class="ticker-link" data-open-ticker="'+p.ticker+'">'+p.ticker+'</button></td><td><span class="pill '+row.status.tone+'">'+escapeHtml(row.status.label)+'</span></td><td>'+p.lots+' lot</td><td>'+money(p.entryPriceIdr)+'</td><td>'+money(row.current)+'</td><td>'+money(row.pnl)+'</td><td>'+money(p.stopLossIdr)+'</td><td>'+money(p.tp1Idr)+' / '+money(p.tp2Idr)+'</td><td><div class="row-actions"><button class="btn small" data-journal-ticker="'+p.ticker+'">Jurnal</button><button class="btn small danger" data-delete-plan="'+escapeHtml(p.id)+'">Hapus</button></div></td></tr>'; }).join('');
    $('watchCards').innerHTML = rows.map(function (row) { var p=row.plan; return '<div class="position-card"><div class="position-card-head"><button class="ticker-link" data-open-ticker="'+p.ticker+'">'+p.ticker+'</button><span class="pill '+row.status.tone+'">'+escapeHtml(row.status.label)+'</span></div><div class="position-card-grid"><div><span>Harga</span><b>'+money(row.current)+'</b></div><div><span>P/L</span><b class="'+pnlClass(row.pnl)+'">'+money(row.pnl)+'</b></div><div><span>Entry</span><b>'+money(p.entryPriceIdr)+'</b></div><div><span>Stop</span><b>'+money(p.stopLossIdr)+'</b></div></div><div class="actions"><button class="btn small" data-journal-ticker="'+p.ticker+'">Jurnal</button><button class="btn small danger" data-delete-plan="'+escapeHtml(p.id)+'">Hapus</button></div></div>'; }).join('');
  }

  function deletePlan(id) { state.plans = state.plans.filter(function (plan) { return String(plan.id) !== String(id); }); persistPlans(); captureSnapshot(); }

  function renderRiskOptions() {
    var currentId = $('riskPlan').value;
    $('riskPlan').innerHTML = state.plans.length ? state.plans.map(function (plan) { return '<option value="'+escapeHtml(plan.id)+'">'+escapeHtml(plan.ticker)+' · '+Number(plan.lots || 0)+' lot</option>'; }).join('') : '<option value="">Belum ada posisi</option>';
    if (currentId && state.plans.some(function (plan) { return String(plan.id) === currentId; })) $('riskPlan').value = currentId;
    fillRiskDefaults();
  }

  function fillRiskDefaults() {
    var plan = state.plans.find(function (row) { return String(row.id) === $('riskPlan').value; }); if (!plan) return;
    $('riskCurrent').value = state.prices[plan.ticker] || ''; $('riskLimit').value = plan.estimatedMaxLossIdr || plan.riskBudgetIdr || '';
  }

  function evaluateRisk() {
    var plan = state.plans.find(function (row) { return String(row.id) === $('riskPlan').value; });
    var current=num($('riskCurrent').value), addLots=Math.max(0,num($('riskAddLots').value)||0), funds=Math.max(0,num($('riskFunds').value)||0), limit=Math.max(0,num($('riskLimit').value)||0), valid=$('riskValid').checked;
    if (!plan || !current) { $('riskResult').className='error'; $('riskResult').textContent='Pilih posisi dan isi harga saat ini.'; return; }
    var existing=Math.max(0,(Number(plan.entryPriceIdr)-Number(plan.stopLossIdr))*Number(plan.lots)*100), cost=current*addLots*100, added=Math.max(0,(current-Number(plan.stopLossIdr))*addLots*100), combined=existing+added;
    var allowed=valid && current>Number(plan.stopLossIdr) && cost<=funds && combined<=limit;
    $('riskResult').className=allowed?'success':'note'; $('riskResult').innerHTML='<b>'+escapeHtml(plan.ticker)+'</b><br>Risiko sekarang: '+money(existing)+'<br>Biaya tambahan: '+money(cost)+'<br>Risiko gabungan: '+money(combined)+'<br><br><b>'+(allowed?'Masih di dalam guard matematis; review setup tetap wajib.':'Belum memenuhi seluruh guard yang diisi.')+'</b>';
  }

  function renderAlerts() {
    if (!state.plans.length) { $('alertPrices').innerHTML='<div class="empty">Belum ada ticker.</div>'; $('alertList').className='empty'; $('alertList').textContent='Belum ada level karena belum ada posisi.'; return; }
    $('alertPrices').innerHTML=state.plans.map(function (plan) { return '<div class="field" style="margin-bottom:10px"><label>'+escapeHtml(plan.ticker)+'</label><input class="alert-price" data-price-ticker="'+escapeHtml(plan.ticker)+'" value="'+escapeHtml(state.prices[plan.ticker]||'')+'" placeholder="Harga saat ini"></div>'; }).join('');
    $('alertList').className='action-list'; $('alertList').innerHTML=state.plans.map(function (plan) { return '<div class="action-item"><span class="action-rank">•</span><div class="action-copy"><strong><button class="ticker-link" data-open-ticker="'+escapeHtml(plan.ticker)+'">'+escapeHtml(plan.ticker)+'</button></strong><span>Entry '+money(plan.entryPriceIdr)+' · Stop '+money(plan.stopLossIdr)+' · TP1 '+money(plan.tp1Idr)+' · TP2 '+money(plan.tp2Idr)+'</span></div></div>'; }).join('');
  }

  function saveManualPrice(event) {
    var input=event.target.closest('[data-price-ticker]'); if (!input) return; var value=num(input.value);
    if (value && value>0) state.prices[input.dataset.priceTicker]=Math.round(value); else delete state.prices[input.dataset.priceTicker];
    saveJson(pricesKey(),state.prices); localStorage.setItem(priceTimeKey(),String(Date.now())); renderAll();
  }
  function checkAlertLevels() { renderAll(); captureSnapshot(); }

  function openTickerDrawer(symbol) {
    var t=ticker(symbol); if (!t) return; state.activeTicker=t;
    var plan=Model.summarize(state.plans,state.prices).plans.find(function (row) { return row.ticker===t; });
    var current=num(state.prices[t]); var status=plan?Model.planStatus(plan,current):{label:'Belum direncanakan',tone:'neutral'};
    $('drawerTicker').textContent=t; $('drawerSubtitle').textContent=(current?'Harga tersimpan '+money(current):'Harga belum tersedia')+' · '+status.label;
    var pnl=plan&&current&&plan.entryPriceIdr?(current-plan.entryPriceIdr)*plan.lots*100:null;
    $('drawerContent').innerHTML='<section class="drawer-section"><span class="pill '+status.tone+'">'+escapeHtml(status.label)+'</span><div class="drawer-metrics" style="margin-top:10px"><div class="drawer-metric"><span>Harga</span><b>'+money(current)+'</b></div><div class="drawer-metric"><span>P/L</span><b class="'+pnlClass(pnl)+'">'+money(pnl)+'</b></div><div class="drawer-metric"><span>Entry</span><b>'+money(plan&&plan.entryPriceIdr)+'</b></div><div class="drawer-metric"><span>Lot</span><b>'+(plan?plan.lots+' lot':'—')+'</b></div></div></section><section class="drawer-section"><h3>Level Rencana</h3><div class="data-rows"><div class="data-row"><span>Stop loss</span><strong>'+money(plan&&plan.stopLossIdr)+'</strong></div><div class="data-row"><span>TP1</span><strong>'+money(plan&&plan.tp1Idr)+'</strong></div><div class="data-row"><span>TP2</span><strong>'+money(plan&&plan.tp2Idr)+'</strong></div><div class="data-row"><span>Estimasi risiko</span><strong>'+money(plan&&plan.estimatedMaxLossIdr)+'</strong></div></div></section><section class="drawer-section"><div class="actions"><button class="btn primary" data-drawer-action="refresh">Refresh Harga</button><button class="btn" data-drawer-action="plan">Buat Rencana</button><button class="btn" data-drawer-action="journal">Catat Jurnal</button><button class="btn" data-drawer-action="ai">Tanya AI</button></div></section>';
    show('drawerBackdrop'); show('tickerDrawer'); $('closeDrawer').focus();
  }

  function closeDrawer() { hide('drawerBackdrop'); hide('tickerDrawer'); }
  async function handleDrawerAction(action) {
    var t=state.activeTicker; if (!t) return;
    if (action==='refresh') { var price=await quote(t); if (price) { state.prices[t]=Math.round(price); saveJson(pricesKey(),state.prices); localStorage.setItem(priceTimeKey(),String(Date.now())); openTickerDrawer(t); renderAll(); } return; }
    if (action==='plan') { closeDrawer(); openTab('planner'); $('ticker').value=t; $('entry').value=state.prices[t]||''; $('stop').focus(); return; }
    if (action==='journal') { closeDrawer(); openJournalModal(t); return; }
    if (action==='ai') { closeDrawer(); openTab('ai'); var input=$('aiInput'); if (input) { input.value='Tinjau risiko dan prioritas untuk '+t+' berdasarkan data yang tersimpan.'; input.focus(); } }
  }

  function openJournalModal(symbol) {
    var t=ticker(symbol); if (t) $('journalTicker').value=t;
    if (t && state.prices[t]) $('journalPrice').value=state.prices[t];
    hide('journalError'); show('journalBackdrop'); show('journalModal'); $('journalTicker').focus();
  }
  function closeJournalModal() { hide('journalBackdrop'); hide('journalModal'); }

  function saveJournal() {
    hide('journalError'); var t=ticker($('journalTicker').value);
    if (!t) { $('journalError').textContent='Ticker harus 3–5 huruf.'; show('journalError'); return; }
    state.journal.unshift({ id:'journal_'+Date.now(), ticker:t, action:$('journalAction').value, price:num($('journalPrice').value), lots:num($('journalLots').value), note:String($('journalNote').value||'').trim().slice(0,1000), followedPlan:$('journalFollowed').checked, createdAt:new Date().toISOString() });
    persistJournal(); closeJournalModal(); ['journalTicker','journalPrice','journalLots','journalNote'].forEach(function (id) { $(id).value=''; }); $('journalFollowed').checked=false; toast('Catatan jurnal disimpan.');
  }

  function deleteJournal(id) { state.journal=state.journal.filter(function (row) { return String(row.id)!==String(id); }); persistJournal(); }
  function renderJournal() {
    var summary=Model.journalSummary(state.journal); $('journalTotal').textContent=summary.total; $('journalEntries').textContent=summary.entries; $('journalPositive').textContent=summary.positive; $('journalStopped').textContent=summary.stopped; $('journalDiscipline').textContent=summary.disciplinePct==null?'—':Math.round(summary.disciplinePct)+'%';
    if (!state.journal.length) { $('journalList').className='empty'; $('journalList').textContent='Belum ada catatan jurnal.'; return; }
    $('journalList').className='journal-list'; $('journalList').innerHTML=state.journal.slice(0,50).map(function (row) { return '<div class="journal-item"><div><div class="journal-meta"><button class="ticker-link" data-open-ticker="'+escapeHtml(row.ticker)+'">'+escapeHtml(row.ticker)+'</button><span class="pill info">'+escapeHtml(row.action)+'</span><span class="pill '+(row.followedPlan?'good':'warn')+'">'+(row.followedPlan?'Sesuai rencana':'Perlu evaluasi')+'</span></div><p>Harga '+money(row.price)+(row.lots?' · '+row.lots+' lot':'')+(row.note?' · '+escapeHtml(row.note):'')+'</p></div><div><span class="journal-time">'+new Date(row.createdAt).toLocaleString('id-ID')+'</span><button class="btn small danger" data-delete-journal="'+escapeHtml(row.id)+'" style="display:block;margin-top:7px">Hapus</button></div></div>'; }).join('');
  }

  function exportJournal() {
    var blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),entries:state.journal},null,2)],{type:'application/json'}); var url=URL.createObjectURL(blob); var a=document.createElement('a'); a.href=url; a.download='auto-cuan-journal-'+new Date().toISOString().slice(0,10)+'.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){URL.revokeObjectURL(url);},500);
  }

  checkAccess();
})();