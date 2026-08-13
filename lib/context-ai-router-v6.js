'use strict';

/**
 * Context AI Router V6
 *
 * Keeps the provider routing, health checks, rate limits, token protection, cache,
 * and access verification owned by V5/V4. This wrapper only adds a deterministic
 * fallback for stock-analysis follow-up questions when every configured provider
 * is temporarily unavailable.
 *
 * The fallback never fetches market data and never invents a level. It may only
 * quote values already present in the analysis snapshot sent by the browser.
 */

const handleContextAIV5 = require('./context-ai-router-v5');

const FALLBACK_CODES = new Set([
  'AI_MODELS_FAILED_SAFE_STOP',
  'AI_ALL_MODELS_TIMED_OUT',
  'AI_RECENT_FAILURE',
  'AI_TIMEOUT_NO_RETRY',
  'AI_REQUEST_ERROR'
]);

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .trim()
    .slice(0, max || 12000);
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function normalizeText(value) {
  return clean(value, 12000)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return clean(match[1], 80);
  }
  return '';
}

function firstLine(text, labels) {
  const lines = normalizeText(text).split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (labels.some((label) => lower.includes(label))) return clean(line, 220);
  }
  return '';
}

function extractSnapshotFacts(raw) {
  const text = normalizeText(raw);
  const priceToken = '([0-9][0-9.,]*(?:\\s*[–-]\\s*[0-9][0-9.,]*)?)';
  const make = (label) => new RegExp(label + '\\s*(?::|=)?\\s*' + priceToken, 'i');

  return {
    text,
    last: firstMatch(text, [
      make('harga\\s+terakhir'), make('last(?:\\s+price)?'), make('close')
    ]),
    entry: firstMatch(text, [
      make('entry\\s*\\/\\s*konfirmasi'), make('area\\s+entry'), make('entry\\s+zone'), make('entry\\s*1?'), make('konfirmasi')
    ]),
    entry2: firstMatch(text, [make('entry\\s*2'), make('e2')]),
    stop: firstMatch(text, [
      make('stop\\s*loss\\s*\\/\\s*invalidasi'), make('stop\\s*loss'), make('invalidasi'), make('batas\\s+invalidasi')
    ]),
    tp1: firstMatch(text, [make('target\\s*(?:naik|turun)?\\s*1'), make('tp\\s*1'), make('target\\s+1')]),
    tp2: firstMatch(text, [make('target\\s*(?:naik|turun)?\\s*2'), make('tp\\s*2'), make('target\\s+2')]),
    action: firstLine(text, ['action', 'tindakan', 'watchlist', 'hindari', 'avoid', 'wait pullback', 'swing ready']),
    bias: firstLine(text, ['bias', 'bullish', 'bearish', 'neutral']),
    confirmation: firstLine(text, ['konfirmasi']),
    invalidation: firstLine(text, ['invalidasi', 'setup batal']),
    reason: firstLine(text, ['alasan risk/action', 'alasan', 'status reason'])
  };
}

function joinLevels(facts) {
  const parts = [];
  if (facts.entry) parts.push('entry/konfirmasi ' + facts.entry);
  if (facts.entry2 && facts.entry2 !== facts.entry) parts.push('entry kedua ' + facts.entry2);
  if (facts.stop) parts.push('invalidasi ' + facts.stop);
  if (facts.tp1) parts.push('TP1 ' + facts.tp1);
  if (facts.tp2) parts.push('TP2 ' + facts.tp2);
  return parts;
}

function buildLocalStockReply(question, context) {
  const message = clean(question, 2500);
  const ctx = context && typeof context === 'object' ? context : {};
  const ticker = clean(ctx.ticker, 10).toUpperCase().replace(/\.JK$/i, '');
  const facts = extractSnapshotFacts(ctx.analysis_text || ctx.analysisText || '');
  const q = message.toLowerCase();
  const prefix = ticker ? ticker + ': ' : '';
  const sourceNote = 'Jawaban ini memakai snapshot analisis yang sedang terbuka, bukan harga real-time.';

  let lead = '';
  let detail = '';

  if (/entry|masuk|beli|harga berapa|area beli/.test(q)) {
    if (facts.entry) {
      lead = prefix + 'area entry/konfirmasi yang tercatat adalah ' + facts.entry + '.';
      detail = 'Tunggu harga berada di area tersebut atau memenuhi konfirmasi yang tertulis; jangan mengejar harga bila sudah jauh di atasnya.';
      if (facts.stop) detail += ' Batas invalidasinya ' + facts.stop + '.';
    } else {
      lead = prefix + 'snapshot ini belum memuat level entry yang cukup jelas.';
      detail = facts.confirmation || 'Gunakan level konfirmasi pada hasil analisis dan cek chart sebelum mengambil posisi.';
    }
  } else if (/stop|cut loss|cl\b|invalidasi|batal/.test(q)) {
    if (facts.stop) {
      lead = prefix + 'batas stop loss/invalidasi yang tercatat adalah ' + facts.stop + '.';
      detail = facts.invalidation || 'Setup tidak lagi valid bila harga menembus batas tersebut sesuai syarat pada analisis.';
    } else {
      lead = prefix + 'snapshot ini belum memuat batas invalidasi yang dapat dikutip dengan aman.';
      detail = 'Jangan menetapkan cut loss dari tebakan; buka kembali bagian invalidasi atau jalankan analisis ulang.';
    }
  } else if (/target|tp\b|take profit|jual di mana/.test(q)) {
    const targets = [facts.tp1 && 'TP1 ' + facts.tp1, facts.tp2 && 'TP2 ' + facts.tp2].filter(Boolean);
    if (targets.length) {
      lead = prefix + 'target yang tercatat: ' + targets.join(' dan ') + '.';
      detail = facts.stop ? 'Tetap gunakan invalidasi ' + facts.stop + '; target tidak berlaku bila setup sudah batal.' : 'Pastikan setup masih valid sebelum memakai target tersebut.';
    } else {
      lead = prefix + 'snapshot ini belum memuat target harga yang dapat dikutip dengan aman.';
      detail = 'Jalankan analisis ulang atau lihat bagian target pada kartu analisis.';
    }
  } else if (/kenapa|alasan|watchlist|action|tindakan|layak/.test(q)) {
    lead = prefix + (facts.action || facts.bias || 'status pada snapshot perlu dibaca bersama konfirmasi dan invalidasinya.');
    detail = facts.reason || facts.confirmation || facts.invalidation || 'Gunakan hanya alasan yang tertulis pada hasil analisis; data yang tidak ada tidak boleh diasumsikan.';
  } else {
    const levels = joinLevels(facts);
    lead = prefix + (facts.action || facts.bias || 'snapshot analisis tersedia.');
    detail = levels.length ? 'Level yang tercatat: ' + levels.join(', ') + '.' : 'Tidak ada level numerik yang cukup jelas untuk diringkas tanpa mengarang.';
  }

  const captured = clean(ctx.captured_at, 60);
  const timeNote = captured ? ' Snapshot: ' + captured + '.' : '';
  return [lead, detail, sourceNote + timeNote].filter(Boolean).join(' ');
}

function captureResponse() {
  const state = { statusCode: 200, payload: null, ended: false };
  const response = {
    status(code) { state.statusCode = Number(code) || 200; return response; },
    json(payload) { state.payload = payload; state.ended = true; return response; },
    send(payload) { state.payload = payload; state.ended = true; return response; },
    end(payload) { if (payload !== undefined) state.payload = payload; state.ended = true; return response; },
    setHeader() { return response; },
    getHeader() { return undefined; }
  };
  return { state, response };
}

function shouldUseLocalFallback(req, statusCode, payload) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  if (body.source !== 'stock_analysis_followup') return false;
  const context = body.context && typeof body.context === 'object' ? body.context : {};
  if (!clean(context.ticker, 10) || !clean(context.analysis_text || context.analysisText, 12000)) return false;
  if (Number(statusCode) < 500) return false;
  const code = payload && payload.code;
  return !code || FALLBACK_CODES.has(code);
}

async function handleContextAIV6(req, res) {
  const captured = captureResponse();
  await handleContextAIV5(req, captured.response);

  const payload = captured.state.payload && typeof captured.state.payload === 'object'
    ? captured.state.payload
    : { success: false, error: clean(captured.state.payload, 300) || 'Asisten AI belum tersedia.' };

  if (!shouldUseLocalFallback(req, captured.state.statusCode, payload)) {
    return res.status(captured.state.statusCode || 500).json(payload);
  }

  const body = req.body || {};
  const reply = buildLocalStockReply(body.chatMessage, body.context);
  return res.status(200).json({
    success: true,
    reply,
    model_used: 'local-stock-snapshot-v1',
    fallback_count: Number(payload.attempted_count) || 0,
    attempted_count: Number(payload.attempted_count) || 0,
    task_type: 'local-stock-followup',
    stock_analysis_used: true,
    local_fallback: true,
    provider_unavailable: true,
    provider_code: payload.code || null,
    token_saved: true
  });
}

handleContextAIV6._test = {
  normalizeText,
  extractSnapshotFacts,
  buildLocalStockReply,
  shouldUseLocalFallback
};

module.exports = handleContextAIV6;
