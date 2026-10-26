'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const remoteScript = `
const fs = require('fs');
const path = require('path');

const BASE_DIR = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';

const flowCounts = {};
let totalScanned = 0;
let errors = 0;
let missingFlow = 0;
const missingFlowSamples = [];

const tickers = fs.readdirSync(BASE_DIR).filter(f => {
  try {
    return fs.statSync(path.join(BASE_DIR, f)).isDirectory();
  } catch(e) {
    return false;
  }
});

console.log('Total tickers found:', tickers.length);
const bufTail = Buffer.alloc(2048);
const bufHead = Buffer.alloc(1024);

const startTime = Date.now();

for (let i = 0; i < tickers.length; i++) {
  const tk = tickers[i];
  const tkDir = path.join(BASE_DIR, tk);
  let files;
  try {
    files = fs.readdirSync(tkDir).filter(f => f.endsWith('.json'));
  } catch(e) {
    continue;
  }

  for (let j = 0; j < files.length; j++) {
    const filename = files[j];
    const filePath = path.join(tkDir, filename);
    totalScanned++;
    try {
      const stat = fs.statSync(filePath);
      let flowVal = null;

      // 1. Try tail (where flow usually is in Arjum JSON)
      const readTailLen = Math.min(2048, stat.size);
      const startTail = Math.max(0, stat.size - readTailLen);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, bufTail, 0, readTailLen, startTail);
      
      const tailStr = bufTail.toString('utf8', 0, readTailLen);
      let m = tailStr.match(/"flow"\\s*:\\s*"([^"]+)"/);
      if (m) {
        flowVal = m[1];
      } else {
        // 2. Try head
        const readHeadLen = Math.min(1024, stat.size);
        fs.readSync(fd, bufHead, 0, readHeadLen, 0);
        const headStr = bufHead.toString('utf8', 0, readHeadLen);
        m = headStr.match(/"flow"\\s*:\\s*"([^"]+)"/);
        if (m) {
          flowVal = m[1];
        }
      }
      fs.closeSync(fd);

      // 3. Fallback to full file if still not found
      if (!flowVal) {
        const fullStr = fs.readFileSync(filePath, 'utf8');
        m = fullStr.match(/"flow"\\s*:\\s*"([^"]+)"/);
        if (m) {
          flowVal = m[1];
        } else {
          // Check if flow is null or empty
          const mNull = fullStr.match(/"flow"\\s*:\\s*null/);
          if (mNull) {
            flowVal = 'null';
          }
        }
      }

      if (flowVal) {
        flowCounts[flowVal] = (flowCounts[flowVal] || 0) + 1;
      } else {
        missingFlow++;
        if (missingFlowSamples.length < 10) {
          missingFlowSamples.push(path.join(tk, filename));
        }
      }
    } catch(err) {
      errors++;
    }
  }

  if ((i + 1) % 200 === 0 || i === tickers.length - 1) {
    console.log(\`Processed \${i + 1}/\${tickers.length} tickers (\${totalScanned} files scanned)...\`);
  }
}

const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

console.log('__FLOW_CENSUS_START__');
console.log(JSON.stringify({
  totalScanned,
  elapsedSec,
  flowCounts,
  missingFlow,
  missingFlowSamples,
  errors
}, null, 2));
console.log('__FLOW_CENSUS_END__');
`;

console.log('Executing full census across all 186,912 broker-summary files on VPS...');
const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
  input: remoteScript,
  maxBuffer: 20 * 1024 * 1024,
  encoding: 'utf8'
});

console.log(out);
const s = out.indexOf('__FLOW_CENSUS_START__');
const e = out.indexOf('__FLOW_CENSUS_END__');
if (s !== -1 && e !== -1) {
  const jsonStr = out.slice(s + '__FLOW_CENSUS_START__'.length, e).trim();
  fs.writeFileSync(path.join(__dirname, 'census_all_flow_result.json'), jsonStr);
  console.log('Saved census_all_flow_result.json');
}
