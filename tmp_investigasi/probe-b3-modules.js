'use strict';
const pub = require('../lib/intraday-fast-watcher-publisher');
const svc = require('../lib/bandarmologi-service');

console.log('--- M2: publisher.getMarketSession (flat vs day-of-week) ---');
for (const [t, d, label] of [
  ['10:00', '2026-08-13', 'THU morning'],
  ['13:00', '2026-08-13', 'THU lunch break (12:00-13:30)'],
  ['14:00', '2026-08-13', 'THU afternoon'],
  ['13:00', '2026-08-14', 'FRI break (11:30-14:00) -> must NOT be SESSION_2'],
  ['12:00', '2026-08-14', 'FRI break -> must NOT be SESSION_2'],
  ['14:30', '2026-08-14', 'FRI afternoon'],
  ['16:05', '2026-08-13', 'THU after close']
]) {
  console.log(label.padEnd(52), t, '=>', pub.getMarketSession(t, d), '| legacy single-arg:', pub.getMarketSession(t));
}

console.log('\n--- M4: filterCalendarWindowDates over-collection ---');
// 14 consecutive trading days, newest first
const many = [];
let cursor = new Date('2026-08-14T00:00:00Z');
while (many.length < 14) {
  const day = cursor.getUTCDay();
  if (day !== 0 && day !== 6) many.push(cursor.toISOString().slice(0, 10));
  cursor = new Date(cursor.getTime() - 86400000);
}
console.log('available trading days:', many.length, many.join(','));
for (const want of [1, 2, 5, 7]) {
  const got = svc.filterCalendarWindowDates(many, want);
  console.log(`requested ${want}d -> returned ${got.length} dates`, got.length > want ? '*** OVER-AGGREGATED ***' : '');
}

console.log('\n--- M4b: aggregateBrokerSummaries with no disk cache ---');
const agg = svc.aggregateBrokerSummaries('ZZZT', ['2026-08-14', '2026-08-13'], 2, true);
console.log('returned:', agg === null ? 'null (no per-day headers at all)' : JSON.stringify(Object.keys(agg)));
