'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const WATCHLIST_JS = fs.readFileSync(path.join(ROOT, 'public', 'watchlist-runtime.js'), 'utf8');
const CSS_V2 = fs.readFileSync(path.join(ROOT, 'public', 'ac-v2.css'), 'utf8');

test('Watchlist redesign: header carries title, description, and action buttons matching canvas', () => {
  const wlSection = INDEX_HTML.slice(INDEX_HTML.indexOf('id="page-watchlist"'));
  assert.match(wlSection, /<h1>Watchlist<\/h1>/);
  assert.match(wlSection, /Saham yang Anda pantau: niat, bukan posisi/);
  assert.match(wlSection, /id="btnWatchlistAlertLog"/);
  assert.match(wlSection, /Riwayat alert/);
  assert.match(wlSection, /id="wlRefreshBtn"/);
  assert.match(wlSection, /\+ Tambah dari Screener/);
});

test('Watchlist redesign: summary strip defines all 4 canvas metrics', () => {
  assert.match(INDEX_HTML, /id="wlTotalCount"/);
  assert.match(INDEX_HTML, /id="wlActiveAlertCount"/);
  assert.match(INDEX_HTML, /id="wlUpCount"/);
  assert.match(INDEX_HTML, /id="wlDownCount"/);
  assert.match(INDEX_HTML, /via Telegram/);
});

test('Watchlist redesign: filter bar has 4 chips with .fchip class and data-wl-filter', () => {
  assert.match(INDEX_HTML, /class="fchip on" data-wl-filter="all"/);
  assert.match(INDEX_HTML, /class="fchip" data-wl-filter="alert"/);
  assert.match(INDEX_HTML, /class="fchip" data-wl-filter="gain"/);
  assert.match(INDEX_HTML, /class="fchip" data-wl-filter="loss"/);
});

test('Watchlist redesign: table container is .tw with overflow-x auto and 7-column layout', () => {
  assert.match(WATCHLIST_JS, /class="tw wl-table-wrap"/);
  assert.match(WATCHLIST_JS, /<th>Ticker<\/th>/);
  assert.match(WATCHLIST_JS, /<th class="r">Harga<\/th>/);
  assert.match(WATCHLIST_JS, /<th class="r">Perubahan<\/th>/);
  assert.match(WATCHLIST_JS, /<th>Alert<\/th>/);
  assert.match(WATCHLIST_JS, /<th>Jarak ke alert<\/th>/);
  assert.match(WATCHLIST_JS, /<th>Catatan pantauan<\/th>/);
  assert.match(WATCHLIST_JS, /<th class="r">Aksi<\/th>/);
});

test('Watchlist redesign: CSS defines .fchip, .drawer, .ib, .prox and mobile touch target >= 44px', () => {
  assert.match(CSS_V2, /\.fchip\s*\{/);
  assert.match(CSS_V2, /\.drawer\s*\{/);
  assert.match(CSS_V2, /\.ib\s*\{/);
  assert.match(CSS_V2, /\.prox\s*\{/);
  assert.match(CSS_V2, /min-height:\s*44px/);
  assert.match(CSS_V2, /#wlRefreshBtn:focus-visible/);
});

test('Watchlist redesign: runtime updates up and down counters and formats counts with honest empty state', () => {
  assert.match(WATCHLIST_JS, /upCount\+\+/);
  assert.match(WATCHLIST_JS, /downCount\+\+/);
  assert.match(WATCHLIST_JS, /wlUpCount/);
  assert.match(WATCHLIST_JS, /wlDownCount/);
  assert.match(WATCHLIST_JS, /Tidak ada saham di filter ini\./);
});
