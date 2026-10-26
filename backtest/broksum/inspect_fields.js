'use strict';

const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const remoteCode = `
const fs = require('fs');
const p = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/BRPT/2026-09-08.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));

console.log('Top level keys:', Object.keys(d));
console.log('Flow object/val:', JSON.stringify(d.flow));

// Check if any broker has board or investor type
let hasInvestorType = false;
let hasBoard = false;
for (const b of (d.brokers || [])) {
  if (b.type || b.investor_type || b.buyer_type || b.seller_type) hasInvestorType = true;
  if (b.board || b.market_board) hasBoard = true;
}
console.log('Brokers has investor type field:', hasInvestorType);
console.log('Brokers has board field:', hasBoard);

// Print all brokers sorted by nval descending
console.log('\\nBrokers list (length: ' + d.brokers.length + '):');
const sorted = d.brokers.slice().sort((a,b) => b.nval - a.nval);
sorted.forEach(b => {
  console.log(b.broker_code + ' | bval: ' + b.bval + ' | sval: ' + b.sval + ' | nval: ' + b.nval + ' | bvol: ' + b.bvol + ' | svol: ' + b.svol);
});
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
