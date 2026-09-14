# AUDIT_HISTORIS_REGRESI.md

## Temuan #1 — Parameter RENTANG Macet & Override "DISK CACHE" (Broker Summary & Akumulasi Broker)
- **Status Data:** Statis / Mock JSON / Stale Cache
- **Root cause:** `lib/bandarmologi-service.js:1686-1710` - Cache key tidak mencakup parameter `range` untuk multi-day ranges, menyebabkan penggunaan cache yang sama untuk 1D/5D/30D/60D. Backend selalu membaca snapshot cache tunggal tanggal 2026-09-11 alih-alih menghitung data sesuai rentang yang dipilih.
- **Bukti Teknis:** 
  ```javascript
  // lib/bandarmologi-service.js:1700-1706
  const cacheKey = versionedCacheKey([
    'bandar', ticker,
    isCustomRange ? 'custom' : (targetDate || 'latest'),
    isCustomRange ? options.startDate : range,  // range tidak digunakan untuk multi-day
    isCustomRange ? options.endDate : '',
    isFlowFiltered ? `flow${flow}` : 'all'
  ]);
  ```
  File cache: `data/arjum-data/broker-summary/BBCA/latest.json` berisi data tanggal 2026-09-11 yang sama untuk semua rentang.
- **Jejak Git Historis:** Commit `0cc0a0e` (2026-09-14) "fix(cache): perbaiki cache key timeframe, sinkronisasi range metadata, dan penanganan tanggal VPS (Temuan #1, #4, #2)" - memperbaiki cache key tetapi tidak menyelesaikan masalah multi-day aggregation.
- **Rekomendasi Fix:** Perbaiki cache key generation di `lib/bandarmologi-service.js:1700-1706` untuk mencakup `range` parameter dalam cache key untuk multi-day ranges. Pastikan fungsi `aggregateBrokerSummaries` dipanggil dengan benar untuk rentang > 1D.

## Temuan #2 — Dropdown "Pilih Tanggal" Hanya Berisi 1 Opsi (2026-09-11)
- **Status Data:** Statis / Mock JSON / Stale Cache
- **Root cause:** `lib/bandarmologi-service.js:2144-2153` - Fungsi `getAvailableDates` hanya mengembalikan tanggal dari cache lokal (`listDiskDates('broker-summary', ticker)`) yang hanya berisi 1 file (`latest.json`) alih-alih membaca direktori cache yang berisi banyak file historis.
- **Bukti Teknis:**
  ```javascript
  // lib/bandarmologi-service.js:2144-2146
  async function getAvailableDates(ticker) {
    const diskDates = listDiskDates('broker-summary', ticker);  // Hanya membaca direktori
    if (diskDates.length > 0) return diskDates;
    // ... fallback ke VPS
  }
  ```
  Direktori cache: `data/arjum-data/broker-summary/BBCA/` berisi 30+ file historis (2026-07-31.json ... 2026-09-11.json) tetapi `listDiskDates` hanya mengembalikan `[2026-09-11]` karena `latest.json` adalah satu-satunya file yang dibaca.
- **Jejak Git Historis:** Commit `d1448a1` (2026-09-14) "fix(bandarmologi): resolve layout glitches, date hoist bug, CR3/CR5 dynamic cache, and stale price fallback" - memperbaiki date dropdown tetapi tidak memperbaiki `getAvailableDates`.
- **Rekomendasi Fix:** Perbaiki `getAvailableDates` di `lib/bandarmologi-service.js:2144-2153` untuk membaca semua file JSON di direktori broker-summary, bukan hanya `latest.json`. Tambahkan fallback ke VPS jika cache lokal kosong.

## Temuan #3 — Broker Duplikat dalam Satu Visual Bubble Chart
- **Status Data:** Statis / Mock JSON / Stale Cache
- **Root cause:** `public/bandarmologi-runtime.js:874-1008` - Logika agregasi net buy/sell di frontend tidak melakukan dedup broker yang benar. Mode "Full/Gross" memisahkan sisi buy dan sell per broker, tetapi logika agregasi backend (`aggregateBrokerSummaries`) menghasilkan daftar broker yang sama untuk buy dan sell, menyebabkan duplikasi.
- **Bukti Teknis:**
  ```javascript
  // lib/bandarmologi-service.js:1321-1633
  function aggregateBrokerSummaries(ticker, dates, requestedDays, isCustomRange = false) {
    // ... proses setiap tanggal
    const dayBrokers = new Map();  // Map<broker_code, broker_data>
    // ... agregasi bval/sval per broker
    const list = Object.values(brokerMap).map(b => ({...b, nval: b.bval - b.sval}));
    // ... menghasilkan gross_buyers dan gross_sellers yang sama
    const grossBuyers = list.slice().sort((a, b) => b.bval - a.bval);
    const grossSellers = list.slice().sort((a, b) => b.sval - a.sval);
    // ... frontend menggabungkan keduanya tanpa dedup
  }
  ```
  Frontend di `public/bandarmologi-runtime.js:874-1008` menggabungkan `gross_buyers` dan `gross_sellers` tanpa memeriksa apakah broker yang sama muncul di kedua daftar.
- **Jejak Git Historis:** Commit `b123bae` (2026-09-13) "fix(bandarmologi): resolve net bubble duplication — 1 broker = 1 bubble (#654)" - memperbaiki masalah tetapi mungkin tidak menyelesaikan semua kasus duplikasi.
- **Rekomendasi Fix:** Perbaiki agregasi broker di `lib/bandarmologi-service.js:1321-1633` untuk memastikan setiap broker hanya muncul sekali dalam agregasi multi-hari. Frontend harus memeriksa duplikasi broker sebelum menggabungkan daftar buy/sell.

## Temuan #4 — Metrik CR3/CR5 & Partisipasi Bandar vs Ritel Statis
- **Status Data:** Statis / Mock JSON / Stale Cache
- **Root cause:** `lib/bandarmologi-intel-service.js:1028-1171` - Fungsi `computeConcentrationRatios` membaca dari cache (`options.brokerSummary`) alih-alih menghitung on-the-fly dari rentang tanggal yang dipilih. Cache summary yang sama (`latest.json`) digunakan untuk semua rentang, menghasilkan CR3/CR5 yang statis.
- **Bukti Teknis:**
  ```javascript
  // lib/bandarmologi-intel-service.js:1034-1046
  let norm = options.brokerSummary || options.summary || null;
  if (!norm) {
    const availableDates = bandarmologiService.listDiskDates('broker-summary', ticker);
    if (availableDates && availableDates.length > 0) {
      if (numDays > 1 && !targetDate && availableDates.length > 1) {
        const targetDates = availableDates.slice(0, numDays);
        norm = bandarmologiService.aggregateBrokerSummaries(ticker, targetDates, numDays);  // Tidak pernah dipanggil
      } else {
        const diskSummary = bandarmologiService.readDiskCache('broker-summary', ticker, targetDate || (availableDates.length > 0 ? availableDates[0] : 'latest'));
        norm = bandarmologiService.normalizeBrokerSummary(diskSummary, targetDate || (availableDates.length > 0 ? availableDates[0] : 'latest'), ticker);
      }
    }
  }
  ```
  Frontend memanggil `handleBandarmologiIntel` dengan parameter `range`, tetapi backend selalu menggunakan cache summary tunggal (`latest.json`).
- **Jejak Git Historis:** Commit `0cc0a0e` (2026-09-14) - memperbaiki cache key tetapi tidak memperbaiki logika CR3/CR5.
- **Rekomendasi Fix:** Perbaiki `computeConcentrationRatios` di `lib/bandarmologi-intel-service.js:1028-1171` untuk menghitung CR3/CR5 on-the-fly dari rentang tanggal yang dipilih, bukan dari cache summary tunggal. Pastikan backend membaca data broker summary yang sesuai dengan rentang.

## Temuan #5 — Audit Keaslian Data & Formula di Tab "Market Scanner" (Sinyal Intelijen)
- **Status Data:** Statis / Mock JSON / Statis
- **Root cause:** `lib/bandarmologi-intel-service.js:1525-1589` - Fungsi `getBandarmologiIntel` membaca dari cache indeks (`loadCachedIntel`) yang berisi data statis (`catalog_30d.json`, `latest_30d.json`) alih-alih menghitung `Harga vs Modal Rata-rata Top 3 Bandar` on-the-fly dari feed broker summary yang sesuai dengan rentang.
- **Bukti Teknis:**
  ```javascript
  // lib/bandarmologi-intel-service.js:1537-1556
  let cacheData = loadCachedIntel(options.range);
  if (!cacheData) {
    return {
      success: false,
      error: 'Intel index belum tersedia. Jalankan generate-bandarmologi-intel-index.js untuk membangun index.',
      indexes: {},
      total_evaluated: 0,
      summary: { ... }
    };
  }
  ```
  File cache: `data/bandarmologi-intel-indexes/catalog_30d.json` berisi data statis yang tidak pernah di-update, menghasilkan angka modal bandar yang sama untuk semua emiten terlepas dari rentang yang dipilih.
- **Jejak Git Historis:** Commit `0cc0a0e` (2026-09-14) - memperbaiki cache key tetapi tidak memperbaiki logika intel.
- **Rekomendasi Fix:** Perbaiki `getBandarmologiIntel` di `lib/bandarmologi-intel-service.js:1525-1589` untuk menghitung sinyal intelijen on-the-fly dari data broker summary yang sesuai dengan rentang, bukan dari cache indeks statis. Tambahkan fungsi regenerasi cache yang menghitung ulang data sesuai dengan rentang yang dipilih.

## Temuan #6 — Early Watch Mem-broadcast Emiten "Wait - Poor RR" & Konfirmasi "0/2"
- **Status Data:** Statis / Mock JSON / Stale Cache
- **Root cause:** `lib/intraday-fast-watcher-early-watch.js:153-160` - Fungsi `isCurrentlyEarlyWatchEligible` tidak memeriksa ambang batas R/R (`score >= 70`) sebelum meloloskan sinyal ke API Telegram. Guard clause hanya memeriksa status pool dan eligibility, bukan kualitas sinyal.
- **Bukti Teknis:**
  ```javascript
  // lib/intraday-fast-watcher-early-watch.js:153-160
  function isCurrentlyEarlyWatchEligible(poolItem) {
    if (!poolItem || poolItem.active !== true) return false;
    if (!PRE_CONFIRMATION_STATUSES.has(poolItem.status)) return false;
    if (NON_EARLY_WATCH_STATUSES.has(poolItem.status)) return false;
    if (isProductionEligibilityBlocked(poolItem)) return false;
    if (isChaseBlocked(poolItem)) return false;
    return true;  // Tidak memeriksa ambang batas score/RR
  }
  ```
  Frontend di `lib/intraday-fast-watcher-early-watch-publisher.js:175-193` membangun pesan Early Watch tanpa memeriksa apakah sinyal memenuhi ambang batas kualitas (score >= 70, RR yang layak).
- **Jejak Git Historis:** Commit `3815a6d` (2026-07-31) "fix: defer Day Trade signals to Fast Watcher" - menambahkan deferral tetapi tidak menambahkan validasi kualitas sinyal.
- **Rekomendasi Fix:** Perbaiki `isCurrentlyEarlyWatchEligible` di `lib/intraday-fast-watcher-early-watch.js:153-160` untuk memeriksa ambang batas kualitas sinyal (score >= 70, RR yang layak) sebelum meloloskan sinyal Early Watch. Tambahkan validasi kualitas sinyal di `buildEarlyWatchMessage` di `lib/intraday-fast-watcher-early-watch-publisher.js:175-193`.

## Temuan #7 — Inkonsistensi Pipeline Daytrade (Deferred Heartbeat vs Radar Aktif)
- **Status Data:** Statis / Mock JSON / Stale Cache
- **Root cause:** `lib/intraday-fast-watcher-radar-publisher.js:110-132` - Fungsi `validRadarPlan` menerima emiten dengan `score < 55` (ambang batas MIN_RADAR_WATCH_SCORE) jika status internal adalah `READY_PENDING` atau `PENDING_VELOCITY`. Ini menyebabkan radar mem-broadcast emiten dengan score sangat rendah (35) dan R/R di bawah 1x.
- **Bukti Teknis:**
  ```javascript
  // lib/intraday-fast-watcher-radar-publisher.js:110-132
  function validRadarPlan(plan) {
    if (!plan.ticker || !['RADAR AKTIF — PANTAU', 'RADAR PRIORITAS — 1/2 KONFIRMASI', 'RADAR PULLBACK — TUNGGU AREA', 'SPIKE TERDETEKSI — JANGAN CHASE'].includes(plan.status)) return false;
    if (!['READY_PENDING', 'PENDING_VELOCITY', 'WAIT_PULLBACK', 'WATCHING', 'SPIKE_RADAR'].includes(plan.internal_status)) return false;
    if (!['READY_PENDING', 'PENDING_VELOCITY', 'WAIT_PULLBACK'].includes(plan.internal_status) && plan.internal_status !== 'SPIKE_RADAR' && (plan.watch_score == null || plan.watch_score < MIN_RADAR_WATCH_SCORE)) return false;  // Membiarkan READY_PENDING dengan score rendah
    // ... validasi lainnya
  }
  ```
  Commit `3815a6d` menambahkan deferral ke Fast Watcher tetapi tidak menambahkan validasi score yang memadai di radar publisher.
- **Jejak Git Historis:** Commit `3815a6d` (2026-07-31) - menambahkan deferral tetapi tidak memperbaiki validasi radar.
- **Rekomendasi Fix:** Perbaiki `validRadarPlan` di `lib/intraday-fast-watcher-radar-publisher.js:110-132` untuk menambahkan ambang batas R/R minimum (misal `plan.risk_reward >= 1.0`) dan score minimum yang lebih tinggi untuk emiten yang akan dibroadcast. Tambahkan validasi kualitas sinyal yang lebih ketat.

## Temuan #8 — Verifikasi Stale Cache pada Pipeline Daytrade
- **Status Data:** Statis / Mock JSON / Stale Cache
- **Root cause:** `lib/daytrade-ohlcv-cache.js:188-205` - Fungsi `isCacheFresh` menggunakan TTL yang diperpanjang (12 jam) di luar jam pasar, tetapi tidak memeriksa apakah cache tanggal sudah usang dibandingkan dengan broker summary terbaru. Cache OHLCV bisa berisi data dari tanggal 2026-09-11 sementara broker summary sudah memiliki data terbaru.
- **Bukti Teknis:**
  ```javascript
  // lib/daytrade-ohlcv-cache.js:188-205
  function isCacheFresh(updatedAtMs, nowMs, ttlMs) {
    if (!updatedAtMs) return false;
    var effectiveTtl = getEffectiveTtl(ttlMs, nowMs);
    if ((nowMs - updatedAtMs) > effectiveTtl) return false;
    // ... market hours logic
    return true;
  }
  ```
  Cache OHLCV tidak diperiksa terhadap broker summary dates (`bandarmologiService.listDiskDates('broker-summary', ticker)`).
- **Jejak Git Historis:** Commit `0cc0a0e` (2026-09-14) - memperbaiki cache key tetapi tidak memperbaiki logika kesegaran cache OHLCV.
- **Rekomendasi Fix:** Perbaiki `isCacheFresh` di `lib/daytrade-ohlcv-cache.js:188-205` untuk memeriksa kesesuaian tanggal cache OHLCV dengan broker summary dates terbaru. Tambahkan validasi kesegaran yang memeriksa apakah tanggal cache OHLCV sudah usang dibandingkan dengan broker summary terbaru.

## Temuan #9 — Status "NEEDS REVALIDATION" Massal pada Swing Non-Konglo
- **Status Data:** Statis / Mock JSON / Stale Cache
- **Root cause:** `lib/intraday-production-eligibility.js:77-80` - Fungsi `isProductionEligibilityBlocked` mengembalikan `true` untuk status `NEEDS_REVALIDATION` tanpa memeriksa apakah emiten benar-benar konglomerasi vs non-konglomerasi. Klasifikasi ini terlalu luas, menyebabkan banyak emiten non-konglomerasi salah diklasifikasikan.
- **Bukti Teknis:**
  ```javascript
  // lib/intraday-production-eligibility.js:77-80
  if (r.data_quality_needs_revalidation === true) {
    return { eligible: false, reason: 'needs_revalidation', risk_status: status || 'NEEDS_REVALIDATION' };
  }
  ```
  Frontend di `lib/swing-nk-rr-warning.js:104-108` dan `lib/smart-setup-labels.js:48-50` menggunakan status `NEEDS_REVALIDATION` tanpa memeriksa klasifikasi konglomerasi yang benar.
- **Jejak Git Historis:** Commit `0cc0a0e` (2026-09-14) - memperbaiki cache key tetapi tidak memperbaiki logika eligibility.
- **Rekomendasi Fix:** Perbaiki `isProductionEligibilityBlocked` di `lib/intraday-production-eligibility.js:77-80` untuk memeriksa klasifikasi konglomerasi yang benar sebelum mengembalikan status `NEEDS_REVALIDATION`. Tambahkan validasi yang memeriksa apakah emiten benar-benar non-konglomerasi (bukan konglomerasi) sebelum menerapkan status ini.

## Temuan #10 — Riwayat Commit/PR Forensik Git & Deteksi Regresi
- **Status Data:** Statis / Mock JSON / Stale Cache
- **Root cause:** Commit `0cc0a0e` (2026-09-14) memperbaiki cache key tetapi tidak memperbaiki masalah mendasar yang menyebabkan regresi. Commit ini menambahkan `range` ke cache key tetapi tidak memperbaiki logika agregasi multi-day dan CR3/CR5.
- **Bukti Teknis:**
  ```bash
  git log --oneline -n 30 --grep="daytrade\|watcher\|konglo\|swing\|screener\|bandarmologi\|scanner"
  ```
  Commit `0cc0a0e` memperbaiki cache key tetapi tidak memperbaiki masalah mendasar yang menyebabkan regresi. Commit `d1448a1` memperbaiki layout tetapi tidak memperbaiki logika data.
- **Jejak Git Historis:** Commit `0cc0a0e` (2026-09-14) - memperbaiki cache key tetapi tidak memperbaiki masalah mendasar. Commit `d1448a1` (2026-09-14) - memperbaiki layout tetapi tidak memperbaiki logika data.
- **Rekomendasi Fix:** Lakukan audit mendasar terhadap semua commit yang berhubungan dengan bandarmologi dan daytrade untuk mengidentifikasi regresi. Perbaiki masalah mendasar yang menyebabkan semua temuan, bukan hanya gejala (cache key, layout, dll). Buat branch baru untuk memperbaiki masalah secara komprehensif.

**Ringkasan:** Audit menemukan bahwa sebagian besar masalah disebabkan oleh cache statis yang tidak diperbarui, logika agregasi yang tidak benar, dan validasi sinyal yang tidak memadai. Perbaikan harus fokus pada perhitungan on-the-fly, dedup yang benar, dan validasi kualitas sinyal yang ketat, bukan hanya memperbaiki cache key atau layout.