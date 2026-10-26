'use strict';

const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const remoteCode = `
const fs = require('fs');
const p = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/BRPT/2026-09-08.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));

// Check brokers map
const bMap = new Map();
if (Array.isArray(d.brokers)) {
  d.brokers.forEach(b => {
    bMap.set(b.broker_code, { bval: b.bval, sval: b.sval, nval: b.nval });
  });
}

// Check levels
const levelBuyers = [];
const levelSellers = [];
if (Array.isArray(d.broker_levels)) {
  d.broker_levels.forEach(lvl => {
    if (lvl.buy && lvl.buy.broker_code) levelBuyers.push(lvl.buy.broker_code);
    if (lvl.sell && lvl.sell.broker_code) levelSellers.push(lvl.sell.broker_code);
  });
}

console.log('Unique brokers in brokers array:', bMap.size);
console.log('Brokers in levels buy:', levelBuyers.length, 'sell:', levelSellers.length);

// Compare: are top net buyers in brokers array?
console.log('Top 3 in brokers array by nval:');
const byNet = Array.from(bMap.entries()).sort((a,b) => b[1].nval - a[1].nval);
console.log(byNet.slice(0, 5));
console.log('Bottom 3 in brokers array by nval:');
console.log(byNet.slice(-5));

// Check if all brokers in broker_levels can be merged:
const allBrokersFromLevels = new Map();
d.broker_levels.forEach(lvl => {
  if (lvl.buy && lvl.buy.broker_code) {
    const code = lvl.buy.broker_code;
    const cur = allBrokersFromLevels.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0 };
    cur.bval += Number(lvl.buy.bval || 0);
    cur.bvol += Number(lvl.buy.bvol || 0);
    allBrokersFromLevels.set(code, cur);
  }
  if (lvl.sell && lvl.sell.broker_code) {
    const code = lvl.sell.broker_code;
    const cur = allBrokersFromLevels.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0 };
    cur.sval += Number(lvl.sell.sval || 0);
    cur.svol += Number(lvl.sell.svol || 0);
    allBrokersFromLevels.set(code, cur);
  }
});

for (const [code, val] of allBrokersFromLevels.entries()) {
  val.nval = val.bval - val.sval;
  val.nvol = val.bvol - val.svol;
}

const levelsByNet = Array.from(allBrokersFromLevels.entries()).sort((a,b) => b[1].nval - a[1].nval);
console.log('Top 3 from merged levels:');
console.log(levelsByNet.slice(0, 5).map(x => [x[0], x[1].nval]));
console.log('Bottom 3 from merged levels:');
console.log(levelsByNet.slice(-5).map(x => [x[0], x[1].nval]));
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
