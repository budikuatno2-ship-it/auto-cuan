# LAPORAN INVESTIGASI: AUDIT INTEGRITAS FILE BROKER SUMMARY ASING, KARANTINA, DAN PERBAIKAN MEKANISME BACKFILL

**Tanggal & Waktu Audit:** Minggu, 18 Oktober 2026, 10:25 WIB  
**Direktori Data:** `/home/ubuntu/auto-cuan/data/arjum-data`  
**Branch:** [`feat/broksum-all-foreign`](deploy/vps/final-schedule.cron)  

---

## 1. Tabel Per Jam (WIB) × Field `flow`

Sensus lengkap terhadap seluruh 180.856 file di folder `broker-summary-F` menghasilkan rincian berikut:

| Jam Tulis (WIB) | File Asli (`flow: "F"`) | File Tercemar (`flow: "all"`) | File Rusak / Format Lain | Status & Keterangan |
|---|---|---|---|---|
| **2026-10-18 00:00** | **12.055** | **236** | 0 | Kuota habis pada request ke-12.055 (00:59:28 WIB), sisa 236 request mulai tercemar fallback |
| **2026-10-18 01:00** | 0 | **28.441** | 0 | Tercemar total (circuit breaker aktif, melayani disk cache `latest.json`) |
| **2026-10-18 02:00** | 0 | **28.319** | 0 | Tercemar total |
| **2026-10-18 03:00** | 0 | **28.182** | 0 | Tercemar total |
| **2026-10-18 04:00** | 0 | **28.039** | 0 | Tercemar total |
| **2026-10-18 05:00** | 0 | **27.905** | 0 | Tercemar total |
| **2026-10-18 06:00** | 0 | **27.679** | 0 | Tercemar total |
| **TOTAL** | **12.055** | **168.801** | **0** | **180.856 file total** (Pengecekan `stock_code`: 0 mismatch) |

---

## 2. Hasil Perbandingan Isi File (20 File Acak Non-F)

Pengujian komparasi mendalam pada 20 file acak berlabel `flow: "all"` di `broker-summary-F` membuktikan bahwa **100% (20/20) identik secara byte-exact dengan file `broker-summary/<TICKER>/latest.json`**:

```json
[
  { "ticker": "AALI", "date": "2026-01-02", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-01-19", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-02-02", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-02-18", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-03-04", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-03-25", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-04-09", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-04-23", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-05-08", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-05-26", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-06-12", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-06-29", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-07-13", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-07-27", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-08-10", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-08-26", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-09-09", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-09-23", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "AALI", "date": "2026-10-07", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true },
  { "ticker": "ABBA", "date": "2026-01-06", "flowF": "all", "identicalToDatedAll": false, "identicalToLatestAll": true }
]
```

**Temuan Lapangan Web (Uji Nyata AALI vs BBCA):**
- Pada saham **BBCA** (memiliki file Foreign asli):
  `all_buy_val = Rp 6.474.934.315.000` vs `foreign_buy_val = Rp 1.616.461.977.500` (Asing ≠ Semua, valid).
- Pada saham **AALI** (file `broker-summary-F` tercemar sebelum karantina):
  `all_buy_val = Rp 48.753.935.000` vs `foreign_buy_val = Rp 48.753.935.000` (Asing = Semua, dan Domestik menjadi Rp 0).

---

## 3. Jalur Kode Fallback yang Ditemukan (Root Cause)

Terdapat 3 kebocoran di [`lib/arjum-client.js`](lib/arjum-client.js:446):

1. **Jalur Circuit Breaker (Baris 446–451):**
   ```javascript
   if (isCircuitBreakerTripped()) {
     const fallbackCached = readLocalBrokerSummary(ticker, 'latest') || readLocalBrokerSummary(ticker, date);
     if (fallbackCached) {
       return { ok: true, status: 200, data: fallbackCached, fallback: true, rateLimited: true };
     }
   ```
   *Cacat:* Fungsi memanggil `readLocalBrokerSummary` tanpa meneruskan parameter `flow`, sehingga selalu membaca `broker-summary/<ticker>/latest.json` yang berisi `flow: "all"`, dan mengembalikannya dengan `status: 200, ok: true`!

2. **Jalur HTTP 429 / Rate Limited (Baris 520–524):**
   ```javascript
   if (!res.ok && res.rateLimited) {
     const fallbackCached = readLocalBrokerSummary(ticker, 'latest') || readLocalBrokerSummary(ticker, date);
     if (fallbackCached) {
       return { ok: true, status: 200, data: fallbackCached, fallback: true, rateLimited: true };
     }
   ```
   *Cacat:* Hal serupa terjadi jika API mengembalikan HTTP 429; kegagalan ditutupi dengan mengembalikan cache All berstatus `ok: true`.

3. **Jalur Validasi Worker Backfill ([`tools/backfill-broksum.js:455`](tools/backfill-broksum.js:455)):**
   ```javascript
   const resF = await arjumClient.fetchBrokerSummary(ticker, date, 'F', null, { allData: true, fresh: true });
   if (resF.ok && resF.data) {
     fs.writeFileSync(fFile, JSON.stringify(resF.data, null, 2), 'utf8');
   ```
   *Cacat:* Worker hanya mengecek `resF.ok && resF.data`. Karena `arjumClient` mengembalikan `ok: true` via fallback cache, worker menganggap respons tersebut sukses dan menyimpannya ke `broker-summary-F/`.

---

## 4. Eksekusi Karantina & Pemulihan State

Proses karantina telah dijalankan penuh tanpa menghapus file apapun:
- **Folder Karantina:** `/home/ubuntu/auto-cuan/data/arjum-data/_quarantine-F-20261018/`
- **File Dipindahkan ke Karantina:** **168.801 file** (semua file non-F yang tercemar).
- **File Asing yang Dipertahankan:** **12.055 file** (seluruh file autentik `flow: "F"` milik 64 emiten pertama + PSAB parsial).
- **Backup State:** `/home/ubuntu/auto-cuan/data/arjum-data/_backfill/state.backup-20261018.json` (dibuat sebelum pembersihan).
- **Update State:** 168.801 entri task yang tidak valid dihapus dari `state.json`. Sisa task terverifikasi di state: **12.055 task** (64 emiten selesai).

Verifikasi fisik di VPS pasca-karantina:
```
broker-summary-F (Asing Asli) : 12.055 file
_quarantine-F-20261018        : 168.801 file
Total                         : 180.856 file
```

---

## 5. Ringkasan Diff Perbaikan & Hasil Test

### a. `lib/arjum-client.js`:
- Parameter opsi `noFallback: true` didukung penuh.
- Saat circuit breaker aktif atau request rate-limited: jika `noFallback` atau `forceFresh` bernilai `true`, langsung kembalikan `{ ok: false, status: 429, ... }`.
- Jika fallback diizinkan (untuk UI), wajib memvalidasi kecocokan flow: permintaan `F` tidak akan pernah menerima data `all`.
- `readLocalBrokerSummary(ticker, date, 'F')` memverifikasi `parsed.flow === 'F'`.

### b. `tools/backfill-broksum.js`:
- Memanggil `fetchBrokerSummary` dengan opsi ketat `{ allData: true, fresh: true, forceLive: true, noFallback: true, bypassMarketGuard: true }`.
- Verifikasi penyimpanan ketat 5 lapis: `res.ok && res.status === 200 && !res.from_cache && !res.fallback && res.data.flow === 'F' && stock_code_match`.
- Hard-halt seketika jika terjadi 429, circuit breaker trip, atau data tidak valid.
- Jika header `x-ratelimit-remaining` absen, otomatis menggunakan `quotaTracker.getRemainingToday()`; jika kuota habis atau sisa ≤ cadangan (800 weekday / 4.500 sebelum EOD), worker berhenti rapi.

### c. `lib/bandarmologi-service.js`:
- Membaca disk cache `flow=F` hanya jika `diskSummaryRaw.flow === 'F'`.
- Bila data asing belum ada di disk (misal saham yang baru dikarantina), website mengembalikan status jujur:
  `{ success: false, status: "unarchived", error: "Data broker summary Asing ... belum diarsip." }`
  Alih-alih menyamakannya dengan Semua!

### d. `tools/run-daily-broker-update.js` (J1):
- Menambahkan proteksi `noFallback: true, forceLive: true` dan memvalidasi `resF.data.flow === 'F'` sebelum menyimpan data broker summary harian.

### e. Hasil Pengujian:
- **Unit Test Baru (`test/backfill-validation.test.js`):** **PASS (4/4)**.
- **Unit Test Paritas (`test/broksum-flow.test.js`):** **PASS (2/2)**.
- **Regresi Bandarmologi (`test/bandarmologi-integration.test.js`):** **PASS (31/31)**.
- **Ingestion Test (`test/audit-fase3-ingestion-cache-bugs.test.js`):** **PASS (11/11)**.
- **Dry-Run Backfill (`--only-foreign --limit 5 --dry-run`):**
  * Berhasil membaca 12.055 task yang sudah selesai (`Tasks Skipped: 12055`).
  * Memilih emiten yang benar berikutnya (`PSAB 2026-09-15`) tanpa error.
- **Web Live Test Pasca PM2 Restart:**
  * `BBCA` (`flow: F`): Berhasil memuat data Asing asli (`from_cache: true`).
  * `AALI` (`flow: F`): Berhasil menampilkan `{ success: false, status: "unarchived" }` (jujur, tidak menyamakan dengan Semua).

---

## 6. Proyeksi Penyelesaian Backfill & Kapasitas Kuota

- **Total Kebutuhan Task Asing:** 180.856 request (962 emiten × 188 hari).
- **Sudah Selesai (Autentik):** 12.055 request.
- **Sisa yang Perlu Diambil:** **168.801 request**.
- **Kapasitas Kuota Harian Arjum:** 12.060 request/hari.
- **Alokasi Kuota Harian:**
  * Job EOD Produksi (J1 + J2): ~3.500 request/hari (hari kerja).
  * Cadangan Backfill Hari Kerja (pasca EOD): ~7.500 – 8.500 request/hari.
  * Cadangan Backfill Akhir Pekan (Sabtu & Minggu): ~11.700 request/hari.
- **Perkiraan Waktu Selesai:**
  $$\frac{168.801 \text{ request}}{\sim 10.000 \text{ request/hari rata-rata}} \approx \mathbf{16\text{–}18\text{ hari}}.$$
- **Otomatisasi Cron:** Cron Senin pukul 00:07 WIB akan melanjutkan backfill asing secara presisi mulai dari request ke-12.056 tanpa intervensi manual.
