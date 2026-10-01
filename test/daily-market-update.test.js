'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const market=require('../tools/run-daily-market-update'),broker=require('../tools/run-daily-broker-update');
function state(fn){const old=process.env.ARJUM_DATA_DIR,dir=fs.mkdtempSync(path.join(os.tmpdir(),'market-queue-'));process.env.ARJUM_DATA_DIR=dir;try{fn();}finally{if(old==null)delete process.env.ARJUM_DATA_DIR;else process.env.ARJUM_DATA_DIR=old;fs.rmSync(dir,{recursive:true,force:true});}}
test('new session begins at 18 WIB, while dated pending work survives midnight and weekends',()=>state(()=>{
 assert.deepEqual(market.pendingDates(new Date('2026-10-01T17:59:00+07:00')),[]);
 assert.deepEqual(market.pendingDates(new Date('2026-10-01T18:00:00+07:00')),['2026-10-01']);
 broker.writeMarker('2026-10-01',{complete:false});
 assert.deepEqual(market.pendingDates(new Date('2026-10-02T01:00:00+07:00')),['2026-10-01']);
 assert.deepEqual(market.pendingDates(new Date('2026-10-03T19:00:00+07:00')),['2026-10-02','2026-10-01']);
}));
test('missed trading dates are recovered from the last durable date',()=>state(()=>{
 broker.writeMarker('2026-09-29',{complete:true,version:2});
 assert.deepEqual(market.pendingDates(new Date('2026-10-01T18:00:00+07:00')),['2026-10-01','2026-09-30']);
}));
test('old completion markers are rechecked for auxiliary data',()=>state(()=>{
 broker.writeMarker('2026-09-30',{complete:true});
 assert.deepEqual(market.pendingDates(new Date('2026-10-01T09:00:00+07:00')),['2026-09-30']);
}));
test('a failed broker stage still runs candles and retains the date; closed sessions complete',async()=>{
 const candles=require('../tools/fetch-daily-candles');
 const old=process.env.ARJUM_DATA_DIR,dir=fs.mkdtempSync(path.join(os.tmpdir(),'market-run-'));
 const brokerRun=broker.run,candleRun=candles.main;
 process.env.ARJUM_DATA_DIR=dir;let candleCalls=0;
 const now=new Date('2026-10-01T18:00:00+07:00');
 try{
  broker.run=async()=>{throw new Error('fixture failure')};
  candles.main=async({targetDate})=>{assert.equal(targetDate,'2026-10-01');candleCalls++;return {skipped:true};};
  await market.run({now});assert.equal(candleCalls,1);assert.equal(process.exitCode,3);
  let saved=JSON.parse(fs.readFileSync(path.join(market.stateDir(),'2026-10-01.json')));assert.equal(saved.complete,false);
  broker.run=async()=>({skipped:true});await market.run({now});
  saved=JSON.parse(fs.readFileSync(path.join(market.stateDir(),'2026-10-01.json')));assert.equal(saved.complete,true);
 }finally{
  broker.run=brokerRun;candles.main=candleRun;process.exitCode=undefined;
  if(old==null)delete process.env.ARJUM_DATA_DIR;else process.env.ARJUM_DATA_DIR=old;
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
