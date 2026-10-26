'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const remoteCode = `
const fs = require('fs');
const p = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/BRPT/2026-09-08.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));

// 1. All Top Level Keys
console.log('--- ALL TOP LEVEL KEYS ---');
console.log(Object.keys(d));

// 2. Scan all nested paths and keys recursively
const allKeyPaths = new Set();
const foreignKeyMatches = [];

function walk(obj, prefix = '') {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    if (obj.length > 0) walk(obj[0], prefix + '[0].');
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    const fullPath = prefix + k;
    allKeyPaths.add(fullPath);
    if (/foreign|asing|investor|f_|_f|fval|fvol|dtype|ftype|buyer_type|seller_type/i.test(k)) {
      foreignKeyMatches.push({ key: fullPath, sampleValue: v });
    }
    if (v && typeof v === 'object') {
      walk(v, fullPath + '.');
    }
  }
}

walk(d);

console.log('\\n--- ALL DISTINCT KEY PATHS (SCHEMA TREE) ---');
console.log(Array.from(allKeyPaths));

console.log('\\n--- POTENTIAL FOREIGN / INVESTOR MATCHES ---');
console.log(foreignKeyMatches);

// 3. Inspect d.flow or any other scalar/object in detail
console.log('\\n--- DETAILED INSPECTION OF FLOW & BROKER_NET ---');
console.log('flow:', d.flow);
console.log('broker_net:', d.broker_net);
console.log('broker_start_date:', d.broker_start_date);
console.log('broker_end_date:', d.broker_end_date);
console.log('broker_date_min:', d.broker_date_min);
console.log('broker_date_max:', d.broker_date_max);

// 4. Sample first broker and first broker_level in full JSON
console.log('\\n--- SAMPLE BROKER[0] RAW JSON ---');
console.log(JSON.stringify(d.brokers[0], null, 2));

console.log('\\n--- SAMPLE BROKER_LEVELS[0] RAW JSON ---');
console.log(JSON.stringify(d.broker_levels[0], null, 2));
`;

function main() {
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 15 * 1024 * 1024,
    encoding: 'utf8'
  });
  console.log(out);
  fs.writeFileSync(path.join(__dirname, 'raw_schema_sample.txt'), out);
}

main();
