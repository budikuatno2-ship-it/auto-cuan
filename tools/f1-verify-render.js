'use strict';
// F1 — verifikasi render Financial 10 emiten via HTTP (header preview) + Playwright.
// Memeriksa: 4 tab + toggle Kuartalan/Tahunan + nil span + grafik PBV + angka BRPT Q2.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 31991;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function waitFor(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      http.get(url, (res) => { res.resume(); resolve(); }).on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('timeout ' + url));
        else setTimeout(check, 300);
      });
    })();
  });
}

function get(p) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port: PORT, path: p,
      headers: { 'X-AutoCuan-Preview': '1' }
    };
    http.get(opts, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

async function run() {
  const server = spawn(process.execPath, ['tools/local-dev-server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore'
  });
  let browser = null;
  const out = {
    tool: 'tools/f1-verify-render.js',
    at: new Date().toISOString(),
    tickers: [],
    dom: null,
    pass: false
  };
  try {
    await waitFor(BASE + '/', 20000);
    const ten = ['BRPT', 'BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII', 'ADRO', 'ANTM', 'GOTO', 'BBNI'];
    for (const t of ten) {
      const r = await get('/api/quote?action=financial-snapshot&ticker=' + t);
      let period = null;
      let hasQ = false;
      let q0 = null;
      try {
        const j = JSON.parse(r.body);
        period = j && j.snapshot && j.snapshot.fundamental ? j.snapshot.fundamental.fundamental_period : null;
        const q = j && j.snapshot && j.snapshot.financial_statements ? j.snapshot.financial_statements.quarterly : null;
        hasQ = Boolean(q);
        q0 = q && q.periods ? q.periods[0] : null;
      } catch (_) {}
      const expectQ2 = ['BRPT', 'BBCA', 'BBRI', 'BMRI', 'TLKM'].includes(t);
      const ok = expectQ2 ? (period === 'Q2 2026' && q0 === 'Q2 2026') : (period == null && !hasQ);
      out.tickers.push({ ticker: t, period, q0, hasQ, expectQ2, ok });
    }
    const br = await get('/api/quote?action=financial-snapshot&ticker=BRPT');
    let brptNums = null;
    try {
      const j = JSON.parse(br.body);
      const q = j.snapshot.financial_statements.quarterly;
      const rows = q.income_statement.rows;
      const gv = (label) => {
        const r = rows.find((x) => x.label === label);
        return r ? r.values[0] : null;
      };
      brptNums = {
        rev: gv('Penjualan / Pendapatan'),
        cogs: gv('Beban Pokok'),
        gross: gv('Laba Bruto'),
        net: gv('Laba Bersih Periode Berjalan'),
        eps: gv('EPS')
      };
    } catch (_) {}
    out.brpt = brptNums;
    out.brptOk = brptNums && brptNums.rev === 55767.63 && brptNums.cogs === -48356.71 && brptNums.gross === 7410.92 && brptNums.net === 4432.15 && brptNums.eps === 19.1;

    const page = await get('/analisis-saham.html');
    const html = page.body || '';
    const runtime = fs.readFileSync(path.join(ROOT, 'public', 'analisis-saham-runtime.js'), 'utf8');
    out.dom = {
      tabs4: ['finCat0', 'finCat1', 'finCat2', 'finCat3'].every((id) => html.includes(id)),
      toggle: html.includes('finFreq0') && html.includes('finFreq1'),
      nilCss: html.includes('.nil'),
      nilSpan: runtime.includes('<span class="nil">'),
      pbvGraph: html.includes('financialBarSvg') && html.includes('financialSvgBarsGroup') && runtime.includes('function renderFinancialTrend'),
      realModel: runtime.includes('modelFromSnapshot')
    };

    let pw = { ran: false, ok: false, detail: 'skip' };
    if (fs.existsSync(CHROME)) {
      try {
        const puppeteer = require('puppeteer-core');
        browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
        const pg = await browser.newPage();
        await pg.setViewport({ width: 1366, height: 900 });
        await pg.setExtraHTTPHeaders({ 'X-AutoCuan-Preview': '1' });
        await pg.goto(BASE + '/analisis-saham.html?tab=financial&ticker=BRPT', { waitUntil: 'networkidle2', timeout: 30000 });
        await pg.evaluate(async () => {
          if (typeof window.switchAnalisisTab === 'function') window.switchAnalisisTab('financial');
          if (typeof window.loadFinancialStructureTab === 'function') await window.loadFinancialStructureTab('financial', 'BRPT');
        });
        await new Promise((r) => setTimeout(r, 3500));
        const dom = await pg.evaluate(() => {
          const thead = document.getElementById('financialStatementsThead');
          const tbody = document.getElementById('financialStatementsTbody');
          const svg = document.getElementById('financialBarSvg');
          const bars = document.getElementById('financialSvgBarsGroup');
          const tabs = [0, 1, 2, 3].map((i) => Boolean(document.getElementById('finCat' + i)));
          const nilCount = tbody ? (tbody.innerHTML.match(/<span class="nil">/g) || []).length : 0;
          return {
            theadCols: thead ? thead.querySelectorAll('th').length : 0,
            theadFirst: thead ? (thead.textContent || '').slice(0, 80) : '',
            bodyRows: tbody ? tbody.querySelectorAll('tr').length : 0,
            svgBars: bars ? bars.querySelectorAll('rect').length : 0,
            svgExists: Boolean(svg),
            tabs,
            nilCount
          };
        });
        const tabRows = [];
        for (let c = 0; c < 4; c++) {
          await pg.evaluate((cc) => { if (typeof window.setFinStatementCat === 'function') window.setFinStatementCat(cc); }, c);
          await new Promise((r) => setTimeout(r, 500));
          const n = await pg.evaluate(() => {
            const tb = document.getElementById('financialStatementsTbody');
            return tb ? tb.querySelectorAll('tr').length : 0;
          });
          tabRows.push(n);
        }
        await pg.evaluate(() => { if (typeof window.setFinStatementFreq === 'function') window.setFinStatementFreq(1); });
        await new Promise((r) => setTimeout(r, 600));
        const annualHead = await pg.evaluate(() => {
          const th = document.getElementById('financialStatementsThead');
          return th ? th.textContent || '' : '';
        });
        pw = {
          ran: true,
          ok: dom.theadCols >= 2 && dom.theadFirst.includes('Q2 2026') && dom.bodyRows > 0 && dom.svgExists && dom.svgBars > 0 && tabRows.every((n) => n > 0) && annualHead.includes('FY'),
          detail: 'theadCols=' + dom.theadCols + ' first=' + dom.theadFirst.slice(0, 30) + ' rows=' + dom.bodyRows + ' bars=' + dom.svgBars + ' nil=' + dom.nilCount + ' tabs=' + tabRows.join(',') + ' annualFY=' + annualHead.includes('FY')
        };
        out.pw = pw;
      } catch (e) {
        pw = { ran: true, ok: false, detail: 'pw-error: ' + (e && e.message) };
        out.pw = pw;
      }
    } else {
      out.pw = pw;
    }

    const tenOk = out.tickers.filter((x) => x.ok).length;
    const domOk = out.dom.tabs4 && out.dom.toggle && out.dom.nilCss && out.dom.nilSpan && out.dom.pbvGraph && out.dom.realModel;
    out.tenOk = tenOk;
    out.domOk = domOk;
    out.pass = tenOk === 10 && out.brptOk === true && domOk === true && (!out.pw.ran || out.pw.ok === true);
    const dir = path.join(ROOT, 'bukti-verifikasi-final', 'faseF1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'render-10-emiten.json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ tenOk, brptOk: out.brptOk, domOk, pw: out.pw, pass: out.pass }));
    process.exitCode = out.pass ? 0 : 1;
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    try { server.kill(); } catch (_) {}
  }
}

run().catch((e) => { console.error('F1 render FAIL:', e && e.message); process.exit(1); });
