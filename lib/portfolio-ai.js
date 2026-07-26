'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession, isSameOrigin } = require('./admin-session');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;
const buckets = new Map();

function rateAllowed(key) {
  const now = Date.now();
  const current = buckets.get(key) || [];
  const active = current.filter((stamp) => now - stamp < WINDOW_MS);
  if (active.length >= MAX_REQUESTS) {
    buckets.set(key, active);
    return false;
  }
  active.push(now);
  buckets.set(key, active);
  return true;
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max);
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sanitizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const ticker = cleanText(plan.ticker, 8).toUpperCase().replace(/\.JK$/i, '');
  if (!/^[A-Z]{3,5}$/.test(ticker)) return null;
  return {
    ticker,
    entry: safeNumber(plan.entryPriceIdr != null ? plan.entryPriceIdr : plan.entry),
    stop_loss: safeNumber(plan.stopLossIdr != null ? plan.stopLossIdr : plan.stop),
    tp1: safeNumber(plan.tp1Idr != null ? plan.tp1Idr : plan.tp1),
    tp2: safeNumber(plan.tp2Idr != null ? plan.tp2Idr : plan.tp2),
    lots: safeNumber(plan.lots),
    estimated_max_loss: safeNumber(plan.estimatedMaxLossIdr != null ? plan.estimatedMaxLossIdr : plan.riskBudgetIdr),
    capital: safeNumber(plan.capitalIdr),
    created_at: safeNumber(plan.createdAt)
  };
}

function sanitizeContext(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const plans = (Array.isArray(input.plans) ? input.plans : []).slice(0, 30).map(sanitizePlan).filter(Boolean);
  const prices = {};
  const sourcePrices = input.prices && typeof input.prices === 'object' ? input.prices : {};
  Object.keys(sourcePrices).slice(0, 50).forEach((key) => {
    const ticker = cleanText(key, 8).toUpperCase().replace(/\.JK$/i, '');
    const price = safeNumber(sourcePrices[key]);
    if (/^[A-Z]{3,5}$/.test(ticker) && price != null && price > 0) prices[ticker] = price;
  });
  const summary = input.summary && typeof input.summary === 'object' ? {
    plan_count: safeNumber(input.summary.plan_count),
    positions_with_price: safeNumber(input.summary.positions_with_price),
    positions_missing_price: safeNumber(input.summary.positions_missing_price),
    total_estimated_risk: safeNumber(input.summary.total_estimated_risk),
    total_position_value: safeNumber(input.summary.total_position_value)
  } : null;
  return { plans, prices, summary, data_note: 'Harga pada konteks berasal dari data yang tersimpan/diisi pengguna dan tidak boleh dianggap real-time tanpa bukti waktu.' };
}

function sanitizeHistory(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-8).map((item) => {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) return null;
    const content = cleanText(item.content, 1200);
    return content ? { role: item.role, content } : null;
  }).filter(Boolean);
}

function extractReply(data) {
  if (!data || typeof data !== 'object') return '';
  const choice = data.choices && data.choices[0];
  const message = choice && choice.message;
  if (message && typeof message.content === 'string') return message.content.trim();
  if (message && Array.isArray(message.content)) {
    return message.content.map((part) => part && (part.text || part.content) || '').join('').trim();
  }
  if (choice && typeof choice.text === 'string') return choice.text.trim();
  if (typeof data.output_text === 'string') return data.output_text.trim();
  if (Array.isArray(data.output)) {
    return data.output.map((item) => {
      if (!item) return '';
      if (typeof item.text === 'string') return item.text;
      if (Array.isArray(item.content)) return item.content.map((part) => part && part.text || '').join('');
      return '';
    }).join('').trim();
  }
  return '';
}

async function verifyApprovedUser(req) {
  if (!isSameOrigin(req)) return { ok: false, status: 403, error: 'Permintaan ditolak.' };
  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return auth;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, status: 503, error: 'Status akses belum tersedia.' };

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await supabase.from('app_users')
    .select('id,username,is_approved,is_blocked')
    .eq('id', auth.session.uid)
    .maybeSingle();

  if (result.error || !result.data) return { ok: false, status: 401, error: 'Sesi tidak valid.' };
  const account = result.data;
  if (String(account.username || '').trim().toLowerCase() !== String(auth.session.un || '').trim().toLowerCase()) {
    return { ok: false, status: 401, error: 'Sesi tidak valid.' };
  }
  if (account.is_blocked === true) return { ok: false, status: 403, error: 'Akun sedang diblokir.' };
  if (account.is_approved !== true) return { ok: false, status: 403, error: 'Akun belum di-approve admin.' };
  return { ok: true, account };
}

module.exports = async function handlePortfolioAI(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
    const access = await verifyApprovedUser(req);
    if (!access.ok) return res.status(access.status || 403).json({ success: false, error: access.error });
    if (!rateAllowed(String(access.account.id))) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak pertanyaan. Tunggu sebentar lalu coba lagi.' });
    }

    const message = cleanText(req.body && req.body.chatMessage, 2500);
    if (!message) return res.status(400).json({ success: false, error: 'Pertanyaan belum diisi.' });

    const apiKey = process.env.PORTFOLIO_AI_API_KEY;
    const baseUrl = String(process.env.PORTFOLIO_AI_BASE_URL || 'https://api.codecrafters.id/v1').replace(/\/+$/, '');
    const model = process.env.PORTFOLIO_AI_MODEL || 'deepseek-v4-flash';
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        code: 'PORTFOLIO_AI_NOT_CONFIGURED',
        error: 'Asisten AI Portofolio belum aktif. Admin perlu memasang PORTFOLIO_AI_API_KEY di server.'
      });
    }

    const context = sanitizeContext(req.body && req.body.context);
    const history = sanitizeHistory(req.body && req.body.history);
    const systemPrompt = [
      'Anda adalah Asisten AI Portofolio Auto-Cuan berbahasa Indonesia.',
      'Anda boleh membantu analisis portofolio, konsultasi pengambilan keputusan, penjelasan risiko, perencanaan, dan percakapan suportif ketika pengguna sedang cemas atau ingin bercerita.',
      'Bedakan dengan jelas: (1) fakta dari data yang diberikan, (2) analisis atau inferensi logis, dan (3) saran umum.',
      'Jangan mengarang harga, berita, kondisi pasar, transaksi, atau data real-time. Bila data tidak tersedia atau sudah lama, katakan secara eksplisit.',
      'Jangan menjanjikan keuntungan, jangan memerintah BUY/SELL secara mutlak, dan jangan membuat order. Tekankan konfirmasi manual dan batas risiko.',
      'Untuk curhat, jawab dengan empati dan masuk akal tanpa berpura-pura menjadi psikolog atau dokter. Jangan menghakimi.',
      'Utamakan jawaban praktis, ringkas, dan sesuai konteks pengguna. Gunakan angka dari data bila tersedia.',
      'Konteks portofolio berikut berasal dari browser pengguna:',
      JSON.stringify(context)
    ].join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    let response;
    try {
      response = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }].concat(history, [{ role: 'user', content: message }]),
          temperature: 0.35,
          max_tokens: 1000
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      console.error('portfolio-ai provider error', response.status);
      return res.status(502).json({ success: false, error: 'Asisten AI sedang tidak tersedia. Coba lagi beberapa saat.' });
    }
    const data = await response.json();
    const reply = cleanText(extractReply(data), 8000);
    if (!reply) return res.status(502).json({ success: false, error: 'Asisten AI belum menghasilkan jawaban. Coba ulang dengan pertanyaan yang lebih spesifik.' });

    return res.status(200).json({ success: true, reply, grounded: true, portfolio_data_used: context.plans.length > 0 });
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    console.error('portfolio-ai exception', timedOut ? 'timeout' : (error && error.message));
    return res.status(timedOut ? 504 : 500).json({ success: false, error: timedOut ? 'Asisten AI terlalu lama merespons. Coba lagi.' : 'Asisten AI mengalami gangguan.' });
  }
};
