'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'telegram-daily-picks-migration.sql'), 'utf8');

test('telegram daily picks migration replaces date+ticker uniqueness with plan identity', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS monitor_source TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS plan_lock_id TEXT/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS telegram_daily_picks_date_ticker_key/);
  assert.match(sql, /UNIQUE INDEX IF NOT EXISTS idx_telegram_daily_picks_plan_identity_unique/);
  assert.match(sql, /date, ticker, monitor_source, plan_lock_id/);
  assert.doesNotMatch(sql, /CONSTRAINT telegram_daily_picks_date_ticker_key UNIQUE/);
});
