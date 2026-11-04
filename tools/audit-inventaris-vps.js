#!/usr/bin/env node
/* audit-inventaris-vps.js — inventory all 964 tickers */
const fs=require("fs"),path=require("path");
const D="/home/ubuntu/auto-cuan/data/arjum-data";
const B=path.join(D,"broker-summary");
const BF=path.join(D,"broker-summary-F");
const tDirs=fs.readdirSync(B).filter(d=>fs.statSync(path.join(B,d)).isDirectory());
const r={total:tDirs.length,broksum:{},foreign:{},domestik:{},akumulasi:{}};
for(const t of tDirs){
  const bd=fs.readdirSync(path.join(B,t)).filter(f=>f.endsWith(".json")&&f!=="latest.json").sort();
  const fd=fs.existsSync(path.join(BF,t))?fs.readdirSync(path.join(BF,t)).filter(f=>f.endsWith(".json")&&f!=="latest.json").sort():[];
  r.broksum[t]=bd.length;r.foreign[t]=fd.length;
  r.domestik[t]=Math.min(bd.length,fd.length);
}
fs.writeFileSync("/tmp/inventaris-vps.json",JSON.stringify(r,null,2));
console.log("tickers:",r.total," broksum files:",Object.values(r.broksum).reduce((a,b)=>a+b,0)," foreign files:",Object.values(r.foreign).reduce((a,b)=>a+b,0));