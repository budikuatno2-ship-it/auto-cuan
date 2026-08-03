'use strict';

const handleContextAI = require('../lib/context-ai-router-v6');
const legacyAnalyze = require('../lib/analyze-legacy');
const { hydrateContext } = require('../lib/ai-context-snapshot-store');
const { prepareRuntimeGrounding } = require('../lib/ai-runtime-grounding');

function styleInstruction(source) {
  const focus = source === 'stock_analysis_followup'
    ? [
        'Fokus hanya pada ticker dan snapshot Analisis Saham yang sedang dibahas.',
        'Boleh menilai entry, konfirmasi, invalidasi, stop loss, target, risk/reward, skenario naik/turun, serta kelemahan setup.',
        'Jangan berubah menjadi penilaian seluruh portofolio dan jangan membuat angka baru.'
      ]
    : [
        'Fokus pada Asisten AI Portofolio dan seluruh fitur portofolio:',
        'budget-to-stock, kemampuan membeli lot, ukuran posisi, alokasi, risiko gabungan, prioritas posisi, average down, cut loss, target, alert, jurnal, disiplin, perubahan snapshot, perbandingan posisi, dan simulasi what-if.',
        'Jangan menganalisis satu saham dari nol; gunakan posisi, rencana, harga, dan skenario yang tersedia pada konteks.'
      ];
  return [
    'Aturan jawaban wajib:',
    ...focus,
    'Gunakan bahasa Indonesia yang natural, tenang, ringkas, dan enak dibaca; gunakan kata “kamu”.',
    'Mulai dengan jawaban langsung. Setelah itu pisahkan secara jelas: fakta/data yang dipakai, analisis atau opini, tindakan praktis, risiko/invalidation, dan data yang masih kurang.',
    'Opini diperbolehkan dan harus berguna, tetapi jangan menyamarkan opini sebagai fakta atau kepastian.',
    'Simulasi diperbolehkan untuk budget, lot, average down, perubahan posisi, dan skenario what-if. Semua asumsi simulasi wajib diberi label SIMULASI dan tidak boleh disebut sebagai transaksi nyata.',
    'Jangan mengarang harga, level, indikator, berita, posisi, transaksi, probabilitas, atau kondisi real-time.',
    'Bila pertanyaan membutuhkan berita terbaru, harga real-time, atau data luar yang tidak ada pada konteks, katakan terus terang bahwa sumber terbaru belum tersedia.',
    'Jangan memakai bestie, bro, cuy, lo, lu, gue, bahasa influencer, analogi dramatis, janji keuntungan, atau perintah BUY/SELL mutlak.',
    'Pertanyaan typo, pendek, ambigu, atau lanjutan harus dipahami dari konteks dan riwayat; bila tetap ambigu, jelaskan asumsi yang dipakai.',
    'Jawab pertanyaan sederhana sekitar 80–180 kata dan analisis kompleks sekitar 180–350 kata. Hindari pengulangan dan tabel Markdown.',
    'Beri satu sampai tiga langkah praktis, lalu berhenti.'
  ].join(' ');
}

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function transientSimulation(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const availableFunds = finite(input.available_funds_idr != null ? input.available_funds_idr : input.availableFundsIdr);
  const addLots = finite(input.add_lots != null ? input.add_lots : input.addLots);
  const output = {
    label: String(input.label || 'SIMULASI').slice(0, 40),
    available_funds_idr: availableFunds != null && availableFunds > 0 ? availableFunds : null,
    add_lots: addLots != null && addLots > 0 ? addLots : null,
    setup_still_valid: typeof input.setup_still_valid === 'boolean'
      ? input.setup_still_valid
      : (typeof input.setupStillValid === 'boolean' ? input.setupStillValid : null)
  };
  return Object.values(output).some((value) => value !== null && value !== '') ? output : null;
}

async function prepareContextRequest(req) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  const source = body.source;
  let context = await hydrateContext(req, source, body.context);
  if (source === 'portfolio_chat') {
    const simulation = transientSimulation(body.context && body.context.simulation);
    if (simulation) context = Object.assign({}, context, { simulation });
  }
  context = prepareRuntimeGrounding(source, body.chatMessage, context);
  const history = Array.isArray(body.history) ? body.history.slice(-3) : [];
  history.push({ role: 'user', content: styleInstruction(source) });
  req.body = Object.assign({}, body, { context, history });
  return req;
}

module.exports = async function handler(req, res) {
  const source = req && req.method === 'POST' && req.body && req.body.source;
  if (source === 'portfolio_chat' || source === 'stock_analysis_followup') {
    return handleContextAI(await prepareContextRequest(req), res);
  }
  return legacyAnalyze(req, res);
};
