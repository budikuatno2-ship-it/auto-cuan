'use strict';

const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const remoteCode = `
const fs = require('fs');
const p = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/BRPT/2026-09-08.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));

console.log('Stock:', d.stock_code, 'Date min/max:', d.broker_date_min, d.broker_date_max);
console.log('Brokers array length:', d.brokers ? d.brokers.length : 'none');
if (d.brokers && d.brokers.length > 0) {
  console.log('Sample broker 0:', JSON.stringify(d.brokers[0], null, 2));
  console.log('Sample broker 1:', JSON.stringify(d.brokers[1], null, 2));
}

console.log('Broker levels array length:', d.broker_levels ? d.broker_levels.length : 'none');
if (d.broker_levels && d.broker_levels.length > 0) {
  console.log('Sample level 0:', JSON.stringify(d.broker_levels[0], null, 2));
}

console.log('broker_net:', JSON.stringify(d.broker_net));
`;

function main() {
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8'
  });
  console.log(out);
}

main();
