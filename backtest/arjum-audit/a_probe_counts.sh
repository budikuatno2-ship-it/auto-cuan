#!/usr/bin/env bash
# READ-ONLY probe A1: hitungan file per tipe & per tanggal (19-22 Okt) + 10 saham uji.
set -uo pipefail
cd /home/ubuntu/auto-cuan || exit 1

node -e '
const fs=require("fs"),path=require("path");
const ROOT="data/arjum-data";
const TYPES=[
  ["ALL","broker-summary"],
  ["F","broker-summary-F"],
  ["AKUMULASI","broker-accumulation"],
  ["INSIDER","insiders"]
];
const DATES=["2026-10-16","2026-10-19","2026-10-20","2026-10-21","2026-10-22"];

function tickerDirs(sub){
  const p=path.join(ROOT,sub);
  if(!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter(d=>{
    try{return fs.statSync(path.join(p,d)).isDirectory();}catch(e){return false;}
  });
}

console.log("== jumlah direktori emiten per tipe ==");
const all={};
for(const [name,sub] of TYPES){
  const dirs=tickerDirs(sub);
  all[name]=dirs;
  console.log(name+" ("+sub+"): "+dirs.length+" direktori");
}

console.log();
console.log("== jumlah file TANGGAL per tipe ==");
const table={};
for(const d of DATES) table[d]={};
for(const [name,sub] of TYPES){
  for(const d of DATES) table[d][name]=0;
  let counted=0;
  for(const t of all[name]){
    const dir=path.join(ROOT,sub,t);
    let files=[];
    try{files=fs.readdirSync(dir);}catch(e){continue;}
    for(const d of DATES){
      if(files.includes(d+".json")) { table[d][name]++; }
    }
    counted++;
  }
}
for(const d of DATES){
  const r=table[d];
  console.log(d+" : ALL="+r.ALL+" F="+r.F+" AKUMULASI="+r.AKUMULASI+" INSIDER="+r.INSIDER);
}

console.log();
console.log("== 10 saham uji (file per tanggal) ==");
const TEN=["BBCA","BRPT","BBRI","MEDC","ADRO","BUMI","BMRI","TPIA","BBNI","TLKM"];
for(const t of TEN){
  const parts=[];
  for(const [name,sub] of TYPES){
    const dir=path.join(ROOT,sub,t);
    let files=[];try{files=fs.readdirSync(dir);}catch(e){}
    const hits=DATES.filter(d=>files.includes(d+".json")).map(d=>d.slice(5));
    parts.push(name+"["+(hits.length?hits.join(","):"-")+"]");
  }
  console.log(t.padEnd(6)+" "+parts.join(" "));
}

console.log();
console.log("== latest.json per tipe (konten tanggal saja) ==");
for(const [name,sub] of TYPES){
  const c={};
  let n=0;
  for(const t of all[name]){
    const f=path.join(ROOT,sub,t,"latest.json");
    if(!fs.existsSync(f)) continue;
    n++;
    let d="(unreadable)";
    try{const j=JSON.parse(fs.readFileSync(f,"utf8")); d=j.date||j.broker_date||j.end_date||j.as_of_date||j.broker_date_max||"(no-date-field)";}catch(e){}
    c[d]=(c[d]||0)+1;
  }
  console.log(name+": latest.json ada="+n+" -> "+JSON.stringify(c));
}
'
