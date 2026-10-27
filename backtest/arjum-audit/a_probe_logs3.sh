#!/usr/bin/env bash
# READ-ONLY probe A2c: rekap harian 20-22 Okt dari 4 log.
set -uo pipefail
node -e '
const fs=require("fs");
const L="/home/ubuntu/auto-cuan-runner/logs/";
function read(f){try{return fs.readFileSync(L+f,"utf8").split("\n");}catch(e){return null;}}

// ---------- 1. daily-market-update ----------
const dm=read("daily-market-update.log");
if(dm){
  console.log("### daily-market-update.log");
  const counts={};
  let circuit=0, skipped=0, exitLines=[];
  for(const l of dm){
    if(l.includes("[CIRCUIT BREAKER]")) circuit++;
    if(l.includes("SKIPPED_ARJUM_BUSY")) skipped++;
    if(/^Status: /.test(l)){
      const m=l.match(/(\d{4}-\d{2}-\d{2})/);
      const key=m?m[1]:"(no-date)";
      counts[key]=counts[key]||[];
      counts[key].push(l.slice(7));
    }
    const e=l.match(/\[EXIT[^\]]*\]?\s*(\d+)/);
    if(e) exitLines.push(l);
  }
  const dates=Object.keys(counts).sort();
  console.log("total_circuit_breaker_lines="+circuit+" total_skipped_arjum_busy_lines="+skipped+" exit_lines="+exitLines.length);
  for(const d of dates.slice(-6)){
    const arr=counts[d];
    console.log("-- "+d+" (status lines: "+arr.length+")");
    console.log("   terakhir: "+arr[arr.length-1]);
    console.log("   unique  : "+[...new Set(arr)].join(" || ").slice(0,600));
  }
  console.log("-- exit line contoh --");
  console.log(exitLines.slice(-6).join("\n"));
}

console.log();
console.log("### backfill-broksum.log");
const bf=read("backfill-broksum.log");
if(bf){
  let halts=[], budgets=[], skips=[], last=[];
  for(const l of bf){
    if(/HALTED|HALT|SKIP|BUDGET|Mode:|Requests Sent|Status:|Halaman|ERROR 5xx/i.test(l)) halts.push(l);
  }
  console.log("baris kunci="+halts.length);
  console.log(halts.slice(-40).join("\n"));
}

console.log();
console.log("### daily-candles.log");
const dc=read("daily-candles.log");
if(dc){
  const keys=dc.filter(l=>/fetched|failed|stale|cross|SKIP|ERROR|Status|defer/i.test(l));
  console.log(keys.slice(-40).join("\n"));
}

console.log();
console.log("### ihsg-candle.log");
const ih=read("ihsg-candle.log");
if(ih){ console.log(ih.slice(-30).join("\n")); }
'
