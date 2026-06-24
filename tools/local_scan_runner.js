#!/usr/bin/env node
/**
 * Auto-Cuan Local Scan Runner
 * ============================
 * Runs existing screener actions locally via CMD.
 * Reuses api/sector-hot.js handler with mock req/res objects.
 *
 * Usage:
 *   node tools/local_scan_runner.js konglo
 *   node tools/local_scan_runner.js nonkonglo
 *   node tools/local_scan_runner.js swing-all
 *   node tools/local_scan_runner.js daytrade morning
 *   node tools/local_scan_runner.js daytrade midday
 *   node tools/local_scan_runner.js daytrade afternoon
 *
 * Requires .env.local (or .env) with:
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *   CRON_SECRET=...
 */

const path = require('path');
const fs = require('fs');

// === Load environment variables from .env.local or .env ===
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  content.split('\n').forEach(function(line) {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) return;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    // Remove surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  });
}

// Try .env.local first, then .env
const rootDir = path.resolve(__dirname, '..');
loadEnvFile(path.join(rootDir, '.env.local'));
loadEnvFile(path.join(rootDir, '.env'));

// === Validate required env ===
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET'];
const missing = REQUIRED_ENV.filter(function(k) { return !process.env[k]; });
if (missing.length > 0) {
  console.error('');
  console.error('  =============================================');
  console.error('  Local scan belum siap.');
  console.error('  =============================================');
  console.error('');
  console.error('  File .env.local belum ditemukan atau belum lengkap.');
  console.error('  Variable yang belum ada: ' + missing.join(', '));
  console.error('');
  console.error('  Jalankan tools\\SETUP_LOCAL_SCAN_ENV.bat sekali saja');
  console.error('  untuk membuat .env.local.');
  console.error('');
  process.exit(1);
}

// === Load the handler ===
const handler = require('../api/sector-hot');

// === Mock req/res ===
function createMockReq(action, extraQuery) {
  const query = Object.assign({ action: action }, extraQuery || {});
  return {
    method: 'GET',
    headers: { authorization: 'Bearer ' + process.env.CRON_SECRET },
    query: query,
    body: null
  };
}

function createMockRes() {
  let _status = 200;
  let _json = null;
  const res = {
    status: function(code) { _status = code; return res; },
    json: function(data) { _json = data; return res; },
    getStatus: function() { return _status; },
    getData: function() { return _json; }
  };
  return res;
}

// === Progress display ===
function printProgress(label, data) {
  const status = data.status || data.step || '?';
  const scanned = data.scanned_count || data.processed || '-';
  const passed = data.passed_count || data.passed || data.saved_count || '-';
  const failed = data.failed_count || data.failed || '-';
  const universe = data.universe_count || '-';
  const batch = data.batch_index != null ? (data.batch_index + 1) + '/' + (data.batch_count || '?') : (data.batch_count || '-');
  const msg = data.message || '';

  process.stdout.write(
    '\r  [' + label + '] Status: ' + status +
    ' | Universe: ' + universe +
    ' | Scanned: ' + scanned +
    ' | Passed: ' + passed +
    ' | Failed: ' + failed +
    ' | Batch: ' + batch +
    '   '
  );
  if (msg) console.log('\n  > ' + msg);
}

// === Scan executors ===
async function runKonglo() {
  console.log('\n  Running: Konglo Swing Screener (refresh-screener)');
  console.log('  ' + '-'.repeat(50));

  const req = createMockReq('refresh-screener');
  const res = createMockRes();
  await handler(req, res);
  const data = res.getData();

  if (data && data.success) {
    console.log('  Status: SUCCESS');
    console.log('  Universe: ' + (data.universe_count || '-'));
    console.log('  Scanned: ' + (data.scanned_count || '-'));
    console.log('  Saved: ' + (data.saved_count || '-'));
    console.log('  Failed: ' + (data.failed_count || 0));
    if (data.message) console.log('  Message: ' + data.message);
    return true;
  } else {
    console.log('  Status: FAILED');
    console.log('  Error: ' + (data ? data.error : 'No response'));
    return false;
  }
}

async function runNonKonglo() {
  console.log('\n  Running: Non-Konglo Swing Screener (nk-screener-run)');
  console.log('  ' + '-'.repeat(50));

  const MAX_CALLS = 60;
  let callCount = 0;
  let finalOk = false;

  while (callCount < MAX_CALLS) {
    callCount++;
    const extraQuery = callCount === 1 ? { force: '1' } : {};
    const req = createMockReq('nk-screener-run', extraQuery);
    const res = createMockRes();
    await handler(req, res);
    const data = res.getData();

    if (!data) { console.log('\n  ERROR: No response at call ' + callCount); break; }

    // Check terminal states
    if (data.step === 'finalize' || data.status === 'published' || (data.success && data.published > 0)) {
      console.log('\n  Status: PUBLISHED');
      console.log('  Published: ' + (data.published || data.staging_count || '-'));
      finalOk = true;
      break;
    }

    if (!data.success && !data.step) {
      if (data.skipped) { console.log('\n  SKIPPED: ' + (data.error || '')); break; }
      if ((data.error || '').indexOf('pending/processing') >= 0) {
        process.stdout.write('\r  Waiting for pending batches...   ');
        await sleep(2000);
        continue;
      }
      if ((data.message || '').indexOf('No action needed') >= 0) {
        console.log('\n  Already done for today.');
        finalOk = true;
        break;
      }
      console.log('\n  FAILED: ' + (data.error || 'Unknown error'));
      break;
    }

    printProgress('NK', data);

    if ((data.message || '').indexOf('No action needed') >= 0) {
      console.log('\n  Already done for today.');
      finalOk = true;
      break;
    }

    await sleep(600);
  }

  if (!finalOk && callCount >= MAX_CALLS) {
    console.log('\n  ERROR: Max calls reached (' + MAX_CALLS + ').');
  }
  return finalOk;
}

async function runDayTrade(mode) {
  console.log('\n  Running: Day Trade Screener (mode: ' + mode + ')');
  console.log('  NOTE: Day Trade scan saat ini berbasis candle harian sebagai radar awal.');
  console.log('        Konfirmasi intraday tetap wajib.');
  console.log('  ' + '-'.repeat(50));

  const MAX_BATCHES = 120;
  let batch = 0;
  let finalOk = false;

  while (batch < MAX_BATCHES) {
    const extraQuery = { force: '1', batch: String(batch) };
    if (mode && mode !== 'full') extraQuery.mode = mode;
    const req = createMockReq('daytrade-screener-run', extraQuery);
    const res = createMockRes();
    await handler(req, res);
    const data = res.getData();

    if (!data) { console.log('\n  ERROR: No response at batch ' + batch); break; }

    if (!data.success && data.status !== 'running') {
      console.log('\n  FAILED: ' + (data.error || data.message || 'Unknown error'));
      break;
    }

    printProgress('DT/' + mode, data);

    const status = data.status || '';
    if (status === 'published' || status === 'already_done') {
      console.log('\n  Status: ' + status.toUpperCase());
      console.log('  Published: ' + (data.published_count || data.passed_count || '-'));
      finalOk = true;
      break;
    }
    if (status === 'failed') {
      console.log('\n  FAILED: ' + (data.error || data.message || ''));
      break;
    }

    const nextBatch = data.next_batch;
    if (nextBatch != null && nextBatch > batch) { batch = nextBatch; }
    else { batch++; }

    await sleep(500);
  }

  if (!finalOk && batch >= MAX_BATCHES) {
    console.log('\n  ERROR: Max batches reached (' + MAX_BATCHES + ').');
  }
  return finalOk;
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// === Main ===
async function main() {
  const args = process.argv.slice(2);
  const command = (args[0] || '').toLowerCase();
  const subArg = (args[1] || '').toLowerCase();

  console.log('\n' + '='.repeat(55));
  console.log('  Auto-Cuan Local Scan Runner');
  console.log('='.repeat(55));

  const startTime = Date.now();
  let success = false;

  if (command === 'konglo') {
    success = await runKonglo();
  } else if (command === 'nonkonglo' || command === 'non-konglo') {
    success = await runNonKonglo();
  } else if (command === 'swing-all' || command === 'swingall') {
    console.log('\n  Mode: Swing All (Konglo first, then Non-Konglo)');
    const kongloOk = await runKonglo();
    if (!kongloOk) {
      console.log('\n  Konglo failed. Non-Konglo dibatalkan.');
    } else {
      console.log('\n  Konglo selesai. Memulai Non-Konglo...');
      const nkOk = await runNonKonglo();
      if (!nkOk) {
        console.log('\n  Konglo selesai, Non-Konglo gagal.');
      } else {
        success = true;
      }
    }
  } else if (command === 'daytrade' || command === 'dt') {
    const mode = subArg || 'morning';
    if (!['morning', 'midday', 'afternoon', 'full'].includes(mode)) {
      console.error('  Invalid day trade mode: ' + mode);
      console.error('  Valid: morning, midday, afternoon, full');
      process.exit(1);
    }
    success = await runDayTrade(mode);
  } else {
    console.log('\n  Usage:');
    console.log('    node tools/local_scan_runner.js konglo');
    console.log('    node tools/local_scan_runner.js nonkonglo');
    console.log('    node tools/local_scan_runner.js swing-all');
    console.log('    node tools/local_scan_runner.js daytrade morning');
    console.log('    node tools/local_scan_runner.js daytrade midday');
    console.log('    node tools/local_scan_runner.js daytrade afternoon');
    console.log('    node tools/local_scan_runner.js daytrade full');
    process.exit(0);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(55));
  console.log('  ' + (success ? 'DONE' : 'FINISHED WITH ERRORS') + ' (' + elapsed + 's)');
  console.log('='.repeat(55) + '\n');
}

main().catch(function(e) {
  console.error('\n  UNEXPECTED ERROR: ' + e.message);
  process.exit(1);
});
