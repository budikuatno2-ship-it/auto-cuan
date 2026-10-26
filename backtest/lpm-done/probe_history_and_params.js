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
  '/home/ubuntu/auto-cuan/.env',
  '/home/ubuntu/auto-cuan/.env.ai-eval-once',
  '/home/ubuntu/auto-cuan/.env.local'
];
for (const f of envCandidates) {
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, 'utf8').match(/^ARJUM_API_KEY=(.*)$/m);
    if (m) {
      apiKey = m[1].trim().replace(/^['"]|['"]$/g, '');
      break;
    }
  }
}

const BASE_URL = 'https://stock.arjum.com';
let requestCount = 0;
const MAX_REQUESTS = 30; // within budget
const RATE_LIMIT_DELAY_MS = 650; // strictly <= 2 req/sec

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function safeGet(pathAndQuery) {
  if (requestCount >= MAX_REQUESTS) {
    throw new Error('Safety limit reached: ' + MAX_REQUESTS);
  }
  requestCount++;
  const url = BASE_URL + pathAndQuery;
  const t0 = Date.now();
  const headers = {
    'Accept': 'application/json',
    'X-API-Key': apiKey
  };

  try {
    const res = await fetch(url, { method: 'GET', headers });
    const elapsed = Date.now() - t0;
    const text = await res.text();
    const bytes = Buffer.byteLength(text, 'utf8');

    const quotaHeaders = {};
    for (const [k, v] of res.headers.entries()) {
      if (/rate|quota|limit|remain|reset|retry/i.test(k)) {
        quotaHeaders[k] = v;
      }
    }

    let parsed = null;
    try { parsed = JSON.parse(text); } catch(e) { parsed = text.slice(0, 500); }

    await sleep(RATE_LIMIT_DELAY_MS);
    return {
      reqNum: requestCount,
      query: pathAndQuery,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: elapsed,
      bytes: bytes,
      headers: quotaHeaders,
      data: parsed
    };
  } catch (err) {
    await sleep(RATE_LIMIT_DELAY_MS);
    return {
      reqNum: requestCount,
      query: pathAndQuery,
      status: 0,
      error: err.message
    };
  }
}

async function main() {
  const log = [];

  // 1. Test Date probes for BRPT
  // Dates to test: 2026-10-16, 2026-10-01, 2026-09-01, 2026-01-02
  const dateTests = ['2026-10-16', '2026-10-01', '2026-09-01', '2026-01-02'];
  for (const d of dateTests) {
    const res = await safeGet(\`/api/done-details?code=BRPT&date=\${d}\`);
    log.push({
      test: 'Date Probe BRPT ' + d,
      status: res.status,
      elapsedMs: res.elapsedMs,
      bytes: res.bytes,
      totalRecords: res.data ? res.data.total : null,
      returnedRows: res.data && res.data.data ? res.data.data.length : null,
      dateReturned: res.data ? res.data.date : null,
      headers: res.headers,
      firstRow: res.data && res.data.data && res.data.data[0] ? res.data.data[0] : null,
      error: res.data && res.data.detail ? res.data.detail : null
    });
  }

  // 2. Test Paging parameters: per_page, limit, page
  // Test per_page=200
  const perPage200 = await safeGet('/api/done-details?code=BRPT&date=2026-10-16&per_page=200');
  log.push({
    test: 'Paging per_page=200',
    status: perPage200.status,
    elapsedMs: perPage200.elapsedMs,
    bytes: perPage200.bytes,
    page: perPage200.data ? perPage200.data.page : null,
    per_page: perPage200.data ? perPage200.data.per_page : null,
    returnedRows: perPage200.data && perPage200.data.data ? perPage200.data.data.length : null
  });

  // Test per_page=500
  const perPage500 = await safeGet('/api/done-details?code=BRPT&date=2026-10-16&per_page=500');
  log.push({
    test: 'Paging per_page=500',
    status: perPage500.status,
    per_page: perPage500.data ? perPage500.data.per_page : null,
    returnedRows: perPage500.data && perPage500.data.data ? perPage500.data.data.length : null
  });

  // Test per_page=1000
  const perPage1000 = await safeGet('/api/done-details?code=BRPT&date=2026-10-16&per_page=1000');
  log.push({
    test: 'Paging per_page=1000',
    status: perPage1000.status,
    per_page: perPage1000.data ? perPage1000.data.per_page : null,
    returnedRows: perPage1000.data && perPage1000.data.data ? perPage1000.data.data.length : null
  });

  // Test page=2
  const page2 = await safeGet('/api/done-details?code=BRPT&date=2026-10-16&page=2&per_page=100');
  log.push({
    test: 'Paging page=2',
    status: page2.status,
    page: page2.data ? page2.data.page : null,
    returnedRows: page2.data && page2.data.data ? page2.data.data.length : null,
    firstRowTime: page2.data && page2.data.data && page2.data.data[0] ? page2.data.data[0].time : null
  });

  // 3. Test filter parameters: board=RG vs board=NG
  const boardRg = await safeGet('/api/done-details?code=BRPT&date=2026-10-16&board=RG');
  log.push({
    test: 'Filter board=RG',
    status: boardRg.status,
    totalRecords: boardRg.data ? boardRg.data.total : null,
    sampleBoard: boardRg.data && boardRg.data.data && boardRg.data.data[0] ? boardRg.data.data[0].market_board : null
  });

  const marketBoardRg = await safeGet('/api/done-details?code=BRPT&date=2026-10-16&market_board=RG');
  log.push({
    test: 'Filter market_board=RG',
    status: marketBoardRg.status,
    totalRecords: marketBoardRg.data ? marketBoardRg.data.total : null
  });

  // 4. Test BBCA on 2026-10-16
  const bbcaRes = await safeGet('/api/done-details?code=BBCA&date=2026-10-16&per_page=100');
  log.push({
    test: 'BBCA 2026-10-16',
    status: bbcaRes.status,
    elapsedMs: bbcaRes.elapsedMs,
    bytes: bbcaRes.bytes,
    totalRecords: bbcaRes.data ? bbcaRes.data.total : null,
    total_pages: bbcaRes.data ? bbcaRes.data.total_pages : null,
    returnedRows: bbcaRes.data && bbcaRes.data.data ? bbcaRes.data.data.length : null,
    headers: bbcaRes.headers
  });

  // 5. Fetch sample 200 rows of BRPT on 2026-10-16
  // If perPage200 worked and returned 200 rows, use that.
  let sample200 = [];
  if (perPage200.data && perPage200.data.data && perPage200.data.data.length >= 200) {
    sample200 = perPage200.data.data.slice(0, 200);
  } else if (perPage200.data && perPage200.data.data) {
    sample200 = perPage200.data.data.concat(page2.data && page2.data.data ? page2.data.data : []).slice(0, 200);
  }

  console.log('__PROBE2_OUTPUT_START__');
  console.log(JSON.stringify({
    requestCount,
    log,
    sample200Length: sample200.length,
    sample200: sample200
  }, null, 2));
  console.log('__PROBE2_OUTPUT_END__');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
`;

function runLocal() {
  console.log('Running probe_history_and_params.js on VPS...');
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 25 * 1024 * 1024,
    encoding: 'utf8'
  });

  const startMarker = '__PROBE2_OUTPUT_START__';
  const endMarker = '__PROBE2_OUTPUT_END__';
  const sIdx = out.indexOf(startMarker);
  const eIdx = out.indexOf(endMarker);

  if (sIdx !== -1 && eIdx !== -1) {
    const jsonStr = out.slice(sIdx + startMarker.length, eIdx).trim();
    const data = JSON.parse(jsonStr);

    console.log(`Executed ${data.requestCount} requests.`);
    console.log('Log summary:');
    data.log.forEach(l => {
      console.log(`  [${l.test}] status=${l.status}, elapsed=${l.elapsedMs}ms, bytes=${l.bytes || '-'}, totalRecords=${l.totalRecords}`);
    });

    // Save full result JSON
    fs.writeFileSync(path.join(__dirname, 'probe_detailed_result.json'), JSON.stringify(data.log, null, 2));

    // Save 200 sample rows
    if (data.sample200 && data.sample200.length > 0) {
      const samplePath = path.join(__dirname, 'sample_BRPT_20261016.json');
      fs.writeFileSync(samplePath, JSON.stringify(data.sample200, null, 2));
      console.log(`Saved ${data.sample200.length} rows to ${samplePath}`);
    }
  } else {
    console.log('Raw output:', out);
  }
}

runLocal();
