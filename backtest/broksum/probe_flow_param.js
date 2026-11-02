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

if (!apiKey) {
  console.error('No API key found on VPS');
  process.exit(1);
}

const BASE_URL = 'https://stock.arjum.com';
let requestCount = 0;
const MAX_REQUESTS = 6; // STRICT LIMIT: <= 6 requests
const RATE_LIMIT_DELAY_MS = 650; // max 2 req/sec

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testFlow(flowParam) {
  if (requestCount >= MAX_REQUESTS) throw new Error('Hard limit of 6 requests reached');
  requestCount++;

  const url = BASE_URL + '/api/broker-summary/BRPT?date=2026-09-08&flow=' + encodeURIComponent(flowParam);
  const t0 = Date.now();
  const headers = {
    'Accept': 'application/json',
    'X-API-Key': apiKey
  };

  try {
    const res = await fetch(url, { headers });
    const elapsed = Date.now() - t0;
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = text; }

    await sleep(RATE_LIMIT_DELAY_MS);

    // Analyze data structure
    let buySum = 0, sellSum = 0, buyVol = 0, sellVol = 0;
    if (data && Array.isArray(data.broker_levels)) {
      data.broker_levels.forEach(lvl => {
        if (lvl.buy) { buySum += Number(lvl.buy.bval || 0); buyVol += Number(lvl.buy.bvol || 0); }
        if (lvl.sell) { sellSum += Number(lvl.sell.sval || 0); sellVol += Number(lvl.sell.svol || 0); }
      });
    }

    let brokersBuySum = 0, brokersSellSum = 0;
    if (data && Array.isArray(data.brokers)) {
      data.brokers.forEach(b => {
        brokersBuySum += Number(b.bval || 0);
        brokersSellSum += Number(b.sval || 0);
      });
    }

    return {
      flowParam,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: elapsed,
      responseFlowField: data ? data.flow : null,
      brokersCount: data && Array.isArray(data.brokers) ? data.brokers.length : 0,
      brokerLevelsCount: data && Array.isArray(data.broker_levels) ? data.broker_levels.length : 0,
      totalBuyVal: buySum,
      totalSellVal: sellSum,
      totalBuyVol: buyVol,
      totalSellVol: sellVol,
      brokersBuySum,
      brokersSellSum,
      sampleBrokers: data && Array.isArray(data.brokers) ? data.brokers.slice(0, 3) : null,
      error: data && data.detail ? data.detail : null,
      fullData: data
    };
  } catch (err) {
    await sleep(RATE_LIMIT_DELAY_MS);
    return { flowParam, status: 0, error: err.message };
  }
}

async function main() {
  const paramsToTest = ['foreign', 'asing', 'f', 'F', 'domestic'];
  const results = [];

  for (const p of paramsToTest) {
    console.log('Testing flow=' + p + '...');
    const r = await testFlow(p);
    results.push(r);
  }

  console.log('__FLOW_PROBE_START__');
  console.log(JSON.stringify({ requestCount, results }, null, 2));
  console.log('__FLOW_PROBE_END__');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
`;

function run() {
  console.log('Executing Flow Probe (max 5 requests) on VPS...');
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 25 * 1024 * 1024,
    encoding: 'utf8'
  });

  const s = out.indexOf('__FLOW_PROBE_START__');
  const e = out.indexOf('__FLOW_PROBE_END__');
  if (s !== -1 && e !== -1) {
    const jsonStr = out.slice(s + '__FLOW_PROBE_START__'.length, e).trim();
    const parsed = JSON.parse(jsonStr);
    console.log(`Executed ${parsed.requestCount} requests.`);
    fs.writeFileSync(path.join(__dirname, 'flow_probe_results.json'), JSON.stringify(parsed, null, 2));
    console.log('Saved to flow_probe_results.json');
  } else {
    console.log(out);
  }
}

run();
