#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const reportLib = require('../lib/daytrade-compare-report');

function parseArgs(argv) {
  const args = { logsFile: reportLib.DEFAULT_LOGS_FILE, outputDir: reportLib.DEFAULT_OUTPUT_DIR, limit: 10, writeJson: false, productionSource: 'supabase', productionFile: null, apiBase: null, token: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.writeJson = true;
    else if (a.indexOf('--') === 0) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[i + 1] && argv[i + 1].indexOf('--') !== 0 ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  args.limit = Number(args.limit || 10);
  return args;
}

async function readProductionFromFile(file) {
  if (!file) throw new Error('--production-file is required when --production-source file');
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  return { rows: reportLib.asArray(parsed), detail: path.resolve(file) };
}

async function readProductionFromSupabase(limit) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY are required for Supabase read.');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.from('daytrade_screener_latest').select('*').order('daytrade_score', { ascending: false }).limit(limit || 50);
  if (error) throw new Error('Supabase read failed: ' + error.message);
  return { rows: data || [], detail: 'daytrade_screener_latest ordered by daytrade_score desc' };
}

async function readProductionFromApi(apiBase, token) {
  if (!apiBase) throw new Error('--api-base is required when --production-source api');
  const url = new URL(apiBase);
  if (!url.searchParams.get('action')) url.searchParams.set('action', 'daytrade-screener');
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('API read failed with HTTP ' + res.status);
  const body = await res.json();
  if (body && body.success === false) throw new Error('API read failed: ' + (body.error || 'unknown error'));
  return { rows: reportLib.asArray(body), detail: reportLib.sanitizeForOutput(url.toString()) };
}

async function readProduction(args) {
  if (args.productionSource === 'file') return readProductionFromFile(args.productionFile);
  if (args.productionSource === 'api') return readProductionFromApi(args.apiBase, args.token || process.env.DAYTRADE_REPORT_API_TOKEN || process.env.CRON_SECRET);
  if (args.productionSource === 'supabase') return readProductionFromSupabase(args.limit || 50);
  throw new Error('Unsupported --production-source: ' + args.productionSource);
}

async function main() {
  const args = parseArgs(process.argv);
  const local = await reportLib.readLatestLocalRun(args.logsFile);
  if (!local.ok) throw new Error(local.error);
  let production;
  try { production = await readProduction(args); } catch (e) { throw new Error('Production data unavailable: ' + e.message); }
  const comparison = reportLib.compareDayTrade(local.rows, production.rows, { limit: args.limit });
  const date = new Date().toISOString().slice(0, 10);
  const out = {
    date,
    generated_at: new Date().toISOString(),
    sources: { local: { logs_file: path.resolve(args.logsFile), latest_run_ended_at: local.run.ended_at || null }, production: { type: args.productionSource, detail: production.detail } },
    comparison
  };
  const paths = await reportLib.writeReports(out, { outputDir: args.outputDir, writeJson: args.writeJson });
  console.log(reportLib.markdownReport(out));
  console.log('Reports written:');
  console.log('- markdown: ' + paths.markdown);
  if (paths.json) console.log('- json: ' + paths.json);
}

if (require.main === module) main().catch((e) => { console.error(reportLib.sanitizeForOutput(e.message || e.stack)); process.exitCode = 1; });

module.exports = { parseArgs, readProductionFromFile, readProductionFromSupabase, readProductionFromApi, readProduction };
