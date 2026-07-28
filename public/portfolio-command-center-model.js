(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanPortfolioCommandModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'portfolio-command-center-model-v2';
  var LOT_SIZE = 100;

  function finite(value, fallback) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : (fallback == null ? null : fallback);
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return fallback == null ? null : fallback;
    var direct = Number(raw);
    if (Number.isFinite(direct)) return direct;
    var sign = raw.charAt(0) === '-' ? -1 : 1;
    var digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return fallback == null ? null : fallback;
    var normalized = sign * Number(digits);
    return Number.isFinite(normalized) ? normalized : (fallback == null ? null : fallback);
  }

  function positive(value) {
    var n = finite(value);
    return n != null && n > 0 ? n : null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function tickerOf(value) {
    var ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
    return /^[A-Z]{3,5}$/.test(ticker) ? ticker : null;
  }

  function budgetCapacity(input) {
    input = input || {};
    var capital = positive(input.capitalIdr);
    var reservePct = clamp(finite(input.reservePct, 0), 0, 90);
    var maxPositions = Math.round(clamp(finite(input.maxPositions, 4), 1, 20));
    if (!capital) return { ok: false, error: 'Modal harus lebih dari 0.' };
    var usableCapital = Math.floor(capital * (100 - reservePct) / 100);
    var positionBudget = Math.floor(usableCapital / maxPositions);
    return {
      ok: true,
      capitalIdr: capital,
      reservePct: reservePct,
      maxPositions: maxPositions,
      usableCapitalIdr: usableCapital,
      positionBudgetIdr: positionBudget,
      maxPriceOneLotIdr: Math.floor(positionBudget / LOT_SIZE),
      maxPriceTwoLotsIdr: Math.floor(positionBudget / (LOT_SIZE * 2)),
      maxPriceFourLotsIdr: Math.floor(positionBudget / (LOT_SIZE * 4))
    };
  }

  function affordability(price, capacity) {
    var p = positive(price);
    if (!p || !capacity || !capacity.ok) return null;
    var lots = Math.floor(capacity.positionBudgetIdr / (p * LOT_SIZE));
    var value = lots * p * LOT_SIZE;
    var allocationPct = capacity.usableCapitalIdr > 0 ? value / capacity.usableCapitalIdr * 100 : 0;
    return {
      lots: lots,
      positionValueIdr: value,
      allocationPct: allocationPct,
      label: lots >= 4 ? 'Leluasa' : lots >= 2 ? 'Cukup' : lots === 1 ? 'Ketat' : 'Di luar batas',
      tone: lots >= 4 ? 'good' : lots >= 2 ? 'info' : lots === 1 ? 'warn' : 'danger'
    };
  }

  function planStatus(plan, currentPrice) {
    plan = plan || {};
    var current = positive(currentPrice);
    var entry = positive(plan.entryPriceIdr != null ? plan.entryPriceIdr : plan.entry);
    var stop = positive(plan.stopLossIdr != null ? plan.stopLossIdr : plan.stop);
    var tp1 = positive(plan.tp1Idr != null ? plan.tp1Idr : plan.tp1);
    var tp2 = positive(plan.tp2Idr != null ? plan.tp2Idr : plan.tp2);
    if (!current) return { code: 'NO_PRICE', label: 'Harga belum tersedia', tone: 'warn', priority: 30, attention: true };
    if (stop && current <= stop) return { code: 'STOP_TOUCHED', label: 'Stop tersentuh', tone: 'danger', priority: 100, attention: true };
    if (tp2 && current >= tp2) return { code: 'TP2_TOUCHED', label: 'TP2 tercapai', tone: 'good', priority: 92, attention: true };
    if (tp1 && current >= tp1) return { code: 'TP1_TOUCHED', label: 'TP1 tercapai', tone: 'good', priority: 82, attention: true };
    if (stop && current <= stop * 1.03) return { code: 'NEAR_STOP', label: 'Dekat stop', tone: 'danger', priority: 88, attention: true };
    if (entry && current < entry) return { code: 'BELOW_ENTRY', label: 'Di bawah entry', tone: 'warn', priority: 65, attention: true };
    if (tp1 && current >= tp1 * 0.97) return { code: 'NEAR_TP1', label: 'Dekat TP1', tone: 'info', priority: 58, attention: true };
    return { code: 'ACTIVE', label: 'Aktif', tone: 'good', priority: 10, attention: false };
  }

  function normalizePlan(plan) {
    var ticker = tickerOf(plan && plan.ticker);
    if (!ticker) return null;
    return {
      id: String(plan.id || ticker),
      ticker: ticker,
      entryPriceIdr: positive(plan.entryPriceIdr != null ? plan.entryPriceIdr : plan.entry),
      stopLossIdr: positive(plan.stopLossIdr != null ? plan.stopLossIdr : plan.stop),
      tp1Idr: positive(plan.tp1Idr != null ? plan.tp1Idr : plan.tp1),
      tp2Idr: positive(plan.tp2Idr != null ? plan.tp2Idr : plan.tp2),
      lots: Math.max(0, Math.floor(positive(plan.lots) || 0)),
      estimatedMaxLossIdr: positive(plan.estimatedMaxLossIdr != null ? plan.estimatedMaxLossIdr : plan.riskBudgetIdr) || 0,
      capitalIdr: positive(plan.capitalIdr) || 0,
      source: String(plan.source || ''),
      positionStatus: String(plan.positionStatus || ''),
      createdAt: String(plan.createdAt || '')
    };
  }

  function averageDownDecision(input) {
    input = input || {};
    var plan = normalizePlan(input.plan || {});
    var current = positive(input.currentPriceIdr);
    var addLots = Math.max(0, Math.floor(positive(input.addLots) || 0));
    var availableFunds = Math.max(0, finite(input.availableFundsIdr, 0));
    var riskLimit = Math.max(0, finite(input.riskLimitIdr, 0));
    var setupValid = input.setupValid === true;
    if (!plan || !plan.entryPriceIdr || !plan.stopLossIdr || !plan.lots || !current) {
      return { allowed: false, code: 'INVALID_INPUT', action: 'HOLD', tone: 'warn', message: 'Data posisi, harga, atau level stop belum lengkap.' };
    }
    var existingRisk = Math.max(0, (plan.entryPriceIdr - plan.stopLossIdr) * plan.lots * LOT_SIZE);
    var cost = current * addLots * LOT_SIZE;
    var addedRisk = Math.max(0, (current - plan.stopLossIdr) * addLots * LOT_SIZE);
    var combinedRisk = existingRisk + addedRisk;
    var newAverage = addLots > 0 ? ((plan.entryPriceIdr * plan.lots) + (current * addLots)) / (plan.lots + addLots) : plan.entryPriceIdr;
    var base = {
      allowed: false,
      existingRiskIdr: existingRisk,
      addedCostIdr: cost,
      addedRiskIdr: addedRisk,
      combinedRiskIdr: combinedRisk,
      newAveragePriceIdr: newAverage,
      totalLots: plan.lots + addLots
    };
    if (current <= plan.stopLossIdr) return Object.assign(base, { code: 'CUT_LOSS', action: 'CUT LOSS / JANGAN AVG DOWN', tone: 'danger', message: 'Harga sudah menyentuh atau melewati stop loss.' });
    if (current >= plan.entryPriceIdr) return Object.assign(base, { code: 'NOT_BELOW_ENTRY', action: 'HOLD', tone: 'info', message: 'Harga belum berada di bawah rata-rata entry; average down tidak relevan.' });
    if (!setupValid) return Object.assign(base, { code: 'SETUP_INVALID', action: 'HOLD', tone: 'warn', message: 'Setup terbaru belum dikonfirmasi masih valid.' });
    if (addLots < 1) return Object.assign(base, { code: 'NO_ADD_LOTS', action: 'HOLD', tone: 'warn', message: 'Masukkan minimal 1 lot tambahan untuk simulasi.' });
    if (cost > availableFunds) return Object.assign(base, { code: 'INSUFFICIENT_FUNDS', action: 'HOLD', tone: 'warn', message: 'Dana tersedia tidak cukup untuk lot tambahan.' });
    if (riskLimit <= 0 || combinedRisk > riskLimit) return Object.assign(base, { code: 'RISK_LIMIT', action: 'HOLD', tone: 'danger', message: 'Risiko gabungan melewati batas risiko total.' });
    return Object.assign(base, { allowed: true, code: 'AVG_DOWN_REVIEW', action: 'AVG DOWN BOLEH DIREVIEW', tone: 'good', message: 'Seluruh guard matematis terpenuhi. Validasi analisis tetap wajib sebelum tindakan manual.' });
  }

  function summarize(plans, prices) {
    plans = Array.isArray(plans) ? plans : [];
    prices = prices && typeof prices === 'object' && !Array.isArray(prices) ? prices : {};
    var normalized = plans.map(normalizePlan).filter(Boolean);
    var totalRisk = 0, totalExposure = 0, totalPnl = 0, priced = 0, actions = [];
    normalized.forEach(function (plan) {
      var current = positive(prices[plan.ticker]);
      var status = planStatus(plan, current);
      var exposure = plan.capitalIdr || (plan.entryPriceIdr && plan.lots ? plan.entryPriceIdr * plan.lots * LOT_SIZE : 0);
      totalExposure += exposure || 0;
      totalRisk += plan.estimatedMaxLossIdr || 0;
      if (current && plan.entryPriceIdr && plan.lots) {
        totalPnl += (current - plan.entryPriceIdr) * plan.lots * LOT_SIZE;
        priced += 1;
      }
      if (status.attention) actions.push({ ticker: plan.ticker, planId: plan.id, status: status, currentPriceIdr: current, entryPriceIdr: plan.entryPriceIdr, stopLossIdr: plan.stopLossIdr, tp1Idr: plan.tp1Idr, tp2Idr: plan.tp2Idr });
    });
    actions.sort(function (a, b) { return b.status.priority - a.status.priority || a.ticker.localeCompare(b.ticker); });
    var posture = !normalized.length
      ? { label: 'Belum ada rencana', tone: 'neutral', note: 'Tambahkan rencana atau posisi untuk membangun pusat keputusan.' }
      : actions.some(function (row) { return row.status.tone === 'danger'; })
        ? { label: 'Fokus risiko', tone: 'danger', note: 'Ada posisi yang perlu diperiksa sebelum menambah eksposur.' }
        : actions.length
          ? { label: 'Perlu perhatian', tone: 'warn', note: 'Beberapa posisi mendekati level penting atau belum memiliki harga.' }
          : { label: 'Terukur', tone: 'good', note: 'Tidak ada level penting yang terdeteksi dari data tersimpan.' };
    return { plans: normalized, planCount: normalized.length, pricedCount: priced, missingPriceCount: Math.max(0, normalized.length - priced), totalRiskIdr: totalRisk, totalExposureIdr: totalExposure, totalPnlIdr: priced ? totalPnl : null, attentionCount: actions.length, actions: actions, posture: posture };
  }

  function buildSnapshot(plans, prices) {
    var summary = summarize(plans, prices);
    var rows = {};
    summary.plans.forEach(function (plan) {
      var price = positive(prices && prices[plan.ticker]);
      var status = planStatus(plan, price);
      rows[plan.ticker] = { planId: plan.id, price: price, status: status.code, lots: plan.lots, entry: plan.entryPriceIdr, stop: plan.stopLossIdr, tp1: plan.tp1Idr, tp2: plan.tp2Idr, risk: plan.estimatedMaxLossIdr };
    });
    return { version: 1, capturedAt: new Date().toISOString(), rows: rows };
  }

  function compareSnapshots(previous, current) {
    var events = [], before = previous && previous.rows ? previous.rows : {}, after = current && current.rows ? current.rows : {};
    Object.keys(after).forEach(function (ticker) {
      var now = after[ticker], old = before[ticker];
      if (!old) return events.push({ type: 'PLAN_ADDED', ticker: ticker, tone: 'info', text: ticker + ' ditambahkan ke rencana atau pantauan.' });
      if (old.status !== now.status) events.push({ type: 'STATUS_CHANGED', ticker: ticker, tone: now.status === 'STOP_TOUCHED' || now.status === 'NEAR_STOP' ? 'danger' : 'info', text: ticker + ' berubah dari ' + old.status + ' menjadi ' + now.status + '.' });
      if (old.price && now.price && old.price !== now.price) {
        var pct = (now.price - old.price) / old.price * 100;
        if (Math.abs(pct) >= 0.5) events.push({ type: 'PRICE_CHANGED', ticker: ticker, tone: pct >= 0 ? 'good' : 'warn', text: ticker + ' bergerak ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '% sejak pembaruan sebelumnya.' });
      }
      if (old.risk !== now.risk) events.push({ type: 'RISK_CHANGED', ticker: ticker, tone: 'warn', text: 'Estimasi risiko ' + ticker + ' berubah.' });
    });
    Object.keys(before).forEach(function (ticker) { if (!after[ticker]) events.push({ type: 'PLAN_REMOVED', ticker: ticker, tone: 'neutral', text: ticker + ' tidak lagi ada di pantauan.' }); });
    return events;
  }

  function journalSummary(entries) {
    entries = Array.isArray(entries) ? entries : [];
    var summary = { total: entries.length, entries: 0, positive: 0, stopped: 0, followed: 0, assessed: 0 };
    entries.forEach(function (row) {
      var action = String(row && row.action || '').toUpperCase();
      if (action === 'ENTRY') summary.entries += 1;
      if (action === 'TP1' || action === 'TP2' || action === 'EXIT_POSITIVE') summary.positive += 1;
      if (action === 'STOP') summary.stopped += 1;
      if (typeof row.followedPlan === 'boolean') { summary.assessed += 1; if (row.followedPlan) summary.followed += 1; }
    });
    summary.disciplinePct = summary.assessed ? summary.followed / summary.assessed * 100 : null;
    return summary;
  }

  return {
    VERSION: VERSION,
    LOT_SIZE: LOT_SIZE,
    finite: finite,
    positive: positive,
    tickerOf: tickerOf,
    budgetCapacity: budgetCapacity,
    affordability: affordability,
    planStatus: planStatus,
    normalizePlan: normalizePlan,
    averageDownDecision: averageDownDecision,
    summarize: summarize,
    buildSnapshot: buildSnapshot,
    compareSnapshots: compareSnapshots,
    journalSummary: journalSummary
  };
});
