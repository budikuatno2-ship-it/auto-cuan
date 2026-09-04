'use strict';

const zlib = require('zlib');
const { findSwingHigh, findSwingLow, calculateFibLevels } = require('./fibonacci-confluence');
const { calcMA } = require('./daytrade-screener-engine');

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

const FONT3x5 = {
  '0': [0x7, 0x5, 0x5, 0x5, 0x7], '1': [0x2, 0x6, 0x2, 0x2, 0x7], '2': [0x7, 0x1, 0x7, 0x4, 0x7],
  '3': [0x7, 0x1, 0x7, 0x1, 0x7], '4': [0x5, 0x5, 0x7, 0x1, 0x1], '5': [0x7, 0x4, 0x7, 0x1, 0x7],
  '6': [0x7, 0x4, 0x7, 0x5, 0x7], '7': [0x7, 0x1, 0x2, 0x2, 0x2], '8': [0x7, 0x5, 0x7, 0x5, 0x7],
  '9': [0x7, 0x5, 0x7, 0x1, 0x7], '.': [0x0, 0x0, 0x0, 0x0, 0x2], '%': [0x5, 0x1, 0x2, 0x4, 0x5],
  '-': [0x0, 0x0, 0x7, 0x0, 0x0], ':': [0x0, 0x2, 0x0, 0x2, 0x0], ' ': [0x0, 0x0, 0x0, 0x0, 0x0],
  '/': [0x1, 0x1, 0x2, 0x4, 0x4], '(': [0x2, 0x4, 0x4, 0x4, 0x2], ')': [0x2, 0x1, 0x1, 0x1, 0x2],
  'A': [0x2, 0x5, 0x7, 0x5, 0x5], 'B': [0x6, 0x5, 0x6, 0x5, 0x6], 'C': [0x7, 0x4, 0x4, 0x4, 0x7],
  'D': [0x6, 0x5, 0x5, 0x5, 0x6], 'E': [0x7, 0x4, 0x6, 0x4, 0x7], 'F': [0x7, 0x4, 0x6, 0x4, 0x4],
  'G': [0x7, 0x4, 0x5, 0x5, 0x7], 'H': [0x5, 0x5, 0x7, 0x5, 0x5], 'I': [0x7, 0x2, 0x2, 0x2, 0x7],
  'J': [0x1, 0x1, 0x1, 0x5, 0x2], 'K': [0x5, 0x5, 0x6, 0x5, 0x5], 'L': [0x4, 0x4, 0x4, 0x4, 0x7],
  'M': [0x5, 0x7, 0x5, 0x5, 0x5], 'N': [0x5, 0x7, 0x7, 0x5, 0x5], 'O': [0x2, 0x5, 0x5, 0x5, 0x2],
  'P': [0x6, 0x5, 0x6, 0x4, 0x4], 'Q': [0x2, 0x5, 0x5, 0x6, 0x3], 'R': [0x6, 0x5, 0x6, 0x5, 0x5],
  'S': [0x3, 0x4, 0x2, 0x1, 0x6], 'T': [0x7, 0x2, 0x2, 0x2, 0x2], 'U': [0x5, 0x5, 0x5, 0x5, 0x7],
  'V': [0x5, 0x5, 0x5, 0x5, 0x2], 'W': [0x5, 0x5, 0x5, 0x7, 0x5], 'X': [0x5, 0x5, 0x2, 0x5, 0x5],
  'Y': [0x5, 0x5, 0x2, 0x2, 0x2], 'Z': [0x7, 0x1, 0x2, 0x4, 0x7]
};

function getChartFibLevels(rows) {
  if (!rows || rows.length < 3) return null;
  let sh = findSwingHigh(rows, 60, 3) || findSwingHigh(rows, 60, 2) || findSwingHigh(rows, 60, 1);
  let sl = findSwingLow(rows, 60, 3) || findSwingLow(rows, 60, 2) || findSwingLow(rows, 60, 1);
  let highP = (sh && sh.price) || Math.max(...rows.map(r => r.high));
  let lowP = (sl && sl.price) || Math.min(...rows.map(r => r.low));
  if (highP <= lowP) {
    highP = Math.max(...rows.map(r => r.high));
    lowP = Math.min(...rows.map(r => r.low));
  }
  if (highP > lowP && lowP > 0) {
    return calculateFibLevels(highP, lowP);
  }
  return null;
}

async function fetchChartOhlc(supabase, ticker, options = {}) {
  const safeTicker = normalizeForeignTicker(ticker);
  if (!safeTicker) return { rows: [], source: 'missing_ticker', skipped: true };

  if (Array.isArray(options.ohlcRows) && options.ohlcRows.length > 0) {
    return { rows: options.ohlcRows, source: 'options_provided' };
  }

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

  function drawText(text, tx, ty, color, scale = 1) {
    const s = String(text || '').toUpperCase();
    let cx = tx;
    for (let i = 0; i < s.length; i++) {
      const glyph = FONT3x5[s[i]];
      if (glyph) {
        for (let r = 0; r < 5; r++) {
          const row = glyph[r];
          for (let c = 0; c < 3; c++) {
            if (row & (1 << (2 - c))) {
              if (scale === 1) {
                setPx(cx + c, ty + r, color);
              } else {
                rect(cx + c * scale, ty + r * scale, cx + (c + 1) * scale - 1, ty + (r + 1) * scale - 1, color);
              }
            }
          }
        }
      }
      cx += 4 * scale;
    }
  }

  // 1. Dark background panes
  rect(0, 0, w, h, hexToRgb('#0f1319'));
  rect(left, top, w - right, bottomMain, hexToRgb('#0b0e14'));
  rect(left, bottomMain + 8, w - right, bottomMain + 8 + volH, hexToRgb('#0b0e14'));
  rect(left, rsiTop, w - right, rsiTop + rsiH, hexToRgb('#0b0e14'));

  // 2. Grids
  for (let g = 0; g <= 4; g++) {
    const gy = top + g * mainH / 4;
    line(left, gy, w - right, gy, hexToRgb('#1c2333'), 1);
  }
  for (let vg = 0; vg <= 6; vg++) {
    const gx = left + vg * plotW / 6;
    line(gx, top, gx, rsiTop + rsiH, hexToRgb('#151b29'), 1);
  }

  // 3. Fibonacci Retracement (WAJIB - soft fallback if calculation fails)
  try {
    const fibResult = getChartFibLevels(rows);
    if (fibResult && fibResult.levels) {
      const fibMeta = [
        { key: 'fib_0', label: '0.0%', color: '#64748b' },
        { key: 'fib_236', label: '23.6%', color: '#94a3b8' },
        { key: 'fib_382', label: '38.2%', color: '#38bdf8' },
        { key: 'fib_500', label: '50.0%', color: '#eab308' },
        { key: 'fib_618', label: '61.8%', color: '#ec4899' },
        { key: 'fib_786', label: '78.6%', color: '#a855f7' },
        { key: 'fib_100', label: '100.0%', color: '#64748b' }
      ];
      fibMeta.forEach(m => {
        const p = fibResult.levels[m.key];
        if (p != null && isFinite(p) && p >= minP && p <= maxP) {
          const ly = y(p);
          const col = hexToRgb(m.color);
          for (let xx = left; xx < w - right; xx += 12) {
            line(xx, ly, Math.min(xx + 6, w - right), ly, col, 1);
          }
          rect(w - right + 2, ly - 3, w - right + 6, ly + 3, col);
          drawText(m.label + ' ' + p, w - right + 8, ly - 2, col, 1);
        }
      });
    }
  } catch (_) {
    // Fibonacci calculation error should never fail chart rendering
  }

  // 4. Horizontal price levels (Plan: Entry, TP, SL)
  levels.forEach(l => {
    const ly = y(l.value);
    const col = hexToRgb(l.color || '#3b82f6');
    for (let xx = left; xx < w - right; xx += 16) {
      line(xx, ly, Math.min(xx + 9, w - right), ly, col, 2);
    }
  });

  // 5. Moving Averages (MA20 & MA50: Opsional pelengkap, skip jika data kurang / gagal)
  let ma20Rendered = false;
  let ma50Rendered = false;
  try {
    const closes = rows.map(r => r.close);
    if (rows.length >= 20) {
      const ma20Data = [];
      for (let i = 19; i < rows.length; i++) {
        const val = calcMA(closes.slice(0, i + 1), 20);
        if (val != null && isFinite(val)) ma20Data.push({ i, v: val });
      }
      if (ma20Data.length > 1) {
        const col20 = hexToRgb('#10b981');
        for (let i = 1; i < ma20Data.length; i++) {
          line(x(ma20Data[i - 1].i), y(ma20Data[i - 1].v), x(ma20Data[i].i), y(ma20Data[i].v), col20, 1);
        }
        ma20Rendered = true;
      }
    }
  } catch (_) {
    // Graceful skip
  }

  try {
    const closes = rows.map(r => r.close);
    if (rows.length >= 50) {
      const ma50Data = [];
      for (let i = 49; i < rows.length; i++) {
        const val = calcMA(closes.slice(0, i + 1), 50);
        if (val != null && isFinite(val)) ma50Data.push({ i, v: val });
      }
      if (ma50Data.length > 1) {
        const col50 = hexToRgb('#eab308');
        for (let i = 1; i < ma50Data.length; i++) {
          line(x(ma50Data[i - 1].i), y(ma50Data[i - 1].v), x(ma50Data[i].i), y(ma50Data[i].v), col50, 1);
        }
        ma50Rendered = true;
      }
    }
  } catch (_) {
    // Graceful skip
  }

  // 6. Candlesticks (WAJIB)
  const cw = Math.max(3, Math.min(10, plotW / Math.max(rows.length, 40) * 0.62));
  rows.forEach((r, i) => {
    const cx = x(i);
    const up = r.close >= r.open;
    const color = hexToRgb(up ? '#10b981' : '#ef4444');
    const fill = hexToRgb(up ? '#10b981' : '#ef4444');
    line(cx, y(r.high), cx, y(r.low), color, 1);
    const by = Math.min(y(r.open), y(r.close));
    const bh = Math.max(2, Math.abs(y(r.open) - y(r.close)));
    rect(cx - cw / 2, by, cx + cw / 2, by + bh, fill);
  });

  // 7. Volume Bars & Volume Moving Average Line (WAJIB)
  let volMaRendered = false;
  try {
    const maxVol = Math.max(...rows.map(r => r.volume || 0), 1);
    rows.forEach((r, i) => {
      const cx = x(i);
      const up = r.close >= r.open;
      const vh = Math.max(1, ((r.volume || 0) / maxVol) * volH);
      rect(cx - cw / 2, bottomMain + 8 + volH - vh, cx + cw / 2, bottomMain + 8 + volH, hexToRgb(up ? '#064e3b' : '#7f1d1d'));
    });

    const volPeriod = rows.length >= 20 ? 20 : (rows.length >= 5 ? 5 : 0);
    if (volPeriod > 1) {
      const volumes = rows.map(r => r.volume || 0);
      const volMaData = [];
      for (let i = volPeriod - 1; i < rows.length; i++) {
        const val = calcMA(volumes.slice(0, i + 1), volPeriod);
        if (val != null && isFinite(val)) volMaData.push({ i, v: val });
      }
      if (volMaData.length > 1) {
        const colVolMa = hexToRgb('#38bdf8');
        for (let i = 1; i < volMaData.length; i++) {
          const y1 = bottomMain + 8 + volH - Math.max(1, ((volMaData[i - 1].v || 0) / maxVol) * volH);
          const y2 = bottomMain + 8 + volH - Math.max(1, ((volMaData[i].v || 0) / maxVol) * volH);
          line(x(volMaData[i - 1].i), y1, x(volMaData[i].i), y2, colVolMa, 1);
        }
        volMaRendered = true;
      }
    }
  } catch (_) {
    // Volume MA error should never block PNG output
  }

  // 8. RSI Pane (WAJIB)
  try {
    const rsi = rsiData();
    line(left, yr(70), w - right, yr(70), hexToRgb('#7f1d1d'), 1);
    line(left, yr(30), w - right, yr(30), hexToRgb('#064e3b'), 1);
    for (let ri = 1; ri < rsi.length; ri++) {
      line(x(rsi[ri - 1].i), yr(rsi[ri - 1].v), x(rsi[ri].i), yr(rsi[ri].v), hexToRgb('#f97316'), 2);
    }
  } catch (_) {
    // RSI error should never block PNG output
  }

  line(left, bottomMain, w - right, bottomMain, hexToRgb('#1c2333'), 1);
  line(w - right, top, w - right, rsiTop + rsiH, hexToRgb('#1c2333'), 1);

  // 9. Last close tag
  const last = rows[rows.length - 1];
  if (last && isFinite(last.close)) {
    const ly2 = y(last.close);
    rect(w - right + 4, ly2 - 8, w - 18, ly2 + 8, hexToRgb(last.close >= last.open ? '#047857' : '#b91c1c'));
    line(w - right - 8, ly2, w - right + 4, ly2, hexToRgb(last.close >= last.open ? '#10b981' : '#ef4444'), 2);
  }

  // 10. Text Annotations and Legend
  try {
    drawText(ticker + ' 1D', left, top - 26, hexToRgb('#f1f5f9'), 2);
    if (date) drawText(date, left + 140, top - 22, hexToRgb('#94a3b8'), 1);

    let lx = left + 260;
    drawText('CANDLESTICK', lx, top - 22, hexToRgb('#94a3b8'), 1);
    lx += 80;
    if (ma20Rendered) {
      drawText('MA20', lx, top - 22, hexToRgb('#10b981'), 1);
      lx += 40;
    }
    if (ma50Rendered) {
      drawText('MA50', lx, top - 22, hexToRgb('#eab308'), 1);
      lx += 40;
    }
    drawText('FIBONACCI', lx, top - 22, hexToRgb('#38bdf8'), 1);

    drawText(volMaRendered ? 'VOL / VOL-MA' : 'VOLUME', left + 8, bottomMain + 12, hexToRgb('#94a3b8'), 1);
    drawText('RSI 14', left + 8, rsiTop + 8, hexToRgb('#f97316'), 1);
    drawText('70', w - right + 6, yr(70) - 2, hexToRgb('#7f1d1d'), 1);
    drawText('30', w - right + 6, yr(30) - 2, hexToRgb('#064e3b'), 1);
  } catch (_) {
    // Text drawing error should never block PNG output
  }

  return encodeRgbaPng(w, h, rgba);
}

module.exports = {
  fetchChartOhlc,
  buildChartPng,
  getChartFibLevels,
  normalizeForeignTicker
};
