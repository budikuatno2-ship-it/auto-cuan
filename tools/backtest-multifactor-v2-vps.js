#!/usr/bin/env node
/* BACKTEST MULTI-FAKTOR V2 — gate lebih realistis */
'use strict';
const fs=require('fs'),path=require('path');
const CANDLE_DIR='/home/ubuntu/auto-cuan/data/daily-candles';
const ACC_DIR='/home/ubuntu/auto-cuan/data/arjum-data/broker-accumulation';
const engine=require('../lib/daytrade-screener-engine');
const tpv2=require('../lib/trade-plan-v2');
const tickNorm=require('../lib/idx-tick-normalization');
const OUT='/tmp/backtest-multifactor-v2.json';

const LIQ=5e9;
const files=fs.readdirSync(CANDLE_DIR).filter(f=>f.endsWith('.json'));
const r={meta:{v:'v2',total:files.length,at:new Date().toISOString()},liquid:{signals:0,tp1:0,tp2:0,sl:0,exp:0},nonLiquid:{signals:0,tp1:0,tp2:0,sl:0,exp:0}};

for(const f of files){
  const t=f.replace('.json','');if(t==='IHSG')continue;
  let c;try{const raw=JSON.parse(fs.readFileSync(path.join(CANDLE_DIR,f),'utf8'));c=Array.isArray(raw)?raw:(raw.candles||raw.data||raw.ohlcv||[]);}catch(e){continue;}
  if(!Array.isArray(c)||c.length<60)continue;
  const last=c[c.length-1];const close=Number(last.close);if(isNaN(close)||close<=0)continue;
  let totalVal=0,count=0;for(let i=Math.max(0,c.length-20);i<c.length;i++){const v=Number(c[i].volume||0)*Number(c[i].close||0);if(v>0){totalVal+=v;count++;}}
  const avgVal=count>0?totalVal/count:0;const liqType=avgVal>=LIQ?'liquid':'nonLiquid';
  let ana;try{ana=engine.analyzeDayTrade(c,t);}catch(e){continue;}
  if(!ana||!ana.support||!ana.resistance||!ana.atr14)continue;
  let acc=null;try{const af=path.join(ACC_DIR,t,'latest.json');if(fs.existsSync(af))acc=JSON.parse(fs.readFileSync(af,'utf8'));}catch(e){}
  const agg20=acc&&acc.agg&&acc.agg['20H']||null;
  const bsRatio=agg20?agg20.ratio:1;
  const rvol=ana.volume_ratio_20d||1;

  // V2: relaxed gate — filter bandarmologi as scoring boost, not hard gate
  let plan;
  try{plan=tpv2.buildTradePlanV2({entry_low:ana.support+(ana.resistance-ana.support)*0.2,entry_high:ana.support+(ana.resistance-ana.support)*0.35,support:ana.support,resistance:ana.resistance,atr14:ana.atr14,current_price:ana.last_price,volume:ana.volume_today,ticker:t,board:'UTAMA',observations:ana},{screener_type:'DAY_TRADE',ticker:t,board:'UTAMA',generatedAt:new Date().toISOString()});}catch(e){continue;}
  if(!plan||plan.status==='REJECTED'||!plan.entry_zone_low||!plan.stop_loss)continue;
  const el=Number(plan.entry_zone_low),sl=Number(plan.stop_loss),tp1=Number(plan.tp1),tp2=Number(plan.tp2);
  if(!isFinite(el)||el<=0||!isFinite(sl)||sl<=0||sl>=el)continue;
  // Score boost from bandarmologi
  let score=50;if(bsRatio>=1.35)score+=30;else if(bsRatio>=1.1)score+=15;if(rvol>=1.5)score+=10;if(liqType==='liquid'&&rvol>0.8)score+=5;
  if(score<50)continue;

  let bt={t,type:liqType,score,buys:0,slHits:0,tp1Hits:0,tp2Hits:0,expired:0};
  if(c.length>=100){for(let i=99;i<c.length;i++){const candle=c[i];if(candle.close<=el&&candle.close>=sl){bt.buys++;for(let j=i+1;j<Math.min(c.length,i+15);j++){const fc=c[j];if(fc.low<=sl){bt.slHits++;break;}if(tp1&&fc.high>=tp1){bt.tp1Hits++;break;}if(tp2&&fc.high>=tp2){bt.tp2Hits++;break;}if(j===Math.min(c.length-1,i+14))bt.expired++;}}}}
  const d=liqType==='liquid'?r.liquid:r.nonLiquid;d.signals+=bt.buys;d.tp1+=bt.tp1Hits;d.tp2+=bt.tp2Hits;d.sl+=bt.slHits;d.exp+=bt.expired;
}
const calcWR=(d)=>{const t=d.tp1+d.tp2+d.sl+d.exp;return t>0?((d.tp1+d.tp2)/t*100).toFixed(1):'N/A';};
r.liquid.winRate=calcWR(r.liquid);r.nonLiquid.winRate=calcWR(r.nonLiquid);
const all={signals:r.liquid.signals+r.nonLiquid.signals,tp1:r.liquid.tp1+r.nonLiquid.tp1,tp2:r.liquid.tp2+r.nonLiquid.tp2,sl:r.liquid.sl+r.nonLiquid.sl,exp:r.liquid.exp+r.nonLiquid.exp};all.winRate=calcWR(all);
r.combined=all;
fs.writeFileSync(OUT,JSON.stringify(r,null,2));
console.log('Liquid: sigs='+r.liquid.signals+' wr='+r.liquid.winRate+'%');
console.log('NonLiquid: sigs='+r.nonLiquid.signals+' wr='+r.nonLiquid.winRate+'%');
console.log('Combined: sigs='+all.signals+' tp1='+all.tp1+' tp2='+all.tp2+' sl='+all.sl+' exp='+all.exp+' wr='+all.winRate+'%');