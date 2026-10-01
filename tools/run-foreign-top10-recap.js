'use strict';

/**
 * CLI Runner: Top 10 Foreign Flow Recap
 *
 * Computes Top 10 Accumulation, Top 10 Distribution, and Total Net Foreign
 * across the 957 IDX stock universe from cached broker summary data.
 *
 * Usage:
 *   node tools/run-foreign-top10-recap.js --dry-run
 *   node tools/run-foreign-top10-recap.js --send
 *   node tools/run-foreign-top10-recap.js --date=2026-09-04 --dry-run
 *   node tools/run-foreign-top10-recap.js --date=2026-09-04 --send
 */

const fs = require('node:fs');
const path = require('node:path');
const foreignFlowService = require('../lib/foreign-flow-recap');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/
      );
      if (!match) continue;
      if (Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
      let value = match[2].replace(/\s+#.*$/, '').trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function initEnv(baseDir = path.resolve(__dirname, '..')) {
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  [
    path.join(baseDir, '.env.intraday-runtime'),
    path.join(baseDir, '.env.local'),
    path.join(baseDir, '.env'),
    path.join(runnerDir, '.env')
  ].forEach(loadEnvFile);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: true,
    send: false,
    date: null,
    chatId: null
  };

  argv.forEach(arg => {
    if (arg === '--send') {
      options.send = true;
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
      options.send = false;
    } else if (arg.startsWith('--date=')) {
      options.date = arg.split('=')[1].trim();
    } else if (arg.startsWith('--chat-id=')) {
      options.chatId = arg.split('=')[1].trim();
    }
  });

  return options;
}

async function main(argv = process.argv.slice(2)) {
  initEnv();
  const options = parseArgs(argv);

  console.log('=== AUTO-CUAN TOP 10 FOREIGN FLOW RECAP ===');
  console.log(`Target Date: ${options.date || foreignFlowService.getTodayWibDateStr()} (WIB)`);
  console.log(`Mode: ${options.send ? 'SEND TO TELEGRAM' : 'DRY RUN (PREVIEW ONLY)'}`);
  if (options.chatId) {
    console.log(`Target Chat ID: ${options.chatId}`);
  }
  console.log('-------------------------------------------\n');

  const result = await foreignFlowService.sendForeignFlowRecap({
    date: options.date,
    send: options.send,
    dryRun: options.dryRun,
    chatId: options.chatId
  });

  console.log(result.message);
  console.log('\n-------------------------------------------');
  console.log(`Scanned: ${result.data.stocks_scanned} of ${result.data.total_universe} stocks.`);
  console.log(`Total Net Foreign: Rp ${foreignFlowService.formatIDR(result.data.total_net_foreign)}`);
  console.log(`Top Accumulation Count: ${result.data.top_accumulated.length}`);
  console.log(`Top Distribution Count: ${result.data.top_distributed.length}`);

  if (options.send) {
    if (result.sent) {
      console.log('✅ Successfully sent to Telegram!');
    } else {
      console.log(`⚠️ Telegram send result: status=${result.status}, reason=${result.reason || 'none'}`);
    }
  } else {
    console.log('ℹ️ Dry-run completed. No message sent to Telegram.');
  }

  return result;
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error in foreign flow recap:', err);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };
