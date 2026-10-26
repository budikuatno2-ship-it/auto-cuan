#!/usr/bin/env bash
# READ-ONLY probe A: backlog per tipe, marker harian, kuota, 10 saham uji.
set -uo pipefail
cd /home/ubuntu/auto-cuan || exit 1
ROOT=data/arjum-data

echo "== layout broker-summary/BBCA (5 terakhir) =="
ls -1 $ROOT/broker-summary/BBCA 2>/dev/null | tail -5
ls -1 $ROOT/broker-summary-F/BBCA 2>/dev/null | tail -5
ls -1 $ROOT/broker-accumulation/BBCA 2>/dev/null | tail -5
ls -1 $ROOT/insiders/BBCA 2>/dev/null | tail -5

echo
echo "== marker files (20 Okt ke belakang) =="
ls -1 $ROOT/_daily-update-marker 2>/dev/null | tail -15
echo "-- quarantine --"
ls -1 $ROOT/_daily-update-marker/_quarantine 2>/dev/null | tail -15

echo
echo "== ringkasan marker per tanggal (fields saja) =="
node -e '
const fs=require("fs"),path=require("path");
const dir="data/arjum-data/_daily-update-marker";
let files=[];
try{files=fs.readdirSync(dir).filter(f=>f.endsWith(".json"));}catch(e){console.log("NO_MARKER_DIR");process.exit(0);}
files.sort();
for(const f of files.slice(-12)){
  try{
    const m=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
    console.log(f.replace(".json",""),
      "complete="+(m.complete===true),
      "done="+(m.done!==undefined?m.done:"-"),
      "pending="+(m.pending!==undefined?m.pending:"-"),
      "errors="+(m.errors!==undefined?m.errors:"-"),
      "total="+(m.total_tickers!==undefined?m.total_tickers:"-"),
      "aux_pending="+(m.auxiliary_pending!==undefined?m.auxiliary_pending:"-"),
      "completed_at="+(m.completed_at||"-"),
      "updated="+(m.updated_at||m.timestamp||"-"));
  }catch(e){console.log(f,"PARSE_ERR");}
}
'

echo
echo "== kuota: usage.json =="
cat $ROOT/_quota-state/usage.json 2>/dev/null
echo
echo "== ARJUM_DAILY_LIMIT (nilai, bukan rahasia) =="
grep -h -E "^\s*ARJUM_DAILY_LIMIT=" /home/ubuntu/auto-cuan/.env /home/ubuntu/auto-cuan-runner/.env 2>/dev/null | head -4

echo
echo "== backfill state.json (ringkas) =="
node -e '
const fs=require("fs");
try{
  const s=JSON.parse(fs.readFileSync("data/arjum-data/_backfill/state.json","utf8"));
  const out={};
  for(const k of Object.keys(s)){
    const v=s[k];
    if(Array.isArray(v)) out[k]=Array.isArray(v)?("array["+v.length+"]"):v;
    else if(v&&typeof v==="object") out[k]="object{"+Object.keys(v).length+"}";
    else out[k]=v;
  }
  console.log(JSON.stringify(out,null,1));
}catch(e){console.log("NO_BACKFILL_STATE",e.message);}
'
