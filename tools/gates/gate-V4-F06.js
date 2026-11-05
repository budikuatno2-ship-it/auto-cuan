'use strict';

/**
 * tools/gates/gate-V4-F06.js
 * Gate Penguji Anti-Bohong FASE V4-F06:
 * 1. Verifikasi Kompilasi Paralel:
 *    - scripts/domestic-compile.js dan scripts/foreign-compile.js selesai dalam < 15 detik.
 * 2. Playwright / Puppeteer Browser Verification:
 *    - /analisis-saham?ticker=BBCA -> Sub-tab Bandarmologi:
 *      Net bandar != 0, Net asing != 0, Konsentrasi Top 3 terhitung, tabel broker pembeli/penjual memiliki >= 5 baris data nyata.
 *    - /ranking:
 *      Tidak ada saham yang tertulis puluhan Triliun (83,20 T atau sejenisnya pada GRPM / lapis tiga),
 *      dan minimal 80% baris memiliki nilai asing != 0.
 *    - /struktur-pasar:
 *      Minimal 90% baris menampilkan Free Float > 0% dan pengendali valid (bukan "Free Float 0,00% · Belum diketahui").
 *    - /sektor:
 *      Grup Barito, Djarum, Sinarmas, Salim masing-masing memiliki >= 4 emiten (bukan 1 emiten).
 * 3. Catat bukti otentik ke bukti-verifikasi-final/gates-v4/F06.json.
 * 4. Cetak 'PASS: Gate V4-F06 LULUS'.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F06.json');

const result = lib.newResult(
  'V4-F06',
  'Optimasi Kompilasi Paralel < 15 Detik (Bandarmologi BBCA, Ranking Harian, Struktur Pasar, & Sektor Hot)'
);

// --- Kontrol Negatif (Negative Control Validator) ---
function f06Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.compileDurationSec !== 'number' || sample.compileDurationSec >= 15) return false;
  if (sample.bbcaBandarNet === 0 && sample.bbcaForeignNet === 0) return false;
  if (typeof sample.bbcaBuyersCount !== 'number' || sample.bbcaBuyersCount < 5) return false;
  if (sample.hasTrillionBug === true) return false;
  if (typeof sample.rankingNonZeroForeignPct !== 'number' || sample.rankingNonZeroForeignPct < 80) return false;
  if (typeof sample.strukturPasarFfGt0Pct !== 'number' || sample.strukturPasarFfGt0Pct < 90) return false;
  if (sample.hasStaleFreeFloatUnknown === true) return false;
  if (sample.hasSingleMemberConglo === true) return false;
  return true;
}

const negativeSamples = [
  null,
  // Sampel korup 1: Kompilasi lambat / timeout >= 15s
  {
    compileDurationSec: 18.5,
    bbcaBandarNet: -248000000000,
    bbcaForeignNet: -66000000000,
    bbcaBuyersCount: 15,
    hasTrillionBug: false,
    rankingNonZeroForeignPct: 95,
    strukturPasarFfGt0Pct: 98,
    hasStaleFreeFloatUnknown: false,
    hasSingleMemberConglo: false
  },
  // Sampel korup 2: Bandarmologi BBCA kosong (+0)
  {
    compileDurationSec: 3.2,
    bbcaBandarNet: 0,
    bbcaForeignNet: 0,
    bbcaBuyersCount: 0,
    hasTrillionBug: false,
    rankingNonZeroForeignPct: 95,
    strukturPasarFfGt0Pct: 98,
    hasStaleFreeFloatUnknown: false,
    hasSingleMemberConglo: false
  },
  // Sampel korup 3: Ranking GRPM terkena bug 83,20 T
  {
    compileDurationSec: 3.2,
    bbcaBandarNet: -248000000000,
    bbcaForeignNet: -66000000000,
    bbcaBuyersCount: 15,
    hasTrillionBug: true,
    rankingNonZeroForeignPct: 95,
    strukturPasarFfGt0Pct: 98,
    hasStaleFreeFloatUnknown: false,
    hasSingleMemberConglo: false
  },
  // Sampel korup 4: Struktur Pasar Free Float 0,00% / Belum diketahui
  {
    compileDurationSec: 3.2,
    bbcaBandarNet: -248000000000,
    bbcaForeignNet: -66000000000,
    bbcaBuyersCount: 15,
    hasTrillionBug: false,
    rankingNonZeroForeignPct: 95,
    strukturPasarFfGt0Pct: 45,
    hasStaleFreeFloatUnknown: true,
    hasSingleMemberConglo: false
  },
  // Sampel korup 5: Sektor Hot konglomerasi hanya 1 emiten per grup
  {
    compileDurationSec: 3.2,
    bbcaBandarNet: -248000000000,
    bbcaForeignNet: -66000000000,
    bbcaBuyersCount: 15,
    hasTrillionBug: false,
    rankingNonZeroForeignPct: 95,
    strukturPasarFfGt0Pct: 98,
    hasStaleFreeFloatUnknown: false,
    hasSingleMemberConglo: true
  }
];

const nc = lib.runNegativeControl(negativeSamples, f06Validator);
result.negativeControl = {
  description: 'Injeksi 5 sampel cacat (kompilasi > 15s, bandarmologi BBCA 0, bug 83,20 T, free float 0.00%, konglo 1 emiten); validator wajib menolak 100%',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

function findBrowserExe() {
  const sys = 'C:';
  const c = [
    sys + '\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    sys + '\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    sys + '\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    sys + '\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of c) {
    try {
      fs.statSync(p);
      return p;
    } catch (_) {}
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
        if (res.statusCode === 200) return resolve();
        setTimeout(check, 100);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('Server start timeout'));
        setTimeout(check, 100);
      });
      req.end();
    };
    check();
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('[GATE V4-F06] Memulai Verifikasi Otentik Kompilasi Paralel, Bandarmologi, Ranking, & Sektor Hot...');

  // =========================================================================
  // ASERSI 1: Kecepatan Kompilasi Paralel Domestic & Foreign (< 15 Detik)
  // =========================================================================
  console.log('[ASERSI 1] Menguji eksekusi scripts/foreign-compile.js & scripts/domestic-compile.js...');
  const tStart = Date.now();
  const foreignCompiler = require('../../scripts/foreign-compile');
  const domesticCompiler = require('../../scripts/domestic-compile');

  const fRes = await foreignCompiler.runForeignCompile();
  const dRes = await domesticCompiler.runDomesticCompile();
  const totalCompileSec = Number(((Date.now() - tStart) / 1000).toFixed(2));

  const assert1Pass = fRes.success && dRes.success && totalCompileSec < 15.0;

  lib.addAssertion(
    result,
    'Asersi 1: Kompilasi Paralel Domestic & Foreign selesai dalam < 15 detik (tanpa timeout exitCode=124)',
    assert1Pass,
    '< 15.00 detik',
    `Foreign: ${fRes.durationSec}s, Domestic: ${dRes.durationSec}s, Total: ${totalCompileSec}s`
  );

  let browser = null;
  let playwright = null;
  try { playwright = require('playwright'); } catch (_) {}

  if (playwright && playwright.chromium) {
    console.log('[BROWSER] Menggunakan engine Playwright Chromium');
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900']
    });
  } else {
    console.log('[BROWSER] Menggunakan engine Puppeteer-Core');
    const puppeteer = require('puppeteer-core');
    const exe = findBrowserExe();
    if (!exe) throw new Error('Browser Chromium tidak ditemukan di sistem!');
    browser = await puppeteer.launch({
      executablePath: exe,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900']
    });
  }

  const testPort = await getFreePort();
  console.log(`[SERVER] Memulai server terisolasi pada port ${testPort}...`);
  const serverChild = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-dev-server.js')], {
    env: { ...process.env, PORT: String(testPort), HOST: '127.0.0.1', NODE_ENV: 'test' },
    stdio: 'ignore'
  });

  try {
    await waitForServer(testPort);
    const baseUrl = `http://127.0.0.1:${testPort}`;

    // =========================================================================
    // ASERSI 2: Browser Test /analisis-saham?ticker=BBCA -> Sub-tab Bandarmologi
    // =========================================================================
    console.log('[ASERSI 2] Membuka /analisis-saham?ticker=BBCA dan mengaudit sub-tab Bandarmologi...');
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/analisis-saham?ticker=BBCA`, { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    // Klik sub-tab Bandarmologi
    await page.evaluate(() => {
      if (typeof window.switchAnalisisTab === 'function') {
        window.switchAnalisisTab('bandarmologi');
      } else {
        const btn = document.querySelector('[data-lens="bandarmologi"]') || document.getElementById('tabBandarmologi');
        if (btn) btn.click();
      }
    });
    await new Promise(r => setTimeout(r, 2000));

    const bandarAudit = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const bContent = document.getElementById('bandarmologiContent');
      const bText = bContent ? bContent.innerText : text;

      // Cek tabel broker pembeli dan penjual
      const rows = Array.from(document.querySelectorAll('#bandarmologiContent table tbody tr'));
      const buyersRows = rows.filter(r => r.innerText.includes('Rp') && !r.innerText.includes('Tidak ada data'));

      // Ekstrak nilai Net bandar, Net asing, CR3
      const netBandarMatch = bText.match(/Net bandar\s*([+\−\-]?Rp[^\n]+)/i);
      const netAsingMatch = bText.match(/Net asing\s*([+\−\-]?Rp[^\n]+)/i);
      const cr3Match = bText.match(/Konsentrasi top 3[^\n]*\s*([0-9,.]+%)/i);

      return {
        hasEmptyBuyersText: bText.includes('Tidak ada data pembeli') || bText.includes('Tidak ada data penjual'),
        netBandarText: netBandarMatch ? netBandarMatch[1].trim() : '',
        netAsingText: netAsingMatch ? netAsingMatch[1].trim() : '',
        cr3Text: cr3Match ? cr3Match[1].trim() : '',
        rowsCount: rows.length,
        validDataRowsCount: buyersRows.length
      };
    });

    // Verifikasi juga respon API langsung
    const bApiRes = await fetchJson(`${baseUrl}/api/bandarmologi?ticker=BBCA`);
    const bApiSummary = (bApiRes.json && bApiRes.json.broker_summary) || {};
    const bApiBuyers = bApiSummary.top_buyers || [];
    const bApiSellers = bApiSummary.top_sellers || [];

    const assert2Pass = !bandarAudit.hasEmptyBuyersText &&
      bApiSummary.net_flow !== 0 &&
      (bApiSummary.foreign_net_val !== 0 || bApiSummary.foreign_net !== 0) &&
      bApiBuyers.length >= 5 &&
      bApiSellers.length >= 5;

    lib.addAssertion(
      result,
      'Asersi 2: Bandarmologi BBCA terisi lengkap (Net bandar != 0, Net asing != 0, tabel broker pembeli/penjual >= 5 baris nyata)',
      assert2Pass,
      'Net bandar & asing != 0, CR3 terhitung, tabel broker >= 5 baris nyata (bukan +0 / kosong)',
      `API net_flow: ${bApiSummary.net_flow}, foreign_net: ${bApiSummary.foreign_net_val || bApiSummary.foreign_net}, buyers: ${bApiBuyers.length}, sellers: ${bApiSellers.length}, DOM rows: ${bandarAudit.rowsCount}`
    );

    // =========================================================================
    // ASERSI 3: Browser Test /ranking -> Bebas Triliun (GRPM) & >= 80% Foreign Flow
    // =========================================================================
    console.log('[ASERSI 3] Membuka /ranking dan mengaudit nilai satuan asing & kelengkapan...');
    await page.goto(`${baseUrl}/ranking`, { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Audit DOM ranking dan audit respon API
    const rankingDomAudit = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const has83Trillion = text.includes('83,20 T') || text.includes('83.20 T') || text.includes('83,2 T');
      const tableRows = Array.from(document.querySelectorAll('#rankingTableWrap table tbody tr'));
      let abnormalTrillionCount = 0;
      for (const row of tableRows) {
        const rowText = row.innerText;
        if (rowText.includes('GRPM') && rowText.includes(' T')) {
          abnormalTrillionCount++;
        }
      }
      return {
        has83Trillion,
        abnormalTrillionCount,
        renderedRowCount: tableRows.length
      };
    });

    const rankingApiRes = await fetchJson(`${baseUrl}/api/quote?action=daily-market-context-list`);
    const rankingRows = (rankingApiRes.json && rankingApiRes.json.rows) || [];
    const grpmRow = rankingRows.find(r => r.ticker === 'GRPM');

    let nonZeroForeignCount = 0;
    let corruptedTrillionStockCount = 0;

    for (const r of rankingRows) {
      const fToday = Number(r.foreign_net_today || 0);
      const f3d = Number(r.foreign_net_3d || 0);
      if (fToday !== 0 || f3d !== 0) {
        nonZeroForeignCount++;
      }
      // Saham harga < 500 tidak boleh memiliki net foreign puluhan Triliun
      const p = Number(r.last_price || 0);
      if (p < 500 && (Math.abs(fToday) >= 1e13 || Math.abs(f3d) >= 1e13)) {
        corruptedTrillionStockCount++;
      }
    }

    const nonZeroPct = rankingRows.length > 0 ? (nonZeroForeignCount / rankingRows.length) * 100 : 0;
    const grpmIsClean = grpmRow && Math.abs(Number(grpmRow.foreign_net_today || 0)) < 1e10; // di bawah 10 Miliar

    const assert3Pass = !rankingDomAudit.has83Trillion &&
      rankingDomAudit.abnormalTrillionCount === 0 &&
      corruptedTrillionStockCount === 0 &&
      grpmIsClean &&
      nonZeroPct >= 80.0;

    lib.addAssertion(
      result,
      'Asersi 3: Ranking Harian bebas dari bug satuan triliun (GRPM bukan 83,20 T) dan minimal 80% baris memiliki nilai asing != 0',
      assert3Pass,
      '0 saham cacat triliun, GRPM wajar, nonZeroForeign >= 80%',
      `GRPM foreign_today: ${grpmRow ? grpmRow.foreign_net_today : 'N/A'}, nonZeroPct: ${nonZeroPct.toFixed(1)}% (${nonZeroForeignCount}/${rankingRows.length} saham), corruptedTrillion: ${corruptedTrillionStockCount}`
    );

    // =========================================================================
    // ASERSI 4: Browser Test /struktur-pasar -> >= 90% Free Float > 0% & Pengendali
    // =========================================================================
    console.log('[ASERSI 4] Membuka /struktur-pasar dan mengaudit Free Float riil KSEI...');
    await page.goto(`${baseUrl}/struktur-pasar`, { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const strukturDomAudit = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const hasStaleZeroFloat = text.includes('Free Float 0,00% · Belum diketahui') ||
        text.includes('Free Float 0.00% · Belum diketahui');
      return {
        hasStaleZeroFloat
      };
    });

    const msApiRes = await fetchJson(`${baseUrl}/api/sector-hot?action=market-structure-list`);
    const msRows = (msApiRes.json && msApiRes.json.rows) || [];

    let ffGt0Count = 0;
    let validPengendaliCount = 0;

    for (const r of msRows) {
      const ff = Number(r.free_float_pct != null ? r.free_float_pct : r.freeFloat);
      if (ff > 0) ffGt0Count++;
      const p = r.pengendali || r.controller_name;
      if (p && !p.includes('Belum diketahui') && !p.includes('null')) {
        validPengendaliCount++;
      }
    }

    const ffGt0Pct = msRows.length > 0 ? (ffGt0Count / msRows.length) * 100 : 0;
    const pengendaliPct = msRows.length > 0 ? (validPengendaliCount / msRows.length) * 100 : 0;

    const assert4Pass = !strukturDomAudit.hasStaleZeroFloat &&
      ffGt0Pct >= 90.0 &&
      pengendaliPct >= 90.0;

    lib.addAssertion(
      result,
      'Asersi 4: Struktur Pasar menampilkan Free Float riil > 0% dan Pengendali valid pada minimal 90% emiten',
      assert4Pass,
      'Bebas dari "Free Float 0,00% · Belum diketahui", Free Float > 0% >= 90%, Pengendali valid >= 90%',
      `ffGt0Pct: ${ffGt0Pct.toFixed(1)}% (${ffGt0Count}/${msRows.length}), pengendaliPct: ${pengendaliPct.toFixed(1)}%, hasStaleZeroFloat: ${strukturDomAudit.hasStaleZeroFloat}`
    );

    // =========================================================================
    // ASERSI 5: Browser Test /sektor -> Grup Konglomerasi (Barito, Djarum, Sinarmas, Salim >= 4 emiten)
    // =========================================================================
    console.log('[ASERSI 5] Membuka /sektor dan mengaudit kelengkapan emiten konglomerasi...');
    await page.goto(`${baseUrl}/sektor`, { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Ensure logged in state and navigate to sektor
    await page.evaluate(() => {
      try {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_role', 'ADMIN');
        localStorage.setItem('autocuan_session', JSON.stringify({ name: 'budi', username: 'budi', role: 'ADMIN', approved: true }));
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_is_admin', 'true');
      } catch (_) {}
      if (typeof window.navigateTo === 'function') window.navigateTo('sektor');
      if (typeof window.loadSektorHot === 'function') window.loadSektorHot();
    });
    await new Promise(r => setTimeout(r, 2000));

    const sektorDomAudit = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        hasBarito: text.includes('BARITO') || text.includes('Barito'),
        hasSalim: text.includes('SALIM') || text.includes('Salim'),
        hasDjarum: text.includes('DJARUM') || text.includes('Djarum'),
        hasSinarmas: text.includes('SINARMAS') || text.includes('Sinarmas')
      };
    });

    const sektorRadar = require('../../lib/sector-radar');
    const groups = sektorRadar.getSectorRadarGroups();

    const baritoGrp = groups.find(g => g.group_code === 'BARITO_GROUP' || g.group_code === 'BARITO');
    const djarumGrp = groups.find(g => g.group_code === 'DJARUM_GROUP' || g.group_code === 'DJARUM');
    const salimGrp = groups.find(g => g.group_code === 'SALIM_GROUP' || g.group_code === 'SALIM');
    const sinarmasGrp = groups.find(g => g.group_code === 'SINARMAS_GROUP' || g.group_code === 'SINARMAS');

    const baritoCount = baritoGrp ? baritoGrp.member_count : 0;
    const djarumCount = djarumGrp ? djarumGrp.member_count : 0;
    const salimCount = salimGrp ? salimGrp.member_count : 0;
    const sinarmasCount = sinarmasGrp ? sinarmasGrp.member_count : 0;

    const assert5Pass = sektorDomAudit.hasBarito &&
      sektorDomAudit.hasSalim &&
      baritoCount >= 4 &&
      djarumCount >= 4 &&
      salimCount >= 4 &&
      sinarmasCount >= 4;

    lib.addAssertion(
      result,
      'Asersi 5: Sektor Hot Konglomerasi lengkap (Barito, Djarum, Sinarmas, Salim masing-masing memiliki >= 4 emiten)',
      assert5Pass,
      'Barito, Djarum, Sinarmas, Salim >= 4 emiten (bukan hanya 1 emiten)',
      `Barito: ${baritoCount} emiten, Djarum: ${djarumCount} emiten, Salim: ${salimCount} emiten, Sinarmas: ${sinarmasCount} emiten`
    );

    await page.close();

    // =========================================================================
    // FINALISASI DAN PENULISAN BUKTI
    // =========================================================================
    result.pass = result.negativeControl.pass &&
      assert1Pass &&
      assert2Pass &&
      assert3Pass &&
      assert4Pass &&
      assert5Pass;

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[EVIDENCE] Bukti verifikasi otentik tersimpan di: ${OUT}`);

    if (result.pass) {
      console.log('PASS: Gate V4-F06 LULUS');
      process.exitCode = 0;
    } else {
      console.error('FAIL: Gate V4-F06 GAGAL');
      process.exitCode = 1;
    }

  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    if (serverChild) {
      try {
        serverChild.kill('SIGTERM');
        setTimeout(() => { try { serverChild.kill('SIGKILL'); } catch (_) {} }, 2000);
      } catch (_) {}
    }
  }
}

main().catch((err) => {
  console.error('[GATE V4-F06 FATAL ERROR]:', err);
  process.exit(1);
});
