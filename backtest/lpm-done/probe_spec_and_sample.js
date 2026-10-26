'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const remoteCode = `
const fs = require('fs');

let apiKey = '';
const envCandidates = [
  '/home/ubuntu/auto-cuan-runner/.env',
  '/home/ubuntu/auto-cuan/.env'
];
for (const f of envCandidates) {
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, 'utf8').match(/^ARJUM_API_KEY=(.*)$/m);
    if (m) { apiKey = m[1].trim().replace(/^['"]|['"]$/g, ''); break; }
  }
}

const BASE_URL = 'https://stock.arjum.com';
let requestCount = 0;
const MAX_REQUESTS = 15;
const RATE_LIMIT_DELAY_MS = 650;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeGet(pathAndQuery, noAuth = false) {
  if (requestCount >= MAX_REQUESTS) throw new Error('Limit reached');
  if (!noAuth) requestCount++;
  const url = BASE_URL + pathAndQuery;
  const t0 = Date.now();
  const headers = { 'Accept': 'application/json' };
  if (!noAuth) headers['X-API-Key'] = apiKey;

  try {
    const res = await fetch(url, { headers });
    const elapsed = Date.now() - t0;
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { data = text; }
    if (!noAuth) await sleep(RATE_LIMIT_DELAY_MS);
    return { status: res.status, elapsed, data, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (e) {
    if (!noAuth) await sleep(RATE_LIMIT_DELAY_MS);
    return { status: 0, error: e.message };
  }
}

async function main() {
  const result = {};

  // 1. Inspect openapi.json directly (no quota cost)
  const openapi = await safeGet('/openapi.json', true);
  if (openapi.status === 200 && openapi.data && openapi.data.paths) {
    result.allEndpoints = Object.keys(openapi.data.paths);
    for (const [p, spec] of Object.entries(openapi.data.paths)) {
      if (/done/i.test(p) || /detail/i.test(p) || /trade/i.test(p) || /order/i.test(p) || /flow/i.test(p)) {
        result.matchingSpec = { path: p, spec };
      }
    }
  }

  // 2. Fetch page 1 (100 rows) & page 2 (100 rows) for BRPT 2026-10-16
  const p1 = await safeGet('/api/done-details?code=BRPT&date=2026-10-16&page=1&per_page=100');
  const p2 = await safeGet('/api/done-details?code=BRPT&date=2026-10-16&page=2&per_page=100');

  let rows200 = [];
  if (p1.data && p1.data.data) rows200 = rows200.concat(p1.data.data);
  if (p2.data && p2.data.data) rows200 = rows200.concat(p2.data.data);
  result.rows200 = rows200;
  result.p1Stats = { total: p1.data?.total, total_pages: p1.data?.total_pages, elapsed: p1.elapsed, bytes: p1.bytes };

  // 3. Test exact date horizon bounds for BRPT (probe September dates)
  const dateProbes = ['2026-09-30', '2026-09-25', '2026-09-18', '2026-09-15', '2026-10-05', '2026-10-12'];
  result.dateBounds = {};
  for (const d of dateProbes) {
    const r = await safeGet(\`/api/done-details?code=BRPT&date=\${d}\`);
    result.dateBounds[d] = {
      status: r.status,
      total: r.data?.total || 0,
      rowsLength: r.data?.data?.length || 0,
      elapsed: r.elapsed
    };
  }

  // 4. Test board filter (board=NG vs board=TN)
  const ngRes = await safeGet('/api/done-details?code=BRPT&date=2026-10-16&board=NG');
  result.boardNG = {
    status: ngRes.status,
    total: ngRes.data?.total,
    sample: ngRes.data?.data?.[0]
  };

  result.totalApiRequestsUsed = requestCount;

  console.log('__PROBE3_START__');
  console.log(JSON.stringify(result, null, 2));
  console.log('__PROBE3_END__');
}

main().catch(err => { console.error(err); process.exit(1); });
`;

function run() {
  console.log('Running probe 3 (spec, 200 rows sample, date bounds)...');
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 25 * 1024 * 1024,
    encoding: 'utf8'
  });

  const sIdx = out.indexOf('__PROBE3_START__');
  const eIdx = out.indexOf('__PROBE3_END__');
  if (sIdx !== -1 && eIdx !== -1) {
    const jsonStr = out.slice(sIdx + '__PROBE3_START__'.length, eIdx).trim();
    const res = JSON.parse(jsonStr);

    console.log(`Executed ${res.totalApiRequestsUsed} paid API requests.`);
    console.log('Endpoints in OpenAPI:', res.allEndpoints);
    console.log('Matching spec:', JSON.stringify(res.matchingSpec, null, 2));
    console.log('Date Bounds:', JSON.stringify(res.dateBounds, null, 2));
    console.log('Board NG:', JSON.stringify(res.boardNG, null, 2));
    console.log(`Rows collected: ${res.rows200.length}`);

    // Save sample 200 rows
    const sampleFile = path.join(__dirname, 'sample_BRPT_20261016.json');
    fs.writeFileSync(sampleFile, JSON.stringify(res.rows200.slice(0, 200), null, 2));
    console.log(`Saved sample to ${sampleFile}`);

    // Save full probe output
    fs.writeFileSync(path.join(__dirname, 'probe3_full_output.json'), JSON.stringify(res, null, 2));
  } else {
    console.log(out);
  }
}

run();
