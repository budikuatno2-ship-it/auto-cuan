'use strict';

const STATUSES = [
  'WITHIN_ENTRY_RANGE',
  'AT_OR_BELOW_ENTRY',
  'WAIT_PULLBACK',
  'ENTRY_UNVERIFIED',
  'ENTRY_NOT_PROVIDED'
];

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function emptyBucket() {
  return { count: 0, executable_count: 0, blocked_count: 0, chase_pct_sum: 0, chase_pct_count: 0, chase_pct_avg: null };
}

function summarizeDayTradeEntryDiscipline(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, emptyBucket()]));
  let executableCount = 0;
  let blockedCount = 0;
  let chasedCount = 0;
  let chasePctSum = 0;
  let chasePctCount = 0;

  for (const row of list) {
    const status = STATUSES.includes(row && row.entry_discipline_status)
      ? row.entry_discipline_status
      : 'ENTRY_UNVERIFIED';
    const bucket = byStatus[status];
    bucket.count += 1;
    if (row && row.entry_executable_now === true) {
      bucket.executable_count += 1;
      executableCount += 1;
    } else {
      bucket.blocked_count += 1;
      blockedCount += 1;
    }
    const chasePct = finite(row && row.entry_chase_pct);
    if (chasePct != null) {
      bucket.chase_pct_sum += chasePct;
      bucket.chase_pct_count += 1;
      chasePctSum += chasePct;
      chasePctCount += 1;
      if (chasePct > 0) chasedCount += 1;
    }
  }

  for (const bucket of Object.values(byStatus)) {
    bucket.chase_pct_avg = bucket.chase_pct_count ? bucket.chase_pct_sum / bucket.chase_pct_count : null;
    delete bucket.chase_pct_sum;
    delete bucket.chase_pct_count;
  }

  return {
    total_count: list.length,
    executable_count: executableCount,
    blocked_count: blockedCount,
    chased_count: chasedCount,
    chased_pct: list.length ? (chasedCount / list.length) * 100 : null,
    chase_pct_avg: chasePctCount ? chasePctSum / chasePctCount : null,
    by_status: byStatus
  };
}

module.exports = { STATUSES, summarizeDayTradeEntryDiscipline };
