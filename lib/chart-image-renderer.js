'use strict';

const zlib = require('zlib');

function normalizeForeignTicker(value) {
  const ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/, '');
  return /^[A-Z]{3,5}$/.test(ticker) ? ticker : '';
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function makeCrcTable() {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

const PNG_CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodeRgbaPng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let yy = 0; yy < height; yy++) {
    raw[yy * (width * 4 + 1)] = 0;
    rgba.copy(raw, yy * (width * 4 + 1) + 1, yy * width * 4, (yy + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function hexToRgb(hex) {
  const clean = String(hex || '#000000').replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16)
  ];
}

async function fetchChartOhlc(supabase, ticker, options = {}) {
  const safeTicker = normalizeForeignTicker(ticker);
  if (!safeTicker) return { rows: [], source: 'missing_ticker', skipped: true };

  const timeoutMs = Number(options.timeout_ms || options.timeoutMs || 8000);

  // 1. Yahoo Finance 1y daily OHLCV
  try {
    const symbol = safeTicker + '.JK';
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1y&interval=1d';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fetchFn = options.fetchFn || globalThis.fetch;
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (response.ok) {
      const json = await response.json();
      const result = json && json.chart && json.chart.result && json.chart.result[0];
      const timestamps = result && result.timestamp || [];
      const q = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
      if (q) {
        const rows = [];
        for (let i = 0; i < timestamps.length; i++) {
          const o = q.open && q.open[i];
          const h = q.high && q.high[i];
          const l = q.low && q.low[i];
          const c = q.close && q.close[i];
          const v = q.volume && q.volume[i];
          if (o != null && h != null && l != null && c != null &&
              isFinite(o) && isFinite(h) && isFinite(l) && isFinite(c)) {
            rows.push({
              date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
              open: Math.round(o * 100) / 100,
              high: Math.round(h * 100) / 100,
              low: Math.round(l * 100) / 100,
              close: Math.round(c * 100) / 100,
              volume: v || 0
            });
          }
        }
        if (rows.length >= 20) return { rows, source: 'Yahoo Finance 1y daily' };
      }
    }
  } catch (_) { /* continue to fallback */ }

  // 2. Secondary fallback: foreign_watchlist_daily
  if (supabase && typeof supabase.from === 'function') {
    try {
      const res = await supabase.from('foreign_watchlist_daily')
        .select('trade_date,ticker,open,high,low,close,volume')
        .eq('ticker', safeTicker)
        .order('trade_date', { ascending: false })
        .limit(80);
      const localRows = (res.data || [])
        .filter(r => toNum(r.open) != null && toNum(r.high) != null && toNum(r.low) != null && toNum(r.close) != null)
        .map(r => ({
          date: r.trade_date,
          open: toNum(r.open),
          high: toNum(r.high),
          low: toNum(r.low),
          close: toNum(r.close),
          volume: toNum(r.volume) || 0
        }))
        .reverse();
      if (!res.error && localRows.length >= 20) {
        return { rows: localRows, source: 'foreign_watchlist_daily fallback' };
      }
    } catch (_) {}
  }

  return { rows: [], source: 'none', skipped: true };
}

function buildChartPng(ticker, date, ohlcRows, planLevels = []) {
  const rows = (ohlcRows || []).slice(-120);
  if (rows.length < 5) throw new Error('insufficient_historical_ohlc_' + rows.length);

  const levels = (planLevels || []).filter(x => x && x.value != null && isFinite(x.value) && x.value > 0);
  const prices = [];
  rows.forEach(r => prices.push(r.open, r.high, r.low, r.close));
  levels.forEach(l => prices.push(l.value));

  let minP = Math.min(...prices.filter(v => v != null && isFinite(v)));
  let maxP = Math.max(...prices.filter(v => v != null && isFinite(v)));
  if (!isFinite(minP) || !isFinite(maxP)) throw new Error('invalid_price_range');
  if (minP === maxP) { minP *= 0.98; maxP *= 1.02; }
  const pad = (maxP - minP) * 0.10;
  minP -= pad;
  maxP += pad;

  const w = 1080;
  const h = 720;
  const left = 64;
  const right = 96;
  const top = 54;
  const mainH = 410;
  const volH = 84;
  const rsiTop = 574;
  const rsiH = 82;
  const plotW = w - left - right;
  const bottomMain = top + mainH;

  const rgba = Buffer.alloc(w * h * 4);

  function setPx(px, py, color) {
    px = Math.round(px);
    py = Math.round(py);
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const idx = (py * w + px) * 4;
    rgba[idx] = color[0];
    rgba[idx + 1] = color[1];
    rgba[idx + 2] = color[2];
    rgba[idx + 3] = color.length > 3 ? color[3] : 255;
  }

  function blendRect(x1, y1, x2, y2, color) {
    x1 = Math.max(0, Math.floor(x1));
    x2 = Math.min(w - 1, Math.ceil(x2));
    y1 = Math.max(0, Math.floor(y1));
    y2 = Math.min(h - 1, Math.ceil(y2));
    for (let ry = y1; ry <= y2; ry++) {
      for (let rx = x1; rx <= x2; rx++) setPx(rx, ry, color);
    }
  }

  function rect(x1, y1, x2, y2, color) {
    blendRect(x1, y1, x2, y2, color);
  }

  function line(x1, y1, x2, y2, color, width = 1) {
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    x2 = Math.round(x2);
    y2 = Math.round(y2);
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    let maxSteps = dx + dy + 10;
    while (maxSteps-- > 0) {
      rect(x1 - width / 2, y1 - width / 2, x1 + width / 2, y1 + width / 2, color);
      if (x1 === x2 && y1 === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x1 += sx; }
      if (e2 < dx) { err += dx; y1 += sy; }
    }
  }

  function x(i) {
    return left + (rows.length === 1 ? plotW / 2 : (i * plotW / (rows.length - 1)));
  }
  function y(v) {
    return top + ((maxP - v) / (maxP - minP)) * mainH;
  }

  function ma(period) {
    const out = [];
    for (let i = period - 1; i < rows.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += rows[j].close;
      out.push({ i, v: sum / period });
    }
    return out;
  }

  function drawMA(period, color) {
    const data = ma(period);
    for (let i = 1; i < data.length; i++) {
      line(x(data[i - 1].i), y(data[i - 1].v), x(data[i].i), y(data[i].v), color, period >= 100 ? 2 : 1);
    }
  }

  function rsiData() {
    const out = [];
    for (let i = 14; i < rows.length; i++) {
      let gains = 0, losses = 0;
      for (let k = i - 13; k <= i; k++) {
        const d = rows[k].close - rows[k - 1].close;
        if (d > 0) gains += d;
        else losses -= d;
      }
      const ag = gains / 14;
      const al = losses / 14;
      out.push({ i, v: al === 0 ? 100 : 100 - 100 / (1 + ag / al) });
    }
    return out;
  }

  function yr(v) {
    return rsiTop + ((100 - v) / 100) * rsiH;
  }

  // Dark background
  rect(0, 0, w, h, hexToRgb('#0f1319'));
  rect(left, top, w - right, bottomMain, hexToRgb('#0b0e14'));
  rect(left, bottomMain + 8, w - right, bottomMain + 8 + volH, hexToRgb('#0b0e14'));
  rect(left, rsiTop, w - right, rsiTop + rsiH, hexToRgb('#0b0e14'));

  // Grids
  for (let g = 0; g <= 4; g++) {
    const gy = top + g * mainH / 4;
    line(left, gy, w - right, gy, hexToRgb('#1c2333'), 1);
  }
  for (let vg = 0; vg <= 6; vg++) {
    const gx = left + vg * plotW / 6;
    line(gx, top, gx, rsiTop + rsiH, hexToRgb('#151b29'), 1);
  }

  // Horizontal price levels (Entry, TP, SL)
  levels.forEach(l => {
    const ly = y(l.value);
    const col = hexToRgb(l.color || '#3b82f6');
    for (let xx = left; xx < w - right; xx += 16) {
      line(xx, ly, Math.min(xx + 9, w - right), ly, col, 2);
    }
  });

  // Moving averages
  if (rows.length >= 20) drawMA(20, hexToRgb('#10b981'));
  if (rows.length >= 50) drawMA(50, hexToRgb('#eab308'));
  if (rows.length >= 100) drawMA(100, hexToRgb('#3b82f6'));
  if (rows.length >= 200) drawMA(200, hexToRgb('#a855f7'));

  // Volume bars
  const maxVol = Math.max(...rows.map(r => r.volume || 0), 1);
  const cw = Math.max(3, Math.min(10, plotW / Math.max(rows.length, 40) * 0.62));
  rows.forEach((r, i) => {
    const cx = x(i);
    const up = r.close >= r.open;
    const color = hexToRgb(up ? '#10b981' : '#ef4444');
    const fill = hexToRgb(up ? '#10b981' : '#ef4444');
    const vh = Math.max(1, ((r.volume || 0) / maxVol) * volH);
    rect(cx - cw / 2, bottomMain + 8 + volH - vh, cx + cw / 2, bottomMain + 8 + volH, hexToRgb(up ? '#064e3b' : '#7f1d1d'));
    line(cx, y(r.high), cx, y(r.low), color, 1);
    const by = Math.min(y(r.open), y(r.close));
    const bh = Math.max(2, Math.abs(y(r.open) - y(r.close)));
    rect(cx - cw / 2, by, cx + cw / 2, by + bh, fill);
  });

  // RSI Line
  const rsi = rsiData();
  line(left, yr(70), w - right, yr(70), hexToRgb('#7f1d1d'), 1);
  line(left, yr(30), w - right, yr(30), hexToRgb('#064e3b'), 1);
  for (let ri = 1; ri < rsi.length; ri++) {
    line(x(rsi[ri - 1].i), yr(rsi[ri - 1].v), x(rsi[ri].i), yr(rsi[ri].v), hexToRgb('#f97316'), 2);
  }
  line(left, bottomMain, w - right, bottomMain, hexToRgb('#1c2333'), 1);
  line(w - right, top, w - right, rsiTop + rsiH, hexToRgb('#1c2333'), 1);

  // Last close tag
  const last = rows[rows.length - 1];
  if (last && isFinite(last.close)) {
    const ly2 = y(last.close);
    rect(w - right + 4, ly2 - 8, w - 18, ly2 + 8, hexToRgb(last.close >= last.open ? '#047857' : '#b91c1c'));
    line(w - right - 8, ly2, w - right + 4, ly2, hexToRgb(last.close >= last.open ? '#10b981' : '#ef4444'), 2);
  }

  return encodeRgbaPng(w, h, rgba);
}

module.exports = {
  fetchChartOhlc,
  buildChartPng,
  normalizeForeignTicker
};
