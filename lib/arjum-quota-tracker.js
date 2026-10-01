'use strict';

/**
 * Arjum Daily Quota Tracker — persistent, cross-process usage counter.
 *
 * Root problem this fixes: tools/backfill-arjum-data.js and
 * tools/run-daily-broker-update.js each tracked "requests used today" in an
 * in-process variable starting at 0 on every invocation. Since both are
 * separate cron-fired processes (backfill once at 00:05, the daily update
 * job up to 5x between 20:00-22:00), neither ever knew how much quota the
 * OTHER one had already spent that day — a --reserve-quota computed against
 * a per-process counter that resets to 0 every run is not a real reservation
 * at all once more than one process touches the quota in the same day.
 *
 * This tracker persists actual usage to a small JSON file keyed by the
 * current WIB calendar date, incremented once per real network call
 * fetchArjum() issues (success or failure — a sent request is a sent
 * request; if Arjum happens to not count rejected calls against quota, this
 * undercounts remaining budget slightly, which only makes callers MORE
 * conservative, never less).
 *
 * This is the fallback/primary source of truth. When Arjum's response ever
 * carries a real rate-limit header (see extractQuotaHeaders in
 * arjum-client.js), callers should prefer that live number — this tracker
 * exists for the (current, confirmed) case where no such header is sent.
 */

const fs = require('fs');
const path = require('path');

function getArjumDataDir() {
  const configured = process.env.ARJUM_DATA_DIR;
  if (configured && fs.existsSync(configured)) return configured;
  return path.join(__dirname, '..', 'data', 'arjum-data');
}

function getStatePath() {
  return path.join(getArjumDataDir(), '_quota-state', 'usage.json');
}

function getTodayWibKey(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(now || new Date());
}

// Reads the state file, resetting in memory (not yet persisted) to 0 if the
// stored date is not today's WIB date — this is the "reset otomatis jam
// 00:00 WIB" behavior, implemented as "any read/write on a new day starts
// counting from 0" rather than a scheduled job, so it works correctly even
// if no process happens to run exactly at midnight.
function readState() {
  const today = getTodayWibKey();
  try {
    const raw = fs.readFileSync(getStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.date === today && Number.isFinite(parsed.used)) {
      return { date: today, used: parsed.used };
    }
  } catch (_) {}
  return { date: today, used: 0 };
}

function writeState(state) {
  try {
    const p = getStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ date: state.date, used: state.used, updated_at: new Date().toISOString() }, null, 2));
  } catch (_) {
    // Best-effort persistence. A failed write just means the next read falls
    // back to whatever was last durably saved (or 0 on a new day) — callers
    // still function, just with a less accurate cross-process count for
    // this one increment.
  }
}

// Not perfectly atomic against truly concurrent writers, but backfill and
// the daily-update job are scheduled to never overlap (00:05 vs 20:00-22:00,
// each also flock-guarded against overlapping with itself), so a
// read-modify-write here is sufficient in practice.
function recordUsage(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  const state = readState();
  state.used += n;
  writeState(state);
  return state.used;
}

function getUsedToday() {
  return readState().used;
}

function getRemainingToday(configuredDailyQuota) {
  const total = Number.isFinite(configuredDailyQuota) && configuredDailyQuota > 0 ? configuredDailyQuota : 0;
  return Math.max(0, total - getUsedToday());
}

// For tests and operational resets only (e.g. correcting a bad manual entry)
// — never called from normal request-handling code.
function resetForTesting(used) {
  writeState({ date: getTodayWibKey(), used: Number.isFinite(used) ? used : 0 });
}

module.exports = {
  getTodayWibKey,
  getStatePath,
  recordUsage,
  getUsedToday,
  getRemainingToday,
  resetForTesting
};
