'use strict';

const SHARES_PER_LOT = 100;

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

function addRounded(set, value) {
  const number = finite(value);
  if (number == null) return;
  set.add(number);
  set.add(round(number, 2));
  set.add(round(number, 1));
  if (Math.abs(number) >= 100) set.add(round(number, 0));
}

function compactObject(value) {
  if (Array.isArray(value)) {
    return value
      .map(compactObject)
      .filter((item) => item !== null && item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const compacted = compactObject(item);
    if (compacted === null || compacted === undefined) continue;
    if (Array.isArray(compacted) && compacted.length === 0) continue;
    if (compacted && typeof compacted === 'object' && !Array.isArray(compacted) && Object.keys(compacted).length === 0) continue;
    output[key] = compacted;
  }
  return output;
}

function numbersFrom(value, set) {
  const output = set || new Set();
  if (typeof value === 'number' && Number.isFinite(value)) addRounded(output, value);
  else if (Array.isArray(value)) value.forEach((item) => numbersFrom(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => numbersFrom(item, output));
  return output;
}

function recursiveFind(value, keys, depth) {
  const maxDepth = depth == null ? 6 : depth;
  if (!value || typeof value !== 'object' || maxDepth < 0) return null;
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(String(key).toLowerCase())) {
      const number = positive(item);
      if (number != null) return number;
    }
  }
  for (const item of Object.values(value)) {
    if (!item || typeof item !== 'object') continue;
    const found = recursiveFind(item, keys, maxDepth - 1);
    if (found != null) return found;
  }
  return null;
}

function planFacts(plan, simulation) {
  const source = plan && typeof plan === 'object' ? plan : {};
  const lots = positive(source.lots ?? source.lot);
  const entry = positive(source.entryPriceIdr ?? source.entry_price ?? source.entry ?? source.avgPriceIdr);
  const current = positive(source.currentPriceIdr ?? source.current_price ?? source.last);
  const stop = positive(source.stopLossIdr ?? source.stop_loss ?? source.stop);
  const tp1 = positive(source.tp1Idr ?? source.tp1);
  const tp2 = positive(source.tp2Idr ?? source.tp2);
  const sourceCapital = positive(source.capitalIdr ?? source.capital ?? source.positionValueIdr);
  const sourceMaxLoss = positive(source.estimatedMaxLossIdr ?? source.estimated_max_loss ?? source.maxLossIdr);

  const shares = lots != null ? lots * SHARES_PER_LOT : null;
  const calculatedCapital = shares != null && entry != null ? shares * entry : null;
  const capital = sourceCapital ?? calculatedCapital;
  const riskPerShare = entry != null && stop != null && entry > stop ? entry - stop : null;
  const riskPerLot = riskPerShare != null ? riskPerShare * SHARES_PER_LOT : null;
  const calculatedMaxLoss = riskPerShare != null && shares != null ? riskPerShare * shares : null;
  const maxLoss = sourceMaxLoss ?? calculatedMaxLoss;
  const riskPct = maxLoss != null && capital != null && capital > 0 ? maxLoss / capital * 100 : null;
  const tp1Profit = tp1 != null && entry != null && shares != null && tp1 > entry ? (tp1 - entry) * shares : null;
  const tp2Profit = tp2 != null && entry != null && shares != null && tp2 > entry ? (tp2 - entry) * shares : null;

  const facts = {
    ticker: source.ticker || source.symbol || null,
    shares_per_lot: SHARES_PER_LOT,
    existing_lots: lots,
    existing_shares: shares,
    entry_price_idr: entry,
    current_price_idr: current,
    stop_loss_idr: stop,
    source_capital_idr: sourceCapital,
    calculated_capital_idr: calculatedCapital,
    risk_per_share_idr: riskPerShare,
    risk_per_lot_idr: riskPerLot,
    source_max_loss_idr: sourceMaxLoss,
    calculated_max_loss_idr: calculatedMaxLoss,
    risk_pct_of_position: round(riskPct, 2),
    tp1_gross_profit_idr: tp1Profit,
    tp2_gross_profit_idr: tp2Profit
  };

  const scenario = simulation && typeof simulation === 'object' ? simulation : null;
  if (scenario) {
    const addLots = positive(scenario.add_lots ?? scenario.addLots);
    const availableFunds = positive(scenario.available_funds_idr ?? scenario.availableFundsIdr);
    const assumedEntry = current ?? entry;
    const addShares = addLots != null ? addLots * SHARES_PER_LOT : null;
    const additionalCapital = addShares != null && assumedEntry != null ? addShares * assumedEntry : null;
    const totalLots = lots != null && addLots != null ? lots + addLots : null;
    const totalShares = shares != null && addShares != null ? shares + addShares : null;
    const totalCapital = capital != null && additionalCapital != null ? capital + additionalCapital : null;
    const remainingFunds = availableFunds != null && additionalCapital != null ? availableFunds - additionalCapital : null;
    const maxAffordableLots = availableFunds != null && assumedEntry != null
      ? Math.floor(availableFunds / (assumedEntry * SHARES_PER_LOT))
      : null;
    const additionalRisk = assumedEntry != null && stop != null && assumedEntry > stop && addShares != null
      ? (assumedEntry - stop) * addShares
      : null;
    const totalRisk = maxLoss != null && additionalRisk != null ? maxLoss + additionalRisk : null;
    const averageEntry = totalCapital != null && totalShares != null && totalShares > 0
      ? totalCapital / totalShares
      : null;
    const totalRiskPct = totalRisk != null && totalCapital != null && totalCapital > 0
      ? totalRisk / totalCapital * 100
      : null;

    facts.simulation = {
      calculation_basis: current != null ? 'current_price' : (entry != null ? 'existing_entry_price' : 'unavailable'),
      assumed_entry_price_idr: assumedEntry,
      available_funds_idr: availableFunds,
      add_lots: addLots,
      add_shares: addShares,
      additional_capital_idr: additionalCapital,
      remaining_funds_idr: remainingFunds,
      max_affordable_lots: maxAffordableLots,
      total_lots: totalLots,
      total_shares: totalShares,
      total_capital_idr: totalCapital,
      average_entry_idr: round(averageEntry, 2),
      additional_risk_idr: additionalRisk,
      total_risk_idr: totalRisk,
      total_risk_pct: round(totalRiskPct, 2)
    };
  }

  return compactObject(facts);
}

function budgetFacts(context) {
  const budget = context && context.budget && typeof context.budget === 'object' ? context.budget : null;
  if (!budget) return null;
  const capital = positive(budget.capitalIdr ?? budget.capital_idr);
  const reservePct = finite(budget.reservePct ?? budget.reserve_pct);
  const maxPositions = positive(budget.maxPositions ?? budget.max_positions);
  if (capital == null) return null;
  const boundedReserve = reservePct != null ? Math.max(0, Math.min(100, reservePct)) : null;
  const reserve = boundedReserve != null ? capital * boundedReserve / 100 : null;
  const investable = reserve != null ? capital - reserve : capital;
  const perPosition = maxPositions != null ? investable / maxPositions : null;
  return compactObject({
    capital_idr: capital,
    reserve_pct: boundedReserve,
    reserve_idr: reserve,
    investable_capital_idr: investable,
    max_positions: maxPositions,
    equal_allocation_per_position_idr: round(perPosition, 2)
  });
}

function stockFacts(context) {
  const source = context && typeof context === 'object' ? context : {};
  const entry = recursiveFind(source, new Set(['entry', 'entryprice', 'entry_price', 'entrylow', 'entry_low', 'entrypriceidr']));
  const entryHigh = recursiveFind(source, new Set(['entryhigh', 'entry_high']));
  const stop = recursiveFind(source, new Set(['stop', 'stoploss', 'stop_loss', 'stoplossidr']));
  const tp1 = recursiveFind(source, new Set(['tp1', 'tp1idr', 'target1', 'target_1']));
  const tp2 = recursiveFind(source, new Set(['tp2', 'tp2idr', 'target2', 'target_2']));
  const baseEntry = entry ?? entryHigh;
  const risk = baseEntry != null && stop != null && baseEntry > stop ? baseEntry - stop : null;
  const reward1 = tp1 != null && baseEntry != null && tp1 > baseEntry ? tp1 - baseEntry : null;
  const reward2 = tp2 != null && baseEntry != null && tp2 > baseEntry ? tp2 - baseEntry : null;
  const rr1 = risk != null && risk > 0 && reward1 != null ? reward1 / risk : null;
  const rr2 = risk != null && risk > 0 && reward2 != null ? reward2 / risk : null;
  const riskPct = baseEntry != null && risk != null ? risk / baseEntry * 100 : null;
  const tp1Pct = baseEntry != null && reward1 != null ? reward1 / baseEntry * 100 : null;
  const tp2Pct = baseEntry != null && reward2 != null ? reward2 / baseEntry * 100 : null;
  return compactObject({
    entry_price: baseEntry,
    stop_loss: stop,
    tp1,
    tp2,
    risk_per_share: risk,
    reward_to_tp1_per_share: reward1,
    reward_to_tp2_per_share: reward2,
    risk_reward_tp1: round(rr1, 2),
    risk_reward_tp2: round(rr2, 2),
    risk_pct: round(riskPct, 2),
    tp1_upside_pct: round(tp1Pct, 2),
    tp2_upside_pct: round(tp2Pct, 2)
  });
}

function enrichCase(testCase) {
  const row = testCase && typeof testCase === 'object' ? JSON.parse(JSON.stringify(testCase)) : {};
  row.context = row.context && typeof row.context === 'object' ? row.context : {};
  row.expected = row.expected && typeof row.expected === 'object' ? row.expected : {};

  let facts;
  if (row.task === 'portfolio_chat') {
    const plans = Array.isArray(row.context.plans) ? row.context.plans : [];
    facts = compactObject({
      policy: 'Angka turunan di bawah dihitung deterministik dari snapshot. Gunakan hanya bila basisnya sesuai dan tetap labeli simulasi.',
      market_rules: { shares_per_lot: SHARES_PER_LOT },
      plans: plans.map((plan) => planFacts(plan, row.context.simulation)),
      budget: budgetFacts(row.context)
    });
  } else {
    facts = compactObject({
      policy: 'Angka turunan di bawah dihitung deterministik dari level snapshot.',
      stock: stockFacts(row.context)
    });
  }

  row.context.calculation_facts = facts;
  const allowed = new Set();
  for (const value of Array.isArray(row.expected.allowed_numbers) ? row.expected.allowed_numbers : []) addRounded(allowed, value);
  numbersFrom(facts, allowed);
  row.expected.allowed_numbers = Array.from(allowed).filter((value) => Number.isFinite(value)).slice(0, 600);
  row.expected.derived_numbers_source = 'context.calculation_facts';
  row.expected.require_calculation_basis = true;
  return row;
}

module.exports = {
  SHARES_PER_LOT,
  finite,
  round,
  addRounded,
  numbersFrom,
  planFacts,
  budgetFacts,
  stockFacts,
  enrichCase
};
