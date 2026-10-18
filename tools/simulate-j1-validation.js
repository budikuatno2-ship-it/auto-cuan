'use strict';

/**
 * Simulasi rule .done J1 untuk 5 hari bursa terakhir (12-16 Okt 2026).
 * 0 request Arjum -- semua dari disk lokal.
 *
 * Membandingkan dua skenario candle:
 *   A. candle Arjum (dari data/daily-candles/*.json)
 *   B. candle Yahoo (jika sudah tersedia di file yang sama, karena Fase 1A sudah
 *      menggabungkan bar Yahoo ke file cache -- jadi yang ada di disk adalah Yahoo
 *      untuk bar terbaru).
 *
 * Menjalankan DUA set aturan:
 *   1. ATURAN LAMA (commit 2dbf5ddc): .done hanya jika SEMUA file wajar
 *      termasuk f_broker_missing_in_all.
 *   2. ATURAN BARU (usulan prompt): sukses kecuali >1% tidak wajar ATAU ada
 *      yang tidak wajar pada 100 saham paling likuid.
 *
 * Output: JSON supaya bisa dilaporkan.
 */

const fs = require('fs');
const path = require('path');
const validator = require('/home/ubuntu/auto-cuan/lib/broksum-validator');

const DATA_ROOT = process.env.ARJUM_DATA_DIR || '/home/ubuntu/auto-cuan/data/arjum-data';
const ALL_DIR = path.join(DATA_ROOT, 'broker-summary');
const F_DIR = path.join(DATA_ROOT, 'broker-summary-F');
const CANDLE_DIR = '/home/ubuntu/auto-cuan/data/daily-candles';

const DATES = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];

// ── 100 saham paling likuid (sederhana: ranking turnover rata-rata 3 bulan) ──
function loadTop100Liquid() {
  const ranking = [];
  try {
    const files = fs.readdirSync(CANDLE_DIR).filter(f => f.endsWith('.json') && f !== 'IHSG.json');
    for (const f of files) {
      const tk = f.replace('.json', '');
      try {
        const d = JSON.parse(fs.readFileSync(path.join(CANDLE_DIR, f), 'utf8'));
        const cs = (d.candles || []).slice(-60);
        if (cs.length === 0) continue;
        const sum = cs.reduce((a, c) => a + Number(c.volume || 0) * Number(c.close || 0), 0);
        ranking.push({ ticker: tk, avgTurnover: sum / cs.length });
      } catch (_) {}
    }
  } catch (_) {}
  ranking.sort((a, b) => b.avgTurnover - a.avgTurnover);
  return new Set(ranking.slice(0, 100).map(r => r.ticker));
}

const TOP100 = loadTop100Liquid();

// ── Candle reader ─────────────────────────────────────────────────────────
function readCandle(ticker, date) {
  try {
    const p = path.join(CANDLE_DIR, `${ticker}.json`);
    if (!fs.existsSync(p)) return null;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const c of (d.candles || [])) {
      const dd = String(c.date || c.time || '').slice(0, 10);
      if (dd === date) {
        return {
          close: Number(c.close),
          volume: Number(c.volume),
          value: c.value != null ? Number(c.value) : null,
          source: d.source || 'unknown'
        };
      }
    }
  } catch (_) {}
  return null;
}

// ── Deduplikasi brokers[] + broker_levels[] (seperti micro fix di validator) ──
function buildCompleteCodeSet(payload) {
  const codes = new Set();
  if (payload && Array.isArray(payload.brokers)) {
    for (const b of payload.brokers) {
      if (b && b.broker_code) codes.add(String(b.broker_code).trim().toUpperCase());
    }
  }
  if (payload && Array.isArray(payload.broker_levels)) {
    for (const lvl of payload.broker_levels) {
      if (!lvl) continue;
      if (lvl.buy && lvl.buy.broker_code) codes.add(String(lvl.buy.broker_code).trim().toUpperCase());
      if (lvl.sell && lvl.sell.broker_code) codes.add(String(lvl.sell.broker_code).trim().toUpperCase());
    }
  }
  return codes;
}

// ── Validasi harian ───────────────────────────────────────────────────────
function validateDay(date) {
  const invalidAll = [];
  const invalidF = [];
  const invalidByRule = {};

  const allIndex = new Map();

  // 1. ALL files
  if (fs.existsSync(ALL_DIR)) {
    for (const tk of fs.readdirSync(ALL_DIR)) {
      const f = path.join(ALL_DIR, tk, `${date}.json`);
      if (!fs.existsSync(f)) continue;
      let payload;
      try { payload = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
        invalidAll.push({ ticker: tk, category: 'parse_error', flags: ['parse_error'] });
        invalidByRule.parse_error = (invalidByRule.parse_error || 0) + 1;
        continue;
      }
      allIndex.set(tk, payload);
      const candle = readCandle(tk, date);
      const v = validator.validateBroksumAgainstCandle(payload, candle);
      if (!v.valid) {
        // Kategorisasi ala J1: hanya 4 aturan ini yang benar-benar korupsi
        const hardFlags = ['empty_broksum_but_candle_has_volume', 'unclipped_ratio_below', 'unclipped_imbalance', 'parse_error'];
        const isHard = v.flags.some(fl => hardFlags.includes(fl));
        if (isHard) {
          invalidAll.push({ ticker: tk, category: v.flags.find(fl => hardFlags.includes(fl)), flags: v.flags, ratio: v.ratio });
          for (const fl of v.flags) {
            if (hardFlags.includes(fl)) invalidByRule[fl] = (invalidByRule[fl] || 0) + 1;
          }
        }
      }
    }
  }

  // 2. F files
  if (fs.existsSync(F_DIR)) {
    for (const tk of fs.readdirSync(F_DIR)) {
      const f = path.join(F_DIR, tk, `${date}.json`);
      if (!fs.existsSync(f)) continue;
      let fPayload;
      try { fPayload = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
        invalidF.push({ ticker: tk, category: 'f_parse_error', flags: ['parse_error'] });
        invalidByRule.f_parse_error = (invalidByRule.f_parse_error || 0) + 1;
        continue;
      }
      const aPayload = allIndex.get(tk);
      if (!aPayload) continue;

      // Gunakan validator PRODUKSI (lib/broksum-validator.js) supaya aturan di
      // simulasi ini persis sama dengan J1 saat dijalankan.
      const fTotals = validator.summarizeBroksumTotals(fPayload);
      const v = validator.validateForeignAgainstAll(fPayload, aPayload);
      if (v.valid) continue;

      // Klasifikasi anomali keras
      const HARD_F = ['f_empty_but_all_has_value', 'f_buy_exceeds_all', 'f_sell_exceeds_all', 'foreign_buy_exceeds_all', 'foreign_sell_exceeds_all'];
      const hard = v.flags.filter(fl => HARD_F.includes(fl));
      if (hard.length > 0) {
        invalidF.push({ ticker: tk, category: hard[0], flags: v.flags });
        for (const fl of v.flags) invalidByRule[fl] = (invalidByRule[fl] || 0) + 1;
      } else if (v.flags.includes('foreign_broker_missing_in_all')) {
        invalidF.push({ ticker: tk, category: 'f_broker_missing_in_all', flags: v.flags });
        invalidByRule.f_broker_missing_in_all = (invalidByRule.f_broker_missing_in_all || 0) + 1;
      } else {
        invalidByRule.foreign_warning_only = (invalidByRule.foreign_warning_only || 0) + 1;
      }
    }
  }

  // Total saham yang ada di all hari ini (untuk persentase)
  const totalAllFiles = allIndex.size;
  const totalInvalid = invalidAll.length + invalidF.length;
  const invalidPct = totalAllFiles > 0 ? (totalInvalid / totalAllFiles) * 100 : 0;

  // Apakah ada yang tidak wajar di top 100 likuid?
  const top100Invalid = [...invalidAll, ...invalidF].filter(r => TOP100.has(r.ticker));

  return {
    date,
    totalAllFiles,
    invalidAllCount: invalidAll.length,
    invalidFCount: invalidF.length,
    invalidTotal: totalInvalid,
    invalidPct: Number(invalidPct.toFixed(3)),
    invalidByRule,
    top100InvalidCount: top100Invalid.length,
    top100InvalidSample: top100Invalid.slice(0, 10),
    sampleInvalid: [...invalidAll, ...invalidF].slice(0, 20)
  };
}

// ── Main ──────────────────────────────────────────────────────────────────
const results = [];
for (const d of DATES) {
  results.push(validateDay(d));
}

// Evaluasi dua skenario
const summary = results.map(r => {
  // Aturan LAMA: sukses hanya jika SEMUA wajar
  const oldDone = r.invalidTotal === 0;

  // Aturan BARU: sukses kecuali (a) >1% tidak wajar, ATAU (b) ada di 100 likuid
  const newDone = !(r.invalidPct > 1 || r.top100InvalidCount > 0);

  return {
    date: r.date,
    totalAllFiles: r.totalAllFiles,
    invalidAllCount: r.invalidAllCount,
    invalidFCount: r.invalidFCount,
    invalidTotal: r.invalidTotal,
    invalidPct: r.invalidPct,
    invalidByRule: r.invalidByRule,
    top100InvalidCount: r.top100InvalidCount,
    oldRuleDone: oldDone ? 'TERTULIS' : 'TERTAHAN',
    newRuleDone: newDone ? 'TERTULIS' : 'TERTAHAN',
    sampleInvalid: r.sampleInvalid.slice(0, 5)
  };
});

console.log(JSON.stringify({
  top100Count: TOP100.size,
  top100Sample: Array.from(TOP100).slice(0, 10),
  results: summary
}, null, 2));
