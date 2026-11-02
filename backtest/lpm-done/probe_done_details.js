'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

// The remote script to run on VPS Node
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

if (!apiKey) {
  console.error(JSON.stringify({ error: 'ARJUM_API_KEY not found in candidate files' }));
  process.exit(1);
}

const BASE_URL = 'https://stock.arjum.com';
let totalRequests = 0;
const MAX_REQUESTS = 40;
const RATE_LIMIT_DELAY_MS = 600; // <= 2 requests per second

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function safeGet(endpointPath, options = {}) {
  if (totalRequests >= MAX_REQUESTS) {
    throw new Error('HARD LIMIT EXCEEDED: Total requests exceeded ' + MAX_REQUESTS);
  }

  totalRequests++;
  const url = endpointPath.startsWith('http') ? endpointPath : BASE_URL + endpointPath;
  const t0 = Date.now();

  const headers = {
    'Accept': 'application/json',
    'X-API-Key': apiKey
  };
  if (options.noAuth) {
    delete headers['X-API-Key'];
  }

  let res, body, isJson = false;
  try {
    res = await fetch(url, { method: 'GET', headers });
    const elapsed = Date.now() - t0;
    const contentType = res.headers.get('content-type') || '';

    // Collect relevant response headers (quota, ratelimit, server info)
    const headerDump = {};
    for (const [k, v] of res.headers.entries()) {
      if (/rate|quota|limit|remain|reset|retry|time/i.test(k)) {
        headerDump[k] = v;
      }
    }

    let text = await res.text();
    try {
      body = JSON.parse(text);
      isJson = true;
    } catch (_) {
      body = text.slice(0, 1000);
    }

    await sleep(RATE_LIMIT_DELAY_MS);

    return {
      requestNum: totalRequests,
      url: endpointPath,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: elapsed,
      responseBytes: Buffer.byteLength(text, 'utf8'),
      headers: headerDump,
      isJson,
      data: body
    };
  } catch (err) {
    await sleep(RATE_LIMIT_DELAY_MS);
    return {
      requestNum: totalRequests,
      url: endpointPath,
      status: 0,
      error: err.message
    };
  }
}

async function run() {
  const probeLog = [];

  // Probe 1: Check openapi.json documentation if available
  const openapiRes = await safeGet('/openapi.json', { noAuth: true });
  let openapiDoneDetails = null;
  if (openapiRes.status === 200 && openapiRes.isJson) {
    const paths = openapiRes.data.paths || {};
    for (const p of Object.keys(paths)) {
      if (/done-details|done|order/i.test(p)) {
        openapiDoneDetails = { path: p, spec: paths[p] };
      }
    }
  }
  probeLog.push({
    test: '1. Check OpenAPI Spec',
    result: openapiRes.status === 200 ? 'Available' : 'Status ' + openapiRes.status,
    endpointFound: openapiDoneDetails
  });

  // Probe 2: Call /api/done-details with NO parameters
  const noParamRes = await safeGet('/api/done-details');
  probeLog.push({
    test: '2. Call without parameters',
    status: noParamRes.status,
    response: noParamRes.data,
    headers: noParamRes.headers
  });

  // Probe 3: Call with symbol only: /api/done-details/BRPT or ?symbol=BRPT or ?code=BRPT
  // Let us inspect what error probe 2 produced to guide probe 3
  const probe2Data = noParamRes.data;
  let paramStyle = 'query';
  let tickerParam = 'code';

  // Test /api/done-details/BRPT vs /api/done-details?code=BRPT
  const pathStyleRes = await safeGet('/api/done-details/BRPT');
  probeLog.push({
    test: '3. Call /api/done-details/BRPT (path param)',
    status: pathStyleRes.status,
    response: pathStyleRes.data
  });

  const queryCodeRes = await safeGet('/api/done-details?code=BRPT');
  probeLog.push({
    test: '4. Call /api/done-details?code=BRPT',
    status: queryCodeRes.status,
    response: queryCodeRes.data
  });

  const queryTickerRes = await safeGet('/api/done-details?ticker=BRPT');
  probeLog.push({
    test: '5. Call /api/done-details?ticker=BRPT',
    status: queryTickerRes.status,
    response: queryTickerRes.data
  });

  const queryStockRes = await safeGet('/api/done-details?stock_code=BRPT');
  probeLog.push({
    test: '6. Call /api/done-details?stock_code=BRPT',
    status: queryStockRes.status,
    response: queryStockRes.data
  });

  console.log('__PROBE_OUTPUT_START__');
  console.log(JSON.stringify({ totalRequests, probeLog }, null, 2));
  console.log('__PROBE_OUTPUT_END__');
}

run().catch(err => {
  console.error('Run error:', err);
  process.exit(1);
});
`;

function main() {
  console.log('Executing minimal initial probe via VPS...');
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8'
  });

  const startMarker = '__PROBE_OUTPUT_START__';
  const endMarker = '__PROBE_OUTPUT_END__';
  const sIdx = out.indexOf(startMarker);
  const eIdx = out.indexOf(endMarker);

  if (sIdx !== -1 && eIdx !== -1) {
    const jsonStr = out.slice(sIdx + startMarker.length, eIdx).trim();
    const data = JSON.parse(jsonStr);
    console.log('Probe results:');
    console.log(JSON.stringify(data, null, 2));
    fs.writeFileSync(path.join(__dirname, 'probe_initial_result.json'), JSON.stringify(data, null, 2));
  } else {
    console.log('Raw output:');
    console.log(out);
  }
}

main();
