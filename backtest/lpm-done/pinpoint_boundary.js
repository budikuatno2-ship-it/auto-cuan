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
let count = 0;
const MAX = 4;
const DELAY = 650;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeGet(pathAndQuery) {
  if (count >= MAX) throw new Error('Limit reached');
  count++;
  const url = BASE_URL + pathAndQuery;
  const headers = { 'Accept': 'application/json', 'X-API-Key': apiKey };
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { data = text; }
    await sleep(DELAY);
    return { status: res.status, data };
  } catch (e) {
    await sleep(DELAY);
    return { status: 0, error: e.message };
  }
}

async function main() {
  const dates = ['2026-09-02', '2026-09-03', '2026-09-04'];
  const res = {};
  for (const d of dates) {
    const r = await safeGet(\`/api/done-details?code=BRPT&date=\${d}\`);
    res[d] = {
      status: r.status,
      total: r.data?.total ?? 0,
      rowsLen: r.data?.data?.length ?? 0
    };
  }

  console.log('__EARLIEST2_OUTPUT_START__');
  console.log(JSON.stringify({ count, res }, null, 2));
  console.log('__EARLIEST2_OUTPUT_END__');
}

main().catch(err => { console.error(err); process.exit(1); });
`;

function run() {
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8'
  });

  const sIdx = out.indexOf('__EARLIEST2_OUTPUT_START__');
  const eIdx = out.indexOf('__EARLIEST2_OUTPUT_END__');
  if (sIdx !== -1 && eIdx !== -1) {
    const jsonStr = out.slice(sIdx + '__EARLIEST2_OUTPUT_START__'.length, eIdx).trim();
    const res = JSON.parse(jsonStr);
    console.log('Boundary pinpoint:', JSON.stringify(res, null, 2));
  } else {
    console.log(out);
  }
}

run();
