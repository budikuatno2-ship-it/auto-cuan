#!/bin/bash
# TUGAS A: Pull Q2 2026 financial statements via Arjum API
# Saves to data/arjum-data/financial-statements/<TICKER>/INCOME_STATEMENT-quarterly.json
# Usage: node tools/refresh-financial-statements.js --ticker BRPT

set -e
cd /home/ubuntu/auto-cuan
TICKER="${1:-BRPT}"
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Pulling financial statements for $TICKER from Arjum..."
node -e "
const c=require('./lib/arjum-client');
const fs=require('fs');
const path=require('path');

async function pull(ticker){
  const types=['INCOME_STATEMENT','BALANCE_SHEET','CASH_FLOW_REPORT'];
  const periods=['quarterly','annually'];
  const dir=path.join('data','arjum-data','financial-statements',ticker);
  fs.mkdirSync(dir,{recursive:true});

  for(const type of types){
    for(const period of periods){
      try{
        const r=await c.fetchArjum('/api/financials/'+ticker+'?report_type='+type+'&period='+period+'&limit=8');
        if(r.status===200 && r.data){
          const outPath=path.join(dir,type+'-'+period+'.json');
          fs.writeFileSync(outPath,JSON.stringify(r.data,null,2));
          const items=r.data.items||r.data.data||[];
          console.log(ticker,type,period,'— items:',items.length,'— saved');
        }else{
          console.log(ticker,type,period,'— status:',r.status);
        }
      }catch(e){
        console.error(ticker,type,period,'— ERR:',e.message);
      }
    }
  }
}
pull('$TICKER').then(()=>console.log('DONE')).catch(e=>console.error(e));
"