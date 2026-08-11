-- ============================================================
-- IDX 2026 Exchange Holiday Calendar — Seed / Upsert (SQL alternative)
-- Run this manually in Supabase SQL Editor. Safe to run multiple times
-- (idempotent upsert on trade_date).
--
-- Requires supabase/stock-daily-context-migration.sql to have been applied
-- first (creates idx_trading_calendar).
--
-- Provenance: user-provided 2026 exchange calendar seed (see
-- lib/idx-holidays-2026-seed-data.js — the canonical source both this file
-- and scripts/seed-idx-holidays-2026.js are generated from). verified_at is
-- left NULL until someone independently confirms these dates against the
-- official BEI announcement.
--
-- July, September, October, and November 2026 intentionally have no rows
-- here — the source list has no additional exchange holidays in those
-- months beyond weekends, and nothing is fabricated to fill them.
--
-- NOT applied to production by this change — an operator must run it
-- manually against the target database.
-- ============================================================

INSERT INTO idx_trading_calendar (trade_date, status, name, source, verified_at, override_reason)
VALUES
  ('2026-01-01', 'HOLIDAY', 'Tahun Baru 2026 Masehi', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-01-16', 'HOLIDAY', 'Isra Mikraj Nabi Muhammad SAW', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-02-16', 'HOLIDAY', 'Cuti Bersama Tahun Baru Imlek 2577 Kongzili', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-02-17', 'HOLIDAY', 'Tahun Baru Imlek 2577 Kongzili', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-03-18', 'HOLIDAY', 'Cuti Bersama Hari Suci Nyepi Tahun Baru Saka 1948', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-03-19', 'HOLIDAY', 'Hari Suci Nyepi Tahun Baru Saka 1948', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-03-20', 'HOLIDAY', 'Cuti Bersama Idul Fitri 1447 Hijriah', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-03-23', 'HOLIDAY', 'Cuti Bersama Idul Fitri 1447 Hijriah', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-03-24', 'HOLIDAY', 'Cuti Bersama Idul Fitri 1447 Hijriah', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-04-03', 'HOLIDAY', 'Wafat Yesus Kristus', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-05-01', 'HOLIDAY', 'Hari Buruh Internasional', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-05-14', 'HOLIDAY', 'Kenaikan Yesus Kristus', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-05-15', 'HOLIDAY', 'Cuti Bersama Kenaikan Yesus Kristus', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-05-27', 'HOLIDAY', 'Idul Adha 1447 Hijriah', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-05-28', 'HOLIDAY', 'Cuti Bersama Hari Raya Idul Adha 1447 Hijriah', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-06-01', 'HOLIDAY', 'Hari Lahir Pancasila', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-06-16', 'HOLIDAY', '1 Muharam Tahun Baru Islam 1448 Hijriah', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-08-17', 'HOLIDAY', 'Proklamasi Kemerdekaan', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-08-25', 'HOLIDAY', 'Maulid Nabi Muhammad SAW', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-12-24', 'HOLIDAY', 'Cuti Bersama Kelahiran Yesus Kristus', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-12-25', 'HOLIDAY', 'Kelahiran Yesus Kristus', 'user_provided_2026_exchange_calendar_seed', NULL, NULL),
  ('2026-12-31', 'HOLIDAY', 'Libur Bursa', 'user_provided_2026_exchange_calendar_seed', NULL, NULL)
ON CONFLICT (trade_date) DO UPDATE SET
  status = EXCLUDED.status,
  name = EXCLUDED.name,
  source = EXCLUDED.source,
  override_reason = EXCLUDED.override_reason,
  updated_at = NOW();
