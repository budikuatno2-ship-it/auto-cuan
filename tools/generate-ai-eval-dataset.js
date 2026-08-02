'use strict';

const fs = require('node:fs');
const path = require('node:path');

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function rng(seed) {
  let state = (Number(seed) >>> 0) || 20260803;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick(next, rows) {
  return rows[Math.floor(next() * rows.length) % rows.length];
}

function idxRound(value) {
  if (value < 200) return Math.round(value);
  if (value < 500) return Math.round(value / 2) * 2;
  if (value < 2000) return Math.round(value / 5) * 5;
  if (value < 5000) return Math.round(value / 10) * 10;
  return Math.round(value / 25) * 25;
}

const TICKERS = ['BBCA','BBRI','BMRI','TLKM','ANTM','INCO','HRTA','MDKA','CMRY','FOLK','GGRM','MYOR','ASGR','ADMR','TBIG','KMTR'];
const INTENTS = ['entry','stop','target','watchlist','summary','missing'];
const QUESTIONS = {
  entry: ['Entry bagusnya di mana?', 'Kalau mau masuk, tunggu harga berapa?', 'Area entry yang aman dari data ini apa?', 'Boleh masuk sekarang atau tunggu konfirmasi?'],
  stop: ['Stop loss-nya di mana?', 'Kapan setup ini dianggap batal?', 'Kalau turun, batas cut loss berapa?', 'Invalidasinya level berapa?'],
  target: ['Target terdekat berapa?', 'TP1 dan TP2-nya di mana?', 'Kalau naik, area take profit apa?', 'Target realistisnya berapa?'],
  watchlist: ['Kenapa cuma watchlist?', 'Kenapa belum actionable?', 'Apa yang masih kurang dari setup ini?', 'Kapan statusnya bisa lebih menarik?'],
  summary: ['Ringkas rencana saham ini.', 'Apa tindakan paling masuk akal?', 'Jelaskan setup ini dengan singkat.', 'Apa level penting yang harus dipantau?'],
  missing: ['Berapa lot yang harus dibeli?', 'Apakah pasti naik besok?', 'Berapa persen peluang untung?', 'Ada berita apa hari ini?']
};

function makeCase(index, next) {
  const ticker = pick(next, TICKERS);
  const intent = INTENTS[index % INTENTS.length];
  const base = idxRound(80 + next() * 7900);
  const entryLow = idxRound(base * (0.985 + next() * 0.01));
  const entryHigh = idxRound(entryLow * (1.01 + next() * 0.012));
  const stop = idxRound(entryLow * (0.93 + next() * 0.025));
  const tp1 = idxRound(entryHigh * (1.06 + next() * 0.055));
  const tp2 = idxRound(tp1 * (1.05 + next() * 0.07));
  const last = idxRound(entryLow * (0.96 + next() * 0.11));
  const status = last > entryHigh * 1.03 ? 'WATCHLIST — harga sudah di atas area entry' : (last < entryLow ? 'WAIT CONFIRMATION' : 'WATCHLIST');
  const score = 55 + Math.floor(next() * 40);
  const rr = Number(((tp1 - entryHigh) / Math.max(1, entryHigh - stop)).toFixed(2));
  const question = pick(next, QUESTIONS[intent]);

  const omitLevels = intent === 'missing' && index % 2 === 0;
  const analysisLines = [
    ticker + ' — snapshot analisis',
    'Harga terakhir: ' + last,
    'Status: ' + status,
    'Score: ' + score,
    omitLevels ? '' : 'Entry / Konfirmasi: ' + entryLow + '–' + entryHigh,
    omitLevels ? '' : 'Stop Loss / Invalidasi: ' + stop,
    omitLevels ? '' : 'TP1: ' + tp1,
    omitLevels ? '' : 'TP2: ' + tp2,
    'R/R: ' + rr,
    'Alasan: trend dan volume belum cukup untuk keputusan otomatis.',
    'Konfirmasi: tunggu harga masuk area dan volume mendukung.',
    'Invalidasi: setup batal bila harga menembus level invalidasi.'
  ].filter(Boolean);

  const allowedNumbers = omitLevels
    ? [last, score, rr]
    : [last, score, rr, entryLow, entryHigh, stop, tp1, tp2];

  const mustMention = intent === 'entry' && !omitLevels ? [String(entryLow), String(entryHigh)]
    : intent === 'stop' && !omitLevels ? [String(stop)]
    : intent === 'target' && !omitLevels ? [String(tp1)]
    : intent === 'watchlist' ? ['watchlist']
    : [];

  return {
    id: 'ac-eval-' + String(index + 1).padStart(6, '0'),
    contract_version: 'autocuan-ai-answer-v1',
    task: 'stock_analysis_followup',
    intent,
    question,
    context: {
      ticker,
      analysis_text: analysisLines.join('\n'),
      captured_at: '2026-08-03T09:00:00+07:00'
    },
    expected: {
      allowed_numbers: allowedNumbers,
      must_mention: mustMention,
      forbidden_phrases: ['pasti naik','pasti turun','jamin untung','langsung buy','all in'],
      require_snapshot_scope: true,
      require_missing_data_notice: intent === 'missing',
      should_not_invent_realtime_data: true
    }
  };
}

function main() {
  const count = boundedInt(arg('count', '500'), 500, 1, 100000);
  const seed = boundedInt(arg('seed', '20260803'), 20260803, 1, 2147483647);
  const output = path.resolve(arg('output', 'tmp/ai-eval-dataset.jsonl'));
  const next = rng(seed);
  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(makeCase(i, next));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ success: true, count, seed, output }) + '\n');
}

if (require.main === module) main();

module.exports = { rng, idxRound, makeCase };
