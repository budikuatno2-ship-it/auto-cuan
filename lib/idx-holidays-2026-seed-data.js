/**
 * IDX 2026 Exchange Holiday Calendar — user-provided seed data.
 *
 * Source/provenance: supplied directly by the project owner as the intended
 * 2026 exchange holiday schedule (not independently cross-checked against
 * the official IDX/KSEI announcement PDF from this environment — outbound
 * access to idx.co.id was blocked when this layer was first built). Treat
 * `verified_at` as null until someone independently confirms these dates
 * against the official BEI announcement (Peng-00171/BEI.POP/09-2025 or its
 * successor) and updates the row.
 *
 * This is the SINGLE source of truth consumed by both:
 *   - scripts/seed-idx-holidays-2026.js (idempotent upsert via Supabase JS client)
 *   - supabase/idx-holidays-2026-seed.sql (idempotent INSERT ... ON CONFLICT,
 *     generated from this same list, for direct SQL Editor use)
 * Keeping one list avoids the two seed paths drifting apart.
 *
 * Weekends are NOT included here — they are derived automatically by
 * lib/idx-trading-calendar.js and never need a database row.
 *
 * July, September, October, and November 2026 have no additional exchange
 * holidays in the source list beyond weekends — nothing is fabricated to
 * fill those months.
 */

'use strict';

const SOURCE = 'user_provided_2026_exchange_calendar_seed';

const IDX_HOLIDAYS_2026 = [
  { trade_date: '2026-01-01', name: 'Tahun Baru 2026 Masehi' },
  { trade_date: '2026-01-16', name: 'Isra Mikraj Nabi Muhammad SAW' },
  { trade_date: '2026-02-16', name: 'Cuti Bersama Tahun Baru Imlek 2577 Kongzili' },
  { trade_date: '2026-02-17', name: 'Tahun Baru Imlek 2577 Kongzili' },
  { trade_date: '2026-03-18', name: 'Cuti Bersama Hari Suci Nyepi Tahun Baru Saka 1948' },
  { trade_date: '2026-03-19', name: 'Hari Suci Nyepi Tahun Baru Saka 1948' },
  { trade_date: '2026-03-20', name: 'Cuti Bersama Idul Fitri 1447 Hijriah' },
  { trade_date: '2026-03-23', name: 'Cuti Bersama Idul Fitri 1447 Hijriah' },
  { trade_date: '2026-03-24', name: 'Cuti Bersama Idul Fitri 1447 Hijriah' },
  { trade_date: '2026-04-03', name: 'Wafat Yesus Kristus' },
  { trade_date: '2026-05-01', name: 'Hari Buruh Internasional' },
  { trade_date: '2026-05-14', name: 'Kenaikan Yesus Kristus' },
  { trade_date: '2026-05-15', name: 'Cuti Bersama Kenaikan Yesus Kristus' },
  { trade_date: '2026-05-27', name: 'Idul Adha 1447 Hijriah' },
  { trade_date: '2026-05-28', name: 'Cuti Bersama Hari Raya Idul Adha 1447 Hijriah' },
  { trade_date: '2026-06-01', name: 'Hari Lahir Pancasila' },
  { trade_date: '2026-06-16', name: '1 Muharam Tahun Baru Islam 1448 Hijriah' },
  { trade_date: '2026-08-17', name: 'Proklamasi Kemerdekaan' },
  { trade_date: '2026-08-25', name: 'Maulid Nabi Muhammad SAW' },
  { trade_date: '2026-12-24', name: 'Cuti Bersama Kelahiran Yesus Kristus' },
  { trade_date: '2026-12-25', name: 'Kelahiran Yesus Kristus' },
  { trade_date: '2026-12-31', name: 'Libur Bursa' }
];

/** Build full upsert-ready rows matching idx_trading_calendar's schema. */
function buildSeedRows() {
  return IDX_HOLIDAYS_2026.map(function(h) {
    return {
      trade_date: h.trade_date,
      status: 'HOLIDAY',
      name: h.name,
      source: SOURCE,
      verified_at: null,
      override_reason: null
    };
  });
}

module.exports = { SOURCE, IDX_HOLIDAYS_2026, buildSeedRows };
