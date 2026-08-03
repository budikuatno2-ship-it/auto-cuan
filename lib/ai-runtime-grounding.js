'use strict';

const { planFacts } = require('./ai-eval-derived-facts');

const SHARES_PER_LOT = 100;
const SCALE = Object.freeze({
  ribu: 1000,
  juta: 1000000,
  miliar: 1000000000,
  triliun: 1000000000000
});

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number != null && number > 0 ? number : null;
}

function round(value, digits) {
  const number = finite(value);
  if (number == null) return null;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function compact(value) {
  if (Array.isArray(value)) {
    return value.map(compact).filter((item) => item !== null && item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = compact(item);
    if (normalized === null || normalized === undefined) continue;
    if (Array.isArray(normalized) && normalized.length === 0) continue;
    if (normalized && typeof normalized === 'object' && !Array.isArray(normalized) && Object.keys(normalized).length === 0) continue;
    output[key] = normalized;
  }
  return output;
}

function uniqueNumbers(values) {
  const output = [];
  for (const value of values) {
    const number = positive(value);
    if (number == null) continue;
    if (!output.some((item) => Math.abs(item - number) <= Math.max(0.01, Math.abs(number) * 0.0001))) output.push(number);
  }
  return output;
}

function parseIndonesianNumber(raw, scaleName) {
  let text = String(raw || '').trim().toLowerCase();
  if (!text) return null;
  if (text.includes('.') && text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  else if (text.includes(',')) text = text.replace(',', '.');
  const base = Number(text);
  if (!Number.isFinite(base)) return null;
  const multiplier = SCALE[String(scaleName || '').toLowerCase()] || 1;
  return base * multiplier;
}

function moneyFromMessage(message) {
  const text = String(message || '').toLowerCase();
  const values = [];
  const explicitCurrency = /(?:rp|idr)\s*(\d(?:[\d.,]*\d)?)(?:\s*(ribu|juta|miliar|triliun))?/gi;
  const contextualMoney = /(?:budget|modal|dana|uang|saldo|kapital|simulasi)\s*(?:saya|aku|ku|sebesar|sekitar|senilai|=|:)?\s*(\d(?:[\d.,]*\d)?)(?:\s*(ribu|juta|miliar|triliun))/gi;

  for (const regex of [explicitCurrency, contextualMoney]) {
    for (const match of text.matchAll(regex)) {
      const number = parseIndonesianNumber(match[1], match[2]);
      if (number != null && number > 0) values.push(number);
    }
  }

  if (!values.length) return [];
  return [Math.max(...values)];
}

function lotsFromMessage(message) {
  const output = [];
  const text = String(message || '').toLowerCase();
  for (const match of text.matchAll(/(\d(?:[\d.,]*\d)?)\s*lot\b/gi)) {
    const number = parseIndonesianNumber(match[1]);
    if (number != null && Number.isInteger(number) && number > 0 && number <= 1000000) output.push(number);
  }
  return uniqueNumbers(output);
}

function fundsFromContext(context) {
  const source = context && typeof context === 'object' ? context : {};
  const budget = source.budget && typeof source.budget === 'object' ? source.budget : {};
  const simulation = source.simulation && typeof source.simulation === 'object' ? source.simulation : {};
  return uniqueNumbers([
    simulation.available_funds_idr,
    simulation.availableFundsIdr,
    budget.capitalIdr,
    budget.capital_idr,
    budget.available_funds_idr
  ]);
}

function requestedLots(context, message) {
  const source = context && typeof context === 'object' ? context : {};
  const simulation = source.simulation && typeof source.simulation === 'object' ? source.simulation : {};
  return uniqueNumbers([
    ...lotsFromMessage(message),
    simulation.add_lots,
    simulation.addLots,
    1
  ]).filter(Number.isInteger);
}

function priceForPlan(plan, prices) {
  const source = plan && typeof plan === 'object' ? plan : {};
  const ticker = String(source.ticker || '').toUpperCase().replace(/\.JK$/i, '');
  const mapped = prices && typeof prices === 'object' ? positive(prices[ticker]) : null;
  return mapped || positive(source.currentPriceIdr ?? source.current_price ?? source.last) || positive(source.entryPriceIdr ?? source.entry_price ?? source.entry ?? source.avgPriceIdr);
}

function affordabilityFacts(context, message) {
  const source = context && typeof context === 'object' ? context : {};
  const plans = Array.isArray(source.plans) ? source.plans : [];
  const funds = uniqueNumbers([...moneyFromMessage(message), ...fundsFromContext(source)]);
  const lotOptions = requestedLots(source, message);
  const prices = source.prices && typeof source.prices === 'object' ? source.prices : {};

  const scenarios = funds.map((availableFunds) => {
    const requestedLotScenarios = lotOptions.map((lots) => {
      const shares = lots * SHARES_PER_LOT;
      const exact = availableFunds / shares;
      return {
        lots,
        shares,
        max_price_per_share_exact_idr: round(exact, 2),
        max_price_per_share_floor_idr: Math.floor(exact),
        formula: 'available_funds_idr / (lots × 100)'
      };
    });

    const planScenarios = plans.map((plan) => {
      const price = priceForPlan(plan, prices);
      if (price == null) return null;
      const maxLots = Math.floor(availableFunds / (price * SHARES_PER_LOT));
      const maxShares = maxLots * SHARES_PER_LOT;
      const maxCost = maxShares * price;
      return compact({
        ticker: plan.ticker || null,
        assumed_price_idr: price,
        one_lot_cost_idr: price * SHARES_PER_LOT,
        remaining_after_one_lot_idr: availableFunds - (price * SHARES_PER_LOT),
        max_affordable_lots: maxLots,
        max_affordable_shares: maxShares,
        max_affordable_cost_idr: maxCost,
        remaining_after_max_lots_idr: availableFunds - maxCost,
        maximum_price_at_max_lots_exact_idr: maxLots > 0 ? round(availableFunds / maxShares, 2) : null
      });
    }).filter(Boolean);

    return {
      available_funds_idr: availableFunds,
      shares_per_lot: SHARES_PER_LOT,
      max_price_for_one_lot_idr: Math.floor(availableFunds / SHARES_PER_LOT),
      requested_lot_scenarios: requestedLotScenarios,
      plan_scenarios: planScenarios
    };
  });

  return compact({
    policy: 'Batas daya beli bukan valuasi. Gunakan available_funds_idr / (lots × 100), sebutkan asumsi jumlah lot, dan labeli hasil sebagai SIMULASI.',
    scenarios
  });
}

function portfolioCalculationFacts(context) {
  const source = context && typeof context === 'object' ? context : {};
  const plans = Array.isArray(source.plans) ? source.plans : [];
  const simulation = source.simulation && typeof source.simulation === 'object' ? source.simulation : null;
  return compact({
    policy: 'Semua angka turunan dihitung deterministik dari snapshot. Jangan pakai bila basis datanya tidak tersedia.',
    market_rules: { shares_per_lot: SHARES_PER_LOT },
    plans: plans.map((plan) => planFacts(plan, simulation))
  });
}

function answerPolicy(source) {
  const common = [
    'Jawab inti pertanyaan pada bagian awal.',
    'Pisahkan fakta snapshot, analisis atau opini, tindakan, invalidasi atau risiko, dan data yang masih kurang.',
    'Angka hanya boleh berasal dari snapshot atau calculation_facts.',
    'Simulasi wajib diberi label SIMULASI dan tidak boleh disebut transaksi nyata.',
    'Jangan membuat klaim harga real-time, berita terbaru, probabilitas, atau kepastian keuntungan.',
    'Pastikan seluruh kalimat dan field selesai, tidak terpotong.'
  ];
  return {
    version: 'AUTO_CUAN_AI_RUNTIME_GROUNDING_V1',
    source,
    rules: source === 'portfolio_chat'
      ? common.concat([
          'Untuk budget-to-stock, jelaskan asumsi jumlah lot dan rumus dana / (lot × 100).',
          'Bedakan kemampuan membeli, ukuran posisi, dan kelayakan harga secara analitis.'
        ])
      : common.concat([
          'Fokus hanya pada ticker dan snapshot Analisis Saham yang sedang terbuka.',
          'Jangan mengubah analisis saham menjadi penilaian seluruh portofolio.'
        ])
  };
}

function prepareRuntimeGrounding(source, message, context) {
  const input = context && typeof context === 'object' ? context : {};
  const output = JSON.parse(JSON.stringify(input));
  output.ai_answer_policy = answerPolicy(source);
  if (source === 'portfolio_chat') {
    output.calculation_facts = portfolioCalculationFacts(output);
    output.affordability_facts = affordabilityFacts(output, message);
  }
  return output;
}

module.exports = {
  SHARES_PER_LOT,
  finite,
  parseIndonesianNumber,
  moneyFromMessage,
  lotsFromMessage,
  affordabilityFacts,
  portfolioCalculationFacts,
  answerPolicy,
  prepareRuntimeGrounding
};
