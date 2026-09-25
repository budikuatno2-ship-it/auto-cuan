'use strict';

/**
 * Market context injection for /tanya.
 *
 * When a user asks about a specific ticker, this module pulls the latest
 * CLOSED session facts (close, change, MA20, volume ratio, foreign/retail net)
 * from local snapshots and injects them into the AI prompt so the answer is
 * grounded in real data instead of the model's memory.
 *
 * It NEVER fabricates a price: when no local snapshot exists the snapshot is
 * `available: false` and the prompt says so explicitly rather than inventing a
 * number. An optional `fetchFn` hook is accepted so a future Yahoo/feed source
 * can be plugged in without changing callers.
 */

const fs = require('fs');
const path = require('path');
const flow = require('./bandarmologi-flow');

function candlesDir(rootDir) {
  return path.join(rootDir || process.cwd(), 'data', 'daily-candles');
}

function brokerRoot(rootDir) {
  return path.join(rootDir || process.cwd(), 'data', 'arjum-data', 'broker-summary');
}

function readCandles(rootDir, ticker) {
  const filePath = path.join(candlesDir(rootDir), String(ticker).toUpperCase() + '.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(data) ? data : (data && data.candles) || [];
    return rows
      .filter((r) => r && r.date && Number.isFinite(Number(r.close)))
      .map((r) => ({
        date: String(r.date).slice(0, 10),
        close: Number(r.close),
        high: Number(r.high),
        low: Number(r.low),
        volume: Number(r.volume) || 0
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch (_) {
    return [];
  }
}

function listKnownTickers(rootDir) {
  const dir = candlesDir(rootDir);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5).toUpperCase())
      .filter((t) => /^[A-Z0-9]{2,10}$/.test(t));
  } catch (_) {
    return [];
  }
}

/**
 * Read the latest screener snapshot (the same file the web cards render from)
 * and return the row for one ticker, or null.
 *
 * The snapshot is written by the scheduled screener run; when it is absent or
 * stale the caller gets null and the prompt simply omits score/plan lines
 * rather than inventing them.
 */
function screenerSnapshotPath(rootDir) {
  return path.join(rootDir || process.cwd(), 'data', 'screener-latest.json');
}

function findScreenerRow(rootDir, ticker) {
  const code = String(ticker || '').toUpperCase();
  if (!code) return null;
  const filePath = screenerSnapshotPath(rootDir);
  if (!fs.existsSync(filePath)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
  // The snapshot is a union of every screener category; the same ticker can
  // legitimately appear in more than one, so the first match wins.
  const buckets = [data.daytrade, data.dayTrade, data.swing, data.top5, data.fusion, data.nk, data.non_konglo];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    const hit = bucket.find((r) => r && String(r.ticker || '').toUpperCase() === code);
    if (hit) return hit;
  }
  return null;
}

/**
 * Detect a stock code inside a free-text question. Only tokens that exist in
 * the local ticker universe are treated as tickers, so ordinary words are not
 * mistaken for a code.
 */
function detectTickers(question, knownTickers) {
  const known = new Set((knownTickers || []).map((t) => String(t).toUpperCase()));
  if (!known.size) return [];
  const tokens = String(question || '').toUpperCase().match(/\b[A-Z0-9]{2,10}\b/g) || [];
  const found = [];
  for (const token of tokens) {
    if (known.has(token) && !found.includes(token)) found.push(token);
  }
  return found;
}

function technicalFromCandles(candles) {
  if (!candles.length) return null;
  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : last;
  const window = candles.slice(-20);
  const ma20 = window.reduce((s, r) => s + r.close, 0) / window.length;
  const avgVol = window.reduce((s, r) => s + r.volume, 0) / window.length;
  return {
    date: last.date,
    close: last.close,
    changePct: prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0,
    ma20,
    volumeRatio: avgVol ? last.volume / avgVol : null,
    sessions: candles.length
  };
}

/**
 * Build a grounded snapshot for one ticker. `available: false` means the
 * caller must not claim any specific price.
 */
function buildSnapshot(rootDir, ticker) {
  const code = String(ticker || '').toUpperCase();
  const candles = readCandles(rootDir, code);
  const technical = technicalFromCandles(candles);
  const bandar = flow.bandarForTicker(brokerRoot(rootDir), code, null);
  const screenerRow = findScreenerRow(rootDir, code);
  return {
    ticker: code,
    source: 'snapshot-penutupan-lokal',
    available: Boolean(technical || bandar || screenerRow),
    technical,
    bandar: bandar
      ? {
        date: bandar.date,
        net: bandar.summary.net,
        foreignNet: bandar.summary.foreignNet,
        retailNet: bandar.summary.retailNet,
        cr3Buy: bandar.summary.cr3Buy,
        cr5Buy: bandar.summary.cr5Buy,
        topBuyers: bandar.summary.topBuyers.slice(0, 3).map((b) => b.code)
      }
      : null,
    // Unified score + trading plan + bandar verdict from the screener snapshot.
    // The AI is asked to reason about the SAME numbers the web card shows, so
    // the score it quotes and the score the user sees can never disagree.
    screener: screenerRow ? extractScreenerFacts(screenerRow) : null
  };
}

/**
 * Pull only the fields the AI is allowed to quote. Anything absent stays absent
 * (undefined) so `renderContext` can omit the line rather than print a blank.
 */
function extractScreenerFacts(row) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  // Prefer the unified score, fall back through the aliases the engine syncs so
  // an un-refreshed snapshot still grounds on the same number the card reads.
  const score = num(row.unified_score) ?? num(row.score) ?? num(row.daytrade_score) ?? num(row.combined_score);
  return {
    score,
    grade: row.unified_score_grade || row.quality_grade || row.grade || null,
    category: row.category || row.screener_type || null,
    status: row.final_status || row.status || row.swing_tier || null,
    entry_low: num(row.entry_low),
    entry_high: num(row.entry_high),
    stop_loss: num(row.stop_loss),
    tp1: num(row.tp1),
    tp2: num(row.tp2),
    risk_reward: num(row.risk_reward) ?? num(row.rr),
    bandar_label: row.bandar_label || null,
    bandar_windows: Array.isArray(row.bandar_consistent_windows) ? row.bandar_consistent_windows : [],
    volume_ratio: num(row.volume_ratio_20d) ?? num(row.volume_ratio) ?? num(row.volume_ratio_avg20),
    updated_at: row.updated_at || row.calculated_at || null
  };
}

function formatIdr(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + ' T';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + ' M';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + ' jt';
  return sign + Math.round(abs).toLocaleString('id-ID');
}

/**
 * Render the grounding block appended to the AI system prompt. Every number is
 * quoted from the snapshot; nothing is inferred beyond the stated metrics.
 */
function renderContext(snapshots) {
  const list = (snapshots || []).filter(Boolean);
  if (!list.length) return '';
  const lines = [
    'DATA PASAR (snapshot penutupan terakhir, sumber lokal Auto-Cuan).',
    'Gunakan hanya angka di bawah ini. Jangan menambah atau menebak harga lain.'
  ];
  for (const snap of list) {
    if (!snap.available) {
      lines.push('- ' + snap.ticker + ': tidak ada snapshot lokal. Sebutkan keterbatasan data ini.');
      continue;
    }
    if (snap.technical) {
      const t = snap.technical;
      lines.push(
        '- ' + snap.ticker + ' (' + t.date + '): close ' + t.close +
        ', perubahan ' + t.changePct.toFixed(2) + '%, MA20 ' + t.ma20.toFixed(0) +
        (t.volumeRatio != null ? ', rasio volume ' + t.volumeRatio.toFixed(2) + 'x' : '')
      );
    }
    if (snap.bandar) {
      const b = snap.bandar;
      lines.push(
        '- ' + snap.ticker + ' bandar (' + b.date + '): net ' + formatIdr(b.net) +
        ', asing ' + formatIdr(b.foreignNet) + ', ritel ' + formatIdr(b.retailNet) +
        ', CR3 beli ' + b.cr3Buy.toFixed(1) + '%, CR5 beli ' + b.cr5Buy.toFixed(1) + '%' +
        (b.topBuyers.length ? ', top akum ' + b.topBuyers.join('/') : '')
      );
    }

    // Screener facts: the unified score, the trade plan levels, and the bandar
    // verdict. Rendered as separate labelled lines so the model can quote the
    // plan without having to infer it, and so a missing field is simply absent
    // rather than filled with a guess.
    const s = snap.screener;
    if (s) {
      if (s.score != null) {
        lines.push(
          '- ' + snap.ticker + ' SKOR UNIFIED: ' + s.score + '/100' +
          (s.grade ? ' (grade ' + s.grade + ')' : '') +
          (s.status ? ', status ' + s.status : '') +
          (s.category ? ', kategori ' + s.category : '')
        );
      }
      const plan = [];
      if (s.entry_low != null || s.entry_high != null) {
        plan.push('Entry ' + fmtLvl(s.entry_low) + '-' + fmtLvl(s.entry_high));
      }
      if (s.stop_loss != null) plan.push('SL ' + fmtLvl(s.stop_loss));
      if (s.tp1 != null) plan.push('TP1 ' + fmtLvl(s.tp1));
      if (s.tp2 != null) plan.push('TP2 ' + fmtLvl(s.tp2));
      if (s.risk_reward != null) plan.push('R/R ' + s.risk_reward.toFixed(1));
      if (plan.length) lines.push('- ' + snap.ticker + ' RENCANA TRADE: ' + plan.join(', '));
      if (s.bandar_label) {
        lines.push(
          '- ' + snap.ticker + ' STATUS BANDARMOLOGI: ' + bandarLabelId(s.bandar_label) +
          (s.bandar_windows.length >= 2 ? ' (konsisten ' + s.bandar_windows.join(' & ') + ')' : '')
        );
      }
    }
  }
  return lines.join('\n');
}

/** Local price formatter; keeps the grounding block readable (8.750 not 8750). */
function fmtLvl(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return Math.round(n).toLocaleString('id-ID');
}

/**
 * Map the engine's English verdict to the Indonesian term the web card shows,
 * so the AI's wording matches the badge the user just looked at.
 */
function bandarLabelId(label) {
  const map = { Accumulation: 'Akumulasi', Distribution: 'Distribusi', Mixed: 'Campuran' };
  return map[label] || String(label);
}

/**
 * Full injection helper. Returns { tickers, snapshots, context } where context
 * is '' when no ticker was detected (the caller then sends the raw question).
 */
function buildInjection(rootDir, question) {
  const known = listKnownTickers(rootDir);
  const tickers = detectTickers(question, known);
  const snapshots = tickers.map((t) => buildSnapshot(rootDir, t));
  return { tickers, snapshots, context: renderContext(snapshots) };
}

/**
 * Same as buildInjection but lets the caller override the screener snapshot
 * path, so the Telegram bot can reuse the `roots.screener` value it already
 * resolved instead of this module guessing a second time.
 */
function buildInjectionWithRoots(rootDir, question, options) {
  const opts = options || {};
  const screenerFile = opts.screenerPath || screenerSnapshotPath(rootDir);
  const known = listKnownTickers(rootDir);
  const tickers = detectTickers(question, known);
  const snapshots = tickers.map((t) => {
    const snap = buildSnapshot(rootDir, t);
    if (!snap.screener && screenerFile !== screenerSnapshotPath(rootDir)) {
      const row = findScreenerRowIn(screenerFile, t);
      if (row) {
        snap.screener = extractScreenerFacts(row);
        snap.available = true;
      }
    }
    return snap;
  });
  return { tickers, snapshots, context: renderContext(snapshots) };
}

/** Read one ticker's row from an explicit snapshot file path. */
function findScreenerRowIn(filePath, ticker) {
  const code = String(ticker || '').toUpperCase();
  if (!code || !filePath || !fs.existsSync(filePath)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
  const buckets = [data.daytrade, data.dayTrade, data.swing, data.top5, data.fusion, data.nk, data.non_konglo];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    const hit = bucket.find((r) => r && String(r.ticker || '').toUpperCase() === code);
    if (hit) return hit;
  }
  return null;
}

module.exports = {
  candlesDir,
  brokerRoot,
  screenerSnapshotPath,
  readCandles,
  listKnownTickers,
  detectTickers,
  technicalFromCandles,
  buildSnapshot,
  extractScreenerFacts,
  findScreenerRow,
  findScreenerRowIn,
  renderContext,
  buildInjection,
  buildInjectionWithRoots
};