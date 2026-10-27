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

async function getSep08Foreign() {
  // Use start_date and end_date as expected by Arjum endpoint
  const url = BASE_URL + '/api/broker-summary/BRPT?start_date=2026-09-08&end_date=2026-09-08&flow=F';
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'X-API-Key': apiKey }
  });
  const data = await res.json();
  console.log('Status:', res.status);
  console.log('Date returned:', data.broker_start_date, 'to', data.broker_end_date);
  console.log('Flow returned:', data.flow);
  console.log('Brokers count:', data.brokers ? data.brokers.length : 0);
  console.log('Levels count:', data.broker_levels ? data.broker_levels.length : 0);

  let buySum = 0, sellSum = 0, buyVol = 0, sellVol = 0;
  if (Array.isArray(data.broker_levels)) {
    data.broker_levels.forEach(lvl => {
      if (lvl.buy) { buySum += Number(lvl.buy.bval || 0); buyVol += Number(lvl.buy.bvol || 0); }
      if (lvl.sell) { sellSum += Number(lvl.sell.sval || 0); sellVol += Number(lvl.sell.svol || 0); }
    });
  }

  let brokersBuySum = 0, brokersSellSum = 0;
  if (Array.isArray(data.brokers)) {
    data.brokers.forEach(b => {
      brokersBuySum += Number(b.bval || 0);
      brokersSellSum += Number(b.sval || 0);
    });
  }

  console.log('broker_levels Buy Sum:', buySum, 'Sell Sum:', sellSum);
  console.log('brokers Buy Sum:', brokersBuySum, 'Sell Sum:', brokersSellSum);
  console.log('Brokers list:', JSON.stringify(data.brokers, null, 2));

  fs.writeFileSync('/tmp/brpt_20260908_flow_F.json', JSON.stringify(data, null, 2));
}

getSep08Foreign().catch(e => console.error(e));
`;

function main() {
  console.log('Executing 6th request: BRPT 2026-09-08 with start_date, end_date & flow=F...');
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8'
  });
  console.log(out);

  // Scp the result from /tmp to local
  execSync(`scp -o StrictHostKeyChecking=no -i "${SSH_KEY_PATH}" ${VPS_HOST}:/tmp/brpt_20260908_flow_F.json "${path.join(__dirname, 'brpt_20260908_flow_F.json')}"`);
  console.log('Saved to backtest/broksum/brpt_20260908_flow_F.json');
}

main();
