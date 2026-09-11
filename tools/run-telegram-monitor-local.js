#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = process.env.AUTO_CUAN_REPO || (fs.existsSync(path.join(__dirname, '..', 'package.json')) ? path.resolve(__dirname, '..') : '/home/ubuntu/auto-cuan');
const RUNNER_DIR = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;

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
}

function getJakartaDateParts(now = new Date()) {
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const day = wib.getUTCDay();
  const hours = wib.getUTCHours();
  const minutes = wib.getUTCMinutes();
  const totalMinutes = hours * 60 + minutes;
  const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return { day, hours, minutes, totalMinutes, timeStr };
}

function isMarketSessionWib(now = new Date()) {
  const { day, totalMinutes, timeStr } = getJakartaDateParts(now);
  const isWeekday = day >= 1 && day <= 5;
  if (!isWeekday) return { active: false, reason: 'weekend', timeStr };
  // Active trading window: 09:05 - 16:05 WIB (545 to 965 minutes from midnight)
  if (totalMinutes < 545 || totalMinutes > 965) {
    return { active: false, reason: 'outside_trading_hours', timeStr };
  }
  return { active: true, reason: null, timeStr };
}

[
  path.join(REPO, '.env.intraday-runtime'),
  path.join(REPO, '.env.local'),
  path.join(RUNNER_DIR, '.env')
].forEach(loadEnvFile);

async function main() {
  const args = new Set(process.argv.slice(2));
  const execute = args.has('--execute');
  const finalRun = args.has('--final');
  const force = args.has('--force');

  if (execute && process.env.LOCAL_MONITOR_LIVE_APPROVED !== 'YES') {
    throw new Error(
      'LIVE_BLOCKED: set LOCAL_MONITOR_LIVE_APPROVED=YES only after production approval'
    );
  }

  // In live execution mode without --force, gracefully skip when outside IDX trading hours (09:05 - 16:05 WIB Mon-Fri)
  const sessionCheck = isMarketSessionWib();
  if (execute && !force && !sessionCheck.active) {
    const skipOutput = {
      run_mode: 'LIVE',
      success: true,
      skipped: true,
      reason: sessionCheck.reason,
      time_wib: sessionCheck.timeStr,
      message: `Skipped: ${sessionCheck.reason} (active market window is 09:05-16:05 WIB Mon-Fri). Pass --force to override.`
    };
    console.log(JSON.stringify(skipOutput, null, 2));
    process.exit(0);
  }

  for (const key of [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'CRON_SECRET'
  ]) {
    if (!process.env[key]) throw new Error(`${key}_MISSING`);
  }

  process.chdir(REPO);

  let createClient;
  try {
    createClient = require('@supabase/supabase-js').createClient;
  } catch (_) {
    createClient = require(
      path.join(REPO, 'node_modules', '@supabase', 'supabase-js')
    ).createClient;
  }
  const sectorHot = require(path.join(REPO, 'api', 'sector-hot.js'));

  const handler =
    sectorHot.__test &&
    sectorHot.__test.handleTelegramMonitorPicks;

  if (typeof handler !== 'function') {
    throw new Error('LOCAL_MONITOR_HANDLER_NOT_EXPORTED');
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );

  const query = {};

  if (!execute) {
    query.dry_run = '1';
    query.force = '1';
    query.preview_hourly_batch = '1';
  } else {
    if (finalRun) query.final = '1';
    if (force) query.force = '1';
  }

  const req = {
    method: 'GET',
    query,
    body: {},
    headers: {
      authorization: `Bearer ${process.env.CRON_SECRET}`
    }
  };

  let statusCode = null;
  let payload = null;

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },

    json(value) {
      payload = value;
      return value;
    }
  };

  await handler(req, res, supabase);

  if (!payload) throw new Error('MONITOR_RETURNED_NO_PAYLOAD');

  const output = {
    run_mode: execute ? 'LIVE' : 'DRY_RUN',
    http_status: statusCode,
    success: payload.success,
    skipped: payload.skipped,
    reason: payload.reason || null,
    dry_run: payload.dry_run === true,
    write_suppressed: payload.write_suppressed === true,
    telegram_suppressed: payload.telegram_suppressed === true,
    ai_suppressed: payload.ai_suppressed === true,
    raw_row_count: payload.raw_row_count ?? null,
    deduped_row_count: payload.deduped_row_count ?? null,
    checked_count: payload.checked_count ?? null,
    event_count: Array.isArray(payload.events) ? payload.events.length : 0,
    individual_sendable_count: payload.individual_sendable_count ?? 0,
    individual_sent_count: payload.individual_sent_count ?? 0,
    sent_count: payload.sent_count ?? 0,
    error: payload.error || null
  };

  console.log(JSON.stringify(output, null, 2));

  if (!execute) {
    const safe =
      output.dry_run &&
      output.write_suppressed &&
      output.telegram_suppressed &&
      output.ai_suppressed;

    console.log(`LOCAL_MONITOR_DRY_RUN=${safe ? 'PASS' : 'FAILED'}`);
    if (!safe) process.exitCode = 1;
  }

  if (payload.success !== true) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error('LOCAL_MONITOR_RUN=FAILED');
    console.error('ERROR=' + String(error && error.message || error));
    process.exit(1);
  });
}

module.exports = {
  loadEnvFile,
  getJakartaDateParts,
  isMarketSessionWib,
  main
};
