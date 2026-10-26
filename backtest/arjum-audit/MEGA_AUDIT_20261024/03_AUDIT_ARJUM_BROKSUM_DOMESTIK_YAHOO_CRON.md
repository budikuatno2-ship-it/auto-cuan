# LAPORAN FORENSIK 03: AUDIT INTEGRITAS ARJUM DATA, KALKULASI DOMESTIK (D=ALL-F), YAHOO CANDLES & OPERASIONAL CRON
**Tanggal Audit:** 24 Oktober 2026  
**Status Sifat:** 100% READ-ONLY FORENSIC MEGA AUDIT  
**Modul Tercakup:** Modul 7, Modul 10, Modul 11, Modul 12, Modul 13, Modul 15  
**Auditor:** Roo Autonomous Software Engineer

---

## MODUL 12: AUDIT KALKULASI ALIRAN DOMESTIK ($D = \text{ALL} - F$)

### 1. Landasan Teori & Model Aliran Modal
Data Broker Summary dari Bursa Efek Indonesia (BEI) melalui API Arjum menyediakan dua feed data primer per emiten per tanggal perdagangan:
1. **Feed Total / Keseluruhan ($\text{ALL}$):** Seluruh transaksi beli dan jual oleh seluruh kode broker anggota bursa.
2. **Feed Asing ($F$):** Transaksi yang hanya melibatkan akun investor dengan status kewarganegaraan asing.

Berdasarkan hukum konservasi volume perdagangan bursa:
$$\text{Domestic Buy} = \text{Total Buy} - \text{Foreign Buy}$$
$$\text{Domestic Sell} = \text{Total Sell} - \text{Foreign Sell}$$
$$\text{Domestic Net Value} = \text{Total Net Value} - \text{Foreign Net Value}$$

### 2. TEMUAN CACAT LOGIKA FATAL: `lib/broksum-flow.js`
Dalam pemeriksaan forensik baris-demi-baris pada [`lib/broksum-flow.js:46-50`](lib/broksum-flow.js:46), ditemukan cacat komputasi berstatus **CRITICAL**:

```javascript
// Kutipan Baris 46-50 lib/broksum-flow.js:
if (!foreignBroksum) {
  return Object.assign({}, allBroksum, {
    flow: 'D',
    is_complete: true,
    status: 'complete'
  });
}
```

#### Analisis Dampak & Akar Masalah:
* **Perilaku Cacat:** Jika feed data Foreign (`foreignBroksum`) bernilai `null`, `undefined`, atau gagal diunduh dari API, fungsi `computeDomestic` secara instan menyalin seluruh objek `allBroksum`, melabelinya dengan `flow: 'D'`, dan menetapkan `is_complete: true` serta `status: 'complete'`.
* **Konsekuensi Nyata:** Sistem menganggap seluruh transaksi pasar sebagai Transaksi Domestik murni! Transaksi asing yang sangat masif (misalnya aksi jual asing Rp 1 Triliun di BBCA) akan disalahartikan sebagai aksi jual investor lokal, atau sebaliknya.
* **Solusi Perbaikan:** Ketika `foreignBroksum` tidak tersedia, fungsi WAJIB mengembalikan status:
  ```javascript
  return {
    flow: 'D',
    is_complete: false,
    status: 'foreign_missing',
    error: 'Foreign broksum data not available; cannot compute D = ALL - F'
  };
  ```

---

## MODUL 10: ARJUM CLIENT & INTEGRITAS BROKSUM

### 1. Arsitektur Client & Kebijakan Throttling
Koneksi ke endpoint Arjum Data dikelola oleh [`lib/arjum-client.js`](lib/arjum-client.js:1):
* **Pemberi Jeda (Rate Limit Throttle):** Ditetapkan interval default **800 ms per request** antar-panggilan HTTP untuk mencegah respons HTTP 429 (Too Many Requests) dari server upstream Arjum.
* **Mekanisme Retry:** Maksimal 3 kali percobaan ulang dengan penundaan eksponensial (1s, 2s, 4s).
* **Format Data:** Arjum mengembalikan ringkasan broker dalam dua mode: `unclipped` (seluruh transaksi broker) dan `clipped` (hanya Top 5 broker pembeli dan penjual).

### 2. Temuan Hardcoded Date List pada Backfill
Pemeriksaan pada [`tools/backfill-broksum.js:247-290`](tools/backfill-broksum.js:247) menemukan daftar tanggal perdagangan hardcoded:
* **Kondisi Kode:** Terdapat array statis yang mendaftar hari bursa dari tanggal `2026-01-02` hingga `2026-10-16`.
* **Kelemahan:** Begitu tanggal sistem melampaui 16 Oktober 2026, script backfill tidak mengetahui tanggal bursa baru secara otomatis kecuali jika programmer menambahkan tanggal baru ke dalam kode secara manual.
* **Rekomendasi:** Mengganti array statis dengan pemanggilan dinamis ke fungsi `getIdxTradingDays(startDate, endDate)` dari [`lib/idx-trading-calendar.js`](lib/idx-trading-calendar.js:1).

---

## MODUL 11: ARJUM QUOTA TRACKER, DAILY UPDATE MARKER & LOCKS

### 1. Kontrol Alokasi Kuota Harian (12.060 Requests/Hari)
Manajemen kuota diatur oleh [`lib/arjum-quota-tracker.js`](lib/arjum-quota-tracker.js:1):
* **Plafon Harian:** 12.060 request per hari bursa.
* **Cadangan Darurat (Buffer Reserve):** 500 request disisihkan khusus untuk query instan pengguna web dan IHSG anchor candle.
* **Anggaran per Job (EOD & Intraday):**
  - Intraday DayTrade & FastWatcher: Maksimal 2.500 request/hari.
  - EOD Daily Update (J1 - 962 Saham): ~2.000–3.000 request/hari (All + Foreign).
  - Backfill Riwayat: Menggunakan sisa kuota yang belum terpakai pada malam hari (maksimal 2.500 request).

### 2. Struktur Daily Update Marker
Di server VPS, integritas penyelesaian pembaruan harian dicatat dalam direktori state:
`/home/ubuntu/auto-cuan-runner/state/daily-update-marker/YYYY-MM-DD.json`
* File marker memuat payload: `{ date: "YYYY-MM-DD", completed_at: "ISO", total_tickers: 962, success_count: N, failed_count: M }`.
* Idempotency: Jika file marker untuk tanggal yang sama sudah berstatus `completed`, job J1 tidak akan memanggil ulang API Arjum saat cron dijalankan kembali pada slot kedua (23:30 WIB).

---

## MODUL 7: JADWAL CRON, KONKURENSI & LOCK CLASHES

### 1. Peta Eksekusi Cron 24 Jam di VPS
Berdasarkan berkas riil VPS [`deploy/vps/final-schedule.cron`](deploy/vps/final-schedule.cron:1):

| Jam (WIB) | Frekuensi / Waktu | Skrip Worker | Fungsi & Potensi Konflik |
|---|---|---|---|
| **00:07** | Sabtu & Minggu | `run-catchup-missing-dates.sh` | Pengecoran tanggal bolong (Sabtu: 24 Okt, Minggu: 25 Okt) |
| **09:00–15:45** | Setiap 5 menit | `run-fastwatcher.sh` | FastWatcher intraday scanner (Memakai lockfile `/tmp/fastwatcher.lock`) |
| **09:02–15:47** | Menit 2, 17, 32, 47 | `run-daytrade-producer.sh` | Daytrade intraday producer (Memakai lockfile `/tmp/daytrade.lock`) |
| **09:00–16:00** | Setiap 15 menit | `run-daily-market-context-collector.sh` | Mengumpulkan ringkasan IHSG & snapshot |
| **16:30** | Hari kerja | `run-lifecycle-evaluator.sh` | Evaluasi status masa aktif langganan member |
| **16:40** | Hari kerja | `run-daily-candles.sh` | Unduh candle 962 saham via Yahoo Finance |
| **17:45** | Hari kerja | `run-ihsg-candle.sh` | Unduh candle mandiri IHSG dari Arjum (1 req) |
| **18:00** | Hari kerja | `run-daily-market-update.sh` (J1) | Pembaruan broker summary harian seluruh emiten |
| **18:30** | Hari kerja | `run-screeners.sh` | Eksekusi screener EOD (Swing Konglo & Non-Konglo) |
| **19:45** | Hari kerja | `run-backlog-age-alarm.sh` | Deteksi antrean data H-1 yang macet > 24 jam |
| **22:45** | Hari kerja | `run-broker-hunter-indexer.sh` | Indeksasi broker hunter lokal dari disk |
| **23:30** | Hari kerja | `run-daily-candles.sh` & `run-ihsg-candle.sh` | Pass kedua verifikasi candle harian |

### 2. Analisis Bentrokan & Mitigasi Locking
* **Pemisahan Lock File:** FastWatcher dan DayTrade berjalan pada menit yang berbeda (FastWatcher di menit kelipatan 5, DayTrade di menit 2, 17, 32, 47) sehingga tidak pernah bertabrakan memperebutkan lockfile yang sama.
* **Flock Wrapper:** Seluruh skrip shell di `deploy/vps/` dibungkus perintah `flock -n /tmp/jobname.lock` untuk menjamin tidak ada dua instance worker yang sama berjalan tumpang tindih jika satu siklus membutuhkan waktu lebih lama dari interval cron.

---

## MODUL 13: CACAT OPERASIONAL OTOMATISASI CRON

### 1. Kurangnya Log Rotation pada Runner Logs
* File log di `/home/ubuntu/auto-cuan-runner/logs/` (seperti `catchup-missing-dates.log`, `daily-candles.log`, dan `broker-update.log`) diarahkan menggunakan operator penambahan `>>` tanpa integrasi dengan utilitas sistem `logrotate`.
* **Dampak:** Beberapa file log mencapai ukuran lebih dari 200 MB (`logs_7days_audit.txt` tercatat 203 KB per cuplikan). Jika dibiarkan berbulan-bulan, ruang disk pada partisi root VPS (Oracle Cloud Free Tier: 45 GB) berisiko penuh.

### 2. Hardcoded Absolute Paths di Skrip Shell
* Mayoritas skrip di `deploy/vps/` mengasumsikan path absolut `/home/ubuntu/auto-cuan/` dan binary node di `/home/ubuntu/.local/node-v22/bin/node`. Jika struktur folder dipindahkan atau versi node diperbarui ke v24, skrip akan gagal dieksekusi secara serentak.

---

## MODUL 15: YAHOO FINANCE CANDLE FETCHER & CIRCUIT BREAKER

### 1. Arsitektur Multi-Tier Fetcher
Pengambilan candle harian dikelola oleh [`lib/chart-engine/candle-fetcher.js`](lib/chart-engine/candle-fetcher.js:1) dan [`tools/fetch-daily-candles.js`](tools/fetch-daily-candles.js:1):
* **Tier 1 (Utama):** Yahoo Finance API (`https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>.JK`). Digunakan untuk 962 saham guna menghemat kuota Arjum (bebas biaya request).
* **Tier 2 (Anchor Mandiri):** Data IHSG (`^JKSE`) selalu diambil langsung dari Arjum API untuk menghindari ketidaksinkronan harga pembukaan/penutupan indeks yang kerap terjadi di feed publik Yahoo.
* **Tier 3 (Cross-Check Verification):** Membandingkan 20 saham kapitalisasi terbesar (Big Cap) antara data Yahoo dan Arjum untuk memastikan integritas bar candle penutupan.

### 2. Mekanisme Circuit Breaker
* Jika Yahoo Finance mengembalikan status `HTTP 429 Too Many Requests` secara beruntun sebanyak 5 kali, circuit breaker aktif dan menunda request selama 60 detik sebelum melanjutkan antrean.
* Jika candle penutupan belum terbentuk sempurna pada pukul 16:40 WIB (Yahoo terkadang terlambat memperbarui penutupan bursa BEI hingga 30 menit), job ditandai `unconfirmed` dan akan diperbarui secara otomatis pada jadwal kedua pukul 23:30 WIB.
