'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cryptoService = require('../lib/crypto-service');
const backtestScreener = require('../tools/backtest-screener');
const dtEngine = require('../lib/daytrade-screener-engine');
const fastWatcher = require('../lib/intraday-fast-watcher-momentum');
const bandarmologi = require('../lib/bandarmologi-service');

test('Klaster 2: safeToFixed is exported and formats correctly across engines', () => {
  assert.equal(typeof dtEngine.safeToFixed, 'function');
  assert.equal(typeof fastWatcher.safeToFixed, 'function');
  assert.equal(dtEngine.safeToFixed(12.3456), '12.35');
  assert.equal(dtEngine.safeToFixed(null), '0.00');
  assert.equal(dtEngine.safeToFixed(undefined), '0.00');
  assert.equal(dtEngine.safeToFixed('invalid'), '0.00');
  assert.equal(fastWatcher.safeToFixed(7.8), '7.80');
});

test('Klaster 2: Prespike and Early Momentum boundaries match specifications', () => {
  // Prespike Radar: -1.0% to +1.5%, Volume Ratio >= 2.5x
  assert.equal(dtEngine.isPrespikeRadar({ change_pct: 0.5, volume_ratio_20d: 3.0 }), true);
  assert.equal(dtEngine.isPrespikeRadar({ change_pct: -1.0, volume_ratio_20d: 2.5 }), true);
  assert.equal(dtEngine.isPrespikeRadar({ change_pct: 1.5, volume_ratio_20d: 2.5 }), true);
  assert.equal(dtEngine.isPrespikeRadar({ change_pct: 1.6, volume_ratio_20d: 3.0 }), false);
  assert.equal(dtEngine.isPrespikeRadar({ change_pct: -1.1, volume_ratio_20d: 3.0 }), false);
  assert.equal(dtEngine.isPrespikeRadar({ change_pct: 0.5, volume_ratio_20d: 2.4 }), false);

  // Early Momentum: +2.0% to +4.5%, Volume Ratio >= 1.8x
  assert.equal(dtEngine.isEarlyMomentum({ change_pct: 2.5, volume_ratio_20d: 2.0 }), true);
  assert.equal(dtEngine.isEarlyMomentum({ change_pct: 2.0, volume_ratio_20d: 1.8 }), true);
  assert.equal(dtEngine.isEarlyMomentum({ change_pct: 4.5, volume_ratio_20d: 1.8 }), true);
  assert.equal(dtEngine.isEarlyMomentum({ change_pct: 1.9, volume_ratio_20d: 2.0 }), false);
  assert.equal(dtEngine.isEarlyMomentum({ change_pct: 4.6, volume_ratio_20d: 2.0 }), false);
  assert.equal(dtEngine.isEarlyMomentum({ change_pct: 3.0, volume_ratio_20d: 1.7 }), false);
});

test('Klaster 3: Backtest screener parses mixed line breaks, MFE best_gain, and filters > +500% anomalies', () => {
  const mixedLines = 'ticker,entry,exit,high\r\nBBCA,100,110,115\nASII,200,190,205\rTLKM,300,330,360\r\nANOM,100,800,900';
  const parsed = backtestScreener.parseCsv(mixedLines);
  assert.equal(parsed.length, 4);

  // MFE calculation test
  const mfe = backtestScreener.calculateMfe(100, 125);
  assert.equal(mfe, 25);
  const mfeZero = backtestScreener.calculateMfe(100, 95);
  assert.equal(mfeZero, 0);

  // Run backtest
  const result = backtestScreener.runBacktest(parsed);
  assert.equal(result.total_trades, 3, 'Anomaly should be filtered out');
  assert.equal(result.anomalies_filtered, 1, '1 anomaly trade filtered');
  assert.equal(result.winning_trades, 2);
  assert.equal(result.losing_trades, 1);
  assert.equal(result.best_gain, 20); // TLKM mfe was (360-300)/300 = 20%
});

test('Klaster 5 & 6: Crypto service performs AES-256-GCM encryption with 12-byte IV, 16-byte tag, and timingSafeEqual', () => {
  const secretKey = 'test-encryption-key-for-zero-defect';
  const plaintext = 'Sensitive financial credentials payload';

  const encrypted = cryptoService.encrypt(plaintext, secretKey);
  assert.ok(encrypted.ciphertext);
  assert.equal(Buffer.from(encrypted.iv, 'hex').length, cryptoService.IV_LENGTH);
  assert.equal(Buffer.from(encrypted.tag, 'hex').length, cryptoService.AUTH_TAG_LENGTH);

  // Successful decryption
  const decrypted = cryptoService.decrypt(encrypted.serialized, secretKey);
  assert.equal(decrypted, plaintext);

  // Tampered ciphertext fails authentication
  const tampered = encrypted.serialized.slice(0, -2) + '00';
  assert.throws(() => {
    cryptoService.decrypt(tampered, secretKey);
  }, /Unsupported state or unable to authenticate data|bad decrypt/i);

  // timingSafeEqual tests
  assert.equal(cryptoService.timingSafeEqual('safe-token-12345', 'safe-token-12345'), true);
  assert.equal(cryptoService.timingSafeEqual('safe-token-12345', 'safe-token-wrong'), false);
  assert.equal(cryptoService.timingSafeEqual('short', 'much-longer-token'), false);
  assert.equal(cryptoService.timingSafeEqual(null, 'token'), false);
});

test('Klaster 1: Bandarmologi service returns official empty schema without demo dummy data', async () => {
  const demo = bandarmologi.generateDemoData();
  assert.equal(demo.is_empty, true);
  assert.equal(demo.status, 'NO_DATA');
  assert.ok(Array.isArray(demo.gross_buyers));
  assert.ok(Array.isArray(demo.gross_sellers));
  assert.ok(Array.isArray(demo.top_buyers));
  assert.ok(Array.isArray(demo.top_sellers));
  assert.equal(demo.gross_buyers.length, 0);

  const empty = await bandarmologi.getBandarmologiData('NONEXISTENT');
  assert.equal(empty.is_demo, false);
  assert.equal(empty.status, 'NO_DATA');
  assert.ok(Array.isArray(empty.top_buyers));
  assert.ok(Array.isArray(empty.top_sellers));
  assert.ok(Array.isArray(empty.gross_buyers));
  assert.ok(Array.isArray(empty.gross_sellers));
  assert.equal(empty.top_buyers.length, 0);
  assert.equal(empty.top_sellers.length, 0);
});

test('Bagian 4: UI CSS contains search static/flex rules, card grid padding, and overflow rules', () => {
  const cssPath = path.join(__dirname, '..', 'public', 'ui-theme.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  assert.match(css, /ticker-search-container/);
  assert.match(css, /position:\s*static\s*!important/);
  assert.match(css, /padding-bottom:\s*32px/);
  assert.match(css, /overflow-x:\s*hidden/);
});
