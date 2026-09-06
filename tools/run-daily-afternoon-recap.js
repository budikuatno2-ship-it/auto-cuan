'use strict';

/**
 * Runner CLI: Daily Afternoon Recap Telegram Sender
 *
 * Usage:
 *   node tools/run-daily-afternoon-recap.js --dry-run
 *   node tools/run-daily-afternoon-recap.js --send
 *   node tools/run-daily-afternoon-recap.js --date=2026-08-27 --dry-run
 */

const fs = require('node:fs');
const path = require('node:path');
const recapService = require('../lib/telegram-daily-recap');

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
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log('=== AUTO-CUAN DAILY AFTERNOON RECAP ===');
  console.log(`Target Date: ${options.date || recapService.getTodayWibDateStr()} (WIB)`);
  console.log(`Mode: ${options.send ? 'SEND TO TELEGRAM' : 'DRY RUN (PREVIEW ONLY)'}`);
  if (options.chatId) {
    console.log(`Target Chat ID: ${options.chatId}`);
  }
  console.log('----------------------------------------\n');

  if (!supabaseUrl || !supabaseKey) {
    console.log('Notice: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in local environment.');
    if (options.send) {
      console.error('Cannot send to Telegram without database credentials.');
      process.exit(1);
    }
    console.log('Generating fallback preview for date without DB connection:\n');
    const msg = recapService.formatDailyAfternoonRecapMessage([], options.date);
    console.log(msg);
    return { dry_run: true, fallback: true, message: msg };
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    const res = await recapService.sendDailyAfternoonRecap(supabase, {
      date: options.date,
      dryRun: options.dryRun,
      chat_id: options.chatId
    });

    console.log('Generated Message:\n');
    console.log(res.message);
    console.log('\n----------------------------------------');
    console.log(`Status: ${res.sent ? 'SENT' : (res.dry_run ? 'DRY-RUN (NOT SENT)' : 'SKIPPED (' + res.reason + ')')}`);
    console.log(`Total Sinyal: ${res.total_signals}`);
    return res;
  } catch (err) {
    console.error('Error generating afternoon recap:', err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadEnvFile,
  initEnv,
  parseArgs,
  main
};