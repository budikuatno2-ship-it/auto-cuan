# LAPORAN FASE 1B · AUDIT PENYIMPANAN VPS & UJI KOMPRESI (READ-ONLY)

**Tanggal Audit:** Minggu, 18 Oktober 2026
**Sifat Tugas:** Read-only. Tidak ada data yang dihapus. Salinan uji kompresi sudah dibersihkan.
**Server:** Production VPS production (Node.js v22.23.1, PM2)

---

## 1. Kapasitas Disk & Inode

### Disk Space (`df -h /home/ubuntu`)
```
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        96G   18G   79G  19% /
```

### Inode (`df -i /home/ubuntu`)
```
Filesystem       Inodes  IUsed    IFree IUse% Mounted on
/dev/sda1      12976128 691075 12285053    6% /
```

**Kesimpulan:** Disk 19% terpakai (79 GB tersisa), inode 6% terpakai (12,29 juta inode tersisa). Keduanya **sangat lega**, tidak ada risiko kehabisan inode meskipun backfill menulis ratusan ribu file kecil.

---

## 2. Tabel Ukuran Folder

| Folder | Ukuran | Jumlah File | Rata-rata File | Pertumbuhan/Hari (est.) |
|---|---|---|---|---|
| `data/arjum-data/broker-summary` (all) | **3,2 GB** | 187.154 | ~17,1 KB | ~90 file/hari (~1,5 MB/hari) |
| `data/arjum-data/broker-summary-F` (F) | **115 MB** | 13.020 | ~8,8 KB | ~900 file/hari (backfill) (~8 MB/hari) |
| `data/arjum-data/broker-accumulation` | **732 MB** | 11.237 | ~65 KB | ~10 file/hari (~650 KB/hari) |
| `data/arjum-data/insiders` | **75 MB** | 10.364 | ~7,2 KB | ~962 file/hari (saat aktif) |
| `data/daily-candles` | **66 MB** | 964 | ~68 KB | ~963 file/hari (overwrite harian) |
| `data/arjum-data/_backup-broksum-25` | **79 MB** | 4.550 | ~17 KB | Dinamis (mengikuti penarikan unclipped) |
| `data/arjum-data/_backfill` | **6,5 MB** | 3 | ~2,2 MB | state.json (tumbuh ~50 KB/hari) |
| `auto-cuan-runner/logs` | **37 MB** | 385 | ~96 KB | ~1-2 MB/hari |
| `~/.pm2/logs` | **11 MB** | 14 | ~800 KB | ~500 KB/hari |
| `auto-cuan/node_modules` | **9,4 MB** | 575 | — | Statis |
| `auto-cuan/.git` | **85 MB** | 1.422 | — | Statis |

### Catatan Tambahan
- Terdapat 2 folder karantina:
  - `/home/ubuntu/auto-cuan/data/arjum-data/_quarantine-F-20261018` (168.801 file kontaminasi fallback)
  - `/home/ubuntu/auto-cuan/data/arjum-data/_quarantine-no-trade` (File SINI yang salah no-trade)
- Folder karantina _quarantine-F-20261018 diperkirakan berukuran ~2,85 GB (hasil dari 168.801 file × 17 KB rata-rata).

---

## 3. Pemborosan Blok 4 KB

**Filesystem ext4 default: block size 4096 bytes (4 KB).**

Berdasarkan sampel 180 file (dari benchmark Fase 1B):
- Total ukuran riil: 4.109.379 bytes (~4,1 MB)
- Total alokasi blok: 4.452.352 bytes (~4,45 MB)
- **Pemborosan blok:** 342.973 bytes (**7,70%**)

**Proyeksi total pemborosan blok:**
- `broker-summary` (187.154 file × ~17 KB rata-rata): setiap file 17 KB menghabiskan 5 blok (20 KB) → pemborosan ~3 KB/file × 187.154 = **~561 MB**.
- `broker-summary-F` (13.020 file × ~8,8 KB): setiap file 8,8 KB menghabiskan 3 blok (12 KB) → pemborosan ~3,2 KB/file × 13.020 = **~41 MB**.
- Kompresi per file (gzip level 6) akan **menghilangkan** pemborosan blok ini secara efektif karena file gzip berukuran ~2,4 KB (masuk 1 blok).

---

## 4. Proyeksi Ukuran & Jumlah File Saat Backfill Selesai

### Asumsi Backfill:
- Universe: 962 saham × 188 hari bursa (Jan-Okt 2026) = 180.856 pasangan.
- Setelah zero-trade skip: ~159.775 pasangan membutuhkan penarikan `all` + `F`.
- Total file setelah backfill: 187.154 (all existing) + ~159.775 (all baru) + 13.020 (F existing) + ~159.775 (F baru) = **~519.724 file**.

### Proyeksi Ukuran:
| Komponen | Ukuran Sekarang | Ukuran Setelah Backfill |
|---|---|---|
| broker-summary (all) | 3,2 GB | **~6,3 GB** |
| broker-summary-F | 115 MB | **~1,6 GB** |
| Sub-total unclipped | 3,3 GB | **~7,9 GB** |
| _backup-broksum-25 | 79 MB | **~200 MB** |
| karantina F + no-trade | ~2,85 GB | ~2,85 GB (bisa dihapus setelah verifikasi) |
| Total arjum-data | ~6,5 GB | **~11,2 GB** |

### Proyeksi Pertumbuhan Setelah Backfill Selesai:
- Penambahan harian: ~2.000 file/hari (962 saham × 2 flow all+F).
- Ukuran harian: ~35 MB/hari.
- Bulanan: ~1,05 GB/bulan.
- **Sisa disk 79 GB / 1,05 GB/bulan = ~75 bulan (6,3 tahun)** tanpa pembersihan.
- Sisa inode 12,28 juta / 2.000 file/hari = **~6.140 hari (~16,8 tahun)**.

**Kesimpulan:** Disk akan penuh dalam **6,3 tahun**, inode dalam **16,8 tahun**. Tidak ada urgensi untuk kompresi agresif dalam jangka pendek, tetapi strategi arsip tetap disarankan untuk efisiensi.

---

## 5. Hasil Uji Kompresi (Sampel: 3 Likuid + 3 Sepi × 1 Bulan × 2 Flow = 180 File)

Salinan uji dibuat di `data/_staging/compress-test/` dan sudah dihapus setelah pengukuran.

| Format | Total Ukuran | Rasio vs Raw | Jumlah File | Waktu Baca 1 Hari | Waktu Baca 20 Hari |
|---|---|---|---|---|---|
| **JSON mentah (baseline)** | **4,11 MB** | 1,0000 | 180 | **0,28 ms** | **5,05 ms** |
| **Gzip per file (level 6)** | **577 KB** | 0,1405 (14%) | 180 | — | 22,51 ms |
| **Brotli per file (quality 5)** | **538 KB** | 0,1310 (13%) | 180 | — | — |
| **Satu file per saham per flow per bulan (`.json.gz`)** | **324 KB** | **0,0789 (7,9%)** | **9** | — | **4,98 ms** |
| SQLite (satu tabel + indeks) | Di-skip | — | — | — | Tidak diuji (better-sqlite3 tidak tersedia) |

### Temuan Utama:
1. **Arsip bulanan `.json.gz` adalah format optimal:** Ukuran **7,9% dari mentah** (hemat 92%), dan waktu baca 20 hari **4,98 ms (lebih cepat dari JSON mentah!)** karena hanya 1 file yang dibuka untuk 20 hari data.
2. **Gzip per file** hemat 86% tetapi 4,5× lebih lambat baca (22,5 ms) karena overhead gunzip per file.
3. **Brotli** hemat 87% tetapi CPU lebih tinggi saat kompresi.

---

## 6. Daftar Kode yang Membaca Data (File:Baris & Pola Baca)

| Pola Baca | Total Hits | File Unik | Reader Utama |
|---|---|---|---|
| `broker-summary` (path string) | 198 | 44 | `lib/bandarmologi-service.js`, `lib/vps-data-fetcher.js`, `lib/arjum-client.js`, `api/sector-hot.js`, dll. |
| `broker-accumulation` | 55 | 17 | `lib/bandarmologi-service.js`, `lib/broker-accumulation-local.js`, `lib/arjum-client.js` |
| `insiders` | 112 | 16 | `lib/bandarmologi-service.js`, `lib/arjum-client.js` |
| `readLocalBrokerSummary()` | 12 | 3 | `lib/arjum-client.js` |
| `readLocalBrokerAccumulation()` | 7 | 3 | `lib/arjum-client.js` |
| `readLocalInsiders()` | 6 | 2 | `lib/arjum-client.js` |
| `readDiskCache()` | 44 | 6 | `lib/bandarmologi-service.js` |
| `hasDiskCache()` | 5 | 1 | `lib/bandarmologi-service.js` |
| `listDiskDates()` | 28 | 6 | `lib/bandarmologi-service.js` |

**Reader kunci:**
- [`lib/arjum-client.readLocalBrokerSummary()`](lib/arjum-client.js:114) — pembaca utama file broksum harian.
- [`lib/bandarmologi-service.readDiskCache()`](lib/bandarmologi-service.js:139) — cache reader yang membaca `broker-summary/<ticker>/<date>.json`.
- [`lib/bandarmologi-service.listDiskDates()`](lib/bandarmologi-service.js:205) — list tanggal tersedia dari disk.
- [`lib/vps-data-fetcher.js`](lib/vps-data-fetcher.js:1) — pengambil data via SSH/HTTP dari VPS.

**Implikasi:** Sekitar **44 file** mereferensikan path `broker-summary` secara langsung. Migrasi ke format arsip harus melalui lapisan abstraksi [`lib/broksum-store.js`](lib/broksum-store.js) (usulan baru) sehingga semua pemakai diarahkan melalui satu entry point.

---

## 7. Usulan Arsitektur Penyimpanan (Belum Diterapkan — Menunggu Persetujuan)

### Usulan 1: Hot/Cold Split Berdasarkan Umur
- **Hot data (60 hari terakhir):** Tetap dalam format JSON per file (akses cepat untuk chart & screener).
- **Cold data (>60 hari):** Diarsipkan ke `.json.gz` per bulan (`<ticker>/<YYYY-MM>.json.gz`).
- **Hemat:** Untuk 1 tahun data (2026), hot 60 hari (~120.000 file × 17 KB = 2 GB) + cold arsip (~1,05 GB → 105 MB gzip) = **~2,1 GB** vs 3,2 GB sekarang. Hemat ~35%.
- **Waktu baca:** Cold data hanya diakses untuk backtest historis, jadi latensi gzip dapat diterima.

### Usulan 2: Modul `lib/broksum-store.js` (Single Entry Point)
Satu modul yang mengabstraksi semua baca/tulis broksum, dengan fallback otomatis:
```js
const store = require('./lib/broksum-store');
const payload = await store.readBroksum(ticker, date, flow); // Baca dari hot atau cold otomatis
```
Semua 44 file yang mereferensikan path broksum akan dimigrasi ke modul ini.

### Usulan 3: Rencana Migrasi (4 Tahap, Tanpa Downtime)
1. **Tulis di samping format lama:** Mulai tulis data baru ke format `.json.gz` bulanan (bulan berjalan).
2. **Verifikasi identik:** Bandingkan konten JSON yang dibaca dari hot vs cold, harus bit-exact.
3. **Pindahkan pemakai:** Ubah semua 44 file untuk menggunakan `broksum-store.js`.
4. **Arsipkan format lama:** Setelah verifikasi sukses selama 7 hari, gzip file lama ke arsip.

### Usulan 4: Karantina Dibungkus `.tar.zst`
- `_quarantine-F-20261018` (168.801 file, ~2,85 GB) → dibungkus menjadi `quarantine-F-20261018.tar.zst` → **~200-300 MB** (hemat ~90%).
- Menghapus beban 168.801 inode.
- **Wajib menunggu persetujuan pemilik** sebelum dijalankan.

### Usulan 5: Rotasi Log
- `autocuan-web-error.log` dan `logs/*.log` tumbuh line-by-line tanpa rotasi.
- Gunakan `logrotate` mingguan: simpan 4 minggu terakhir + arsip `.gz` lama.
- Hemat: ~37 MB/bulan → ~10 MB/bulan setelah rotasi agresif.

---

## 8. Ringkasan Fase 1B

| Aspek | Status | Nilai |
|---|---|---|
| Sisa disk | Aman | **79 GB (19% terpakai)** |
| Sisa inode | Aman | **12,28 juta (6% terpakai)** |
| Proyeksi disk penuh | Tanpa kompresi | **~6,3 tahun** |
| Proyeksi inode penuh | Tanpa kompresi | **~16,8 tahun** |
| Format kompresi terbaik | **Arsip bulanan `.json.gz`** | **7,9% dari mentah, 92% hemat** |
| Rekomendasi | Hot/cold split 60 hari + modul `broksum-store.js` | Menunggu persetujuan pemilik |
