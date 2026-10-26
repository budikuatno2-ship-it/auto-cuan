'use strict';

const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', '..', 'tools', 'run-daily-market-update.js');
let c = fs.readFileSync(target, 'utf8');
const crlf = c.includes('\r\n');
c = c.replace(/\r\n/g, '\n');

function rep(from, to, label) {
  if (!c.includes(from)) { console.error('NOT FOUND: ' + label); process.exitCode = 1; return; }
  c = c.replace(from, to);
  console.log('OK: ' + label);
}

// Add eodDonePath helper after stateDir()
rep(
`function stateDir(){return path.join(path.dirname(path.dirname(broker.markerPath('unused'))),'_daily-market-update');}`,
`function stateDir(){return path.join(path.dirname(path.dirname(broker.markerPath('unused'))),'_daily-market-update');}
// 2c: EOD completion sentinel readable by the backfill worker. Written after
// broker-summary + foreign + insider + candle all complete for the date.
function eodDonePath(date, dataDir){
  const base = dataDir || path.dirname(path.dirname(broker.markerPath('unused')));
  return path.join(base, '_eod', date + '.done');
}
function writeEodDone(date, dataDir, payload){
  try{
    const p = eodDonePath(date, dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const temp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
    fs.renameSync(temp, p);
  }catch(_){}
}`,
'eodDonePath + writeEodDone helpers'
);

// Write the sentinel when all three stages complete
rep(
`    writeState(date,{date,complete:brokerOk&&candleOk&&historyOk,broker_complete:brokerOk,candle_complete:candleOk,history_complete:historyOk,updated_at:new Date().toISOString()});`,
`    writeState(date,{date,complete:brokerOk&&candleOk&&historyOk,broker_complete:brokerOk,candle_complete:candleOk,history_complete:historyOk,updated_at:new Date().toISOString()});
    if(brokerOk&&candleOk&&historyOk){
      writeEodDone(date, null, {
        date,
        broker_complete: brokerOk,
        candle_complete: candleOk,
        history_complete: historyOk,
        completed_at: new Date().toISOString()
      });
    }`,
'write EOD .done sentinel on full completion'
);

// Export helpers for tests
rep(
`module.exports={run,pendingDates,stateDir,readMarketState,previousDateNeedsWork,loadEnv};`,
`module.exports={run,pendingDates,stateDir,readMarketState,previousDateNeedsWork,loadEnv,eodDonePath,writeEodDone};`,
'export helpers'
);

if (crlf) c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(target, c, 'utf8');
console.log('Patched:', target);