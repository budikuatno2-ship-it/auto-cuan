#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const B=path.join('/home/ubuntu/auto-cuan/data/arjum-data/','broker-summary');
const BF=path.join('/home/ubuntu/auto-cuan/data/arjum-data/','broker-summary-F');
const OUT='/tmp/fase04-broker-audit.json';

// Dirs per ticker, each contains latest.json
const allDirs=fs.readdirSync(B).filter(d=>fs.statSync(path.join(B,d)).isDirectory());
const fDirs=fs.readdirSync(BF).filter(d=>fs.statSync(path.join(BF,d)).isDirectory());
const allSet=new Set(allDirs),fSet=new Set(fDirs);

const report={meta:{totalAll:allDirs.length,totalF:fDirs.length,checkedAt:new Date().toISOString()},summary:{lengkap:0,belumLengkap:0,asingBelumRilis:0,anomaliD:[]},tickers:{}};

let lengkap=0,belumLengkap=0,asingBelumRilis=0;
for(const ticker of allDirs){
  const latestPath=path.join(B,ticker,'latest.json');
  if(!fs.existsSync(latestPath)){belumLengkap++;continue;}
  let all,ff=null;
  try{all=JSON.parse(fs.readFileSync(latestPath,'utf8'));}catch(e){belumLengkap++;continue;}
  const hasF=fSet.has(ticker);
  if(hasF){
    const fLatestPath=path.join(BF,ticker,'latest.json');
    if(fs.existsSync(fLatestPath)){try{ff=JSON.parse(fs.readFileSync(fLatestPath,'utf8'));}catch(e){}}
  }
  
  const allBrokers=all.brokers||all.data||[];
  const fBrokers=ff?((ff.brokers||ff.data||[])):null;
  
  if(hasF&&Array.isArray(allBrokers)&&allBrokers.length>0&&fBrokers&&fBrokers.length>0){
    lengkap++;
    const allMap=new Map(); for(const b of allBrokers){const nv=Number(b.net_value||b.nv||b.value||0);allMap.set(b.broker_code||b.code||b.id,nv);}
    const fMap=new Map(); for(const b of fBrokers){fMap.set(b.broker_code||b.code||b.id,Number(b.net_value||b.nv||b.value||0));}
    for(const [code,allVal] of allMap){
      const fVal=fMap.get(code)||0;
      const dVal=allVal-fVal;
      if(dVal< -1e-3){report.summary.anomaliD.push({ticker,broker:code,allVal,fVal,dVal});}
    }
  }else if(!hasF){
    asingBelumRilis++;
  }else{
    belumLengkap++;
  }
  
  if(Object.keys(report.tickers).length<20){
    report.tickers[ticker]={hasF,allBrokersCount:allBrokers.length,fBrokersCount:fBrokers?fBrokers.length:0,allDate:all.date||all.scrape_date||''};
  }
}

report.summary.lengkap=lengkap;report.summary.belumLengkap=belumLengkap;report.summary.asingBelumRilis=asingBelumRilis;
fs.writeFileSync(OUT,JSON.stringify(report,null,2));
console.log('ALL:',allDirs.length,'F:',fDirs.length,'Lengkap:',lengkap,'BelumLengkap:',belumLengkap,'AsingTidakRilis:',asingBelumRilis,'AnomaliD:',report.summary.anomaliD.length);