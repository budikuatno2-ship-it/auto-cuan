(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (root && root.__AUTOCUAN_POSITION_SCENARIOS_V2__) return;
  if (root) root.__AUTOCUAN_POSITION_SCENARIOS_V2__ = true;

  var Model = (root && root.AutoCuanPortfolioCommandModel) || null;

  var screenerQuotes = [];
  var screenerLoading = false;
  var MONEY_IDS = [
    'budgetCapital','capital','entry','stop','tp1','tp2','ownedEntry','ownedStop','ownedTp1','ownedTp2',
    'riskCurrent','riskFunds','riskLimit','journalPrice'
  ];

  function byId(id) { return document.getElementById(id); }
  // Elemen bisa saja tidak ada atau berupa stub tanpa addEventListener (mis. saat
  // sebagian markup gagal dimuat). Pengikatan event tidak boleh menjatuhkan runtime.
  function on(target, event, handler) {
    if (target && typeof target.addEventListener === 'function') target.addEventListener(event, handler);
  }
  // Bila tidak ada satu pun nilai yang bisa disimulasikan, tampilkan '—' alih-alih 0.
  function sumOrDash(values) {
    var present = values.filter(function (value) { return value != null && Number.isFinite(Number(value)); });
    if (!present.length) return '—';
    return money(present.reduce(function (total, value) { return total + Number(value); }, 0));
  }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]; }); }
  function digits(value) { return String(value == null ? '' : value).replace(/[^0-9]/g, ''); }
  function positive(value) { var n = Model.finite(value); return Number.isFinite(n) && n > 0 ? n : null; }
  function money(value) { var n = Number(value); if (!Number.isFinite(n)) return '—'; return (n < 0 ? '−' : '') + 'Rp ' + Math.abs(Math.round(n)).toLocaleString('id-ID'); }
  function ratio(value) { return Number.isFinite(value) && value > 0 ? value.toFixed(2) + 'x' : '—'; }
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
      on(input, 'input', function () { formatMoneyInput(input); });
      on(input, 'blur', function () { formatMoneyInput(input); });
    });

    function rawBeforeClick(buttonId, ids) {
      var button = byId(buttonId);
      if (!button) return;
      on(button, 'click', function () {
        ids.forEach(function (id) { var input = byId(id); if (input) input.value = digits(input.value); });
        setTimeout(function () { ids.forEach(function (id) { formatMoneyInput(byId(id)); }); }, 0);
      }, true);
    }

    rawBeforeClick('calculateBudget', ['budgetCapital']);
    rawBeforeClick('checkBudgetTicker', ['budgetCapital']);
    rawBeforeClick('calculatePlan', ['capital','entry','stop','tp1','tp2']);
    rawBeforeClick('saveOwned', ['ownedEntry','ownedStop','ownedTp1','ownedTp2']);
    rawBeforeClick('evaluateRisk', ['riskCurrent','riskFunds','riskLimit']);
    rawBeforeClick('saveJournal', ['journalPrice']);
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

  var Calculator = {
    calculateScaleOutWithFees: function (params) {
      params = params || {};
      var entry = Number(params.entry);
      var stop = Number(params.stop);
      var tp1 = Number(params.tp1);
      var tp2 = Number(params.tp2);
      var lots = Math.max(0, Math.floor(Number(params.lots) || 0));
      var tp1Pct = Number.isFinite(Number(params.tp1Pct)) ? Number(params.tp1Pct) : 50;
      var buyFeePct = Number.isFinite(Number(params.buyFeePct)) ? Number(params.buyFeePct) : 0.15;
      var sellFeePct = Number.isFinite(Number(params.sellFeePct)) ? Number(params.sellFeePct) : 0.25;

      var totalShares = lots * 100;
      var invertedStop = !!(entry && stop && stop > entry);

      if (!entry || !lots || totalShares <= 0) {
        return {
          valid: false,
          totalShares: totalShares,
          buyGross: 0,
          buyFee: 0,
          stopResultGross: null,
          stopResultNet: null,
          tp1ResultGross: null,
          tp1ResultNet: null,
          tp2ResultGross: null,
          tp2ResultNet: null,
          partialGross: null,
          partialNet: null,
          partialTotalFee: null,
          breakEvenGross: null,
          breakEvenNet: null,
          breakEvenTotalFee: null,
          tp1Lots: 0,
          tp2Lots: 0,
          tp1Shares: 0,
          tp2Shares: 0
        };
      }

      var buyGross = entry * totalShares;
      var buyFee = buyGross * (buyFeePct / 100);

      var stopResultGross = null;
      var stopResultNet = null;
      if (stop && !invertedStop) {
        stopResultGross = (stop - entry) * totalShares;
        var stopSellFee = (stop * totalShares) * (sellFeePct / 100);
        stopResultNet = stopResultGross - (buyFee + stopSellFee);
      }

      var tp1ResultGross = null;
      var tp1ResultNet = null;
      if (tp1) {
        tp1ResultGross = (tp1 - entry) * totalShares;
        var tp1SellFee = (tp1 * totalShares) * (sellFeePct / 100);
        tp1ResultNet = tp1ResultGross - (buyFee + tp1SellFee);
      }

      var tp2ResultGross = null;
      var tp2ResultNet = null;
      if (tp2) {
        tp2ResultGross = (tp2 - entry) * totalShares;
        var tp2SellFee = (tp2 * totalShares) * (sellFeePct / 100);
        tp2ResultNet = tp2ResultGross - (buyFee + tp2SellFee);
      }

      var tp1Lots = Math.floor(lots * tp1Pct / 100);
      var tp2Lots = Math.max(0, lots - tp1Lots);
      var tp1Shares = tp1Lots * 100;
      var tp2Shares = tp2Lots * 100;

      var partialGross = null;
      var partialNet = null;
      var partialTotalFee = null;
      var breakEvenGross = null;
      var breakEvenNet = null;
      var breakEvenTotalFee = null;

      if (tp1 && tp2) {
        var tp1Revenue = tp1 * tp1Shares;
        var tp1Fee = tp1Revenue * (sellFeePct / 100);
        var tp2Revenue = tp2 * tp2Shares;
        var tp2Fee = tp2Revenue * (sellFeePct / 100);

        partialGross = ((tp1 - entry) * tp1Shares) + ((tp2 - entry) * tp2Shares);
        partialTotalFee = buyFee + tp1Fee + tp2Fee;
        partialNet = partialGross - partialTotalFee;

        var beRevenue = entry * tp2Shares;
        var beSellFee = beRevenue * (sellFeePct / 100);
        breakEvenGross = (tp1 - entry) * tp1Shares;
        breakEvenTotalFee = buyFee + tp1Fee + beSellFee;
        breakEvenNet = breakEvenGross - breakEvenTotalFee;
      }

      return {
        valid: true,
        totalShares: totalShares,
        buyGross: buyGross,
        buyFee: buyFee,
        stopResultGross: stopResultGross,
        stopResultNet: stopResultNet,
        tp1ResultGross: tp1ResultGross,
        tp1ResultNet: tp1ResultNet,
        tp2ResultGross: tp2ResultGross,
        tp2ResultNet: tp2ResultNet,
        tp1Lots: tp1Lots,
        tp2Lots: tp2Lots,
        tp1Shares: tp1Shares,
        tp2Shares: tp2Shares,
        partialGross: partialGross,
        partialNet: partialNet,
        partialTotalFee: partialTotalFee,
        breakEvenGross: breakEvenGross,
        breakEvenNet: breakEvenNet,
        breakEvenTotalFee: breakEvenTotalFee
      };
    }
  };

  function scenarioFor(plan, prices, tp1Pct, buyFeePct, sellFeePct) {
    var current = positive(prices[plan.ticker]);
    var calc = Calculator.calculateScaleOutWithFees({
      entry: plan.entry,
      stop: plan.stop,
      tp1: plan.tp1,
      tp2: plan.tp2,
      lots: plan.lots,
      tp1Pct: tp1Pct,
      buyFeePct: buyFeePct,
      sellFeePct: sellFeePct
    });

    var shares = plan.lots * 100;
    var invertedStop = !!(plan.entry && plan.stop && plan.stop > plan.entry);
    var stopResult = plan.entry && plan.stop && shares && !invertedStop ? (plan.stop - plan.entry) * shares : null;
    var tp1Result = plan.entry && plan.tp1 && shares ? (plan.tp1 - plan.entry) * shares : null;
    var riskAbs = calc.stopResultGross != null ? Math.abs(calc.stopResultGross) : (stopResult != null ? Math.abs(stopResult) : null);
    var rr1 = riskAbs && tp1Result != null ? tp1Result / riskAbs : (riskAbs && calc.tp1ResultGross != null ? calc.tp1ResultGross / riskAbs : null);
    var rr2 = riskAbs && calc.tp2ResultGross != null ? calc.tp2ResultGross / riskAbs : null;

    var missing = [];
    if (!plan.entry) missing.push('entry');
    if (!plan.stop) missing.push('stop loss');
    if (invertedStop) missing.push('stop loss di atas entry');
    if (!plan.tp1) missing.push('TP1');
    if (!plan.tp2) missing.push('TP2');
    if (!plan.lots) missing.push('jumlah lot');
    if (!current) missing.push('harga terbaru');

    return {
      current: current,
      stopResult: calc.stopResultGross,
      stopResultNet: calc.stopResultNet,
      tp1Result: calc.tp1ResultGross,
      tp1ResultNet: calc.tp1ResultNet,
      tp2Result: calc.tp2ResultGross,
      tp2ResultNet: calc.tp2ResultNet,
      rr1: rr1,
      rr2: rr2,
      tp1Lots: calc.tp1Lots,
      tp2Lots: calc.tp2Lots,
      partialResult: calc.partialGross,
      partialResultNet: calc.partialNet,
      partialTotalFee: calc.partialTotalFee,
      breakEvenResult: calc.breakEvenGross,
      breakEvenResultNet: calc.breakEvenNet,
      breakEvenTotalFee: calc.breakEvenTotalFee,
      missing: missing
    };
  }

  function renderScenarios() {
    var host = byId('scenarioList');
    if (!host) return;
    var data = stateNow();
    var tp1Pct = Number((byId('scenarioTp1Pct') || {}).value || 50);
    var buyFeePct = Number((byId('scenarioBuyFeePct') || {}).value || 0.15);
    var sellFeePct = Number((byId('scenarioSellFeePct') || {}).value || 0.25);
    var rows = data.plans.map(normalizedPlan).filter(Boolean).map(function (plan) {
      return { plan: plan, scenario: scenarioFor(plan, data.prices, tp1Pct, buyFeePct, sellFeePct) };
    });
    var complete = rows.filter(function (row) { return row.scenario.missing.length === 0; }).length;
    var totalStop = sumOrDash(rows.map(function (row) { return row.scenario.stopResultNet != null ? row.scenario.stopResultNet : row.scenario.stopResult; }));
    var totalTp1 = sumOrDash(rows.map(function (row) { return row.scenario.tp1ResultNet != null ? row.scenario.tp1ResultNet : row.scenario.tp1Result; }));
    var totalPartial = sumOrDash(rows.map(function (row) { return row.scenario.partialResultNet != null ? row.scenario.partialResultNet : row.scenario.partialResult; }));
    if (byId('scenarioCount')) byId('scenarioCount').textContent = String(rows.length);
    if (byId('scenarioComplete')) byId('scenarioComplete').textContent = complete + ' lengkap';
    if (byId('scenarioStopTotal')) byId('scenarioStopTotal').textContent = totalStop;
    if (byId('scenarioTp1Total')) byId('scenarioTp1Total').textContent = totalTp1;
    if (byId('scenarioPartialTotal')) byId('scenarioPartialTotal').textContent = totalPartial;
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
          '<div class="metric"><span>Jika stop tersentuh</span><b>' + money(scenario.stopResultNet != null ? scenario.stopResultNet : scenario.stopResult) + '</b><small>Kotor: ' + money(scenario.stopResult) + '</small></div>' +
          '<div class="metric"><span>Jika TP1 tercapai</span><b>' + money(scenario.tp1ResultNet != null ? scenario.tp1ResultNet : scenario.tp1Result) + '</b><small>Net · R:R ' + ratio(scenario.rr1) + '</small></div>' +
          '<div class="metric"><span>Simulasi bertahap</span><b>' + money(scenario.partialResultNet != null ? scenario.partialResultNet : scenario.partialResult) + '</b><small>' + scenario.tp1Lots + ' lot TP1 · ' + scenario.tp2Lots + ' lot TP2 (Biaya ' + money(scenario.partialTotalFee) + ')</small></div>' +
          '<div class="metric"><span>Break-Even Stop</span><b>' + money(scenario.breakEvenResultNet) + '</b><small>TP1 tercapai + sisa di Entry</small></div>' +
        '</div><div class="data-row" style="margin-top:10px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' + completeness + '</div><strong>Simulasi berlabel, bukan order otomatis</strong></div></article>';
    }).join('');
  }

  function installRiskGuard() {
    var button = byId('evaluateRisk');
    if (!button || button.dataset.guardV2 === 'true') return;
    button.dataset.guardV2 = 'true';
    on(button, 'click', function (event) {
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
    ['scenarioTp1Pct', 'scenarioBuyFeePct', 'scenarioSellFeePct'].forEach(function (id) {
      on(byId(id), 'input', renderScenarios);
      on(byId(id), 'change', renderScenarios);
    });
    var refresh = byId('refreshScenarios');
    on(refresh, 'click', renderScenarios);
    var tabs = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('[data-tab="scenarios"]') : [];
    Array.prototype.forEach.call(tabs, function (button) { on(button, 'click', function () { setTimeout(renderScenarios, 0); }); });
    ['calculateBudget','checkBudgetTicker'].forEach(function (id) { on(byId(id), 'click', function () { setTimeout(renderBudgetMatches, 0); }); });
    ['budgetCapital','budgetReserve','budgetPositions','budgetProfile'].forEach(function (id) { on(byId(id), 'change', function () { setTimeout(renderBudgetMatches, 0); }); });
    on(document, 'click', function (event) { var button = event.target.closest('[data-budget-match]'); if (button) useBudgetMatch(button); });
    on(window, 'focus', function () { renderScenarios(); renderBudgetMatches(); });
    on(window, 'storage', function (event) { if (/autocuan_portfolio_(plans|prices)_/.test(String(event.key || ''))) { renderScenarios(); renderBudgetMatches(); } });
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

  if (typeof window !== 'undefined') {
    window.AutoCuanPortfolioScenarioCalculator = Calculator;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Calculator;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') on(document, 'DOMContentLoaded', init);
    else init();
  }
})();
