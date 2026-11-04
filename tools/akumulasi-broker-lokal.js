#!/usr/bin/env node
/* AKUMULASI BROKER LOKAL — D = ALL - F, NetLot 1/3/5/10/20H, 0 KUOTA ARJUM */
'use strict';
const fs=require('fs'),path=require('path');
const D='/home/ubuntu/auto-cuan/data/arjum-data';
const B_ALL=path.join(D,'broker-summary');
const B_F=path.join(D,'broker-summary-F');
const OUT_ACC=path.join(D,'broker-accumulation');

const tDirs=fs.readdirSync(B_ALL).filter(d=>fs.statSync(path.join(B_ALL,d)).isDirectory());
const report={meta:{total:tDirs.length,at:new Date().toISOString()},perTicker:{},sum:{processed:0,skipped:0}};
const WINDOWS=[1,3,5,10,20];

for(const ticker of tDirs){
  const allDates=fs.readdirSync(path.join(B_ALL,ticker)).filter(f=>f.endsWith('.json')&&f!=='latest.json').sort();
  if(allDates.length===0){report.sum.skipped++;continue;}
  const fDates=fs.existsSync(path.join(B_F,ticker))?fs.readdirSync(path.join(B_F,ticker)).filter(f=>f.endsWith('.json')&&f!=='latest.json').sort():[];
  const fSet=new Set(fDates);

  // Compute daily D = ALL - F per broker
  const dailyD=[];
  for(const dateFile of allDates.slice(-60)){ // last 60 days
    const date=dateFile.replace('.json','');
    let all,f;
    try{all=JSON.parse(fs.readFileSync(path.join(B_ALL,ticker,dateFile),'utf8'));}catch(e){continue;}
    const allB=all.brokers||all.data||[];
    let fB=[];
    if(fSet.has(dateFile)){try{f=JSON.parse(fs.readFileSync(path.join(B_F,ticker,dateFile),'utf8'));fB=f.brokers||f.data||[];}catch(e){}}
    const fMap=new Map();for(const b of fB){fMap.set(b.broker_code||b.code||b.id,{buyVol:Number(b.buy_volume||b.buyVol||0),buyVal:Number(b.buy_value||b.buyVal||0),sellVol:Number(b.sell_volume||b.sellVol||0),sellVal:Number(b.sell_value||b.sellVal||0)});}
    const domBrokers=[];
    for(const b of allB){
      const code=b.broker_code||b.code||b.id;
      const allBuyVol=Number(b.buy_volume||b.buyVol||0),allBuyVal=Number(b.buy_value||b.buyVal||0),allSellVol=Number(b.sell_volume||b.sellVol||0),allSellVal=Number(b.sell_value||b.sellVal||0);
      const fv=fMap.get(code)||{buyVol:0,buyVal:0,sellVol:0,sellVal:0};
      const dBV=Math.max(0,allBuyVol-fv.buyVol),dBVa=Math.max(0,allBuyVal-fv.buyVal),dSV=Math.max(0,allSellVol-fv.sellVol),dSVa=Math.max(0,allSellVal-fv.sellVal);
      if(dBV>0||dBVa>0||dSV>0||dSVa>0){domBrokers.push({code,broker_name:b.broker_name||b.name||'',buyVol:dBV,buyVal:dBVa,sellVol:dSV,sellVal:dSVa,netLot:Math.round((dBV-dSV)/100),netVal:dBVa-dSVa});}
    }
    dailyD.push({date,allCount:allB.length,fCount:fB.length,domCount:domBrokers.length,domBrokers});
  }

  // Aggregasi multi-hari
  const agg={};
  for(const W of WINDOWS){
    const window=Math.min(W,dailyD.length);
    const brokerMap=new Map();
    for(let i=0;i<window;i++){
      for(const b of dailyD[dailyD.length-1-i].domBrokers){
        const prev=brokerMap.get(b.code)||{code:b.code,name:b.broker_name,buyLot:0,buyVal:0,sellLot:0,sellVal:0};
        prev.buyLot+=b.buyVol/100;prev.buyVal+=b.buyVal;prev.sellLot+=b.sellVol/100;prev.sellVal+=b.sellVal;
        brokerMap.set(b.code,prev);
      }
    }
    const brokers=[...brokerMap.values()].map(b=>({...b,netLot:b.buyLot-b.sellLot,netVal:b.buyVal-b.sellVal,avgBuy:b.buyLot>0?b.buyVal/(b.buyLot*100):null,avgSell:b.sellLot>0?b.sellVal/(b.sellLot*100):null}));
    brokers.sort((a,b)=>b.netLot-a.netLot);
    const topB=brokers.filter(b=>b.netLot>0);const topS=brokers.filter(b=>b.netLot<0);
    const topBV3=topB.slice(0,3).reduce((s,b)=>s+b.buyVal,0);const topSV3=topS.slice(0,3).reduce((s,b)=>s+Math.abs(b.sellVal),0);
    const ratio=topSV3>0?topBV3/topSV3:99;
    let arah='Netral';if(ratio>=1.35)arah='Akumulasi Kuat';else if(ratio>=1.1)arah='Akumulasi';else if(ratio>=0.7)arah='Distribusi';else arah='Distribusi Kuat';
    agg[W+'H']={brokers:brokers.slice(0,15),topBuyer:topB[0]||null,topSeller:topS[0]||null,ratio,arah,topBuyVal3:topBV3,topSellVal3:topSV3,totalBrokers:brokers.length};
  }
  const outDir=path.join(OUT_ACC,ticker);fs.mkdirSync(outDir,{recursive:true});
  fs.writeFileSync(path.join(outDir,'latest.json'),JSON.stringify({ticker,generatedAt:new Date().toISOString(),daily:dailyD.slice(-30),agg},null,2));
  report.perTicker[ticker]={dailyEntries:dailyD.length,aggWindows:Object.keys(agg)};
  report.sum.processed++;
  if(report.sum.processed%100===0)process.stderr.write(' '+report.sum.processed+'/'+tDirs.length+'\n');
}
fs.writeFileSync('/tmp/akumulasi-report.json',JSON.stringify(report,null,2));
console.log('\nprocessed',report.sum.processed,'skipped',report.sum.skipped);