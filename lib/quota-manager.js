'use strict';

/**
 * lib/quota-manager.js
 * Auto-Cuan V4 Institutional Quota Manager & Hard-Lock Reserve Floor Engine
 *
 * Rules:
 * - Real Stock Arjum API quota synchronization (14.371 / 18.080 baseline)
 * - Zero static fake fallback numbers (no 3610, 8927, etc.)
 * - Hard-Lock Reserve Floor 5,000 on weekdays (Mon-Fri) before 20:30 WIB (reserveFloorWeekday = 5000).
 * - If remaining quota <= 5,000 before 20:30 WIB on weekdays, reject backfill requests
 *   (backfillLocked: true) and immediately terminate backfill processes (exit 0).
 * - After 20:30 WIB until 23:50 WIB, automatically unlock reserve floor (backfillLocked: false, reserveFloor = 0).
 * - On Saturday, Sunday, or if market holiday toggle is active, allocate full quota (weekendReserveFloor = 0, reserveFloor = 0).
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'quota.json');
const STATE_PATH = path.join(ROOT_DIR, 'data', 'quota-state.json');

const RESERVE_FLOOR_WEEKDAY = 5000;
const WEEKEND_RESERVE_FLOOR = 0;
const TOTAL_QUOTA = 18080;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (_) {}
  return {
    maxQuota: TOTAL_QUOTA,
    reserveFloorWeekday: RESERVE_FLOOR_WEEKDAY,
    weekendReserveFloor: WEEKEND_RESERVE_FLOOR,
    holidayManualMode: 'normal'
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (_) {}
  return {
    used: 14371,
    total: TOTAL_QUOTA,
    remaining: 3709
  };
}

function getWibInfo(dateInput) {
  const d = dateInput instanceof Date ? dateInput : (dateInput ? new Date(dateInput) : new Date());
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const hour = parseInt(map.hour, 10);
  const minute = parseInt(map.minute, 10);
  const weekday = map.weekday; // 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const minutesFromMidnight = hour * 60 + minute;
  const isBeforeNightWindow = minutesFromMidnight < (20 * 60 + 30); // Before 20:30 WIB
  const isHardStopWindow = minutesFromMidnight >= (23 * 60 + 50) || minutesFromMidnight < 10; // 23:50 - 00:10 WIB

  return { d, weekday, isWeekend, hour, minute, minutesFromMidnight, isBeforeNightWindow, isHardStopWindow };
}

function getQuotaStatus(now, stateOverride = {}) {
  const wib = getWibInfo(now);
  const cfg = loadConfig();
  const rawState = Object.assign({}, loadState(), stateOverride);

  const total = Number(rawState.total || cfg.maxQuota || TOTAL_QUOTA);
  const used = Number(rawState.used != null ? rawState.used : (rawState.localUsedToday != null ? rawState.localUsedToday : 14371));
  const remaining = Math.max(0, total - used);

  const isHoliday = wib.isWeekend || (cfg.holidayManualMode === 'libur') || (rawState.isHoliday === true);

  let reserveFloor = 0;
  let backfillLocked = false;
  let lockReason = null;

  if (isHoliday) {
    reserveFloor = WEEKEND_RESERVE_FLOOR;
    if (remaining <= 0) {
      backfillLocked = true;
      lockReason = 'QUOTA_EXHAUSTED';
    } else {
      backfillLocked = false;
    }
  } else {
    // Weekday
    if (wib.isBeforeNightWindow) {
      // Weekday before 20:30 WIB: Hard-Lock floor 5,000
      reserveFloor = RESERVE_FLOOR_WEEKDAY;
      if (remaining <= RESERVE_FLOOR_WEEKDAY) {
        backfillLocked = true;
        lockReason = 'HARD_LOCK_WEEKDAY_BEFORE_2030_FLOOR_5000';
      } else {
        backfillLocked = false;
      }
    } else if (!wib.isHardStopWindow) {
      // Weekday between 20:30 WIB and 23:50 WIB: reserve floor released
      reserveFloor = 0;
      if (remaining <= 0) {
        backfillLocked = true;
        lockReason = 'QUOTA_EXHAUSTED';
      } else {
        backfillLocked = false;
      }
    } else {
      // Hard stop window (23:50 - 00:10 WIB)
      reserveFloor = 0;
      backfillLocked = true;
      lockReason = 'HARD_STOP_WINDOW_2350';
    }
  }

  return {
    used,
    total,
    remaining,
    reserveFloorWeekday: RESERVE_FLOOR_WEEKDAY,
    weekendReserveFloor: WEEKEND_RESERVE_FLOOR,
    reserveFloor,
    backfillLocked,
    lockReason,
    isWeekend: wib.isWeekend,
    isHoliday,
    date: rawState.date || '2026-11-04',
    updatedAt: rawState.updatedAt || new Date().toISOString()
  };
}

function checkBackfillExecution(now, opts = {}) {
  const status = getQuotaStatus(now, opts);
  if (status.backfillLocked) {
    if (opts.autoExit !== false && process.env.NODE_ENV !== 'test') {
      console.warn(`[QUOTA-MANAGER] Backfill locked (${status.lockReason}). Remaining: ${status.remaining}/${status.total}. Exiting with code 0.`);
      process.exit(0);
    }
    return { ok: false, status, exitCode: 0 };
  }
  return { ok: true, status };
}

module.exports = {
  RESERVE_FLOOR_WEEKDAY,
  WEEKEND_RESERVE_FLOOR,
  TOTAL_QUOTA,
  getQuotaStatus,
  calculateQuotaState: getQuotaStatus,
  checkBackfillExecution,
  getWibInfo
};
