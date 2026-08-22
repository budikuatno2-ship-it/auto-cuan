'use strict';

const base = require('./ai-runtime-grounding');

function positive(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function levelOf(plan, names) {
  const source = plan && typeof plan === 'object' ? plan : {};
  for (const name of names) {
    const value = positive(source[name]);
    if (value != null) return value;
  }
  return null;
}

function tickerKey(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
}

function addPerShareFacts(context) {
  const source = context && typeof context === 'object' ? context : {};
  const plans = Array.isArray(source.plans) ? source.plans : [];
  const facts = source.calculation_facts && Array.isArray(source.calculation_facts.plans)
    ? source.calculation_facts.plans
    : [];

  // Match by ticker rather than array position: calculation_facts.plans and
  // context.plans are built independently upstream, and pairing them purely
  // by index would silently attach one position's per-share loss/gain
  // figures to a different ticker's fact if the two arrays ever diverge in
  // order or length.
  const plansByTicker = new Map();
  plans.forEach((plan) => {
    const key = tickerKey(plan && plan.ticker);
    if (key && !plansByTicker.has(key)) plansByTicker.set(key, plan);
  });

  facts.forEach((fact, index) => {
    const factTicker = tickerKey(fact && fact.ticker);
    const plan = (factTicker && plansByTicker.get(factTicker)) || plans[index] || {};
    const entry = levelOf(plan, ['entryPriceIdr', 'entry_price', 'entry', 'avgPriceIdr']);
    const stop = levelOf(plan, ['stopLossIdr', 'stop_loss', 'stop']);
    const tp1 = levelOf(plan, ['tp1Idr', 'tp1']);
    const tp2 = levelOf(plan, ['tp2Idr', 'tp2']);
    if (entry != null && stop != null && entry > stop) fact.loss_to_stop_per_share_idr = entry - stop;
    if (entry != null && tp1 != null && tp1 > entry) fact.tp1_gain_per_share_idr = tp1 - entry;
    if (entry != null && tp2 != null && tp2 > entry) fact.tp2_gain_per_share_idr = tp2 - entry;
  });
  return source;
}

function prepareRuntimeGrounding(source, message, context) {
  const grounded = base.prepareRuntimeGrounding(source, message, context);
  return source === 'portfolio_chat' ? addPerShareFacts(grounded) : grounded;
}

module.exports = {
  ...base,
  prepareRuntimeGrounding,
  addPerShareFacts
};
