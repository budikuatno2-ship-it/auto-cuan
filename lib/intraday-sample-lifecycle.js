'use strict';

/**
 * Intraday Sample Lifecycle Tracker
 * 
 * Tracks candidate observations across the day purely in research storage.
 * Does NOT modify production state, hit markers, or recommendation status.
 * 
 * Storage: single JSON file per sample date containing lifecycle map.
 */

const fsp = require('node:fs/promises');

/**
 * Load existing lifecycle data from file, or return empty map.
 */
async function loadLifecycle(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

/**
 * Save lifecycle data atomically (write to .tmp then rename).
 */
async function saveLifecycle(filePath, data) {
  const fsp2 = require('node:fs/promises');
  const path = require('node:path');
  await fsp2.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  await fsp2.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n');
  await fsp2.rename(tmpPath, filePath);
}

/**
 * Update lifecycle for all candidates observed in this sample run.
 * 
 * @param {string} filePath - Path to lifecycle.json
 * @param {Array} candidateRecords - Array of candidate observation records
 * @param {string} scheduledTime - The HH:MM scheduled time of this observation
 */
async function updateLifecycle(filePath, candidateRecords, scheduledTime) {
  const data = await loadLifecycle(filePath);
  const nowIso = new Date().toISOString();

  for (const record of candidateRecords) {
    const ticker = record.ticker;
    if (!ticker) continue;

    const price = record.current_price;
    const existing = data[ticker];

    if (!existing) {
      // First observation of this ticker
      data[ticker] = {
        ticker: ticker,
        first_seen_at: scheduledTime,
        first_seen_timestamp: nowIso,
        last_seen_at: scheduledTime,
        last_seen_timestamp: nowIso,
        number_of_observations: 1,
        first_seen_price: price,
        latest_price: price,
        intraday_high_after_first_seen: price,
        intraday_low_after_first_seen: price,
        max_favorable_excursion_pct: 0,
        max_adverse_excursion_pct: 0,
        // Level tracking (from first observation)
        entry_low: record.entry_low,
        entry_high: record.entry_high,
        reference_entry_price: record.reference_entry_price,
        tp1: record.tp1,
        tp2: record.tp2,
        sl: record.sl,
        // Touch tracking
        first_entry_touch_at: null,
        first_tp1_touch_at: null,
        first_tp2_touch_at: null,
        first_sl_touch_at: null,
        first_invalid_at: null,
        first_stale_at: null,
        first_entry_missed_at: null,
        // Final outcome (updated at end of day)
        final_simulated_outcome: null,
        // Observation history
        observations: [scheduledTime],
        statuses: [record.current_status],
        scores: [record.score]
      };
    } else {
      // Repeated observation — update lifecycle
      existing.last_seen_at = scheduledTime;
      existing.last_seen_timestamp = nowIso;
      existing.number_of_observations += 1;
      existing.latest_price = price;
      existing.observations.push(scheduledTime);
      existing.statuses.push(record.current_status);
      existing.scores.push(record.score);

      // Update intraday high/low after first seen
      if (price != null) {
        if (price > existing.intraday_high_after_first_seen) {
          existing.intraday_high_after_first_seen = price;
        }
        if (price < existing.intraday_low_after_first_seen) {
          existing.intraday_low_after_first_seen = price;
        }
      }

      // MFE / MAE (based on reference entry price from first observation)
      const refEntry = existing.reference_entry_price;
      if (refEntry && refEntry > 0 && price != null) {
        const mfe = ((existing.intraday_high_after_first_seen - refEntry) / refEntry) * 100;
        const mae = ((refEntry - existing.intraday_low_after_first_seen) / refEntry) * 100;
        existing.max_favorable_excursion_pct = Math.max(0, round2(mfe));
        existing.max_adverse_excursion_pct = Math.max(0, round2(mae));
      }

      // Touch detection (only first touch)
      if (price != null && refEntry) {
        // Entry touch: price is within entry_low to entry_high
        if (!existing.first_entry_touch_at &&
            existing.entry_low != null && existing.entry_high != null &&
            price >= existing.entry_low && price <= existing.entry_high) {
          existing.first_entry_touch_at = scheduledTime;
        }

        // TP1 touch
        if (!existing.first_tp1_touch_at && existing.tp1 != null && price >= existing.tp1) {
          existing.first_tp1_touch_at = scheduledTime;
        }

        // TP2 touch
        if (!existing.first_tp2_touch_at && existing.tp2 != null && price >= existing.tp2) {
          existing.first_tp2_touch_at = scheduledTime;
        }

        // SL touch
        if (!existing.first_sl_touch_at && existing.sl != null && price <= existing.sl) {
          existing.first_sl_touch_at = scheduledTime;
        }
      }

      // Entry missed: price moved away above entry_high without touching entry zone
      if (!existing.first_entry_missed_at && !existing.first_entry_touch_at &&
          existing.entry_high != null && price != null && price > existing.entry_high * 1.03) {
        existing.first_entry_missed_at = scheduledTime;
      }

      // Stale detection: same price as first observation, no volume movement
      if (!existing.first_stale_at && price != null && existing.first_seen_price != null &&
          price === existing.first_seen_price && existing.number_of_observations >= 4) {
        existing.first_stale_at = scheduledTime;
      }

      // Invalid detection: status became AVOID or data quality failed
      if (!existing.first_invalid_at &&
          (record.current_status === 'AVOID' || record.data_quality_status === 'INVALID_CANDLE')) {
        existing.first_invalid_at = scheduledTime;
      }
    }
  }

  await saveLifecycle(filePath, data);
  return data;
}

/**
 * Finalize all lifecycle entries with simulated outcome at end of day.
 */
async function finalizeLifecycle(filePath) {
  const data = await loadLifecycle(filePath);

  for (const ticker of Object.keys(data)) {
    const entry = data[ticker];
    if (entry.final_simulated_outcome) continue; // already finalized

    if (entry.first_sl_touch_at && !entry.first_tp1_touch_at) {
      entry.final_simulated_outcome = 'SL_HIT';
    } else if (entry.first_tp2_touch_at) {
      entry.final_simulated_outcome = 'TP2_HIT';
    } else if (entry.first_tp1_touch_at) {
      entry.final_simulated_outcome = 'TP1_HIT';
    } else if (entry.first_invalid_at) {
      entry.final_simulated_outcome = 'INVALID';
    } else if (entry.first_stale_at) {
      entry.final_simulated_outcome = 'STALE';
    } else if (entry.first_entry_missed_at) {
      entry.final_simulated_outcome = 'ENTRY_MISSED';
    } else if (!entry.first_entry_touch_at) {
      entry.final_simulated_outcome = 'NO_ENTRY_TOUCH';
    } else {
      entry.final_simulated_outcome = 'OPEN_AT_CLOSE';
    }
  }

  await saveLifecycle(filePath, data);
  return data;
}

/**
 * Read lifecycle without modification
 */
async function readLifecycle(filePath) {
  return loadLifecycle(filePath);
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  loadLifecycle,
  saveLifecycle,
  updateLifecycle,
  finalizeLifecycle,
  readLifecycle
};
