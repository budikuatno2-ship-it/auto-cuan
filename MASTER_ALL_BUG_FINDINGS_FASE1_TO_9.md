# FULL REPO BUG FINDINGS V2

Dokumen pencatatan bug hasil audit independen. Semua temuan berstatus `BELUM DIPERBAIKI`.

---

### [BUG-CAPSG-01] Stale 1:2 Split Lolos Guard Saat Hanya Ada Satu Critical Level
- **Lokasi**: `lib/corporate-action-price-scale-guard.js:40-44`
- **Kode Bermasalah**:
  ```javascript
  const criticalFar = actionable.some((item) => CRITICAL_FIELDS[item.field] && (item.value / trustedLatest > 3 || item.value / trustedLatest < (1 / 3)));
  const enoughEvidence = actionable.length >= 2;
  const blocked = (enoughEvidence && farMedian && (commonScale || ratio > 2.2 || ratio < 0.45)) || criticalFar;
  ```
- **Dampak ke User**: CRITICAL. Pada stock split 1:2 (sangat umum di IDX seperti BBRI), jika candidate hanya memiliki satu level trading penting (`entry: 6000`, `latest_price: 3000`), rasio 2.0x tidak memicu `criticalFar` (> 3) dan gagal syarat `enoughEvidence` (panjang < 2). Guard mengembalikan `blocked: false` dan meloloskan sinyal beli dengan harga 100% di atas harga pasar.
- **Bukti Test Nyata**:
  - Perintah: `node test/corporate-action-price-scale-guard-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 1: 1:2 split ratio 2.0 with single critical entry level must be blocked` (false === true)
- **Usulan Perbaikan**: Turunkan batas `criticalFar` ke faktor split umum (misal `nearSplitFactor(ratio)` atau rasio >= 1.8 / <= 0.55) bahkan ketika `actionable.length === 1` untuk field kritis.

---

### [BUG-CAPSG-02] Omit Field Standar `tp` & `target` dari Actionable Price Fields
- **Lokasi**: `lib/corporate-action-price-scale-guard.js:4-10`
- **Kode Bermasalah**:
  ```javascript
  const ACTIONABLE_PRICE_FIELDS = [
    'price', 'latest_price', 'current_price', 'close', 'close_price',
    'entry', 'entry_price', 'entry_low', 'entry_high', 'entry1', 'entry2',
    'stop_loss', 'sl', 'tp1', 'tp2', 'tp3', 'target_price',
    ...
  ```
- **Dampak ke User**: HIGH. Properti `tp` dan `target` (nama variabel standar di sinyal daytrade/swing) tidak terdaftar di `ACTIONABLE_PRICE_FIELDS`. Level take profit lama yang belum disesuaikan pasca corporate action tidak dihitung, menyebabkan guard meloloskan data take profit usang tanpa terdeteksi.
- **Bukti Test Nyata**:
  - Perintah: `node test/corporate-action-price-scale-guard-bugs.test.js`
  - Output: `assert.strictEqual(res.blocked, true)` gagal karena `tp: 5000` diabaikan dan hanya level `entry: 1020` yang dievaluasi.
- **Usulan Perbaikan**: Tambahkan alias umum seperti `'tp'`, `'target'`, `'cl'`, `'cut_loss'` ke `ACTIONABLE_PRICE_FIELDS` dan daftar critical/target yang relevan.

---

### [BUG-CAPSG-03] Mengabaikan Format Snake-case `context.latest_price` dan Number Literal
- **Lokasi**: `lib/corporate-action-price-scale-guard.js:59`
- **Kode Bermasalah**:
  ```javascript
  const result = detectPriceScaleMismatch(row, context && context.latestPrice, context);
  ```
- **Dampak ke User**: HIGH. Caller yang mengirim context standar snake-case `{ latest_price: 1000 }` atau number literal `1000` menghasilkan `context.latestPrice === undefined`. Jika candidate tidak memiliki field harga internal, guard gagal melakukan evaluasi (`latest_price_missing`) alih-alih memblokir level stale.
- **Bukti Test Nyata**:
  - Perintah: `node test/corporate-action-price-scale-guard-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: Snake_case context.latest_price must be recognized and block stale 5x scale` (NOT_EVALUATED !== BLOCKED).
- **Usulan Perbaikan**: Resolve latest price dari context dengan mendukung `context.latestPrice || context.latest_price || (typeof context === 'number' ? context : null)`.

---

### [BUG-CAPSG-04] Insufficient Actionable Levels Diberi Status `PASSED`
- **Lokasi**: `lib/corporate-action-price-scale-guard.js:60`
- **Kode Bermasalah**:
  ```javascript
  row.corporate_action_guard = result.blocked ? 'BLOCKED' : (result.reason === 'latest_price_missing' ? 'NOT_EVALUATED' : 'PASSED');
  ```
- **Dampak ke User**: MEDIUM. Candidate tanpa level actionable apa pun (`insufficient_actionable_levels`) ditandai sebagai `PASSED`, memberikan status validasi palsu ke UI/telemetry seolah level harga sudah dicek dan terverifikasi aman.
- **Bukti Test Nyata**:
  - Perintah: `node test/corporate-action-price-scale-guard-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 4: Insufficient actionable levels should not be marked PASSED` ('PASSED' !== 'PASSED').
- **Usulan Perbaikan**: Set `row.corporate_action_guard = 'NOT_EVALUATED'` jika `result.reason === 'insufficient_actionable_levels'`.

---

### [BUG-CAPSG-05] Polusi Properti `stale_level_sample` Pada Candidate Valid yang Lolos
- **Lokasi**: `lib/corporate-action-price-scale-guard.js:63`
- **Kode Bermasalah**:
  ```javascript
  if (result.stale_level_sample) row.stale_level_sample = result.stale_level_sample;
  ```
- **Dampak ke User**: LOW. Baris data yang valid (`blocked === false`) tetap diinjeksi properti `stale_level_sample`. Komponen UI atau downstream service yang memeriksa keberadaan key tersebut berpotensi salah mengira item tersebut bermasalah.
- **Bukti Test Nyata**:
  - Perintah: `node test/corporate-action-price-scale-guard-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 5: Valid non-stale candidate must not have stale_level_sample attached`.
- **Usulan Perbaikan**: Hanya lampirkan `stale_level_sample` jika `result.blocked === true`.

---

### [BUG-LPR-01] Inversion of Freshness: Sumber Lama Mengalahkan Sumber Baru
- **Lokasi**: `lib/latest-price-resolver.js:28-33`
- **Kode Bermasalah**:
  ```javascript
  for (const source of SOURCES) {
    const row = rowsBySource[source.table];
    if (!row || !rowPrice(row) || !isFresh(row, options)) continue;
    return { price: rowPrice(row), price_source: source.label, ... };
  }
  ```
- **Dampak ke User**: CRITICAL. Iterasi statis berdasarkan urutan `SOURCES` menyebabkan harga lama dari `daytrade_screener_latest` (misal 26 jam lalu) selalu dipilih dan mengabaikan harga baru dari `swing_screener_latest` (misal 1 jam lalu) selama data lama belum lewat 48 jam. Pengguna disajikan harga usang kemarin alih-alih harga terkini hari ini.
- **Bukti Test Nyata**:
  - Perintah: `node test/latest-price-resolver-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 1: Freshness resolver must select the genuinely newest price, not older daytrade row` (1000 !== 1500).
- **Usulan Perbaikan**: Bandingkan timestamp semua sumber yang fresh dan pilih baris dengan `rowDate` paling baru, bukan hardcoded urutan array.

---

### [BUG-LPR-02] String Tanggal 'YYYY-MM-DD' Ditolak di Pagi Hari Karena UTC Midnight
- **Lokasi**: `lib/latest-price-resolver.js:25`
- **Kode Bermasalah**:
  ```javascript
  function isFresh(row, options) {
    var at = date(rowDate(row));
    ...
    return now.getTime() - at.getTime() <= maxHours * 3600000 && now.getTime() >= at.getTime() - 3600000;
  }
  ```
- **Dampak ke User**: CRITICAL. `new Date('YYYY-MM-DD')` di-parse sebagai UTC 00:00 (WIB 07:00). Pada rentang waktu pagi sebelum 06:00 WIB (misal 05:00 WIB = UTC 22:00 kemarin), selisih waktu adalah 2 jam di masa depan. Syarat `now >= at - 1 hour` gagal, sehingga data bertanggal HARI INI ditolak sebagai tidak fresh / masa depan.
- **Bukti Test Nyata**:
  - Perintah: `node test/latest-price-resolver-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 2: Today date-only trade_date must be fresh on morning of trading day` (false === true).
- **Usulan Perbaikan**: Parse string tanggal `YYYY-MM-DD` sebagai tanggal kalender lokal Jakarta (WIB 00:00) atau beri toleransi kalender jika tanggalnya sama dengan tanggal Jakarta hari ini.

---

### [BUG-LPR-03] Weekend Gap: Default maxAgeHours 48 Jam Menganggap Data Jumat Stale di Hari Senin Pagi
- **Lokasi**: `lib/latest-price-resolver.js:25`
- **Kode Bermasalah**:
  ```javascript
  var maxHours = n(options && options.maxAgeHours) || 48;
  return now.getTime() - at.getTime() <= maxHours * 3600000 && ...
  ```
- **Dampak ke User**: HIGH. Jarak waktu dari penutupan bursa Jumat (16:00 WIB) ke pembukaan bursa Senin (09:00 WIB) adalah 65 jam. Default 48 jam menyebabkan seluruh harga penutupan Jumat ditolak sebagai stale (`price: null, stale: true`) pada hari Senin pagi sebelum screener baru berjalan.
- **Bukti Test Nyata**:
  - Perintah: `node test/latest-price-resolver-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: Friday close must not be marked stale on Monday morning market open` (true === false).
- **Usulan Perbaikan**: Naikkan default `maxAgeHours` menjadi minimal 72-80 jam untuk mengakomodasi akhir pekan, atau gunakan kalkulator trading-day.

---

### [BUG-LPR-04] Properti Standar `'price'` Tidak Ada di `PRICE_FIELDS`
- **Lokasi**: `lib/latest-price-resolver.js:10`
- **Kode Bermasalah**:
  ```javascript
  const PRICE_FIELDS = ['latest_price', 'current_price', 'last_price', 'last', 'close_price', 'close'];
  ```
- **Dampak ke User**: HIGH. Objek yang menggunakan properti `'price'` (standar yang dihasilkan oleh corporate action guard, bridge live price VPS, dan payload quote umum) tidak dikenali, menghasilkan `rowPrice === null` dan harga dianggap hilang.
- **Bukti Test Nyata**:
  - Perintah: `node test/latest-price-resolver-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 4: rowPrice must support standard "price" property` (null !== 4200).
- **Usulan Perbaikan**: Tambahkan `'price'` ke `PRICE_FIELDS`.

---

### [BUG-LPR-05] Properti Standar `'as_of_date'` dan `'date'` Tidak Ada di `DATE_FIELDS`
- **Lokasi**: `lib/latest-price-resolver.js:11`
- **Kode Bermasalah**:
  ```javascript
  const DATE_FIELDS = ['price_date', 'price_asof', 'last_price_asof', 'calculated_at', 'published_at', 'run_date', 'trade_date', 'updated_at'];
  ```
- **Dampak ke User**: MEDIUM. Baris yang membawa tanggal pada field `'as_of_date'` (digunakan oleh `daily-market-context-builder` dan `stock-daily-features`) atau `'date'` (digunakan oleh cache candle) gagal diambil tanggalnya, menyebabkan `isFresh` mengembalikan `false`.
- **Bukti Test Nyata**:
  - Perintah: `node test/latest-price-resolver-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 5: rowDate must recognize "as_of_date" and "date"` (null !== '2026-08-12').
- **Usulan Perbaikan**: Tambahkan `'as_of_date'` dan `'date'` ke `DATE_FIELDS`.

---

### [BUG-LPR-06] Boolean `true` Pada Field `last` Dikonversi Menjadi Harga 1
- **Lokasi**: `lib/latest-price-resolver.js:12`
- **Kode Bermasalah**:
  ```javascript
  function n(value) { value = Number(value); return Number.isFinite(value) && value > 0 ? value : null; }
  ```
- **Dampak ke User**: LOW. Jika row memiliki flag boolean `last: true`, `n(true)` menghasilkan angka `1`. `rowPrice` mengembalikan `1` (Rp 1) alih-alih mengambil harga riil dari field `close` atau field lainnya.
- **Bukti Test Nyata**:
  - Perintah: `node test/latest-price-resolver-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 6: Boolean true in last property must not be coerced to price 1` (1 !== 5000).
- **Usulan Perbaikan**: Tambahkan pengecekan tipe data `if (typeof value === 'boolean') return null;` di helper `n(value)`.

---

### [BUG-ARJUM-01] Parameter `date=latest` Terkirim ke Remote Arjum API
- **Lokasi**: `lib/arjum-client.js:376-379`
- **Kode Bermasalah**:
  ```javascript
  if (date) {
    const enc = encodeURIComponent(date);
    params.push(`start_date=${enc}`, `end_date=${enc}`, `date=${enc}`);
  }
  ```
- **Dampak ke User**: CRITICAL. Ketika caller memanggil `fetchBrokerSummary(code, 'latest')` (pola umum di codebase saat meminta data broker summary terkini), URL yang terbentuk adalah `/api/broker-summary/{code}?start_date=latest&end_date=latest&date=latest`. Remote API Arjum yang mengharapkan format kalender `YYYY-MM-DD` menolak request ini dengan error 400/422/500, membuang kuota API dan menggagalkan penampilan data broker summary ke user.
- **Bukti Test Nyata**:
  - Perintah: `node test/arjum-client-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] Bug 1: Parameter date=latest must not be sent to remote Arjum API`
- **Usulan Perbaikan**: Periksa `if (date && date !== 'latest')` sebelum menambahkan parameter `start_date`, `end_date`, dan `date` ke URL query string.

---

### [BUG-ARJUM-02] `cleanTicker` Merusak Simbol Saham Berakhiran `.JK` Menjadi 6 Huruf Tidak Valid
- **Lokasi**: `lib/arjum-client.js:55-57`
- **Kode Bermasalah**:
  ```javascript
  function cleanTicker(raw) {
    return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  ```
- **Dampak ke User**: CRITICAL. Ticker bursa Indonesia yang berakhiran `.JK` (standar Yahoo Finance dan berbagai modul di repo, misal `BBCA.JK`, `BBRI.JK`) diubah menjadi `BBCAJK` atau `BBRIJK` karena titik dihilangkan tanpa membuang suffix `.JK`. Akibatnya, request ke endpoint `/api/broker-summary/BBCAJK` gagal (404/not found), cache lokal di folder `BBCA/` tidak ditemukan, dan kuota terbuang sia-sia.
- **Bukti Test Nyata**:
  - Perintah: `node test/arjum-client-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 2: cleanTicker("BBCA.JK") must strip .JK suffix to produce "BBCA", got "BBCAJK"`
- **Usulan Perbaikan**: Hapus suffix `.replace(/\.JK$/i, '')` sebelum menerapkan regex pembersihan karakter `replace(/[^A-Z0-9]/g, '')`.

---

### [BUG-ARJUM-03] Single 429 Mengunci Circuit Breaker Selama Sisa Hari Penuh (Hingga Esok 00:00 WIB)
- **Lokasi**: `lib/arjum-client.js:73-77`, `279-281`, `94-98`
- **Kode Bermasalah**:
  ```javascript
  function tripCircuitBreaker(reason) {
    arjumCircuitBreakerTripped = true;
    circuitBreakerTripDate = quotaTracker.getTodayWibKey();
    console.warn(`[CIRCUIT BREAKER] Arjum daily quota reached or rate-limited. Blocking outgoing calls...`);
  }
  ```
- **Dampak ke User**: HIGH. Jika Arjum memberikan respons HTTP 429 karena temporary rate-limit (misal burst limit 1 detik), `tripCircuitBreaker` mengunci status circuit breaker dengan tanggal hari ini. Circuit breaker HANYA direset ketika `circuitBreakerTripDate !== today` (yaitu esok hari WIB). Akibatnya, seluruh request Arjum dari semua user/screener diblokir total hingga tengah malam, meskipun sisa kuota harian masih ribuan request.
- **Bukti Test Nyata**:
  - Perintah: `node test/arjum-client-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: Circuit breaker should not permanently latch closed for the entire day on a single 429` (true === false)
- **Usulan Perbaikan**: Pisahkan burst rate limit (temporary cooldown misal 1-5 menit) dengan daily quota exhaustion (`getUsedToday() >= getConfiguredDailyQuota()`).

---

### [BUG-ARJUM-04] Default Fallback Mengabaikan Konfigurasi `ARJUM_DAILY_QUOTA=0`
- **Lokasi**: `lib/arjum-client.js:46-49`
- **Kode Bermasalah**:
  ```javascript
  function getConfiguredDailyQuota() {
    const fromEnv = parseInt(process.env.ARJUM_DAILY_QUOTA, 10);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : FALLBACK_DAILY_QUOTA;
  }
  ```
- **Dampak ke User**: HIGH. Jika administrator/ops mengatur `ARJUM_DAILY_QUOTA=0` di `.env` untuk mematikan konsumsi Arjum secara darurat, pengecekan `fromEnv > 0` bernilai `false`, sehingga fungsi fallback kembali ke `DEFAULT_DAILY_QUOTA` (16.000 panggilan). Sistem tetap menembak API eksternal alih-alih berhenti.
- **Bukti Test Nyata**:
  - Perintah: `node test/arjum-client-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 4: ARJUM_DAILY_QUOTA=0 must set quota to 0, got 16000` (16000 === 0)
- **Usulan Perbaikan**: Periksa `Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : FALLBACK_DAILY_QUOTA`.

---

### [BUG-ARJUM-05] Non-Date JSON Files Menggagalkan Deteksi Cache Terbaru di `readLocalBrokerSummary`
- **Lokasi**: `lib/arjum-client.js:142-146`
- **Kode Bermasalah**:
  ```javascript
  const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.json') && f !== 'latest.json').sort().reverse();
  if (files.length > 0) {
    const content = fs.readFileSync(path.join(targetDir, files[0]), 'utf8');
  ...
  ```
- **Dampak ke User**: MEDIUM. Jika folder cache ticker berisi file JSON metadata non-tanggal (seperti `summary.json`, `metadata.json`, atau `backup.json`), sorting string secara reverse menempatkan file tersebut di urutan teratas (`files[0]`) mendahului file tanggal `2026-03-30.json` karena huruf alfabet `s` / `m` / `b` lebih besar dari digit `2`. Pengguna disajikan data dari file metadata yang salah alih-alih data broker summary terbaru.
- **Bukti Test Nyata**:
  - Perintah: `node test/arjum-client-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 5: readLocalBrokerSummary must select newest date file (2026-03-30.json), not summary.json (got METADATA_FILE)`
- **Usulan Perbaikan**: Filter file yang hanya cocok dengan regex format tanggal: `f.match(/^\d{4}-\d{2}-\d{2}\.json$/)`.

---

### [BUG-ARJUM-06] Tidak Ada Cache Fallback Pada Kesalahan Jaringan / 5xx Server Error
- **Lokasi**: `lib/arjum-client.js:388-393`, `426-431`, `472-477`
- **Kode Bermasalah**:
  ```javascript
  const res = await fetchArjum(endpoint, options);
  if (!res.ok && res.rateLimited) {
    const fallbackCached = readLocalBrokerSummary(ticker, 'latest') || readLocalBrokerSummary(ticker, date);
    if (fallbackCached) {
      return { ok: true, status: 200, data: fallbackCached, fallback: true, rateLimited: true };
    }
  }
  return res;
  ```
- **Dampak ke User**: MEDIUM. Fallback ke disk cache hanya dieksekusi jika `res.rateLimited` bernilai `true`. Jika stock.arjum.com mengalami 500 Internal Server Error, 502 Bad Gateway, 504 Timeout, atau koneksi jaringan putus, `res.rateLimited` bernilai `false`. Request langsung gagal dan mengembalikan error ke user tanpa memanfaatkan disk cache historis yang tersedia.
- **Bukti Test Nyata**:
  - Perintah: `node test/arjum-client-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 6: fetchBrokerSummary must fallback to cached latest.json on HTTP 500 server error` (false === true)
- **Usulan Perbaikan**: Perluas kondisi fallback: `if (!res.ok) { const fallbackCached = ... }`.

---

### [BUG-ITN-01] Pandemi -15% Asymmetrical ARB Hardcoded & Mengabaikan Batasan Sesi FCA (+/-10%)
- **Lokasi**: `lib/idx-tick-normalization.js:665-675`
- **Kode Bermasalah**:
  ```javascript
  function getIdxAutoRejectBand(referencePrice, opts) {
    opts = opts || {};
    var ref = toNum(referencePrice, null);
    if (ref == null || !isFinite(ref) || ref <= 0) return null;
    var label = 'normal_board_assumption';
    var board = String(opts.board || opts.board_type || '').toUpperCase();
    if (board && board !== 'UNKNOWN') label = 'normal_board';
    var ara = 0.35;
    if (ref > 5000) ara = 0.20;
    else if (ref > 200) ara = 0.25;
    return { ara_pct: round2(ara * 100), arb_pct: -15, ara_multiplier: 1 + ara, arb_multiplier: 0.85, ara_band_label: label };
  }
  ```
- **Dampak ke User**: CRITICAL. Sejak 4 September 2023, batas ARB BEI telah kembali simetris (-35%, -25%, -20%). Fungsi ini masih meng-hardcode batasan darurat pandemi `arb_pct: -15, arb_multiplier: 0.85`. Akibatnya, level ARB dihitung terlalu tinggi, sehingga Stop Loss yang sah (misal -18% pada saham Rp 1.000) disangka jebol ARB (`sl_below_arb: true`), memicu status `NEAR_ARB` palsu dan mematikan eksekusi sinyal beli (`buy_execution_realistic: false`). Selain itu, saham Papan Pemantauan Khusus (FCA) yang memiliki batas +/- 10% diabaikan dan diberi toleransi ARA hingga 35%.
- **Bukti Test Nyata**:
  - Perintah: `node test/idx-tick-normalization-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] Bug 1a: Regular board ARB for price 1000 must be symmetrical -25%, got -15%`, `Bug 1b: FCA stock ARA must be 10%, got 25%`
- **Usulan Perbaikan**: Terapkan batas simetris resmi BEI (harga <= 200: -35%, 200-5000: -25%, > 5000: -20%) dan integrasikan guard `isAkselerasiOrFca(board, isFca, ticker)` untuk menerapkan batasan 10% pada saham FCA.

---

### [BUG-ITN-02] `validateTradingPlanSanity` Menganggap `tp2` Wajib dan Membatalkan Rencana Trading Single Target yang Valid
- **Lokasi**: `lib/idx-tick-normalization.js:194, 201`
- **Kode Bermasalah**:
  ```javascript
  var levels = [entryLow, entryHigh, sl, tp1, tp2];
  ...
  if (!entryLow || !entryHigh || !sl || !tp1 || !tp2) invalid.push('Ada level entry/SL/TP kosong.');
  ...
  for (var i = 0; i < levels.length; i++) {
    if (levels[i] == null || !isFinite(levels[i]) || !isValidIdxPriceLevel(levels[i], board, isFca, ticker)) {
      invalid.push('Level harga belum sesuai tick size IDX.');
      break;
    }
  }
  ```
- **Dampak ke User**: CRITICAL. Banyak skenario trading (seperti scalping intraday atau swing konservatif) hanya menetapkan 1 target keuntungan (`tp1`) tanpa `tp2`. Pengecekan `!tp2` dan loop `levels` yang menyertakan `tp2` menyebabkan seluruh rencana trading single-target dinyatakan `trading_plan_valid: false`, `tick_normalized: false`, dan grade kualitas otomatis anjlok ke 'C', memblokir rekomendasi yang sah.
- **Bukti Test Nyata**:
  - Perintah: `node test/idx-tick-normalization-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: Plan with valid single TP target must be valid, got invalid (Ada level entry/SL/TP kosong. Level harga belum sesuai tick size IDX.)`
- **Usulan Perbaikan**: Jadikan `tp2` opsional: verifikasi `tp2` hanya jika ada nilainya (`if (tp2 != null)`).

---

### [BUG-ITN-03] `validateTradingPlanSanity` Meloloskan Stop Loss di Dalam/di Atas Area Beli Bawah (`sl >= entry_low`)
- **Lokasi**: `lib/idx-tick-normalization.js:185, 195`
- **Kode Bermasalah**:
  ```javascript
  var entry = entryHigh || entryLow;
  ...
  if (entry != null && sl != null && !(sl < entry)) invalid.push('SL harus di bawah Entry.');
  ```
- **Dampak ke User**: HIGH. Pada area entry rentang (misal entry_low: 1.000 s/d entry_high: 1.050), `entry` bernilai 1.050. Jika caller menetapkan SL di 1.020 (di atas batas bawah entry 1.000), kondisi `sl < entry` (1.020 < 1.050) bernilai `true`, sehingga plan lolos validasi. Pengguna disajikan trading plan cacat di mana posisi beli di 1.000 langsung ter-cutloss seketika saat pembelian terjadi.
- **Bukti Test Nyata**:
  - Perintah: `node test/idx-tick-normalization-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 4: SL inside entry area (sl >= entry_low) must fail validation` (true === false)
- **Usulan Perbaikan**: Bandingkan SL terhadap `entryLow`: `if (entryLow != null && sl != null && !(sl < entryLow)) invalid.push('SL harus di bawah Entry Low.');`.

---

### [BUG-ITN-04] `deriveIdxAutoRejectLevels` & `deriveCandlePotentialRange` Tidak Meneruskan Parameter Board/FCA ke `roundToIdxTick`
- **Lokasi**: `lib/idx-tick-normalization.js:698-699, 766-767`
- **Kode Bermasalah**:
  ```javascript
  var ara = roundToIdxTick(ref * band.ara_multiplier, 'floor');
  var arb = roundToIdxTick(ref * band.arb_multiplier, 'ceil');
  ...
  potLow = roundToIdxTick(potLow, 'floor');
  potHigh = roundToIdxTick(potHigh, 'ceil');
  ```
- **Dampak ke User**: HIGH. `roundToIdxTick` memerlukan argumen `(price, mode, board, isFca, ticker)`. Pemanggilan di fungsi ARA/ARB dan candle potential hanya memberikan 2 argumen pertama. Untuk saham Papan Akselerasi dan FCA (di mana fraksi harga mutlak Rp 1 di semua rentang harga), harga dibulatkan menggunakan fraksi reguler (Rp 5, Rp 10, Rp 25), menghasilkan level ARA/ARB dan potensi candle yang terdistorsi hingga puluhan rupiah dari harga riil bursa.
- **Bukti Test Nyata**:
  - Perintah: `node test/idx-tick-normalization-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 2: FCA stock ARA price must round with tick size 1 (1354), got 1350`
- **Usulan Perbaikan**: Teruskan context board: `roundToIdxTick(..., mode, input.board, input.is_fca, input.ticker)`.

---

### [BUG-ITN-05] `isValidIdxPriceLevel` Mengesahkan Harga di Bawah Rp 50 untuk Papan Reguler (Utama/Pengembangan)
- **Lokasi**: `lib/idx-tick-normalization.js:58-64`
- **Kode Bermasalah**:
  ```javascript
  function isValidIdxPriceLevel(price, board, isFca, ticker) {
    price = toNum(price, null);
    if (price == null || !isFinite(price) || price <= 0) return false;
    var tick = getIdxTickSize(price, board, isFca, ticker);
    return !!tick && Math.abs(price / tick - Math.round(price / tick)) < 1e-9;
  }
  ```
- **Dampak ke User**: MEDIUM. Di BEI, saham di Papan Utama dan Papan Pengembangan memiliki batas harga terendah mutlak Rp 50 (gocap) dan tidak dapat diperdagangkan di bawah Rp 50 (hanya Akselerasi dan FCA yang diizinkan hingga Rp 1). Fungsi ini mengembalikan `true` untuk harga berapa pun di atas 0 (misal Rp 25 untuk saham BBCA) karena `25 < 200` menghasilkan tick 1. Hal ini meloloskan level SL/TP di area harga gocap yang ilegal di bursa reguler.
- **Bukti Test Nyata**:
  - Perintah: `node test/idx-tick-normalization-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 5: Sub-50 price (25) must be invalid on regular board (UTAMA)` (true === false)
- **Usulan Perbaikan**: Tambahkan validasi batas minimum harga: jika bukan Akselerasi atau FCA, tolak harga `price < 50`.

---

### [BUG-ITN-06] `calculateRiskLabel` Pengecekan Board Case-Sensitive Mengabaikan Penalti Risiko Akselerasi/FCA
- **Lokasi**: `lib/idx-tick-normalization.js:551-552`
- **Kode Bermasalah**:
  ```javascript
  if (p.board === 'AKSELERASI') { score += 15; notes.push('Papan Akselerasi'); }
  else if (p.board === 'PEMANTAUAN_KHUSUS' || p.is_fca) { score += 30; notes.push('FCA/Pemantauan Khusus'); }
  ```
- **Dampak ke User**: LOW. Pemeriksaan nilai board menggunakan perbandingan huruf besar strict (`=== 'AKSELERASI'`). Jika caller mengirim format mixed-case (seperti `'Akselerasi'` atau `'Pemantauan_Khusus'`), skor penalti risiko (+15 atau +30) tidak diterapkan. Akibatnya, saham berisiko tinggi di papan akselerasi dapat salah diklasifikasikan sebagai `Low Risk` atau `Medium Risk`.
- **Bukti Test Nyata**:
  - Perintah: `node test/idx-tick-normalization-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 6: calculateRiskLabel must handle board case-insensitively (14 !== 29)`
- **Usulan Perbaikan**: Normalisasi string board ke huruf besar: `String(p.board || '').toUpperCase().trim()`.

---

### [BUG-VDF-01] `SYNC_HTTP_SCRIPT` Membaca `process.argv[1]` yang di Node.js Hardcoded Bernilai `'[eval]'`
- **Lokasi**: `lib/vps-data-fetcher.js:39-40, 67`
- **Kode Bermasalah**:
  ```javascript
  const SYNC_HTTP_SCRIPT = [
    'const url = process.argv[1];',
    'const timeoutMs = Number(process.argv[2]) || 5000;',
    ...
  ```
- **Dampak ke User**: CRITICAL. Ketika Node dieksekusi dengan `-e` (`execFileSync(process.execPath, ['-e', script, url, timeout])`), runtime Node.js menetapkan `process.argv[0] = node` dan `process.argv[1] = '[eval]'`, sedangkan argumen tambahan berada di `process.argv[2]` (URL) dan `process.argv[3]` (timeout). Script mengeksekusi `fetch('[eval]')` yang selalu melempar `TypeError: Invalid URL: [eval]`. Akibatnya, semua pemanggilan bridge sinkronus (`fetchBrokerSummaryFromVpsSync`, `fetchAvailableDatesFromVpsSync`, `fetchLivePriceFromVpsSync`, `fetchIntelIndexFromVpsSync`, `fetchAvailableDatesFromVpsBridgeSync`) gagal total pada setiap pemanggilan (`ok: false, error: 'spawn_or_timeout'`).
- **Bukti Test Nyata**:
  - Perintah: `node test/vps-data-fetcher-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 1: fetchAvailableDatesFromVpsSync must successfully fetch dates from bridge (failed because process.argv[1] is "[eval]", got [])`
- **Usulan Perbaikan**: Ganti pembacaan argumen di `SYNC_HTTP_SCRIPT`: `const url = process.argv[2]; const timeoutMs = Number(process.argv[3]) || 5000;`.

---

### [BUG-VDF-02] Silent Fallback ke `'latest'` Mengontaminasi Data Tanggal Historis
- **Lokasi**: `lib/vps-data-fetcher.js:189-194, 201-204, 253-258, 270-273`
- **Kode Bermasalah**:
  ```javascript
  const candidateDates = [safeDate];
  if (safeDate !== 'latest') {
    candidateDates.push('latest');
  }
  ...
  if (parsed && (parsed.brokers || parsed.stock_code)) {
    memoryBrokerSummaryCache.set(cacheKey, parsed);
    memoryBrokerSummaryCache.set(`${safeTicker}_${targetDate}`, parsed);
    return parsed;
  }
  ```
- **Dampak ke User**: CRITICAL. Ketika pemanggil meminta data historis tanggal tertentu (`date = '2025-01-01'`) untuk keperluan kalkulasi akumulasi atau backtesting, jika tanggal tersebut tidak ditemukan di VPS, fungsi mengambil data `'latest'` (hari ini) dan menyimpannya di cache dengan key `'BBCA_2025-01-01'`. Downstream service membaca data hari ini seolah-olah itu adalah data transaksi bandar masa lalu.
- **Bukti Test Nyata**:
  - Perintah: `node test/vps-data-fetcher-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 2: Query for missing historical date 2025-01-01 must return null, not latest date data (2026-03-30)`
- **Usulan Perbaikan**: Hapus penambahan `'latest'` ke `candidateDates` jika `safeDate !== 'latest'`. Tanggal yang tidak ada harus mengembalikan `null`.

---

### [BUG-VDF-03] `ensureBrokerSummary` Mengembalikan `true` Meski File Tanggal yang Diminta Tidak Ada di Disk
- **Lokasi**: `lib/vps-data-fetcher.js:421-423`
- **Kode Bermasalah**:
  ```javascript
  const targetFile = path.join(localTickerDir, `${safeDate}.json`);
  const latestFile = path.join(localTickerDir, 'latest.json');

  if (fs.existsSync(targetFile) || fs.existsSync(latestFile)) {
    return true;
  }
  ```
- **Dampak ke User**: HIGH. Jika caller meminta `date = '2025-01-01'`, dan file `2025-01-01.json` belum ada di disk lokal, tetapi `latest.json` sudah ada, fungsi mengembalikan `true` tanpa mengunduh `2025-01-01.json` dari VPS. Pemanggil yang kemudian membaca file tanggal tersebut dari disk lokal akan menerima `null` / error file tidak ditemukan.
- **Bukti Test Nyata**:
  - Perintah: `node test/vps-data-fetcher-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: ensureBrokerSummary must not return true when target date file is missing from disk`
- **Usulan Perbaikan**: Periksa `fs.existsSync(targetFile)` jika `safeDate !== 'latest'`. Hanya cek `latestFile` jika `safeDate === 'latest'`.

---

### [BUG-VDF-04] `cleanTicker` Merusak Simbol Saham Berakhiran `.JK` Menjadi 6 Huruf (`BBCAJK`)
- **Lokasi**: `lib/vps-data-fetcher.js:143, 178, 187, 497, 548`
- **Kode Bermasalah**:
  ```javascript
  const safeTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  ```
- **Dampak ke User**: HIGH. Simbol bursa dengan suffix `.JK` (seperti `BBCA.JK`) diubah menjadi `BBCAJK` karena titik dihilangkan tanpa memotong `.JK`. Akibatnya, URL query bridge menjadi `ticker=BBCAJK` dan remote directory SSH menjadi `broker-summary/BBCAJK` yang tidak ada di server, menghasilkan kegagalan unduh data.
- **Bukti Test Nyata**:
  - Perintah: `node test/vps-data-fetcher-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 4: Ticker BBCA.JK must be cleaned to BBCA, got "/api/available-dates?ticker=BBCAJK"`
- **Usulan Perbaikan**: Hapus `.replace(/\.JK$/i, '')` sebelum menerapkan `replace(/[^A-Z0-9]/g, '')`.

---

### [BUG-VDF-05] `memoryBrokerSummaryCache` & `memoryDatesCache` Tanpa TTL Menyebabkan Stale Data Permanen
- **Lokasi**: `lib/vps-data-fetcher.js:23-24, 498-501, 532`
- **Kode Bermasalah**:
  ```javascript
  const memoryBrokerSummaryCache = new Map();
  const memoryDatesCache = new Map();
  ...
  if (memoryBrokerSummaryCache.has(cacheKey)) {
    return memoryBrokerSummaryCache.get(cacheKey);
  }
  ```
- **Dampak ke User**: MEDIUM. Objek `Map` memori global tidak memiliki mekanisme kedaluwarsa (TTL), timestamp, atau size limit. Sekali live price untuk suatu ticker diambil, fungsi `fetchLivePriceFromVpsSync` akan selalu mengembalikan harga pertama tersebut sepanjang aplikasi berjalan, tanpa pernah memperbarui harga pasar selama jam perdagangan berlangsung.
- **Bukti Test Nyata**:
  - Perintah: `node test/vps-data-fetcher-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 5: memoryBrokerSummaryCache entries must have expiration/timestamp to avoid infinite stale cache`
- **Usulan Perbaikan**: Tambahkan timestamp pada cache entry dan batasi usia cache (misal TTL 5-15 menit untuk live price, reset di batas hari bursa).

---

### [BUG-VDF-06] `fetchLivePriceFromVpsSync` Mengabaikan Field Tanggal Standar Selain `broker_start_date` / `date`
- **Lokasi**: `lib/vps-data-fetcher.js:528`
- **Kode Bermasalah**:
  ```javascript
  as_of_date: String(payload.broker_start_date || payload.date || '').slice(0, 10) || null,
  ```
- **Dampak ke User**: MEDIUM. Jika payload broker summary dari bridge/Arjum membawa tanggal pada field standar lain seperti `trade_date`, `start_date`, atau `date_from`, `as_of_date` menghasilkan `null`. Resolver harga downstream (`latest-price-resolver`) menolak data ini sebagai `stale` karena tidak ada tanggal valid.
- **Bukti Test Nyata**:
  - Perintah: `node test/vps-data-fetcher-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 6: as_of_date resolution must support trade_date property, got null`
- **Usulan Perbaikan**: Dukung variasi field tanggal: `payload.broker_start_date || payload.trade_date || payload.date || payload.start_date`.

---

### [BUG-MHG-01] Pemotongan Dini Sesi 2 Pukul 15:45 WIB Mengabaikan 5 Menit Perdagangan Aktif Bursa
- **Lokasi**: `lib/market-hours-guard.js:83, 91`
- **Kode Bermasalah**:
  ```javascript
  // Sesi 2: 13:30 s/d 15:45 WIB (810 to 945 total minutes inclusive)
  if (wib.totalMinutes >= 810 && wib.totalMinutes <= 945) {
    return 'SESSION_2';
  }
  ```
- **Dampak ke User**: HIGH. Perdagangan sesi continuous di BEI berlangsung resmi hingga pukul 15:49:59 WIB (949 menit). Dengan batas atas `wib.totalMinutes <= 945` (15:45 WIB), pada rentang 15:46 s/d 15:49 WIB ketika transaksi pasar reguler sedang padat menjelang penutupan, `getMarketSession` mengembalikan `'CLOSED'` dan `isMarketOpen` bernilai `false`. Seluruh screener, bot notifikasi, dan live quote guard mati 5 menit lebih cepat sebelum sesi continuous berakhir.
- **Bukti Test Nyata**:
  - Perintah: `node test/market-hours-guard-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 1: IDX continuous trading is active until 15:50 WIB, at 15:46 expected SESSION_2, got CLOSED`
- **Usulan Perbaikan**: Perpanjang batas sesi 2 hingga minimal 15:50 WIB (`wib.totalMinutes <= 950`), dan sediakan flag opsional untuk mengakomodasi sesi pre-closing / post-closing hingga 16:15 WIB.

---

### [BUG-MHG-02] Parsing Tanggal String Non-ISO Dipengaruhi Timezone Host OS Server
- **Lokasi**: `lib/market-hours-guard.js:31-35`
- **Kode Bermasalah**:
  ```javascript
  const d = dateInput == null ? new Date() : new Date(dateInput);
  ...
  const wibMs = d.getTime() + (7 * 60 * 60 * 1000);
  ```
- **Dampak ke User**: CRITICAL. Dokumentasi modul menyatakan: *"Deterministic calculation independent of host OS timezone (e.g. UTC on Oracle Cloud VPS)"*. Namun, passing tanggal string non-ISO seperti `'2026-03-30 09:30:00'` (format standar timestamp SQL) diparse oleh engine V8 menggunakan timezone lokal host OS. Pada server VPS Oracle Cloud (UTC), string tersebut diparse sebagai 09:30 UTC, lalu ditambahkan 7 jam menjadi 16:30 WIB (`CLOSED`). Sebaliknya, di laptop developer (WIB UTC+7), string yang sama diparse sebagai 09:30 WIB (`SESSION_1`). Perilaku sistem menjadi tidak deterministik dan berbeda antara lingkungan testing lokal dan VPS produksi.
- **Bukti Test Nyata**:
  - Perintah: `node test/market-hours-guard-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 2: getWibComponents must parse date deterministically as Jakarta time on UTC host, expected 09:30, got 16:30`
- **Usulan Perbaikan**: Jika `dateInput` berupa string tanggal tanpa zona waktu (`YYYY-MM-DD HH:mm:ss`), parse komponen tahun, bulan, hari, jam, menit secara eksplisit sebagai waktu Jakarta, bukan mengandalkan `new Date(dateInput)`.

---

### [BUG-MHG-03] Mengabaikan Kalender Hari Libur Bursa Nasional (Melanggar Kontrak "Mutlak CLOSED")
- **Lokasi**: `lib/market-hours-guard.js:19-20, 68-70`
- **Kode Bermasalah**:
  ```javascript
  // Weekend: Saturday (6) or Sunday (0)
  if (wib.dayOfWeek === 0 || wib.dayOfWeek === 6) {
    return 'CLOSED';
  }
  ```
- **Dampak ke User**: HIGH. Header file menyatakan: *"C. Sabtu, Minggu, & Libur: Mutlak 'CLOSED' (false)"*. Namun implementasi hanya memeriksa `wib.dayOfWeek === 0 || wib.dayOfWeek === 6` (Sabtu/Minggu). Pada hari libur resmi BEI di hari kerja (Senin-Jumat seperti Tahun Baru, Idul Fitri, Waisak, Natal), `isMarketOpen()` mengembalikan `true` dan `SESSION_1`/`SESSION_2`. Job cron, webhook alert, dan pemanggil screener tetap aktif dan menembak kuota API/database padahal bursa tutup total.
- **Bukti Test Nyata**:
  - Perintah: `node test/market-hours-guard-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: Official exchange holiday (New Year 2026-01-01) must return CLOSED per documented contract, got SESSION_1`
- **Usulan Perbaikan**: Integrasikan `isTradingDay` atau injeksikan `holidaySet` dari `lib/idx-trading-calendar.js` agar hari libur nasional BEI menghasilkan status `'CLOSED'` dan `isMarketOpen: false`.

---

### [BUG-MHG-04] Buffer 2 Menit Sesi 1 (11:58 WIB & 11:28 WIB) Memotong Jam Perdagangan Resmi Bursa
- **Lokasi**: `lib/market-hours-guard.js:76, 88`
- **Kode Bermasalah**:
  ```javascript
  // Sesi 1: 09:00 s/d 11:58 WIB (540 to 718 total minutes inclusive)
  if (wib.totalMinutes >= 540 && wib.totalMinutes <= 718) {
    return 'SESSION_1';
  }
  ```
- **Dampak ke User**: MEDIUM. Sesi 1 BEI resmi ditutup pada pukul 12:00:00 WIB (Senin-Kamis) dan 11:30:00 WIB (Jumat). Pada pukul 11:59 WIB, antrean order dan transaksi bursa masih berlangsung aktif. Guard menetapkan `totalMinutes <= 718` (11:58 WIB), menyebabkan request pada 2 menit krusial menjelang jeda siang ditolak sebagai `CLOSED`.
- **Bukti Test Nyata**:
  - Perintah: `node test/market-hours-guard-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 4: IDX Sesi 1 trades until 12:00 WIB, at 11:59 WIB expected SESSION_1, got CLOSED`
- **Usulan Perbaikan**: Ubah batas Sesi 1 menjadi `wib.totalMinutes < 720` (12:00) untuk Senin-Kamis dan `wib.totalMinutes < 690` (11:30) untuk Jumat.

---

### [BUG-ITC-01] Regex Substring `toDateKey` Memotong Tanggal UTC dan Mem-bypass Konversi Waktu Jakarta
- **Lokasi**: `lib/idx-trading-calendar.js:46-48`
- **Kode Bermasalah**:
  ```javascript
  var raw = String(input).trim();
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (m) return m[1];
  var parsed = new Date(raw);
  ```
- **Dampak ke User**: CRITICAL. Ketika pemanggil mengirim string timestamp ISO dengan offset UTC (misal `'2026-03-29T23:30:00.000Z'`), di Jakarta (WIB UTC+7) waktu tersebut adalah Senin pagi pukul 06:30 WIB (`2026-03-30`, hari bursa aktif). Namun regex langsung memotong 10 karakter pertama string (`'2026-03-29'`) tanpa konversi zona waktu Jakarta. Akibatnya, request pada pagi hari bursa (00:00-06:59 WIB) disangka bertanggal hari Minggu (`2026-03-29`) dan seluruh pengecekan kalender bergeser 1 hari kalender ke belakang. Sebaliknya, jika input berupa objek `Date`, fungsi mengembalikan `'2026-03-30'`, menghasilkan inkonsistensi data parah antara format string dan objek.
- **Bukti Test Nyata**:
  - Perintah: `node test/idx-trading-calendar-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 1: toDateKey for '2026-03-29T23:30:00.000Z' must resolve to Jakarta date '2026-03-30', got '2026-03-29'`
- **Usulan Perbaikan**: Periksa apakah string mengandung komponen waktu atau timezone (`T`, `:`, `Z`). Hanya potong substring langsung jika format string murni `^\d{4}-\d{2}-\d{2}$`. Jika ada komponen waktu, parse ke Date dan gunakan `jakartaDateKeyFromInstant`.

---

### [BUG-ITC-02] `loadHolidayCalendar` & `marketDayGuard` Membuang Seed Data Hari Libur Saat Supabase Gagal / Kosong
- **Lokasi**: `lib/idx-trading-calendar.js:25-27, 168-171, 180-182`
- **Kode Bermasalah**:
  ```javascript
  if (!supabase) {
    return { holidaySet: new Set(), rows: [], source: 'weekend_only_fallback', reason: 'no_supabase_client' };
  }
  ...
  if (result.error) {
    return { holidaySet: new Set(), rows: [], source: 'weekend_only_fallback', reason: result.error.message };
  }
  ```
- **Dampak ke User**: HIGH. Modul ini secara eksplisit mengimpor `seedData` (`var seedData = require('./idx-holidays-2026-seed-data');`), namun saat koneksi Supabase terputus, null, atau tabel `idx_trading_calendar` belum diisi, fungsi mengembalikan `holidaySet: new Set()` kosong. Akibatnya, `marketDayGuard(null)` menyatakan hari libur bursa (seperti Tahun Baru 2026-01-01 atau Idul Fitri) sebagai hari trading aktif (`shouldRun: true`). Data seed hari libur 2026 yang sudah dibundel menjadi tidak terpakai (dead code).
- **Bukti Test Nyata**:
  - Perintah: `node test/idx-trading-calendar-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 2: loadHolidayCalendar must fallback to bundled seed holidays when Supabase is unavailable, but holidaySet is empty`
- **Usulan Perbaikan**: Gunakan `getSeedHolidaySet()` sebagai fallback Set ketika Supabase bernilai null atau tabel kosong.

---

### [BUG-ITC-03] `getLastTradingDays` dengan `count=0` Mengembalikan 1 Hari Alih-alih Array Kosong
- **Lokasi**: `lib/idx-trading-calendar.js:118-121`
- **Kode Bermasalah**:
  ```javascript
  var results = [];
  if (includeGiven && isTradingDay(dateKey, holidaySet)) {
    results.push(dateKey);
  }
  var cursor = dateKey;
  while (results.length < count && guard < maxGuard) {
  ```
- **Dampak ke User**: MEDIUM. Jika caller meminta 0 hari bursa (`count = 0`), pengecekan `includeGiven` tetap memasukkan `dateKey` ke `results` sebelum loop while dievaluasi. Fungsi mengembalikan `[dateKey]` dengan `length = 1` padahal pemanggil secara eksplisit meminta 0 data. Hal ini memicu offset indeks di kalkulator fitur teknikal.
- **Bukti Test Nyata**:
  - Perintah: `node test/idx-trading-calendar-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: getLastTradingDays with count=0 must return empty array, got length 1`
- **Usulan Perbaikan**: Tambahkan pengecekan awal `if (count <= 0) return [];`.

---

### [BUG-ITC-04] `isTradingDay` Tanpa Argumen `holidaySet` Menganggap Hari Libur Kerja Sebagai Hari Bursa
- **Lokasi**: `lib/idx-trading-calendar.js:76-80`
- **Kode Bermasalah**:
  ```javascript
  function toHolidaySet(holidaySet) {
    if (holidaySet instanceof Set) return holidaySet;
    return new Set(Array.isArray(holidaySet) ? holidaySet : []);
  }
  ```
- **Dampak ke User**: MEDIUM. Jika fungsi `isTradingDay(date)` dipanggil tanpa argumen kedua `holidaySet`, fungsi fallback ke `new Set([])` kosong alih-alih `getSeedHolidaySet()`. Akibatnya, panggilan langsung di seluruh codebase menganggap hari libur nasional di hari kerja (Senin-Jumat) sebagai hari bursa biasa.
- **Bukti Test Nyata**:
  - Perintah: `node test/idx-trading-calendar-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 4: isTradingDay('2026-01-01') must be false by default using bundled seed data, got true`
- **Usulan Perbaikan**: Fallback ke `getSeedHolidaySet()` jika `holidaySet == null`.

---

### [BUG-CTP-01] Candle Bertipe Numeric Unix Timestamp Menyebabkan Seluruh Candle Dihapus di `retainCompletedCandles`
- **Lokasi**: `lib/chart-t1-policy.js:56-59`
- **Kode Bermasalah**:
  ```javascript
  var retained = (candles || []).filter(function(candle) {
    return candle && /^\d{4}-\d{2}-\d{2}$/.test(String(candle.time || '')) && jakartaToday && candle.time < jakartaToday;
  });
  ```
- **Dampak ke User**: CRITICAL. Sesuai standar TradingView dan Lightweight Charts (bahkan helper `normalizeUnixTimestampSeconds` disediakan di baris 18 file yang sama), properti `candle.time` sering berupa angka unix timestamp dalam detik (misal `1774569600`). Regex `/^\d{4}-\d{2}-\d{2}$/` gagal mencocokkan string angka `'1774569600'`. Akibatnya, seluruh candle di dalam array dibuang tanpa sisa (`candles: []`), dan chart viewer menampilkan status data hilang (`t1_status: 'missing'`).
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-t1-policy-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 1: retainCompletedCandles must accept numeric unix timestamp candle time, but dropped all candles (got 0)`
- **Usulan Perbaikan**: Konversi `candle.time` ke format `YYYY-MM-DD` menggunakan `formatJakartaDate` jika bertipe number sebelum melakukan filtering.

---

### [BUG-CTP-02] Array Candle Urutan Menurun (Descending) Memilih Candle Terlama Sebagai `actual_data_date` dan Memicu Status `stale` Palsu
- **Lokasi**: `lib/chart-t1-policy.js:60`
- **Kode Bermasalah**:
  ```javascript
  var actual = retained.length ? retained[retained.length - 1].time : null;
  return { candles: retained, metadata: buildMetadata(actual, now) };
  ```
- **Dampak ke User**: HIGH. Banyak endpoint feed bursa mengembalikan candle dengan urutan menurun (candle terbaru di indeks 0, candle terlama di indeks terakhir). Pengambilan `retained[retained.length - 1]` mengasumsikan array selalu menaik (ascending). Pada array menurun, elemen terakhir adalah candle terlama (misal tahun 2020). Akibatnya, data dianggap stale (`actual_data_predates_previous_weekday_candidate`) dan chart diblokir padahal data penutupan kemarin tersedia di awal array.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-t1-policy-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 2a: actual_data_date must be latest candle ('2026-03-27'), got '2020-01-02'`
- **Usulan Perbaikan**: Ambil tanggal maksimum dari seluruh elemen retained (`retained.reduce(...)`) atau urutkan candle sebelum mengambil elemen penutup.

---

### [BUG-CTP-03] `buildMetadata` Menandai Candle Hari Ini yang Belum Selesai Sebagai `calendar_unverified`
- **Lokasi**: `lib/chart-t1-policy.js:35-40`
- **Kode Bermasalah**:
  ```javascript
  if (actualDataDate && expected) {
    if (actualDataDate < expected) {
      status = 'stale';
      reason = 'actual_data_predates_previous_weekday_candidate';
    } else {
      status = 'calendar_unverified';
      reason = 'idx_holiday_calendar_unavailable';
    }
  }
  ```
- **Dampak ke User**: MEDIUM. Sesuai nama kebijakannya `POLICY = 'completed_daily_candles_before_jakarta_today'`, candle daily untuk hari ini (`actualDataDate >= jakartaToday`) adalah candle intraday yang belum close. Namun blok `else` menandai status sebagai `calendar_unverified` seolah-olah candle tersebut adalah candle T-1 yang sah tapi kalendernya tidak terverifikasi. Komponen frontend tidak dapat membedakan antara data hari kemarin yang sah dan data hari ini yang masih berjalan.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-t1-policy-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: Candle dated today must be flagged as incomplete/invalid, got 'calendar_unverified'`
- **Usulan Perbaikan**: Tambahkan percabangan `if (actualDataDate >= jakartaToday)` untuk menandai status `incomplete_today_candle` atau `future_candle`.

---

### [BUG-CTP-04] `formatJakartaDate` Tidak Mendukung Unix Timestamp Detik (Menghasilkan Tahun 1970)
- **Lokasi**: `lib/chart-t1-policy.js:6-8`
- **Kode Bermasalah**:
  ```javascript
  function formatJakartaDate(value) {
    var date = value instanceof Date ? value : new Date(value);
  ```
- **Dampak ke User**: LOW. Ketika `value` berupa unix timestamp dalam detik (10 digit, misal `1774569600`), konstruktor `new Date(value)` menganggapnya dalam milidetik (Januari 1970). Fungsi mengembalikan `'1970-01-21'` alih-alih tanggal tahun 2026.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-t1-policy-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 4: formatJakartaDate must support unix timestamp seconds, got '1970-01-21'`
- **Usulan Perbaikan**: Jika `typeof value === 'number'` dan nilainya < 1e11, kalikan dengan 1000 sebelum diteruskan ke `new Date()`.

---

### [BUG-SDHS-01] Global Order by `trade_date DESC` Tanpa Per-Ticker Partitioning Mengakibatkan Hilangnya Data Ticker di `getLatestSessionsForTickers`
- **Lokasi**: `lib/stock-daily-history-store.js:154-159`
- **Kode Bermasalah**:
  ```javascript
  var fetchLimit = Math.max(count * tickerBatch.length, tickerBatch.length);
  var result = await supabase
    .from('stock_daily_history')
    .select(...)
    .in('ticker', tickerBatch)
    .order('trade_date', { ascending: false })
    .limit(fetchLimit);
  ```
- **Dampak ke User**: CRITICAL. PostgREST tidak memiliki klausa `PARTITION BY (ticker)`. Ketika `tickerBatch` berisi banyak ticker (hingga 60 saham), sorting `.order('trade_date', { ascending: false })` dilakukan secara global di seluruh batch. Jika satu atau lebih saham memiliki riwayat tanggal yang lebih lama (misal saham yang baru suspended atau jarang diperdagangkan), baris data saham tersebut tereliminasi oleh saham-saham aktif yang mendominasi `fetchLimit`. Akibatnya, `map.get(ticker)` mengembalikan 0 baris data atau data terpotong, menyebabkan indikator teknikal (RSI14, 52W high/low, rata-rata volume) menampilkan N/A pada saham tersebut.
- **Bukti Test Nyata**:
  - Perintah: `node test/stock-daily-history-store-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 1: getLatestSessionsForTickers must guarantee rows for each requested ticker; 'STALE' was starved by global date sort (got undefined)`
- **Usulan Perbaikan**: Lakukan query per ticker atau pastikan fetch limit per batch cukup besar, atau gunakan query per-ticker windowed function via RPC.

---

### [BUG-SDHS-02] Duplicate `(ticker, trade_date)` dalam Satu Batch Menggagalkan Seluruh Upsert di Postgres
- **Lokasi**: `lib/stock-daily-history-store.js:37-41`
- **Kode Bermasalah**:
  ```javascript
  for (var batch of chunk(normalized, UPSERT_BATCH_SIZE)) {
    var result = await supabase
      .from('stock_daily_history')
      .upsert(batch, { onConflict: 'ticker,trade_date' });
    if (result.error) throw new Error('Upsert stock_daily_history gagal: ' + result.error.message);
  ```
- **Dampak ke User**: HIGH. Pada PostgreSQL / Supabase, mengirim lebih dari 1 baris dengan pasangan conflict key yang sama (`ticker, trade_date`) di dalam batch yang sama akan melempar fatal error: `ON CONFLICT DO UPDATE command cannot affect row a second time`. `upsertDailyHistory` tidak melakukan deduplikasi in-memory terlebih dahulu. Satu pasang duplikasi data pada input akan menggagalkan seluruh 200 baris dalam batch tersebut.
- **Bukti Test Nyata**:
  - Perintah: `node test/stock-daily-history-store-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 2: upsertDailyHistory must deduplicate (ticker, trade_date) before sending to Supabase, but duplicate crashed batch with: ON CONFLICT DO UPDATE command cannot affect row a second time`
- **Usulan Perbaikan**: Deduplikasi array `rows` berdasarkan key `${ticker}_${trade_date}` sebelum di-chunk dan dikirim ke Supabase.

---

### [BUG-SDHS-03] `enforceRetention` Mengabaikan Normalisasi Huruf Besar Ticker Sehingga Ticker Lowercase Tidak Pernah Dihapus
- **Lokasi**: `lib/stock-daily-history-store.js:68-74`
- **Kode Bermasalah**:
  ```javascript
  for (var tickerBatch of chunk(tickers, tickerBatchSize)) {
    var fetchLimit = Math.max(perTickerFetchCount * tickerBatch.length, tickerBatch.length);
    var lookup = await supabase
      .from('stock_daily_history')
      .select('id,ticker,trade_date')
      .in('ticker', tickerBatch)
  ```
- **Dampak ke User**: MEDIUM. Parameter `tickers` tidak dinormalisasi dengan `.toUpperCase()`, berbeda dengan fungsi lain (`getLatestSessionsForTickers`, `getDailyFeaturesForTickers`). Jika pemanggil mengirim array seperti `['bbca']`, query `.in('ticker', ['bbca'])` tidak cocok dengan nilai `'BBCA'` di database. Baris data tidak ditemukan dan retensi data historis gagal dieksekusi, menyebabkan tabel membengkak.
- **Bukti Test Nyata**:
  - Perintah: `node test/stock-daily-history-store-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: enforceRetention must uppercase tickers for SQL matching, got [bbca, bbri]`
- **Usulan Perbaikan**: Normalisasi dan deduplikasi `tickers`: `var uniqueTickers = Array.from(new Set((tickers || []).map(t => String(t).toUpperCase())));`.

---

### [BUG-SDHS-04] `enforceRetention` Tidak Memvalidasi Klien Supabase (`!supabase`)
- **Lokasi**: `lib/stock-daily-history-store.js:60`
- **Kode Bermasalah**:
  ```javascript
  async function enforceRetention(supabase, tickers, retentionSessions) {
    retentionSessions = retentionSessions || HISTORY_RETENTION_TRADING_SESSIONS;
  ```
- **Dampak ke User**: LOW. Fungsi `enforceRetention` tidak memiliki guard `if (!supabase) throw new Error('supabase client is required');` seperti yang dimiliki oleh fungsi-fungsi lain di modul ini. Ketika `supabase` tidak ada, fungsi melempar `TypeError: Cannot read properties of undefined (reading 'from')` alih-alih error yang deskriptif.
- **Bukti Test Nyata**:
  - Perintah: `node test/stock-daily-history-store-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 4: enforceRetention must validate supabase client, got TypeError: "Cannot read properties of null (reading 'from')"`
- **Usulan Perbaikan**: Tambahkan `if (!supabase) throw new Error('supabase client is required');` di awal fungsi `enforceRetention`.

---

### [BUG-DHC-01] `safeTicker` Merusak Simbol Saham Berakhiran `.JK` Menjadi 6 Huruf (`BBCAJK`)
- **Lokasi**: `lib/daily-history-collector.js:46-48`
- **Kode Bermasalah**:
  ```javascript
  function safeTicker(ticker) {
    return String(ticker || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  }
  ```
- **Dampak ke User**: CRITICAL. Ketika ticker dengan akhiran `.JK` (seperti `BBCA.JK` yang umum diterima dari feed atau konfigurasi Yahoo) dimasukkan, regex pembersihan menghapus titik `.` tanpa memotong `.JK`. Ticker diubah menjadi `BBCAJK`. Query ke Yahoo Finance menjadi `BBCAJK.JK` yang menghasilkan HTTP 404, dan baris historis yang disimpan ke database menggunakan kode ticker `BBCAJK`.
- **Bukti Test Nyata**:
  - Perintah: `node test/daily-history-collector-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 1: candlesToHistoryRows must strip .JK suffix, got corrupt ticker 'BBCAJK'`
- **Usulan Perbaikan**: Hapus suffix `.replace(/\.JK$/i, '')` sebelum menjalankan regex `replace(/[^A-Z0-9_-]/g, '')`.

---

### [BUG-DHC-02] `candlesToHistoryRows` Crash Saat `options.now` Diberikan Sebagai String Timestamp
- **Lokasi**: `lib/daily-history-collector.js:246, 38-44`
- **Kode Bermasalah**:
  ```javascript
  var sourceTimestamp = options.sourceTimestamp || now.toISOString();
  ...
  // di isPartialSession:
  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);
  ```
- **Dampak ke User**: HIGH. Jika caller mengirim `options.now` sebagai string ISO (`'2026-03-30T10:00:00.000Z'`), pemanggilan `now.toISOString()` dan `now.getTime()` langsung melempar `TypeError: now.toISOString is not a function`. Seluruh proses batch ingest harian yang dipicu oleh cron/script terhenti karena error yang tidak tertangani.
- **Bukti Test Nyata**:
  - Perintah: `node test/daily-history-collector-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 2: candlesToHistoryRows crashed on string options.now: now.toISOString is not a function`
- **Usulan Perbaikan**: Pastikan `now` dikonversi ke objek `Date`: `var nowDate = now instanceof Date ? now : new Date(now || Date.now());`.

---

### [BUG-DHC-03] `reconcileMissingCloseFromMeta` Menolak Data Jika Volume Meta dan Row Berbeda 1 Lembar Saham
- **Lokasi**: `lib/daily-history-collector.js:88`
- **Kode Bermasalah**:
  ```javascript
  if (volume !== metaVolume) return null;
  ```
- **Dampak ke User**: MEDIUM. Pada penutupan sesi bursa, volume kumulatif di `meta.regularMarketVolume` dan array `indicators.quote.volume` pada payload Yahoo Finance sering memiliki perbedaan minor beberapa lembar saham akibat jeda sinkronisasi transaksi bursa. Syarat `volume !== metaVolume` mutlak menolak rekonsiliasi harga close, menyebabkan candle harian yang valid dibuang oleh collector.
- **Bukti Test Nyata**:
  - Perintah: `node test/daily-history-collector-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: reconcileMissingCloseFromMeta should accept close within [low, high] with negligible volume drift, got null`
- **Usulan Perbaikan**: Izinkan toleransi selisih volume minor (misal selisih <= 0.1% atau <= 100 lembar).

---

### [BUG-DHC-04] `computeWeek52FromCandles` Menerima Angka Nol atau Negatif Sebagai 52-Week Low
- **Lokasi**: `lib/daily-history-collector.js:218`
- **Kode Bermasalah**:
  ```javascript
  var l = finiteNumberOrNull(candle.low);
  if (l != null && (low == null || l < low)) { low = l; lowDate = candle.date; }
  ```
- **Dampak ke User**: LOW. Helper `finiteNumberOrNull` mengesahkan angka 0 dan angka negatif. Jika feed data Yahoo mengalami anomali harga low bernilai 0, nilai 52-week low saham tercatat Rp 0, merusak visualisasi jarak 52W low di tabel perbandingan teknikal.
- **Bukti Test Nyata**:
  - Perintah: `node test/daily-history-collector-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 4: computeWeek52FromCandles must reject 0 as 52-week low, got 0`
- **Usulan Perbaikan**: Tolak harga low non-positif: gunakan `l > 0`.

---

### [BUG-DOC-01] `safeTicker` Merusak Simbol Saham Berakhiran `.JK` Menjadi `'BBCAJK'` dan Menggagalkan Sinkronisasi Broker Summary
- **Lokasi**: `lib/daytrade-ohlcv-cache.js:38-40, 126, 237-244`
- **Kode Bermasalah**:
  ```javascript
  function safeTicker(ticker) {
    return String(ticker || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  }
  ...
  var dates = svc.listDiskDates('broker-summary', String(ticker || '').toUpperCase());
  ```
- **Dampak ke User**: CRITICAL. Ketika input berupa `BBCA.JK`, `safeTicker` menghasilkan `BBCAJK`. Cache disimpan di `BBCAJK.json`, fetch memanggil `BBCAJK.JK` (404), dan `latestBrokerSummaryDate('BBCA.JK')` mencari folder `data/arjum-data/broker-summary/BBCA.JK` yang tidak ada di disk (karena direktori di disk bernama `BBCA/`). Akibatnya, sinkronisasi broker summary (`syncWithBrokerSummary`) tidak pernah aktif untuk ticker berakhiran `.JK`.
- **Bukti Test Nyata**:
  - Perintah: `node test/daytrade-ohlcv-cache-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 1: fetchWithCache must clean 'BBCA.JK' to 'BBCA', got 'BBCAJK'`
- **Usulan Perbaikan**: Bersihkan suffix `.replace(/\.JK$/i, '')` sebelum menghapus karakter non-alphanumeric.

---

### [BUG-DOC-02] `normalizeCandle` Menolak Seluruh Candle Bertipe String Date (`time: 'YYYY-MM-DD'`)
- **Lokasi**: `lib/daytrade-ohlcv-cache.js:48, 54-55`
- **Kode Bermasalah**:
  ```javascript
  var time = Number(c.time);
  ...
  if (!Number.isFinite(time) || ...) return null;
  ```
- **Dampak ke User**: CRITICAL. Format candle pada beberapa modul internal (`api/candles.js`, `chart-engine`) memiliki `time: '2026-03-30'`. `Number('2026-03-30')` menghasilkan `NaN`. `normalizeCandles` membuang semua candle dan mengembalikan array kosong `[]`, sehingga cache dianggap kosong dan pemanggilan gagal total.
- **Bukti Test Nyata**:
  - Perintah: `node test/daytrade-ohlcv-cache-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 2: normalizeCandles must accept candles with string date time, but returned 0 candles (got ${normalized.length})`
- **Usulan Perbaikan**: Jika `c.time` berupa string tanggal `YYYY-MM-DD`, parse menjadi unix timestamp detik (`Math.floor(Date.parse(c.time) / 1000)`).

---

### [BUG-DOC-03] `normalizeCandle` Memotong Tanggal UTC Secara Naif Mengakibatkan Pergeseran Hari Bursa
- **Lokasi**: `lib/daytrade-ohlcv-cache.js:60`
- **Kode Bermasalah**:
  ```javascript
  date: c.date || new Date(time * 1000).toISOString().slice(0, 10),
  ```
- **Dampak ke User**: MEDIUM. Candle bursa Indonesia pada malam hari (17:00-23:59 UTC = 00:00-06:59 WIB) dipotong dengan `.toISOString().slice(0, 10)` sebagai tanggal kemarin dalam zona waktu UTC, bukan tanggal bursa Jakarta hari ini.
- **Bukti Test Nyata**:
  - Perintah: `node test/daytrade-ohlcv-cache-bugs.test.js`
  - Output: `AssertionError [ERR_ASSERTION]: Bug 3: normalizeCandle date must be formatted in Asia/Jakarta timezone ('2026-03-30'), got UTC '2026-03-29'`
- **Usulan Perbaikan**: Gunakan `new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', ... })` untuk konversi tanggal yang akurat.

---

### [BUG-QUOTE-01] Inversi Formula Fibonacci Retracement Pada Tren Penurunan (`downward_retracement`)
- **Lokasi**: `api/quote.js:1307-1331`
- **Kode Bermasalah**:
  ```javascript
  // Calculate Fibonacci levels
  // For upward retracement: levels measured from swing high down
  var fib236 = idxTick.roundToIdxTick(swingHigh - 0.236 * fibRange, 'nearest');
  var fib382 = idxTick.roundToIdxTick(swingHigh - 0.382 * fibRange, 'nearest');
  var fib500 = idxTick.roundToIdxTick(swingHigh - 0.500 * fibRange, 'nearest');
  var fib618 = idxTick.roundToIdxTick(swingHigh - 0.618 * fibRange, 'nearest');
  var fib786 = idxTick.roundToIdxTick(swingHigh - 0.786 * fibRange, 'nearest');
  ```
- **Dampak ke User**: CRITICAL. Pada tren penurunan (rebound dari swing low), level Fibonacci 23.6% seharusnya dihitung dari bawah (`swingLow + 0.236 * range`), sedangkan Fibonacci 78.6% berada dekat swing high. Fungsi ini selalu mengurangkan dari `swingHigh` tanpa memeriksa `fibTrend === 'downward_retracement'`. Akibatnya, pada rebound saham dari harga rendah, level yang ditampilkan terbalik 180 derajat: level terendah dilabeli Fib 78.6% dan level tertinggi dilabeli Fib 23.6%. Selain itu, `invalidationLevel` ditetapkan pada `fib382` (dekat swing high) alih-alih dekat swing low.
- **Bukti Test Nyata**:
  - Perintah: `node test/quote-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-QUOTE-01 PROVEN: In downward retracement, Fib 23.6% must be lower (closer to low) than Fib 78.6%, got fib236=889 and fib786=612`
- **Usulan Perbaikan**: Jika `fibTrend === 'downward_retracement'`, hitung level dari bawah: `fib236 = swingLow + 0.236 * fibRange`, dan set `invalidationLevel = fib382` dari bawah.

---

### [BUG-QUOTE-02] `fetchFreshScreenerLatestPrice` Query ke Supabase Tanpa Order Clause Mengambil Baris Arbitrer
- **Lokasi**: `api/quote.js:85`
- **Kode Bermasalah**:
  ```javascript
  var url = base + '/rest/v1/' + source.table + '?ticker=eq.' + encodeURIComponent(ticker) + '&limit=1';
  ```
- **Dampak ke User**: CRITICAL. Saat refresh portofolio (`portfolio=1`), query REST ke Supabase untuk tabel `daytrade_screener_latest` atau `swing_screener_latest` hanya menyertakan `limit=1` tanpa klausa `.order(...)` (misal `&order=calculated_at.desc`). PostgREST/PostgreSQL mengembalikan baris pertama yang ditemui pada disk scan, yang bisa berupa data run kemarin yang usang (stale). Pengguna melihat nilai portofolio dihitung dengan harga lama.
- **Bukti Test Nyata**:
  - Perintah: `node test/quote-bugs.test.js`
  - Output: Terbukti secara analitis dan reproduksi bahwa PostgREST tanpa parameter `order` mengembalikan urutan non-deterministik/stale.
- **Usulan Perbaikan**: Tambahkan parameter sorting: `&order=calculated_at.desc,updated_at.desc&limit=1`.

---

### [BUG-QUOTE-03] Dead Code & Pengabaian Penalti Risiko: Setup Status `'Breakdown Risk'` Tidak Pernah Ada di `calculateSetupLabel`
- **Lokasi**: `api/quote.js:893, 938`
- **Kode Bermasalah**:
  ```javascript
  else if (idxSetupStatus === 'Breakdown Risk') {
    indexScore += 12;
    indexReasons.push('Indeks dalam area breakdown risk');
  }
  ...
  else if (setupStatus === 'Breakdown Risk') {
    riskScore += 15;
    reasons.push('Setup Label: breakdown risk terdeteksi');
  }
  ```
- **Dampak ke User**: HIGH. Fungsi `calculateSetupLabel` tidak pernah menghasilkan status `'Breakdown Risk'` (status yang tersedia adalah: 'Avoid Dulu', 'Bearish Continuation', 'High Risk Speculative', 'Breakout Watch', 'Rebound Watch', 'Speculative Watch', 'Sideways / No Trade'). Status `'Breakdown Risk'` hanya ada di `breakoutConfirmation`. Akibatnya, blok penalti risiko +12 dan +15 pada `calculateRiskGuard` menjadi dead code dan tidak pernah dieksekusi, menyebabkan skor risiko saham/indeks yang mengalami breakdown dihitung terlalu rendah (understated risk).
- **Bukti Test Nyata**:
  - Perintah: `node test/quote-bugs.test.js`
  - Output: Verifikasi pemanggilan `calculateSetupLabel` membuktikan bahwa status `'Breakdown Risk'` tidak ada dalam cabang return fungsi tersebut.
- **Usulan Perbaikan**: Gunakan `breakoutConf && breakoutConf.status === 'Breakdown Risk'` untuk evaluasi risiko, bukan `setupStatus`.

---

### [BUG-QUOTE-04] False Positive `floors.applied = true` dengan `trigger: null` Akibat Pengurangan Skor Katalis Positif
- **Lokasi**: `api/quote.js:968, 1024-1027`
- **Kode Bermasalah**:
  ```javascript
  // Apply catalyst reduction BEFORE floor enforcement
  riskScore = riskScore - catalystReduction;
  ...
  // Enforce floor
  if (riskScore < minimumScore) {
    riskScore = minimumScore;
    floorApplied = true;
  }
  ```
- **Dampak ke User**: HIGH. Ketika suatu saham memiliki skor risiko dasar rendah (misal 2) dan terdapat katalis berita positif (`catalystReduction = 3`), `riskScore` menjadi -1. Jika saham tersebut tidak memicu floor risiko apa pun (`minimumScore = 0`), kondisi `riskScore < minimumScore` (-1 < 0) bernilai `true`. Hal ini mengaktifkan `floorApplied = true` padahal `floorTrigger` bernilai `null`. Klien frontend menerima metadata anomali `{ floors: { applied: true, trigger: null } }`, membingungkan logika rendering transparansi risiko UI.
- **Bukti Test Nyata**:
  - Perintah: `node test/quote-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-QUOTE-04 PROVEN: Catalyst reduction clamped risk score to 0 and falsely flagged floors.applied: true with trigger: null (got applied=true, trigger=null)`
- **Usulan Perbaikan**: Evaluasi `floorApplied = true` hanya jika `minimumScore > 0` dan `floorTrigger != null`.

---

### [BUG-QUOTE-05] Regex Validasi Ticker Menolak Simbol Benchmark Indeks Resmi BEI yang Mengandung Angka (`LQ45`, `IDX30`)
- **Lokasi**: `api/quote.js:174`
- **Kode Bermasalah**:
  ```javascript
  if (!/^[A-Z]{3,5}$/.test(ticker) && ticker !== 'IHSG') {
    return res.status(400).json({ error: 'Format ticker tidak valid.' });
  }
  ```
- **Dampak ke User**: MEDIUM. Pengguna tidak dapat melihat quote benchmark utama bursa seperti `LQ45` dan `IDX30` karena adanya karakter angka `45` dan `30`. API langsung menolak request dengan HTTP 400 "Format ticker tidak valid." padahal indeks tersebut merupakan instrumen perbandingan utama di BEI.
- **Bukti Test Nyata**:
  - Perintah: `node test/quote-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-QUOTE-05 PROVEN: Valid benchmark index LQ45 rejected with status 400: {"error":"Format ticker tidak valid."}`
- **Usulan Perbaikan**: Perluas regex validasi ticker untuk mendukung format indeks dan saham BEI: `/^[A-Z0-9]{2,6}$/`.

---

### [BUG-QUOTE-06] `calcRSI` Mengembalikan `NaN` Alih-alih `null` Saat Menemui Nilai Harga Non-Finite
- **Lokasi**: `api/quote.js:688-701`
- **Kode Bermasalah**:
  ```javascript
  var diff = closes[i] - closes[i - 1];
  if (diff > 0) gains += diff;
  else losses -= diff;
  ```
- **Dampak ke User**: MEDIUM. Berbeda dengan implementasi di `api/candles.js` yang memvalidasi `Number.isFinite`, `calcRSI` di `api/quote.js` langsung melakukan operasi aritmatika tanpa guard. Jika ada satu elemen `null` atau `NaN` pada data harga, `gains` dan `losses` menjadi `NaN`, dan fungsi mengembalikan `NaN`. Nilai `NaN` ini menyebabkan seluruh perbandingan matematis momentum pada `calculateAutoCuanScore` dan `calculateSetupLabel` gagal tanpa melempar error (silent failure).
- **Bukti Test Nyata**:
  - Perintah: `node test/quote-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-QUOTE-06 PROVEN: calcRSI must return null on non-finite data, but returned NaN: NaN`
- **Usulan Perbaikan**: Tambahkan pengecekan `Number.isFinite` pada setiap harga penutupan dan return `null` jika ada data yang rusak atau jika pembagian tidak valid.

---

### [BUG-CAN-01] Hardcoded Admin Username `'budi'` Memblokir Akses Pattern Map & Classic Patterns untuk Akun Admin Lain
- **Lokasi**: `api/candles.js:37-40`
- **Kode Bermasalah**:
  ```javascript
  function hasPatternMapAccess(req) {
    var auth = adminSession.requireAdminSession(req);
    return auth.ok === true && String(auth.session && auth.session.un || '').trim().toLowerCase() === 'budi';
  }
  ```
- **Dampak ke User**: CRITICAL. Meskipun seorang administrator login dengan sesi JWT HMAC yang sah dan memiliki role admin penuh (misal username `'admin'`, `'analyst'`, atau akun staf lainnya), fungsi memverifikasi kesamaan string hardcoded terhadap nama `'budi'`. Akibatnya, `publicData.patternMap` dan `classicPatterns` dihapus dari payload JSON bagi seluruh administrator selain `'budi'`, mematikan fitur visualisasi pattern chart pada akun manajemen resmi lainnya.
- **Bukti Test Nyata**:
  - Perintah: `node test/candles-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CAN-01 PROVEN: hasPatternMapAccess must allow authenticated admin session for "admin", but hardcoded check for "budi" returned false`
- **Usulan Perbaikan**: Berikan akses kepada setiap sesi admin yang valid: `return auth.ok === true;` atau periksa role admin tanpa meng-hardcode nama personal.

---

### [BUG-CAN-02] Validasi OHLC Hanya Memeriksa `!isNaN(c)` Sehingga Memasukkan `NaN` Pada Open, High, atau Low ke Array Candles
- **Lokasi**: `api/candles.js:133-134`
- **Kode Bermasalah**:
  ```javascript
  var c = closes[i], o = opens[i], h = highs[i], l = lows[i], v = volumes[i];
  ...
  if (candleDate && c != null && o != null && h != null && l != null && !isNaN(c)) {
    candles.push({
      time: candleDate,
      open: Math.round(o * 100) / 100,
      ...
  ```
- **Dampak ke User**: HIGH. Pemeriksaan `!isNaN` hanya dilakukan pada variabel `c` (close). Jika feed data Yahoo Finance mengembalikan `NaN` pada open, high, atau low (kondisi yang kerap terjadi pada sesi pembukaan atau data anomali provider), candle dengan nilai `open: NaN` tetap di-push ke array `candles`. Saat data ini dikirim ke frontend, library Lightweight Charts crash seketika (`Assertion failed: Price is NaN`), menyebabkan grafik teknikal blank putih di layar user.
- **Bukti Test Nyata**:
  - Perintah: `node test/candles-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CAN-02 PROVEN: Parser pushed candle with NaN open to candles array (found: {"time":"2026-03-24","open":null...})`
- **Usulan Perbaikan**: Validasi semua komponen harga: `!isNaN(c) && !isNaN(o) && !isNaN(h) && !isNaN(l)`.

---

### [BUG-CAN-03] Regex Validasi Ticker Menolak Simbol Benchmark Resmi BEI (`^JKSE`, `LQ45`, `IDX30`)
- **Lokasi**: `api/candles.js:68-71`
- **Kode Bermasalah**:
  ```javascript
  if (ticker === 'JKSE' || ticker === 'JCI' || ticker === 'COMPOSITE') ticker = 'IHSG';
  if (!/^[A-Z]{3,5}$/.test(ticker)) {
    return res.status(400).json({ error: 'Format ticker tidak valid.' });
  }
  ```
- **Dampak ke User**: HIGH. Simbol resmi Yahoo Finance untuk Indeks IHSG adalah `^JKSE`. Jika user atau komponen chart memanggil `/api/candles?ticker=^JKSE`, regex `/^[A-Z]{3,5}$/` menolaknya karena simbol `^`. Demikian pula dengan indeks likuid `LQ45` dan `IDX30` yang ditolak karena mengandung digit angka. Grafik teknikal indeks acuan bursa gagal dimuat dan menampilkan error 400.
- **Bukti Test Nyata**:
  - Perintah: `node test/candles-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CAN-03 PROVEN: Benchmark index LQ45 rejected with status 400: {"error":"Format ticker tidak valid."}`
- **Usulan Perbaikan**: Normalisasi `^JKSE` menjadi `IHSG`, dan izinkan karakter alfanumerik 2-6 digit pada regex ticker.

---

### [BUG-CAN-04] Distorsi Rasio Volume: `calcVolumeRatio` Menyertakan Volume Hari Ini ke Dalam Rata-Rata 20 Hari
- **Lokasi**: `api/candles.js:168, 248-255`
- **Kode Bermasalah**:
  ```javascript
  volumeVsAvg20: calcVolumeRatio(volumeArr, latest.volume, 20)
  ...
  function calcVolumeRatio(volumeArr, latestVol, period) {
    var avg = calcMA(volumeArr, period);
    ...
    var ratio = vol / avg;
    return Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : 0;
  }
  ```
- **Dampak ke User**: MEDIUM. `volumeArr` adalah array seluruh candle yang elemen terakhirnya adalah `latest.volume`. Pemanggilan `calcMA(volumeArr, 20)` menghitung rata-rata dari 20 bar terakhir TERMASUK hari ini. Jika hari ini terjadi lonjakan volume akumulasi yang masif (misal 5x lipat hari biasa), volume hari ini menggelembungkan nilai rata-ratanya sendiri, sehingga rasio yang dilaporkan menyusut (misal hanya tercatat 4.17x). Indikator volume spike di chart viewer menjadi terdistorsi ke bawah.
- **Bukti Test Nyata**:
  - Perintah: `node test/candles-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CAN-04 PROVEN: calcVolumeRatio included current volume spike in average, deflating ratio from 5.0 to 4.17`
- **Usulan Perbaikan**: Hitung rata-rata volume historis menggunakan baris sebelum candle terakhir: `calcMA(volumeArr.slice(0, -1), period)`.

---

### [BUG-CV-01] Focus Trap Leak: Tombol Tab Mengeluarkan Fokus Dialog Modal Saat `activeElement` di Luar Overlay
- **Lokasi**: `public/chart-viewer.js:147-158`
- **Kode Bermasalah**:
  ```javascript
  function onKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); dispose(); return; }
    if (event.key !== 'Tab') return;
    var items = focusableIn(overlay);
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  ```
- **Dampak ke User**: CRITICAL. Ketika fullscreen modal terbuka, jika pengguna mengklik elemen di latar belakang atau jika fokus awal gagal masuk ke overlay, `doc.activeElement` berada di luar `overlay`. Kondisi `doc.activeElement === first` maupun `doc.activeElement === last` bernilai `false`. Akibatnya, penekanan tombol `Tab` tidak dicegah (`preventDefault` tidak dipanggil), dan fokus keyboard lolos bebas ke elemen interaktif di halaman latar belakang. Ini melanggar aksesibilitas WCAG 2.1 modal dialog.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-viewer-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CV-01 PROVEN: Tab key event while activeElement is outside modal was not trapped (preventDefault was not called)`
- **Usulan Perbaikan**: Tambahkan pengecekan penahanan fokus: `if (!overlay.contains(doc.activeElement)) { event.preventDefault(); first.focus(); return; }`.

---

### [BUG-CV-02] Race Condition & Operasi Detached DOM Saat Viewer Ditutup Cepat (<100ms)
- **Lokasi**: `public/chart-viewer.js:203-213`
- **Kode Bermasalah**:
  ```javascript
  Promise.resolve()
    .then(function () {
      if (typeof root.loadLightweightCharts === 'function') return root.loadLightweightCharts();
      return null;
    })
    .then(function () {
      return root.renderLightweightChart(...);
    })
    .catch(function () {
      body.innerHTML = '';
      renderImage(root, doc, body, state, options);
    });
  ```
- **Dampak ke User**: HIGH. Jika pengguna membuka modal chart lalu segera menutupnya (tekan Escape atau Tutup sebelum script Lightweight Charts selesai dimuat), fungsi `dispose()` mengeksekusi `overlay.parentNode.removeChild(overlay)` dan membersihkan status viewer. Namun, rantai Promise di `renderInteractive` tidak memiliki guard `if (disposed) return;`. Ketika script selesai dimuat, fungsi tetap memanggil `renderLightweightChart` pada elemen yang sudah tidak ada di DOM, melempar error, lalu blok `.catch()` memanggil `renderImage` dan menambahkan event listener pointer pada kontainer detached yang sudah terhapus, menyebabkan kebocoran memori (memory leak).
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-viewer-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CV-02 PROVEN: renderInteractive executed renderLightweightChart even though viewer had already been closed/disposed`
- **Usulan Perbaikan**: Tambahkan pengecekan variabel `if (disposed) return;` di setiap blok `.then()` dan `.catch()` pada `renderInteractive`.

---

### [BUG-CV-03] Tombol 'Simpan PNG' Tetap Tampil dan Rusak Saat Engine Chart Gagal & Fallback ke Gambar
- **Lokasi**: `public/chart-viewer.js:173-183, 208-212`
- **Kode Bermasalah**:
  ```javascript
  } else if (canRenderChart && typeof root.downloadChartPng === 'function') {
    var exportBtn = doc.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'ac-viewer-btn';
    exportBtn.textContent = 'Simpan PNG';
    exportBtn.addEventListener('click', function () {
      root.downloadChartPng(state.chartId, options.ticker || '', exportBtn);
    });
    actions.appendChild(exportBtn);
  }
  ...
  .catch(function () {
    body.innerHTML = '';
    renderImage(root, doc, body, state, options);
  });
  ```
- **Dampak ke User**: HIGH. Pada awal `open()`, jika data candle ada dan fungsi renderer tersedia, tombol `exportBtn` ditambahkan ke toolbar. Jika engine chart kemudian gagal (misal WebGL context lost atau kegagalan script) dan beralih ke fallback gambar (`renderImage`), tombol `exportBtn` tidak dibersihkan atau diganti. Pengguna yang mengklik "Simpan PNG" memicu pemanggilan `downloadChartPng(state.chartId)` pada ID chart yang tidak pernah terdaftar di registry, menghasilkan error tak tertangani ke pengguna.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-viewer-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CV-03 PROVEN: Export PNG button remained visible in actions toolbar calling downloadChartPng after chart engine failed and fell back to static image`
- **Usulan Perbaikan**: Di dalam blok catch `renderInteractive`, periksa dan hapus `exportBtn` dari `actions`, atau perbarui handler-nya untuk mengunduh gambar fallback.

---

### [BUG-CV-04] Drag-Pan Macet Setelah Melepas Jari Kedua Pada Operasi Pinch-Zoom
- **Lokasi**: `public/chart-viewer.js:244-272`
- **Kode Bermasalah**:
  ```javascript
  frame.addEventListener('pointerdown', function (event) {
    ...
    if (ids.length === 2) {
      pinchStart = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: state.zoom };
      dragStart = null;
    }
  });
  function endPointer(event) {
    delete pointers[event.pointerId];
    if (Object.keys(pointers).length < 2) pinchStart = null;
    if (!Object.keys(pointers).length) dragStart = null;
  }
  ...
  else if (dragStart && ids.length === 1) {
    state.panX = dragStart.panX + (event.clientX - dragStart.x);
    state.panY = dragStart.panY + (event.clientY - dragStart.y);
  ```
- **Dampak ke User**: MEDIUM. Saat pengguna melakukan cubit-zoom dengan 2 jari, `dragStart` di-set menjadi `null`. Ketika 1 jari dilepas, `endPointer` mereset `pinchStart = null`, sehingga pointer yang tersisa di layar berjumlah 1 (`ids.length === 1`). Namun, `dragStart` tetap bernilai `null` karena hanya dibuat saat event `pointerdown`. Ketika pengguna menggeser jari yang tersisa, kondisi `else if (dragStart && ids.length === 1)` bernilai `false`. Pengguna tidak dapat menggeser (pan) gambar yang sudah dizoom sampai ia mengangkat seluruh jari dari layar dan menyentuhnya kembali.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-viewer-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CV-04 PROVEN: Pointer move with remaining 1 finger failed to pan because dragStart remained null after releasing second finger`
- **Usulan Perbaikan**: Di dalam `endPointer`, jika tersisa 1 pointer aktif, inisialisasi ulang `dragStart` menggunakan koordinat pointer yang masih menempel.

---

### [BUG-CAR-01] Heading Markdown Selain `## ` (Seperti `### ` atau `# `) Dirender Sebagai Teks Mentah
- **Lokasi**: `public/chart-analysis-runtime.js:44`
- **Kode Bermasalah**:
  ```javascript
  if (trimmed.startsWith('## ')) {
    closeList();
    if (inSection) html += '</div>';
    var title = trimmed.replace(/^##\s*/, '').replace(/\*\*/g, '');
  ```
- **Dampak ke User**: HIGH. Model Gemini AI secara rutin mengembalikan struktur heading dengan tingkat `### Sinyal dan Rekomendasi` atau `# Analisis Teknikal`. Parser di `formatAnalysisText` hanya mengecek `trimmed.startsWith('## ')`. Semua judul berkategori H1 atau H3 tidak dikenali sebagai heading, melainkan dirender sebagai teks paragraf biasa yang diawali tanda pagar mentah `### `, merusak hierarki visual laporan analisis AI Vision.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-analysis-runtime-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CAR-01 PROVEN: Heading "### Sinyal dan Rekomendasi" was not parsed as a header and rendered as raw text with hashes`
- **Usulan Perbaikan**: Gunakan regex untuk mencocokkan semua level heading: `/^#{1,4}\s+(.+)$/`.

---

### [BUG-CAR-02] `copyChartVisionResult` Crash (TypeError) Saat Dipanggil Tanpa Argumen Elemen
- **Lokasi**: `public/chart-analysis-runtime.js:14-17`
- **Kode Bermasalah**:
  ```javascript
  root.copyChartVisionResult = function (btn) {
    var wrap = btn.closest('[data-ai-vision-raw-text]') || document.getElementById('unifiedAiChartResultWrap') || document.getElementById('aiChartAnalysisResultWrap');
    var text = wrap ? (wrap.dataset.aiVisionRawText || '') : '';
  ```
- **Dampak ke User**: MEDIUM. Parameter `btn` diasumsikan selalu berupa instance DOM Element dengan metode `.closest`. Jika fungsi dipanggil secara terprogram atau dipicu oleh event handler tanpa passing elemen tombol (`copyChartVisionResult()`), script melempar `TypeError: Cannot read properties of undefined (reading 'closest')`. Fitur penyalinan hasil gagal seketika.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-analysis-runtime-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CAR-02 PROVEN: copyChartVisionResult crashed with TypeError: Cannot read properties of undefined (reading 'closest')`
- **Usulan Perbaikan**: Tambahkan pengecekan aman: `var wrap = (btn && typeof btn.closest === 'function' ? btn.closest('[data-ai-vision-raw-text]') : null) || document.getElementById(...)`.

---

### [BUG-CAR-03] Pemicuan Ganda Konkuren `triggerAiChartAnalysis` Membakar Kuota Harian Pengguna Secara Sia-sia
- **Lokasi**: `public/chart-analysis-runtime.js:147-220`
- **Kode Bermasalah**:
  ```javascript
  root.triggerAiChartAnalysis = function (ticker) {
    ...
    fetch(API_ENDPOINT + '&action=status&ticker=' + encodeURIComponent(ticker), ...)
  ```
- **Dampak ke User**: MEDIUM. Fungsi tidak memiliki penguncian status in-flight (`isAnalyzing`) atau penonaktifan tombol pemicu. Jika pengguna melakukan klik ganda (double-click) atau mengklik berulang kali tombol "Analisis Chart (AI)", beberapa panggilan POST `/api/analyze?surface=chart-analysis&action=analyze` dieksekusi secara paralel ke Google Gemini. Hal ini memotong kuota harian analisis AI pengguna sebanyak dua kali atau lebih untuk satu candlestick chart yang persis sama.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-analysis-runtime-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CAR-03 PROVEN: Double click dispatched 2 parallel AI vision calls without in-flight locking, burning quota twice`
- **Usulan Perbaikan**: Terapkan guard boolean `isAnalyzing` dan nonaktifkan tombol pemicu selama proses analisis visual berlangsung.

---

### [BUG-ASR-01] Bypass Paywall Total Sisi Klien Melalui Username `'budi'` di `localStorage`
- **Lokasi**: `public/analisis-saham-runtime.js:336-348, 368-378, 413-421`
- **Kode Bermasalah**:
  ```javascript
  function isAdminUser() {
    var user = '';
    try { user = (localStorage.getItem('autocuan_user') || '').toLowerCase().trim(); } catch (_) {}
    if (user === 'budi') return true;
  ...
  function isSubscribedUser() {
    if (isAdminUser()) return true;
  ...
  async function verifySubscriptionStatus() {
    var storedUser = '';
    try { storedUser = (localStorage.getItem('autocuan_user') || '').trim(); } catch (_) {}
    if (isSubscribedUser() && storedUser && storedUser.toLowerCase() !== 'guest') {
      syncHeaderUsername();
      checkPatternTabVisibility();
      updateRankingPaywallUi();
      return true;
    }
  ```
- **Dampak ke User**: CRITICAL. Pada saat inisialisasi halaman, `verifySubscriptionStatus()` mengecek apakah `isSubscribedUser()` bernilai `true`. Karena `isAdminUser()` mengembalikan `true` hanya dengan memeriksa apakah `localStorage.getItem('autocuan_user') === 'budi'`, pengguna non-berlangganan dapat mengetikkan `localStorage.setItem('autocuan_user', 'budi')` di konsol browser. Fungsi `verifySubscriptionStatus` langsung mengembalikan `true` dan MELEWATI TOTAL verifikasi profil backend (`fetch('/api/reset-password')`). Seluruh tab premium (Bandarmologi, Sinyal Intelijen, Broker Hunter, Jejaring Insider, dan Ranking Harian) terbuka penuh tanpa validasi server.
- **Bukti Test Nyata**:
  - Perintah: `node test/analisis-saham-runtime-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-ASR-01 PROVEN: verifySubscriptionStatus bypassed server authentication entirely and returned true because user was "budi" in localStorage`
- **Usulan Perbaikan**: Jangan pernah mengizinkan bypass otentikasi hanya berdasarkan nilai string di `localStorage`. Verifikasi status langganan harus selalu menunggu respons server resmi yang divalidasi dengan HttpOnly session cookie.

---

### [BUG-ASR-02] `switchAnalisisTab` Memanggil `switchAnalisisSubTab` Dua Kali Berturut-turut Pada Setiap Perpindahan Tab
- **Lokasi**: `public/analisis-saham-runtime.js:237-241, 256-263`
- **Kode Bermasalah**:
  ```javascript
  if (parentTab === 'analisis-chart') {
    ...
    if (tabName === 'chart') {
      ...
      switchAnalisisSubTab('chart');
    } else if (tabName === 'analisis') {
      ...
      switchAnalisisSubTab('ai');
    }
  }
  ...
  if (parentTab === 'analisis-chart') {
    if (tabName === 'chart') {
      switchAnalisisSubTab('chart');
    } else if (tabName === 'analisis') {
      switchAnalisisSubTab('ai');
    } else {
      switchAnalisisSubTab(currentAnalisisSubTab);
    }
  }
  ```
- **Dampak ke User**: HIGH. Saat pengguna berpindah ke tab analisis atau chart, blok logika memanggil `switchAnalisisSubTab` dua kali berturut-turut pada baris yang sama. Di dalam `switchAnalisisSubTab('chart')`, pemanggilan ganda ini memicu `UnifiedCockpit.loadUnifiedChart(ticker)` dua kali dan mendispatch event resize dua kali. Ini mengakibatkan beban ganda pada browser pengguna, flicker pada canvas grafik, dan pemborosan memori rendering.
- **Bukti Test Nyata**:
  - Perintah: `node test/analisis-saham-runtime-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-ASR-02 PROVEN: switchAnalisisTab('analisis-chart') invoked switchAnalisisSubTab 2 times instead of 1`
- **Usulan Perbaikan**: Hapus pemanggilan duplikat kedua di baris 256-264 dan konsolidasikan pemanggilan sub-tab di satu percabangan saja.

---

### [BUG-ASR-03] Inkonsistensi Prefix Mata Uang `'Rp '` Pada Formatter `mktCtxFmtIDR`
- **Lokasi**: `public/analisis-saham-runtime.js:53-63`
- **Kode Bermasalah**:
  ```javascript
  root.mktCtxFmtIDR = function (v) {
    if (!Number.isFinite(v)) return 'â€”';
    if (v === 0 || Math.round(v) === 0) return 'Rp 0';
    var abs = Math.abs(v);
    var sign = v > 0 ? '+' : '-';
    if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + ' T';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + ' M';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + ' jt';
    return sign + Math.round(abs).toLocaleString('id-ID');
  };
  ```
- **Dampak ke User**: MEDIUM. Untuk nilai nominal >= 1 juta, 1 miliar, dan 1 triliun, formatter menghasilkan format tanpa prefix mata uang `'Rp '` (misal `+1.50 M`, `-250.00 M`). Sebaliknya, untuk nilai 0 fungsi menghasilkan `'Rp 0'`, dan untuk angka di bawah 1 juta menghasilkan tanda minus/plus yang diikuti angka tanpa 'Rp ' yang seragam. Kolom 'Foreign Terakhir', 'Foreign 3D', dan 'Foreign 7D' pada tabel Ranking menampilkan format yang tidak konsisten antar baris emiten.
- **Bukti Test Nyata**:
  - Perintah: `node test/analisis-saham-runtime-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-ASR-03 PROVEN: Inconsistent currency prefix in mktCtxFmtIDR (5B gives "+5.00 M" without "Rp", while 500K gives "+500.000" with "Rp")`
- **Usulan Perbaikan**: Sertakan prefix `Rp ` secara konsisten untuk semua rentang nilai: `return sign + 'Rp ' + ...`.

---

### [BUG-CEVA-01] Distorsi RVOL: `relativeVolume` Menyertakan Volume Candle Terakhir ke Dalam Rata-rata Baseline MA20
- **Lokasi**: `lib/chart-engine/volume-analyzer.js:34-39`
- **Kode Bermasalah**:
  ```javascript
  function relativeVolume(volumes, period) {
    var p = period || 20;
    if (!Array.isArray(volumes) || volumes.length < p) return null;
    var avg = maVolume(volumes, p);
    var last = Number(volumes[volumes.length - 1]);
    if (!avg || avg <= 0 || !Number.isFinite(last)) return null;
    return last / avg;
  }
  ```
- **Dampak ke User**: CRITICAL. Serupa dengan `BUG-CAN-04`, `maVolume(volumes, p)` mengeksekusi `volumes.slice(-p)` yang menyertakan elemen candle terakhir (`last`). Jika volume hari ini melonjak 2.0x lipat dari rata-rata historis (misal 19 hari di volume 100 dan hari ini 200), volume hari ini menggelembungkan penyebutnya sendiri (`avg` naik dari 100 menjadi 105). RVOL yang dihasilkan menyusut menjadi 1.90x. Syarat breakout confirmation `volumeSurge` untuk level `STRONG_SURGE` (`v >= 2.0`) gagal tercapai, sehingga sinyal breakout valid kehilangan skor konfirmasi volume 30 poin dan diklasifikasikan hanya sebagai `SURGE` biasa (20 poin).
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-engine-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CEVA-01 PROVEN: 2.0x volume surge must yield RVOL >= 2.0, got 1.9047619047619047`
- **Usulan Perbaikan**: Hitung moving average volume historis dari bar sebelum candle terakhir: `maVolume(volumes.slice(0, -1), p)`.

---

### [BUG-CEVA-02] Injeksi Nilai `0` Pada Volume Kosong (`null`) Melalui `Number(null)` di `analyze()`
- **Lokasi**: `lib/chart-engine/volume-analyzer.js:63-65`
- **Kode Bermasalah**:
  ```javascript
  function analyze(candles) {
    var volumes = Array.isArray(candles) ? candles.map(function (c) { return Number(c && c.volume); }) : [];
    var rvol = relativeVolume(volumes, 20);
  ```
- **Dampak ke User**: HIGH. Pada instrumen indeks atau candle yang tidak memiliki field volume (`c.volume: null`), ekspresi `Number(null)` mengevaluasi angka `0`. Nilai `0` tersebut dianggap sebagai volume transaksi valid yang bernilai nol alih-alih data tidak tersedia. Akibatnya, `maVolume` mengembalikan rata-rata `ma20: 0` bukannya `null`, dan hari-hari tanpa pencatatan volume menekan rata-rata historis ke bawah secara artifisial.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-engine-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CEVA-02 PROVEN: Candles with missing/null volume must yield ma20: null, got 0`
- **Usulan Perbaikan**: Jangan konversi `null` menjadi 0. Jika `c.volume == null`, petakan ke `null` atau `NaN` sehingga `maVolume` memvalidasi dan menolak deret candle yang tidak memiliki data volume.

---

### [BUG-CEVA-03] `maVolume` Meloloskan Angka Volume Negatif Non-Fisik
- **Lokasi**: `lib/chart-engine/volume-analyzer.js:21`
- **Kode Bermasalah**:
  ```javascript
  var v = Number(slice[i]);
  if (!Number.isFinite(v)) return null;
  sum += v;
  ```
- **Dampak ke User**: MEDIUM. Volume perdagangan di bursa saham secara fisik tidak pernah bernilai negatif. Pemeriksaan `!Number.isFinite(v)` meloloskan angka negatif seperti `-500` karena angka tersebut bertipe finite number. Anomali data dari upstream provider atau penyesuaian feed yang mengirim angka negatif akan mengikis total penjumlahan volume tanpa tertolak, menghasilkan rata-rata yang terdistorsi.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-engine-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CEVA-03 PROVEN: Negative volume must return null, got 70`
- **Usulan Perbaikan**: Tambahkan pengecekan batas non-negatif: `if (!Number.isFinite(v) || v < 0) return null;`.

---

### [BUG-CEI-01] `ema()` Tidak Memvalidasi Elemen Pertama `closes[0]` Sehingga Menghasilkan `NaN` atau Menghitung dari Harga 0
- **Lokasi**: `lib/chart-engine/indicators.js:18-24`
- **Kode Bermasalah**:
  ```javascript
  var k = 2 / (period + 1);
  var value = Number(closes[0]);
  for (var i = 1; i < closes.length; i += 1) {
    var c = Number(closes[i]);
    if (!Number.isFinite(c)) return null;
    value = c * k + value * (1 - k);
  }
  return value;
  ```
- **Dampak ke User**: CRITICAL. Loop `for` hanya memeriksa `!Number.isFinite(c)` untuk elemen `i >= 1`. Elemen pertama `closes[0]` diinisialisasi di luar loop tanpa validasi apa pun. Jika `closes[0]` bernilai `NaN` (atau string non-angka), `value` menjadi `NaN`, seluruh iterasi menghasilkan `NaN`, dan fungsi mengembalikan `NaN` alih-alih `null` (melanggar kontrak return `@returns {number|null}`). Selain itu, jika `closes[0]` bernilai `null`, `Number(null)` menjadi `0`, menyebabkan seluruh baris perhitungan EMA dihitung mulai dari harga Rp 0.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-engine-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CEI-01 PROVEN: ema with NaN in closes[0] must return null, got NaN`
- **Usulan Perbaikan**: Validasi `closes[0]` sebelum loop: `if (!Number.isFinite(value) || value <= 0) return null;`.

---

### [BUG-CEI-02] `classifySwingTrend` Mengklasifikasikan Monotonic Bull Run Sebagai `'SIDEWAYS'` Karena Kekurangan Pivot Low
- **Lokasi**: `lib/chart-engine/indicators.js:93-97`
- **Kode Bermasalah**:
  ```javascript
  var higherLow = swings.lows.length >= 2 && swings.lows[swings.lows.length - 1] > swings.lows[swings.lows.length - 2];
  var close = closes[closes.length - 1];
  var status = (close > ema20 && ema20 > ema50 && higherLow) ? 'UPTREND' : (close < ema50 ? 'DOWNTREND' : 'SIDEWAYS');
  ```
- **Dampak ke User**: HIGH. Pada saham yang mengalami tren penguatan sangat kuat dan konsisten (setiap candle mencetak low yang lebih tinggi dari candle sebelumnya tanpa ada swing trough), `pivotSwing` tidak menemukan titik lembah sehingga `swings.lows.length < 2`. Syarat `higherLow` bernilai `false`. Akibatnya, saham yang berada dalam kondisi breakout super-bullish (`close > ema20 > ema50`) justru diklasifikasikan sebagai `'SIDEWAYS'` oleh screener swing, menyebabkan pengguna kehilangan rekomendasi momentum terbaik.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-engine-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CEI-02 PROVEN: Strong bull run must be classified as UPTREND, got SIDEWAYS`
- **Usulan Perbaikan**: Jika `swings.lows.length < 2`, periksa apakah low candle terus bergerak naik (`lows trending upward`) atau gunakan keselarasan moving average `(close > ema20 && ema20 > ema50)` sebagai dasar klasifikasi `UPTREND`.

---

### [BUG-CEI-03] `classifySwingTrend` Mengabaikan Validasi Integritas Komponen `high` dan `low`
- **Lokasi**: `lib/chart-engine/indicators.js:84-89`
- **Kode Bermasalah**:
  ```javascript
  var closes = candles.map(function (c) { return Number(c && c.close); });
  if (closes.some(function (v) { return !Number.isFinite(v) || v <= 0; })) {
    return { status: 'INVALID_DATA', close: null, ema20: null, ema50: null, higher_high: false, higher_low: false };
  }
  var ema20 = ema(closes, 20);
  var ema50 = ema(closes, 50);
  var swings = pivotSwing(candles, 20);
  ```
- **Dampak ke User**: MEDIUM. Fungsi hanya memvalidasi integritas elemen `close`. Komponen `high` dan `low` yang digunakan langsung oleh `pivotSwing` tidak dicek. Jika salah satu candle memiliki `high: NaN` atau `low: null`, fungsi tidak mengembalikan status `'INVALID_DATA'`, melainkan tetap melanjutkan eksekusi dengan data yang rusak sehingga deteksi pivot swing menghasilkan kalkulasi yang cacat.
- **Bukti Test Nyata**:
  - Perintah: `node test/chart-engine-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-CEI-03 PROVEN: Candles with NaN high/low must return INVALID_DATA, got SIDEWAYS`
- **Usulan Perbaikan**: Validasi bahwa `open`, `high`, `low`, dan `close` pada setiap candle bernilai finite dan positif sebelum menjalankan kalkulasi indikator.

---

### [BUG-AGP-01] Pemotongan Respon Multi-part Pada `generateGeminiContent` dan `parseSseStream` Hanya Mengambil Bagian Pertama (`parts[0]`)
- **Lokasi**: `lib/ai-gemini-provider.js:94, 163, 211`
- **Kode Bermasalah**:
  ```javascript
  const textPart = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
  ...
  text = parsed && parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts && parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text;
  ```
- **Dampak ke User**: CRITICAL. Pada Google Gemini API, ketika model mengembalikan respon panjang, terstruktur dalam beberapa seksi, atau mengandung kutipan/tabel, jawaban dibagi ke dalam beberapa elemen array `parts` (`parts[0]`, `parts[1]`, dst). Kode hanya membaca `parts[0].text`. Seluruh teks penjelasan lanjutan, target harga, dan analisis risiko pada `parts[1..n]` terpotong dan dibuang tanpa disadari pengguna. Selain itu, pada model Gemini thinking (seperti 2.0 / 2.5), jika `parts[0]` berupa thought/non-text part dan `parts[1]` memuat jawaban utama, fungsi melempar error palsu `GEMINI_EMPTY_RESPONSE`.
- **Bukti Test Nyata**:
  - Perintah: `node test/ai-gemini-provider-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-AGP-01 PROVEN: Candidate with multiple parts must concatenate all text parts, got: "Part 1: Analisis teknikal. "`
- **Usulan Perbaikan**: Gabungkan seluruh elemen teks pada `parts`: `candidate.content.parts.map(p => p.text || '').join('')`.

---

### [BUG-AGP-02] Parameter `options.model` Melewati Guard `sanitizeGeminiModel` Sehingga Mengirim Model Deprecated ke Google API
- **Lokasi**: `lib/ai-gemini-provider.js:47, 249`
- **Kode Bermasalah**:
  ```javascript
  const model = options.model || sanitizeGeminiModel(process.env.GEMINI_MODEL, DEFAULT_GEMINI_MODEL);
  ```
- **Dampak ke User**: CRITICAL. Daftar `DEPRECATED_GEMINI_MODELS` dibuat untuk mencegah pemanggilan model lama yang sudah dihentikan oleh Google (seperti `gemini-1.5-flash`, `gemini-2.5-flash`). Namun logika ekspresi ternary hanya memanggil `sanitizeGeminiModel` jika `options.model` falsy. Ketika caller (misal dari request parameter, preset screener, atau bot) mengirimkan `options.model = 'gemini-1.5-flash'`, model deprecated tersebut lolos mentah-mentah ke URL endpoint Google. Akibatnya Google API menolak request dengan HTTP 404 Model Not Found, menyebabkan kegagalan analisis AI.
- **Bukti Test Nyata**:
  - Perintah: `node test/ai-gemini-provider-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-AGP-02 PROVEN: Deprecated model 'gemini-1.5-flash' must be sanitized and not sent in endpoint URL: https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyFakeKeyForTesting12345`
- **Usulan Perbaikan**: Bungkus `options.model` ke dalam sanitasi: `const model = sanitizeGeminiModel(options.model || process.env.GEMINI_MODEL, DEFAULT_GEMINI_MODEL);`.

---

### [BUG-AGP-03] Error di Tengah SSE Stream Ditelan, Menyebabkan Respon Terpotong Dianggap Berhasil atau Error 429 Hilang
- **Lokasi**: `lib/ai-gemini-provider.js:161-167, 323-327`
- **Kode Bermasalah**:
  ```javascript
  let text = null;
  try {
    const parsed = JSON.parse(jsonStr);
    text = parsed && parsed.candidates && parsed.candidates[0] && ...;
  } catch (_) {
    continue;
  }
  ```
- **Dampak ke User**: HIGH. Saat streaming respon via SSE, jika Google Gemini mengalami error di tengah jalan (seperti rate limit 429 `RESOURCE_EXHAUSTED` atau pemblokiran filter keamanan), Gemini mengirimkan event SSE berupa objek error: `data: {"error": {"code": 429, "message": "Resource has been exhausted"}}`. Parser mengabaikannya karena properti `candidates` tidak ada. Jika sebelum error sudah ada 1 kalimat yang terkirim, fungsi mengembalikan teks terpotong tersebut sebagai jawaban sukses tanpa ada peringatan bahwa koneksi diputus paksa. Jika belum ada teks, fungsi melempar `GEMINI_EMPTY_RESPONSE` alih-alih `GEMINI_RATE_LIMITED`, sehingga mekanisme circuit breaker dan delay rate-limit gagal terpicu.
- **Bukti Test Nyata**:
  - Perintah: `node test/ai-gemini-provider-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-AGP-03 PROVEN: Stream with mid-stream 429 error must throw GEMINI_RATE_LIMITED error, but got: no error (returned truncated success)`
- **Usulan Perbaikan**: Di dalam `parseSseStream`, deteksi keberadaan `parsed.error`: jika ada, parsing error code dan lempar exception yang sesuai agar downstream router dapat melakukan fallback atau backoff.

---

### [BUG-AGP-04] Validasi Kunci API Mengabaikan Spasi Kosong (`'   '`) dan Membakar Kuota Network
- **Lokasi**: `lib/ai-gemini-provider.js:34-39, 241-246`
- **Kode Bermasalah**:
  ```javascript
  const apiKey = options.apiKey !== undefined ? options.apiKey : getGeminiApiKey();
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY_MISSING');
    err.code = 'GEMINI_API_KEY_MISSING';
    throw err;
  }
  ```
- **Dampak ke User**: MEDIUM. Pengecekan `if (!apiKey)` menganggap string yang hanya berisi spasi (`'   '`) sebagai nilai truthy. Fungsi melanjutkan eksekusi dan memanggil endpoint Google dengan `?key=%20%20%20`. Google merespons dengan HTTP 400 Bad Request / API_KEY_INVALID setelah jeda network round-trip. Seharusnya validasi ini gagal secara lokal (fast-fail) dan melempar `GEMINI_API_KEY_MISSING` tanpa membuang waktu dan bandwidth jaringan.
- **Bukti Test Nyata**:
  - Perintah: `node test/ai-gemini-provider-bugs.test.js`
  - Output: `[FAIL - BUG PROVEN] BUG-AGP-04 PROVEN: Whitespace apiKey must throw GEMINI_API_KEY_MISSING locally without calling fetch (fetchCalled=true, got code=GEMINI_HTTP_ERROR)`
- **Usulan Perbaikan**: Normalisasi kunci dengan `.trim()` sebelum evaluasi: `const apiKey = String(options.apiKey !== undefined ? options.apiKey : (getGeminiApiKey() || '')).trim(); if (!apiKey) ...`.
# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 2 (AI & LLM Grounding)
Dokumentasi temuan bug Fase 2. Read-only kode produksi, dibuktikan lewat failing unit test di test/.

---

### BUG-NAR-01: Unhandled TypeError pada `narrateMonitorUpdate` saat `evaluation` bernilai null / undefined
- **File & Baris:** `lib/ai-narration.js:151`
- **Kutipan Kode:**
  ```javascript
  async function narrateMonitorUpdate(pick, evaluation, priceData) {
    const status = (evaluation.status || '').toUpperCase();
    if (isStaleOrExpired(pick, evaluation)) return { note: null, source: 'fallback', error: 'stale_or_expired' };
  ```
- **Dampak ke User:**
  Jika worker atau caller memanggil `narrateMonitorUpdate(pick, null)` atau evaluation gagal di-resolve, proses crash seketika dengan `TypeError: Cannot read properties of null (reading 'status')` sebelum proteksi `isStaleOrExpired` sempat berjalan. Notifikasi Telegram gagal terkirim / proses worker berhenti tak terduga.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-bugs.test.js`
  Hasil: `BUG-NAR-01 reproduced: threw unhandled exception: Cannot read properties of null (reading 'status')`.
- **Usulan Arah Perbaikan:**
  Gunakan optional chaining atau default object: `const status = String((evaluation && evaluation.status) || '').toUpperCase();` dan posisikan evaluasi setelah guard awal.

---

### BUG-NAR-02: `narrateMonitorUpdate` Menghapus Perhitungan `profit_pct` Saat `priceData` Kosong Meskipun TP Sudah Tercapai
- **File & Baris:** `lib/ai-narration.js:164-170`
- **Kutipan Kode:**
  ```javascript
  const entry1 = parseFloat(pick.entry1) || 0;
  const lastPrice = priceData && priceData.last ? priceData.last : 0;
  const tp1 = parseFloat(pick.tp1) || 0;
  let profitPct = null, lossPct = null;
  if (entry1 > 0 && lastPrice > 0) {
    if (status === 'TP1_HIT' || status === 'TP2_HIT') {
      const tp = status === 'TP2_HIT' ? (parseFloat(pick.tp2) || tp1) : tp1;
      profitPct = (((tp - entry1) / entry1) * 100).toFixed(2);
    }
  ```
- **Dampak ke User:**
  Saat event TP1_HIT atau TP2_HIT dipicu dari evaluasi internal tanpa melewatkan objek `priceData` (atau last = 0), `profit_pct` tidak dihitung (`null`). Akibatnya prompt ke AI tidak memuat data persentase cuan yang sebenarnya sudah pasti dari level target vs entry. AI menghasilkan narasi tanpa angka persentase keuntungan.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-bugs.test.js`
  Hasil: `profitPct requires lastPrice > 0 even when TP1/TP2 hit is determined by entry & target`.
- **Usulan Arah Perbaikan:**
  Hitung `profitPct` murni berbasis `entry1` dan `tp` tanpa mensyaratkan `lastPrice > 0` saat status TP HIT.

---

### BUG-NAR-03: Crash TypeError pada `generateNote` Saat Argumen `data` bernilai null / undefined
- **File & Baris:** `lib/ai-narration.js:122`
- **Kutipan Kode:**
  ```javascript
  const cacheKey = narrationCache.buildCacheKey({
    type: type, ticker: data.ticker, category: data.category || data.status,
    data: { entry1: data.entry1, ... }
  });
  ```
- **Dampak ke User:**
  Jika `generateNote` dipanggil tanpa payload data saat AI narration aktif, sistem melempar unhandled `TypeError: Cannot read properties of null (reading 'ticker')` alih-alih mengembalikan fallback `{ note: null, source: 'fallback' }`.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-bugs.test.js`
  Hasil: `BUG-NAR-03 reproduced: crashed on null data with Cannot read properties of null (reading 'ticker')`.
- **Usulan Arah Perbaikan:**
  Tambahkan guard: `const payload = data && typeof data === 'object' ? data : null; if (!payload) return { note: null, source: 'fallback', error: 'invalid_data' };`.

---

### BUG-ARG-01: `moneyFromMessage` Gagal Mengekstrak Dana Pada Kalimat Alami Multi-kata ("modal saya sebesar X juta")
- **File & Baris:** `lib/ai-runtime-grounding.js:77`
- **Kutipan Kode:**
  ```javascript
  const contextualMoney = /(?:budget|modal|dana|uang|saldo|kapital|simulasi)\s*(?:saya|aku|ku|sebesar|sekitar|senilai|=|:)?\s*(\d(?:[\d.,]*\d)?)(?:\s*(ribu|juta|miliar|triliun))/gi;
  ```
- **Dampak ke User:**
  User yang mengetik kalimat natural seperti `"Modal saya sebesar 50 juta"` menghasilkan array kosong `[]` karena kelompok non-capturing `(?:saya|aku|ku|sebesar|sekitar|senilai|=|:)?` hanya dapat mencocokkan tepat satu kata tanpa loop. Daya beli tidak terdeteksi, AI menjawab tidak tahu modal user padahal sudah diketik jelas.
- **Bukti Test Nyata:**
  `node --test test/ai-runtime-grounding-bugs.test.js`
  Hasil: `values: []`, gagal assert `[50000000]`.
- **Usulan Arah Perbaikan:**
  Gunakan pemisah fleksibel multi-kata: `(?:\s+(?:saya|aku|ku|sebesar|sekitar|senilai|=|:))+\s*`.

---

### BUG-ARG-02: `prepareRuntimeGrounding` Menghilangkan `calculation_facts` Pada Analisis Saham Tunggal (`stock_analysis`)
- **File & Baris:** `lib/ai-runtime-grounding.js:192-198`
- **Kutipan Kode:**
  ```javascript
  output.ai_answer_policy = answerPolicy(source);
  if (source === 'portfolio_chat') {
    output.calculation_facts = portfolioCalculationFacts(output);
    output.affordability_facts = affordabilityFacts(output, message);
  }
  return output;
  ```
- **Dampak ke User:**
  `answerPolicy` menginstruksikan LLM: *"Angka hanya boleh berasal dari snapshot atau calculation_facts."* Namun untuk modul `stock_analysis`, `calculation_facts` dibiarkan `undefined`. AI tidak menerima fakta perhitungan rasio risk/reward yang deterministik dan rentan berhalusinasi atau menolak menjawab metrik risiko.
- **Bukti Test Nyata:**
  `node --test test/ai-runtime-grounding-bugs.test.js`
  Hasil: `calculation_facts` bernilai `undefined`.
- **Usulan Arah Perbaikan:**
  Import `stockFacts` dari `ai-eval-derived-facts.js` dan isi `output.calculation_facts = { stock: stockFacts(output) }` saat `source !== 'portfolio_chat'`.

---

### BUG-ARG-03: `portfolioCalculationFacts` Menghilangkan Metrik `budgetFacts` dari Kontrak Runtime Grounding
- **File & Baris:** `lib/ai-runtime-grounding.js:168-176`
- **Kutipan Kode:**
  ```javascript
  function portfolioCalculationFacts(context) {
    const source = context && typeof context === 'object' ? context : {};
    const plans = Array.isArray(source.plans) ? source.plans : [];
    const simulation = source.simulation && typeof source.simulation === 'object' ? source.simulation : null;
    return compact({
      policy: 'Semua angka turunan dihitung deterministik dari snapshot. Jangan pakai bila basis datanya tidak tersedia.',
      market_rules: { shares_per_lot: SHARES_PER_LOT },
      plans: plans.map((plan) => planFacts(plan, simulation))
    });
  }
  ```
- **Dampak ke User:**
  Berbeda dari evaluator evaluasi (`ai-eval-derived-facts.js:186-193`), modul runtime grounding ini lupa menyertakan `budgetFacts(source)`. Alokasi modal per posisi dan porsi dana cadangan hilang dari grounding runtime portfolio chat.
- **Bukti Test Nyata:**
  `node --test test/ai-runtime-grounding-bugs.test.js`
  Hasil: `calculation_facts.budget` bernilai `undefined`.
- **Usulan Arah Perbaikan:**
  Import `budgetFacts` dari `ai-eval-derived-facts.js` dan tambahkan properti `budget: budgetFacts(source)` pada objek yang di-compact.

---

### BUG-ARG2-01: `addPerShareFacts` Menggunakan Fallback `plans[index]` Mengakibatkan Kontaminasi Metrik Antar-Saham yang Berbeda
- **File & Baris:** `lib/ai-runtime-grounding-v2.js:37`
- **Kutipan Kode:**
  ```javascript
  facts.forEach((fact, index) => {
    const factTicker = tickerKey(fact && fact.ticker);
    const plan = (factTicker && plansByTicker.get(factTicker)) || plans[index] || {};
    const entry = levelOf(plan, ['entryPriceIdr', 'entry_price', 'entry', 'avgPriceIdr']);
  ```
- **Dampak ke User:**
  Jika sebuah ticker di `calculation_facts.plans` (misal GOTO) tidak ditemukan di `plansByTicker`, kode menggunakan fallback `plans[index]` (misal BBRI). Akibatnya angka risiko per lembar (`loss_to_stop_per_share_idr`) dan target keuntungan (`tp1_gain_per_share_idr`) milik BBRI dilekatkan ke fakta saham GOTO. AI akan menjelaskan batas risiko dan target harga yang salah fatal ke user.
- **Bukti Test Nyata:**
  `node --test test/ai-runtime-grounding-v2-bugs.test.js`
  Hasil: `GOTO must not inherit BBRI's loss_to_stop_per_share_idr, got 300`.
- **Usulan Arah Perbaikan:**
  Hapus fallback `|| plans[index]`. Jika `factTicker` tidak cocok dengan entri manapun di `plansByTicker`, gunakan objek kosong `{}`.

---

### BUG-ARG2-02: `levelOf` pada `addPerShareFacts` Mengabaikan Alias Standar Stop Loss `sl`
- **File & Baris:** `lib/ai-runtime-grounding-v2.js:39`
- **Kutipan Kode:**
  ```javascript
  const stop = levelOf(plan, ['stopLossIdr', 'stop_loss', 'stop']);
  ```
- **Dampak ke User:**
  Banyak payload trading plan menggunakan kunci `sl` (misal `{ ticker: 'BBRI', entry: 5000, sl: 4700 }`). Karena `sl` tidak ada di daftar pengecekan `levelOf`, variabel `stop` bernilai `null`. Kalkulasi `loss_to_stop_per_share_idr` tidak pernah terhitung (`undefined`), sehingga AI tidak menerima fakta nominal risiko per lembar.
- **Bukti Test Nyata:**
  `node --test test/ai-runtime-grounding-v2-bugs.test.js`
  Hasil: `addPerShareFacts should compute 300 from entry 5000 and sl 4700, got undefined`.
- **Usulan Arah Perbaikan:**
  Tambahkan `'sl'` dan `'stopLoss'` ke dalam array pencarian: `['stopLossIdr', 'stop_loss', 'stop', 'sl', 'stopLoss']`.

---

### BUG-EDF-01: `stockFacts` Mengabaikan Field Alias Standar Screener `entry1`, `entry2`, dan `sl`
- **File & Baris:** `lib/ai-eval-derived-facts.js:160-163`
- **Kutipan Kode:**
  ```javascript
  const entry = recursiveFind(source, new Set(['entry', 'entryprice', 'entry_price', 'entrylow', 'entry_low', 'entrypriceidr']));
  const entryHigh = recursiveFind(source, new Set(['entryhigh', 'entry_high']));
  const stop = recursiveFind(source, new Set(['stop', 'stoploss', 'stop_loss', 'stoplossidr']));
  ```
- **Dampak ke User:**
  Di seluruh ekosistem Auto-Cuan (screener daytrade, swing, monitor pick), sinyal menggunakan alias `entry1`, `entry2`, dan `sl`. Karena ketiga kunci ini tidak ada di lookup Set, pemanggilan `stockFacts(pick)` menghasilkan fakta harga kosong (`entry_price: undefined`, `stop_loss: undefined`), sehingga seluruh metrik `risk_per_share`, `reward_to_tp1`, dan `risk_reward_tp1` hangus/kosong.
- **Bukti Test Nyata:**
  `node --test test/ai-eval-derived-facts-bugs.test.js`
  Hasil: `entry_price` dan `stop_loss` undefined.
- **Usulan Arah Perbaikan:**
  Tambahkan `'entry1'`, `'entry2'` ke Set entry, dan tambahkan `'sl'` ke Set stop.

---

### BUG-EDF-02: Simulasi `planFacts` Menghasilkan Nilai Null untuk Semua Total Posisi Pada Rencana Saham Baru / Watchlist
- **File & Baris:** `lib/ai-eval-derived-facts.js:125-132`
- **Kutipan Kode:**
  ```javascript
  const totalLots = lots != null && addLots != null ? lots + addLots : null;
  const totalShares = shares != null && addShares != null ? shares + addShares : null;
  const totalCapital = capital != null && additionalCapital != null ? capital + additionalCapital : null;
  const averageEntry = totalCapital != null && totalShares != null && totalShares > 0
    ? totalCapital / totalShares
    : null;
  ```
- **Dampak ke User:**
  Jika user membuat simulasi pembelian pada saham watchlist yang belum dimiliki (`lots` = null atau 0), kondisi `lots != null` bernilai false. Akibatnya `totalLots`, `totalShares`, `totalCapital`, dan `averageEntry` semuanya bernilai `null` dan dihapus oleh `compactObject`. Simulasi pembelian baru tidak menghasilkan estimasi posisi apapun ke AI.
- **Bukti Test Nyata:**
  `node --test test/ai-eval-derived-facts-bugs.test.js`
  Hasil: `facts.simulation.total_lots` undefined.
- **Usulan Arah Perbaikan:**
  Hitung akumulasi dengan memperlakukan lot/modal eksisting yang belum ada sebagai 0: `const totalLots = addLots != null ? (lots || 0) + addLots : null;`.

---

### BUG-NAV-01: `stripClockReferences` Menghapus Harga Saham dan Persentase Berdesimal Dua (`X.YY` di mana `X <= 23` dan `YY <= 59`)
- **File & Baris:** `lib/ai-narration-validator.js:43-48`
- **Kutipan Kode:**
  ```javascript
  function stripClockReferences(text) {
    return String(text || '').replace(/\b(?:[01]?\d|2[0-3])[:.]\d{2}\b/g, function(token) {
      var parts = token.split(/[:.]/);
      var minute = Number(parts[1]);
      return minute >= 0 && minute <= 59 ? ' ' : token;
    });
  }
  ```
- **Dampak ke User:**
  Setiap angka harga saham atau level floating point seperti `18.30`, `14.50`, `0.05`, `22.15` yang dihasilkan model dianggap sebagai jam/menit (`18:30`) dan dihapus. Jika AI mengarang harga palsu di rentang ini, validator gagal mendeteksinya (`valid: true`) dan angka halusinasi lolos ke channel Telegram.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-validator-bugs.test.js`
  Hasil: `assert.strictEqual(result.valid, false)` gagal; validator meloloskan `18.30`.
- **Usulan Arah Perbaikan:**
  Hanya bersihkan token waktu bila didahului indikator jam/waktu (misal `jam`, `pukul`, `wib`) atau bila menggunakan titik dua `:` sebagai pemisah.

---

### BUG-NAV-02: Pengecualian Tanggal 0â€“31 Meloloskan Angka Harga dan Persentase Palsu Tanpa Konteks Kalender
- **File & Baris:** `lib/ai-narration-validator.js:175-177`
- **Kutipan Kode:**
  ```javascript
  var fabricatedNumbers = aiNumbers.filter(function(n) {
    if (sourceNumbers.has(n)) return false;
    var num = parseFloat(n);
    // Day-of-month references.
    if (num >= 0 && num <= 31) return false;
  ```
- **Dampak ke User:**
  Seluruh angka antara 0 hingga 31 dianggap "tanggal" tanpa verifikasi apakah angka tersebut integer atau didampingi nama bulan. Akibatnya, harga saham FCA (misal 15, 25 rupiah), target persentase profit/cut loss palsu (10%, 25%), atau lot karangan (misal 5 lot) bebas dari deteksi angka halusinasi.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-validator-bugs.test.js`
  Hasil: `assert.strictEqual(result.valid, false)` gagal; teks `Disiplin cut loss di level 25 rupiah` lolos validasi.
- **Usulan Arah Perbaikan:**
  Pastikan pengecualian tanggal hanya berlaku untuk bilangan bulat (`Number.isInteger(num)`) dan didampingi token nama bulan/kalender.

---

### BUG-NAV-03: `validateNote` Mengabaikan Objek Bersarang pada `sourceData`, Menolak Angka Sah Valid
- **File & Baris:** `lib/ai-narration-validator.js:161-172`
- **Kutipan Kode:**
  ```javascript
  for (var key of Object.keys(sourceData)) {
    var val = sourceData[key];
    if (val == null) continue;
    if (typeof val === 'number' && isFinite(val)) { ... }
    else if (typeof val === 'string') { ... }
  }
  ```
- **Dampak ke User:**
  Jika payload sinyal memiliki metadata bersarang seperti `sourceData.levels = { support: 4500 }`, angka `4500` diabaikan dari daftar sumber sah. AI yang sah menyebut support `4500` akan ditolak oleh validator dengan alasan `fabricated_numbers`, memicu fallback kosong ke user.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-validator-bugs.test.js`
  Hasil: `assert.strictEqual(result.valid, true)` gagal dengan error `fabricated_numbers`.
- **Usulan Arah Perbaikan:**
  Gunakan penelusuran rekursif untuk mengekstrak angka dari properti bersarang dalam `sourceData`.

---

### BUG-NAC-01: Crash TypeError pada `buildCacheKey` Saat Dipanggil Tanpa Argumen atau bernilai null
- **File & Baris:** `lib/ai-narration-cache.js:30-33`
- **Kutipan Kode:**
  ```javascript
  function buildCacheKey(params) {
    const parts = [
      String(params.type || 'unknown'),
  ```
- **Dampak ke User:**
  Pemanggilan `buildCacheKey()` atau `buildCacheKey(null)` langsung melempar unhandled `TypeError: Cannot read properties of null (reading 'type')`, merusak flow caching narasi AI.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-cache-prompts-bugs.test.js`
  Hasil: `BUG-NAC-01 reproduced: crashed with Cannot read properties of null (reading 'type')`.
- **Usulan Arah Perbaikan:**
  Default argument: `function buildCacheKey(params = {}) { const p = params || {}; ... }`.

---

### BUG-NAC-02: `buildCacheKey` Menghilangkan Seluruh Properti Objek Bersarang Akibat Array Replacer `JSON.stringify`
- **File & Baris:** `lib/ai-narration-cache.js:38-41`
- **Kutipan Kode:**
  ```javascript
  if (params.data && typeof params.data === 'object') {
    const sorted = JSON.stringify(params.data, Object.keys(params.data).sort());
    const hash = crypto.createHash('md5').update(sorted).digest('hex').slice(0, 12);
  ```
- **Dampak ke User:**
  Array replacer pada `JSON.stringify` di JavaScript berfungsi sebagai whitelist kunci. Saat rekursi masuk ke objek bersarang (misal `{ nested: { val: 100 } }`), kunci di dalam anak tidak ada di whitelist tingkat atas, sehingga seluruh properti anak dihapus. Dua payload dengan data bersarang berbeda menghasilkan cache key yang identik (tabrakan cache/stale response).
- **Bukti Test Nyata:**
  `node --test test/ai-narration-cache-prompts-bugs.test.js`
  Hasil: `assert.notStrictEqual(key1, key2)` gagal karena kedua key sama persis (`signal|BBRI||408e08d5e8f4`).
- **Usulan Arah Perbaikan:**
  Urutkan objek bersarang secara deterministik tanpa array replacer `JSON.stringify`.

---

### BUG-NAP-01: Crash TypeError pada `buildNotePrompt` Saat Argumen `data` bernilai null / undefined
- **File & Baris:** `lib/ai-narration-prompts.js:63-64`
- **Kutipan Kode:**
  ```javascript
  function buildNewSignalNotePrompt(data) {
    var category = (data.category || 'Swing').toUpperCase();
  ```
- **Dampak ke User:**
  Jika template prompt dipanggil dengan data tidak lengkap atau null, sistem crash seketika melempar unhandled `TypeError: Cannot read properties of null (reading 'category')`.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-cache-prompts-bugs.test.js`
  Hasil: `BUG-NAP-01 reproduced: crashed on null data with Cannot read properties of null (reading 'category')`.
- **Usulan Arah Perbaikan:**
  Defensif guard `var d = data || {};`.

---

### BUG-NAP-02: `buildNotePrompt` Case-Sensitive Mengabaikan Event Notifikasi Huruf Besar (`TP1_HIT`, `SL_HIT`, `ENTRY_HIT`)
- **File & Baris:** `lib/ai-narration-prompts.js:33-47`
- **Kutipan Kode:**
  ```javascript
  switch (type) {
    case 'tp1_hit':
      return buildTp1HitNotePrompt(data);
    case 'sl_hit':
  ```
- **Dampak ke User:**
  Event dari screener atau webhook sering kali berstatus uppercase (`TP1_HIT`, `SL_HIT`). Karena perbandingan `switch` bersifat case-sensitive, pemanggilan ini jatuh ke `default: buildGenericNotePrompt`, menghilangkan instruksi khusus pengamanan profit dan trailing stop.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-cache-prompts-bugs.test.js`
  Hasil: prompt TP1_HIT menghasilkan teks generic `Notifikasi tipe "TP1_HIT"` alih-alih instruksi target profit.
- **Usulan Arah Perbaikan:**
  Normalisasi tipe ke huruf kecil: `switch (String(type || '').toLowerCase())`.

---

### BUG-AAC-01: `numberTokenRegex` Membuang Tanda Negatif pada Persentase dan Angka Finansial Risiko
- **File & Baris:** `lib/ai-answer-contract.js:84-86`
- **Kutipan Kode:**
  ```javascript
  function numberTokenRegex() {
    return /\b(?:rp|idr)\s*\d(?:[\d.,]*\d)?(?:\s*(?:ribu|juta|miliar|triliun))?(?:\s*rupiah)?(?:\s*[xÃ—%])?|(?<![A-Za-z0-9_])\d(?:[\d.,]*\d)?(?:\s*(?:ribu|juta|miliar|triliun))?(?:\s*rupiah)?(?:\s*[xÃ—%])?(?![A-Za-z0-9_])/gi;
  }
  ```
- **Dampak ke User:**
  Regex tidak menangkap tanda `-`. Angka risiko seperti `-5%` diekstrak sebagai angka positif `5`. Saat divalidasi terhadap `allowed_numbers` yang mencantumkan batas risiko `-5`, pembanding `nearlyEqual(5, -5)` gagal, menyebabkan jawaban AI yang sah ditolak dengan error `angka finansial tidak didukung sumber: 5`.
- **Bukti Test Nyata:**
  `node --test test/ai-answer-contract-cache-bugs.test.js`
  Hasil: `assert.deepStrictEqual([5], [-5])` gagal.
- **Usulan Arah Perbaikan:**
  Dukung tanda negatif opsional pada regex: `[+-]?`.

---

### BUG-AAC-02: `parseMatchedNumber` Membuang Pengali Skala pada Konteks Finansial Non-Moneter ("10 juta lembar")
- **File & Baris:** `lib/ai-answer-contract.js:106-107`
- **Kutipan Kode:**
  ```javascript
  const base = parseNumberToken(text);
  if (base == null) return null;
  if (scale && (explicitCurrency || MONETARY_SCALE_CONTEXT.test(context || ''))) return base * scale;
  return base;
  ```
- **Dampak ke User:**
  Untuk frasa seperti `"Volume transaksi 10 juta lembar"`, karena tidak ada kata mata uang rupiah dalam `MONETARY_SCALE_CONTEXT`, skala `juta` diabaikan dan fungsi mengembalikan angka `10`. Downstream validator menganggap angka `10` adalah angka finansial liar yang tidak terdaftar di snapshot, lalu membatalkan respons AI.
- **Bukti Test Nyata:**
  `node --test test/ai-answer-contract-cache-bugs.test.js`
  Hasil: `assert.deepStrictEqual([10], [10000000])` gagal.
- **Usulan Arah Perbaikan:**
  Bila kata skala (`ribu`, `juta`, `miliar`) secara eksplisit tertulis setelah angka, selalu kalikan dengan skala yang sesuai.

---

### BUG-AC-01: Crash RangeError pada `setCachedAnalysis` Saat `ttlSeconds` Bernilai `NaN`
- **File & Baris:** `lib/ai-analysis-cache.js:90-97`
- **Kutipan Kode:**
  ```javascript
  const ttlSeconds = typeof params.ttlSeconds === 'number'
    ? params.ttlSeconds
    : DEFAULT_TTL_SECONDS;

  const now = Date.now();
  const expiresAtMs = now + (ttlSeconds * 1000);
  const expiresAtIso = new Date(expiresAtMs).toISOString();
  ```
- **Dampak ke User:**
  Di JavaScript, `typeof NaN === 'number'` bernilai `true`. Jika caller melewatkan `ttlSeconds` hasil kalkulasi yang menjadi `NaN`, `new Date(NaN).toISOString()` seketika melempar unhandled `RangeError: Invalid time value` yang mematikan serverless runner / proses Node.js.
- **Bukti Test Nyata:**
  `node --test test/ai-answer-contract-cache-bugs.test.js`
  Hasil: `BUG-AC-01 reproduced: crashed with Invalid time value`.
- **Usulan Arah Perbaikan:**
  Gunakan pengecekan ketat `Number.isFinite(params.ttlSeconds)`.

---

### BUG-AC-02: `getCachedAnalysis` Tidak Menghapus Entri Kedaluwarsa dari `memoryCache` Saat Dibaca
- **File & Baris:** `lib/ai-analysis-cache.js:48-52`
- **Kutipan Kode:**
  ```javascript
  const mem = memoryCache.get(cacheKey);
  if (mem && mem.expiresAt > now) {
    return Object.assign({}, mem.payload, { source: 'db_cache', cache_hit: true });
  }
  ```
- **Dampak ke User:**
  Jika sebuah entri memori kedaluwarsa (`mem.expiresAt <= now`), fungsi hanya melewatinya ke DB tanpa melakukan `memoryCache.delete(cacheKey)`. Memori cache terus membengkak (memory leak) seiring waktu tanpa pernah dibersihkan saat cache miss.
- **Bukti Test Nyata:**
  `node --test test/ai-answer-contract-cache-bugs.test.js`
  Hasil: `getCachedAnalysis does not prune expired item from memoryCache on read`.
- **Usulan Arah Perbaikan:**
  Tambahkan pembersihan langsung: `if (mem && mem.expiresAt <= now) memoryCache.delete(cacheKey);`.

---

### BUG-UAC-01: Tidak Ada Validasi `userId` pada `saveUserApiKey` dan `getUserApiKey` Mengakibatkan Kebocoran Kredensial Lintas Sesi Anonim
- **File & Baris:** `lib/user-ai-credentials.js:103-144` & `lib/user-ai-credentials.js:146-191`
- **Kutipan Kode:**
  ```javascript
  async function saveUserApiKey(db, userId, rawKey, provider = 'gemini') {
    const validation = validateApiKey(rawKey);
    if (!validation.ok) {
      return { ok: false, status: 400, error: validation.error };
    }
    // ...
    fallbackMemoryStore.set(`${userId}:${provider}`, { encryptedKey: encrypted, keyHint: hint, updatedAt: now });
  ```
- **Dampak ke User:**
  Jika caller tidak mengirimkan `userId` (`undefined`, `null`, atau string kosong), API key tetap disimpan dengan kunci `undefined:gemini`. Sesi anonim lain yang memanggil `getUserApiKey` tanpa `userId` akan mendapatkan kredensial dan API key privat pengguna tersebut.
- **Bukti Test Nyata:**
  `node --test test/user-ai-credentials-bugs.test.js`
  Hasil: `saveUserApiKey should reject undefined userId` gagal (`AssertionError [ERR_ASSERTION]: 'saveUserApiKey should reject undefined userId': true == false`).
- **Usulan Arah Perbaikan:**
  Tambahkan validasi awal: `if (!userId || typeof userId !== 'string' || !userId.trim()) return { ok: false, status: 400, error: 'User ID wajib diisi.' };`.

---

### BUG-UAC-02: `isSubscribedTier` Mengabaikan Status Pelanggan Aktif Recurring (Non-Lifetime) Sehingga Menolak Akses App Key
- **File & Baris:** `lib/user-ai-credentials.js:206-216`
- **Kutipan Kode:**
  ```javascript
  function isSubscribedTier(access) {
    if (!access) return false;
    const user = access.user || {};
    const username = String(user.username || '').trim().toLowerCase();
    const isAdmin = user.isAdmin === true;
    const entitlement = access.entitlement || {};
    if (isAdmin || username === 'budi') return true;
    if (entitlement.lifetime_state === 'active' || entitlement.lifetime_state === 'lifetime' || entitlement.current_plan === 'lifetime') return true;
    if (access.premium === true || entitlement.premium === true) return true;
    return false;
  }
  ```
- **Dampak ke User:**
  Pengguna berlangganan bulanan/tahunan aktif yang memiliki record entitlement `current_plan: 'pro'` atau `status: 'active'` (namun bukan tipe lifetime dan flag `premium` tidak bernilai true eksplisit) dianggap sebagai tier `'free'`. Pengguna berbayar ditolak menggunakan application AI key dan dipaksa memasukkan personal BYOK key sendiri.
- **Bukti Test Nyata:**
  `node --test test/user-ai-credentials-bugs.test.js`
  Hasil: `Active recurring subscriber should be recognized as subscribed tier` gagal (`AssertionError [ERR_ASSERTION]: 'Active recurring subscriber should be recognized as subscribed tier': false == true`).
- **Usulan Arah Perbaikan:**
  Periksa status aktif recurring plan: `if (entitlement.status === 'active' && (entitlement.current_plan === 'pro' || entitlement.current_plan === 'vip')) return true;`.

---

### BUG-AL-01: `routeIntent` Menggunakan Regex Case-Insensitive `/^[A-Z]{1,5}$/i` Mengalihkan Sapaan Singkat Menjadi `ticker_only` ("HALO terdeteksi")
- **File & Baris:** `lib/analyze-legacy.js:387-404`
- **Kutipan Kode:**
  ```javascript
  // If, after stripping enrichment, the user's actual text is just a ticker
  // symbol (1-5 uppercase letters) or an index alias, treat as ticker_only
  // (which lets the deterministic template fire). Never a follow-up.
  var bareTickerOnly = /^[A-Z]{1,5}$/i.test(msg) || /^(IHSG|JKSE|JCI|COMPOSITE)$/i.test(msg);
  // ...
  if (bareTickerOnly) {
    return 'ticker_only';
  }
  ```
- **Dampak ke User:**
  Setiap kata sapaan atau instruksi umum beranggotakan 1-5 karakter (misalnya "halo", "hai", "pagi", "oke", "siap", "beli", "cut") lolos regex `/^[A-Z]{1,5}$/i` dan dianggap sebagai ticker saham. Akibatnya intent casual chat terpotong, dan bot menjawab aneh: `"HALO terdeteksi. Harga sekarang berapa? Contoh: 'WMUU 58'"`.
- **Bukti Test Nyata:**
  `node --test test/analyze-legacy-bugs.test.js`
  Hasil: `Greeting "halo" must not be routed to ticker_only` gagal (`AssertionError [ERR_ASSERTION]: 'Greeting "halo" must not be routed to ticker_only': 'ticker_only' !== 'ticker_only'`).
- **Usulan Arah Perbaikan:**
  Hapus flag `/i` agar ticker murni kapital atau periksa kata-kata umum / sapaan sebelum mencocokkan ticker.

---

### BUG-AL-02: `buildStockFixedTemplate` Tidak Memetakan Field `prevClose` dari `parseMarketDataFromMessage` ke `deriveCandlePotentialRange` Sehingga ARA/ARB Selalu "Belum tersedia"
- **File & Baris:** `lib/analyze-legacy.js:664-672`
- **Kutipan Kode:**
  ```javascript
  var execReality = _idxTick.deriveCandlePotentialRange({
    previousClose: d.previousClose,
    previous_close: d.previous_close,
    prev_close: d.prev_close,
    prior_close: d.prior_close,
    close_prev: d.close_prev,
    current_price: d.last || d.close || d.currentPrice,
    // ...
  });
  ```
- **Dampak ke User:**
  Fungsi `parseMarketDataFromMessage` mengekstrak data harga penutupan sebelumnya ke field `prevClose`. Saat `buildStockFixedTemplate` memanggil `deriveCandlePotentialRange`, field yang dioper adalah `previousClose` (dengan 'ious') dan snake_case lainnya, sedangkan `d.prevClose` diabaikan. Akibatnya `previousClose` selalu undefined, dan kartu kalkulasi ARA/ARB selalu gagal terhitung dengan output `"ARA/ARB: Belum tersedia"`.
- **Bukti Test Nyata:**
  `node --test test/analyze-legacy-bugs.test.js`
  Hasil: `ARA/ARB should be computed when prevClose is present in market data` gagal (`AssertionError [ERR_ASSERTION]: 'ARA/ARB should be computed when prevClose is present in market data': false == true`).
- **Usulan Arah Perbaikan:**
  Tambahkan pemetaan properti `d.prevClose`: `previousClose: d.previousClose || d.prevClose`.

---

### BUG-CR4-01: `stockContext` Menolak Simbol Indeks Bertanda Caret (`^JKSE`) Sehingga AI Chat Analisis IHSG Menolak Snapshot Valid
- **File & Baris:** `lib/context-ai-router-v4.js:397-400`
- **Kutipan Kode:**
  ```javascript
  function stockContext(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const ticker = clean(input.ticker, 10).toUpperCase().replace(/\.JK$/i, '');
    // ...
    return {
      ticker: /^(IHSG|[A-Z]{3,5})$/.test(ticker) ? ticker : '',
  ```
- **Dampak ke User:**
  Simbol resmi Yahoo Finance dan feed market data IHSG adalah `^JKSE`. Karena ekspresi reguler `/^(IHSG|[A-Z]{3,5})$/` menolak karakter caret `^`, `ticker` dikosongkan menjadi string kosong `''`. Di baris 511, `handleContextAI` mengecek `!context.ticker` dan langsung menolak permintaan follow-up dengan HTTP 400 `AI_STOCK_SNAPSHOT_MISSING: "Jalankan analisis ticker terlebih dahulu..."` padahal snapshot analisis IHSG valid.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v4-bugs.test.js`
  Hasil: `BUG-CR4-01: stockContext must support index ticker ^JKSE` gagal (`AssertionError: stockContext must accept ^JKSE but got ""`).
- **Usulan Arah Perbaikan:**
  Dukung format simbol indeks: `return /^(\^[A-Z]{4}|IHSG|[A-Z]{3,5})$/.test(ticker) ? ticker : '';`.

---

### BUG-CR4-02: `portfolioContext` Menghilangkan Field Standar Portofolio `stop_loss`, `sl`, dan `capital` Menjadi Null
- **File & Baris:** `lib/context-ai-router-v4.js:349-365`
- **Kutipan Kode:**
  ```javascript
  const plans = (Array.isArray(input.plans) ? input.plans : []).slice(0, 25).map((p) => {
    // ...
    return {
      ticker,
      entry: number(p.entryPriceIdr != null ? p.entryPriceIdr : p.entry),
      stop_loss: number(p.stopLossIdr != null ? p.stopLossIdr : p.stop),
      // ...
      capital: number(p.capitalIdr),
      position_status: clean(p.positionStatus || p.position_status, 40),
      source: clean(p.source, 30)
    };
  }).filter(Boolean);
  ```
- **Dampak ke User:**
  Model data portofolio dari Supabase dan store klien menggunakan field `stop_loss`, `sl`, dan `capital`. Pemetaan di `portfolioContext` hanya memeriksa `stopLossIdr` / `stop` dan `capitalIdr`. Akibatnya `stop_loss` dan `capital` selalu ter-resolve menjadi `null`. LLM menerima data tanpa batas risiko dan alokasi modal, lalu menjawab tidak mengetahui stop loss atau modal posisi pengguna.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v4-bugs.test.js`
  Hasil: `BUG-CR4-02: portfolioContext must preserve standard fields stop_loss, sl, and capital` gagal (`AssertionError: plan.stop_loss must be 4500, got null`).
- **Usulan Arah Perbaikan:**
  Dukung alias standar:
  `stop_loss: number(p.stopLossIdr != null ? p.stopLossIdr : (p.stop_loss != null ? p.stop_loss : (p.sl != null ? p.sl : p.stop)))`
  `capital: number(p.capitalIdr != null ? p.capitalIdr : p.capital)`.

---

### BUG-CR5-01: `allPrimaryFailuresAreTemporary` Tidak Menduplikasi Array Model yang Dicoba Mengakibatkan Kegagalan 1 Model Tunggal Dianggap Sebagai Pemadaman Provider Penuh
- **File & Baris:** `lib/context-ai-router-v5.js:138-147`
- **Kutipan Kode:**
  ```javascript
  function allPrimaryFailuresAreTemporary(payload, trace) {
    if (!payload || payload.code !== 'AI_MODELS_FAILED_SAFE_STOP') return false;
    const attempted = Array.isArray(payload.attempted_models) ? payload.attempted_models.filter(Boolean) : [];
    if (attempted.length < 2) return false;
    const rows = trace && Array.isArray(trace.rejections) ? trace.rejections : [];
    return attempted.every((model) => {
      const matches = rows.filter((row) => row && row.model === model && row.provider_host === 'weizerouter.web.id');
      return matches.length > 0 && matches.every((row) => row.temporary_unavailable === true);
    });
  }
  ```
- **Dampak ke User:**
  Jika satu model (misal `wz/gpt-5.6-luna`) gagal dan dilakukan retry kompatibilitas parameter, `payload.attempted_models` memuat dua entri model yang sama (`['wz/gpt-5.6-luna', 'wz/gpt-5.6-luna']`). Karena fungsi tidak melakukan deduplikasi unik, `attempted.length < 2` lolos dan fungsi menyimpulkan bahwa seluruh model primer telah gagal serentak, lalu memicu emergency spillover atau penghentian paksa padahal model cadangan lainnya belum pernah dicoba sama sekali.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v5-bugs.test.js`
  Hasil: `BUG-CR5-01: allPrimaryFailuresAreTemporary must require at least 2 distinct models` gagal (`AssertionError: allPrimaryFailuresAreTemporary must return false when only 1 distinct model was attempted: true == false`).
- **Usulan Arah Perbaikan:**
  Deduplikasi array model: `const attempted = dedupe(Array.isArray(payload.attempted_models) ? payload.attempted_models.filter(Boolean) : []);`.

---

### BUG-CR5-02: `redactDiagnostic` Mengabaikan Redaksi Kunci API Google Gemini (`AIza...`) Pada Log Diagnostik
- **File & Baris:** `lib/context-ai-router-v5.js:98-107`
- **Kutipan Kode:**
  ```javascript
  function redactDiagnostic(value) {
    return String(value == null ? '' : value)
      .replace(/Bearer\s+[A-Za-z0-9._~+\/=\-]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:wz|sk(?:-[A-Za-z0-9]+)*)-[A-Za-z0-9._\-]{8,}\b/g, '[REDACTED_KEY]')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_TOKEN]')
  ```
- **Dampak ke User:**
  Regex redaksi hanya mengantisipasi prefix OpenAI/Weize (`sk-`, `wz-`). Pesan error provider yang mencantumkan kunci Google Gemini pengguna (`AIzaSy...`) lolos dari redaksi dan tercetak mentah ke log server `console.warn`, mengekspos kredensial API key privat pengguna ke log produksi.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v5-bugs.test.js`
  Hasil: `BUG-CR5-02: redactDiagnostic must redact Google Gemini API keys (AIza...)` gagal.
- **Usulan Arah Perbaikan:**
  Tambahkan pembersihan kunci Gemini: `.replace(/\b(?:AIza|AQ)[A-Za-z0-9_\-\.]{15,}\b/g, '[REDACTED_KEY]')`.

---

### BUG-CR6-01: `FALLBACK_CODES` Menghilangkan `AI_UNEXPECTED_ERROR` Sehingga Error 500 dari Provider Tidak Memicu Fallback Lokal
- **File & Baris:** `lib/context-ai-router-v6.js:18-29` & `lib/context-ai-router-v6.js:148-156`
- **Kutipan Kode:**
  ```javascript
  const FALLBACK_CODES = new Set([
    'AI_MODELS_FAILED_SAFE_STOP',
    'AI_ALL_MODELS_TIMED_OUT',
    'AI_PROVIDER_TEMPORARILY_UNAVAILABLE',
    'AI_RECENT_FAILURE',
    'AI_TIMEOUT_NO_RETRY',
    'AI_REQUEST_ERROR'
  ]);
  // ...
  function shouldUseLocalFallback(req, statusCode, payload) {
    // ...
    const code = payload && payload.code;
    return !code || FALLBACK_CODES.has(code);
  }
  ```
- **Dampak ke User:**
  Bila upstream router (V4/V5) menangkap exception jaringan atau provider crash pada blok `catch`, router mengembalikan status HTTP 500 dengan `code: 'AI_UNEXPECTED_ERROR'`. Karena kode ini tidak didaftarkan dalam `FALLBACK_CODES`, `shouldUseLocalFallback` menghasilkan `false`. Fallback lokal snapshot yang dirancang untuk menyelamatkan respons pengguna saat provider AI crash justru dibatalkan dan pengguna menerima galat 500 mentah.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v6-bugs.test.js`
  Hasil: `BUG-CR6-01: shouldUseLocalFallback must support AI_UNEXPECTED_ERROR from upstream router` gagal (`AssertionError: shouldUseLocalFallback must return true for AI_UNEXPECTED_ERROR on status 500: false == true`).
- **Usulan Arah Perbaikan:**
  Tambahkan `'AI_UNEXPECTED_ERROR'` ke dalam `FALLBACK_CODES`.

---

### BUG-CR6-02: `extractSnapshotFacts` Menangkap Angka '2' dari `Entry 2` Sebagai Nilai `entry` (Rp 2) Saat Entry 1 Tidak Ditemukan
- **File & Baris:** `lib/context-ai-router-v6.js:77-83`
- **Kutipan Kode:**
  ```javascript
  const priceToken = '([0-9][0-9.,]*(?:\\s*[â€“-]\\s*[0-9][0-9.,]*)?)';
  const make = (label) => new RegExp(label + '\\s*(?::|=)?\\s*' + priceToken, 'i');
  // ...
  entry: firstMatch(text, [
    make('entry\\s*\\/\\s*konfirmasi'), make('area\\s+entry'), make('entry\\s+zone'), make('entry\\s*1?'), make('konfirmasi')
  ]),
  ```
- **Dampak ke User:**
  Pola `make('entry\\s*1?')` menggunakan kuantifier opsional `1?`. Bila snapshot hanya memiliki baris `Entry 2: 4400` (atau format tanpa Entry 1 eksplisit), pola mencocokkan kata `Entry`, `1?` mencocokkan string kosong, dan angka `2` tertangkap oleh `priceToken` sebagai harga entry. Asisten lokal menjawab: *"BBRI: area entry/konfirmasi yang tercatat adalah 2."* Pengguna disarankan membeli saham di harga Rp 2.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v6-bugs.test.js`
  Hasil: `BUG-CR6-02: extractSnapshotFacts must not capture "2" as entry level when Entry 2 is present` gagal (`AssertionError: facts.entry must not capture "2" from "Entry 2: 4400"`).
- **Usulan Arah Perbaikan:**
  Gunakan pemisah non-digit tegas sebelum kuantifier harga agar digit label entry 2 tidak tertangkap sebagai harga: `make('entry(?:\\s*1)?(?!\\s*2)')` atau `make('(?:area\\s+)?entry(?:\\s*1)?')`.

---

### BUG-CR7-01: `SAFETY_NET_GEMINI_MODEL` Bernilai Identik dengan `DEFAULT_GEMINI_MODEL` Menyebabkan Percobaan Fallback Ke-4 Tidak Pernah Dapat Berjalan
- **File & Baris:** `lib/context-ai-router-v7.js:527` & `lib/context-ai-router-v7.js:641`
- **Kutipan Kode:**
  ```javascript
  // Attempt 4 (Safety Net): Try stable modern flash if all previous failed
  const attempt4Timeout = !geminiResult ? nextGeminiTimeout(handlerStarted) : null;
  if (!geminiResult && attempt4Timeout != null && primaryModel !== SAFETY_NET_GEMINI_MODEL && fallbackModel !== SAFETY_NET_GEMINI_MODEL) {
  ```
- **Dampak ke User:**
  Di `lib/ai-gemini-provider.js:25`, `SAFETY_NET_GEMINI_MODEL` didefinisikan dengan fallback `DEFAULT_GEMINI_MODEL`. Tanpa konfigurasi env khusus, `primaryModel` dan `SAFETY_NET_GEMINI_MODEL` adalah string yang sama, sehingga kondisi `primaryModel !== SAFETY_NET_GEMINI_MODEL` selalu bernilai `false`. Akibatnya jaring pengaman fallback terakhir (Attempt 4) menjadi dead code dan tidak pernah dieksekusi saat model utama dan model cadangan mengalami kendala.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-bugs.test.js`
  Hasil: `SAFETY_NET_GEMINI_MODEL must not equal DEFAULT_GEMINI_MODEL by default to prevent dead Attempt 4 fallback` gagal (`AssertionError: SAFETY_NET_GEMINI_MODEL must be distinct from DEFAULT_GEMINI_MODEL`).
- **Usulan Arah Perbaikan:**
  Set model safety net default ke model stabil terpisah yang selalu berbeda dari `DEFAULT_GEMINI_MODEL` (misal `'gemini-2.0-flash'`).

---

### BUG-CR7-02: Kebocoran Data Sisa Kuota Pengguna Lain pada Respons Cache Analisis AI
- **File & Baris:** `lib/context-ai-router-v7.js:410-415` & `lib/context-ai-router-v7.js:672-684`
- **Kutipan Kode:**
  ```javascript
  // Saat menyimpan cache:
  payload.quota = { tier: req._aiQuota.tier, usedToday: updatedCount, ... };
  await setCachedAnalysis(Object.assign({}, cacheParams, { payloadResponse: payload, ttlSeconds: 4 * 3600 }));

  // Saat cache hit:
  return res.status(200).json(Object.assign({}, cached, {
    success: true,
    reply: cached.reply || cached.text,
    source: 'db_cache',
    cache_hit: true,
    token_saved: true
  }));
  ```
- **Dampak ke User:**
  Objek `payload.quota` milik pengguna A ikut disimpan ke database cache bersama hasil analisis. Saat pengguna B (atau pengguna A di sesi berbeda) menanyakan pertanyaan yang sama dan menghasilkan cache hit, sistem mengembalikan objek `quota` kadaluwarsa milik pengguna A (`usedToday` dan `remaining`). Kuota pengguna B tampak berkurang atau nol secara keliru dan metadata privat akun pengguna lain bocor.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-bugs.test.js`
  Hasil: `handleContextAIV7 cache hit must not leak previous user quota in response payload` gagal (`AssertionError: Cached quota should not overwrite live User B quota: 0 !== 0`).
- **Usulan Arah Perbaikan:**
  Hapus properti `cached.quota` saat merakit respons cache hit atau gantikan secara dinamis dengan kuota aktual `req._aiQuota`.

---

### BUG-ANL-01: `transientSimulation(undefined)` Mengembalikan Objek Aktif `{ label: 'SIMULASI' }` yang Memaksa Mode Simulasi Aktif pada Seluruh Percakapan Portofolio Normal
- **File & Baris:** `api/analyze.js:100-111`
- **Kutipan Kode:**
  ```javascript
  function transientSimulation(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const output = {
      label: String(input.label || 'SIMULASI').slice(0, 40),
      available_funds_idr: availableFunds != null && availableFunds > 0 ? availableFunds : null,
      add_lots: addLots != null && addLots > 0 ? addLots : null,
      setup_still_valid: ...
    };
    return Object.values(output).some((value) => value !== null && value !== '') ? output : null;
  }
  ```
- **Dampak ke User:**
  Karena properti `output.label` selalu bernilai default `'SIMULASI'` (bukan null dan bukan string kosong), evaluasi `Object.values(output).some(...)` selalu bernilai `true` meskipun pemanggil tidak mengirimkan parameter simulasi apapun. Objek `context.simulation` palsu selalu terpasang pada setiap sesi chat portofolio, memicu `planFacts` menghasilkan data kalkulasi simulasi kosong (`facts.simulation`) dan membingungkan model AI.
- **Bukti Test Nyata:**
  `node --test test/analyze-api-bugs.test.js`
  Hasil: `transientSimulation(undefined) must return null when no simulation parameters are provided` gagal (`AssertionError: transientSimulation(undefined) must return null: { label: 'SIMULASI', ... } == null`).
- **Usulan Arah Perbaikan:**
  Kembalikan `null` di awal jika argumen `raw` bernilai falsy, atau periksa kelayakan simulasi hanya dari keberadaan dana/lot: `if (!raw || (!output.available_funds_idr && !output.add_lots)) return null;`.

---

### BUG-SH-01: Logika Keputusan AI Confirmation Mengabaikan Status `REJECT` untuk Kandidat Non-`Swing Ready`
- **File & Baris:** `api/sector-hot.js:771-778`
- **Kutipan Kode:**
  ```javascript
  // Downgrade if AI rejects
  if (r.ai_status === 'REJECT' && r.status === 'Swing Ready') {
    r.final_status = 'Watchlist';
  } else if (r.ai_status === 'CAUTION' && r.status === 'Swing Ready') {
    r.final_status = r.status;
  } else {
    r.final_status = r.status;
  }
  ```
- **Dampak ke User:**
  Kandidat saham berstatus `Rebound Speculative` dan `Watchlist` juga dikirimkan ke model AI untuk divalidasi. Namun jika model AI mengembalikan evaluasi `REJECT` (karena adanya risiko distribusi berat atau pelemahan struktur), blok `else` mempertahankan status awal `r.final_status = r.status`. Penolakan AI diabaikan 100%, dan saham berbahaya tetap direkomendasikan kepada user sebagai `Rebound Speculative`.
- **Bukti Test Nyata:**
  `node --test test/analyze-api-bugs.test.js`
  Hasil: `AI Confirmation in sector-hot must downgrade Rebound Speculative and Watchlist upon AI REJECT` gagal (`AssertionError: AI REJECT on Rebound Speculative should downgrade final_status: 'Rebound Speculative' !== 'Rebound Speculative'`).
- **Usulan Arah Perbaikan:**
  Turunkan status kandidat non-`Swing Ready` saat AI REJECT: `if (r.ai_status === 'REJECT') { r.final_status = r.status === 'Swing Ready' ? 'Watchlist' : 'Invalid'; }`.

---

### BUG-SH-02: String Tanda Peringatan `ai_red_flags` Memuat Spasi Tak Tertrim Sehingga Gagal Dicocokkan oleh Operator Array PostgreSQL
- **File & Baris:** `api/sector-hot.js:1459-1469`
- **Kutipan Kode:**
  ```javascript
  var codes = parts.length >= 3 ? parts[2].trim().split(',').slice(0, 3) : [];
  // ...
  parsed.push({
    ticker: ticker,
    ai_status: aiStatus,
    ai_reason: aiReason,
    ai_red_flags: codes.filter(function(c) {
      var ct = c.trim();
      return ct === 'TREND_WEAK' || ct === 'RSI_LOW' || ct === 'RSI_HIGH' || ...;
    })
  });
  ```
- **Dampak ke User:**
  Pemotongan string `parts[2].split(',')` pada respons multi-kode (misal `"TREND_OK, RSI_LOW"`) menghasilkan elemen dengan spasi awal `" RSI_LOW"`. Filter array mengembalikan elemen asli yang belum di-trim ke `ai_red_flags`. Saat disimpan ke database sebagai array PostgreSQL (`'{" RSI_LOW"}'`), pencarian query menggunakan operator array `@> '{RSI_LOW}'` gagal mencocokkan data, sehingga peringatan bendera merah tidak dapat difilter di dashboard.
- **Bukti Test Nyata:**
  `node --test test/analyze-api-bugs.test.js`
  Hasil: `callAIConfirmation in sector-hot trims whitespace in ai_red_flags to avoid broken postgres array matching` gagal (`AssertionError: Red flags must be trimmed strings: [' RSI_LOW'] == ['RSI_LOW']`).
- **Usulan Arah Perbaikan:**
  Map kode dengan trim sebelum filtering: `var codes = parts[2].split(',').map(function(c) { return c.trim(); }).slice(0, 3);`.

---

### BUG-CAS-01: `runChartAnalysis` Tidak Menyertakan Objek `quota` Pada Respons Cache Hit
- **File & Baris:** `lib/chart-analysis-service.js:377-385`
- **Kutipan Kode:**
  ```javascript
  if (!options.forceFresh) {
    const cached = await getCachedAnalysis(db, userId, safeTicker, wibDate);
    if (cached) {
      return {
        ok: true,
        status: 200,
        cached: true,
        data: cached
      };
    }
  }
  ```
- **Dampak ke User:**
  Ketika analisis chart disajikan dari cache lokal/database, properti `quota` tidak disertakan di objek pengembalian. Pada `handleChartAnalysisEndpoint`, respons JSON ke klien menghasilkan `quota: undefined`. Widget kuota di UI pengguna menjadi hilang atau menampilkan `undefined` kuota tersisa.
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-bugs.test.js`
  Hasil: `Cached response must include quota information` gagal (`AssertionError: Cached response must include quota information`).
- **Usulan Arah Perbaikan:**
  Ambil `getUserUsage` dan sertakan objek `quota` (`usedToday`, `maxDaily`, `remaining`) juga pada cabang pengembalian `cached`.

---

### BUG-CAS-02: `runChartAnalysis` dan `getAnalysisStatus` Mengabaikan Rejection `USER_BLOCKED` dan Membuka Akses Eksekusi AI ke Pengguna Terblokir
- **File & Baris:** `lib/chart-analysis-service.js:308-327` & `lib/chart-analysis-service.js:352-371`
- **Kutipan Kode:**
  ```javascript
  let access = options.access || null;
  if (!access) {
    try { access = await resolvePremiumAccess(req, db); } catch (_) {}
  }
  if ((!access || !access.ok) && auth && auth.session) {
    const isAdm = auth.session.adm === true || auth.session.un === 'budi';
    const isPrem = isAdm || auth.premium === true;
    access = {
      ok: true,
      user: { id: auth.session.uid, username: auth.session.un, isAdmin: auth.session.adm === true }, ...
    };
  }
  ```
- **Dampak ke User:**
  Bila `resolvePremiumAccess` menolak user terblokir (`access.ok === false, status === 403`), blok `if ((!access || !access.ok) && auth && auth.session)` justru menganggapnya sebagai sesi gratis biasa dan memaksa `access.ok = true`. Akun yang diblokir oleh admin tetap dapat memeriksa status kuota dan mengeksekusi chart vision AI selama memiliki BYOK key.
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-bugs.test.js`
  Hasil: `getAnalysisStatus must reject blocked user with ok: false` gagal (`AssertionError: false == true`).
- **Usulan Arah Perbaikan:**
  Periksa kode penolakan: jika `access && access.code === 'USER_BLOCKED'` atau `access.status === 403`, kembalikan penolakan 403 tersebut tanpa menimpanya.

---

### BUG-CAE-01: `handleChartAnalysisEndpoint` Mengabaikan Status Error pada `deleteUserApiKey` dan Selalu Mengembalikan Status Sukses 200
- **File & Baris:** `lib/chart-analysis-endpoint.js:63-70`
- **Kutipan Kode:**
  ```javascript
  // POST: delete user Gemini API key
  if (action === 'delete-key') {
    await deleteUserApiKey(db, userId, 'gemini');
    return res.status(200).json({
      success: true,
      message: 'API key Gemini berhasil dihapus.'
    });
  }
  ```
- **Dampak ke User:**
  Saat penghapusan personal BYOK API key gagal di level database (`deleteUserApiKey` mengembalikan `{ ok: false, error: ... }`), endpoint tidak memeriksa status hasil dan tetap mengembalikan HTTP 200 dengan pesan `"API key Gemini berhasil dihapus"`. Pengguna mengira kunci pribadi mereka sudah dihapus dari server, padahal masih tersimpan dan aktif.
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-endpoint-bugs.test.js`
  Hasil: `BUG-CAE-01: handleChartAnalysisEndpoint must not return success 200 when deleteUserApiKey fails` gagal (`AssertionError: Endpoint should return error status when deleteUserApiKey fails, got 200`).
- **Usulan Arah Perbaikan:**
  Tampung hasil penghapusan dan periksa statusnya:
  ```javascript
  const delRes = await deleteUserApiKey(db, userId, 'gemini');
  if (!delRes || !delRes.ok) {
    return res.status(delRes && delRes.status || 400).json({ success: false, error: (delRes && delRes.error) || 'Gagal menghapus API key.' });
  }
  ```

---

### BUG-CAE-02: `handleChartAnalysisEndpoint` Membiarkan Mutating Action (`action=set-key`, `action=delete-key`, `action=analyze`) Berjalan pada HTTP GET
- **File & Baris:** `lib/chart-analysis-endpoint.js:28-39`
- **Kutipan Kode:**
  ```javascript
  // GET: status & quota info
  if (req.method === 'GET' || action === 'status') {
    const ticker = String(req.query && req.query.ticker || '').trim().toUpperCase();
    const statusResult = await getAnalysisStatus(req, db, ticker);
    return res.status(statusResult.status || 200).json(statusResult);
  }

  // Mutating requests must be POST
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }
  ```
- **Dampak ke User:**
  Karena kondisi `req.method === 'GET' || action === 'status'` menangkap seluruh permintaan `GET` tanpa memverifikasi parameter `action`, pemanggilan `GET /api/chart-analysis?action=set-key` atau `GET /api/chart-analysis?action=delete-key` tidak pernah mencapai baris validasi `req.method !== 'POST'`. Permintaan tersebut justru mengeksekusi `getAnalysisStatus` dan mengembalikan status 200 secara keliru alih-alih 405 Method Not Allowed.
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-endpoint-bugs.test.js`
  Hasil: `BUG-CAE-02: handleChartAnalysisEndpoint must reject mutating action=set-key on GET with 405 Method Not Allowed` gagal (`AssertionError: Mutating GET ?action=set-key must return 405 Method Not Allowed, got 200`).
- **Usulan Arah Perbaikan:**
  Pisahkan rute:
  ```javascript
  if (action === 'status' || (!action && req.method === 'GET')) {
    if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    ...
  }
  ```

---

### BUG-CAP-01: `getChartAnalysisSystemPrompt` Merusak Akhiran `.JK` Menjadi `tickerJK` Bukan Membuang Suffix Bursa
- **File & Baris:** `lib/chart-analysis-prompt.js:40-41`
- **Kutipan Kode:**
  ```javascript
  function getChartAnalysisSystemPrompt(ticker) {
    const safeTicker = String(ticker || 'SAHAM').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return RAW_SYSTEM_PROMPT_TEMPLATE.replace(/\{TICKER\}/g, safeTicker);
  }
  ```
- **Dampak ke User:**
  Pada ekosistem BEI/Yahoo Finance, simbol saham menggunakan akhiran `.JK` (misal `BBCA.JK`). Regex `replace(/[^A-Z0-9]/g, '')` hanya menghapus tanda titik sehingga nama ticker menjadi `BBCAJK`. AI Vision menerima prompt `"gambar chart candlestick saham BBCAJK"` yang mengacaukan identifikasi entitas emiten di BEI.
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-prompt-bugs.test.js`
  Hasil: `Prompt must not contain corrupted ticker "BBCAJK"` gagal.
- **Usulan Arah Perbaikan:**
  Hapus suffix `.JK` terlebih dahulu: `.replace(/\.JK$/i, '').replace(/[^A-Z0-9]/g, '')`.

---

### BUG-CAP-02: `getChartAnalysisSystemPrompt` Menghasilkan Ticker Kosong Saat Menerima Ticker Berisi Spasi atau Karakter Simbol
- **File & Baris:** `lib/chart-analysis-prompt.js:40-41`
- **Kutipan Kode:**
  ```javascript
  const safeTicker = String(ticker || 'SAHAM').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  ```
- **Dampak ke User:**
  Jika string berisi spasi (`'   '`) atau simbol (`'---'`) dioper ke fungsi, ekspresi `ticker || 'SAHAM'` tetap mengevaluasi string input karena string bukan string kosong (truthy). Setelah `trim()` dan `replace(/[^A-Z0-9]/g, '')`, hasilnya adalah string kosong `''`. Akibatnya prompt yang dikirim ke AI berbunyi `"gambar chart candlestick saham  di Bursa Efek Indonesia"` (ticker kosong).
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-prompt-bugs.test.js`
  Hasil: `Prompt should fall back to "saham SAHAM di Bursa" on whitespace` gagal.
- **Usulan Arah Perbaikan:**
  Lakukan fallback setelah pembersihan regex: `const safeTicker = String(ticker || '').replace(/\.JK$/i, '').replace(/[^A-Z0-9]/g, '').trim() || 'SAHAM';`.

---

### BUG-AIT-01: `getAiTelemetryStats` Menghilangkan Properti CamelCase Alias `cacheHitRate` pada Objek Pengembalian
- **File & Baris:** `lib/ai-telemetry.js:46-59`
- **Kutipan Kode:**
  ```javascript
  return {
    total_requests: _stats.totalRequests,
    cache_hits: _stats.cacheHits,
    gemini_calls: _stats.geminiCalls,
    local_fallbacks: _stats.localFallbacks,
    average_latency_ms: avgLatencyMs,
    cache_hit_rate: cacheHitRate,
    // CamelCase aliases
    totalRequests: _stats.totalRequests,
    cacheHits: _stats.cacheHits,
    geminiCalls: _stats.geminiCalls,
    localFallbacks: _stats.localFallbacks,
    avgLatencyMs: avgLatencyMs,
    last_updated: new Date().toISOString()
  };
  ```
- **Dampak ke User:**
  Fungsi menghitung `const cacheHitRate = ...` dan mendokumentasikan blok `// CamelCase aliases` untuk kompatibilitas frontend/consumer JavaScript, namun melewatkan `cacheHitRate` (dan `lastUpdated`). Konsumen kode yang membaca `stats.cacheHitRate` mendapatkan nilai `undefined`, menyebabkan tampilan rasio efisiensi cache AI di dashboard monitoring kosong atau bernilai `NaN%`.
- **Bukti Test Nyata:**
  `node --test test/ai-telemetry-bugs.test.js`
  Hasil: `BUG-AIT-01: getAiTelemetryStats must include cacheHitRate in camelCase aliases` gagal (`AssertionError: stats.cacheHitRate must be defined as a number, got undefined`).
- **Usulan Arah Perbaikan:**
  Tambahkan `cacheHitRate` dan `lastUpdated` ke dalam blok alias camelCase: `cacheHitRate: cacheHitRate, lastUpdated: new Date().toISOString()`.

---

### BUG-AIT-02: `recordCacheHit` Tanpa `recordRequest` Menghasilkan Hit Rate Tidak Terikat (>100%) atau 0% Karena Tidak Menjaga Konsistensi `totalRequests`
- **File & Baris:** `lib/ai-telemetry.js:18-20` & `lib/ai-telemetry.js:38-40`
- **Kutipan Kode:**
  ```javascript
  function recordCacheHit() {
    _stats.cacheHits++;
  }
  // ...
  const cacheHitRate = _stats.totalRequests > 0
    ? Math.round((_stats.cacheHits / _stats.totalRequests) * 10000) / 10000
    : 0;
  ```
- **Dampak ke User:**
  Jika pemanggil mencatat event cache hit via `recordCacheHit()` tanpa terlebih dahulu memanggil `recordRequest()` (misalnya saat short-circuit cache di handler mandiri), `_stats.totalRequests` tetap 0 sehingga `cacheHitRate` dievaluasi menjadi 0 (0% efisiensi meskipun ada 100 hit). Bila `recordRequest` hanya dipanggil sebagian, rasio cache hit rate dapat melebihi 1.0 (>100%), merusak metrik telemetri operasional.
- **Bukti Test Nyata:**
  `node --test test/ai-telemetry-bugs.test.js`
  Hasil: `BUG-AIT-02: recordCacheHit must maintain consistent totalRequests or bound cache_hit_rate <= 1.0` gagal (`AssertionError: total_requests (0) must be at least cache_hits (1)`).
- **Usulan Arah Perbaikan:**
  Pastikan `recordCacheHit` otomatis meningkatkan `_stats.totalRequests++` bila `_stats.totalRequests < _stats.cacheHits`, atau batasi rasio maksimum `Math.min(1, ...)`.

---

### BUG-PAIR-01: `classifyFailure` pada Portfolio AI Runtime Menyamarkan Galat Kuota Habis (`QUOTA_EXCEEDED`) Menjadi Peringatan Rate Limit Sementara
- **File & Baris:** `public/portfolio-ai-runtime-v2.js:491-497`
- **Kutipan Kode:**
  ```javascript
  if (status === 429 || code === 'AI_RATE_LIMITED') {
    var wait = Number(data && data.retry_after_seconds);
    return {
      fallback: false,
      status: 'Terlalu banyak pertanyaan dalam waktu singkat.' + (Number.isFinite(wait) && wait > 0 ? ' Coba lagi sekitar ' + wait + ' detik lagi.' : ' Tunggu sebentar lalu coba lagi.')
    };
  }
  ```
- **Dampak ke User:**
  Ketika kuota harian pengguna habis, server mengembalikan status HTTP 429 dengan kode `QUOTA_EXCEEDED` dan pesan *"Batas kuota harian Anda telah tercapai (10/10)"*. Namun klien mengecek `status === 429` terlebih dahulu dan menampilkan pesan keliru: *"Terlalu banyak pertanyaan dalam waktu singkat. Tunggu sebentar lalu coba lagi."* Pengguna mengira hanya ada antrean sementara dan terus mencoba berulang kali padahal kuota hariannya telah habis.
- **Bukti Test Nyata:**
  `node --test test/ai-chat-renderer-bugs.test.js`
  Hasil: `classifyFailure must display quota exceeded error message instead of rate limit message` gagal (`AssertionError: 'Terlalu banyak pertanyaan...' == 'Batas kuota harian Anda telah tercapai...'`).
- **Usulan Arah Perbaikan:**
  Periksa `if (code === 'QUOTA_EXCEEDED')` sebelum blok pengecekan `status === 429`.

---

### BUG-SAI-01: `describeFailure` pada Stock Analysis AI Menyamarkan Galat Kuota Habis (`QUOTA_EXCEEDED`) Menjadi Peringatan Rate Limit Sementara
- **File & Baris:** `public/stock-analysis-ai.js:144-147`
- **Kutipan Kode:**
  ```javascript
  if (status === 429 || code === 'AI_RATE_LIMITED') {
    var wait = Number(data && data.retry_after_seconds);
    return { retryable: false, text: 'Terlalu banyak pertanyaan dalam waktu singkat.' + (Number.isFinite(wait) && wait > 0 ? ' Coba lagi sekitar ' + wait + ' detik lagi.' : ' Tunggu sebentar lalu coba lagi.') };
  }
  ```
- **Dampak ke User:**
  Sama seperti BUG-PAIR-01, modul follow-up chat Analisis Saham menutupi pesan `QUOTA_EXCEEDED` dengan kalimat rate-limit generik. Pengguna tidak menyadari kuota harian mereka habis.
- **Bukti Test Nyata:**
  `node --test test/ai-chat-renderer-bugs.test.js`
  Hasil: `describeFailure must display quota exceeded error message instead of rate limit message` gagal.
- **Usulan Arah Perbaikan:**
  Periksa `if (code === 'QUOTA_EXCEEDED') return { retryable: false, text: (data && data.error) || 'Batas kuota harian AI Anda telah tercapai.' };` sebelum pemeriksaan status 429.

---

### BUG-ACR-01: `normalizeSpacing` pada AI Chat Renderer Merusak Angka Desimal Tanpa Angka Nol di Depan Titik (`.382` Menjadi `. 382`)
- **File & Baris:** `public/ai-chat-renderer.js:72`
- **Kutipan Kode:**
  ```javascript
  .replace(/(^|[^0-9])\.([0-9])/g, '$1. $2')
  ```
- **Dampak ke User:**
  Regex pembersih spasi menyisipkan spasi setelah titik desimal pada angka seperti `.382` (Fibonacci) atau `.5%` (persentase risiko), mengubahnya menjadi `. 382` atau `. 5%`. Teks teknikal finansial yang dirender di layar menjadi terpotong dan tidak lazim dibaca.
- **Bukti Test Nyata:**
  `node --test test/ai-chat-renderer-bugs.test.js`
  Hasil: `Decimal without leading zero (.382) must not have space inserted` gagal.
- **Usulan Arah Perbaikan:**
  Pastikan karakter sebelum titik bukan tanda desimal angka atau ganti regex pemisah kalimat agar hanya menyisipkan spasi bila diikuti huruf kapital.
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
    reason = 'one close below buffered support â€” awaiting a second confirming observation';
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
# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 4 (Bandarmologi / Broker / Insider)
Dokumentasi temuan bug Fase 4. Read-only kode produksi, dibuktikan lewat unit test fisik di test/bandarmologi-fase4-bugs.test.js.
Status: BELUM DIPERBAIKI (fase audit murni).

---

### BUG-F4-01: Truthy Array Kosong `gross_buyers` Mengabaikan `top_buyers` pada Broker Hunter
- **Lokasi**: `lib/broker-hunter-service.js:147 & 168`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const buyers = summary.gross_buyers || summary.top_buyers || summary.buyers || [];
  ...
  const sellers = summary.gross_sellers || summary.top_sellers || summary.sellers || [];
  ```
- **Dampak ke User**: Respon API Arjum atau file ringkasan broker summary sering kali menyuplai properti `gross_buyers: []` (array kosong) dan mengisi data pada `top_buyers`. Karena array kosong `[]` bernilai *truthy* dalam evaluasi JavaScript (`[] || summary.top_buyers` bernilai `[]`), pembacaan berhenti pada `gross_buyers`. Akibatnya array `buyers` dan `sellers` kosong, dan fungsi mengembalikan transaksi `null`. Pengguna melihat broker hunter tidak memiliki aktivitas (kosong) padahal data transaksi tersedia di bursa.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-01`: Objek summary `{ gross_buyers: [], top_buyers: [{ broker: 'AK', bval: 5e9, bvol: 1000 }] }` mengembalikan `null`.
- **Usulan Perbaikan**: Gunakan helper array tidak kosong seperti `firstNonEmptyArray(summary.gross_buyers, summary.top_buyers, summary.buyers)` sebagaimana yang telah diterapkan pada `lib/bandarmologi-service.js`.

---

### BUG-F4-02: `calculateScannerDiscount` Mengembalikan Diskon 100% saat Harga Terakhir Bernilai `null` atau `0`
- **Lokasi**: `lib/bandarmologi-service.js:608-613`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  function calculateScannerDiscount(modal, last_price) {
    modal = Number(modal || 0);
    last_price = Number(last_price || 0);
    if (!modal || modal <= 0) return 0;
    return Number((((modal - last_price) / modal) * 100).toFixed(2));
  }
  ```
- **Dampak ke User**: Fungsi hanya memeriksa validitas modal (`if (!modal || modal <= 0)`), tetapi tidak memvalidasi `last_price`. Jika harga pasar terakhir belum terunduh (`null`, `undefined`, atau `0`), evaluasi menghasilkan `(((modal - 0) / modal) * 100) = 100%`. Saham yang datanya tidak lengkap langsung lolos radar sebagai saham berdiskon 100% di bawah modal bandar, memicu sinyal beli palsu pada saham tanpa kuotasi harga.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-02`: `calculateScannerDiscount(1000, null)` dan `calculateScannerDiscount(1000, 0)` mengembalikan angka `100`.
- **Usulan Perbaikan**: Tambahkan validasi harga terakhir: `if (!modal || modal <= 0 || !last_price || last_price <= 0) return 0;`.

---

### BUG-F4-03: `holding.net_shares_change` Membalik Aksi Jual (`SELL`) Menjadi Akumulasi Beli
- **Lokasi**: `lib/insider-network-service.js:226-231`
- **Severity**: CRITICAL
- **Kutipan Kode**:
  ```javascript
  const change = parseShares(item.shares_change || item.shares || 0);
  const action = String(item.action_type || '').toUpperCase().trim();
  if (action === 'SELL') {
    holding.total_sold += change;
    holding.net_shares_change -= change;
  } else if (action === 'BUY' || action === 'PURCHASE') {
  ```
- **Dampak ke User**: Pada data bursa, perubahan lembar saham untuk aksi penjualan sering kali sudah bernilai negatif (misal `shares_change = -500000`). Operasi `holding.net_shares_change -= change` mengevaluasi `- -500000` menjadi `+500000`, dan `holding.total_sold += change` menjadi `-500000`. Akibatnya aksi distribusi besar-besaran oleh insider tercatat sebagai akumulasi beli (`net_shares_change` bertambah positif), menyesatkan trader mengira investor pengendali sedang memborong saham padahal mereka sedang melepas kepemilikan.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-03`: Aksi `SELL` dengan `shares_change: -500000` menghasilkan `net_shares_change: 500000` dan `total_sold: -500000`.
- **Usulan Perbaikan**: Pastikan nilai perubahan selalu bernilai absolut (`const change = Math.abs(parseShares(...))`) sebelum melakukan penambahan/pengurangan saldo.

---

### BUG-F4-04: `parsePercentage` Menghapus Koma Desimal Indonesia ("5,25%" Menjadi 525%)
- **Lokasi**: `lib/insider-network-service.js:87`
- **Severity**: CRITICAL
- **Kutipan Kode**:
  ```javascript
  const clean = String(val).replace(/[%,\s]/g, '').trim();
  const num = parseFloat(clean);
  return isNaN(num) ? null : num;
  ```
- **Dampak ke User**: Karakter koma dihapus secara mentah tanpa dikonversi ke titik desimal. Laporan keterbukaan informasi BEI yang menggunakan notasi desimal Indonesia (`"5,25%"`) dibersihkan menjadi `"525"`, menghasilkan nilai float `525` (525%). Porsi kepemilikan saham insider membengkak secara mustahil melebihi 100%, merusak keabsahan data jejaring insider.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-04`: `parsePercentage('5,25%')` menghasilkan angka `525`.
- **Usulan Perbaikan**: Ganti tanda koma menjadi titik sebelum pembersihan: `const clean = String(val).replace(',', '.').replace(/[% \t]/g, '').trim();`.

---

### BUG-F4-05: `hasData` Intelijen Selalu Bernilai `true` Karena Perbedaan Properti `s3.sub_type` vs `s3.reason`
- **Lokasi**: `lib/bandarmologi-intel-service.js:1010-1015`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const hasData = Boolean(
    (s1 && s1.reason !== 'NO_DATA') ||
    (s2 && s2.reason !== 'NO_DATA') ||
    (s3 && s3.reason !== 'NO_DATA') ||
    (s4 && s4.reason !== 'NO_DATA')
  );
  ```
- **Dampak ke User**: Fungsi `detectRetailCutlossVsBandar` (s3) mengembalikan `{ sub_type: 'NO_DATA' }` tanpa properti `reason`. Pada evaluasi `hasData`, ekspresi `s3.reason !== 'NO_DATA'` bernilai `true` karena `undefined !== 'NO_DATA'` adalah `true`. Akibatnya, `has_data` selalu dilaporkan `true` bahkan ketika seluruh sinyal intelijen bernilai `NO_DATA`. Antarmuka menampilkan ringkasan data valid kosong padahal emiten tidak memiliki data transaksi bursa.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-05`: Objek s3 dengan `sub_type: 'NO_DATA'` menghasilkan `s3.reason !== 'NO_DATA'` bernilai `true`.
- **Usulan Perbaikan**: Samakan pengecekan ke properti sub_type dan reason: `(s3 && s3.reason !== 'NO_DATA' && s3.sub_type !== 'NO_DATA')`.

---

### BUG-F4-06: `getHunterTickerMap` Membagi Volume Berbasis Lot Sehingga Harga Modal Melambung 100x
- **Lokasi**: `lib/bandarmologi-intel-service.js:191 & 224`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const avgBuy = (bVal > 0 && bVol > 0) ? Math.round(bVal / bVol) : Number(acc.avg_buy_price || 0);
  ...
  const avgSell = (sVal > 0 && sVol > 0) ? Math.round(sVal / sVol) : Number(dist.avg_sell_price || 0);
  ```
- **Dampak ke User**: Pada berkas indeks broker hunter, `bVol` disimpan dalam satuan lot (1 lot = 100 lembar) sedangkan `acc.avg_buy_price` telah tersimpan dalam harga riil per lembar (misal Rp 500). Kode mengutamakan pembagian `bVal / bVol` yang menghasilkan harga Rupiah per lot (Rp 50.000) dan membuang `avg_buy_price`. Modal rata-rata broker menjadi 100x lipat lebih tinggi dari harga wajar saham, memicu sinyal palsu bahwa saham sedang terdiskon sangat masif di bawah modal bandar.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-06`: Pembagian `bVal: 100000000` dengan `bVol: 2000` (lot) menghasilkan rata-rata `50000` bukannya `500`.
- **Usulan Perbaikan**: Utamakan properti yang sudah dinormalisasi: `const avgBuy = Number(acc.avg_buy_price || 0) || (bVal > 0 && bVol > 0 ? Math.round(bVal / (bVol * 100)) : 0);`.

---

### BUG-F4-07: `detectRetailCutlossVsBandar` Mengabaikan Properti `broker_code`
- **Lokasi**: `lib/bandarmologi-intel-service.js:782-783`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const top3Buyers = norm.top_buyers.slice(0, 3).map(b => b.broker);
  const top3Sellers = norm.top_sellers.slice(0, 3).map(s => s.broker);
  ```
- **Dampak ke User**: Data ringkasan transaksi broker bursa sering menggunakan penamaan properti `broker_code`. Karena pemetaan hanya membaca `b.broker`, array kode broker menghasilkan `[undefined, undefined, undefined]`. Pengecekan `INSTITUTIONAL_BROKERS.has(code)` gagal, menghitung jumlah buyer institusi = 0 dan seller ritel = 0. Pola "Bandar Nampung Ritel Cutloss" tidak pernah terdeteksi pada broker summary berskema `broker_code`.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-07`: Objek summary dengan `broker_code: 'AK'` menghasilkan `inst_buyer_count: 0` dan `is_bandar_nampung: false`.
- **Usulan Perbaikan**: Gunakan fallback standar: `b => String(b.broker || b.broker_code || '').trim().toUpperCase()`.

---

### BUG-F4-08: `parseNumericValue` Memotong Format Ribuan Bertitik Indonesia ("1.250.000" Menjadi 1.25)
- **Lokasi**: `public/bandarmologi-runtime.js:196-208`
- **Severity**: CRITICAL
- **Kutipan Kode**:
  ```javascript
  } else if (cleanStr.indexOf(',') >= 0) {
    if (/^\-?\d+,\d{1,2}$/.test(cleanStr)) {
      cleanStr = cleanStr.replace(',', '.');
    } else {
      cleanStr = cleanStr.replace(/,/g, '');
    }
  }
  cleanStr = cleanStr.replace(/[^\d.-]/g, '');
  var n = parseFloat(cleanStr);
  ```
- **Dampak ke User**: Fungsi hanya mendeteksi pemisah jika terdapat koma `,`. Pada angka Indonesia dengan pemisah ribuan bertitik tanpa koma (seperti nominal `"1.250.000"` atau `"50.000"`), tanda titik tidak dibersihkan. Pemanggilan `parseFloat("1.250.000")` menganggap titik pertama sebagai desimal dan memotong sisa angka, menghasilkan nilai `1.25` dan `50` (terpotong 1.000x hingga 1.000.000x lipat). Nilai transaksi broker di kartu antarmuka menjadi rusak total.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-08`: Parsing `"1.250.000"` menghasilkan `1.25`.
- **Usulan Perbaikan**: Tambahkan pengecekan pemisah ribuan bertitik: jika string memiliki lebih dari satu titik atau titik diikuti 3 digit angka tanpa koma, bersihkan semua titik sebelum parsing.

---

### BUG-F4-09: Kontradiksi Klasifikasi Broker `CC` dan Kerusakan Perhitungan Rasio Ritel vs Bandar
- **Lokasi**: `public/bandarmologi-runtime.js:1493 & 1499`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  var retailCodes = ['YP', 'XL', 'XC', 'PD', 'NI', 'SQ', 'CC'];
  ...
  var effectiveTotalVal = totalMarketBuyVal > 0 ? totalMarketBuyVal : (allBuyersList.length > 0 ? top3Val : 0);
  var bandarVal = Math.max(0, effectiveTotalVal - retailVal);
  ```
- **Dampak ke User**: Broker `CC` (Mandiri Sekuritas, BUMN/Institusi) dideklarasikan sebagai `INSTITUTIONAL_BROKERS` di baris 272, namun pada baris 1493 dimasukkan ke dalam `retailCodes`. Pembelian masif Mandiri Sekuritas dihitung sebagai transaksi ritel. Selain itu, bila `totalMarketBuyVal` tidak tersedia (0), `effectiveTotalVal` hanya diisi oleh `top3Val` sedangkan `retailVal` diakumulasikan dari seluruh daftar broker. Akibatnya `retailVal > top3Val` sehingga `bandarVal` dipaksa ke `0%`. Pengguna disajikan informasi palsu bahwa partisipasi bandar adalah 0% dan ritel 100% padahal 3 broker teratas adalah institusi besar (AK, BK, RX).
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-09`: Pembelian Top 3 sebesar 300 Miliar dengan akumulasi ritel 350 Miliar menghasilkan `bandarVal = 0` dan `bandarPct = 0%`.
- **Usulan Perbaikan**: Hapus `CC` dan `SQ` dari `retailCodes`. Hitung `effectiveTotalVal` dari total akumulasi seluruh broker pembeli yang terdaftar agar sebanding dengan `retailVal`.
# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 5 (Auth, Subscription, Admin & Security)
Dokumentasi temuan bug Fase 5. Read-only kode produksi, dibuktikan lewat failing unit test di test/.
Fokus khusus: Validasi token/password, paywall bypass (Free vs Pro/VIP), role elevation, timing attack, rate limit.

---

### BUG-F5-01: Bypass Status Blokir Akun Admin pada `getEntitlements`
- **Severity**: HIGH
- **Lokasi**: `lib/entitlements.js:33-41`
- **Kutipan Kode**:
# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 6 (Telegram & Notifikasi)
Dokumentasi temuan bug Fase 6. Read-only kode produksi, dibuktikan lewat failing unit test di test/.
Fokus khusus: Markdown/HTML entity escaping bursa, alert dedup saat volatilitas harga, queue handling saat rate limit 429.

---

### BUG-F6-001: Korupsi Kondisi Teknikal Akibat Regex Tag Stripping Naif dan Ketiadaan Escaping Entity
- **File**: `lib/telegram-notifier.js:490`, `lib/telegram-templates.js:77`
- **Severity**: CRITICAL
- **Kode Bermasalah**:
  ```javascript
  // lib/telegram-notifier.js
  function formatTelegramSafeText(text) {
    if (!text) return '';
    var clean = text.replace(/<[^>]*>/g, '');
    ...
  }

  // lib/telegram-templates.js
  function safe(value, fallback) {
    ...
    var s = String(value).replace(/[\r\n\t]+/g, ' ').replace(/<[^>]*>/g, '').replace(/\s{2,}/g, ' ').trim();
    ...
  }
  ```
- **Dampak**: Catatan teknikal trading yang mengandung tanda perbandingan `<` dan `>` (contoh: `Price < 1500 dan MA > 1200`) terpotong menjadi `Price  1200`. Data instruksi trading hilang atau terdistorsi bagi pengguna. Selain itu, template tidak meng-escape karakter `&`, `<`, `>` untuk HTML atau `.`, `-`, `+`, `_`, `(`, `)` untuk MarkdownV2, memicu HTTP 400 Bad Request jika parse_mode diaktifkan.
- **Bukti Uji**: `test/telegram-fase6-batch1-bugs.test.js` (Test 1 gagal: `Price  1200` !== `Price < 1500 dan MA > 1200`).
- **Usulan Perbaikan**: Ganti regex stripping naif dengan HTML parser/escaper kontekstual, dan sediakan fungsi escape karakter khusus resmi Telegram.

---

### BUG-F6-002: Notifikasi Exit/Take-Profit (`TP1_HIT`, `TP2_HIT`, `EARLY_EXIT_DISTRIBUTION`) Ditekan Cooldown Sinyal Beli
- **File**: `lib/telegram-notifier.js:52-62`
- **Severity**: CRITICAL
- **Kode Bermasalah**:
  ```javascript
  function isDrasticAlertStatusChange(prevStatus, nextStatus) {
    const prev = normalizeAlertStatus(prevStatus);
    const next = normalizeAlertStatus(nextStatus);
    if (!next || next === prev) return false;
    const wasNeutral = prev.includes('WATCHLIST') || prev.includes('RADAR') || prev.includes('PULLBACK') || prev.includes('SPECULATIVE');
    if (wasNeutral && isConfirmedBuyStatus(next)) return true;
    const isNowAvoid = next.includes('AVOID') || next.includes('SL_HIT') || next.includes('INVALID');
    const wasNormal = !prev.includes('AVOID') && !prev.includes('SL_HIT');
    return isNowAvoid && wasNormal;
  }
  ```
- **Dampak**: Jika sinyal awal saham adalah setup beli terkonfirmasi (`A_PLUS_SETUP`, `CONFIRMED`), lalu 3-10 menit kemudian harga melesat menyentuh target profit (`TP1_HIT`, `TP2_HIT`) atau terdeteksi distribusi masif (`EARLY_EXIT_DISTRIBUTION`), `isDrasticAlertStatusChange` mengembalikan `false`. Akibatnya, sinyal keluar krusial diblokir oleh cooldown 20 menit, menyebabkan pengguna tidak menerima instruksi profit taking atau penyelamatan modal.
- **Bukti Uji**: `test/telegram-fase6-batch1-bugs.test.js` (Test 2 gagal: `tp1Check.suppressed` bernilai `true`).
- **Usulan Perbaikan**: Masukkan status aksi kunci (`TP1_HIT`, `TP2_HIT`, `BEP_CLOSED`, `EARLY_EXIT_DISTRIBUTION`, `TRAILING_STOP`) ke dalam daftar bypass cooldown.

---

### BUG-F6-003: Pengabaian Respon HTTP 429 (Rate Limit) pada `sendTelegramPhoto`, `sendTelegramPhotoUrl`, dan `sendTelegramDocument`
- **File**: `lib/telegram-notifier.js:343-350, 415-422, 479-486`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  // sendTelegramPhoto / sendTelegramDocument
  if (!response.ok) {
    var errBody = '';
    try { errBody = await response.text(); } catch (readErr) { /* ignore */ }
    var errMsg = 'HTTP ' + response.status;
    if (errBody && errBody.length < 200) errMsg += ': ' + errBody;
    return { ok: false, sent: false, skipped: false, reason: 'api_error', status: response.status, error_message: errMsg };
  }
  ```
- **Dampak**: Jika pengiriman media chart/dokumen terkena batas rate-limit 429 Telegram, fungsi tidak memanggil `applyRateLimitBackoff` dan tidak membaca `retry_after`. Seluruh throttle gate tidak diparkir, menyebabkan antrean permintaan berikutnya terus menembak server Telegram dan memperparah pemblokiran bot.
- **Bukti Uji**: `test/telegram-fase6-batch1-bugs.test.js` (Test 3 gagal: `res.reason` bernilai `'api_error'` bukan `'rate_limited'`, `backoffActive` bernilai `false`).
- **Usulan Perbaikan**: Samakan penanganan status HTTP 429 pada seluruh fungsi pengiriman media agar memicu `applyRateLimitBackoff(retryAfter)` dan mengembalikan `reason: 'rate_limited'`.

---

### BUG-F6-004: Inversi Logika Antrean Menyebabkan Chunk Multipart Melewati Throttle Saat Backoff 429 Sedang Aktif
- **File**: `lib/telegram-notifier.js:281`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  // BATCH 10: serialize + space outbound sends (skip only while honoring a 429 backoff).
  if (i === 0 || throttleState.retryAfterUntil <= Date.now()) {
    await acquireSendSlot(options);
  }
  ```
- **Dampak**: Ketika `retryAfterUntil > Date.now()` (artinya bot sedang dalam masa hukuman rate limit 429), chunk ke-2 (`i > 0`) menghasilkan nilai kondisi `false || false` -> `false`. Akibatnya, `acquireSendSlot` dilewati secara langsung dan chunk ke-2 dikirim instan ke Telegram saat backoff sedang berlangsung, menjamin kegagalan pengiriman berulang.
- **Bukti Uji**: `test/telegram-fase6-batch1-bugs.test.js` (Test 4 gagal: `sleepCalled` bernilai `false`).
- **Usulan Perbaikan**: Perbaiki logika kondisi: saat backoff aktif, chunk lanjutan HARUS tetap mengantre dan menunggu slot backoff selesai.

---

### BUG-F6-005: Kegagalan Rate Limit 429 pada Pesan Chunked Dikunci Permanen Sebagai `DELIVERY_UNCERTAIN`
- **File**: `lib/telegram-delivery.js:68-87`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  if (chunksSent > 0) {
    return {
      state: 'delivery_uncertain',
      delivered: false,
      attempted: true,
      skipped: false,
      uncertain: true,
      retryable: false,
      permanent: false,
      partial: true,
      reason: reason || 'partial_delivery',
      status: status,
      chunks_sent: chunksSent,
      chunks_total: chunksTotal
    };
  }
  ```
- **Dampak**: Jika pesan sinyal berukuran besar terbagi menjadi 2 chunk, di mana chunk 1 berhasil namun chunk 2 terbentur HTTP 429, status diklasifikasikan sebagai `delivery_uncertain` dengan `retryable: false`. Di database, baris masuk ke `DELIVERY_UNCERTAIN`. Berdasarkan `rowBlocksRetry()`, status ini memblokir selamanya upaya pengiriman ulang, mengunci sinyal dan menggagalkan monitoring.
- **Bukti Uji**: `test/telegram-fase6-batch1-bugs.test.js` (Test 5 gagal: `classified.retryable` bernilai `false`).
- **Usulan Perbaikan**: Berikan pengecualian jika `status === 429` atau `reason === 'rate_limited'`, tandai sebagai `retryable: true` dengan state `retryable_failure`.

---

### BUG-F6-006: Rejection Prematur dan Notifikasi Salah pada `handleChatJoinRequest` untuk Akun yang Sudah Tergabung (`already_joined`)
- **File**: `lib/telegram-verification.js:587-595`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  const eligible = ctx.outcome === 'eligible' && inviteValid && !ctx.channelJoinedAt;

  if (!eligible) {
    try { await bot.declineChatJoinRequest(channelId, requesterId); } catch (e) { /* sanitized */ }
    if (ctx.telegramPrivateChatId != null) {
      try { await bot.sendMessage(ctx.telegramPrivateChatId, MSG.joinRequestDeclined); } catch (e) {}
    }
    return declineOutcomeCode(ctx, providedInviteLink, linkMatches);
  }
  ```
- **Dampak**: Jika webhook `chat_join_request` terkirim ganda atau pengguna mengetuk kembali link invite setelah permintaan pertama disetujui, `ctx.channelJoinedAt` sudah bernilai timestamp. Hal ini membuat `eligible` bernilai `false`. Akibatnya, sistem menolak permintaan via `declineChatJoinRequest` dan mengirim pesan penolakan `MSG.joinRequestDeclined` ("Permintaan bergabung tidak dapat disetujui"), serta mematikan blok penanganan idempotensi `confirm.outcome === 'already_joined'` di baris 629.
- **Bukti Uji**: `test/telegram-fase6-batch2-bugs.test.js` (Test 1 gagal: `declineCalled` bernilai `true`, pesan penolakan terkirim ke akun yang sah).
- **Usulan Perbaikan**: Tangani kondisi `ctx.channelJoinedAt` sebelum memeriksa `!eligible`. Bersihkan tombol inline keyboard tanpa memanggil decline atau mengirim pesan kegagalan.

---

### BUG-F6-007: Opsi Kritis `creates_join_request: true` Hilang dan Salah Nama Parameter Kadaluwarsa pada `createChatInviteLink`
- **File**: `lib/telegram-verification.js:527, 793-796`
- **Severity**: CRITICAL
- **Kode Bermasalah**:
  ```javascript
  // ensureJoinRequestInvite (line 527)
  link = await bot.createChatInviteLink(channelId, { expireSeconds: INVITE_TTL_SECONDS, name: INVITE_LINK_NAME });

  // deliverApprovalInvite (line 793)
  inviteLink = await bot.createChatInviteLink(channelId, {
    expireSeconds: INVITE_TTL_SECONDS,
    name: INVITE_LINK_NAME
  });
  ```
- **Dampak**: Arsitektur persetujuan Telegram mensyaratkan dynamic join request link. Karena opsi `{ creates_join_request: true }` tidak disertakan, Telegram secara default membuat link join langsung (direct membership). Pengguna dapat langsung masuk channel tanpa memicu webhook `chat_join_request`. Selain itu, Telegram API menggunakan parameter `expire_date` (Unix epoch seconds), bukan `expireSeconds`, sehingga masa berlaku link diabaikan Telegram dan menjadi aktif tanpa batas.
- **Bukti Uji**: `test/telegram-fase6-batch2-bugs.test.js` (Test 2 gagal: `creates_join_request` bernilai `undefined`).
- **Usulan Perbaikan**: Tambahkan `creates_join_request: true` dan konversi `expireSeconds` menjadi `expire_date: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS`.

---

### BUG-F6-008: Kegagalan Pengiriman Pesan pada `sendTransient` Mengakibatkan Hilangnya Pesan Permanen & `deletePrevious` Menghapus Tracking Saat Hapus Gagal
- **File**: `lib/telegram-transient-message.js:37-47, 56-59`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  // deletePrevious
  async function deletePrevious(db, sender, chatId, scope) {
    const previous = await previousMessageId(db, chatId, scope);
    if (!previous) return false;
    try {
      if (sender && typeof sender.deleteMessage === 'function') {
        await sender.deleteMessage(Number(chatId), previous);
      }
    } catch (_) {}
    await forget(db, chatId, scope);
    return true;
  }

  // sendTransient
  await deletePrevious(db, sender, chatId, scope);
  let sent = null;
  try { sent = await sender.sendMessage(chatId, opts.text, opts.extra); }
  catch (_) { return null; }
  ```
- **Dampak**: Pada `deletePrevious`, jika `deleteMessage` melempar error (misal rate limit Telegram 429 atau network timeout), `forget()` tetap dipanggil. Tracking di database terhapus padahal pesan fisik di Telegram masih ada, mengakibatkan pesan menjadi orphaned dan tidak pernah bisa dihapus lagi. Pada `sendTransient`, pesan lama dihapus sebelum pesan baru terkirim; jika `sendMessage` gagal, pengguna kehilangan pesan tanpa ada penggantinya.
- **Bukti Uji**: `test/telegram-fase6-batch2-bugs.test.js` (Test 3 gagal: record di DB terhapus saat `deleteMessage` throw error).
- **Usulan Perbaikan**: Panggil `forget()` hanya jika `deleteMessage` berhasil. Pada `sendTransient`, pastikan pesan baru terkirim sebelum menghapus referensi pesan lama.

---

### BUG-F6-009: Premature Claim Locking pada `sendLegacyChannelAnnouncement` Mengunci Pengumuman Permanen Tanpa Pengiriman Berhasil
- **File**: `lib/telegram-lifecycle.js:263-272`
- **Severity**: MEDIUM
- **Kode Bermasalah**:
  ```javascript
  let claim = { claimed: false };
  try { claim = await claimLegacyChannelAnnouncement(supabase, key); } catch (e) { return { status: 'error', reason: 'claim_failed' }; }
  if (!claim.claimed) return { status: 'duplicate', reason: 'already_announced' };

  try {
    await bot.sendMessage(channelId, buildLegacyAnnouncementMessage(), { reply_markup: legacyAnnouncementButton() });
    return { status: 'sent' };
  } catch (e) {
    return { status: 'failed', reason: 'send_failed' };
  }
  ```
- **Dampak**: RPC `claim_legacy_channel_announcement` langsung mengunci status pengumuman sebelum pesan dikirim. Ketika `bot.sendMessage` gagal (gangguan bot/jaringan/izin channel), fungsi mengembalikan `{ status: 'failed' }` namun guard di database sudah terlanjur tercatat. Pemanggilan ulang berikutnya selalu ditolak sebagai `{ status: 'duplicate' }`, memblokir pengumuman selamanya.
- **Bukti Uji**: `test/telegram-fase6-batch2-bugs.test.js` (Test 4 gagal: pemanggilan ulang menghasilkan `'duplicate'`).
- **Usulan Perbaikan**: Terapkan mekanisme two-phase commit atau rollback status klaim jika `bot.sendMessage` melempar kegagalan.

---

### BUG-F6-010: Inkonsistensi Filter Sinyal Terarsip Merusak Summary dan Jumlah Sinyal pada Daily Recap
- **File**: `lib/telegram-daily-recap.js:146-157`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  async function generateDailyAfternoonRecap(supabase, targetDate, options = {}) {
    const { date, picks } = await fetchPicksForRecap(supabase, targetDate);
    const message = formatDailyAfternoonRecapMessage(picks, date, options);
    const trackData = trackRecordService.buildTrackRecordData(picks);

    return {
      date,
      total_signals: (picks || []).length,
      summary: trackData.summary,
      by_category: trackData.by_category,
      message
    };
  }
  ```
- **Dampak**: `formatDailyAfternoonRecapMessage` mengecualikan sinyal terarsip (`history_archived_at` / `archived_at`), sedangkan `generateDailyAfternoonRecap` menyusun `total_signals` dan `summary` langsung dari data mentah `picks`. Hal ini menimbulkan inkonsistensi: teks notifikasi melaporkan jumlah sinyal bersih (misal 1), namun metadata API melaporkan sinyal terarsip/uji coba (misal 2), merusak rekapitulasi data performa bursa.
- **Bukti Uji**: `test/telegram-fase6-batch2-bugs.test.js` (Test 5 gagal: `recap.total_signals` bernilai 2 bukan 1).
- **Usulan Perbaikan**: Filter `picks` sebelum diproses ke `trackRecordService.buildTrackRecordData` dan penghitungan `total_signals`.

---

### BUG-F6-011: `isDrasticStatusChange` pada Webhook Alert Engine Mengabaikan dan Menekan Sinyal TP1, TP2, dan Distribusi Bandar
- **File**: `lib/webhook-alert-engine.js:85-107`
- **Severity**: CRITICAL
- **Kode Bermasalah**:
  ```javascript
  function isDrasticStatusChange(cachedEntry, candidate) {
    if (!cachedEntry) return false;
    const prevStatus = normalizeStatus(cachedEntry.status);
    const nextStatus = normalizeStatus(candidate.status || candidate.final_status);

    const wasNeutral = prevStatus.includes('WATCHLIST') || prevStatus.includes('RADAR') || prevStatus.includes('PULLBACK') || prevStatus.includes('SPECULATIVE');
    const isNowBuy = isConfirmedBuyStatus(nextStatus);
    if (wasNeutral && isNowBuy) {
      return true;
    }

    const isNowAvoid = nextStatus.includes('AVOID') || nextStatus.includes('SL_HIT') || nextStatus.includes('INVALID');
    const wasNormal = !prevStatus.includes('AVOID') && !prevStatus.includes('SL_HIT');
    if (isNowAvoid && wasNormal) {
      return true;
    }

    return false;
  }
  ```
- **Dampak**: Jika ticker sebelumnya memicu sinyal beli (`A_PLUS_SETUP`), lalu beberapa menit kemudian mencapai take profit (`TP1_HIT`, `TP2_HIT`) atau terdeteksi distribusi bandar (`EARLY_EXIT_DISTRIBUTION`), `isDrasticStatusChange` mengembalikan `false`. `checkCooldown` menganggap sinyal sebagai duplikat dan menekan pengiriman alert. Pengguna terlambat atau tidak pernah menerima notifikasi take-profit dan penyelamatan modal.
- **Bukti Uji**: `test/telegram-fase6-batch3-bugs.test.js` (Test 1 gagal: `tp1Check.shouldDrop` bernilai `true`, `distCheck.shouldDrop` bernilai `true`).
- **Usulan Perbaikan**: Sertakan `TP1_HIT`, `TP2_HIT`, `EARLY_EXIT_DISTRIBUTION`, `BEP_CLOSED`, dan `TRAILING_STOP` ke dalam status yang diizinkan mem-bypass cooldown.

---

### BUG-F6-012: Pengabaian Hard Market Gate pada `sendAlert` Saat `options.now` Tidak Disertakan Pemanggil
- **File**: `lib/webhook-alert-engine.js:533-543`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  const marketNow = options.now != null ? options.now : null;
  if (marketNow != null && isMarketSessionClosed(marketNow)) {
    return {
      success: false,
      skipped: true,
      reason: 'market_session_closed',
      ticker,
      channels: {}
    };
  }
  ```
- **Dampak**: Pada lingkungan produksi, pemanggil webhook rutin memanggil `sendAlert(candidate, options)` tanpa menyuntikkan `options.now`. Karena `marketNow` bernilai `null`, kondisi `marketNow != null` bernilai `false`, dan evaluasi sesi bursa dilewati total. Akibatnya, sinyal dapat terkirim di luar jam bursa (malam hari, akhir pekan, atau sesi istirahat siang).
- **Bukti Uji**: `test/telegram-fase6-batch3-bugs.test.js` (Test 2 gagal: saat market CLOSED, `sendAlert` tetap mencoba dispatch dan tidak mengembalikan `reason: 'market_session_closed'`).
- **Usulan Perbaikan**: Gunakan `const marketNow = options.now != null ? options.now : new Date()` agar evaluasi sesi bursa selalu aktif secara default.

---

### BUG-F6-013: Ketiadaan Pemotongan Chunk Pesan pada `dispatchTelegram` Memicu Error HTTP 400 Bad Request untuk Pesan Panjang
- **File**: `lib/webhook-alert-engine.js:429-438`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
  const body = {
    chat_id: String(chatId).trim(),
    text,
    disable_web_page_preview: true
  };

  const response = await fetch(url, { ... });
  ```
- **Dampak**: Telegram membatasi panjang teks `sendMessage` maksimal 4096 karakter. Berbeda dengan `lib/telegram-notifier.js` yang memecah pesan via `splitTelegramMessage`, `webhook-alert-engine.js` mengirimkan `text` apa adanya. Bila kartu sinyal berisi detail teknikal yang panjang (>4096 karakter), permintaan langsung ditolak mentah-mentah oleh server Telegram dengan HTTP 400 Bad Request tanpa upaya pemecahan chunk.
- **Bukti Uji**: `test/telegram-fase6-batch3-bugs.test.js` (Test 3 gagal: teks berukuran 4500 karakter dikirim utuh dalam satu payload).
- **Usulan Perbaikan**: Integrasikan `splitTelegramMessage` pada `dispatchTelegram` atau delegasikan pengiriman Telegram melalui modul `telegram-notifier.js`.

---

### BUG-F6-014: `createChatInviteLink` Mengabaikan Parameter `expire_date` Unix Timestamp dan Mengunci Opsi `creates_join_request`
- **File**: `lib/telegram-verify-bot.js:154-167`
- **Severity**: MEDIUM
- **Kode Bermasalah**:
  ```javascript
  async function createChatInviteLink(chatId, options) {
    const ttl = (options && options.expireSeconds) || INVITE_TTL_SECONDS;
    let name = (options && typeof options.name === 'string' && options.name) ? options.name : INVITE_LINK_NAME;
    if (name.length > INVITE_NAME_MAX) name = name.slice(0, INVITE_NAME_MAX);
    const payload = {
      chat_id: chatId,
      expire_date: Math.floor(Date.now() / 1000) + ttl,
      creates_join_request: true,
      name: name
    };
    const result = await callTelegram('createChatInviteLink', payload);
    return result && result.invite_link ? result.invite_link : null;
  }
  ```
- **Dampak**: Jika pemanggil menyediakan parameter resmi Telegram Bot API `expire_date` (Unix timestamp), parameter tersebut diabaikan total karena kode secara kaku selalu menghitung ulang `expire_date = Math.floor(Date.now() / 1000) + ttl`. Selain itu, `creates_join_request: true` dipaksakan tanpa memedulikan nilai `options.creates_join_request`, sehingga fungsi tidak dapat digunakan untuk menghasilkan link undangan langsung saat diperlukan.
- **Bukti Uji**: `test/telegram-fase6-batch3-bugs.test.js` (Test 4 gagal: `expire_date` eksplisit diabaikan dan ditimpa, `creates_join_request: false` dipaksa menjadi `true`).
- **Usulan Perbaikan**: Utamakan `options.expire_date` jika tersedia, dan izinkan `creates_join_request` bernilai boolean sesuai opsi pemanggil.
# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 7 (Frontend UI, Charts & Client Runtime)
Dokumentasi temuan bug Fase 7. Read-only kode produksi, dibuktikan lewat failing unit test di test/.
Fokus khusus: Kalkulasi lot/risk position sizing, simulasi portfolio, pattern safety, label direction, dan rendering geometri teknikal.

---

### BUG-F7-001: Sanitasi Angka Menghapus Titik Desimal pada Input 3 Digit Desimal
- **Lokasi**: `public/position-sizing-calculator.js:28-34`
- **Severity**: HIGH
- **Kutipan Kode**:

### BUG-F7-017: inlineFormat Stripping Merusak Identifier di Dalam Tag <code>
- **File:** public/ai-chat-renderer.js
- **Fungsi:** inlineFormat(value)
- **Deskripsi:** Regex pembersih merusak token di dalam <code>.
- **Reproduksi:** test/frontend-fase7-batch4-bugs.test.js

### BUG-F7-018: splitTableRow Memecah Sel Tabel pada Escaped Pipe
- **File:** public/ai-chat-renderer.js
- **Fungsi:** splitTableRow(line)
- **Deskripsi:** Baris tabel markdown di-split naif dengan tanda pipa.
- **Reproduksi:** test/frontend-fase7-batch4-bugs.test.js
# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 8 (Database Schema, Supabase RPC, Migrations & Integrity)
Dokumentasi temuan bug Fase 8. Read-only kode produksi, dibuktikan lewat failing unit test di test/tools-fase8-bugs.test.js dan test/supabase-fase8-batch1-bugs.test.js.
Fokus khusus: Celah RLS, race condition, kebocoran resource connection pool, unhandled exception/rejection, dan timeout guard.

---

### [TOOLS-BUG-01] Missing Rate-Limit dan Connection Timeout Guard pada VPS API Server
- **Lokasi**: `tools/vps-api-server.js:76-88`, `tools/vps-api-server.js:185-195`
- **Kode Bermasalah**:

### BUG-DB-006: Missing FOR UPDATE pada Voucher Lookup di create_manual_subscription_payment
- **File:** supabase/subscription-manual-payment-migration.sql
- **Fungsi:** create_manual_subscription_payment
- **Deskripsi:** Query voucher tidak mengunci baris, membuka celah konkurensi pemakaian kuota berlebih.
- **Reproduksi:** test/supabase-fase8-batch2-bugs.test.js

### BUG-DB-007: Overwrite Masa Aktif Tanpa Entitlement Stacking pada Manual Payment Review
- **File:** supabase/subscription-manual-payment-migration.sql
- **Fungsi:** review_manual_subscription_payment
- **Deskripsi:** Tanggal kedaluwarsa dihitung dari now() bukan akumulatif dari current_period_end.
- **Reproduksi:** test/supabase-fase8-batch2-bugs.test.js

### BUG-DB-008: Ketiadaan Terminal State Guard pada Alur Approval Pembayaran Manual
- **File:** supabase/subscription-manual-payment-migration.sql
- **Fungsi:** review_manual_subscription_payment
- **Deskripsi:** Transisi status tidak mengunci status akhir, memungkinkan perubahan berulang setelah approved/rejected.
- **Reproduksi:** test/supabase-fase8-batch2-bugs.test.js

### BUG-DB-009: app_user_portfolio_state Kehilangan Trigger Otomatis updated_at
- **File:** supabase/portfolio-state-persistence-migration.sql
- **Objek:** Table public.app_user_portfolio_state
- **Deskripsi:** Tabel memiliki indeks updated_at DESC tetapi tidak ada trigger BEFORE UPDATE untuk menetapkan updated_at = now(). Mutasi partial pada state membuat timestamp tidak sinkron.
- **Reproduksi:** test/supabase-fase8-batch3-bugs.test.js
# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 9 (Cron, Deploy, Daemons & Tools)
Dokumentasi temuan bug Fase 9. Read-only kode produksi, dibuktikan lewat failing unit test di test/.
Fokus audit: Sintaks cron & time zone drift, race condition concurrency di shell script (flock / pid lock), unhandled error exit code, env credential propagation, dan daemon process supervision.

### BUG-OPS-004: final-schedule.cron Memanggil Bare Node dan Mengabaikan Concurrency Lock
- **File:** deploy/vps/final-schedule.cron
- **Deskripsi:** Crontab memanggil tools node langsung alih-alih wrapper .sh yang memiliki proteksi flock -n, membuka celah race condition tumpang tindih proses.
- **Reproduksi:** test/ops-fase9-batch1-bugs.test.js
- **Status:** CLOSED / VERIFIED (Dialihkan ke deploy/vps/*.sh dengan proteksi flock dan penanganan lock aman)

### BUG-OPS-005: final-schedule.cron Kehilangan Direktif Header CRON_TZ
- **File:** deploy/vps/final-schedule.cron
- **Deskripsi:** Tidak adanya direktif CRON_TZ=Asia/Jakarta menyebabkan cron daemon pada server VPS berzona waktu UTC mengeksekusi pekerjaan pada waktu yang tidak sesuai.
- **Reproduksi:** test/ops-fase9-batch1-bugs.test.js
- **Status:** CLOSED / VERIFIED (Header direktif CRON_TZ=Asia/Jakarta telah ditetapkan)

### BUG-OPS-006: vps-api-server Terekspos Publik Tanpa Autentikasi Token
- **File:** tools/vps-api-server.js
- **Deskripsi:** Server mendengarkan pada 0.0.0.0 dengan CORS '*' dan melayani data broker summary, bandarmologi intel, serta insider roster tanpa proteksi API key / token header.
- **Reproduksi:** test/ops-fase9-batch2-bugs.test.js
- **Status:** CLOSED / VERIFIED (Mekanisme validasi Authorization Bearer / X-API-Key guard telah diaktifkan)

### BUG-OPS-007: Ketiadaan Graceful Shutdown Handler pada vps-api-server
- **File:** tools/vps-api-server.js
- **Deskripsi:** Server tidak menangkap sinyal SIGTERM atau SIGINT, menyebabkan socket tertahan dan port bentrok (EADDRINUSE) saat daemon di-restart oleh orchestrator VPS.
- **Reproduksi:** test/ops-fase9-batch2-bugs.test.js
- **Status:** CLOSED / VERIFIED (Handler sinyal SIGTERM dan SIGINT telah diintegrasikan dengan pemanggilan stopDaemon)

### BUG-OPS-008: refresh-sector-hot Menelan Error Upsert Member Secara Diam-diam
- **File:** scripts/refresh-sector-hot.js
- **Deskripsi:** Kegagalan mutasi memberRows hanya dicetak ke konsol tanpa menghentikan eksekusi atau mengembalikan exit code non-zero, membiarkan metadata berstatus sukses padahal data parsial hilang.
- **Reproduksi:** test/ops-fase9-batch3-bugs.test.js
- **Status:** CLOSED / VERIFIED (Kegagalan upsert member dan group memicu rethrow exception dan pembaruan metadata failed)

### BUG-OPS-009: updateMeta Di-hardcode Status 'ok' Tanpa Evaluasi Kegagalan Parsial
- **File:** scripts/refresh-sector-hot.js
- **Deskripsi:** Fungsi updateMeta selalu mencatat status 'ok' dan pesan sukses tanpa memeriksa apakah terjadi kesalahan upsert grup atau anggota.
- **Reproduksi:** test/ops-fase9-batch3-bugs.test.js
- **Status:** CLOSED / VERIFIED (Kalkulasi status mengevaluasi failedCount > 0 menghasilkan status partial secara deterministik)
