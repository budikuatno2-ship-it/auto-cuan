'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sectorHot = require('../api/sector-hot');
const templates = require('../lib/telegram-templates');

const {
  evaluateMonitorStatus,
  detectSwingBandarDistribution,
  isTerminalPick
} = sectorHot.__test;

test('Fase 5: detectSwingBandarDistribution detects massive distribution on Swing setups', () => {
  // CR3 >= 50% with negative net flow
  const dist1 = detectSwingBandarDistribution(
    { monitor_source: 'swing_konglo' },
    { cr3: 65, net_flow: -15000000000, retail_participation: 58 }
  );
  assert.equal(dist1.distribution_detected, true);
  assert.equal(dist1.reason, 'BANDAR_DISTRIBUTION_WARNING');
  assert.equal(dist1.cr3, 65);
  assert.equal(dist1.net_flow, -15000000000);

  // Status label DISTRIBUSI_MASIF
  const dist2 = detectSwingBandarDistribution(
    { monitor_source: 'swing_nk', bandarmologi_status: 'DISTRIBUSI_MASIF' },
    {}
  );
  assert.equal(dist2.distribution_detected, true);

  // Retail dominance (>50%) with negative flow
  const dist3 = detectSwingBandarDistribution(
    { monitor_source: 'swing_non_konglo' },
    { retail_participation: 62, net_flow: -8000000000 }
  );
  assert.equal(dist3.distribution_detected, true);

  // Explicit distribution flag
  const dist4 = detectSwingBandarDistribution(
    { monitor_source: 'swing_konglo', distribution_detected: true },
    {}
  );
  assert.equal(dist4.distribution_detected, true);
});

test('Fase 5: detectSwingBandarDistribution does not flag accumulation or normal flow', () => {
  // Accumulation: high CR3 but positive net flow
  const accum = detectSwingBandarDistribution(
    { monitor_source: 'swing_konglo' },
    { cr3: 68, net_flow: 25000000000, retail_participation: 30 }
  );
  assert.equal(accum.distribution_detected, false);
  assert.equal(accum.reason, null);

  // Neutral flow
  const neutral = detectSwingBandarDistribution(
    { monitor_source: 'swing_nk' },
    { cr3: 35, net_flow: 500000000, retail_participation: 40 }
  );
  assert.equal(neutral.distribution_detected, false);
});

test('Fase 5: Swing position with massive distribution & price < entry triggers EARLY_EXIT_DISTRIBUTION', () => {
  const pickKonglo = {
    ticker: 'ASII',
    category: 'Swing Konglo',
    monitor_source: 'swing_konglo',
    status: 'RUNNING',
    entry1: 5200,
    entry2: 5150,
    tp1: 5600,
    tp2: 5800,
    sl: 4950,
    hit_entry_at: '2026-09-11T09:15:00Z'
  };

  // Price drops below entryMid (5175) to 5100, but is still well above SL (4950)
  const pxDist = {
    last: 5100,
    at: new Date().toISOString(),
    source: 'swing_screener_latest',
    cr3: 65,
    cr5: 78,
    net_flow: -18000000000,
    retail_participation: 59
  };

  const evKonglo = evaluateMonitorStatus(pickKonglo, pxDist);
  assert.equal(evKonglo.status, 'EARLY_EXIT_DISTRIBUTION');
  assert.equal(evKonglo.isFinal, true);
  assert.equal(evKonglo.distribution_detected, true);
  assert.equal(evKonglo.bandar_distribution_warning, true);
  assert.equal(evKonglo.reason, 'BANDAR_DISTRIBUTION_WARNING');
  assert.equal(evKonglo.cr3, 65);
  assert.equal(evKonglo.net_flow, -18000000000);

  // Test Swing Non-Konglo setup
  const pickNK = {
    ticker: 'HEAL',
    category: 'Swing Non-Konglo',
    monitor_source: 'swing_nk',
    status: 'RUNNING',
    entry1: 1650,
    entry2: 1620,
    tp1: 1780,
    tp2: 1850,
    sl: 1550,
    hit_entry_at: '2026-09-11T09:30:00Z'
  };

  const pxDistNK = {
    last: 1600,
    at: new Date().toISOString(),
    source: 'swing_screener_non_konglo_latest',
    bandarmologi_status: 'DISTRIBUSI_MASIF',
    net_flow: -7500000000
  };

  const evNK = evaluateMonitorStatus(pickNK, pxDistNK);
  assert.equal(evNK.status, 'EARLY_EXIT_DISTRIBUTION');
  assert.equal(evNK.isFinal, true);
  assert.equal(evNK.distribution_detected, true);
  assert.equal(evNK.reason, 'BANDAR_DISTRIBUTION_WARNING');
});

test('Fase 5: Swing position with accumulation stays RUNNING without early exit', () => {
  const pick = {
    ticker: 'BBRI',
    category: 'Swing Konglo',
    monitor_source: 'swing_konglo',
    status: 'RUNNING',
    entry1: 5000,
    entry2: 4950,
    tp1: 5400,
    tp2: 5600,
    sl: 4750,
    hit_entry_at: '2026-09-11T09:00:00Z'
  };

  // Price is 4920 (< entryLow 4950), but Bandar is heavily accumulating
  const pxAccum = {
    last: 4920,
    at: new Date().toISOString(),
    source: 'swing_screener_latest',
    cr3: 70,
    net_flow: 35000000000,
    retail_participation: 28
  };

  const ev = evaluateMonitorStatus(pick, pxAccum);
  assert.equal(ev.status, 'RUNNING');
  assert.equal(ev.isFinal, false);
  assert.equal(Boolean(ev.distribution_detected), false);
});

test('Fase 5: Swing position with distribution but price above entry stays RUNNING with warning flag', () => {
  const pick = {
    ticker: 'TLKM',
    category: 'Swing Konglo',
    monitor_source: 'swing_konglo',
    status: 'RUNNING',
    entry1: 3000,
    entry2: 2960,
    tp1: 3250,
    tp2: 3400,
    sl: 2850,
    hit_entry_at: '2026-09-11T09:10:00Z'
  };

  // Price is 3050 (> entryMid 2980), but distribution detected
  const pxWarning = {
    last: 3050,
    at: new Date().toISOString(),
    source: 'swing_screener_latest',
    cr3: 65,
    cr5: 75,
    net_flow: -22000000000,
    retail_participation: 55
  };

  const ev = evaluateMonitorStatus(pick, pxWarning);
  assert.equal(ev.status, 'RUNNING');
  assert.equal(ev.isFinal, false);
  assert.equal(ev.distribution_detected, true);
  assert.equal(ev.bandar_distribution_warning, true);
  assert.equal(ev.reason, 'BANDAR_DISTRIBUTION_WARNING');
  assert.match(ev.note, /Peringatan: Distribusi bandar terdeteksi/);
});

test('Fase 5: Day Trade isolation — strictly unaffected by bandarmologi early exit logic', () => {
  const pickDaytrade = {
    ticker: 'BUMI',
    category: 'Day Trade',
    monitor_source: 'daytrade',
    status: 'RUNNING',
    entry1: 140,
    entry2: 138,
    tp1: 148,
    tp2: 155,
    sl: 134,
    hit_entry_at: '2026-09-11T09:05:00Z'
  };

  // Price is 137 (< entryMid 139), and heavy distribution payload is supplied
  const pxDaytrade = {
    last: 137,
    at: new Date().toISOString(),
    source: 'daytrade_screener_latest',
    cr3: 80,
    net_flow: -50000000000,
    retail_participation: 70,
    bandarmologi_status: 'DISTRIBUSI_MASIF',
    distribution_detected: true
  };

  // Direct detector check on daytrade source
  const directCheck = detectSwingBandarDistribution(pickDaytrade, pxDaytrade);
  assert.equal(directCheck.distribution_detected, false);

  const ev = evaluateMonitorStatus(pickDaytrade, pxDaytrade);
  // Daytrade must NEVER trigger EARLY_EXIT_DISTRIBUTION
  assert.notEqual(ev.status, 'EARLY_EXIT_DISTRIBUTION');
  assert.equal(ev.status, 'RUNNING');
  assert.equal(ev.isFinal, false);
  assert.equal(Boolean(ev.distribution_detected), false);
});

test('Fase 5: formatMonitorHitMessage formats EARLY_EXIT_DISTRIBUTION with structured details', () => {
  const pick = {
    ticker: 'BBRI',
    category: 'Swing Konglo',
    monitor_source: 'swing_konglo',
    entry1: 5000,
    entry2: 4950,
    tp1: 5400,
    sl: 4750
  };

  const ev = {
    status: 'EARLY_EXIT_DISTRIBUTION',
    cr3: 65,
    cr5: 78,
    net_flow: -15000000000,
    retail_participation: 58,
    label: 'Early Exit (Distribusi Bandar)'
  };

  const px = {
    last: 4920
  };

  const msg = templates.formatMonitorHitMessage(pick, ev, px);

  // Exact header check
  assert.match(msg, /🚨 AUTO-CUAN SWING — BANDAR DISTRIBUTION ALERT \/ EARLY EXIT/);
  // Emiten ticker check
  assert.match(msg, /Saham: BBRI/);
  // Category check
  assert.match(msg, /Kategori: Swing Konglo/);
  // Distribution metrics check
  assert.match(msg, /Distribusi: CR3: 65% · CR5: 78% · Net Flow: -Rp15,0 M · Ritel: 58%/);
  // Price and P/L check
  assert.match(msg, /Last: Rp4\.920/);
  assert.match(msg, /P\/L saat ini: -1\.6%/);
  // Exact risk mitigation instruction check
  assert.match(msg, /Catatan: Peringatan distribusi bandar terdeteksi\. Amankan modal atau pertimbangkan exit dini sebelum level SL teknikal\./);
});

test('Fase 5: isTerminalPick recognizes EARLY_EXIT_DISTRIBUTION and early_exit_at', () => {
  assert.equal(isTerminalPick({ status: 'EARLY_EXIT_DISTRIBUTION' }), true);
  assert.equal(isTerminalPick({ status: 'RUNNING', early_exit_at: '2026-09-11T10:00:00Z' }), true);
  assert.equal(isTerminalPick({ status: 'RUNNING', early_exit_at: null }), false);
});
