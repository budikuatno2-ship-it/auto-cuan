#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const CANDLE_DIR='/home/ubuntu/auto-cuan/data/daily-candles';
const OUT='/tmp/fase03-final-audit.json';
const engine=require('../lib/daytrade-screener-engine');
const tpv2=require('../lib/trade-plan-v2');
const tickNorm=require('../lib/idx-tick-normalization');

const r={meta:{v:'final',at:new Date().toISOString(),total:0,audited:0},nc:[],failed:[],backtests:[],sum:{total:0,pass:0,fail:0,insuf:0,nan:0,zero:0,rejected:0,slGeEntry:0,ordFail:0,badTick:0,xSl:0,xTp:0,noAnalysis:0,noPlan:0}};

// NEGATIVE CONTROL
try{const ncAna=engine.analyzeDayTrade([{date:'2026-10-27',open:1000,high:1010,low:990,close:NaN,volume:100}],'__NC');r.nc.push({t:'__NC_NAN',s:ncAna?'ok':'null'});}catch(e){r.nc.push({t:'__NC_NAN',s:'FAILED',err:e.message});}

const files=fs.readdirSync(CANDLE_DIR).filter(f=>f.endsWith('.json'));
r.meta.total=files.length;r.sum.total=files.length;
let audited=0;
for(const f of files){
  const t=f.replace('.json','');audited++;
  if(audited%200===0)process.stderr.write(' '+audited+'/'+files.length+'\n');
  let c;try{const raw=JSON.parse(fs.readFileSync(path.join(CANDLE_DIR,f),'utf8'));c=Array.isArray(raw)?raw:(raw.candles||raw.data||raw.ohlcv||[]);}catch(e){r.sum.fail++;r.failed.push({t,why:'parse'});continue;}
  if(!Array.isArray(c)||c.length<30){r.sum.insuf++;continue;}
  const close=Number(c[c.length-1].close);if(isNaN(close)){r.sum.nan++;r.sum.fail++;continue;}if(close<=0){r.sum.zero++;r.sum.fail++;continue;}

  let ana=null;try{ana=engine.analyzeDayTrade(c,t);}catch(e){r.sum.noAnalysis++;r.sum.fail++;continue;}
  if(!ana||!ana.support||!ana.resistance||!ana.atr14){r.sum.noAnalysis++;r.sum.fail++;continue;}

  let plan=null;
  try{
    plan=tpv2.buildTradePlanV2({
      entry_low:ana.support+(ana.resistance-ana.support)*0.2,
      entry_high:ana.support+(ana.resistance-ana.support)*0.35,
      support:ana.support,resistance:ana.resistance,
      atr14:ana.atr14,current_price:ana.last_price,
      volume:ana.volume_today,ticker:t,board:'UTAMA',
      observations:ana
    },{screener_type:'DAY_TRADE',ticker:t,board:'UTAMA',generatedAt:new Date().toISOString()});
  }catch(e){r.sum.noPlan++;r.sum.fail++;continue;}
  if(!plan||plan.status==='REJECTED'){r.sum.rejected++;continue;}

  const el=Number(plan.entry_zone_low),eh=Number(plan.entry_zone_high),sl=Number(plan.stop_loss),tp1=Number(plan.tp1),tp2=Number(plan.tp2);
  if(!isFinite(el)||el<=0||!isFinite(sl)||sl<=0){r.sum.fail++;continue;}
  let failed=false;
  if(sl>=el){r.sum.slGeEntry++;failed=true;}
  if(isFinite(eh)&&isFinite(tp1)&&eh>=tp1){r.sum.ordFail++;failed=true;}
  if(isFinite(el)&&el>0){const ts=tickNorm.getIdxTickSize(el,'UTAMA',false,t);if([el,eh,sl,tp1,tp2].filter(v=>isFinite(v)&&v>0).some(v=>v%ts!==0))r.sum.badTick++;}
  if(isFinite(sl)&&sl<close*.5)r.sum.xSl++;
  if(isFinite(tp1)&&tp1>close*3)r.sum.xTp++;
  if(failed){r.sum.fail++;r.failed.push({t,close,el,sl,tp1});continue;}

  // minimal backtest
  let bt={t,buys:0,slHits:0,tp1Hits:0,tp2Hits:0,expired:0};
  if(c.length>=120){
    for(let i=119;i<c.length;i++){
      const candle=c[i];
      if(candle.close<=el&&candle.close>=sl){
        bt.buys++;
        for(let j=i+1;j<Math.min(c.length,i+21);j++){
          const fc=c[j];
          if(fc.low<=sl){bt.slHits++;break;}
          if(tp1&&fc.high>=tp1){bt.tp1Hits++;break;}
          if(tp2&&fc.high>=tp2){bt.tp2Hits++;break;}
          if(j===Math.min(c.length-1,i+20))bt.expired++;
        }
      }
    }
  }
  if(bt.buys>0)r.backtests.push(bt);
  r.sum.pass++;
}
r.meta.audited=audited;
fs.writeFileSync(OUT,JSON.stringify(r,null,2));
const btTotal=r.backtests.length;const btSum=r.backtests.reduce((a,x)=>a+x.buys,0);const btSl=r.backtests.reduce((a,x)=>a+x.slHits,0);const btTp1=r.backtests.reduce((a,x)=>a+x.tp1Hits,0);
process.stderr.write('\naudited '+audited+'/'+files.length+' PASS='+r.sum.pass+' FAIL='+r.sum.fail+' rej='+r.sum.rejected+'\n');
process.stderr.write('backtest: '+btTotal+' tickers, '+btSum+' buys, SL='+btSl+' TP1='+btTp1+'\n');
console.log(JSON.stringify({pass:r.sum.pass,fail:r.sum.fail,rejected:r.sum.rejected,slAboveEntry:r.sum.slGeEntry,ordinalFail:r.sum.ordFail,badTick:r.sum.badTick,btTickers:btTotal,btBuys:btSum,btSL:btSl,btTP1:btTp1}));