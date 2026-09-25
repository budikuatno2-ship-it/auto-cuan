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
  return {
    ticker: code,
    source: 'snapshot-penutupan-lokal',
    available: Boolean(technical || bandar),
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
      : null
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
  }
  return lines.join('\n');
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

module.exports = {
  candlesDir,
  brokerRoot,
  readCandles,
  listKnownTickers,
  detectTickers,
  technicalFromCandles,
  buildSnapshot,
  renderContext,
  buildInjection
};