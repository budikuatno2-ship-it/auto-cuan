'use strict';

// Redesign v2 data states (HANDOFF §6): canvas ST copy, real empty/loading/
// error, and an error that never guesses numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const States = require(path.join(ROOT, 'public', 'ac-states.js'));
const css = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');

const PAGES = ['Dashboard', 'Screener', 'Sektor Hot', 'Analisis & Chart', 'Bandarmologi', 'Sinyal Intelijen',
  'Broker Hunter', 'Insider', 'Ranking', 'Financial', 'Struktur Pasar', 'Pattern Radar', 'Watchlist',
  'Portfolio', 'Track Record', 'Kelola Keuangan', 'Pusat Akun', 'Admin Console'];

test('every data page of the canvas has empty, loading and error copy', () => {
  for (const page of PAGES) {
    for (const state of ['empty', 'loading', 'error']) {
      assert.ok(States.html(page, state).length > 0, page + ' ' + state);
    }
  }
});

test('copy carries no stale clock times, sample tickers or em dashes', () => {
  const all = JSON.stringify(States.COPY);
  assert.doesNotMatch(all, /\d{1,2}\.\d{2} WIB/, 'schedule times change; the copy must not pin them');
  assert.doesNotMatch(all, /BRPT/, 'sample ticker from the canvas must not ship');
  assert.doesNotMatch(all, /—/, 'no em dash in UI copy');
  assert.doesNotMatch(all, /\.dc\.html/, 'canvas file links must be mapped to app routes');
});

test('error state names the real last-saved time or says nothing is saved', () => {
  const withSaved = States.html('Screener', 'error', { lastSavedAt: '2026-10-19T09:05:00Z' });
  assert.match(withSaved, /19 Okt 2026, 16\.05 WIB/);
  assert.match(withSaved, /Buka data terakhir/);
  assert.match(withSaved, /Tidak ada angka yang ditebak/);
  assert.match(withSaved, /role="alert"/);

  const none = States.html('Screener', 'error');
  assert.match(none, /Belum ada data tersimpan/);
  assert.doesNotMatch(none, /Buka data terakhir/);
  assert.match(none, /Coba lagi/);

  const bad = States.html('Screener', 'error', { lastSavedAt: 'not-a-date' });
  assert.match(bad, /Belum ada data tersimpan/);
});

test('error reason is escaped', () => {
  const out = States.html('Watchlist', 'error', { reason: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img/);
});

test('loading state keeps the content height so nothing shifts', () => {
  const out = States.html('Ranking', 'loading', { skeletonRows: 3, skeletonHeight: 480 });
  assert.match(out, /min-height:480px/);
  assert.equal((out.match(/<i><\/i>/g) || []).length, 3);
  assert.match(out, /role="status"/);
});

test('empty state links go to app routes', () => {
  const out = States.html('Dashboard', 'empty');
  assert.match(out, /data-state-route="screener"/);
});

test('state styles animate only transform or opacity and stop for reduced motion', () => {
  const section = css.slice(css.indexOf('/* 9a. Data states'));
  const keyframes = section.match(/@keyframes ac-[a-z]+\s*\{[\s\S]*?\}\s*\}/g) || [];
  assert.ok(keyframes.length >= 2);
  for (const k of keyframes) assert.doesNotMatch(k, /background-position|width|height|left|top/);
  assert.match(section, /prefers-reduced-motion: reduce\)\s*\{\s*\.ac-spin, \.ac-state-sk i \{ animation: none; \}/);
});
