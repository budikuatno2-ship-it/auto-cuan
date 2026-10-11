'use strict';

/**
 * Centralized Screener Configuration & Risk/Reward Filters — Auto-Cuan
 *
 * Core Risk/Reward thresholds applied across Day Trade & Swing Screener pipelines.
 */

const MIN_RR_RATIO = 1.5;
const IDEAL_RR_RATIO = 2.0;
// Batch 9: Minimum volume ratio required for breakout/revalidation confirmation.
const MIN_BREAKOUT_VOLUME_RATIO = 1.2;

/**
 * Evaluates whether candidate meets minimum Risk/Reward ratio threshold.
 * Safely extracts R/R from various property naming variants across the codebase
 * (e.g. rr, rr_ratio, risk_reward, riskReward, levels.risk_reward, levels.riskReward).
 *
 * @param {Object} [candidate] - Candidate object or levels container
 * @param {number} [minRatio=MIN_RR_RATIO] - Minimum acceptable R/R ratio threshold
 * @returns {boolean} True if candidate has valid numerical R/R >= minRatio, false otherwise
 */
function extractCandidateLevels(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;

  // Prioritas sumber level (struktur payload produksi):
  // root candidate = level final aktual, lalu nested levels / trade_plan_v2 /
  // metrics / observation. Level final tidak boleh kalah oleh level basi nested.
  const sources = [
    candidate,
    candidate.levels,
    candidate.trade_plan_v2,
    candidate.metrics,
    candidate.observation && candidate.observation.metrics,
    candidate.observation
  ].filter(src => src && typeof src === 'object');

  const ENTRY_UPPER_KEYS = ['entry_high', 'entry_zone_high', 'buy_high'];
  const ENTRY_LOWER_KEYS = ['entry1', 'entry_low', 'entry_zone_low', 'buy_low'];
  const ENTRY_SECOND_KEYS = ['entry2'];
  const ENTRY_FALLBACK_KEYS = ['entry', 'entry_price', 'current_price', 'last_price', 'close'];
  const STOP_LOSS_KEYS = ['stop_loss', 'sl', 'stop', 'invalidation'];
  const TP1_KEYS = ['tp1', 'tp1n', 'target_1', 'target1'];
  const BOUNDARY_GROUPS = [ENTRY_UPPER_KEYS, ENTRY_LOWER_KEYS, ENTRY_SECOND_KEYS, STOP_LOSS_KEYS, TP1_KEYS];

  // P0 fail-closed: bedakan "tidak diisi" dari "diisi tapi invalid".
  // - null/undefined/''/0 dianggap belum diisi (sentinel umum payload DB/JSON).
  // - Nilai non-finite / negatif yang eksplisit adalah INVALID; level eksplisit
  //   invalid TIDAK BOLEH diselamatkan fallback alias/level lain.
  function readLevelGroup(src, keys) {
    if (!src || typeof src !== 'object') return { value: null, provided: false, invalid: false };
    for (const k of keys) {
      if (!(k in src)) continue;
      const raw = src[k];
      if (raw === null || raw === undefined || raw === '') continue;
      const num = Number(raw);
      if (num === 0) continue;
      if (Number.isFinite(num) && num > 0) return { value: num, provided: true, invalid: false };
      return { value: null, provided: true, invalid: true };
    }
    return { value: null, provided: false, invalid: false };
  }

  // Apakah ada level zona/SL/TP yang diisi sama sekali (bukan fallback harga).
  // Dipakai agar level parsial/bercampur tidak diselamatkan metadata R/R lama.
  let anyLevelProvided = false;
  for (const src of sources) {
    for (const keys of BOUNDARY_GROUPS) {
      if (readLevelGroup(src, keys).provided) { anyLevelProvided = true; break; }
    }
    if (anyLevelProvided) break;
  }
  const failClosed = () => ({ entry: null, sl: null, tp1: null, present: anyLevelProvided, invalid: anyLevelProvided });

  // 1) Entry = batas ATAS zona yang paling konservatif untuk long setup.
  //    - Batas atas eksplisit invalid (mis. entry_high=NaN) => fail-closed;
  //      TIDAK boleh fallback ke entry_low yang lebih rendah (P0 skenario 1).
  //    - Batas atas dari sumber mana pun (mis. candidate.levels.entry_high)
  //      WAJIB mengalahkan lower bound (entry_low) di root, agar R/R tidak
  //      tampak lebih baik dari kenyataan (P0 skenario 2).
  //    - entry1/entry2 legacy digabung dengan max() agar tetap konservatif.
  const boundaries = [];
  for (const src of sources) {
    const upper = readLevelGroup(src, ENTRY_UPPER_KEYS);
    if (upper.invalid) return failClosed();
    if (upper.value != null) boundaries.push(upper.value);
    const lower = readLevelGroup(src, ENTRY_LOWER_KEYS);
    if (lower.invalid) return failClosed();
    if (lower.value != null) boundaries.push(lower.value);
    const second = readLevelGroup(src, ENTRY_SECOND_KEYS);
    if (second.invalid) return failClosed();
    if (second.value != null) boundaries.push(second.value);
  }
  let entry = boundaries.length > 0 ? Math.max.apply(Math, boundaries) : null;

  // 2) Fallback referensi harga legacy (entry/current_price/close) bila tidak
  //    ada level zona sama sekali. Nilai eksplisit invalid tetap fail-closed.
  if (entry == null) {
    for (const src of sources) {
      const ref = readLevelGroup(src, ENTRY_FALLBACK_KEYS);
      if (ref.invalid) return failClosed();
      if (ref.value != null) { entry = ref.value; break; }
    }
  }
  if (entry == null) return failClosed();

  // 3) SL & TP1 WAJIB berasal dari SATU sumber yang sama (sumber pertama yang
  //    menyediakan keduanya). Menggabungkan SL dari satu setup dengan TP1 dari
  //    snapshot/setup lain dapat menciptakan R/R valid palsu => fail-closed
  //    (P0 skenario 3).
  let sl = null;
  let tp1 = null;
  for (const src of sources) {
    const stop = readLevelGroup(src, STOP_LOSS_KEYS);
    if (stop.invalid) return failClosed();
    const target = readLevelGroup(src, TP1_KEYS);
    if (target.invalid) return failClosed();
    if (stop.value != null && target.value != null) { sl = stop.value; tp1 = target.value; break; }
  }
  if (sl == null || tp1 == null) return failClosed();

  return { entry, sl, tp1, present: true, invalid: false };
}

function recalculateRiskReward(candidate) {
  const levels = extractCandidateLevels(candidate);
  if (!levels || levels.entry == null || levels.sl == null || levels.tp1 == null) return null;
  const { entry, sl, tp1 } = levels;
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp1)) return null;
  if (entry <= sl || tp1 <= entry || sl <= 0) return null;
  const rr = (tp1 - entry) / (entry - sl);
  // P0 fix: jangan membulatkan 2 desimal sebelum gate validasi.
  // Kembalikan nilai floating point asli. Pembulatan hanya untuk formatting tampilan.
  return Number.isFinite(rr) && rr >= 0 ? rr : null;
}

function passesRiskRewardFilter(candidate, minRatio = MIN_RR_RATIO, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const threshold = (typeof minRatio === 'number' && !Number.isNaN(minRatio))
    ? minRatio
    : MIN_RR_RATIO;

  const RR_EPSILON = 1e-12;

  // P0 fail-closed: level final yang diisi tapi tidak lengkap / eksplisit invalid /
  // tidak dapat dibuktikan berasal dari setup yang sama TIDAK BOLEH diselamatkan
  // oleh metadata R/R lama — berlaku untuk jalur recalculate maupun metadata.
  const levels = extractCandidateLevels(candidate);
  if (levels && levels.present === true && (levels.entry == null || levels.sl == null || levels.tp1 == null)) {
    return false;
  }

  // Fail-closed jika level struktural tidak valid (SL >= entry, TP1 <= entry, SL <= 0)
  if (levels && levels.entry != null && levels.sl != null && levels.tp1 != null) {
    if (levels.entry <= levels.sl || levels.tp1 <= levels.entry || levels.sl <= 0) {
      return false;
    }
  }

  const requireRecalculate = options.recalculate === true || candidate.recalculate_rr === true;

  let rawVal = null;

  if (requireRecalculate) {
    // Audit Tahap 1B / P0: Sinyal siap eksekusi wajib recalculate dari level final.
    // Jika level tidak lengkap atau invalid saat recalculation diwajibkan:
    // HARUS FAIL-CLOSED (return false), TIDAK BOLEH fallback ke nilai R/R lama!
    const recalculated = recalculateRiskReward(candidate);
    if (recalculated == null) {
      return false;
    }
    rawVal = recalculated;
  } else {
    // Jalur non-mandatory: baca nilai R/R dari metadata
    const sources = [
      candidate,
      candidate.levels,
      candidate.trade_plan_v2,
      candidate.metrics,
      candidate.observation && candidate.observation.metrics,
      candidate.observation
    ].filter(src => src && typeof src === 'object');

    for (const src of sources) {
      for (const k of ['risk_reward', 'riskReward', 'rr', 'rr_ratio', 'rrRatio', 'rr_to_tp1']) {
        if (src[k] != null && src[k] !== '') {
          const n = Number(src[k]);
          if (Number.isFinite(n)) {
            rawVal = n;
            break;
          }
        }
      }
      if (rawVal != null) break;
    }

  }

  if (rawVal == null) {
    return false;
  }

  const numVal = typeof rawVal === 'number' ? rawVal : Number(String(rawVal).trim());

  if (!Number.isFinite(numVal) || numVal < 0) {
    return false;
  }

  return numVal + RR_EPSILON >= threshold;
}

function passesVolumeBreakoutConfirmation(candidate, minRatio = MIN_BREAKOUT_VOLUME_RATIO) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const threshold = (typeof minRatio === 'number' && !Number.isNaN(minRatio))
    ? minRatio
    : MIN_BREAKOUT_VOLUME_RATIO;

  let rawVal = null;

  if (candidate.volume_ratio != null) rawVal = candidate.volume_ratio;
  else if (candidate.volume_ratio_20d != null) rawVal = candidate.volume_ratio_20d;
  else if (candidate.volume_ratio_avg20 != null) rawVal = candidate.volume_ratio_avg20;
  else if (candidate.volumeRatio != null) rawVal = candidate.volumeRatio;
  else if (candidate.vr != null) rawVal = candidate.vr;
  else if (candidate.vol_ratio != null) rawVal = candidate.vol_ratio;

  if (rawVal == null) {
    return false;
  }

  const numVal = typeof rawVal === 'number' ? rawVal : Number(String(rawVal).trim());

  if (!Number.isFinite(numVal) || numVal < 0) {
    return false;
  }

  return numVal >= threshold;
}

// Batch 11: Live/intraday price sources that indicate a still-forming (unclosed) bar.
const LIVE_PRICE_SOURCE_PATTERN = /(^|[_\s])live([_\s]|$)|intraday|realtime|real_time|_tick/i;

/**
 * Batch 11: Determines whether the candidate's price reflects a CONFIRMED candle close
 * rather than an intraday tick of a still-forming bar (wick).
 *
 * Backward-compatible: absent any explicit still-forming signal, returns true so legacy
 * daily-close flows are unaffected. Returns false when the candidate explicitly marks the
 * bar as unclosed (candle_closed/bar_closed === false, candle_forming === true,
 * is_intraday_live === true) or carries a live/intraday price_source.
 *
 * @param {Object} [candidate]
 * @returns {boolean} True if the bar is confirmed closed (or no signal says otherwise)
 */
function isCandleCloseConfirmed(candidate) {
  if (!candidate || typeof candidate !== 'object') return true;
  if (candidate.candle_closed === false) return false;
  if (candidate.bar_closed === false) return false;
  if (candidate.candle_forming === true) return false;
  if (candidate.is_intraday_live === true) return false;
  const src = candidate.price_source;
  if (src != null && LIVE_PRICE_SOURCE_PATTERN.test(String(src))) return false;
  return true;
}

/**
 * Batch 9: Evaluates whether a candidate requiring revalidation can be safely confirmed.
 * Requires:
 * 1. Fresh data (not stale / expired)
 * 2. Minimum Risk/Reward ratio >= MIN_RR_RATIO
 * 3. Volume confirmation >= MIN_BREAKOUT_VOLUME_RATIO if candidate is in breakout / entry state
 *
 * @param {Object} [candidate]
 * @param {Object} [options]
 * @param {number} [options.min_rr] - Override minimum R/R ratio (default MIN_RR_RATIO)
 * @param {number} [options.min_volume_ratio] - Override minimum volume ratio (default MIN_BREAKOUT_VOLUME_RATIO)
 * @param {boolean} [options.require_volume] - Force volume confirmation check regardless of status
 * @returns {{ pass: boolean, reason: string|null }}
 */
function validateRevalidationSignal(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return { pass: false, reason: 'missing_candidate' };
  }

  if (candidate.is_stale === true || candidate.data_stale === true || candidate.freshness_is_stale === true) {
    return { pass: false, reason: 'stale_data' };
  }

  // Fase 3 / BUG-F3-01: setup yang harganya sudah menembus stop loss tidak boleh
  // direvalidasi sebagai entry baru — strukturnya sudah gagal.
  if (candidate.last_price != null && candidate.stop_loss != null &&
      Number.isFinite(Number(candidate.last_price)) && Number.isFinite(Number(candidate.stop_loss)) &&
      Number(candidate.last_price) <= Number(candidate.stop_loss)) {
    return { pass: false, reason: 'stop_loss_breached' };
  }

  // Fase 3 / BUG-F3-02: setup yang harganya sudah mencapai/melampaui TP1 tidak
  // boleh direvalidasi sebagai entry baru (anti-chasing di pucuk).
  if (candidate.last_price != null && candidate.tp1 != null &&
      Number.isFinite(Number(candidate.last_price)) && Number.isFinite(Number(candidate.tp1)) &&
      Number(candidate.last_price) >= Number(candidate.tp1)) {
    return { pass: false, reason: 'tp1_already_hit' };
  }

  const minRR = (typeof options.min_rr === 'number') ? options.min_rr : MIN_RR_RATIO;
  if (!passesRiskRewardFilter(candidate, minRR)) {
    return { pass: false, reason: 'poor_risk_reward' };
  }

  const minVR = (typeof options.min_volume_ratio === 'number') ? options.min_volume_ratio : MIN_BREAKOUT_VOLUME_RATIO;
  // Fase 3 / BUG-F3-04: evaluasi SETIAP field status secara independen. Rantai
  // short-circuit sebelumnya membuat entry_status truthy (mis. 'EXTENDED')
  // menutupi status breakout (mis. 'READY_BREAKOUT') sehingga gate volume lolos.
  const isBreakoutOrEntry = options.require_volume === true ||
    [candidate.entry_status, candidate.status, candidate.breakout_confirmation_status].some((raw) =>
      raw != null && ['BREAKOUT_CONFIRMED', 'READY_BREAKOUT', 'A_PLUS_SETUP', 'IN_ENTRY_AREA', 'TRADE_CANDIDATE']
        .includes(String(raw).toUpperCase())
    );

  if (isBreakoutOrEntry && !passesVolumeBreakoutConfirmation(candidate, minVR)) {
    return { pass: false, reason: 'insufficient_breakout_volume' };
  }

  return { pass: true, reason: null };
}

module.exports = {
  MIN_RR_RATIO,
  IDEAL_RR_RATIO,
  MIN_BREAKOUT_VOLUME_RATIO,
  passesRiskRewardFilter,
  recalculateRiskReward,
  passesVolumeBreakoutConfirmation,
  isCandleCloseConfirmed,
  validateRevalidationSignal
};
