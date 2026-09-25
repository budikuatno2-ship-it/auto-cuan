'use strict';

/**
 * Oracle Cloud Always Free Anti-Idle Watchdog
 *
 * Oracle Cloud Always Free instances are reclaimed if:
 *  - 95th percentile of CPU utilization is less than 20% over 7 days.
 *  - Memory utilization is less than 20%.
 *
 * This watchdog runs periodically (e.g. hourly via cron).
 * If the system has been idle with no significant load over the last 4 hours,
 * it runs a controlled computation (~20-25% CPU duty cycle for 90 seconds).
 *
 * Safety & Invariants:
 *  - Duty cycle: 23ms busy / 77ms yield (sleep) every 100ms slice (~23% CPU on 1 core).
 *  - Yielding 77ms every 100ms ensures PM2 processes, Telegram bots, and web requests
 *    remain completely responsive and are never starved.
 *  - Zero object allocation inside loop: memory footprint stays < 15MB.
 *  - Cleans temporary cache files > 7 days old.
 *  - Records state in runner heartbeat JSON.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const IDLE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
const BURN_DURATION_MS = 90 * 1000;          // 90 seconds
const CYCLE_WINDOW_MS = 100;                 // 100ms duty cycle window
const BUSY_SLICE_MS = 23;                    // 23ms busy = 23% CPU of 1 core
const YIELD_SLICE_MS = 77;                   // 77ms yield to event loop

function getRunnerDir() {
  return process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
}

function getHeartbeatPath() {
  const runnerDir = getRunnerDir();
  const stateDir = path.join(runnerDir, 'state');
  if (fs.existsSync(stateDir) || fs.existsSync(runnerDir)) {
    return path.join(stateDir, 'keepalive-heartbeat.json');
  }
  const localDir = path.join(__dirname, '..', 'data');
  return path.join(localDir, 'keepalive-heartbeat.json');
}

function wibTimestamp() {
  const wib = new Date(Date.now() + (7 * 60 * 60 * 1000));
  return wib.toISOString().slice(0, 19).replace('T', ' ') + ' WIB';
}

function cleanStaleFiles(dir, maxAgeDays) {
  if (!fs.existsSync(dir)) return;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        cleanStaleFiles(fullPath, maxAgeDays);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.tmp') || entry.name.endsWith('.bak')) {
          try {
            const stat = fs.statSync(fullPath);
            if (now - stat.mtimeMs > maxAgeMs) {
              fs.unlinkSync(fullPath);
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

function loadState(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveState(filePath, state) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Runs a controlled CPU load of ~20-25% on 1 core for `durationMs`.
 * Non-blocking: yields 77ms every 100ms.
 */
function runDutyCycleBurn(durationMs, onTick, onComplete) {
  const startTime = Date.now();
  let iterations = 0;

  function cycle() {
    const sliceStart = Date.now();
    // Busy computation for BUSY_SLICE_MS
    let counter = 0;
    while (Date.now() - sliceStart < BUSY_SLICE_MS) {
      counter = (counter + 1) ^ 0x5a5a;
    }
    iterations++;

    const elapsed = Date.now() - startTime;
    if (elapsed < durationMs) {
      if (typeof onTick === 'function' && iterations % 100 === 0) {
        onTick(Math.round(elapsed / 1000));
      }
      setTimeout(cycle, YIELD_SLICE_MS);
    } else {
      if (typeof onComplete === 'function') {
        onComplete(elapsed, iterations);
      }
    }
  }

  cycle();
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const force = args.has('--force');
  const dryRun = args.has('--dry-run');
  const durationArg = process.argv.find((a) => a.startsWith('--duration='));
  const targetDurationMs = durationArg ? (parseInt(durationArg.split('=')[1], 10) * 1000) : BURN_DURATION_MS;

  const heartbeatFile = getHeartbeatPath();
  const state = loadState(heartbeatFile);
  const now = Date.now();
  const lastBurnAt = state.lastBurnAt ? Number(state.lastBurnAt) : 0;
  const timeSinceLastBurn = now - lastBurnAt;

  const loadAvg = os.loadavg();
  const currentLoad1m = loadAvg[0] || 0;
  const isIdle = timeSinceLastBurn >= IDLE_THRESHOLD_MS && currentLoad1m < 0.35;

  const shouldBurn = force || isIdle;

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    wib: wibTimestamp(),
    currentLoad1m: currentLoad1m.toFixed(2),
    timeSinceLastBurnHours: (timeSinceLastBurn / (60 * 60 * 1000)).toFixed(1),
    shouldBurn,
    force,
    dryRun
  }));

  // Clean stale temp files
  const rootDir = path.resolve(__dirname, '..');
  cleanStaleFiles(path.join(rootDir, 'tmp'), 7);
  cleanStaleFiles(path.join(rootDir, 'data'), 7);

  if (!shouldBurn) {
    state.lastCheckAt = now;
    state.lastCheckWib = wibTimestamp();
    state.status = 'idle_ok_skipped';
    state.load = loadAvg.map((l) => l.toFixed(2)).join(', ');
    saveState(heartbeatFile, state);
    console.log('Keepalive: system activity sufficient, skipping CPU cycle.');
    return;
  }

  if (dryRun) {
    console.log('Keepalive dry-run: would execute ' + Math.round(targetDurationMs / 1000) + 's 22% duty cycle burn.');
    return;
  }

  console.log('Keepalive: initiating ' + Math.round(targetDurationMs / 1000) + 's controlled CPU cycle (~22% duty cycle)...');

  runDutyCycleBurn(targetDurationMs, (elapsedSec) => {
    process.stdout.write(`...progress: ${elapsedSec}s\r`);
  }, (totalElapsed, totalIters) => {
    console.log(`\nKeepalive burn completed: ${totalElapsed}ms, ${totalIters} cycles.`);
    state.lastBurnAt = Date.now();
    state.lastBurnWib = wibTimestamp();
    state.lastBurnDurationMs = totalElapsed;
    state.status = 'burned_22pct';
    state.loadAfter = os.loadavg().map((l) => l.toFixed(2)).join(', ');
    saveState(heartbeatFile, state);
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Keepalive error:', err);
    process.exit(1);
  });
}

module.exports = {
  runDutyCycleBurn,
  getHeartbeatPath,
  loadState,
  saveState,
  wibTimestamp,
  IDLE_THRESHOLD_MS,
  BURN_DURATION_MS
};
