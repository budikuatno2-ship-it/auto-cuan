#!/usr/bin/env bash
# READ-ONLY probe A2b: ringkasan per tanggal 20-22 Okt di log job harian.
set -uo pipefail
L=/home/ubuntu/auto-cuan-runner/logs

echo "===== daily-market-update.log : baris paling akhir per tanggal ====="
awk '
/Target|target|Sesi|SESSION|tanggal/ { }
/^\[DAILY|^===|^---/ { }
{ lines[NR]=$0 }
END {
  for(i=1;i<=NR;i++){
    if (lines[i] ~ /2026-10-(20|21|22)/) {
      print i": "lines[i];
    }
  }
}' $L/daily-market-update.log 2>/dev/null | grep -E "Status:|target|Target|SELESAI|GAGAL|BELUM LENGKAP|CIRCUIT|SKIPPED_ARJUM_BUSY|BUDGET|DONE" | tail -60

echo
echo "===== ringkasan: Status per tanggal (dihitung) ====="
node -e '
const fs=require("fs");
const f="/home/ubuntu/auto-cuan-runner/logs/daily-market-update.log";
let lines=[];try{lines=fs.readFileSync(f,"utf8").split("\n");}catch(e){console.log("NO_LOG");process.exit(0);}
let cur=null;const out={};
for(const l of lines){
  const m=l.match(/(\d{4}-\d{2}-\d{2})/g);
  const stat=l.match(/^Status: (.*)$/);
  if(stat&&m){ const d=m[m.length-1]; (out[d]=out[d]||[]).push(stat[1]); }
}
for(const d of Object.keys(out).sort().slice(-8)){
  const arr=out[d];
  console.log(d, "status_lines="+arr.length);
  const last=arr[arr.length-1];
  console.log("   terakhir:", last);
  const uniq=[...new Set(arr)];
  if(uniq.length>1) console.log("   semua   :", uniq.join(" | ").slice(0,400));
}
'
