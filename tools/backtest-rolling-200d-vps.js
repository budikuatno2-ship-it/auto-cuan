#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const CANDLE_DIR='/home/ubuntu/auto-cuan/data/daily-candles';
const B_DIR='/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';
const BF_DIR='/home/ubuntu/auto-cuan/data/arjum-data/broker-summary-F';
const OUT='/tmp/backtest-rolling-200d.json';
const engine=require('../lib/daytrade-screener-engine');
const LIQ_THRESH=5e9;
function tickSz(p){if(p<200)return 1;if(p<500)return 2;if(p<2000)return 5;if(p<5000)return 10;return 25;}
function loadBk(ticker,dateStr){
  const af=path.join(B_DIR,ticker,dateStr+'.json'),ff=path.join(BF_DIR,ticker,dateStr+'.json');
  let all=null,fi=null;try{if(fs.existsSync(af))all=JSON.parse(fs.readFileSync(af,'utf8'));}catch(e){}try{if(fs.existsSync(ff))fi=JSON.parse(fs.readFileSync(ff,'utf8'));}catch(e){}
  if(!all||!all.brokers||all.brokers.length===0)return null;
  const fMap=new Map();if(fi&&fi.brokers)for(const b of fi.brokers)fMap.set(b.broker_code||b.code||b.id,{bv:Number(b.buy_volume||b.buyVol||0),bva:Number(b.buy_value||b.buyVal||0),sv:Number(b.sell_volume||b.sellVol||0),sva:Number(b.sell_value||b.sellVal||0)});
  let tdBV=0,tdBVa=0,tdSV=0,tdSVa=0;const dom=[];
  for(const b of all.brokers){const code=b.broker_code||b.code||b.id;const fv=fMap.get(code)||{bv:0,bva:0,sv:0,sva:0};const dBV=Math.max(0,Number(b.buy_volume||b.buyVol||0)-fv.bv),dBVa=Math.max(0,Number(b.buy_value||b.buyVal||0)-fv.bva),dSV=Math.max(0,Number(b.sell_volume||b.sellVol||0)-fv.sv),dSVa=Math.max(0,Number(b.sell_value||b.sellVal||0)-fv.sva);tdBV+=dBV;tdBVa+=dBVa;tdSV+=dSV;tdSVa+=dSVa;dom.push({code,name:b.broker_name||b.name||'',dBV,dBVa,dSV,dSVa});}
  dom.sort((a,b)=>b.dBV-a.dBV);const top3=dom.slice(0,3);return{topBV:top3.reduce((s,x)=>s+x.dBVa,0),topSV:top3.reduce((s,x)=>s+x.dSVa,0),totalBV:tdBVa,totalSV:tdSVa};
}
const files=fs.existsSync(CANDLE_DIR)?fs.readdirSync(CANDLE_DIR).filter(f=>f.endsWith('.json')):[];
const r={meta:{v:'rolling-200d-fixed',total:files.length,at:new Date().toISOString()},liquid:{sig:0,filled:0,unfilled:0,tp1:0,tp2:0,sl:0,exp:0,profitExp:0},nonLiq:{sig:0,filled:0,unfilled:0,tp1:0,tp2:0,sl:0,exp:0,profitExp:0}};
let proc=0;
for(const f of files){const t=f.replace('.json','');if(t==='IHSG')continue;proc++;if(proc%200===0)process.stderr.write(' '+proc+'/'+files.length+'\n');
  let c;try{const raw=JSON.parse(fs.readFileSync(path.join(CANDLE_DIR,f),'utf8'));c=Array.isArray(raw)?raw:(raw.candles||raw.data||[]);}catch(e){continue;}
  if(!Array.isArray(c)||c.length<120)continue;
  let tv=0,nv=0;for(let i=Math.max(0,c.length-20);i<c.length;i++){const v=Number(c[i].volume||0)*Number(c[i].close||0);if(v>0){tv+=v;nv++;}}
  const liq=(nv>0?tv/nv:0)>=LIQ_THRESH?'liquid':'nonLiq';const bucket=liq==='liquid'?r.liquid:r.nonLiq;
  for(let i=99;i<c.length-15;i++){
    const bar=c[i],close=Number(bar.close);if(isNaN(close)||close<=0)continue;const ds=bar.date||'';if(!ds)continue;
    let topBV5=0,topSV5=0;for(let w=0;w<5;w++){if(i-w<0)break;const dd=c[i-w].date||'';const bk=loadBk(t,dd);if(bk){topBV5+=bk.topBV;topSV5+=bk.topSV;}}
    if(topBV5<=0)continue;const bsRatio=topSV5>0?topBV5/topSV5:99;
    let atrSum=0;for(let j=Math.max(0,i-13);j<=i;j++)atrSum+=Math.max(1,Number(c[j].high)-Number(c[j].low));const atr=atrSum/Math.min(14,i+1);if(atr<=0)continue;
    const winC=c.slice(0,i+1);const ana=engine.analyzeDayTrade(winC,t);if(!ana||!ana.support||!ana.resistance||!ana.atr14)continue;
    let ok=false;if(liq==='liquid'&&bsRatio>=1.2&&ana.volume_ratio_20d>0.7&&close>=ana.ma20*0.95)ok=true;if(liq==='nonLiq'&&bsRatio>=1.35&&(ana.volume_ratio_20d||1)>=1.4&&close>=ana.support*0.97)ok=true;
    if(!ok)continue;bucket.sig++;
    const ts=tickSz(close);
    const entryLow=Math.round((close-0.3*atr)/ts)*ts;const entryHigh=Math.round(close/ts)*ts;const sl=Math.round((close-1.5*atr)/ts)*ts;const tp1=Math.round((close+1.0*atr)/ts)*ts;const tp2=Math.round((close+2.0*atr)/ts)*ts;
    if(sl>=entryLow||tp1<=entryHigh)continue;
    let filled=false;for(let j=i+1;j<Math.min(c.length,i+5);j++){const low=Number(c[j].low),high=Number(c[j].high);if(low<=entryHigh&&high>=entryLow){filled=true;let hit=false;for(let k=j+1;k<Math.min(c.length,j+16);k++){const fc=c[k];if(Number(fc.close)<=sl){bucket.sl++;hit=true;break;}if(Number(fc.high)>=tp1){bucket.tp1++;hit=true;break;}if(Number(fc.high)>=tp2){bucket.tp2++;hit=true;break;}if(k===Math.min(c.length-1,j+15)){if(Number(fc.close)>entryLow){bucket.profitExp++;}else{bucket.exp++;}hit=true;break;}}if(hit)break;}}
    if(!filled)bucket.unfilled++;else bucket.filled++;
  }
}
function wr(d){const t=d.tp1+d.tp2+d.sl;return t>0?((d.tp1+d.tp2)/t*100).toFixed(1):'0.0';}
r.liquid.wr=wr(r.liquid);r.nonLiq.wr=wr(r.nonLiq);
r.combined={sig:r.liquid.sig+r.nonLiq.sig,tp1:r.liquid.tp1+r.nonLiq.tp1,tp2:r.liquid.tp2+r.nonLiq.tp2,sl:r.liquid.sl+r.nonLiq.sl,exp:r.liquid.exp+r.nonLiq.exp,profitExp:r.liquid.profitExp+r.nonLiq.profitExp,filled:r.liquid.filled+r.nonLiq.filled,unfilled:r.liquid.unfilled+r.nonLiq.unfilled};
fs.writeFileSync(OUT,JSON.stringify(r,null,2));
