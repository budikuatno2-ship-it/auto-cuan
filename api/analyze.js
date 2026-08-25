'use strict';

const { createClient } = require('@supabase/supabase-js');
const handleContextAI = require('../lib/context-ai-router-v7');
const legacyAnalyze = require('../lib/analyze-legacy');
const { hydrateContext } = require('../lib/ai-context-snapshot-store');
const { prepareRuntimeGrounding } = require('../lib/ai-runtime-grounding-v2');
const { requirePremiumEntitlement } = require('../lib/subscription-auth');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function requireAnalyzeAccess(req, res) {
  const db = getSupabase();
  if (!db) {
    res.status(503).json({ success:false, code:'PREMIUM_ACCESS_UNAVAILABLE', error:'Status subscription belum tersedia.' });
    return false;
  }

  let access;
  try { access = await requirePremiumEntitlement(req, db); }
  catch (_) {
    res.status(503).json({ success:false, code:'PREMIUM_ACCESS_UNAVAILABLE', error:'Status subscription belum tersedia.' });
    return false;
  }

  if (!access.ok) {
    res.status(access.status || 403).json({
      success:false,
      code:access.code || 'PREMIUM_ACCESS_DENIED',
      error:access.error || 'Akses premium diperlukan.',
      access_level:access.access_level || 'free'
    });
    return false;
  }
  return true;
}

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
  const history = Array.isArray(body.history) ? body.history.slice(-4) : [];
  req.body = Object.assign({}, body, { context, history, styleRules: styleInstruction(source) });
  return req;
}

module.exports = async function handler(req, res) {
  try {
    if (req && req.method === 'POST') {
      const allowed = await requireAnalyzeAccess(req, res);
      if (!allowed) return;
    }

    const source = req && req.method === 'POST' && req.body && req.body.source;
    if (source === 'portfolio_chat' || source === 'stock_analysis_followup') {
      return await handleContextAI(await prepareContextRequest(req), res);
    }
    return await legacyAnalyze(req, res);
  } catch (err) {
    console.error('analyze handler error:', err);
    return res.status(500).json({ success: false, error: 'Terjadi kesalahan server saat memproses analisis.' });
  }
};

module.exports.__test = {
  getSupabase,
  requireAnalyzeAccess,
  transientSimulation,
  styleInstruction
};
