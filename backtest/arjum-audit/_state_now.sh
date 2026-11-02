#!/usr/bin/env bash
set -uo pipefail
cd /home/ubuntu/auto-cuan || exit 1
O=/tmp/state_now.txt
{
echo "now=$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "HEAD=$(git rev-parse --short HEAD)"
echo "quota=$(cat data/arjum-data/_quota-state/usage.json | tr -d '\n ')"
echo
echo "=== files per type 2026-10-23 ==="
node -e '
const fs=require("fs"),path=require("path");const base="data/arjum-data";
for(const [k,d] of [["ALL","broker-summary"],["F","broker-summary-F"],["AKUMULASI","broker-accumulation"],["INSIDER","insiders"]]){
 let n=0;try{for(const t of fs.readdirSync(path.join(base,d))){try{if(fs.existsSync(path.join(base,d,t,"2026-10-23.json")))n++;}catch(e){}}}catch(e){}
 console.log(k+"="+n);}'
echo
echo "=== marker 2026-10-23 (key fields) ==="
node -e '
try{const m=JSON.parse(require("fs").readFileSync("data/arjum-data/_daily-update-marker/2026-10-23.json","utf8"));
console.log("complete="+m.complete+" done="+m.done+" pending="+m.pending+" errors="+m.errors+" total="+m.total_tickers+" updated="+m.updated_at);}catch(e){console.log("no marker")}'
echo
echo "=== J1 skip/zero alarm state ==="
cat data/j1-skip-alarm.json 2>/dev/null
echo
echo "=== last J1 run summary (noise filtered) ==="
grep -aE 'Target Date \(WIB\)|^Status:|Total Permintaan|broker-summary:|Tersimpan di disk|Pemutus Sirkuit|Kuota Habis|J1-ZERO-SAVED|CIRCUIT BREAKER' /home/ubuntu/auto-cuan-runner/logs/daily-market-update.log | tail -20
} > "$O" 2>&1
echo "written=$O"
