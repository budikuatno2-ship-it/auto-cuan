'use strict';

/**
 * lib/three-horizon-ledger-sync.js
 * ============================================================================
 * V6.5.4 Daily Memory (`BARU` vs `LANJUT H+N`) + Persistent Auto-Track Sync.
 *
 * Bridges Three-Horizon snapshot regeneration (`data/three-horizon-latest.json`)
 * with persistent tracking stores (`data/signal-memory.json`,
 * `data/live-signal-ledger.json`, and `telegram_daily_picks`) using active
 * cross-day deduplication keyed by `ticker + horizon_key` so active signals
 * are never recorded twice while still recording terminal re-entries cleanly.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

const ACTIVE_STATUSES = new Set([
  'WAITING', 'WAITING_ENTRY', 'ENTERED', 'RUNNING', 'ACTIVE', 'ENTRY_HIT', 'IN_ENTRY_ZONE'
]);

const DEFAULT_MAX_HOLDING_DAYS = {
  potensi_besok: 5,
  short_swing: 10,
  swing: 30
};

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function countWeekdaysBetween(startYmd, endYmd) {
  if (!startYmd || !endYmd || startYmd >= endYmd) return 0;
  const start = new Date(startYmd + 'T00:00:00Z');
  const end = new Date(endYmd + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  let days = 0;
  const cur = new Date(start.getTime());
  while (cur < end && days < 180) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const wd = cur.getUTCDay();
    if (wd >= 1 && wd <= 5) days++;
  }
  return days;
}

function normalizeHorizonKey(row) {
  const k = String((row && (row.horizon_key || row.horizon || row.screener_type || (row.raw_payload && row.raw_payload.horizon_key))) || '').trim().toLowerCase();
  if (k === 'potensi_besok' || k === 'short_swing' || k === 'swing') return k;
  const cat = String((row && (row.category || row.holding_label)) || '').toLowerCase();
  if (cat.includes('potensi') || cat.includes('1–5') || cat.includes('1-5')) return 'potensi_besok';
  if (cat.includes('short') || cat.includes('3–10') || cat.includes('3-10')) return 'short_swing';
  if (cat.includes('swing') || cat.includes('7–30') || cat.includes('7-30')) return 'swing';
  return 'short_swing';
}

function maxHoldingDaysForHorizon(horizonKey, explicit) {
  const n = Number(explicit);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_MAX_HOLDING_DAYS[horizonKey] || 5;
}

function isRowActive(row) {
  if (!row) return false;
  if (row.hit_tp2_at || row.hit_tp1_at || row.hit_sl_at || row.bep_closed_at || row.early_exit_at) return false;
  if (row.is_final === true) return false;
  const st = String(row.status || 'WAITING_ENTRY').toUpperCase();
  return ACTIVE_STATUSES.has(st);
}

/**
 * Compute daily memory (`BARU` vs `LANJUT H+N`) across horizons BEFORE
 * overwriting `three-horizon-latest.json`.
 */
function annotateDailySignalMemory(horizonSnapshots, tradeDate, options = {}) {
  const rootDir = options.rootDir || ROOT;
  const memoryPath = options.memoryPath || path.join(rootDir, 'data', 'signal-memory.json');
  const prevThreePath = options.prevThreePath || path.join(rootDir, 'data', 'three-horizon-latest.json');
  const ledgerPath = options.ledgerPath || path.join(rootDir, 'data', 'live-signal-ledger.json');

  const storedMemory = readJsonSafe(memoryPath, { trade_date: null, entries: {} });
  const memEntries = (storedMemory && storedMemory.entries && typeof storedMemory.entries === 'object')
    ? Object.assign({}, storedMemory.entries)
    : {};

  // Seed memory from previous three-horizon snapshot & live ledger if missing
  const prevDoc = readJsonSafe(prevThreePath, null);
  if (prevDoc && prevDoc.horizons && typeof prevDoc.horizons === 'object') {
    for (const hKey of Object.keys(prevDoc.horizons)) {
      const list = (prevDoc.horizons[hKey] && (prevDoc.horizons[hKey].top20 || prevDoc.horizons[hKey].picks)) || [];
      for (const r of list) {
        const tk = String(r && r.ticker || '').trim().toUpperCase();
        if (!tk) continue;
        const mKey = `${hKey}:${tk}`;
        const prevDate = String(r.trade_date || prevDoc.trade_date || '').slice(0, 10);
        if (!memEntries[mKey] && prevDate) {
          memEntries[mKey] = {
            ticker: tk,
            horizon_key: hKey,
            first_seen_date: String(r.first_seen_date || prevDate).slice(0, 10),
            last_seen_date: prevDate,
            signal_age_status: r.signal_age_status || 'BARU',
            days_in_radar: Number(r.days_in_radar || 1)
          };
        }
      }
    }
  }

  const ledgerRows = readJsonSafe(ledgerPath, []);
  if (Array.isArray(ledgerRows)) {
    for (const lr of ledgerRows) {
      if (!isRowActive(lr)) continue;
      const tk = String(lr.ticker || '').trim().toUpperCase();
      const hKey = normalizeHorizonKey(lr);
      if (!tk) continue;
      const mKey = `${hKey}:${tk}`;
      const d = String(lr.date || '').slice(0, 10);
      if (!memEntries[mKey] && d) {
        memEntries[mKey] = {
          ticker: tk,
          horizon_key: hKey,
          first_seen_date: d,
          last_seen_date: d,
          signal_age_status: 'BARU',
          days_in_radar: 1
        };
      }
    }
  }

  const nextEntries = {};
  for (const hKey of Object.keys(horizonSnapshots || {})) {
    const snap = horizonSnapshots[hKey];
    const maxHold = maxHoldingDaysForHorizon(hKey, snap && snap.holding_days_max);
    const list = (snap && (snap.top20 || snap.picks)) || [];
    for (const r of list) {
      const tk = String(r && r.ticker || '').trim().toUpperCase();
      if (!tk) continue;
      const mKey = `${hKey}:${tk}`;
      const prev = memEntries[mKey];

      let firstSeenDate = tradeDate;
      let offsetDays = 0;
      let status = 'BARU';
      let label = 'BARU';

      if (prev && prev.first_seen_date) {
        const lastSeen = String(prev.last_seen_date || prev.first_seen_date).slice(0, 10);
        const gapFromLast = countWeekdaysBetween(lastSeen, tradeDate);
        if (lastSeen === tradeDate) {
          // Idempotent same-day re-run preserves existing age status
          firstSeenDate = prev.first_seen_date;
          offsetDays = Math.max(0, countWeekdaysBetween(firstSeenDate, tradeDate));
        } else if (lastSeen < tradeDate && gapFromLast <= maxHold) {
          // Appeared recently within active horizon window -> LANJUT H+N
          firstSeenDate = prev.first_seen_date;
          offsetDays = Math.max(1, countWeekdaysBetween(firstSeenDate, tradeDate));
        }
      }

      if (offsetDays >= 1) {
        status = 'LANJUT';
        label = 'LANJUT H+' + offsetDays;
      }

      r.signal_age_status = status;
      r.signal_age_label = label;
      r.first_seen_date = firstSeenDate;
      r.days_in_radar = offsetDays + 1;

      nextEntries[mKey] = {
        ticker: tk,
        horizon_key: hKey,
        first_seen_date: firstSeenDate,
        last_seen_date: tradeDate,
        signal_age_status: status,
        days_in_radar: offsetDays + 1
      };
    }
    if (snap && Array.isArray(snap.top5) && Array.isArray(snap.top20)) {
      snap.top5 = snap.top20.slice(0, Math.min(5, snap.top20.length));
    }
  }

  if (!options.dryRun) {
    atomicWriteJson(memoryPath, {
      version: 1,
      trade_date: tradeDate,
      updated_at: new Date().toISOString(),
      entries: nextEntries
    });
  }

  return nextEntries;
}

function makePickRecord(r, hKey, hSnap, tradeDate, generatedAt, id) {
  const maxHold = maxHoldingDaysForHorizon(hKey, r.holding_days_max || (hSnap && hSnap.holding_days_max));
  const holdingLabel = r.holding_label || (hSnap && hSnap.holding_label) || hKey;
  const entryHigh = Number(r.entry_high || r.entry1 || r.last_price);
  const entryLow = Number(r.entry_low || r.entry2 || entryHigh);
  const sl = Number(r.sl || r.stop_loss);
  const tp1 = Number(r.tp1);
  const tp2 = Number(r.tp2 || tp1);
  return {
    id,
    date: tradeDate,
    ticker: String(r.ticker).toUpperCase(),
    category: holdingLabel,
    monitor_source: 'three_horizon_top5',
    entry1: entryHigh,
    entry2: entryLow,
    sl,
    tp1,
    tp2,
    last_price: Number(r.last_price || entryHigh),
    status: 'WAITING_ENTRY',
    is_final: false,
    first_sent_at: generatedAt,
    created_at: generatedAt,
    updated_at: generatedAt,
    raw_payload: {
      horizon_key: hKey,
      horizon_label: r.horizon_label || (hSnap && hSnap.horizon_label) || hKey,
      holding_label: holdingLabel,
      max_holding_days: maxHold,
      holding_days_min: Number(r.holding_days_min || (hSnap && hSnap.holding_days_min) || 1),
      holding_days_max: maxHold,
      snapshot_id: r.snapshot_id || (hSnap && hSnap.snapshot_id) || null,
      snapshot_content_hash: r.snapshot_content_hash || null,
      score: r.score,
      confidence: r.confidence,
      risk_label: r.risk_label || null,
      risk_label_v2: r.risk_label_v2 || r.risk_label || null,
      action_label: r.action_label || null,
      rr: r.rr || r.risk_reward || null,
      risk_reward: r.risk_reward || r.rr || null,
      signal_age_status: r.signal_age_status || 'BARU',
      signal_age_label: r.signal_age_label || 'BARU',
      first_seen_date: r.first_seen_date || tradeDate,
      days_in_radar: r.days_in_radar || 1,
      last_seen_date: tradeDate,
      lock_source: 'three_horizon_auto_track',
      web_daily_locked_at: generatedAt,
      telegram_daily_sent_at: null,
      telegram_sent_at: null,
      sent_to_telegram_at: null
    }
  };
}

/**
 * Sync Top 5 per horizon to `data/live-signal-ledger.json` with active
 * `ticker + horizon_key` deduplication (never inserts duplicate active rows).
 */
function syncLiveSignalLedger(horizonSnapshots, tradeDate, generatedAt, options = {}) {
  const rootDir = options.rootDir || ROOT;
  const ledgerPath = options.ledgerPath || path.join(rootDir, 'data', 'live-signal-ledger.json');
  const existing = readJsonSafe(ledgerPath, []);
  const ledger = Array.isArray(existing) ? existing.slice() : [];

  const activeByKey = new Map();
  const sameDayByKey = new Set();
  let maxId = 0;
  for (const row of ledger) {
    const idNum = Number(row && row.id);
    if (Number.isFinite(idNum) && idNum > maxId) maxId = idNum;
    const tk = String(row && row.ticker || '').trim().toUpperCase();
    const hk = normalizeHorizonKey(row);
    const dt = String(row && row.date || '').slice(0, 10);
    if (tk && dt) sameDayByKey.add(`${hk}:${tk}:${dt}`);
    if (!isRowActive(row)) continue;
    if (tk) activeByKey.set(`${hk}:${tk}`, row);
  }

  let inserted = 0;
  let updatedActive = 0;

  for (const hKey of ['potensi_besok', 'short_swing', 'swing']) {
    const hSnap = horizonSnapshots && horizonSnapshots[hKey];
    const top5 = (hSnap && Array.isArray(hSnap.top5)) ? hSnap.top5.slice(0, 5) : [];
    for (const r of top5) {
      const tk = String(r && r.ticker || '').trim().toUpperCase();
      if (!tk) continue;
      const dedupKey = `${hKey}:${tk}`;
      const sameDayKey = `${hKey}:${tk}:${String(tradeDate || '').slice(0, 10)}`;
      const activeRow = activeByKey.get(dedupKey);
      if (activeRow) {
        // Active dedup: keep original signal date/entry levels intact, refresh observation metadata
        activeRow.last_price = Number(r.last_price || activeRow.last_price);
        activeRow.updated_at = generatedAt;
        activeRow.raw_payload = Object.assign({}, activeRow.raw_payload || {}, {
          last_seen_date: tradeDate,
          signal_age_status: r.signal_age_status || 'LANJUT',
          signal_age_label: r.signal_age_label || 'LANJUT H+1',
          first_seen_date: (activeRow.raw_payload && activeRow.raw_payload.first_seen_date) || activeRow.date || tradeDate,
          days_in_radar: r.days_in_radar || 2,
          score: r.score
        });
        updatedActive++;
      } else if (!sameDayByKey.has(sameDayKey)) {
        maxId += 1;
        const nextRec = makePickRecord(r, hKey, hSnap, tradeDate, generatedAt, maxId);
        ledger.push(nextRec);
        activeByKey.set(dedupKey, nextRec);
        sameDayByKey.add(sameDayKey);
        inserted++;
      }
    }
  }

  // Keep newest-first sort order deterministically
  ledger.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (Number(b.id || 0) - Number(a.id || 0)));

  if (!options.dryRun) {
    atomicWriteJson(ledgerPath, ledger);
  }

  return { ok: true, ledgerPath, total: ledger.length, inserted, updatedActive };
}

/**
 * Sync Top 5 per horizon to `telegram_daily_picks` (via hybrid Supabase / VPS SQLite client)
 * using the exact same `ticker + horizon_key` active deduplication rule.
 */
async function syncTelegramDailyPicksDb(horizonSnapshots, tradeDate, generatedAt, options = {}) {
  const supabase = options.supabase;
  if (!supabase) return { ok: false, skipped: true, reason: 'NO_SUPABASE_CLIENT', inserted: 0, updatedActive: 0 };

  const activeQ = await supabase
    .from('telegram_daily_picks')
    .select('id,date,ticker,category,status,is_final,monitor_source,hit_tp1_at,hit_tp2_at,hit_sl_at,raw_payload')
    .eq('monitor_source', 'three_horizon_top5')
    .order('date', { ascending: false })
    .limit(500);

  if (activeQ.error) {
    return { ok: false, error: activeQ.error.message, inserted: 0, updatedActive: 0 };
  }

  const activeByKey = new Map();
  const sameDayByKey = new Set();
  for (const row of (activeQ.data || [])) {
    const tk = String(row && row.ticker || '').trim().toUpperCase();
    const hk = normalizeHorizonKey(row);
    const dt = String(row && row.date || '').slice(0, 10);
    if (tk && dt) sameDayByKey.add(`${hk}:${tk}:${dt}`);
    if (!isRowActive(row)) continue;
    if (tk && !activeByKey.has(`${hk}:${tk}`)) {
      activeByKey.set(`${hk}:${tk}`, row);
    }
  }

  const inserts = [];
  let updatedActive = 0;

  for (const hKey of ['potensi_besok', 'short_swing', 'swing']) {
    const hSnap = horizonSnapshots && horizonSnapshots[hKey];
    const top5 = (hSnap && Array.isArray(hSnap.top5)) ? hSnap.top5.slice(0, 5) : [];
    for (const r of top5) {
      const tk = String(r && r.ticker || '').trim().toUpperCase();
      if (!tk) continue;
      const dedupKey = `${hKey}:${tk}`;
      const sameDayKey = `${hKey}:${tk}:${String(tradeDate || '').slice(0, 10)}`;
      const existingActive = activeByKey.get(dedupKey);
      if (existingActive) {
        const nextRaw = Object.assign({}, existingActive.raw_payload || {}, {
          last_seen_date: tradeDate,
          signal_age_status: r.signal_age_status || 'LANJUT',
          signal_age_label: r.signal_age_label || 'LANJUT H+1',
          first_seen_date: (existingActive.raw_payload && existingActive.raw_payload.first_seen_date) || existingActive.date || tradeDate,
          days_in_radar: r.days_in_radar || 2,
          score: r.score
        });
        if (!options.dryRun) {
          await supabase
            .from('telegram_daily_picks')
            .update({ raw_payload: nextRaw, updated_at: generatedAt })
            .eq('id', existingActive.id);
        }
        updatedActive++;
      } else if (!sameDayByKey.has(sameDayKey)) {
        const rec = makePickRecord(r, hKey, hSnap, tradeDate, generatedAt, undefined);
        delete rec.id;
        inserts.push(rec);
        activeByKey.set(dedupKey, Object.assign({ id: -1 }, rec));
        sameDayByKey.add(sameDayKey);
      }
    }
  }

  if (inserts.length > 0 && !options.dryRun) {
    const insRes = await supabase.from('telegram_daily_picks').insert(inserts);
    if (insRes && insRes.error) {
      return { ok: false, error: insRes.error.message, inserted: 0, updatedActive };
    }
  }

  return { ok: true, inserted: inserts.length, updatedActive };
}

module.exports = {
  DEFAULT_MAX_HOLDING_DAYS,
  ACTIVE_STATUSES,
  normalizeHorizonKey,
  maxHoldingDaysForHorizon,
  isRowActive,
  countWeekdaysBetween,
  annotateDailySignalMemory,
  syncLiveSignalLedger,
  syncTelegramDailyPicksDb
};
