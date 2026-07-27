(function () {
  'use strict';

  if (window.__AUTOCUAN_POSITION_SCENARIOS_V1__) return;
  window.__AUTOCUAN_POSITION_SCENARIOS_V1__ = true;

  var Model = window.AutoCuanPortfolioCommandModel;
  if (!Model) return;

  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function positive(value) { var n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }
  function money(value) { var n = Number(value); if (!Number.isFinite(n)) return '—'; return (n < 0 ? '−' : '') + 'Rp ' + Math.abs(Math.round(n)).toLocaleString('id-ID'); }
  function ratio(value) { return Number.isFinite(value) && value > 0 ? value.toFixed(2) + '×' : '—'; }
  function readJson(key, fallback) { try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } }

  function userId() {
    var access = window.__AUTOCUAN_PORTFOLIO_ACCESS__ || {};
    return String(access.userId || localStorage.getItem('autocuan_user_id') || '').trim();
  }

  function stateNow() {
    var uid = userId();
    if (!uid) return { uid: '', plans: [], prices: {} };
    var plans = readJson('autocuan_portfolio_plans_' + uid, []);
    var prices = readJson('autocuan_portfolio_prices_' + uid, {});
    return {
      uid: uid,
      plans: Array.isArray(plans) ? plans : [],
      prices: prices && typeof prices === 'object' && !Array.isArray(prices) ? prices : {}
    };
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
    return {
      current: current,
      stopResult: stopResult,
      tp1Result: tp1Result,
      tp2Result: tp2Result,
      rr1: rr1,
      rr2: rr2,
      tp1Lots: tp1Lots,
      tp2Lots: tp2Lots,
      partialResult: partialResult,
      missing: missing
    };
  }

  function render() {
    var host = byId('scenarioList');
    if (!host) return;
    var data = stateNow();
    var tp1Pct = Number((byId('scenarioTp1Pct') || {}).value || 50);
    var rows = data.plans.map(normalizedPlan).filter(Boolean).map(function (plan) {
      return { plan: plan, scenario: scenarioFor(plan, data.prices, tp1Pct) };
    });

    var complete = rows.filter(function (row) { return row.scenario.missing.length === 0; }).length;
    var totalStop = rows.reduce(function (sum, row) { return sum + (row.scenario.stopResult || 0); }, 0);
    var totalTp1 = rows.reduce(function (sum, row) { return sum + (row.scenario.tp1Result || 0); }, 0);
    var totalPartial = rows.reduce(function (sum, row) { return sum + (row.scenario.partialResult || 0); }, 0);

    if (byId('scenarioCount')) byId('scenarioCount').textContent = String(rows.length);
    if (byId('scenarioComplete')) byId('scenarioComplete').textContent = complete + ' lengkap';
    if (byId('scenarioStopTotal')) byId('scenarioStopTotal').textContent = money(totalStop);
    if (byId('scenarioTp1Total')) byId('scenarioTp1Total').textContent = money(totalTp1);
    if (byId('scenarioPartialTotal')) byId('scenarioPartialTotal').textContent = money(totalPartial);

    if (!rows.length) {
      host.className = 'empty';
      host.textContent = 'Belum ada posisi atau rencana untuk disimulasikan.';
      return;
    }

    host.className = 'candidate-list';
    host.innerHTML = rows.map(function (row) {
      var plan = row.plan;
      var scenario = row.scenario;
      var completeness = scenario.missing.length
        ? '<span class="pill warn">Belum lengkap</span><span class="muted">Kurang: ' + escapeHtml(scenario.missing.join(', ')) + '</span>'
        : '<span class="pill good">Rencana lengkap</span><span class="muted">Semua level dan harga tersedia.</span>';
      return '<article class="candidate-item" style="display:block">' +
        '<div class="card-head"><div><h3><button class="ticker-link" data-open-ticker="' + escapeHtml(plan.ticker) + '">' + escapeHtml(plan.ticker) + '</button></h3><p>Entry ' + money(plan.entry) + ' · ' + plan.lots + ' lot · Harga ' + money(scenario.current) + '</p></div>' +
        '<button class="btn small" data-journal-ticker="' + escapeHtml(plan.ticker) + '">Catat ke Jurnal</button></div>' +
        '<div class="metric-grid compact">' +
          '<div class="metric"><span>Jika stop tersentuh</span><b>' + money(scenario.stopResult) + '</b><small>Batas rugi sesuai level tersimpan</small></div>' +
          '<div class="metric"><span>Jika TP1 tercapai</span><b>' + money(scenario.tp1Result) + '</b><small>Risk–reward ' + ratio(scenario.rr1) + '</small></div>' +
          '<div class="metric"><span>Jika TP2 tercapai</span><b>' + money(scenario.tp2Result) + '</b><small>Risk–reward ' + ratio(scenario.rr2) + '</small></div>' +
          '<div class="metric"><span>Simulasi bertahap</span><b>' + money(scenario.partialResult) + '</b><small>' + scenario.tp1Lots + ' lot di TP1 · ' + scenario.tp2Lots + ' lot di TP2</small></div>' +
        '</div>' +
        '<div class="data-row" style="margin-top:10px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' + completeness + '</div><strong>Simulasi, bukan order otomatis</strong></div>' +
      '</article>';
    }).join('');
  }

  function bind() {
    var selector = byId('scenarioTp1Pct');
    if (selector) selector.addEventListener('change', render);
    var refresh = byId('refreshScenarios');
    if (refresh) refresh.addEventListener('click', render);
    document.querySelectorAll('[data-tab="scenarios"]').forEach(function (button) {
      button.addEventListener('click', function () { setTimeout(render, 0); });
    });
    window.addEventListener('focus', render);
    window.addEventListener('storage', function (event) {
      if (/autocuan_portfolio_(plans|prices)_/.test(String(event.key || ''))) render();
    });
  }

  function init() {
    bind();
    render();
    setTimeout(render, 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();