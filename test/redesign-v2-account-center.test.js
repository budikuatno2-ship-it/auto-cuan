'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'public', 'account-center-v1.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'account-center-v1.css'), 'utf8');

test('Account Center has 6 canvas tabs with proper navigation attributes', () => {
  assert.match(js, /data-ac-tab="profile"/);
  assert.match(js, /data-ac-tab="security"/);
  assert.match(js, /data-ac-tab="preference"/);
  assert.match(js, /data-ac-tab="ai"/);
  assert.match(js, /data-ac-tab="langganan"/);
  assert.match(js, /data-ac-tab="terms"/);
  assert.doesNotMatch(js, /<button[^>]*data-ac-tab="subscription"/);
});

test('Theme switcher supports Otomatis, Terang, and Gelap', () => {
  assert.match(js, /id="acThmAuto"/);
  assert.match(js, /id="acThmLight"/);
  assert.match(js, /id="acThmDark"/);
  assert.match(js, /window\.acSetTheme/);
});

test('Session logout broadcasts across all tabs via BroadcastChannel and storage event', () => {
  assert.match(js, /broadcastCrossTabLogout/);
  assert.match(js, /new BroadcastChannel\('autocuan_auth'\)/);
  assert.match(js, /autocuan_logout_event/);
  assert.match(js, /window\.addEventListener\('storage'/);
});

test('Trading preferences support capital, risk %, sound test with Web Audio, and Si Mata toggle', () => {
  assert.match(js, /id="acPrefCap"/);
  assert.match(js, /id="acPrefRisk"/);
  assert.match(js, /id="acPrefSound"/);
  assert.match(js, /playAlertBeep/);
  assert.match(js, /id="acPrefMata"/);
  assert.match(js, /ac-mata-off/);
});

test('AI settings include BYOK Gemini, masked key, tier selector, and safe credential handling', () => {
  assert.match(js, /Gemini ••••••••••••••••/);
  assert.match(js, /id="acAiTier"/);
  assert.match(js, /value="auto"/);
  assert.match(js, /value="fast"/);
  assert.match(js, /value="deep"/);
  assert.match(js, /id="acAiInput"/);
  assert.match(js, /type="password"/);
  assert.doesNotMatch(js, /console\.log\([^\n]*rawKey/);
});

test('Ketentuan renders 12 accordion rules from canvas with toggle support', () => {
  assert.match(js, /Sifat layanan/);
  assert.match(js, /Tanggung jawab keputusan/);
  assert.match(js, /Sumber data/);
  assert.match(js, /Nilai kosong/);
  assert.match(js, /Sinyal & Track Record/);
  assert.match(js, /Asisten AI/);
  assert.match(js, /Akun & identitas/);
  assert.match(js, /Keamanan/);
  assert.match(js, /Langganan/);
  assert.match(js, /Data pribadi/);
  assert.match(js, /Penangguhan/);
  assert.match(js, /Perubahan ketentuan/);
  assert.match(js, /window\.acToggleTerm/);
});

test('UI copy is clean from em-dash in admin commands reference', () => {
  assert.match(js, /Daftar ini hanya referensi baca: jalankan perintahnya langsung di bot Telegram admin/);
  assert.doesNotMatch(js, /Daftar ini hanya referensi baca —/);
});

test('CSS enforces responsive layout and touch targets for mobile and desktop', () => {
  assert.match(css, /\.ac-center-layout\s*\{/);
  assert.match(css, /grid-template-columns:\s*220px minmax\(0,\s*1fr\)/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /min-height:\s*38px/);
});
