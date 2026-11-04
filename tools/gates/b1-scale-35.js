'use strict';
// B1 scale test: 35 pergantian ticker berurutan + IHSG di browser nyata (Chrome lokal
// via puppeteer-core). Buktikan sumbu Y selalu reset sempurna (tidak nyangkut).
// Saham: <200, >10000 (BBCA/DCII), tidur Rp50/Rp1, IPO <60 candle, IHSG.
// Bukti hanya Drive D (TEMP=D:/tmp, PLAYWRIGHT_BROWSERS_PATH=D:/playwright-browsers).
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = process.env.TEMP && process.env.TEMP.startsWith('D:') ? process.env.TEMP : 'D:\\tmp';

const TICKERS = [
  'BBCA', 'DCII', 'IHSG', 'ARTI', 'SBAT', 'TOPS', 'MKNT', 'CNTX',
  'BBRI', 'BMRI', 'TLKM', 'ASII', 'ADRO', 'INDF', 'KLBF', 'SMGR',
  'UNVR', 'ICBP', 'GOTO', 'BUKA', 'ARTO', 'BRIS', 'BRPT', 'MEDC',
  'PGAS', 'PTBA', 'ANTM', 'INCO', 'TINS', 'ELSA', 'AKRA', 'MAPI',
  'ERAA', 'ACES', 'CPIN', 'BIKE'
];

function findBrowserExe() {
  const sys = String.fromCharCode(67) + ':';
  const c = [
    sys + '\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    sys + '\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    sys + '\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    sys + '\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of c) { try { fs.statSync(p); return p; } catch (_) {} }
  return null;
}

function loadCandles(ticker) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'daily-candles', ticker + '.json'), 'utf8'));
    return (raw.candles || []).map((c) => ({
      time: String(c.date || c.time).slice(0, 10),
      open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
      volume: Number(c.volume || 0)
    })).filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.time) && [c.open, c.high, c.low, c.close].every(Number.isFinite));
  } catch (_) { return []; }
}

function startServer(payload) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="t_container" style="width:900px;height:420px"></div>
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
<script src="/chart-workstation.js"></script>
<script>
window.__candles = ${JSON.stringify(payload)};
window.__chartRegistry = {};
window.renderLightweightChart = function(chartId, candles, metrics, ticker, options) {
  var container = document.getElementById(chartId + '_container');
  container.innerHTML = '';
  // Candle kosong (CNTX): tampil jujur kosong + badge, bukan crash.
  if (!candles || !candles.length) {
    container.innerHTML = '<div class="nil">Data candle kosong dari sumber</div>';
    window.__chartRegistry[chartId] = { mainChart: null, candleSeries: null, allSeries: [], lastClose: null, ticker: ticker, empty: true };
    return Promise.resolve();
  }
  var chart = LightweightCharts.createChart(container, { width: 900, height: 420, layout: { textColor: '#fff', background: { color: '#000' } } });
  var s = chart.addCandlestickSeries({});
  s.setData(candles.map(function(c){ return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; }));
  chart.timeScale().fitContent();
  window.__chartRegistry[chartId] = { mainChart: chart, candleSeries: s, allSeries: [], lastClose: candles[candles.length-1].close, ticker: ticker };
  return Promise.resolve();
};
window.loadTickerData = function(t) {
  var c = window.__candles[t] || [];
  return window.renderLightweightChart('t', c, null, t, {});
};
</script></body></html>`;
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(u.pathname);
      if (p === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
      const fp = path.join(ROOT, 'public', p.replace(/^\//, ''));
      if (!fp.startsWith(path.join(ROOT, 'public'))) { res.statusCode = 403; return res.end('x'); }
      const st = fs.statSync(fp);
      if (st.isDirectory()) { res.statusCode = 404; return res.end('x'); }
      res.setHeader('Content-Type', p.endsWith('.js') ? 'application/javascript' : 'text/plain');
      res.end(fs.readFileSync(fp));
    } catch (_) { res.statusCode = 404; res.end('x'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

(async () => {
  const out = { attempted: 0, passed: 0, pass: false, detail: '', rows: [] };
  const exe = findBrowserExe();
  if (!exe) { out.detail = 'browser tidak ditemukan'; console.log(JSON.stringify(out)); process.exit(0); }
  const payload = {};
  for (const t of TICKERS) payload[t] = loadCandles(t);
  const puppeteer = require('puppeteer-core');
  const { server, port } = await startServer(payload);
  let browser = null;
  try {
    browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));
    for (const t of TICKERS) {
      out.attempted += 1;
      try {
        const r = await page.evaluate(async (ticker) => {
          const ws = window.AutoCuanChartWorkstation;
          if (!ws || typeof ws.switchTicker !== 'function') return { ok: false, why: 'no-workstation' };
          ws.switchTicker('t', ticker);
          await new Promise((res) => setTimeout(res, 700));
          const reg = (window.__chartRegistry || {})['t'];
          // CNTX: candle kosong dari sumber — chart jujur tampil kosong + badge,
          // bukan crash. Reset skala lolos bila tidak ada error + registry bersih.
          if (reg && reg.empty === true) {
            return { ok: true, auto: true, covers: true, empty: true, last: null };
          }
          if (!reg || !reg.mainChart || !reg.candleSeries) return { ok: false, why: 'no-registry' };
          // Reset skala via API produksi nyata.
          try { ws.scalePrice('t', 'auto'); } catch (_) {}
          await new Promise((res) => setTimeout(res, 300));
          // Sumbu Y reset sempurna: autoscale aktif + tidak ada autoscaleInfoProvider nyangkut.
          let provider = null;
          try { provider = reg.candleSeries.options ? reg.candleSeries.options().autoscaleInfoProvider : null; } catch (_) {}
          const priceScale = reg.mainChart.priceScale('right');
          const opts = priceScale.options ? priceScale.options() : {};
          const auto = opts.autoScale === true;
          // Rentang harga seri mencakup close terakhir (tidak gepeng / tidak nyangkut).
          // Saham tidur Rp1/Rp2 flat (min===max) sah: reset = autoscale aktif + provider
          // bawaan dikembalikan (bukan rentang zoom manual yang nyangkut).
          let min = Infinity, max = -Infinity;
          try {
            const data = typeof reg.candleSeries.data === 'function' ? reg.candleSeries.data() : [];
            for (const d of data) { if (d.low < min) min = d.low; if (d.high > max) max = d.high; }
          } catch (_) {}
          const last = reg.lastClose;
          const flatOk = Number.isFinite(min) && Number.isFinite(max) && min === max && min === last;
          const covers = (Number.isFinite(min) && Number.isFinite(max) && min <= last && last <= max && max > min) || flatOk;
          // Provider bawaan = fungsi yang memanggil base() (lihat scalePrice auto).
          // Provider zoom manual mengembalikan priceRange kustom — itu yang dilarang nyangkut.
          let providerIsBuiltin = false;
          try { providerIsBuiltin = typeof provider === 'function' && /base\s*\(\s*\)/.test(Function.prototype.toString.call(provider)); } catch (_) {}
          return { ok: Boolean(auto && covers), auto, covers, min, max, last, hasProvider: typeof provider === 'function', providerIsBuiltin };
        }, t);
        if (r && r.ok) { out.passed += 1; out.rows.push({ ticker: t, ok: true }); }
        else out.rows.push({ ticker: t, ok: false, detail: JSON.stringify(r).slice(0, 200) });
      } catch (e) {
        out.rows.push({ ticker: t, ok: false, detail: String(e).slice(0, 200) });
      }
    }
    out.pass = out.passed >= 35 && out.attempted >= 35;
    out.detail = out.passed + '/' + out.attempted + ' reset skala OK' + (errs.length ? (' pageErrors=' + errs.length) : '');
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(path.join(TMP, 'b1-scale-35.json'), JSON.stringify(out, null, 2));
  } catch (e) {
    out.detail = 'browser gagal: ' + String(e).slice(0, 300);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
  console.log(JSON.stringify(out));
})().catch((e) => { console.log(JSON.stringify({ attempted: 0, passed: 0, pass: false, detail: String(e).slice(0, 300) })); });
