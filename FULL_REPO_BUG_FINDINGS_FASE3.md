# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 3 (Screener Engine & Daytrade/Swing)
Dokumentasi temuan bug Fase 3. Read-only kode produksi, dibuktikan lewat unit test fisik di test/screener-fase3-bugs.test.js, test/screener-fase3-batch2-bugs.test.js, dan test/screener-fase3-batch3-bugs.test.js.
Status: BELUM DIPERBAIKI (fase audit murni).

---

### BUG-F3-01: Lifecycle & Revalidation Loloskan Sinyal yang Sudah Hit Stop Loss
- **Lokasi**: `lib/screener-config.js:124-142`
- **Severity**: CRITICAL
- **Kutipan Kode**:
  ```javascript
  function validateRevalidationSignal(candidate, options = {}) {
    if (!candidate || typeof candidate !== 'object') {
      return { pass: false, reason: 'missing_candidate' };
    }
    if (candidate.is_stale === true || candidate.data_stale === true || candidate.freshness_is_stale === true) {
      return { pass: false, reason: 'stale_data' };
    }
    const minRR = (typeof options.min_rr === 'number') ? options.min_rr : MIN_RR_RATIO;
    if (!passesRiskRewardFilter(candidate, minRR)) {
      return { pass: false, reason: 'poor_risk_reward' };
    }
    ...
    return { pass: true, reason: null };
  }
  ```
- **Dampak ke User**: Sinyal trading aktif yang harganya sudah jatuh menembus Stop Loss (`last_price <= stop_loss`) tetap diloloskan sebagai sinyal valid saat proses revalidasi/radar berkala karena fungsi tidak memeriksa status breach SL. User berisiko masuk ke saham yang setup-nya sudah gagal/invalid.
- **Bukti Test Nyata**: `test/screener-fase3-bugs.test.js` - Case `BUG-F3-01`: Candidate dengan `last_price: 92` dan `stop_loss: 95` mengembalikan `{ pass: true, reason: null }`.
- **Usulan Perbaikan**: Tambahkan pengecekan harga terhadap Stop Loss (`if (candidate.last_price != null && candidate.stop_loss != null && candidate.last_price <= candidate.stop_loss) return { pass: false, reason: 'stop_loss_breached' };`).

---

### BUG-F3-02: Lifecycle & Revalidation Loloskan Sinyal yang Sudah Mencapai Target TP1
- **Lokasi**: `lib/screener-config.js:124-142`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const minVR = (typeof options.min_volume_ratio === 'number') ? options.min_volume_ratio : MIN_BREAKOUT_VOLUME_RATIO;
  ...
  return { pass: true, reason: null };
  ```
- **Dampak ke User**: Saham yang sudah melompat melampaui target take profit (`last_price >= tp1`) tetap divalidasi sebagai setup breakout baru. Ini memicu sinyal buy di pucuk/area take profit (chasing), merugikan trader pemula.
- **Bukti Test Nyata**: `test/screener-fase3-bugs.test.js` - Case `BUG-F3-02`: Candidate dengan `last_price: 120` dan `tp1: 115` mengembalikan `{ pass: true, reason: null }`.
- **Usulan Perbaikan**: Tolak revalidasi jika harga sudah mencapai atau melampaui TP1 (`if (candidate.last_price != null && candidate.tp1 != null && candidate.last_price >= candidate.tp1) return { pass: false, reason: 'tp1_already_hit' };`).

---

### BUG-F3-03: verifySwingHighConviction Meloloskan Saham Berstatus 'AVOID' / 'SPECULATIVE'
- **Lokasi**: `lib/swing-screener-engine.js:185-215`
- **Severity**: CRITICAL
- **Kutipan Kode**:
  ```javascript
  // 1. HARD GATE: Status Tunggu Pullback DILARANG masuk High Conviction
  if (status.includes('WAIT_PULLBACK') || status.includes('WAIT PULLBACK') ||
      action.includes('tunggu pullback') || action.includes('wait pullback') ||
      notes.includes('tunggu pullback') || notes.includes('wait pullback')) {
    return null;
  }
  // 2. HARD GATE: Risk/Reward WAJIB >= 1.8x
  if (rr < MIN_SWING_HIGH_CONVICTION_RR) {
    return null;
  }
  ```
- **Dampak ke User**: Fungsi hanya mengecek larangan `WAIT_PULLBACK`, tetapi tidak memblokir status `AVOID` atau `SPECULATIVE`. Saham yang ditandai berbahaya/tidak likuid oleh modul analisis awal bisa lolos dan dipromosikan ke Telegram sebagai "High Conviction Swing".
- **Bukti Test Nyata**: `test/screener-fase3-bugs.test.js` - Case `BUG-F3-03`: Candidate dengan `status: 'AVOID'`, `risk_reward: 2.5`, dan `conviction_score: 85` mengembalikan objek approved dan tidak bernilai `null`.
- **Usulan Perbaikan**: Tambahkan pengecekan eksplisit: `if (status.includes('AVOID') || status.includes('SPECULATIVE')) return null;`.

---

### BUG-F3-04: Evaluasi entry_status Menutup Pengecekan Volume pada Status READY_BREAKOUT
- **Lokasi**: `lib/screener-config.js:133-137`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const isBreakoutOrEntry = options.require_volume === true ||
    ['BREAKOUT_CONFIRMED', 'READY_BREAKOUT', 'A_PLUS_SETUP', 'IN_ENTRY_AREA', 'TRADE_CANDIDATE'].includes(
      String(candidate.entry_status || candidate.status || candidate.breakout_confirmation_status || '').toUpperCase()
    );
  ```
- **Dampak ke User**: Karena evaluasi menggunakan operator short-circuit `candidate.entry_status || candidate.status || ...`, bila `candidate.entry_status` bernilai truthy seperti `'EXTENDED'` atau `'NEAR_RESISTANCE'`, `candidate.status: 'READY_BREAKOUT'` tidak pernah terbaca. Akibatnya, syarat konfirmasi volume diabaikan dan saham breakout bervolume rendah (palsu) tetap lolos.
- **Bukti Test Nyata**: `test/screener-fase3-bugs.test.js` - Case `BUG-F3-04`: Candidate dengan `entry_status: 'EXTENDED'`, `status: 'READY_BREAKOUT'`, dan `volume_ratio: 0.7` mengembalikan `{ pass: true }`.
- **Usulan Perbaikan**: Periksa status entry, screener status, dan breakout confirmation status secara independen atau cek union status `[candidate.entry_status, candidate.status, candidate.breakout_confirmation_status].some(...)`.

---

### BUG-F3-05: Inversi TP2 < TP1 pada Respect Zone Refinement Menyebabkan Penolakan Palsu R/R
- **Lokasi**: `lib/daytrade-screener-engine.js:1475-1510`
- **Severity**: MEDIUM
- **Kutipan Kode**:
  ```javascript
  if (supplyLevel && supplyLevel > lastPrice * 1.005) {
    ...
    refined.tp1 = Math.round(supplyLevel);
  }
  ...
  if (refined.tp2 < refined.tp1) valid = false;
  if (!valid) {
    var fallback = {
      ...
      refinement_notes: 'Respect zone refinement skipped because R/R would become too weak (min ' + minRR + ').',
    };
    return fallback;
  }
  ```
- **Dampak ke User**: Ketika `tp1` disesuaikan naik mengikuti supply level terdekat tetapi `tp2` bawaan berada di bawah level baru tersebut, validasi membatalkan seluruh penyesuaian zona support/demand dan menyematkan pesan menyesatkan bahwa "R/R terlalu lemah", padahal R/R aktualnya sangat menguntungkan.
- **Bukti Test Nyata**: `test/screener-fase3-bugs.test.js` - Case `BUG-F3-05`: Refinement dengan `baseLevels.tp1: 108`, `tp2: 110`, dan supply 115 dibatalkan dengan catatan `'Respect zone refinement skipped because R/R would become too weak'`.
- **Usulan Perbaikan**: Saat `tp1` dinaikkan ke supply level, pastikan `refined.tp2 = Math.max(refined.tp2, refined.tp1 + atrProxy * 0.5)` sebelum memeriksa validitas level.

---

### BUG-F3-06: Coercion `null` pada Evaluasi Stop Loss (`stopLoss >= entryLow`) Mengakibatkan Penolakan Palsu (`STOP_NOT_BELOW_ENTRY`)
- **Lokasi**: `lib/trade-plan-v2.js:559`
- **Severity**: CRITICAL
- **Kutipan Kode**:
  ```javascript
  if (stopLoss === null || stopLoss >= entryLow) {
    return base({
      status: STATUS.REJECTED,
      reject_reason: 'STOP_NOT_BELOW_ENTRY',
      ...
    });
  }
  ```
- **Dampak ke User**: Bila candidate hanya menyediakan harga `entry_high` (misal 1000) tanpa `entry_low`, nilai `entryLow` bernilai `null`. Di JavaScript, operator relational `>=` mengonversi `null` menjadi `0`, sehingga perbandingan `stopLoss >= null` bernilai `true` (`940 >= 0`). Setup trading yang sah ditolak mentah-mentah dengan alasan `STOP_NOT_BELOW_ENTRY` padahal stop loss berada aman di bawah entry.
- **Bukti Test Nyata**: `test/screener-fase3-batch2-bugs.test.js` - Case `BUG-F3-06`: Candidate dengan `entry_high: 1000`, `support: 950`, dan `stopLoss: 940` ditolak dengan `reject_reason: 'STOP_NOT_BELOW_ENTRY'`.
- **Usulan Perbaikan**: Gunakan `entryFloor = entryLow !== null ? entryLow : entryRef` saat memeriksa posisi stop loss (`if (stopLoss === null || stopLoss >= entryFloor)`).

---

### BUG-F3-07: Overhead Resistance Level Menerima Support Bawah saat `entryHigh` Bernilai `null`
- **Lokasi**: `lib/trade-plan-v2.js:368`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  function isUsableOverheadLevel(level, entryHigh, tolerance) {
    return !!(level && level.valid && level.confirmed && level.defended &&
      !level.stale && !level.failed && level.value > entryHigh);
  }
  ```
- **Dampak ke User**: Bila candidate hanya menyuplai `entry_low: 1000`, `entryHigh` bernilai `null`. Operator `level.value > null` mengevaluasi `level.value > 0`. Semua level support (misalnya level 500) lolos sebagai overhead resistance karena `500 > 0` adalah `true`. Level 500 ini terpilih sebagai resistance terdekat sehingga memotong TP1 di bawah harga beli dan membatalkan TP1 dengan warning palsu `ENTRY_TOO_CLOSE_TO_RESISTANCE`.
- **Bukti Test Nyata**: `test/screener-fase3-batch2-bugs.test.js` - Case `BUG-F3-07`: Candidate dengan `entry_low: 1000` dan level 500 memilih resistance 500.
- **Usulan Perbaikan**: Gunakan `entryCeil = entryHigh !== null ? entryHigh : entryRef` dalam `isUsableOverheadLevel(level, entryCeil, tolerance)` dan pastikan `level.value > entryCeil`.

---

### BUG-F3-08: False Reassurance `SUPPORT_HOLDING` saat Penutupan Harga di Bawah Garis Support
- **Lokasi**: `lib/trade-plan-v2.js:180-192`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  } else if (last.close < buffered) {
    state = SUPPORT_STATE.BREAKDOWN_PENDING;
    reason = 'one close below buffered support — awaiting a second confirming observation';
  } else if (last.low < support && last.close >= support) {
    state = SUPPORT_STATE.TEST_RECLAIMED;
    reason = 'low pierced support but close reclaimed above it (failed breakdown)';
  } else if (tests >= 2 && last.low <= support + tol) {
    state = SUPPORT_STATE.WEAKENING;
    reason = tests + ' repeated tests of support with price sitting on the level';
  } else {
    state = SUPPORT_STATE.HOLDING;
    reason = 'price holding above support';
  }
  ```
- **Dampak ke User**: Jika harga ditutup di bawah support (`close: 99`, `support: 100`) namun masih di atas batas buffered (`buffered: 98`), kondisi jatuh ke blok `else`, menghasilkan state `SUPPORT_HOLDING` ("price holding above support"). Trader disesatkan oleh status hijau aman padahal harga sudah tembus di bawah support.
- **Bukti Test Nyata**: `test/screener-fase3-batch2-bugs.test.js` - Case `BUG-F3-08`: Bar dengan `close: 99` pada `support: 100` dan `buffered: 98` mengembalikan `SUPPORT_HOLDING`.
- **Usulan Perbaikan**: Tambahkan pengecekan eksplisit jika `last.close < support`: laporkan `SUPPORT_STATE.WEAKENING` atau `SUPPORT_STATE.BREAKDOWN_PENDING` daripada `SUPPORT_HOLDING`.

---

### BUG-F3-09: Dead Gate Konfirmasi Volume & Support Menghasilkan Konfirmasi Palsu (`'Bullish confirmation'`)
- **Lokasi**: `lib/candle-pattern-engine.js:291-292`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  if (hasVol || nearSupport) return 'Bullish confirmation';
  return 'Bullish confirmation';
  ```
- **Dampak ke User**: Baris terakhir fungsi `calcConfirmation` mengembalikan `'Bullish confirmation'` secara tanpa syarat, membuat pengecekan `if (hasVol || nearSupport)` menjadi mati (dead code). Pola candle bullish dengan volume kering (misal `volumeRatio: 0.05`) dan berada di antah berantah tanpa support tetap dilabeli "Bullish confirmation", memperdaya trader pemula masuk ke breakout palsu.
- **Bukti Test Nyata**: `test/screener-fase3-batch2-bugs.test.js` - Case `BUG-F3-09`: Candle bullish dengan `volumeRatio: 0.05` dan jauh dari support mengembalikan `'Bullish confirmation'`.
- **Usulan Perbaikan**: Ganti fallback baris 292 menjadi `return 'No confirmation';`.

---

### BUG-F3-10: Candle Data Korup Berisi `NaN` Ditetapkan sebagai `'Bearish candle'` Valid
- **Lokasi**: `lib/candle-pattern-engine.js:39 & 260-261`
- **Severity**: MEDIUM
- **Kutipan Kode**:
  ```javascript
  if (!c0 || c0.open == null || c0.close == null || c0.high == null || c0.low == null) return empty();
  ...
  if (bull) return { name: 'Bullish candle', bias: 'Bullish', weight: 1 };
  return { name: 'Bearish candle', bias: 'Bearish', weight: 1 };
  ```
- **Dampak ke User**: Pengecekan `c0.open == null` lolos ketika nilai bernilai `NaN` (`NaN == null` adalah `false`). Seluruh perhitungan rasio menghasilkan `NaN`, dan karena `bull` (`c0.close > c0.open`) bernilai `false`, sistem menetapkannya sebagai `Bearish candle` resmi dengan catatan narasi waspada tekanan jual.
- **Bukti Test Nyata**: `test/screener-fase3-batch2-bugs.test.js` - Case `BUG-F3-10`: Candle dengan `open: NaN` menghasilkan `{ pattern: 'Bearish candle', bias: 'Bearish' }`.
- **Usulan Perbaikan**: Gunakan validasi `Number.isFinite(c0.open) && Number.isFinite(c0.close) && Number.isFinite(c0.high) && Number.isFinite(c0.low)` pada entry guard.

---

### BUG-F3-11: File `lib/intraday-engine.js` Kosong (0 Bytes)
- **Lokasi**: `lib/intraday-engine.js:1`
- **Severity**: MEDIUM
- **Kutipan Kode**:
  ```javascript
  (file kosong / 0 bytes)
  ```
- **Dampak ke User**: File inti yang terdaftar dalam arsitektur Fase 3 tidak memiliki implementasi logika dan hanya mengekspor objek kosong `{}`. Pemanggilan fungsi intraday akan melempar `TypeError: ... is not a function`.
- **Bukti Test Nyata**: `test/screener-fase3-batch2-bugs.test.js` - Case `BUG-F3-11`: `Object.keys(intradayEngine).length` bernilai `0`.
- **Usulan Perbaikan**: Implementasikan fungsi kalkulasi intraday yang diperlukan atau bersihkan import dead code.

---

### BUG-F3-12: Pivot Low/High Scanner Memeriksa 40 Candle Terlama, Mengabaikan 40-60 Candle Terkini
- **Lokasi**: `lib/trade-plan-v2-candle-structure.js:233-241 & 280-288`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const maxCandleIdx = normalized.length - 3;
  const maxIdx = Math.min(lookback || CONFIRMED_PIVOT_LOOKBACK, maxCandleIdx);
  const pivots = [];

  for (let i = 2; i <= maxIdx; i++) {
  ```
- **Dampak ke User**: Pada array candle kronologis (oldest first, misal 90-100 bar dari Yahoo chart), `maxIdx` dihitung sebagai `Math.min(40, 97) = 40`. Loop hanya memeriksa index 2 s/d 40 (candle terlama 3-4 bulan lalu), sementara 50-60 candle terkini diabaikan total. Swing low/resistance terdekat yang baru saja terbentuk tidak pernah terdeteksi, menyebabkan stop loss atau target take profit salah sasaran.
- **Bukti Test Nyata**: `test/screener-fase3-batch3-bugs.test.js` - Case `BUG-F3-12`: Pivot low pada candle index 70 dari 100 candle tidak ditemukan (`pivots.length === 0`).
- **Usulan Perbaikan**: Iterasikan lookback dari ujung akhir: `const startIdx = Math.max(2, normalized.length - (lookback || CONFIRMED_PIVOT_LOOKBACK)); for (let i = startIdx; i <= maxCandleIdx; i++)`.

---

### BUG-F3-13: `isPlanV2Usable` Menolak Plan Valid Hanya Karena Properti Legacy `'support'` Bernilai `null`
- **Lokasi**: `lib/trade-plan-v2-integration.js:50 & 213-217`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const MANDATORY_PUBLIC_FIELDS = Object.freeze([
    'entry_zone_high',
    'support',
    'resistance',
    ...
  ]);
  ...
  for (const f of MANDATORY_PUBLIC_FIELDS) {
    if (num(plan[f]) === null) return false;
  }
  ```
- **Dampak ke User**: Ketika screener menghasilkan stop loss berbasis struktur valid seperti `confirmed_swing_low` atau `today_low`, nilai `plan.stop_anchor_price` dan `plan.structural_invalidation` terisi sempurna. Namun karena candidate tidak membawa properti bernama tepat `support`, `plan.support` bernilai `null`. `isPlanV2Usable` menolak plan tersebut dan memaksa fallback ke legacy, merusak transparansi V2.
- **Bukti Test Nyata**: `test/screener-fase3-batch3-bugs.test.js` - Case `BUG-F3-13`: Plan dengan `stop_anchor_price: 950` dan `support: null` ditolak (`isPlanV2Usable === false`).
- **Usulan Perbaikan**: Di `MANDATORY_PUBLIC_FIELDS`, ganti atau izinkan pengecekan alternatif: `(plan.support != null || plan.stop_anchor_price != null || plan.structural_invalidation != null)`.

---

### BUG-F3-14: Trailing Zone Event Tidak Melaporkan Kegagalan Struktur (`structure_failed`) Karena Flag Reclaim Usang
- **Lokasi**: `lib/trade-plan-v2-liquidity-sweep.js:147-152 & 165`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  if (firstPierceIdx >= 0) {
    for (let j = firstPierceIdx; j < bars.length; j++) {
      if (bars[j].close >= level) { reclaimed = true; break; }
    }
  }
  ...
  const structureFailed = closedBelow && !reclaimed;
  ```
- **Dampak ke User**: Bila harga sempat memantul sebentar di atas trailing level pada bar awal (`reclaimed = true`), lalu pada bar-bar berikutnya harga jatuh drastis dan ditutup permanen di bawah trailing zone, evaluasi `structureFailed = closedBelow && !reclaimed` menghasilkan `false` karena `reclaimed` bernilai `true` selamanya. Sistem gagal mendeteksi kerusakan struktur trailing stop.
- **Bukti Test Nyata**: `test/screener-fase3-batch3-bugs.test.js` - Case `BUG-F3-14`: Bar terakhir ditutup jauh di bawah trailing level setelah bounce masa lalu, namun `structure_failed` bernilai `false`.
- **Usulan Perbaikan**: `structureFailed` harus memeriksa status penutupan terkini: jika `last.close < level` dan bar-bar setelah pierce terakhir tidak mampu ditutup kembali di atas level, tandai `structure_failed: true`.

---

### BUG-F3-15: Kontradiksi Exit: `soft_exit_state` Ditunda (`DELAYED`) Saat Emergency Stop Telah Tertembus (`HARD_STOP_HIT`)
- **Lokasi**: `lib/trade-plan-v2-liquidity-sweep.js:358-385`
- **Severity**: CRITICAL
- **Kutipan Kode**:
  ```javascript
  const emergencyHit = emergency !== null && lastClose !== null && lastClose < emergency;
  ...
  case TRAILING_SWEEP_STATE.SWEEP_PENDING:
    soft = SOFT_EXIT_STATE.DELAYED;
    confirmationRequired = true;
    break;
  ...
  return {
    soft_exit_state: soft,
    hard_exit_state: emergencyHit ? HARD_EXIT_STATE.HIT : HARD_EXIT_STATE.ACTIVE,
    structure_confirmation_required: confirmationRequired,
    emergency_stop_active: true
  };
  ```
- **Dampak ke User**: Ketika harga telah anjlok menembus emergency stop (`HARD_STOP_HIT`), logika state machine tetap menyematkan `soft_exit_state: 'SOFT_EXIT_DELAYED'` dan `structure_confirmation_required: true` jika kondisi trailing sweep masih pending. Trader menerima sinyal ambigu bahwa exit dapat "ditunda menunggu konfirmasi" padahal hard stop darurat sudah jebol.
- **Bukti Test Nyata**: `test/screener-fase3-batch3-bugs.test.js` - Case `BUG-F3-15`: Saat `emergencyHit` bernilai `true`, `soft_exit_state` tetap dilaporkan `SOFT_EXIT_DELAYED`.
- **Usulan Perbaikan**: Tambahkan override mutlak: `if (emergencyHit) { soft = SOFT_EXIT_STATE.TRIGGERED; confirmationRequired = false; }`.

---

### BUG-F3-16: Penyesuaian Skor Intraday Tidak Mengoreksi Status Sinyal (`A_PLUS_SETUP` Bertahan Saat Skor Drop ke 55)
- **Lokasi**: `lib/daytrade-intraday-score-adjustment.js:28-40`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  var adjustedScore = clampScore(baseScore + adjustment);
  var output = Object.assign({}, candidate);
  output[scoreField] = adjustedScore;
  output.base_daytrade_score = baseScore;
  output.intraday_score_adjustment_applied = adjustment;
  output.intraday_score_adjustment_reasons = normalizeReasons(candidate.intraday_score_adjustment_reasons);
  return output;
  ```
- **Dampak ke User**: Ketika modul intraday memberikan penalti signifikan (misal -35 karena distribusi besar), skor turun dari 90 ke 55. Namun status sinyal `status = 'A_PLUS_SETUP'` dan `confidence = 'A+'` tidak diperbarui. User tetap menerima sinyal "A+ SETUP" prioritas utama dengan skor yang sebenarnya sudah di bawah ambang trading (non-tradeable).
- **Bukti Test Nyata**: `test/screener-fase3-batch3-bugs.test.js` - Case `BUG-F3-16`: Candidate dengan skor awal 90 dikoreksi ke 55 tetap berstatus `'A_PLUS_SETUP'` dan confidence `'A+'`.
- **Usulan Perbaikan**: Jika skor hasil penyesuaian turun di bawah threshold klasifikasi aslinya, sesuaikan `status` (misal ke `WAIT_PULLBACK` atau `AVOID`) dan turunkan `confidence` secara proporsional.

---

### BUG-F3-17: `calculateVolumePace` Membatalkan Kalkulasi `intraday_volume_pace_ratio` Jika Candle Sesi Ini Tidak Masuk dalam Array Candle Historis
- **Lokasi**: `lib/intraday-volume-pace.js:228-232`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const sessionCandle = Array.isArray(data.candles)
    ? currentSessionCandle(data.candles, data.sample_date)
    : null;
  const explicitCurrentSession = data.current_session_candle_present === true;
  const hasCandleContext = Array.isArray(data.candles) && data.candles.length > 0;
  const currentSessionPresent = explicitCurrentSession || Boolean(sessionCandle) || !hasCandleContext;
  ...
  const projected = currentSessionPresent && volumeToday != null && volumeToday >= 0 && ...
  ```
- **Dampak ke User**: Ketika pemanggil menyuplai data volume berjalan via `volume_today` dan riwayat candle via `candles` (yang hanya berisi candle harian yang sudah closed hingga kemarin), `hasCandleContext` bernilai `true` dan `sessionCandle` bernilai `null`. Akibatnya `currentSessionPresent` bernilai `false`, dan `intraday_volume_pace_ratio` di-set menjadi `null` dengan status `'current_session_candle_missing'`, mematikan seluruh kalkulasi pacing volume intraday.
- **Bukti Test Nyata**: `test/screener-fase3-batch3-bugs.test.js` - Case `BUG-F3-17`: `volume_today: 500000` dengan 20 completed candles menghasilkan `intraday_volume_pace_ratio: null`.
- **Usulan Perbaikan**: Jika `data.volume_today` disediakan langsung dan valid (`finite(data.volume_today) >= 0`), anggap `currentSessionPresent = true`.
