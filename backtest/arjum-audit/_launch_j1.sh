#!/usr/bin/env bash
# Launch J1 detached so the SSH session closing does not kill it.
set -uo pipefail
cd /home/ubuntu/auto-cuan || exit 1
cat > /tmp/run_j1_detached.sh <<'EOS'
#!/usr/bin/env bash
cd /home/ubuntu/auto-cuan || exit 1
O=/tmp/j1_verify.txt
{
echo "start=$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "quota_before=$(cat data/arjum-data/_quota-state/usage.json | tr -d '\n ')"
} > "$O" 2>&1
timeout 1500 bash deploy/vps/run-daily-market-update.sh --accum-source=api --insider-mode=daily >> "$O" 2>&1
RC=$?
{
echo "rc=$RC"
echo "end=$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "quota_after=$(cat data/arjum-data/_quota-state/usage.json | tr -d '\n ')"
echo "--- summary ---"
grep -aE 'Target Date \(WIB\)|^Status:|Total Permintaan|broker-summary:|Tersimpan di disk|Pemutus Sirkuit|Kuota Habis|J1-ZERO-SAVED|CIRCUIT BREAKER|Broker Summary Selesai' "$O" | tail -20
echo "--- files per type 2026-10-23 ---"
node -e '
const fs=require("fs"),path=require("path");const base="data/arjum-data";
for(const [k,d] of [["ALL","broker-summary"],["F","broker-summary-F"],["AKUMULASI","broker-accumulation"],["INSIDER","insiders"]]){
 let n=0;try{for(const t of fs.readdirSync(path.join(base,d))){try{if(fs.existsSync(path.join(base,d,t,"2026-10-23.json")))n++;}catch(e){}}}catch(e){}
 console.log(k+"="+n);}'
echo "--- marker ---"
node -e 'try{const m=JSON.parse(require("fs").readFileSync("data/arjum-data/_daily-update-marker/2026-10-23.json","utf8"));console.log("complete="+m.complete+" done="+m.done+" pending="+m.pending+" errors="+m.errors);}catch(e){console.log("no marker")}'
} >> "$O" 2>&1
EOS
chmod +x /tmp/run_j1_detached.sh
setsid nohup /tmp/run_j1_detached.sh > /dev/null 2>&1 < /dev/null &
sleep 3
echo "launched"
ps -eo pid,etime,cmd | grep -E 'run_j1_detached|run-daily-market-update' | grep -v grep || echo "NOT_RUNNING"
