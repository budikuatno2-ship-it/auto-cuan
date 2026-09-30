#!/usr/bin/env node
'use strict';

/**
 * Import verified multi-year financial history for DeepScan.
 *
 * Usage:
 *   node tools/import-deepscan-financial-history.js data/deepscan-financial-history.csv --dry-run
 *   node tools/import-deepscan-financial-history.js data/deepscan-financial-history.csv
 *
 * Required columns:
 *   ticker,period_end,period_type,source
 * Optional:
 *   fiscal_year,currency,revenue,operating_income,net_income,
 *   operating_cash_flow,capital_expenditure,free_cash_flow,total_assets,
 *   total_liabilities,equity,shares_outstanding,eps,book_value_per_share,
 *   source_document
 */

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const financial = require('../lib/deepscan-financial-history');

function loadEnvFile(rootDir) {
  for (const name of ['.env.ai-eval-once','.env.local','.env']) {
    const file = path.join(rootDir,name);
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
        const text=line.trim();
        if (!text || text.startsWith('#')) continue;
        const idx=text.indexOf('=');
        if (idx<=0) continue;
        const key=text.slice(0,idx).trim();
        let value=text.slice(idx+1).trim();
        if ((value.startsWith('"')&&value.endsWith('"')) || (value.startsWith("'")&&value.endsWith("'"))) value=value.slice(1,-1);
        if (!process.env[key]) process.env[key]=value;
      }
    } catch (_) {}
  }
}

async function main(argv) {
  const args=argv || process.argv.slice(2);
  const dryRun=args.includes('--dry-run');
  const positional=args.filter(x=>x!=='--dry-run');
  const csvPath=path.resolve(positional[0] || 'data/deepscan-financial-history.csv');
  if (!fs.existsSync(csvPath)) throw new Error('CSV file not found: '+csvPath);

  const parsed=financial.parseCsv(fs.readFileSync(csvPath,'utf8'));
  process.stdout.write('[financial-history] parsed rows='+parsed.summary.row_count+' tickers='+parsed.summary.ticker_count+' sha256='+parsed.summary.sha256+'\n');

  const grouped=new Map();
  for (const row of parsed.rows) {
    if (!grouped.has(row.ticker)) grouped.set(row.ticker,[]);
    grouped.get(row.ticker).push(row);
  }
  for (const [ticker, rows] of Array.from(grouped.entries()).sort((a,b)=>a[0].localeCompare(b[0]))) {
    const annual=financial.annualRows(rows);
    const years=annual.map(x=>x.fiscal_year);
    process.stdout.write('  '+ticker+' FY='+years.join(',')+' periods='+rows.length+'\n');
  }

  if (dryRun) {
    process.stdout.write('[financial-history] --dry-run: validation only, no writes performed.\n');
    return;
  }

  loadEnvFile(path.resolve(__dirname,'..'));
  const url=process.env.SUPABASE_URL;
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});

  const batchSize=200;
  let written=0;
  for (let i=0;i<parsed.rows.length;i+=batchSize) {
    const batch=parsed.rows.slice(i,i+batchSize).map(row=>Object.assign({},row,{
      verified_at: row.verified_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));
    const res=await db.from('stock_financial_history').upsert(batch,{onConflict:'ticker,period_end,period_type'});
    if (res.error) throw new Error('Financial history upsert failed: '+res.error.message);
    written += batch.length;
  }
  process.stdout.write('[financial-history] upserted '+written+' rows.\n');
}

if (require.main===module) {
  main(process.argv.slice(2)).catch(error=>{
    process.stderr.write('[financial-history] error: '+String(error&&error.message||error).slice(0,220)+'\n');
    process.exitCode=1;
  });
}

module.exports={main,loadEnvFile};
