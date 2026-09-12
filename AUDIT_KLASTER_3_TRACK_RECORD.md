# LAPORAN AUDIT FORENSIK KLASTER 3: TRACK RECORD & BACKTESTING ENGINE

**Target Branch:** `feat/daytrade-screener-v1`
**Auditor:** Senior Release Engineer & Algorithmic Auditor
**Status:** AUDITED & SECURED (PASS WITH DEFECT PATCH)

---

## 1. Executive Summary

Audit forensik Klaster 3 berfokus pada keabsahan matematis, integritas data historis, bebas dari bias masa depan (zero lookahead bias), serta keakuratan pelaporan performa sinyal (Track Record, Backtesting Engine, dan Telegram Daily Recap).

### Sinkronisasi Klaster 2 (Day Trade V7 Engine)
- **PR #628** telah di-squash merge ke `feat/daytrade-screener-v1` pada commit `ba121ec`.
- Perubahan telah di-pull dan diverifikasi langsung pada Oracle VPS (`168.110.221.197`):
  - `node --test test/daytrade-v7-engine-integrity.test.js`: **20/20 PASS** (248 ms).
  - `npm run test:smoke`: **67 files, 77 test suites 100% PASS** (2.4 detik).

### Hasil Audit Klaster 3
- **PR #503 (Entry Range Ordering)**: Diverifikasi aman. Rentang harga entry selalu diurutkan dari terendah ke tertinggi secara numerik (`[Math.min, Math.max]`), kebal terhadap lexical sorting bug.
- **PR #500 & #530 (WIB Timestamp & Timezone Offset)**: Diverifikasi aman. Konversi ISO UTC ke WIB menggunakan `Intl.DateTimeFormat` dengan zona waktu `Asia/Jakarta`, bebas dari risiko double-offset (+14 jam).
- **PR #531 (Backtesting Engine & Zero Lookahead Bias)**: Diverifikasi aman. Simulasi harga eksekusi menggunakan rata-rata aritmatika rentang entry, urutan transaksi kronologis strictly sequential, dan evaluasi hasil hanya menggunakan event log sinyal tanpa intip candle masa depan.
- **PR #546 (Daily Afternoon Recap Runner)**: Diverifikasi aman. Evaluasi sinyal sore (16:15 WIB) mengelompokkan sinyal aktif (`RUNNING`, `ENTRY_HIT`, `WAITING`) ke dalam kategori "MASIH DALAM PANTAUAN / FLOATING" dan tidak mematikan sinyal prematur.
- **PR #559 (All-Time Untung Terbesar Card)**: **LATENT BUG DITEMUKAN & DIPERBAIKI**. Ditemukan bug pada evaluasi `bestGain` di mana dataset yang hanya berisi `SL_HIT` menyebabkan kerugian (misal -4%) tercatat sebagai "Untung Terbesar" dan tampil sebagai `+-4%` di UI. Telah dipasang guard `gainPct > 0 && gainPct <= 500` dan ditambahkan unit test verifikasi.

---

## 2. Analisis Forensik per Komponen

### 2.1. PR #503: Validasi Urutan Entry Range Low-to-High
- **Berkas**: `public/track-record-runtime.js` (`trEntryBounds(s)`)
- **Tujuan**: Memastikan rentang entry yang ditampilkan di antarmuka tabel dan diekspor ke CSV selalu berurutan dari angka terendah ke tertinggi.
- **Hasil Audit**:
  - Pada sinyal mentah, field `entry1` dan `entry2` dapat terisi terbalik tergantung tipe setup (misal: entry1=420, entry2=410 pada buy on weakness).
  - Fungsi `trEntryBounds(s)` mem-parsing kedua nilai dengan `Number(val)`, menyaring nilai non-finite (`!Number.isFinite`), lalu mengembalikan `[Math.min(a, b), Math.max(a, b)]`.
  - Penanganan nilai string numerik: Menghindari bug bawaan Javascript di mana pengurutan string secara leksikal menganggap `'1000'` lebih kecil daripada `'950'`.
  - Edge Cases:
    - Jika kedua nilai sama (`low === high`), dikompres menjadi 1 nilai representatif.
    - Jika salah satu bound kosong/null, bound tunggal yang valid tetap dirender tanpa crash.
    - Nilai NaN atau invalid digantikan dengan placeholder aman (`'—'`).
  - **Verifikasi**: `test/track-record-entry-range-order.test.js` mencakup 12 unit test dan lulus 100%.

### 2.2. PR #500 & #530: Integritas Timestamp & Zona Waktu WIB
- **Berkas**: `lib/track-record-service.js` (`formatWibTime(timestamp)`)
- **Tujuan**: Mencegah kesalahan pergeseran waktu (timezone shift) dan anomali double-offset +14 jam.
- **Hasil Audit**:
  - Database dan broker feed menyimpan timestamp dalam format standar ISO 8601 UTC (contoh: `2026-08-20T02:30:00.000Z`).
  - Pemformatan waktu menggunakan `Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false })`.
  - Mencegah double-offset: Pada sistem legasi, sering kali developer menambahkan `+ 7 * 3600 * 1000` secara manual ke objek `Date`, lalu memformatnya dengan locale Jakarta sehingga waktu melompat 14 jam ke depan. `formatWibTime` menerima timestamp murni dan menyerahkan konversi zona waktu sepenuhnya ke engine V8 tanpa mutasi tanggal aritmatika.
  - Nilai `null`, `undefined`, atau invalid date secara deterministik menghasilkan `'—'`.
  - **Verifikasi**: Teruji pada `test/track-record-service.test.js`.

### 2.3. PR #531: Audit Mesin Backtest & Zero Lookahead Bias
- **Berkas**: `public/track-record-backtest.js`, `test/track-record-backtest.test.js`
- **Tujuan**: Memverifikasi model simulasi trading realistis, tidak over-optimistic, dan bebas dari bias intip masa depan (lookahead bias).
- **Hasil Audit**:
  1. **Model Harga Eksekusi (Execution Entry)**:
     - Harga eksekusi dihitung dengan formula rata-rata titik masuk:
       $$\text{execution\_entry} = \frac{\text{entry1} + \text{entry2}}{2}$$
     - Jika hanya `entry1` yang terisi, maka `execution_entry = entry1`.
     - Model ini mencerminkan antrean riil order book di bursa (tidak mengasumsikan selalu tereksekusi di harga terbaik/termurah).
  2. **Pengurutan Transaksi Kronologis**:
     - Array transaksi diurutkan secara strictly ascending berdasarkan `first_sent_at`:
       `trades.sort((a, b) => new Date(a.first_sent_at) - new Date(b.first_sent_at))`
     - Mengeliminasi pengurutan acak yang dapat mendistorsi kurva drawdown kumulatif.
  3. **Zero Lookahead Bias**:
     - Sistem hanya mengevaluasi status final (`TP1_HIT`, `TP2_HIT`, `SL_HIT`) berdasarkan event log yang tercatat saat sinyal aktif.
     - Rasio Risk-to-Reward (R:R) dihitung murni dari level trading plan yang dirilis SEBELUM posisi dimasuki:
       $$\text{R:R} = \frac{\text{TP1} - \text{Entry}}{\text{Entry} - \text{SL}}$$
  4. **Metrik Finansial & Drawdown**:
     - Perhitungan kurva ekuitas, peak balance, drawdown persentase, profit factor, dan win rate diverifikasi akurat secara deterministik.
  - **Verifikasi**: `test/track-record-backtest.test.js` (7/7 PASS).

### 2.4. PR #546: Runner Rekap Harian Sore (16:15 WIB)
- **Berkas**: `tools/run-daily-afternoon-recap.js`, `lib/telegram-daily-recap.js`
- **Tujuan**: Menjamin rekap performa otomatis paska penutupan bursa transparan dan tidak mengabaikan sinyal yang masih berjalan.
- **Hasil Audit**:
  - Dijalankan terjadwal setiap sore (16:00 - 16:15 WIB).
  - **Guard Sinyal Mengambang (Floating Guard)**:
    - Sinyal yang telah mencapai resolusi final (`TP1_HIT`, `TP2_HIT`, `SL_HIT`) dicatat pada kelompok hasil terwujud.
    - Sinyal yang belum menyentuh TP ataupun SL (`RUNNING`, `ENTRY_HIT`, `WAITING`, `IN_ENTRY_ZONE`) tidak dipaksa ditutup atau dicap kadaluarsa, melainkan ditampilkan transparan pada section **"MASIH DALAM PANTAUAN / FLOATING"**.
  - **Resiliensi Lingkungan**:
    - Script mendukung flag `--dry-run` dan menyediakan fallback reporting ketika kredensial Supabase tidak di-set di lingkungan lokal, mencegah kegagalan pipeline CI.
  - **Verifikasi**: `test/run-daily-afternoon-recap.test.js` (5/5 PASS).

### 2.5. PR #559: Temuan Bug Latent Kartu "Untung Terbesar" & Solusinya
- **Berkas**: `lib/track-record-service.js` (`buildTrackRecordData`)
- **Deskripsi Bug**:
  - Pada PR #559 terdahulu, logika penentuan sinyal dengan keuntungan terbesar ditulis:
    ```javascript
    if (gainPct != null && (!bestGain || gainPct > bestGain.gain_pct)) {
      bestGain = { gain_pct: gainPct, ticker: signalTicker, date: signalDate };
    }
    ```
  - Developer berasumsi: *"SL hits otomatis tidak pernah menang karena gain_pct-nya negatif"*.
  - **Anomali Nyata**: Jika dalam suatu rentang filter (atau hari pasar berdarah) seluruh sinyal berakhir dengan `SL_HIT` (misal sinyal pertama rugi -4%), maka saat iterasi sinyal pertama variabel `!bestGain` bernilai `true` (karena `bestGain` masih `null`).
  - Akibatnya, `bestGain` diisi dengan kerugian tersebut (`gain_pct: -4`), dan UI merender: **"Untung Terbesar: +-4% (BRIS)"**. Ini memalukan dan merusak kredibilitas sistem.
  - Selain itu, bila ada data anomali ekstrem (misal unadjusted corporate action / stock split dengan gain > 500%), angka rusak tersebut dapat mengotori kartu ringkasan.
- **Solusi & Patch yang Diterapkan**:
  - Logika evaluasi diperketat:
    ```javascript
    if (gainPct != null && gainPct > 0 && gainPct <= 500 && (!bestGain || gainPct > bestGain.gain_pct)) {
      bestGain = { gain_pct: gainPct, ticker: signalTicker, date: signalDate };
    }
    ```
  - Syarat `gainPct > 0`: Menjamin bahwa hanya sinyal yang benar-benar untung (profit positif) yang dapat menjadi kandidat "Untung Terbesar". Jika seluruh sinyal merah/floating, `best_gain` tetap bernilai `null` dan UI menampilkannya dengan elegan.
  - Syarat `gainPct <= 500`: Menyaring anomali split data/glitch feed bursa yang tidak wajar.
- **Pengujian Tambahan**:
  - Ditambahkan kasus uji khusus pada `test/track-record-service.test.js` untuk memastikan dataset yang hanya berisi `SL_HIT` menghasilkan `best_gain: null` dan outlier `> 500%` diabaikan.
  - Seluruh 7 tes pada `test/track-record-service.test.js` lulus 100%.

---

## 3. Matriks Pengujian & Verifikasi

| Modul Uji | Berkas Test | Jumlah Test | Status |
| :--- | :--- | :--- | :--- |
| Entry Range Order Low-to-High | `test/track-record-entry-range-order.test.js` | 12 tests | **PASS (100%)** |
| Backtesting Engine & Simulation | `test/track-record-backtest.test.js` | 7 tests | **PASS (100%)** |
| Daily Afternoon Recap Runner | `test/run-daily-afternoon-recap.test.js` | 5 tests | **PASS (100%)** |
| Track Record Service & Best Gain Guard | `test/track-record-service.test.js` | 7 tests | **PASS (100%)** |
| Global Smoke Test Suite | Seluruh 67 test files (`npm run test:smoke`) | 77 suites | **PASS (100%)** |

---

## 4. Kesimpulan & Rekomendasi Rilis

1. **Klaster 3 Dinyatakan Lulus Audit**:
   - Seluruh logika bisnis penelusuran rekam jejak sinyal, integritas zona waktu, simulasi backtest tanpa lookahead bias, dan generator rekap harian telah terverifikasi kuat dan akurat.
2. **Bug Tersembunyi Telah Ditambal**:
   - Cacat logika pada kartu "Untung Terbesar" telah dieliminasi total dengan guard positif & validasi batas atas.
3. **Langkah Rilis Selanjutnya**:
   - Menunggu persetujuan user untuk melakukan commit file `lib/track-record-service.js`, `test/track-record-service.test.js`, dan `AUDIT_KLASTER_3_TRACK_RECORD.md` ke branch perbaikan:
     `fix/track-record-best-gain-guard`
   - Melakukan push, pull request, dan squash merge ke branch target `feat/daytrade-screener-v1`.
