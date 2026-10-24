'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAdminSession, isSameOrigin } = require('../lib/admin-session');

// Forbidden promotional/promise words (HANDOFF §5d)
const FORBIDDEN_WORDS = [
  'pasti',
  'dijamin',
  'jaminan',
  'wajib beli',
  'harus beli',
  'tanpa risiko',
  'anti rugi',
  '100%',
  'all in',
  'hajar'
];

// In-memory store for development/preview/test when Supabase is not configured
let _mockNotes = [
  {
    id: 'note-brpt-001',
    ticker: 'BRPT',
    style: 'daytrade',
    reason: 'Volume 2,8× rata-rata 20 hari, tiga broker besar akumulasi 4 hari beruntun. Menembus resisten 1.020 dengan momentum kuat.',
    zone_lo: 1020,
    zone_hi: 1050,
    target: 1150,
    risk_limit: 980,
    valid_days: 2,
    status: 'Di area pantau',
    published_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    entered_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    closed_at: null,
    close_price: null,
    close_reason: null,
    result_pct: null,
    author_id: 'budi',
    edits: [
      {
        id: 'edit-brpt-1',
        edited_at: new Date(Date.now() - 3600 * 1000).toISOString(),
        editor_id: 'budi',
        diff: { target: { from: 1120, to: 1150 } },
        edit_reason: 'Target dinaikkan dari 1.120 ke 1.150 karena breakout volume besar.'
      }
    ]
  },
  {
    id: 'note-ptro-002',
    ticker: 'PTRO',
    style: 'swing',
    reason: 'Akumulasi asing beruntun 5 hari di area support MA50. Valuasi menarik dibanding peers di sektor kontraktor tambang.',
    zone_lo: 13800,
    zone_hi: 14200,
    target: 15800,
    risk_limit: 13200,
    valid_days: 10,
    status: 'Di area pantau',
    published_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    expires_at: new Date(Date.now() + 9 * 24 * 3600 * 1000).toISOString(),
    entered_at: new Date(Date.now() - 20 * 3600 * 1000).toISOString(),
    closed_at: null,
    close_price: null,
    close_reason: null,
    result_pct: null,
    author_id: 'budi',
    edits: []
  },
  {
    id: 'note-medc-003',
    ticker: 'MEDC',
    style: 'swing',
    reason: 'Sentimen kenaikan harga minyak WTI dan pembentukan pola base konsolidasi 3 minggu. Menunggu konfirmasi volume.',
    zone_lo: 1390,
    zone_hi: 1430,
    target: 1580,
    risk_limit: 1330,
    valid_days: 5,
    status: 'Menunggu harga turun ke area',
    published_at: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
    expires_at: new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString(),
    entered_at: null,
    closed_at: null,
    close_price: null,
    close_reason: null,
    result_pct: null,
    author_id: 'budi',
    edits: []
  },
  // History sample notes
  {
    id: 'note-bren-hist-1',
    ticker: 'BREN',
    style: 'swing',
    reason: 'Pelepasan tekanan jual dan pantulan teknikal dari Fibonacci 61.8%.',
    zone_lo: 6400,
    zone_hi: 6600,
    target: 7200,
    risk_limit: 6150,
    valid_days: 10,
    status: 'Kena target',
    published_at: '2026-10-01T08:30:00Z',
    expires_at: '2026-10-15T09:00:00Z',
    entered_at: '2026-10-01T09:15:00Z',
    closed_at: '2026-10-06T15:00:00Z',
    close_price: 7200,
    close_reason: 'Target tercapai',
    result_pct: 10.77,
    author_id: 'budi',
    edits: []
  },
  {
    id: 'note-cuan-hist-2',
    ticker: 'CUAN',
    style: 'daytrade',
    reason: 'Momentum breakout intraday dengan volume spike di pembukaan sesi 1.',
    zone_lo: 6850,
    zone_hi: 7000,
    target: 7500,
    risk_limit: 6650,
    valid_days: 2,
    status: 'Kena batas risiko',
    published_at: '2026-10-05T09:05:00Z',
    expires_at: '2026-10-07T09:00:00Z',
    entered_at: '2026-10-05T09:10:00Z',
    closed_at: '2026-10-05T14:30:00Z',
    close_price: 6650,
    close_reason: 'Batas risiko tersentuh',
    result_pct: -3.97,
    author_id: 'budi',
    edits: []
  },
  {
    id: 'note-bbca-hist-3',
    ticker: 'BBCA',
    style: 'swing',
    reason: 'Rebound dari area akumulasi foreign flow 10 hari.',
    zone_lo: 10050,
    zone_hi: 10150,
    target: 10600,
    risk_limit: 9800,
    valid_days: 20,
    status: 'Ditutup admin',
    published_at: '2026-09-20T08:45:00Z',
    expires_at: '2026-10-18T09:00:00Z',
    entered_at: '2026-09-20T09:30:00Z',
    closed_at: '2026-10-02T11:00:00Z',
    close_price: 10400,
    close_reason: 'Ambil profit sebelum rilis kinerja kuartalan.',
    result_pct: 2.97,
    author_id: 'budi',
    edits: []
  }
];

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// BEI tick size logic
function getTickSize(p) {
  if (p < 200) return 1;
  if (p < 500) return 2;
  if (p < 2000) return 5;
  if (p < 5000) return 10;
  return 25;
}

function validateTickSize(price, fieldName) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0 || !Number.isInteger(p)) {
    return { valid: false, error: `${fieldName} harus berupa bilangan bulat positif.` };
  }
  const step = getTickSize(p);
  if (p % step !== 0) {
    return { valid: false, error: `${fieldName} (${p}) tidak sesuai fraksi harga BEI (kelipatan ${step}).` };
  }
  return { valid: true, step, price: p };
}

function checkForbiddenWords(text) {
  const lower = String(text || '').toLowerCase();
  for (const word of FORBIDDEN_WORDS) {
    if (lower.includes(word)) {
      return { found: true, word };
    }
  }
  return { found: false };
}

function checkAdminAuth(req) {
  // Development / Preview mode zero-auth check
  const isDevOrPreview = process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production';
  if (isDevOrPreview) {
    if (
      req.headers['x-autocuan-preview'] === '1' ||
      req.headers['x-admin'] === '1' ||
      req.headers['x-user-role'] === 'ADMIN' ||
      (req.headers['x-username'] && String(req.headers['x-username']).toLowerCase() === 'budi')
    ) {
      return { ok: true, userId: req.headers['x-user-id'] || 'admin-budi-id', username: 'budi' };
    }
  }

  // Production check
  try {
    const auth = requireAdminSession(req);
    if (auth && auth.ok && auth.session && auth.session.adm === true) {
      return { ok: true, userId: auth.session.sub || auth.session.un || 'admin', username: auth.session.un || 'admin' };
    }
  } catch (_) {}

  return { ok: false, status: 403, error: 'Akses ditolak. Hanya admin yang dapat membuat atau mengubah catatan.' };
}

function calculateInitialStatus(currentPrice, zoneLo, zoneHi, riskLimit) {
  if (currentPrice == null || isNaN(currentPrice)) return 'Di area pantau';
  if (currentPrice >= zoneLo && currentPrice <= zoneHi) return 'Di area pantau';
  if (currentPrice > zoneHi) return 'Menunggu harga turun ke area';
  if (currentPrice < zoneLo && (riskLimit == null || currentPrice > riskLimit)) return 'Di bawah area pantau';
  return 'Di area pantau';
}

function evaluateNoteStatus(note, quote) {
  // If already closed, return as is
  if (['Kena target', 'Kena batas risiko', 'Kedaluwarsa', 'Ditutup admin'].includes(note.status)) {
    return note;
  }
  const midPoint = (Number(note.zone_lo) + Number(note.zone_hi)) / 2;
  const now = new Date();
  const expiresAt = new Date(note.expires_at);

  if (!quote || quote.high == null || quote.low == null) {
    if (now > expiresAt) {
      note.status = 'Kedaluwarsa';
      note.closed_at = now.toISOString();
      if (!note.entered_at) note.result_pct = null;
    }
    return note;
  }

  const high = Number(quote.high);
  const low = Number(quote.low);
  const target = Number(note.target);
  const risk = Number(note.risk_limit);
  const zoneLo = Number(note.zone_lo);
  const zoneHi = Number(note.zone_hi);

  // Check entry
  if (!note.entered_at) {
    if (low <= zoneHi && high >= zoneLo) {
      note.entered_at = now.toISOString();
      note.status = 'Di area pantau';
    } else if (low > zoneHi) {
      note.status = 'Menunggu harga turun ke area';
    } else if (high < zoneLo) {
      note.status = 'Di bawah area pantau';
    }
  }

  // Once entered
  if (note.entered_at) {
    const hitTarget = high >= target;
    const hitRisk = low <= risk;

    if (hitTarget && hitRisk) {
      // Conservative rule: if both hit in same candle, record risk limit
      note.status = 'Kena batas risiko';
      note.closed_at = now.toISOString();
      note.close_price = risk;
      note.result_pct = Math.round(((risk - midPoint) / midPoint) * 10000) / 100;
      return note;
    }

    if (hitTarget) {
      note.status = 'Kena target';
      note.closed_at = now.toISOString();
      note.close_price = target;
      note.result_pct = Math.round(((target - midPoint) / midPoint) * 10000) / 100;
      return note;
    }

    if (hitRisk) {
      note.status = 'Kena batas risiko';
      note.closed_at = now.toISOString();
      note.close_price = risk;
      note.result_pct = Math.round(((risk - midPoint) / midPoint) * 10000) / 100;
      return note;
    }
  }

  // Expiration check
  if (now > expiresAt) {
    note.status = 'Kedaluwarsa';
    note.closed_at = now.toISOString();
    if (!note.entered_at) {
      note.result_pct = null;
    } else {
      const closeP = quote.close != null ? Number(quote.close) : midPoint;
      note.close_price = closeP;
      note.result_pct = Math.round(((closeP - midPoint) / midPoint) * 10000) / 100;
    }
  }

  return note;
}

module.exports = async function handler(req, res) {
  const method = req.method;

  // 1. GET: Public read (cached 60s)
  if (method === 'GET') {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=120');

    const parsedUrl = new URL(req.url, 'http://localhost');
    const tab = parsedUrl.searchParams.get('tab') || parsedUrl.searchParams.get('status') || 'active';
    const style = parsedUrl.searchParams.get('style') || 'all';
    const ticker = parsedUrl.searchParams.get('ticker') || parsedUrl.searchParams.get('t') || '';
    const noteId = parsedUrl.searchParams.get('id') || '';

    let notes = _mockNotes.slice();
    const supabase = getSupabase();
    if (supabase) {
      try {
        let query = supabase.from('admin_notes').select('*, edits:admin_note_edits(*)').order('published_at', { ascending: false });
        if (noteId) query = query.eq('id', noteId);
        const { data, error } = await query;
        if (!error && Array.isArray(data) && data.length > 0) {
          notes = data;
        }
      } catch (_) {}
    }

    if (noteId) {
      const single = notes.find(n => n.id === noteId);
      if (!single) return res.status(404).json({ success: false, error: 'Catatan tidak ditemukan' });
      return res.status(200).json({ success: true, note: single });
    }

    // Filter by tab
    const activeStatuses = ['Di area pantau', 'Menunggu harga turun ke area', 'Di bawah area pantau'];
    if (tab === 'active') {
      notes = notes.filter(n => activeStatuses.includes(n.status));
    } else if (tab === 'history') {
      notes = notes.filter(n => !activeStatuses.includes(n.status));
    }

    // Filter by style
    if (style === 'daytrade' || style === 'swing') {
      notes = notes.filter(n => n.style === style);
    }

    // Filter by ticker
    if (ticker) {
      const t = ticker.trim().toUpperCase();
      notes = notes.filter(n => n.ticker === t);
    }

    // Summary calculation
    const allCompleted = _mockNotes.filter(n => ['Kena target', 'Kena batas risiko', 'Ditutup admin'].includes(n.status) && n.entered_at != null);
    const targetHitCount = allCompleted.filter(n => n.status === 'Kena target').length;
    const evaluatedCount = allCompleted.length;
    const sumResultPct = allCompleted.reduce((acc, curr) => acc + (Number(curr.result_pct) || 0), 0);
    const avgGainPct = evaluatedCount > 0 ? Math.round((sumResultPct / evaluatedCount) * 10) / 10 : 0;
    const totalActive = _mockNotes.filter(n => activeStatuses.includes(n.status)).length;

    return res.status(200).json({
      success: true,
      summary: {
        total_active: totalActive,
        target_hit: targetHitCount,
        total_evaluated: evaluatedCount,
        avg_gain_pct: avgGainPct,
        history_retention_days: 90
      },
      notes,
      as_of: new Date().toISOString()
    });
  }

  // 2. POST: Create note (Admin only)
  if (method === 'POST') {
    const auth = checkAdminAuth(req);
    if (!auth.ok) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }
    body = body || {};

    const ticker = String(body.ticker || '').trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(ticker)) {
      return res.status(400).json({ success: false, error: 'Kode saham harus berupa 4 huruf ticker IDX yang valid.' });
    }

    const style = String(body.style || '').toLowerCase();
    if (style !== 'daytrade' && style !== 'swing') {
      return res.status(400).json({ success: false, error: 'Gaya harus daytrade atau swing.' });
    }

    const reason = String(body.reason || '').trim();
    if (reason.length < 20 || reason.length > 280) {
      return res.status(400).json({ success: false, error: 'Alasan harus antara 20 dan 280 karakter.' });
    }

    const forbidden = checkForbiddenWords(reason);
    if (forbidden.found) {
      return res.status(400).json({ success: false, error: `Alasan tidak boleh mengandung kata janji hasil: "${forbidden.word}".` });
    }

    const vLo = validateTickSize(body.zone_lo, 'Batas bawah area (zone_lo)');
    if (!vLo.valid) return res.status(400).json({ success: false, error: vLo.error });

    const vHi = validateTickSize(body.zone_hi, 'Batas atas area (zone_hi)');
    if (!vHi.valid) return res.status(400).json({ success: false, error: vHi.error });

    const vTp = validateTickSize(body.target, 'Target harga');
    if (!vTp.valid) return res.status(400).json({ success: false, error: vTp.error });

    const vSl = validateTickSize(body.risk_limit, 'Batas risiko');
    if (!vSl.valid) return res.status(400).json({ success: false, error: vSl.error });

    const zoneLo = vLo.price;
    const zoneHi = vHi.price;
    const target = vTp.price;
    const riskLimit = vSl.price;

    if (zoneLo > zoneHi) {
      return res.status(400).json({ success: false, error: 'Batas bawah area pantau tidak boleh lebih besar dari batas atas.' });
    }
    if (target <= zoneHi) {
      return res.status(400).json({ success: false, error: 'Target harus berada di atas area pantau.' });
    }
    if (riskLimit >= zoneLo) {
      return res.status(400).json({ success: false, error: 'Batas risiko harus berada di bawah area pantau.' });
    }

    const validDays = Number(body.valid_days);
    if (style === 'daytrade' && ![1, 2, 3].includes(validDays)) {
      return res.status(400).json({ success: false, error: 'Masa berlaku DayTrade harus 1, 2, atau 3 hari bursa.' });
    }
    if (style === 'swing' && ![3, 5, 10, 20].includes(validDays)) {
      return res.status(400).json({ success: false, error: 'Masa berlaku Swing harus 3, 5, 10, atau 20 hari bursa.' });
    }

    const now = new Date();
    // Add trading days (simple calendar weekday forward)
    const expDate = new Date(now);
    let added = 0;
    while (added < validDays) {
      expDate.setDate(expDate.getDate() + 1);
      const day = expDate.getDay();
      if (day !== 0 && day !== 6) added++;
    }

    const currentPrice = body.current_price != null ? Number(body.current_price) : zoneHi;
    const initialStatus = calculateInitialStatus(currentPrice, zoneLo, zoneHi, riskLimit);

    const newNote = {
      id: 'note-' + ticker.toLowerCase() + '-' + Date.now().toString(36),
      ticker,
      style,
      reason,
      zone_lo: zoneLo,
      zone_hi: zoneHi,
      target,
      risk_limit: riskLimit,
      valid_days: validDays,
      status: initialStatus,
      published_at: now.toISOString(),
      expires_at: expDate.toISOString(),
      entered_at: initialStatus === 'Di area pantau' ? now.toISOString() : null,
      closed_at: null,
      close_price: null,
      close_reason: null,
      result_pct: null,
      author_id: auth.userId || auth.username || 'admin',
      edits: []
    };

    _mockNotes.unshift(newNote);

    const supabase = getSupabase();
    if (supabase) {
      try {
        await supabase.from('admin_notes').insert([newNote]);
      } catch (_) {}
    }

    return res.status(201).json({ success: true, note: newNote });
  }

  // 3. PATCH: Edit note or close early (Admin only, append-only edits)
  if (method === 'PATCH') {
    const auth = checkAdminAuth(req);
    if (!auth.ok) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }
    body = body || {};

    const noteId = body.id || (req.url && new URL(req.url, 'http://localhost').searchParams.get('id'));
    if (!noteId) {
      return res.status(400).json({ success: false, error: 'ID catatan wajib disertakan.' });
    }

    const noteIndex = _mockNotes.findIndex(n => n.id === noteId);
    if (noteIndex < 0) {
      return res.status(404).json({ success: false, error: 'Catatan tidak ditemukan.' });
    }

    const note = _mockNotes[noteIndex];
    const editReason = String(body.edit_reason || body.reason || '').trim();
    if (editReason.length < 10) {
      return res.status(400).json({ success: false, error: 'Alasan perubahan wajib diisi (minimal 10 karakter).' });
    }

    // Action: Close early
    if (body.action === 'close' || body.status === 'Ditutup admin') {
      const midPoint = (Number(note.zone_lo) + Number(note.zone_hi)) / 2;
      const closePrice = body.close_price != null ? Number(body.close_price) : midPoint;
      const resultPct = Math.round(((closePrice - midPoint) / midPoint) * 10000) / 100;
      const now = new Date().toISOString();

      const editRecord = {
        id: 'edit-' + Date.now().toString(36),
        note_id: note.id,
        edited_at: now,
        editor_id: auth.userId || auth.username || 'admin',
        diff: { status: { from: note.status, to: 'Ditutup admin' }, close_reason: editReason },
        edit_reason: editReason
      };

      note.status = 'Ditutup admin';
      note.closed_at = now;
      note.close_price = closePrice;
      note.close_reason = editReason;
      note.result_pct = resultPct;
      note.edits = note.edits || [];
      note.edits.unshift(editRecord);

      return res.status(200).json({ success: true, note });
    }

    // Action: Update levels or reason
    const diff = {};
    if (body.reason && body.reason !== note.reason) {
      const newReason = String(body.reason).trim();
      if (newReason.length < 20 || newReason.length > 280) {
        return res.status(400).json({ success: false, error: 'Alasan harus antara 20 dan 280 karakter.' });
      }
      const forbidden = checkForbiddenWords(newReason);
      if (forbidden.found) {
        return res.status(400).json({ success: false, error: `Alasan tidak boleh mengandung kata: "${forbidden.word}".` });
      }
      diff.reason = { from: note.reason, to: newReason };
      note.reason = newReason;
    }

    if (body.target != null && Number(body.target) !== Number(note.target)) {
      const vTp = validateTickSize(body.target, 'Target harga');
      if (!vTp.valid) return res.status(400).json({ success: false, error: vTp.error });
      if (vTp.price <= Number(body.zone_hi || note.zone_hi)) {
        return res.status(400).json({ success: false, error: 'Target harus di atas area pantau.' });
      }
      diff.target = { from: note.target, to: vTp.price };
      note.target = vTp.price;
    }

    if (body.risk_limit != null && Number(body.risk_limit) !== Number(note.risk_limit)) {
      const vSl = validateTickSize(body.risk_limit, 'Batas risiko');
      if (!vSl.valid) return res.status(400).json({ success: false, error: vSl.error });
      if (vSl.price >= Number(body.zone_lo || note.zone_lo)) {
        return res.status(400).json({ success: false, error: 'Batas risiko harus di bawah area pantau.' });
      }
      diff.risk_limit = { from: note.risk_limit, to: vSl.price };
      note.risk_limit = vSl.price;
    }

    if (body.zone_lo != null && Number(body.zone_lo) !== Number(note.zone_lo)) {
      const vLo = validateTickSize(body.zone_lo, 'Zone low');
      if (!vLo.valid) return res.status(400).json({ success: false, error: vLo.error });
      diff.zone_lo = { from: note.zone_lo, to: vLo.price };
      note.zone_lo = vLo.price;
    }

    if (body.zone_hi != null && Number(body.zone_hi) !== Number(note.zone_hi)) {
      const vHi = validateTickSize(body.zone_hi, 'Zone high');
      if (!vHi.valid) return res.status(400).json({ success: false, error: vHi.error });
      diff.zone_hi = { from: note.zone_hi, to: vHi.price };
      note.zone_hi = vHi.price;
    }

    const editRecord = {
      id: 'edit-' + Date.now().toString(36),
      note_id: note.id,
      edited_at: new Date().toISOString(),
      editor_id: auth.userId || auth.username || 'admin',
      diff,
      edit_reason: editReason
    };
    note.edits = note.edits || [];
    note.edits.unshift(editRecord);

    return res.status(200).json({ success: true, note });
  }

  // Fallback
  res.setHeader('Allow', 'GET, POST, PATCH');
  return res.status(405).json({ success: false, error: `Method ${method} not allowed` });
};

// Export helpers for unit testing
module.exports.validateTickSize = validateTickSize;
module.exports.checkForbiddenWords = checkForbiddenWords;
module.exports.calculateInitialStatus = calculateInitialStatus;
module.exports.evaluateNoteStatus = evaluateNoteStatus;
module.exports._mockNotes = _mockNotes;
