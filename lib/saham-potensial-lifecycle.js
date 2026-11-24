'use strict';

/**
 * lib/saham-potensial-lifecycle.js
 * ============================================================================
 * Short Swing 2–5 Hari Lifecycle State Machine & Evaluator — Auto-Cuan V6
 * ============================================================================
 *
 * State Transitions:
 * - WAITING_ENTRY: Signal diterbitkan, harga belum menyentuh area entry (entry_low..entry_high).
 * - ENTERED: Harga masuk ke dalam rentang entry (low <= entry_high dan high >= entry_low).
 * - TP1_HIT: Pasca entered, harga menyentuh target 1 (high >= tp1).
 * - TP2_HIT: Pasca entered, harga menyentuh target 2 (high >= tp2).
 * - STOP_LOSS: Pasca entered, harga menyentuh stop loss (low <= sl).
 * - INVALIDATED_BEFORE_ENTRY: Belum pernah masuk area entry, namun harga sudah tembus SL (low <= sl).
 * - EXPIRED_NO_ENTRY: Sampai batas holding horizon (mis. 5 hari bursa), harga tidak pernah menyentuh entry.
 * - TIME_EXIT: Sudah entered, tetapi selama horizon (2-5 hari bursa) belum hit TP atau SL.
 * - AMBIGUOUS_SAME_BAR: Dalam SATU bar yang sama harga menyentuh TP (tp1/tp2) DAN SL.
 *   Urutan intrabar TIDAK terbukti dari OHLC harian, jadi hasil tidak boleh diklaim
 *   sebagai win maupun loss (Subtask K / konservatif, selaras dengan
 *   lib/track-record-live-ledger.js yang mengembalikan AMBIGUOUS untuk kasus ini).
 *
 * Invarian:
 * - Tanggal selalu format YYYY-MM-DD standar ISO.
 * - Auto-expiry terhitung berdasarkan hari bursa (default 5 hari).
 * - Same-bar TP+SL tidak pernah dipromosikan menjadi TP*__HIT (no lookahead / no
 *   optimistic intrabar ordering).
 * ============================================================================
 */

const STATES = Object.freeze({
  WAITING_ENTRY: 'WAITING_ENTRY',
  ENTERED: 'ENTERED',
  TP1_HIT: 'TP1_HIT',
  TP2_HIT: 'TP2_HIT',
  STOP_LOSS: 'STOP_LOSS',
  INVALIDATED_BEFORE_ENTRY: 'INVALIDATED_BEFORE_ENTRY',
  EXPIRED_NO_ENTRY: 'EXPIRED_NO_ENTRY',
  TIME_EXIT: 'TIME_EXIT',
  AMBIGUOUS_SAME_BAR: 'AMBIGUOUS_SAME_BAR'
});

const TERMINAL_STATES = new Set([
  STATES.TP1_HIT,
  STATES.TP2_HIT,
  STATES.STOP_LOSS,
  STATES.INVALIDATED_BEFORE_ENTRY,
  STATES.EXPIRED_NO_ENTRY,
  STATES.TIME_EXIT,
  STATES.AMBIGUOUS_SAME_BAR
]);

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Format string tanggal ke 'YYYY-MM-DD'
 *
 * @param {string|Date} dateVal
 * @returns {string|null}
 */
function normalizeDateYmd(dateVal) {
  if (!dateVal) return null;
  if (dateVal instanceof Date) {
    return dateVal.toISOString().slice(0, 10);
  }
  const str = String(dateVal).trim();
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Resolve TP/SL touches that happen inside ONE single bar.
 *
 * Daily OHLC does not prove intrabar ordering. When the same bar reaches a
 * target AND the stop, the true outcome is unknown, so it must never be
 * promoted to a win (TP*_HIT) nor silently booked as a loss (STOP_LOSS).
 * This mirrors the conservative AMBIGUOUS contract already enforced by
 * `lib/track-record-live-ledger.js` for equal hit timestamps — without it the
 * ambiguity was resolved optimistically HERE and the ledger's conservative
 * branch could never fire for evaluator-produced rows.
 *
 * @returns {{event: string, exitPrice: number|null}|null} null when the bar
 *   touches neither a target nor the stop.
 */
function resolveSameBarExit(high, low, tp1, tp2, sl) {
  const hitTp2 = tp2 != null && high >= tp2;
  const hitTp1 = tp1 != null && high >= tp1;
  const hitSl = sl != null && low <= sl;

  // Ambiguity first: a target and the stop inside the same bar.
  if ((hitTp2 || hitTp1) && hitSl) {
    return { event: STATES.AMBIGUOUS_SAME_BAR, exitPrice: null };
  }
  // TP2 is the further target; prefer it only when it is unambiguously reached.
  if (hitTp2) return { event: STATES.TP2_HIT, exitPrice: tp2 };
  if (hitTp1) return { event: STATES.TP1_HIT, exitPrice: tp1 };
  if (hitSl) return { event: STATES.STOP_LOSS, exitPrice: sl };
  return null;
}

/**
 * Evaluasi transisi state untuk satu posisi Short Swing berdasarkan rentetan candle harian berikutnya.
 *
 * @param {object} pick { id, ticker, date, entry_low, entry_high, sl, tp1, tp2, status }
 * @param {Array<object>} candles Array bar harian post-signal terurut kronologis [{ trade_date, open, high, low, close }]
 * @param {object} [options] { maxHoldingDays: 5 }
 * @returns {{
 *   currentState: string,
 *   previousState: string,
 *   isTerminal: boolean,
 *   entryDate: string|null,
 *   exitDate: string|null,
 *   exitPrice: number|null,
 *   holdingDays: number,
 *   gainPct: number|null,
 *   historyLogs: Array<object>
 * }}
 */
function evaluateLifecycleHistory(pick, candles = [], options = {}) {
  const maxHoldingDays = options.maxHoldingDays || 5;
  const entryLow = num(pick.entry_low ?? pick.entry2) ?? num(pick.entry1);
  const entryHigh = num(pick.entry_high ?? pick.entry1) ?? num(pick.entry2);
  const maxEntry = Math.max(entryLow, entryHigh);
  const minEntry = Math.min(entryLow, entryHigh);
  const sl = num(pick.sl ?? pick.stop_loss);
  const tp1 = num(pick.tp1);
  const tp2 = num(pick.tp2);

  let state = pick.status === 'ENTERED' ? STATES.ENTERED : STATES.WAITING_ENTRY;
  const prevState = state;
  let entryDate = pick.entry_date ? normalizeDateYmd(pick.entry_date) : null;
  let exitDate = null;
  let exitPrice = null;
  let holdingDays = 0;
  let gainPct = null;
  const logs = [];

  const postCandles = (candles || []).filter(c => {
    const d = normalizeDateYmd(c.trade_date || c.date);
    const pDate = normalizeDateYmd(pick.date);
    return d && pDate && d > pDate;
  });

  for (let i = 0; i < postCandles.length; i++) {
    const candle = postCandles[i];
    const cDate = normalizeDateYmd(candle.trade_date || candle.date);
    const high = num(candle.high);
    const low = num(candle.low);
    const close = num(candle.close);

    if (high == null || low == null) continue;

    holdingDays++;

    if (state === STATES.WAITING_ENTRY) {
      // Apakah bar ini menjangkau area entry? (low <= maxEntry dan high >= minEntry)
      const touchedEntryZone = low <= maxEntry && high >= minEntry;

      // Cek apakah tembus SL sebelum pernah masuk area entry.
      //
      // Subtask K: bila bar yang sama JUGA menjangkau area entry, klaim
      // "tidak pernah masuk" tidak terbukti — bar harian melebar melewati SL,
      // zona entry, dan (mungkin) target sekaligus, dan urutan intrabar tidak
      // diketahui. Fail-closed ke AMBIGUOUS_SAME_BAR, jangan ke
      // INVALIDATED_BEFORE_ENTRY (yang akan dibaca sebagai hasil pasti).
      if (sl != null && low <= sl) {
        if (touchedEntryZone) {
          state = STATES.AMBIGUOUS_SAME_BAR;
          exitDate = cDate;
          exitPrice = null;
          logs.push({ date: cDate, event: STATES.AMBIGUOUS_SAME_BAR, high, low, sl, tp1, tp2, reason: 'bar menjangkau area entry DAN stop loss; urutan intrabar tidak terbukti' });
          break;
        }
        state = STATES.INVALIDATED_BEFORE_ENTRY;
        exitDate = cDate;
        exitPrice = sl;
        logs.push({ date: cDate, event: 'INVALIDATED_BEFORE_ENTRY', low, sl });
        break;
      }

      // Cek apakah menyentuh area entry (low <= maxEntry dan high >= minEntry)
      if (touchedEntryZone) {
        state = STATES.ENTERED;
        entryDate = cDate;
        logs.push({ date: cDate, event: 'ENTERED', low, high, area: `${minEntry}-${maxEntry}` });

        // Pada hari yang sama, cek apakah langsung hit TP atau SL.
        // Same-bar TP+SL => AMBIGUOUS_SAME_BAR (bukan win, bukan loss).
        const sameBarEntry = resolveSameBarExit(high, low, tp1, tp2, sl);
        if (sameBarEntry) {
          state = sameBarEntry.event;
          exitDate = cDate;
          exitPrice = sameBarEntry.exitPrice;
          logs.push({ date: cDate, event: sameBarEntry.event, high, low, tp1, tp2, sl });
          break;
        }
      } else if (holdingDays >= maxHoldingDays) {
        // Tidak pernah tersentuh hingga batas hari
        state = STATES.EXPIRED_NO_ENTRY;
        exitDate = cDate;
        logs.push({ date: cDate, event: 'EXPIRED_NO_ENTRY', holdingDays });
        break;
      }
    } else if (state === STATES.ENTERED) {
      // Posisi sudah aktif. Cek target dan proteksi.
      // Same-bar TP+SL => AMBIGUOUS_SAME_BAR (bukan win, bukan loss).
      const sameBar = resolveSameBarExit(high, low, tp1, tp2, sl);
      if (sameBar) {
        state = sameBar.event;
        exitDate = cDate;
        exitPrice = sameBar.exitPrice;
        logs.push({ date: cDate, event: sameBar.event, high, low, tp1, tp2, sl });
        break;
      } else if (holdingDays >= maxHoldingDays) {
        // Waktu habis sebelum TP/SL
        state = STATES.TIME_EXIT;
        exitDate = cDate;
        exitPrice = close;
        logs.push({ date: cDate, event: 'TIME_EXIT', holdingDays, close });
        break;
      }
    }
  }

  // Hitung gain pct jika sudah exit atau target hit
  if (exitPrice != null && maxEntry > 0) {
    gainPct = Number((((exitPrice - maxEntry) / maxEntry) * 100).toFixed(2));
  }

  return {
    currentState: state,
    previousState: prevState,
    isTerminal: TERMINAL_STATES.has(state),
    entryDate,
    exitDate,
    exitPrice,
    holdingDays,
    gainPct,
    historyLogs: logs
  };
}

module.exports = {
  STATES,
  TERMINAL_STATES,
  normalizeDateYmd,
  resolveSameBarExit,
  evaluateLifecycleHistory
};
