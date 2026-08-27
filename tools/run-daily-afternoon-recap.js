'use strict';

/**
 * Runner CLI: Daily Afternoon Recap Telegram Sender
 *
 * Usage:
 *   node tools/run-daily-afternoon-recap.js --dry-run
 *   node tools/run-daily-afternoon-recap.js --send
 *   node tools/run-daily-afternoon-recap.js --date=2026-08-27 --dry-run
 */

const recapService = require('../lib/telegram-daily-recap');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: true,
    send: false,
    date: null
  };

  args.forEach(arg => {
    if (arg === '--send') {
      options.send = true;
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
      options.send = false;
    } else if (arg.startsWith('--date=')) {
      options.date = arg.split('=')[1].trim();
    }
  });

  return options;
}

async function main() {
  const options = parseArgs();
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log('=== AUTO-CUAN DAILY AFTERNOON RECAP ===');
  console.log(`Target Date: ${options.date || recapService.getTodayWibDateStr()} (WIB)`);
  console.log(`Mode: ${options.send ? 'SEND TO TELEGRAM' : 'DRY RUN (PREVIEW ONLY)'}`);
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
    process.exit(0);
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const res = await recapService.sendDailyAfternoonRecap(supabase, {
      date: options.date,
      dryRun: options.dryRun
    });

    console.log('Generated Message:\n');
    console.log(res.message);
    console.log('\n----------------------------------------');
    console.log(`Status: ${res.sent ? 'SENT' : (res.dry_run ? 'DRY-RUN (NOT SENT)' : 'SKIPPED (' + res.reason + ')')}`);
    console.log(`Total Sinyal: ${res.total_signals}`);
  } catch (err) {
    console.error('Error generating afternoon recap:', err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}