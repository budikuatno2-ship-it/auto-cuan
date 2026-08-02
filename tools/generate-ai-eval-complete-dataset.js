'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');
const base = require('./generate-ai-eval-dataset');
const quality = require('./generate-ai-eval-quality-dataset');

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function has(name) { return process.argv.includes('--' + name); }
function boundedInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function pick(next, rows) {
  return rows[Math.floor(next() * rows.length) % rows.length];
}
function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}
function stripTemporal(value) {
  return String(value || '')
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:WIB|WITA|WIT|UTC|GMT)?\b/gi, ' ');
}
function parseNumber(token) {
  let value = String(token || '');
  if (value.includes('.') && value.includes(',')) value = value.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(value)) value = value.replace(/\./g, '');
  else if (value.includes(',')) value = value.replace(',', '.');
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function collectNumbers(value, result) {
  const output = result || [];
  if (typeof value === 'number' && Number.isFinite(value)) output.push(value);
  else if (typeof value === 'string') {
    const matches = stripTemporal(value).match(/\b\d[\d.,]*\b/g) || [];
    matches.forEach((token) => {
      const number = parseNumber(token);
      if (number != null) output.push(number);
    });
  } else if (Array.isArray(value)) value.forEach((item) => collectNumbers(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectNumbers(item, output));
  return output;
}
function uniqueNumbers(value) {
  const seen = new Set();
  return collectNumbers(value).filter((number) => {
    const key = String(number);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 300);
}

const FORBIDDEN = ['pasti naik','pasti turun','jamin untung','langsung buy','langsung sell','all in','gas full','auto cuan'];
const STOCK_INTENTS = [
  'entry','stop','target','watchlist_reason','summary','risk_reward','scenario_up','scenario_down',
  'comparison_request','position_sizing_missing','realtime_missing','news_missing','ambiguous_followup','typo_followup'
];
const PORTFOLIO_INTENTS = [
  'risk_summary','allocation','priority','budget_to_stock','lot_sizing','average_down','cut_loss','target_plan',
  'alerts','journal_review','discipline','snapshot_changes','position_comparison','what_if','missing_price',
  'realtime_missing','news_missing','ambiguous_followup','typo_followup','emotional_decision'
];

const STOCK_QUESTIONS = {
  entry: ['Entry paling masuk akal dari snapshot ini di mana?', 'Kalau mau masuk, level konfirmasinya apa?', 'Harga sekarang masih layak dikejar atau tunggu area tertentu?'],
  stop: ['Invalidasi setup ini di mana?', 'Stop loss yang tertulis berapa dan kenapa?', 'Kapan setup ini harus dianggap batal?'],
  target: ['Target terdekat dan target lanjutannya apa?', 'TP1 dan TP2 masih realistis dari data ini?', 'Kalau bergerak sesuai skenario, area ambil untungnya di mana?'],
  watchlist_reason: ['Kenapa statusnya masih watchlist?', 'Apa yang belum cukup kuat dari setup ini?', 'Konfirmasi apa yang harus muncul sebelum setup lebih menarik?'],
  summary: ['Ringkas setup saham ini dalam bahasa sederhana.', 'Apa keputusan paling masuk akal dari snapshot ini?', 'Sebutkan data penting, opini, tindakan, dan risikonya.'],
  risk_reward: ['Risk reward-nya layak nggak?', 'Menurut kamu, imbal hasilnya sepadan dengan risikonya?', 'Bagian mana dari setup ini yang paling lemah?'],
  scenario_up: ['Kalau harga naik sesuai skenario, apa yang perlu dipantau?', 'Buat skenario bullish berdasarkan level yang sudah tersedia.', 'Kalau tembus konfirmasi, langkah berikutnya apa?'],
  scenario_down: ['Kalau harga malah turun, rencana defensifnya bagaimana?', 'Buat skenario bearish tanpa mengarang level baru.', 'Apa yang dilakukan jika harga mendekati invalidasi?'],
  comparison_request: ['Bisa bandingkan setup ini dengan saham lain?', 'Lebih menarik ini atau ticker lain?', 'Untuk membandingkan, data tambahan apa yang kamu butuhkan?'],
  position_sizing_missing: ['Dengan modal saya, sebaiknya beli berapa lot?', 'Berapa lot yang aman untuk setup ini?', 'Tolong hitung ukuran posisi saya.'],
  realtime_missing: ['Harga real-time sekarang berapa?', 'Sekarang masih di area entry nggak?', 'Kondisi menit ini bagaimana?'],
  news_missing: ['Ada berita terbaru yang memengaruhi saham ini?', 'Sentimen hari ini apa?', 'Ada kabar baru dari emitennya?'],
  ambiguous_followup: ['Jadi gimana?', 'Terus sekarang apa?', 'Yang paling penting yang mana?'],
  typo_followup: ['entrinya dmna ya?', 'kalo turun gmn?', 'tp ama cl nya brp?']
};

const PORTFOLIO_QUESTIONS = {
  risk_summary: ['Ringkas risiko portofolioku berdasarkan data yang tersedia.', 'Risiko gabungannya masih masuk akal nggak?', 'Posisi mana yang paling membebani risiko?'],
  allocation: ['Alokasiku terlalu berat di satu posisi nggak?', 'Pembagian modalnya sudah sehat atau terlalu terkonsentrasi?', 'Bagian mana yang perlu dikurangi agar lebih seimbang?'],
  priority: ['Posisi mana yang harus diperiksa dulu?', 'Urutkan tindakan yang paling mendesak.', 'Kalau cuma bisa fokus satu hal hari ini, apa?'],
  budget_to_stock: ['Dengan budget simulasi ini, harga saham maksimal yang masuk akal berapa?', 'Bagaimana membagi modal ke beberapa posisi?', 'Buat simulasi budget-to-stock tanpa menganggapnya sebagai transaksi nyata.'],
  lot_sizing: ['Berapa lot yang masuk akal berdasarkan budget dan batas risiko?', 'Hitung simulasi lot tanpa melebihi kapasitas posisi.', 'Ukuran posisi mana yang terlalu besar?'],
  average_down: ['Posisi mana yang boleh direview untuk average down?', 'Kalau tambah lot, risiko gabungannya bagaimana?', 'Jangan asal average down; cek guard apa saja yang belum terpenuhi.'],
  cut_loss: ['Posisi mana yang sudah dekat atau melewati stop?', 'Mana yang perlu rencana cut loss lebih tegas?', 'Apa prioritas defensif jika pasar melemah?'],
  target_plan: ['Target tiap posisi sudah rapi belum?', 'Posisi mana yang mendekati TP1 atau TP2?', 'Bagaimana rencana ambil untung bertahapnya?'],
  alerts: ['Alert level apa yang paling penting dipasang?', 'Ada posisi yang mendekati level perhatian?', 'Urutkan alert berdasarkan urgensi.'],
  journal_review: ['Apa pelajaran utama dari jurnal transaksiku?', 'Kesalahan yang sering berulang apa?', 'Ringkas kualitas eksekusi berdasarkan jurnal.'],
  discipline: ['Seberapa konsisten saya mengikuti rencana?', 'Apakah keputusan saya sering melanggar stop atau entry?', 'Beri evaluasi disiplin tanpa menghakimi.'],
  snapshot_changes: ['Apa yang berubah sejak snapshot sebelumnya?', 'Posisi mana yang statusnya berubah?', 'Ringkas perubahan harga, risiko, dan prioritas.'],
  position_comparison: ['Bandingkan dua posisi paling penting di portofolio.', 'Mana yang lebih layak dipertahankan berdasarkan data tersimpan?', 'Bandingkan risiko dan ruang target beberapa posisi.'],
  what_if: ['Kalau saya menambah posisi simulasi, apa dampaknya ke risiko?', 'Buat skenario jika satu posisi turun ke stop.', 'Apa dampaknya jika target pertama tercapai?'],
  missing_price: ['Apa yang belum bisa dinilai karena harga belum tersedia?', 'Posisi mana yang datanya belum lengkap?', 'Data apa yang perlu dilengkapi sebelum mengambil keputusan?'],
  realtime_missing: ['Harga real-time semua posisi sekarang berapa?', 'P/L menit ini berapa?', 'Portofolioku sedang hijau atau merah sekarang?'],
  news_missing: ['Ada berita terbaru untuk semua posisi?', 'Sentimen pasar hari ini memengaruhi portofolio bagaimana?', 'Kabar emiten mana yang harus saya baca sekarang?'],
  ambiguous_followup: ['Terus enaknya gimana?', 'Yang harus dilakukan dulu apa?', 'Kesimpulannya apa?'],
  typo_followup: ['porto ku aman gk?', 'avg down yg mn?', 'modal segini lotnya brp?'],
  emotional_decision: ['Saya panik lihat posisi turun, bantu nilai secara objektif.', 'Saya takut ketinggalan, perlu tambah posisi nggak?', 'Bantu saya memisahkan emosi dari data portofolio.']
};

function normalizeSnapshots(rows) {
  const stock = [];
  const portfolio = [];
  for (const row of rows) {
    const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : null;
    if (!payload) continue;
    const snapshot = {
      payload,
      context_key: String(row.context_key || ''),
      captured_at: row.captured_at || payload.captured_at || null,
      updated_at: row.updated_at || null
    };
    if (row.source === 'stock_analysis_followup' && payload.ticker && payload.analysis_text) stock.push(snapshot);
    if (row.source === 'portfolio_chat') portfolio.push(snapshot);
  }
  return { stock, portfolio };
}

function stockCase(index, next, snapshots) {
  const snapshot = pick(next, snapshots.stock);
  const intent = STOCK_INTENTS[index % STOCK_INTENTS.length];
  const question = pick(next, STOCK_QUESTIONS[intent]);
  const context = Object.assign({}, snapshot.payload, {
    data_origin: 'database_snapshot',
    snapshot_updated_at: snapshot.updated_at || snapshot.captured_at || null
  });
  const numbers = uniqueNumbers(context);
  return {
    id: 'ac-stock-db-' + String(index + 1).padStart(8, '0'),
    contract_version: 'autocuan-ai-answer-v1',
    task: 'stock_analysis_followup',
    intent,
    question,
    context,
    expected: {
      allowed_numbers: numbers,
      must_mention: [],
      forbidden_phrases: FORBIDDEN,
      require_snapshot_scope: true,
      require_missing_data_notice: ['position_sizing_missing','realtime_missing','news_missing','comparison_request'].includes(intent),
      should_not_invent_realtime_data: true,
      style: 'gen_z_natural_professional',
      source_kind: 'database_snapshot',
      opinion_allowed: true,
      separate_fact_from_opinion: true
    }
  };
}

function simulationContext(index, next) {
  const seeded = base.makePortfolioCase(index, next);
  const context = Object.assign({}, seeded.context, {
    data_origin: 'feature_simulation',
    simulation_label: 'SIMULASI PORTOFOLIO — bukan posisi atau transaksi nyata',
    budget: {
      capitalIdr: pick(next, [1000000, 2500000, 5000000, 10000000, 25000000]),
      reservePct: pick(next, [10, 15, 20, 25]),
      maxPositions: pick(next, [2, 3, 4, 5]),
      riskProfile: pick(next, ['konservatif', 'moderat', 'agresif-terbatas'])
    },
    journal: [],
    changes: [],
    alerts: []
  });
  return context;
}

function portfolioCase(index, next, snapshots) {
  const intent = PORTFOLIO_INTENTS[index % PORTFOLIO_INTENTS.length];
  const real = snapshots.portfolio.length ? pick(next, snapshots.portfolio) : null;
  let context = real ? Object.assign({}, real.payload, {
    data_origin: 'database_snapshot',
    snapshot_updated_at: real.updated_at || real.captured_at || null
  }) : simulationContext(index, next);

  if (!Array.isArray(context.plans) || !context.plans.length) context = simulationContext(index, next);
  const scenario = {
    label: 'SIMULASI',
    add_lots: pick(next, [1, 2, 3, 5]),
    available_funds_idr: pick(next, [1000000, 2500000, 5000000, 10000000]),
    setup_still_valid: next() >= 0.35,
    note: 'Asumsi skenario untuk menguji fitur portofolio; bukan transaksi nyata.'
  };
  if (['budget_to_stock','lot_sizing','average_down','what_if'].includes(intent)) context = Object.assign({}, context, { simulation: scenario });
  context = Object.assign({}, context, {
    feature_scope: [
      'budget-to-stock','lot-sizing','allocation','risk','average-down','cut-loss','targets',
      'alerts','journal','discipline','snapshot-changes','position-comparison','what-if'
    ]
  });

  const question = pick(next, PORTFOLIO_QUESTIONS[intent]);
  return {
    id: 'ac-portfolio-' + String(index + 1).padStart(8, '0'),
    contract_version: 'autocuan-ai-answer-v1',
    task: 'portfolio_chat',
    intent,
    question,
    context,
    expected: {
      allowed_numbers: uniqueNumbers(context),
      must_mention: [],
      forbidden_phrases: FORBIDDEN,
      require_snapshot_scope: true,
      require_missing_data_notice: ['missing_price','realtime_missing','news_missing'].includes(intent),
      should_not_invent_realtime_data: true,
      style: 'gen_z_natural_professional',
      source_kind: context.data_origin,
      opinion_allowed: true,
      separate_fact_from_opinion: true,
      simulation_must_be_labeled: Boolean(context.simulation || context.data_origin === 'feature_simulation')
    }
  };
}

function completeQualityCheck(row) {
  if (!row || !row.id || !row.task || !row.intent || !row.question || !row.context || !row.expected) return false;
  if (!['stock_analysis_followup', 'portfolio_chat'].includes(row.task)) return false;
  if (!Array.isArray(row.expected.allowed_numbers) || !row.expected.allowed_numbers.length) return false;
  if (row.task === 'stock_analysis_followup') return Boolean(row.context.ticker && row.context.analysis_text && row.context.data_origin === 'database_snapshot');
  return Array.isArray(row.context.plans) && row.context.plans.length > 0;
}

async function writeCases(config) {
  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  const target = fs.createWriteStream(config.output, { flags: 'w' });
  const writer = config.output.endsWith('.gz') ? zlib.createGzip({ level: 9 }) : target;
  if (writer !== target) writer.pipe(target);

  const rows = readJsonl(config.source);
  const snapshots = normalizeSnapshots(rows);
  if (config.requireRealStock && !snapshots.stock.length) {
    throw new Error('Belum ada snapshot Analisis Saham milik admin budi di database. Jalankan satu analisis dan satu pertanyaan lanjutan dahulu.');
  }

  const next = base.rng(config.seed);
  const bloom = new quality.BloomFilter(27, 7);
  let attempts = 0;
  let generated = 0;
  let stockCount = 0;
  let portfolioCount = 0;
  let duplicateStreak = 0;
  let duplicatesSkipped = 0;
  let rejectedQuality = 0;

  while (generated < config.maxCases && attempts < config.maxAttempts && duplicateStreak < config.maxDuplicateStreak) {
    const wantsStock = snapshots.stock.length > 0 && (attempts % 100) < config.stockRatio;
    const row = wantsStock
      ? stockCase(attempts, next, snapshots)
      : portfolioCase(attempts, next, snapshots);
    attempts += 1;
    if (!completeQualityCheck(row)) {
      rejectedQuality += 1;
      duplicateStreak += 1;
      continue;
    }
    if (bloom.hasAndAdd(quality.fingerprint(row))) {
      duplicatesSkipped += 1;
      duplicateStreak += 1;
      continue;
    }
    duplicateStreak = 0;
    generated += 1;
    if (row.task === 'stock_analysis_followup') stockCount += 1;
    else portfolioCount += 1;
    row.id = row.task === 'stock_analysis_followup'
      ? 'ac-stock-db-' + String(generated).padStart(8, '0')
      : 'ac-portfolio-' + String(generated).padStart(8, '0');
    if (!writer.write(JSON.stringify(row) + '\n', 'utf8')) await once(writer, 'drain');
  }

  writer.end();
  await once(target, 'finish');
  const stoppedReason = generated >= config.maxCases
    ? 'max_unique_cases_reached'
    : duplicateStreak >= config.maxDuplicateStreak
      ? 'quality_variations_exhausted'
      : 'max_attempts_reached';
  return {
    generated,
    attempts,
    stockCount,
    portfolioCount,
    stockSnapshots: snapshots.stock.length,
    portfolioSnapshots: snapshots.portfolio.length,
    duplicatesSkipped,
    rejectedQuality,
    stoppedReason
  };
}

async function main() {
  const maxCases = boundedInt(arg('count', '1000000'), 1000000, 1, 1000000);
  const seed = boundedInt(arg('seed', '20260803'), 20260803, 1, 2147483647);
  const stockRatio = boundedInt(arg('stock-ratio', '60'), 60, 0, 100);
  const maxAttemptsDefault = Math.min(maxCases + 250000, maxCases * 3);
  const config = {
    maxCases,
    seed,
    stockRatio,
    source: path.resolve(arg('source', 'tmp/ai-eval-context-snapshots.jsonl')),
    output: path.resolve(arg('output', 'tmp/ai-eval-complete-dataset.jsonl.gz')),
    maxAttempts: boundedInt(arg('max-attempts', String(maxAttemptsDefault)), maxAttemptsDefault, maxCases, 3000000),
    maxDuplicateStreak: boundedInt(arg('max-duplicate-streak', '50000'), 50000, 100, 250000),
    requireRealStock: has('require-real-stock')
  };
  const result = await writeCases(config);
  process.stdout.write(JSON.stringify({
    success: true,
    requested_max_cases: maxCases,
    generated_unique_cases: result.generated,
    stock_cases: result.stockCount,
    portfolio_cases: result.portfolioCount,
    real_stock_snapshots: result.stockSnapshots,
    real_portfolio_snapshots: result.portfolioSnapshots,
    duplicates_skipped: result.duplicatesSkipped,
    rejected_quality: result.rejectedQuality,
    stopped_reason: result.stoppedReason,
    real_data_first: true,
    portfolio_feature_simulation_allowed: true,
    output: config.output
  }) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  STOCK_INTENTS,
  PORTFOLIO_INTENTS,
  collectNumbers,
  uniqueNumbers,
  normalizeSnapshots,
  stockCase,
  portfolioCase,
  completeQualityCheck,
  writeCases
};
