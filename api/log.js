const { createClient } = require('@supabase/supabase-js');
const { getSession, isSameOrigin } = require('../lib/admin-session');

// Telemetry endpoint. It is deliberately fail-soft: a logging problem must never
// surface as a broken UI, so every failure path still answers 200 with
// success:false and the browser ignores it.
//
// It is NOT, however, an open write port. Before hardening, any host on the
// internet could POST an arbitrary `username` plus `isAdmin:true` into
// login_logs, and an unbounded `fullResultHtml` into ai_analysis_logs. That let
// anyone forge admin login entries in the audit trail an operator reads to
// decide whether an account was compromised, and let anyone write rows of
// arbitrary size at the project's storage expense.
//
// The rules now are:
//   - identity comes from the signed ac_sess cookie whenever one is present;
//     a request body can never upgrade who you are
//   - is_admin is derived from that signed session and from nothing else
//   - anonymous callers may still log (guest analytics is the point of this
//     endpoint) but are always recorded as guests
//   - every persisted string is length-capped
//   - cross-origin callers are refused, and a best-effort per-instance rate
//     limit blunts floods

// Column budgets. Generous enough for real telemetry, small enough that a
// hostile caller cannot use this endpoint as free storage.
const LIMITS = {
  username: 30,
  ticker: 12,
  source: 40,
  mode: 40,
  userAgent: 400,
  resultSummary: 2000,
  fullResultHtml: 20000
};

function text(value, max) {
  if (value === null || value === undefined) return '';
  // Strip control characters so a log row can never smuggle terminal escapes or
  // NUL into whatever an operator views the audit trail with.
  return String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

// Best-effort sliding window, per serverless instance. Vercel may run several
// instances, so this is a flood blunter rather than a hard global guarantee —
// a durable limit would need shared state (documented, not silently implied).
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 60;
const buckets = new Map();

function withinRateLimit(key) {
  const now = Date.now();
  if (buckets.size > 5000) buckets.clear(); // bound memory on a long-lived instance
  const recent = (buckets.get(key) || []).filter((stamp) => now - stamp < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) return false;
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

function clientKey(req) {
  const headers = (req && req.headers) || {};
  const forwarded = text(headers['x-forwarded-for'], 100).split(',')[0].trim();
  return forwarded || text(headers['x-real-ip'], 100) || 'unknown';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { action } = body;

    if (!action) {
      return res.status(400).json({ success: false, error: 'Missing action parameter' });
    }

    // State-changing endpoint: refuse a cross-origin caller. isSameOrigin is
    // permissive when neither Host nor Origin/Referer is present, which keeps
    // server-side unit tests and non-browser callers working.
    if (!isSameOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
    }

    // Identity is resolved server-side. A valid signed session wins outright;
    // without one the caller is a guest no matter what the body claims.
    const session = getSession(req);
    const username = session
      ? text(session.un, LIMITS.username) || 'unknown'
      : text(body.username, LIMITS.username) || 'unknown';
    const isGuest = !session;
    const isAdmin = Boolean(session && session.adm === true);

    if (!withinRateLimit(username + '|' + clientKey(req))) {
      return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan.' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ success: false, error: 'Database logging belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    let table, insertData;

    switch (action) {
      case 'login': {
        table = 'login_logs';
        insertData = {
          username: username,
          is_guest: isGuest,
          is_admin: isAdmin,
          user_agent: text(body.userAgent, LIMITS.userAgent)
        };
        break;
      }
      case 'search': {
        table = 'search_logs';
        insertData = {
          username: username,
          ticker: text(body.ticker, LIMITS.ticker).toUpperCase(),
          source: text(body.source, LIMITS.source)
        };
        break;
      }
      case 'analysis': {
        table = 'ai_analysis_logs';
        insertData = {
          username: username,
          ticker: text(body.ticker, LIMITS.ticker).toUpperCase(),
          mode: text(body.mode, LIMITS.mode),
          result_summary: text(body.resultSummary, LIMITS.resultSummary),
          full_result_html: text(body.fullResultHtml, LIMITS.fullResultHtml)
        };
        break;
      }
      case 'usage': {
        table = 'ai_usage_logs';
        insertData = {
          username: username,
          ticker: text(body.ticker, LIMITS.ticker).toUpperCase(),
          action: text(body.usageAction, LIMITS.mode)
        };
        break;
      }
      default:
        return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
    }

    const { data, error } = await supabase
      .from(table)
      .insert(insertData)
      .select();

    if (error) {
      console.error(`log [${action}] insert error:`, error);
      return res.status(200).json({ success: false, error: 'Gagal menyimpan log.' });
    }

    return res.status(200).json({ success: true, data });
  } catch (e) {
    console.error('log exception:', e);
    return res.status(200).json({ success: false, error: 'Gagal menyimpan log.' });
  }
};

// Exposed for focused unit tests only.
module.exports.__test = { text, LIMITS, MAX_PER_WINDOW };
