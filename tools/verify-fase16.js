// FASE 16 Verification — Insider, Ranking, Financial, Struktur Pasar
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT_DIR = path.resolve(__dirname, '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3000;
const BASE_URL = 'http://127.0.0.1:' + PORT;
const OUT_DIR = path.join(ROOT_DIR, 'bukti-verifikasi-final', 'fase16');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function checkServer(url) {
  return new Promise(r => { http.get(url, res => r(res.statusCode < 500)).on('error', () => r(false)); });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function openPage(browser, vp, theme, url) {
  const pg = await browser.newPage();
  await pg.setViewport({ width: vp.w, height: vp.h, isMobile: vp.w <= 480, hasTouch: vp.w <= 480 });
  await pg.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_role', 'admin');
      localStorage.setItem('autocuan_is_admin', 'true');
      localStorage.setItem('auto_cuan_onboarding_seen', 'true');
    } catch (_) {}
  });
  await pg.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(600);
  await pg.evaluate(t => {
    document.documentElement.classList.add(t);
    document.documentElement.classList.remove(t === 'light' ? 'dark' : 'light');
  }, theme);
  await sleep(400);
  return pg;
}

async function shot(pg, name) {
  await pg.screenshot({ path: path.join(OUT_DIR, name), fullPage: false });
  console.log('  [SHOT] ' + name);
}

const VIEWS = [
  { label: '1440_light', vp: { w: 1440, h: 1100 }, theme: 'light' },
  { label: '1440_dark', vp: { w: 1440, h: 1100 }, theme: 'dark' },
  { label: '390_light', vp: { w: 390, h: 844 }, theme: 'light' },
  { label: '390_dark', vp: { w: 390, h: 844 }, theme: 'dark' }
];

async function run() {
  console.log('[FASE16] Checking server at ' + BASE_URL + '...');
  if (!(await checkServer(BASE_URL + '/'))) { console.error('Server DOWN.'); process.exit(1); }
  console.log('[FASE16] Server UP.');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const results = { insider: null, ranking: null, financial: null, strukturPasar: null };

  try {
    // ── 16 screenshots ──
    const PAGES = [
      ['insider', 'insider'],
      ['ranking', 'ranking'],
      ['financial', 'financial'],
      ['struktur-pasar', 'market-structure']
    ];
    for (const pair of PAGES) {
      const label = pair[0], tab = pair[1];
      console.log('\n=== ' + label.toUpperCase() + ' ===');
      for (const v of VIEWS) {
        const pg = await openPage(browser, v.vp, v.theme, BASE_URL + '/analisis-saham?embed=1');
        await pg.evaluate((t) => {
          if (typeof switchAnalisisTab === 'function') switchAnalisisTab(t);
        }, tab);
        await sleep(2500);
        await shot(pg, label + '_' + v.label + '.png');
        await pg.close();
      }
    }

    console.log('\n=== DEEP INTERACTIVE VERIFICATION ===');

    // ── INSIDER ──
    console.log('\n-- Insider --');
    const ip = await openPage(browser, { w: 1440, h: 1100 }, 'light', BASE_URL + '/analisis-saham?embed=1');
    await ip.evaluate(() => { if (typeof switchAnalisisTab === 'function') switchAnalisisTab('insider'); });
    await sleep(2500);
    results.insider = await ip.evaluate(() => {
      const p = document.getElementById('panel-tab-insider');
      if (!p) return { err: 'panel-tab-insider NOT FOUND' };
      const h1 = p.querySelector('h1');
      const nodes = p.querySelectorAll('[class*=node],.node');
      return {
        title: h1 ? h1.textContent.trim() : 'NONE',
        hasSearch: !!p.querySelector('input'),
        svgCount: p.querySelectorAll('svg').length,
        hasGovOverlay: !!p.querySelector('[class*=gov]'),
        hasCqiLabels: !!p.querySelector('[class*=glb]'),
        nodeCount: nodes.length,
        nodeTabIndex: nodes.length > 0 ? (nodes[0].getAttribute('tabindex') || 'none') : 'none',
        hasKsei: /KSEI|Pemegang/i.test(p.textContent),
        hasDetail: /Pengendali|Hubungan|Kepemilikan/i.test(p.textContent),
        hasReset: /Reset/i.test(p.textContent),
        buttons: Array.from(p.querySelectorAll('button')).map(b => b.textContent.trim().substring(0, 60)).slice(0, 10)
      };
    });
    console.log('  Title:', results.insider.title);
    console.log('  Nodes:', results.insider.nodeCount, '| SVG:', results.insider.svgCount, '| Gov:', results.insider.hasGovOverlay);
    console.log('  KSEI:', results.insider.hasKsei, '| Detail:', results.insider.hasDetail, '| Reset:', results.insider.hasReset);

    const insClick = await ip.evaluate(() => {
      const p = document.getElementById('panel-tab-insider');
      if (!p) return 'no panel';
      const n = p.querySelector('[class*=node],.node');
      if (!n) return 'no node';
      try {
        n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch (e) {
        try { n.click(); } catch (e2) { return 'click failed: ' + e2.message; }
      }
      return 'clicked:' + (n.textContent || '').trim().substring(0, 30);
    });
    console.log('  Node click:', insClick);
    results.insider.clickResult = insClick;

    const insReset = await ip.evaluate(() => {
      const p = document.getElementById('panel-tab-insider');
      if (!p) return 'no panel';
      const btns = p.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent.indexOf('Reset') >= 0) { b.click(); return 'reset clicked'; }
      }
      return 'no reset button';
    });
    console.log('  Reset:', insReset);
    results.insider.resetResult = insReset;
    fs.writeFileSync(path.join(OUT_DIR, 'insider-elements.json'), JSON.stringify(results.insider, null, 2));
    await ip.close();

    // ── RANKING ──
    console.log('\n-- Ranking --');
    const rp = await openPage(browser, { w: 1440, h: 1100 }, 'light', BASE_URL + '/analisis-saham?embed=1');
    await rp.evaluate(() => { if (typeof switchAnalisisTab === 'function') switchAnalisisTab('ranking'); });
    await sleep(2500);
    results.ranking = await rp.evaluate(() => {
      const p = document.getElementById('panel-tab-ranking');
      if (!p) return { err: 'panel-tab-ranking NOT FOUND' };
      const h1 = p.querySelector('h1');
      const th = p.querySelector('thead');
      const headers = th ? Array.from(th.querySelectorAll('th')).map(function(h){ return h.textContent.trim(); }) : [];
      const rows = p.querySelectorAll('tbody tr');
      var firstTk = '';
      if (rows.length > 0) { var tk = rows[0].querySelector('.tk'); if (tk) firstTk = tk.textContent.trim(); }
      return {
        title: h1 ? h1.textContent.trim() : 'NONE',
        hasSearch: !!p.querySelector('#rankingSearchInput'),
        presetCount: p.querySelectorAll('#rankingPresetSeg button').length,
        hasCsv: /CSV|Ekspor/i.test(p.textContent),
        hasPin: !!p.querySelector('.pin'),
        headerCount: headers.length,
        headerTexts: headers.slice(0, 10),
        ariaSortCount: (th ? th.querySelectorAll('[aria-sort]').length : 0),
        rowCount: rows.length,
        firstTicker: firstTk
      };
    });
    console.log('  Title:', results.ranking.title);
    console.log('  Presets:', results.ranking.presetCount, '| Headers:', results.ranking.headerCount, '| Rows:', results.ranking.rowCount);
    console.log('  First:', results.ranking.firstTicker, '| CSV:', results.ranking.hasCsv, '| Pin:', results.ranking.hasPin);

    // Sort test
    const sortTest = await rp.evaluate(() => {
      const th = document.querySelector('#panel-tab-ranking thead th button');
      if (!th) return 'no sort button';
      th.click();
      return 'sort clicked';
    });
    await sleep(800);
    const sortResult = await rp.evaluate(() => {
      const th = document.querySelector('#panel-tab-ranking thead th[aria-sort]');
      return th ? th.getAttribute('aria-sort') : 'no aria-sort';
    });
    console.log('  Sort:', sortTest, '| aria-sort:', sortResult);
    results.ranking.sortResult = sortResult;

    // CSV filename check
    const csvCheck = await rp.evaluate(() => {
      var btn = null;
      var btns = document.querySelectorAll('#panel-tab-ranking button');
      for (var i = 0; i < btns.length; i++) {
        if (/CSV|Ekspor/i.test(btns[i].textContent)) { btn = btns[i]; break; }
      }
      return btn ? btn.textContent.trim() : 'no csv btn';
    });
    console.log('  CSV btn text:', csvCheck);

    fs.writeFileSync(path.join(OUT_DIR, 'ranking-elements.json'), JSON.stringify(results.ranking, null, 2));
    await rp.close();

    // ── FINANCIAL ──
    console.log('\n-- Financial --');
    const fp = await openPage(browser, { w: 1440, h: 1100 }, 'light', BASE_URL + '/analisis-saham?embed=1');
    await fp.evaluate(() => { if (typeof switchAnalisisTab === 'function') switchAnalisisTab('financial'); });
    await sleep(3000);
    results.financial = await fp.evaluate(() => {
      const p = document.getElementById('panel-tab-financial');
      if (!p) return { err: 'panel-tab-financial NOT FOUND' };
      var catBtns = Array.from(p.querySelectorAll('#financialCategoryTabs button')).map(function(b){ return b.textContent.trim(); });
      var freqBtns = Array.from(p.querySelectorAll('#financialFreqTabs button')).map(function(b){ return b.textContent.trim(); });
      var ths = p.querySelectorAll('#financialStatementsTable thead th');
      var cols = Array.from(ths).map(function(th){ return (th.textContent || '').trim(); });
      var q2 = cols.filter(function(c){ return /Q2/i.test(c); });
      var body = document.getElementById('financialStatementsTbody');
      return {
        hasSearchInput: !!p.querySelector('#financialTickerInput'),
        hasReload: /Muat ulang/i.test(p.textContent),
        hasStrukturLink: /Struktur Pasar/i.test(p.textContent),
        categories: catBtns,
        frequencies: freqBtns,
        colCount: cols.length,
        q2Columns: q2,
        hasQ2: q2.length > 0,
        columnNames: cols.slice(0, 8),
        rowCount: body ? body.querySelectorAll('tr').length : 0,
        hasYoY: /YoY|yoy/i.test(p.textContent),
        hasCsv: /CSV/i.test(p.textContent),
        hasEmptyToggle: /Pos kosong/i.test(p.textContent),
        hasPbvChart: !!p.querySelector('#financialBarSvg'),
        hasPeerTable: !!p.querySelector('#financialPeerTable'),
        hasNotes: /Catatan metrik|Definisi/i.test(p.textContent),
        chipCount: p.querySelectorAll('#financialPopularChips button').length
      };
    });
    console.log('  Categories:', results.financial.categories);
    console.log('  Frequencies:', results.financial.frequencies);
    console.log('  Columns:', results.financial.columnNames);
    console.log('  Q2 columns:', results.financial.q2Columns);
    console.log('  Rows:', results.financial.rowCount, '| YoY:', results.financial.hasYoY, '| CSV:', results.financial.hasCsv);
    console.log('  Empty toggle:', results.financial.hasEmptyToggle, '| PBV chart:', results.financial.hasPbvChart);
    console.log('  Peer table:', results.financial.hasPeerTable, '| Notes:', results.financial.hasNotes);

    // Freq toggle test
    const freqToggle = await fp.evaluate(() => {
      var btns = document.querySelectorAll('#financialFreqTabs button');
      if (btns.length < 2) return 'not enough freq buttons';
      btns[1].click();
      return 'switched to ' + btns[1].textContent.trim();
    });
    await sleep(1500);
    const freqResult = await fp.evaluate(() => {
      var ths = document.querySelectorAll('#financialStatementsTable thead th');
      var cols = Array.from(ths).map(function(t){ return (t.textContent||'').trim(); });
      var hasAnnual = cols.some(function(c){ return /FY|Tahunan/i.test(c); });
      return { cols: cols.slice(0, 6), hasAnnual: hasAnnual };
    });
    console.log('  Freq toggle:', freqToggle, '| Annual cols:', freqResult.cols, '| hasAnnual:', freqResult.hasAnnual);
    results.financial.freqToggle = { action: freqToggle, annualColumns: freqResult.cols, hasAnnual: freqResult.hasAnnual };

    // Q2 ticker verification
    results.financial.q2Tickers = {};
    var tickers = ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'BRPT'];
    for (var ti = 0; ti < tickers.length; ti++) {
      var ticker = tickers[ti];
      await fp.evaluate(function(tk) {
        var chips = document.querySelectorAll('#financialPopularChips button');
        for (var j = 0; j < chips.length; j++) {
          if (chips[j].textContent.trim() === tk) { chips[j].click(); return; }
        }
        var inp = document.getElementById('financialTickerInput');
        if (inp) { inp.value = tk; inp.dispatchEvent(new Event('input', { bubbles: true })); }
      }, ticker);
      await sleep(2000);
      var hasQ2 = await fp.evaluate(function() {
        var ths = document.querySelectorAll('#financialStatementsTable thead th');
        for (var i = 0; i < ths.length; i++) {
          if (/Q2.*202[56]/i.test(ths[i].textContent || '')) return true;
        }
        return false;
      });
      results.financial.q2Tickers[ticker] = hasQ2;
      console.log('  ' + ticker + ' Q2:', hasQ2);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'financial-elements.json'), JSON.stringify(results.financial, null, 2));
    await fp.close();

    // ── STRUKTUR PASAR ──
    console.log('\n-- Struktur Pasar --');
    const sp = await openPage(browser, { w: 1440, h: 1100 }, 'light', BASE_URL + '/analisis-saham?embed=1');
    await sp.evaluate(() => { if (typeof switchAnalisisTab === 'function') switchAnalisisTab('market-structure'); });
    await sleep(3000);
    results.strukturPasar = await sp.evaluate(() => {
      const p = document.getElementById('panel-tab-market-structure');
      if (!p) return { err: 'panel-tab-market-structure NOT FOUND' };
      var chips = Array.from(p.querySelectorAll('.fchip,[data-filter]')).map(function(c) {
        return { text: c.textContent.trim().substring(0, 60), active: c.classList.contains('on') };
      });
      var ths = p.querySelectorAll('#marketStructureTable thead th');
      var cols = Array.from(ths).map(function(th){ return th.textContent.trim(); });
      var rows = p.querySelectorAll('#marketStructureTableBody tr');
      var pTIdx = -1;
      for (var ci = 0; ci < cols.length; ci++) { if (/Per tanggal/i.test(cols[ci])) { pTIdx = ci; break; } }
      var pTVals = [];
      if (pTIdx >= 0) {
        for (var ri = 0; ri < Math.min(5, rows.length); ri++) {
          var tds = rows[ri].querySelectorAll('td');
          if (tds.length > pTIdx) pTVals.push(tds[pTIdx].textContent.trim());
        }
      }
      var hasSortBtn = false;
      var btns = p.querySelectorAll('button');
      for (var bi = 0; bi < btns.length; bi++) { if (/Urutkan/i.test(btns[bi].textContent)) { hasSortBtn = true; break; } }
      return {
        hasSearch: !!p.querySelector('#marketStructureSearchInput'),
        filterChips: chips,
        filterChipCount: chips.length,
        columnNames: cols,
        hasPerTanggal: cols.some(function(c){ return /Per tanggal/i.test(c); }),
        rowCount: rows.length,
        perTanggalValues: pTVals,
        hasSortBtn: hasSortBtn,
        hasDetailBtn: /Buka analisis/i.test(p.textContent),
        hasFFBar: !!p.querySelector('.ffbar'),
        hasAsOfBadge: !!p.querySelector('#marketStructureAsOfBadge')
      };
    });
    console.log('  Filters:', results.strukturPasar.filterChips.map(function(c){ return c.text; }));
    console.log('  Columns:', results.strukturPasar.columnNames);
    console.log('  Per tanggal:', results.strukturPasar.hasPerTanggal, '| Values:', results.strukturPasar.perTanggalValues);
    console.log('  Rows:', results.strukturPasar.rowCount, '| Sort:', results.strukturPasar.hasSortBtn, '| Detail:', results.strukturPasar.hasDetailBtn);

    // Filter chip click test
    var chipClickResult = await sp.evaluate(function() {
      var chips = document.querySelectorAll('#marketStructureFilterGroup .fchip');
      if (chips.length < 2) return 'not enough chips';
      chips[1].click();
      return 'clicked chip: ' + chips[1].textContent.trim().substring(0, 40);
    });
    await sleep(1200);
    var chipAfter = await sp.evaluate(function() {
      var active = document.querySelector('#marketStructureFilterGroup .fchip.on');
      return active ? active.textContent.trim().substring(0, 40) : 'none active';
    });
    console.log('  Chip click:', chipClickResult, '| Active now:', chipAfter);
    results.strukturPasar.chipClick = { action: chipClickResult, activeAfter: chipAfter };

    // Detail panel row click
    var detailClick = await sp.evaluate(function() {
      var rows = document.querySelectorAll('#marketStructureTableBody tr');
      if (rows.length === 0) return 'no rows';
      rows[0].click();
      return 'row clicked';
    });
    await sleep(800);
    var detailVisible = await sp.evaluate(function() {
      var pane = document.getElementById('marketStructureDetailPane');
      return pane ? /Buka analisis/i.test(pane.textContent) : false;
    });
    console.log('  Detail click:', detailClick, '| Detail visible:', detailVisible);
    results.strukturPasar.detailVisible = detailVisible;

    fs.writeFileSync(path.join(OUT_DIR, 'struktur-pasar-elements.json'), JSON.stringify(results.strukturPasar, null, 2));
    await sp.close();

    // ── SUMMARY ──
    var summary = {
      timestamp: new Date().toISOString(),
      fase: 16,
      totalScreenshots: 16,
      pages: {
        insider: results.insider,
        ranking: results.ranking,
        financial: results.financial,
        strukturPasar: results.strukturPasar
      },
      q2Verification: results.financial.q2Tickers,
      perTanggalVerification: results.strukturPasar.perTanggalValues
    };
    fs.writeFileSync(path.join(OUT_DIR, 'fase16-results.json'), JSON.stringify(summary, null, 2));
    console.log('\n[FASE16] DONE. Results: fase16-results.json');
  } finally {
    await browser.close();
  }
}

run().catch(function(err) { console.error('[FASE16] FATAL:', err); process.exit(1); });
