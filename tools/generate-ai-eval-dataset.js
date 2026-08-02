'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');

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
const STOCK_INTENTS = ['entry','stop','target','watchlist','summary','missing'];
const PORTFOLIO_INTENTS = ['risk','allocation','priority','average_down','stop_plan','missing'];

const STOCK_QUESTIONS = {
  entry: ['Entry enaknya di mana?', 'Kalau mau masuk, tunggu harga berapa?', 'Area entry yang masih masuk akal dari data ini apa?', 'Sekarang sudah oke buat masuk atau mending tunggu?'],
  stop: ['Stop loss-nya di mana?', 'Setup ini batal kalau turun ke berapa?', 'Batas cut loss yang masuk akal berapa?', 'Invalidasinya level berapa?'],
  target: ['Target terdekat berapa?', 'TP1 dan TP2-nya di mana?', 'Kalau naik, area take profit-nya apa?', 'Target yang masih realistis berapa?'],
  watchlist: ['Kenapa masih watchlist?', 'Kok belum actionable?', 'Yang kurang dari setup ini apa?', 'Kapan setup-nya baru lebih menarik?'],
  summary: ['Tolong ringkas rencana saham ini.', 'Tindakan paling masuk akal sekarang apa?', 'Jelasin setup ini secara singkat dong.', 'Level penting yang harus dipantau apa saja?'],
  missing: ['Berapa lot yang harus aku beli?', 'Besok pasti naik nggak?', 'Peluang untungnya berapa persen?', 'Ada berita terbaru apa hari ini?']
};

const PORTFOLIO_QUESTIONS = {
  risk: ['Portofolioku terlalu berisiko nggak?', 'Posisi mana yang paling rawan?', 'Risiko gabungannya masih aman atau sudah berat?', 'Yang perlu paling diawasi sekarang apa?'],
  allocation: ['Pembagian modalnya sudah masuk akal belum?', 'Ada posisi yang kebesaran nggak?', 'Modal sebaiknya dibagi seperti apa dari data ini?', 'Konsentrasi portofolioku terlalu berat di mana?'],
  priority: ['Posisi mana yang harus dicek dulu?', 'Urutan prioritas tindakannya gimana?', 'Mana yang perlu diberesin lebih dulu?', 'Kalau cuma bisa fokus satu posisi, pilih yang mana?'],
  average_down: ['Ada yang layak average down nggak?', 'Average down di posisi ini masuk akal atau malah nambah risiko?', 'Sebelum tambah posisi, apa yang wajib dicek?', 'Mana yang jangan di-average down dulu?'],
  stop_plan: ['Rencana stop loss portofolioku sudah rapi belum?', 'Ada posisi tanpa invalidasi yang jelas nggak?', 'Batas risiko per posisi sudah masuk akal?', 'Stop loss mana yang paling perlu diperbaiki?'],
  missing: ['Berapa harga real-time semua sahamku sekarang?', 'Besok portofolioku pasti hijau nggak?', 'Saham mana yang dijamin cuan?', 'Ada berita terbaru untuk semua posisi?']
};

const FORBIDDEN = ['pasti naik','pasti turun','jamin untung','langsung buy','langsung sell','all in','gas full','auto cuan'];

function makeStockCase(index, next) {
  const ticker = pick(next, TICKERS);
  const intent = STOCK_INTENTS[index % STOCK_INTENTS.length];
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
  const question = pick(next, STOCK_QUESTIONS[intent]);
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

  const allowedNumbers = omitLevels ? [last, score, rr] : [last, score, rr, entryLow, entryHigh, stop, tp1, tp2];
  const mustMention = intent === 'entry' && !omitLevels ? [String(entryLow), String(entryHigh)]
    : intent === 'stop' && !omitLevels ? [String(stop)]
      : intent === 'target' && !omitLevels ? [String(tp1)]
        : intent === 'watchlist' ? ['watchlist'] : [];

  return {
    id: 'ac-stock-' + String(index + 1).padStart(7, '0'),
    contract_version: 'autocuan-ai-answer-v1',
    task: 'stock_analysis_followup',
    intent,
    question,
    context: { ticker, analysis_text: analysisLines.join('\n'), captured_at: '2026-08-03T09:00:00+07:00' },
    expected: {
      allowed_numbers: allowedNumbers,
      must_mention: mustMention,
      forbidden_phrases: FORBIDDEN,
      require_snapshot_scope: true,
      require_missing_data_notice: intent === 'missing',
      should_not_invent_realtime_data: true,
      style: 'gen_z_natural_professional'
    }
  };
}

function makePortfolioCase(index, next) {
  const intent = PORTFOLIO_INTENTS[index % PORTFOLIO_INTENTS.length];
  const positionCount = 1 + Math.floor(next() * 4);
  const used = new Set();
  const plans = [];
  const prices = {};
  const allowedNumbers = [];

  while (plans.length < positionCount) {
    const ticker = pick(next, TICKERS);
    if (used.has(ticker)) continue;
    used.add(ticker);
    const entry = idxRound(100 + next() * 7500);
    const last = idxRound(entry * (0.84 + next() * 0.34));
    const stop = idxRound(entry * (0.90 + next() * 0.06));
    const tp1 = idxRound(entry * (1.06 + next() * 0.09));
    const tp2 = idxRound(tp1 * (1.05 + next() * 0.08));
    const lots = 1 + Math.floor(next() * 80);
    const capital = entry * lots * 100;
    const estimatedLoss = Math.max(0, (entry - stop) * lots * 100);
    plans.push({ ticker, entryPriceIdr: entry, stopLossIdr: stop, tp1Idr: tp1, tp2Idr: tp2, lots, estimatedMaxLossIdr: estimatedLoss, capitalIdr: capital, source: 'simulation' });
    prices[ticker] = last;
    allowedNumbers.push(entry, last, stop, tp1, tp2, lots, estimatedLoss, capital);
  }

  const totalCapital = plans.reduce((sum, row) => sum + row.capitalIdr, 0);
  const totalRisk = plans.reduce((sum, row) => sum + row.estimatedMaxLossIdr, 0);
  allowedNumbers.push(totalCapital, totalRisk, positionCount);
  const question = pick(next, PORTFOLIO_QUESTIONS[intent]);
  const missingIntent = intent === 'missing';

  return {
    id: 'ac-portfolio-' + String(index + 1).padStart(7, '0'),
    contract_version: 'autocuan-ai-answer-v1',
    task: 'portfolio_chat',
    intent,
    question,
    context: {
      plans,
      prices,
      summary: { position_count: positionCount, total_capital_idr: totalCapital, estimated_max_loss_idr: totalRisk },
      data_note: 'Harga adalah snapshot simulasi tersimpan, bukan harga real-time.'
    },
    expected: {
      allowed_numbers: allowedNumbers,
      must_mention: intent === 'risk' ? ['risiko'] : [],
      forbidden_phrases: FORBIDDEN,
      require_snapshot_scope: true,
      require_missing_data_notice: missingIntent,
      should_not_invent_realtime_data: true,
      style: 'gen_z_natural_professional'
    }
  };
}

function makeCase(index, next, stockRatio) {
  const stock = (index % 100) < stockRatio;
  return stock ? makeStockCase(index, next) : makePortfolioCase(index, next);
}

async function writeRows(output, count, next, stockRatio) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const target = fs.createWriteStream(output, { flags: 'w' });
  const writer = output.endsWith('.gz') ? zlib.createGzip({ level: 9 }) : target;
  if (writer !== target) writer.pipe(target);

  for (let i = 0; i < count; i += 1) {
    const line = JSON.stringify(makeCase(i, next, stockRatio)) + '\n';
    if (!writer.write(line, 'utf8')) await once(writer, 'drain');
  }
  writer.end();
  await once(target, 'finish');
}

async function main() {
  const count = boundedInt(arg('count', '500'), 500, 1, 1000000);
  const seed = boundedInt(arg('seed', '20260803'), 20260803, 1, 2147483647);
  const stockRatio = boundedInt(arg('stock-ratio', '60'), 60, 0, 100);
  const output = path.resolve(arg('output', 'tmp/ai-eval-dataset.jsonl.gz'));
  const next = rng(seed);
  await writeRows(output, count, next, stockRatio);
  process.stdout.write(JSON.stringify({ success: true, count, seed, stock_ratio_pct: stockRatio, portfolio_ratio_pct: 100 - stockRatio, compression: output.endsWith('.gz') ? 'gzip' : 'none', output }) + '\n');
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { rng, idxRound, makeStockCase, makePortfolioCase, makeCase, writeRows };
