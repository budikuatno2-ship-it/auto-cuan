/**
 * Auto-Cuan Board API — Stock Board/FCA lookup from Supabase
 * Returns board classification, FCA status, and min price guard.
 * In-memory cache with 12-hour TTL.
 */

var cache = {};
var CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

module.exports = async function handler(req, res) {
  try {
    var ticker = null;

    if (req.method === 'GET') {
      ticker = req.query && req.query.ticker;
    } else if (req.method === 'POST') {
      var body = req.body || {};
      ticker = body.ticker;
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!ticker) {
      return res.status(400).json({ error: 'Parameter ticker wajib diisi.' });
    }

    ticker = String(ticker).toUpperCase().trim();
    if (!/^[A-Z]{3,5}$/.test(ticker)) {
      return res.status(400).json({ error: 'Format ticker tidak valid.' });
    }

    // Check cache
    var cached = cache[ticker];
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return res.status(200).json(cached.data);
    }

    var SUPABASE_URL = process.env.SUPABASE_URL;
    var SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json(makeNotFound(ticker));
    }

    // Query Supabase
    var url = SUPABASE_URL + '/rest/v1/stock_boards?ticker=eq.' + ticker + '&is_active=eq.true&limit=1';

    var response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json'
        }
      });
    } catch (fetchErr) {
      return res.status(200).json(makeNotFound(ticker));
    }

    if (!response.ok) {
      return res.status(200).json(makeNotFound(ticker));
    }

    var rows;
    try { rows = await response.json(); } catch (e) {
      return res.status(200).json(makeNotFound(ticker));
    }

    if (!rows || rows.length === 0) {
      var result = makeNotFound(ticker);
      cache[ticker] = { data: result, timestamp: Date.now() };
      return res.status(200).json(result);
    }

    var row = rows[0];
    var result = {
      success: true,
      ticker: ticker,
      companyName: row.company_name || null,
      board: row.board || 'UNKNOWN',
      isFca: !!row.is_fca,
      minPriceGuard: row.min_price_guard != null ? row.min_price_guard : 50,
      note: row.note || getBoardNote(row.board)
    };

    cache[ticker] = { data: result, timestamp: Date.now() };
    return res.status(200).json(result);

  } catch (err) {
    console.error('board error:', err);
    return res.status(200).json(makeNotFound(ticker || 'unknown'));
  }
};

function makeNotFound(ticker) {
  return {
    success: false,
    ticker: ticker,
    companyName: null,
    board: 'UNKNOWN',
    isFca: false,
    minPriceGuard: 50,
    note: 'Board/FCA belum tersedia di database'
  };
}

function getBoardNote(board) {
  switch (board) {
    case 'UTAMA': return 'Papan Utama';
    case 'PENGEMBANGAN': return 'Papan Pengembangan';
    case 'AKSELERASI': return 'Papan Akselerasi';
    case 'PEMANTAUAN_KHUSUS': return 'Papan Pemantauan Khusus';
    case 'EKONOMI_BARU': return 'Papan Ekonomi Baru';
    default: return '';
  }
}
