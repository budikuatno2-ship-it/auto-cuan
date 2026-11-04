#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const CANDLE_DIR='/home/ubuntu/auto-cuan/data/daily-candles';
const OUT='/tmp/fase03-backtest-964.json';
const engine=require('../lib/daytrade-screener-engine');
const tpv2=require('../lib/trade-plan-v2');
const tickNorm=require('../lib/idx-tick-normalization');

const r={meta:{v:'full-backtest-964',at:new Date().toISOString(),totalFiles:0,audited:0},perTicker:{},sum:{total:0,pass:0,fail:0,insuf:0,noAna:0,noPlan:0,rejected:0,slAboveEntry:0,ordinalFail:0,badTick:0,btTotalTrades:0,btSlHits:0,btTp1Hits:0,btTp2Hits:0,btExpired:0}};

const files=fs.readdirSync(CANDLE_DIR).filter(f=>f.endsWith('.json'));
r.meta.totalFiles=files.length;r.sum.total=files.length;
let audited=0;

for(const f of files){
  const t=f.replace('.json','');audited++;
  if(audited%200===0)process.stderr.write(' '+audited+'/'+files.length+'\n');
  let c;try{const raw=JSON.parse(fs.readFileSync(path.join(CANDLE_DIR,f),'utf8'));c=Array.isArray(raw)?raw:(raw.candles||raw.data||raw.ohlcv||[]);}catch(e){r.sum.fail++;continue;}
  if(!Array.isArray(c)||c.length<30){r.sum.insuf++;continue;}
  const last=c[c.length-1];const close=Number(last.close);
  if(isNaN(close)||close<=0){r.sum.fail++;continue;}

  let ana=null;try{ana=engine.analyzeDayTrade(c,t);}catch(e){r.sum.noAna++;continue;}
  if(!ana||!ana.support||!ana.resistance||!ana.atr14){r.sum.noAna++;continue;}

  // Also compute SWING plan for backtest comparison
  let planD=null,planS=null;
  try{
    planD=tpv2.buildTradePlanV2({
      entry_low:ana.support+(ana.resistance-ana.support)*0.2,
      entry_high:ana.support+(ana.resistance-ana.support)*0.35,
      support:ana.support,resistance:ana.resistance,
      atr14:ana.atr14,current_price:ana.last_price,
      volume:ana.volume_today,ticker:t,board:'UTAMA',observations:ana
    },{screener_type:'DAY_TRADE',ticker:t,board:'UTAMA',generatedAt:new Date().toISOString()});
    planS=tpv2.buildTradePlanV2({
      entry_low:ana.support+(ana.resistance-ana.support)*0.1,
      entry_high:ana.support+(ana.resistance-ana.support)*0.25,
      support:ana.support,resistance:ana.resistance,
      atr14:ana.atr14,current_price:ana.last_price,
      volume:ana.volume_today,ticker:t,board:'UTAMA',observations:ana
    },{screener_type:'SWING_NON_KONGLO',ticker:t,board:'UTAMA',generatedAt:new Date().toISOString()});
  }catch(e){r.sum.noPlan++;continue;}

  const isDok=planD&&planD.status!=='REJECTED'&&planD.entry_zone_low&&planD.stop_loss;
  const isSok=planS&&planS.status!=='REJECTED'&&planS.entry_zone_low&&planS.stop_loss;
  if(!isDok&&!isSok){r.sum.rejected++;continue;}

  const el=(planD&&planD.entry_zone_low)||planS.entry_zone_low;
  const sl=(planD&&planD.stop_loss)||planS.stop_loss;
  const tp1=(planD&&planD.tp1)||planS.tp1;
  const tp2=(planD&&planD.tp2)||planS.tp2;

  // Validation
  let valid=true;
  if(!isFinite(el)||el<=0||!isFinite(sl)||sl<=0)valid=false;
  if(valid&&sl>=el){r.sum.slAboveEntry++;valid=false;}
  if(valid&&isFinite(el)&&el>0){const ts=tickNorm.getIdxTickSize(el,'UTAMA',false,t);if([el,sl,tp1,tp2].filter(v=>isFinite(v)&&v>0).some(v=>v%ts!==0)){r.sum.badTick++;}}
  if(!valid){r.sum.fail++;continue;}

  // FULL BACKTEST — last 60 candles as walk-forward window
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
  r.sum.btTotalTrades+=bt.buys;r.sum.btSlHits+=bt.slHits;r.sum.btTp1Hits+=bt.tp1Hits;r.sum.btTp2Hits+=bt.tp2Hits;r.sum.btExpired+=bt.expired;
  r.perTicker[t]={close,el,sl,tp1,tp2,status:isDok?'DAY_TRADE':'SWING',bt};
  r.sum.pass++;
}
r.meta.audited=audited;
fs.writeFileSync(OUT,JSON.stringify(r,null,2));
console.log('\naudited '+audited+'/'+files.length+' PASS='+r.sum.pass+' FAIL='+r.sum.fail+' insuf='+r.sum.insuf+' noAna='+r.sum.noAna+' noPlan='+r.sum.noPlan+' rej='+r.sum.rejected);
console.log('BACKTEST totals: '+r.sum.btTotalTrades+' trades, SL='+r.sum.btSlHits+' TP1='+r.sum.btTp1Hits+' TP2='+r.sum.btTp2Hits+' expired='+r.sum.btExpired);
const total=r.sum.btSlHits+r.sum.btTp1Hits+r.sum.btTp2Hits+r.sum.btExpired;
if(total>0)console.log('Win-rate(TP1+TP2): '+((r.sum.btTp1Hits+r.sum.btTp2Hits)/total*100).toFixed(1)+'%');