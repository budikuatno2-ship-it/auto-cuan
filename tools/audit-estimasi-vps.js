#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const D='/home/ubuntu/auto-cuan/data/arjum-data';
const B=path.join(D,'broker-summary');
const BF=path.join(D,'broker-summary-F');
const tDirs=fs.readdirSync(B).filter(d=>fs.statSync(path.join(B,d)).isDirectory()).sort();
const r={meta:{total:tDirs.length,at:new Date().toISOString()},broksum:{totalFiles:0},foreign:{totalFiles:0},missing:{totalAll:0,totalF:0},estimasi:{}};
const allDates=new Set();
for(const t of tDirs){
  const bf=fs.readdirSync(path.join(B,t)).filter(f=>f.endsWith('.json')&&f!=='latest.json');
  const ff=fs.existsSync(path.join(BF,t))?fs.readdirSync(path.join(BF,t)).filter(f=>f.endsWith('.json')&&f!=='latest.json'):[];
  r.broksum.totalFiles+=bf.length;r.foreign.totalFiles+=ff.length;
  bf.forEach(d=>allDates.add(d.replace('.json','')));
}
const sortedAll=[...allDates].sort();
const expectedDates=[];
if(sortedAll.length>0){let cur=new Date(sortedAll[0]);const end=new Date(sortedAll[sortedAll.length-1]);while(cur<=end){const ds=cur.toISOString().slice(0,10);if(allDates.has(ds))expectedDates.push(ds);cur.setDate(cur.getDate()+1);}}
for(const t of tDirs){
  const bSet=new Set(fs.readdirSync(path.join(B,t)).filter(f=>f.endsWith('.json')&&f!=='latest.json').map(f=>f.replace('.json','')));
  const fSet=new Set(fs.existsSync(path.join(BF,t))?fs.readdirSync(path.join(BF,t)).filter(f=>f.endsWith('.json')&&f!=='latest.json').map(f=>f.replace('.json','')):[]);
  const missA=expectedDates.filter(d=>!bSet.has(d)).length;
  const missF=expectedDates.filter(d=>!fSet.has(d)).length;
  r.missing.totalAll+=missA;r.missing.totalF+=missF;
}
let dynLimit=0;try{dynLimit=require('../lib/quota-state').resolveEffectiveLimit({});}catch(_){dynLimit=0;}
r.estimasi={totalReq:r.missing.totalAll+r.missing.totalF,hariWeekdayDyn:dynLimit>0?Math.ceil((r.missing.totalAll+r.missing.totalF)/dynLimit):null,dynamicLimit:dynLimit};
fs.writeFileSync('/tmp/inventaris-estimasi.json',JSON.stringify(r,null,2));
console.log('tickers',r.meta.total,'allFiles',r.broksum.totalFiles,'fFiles',r.foreign.totalFiles,'missingAll',r.missing.totalAll,'missingF',r.missing.totalF,'totalReq',r.estimasi.totalReq,'hariDyn',r.estimasi.hariWeekdayDyn,'dynLimit',dynLimit);