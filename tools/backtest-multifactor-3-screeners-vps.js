#!/usr/bin/env node
/* BACKTEST MULTI-FAKTOR 3 SCREENER — Likuid vs Non-Likuid + Broksum + Akumulasi + Insider + LPM */
'use strict';
const fs=require('fs'),path=require('path');
const CANDLE_DIR='/home/ubuntu/auto-cuan/data/daily-candles';
const ACC_DIR='/home/ubuntu/auto-cuan/data/arjum-data/broker-accumulation';
const engine=require('../lib/daytrade-screener-engine');
const tpv2=require('../lib/trade-plan-v2');
const tickNorm=require('../lib/idx-tick-normalization');
const OUT='/tmp/backtest-multifactor.json';

const LIQUID_THRESHOLD=5e9; // 5 Miliar IDR avg daily value
const files=fs.readdirSync(CANDLE_DIR).filter(f=>f.endsWith('.json'));
const r={meta:{v:'multifactor-v1',total:files.length,at:new Date().toISOString()},liquid:{},nonLiquid:{},sum:{totalSigs:0,tp1:0,tp2:0,sl:0,exp:0}};

for(const f of files){
  const t=f.replace('.json','');if(t==='IHSG')continue;
  let c;try{const raw=JSON.parse(fs.readFileSync(path.join(CANDLE_DIR,f),'utf8'));c=Array.isArray(raw)?raw:(raw.candles||raw.data||raw.ohlcv||[]);}catch(e){continue;}
  if(!Array.isArray(c)||c.length<60)continue;
  const last=c[c.length-1];const close=Number(last.close);if(isNaN(close)||close<=0)continue;

  // Determine liquidity
  let totalVal=0,count=0;for(let i=Math.max(0,c.length-20);i<c.length;i++){const v=Number(c[i].volume||0)*Number(c[i].close||0);if(v>0){totalVal+=v;count++;}}
  const avgVal=count>0?totalVal/count:0;const liqType=avgVal>=LIQUID_THRESHOLD?'liquid':'nonLiquid';

  let ana;try{ana=engine.analyzeDayTrade(c,t);}catch(e){continue;}
  if(!ana||!ana.support||!ana.resistance||!ana.atr14)continue;

  // Read accumulation
  let acc=null;try{const af=path.join(ACC_DIR,t,'latest.json');if(fs.existsSync(af))acc=JSON.parse(fs.readFileSync(af,'utf8'));}catch(e){}
  const agg20=(acc&&acc.agg&&acc.agg['20H'])||null;
  const bsRatio=agg20?agg20.ratio:1;const topBuyer=agg20?agg20.topBuyer:null;
  const akumulasiKuat=bsRatio>=1.35;const akumulasi=bsRatio>=1.1;const rvol=ana.volume_ratio_20d||1;
  const avgBuyPrice=topBuyer?topBuyer.avgBuy:null;

  // Gate based on liquidity type
  let gatePass=false;
  if(liqType==='liquid'){
    if(akumulasi&&ana.volume_ratio_20d>0.7&&close>=ana.ma20*0.95)gatePass=true;
  }else{
    if(akumulasiKuat&&rvol>=1.5&&avgBuyPrice&&close<=avgBuyPrice*1.05)gatePass=true;
  }
  if(!gatePass)continue;

  // Build trade plan
  let plan;
  try{plan=tpv2.buildTradePlanV2({entry_low:ana.support+(ana.resistance-ana.support)*0.2,entry_high:ana.support+(ana.resistance-ana.support)*0.35,support:ana.support,resistance:ana.resistance,atr14:ana.atr14,current_price:ana.last_price,volume:ana.volume_today,ticker:t,board:'UTAMA',observations:ana},{screener_type:'DAY_TRADE',ticker:t,board:'UTAMA',generatedAt:new Date().toISOString()});}catch(e){continue;}
  if(!plan||plan.status==='REJECTED'||!plan.entry_zone_low||!plan.stop_loss)continue;

  const el=Number(plan.entry_zone_low),sl=Number(plan.stop_loss),tp1=Number(plan.tp1),tp2=Number(plan.tp2);
  if(!isFinite(el)||el<=0||!isFinite(sl)||sl<=0||sl>=el)continue;

  // Backtest this ticker
  let bt={t,type:liqType,buys:0,slHits:0,tp1Hits:0,tp2Hits:0,expired:0};
  if(c.length>=100){for(let i=99;i<c.length;i++){const candle=c[i];if(candle.close<=el&&candle.close>=sl){bt.buys++;for(let j=i+1;j<Math.min(c.length,i+15);j++){const fc=c[j];if(fc.low<=sl){bt.slHits++;break;}if(tp1&&fc.high>=tp1){bt.tp1Hits++;break;}if(tp2&&fc.high>=tp2){bt.tp2Hits++;break;}if(j===Math.min(c.length-1,i+14))bt.expired++;}}}}
  r.sum.totalSigs+=bt.buys;r.sum.tp1+=bt.tp1Hits;r.sum.tp2+=bt.tp2Hits;r.sum.sl+=bt.slHits;r.sum.exp+=bt.expired;
  (liqType==='liquid'?r.liquid:r.nonLiquid)[t]={close,el,sl,tp1,tp2,bsRatio:bsRatio.toFixed(2),rvol:rvol.toFixed(2),bt};
}
const total=r.sum.tp1+r.sum.tp2+r.sum.sl+r.sum.exp;
r.sum.winRate=total>0?((r.sum.tp1+r.sum.tp2)/total*100).toFixed(1):'N/A';
fs.writeFileSync(OUT,JSON.stringify(r,null,2));
console.log('signals:',r.sum.totalSigs,'tp1:',r.sum.tp1,'tp2:',r.sum.tp2,'sl:',r.sum.sl,'exp:',r.sum.exp,'winRate:',r.sum.winRate+'%','liquid:',Object.keys(r.liquid).length,'nonLiquid:',Object.keys(r.nonLiquid).length);