'use strict';

// Broker consistency badge for the chart (HANDOFF §5a "Lencana konsistensi
// bandar"): the largest net-buying broker over the last 20 archived sessions,
// how many of the last 10 sessions it net bought, and its current streak.
//
// Reads the archived broker summaries on disk only (no live Arjum call), with
// the same normaliser the Bandarmologi page uses. Fewer than 5 archived
// sessions means no reading.

const WINDOW = 20;
const RECENT = 10;
const MIN_DAYS = 5;

function dayNets(summary) {
  const map = {};
  const lists = [summary.gross_buyers, summary.gross_sellers, summary.net_buyers, summary.net_sellers];
  lists.forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((b) => {
      const code = b && (b.broker || b.broker_code);
      if (!code || map[code]) return;
      const nval = b.nval != null ? Number(b.nval) : Number(b.bval || b.buy_val || 0) - Number(b.sval || b.sell_val || 0);
      if (!Number.isFinite(nval)) return;
      map[code] = { net: nval, name: b.broker_name || '' };
    });
  });
  return map;
}

function computeBrokerConsistency(ticker, options = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  const svc = options.service || require('./bandarmologi-service');
  const all = (options.dates || svc.listDiskDates('broker-summary', t) || []).slice().sort();
  const days = all.slice(-WINDOW).map((d) => {
    const raw = svc.readDiskCache('broker-summary', t, d);
    const norm = raw ? svc.normalizeBrokerSummary(raw, d, t) : null;
    return norm ? { date: d, nets: dayNets(norm) } : null;
  }).filter(Boolean);

  const empty = { success: true, data_available: false, ticker: t, window_days: days.length, as_of_date: days.length ? days[days.length - 1].date : null };
  if (days.length < MIN_DAYS) return empty;

  const totals = {};
  days.forEach((day) => Object.keys(day.nets).forEach((code) => {
    totals[code] = totals[code] || { net: 0, name: '' };
    totals[code].net += day.nets[code].net;
    if (!totals[code].name && day.nets[code].name) totals[code].name = day.nets[code].name;
  }));
  const top = Object.keys(totals).filter((c) => totals[c].net > 0).sort((a, b) => totals[b].net - totals[a].net)[0];
  if (!top) return Object.assign(empty, { data_available: true, top_broker: null });

  const recent = days.slice(-RECENT);
  const flags = recent.map((day) => Boolean(day.nets[top] && day.nets[top].net > 0));
  let streak = 0;
  for (let i = flags.length - 1; i >= 0 && flags[i]; i--) streak++;
  return {
    success: true,
    data_available: true,
    ticker: t,
    as_of_date: days[days.length - 1].date,
    window_days: days.length,
    top_broker: top,
    top_broker_name: totals[top].name,
    net_total: totals[top].net,
    days_net_buy: flags.filter(Boolean).length,
    of_days: recent.length,
    streak,
    recent: recent.map((day, i) => ({ date: day.date, net_buy: flags[i] }))
  };
}

module.exports = { computeBrokerConsistency, dayNets, WINDOW, RECENT, MIN_DAYS };
