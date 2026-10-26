#!/usr/bin/env bash
set -uo pipefail
cd /home/ubuntu/auto-cuan || exit 1
echo "now=$(date '+%H:%M:%S')"
node -e '
const fs=require("fs"),path=require("path");const base="data/arjum-data";
for(const [k,d] of [["ALL","broker-summary"],["F","broker-summary-F"],["AKUMULASI","broker-accumulation"],["INSIDER","insiders"]]){
 let n=0;try{for(const t of fs.readdirSync(path.join(base,d))){try{if(fs.existsSync(path.join(base,d,t,"2026-10-23.json")))n++;}catch(e){}}}catch(e){}
 console.log(k+"="+n);}'
echo "quota=$(cat data/arjum-data/_quota-state/usage.json | tr -d '\n ')"
