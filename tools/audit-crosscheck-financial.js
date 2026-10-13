const fs = require('fs');
const path = require('path');

const jsonPath = 'D:\\Auto-Cuan\\data-subset\\market-subset.json';
const rows = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const fundamentals = {};
const features = {};
const latestHistory = {};

rows.forEach(r => {
  const json = JSON.parse(r.row_json);
  if (r.table_name === 'stock_fundamentals') {
    fundamentals[r.row_key] = json;
  } else if (r.table_name === 'stock_daily_features') {
    features[r.row_key] = json;
  } else if (r.table_name === 'stock_daily_history') {
    const ticker = json.ticker;
    const date = json.trade_date || json.date;
    if (!latestHistory[ticker] || date > latestHistory[ticker].date) {
      latestHistory[ticker] = {
        date,
        close: json.close || json.last_price
      };
    }
  }
});

const tickers = [
  'BBCA', 'BBRI', 'BMRI', 'BBNI', 'TLKM',
  'ASII', 'BREN', 'GOTO', 'ANTM', 'UNVR',
  'ICBP', 'GPRA', 'AMRT', 'BRIS', 'CPIN',
  'KLBF', 'SMGR', 'PGAS', 'MDKA', 'GIAA'
];

console.log('| Ticker | Tanggal | Harga (Rp) | Saham Beredar | Mcap Tampil (IDR) | Mcap Hitung (IDR) | Selisih % | PBV Tampil | PBV Hitung |');
console.log('|---|---|---|---|---|---|---|---|---|');

const results = [];

for (const t of tickers) {
  const fund = fundamentals[t] || {};
  const feat = features[t] || {};
  const hist = latestHistory[t] || {};

  const harga = hist.close || feat.last_price || 0;
  const date = hist.date || feat.as_of_trade_date || '-';
  const saham = fund.shares_outstanding || 0;
  const mcap_hitung = harga * saham;

  // Dynamic calculation displayed in API & UI
  const mcap_tampil = saham * harga;
  const diff_pct = mcap_hitung > 0 ? (Math.abs(mcap_tampil - mcap_hitung) / mcap_hitung * 100) : 0;

  let bvps = fund.bvps || fund.book_value_per_share || null;
  let pbv_hitung = null;
  if (bvps && bvps > 0) {
    pbv_hitung = Number((harga / bvps).toFixed(2));
  } else if (fund.equity && fund.equity > 0 && saham > 0) {
    const equityIdr = fund.equity * 1e9;
    bvps = equityIdr / saham;
    pbv_hitung = Number((harga / bvps).toFixed(2));
  }

  let pbv_tampil = fund.pbv ? Number(fund.pbv).toFixed(2) : (pbv_hitung ? pbv_hitung.toFixed(2) : 'N/A');

  const hargaFmt = harga.toLocaleString('id-ID');
  const sahamFmt = saham.toLocaleString('id-ID');
  const mcapTampilFmt = mcap_tampil.toLocaleString('id-ID');
  const mcapHitungFmt = mcap_hitung.toLocaleString('id-ID');
  const diffFmt = diff_pct.toFixed(2) + '%';
  const pbvTampilStr = pbv_tampil === 'N/A' ? 'N/A' : `${pbv_tampil}x`;
  const pbvHitungStr = pbv_hitung === null ? 'N/A' : `${pbv_hitung.toFixed(2)}x`;

  console.log(`| ${t} | ${date} | ${hargaFmt} | ${sahamFmt} | ${mcapTampilFmt} | ${mcapHitungFmt} | ${diffFmt} | ${pbvTampilStr} | ${pbvHitungStr} |`);
  results.push({
    ticker: t,
    date,
    harga,
    saham,
    mcap_tampil,
    mcap_hitung,
    diff_pct,
    pbv_tampil,
    pbv_hitung
  });
}

const maxDiff = Math.max(...results.map(r => r.diff_pct));
console.log(`\nMax Selisih: ${maxDiff.toFixed(2)}% (Batas Syarat: <= 1.00%)`);
