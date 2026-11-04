#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const CANDLE_DIR='/home/ubuntu/auto-cuan/data/daily-candles';
const OUT='/tmp/fase03-deep-v7.json';
const base=require('../lib/daytrade-screener-engine');
const tickNorm=require('../lib/idx-tick-normalization');

const r={meta:{v:'v7',at:new Date().toISOString(),total:0,audited:0},nc:[],failed:[],sum:{total:0,pass:0,fail:0,insuf:0,nan:0,zero:0,noPlan:0,slGeEntry:0,ordFail:0,badTick:0,xSl:0,xTp:0,zLevel:0}};

// NEGATIVE CONTROL
try{base.analyzeDayTrade([],'__NC');r.nc.push({t:'__NC_EMPTY',s:'PASSED',note:'no crash on empty'});}catch(e){r.nc.push({t:'__NC_EMPTY',s:'FAILED',err:e.message});}

const files=fs.readdirSync(CANDLE_DIR).filter(f=>f.endsWith('.json'));
r.meta.total=files.length;r.sum.total=files.length;let audited=0;
for(const f of files){const t=f.replace('.json','');audited++;
  let c;try{const raw=JSON.parse(fs.readFileSync(path.join(CANDLE_DIR,f),'utf8'));c=Array.isArray(raw)?raw:(raw.candles||raw.data||raw.ohlcv||[]);}catch(e){r.failed.push({t,why:'parse'});r.sum.fail++;continue;}
  if(!Array.isArray(c)||c.length<30){r.sum.insuf++;continue;}
  const close=Number(c[c.length-1].close);if(isNaN(close)){r.sum.nan++;r.sum.fail++;continue;}if(close<=0){r.sum.zero++;r.sum.fail++;continue;}
  let a=null;try{a=base.analyzeDayTrade(c,t);}catch(e){r.failed.push({t,why:'exc'});r.sum.fail++;continue;}
  if(!a){r.sum.noPlan++;continue;}
  const el=Number(a.entry_low||a.entryLow),eh=Number(a.entry_high||a.entryHigh),sl=Number(a.stop_loss||a.stopLoss),tp1=Number(a.tp1),tp2=Number(a.tp2);
  if(!isFinite(el)||el<=0||!isFinite(sl)||sl<=0){r.sum.zLevel++;r.sum.fail++;continue;}
  if(sl>=el){r.sum.slGeEntry++;}if(isFinite(eh)&&isFinite(tp1)&&eh>=tp1){r.sum.ordFail++;}
  if(isFinite(el)&&el>0){const ts=tickNorm.getIdxTickSize(el,'UTAMA',false,t);const lv=[el,eh,sl,tp1,tp2].filter(v=>isFinite(v)&&v>0);if(lv.some(v=>v%ts!==0))r.sum.badTick++;}
  if(isFinite(sl)&&sl<close*.5)r.sum.xSl++;if(isFinite(tp1)&&tp1>close*3)r.sum.xTp++;
  r.sum.pass++;
}
r.meta.audited=audited;fs.writeFileSync(OUT,JSON.stringify(r,null,2));
process.stderr.write('audited '+audited+'/'+files.length+' PASS='+r.sum.pass+' FAIL='+r.sum.fail+' insuf='+r.sum.insuf+' noPlan='+r.sum.noPlan+'\n');
console.log(JSON.stringify(r.sum));