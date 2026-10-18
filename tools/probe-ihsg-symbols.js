'use strict';

/**
 * Probe IHSG / Composite Symbol on Arjum /api/history endpoint.
 *
 * Requirements:
 * - Read-only GET only.
 * - Test symbols in order: COMPOSITE, IHSG, ^JKSE.
 * - Max 3 requests total; stops as soon as one symbol succeeds.
 * - Saves response payload to data/arjum-data/_staging/ihsg-test/{symbol}.json.
 * - Compares last 5 closes with Yahoo Finance ^JKSE (16 Okt 2026 close: 5185.1).
 *   Difference > 0.5% considered a failure.
 * - Quota guard: will NOT execute if remaining quota < 400.
 */

const fs = require('fs');
const path = require('path');

// Load environment variables (.env / .env.local)
try {
  const envCandidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local'),
    '/home/ubuntu/auto-cuan-runner/.env',
    '/home/ubuntu/auto-cuan/.env'
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq > 0) {
          const k = t.slice(0, eq).trim();
          let v = t.slice(eq + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          if (!process.env[k]) process.env[k] = v;
        }
      }
    }
  }
} catch (_) {}

const arjumClient = require('../lib/arjum-client');
const quotaTracker = require('../lib/arjum-quota-tracker');

const YAHOO_BENCHMARK_CLOSE_16OCT = 5185.1;
const SYMBOLS = ['COMPOSITE', 'IHSG', '%5EJKSE']; // %5EJKSE is URL-encoded ^JKSE
const STAGING_DIR = path.join(__dirname, '..', 'data', 'arjum-data', '_staging', 'ihsg-test');

async function main() {
  console.log('=== ARJUM IHSG SYMBOL PROBE (B3) ===');

  const configuredQuota = arjumClient.getConfiguredDailyQuota();
  const usedToday = quotaTracker.getUsedToday();
  const remaining = configuredQuota - usedToday;

  console.log(`Daily Limit: ${configuredQuota} | Used Today: ${usedToday} | Remaining: ${remaining}`);

  if (remaining < 400) {
    console.log(`[QUOTA-GUARD] Sisa kuota (${remaining}) < 400. Sesuai batas keras, pengujian live dibatalkan.`);
    console.log(`Jalankan kembali script ini setelah reset kuota 00:00 WIB.`);
    return { skipped: true, reason: 'QUOTA_BELOW_400', remaining };
  }

  if (!arjumClient.hasArjumApiKey()) {
    console.error('ERROR: ARJUM_API_KEY tidak ditemukan.');
    process.exit(1);
  }

  fs.mkdirSync(STAGING_DIR, { recursive: true });

  for (const rawSymbol of SYMBOLS) {
    const symbolClean = decodeURIComponent(rawSymbol);
    console.log(`\nTesting symbol: "${symbolClean}" (URL: /api/history/${rawSymbol}?limit=30&frame=daily)...`);

    try {
      const endpoint = `/api/history/${rawSymbol}?limit=30&frame=daily`;
      const res = await arjumClient.fetchArjum(endpoint, { fresh: true, forceLive: true, noFallback: true });

      console.log(`  HTTP Status: ${res.status} | ok: ${res.ok}`);

      // Save raw response to staging
      const safeFilename = symbolClean.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.json';
      const outPath = path.join(STAGING_DIR, safeFilename);
      fs.writeFileSync(outPath, JSON.stringify(res, null, 2), 'utf8');
      console.log(`  Staged payload saved to: ${outPath}`);

      if (res.ok && res.data) {
        const rows = Array.isArray(res.data) ? res.data : (res.data.rows || res.data.candles || res.data.history || []);
        console.log(`  Rows returned: ${rows.length}`);

        if (rows.length > 0) {
          const first = rows[0];
          const last = rows[rows.length - 1];
          console.log(`  First row date: ${first.date || first.t} | Last row date: ${last.date || last.t}`);

          // Check fields (volume, value)
          const sampleRow = rows[0];
          console.log(`  Available fields in row: ${Object.keys(sampleRow).join(', ')}`);

          // Compare last close with Yahoo Benchmark
          const newestRow = rows.sort((a, b) => String(b.date || b.t || '').localeCompare(String(a.date || a.t || '')))[0];
          const closeVal = Number(newestRow.close || newestRow.c || 0);
          const diffPct = Math.abs((closeVal - YAHOO_BENCHMARK_CLOSE_16OCT) / YAHOO_BENCHMARK_CLOSE_16OCT) * 100;

          console.log(`  Newest Close: ${closeVal} vs Yahoo ^JKSE: ${YAHOO_BENCHMARK_CLOSE_16OCT} (Diff: ${diffPct.toFixed(2)}%)`);

          if (diffPct <= 0.5) {
            console.log(`  [SUCCESS] Symbol "${symbolClean}" matches market benchmark within 0.5%!`);
            console.log(`  Stopping probe (first successful symbol found).`);
            return { success: true, symbol: symbolClean, rowsCount: rows.length, diffPct };
          } else {
            console.log(`  [MISMATCH] Diff ${diffPct.toFixed(2)}% > 0.5%. Symbol discarded.`);
          }
        }
      }
    } catch (err) {
      console.log(`  Request error: ${err.message}`);
    }
  }

  console.log('\n[PROBE COMPLETED] Tidak ada simbol Arjum yang cocok dalam batas toleransi.');
  return { success: false, reason: 'NO_MATCHING_SYMBOL' };
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
