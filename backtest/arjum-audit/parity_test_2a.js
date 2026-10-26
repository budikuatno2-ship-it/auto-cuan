'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

// Remote: fetch /api/broker-accumulation for 5 tickers and compare to local module
const remote = `
const fs = require('fs');
const path = require('path');

let apiKey = '';
for (const f of ['/home/ubuntu/auto-cuan-runner/.env','/home/ubuntu/auto-cuan/.env']) {
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f,'utf8').match(/^ARJUM_API_KEY=(.*)$/m);
    if (m) { apiKey = m[1].trim().replace(/^['"]|['"]$/g,''); break; }
  }
}

const { computeBrokerAccumulation } = require('/home/ubuntu/auto-cuan/lib/broker-accumulation-local.js');

const DATA = '/home/ubuntu/auto-cuan/data/arjum-data';
const TICKERS = ['BRPT','BBCA','MEDC','ADRO','CASH'];
const results = [];

async function run() {
  for (const tk of TICKERS) {
    let api = null;
    try {
      const res = await fetch('https://stock.arjum.com/api/broker-accumulation/' + tk, {
        headers: { 'x-api-key': apiKey, Accept: 'application/json' }
      });
      if (res.ok) api = await res.json();
    } catch(e) {}

    const bsDir = path.join(DATA, 'broker-summary', tk);
    if (!api || !fs.existsSync(bsDir)) {
      results.push({ ticker: tk, error: api ? 'no_bs_dir' : 'api_fail' });
      continue;
    }

    const startDate = api.start_date, endDate = api.end_date;
    const days = fs.readdirSync(bsDir).filter(f=>f.endsWith('.json')&&f!=='latest.json')
      .map(f=>f.replace('.json','')).filter(d=>d>=startDate&&d<=endDate).sort();
    const dailySeries = days.map(d=>({ date:d, broksum: JSON.parse(fs.readFileSync(path.join(bsDir,d+'.json'),'utf8')) }));

    const local = computeBrokerAccumulation(tk, dailySeries, { startDate, endDate });

    // Compare top buyers/sellers sets
    const apiBuy = (api.top_buyers||[]).map(b=>b.broker_code);
    const locBuy = (local.top_buyers||[]).map(b=>b.broker_code);
    const apiSell = (api.top_sellers||[]).map(b=>b.broker_code);
    const locSell = (local.top_sellers||[]).map(b=>b.broker_code);

    // Point-level compare on shared series brokers
    let pts=0, match=0;
    (api.series||[]).forEach(apiItem=>{
      const locItem = (local.series||[]).find(s=>s.broker_code===apiItem.broker_code);
      if (!locItem) return;
      (apiItem.points||[]).forEach(ap=>{
        pts++;
        const lp = (locItem.points||[]).find(p=>p.date===ap.date);
        if (lp && lp.nval===ap.nval) match++;
      });
    });

    results.push({
      ticker: tk,
      range: [startDate, endDate],
      days: days.length,
      apiBrokers: (api.series||[]).length,
      localBrokers: (local.series||[]).length,
      topBuyersMatch: JSON.stringify(apiBuy)===JSON.stringify(locBuy),
      topSellersMatch: JSON.stringify(apiSell)===JSON.stringify(locSell),
      apiBuy, locBuy, apiSell, locSell,
      pointMatchPct: pts>0 ? (100*match/pts).toFixed(1)+'%' : 'n/a',
      pointCount: pts, pointMatch: match
    });
  }
  console.log('__PARITY__'+JSON.stringify(results));
}
run().catch(e=>{ console.log('__PARITY_ERR__'+e.message); });
`;

console.log('Running 2a parity test (5 API requests)...');
const out = execSync(`ssh -o StrictHostKeyChecking=no -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
  input: remote, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024
});

const line = out.split('\n').find(l => l.includes('__PARITY__'));
if (line) {
  const data = JSON.parse(line.slice(line.indexOf('__PARITY__') + 10));
  console.log(JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(__dirname, 'parity_test_2a_result.json'), JSON.stringify(data, null, 2));
} else {
  console.log('Output:', out);
}