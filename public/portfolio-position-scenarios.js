(function () {
  'use strict';

  if (window.__AUTOCUAN_POSITION_SCENARIOS_V2__) return;
  window.__AUTOCUAN_POSITION_SCENARIOS_V2__ = true;

  var Model = window.AutoCuanPortfolioCommandModel;
  if (!Model) return;

  var screenerQuotes = [];
  var screenerLoading = false;
  var MONEY_IDS = [
    'budgetCapital','capital','entry','stop','tp1','tp2','ownedEntry','ownedStop','ownedTp1','ownedTp2',
    'riskCurrent','riskFunds','riskLimit','journalPrice'
  ];

  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]; }); }
  function digits(value) { return String(value == null ? '' : value).replace(/[^0-9]/g, ''); }
  function positive(value) { var n = Model.finite(value); return Number.isFinite(n) && n > 0 ? n : null; }
  function money(value) { var n = Number(value); if (!Number.isFinite(n)) return '—'; return (n < 0 ? '−' : '') + 'Rp ' + Math.abs(Math.round(n)).toLocaleString('id-ID'); }
  function ratio(value) { return Number.isFinite(value) && value > 0 ? value.toFixed(2) + '×' : '—'; }
  function readJson(key, fallback) { try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } }

  function userId() {
    var access = window.__AUTOCUAN_PORTFOLIO_ACCESS__ || {};
    return String(access.userId || localStorage.getItem('autocuan_user_id') || '').trim();
  }

  function authHeaders() {
    return {
      'X-User-Id': userId(),
      'X-Username': String(localStorage.getItem('autocuan_user') || '').trim()
    };
  }

  function stateNow() {
    var uid = userId();
    if (!uid) return { uid:'', plans:[], prices:{} };
    var plans = readJson('autocuan_portfolio_plans_' + uid, []);
    var prices = readJson('autocuan_portfolio_prices_' + uid, {});
    return {
      uid: uid,
      plans: Array.isArray(plans) ? plans : [],
      prices: prices && typeof prices === 'object' && !Array.isArray(prices) ? prices : {}
    };
  }

  function formatMoneyInput(input) {
    if (!input) return;
    var raw = digits(input.value);
    input.value = raw ? 'Rp ' + Number(raw).toLocaleString('id-ID') : '';
  }

  function installMoneyInputs() {
    MONEY_IDS.forEach(function (id) {
      var input = byId(id);
      if (!input || input.dataset.rupiahBound === 'true') return;
      input.dataset.rupiahBound = 'true';
      formatMoneyInput(input);
      input.addEventListener('input', function () { formatMoneyInput(input); });
      input.addEventListener('blur', function () { formatMoneyInput(input); });
    });

    function rawBeforeClick(buttonId, ids) {
      var button = byId(buttonId);
      if (!button) return;
      button.addEventListener('click', function () {
        ids.forEach(function (id) { var input = byId(id); if (input) input.value = digits(input.value); });
        setTimeout(function () { ids.forEach(function (id) { formatMoneyInput(byId(id)); }); }, 0);
      }, true);
    }

    rawBeforeClick('calculateBudget', ['budgetCapital']);
    rawBeforeClick('checkBudgetTicker', ['budgetCapital']);
    rawBeforeClick('calculatePlan', ['capital','entry','stop','tp1','tp2']);
    rawBeforeClick('saveOwned', ['ownedEntry','ownedStop','ownedTp1','ownedTp2']);
  }

  function normalizedPlan(plan) {
    var ticker = Model.tickerOf(plan && plan.ticker);
    if (!ticker) return null;
    return {
      id: String(plan.id || ticker),
      ticker: ticker,
      entry: positive(plan.entryPriceIdr != null ? plan.entryPriceIdr : plan.entry),
      stop: positive(plan.stopLossIdr != null ? plan.stopLossIdr : plan.stop),
      tp1: positive(plan.tp1Idr != null ? plan.tp1Idr : plan.tp1),
      tp2: positive(plan.tp2Idr != null ? plan.tp2Idr : plan.tp2),
      lots: Math.max(0, Math.floor(positive(plan.lots) || 0)),
      risk: positive(plan.estimatedMaxLossIdr != null ? plan.estimatedMaxLossIdr : plan.riskBudgetIdr)
    };
  }

  function scenarioFor(plan, prices, tp1Pct) {
    var current = positive(prices[plan.ticker]);
    var shares = plan.lots * 100;
    var stopResult = plan.entry && plan.stop && shares ? (plan.stop - plan.entry) * shares : null;
    var tp1Result = plan.entry && plan.tp1 && shares ? (plan.tp1 - plan.entry) * shares : null;
    var tp2Result = plan.entry && plan.tp2 && shares ? (plan.tp2 - plan.entry) * shares : null;
    var riskAbs = stopResult != null ? Math.abs(stopResult) : null;
    var rr1 = riskAbs && tp1Result != null ? tp1Result / riskAbs : null;
    var rr2 = riskAbs && tp2Result != null ? tp2Result / riskAbs : null;
    var tp1Lots = Math.floor(plan.lots * tp1Pct / 100);
    var tp2Lots = Math.max(0, plan.lots - tp1Lots);
    var partialResult = plan.entry && plan.tp1 && plan.tp2
      ? ((plan.tp1 - plan.entry) * tp1Lots * 100) + ((plan.tp2 - plan.entry) * tp2Lots * 100)
      : null;
    var missing = [];
    if (!plan.entry) missing.push('entry');
    if (!plan.stop) missing.push('stop loss');
    if (!plan.tp1) missing.push('TP1');
    if (!plan.tp2) missing.push('TP2');
    if (!plan.lots) missing.push('jumlah lot');
    if (!current) missing.push('harga terbaru');
    return { current:current, stopResult:stopResult, tp1Result:tp1Result, tp2Result:tp2Result, rr1:rr1, rr2:rr2, tp1Lots:tp1Lots, tp2Lots:tp2Lots, partialResult:partialResult, missing:missing };
  }

  function renderScenarios() {
    var host = byId('scenarioList');
    if (!host) return;
    var data = stateNow();
    var tp1Pct = Number((byId('scenarioTp1Pct') || {}).value || 50);
    var rows = data.plans.map(normalizedPlan).filter(Boolean).map(function (plan) { return { plan:plan, scenario:scenarioFor(plan, data.prices, tp1Pct) }; });
    var complete = rows.filter(function (row) { return row.scenario.missing.length === 0; }).length;
    var totalStop = rows.reduce(function (sum, row) { return sum + (row.scenario.stopResult || 0); }, 0);
    var totalTp1 = rows.reduce(function (sum, row) { return sum + (row.scenario.tp1Result || 0); }, 0);
    var totalPartial = rows.reduce(function (sum, row) { return sum + (row.scenario.partialResult || 0); }, 0);
    if (byId('scenarioCount')) byId('scenarioCount').textContent = String(rows.length);
    if (byId('scenarioComplete')) byId('scenarioComplete').textContent = complete + ' lengkap';
    if (byId('scenarioStopTotal')) byId('scenarioStopTotal').textContent = money(totalStop);
    if (byId('scenarioTp1Total')) byId('scenarioTp1Total').textContent = money(totalTp1);
    if (byId('scenarioPartialTotal')) byId('scenarioPartialTotal').textContent = money(totalPartial);
    if (!rows.length) { host.className = 'empty'; host.textContent = 'Belum ada posisi atau rencana untuk disimulasikan.'; return; }
    host.className = 'candidate-list';
    host.innerHTML = rows.map(function (row) {
      var plan = row.plan, scenario = row.scenario;
      var completeness = scenario.missing.length
        ? '<span class="pill warn">Belum lengkap</span><span class="muted">Kurang: ' + escapeHtml(scenario.missing.join(', ')) + '</span>'
        : '<span class="pill good">Rencana lengkap</span><span class="muted">Semua level dan harga tersedia.</span>';
      return '<article class="candidate-item" style="display:block">' +
        '<div class="card-head"><div><h3><button class="ticker-link" data-open-ticker="' + escapeHtml(plan.ticker) + '">' + escapeHtml(plan.ticker) + '</button></h3><p>Entry ' + money(plan.entry) + ' · ' + plan.lots + ' lot · Harga ' + money(scenario.current) + '</p></div><button class="btn small" data-journal-ticker="' + escapeHtml(plan.ticker) + '">Catat ke Jurnal</button></div>' +
        '<div class="metric-grid compact">' +
          '<div class="metric"><span>Jika stop tersentuh</span><b>' + money(scenario.stopResult) + '</b><small>Batas rugi sesuai level tersimpan</small></div>' +
          '<div class="metric"><span>Jika TP1 tercapai</span><b>' + money(scenario.tp1Result) + '</b><small>Risk–reward ' + ratio(scenario.rr1) + '</small></div>' +
          '<div class="metric"><span>Jika TP2 tercapai</span><b>' + money(scenario.tp2Result) + '</b><small>Risk–reward ' + ratio(scenario.rr2) + '</small></div>' +
          '<div class="metric"><span>Simulasi bertahap</span><b>' + money(scenario.partialResult) + '</b><small>' + scenario.tp1Lots + ' lot di TP1 · ' + scenario.tp2Lots + ' lot di TP2</small></div>' +
        '</div><div class="data-row" style="margin-top:10px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' + completeness + '</div><strong>Simulasi, bukan order otomatis</strong></div></article>';
    }).join('');
  }

  function installRiskGuard() {
    var button = byId('evaluateRisk');
    if (!button || button.dataset.guardV2 === 'true') return;
    button.dataset.guardV2 = 'true';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      var data = stateNow();
      var planId = String((byId('riskPlan') || {}).value || '');
      var plan = data.plans.find(function (row) { return String(row.id) === planId; });
      var decision = Model.averageDownDecision({
        plan: plan,
        currentPriceIdr: (byId('riskCurrent') || {}).value,
        addLots: (byId('riskAddLots') || {}).value,
        availableFundsIdr: (byId('riskFunds') || {}).value,
        riskLimitIdr: (byId('riskLimit') || {}).value,
        setupValid: !!(byId('riskValid') || {}).checked
      });
      var result = byId('riskResult');
      if (!result) return;
      result.className = decision.tone === 'danger' ? 'error' : (decision.tone === 'good' ? 'success' : 'note');
      result.innerHTML = '<span class="pill ' + escapeHtml(decision.tone || 'warn') + '">' + escapeHtml(decision.action || 'HOLD') + '</span>' +
        '<h3 style="margin:10px 0 4px">' + escapeHtml(plan && plan.ticker || 'Posisi') + '</h3>' +
        '<p style="margin:0">' + escapeHtml(decision.message || '') + '</p>' +
        '<div class="data-rows" style="margin-top:10px">' +
          '<div class="data-row"><span>Risiko posisi sekarang</span><strong>' + money(decision.existingRiskIdr) + '</strong></div>' +
          '<div class="data-row"><span>Biaya lot tambahan</span><strong>' + money(decision.addedCostIdr) + '</strong></div>' +
          '<div class="data-row"><span>Risiko gabungan</span><strong>' + money(decision.combinedRiskIdr) + '</strong></div>' +
          '<div class="data-row"><span>Rata-rata baru</span><strong>' + money(decision.newAveragePriceIdr) + '</strong></div>' +
          '<div class="data-row"><span>Total lot setelah simulasi</span><strong>' + (Number.isFinite(decision.totalLots) ? decision.totalLots + ' lot' : '—') + '</strong></div>' +
        '</div><p class="fine-print">Hasil ini guard matematis, bukan order dan bukan pengganti analisis terbaru.</p>';
    }, true);
  }

  function rowsFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return [];
    var keys = ['results','rows','data','picks','top5'];
    for (var i = 0; i < keys.length; i += 1) if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
    return [];
  }

  async function fetchJson(url) {
    var response = await fetch(url, { credentials:'same-origin', cache:'no-store', headers:authHeaders() });
    var data = await response.json().catch(function () { return null; });
    return response.ok && data && data.success !== false ? data : null;
  }

  async function mapBounded(items, concurrency, worker) {
    var next = 0, output = new Array(items.length);
    async function run() {
      while (next < items.length) {
        var index = next++;
        try { output[index] = await worker(items[index], index); } catch (_) { output[index] = null; }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, run));
    return output;
  }

  async function loadScreenerQuotes() {
    if (screenerLoading || screenerQuotes.length || !userId()) return;
    screenerLoading = true;
    try {
      var stamp = Date.now();
      var sources = [
        { label:'Konglo', url:'/api/sector-hot?action=screener&t=' + stamp },
        { label:'Non-Konglo', url:'/api/sector-hot?action=nk-screener-results&t=' + stamp },
        { label:'Day Trade', url:'/api/sector-hot?action=daytrade-screener&t=' + stamp }
      ];
      var payloads = await Promise.all(sources.map(function (source) { return fetchJson(source.url).catch(function () { return null; }); }));
      var seen = Object.create(null), candidates = [];
      payloads.forEach(function (payload, sourceIndex) {
        rowsFromPayload(payload).slice(0, 8).forEach(function (row) {
          var symbol = Model.tickerOf(row && (row.ticker || row.symbol || row.code));
          if (!symbol || seen[symbol]) return;
          seen[symbol] = true;
          candidates.push({ ticker:symbol, source:sources[sourceIndex].label });
        });
      });
      var quoted = await mapBounded(candidates, 4, async function (row) {
        var data = await fetchJson('/api/quote?ticker=' + encodeURIComponent(row.ticker) + '&portfolio=1');
        var price = positive(data && (data.last != null ? data.last : (data.price != null ? data.price : data.close)));
        return price ? { ticker:row.ticker, source:row.source, price:Math.round(price) } : null;
      });
      screenerQuotes = quoted.filter(Boolean);
      renderBudgetMatches();
    } finally { screenerLoading = false; }
  }

  function currentCapacity() {
    return Model.budgetCapacity({
      capitalIdr: (byId('budgetCapital') || {}).value,
      reservePct: (byId('budgetReserve') || {}).value,
      maxPositions: (byId('budgetPositions') || {}).value
    });
  }

  function renderBudgetMatches() {
    var host = byId('budgetCandidates');
    if (!host) return;
    var capacity = currentCapacity();
    if (!capacity.ok) return;
    if (!screenerQuotes.length) {
      host.className = 'empty';
      host.textContent = screenerLoading ? 'Memuat kandidat dari Screener terbaru…' : 'Kandidat Screener belum tersedia. Anda tetap dapat mengecek ticker tertentu secara manual.';
      return;
    }
    var rows = screenerQuotes.map(function (row) { return Object.assign({}, row, { fit:Model.affordability(row.price, capacity) }); })
      .filter(function (row) { return row.fit && row.fit.lots >= 1; })
      .sort(function (a, b) { return b.fit.lots - a.fit.lots || a.ticker.localeCompare(b.ticker); })
      .slice(0, 12);
    if (!rows.length) { host.className = 'empty'; host.textContent = 'Belum ada kandidat Screener yang muat dalam alokasi modal ini.'; return; }
    host.className = 'candidate-list';
    host.innerHTML = '<div class="note" style="margin:0 0 8px">Kandidat diambil dari ranking Screener terbaru. Daftar ini hanya mencocokkan harga dengan modal Anda, belum menilai kualitas setup.</div>' + rows.map(function (row) {
      return '<div class="candidate-item"><div class="candidate-main"><strong>' + escapeHtml(row.ticker) + '</strong>' +
        '<div class="candidate-stat"><span>Harga</span><b>' + money(row.price) + '</b></div>' +
        '<div class="candidate-stat"><span>Kapasitas</span><b>' + row.fit.lots + ' lot</b></div>' +
        '<div><span class="pill ' + escapeHtml(row.fit.tone) + '">' + escapeHtml(row.source + ' · ' + row.fit.label) + '</span></div></div>' +
        '<button class="btn small" data-budget-match="' + escapeHtml(row.ticker) + '" data-budget-price="' + row.price + '">Gunakan di Rencana</button></div>';
    }).join('');
  }

  function useBudgetMatch(button) {
    var symbol = Model.tickerOf(button.getAttribute('data-budget-match'));
    var price = positive(button.getAttribute('data-budget-price'));
    if (!symbol || !price) return;
    var plannerTab = document.querySelector('[data-tab="planner"]');
    if (plannerTab) plannerTab.click();
    if (byId('ticker')) byId('ticker').value = symbol;
    if (byId('entry')) { byId('entry').value = String(Math.round(price)); formatMoneyInput(byId('entry')); }
    if (byId('capital')) { byId('capital').value = digits((byId('budgetCapital') || {}).value); formatMoneyInput(byId('capital')); }
    if (byId('reservePct')) byId('reservePct').value = (byId('budgetReserve') || {}).value || 10;
    if (byId('maxPositions')) byId('maxPositions').value = (byId('budgetPositions') || {}).value || 4;
    if (byId('stop')) { byId('stop').value = ''; byId('stop').focus(); }
  }

  function bind() {
    installMoneyInputs();
    installRiskGuard();
    var selector = byId('scenarioTp1Pct');
    if (selector) selector.addEventListener('change', renderScenarios);
    var refresh = byId('refreshScenarios');
    if (refresh) refresh.addEventListener('click', renderScenarios);
    document.querySelectorAll('[data-tab="scenarios"]').forEach(function (button) { button.addEventListener('click', function () { setTimeout(renderScenarios, 0); }); });
    ['calculateBudget','checkBudgetTicker'].forEach(function (id) { var button = byId(id); if (button) button.addEventListener('click', function () { setTimeout(renderBudgetMatches, 0); }); });
    ['budgetCapital','budgetReserve','budgetPositions','budgetProfile'].forEach(function (id) { var input = byId(id); if (input) input.addEventListener('change', function () { setTimeout(renderBudgetMatches, 0); }); });
    document.addEventListener('click', function (event) { var button = event.target.closest('[data-budget-match]'); if (button) useBudgetMatch(button); });
    window.addEventListener('focus', function () { renderScenarios(); renderBudgetMatches(); });
    window.addEventListener('storage', function (event) { if (/autocuan_portfolio_(plans|prices)_/.test(String(event.key || ''))) { renderScenarios(); renderBudgetMatches(); } });
  }

  function waitForAccess(attempt) {
    if (userId()) { loadScreenerQuotes(); return; }
    if (attempt < 60) setTimeout(function () { waitForAccess(attempt + 1); }, 200);
  }

  function init() {
    bind();
    renderScenarios();
    setTimeout(function () { installMoneyInputs(); installRiskGuard(); renderScenarios(); }, 700);
    waitForAccess(0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
