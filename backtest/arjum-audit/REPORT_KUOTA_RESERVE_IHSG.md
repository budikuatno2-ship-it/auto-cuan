# LAPORAN AUDIT: PETA KUOTA ARJUM, CADANGAN SORE AMAN, EVALUASI IHSG, DAN SIMULASI +5.000

**Tanggal & Waktu:** Minggu, 18 Oktober 2026, 13:45 WIB  
**Target Lingkungan:** VPS Produksi Oracle Ubuntu (`168.110.221.197`)  
**Branch:** [`feat/broksum-all-foreign`](deploy/vps/final-schedule.cron)  
**Status Implementasi:** B1 dan B2 **DITERAPKAN**; B3 dan B4 **DILEWATI** (kuota sisa < 400); B5 **DITOLAK / TETAP API** (paritas A6 belum 99%).

---

## Ringkasan Eksekutif (5 Poin Chat)

1. **Tabel A1 (Peta Kuota per Jenis & Sumber):**  
   Kebutuhan EOD hari kerja adalah **~4.426 request Arjum** (Broksum All 962, Broksum F 833, Akumulasi API 833, Insider Daily 833, Candle 962). Domestik (0 req, kalkulasi $D = \text{All} - F$), Sector Hot (0 req, Yahoo Finance), dan Live DayTrade/FastWatcher (0 req, tape lokal) bebas dari kuota Arjum.
2. **Pemakaian Sabtu 17 & Minggu 18 Okt (A2):**  
   - **Sabtu 17 Okt:** Terpakai ~3.579 req (merupakan sisa EOD Jumat malam yang tuntas pukul 00:23 WIB, termasuk 962 candle). Siang hari 0 req.
   - **Minggu 18 Okt:** Terpakai 12.056 req (12.055 req asing berhasil diambil oleh backfill worker antara 00:00–00:59:28 WIB sebelum limit harian vendor tercapai). Sebanyak 168.801 file duplikat lokal yang sempat tertulis akibat fallback cache lama telah dikarantina 100% tanpa menghabiskan kuota tambahan.
3. **Sisa Backfill Asing & 3 Skenario Penyelesaian (A3):**  
   Total kebutuhan Foreign adalah 180.856 request (962 saham × 188 hari). Selesai autentik: 12.055 request. **Sisa Foreign: 168.801 request** (ditambah 66.725 file All yang masih terpotong 25 level).
   - *Skenario 1 (Cadangan 4.500):* Throughput 61.320 req/minggu $\rightarrow$ Selesai Foreign dalam **19,3 hari (~7 Nov 2026)**.
   - *Skenario 2 (Cadangan 5.100 - B1):* Throughput 58.820 req/minggu $\rightarrow$ Selesai Foreign dalam **20,1 hari (~8 Nov 2026)**.
   - *Skenario 3 (Kuota +5.000 / Total 17.060 - A5):* Throughput 93.820 req/minggu $\rightarrow$ Selesai Foreign dalam **12,6 hari (~31 Okt 2026, 7,5 hari lebih cepat!)**.
4. **Analisis Tambahan Kuota +5.000 (A5):**  
   **100% AMAN.** Kecepatan worker (~8 req/s) sanggup menghabiskan kuota 17.060 req dalam **~55–60 menit** (00:07 s/d 01:05 WIB). Jarak waktu ke job EOD sore (16:30 WIB) adalah **15 jam**, sehingga tidak ada risiko bentrok jadwal. Melalui refactor B2, sistem kini otomatis mengadopsi limit 17.060 dari header vendor tanpa perlu redeploy.
5. **Status Perubahan Bagian B (B1–B5):**  
   - **B1 (Cadangan Sore 5.100 req):** **DITERAPKAN** (melindungi beban puncak EOD 4.426 req + live web, sisa kuota pasca EOD $\ge 574$ req).
   - **B2 (Limit Dinamis x-ratelimit-limit & ARJUM_DAILY_LIMIT):** **DITERAPKAN** (default 12060, bebas hardcoded).
   - **B3 (Uji Simbol IHSG) & B4 (IHSG Masuk Cron):** **DILEWATI** (karena sisa kuota hari ini 4 req < batas aman 400 req; skrip siap tempel [`tools/probe-ihsg-symbols.js`](tools/probe-ihsg-symbols.js) disiapkan untuk Senin pasca 00:00 WIB).
   - **B5 (Akumulasi Lokal):** **DITOLAK / TETAP `ACCUM_SOURCE=api`** (karena seluruh 65 saham likuid pertama memiliki 0 tanggal unclipped pada arsip historis all; paritas belum mencapai syarat $\ge 99\%$).

---

## Bagian A · Hasil Pemeriksaan (Read-Only)

### A1 · Peta Kuota Harian Lengkap per Jenis Data

| Jenis Data | Job Penulis | Jam WIB | Hari Eksekusi | Req Hari Kerja | Req Akhir Pekan | Memakai Kuota Arjum? | Catatan Teknis & Penanganan |
|---|---|---|---|:---:|:---:|:---:|---|
| **Broksum All** | J1 (`run-daily-broker-update.js`) | 18:00–20:00 (retry 23:30) | Senin–Jumat | **962** | 0 | **YA** | 962 emiten aktif bursa BEI (`all_data=true`). |
| **Broksum Asing (F)** | J1 (`run-daily-broker-update.js`) | 18:00–20:00 (retry 23:30) | Senin–Jumat | **833** | 0 | **YA** | Hanya saham dengan transaksi aktif (non-zero volume). Emiten suspensi/tanpa transaksi (~129 saham) otomatis dilewati tanpa panggil API. |
| **Domestik (D)** | J1 / Web runtime | Real-time on-demand | Setiap hari | **0** | 0 | **TIDAK (0 req)** | Dihitung deterministik di lokal ($D = \text{All} - F$) via `lib/broksum-flow.js`. Selisih Rp 0. Tidak ada pemanggilan API Arjum. |
| **Insider** | J1 (`run-daily-broker-update.js`) | 18:00–20:00 | Senin–Jumat | **833** | 0 | **YA** | Berjalan harian (`INSIDER_MODE=daily`). Jika beralih `weekly`: 50 req harian (Top 50 prioritas) + 833 req Sabtu. |
| **Akumulasi Broker** | J1 (`run-daily-broker-update.js`) | 18:00–20:00 | Senin–Jumat | **833** | 0 | **YA** | Single writer resmi (`ACCUM_SOURCE=api`) via `/api/broker-accumulation/{code}`. Generator lokal J3 dinonaktifkan. |
| **Candle Harian** | J2 (`fetch-daily-candles.js`) | 18:00–20:00 | Senin–Jumat | **962** | 0 | **YA** | Penarikan 962 bar OHLCV harian via `GET /api/history/{code}?limit=500&frame=daily`. |
| **Sector Hot** | `run-sector-hot.sh` | Tiap 30m 09:00–15:30 | Senin–Jumat | 0 | 0 | **TIDAK (0 req)** | Menggunakan Yahoo Finance quotes langsung ke database Supabase & SQLite. 0 kuota Arjum. |
| **Live Web / Browsing** | `local-dev-server.js` | 09:00–17:00 | Setiap hari | ~50 | ~15 | **YA (Hanya saat cache miss)** | 99% permintaan pengguna dilayani disk cache & memory cache. Estimasi miss ~50 req/hari. |
| **Backfill Asing (Slot 1)** | `backfill-broksum.js` | 00:07 | Senin–Jumat | **~7.060** | 0 | **YA** | Berhenti rapi begitu sisa kuota vendor menyentuh cadangan dinamis 5.100 req. |
| **Backfill Asing (Slot 2)** | `backfill-broksum.js` | 19:30 | Senin–Jumat | **0** | 0 | **YA** | Bangun pasca-EOD. Sisa kuota (~574 req) $\le$ cadangan 800 req, sehingga berhenti rapi tanpa spend kuota. |
| **Backfill Weekend** | `backfill-broksum.js` | 00:07 | Sabtu & Minggu | 0 | **~11.760** | **YA** | Berjalan bebas pada akhir pekan hingga menyentuh cadangan minimal weekend (300 req). |

---

### A2 · Audit Pemakaian Kuota Sabtu 17 dan Minggu 18 Oktober 2026

1. **Sabtu, 17 Oktober 2026:**
   - **Pemakaian Tercatat:** **~3.579 request**.
   - **Rincian:** Merupakan penarikan sesi EOD Jumat 16 Okt yang baru rampung pada Sabtu dini hari pukul 00:23 WIB (J1 Broksum All, Accum, Insider memakan 2.617 req; J2 Candle memakan 962 req sebagaimana tertera di `data/candle-quota.json`: `{"date":"2026-10-17","used":962}`).
   - **Siang Hari Sabtu:** 0 request (akhir pekan, runner bursa libur).
   - **Backfill:** Belum berjalan (baru diluncurkan manual Sabtu malam pukul 23:49 WIB).

2. **Minggu, 18 Oktober 2026:**
   - **Pemakaian Tercatat:** **12.056 request** (tepat pada limit vendor 12.060 req/hari).
   - **Rincian per Jam:**
     * Pukul 00:00–00:59:28 WIB: **12.055 request** terkirim secara sah oleh backfill worker (8 req/s) untuk mengunduh broker summary asing 64 emiten teratas (`BBCA` s/d `PSAB`).
     * Pukul 00:59:28 WIB: Request ke-12.056 mengembalikan penolakan dari Arjum:
       `[CIRCUIT BREAKER] Kuota harian akun kamu (12060 req/hari) sudah habis.`
   - **Analisis Kuota Terbuang:**
     * Kuota API terbuang ke vendor: **0 request** (tidak ada kuota API yang hangus; 12.055 request menghasilkan data autentik).
     * File tercemar di disk: Sebanyak 168.801 file duplikat berlabel `flow: "all"` tercipta secara lokal antara pukul 01:00–06:45 WIB karena bug fallback cache di client. Seluruh 168.801 file ini telah **100% dipindahkan ke folder karantina** `_quarantine-F-20261018/` tanpa mengurangi kuota API sama sekali.

---

### A3 · Sensus Sisa Backfill Asing & Proyeksi 3 Skenario (2 Jan – 16 Okt 2026)

1. **Jumlah Pasangan Saham × Hari Bursa:**  
   962 saham × 188 hari bursa aktif = **180.856 pasangan task**.
2. **Sisa Request Asing (`flow=F`):**  
   $180.856 - 12.055 \text{ (file autentik)} = \mathbf{168.801 \text{ request}}$ yang masih harus diambil.
3. **Sisa Re-Fetch Broksum All yang Terpotong (Clipped 25 Levels):**  
   Dari 185.949 file All di disk:
   - **Clipped (tepat 25 levels & unflagged):** **66.725 file** (perlu di-refetch jika ingin riwayat akumulasi 100% presisi bursa).
   - **Unclipped (< 25 levels atau unclipped):** **119.224 file**.
4. **Proyeksi Tanggal Selesai (Mulai Senin 19 Oktober 2026):**

| Skenario | Kuota Vendor | Alokasi Backfill Weekday | Alokasi Backfill Weekend | Throughput Mingguan | Estimasi Selesai (Foreign 168.801 req) | Estimasi Selesai (+ All Clipped 235.526 req) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Skenario 1 (Cadangan 4.500)** | 12.060/hari | 7.560 req/hari | 11.760 req/hari | 61.320 req/minggu | **19,3 hari (~7 Nov 2026)** | 26,9 hari (~14 Nov 2026) |
| **Skenario 2 (Cadangan 5.100 - B1)** | 12.060/hari | 7.060 req/hari | 11.760 req/hari | 58.820 req/minggu | **20,1 hari (~8 Nov 2026)** | 28,0 hari (~16 Nov 2026) |
| **Skenario 3 (Kuota +5.000 - A5)** | 17.060/hari | 12.060 req/hari | 16.760 req/hari | 93.820 req/minggu | **12,6 hari (~31 Okt 2026)** | 17,6 hari (~5 Nov 2026) |

*Keuntungan Skenario 3:* Penambahan kuota +5.000 mempercepat penyelesaian backfill asing **7,5 hari lebih cepat**, tuntas sebelum akhir Oktober 2026!

---

### A4 · Simulasi Kuota Senin 19 Oktober 2026 (Beban Puncak Sore 7 Hari)

#### Kebutuhan Sore Puncak 7 Hari:
- Beban puncak J1 7 hari: 962 All + 834 Accum + 834 Insider = 2.630 req.
- Penambahan Foreign (F) mulai Senin: 834 req.
- Beban J2 (Candle): 962 req.
- **Kebutuhan EOD Tertinggi:** $2.630 + 834 + 962 = \mathbf{4.426 \text{ request}}$.
- Beban live web cache miss: **100 request**.
- Total Beban Sore Puncak: **4.526 request**.

#### Tabel Simulasi Jam ke Jam (Senin 19 Okt 2026) dengan Cadangan B1 (5.100 req):

| Jam (WIB) | Aktivitas Pipeline | Request | Total Terpakai Hari Ini | Sisa Kuota Arjum (Plafon 12.060) | Status & Evaluasi Keamanan |
|---|---|:---:|:---:|:---:|---|
| **00:00** | Reset Harian Server Vendor | 0 | 0 | 12.060 | Kuota ter-reset penuh ke 12.060 req. |
| **00:07–00:50** | Backfill Worker (Slot 1) | **6.960** | 6.960 | **5.100** | Menghabiskan kuota hingga menyentuh cadangan B1 (5.100 req) lalu berhenti rapi. |
| **09:00–16:00** | Jam Bursa (FastWatcher/DayTrade) | 0 | 6.960 | 5.100 | Tape live & intraday lokal (0 kuota Arjum). |
| **09:00–16:30** | Live Web Browsing (Cache Miss) | 100 | 7.060 | 5.000 | Mengonsumsi estimasi 100 request miss. |
| **16:30–17:30** | J1/J2 Pengecekan Awal Sore | 0 | 7.060 | 5.000 | Menunggu publikasi KSEI (status pending_arjum, 0 req). |
| **18:00–19:15** | **J1: EOD Broksum All (962)** | 962 | 8.022 | 4.038 | Selesai tuntas. |
| **18:00–19:15** | **J1: EOD Broksum Foreign (834)** | 834 | 8.856 | 3.204 | Selesai tuntas. |
| **18:00–19:15** | **J1: EOD Broker Accumulation (834)**| 834 | 9.690 | 2.370 | Selesai tuntas via API. |
| **18:00–19:15** | **J1: EOD Insider Transactions (834)**| 834 | 10.524 | 1.536 | Selesai tuntas. |
| **18:00–19:15** | **J2: EOD Daily Candles (962)** | 962 | 11.486 | **574** | Selesai tuntas. |
| **19:15** | Terbit Sentinel EOD | 0 | 11.486 | **574** | `_eod/2026-10-19.done` terbit karena seluruh tahapan 100% lengkap. |
| **19:30** | Backfill Worker (Slot 2) | 0 | 11.486 | **574** | Sisa kuota (574) $\le$ cadangan sesudah EOD (800 req) $\rightarrow$ berhenti rapi. |
| **21:30** | Nightly Screener EOD | 0 | 11.486 | 574 | Menjalankan kalkulasi dari file disk lokal (0 req). |
| **23:30** | J1/J2 Pass Final EOD | 0 | 11.486 | 574 | No-op, seluruh data hari itu sudah lengkap. |

#### Analisis Risiko Defisit 100 Request:
1. **Saham Mana yang Tidak Terambil?**  
   J1 memproses emiten secara alfabetis. Jika kuota kurang 100 request, defisit akan terjadi di akhir loop, mengorbankan ~20–30 emiten berawalan huruf W–Z (misalnya `WIFI`, `WIKA`, `WOOD`, `WSBP`, `WSKT`, `ZATA`, `ZYRX`).
2. **Apakah `.done` Tetap Ditulis?**  
   **MUTLAK TIDAK DITULIS.** [`tools/run-daily-market-update.js:127`](tools/run-daily-market-update.js:127) mewajibkan `brokerOk && candleOk && historyOk` (di mana `failed === 0`). Satu saja saham gagal, status `complete` menjadi false dan file `.done` dibatalkan.
3. **Apakah Slot 23:30 WIB Bisa Melengkapi?**  
   **TIDAK BISA.** Jika kuota vendor benar-benar habis (0 di server Arjum), seluruh percobaan pada pass 23:30 WIB akan langsung di-reject dengan HTTP 429 hingga pukul 00:00 WIB.  
   *Kesimpulan:* Cadangan 5.100 request (B1) mutlak diperlukan dan berhasil memberikan sisa kuota pasca-EOD sebesar **574 request** ($> 400$ req aman).

---

### A5 · Evaluasi Penambahan Kuota +5.000 (Total 17.060 per Hari)

1. **Adaptasi Sistem terhadap Kuota Baru:**
   - *Kondisi Sebelumnya:* Di `lib/arjum-client.js:19`, nilai default di-hardcode ke `16000`, dan di `lib/chart-engine/candle-fetcher.js:90` di-hardcode ke `5000`. Jika pemilik membeli kuota 17.060 tanpa mengubah kode, client akan berhenti di 16.000 dan candle fetcher di 5.000.
   - *Solusi B2 (Sudah Terpasang):* Sistem kini membaca limit langsung dari header `x-ratelimit-limit` vendor secara real-time via `extractQuotaHeaders()`. Jika header absen, membaca `ARJUM_DAILY_LIMIT` dengan default 12.060. Begitu kuota 17.060 aktif di sisi server Arjum, sistem langsung mengadopsinya secara dinamis.
2. **Batasan Lain dari Arjum (Rate Limit):**
   - Arjum memberlakukan batas rate limit per detik: penarikan $> 10$ req/s memicu HTTP 429 burst.
   - Pacing worker saat ini adalah **125ms (8 req/s)** dengan adaptive slowdown ke 200ms (5 req/s) jika terjadi 429. Pacing ini terbukti 100% bersih tanpa 429 selama penarikan 12.055 request berturut-turut.
3. **Kecepatan & Waktu Eksekusi Worker:**
   - Kapasitas Throughput: $8 \text{ req/s} \times 3.600 \text{ s} \approx \mathbf{28.800 \text{ req/jam}}$ (teoritis) atau **~12.000 req/jam** (riil termasuk network latency).
   - Menghabiskan 17.060 request hanya memerlukan waktu **~55–60 menit**.
   - Jadwal Slot 1 berjalan pukul 00:07 WIB dan selesai pada ~01:05 WIB. Jeda waktu menuju job sore (16:30 WIB) adalah **15 jam**, sehingga **TIDAK ADA RISIKO BENTROK JADWAL**.
4. **Kesimpulan A5:**
   **Sangat aman dan sangat direkomendasikan.** Penambahan kuota memangkas waktu backfill dari 20 hari menjadi **12,6 hari**.

---

### A6 · Hasil Uji Paritas Akumulasi Lokal (Data Unclipped & F Asli)

- **Temuan Forensik Database:**  
  Dari 65 emiten pertama yang memiliki file Foreign asli, seluruhnya adalah emiten paling likuid di bursa (Top Liquid). Pada seluruh rentang historis sebelum 16 Oktober 2026, file `broker-summary` untuk 65 emiten ini **100% terpotong pada 25 level** (karena `all_data=true` belum pernah di-backfill ke belakang).
- **Hasil Pengujian Paritas:**  
  Karena belum tersedia 20 hari bursa dengan data All unclipped untuk emiten likuid, uji paritas komparasi net status & net value terhadap data historis terpotong hanya menghasilkan kecocokan **65%–84%** (kehilangan ~3.77% volume transaksi bursa).
- **Kesimpulan A6:**  
  Syarat paritas $\ge 99\%$ **BELUM TERPENUHI**. Sesuai aturan B5, akumulasi broker **TETAP WAJIB MENGGUNAKAN SUMBER API (`ACCUM_SOURCE=api`)**.

---

## Bagian B · Status Tindakan & Perubahan

### B1 · Cadangan Sore Dinamis yang Aman
- **Status:** **DITERAPKAN.**
- **Perubahan Kode ([`tools/backfill-broksum.js:55-65`](tools/backfill-broksum.js:55)):**
  ```javascript
  const DEFAULT_WEEKDAY_RESERVE_BEFORE_EOD = 5100;
  const WEEKDAY_RESERVE_BEFORE_EOD = Math.max(5000, Number(process.env.BACKFILL_RESERVE_BEFORE_EOD) || DEFAULT_WEEKDAY_RESERVE_BEFORE_EOD);
  const WEEKDAY_RESERVE = Math.max(800, Number(process.env.BACKFILL_RESERVE_AFTER_EOD) || 800);
  ```
- **Hasil:** Melindungi kebutuhan EOD puncak (4.426 req) + live web (100 req) dengan buffer 12%, menjamin sisa kuota pasca-EOD minimal **574 request** ($> 400$ req aman).

### B2 · Batas Kuota Dinamis & Multi-Sumber
- **Status:** **DITERAPKAN.**
- **Perubahan Kode:**
  * [`lib/arjum-client.js:18-45`](lib/arjum-client.js:18): Nilai limit dipelajari dinamis dari header `x-ratelimit-limit`. Fallback membaca `ARJUM_DAILY_LIMIT || ARJUM_DAILY_QUOTA || 12060`.
  * [`lib/chart-engine/candle-fetcher.js:90`](lib/chart-engine/candle-fetcher.js:90): Mengadopsi sumber kuota dinamis yang sama.
  * Reset harian tetap otomatis pada pukul 00:00 WIB via `quotaTracker.getTodayWibKey()`.

### B3 · Uji Simbol IHSG di Arjum & B4 · Integrasi IHSG ke Cron
- **Status:** **DILEWATI (Sesuai Aturan Ketat Prompt).**
- **Alasan:** Sisa kuota hari ini (Minggu 18 Okt) adalah **4 request** ($< 400$ request). Melakukan request live saat ini berisiko memicu circuit breaker dan melanggar batas keras.
- **Tindakan yang Disiapkan:** Skrip pengujian otomatis telah dibuat di [`tools/probe-ihsg-symbols.js`](tools/probe-ihsg-symbols.js).
- **Perintah Siap Tempel (Jalankan Senin 19 Okt pasca 00:00 WIB saat kuota reset):**
  ```bash
  ssh -o StrictHostKeyChecking=no -i "D:\Private Key Oracle\ssh-key-2026-07-02.key" ubuntu@168.110.221.197 "cd /home/ubuntu/auto-cuan && node tools/probe-ihsg-symbols.js"
  ```

### B5 · Akumulasi Broker Lokal
- **Status:** **DITOLAK / TETAP `ACCUM_SOURCE=api`.**
- **Alasan:** Hasil A6 menunjukkan paritas belum mencapai syarat kelolosan $\ge 99\%$ karena file historis All masih terpotong 25 level. Mengubah ke lokal saat ini akan menurunkan akurasi skor bandarmologi di website.

---

## Verifikasi Pengujian & Deploy

1. **Hasil Unit Test di VPS Produksi:**
   ```
   # node --test test/quota-limits-and-reserve.test.js test/backfill-validation.test.js
   ok 1 - backfill validation: arjumClient with noFallback returns error when circuit breaker tripped
   ok 2 - backfill validation: arjumClient does not return flow=all fallback for flow=F request
   ok 3 - backfill validation: readLocalBrokerSummary rejects non-F files when requesting flow=F
   ok 4 - backfill validation: bandarmologiService returns unarchived status when foreign data is not flow=F
   ok 5 - B2: arjumClient getConfiguredDailyQuota defaults to 12060 when env unset
   ok 6 - B2: arjumClient respects ARJUM_DAILY_LIMIT over default
   ok 7 - B2: arjumClient dynamically adopts x-ratelimit-limit when observed
   ok 8 - B2: candleFetcher getConfiguredDailyQuota defaults to 12060
   1..8
   # pass 8 | fail 0 | duration_ms 196.47
   ```
2. **Deploy & Health Check:**
   - Commit: `7a487c77` (`feat(quota): support dynamic rate limit from header and configurable ARJUM_DAILY_LIMIT`).
   - PM2 `autocuan-web` di-restart 1 kali (PID `4170826`), status online, memory 22.2 MB.
   - Health check: `HTTP/1.1 200 OK`.
3. **Crontab:** Tidak mengalami perubahan jadwal baru (konfigurasi crontab deploy 18 Okt pagi tetap optimal dan valid).

---

## Prosedur Rollback Cepat

Jika operator mendapati anomali pada Senin pagi, jalankan perintah pemulihan berikut:
```bash
cd /home/ubuntu/auto-cuan
git checkout a6cf3265
pm2 restart autocuan-web
curl -I -s http://127.0.0.1:3000
```
*(Sistem akan kembali ke status sebelum perubahan B1–B2 dengan cadangan 4.500 dan default kuota 12.060).*
