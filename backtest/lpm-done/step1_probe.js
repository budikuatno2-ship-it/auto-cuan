'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const remoteCode = `
const fs = require('fs');

let apiKey = '';
const envCandidates = ['/home/ubuntu/auto-cuan-runner/.env', '/home/ubuntu/auto-cuan/.env'];
for (const f of envCandidates) {
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, 'utf8').match(/^ARJUM_API_KEY=(.*)$/m);
    if (m) { apiKey = m[1].trim().replace(/^['"]|['"]$/g, ''); break; }
  }
}

const BASE_URL = 'https://stock.arjum.com';
let requestCount = 0;
const MAX_REQUESTS = 12;
const RATE_LIMIT_DELAY_MS = 650;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeGet(pathAndQuery) {
  if (requestCount >= MAX_REQUESTS) throw new Error('Limit reached: ' + MAX_REQUESTS);
  requestCount++;
  const url = BASE_URL + pathAndQuery;
  const t0 = Date.now();
  const headers = { 'Accept': 'application/json', 'X-API-Key': apiKey };
  try {
    const res = await fetch(url, { headers });
    const elapsed = Date.now() - t0;
    const allHeaders = {};
    for (const [k, v] of res.headers.entries()) {
      allHeaders[k] = v;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    await sleep(RATE_LIMIT_DELAY_MS);
    return {
      query: pathAndQuery,
      status: res.status,
      elapsed,
      headers: allHeaders,
      data
    };
  } catch (err) {
    await sleep(RATE_LIMIT_DELAY_MS);
    return { query: pathAndQuery, status: 0, error: err.message };
  }
}

async function main() {
  const report = {};

  // 1. Baseline: BRPT 16 Okt 2026, per_page=5
  const baseRes = await safeGet('/api/done-details?code=BRPT&date=2026-10-16&per_page=5');
  report.baseline = {
    status: baseRes.status,
    headers: baseRes.headers,
    total: baseRes.data?.total,
    sampleRows: baseRes.data?.data?.map(r => ({ time: r.time, price_num: r.price_num, qty_num: r.qty_num, value_raw: r.value_raw, action: r.action }))
  };

  // 2. Test 6 filters / sort parameters
  const paramsToTest = [
    'sort=value',
    'order=desc',
    'sort_by=value_raw',
    'min_value=500000000',
    'min_qty=1000',
    'side=BUY'
  ];

  report.paramTests = {};
  for (const param of paramsToTest) {
    const testRes = await safeGet(\`/api/done-details?code=BRPT&date=2026-10-16&per_page=5&\${param}\`);
    const isDifferentTotal = testRes.data?.total !== baseRes.data?.total;
    const isDifferentRows = JSON.stringify(testRes.data?.data) !== JSON.stringify(baseRes.data?.data);
    report.paramTests[param] = {
      status: testRes.status,
      total: testRes.data?.total,
      rowsLen: testRes.data?.data?.length,
      sampleRows: testRes.data?.data?.slice(0, 2).map(r => ({ time: r.time, price_num: r.price_num, qty_num: r.qty_num, value_raw: r.value_raw, action: r.action })),
      changesTotal: isDifferentTotal,
      changesRows: isDifferentRows,
      effective: isDifferentTotal || isDifferentRows
    };
  }

  // 3. Test frequency in 1 request endpoints: /api/movers vs /api/price/list
  const moversRes = await safeGet('/api/movers');
  report.movers = {
    status: moversRes.status,
    isJson: typeof moversRes.data === 'object',
    keys: typeof moversRes.data === 'object' ? Object.keys(moversRes.data) : null,
    sample: Array.isArray(moversRes.data) ? moversRes.data.slice(0, 3) : (moversRes.data?.data?.slice?.(0, 3) || moversRes.data)
  };

  const priceListRes = await safeGet('/api/price/list');
  report.priceList = {
    status: priceListRes.status,
    isJson: typeof priceListRes.data === 'object',
    keys: typeof priceListRes.data === 'object' ? Object.keys(priceListRes.data) : null,
    sample: Array.isArray(priceListRes.data) ? priceListRes.data.slice(0, 3) : (priceListRes.data?.data?.slice?.(0, 3) || priceListRes.data)
  };

  report.totalRequestsUsed = requestCount;

  console.log('__STEP1_START__');
  console.log(JSON.stringify(report, null, 2));
  console.log('__STEP1_END__');
}

main().catch(err => { console.error(err); process.exit(1); });
`;

function run() {
  console.log('Running Step 1 Probe on VPS...');
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 15 * 1024 * 1024,
    encoding: 'utf8'
  });

  const sIdx = out.indexOf('__STEP1_START__');
  const eIdx = out.indexOf('__STEP1_END__');
  if (sIdx !== -1 && eIdx !== -1) {
    const jsonStr = out.slice(sIdx + '__STEP1_START__'.length, eIdx).trim();
    const data = JSON.parse(jsonStr);
    console.log(`Probe Step 1 completed with ${data.totalRequestsUsed} requests.`);
    fs.writeFileSync(path.join(__dirname, 'step1_probe_result.json'), JSON.stringify(data, null, 2));
    console.log('Saved to step1_probe_result.json');
  } else {
    console.log(out);
  }
}

run();
