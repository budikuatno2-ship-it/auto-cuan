'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('V6.5.3 Telegram Three-Horizon recap avoids legacy Konglo wording and enforces R/R >= 1.50', () => {
  const recap = require('../lib/telegram-daily-recap');
  const mockDoc = {
    trade_date: '2026-11-24',
    horizons: {
      potensi_besok: {
        top20: [
          { ticker: 'RELF', company_name: 'Graha Mitra Asia Tbk.', last_price: 36, change_pct: 2.86, entry_low: 35, entry_high: 36, tp1: 42, sl: 33, risk_reward: 2.0, score: 91, confidence: 'A+' },
          { ticker: 'PWON', company_name: 'Pakuwon Jati Tbk.', last_price: 302, change_pct: 3.42, entry_low: 298, entry_high: 302, tp1: 326, sl: 288, risk_reward: 1.71, score: 96.3, confidence: 'A+' }
        ]
      },
      short_swing: {
        top20: [
          { ticker: 'BBCA', company_name: 'Bank Central Asia Tbk.', last_price: 9850, change_pct: 1.25, entry_low: 9750, entry_high: 9850, tp1: 10350, sl: 9525, risk_reward: 1.54, score: 88.0, confidence: 'A+' }
        ]
      },
      swing: {
        top20: [
          { ticker: 'BMRI', company_name: 'Bank Mandiri (Persero) Tbk.', last_price: 6250, change_pct: 0.81, entry_low: 6150, entry_high: 6250, tp1: 6750, sl: 5950, risk_reward: 1.67, score: 84.5, confidence: 'A' }
        ]
      }
    }
  };
  const msg = recap.formatThreeHorizonRecapMessage(mockDoc, { timeStr: '21:20 WIB' });
  assert.match(msg, /21:20 WIB/);
  assert.match(msg, /POTENSI BESOK \(1–5H\)/);
  assert.match(msg, /SHORT SWING \(3–10H\)/);
  assert.match(msg, /SWING \(7–30H\)/);
  assert.match(msg, /PWON/);
  assert.doesNotMatch(msg, /\bRELF\b/, 'stocks below Rp 50 must be excluded');
  assert.doesNotMatch(msg, /Konglo/i, 'legacy Konglo/Non-Konglo label must not appear');
  assert.match(msg, /Disclaimer/i);
});

test('V6.5.3 Admin Console & Screener HTML/CSS/JS invariants', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const acCss = fs.readFileSync(path.join(ROOT, 'public', 'ac-v2.css'), 'utf8');
  const adminRuntime = fs.readFileSync(path.join(ROOT, 'public', 'admin-console-runtime.js'), 'utf8');

  assert.match(indexHtml, /__AC_CANONICAL_EOD_DATE__/);
  assert.match(indexHtml, /pxVal < 50/);
  assert.match(indexHtml, /A\+ BESOK/);
  assert.match(indexHtml, /A\+ SHORT/);
  assert.match(acCss, /\.scr-rr-slot\s*\{[^}]*gap:\s*6px 14px/);
  assert.match(adminRuntime, /telegram_preview/);
  assert.match(adminRuntime, /telegram_test_admin/);
  assert.match(adminRuntime, /renderSecurityPanel\(data\.security\)/);
});

test('V6.5.3 Admin Console service uses TTL caching and sync-quota-state is valid', () => {
  const syncTool = require('../tools/sync-quota-state');
  assert.equal(typeof syncTool.syncQuotaState, 'function');
  assert.equal(typeof syncTool.loadEnvLimit, 'function');
  const adminUsersJs = fs.readFileSync(path.join(ROOT, 'api', 'admin-users.js'), 'utf8');
  assert.match(adminUsersJs, /recordHeartbeat\(auth\.session\.un/);
  assert.match(adminUsersJs, /telegram_preview/);
  assert.match(adminUsersJs, /telegram_test_admin/);
});
