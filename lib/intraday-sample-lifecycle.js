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
const eligibility = require('./intraday-production-eligibility');

/**
 * Research schema version for lifecycle entries.
 * v1.1 (additive): data-quality status history, production-eligibility snapshot,
 * price-inactivity + sampled-price aliases. All prior fields retain their
 * original semantics; readers of old (v1.0, unversioned) entries stay valid.
 */
const LIFECYCLE_SCHEMA_VERSION = 'intraday-sample-lifecycle-v1.1';

/**
 * Keep the additive alias fields in sync with their canonical source fields.
 * Aliases exist to make the sampled-price semantics explicit without changing
 * existing field names/values:
 *   - first_price_inactivity_at  <- first_stale_at (price-inactivity, NOT provider staleness)
 *   - sampled_high_after_first_seen <- intraday_high_after_first_seen (sampled current_price, NOT candle high)
 *   - sampled_low_after_first_seen  <- intraday_low_after_first_seen  (sampled current_price, NOT candle low)
 *   - sampled_mfe_pct <- max_favorable_excursion_pct
 *   - sampled_mae_pct <- max_adverse_excursion_pct
 * Safe to call on legacy entries: derives aliases from whatever base fields exist.
 */
function syncAliases(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  entry.first_price_inactivity_at = entry.first_stale_at != null ? entry.first_stale_at : null;
  entry.sampled_high_after_first_seen = entry.intraday_high_after_first_seen != null
    ? entry.intraday_high_after_first_seen : null;
  entry.sampled_low_after_first_seen = entry.intraday_low_after_first_seen != null
    ? entry.intraday_low_after_first_seen : null;
  entry.sampled_mfe_pct = entry.max_favorable_excursion_pct != null
    ? entry.max_favorable_excursion_pct : null;
  entry.sampled_mae_pct = entry.max_adverse_excursion_pct != null
    ? entry.max_adverse_excursion_pct : null;
  return entry;
}

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
      // First observation of this ticker.
      // NOTE: the first snapshot is intentionally observation-only for
      // price-based classification (entry/TP/SL/stale/missed touch detection
      // runs only from the second observation onward). Data-quality flagging
      // is metadata about the candidate, not a price touch, so it is recorded
      // from the first snapshot.
      const dq = record.data_quality_status != null ? record.data_quality_status : null;
      const elig = eligibility.classifyProductionEligibility(record);
      data[ticker] = {
        ticker: ticker,
        schema_version: LIFECYCLE_SCHEMA_VERSION,
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
        // Data-quality / production-eligibility tracking (additive, v1.1)
        initial_data_quality_status: dq,
        data_quality_statuses: [dq],
        first_data_quality_flag_at: eligibility.isDataQualityRiskStatus(dq) ? scheduledTime : null,
        production_eligible_at_first_seen: elig.eligible,
        production_eligibility_reason: elig.reason,
        // Final outcome (updated at end of day)
        final_simulated_outcome: null,
        // Observation history
        observations: [scheduledTime],
        statuses: [record.current_status],
        scores: [record.score]
      };
      syncAliases(data[ticker]);
    } else {
      // Repeated observation — update lifecycle
      existing.last_seen_at = scheduledTime;
      existing.last_seen_timestamp = nowIso;
      existing.number_of_observations += 1;
      existing.latest_price = price;
      existing.observations.push(scheduledTime);
      existing.statuses.push(record.current_status);
      existing.scores.push(record.score);

      // Data-quality status history (additive, v1.1). Defensive init for
      // legacy entries that predate these fields.
      const dqNow = record.data_quality_status != null ? record.data_quality_status : null;
      if (!Array.isArray(existing.data_quality_statuses)) {
        existing.data_quality_statuses = [existing.initial_data_quality_status != null
          ? existing.initial_data_quality_status : null];
      }
      existing.data_quality_statuses.push(dqNow);
      // Stamp the first observation that carried a data-quality-risk status.
      if (!existing.first_data_quality_flag_at && eligibility.isDataQualityRiskStatus(dqNow)) {
        existing.first_data_quality_flag_at = scheduledTime;
      }

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

      // Invalid detection: status became AVOID or data quality failed.
      // NOTE: this intentionally remains the ORIGINAL narrow rule. A
      // data-quality-risk status (e.g. CORPORATE_ACTION_RISK) does NOT
      // convert a raw TP1_HIT into INVALID here — production-eligibility
      // partitioning is handled downstream in the summary, preserving the
      // raw touch record.
      if (!existing.first_invalid_at &&
          (record.current_status === 'AVOID' || record.data_quality_status === 'INVALID_CANDLE')) {
        existing.first_invalid_at = scheduledTime;
      }

      // Keep additive aliases in sync with their canonical source fields.
      syncAliases(existing);
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

    // Normalize additive aliases for every entry (including legacy entries
    // loaded from an older lifecycle file that lacked these fields).
    syncAliases(entry);
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
  LIFECYCLE_SCHEMA_VERSION,
  loadLifecycle,
  saveLifecycle,
  updateLifecycle,
  finalizeLifecycle,
  readLifecycle,
  syncAliases
};
