# REPORT — DayTrade scan penuh 800 saham + perbaikan scan malam yang ter-skip

**Tanggal kerja:** 2026-10-19 (malam WIB) / dieksekusi untuk slot Selasa 2026-10-20
**Branch kerja:** `feat/daytrade-full-universe` (dari `feat/daytrade-screener-v1`)
**PR:** https://github.com/budikuatno2-ship-it/auto-cuan/pull/899
**Merge commit ke `feat/daytrade-screener-v1`:** `d6a7ac9d`
**Status:** KODE SELESAI + MERGE. Uji beban A2/A3, scan malam B4, dan deploy VPS
menunggu **jam bursa Selasa 20 Okt** (lihat §2, §3, §4).

> Catatan aturan: bagian A dan B disetujui pemilik lewat prompt. **Skor, gate,
> Top 5, dan scoring tidak diubah** — tidak ada baris di `scoreDayTrade`,
> `classifyStatus`, gate publik, atau pemilihan Top 5 yang disentuh.

---

## 0. Ringkasan akar masalah

- Producer intraday 15 menitan (`tools/run-daytrade-intraday-producer.js`)
  selalu mengirim `speed: 'fast'` → universe 258 saham.
- `runDayTrade` (`tools/run-all-screeners-vps.js`) dan guard `already_done`
  di `api/sector-hot.js` menganggap **publish apa pun hari itu** dengan
  `scanned_count >= universe_count` sebagai "sudah scan hari ini".
- Karena producer fast siang menandai `published` 258/258, gate malam 21:30
  terpenuhi → **scan penuh DayTrade tidak pernah jalan sejak 30 Sep 2026**,
  dan 542 saham sisanya tidak pernah di-scan.

Perbaikan B memutus rantai itu: gate malam kini hanya lolos bila publish hari
itu punya `run_speed === 'full'` **dan** cakupan penuh. Perbaikan A menambah
opsi resmi `--speed full` ke producer supaya jadwal 15 menit bisa (setelah diuji)
memakai universe penuh.

---

## 1. Link PR, status merge & deploy

| Item | Nilai |
|---|---|
| PR | [#899](https://github.com/budikuatno2-ship-it/auto-cuan/pull/899) |
| Base | `feat/daytrade-screener-v1` |
| Merge | **MERGED** `2026-10-19T16:34:38Z` → merge commit `d6a7ac9d` |
| Commit fitur | `cdb43c04` (A), `b44f88f1` (B), `5792ebc6` (test deterministik) |
| CI relevan | Analyze JavaScript ✅, CodeQL ✅, Repository Security Gate ✅, `build-and-focused-tests` (web hardening, termasuk `npm run test:full`) ✅, unit ✅, database ✅, portfolio-persistence ✅, command-login ✅, webkit-keyboard ✅ |
| CI pra-ada (bukan regresi) | `browser` (Precision workspace regression) ❌ — juga GAGAL di semua branch lain; Vercel ❌ "Account is blocked" (repo-wide) |
| Deploy VPS | **Belum** — menunggu jam non-bursa Selasa 20 Okt (lihat §5) |

Catatan: `preview`/Vercel gagal karena akun Vercel repo ini diblokir (bukan
akibat perubahan). Workflow `browser` (UI) juga gagal pada branch lain
(`fix/daytrade-producer-20261019`, `feat/broksum-all-foreign`, dll.), jadi
bukan regresi dari PR ini. Merge dijalankan dengan `--admin` sesuai izin pemilik
setelah semua check kode/keamanan/DB hijau.

---

## 2. Uji beban A2 — **BELUM DIJALANKAN (menunggu jam bursa 20 Okt)**

Bagian A2 wajib dijalankan di VPS pada jam bursa (target 09:25 dan 13:40 WIB)
dan hanya bisa diisi setelah deploy. Nilai di bawah **belum ada** — TIDAK akan
diisi dengan angka rekaan.

| Run | Durasi | RAM puncak | Load 1m | Publish | Health ms | FastWatcher telat? |
|---|---|---|---|---|---|---|
| 09:25 WIB | (belum) | (belum) | (belum) | (belum) | (belum) | (belum) |
| 13:40 WIB | (belum) | (belum) | (belum) | (belum) | (belum) | (belum) |

Perintah uji (di VPS, di sela slot cron — bukan menit 2/17/32/47):

```bash
# 1) SATU run penuh manual (lewat wrapper, memakai lock + env canonical)
deploy/vps/run-daytrade-producer.sh --execute --speed full

# 2) Saat run berjalan, ukur respons health
curl -s -o /dev/null -w '%{time_total}\n' http://127.0.0.1:3000/api/health
```

Yang otomatis dicatat producer ke log (`daytrade-producer.log`) per run:

```
  mode     : EXECUTE / FULL
  timeout  : 360s (single run ceiling)
  load 1m  : start=<lv>  rss=<MB>
  summary  : PUBLISHED mode=full universe=<n> scanned=<n> duration=<ms> peak_rss=<MB> load1=<a>-><b>
```

`peak_rss` (proses) dan `load1` awal/akhir memberi angka RAM & CPU yang
diminta A2. Untuk FastWatcher: bandingkan `started_at`/selesai barisnya di
`fastwatcher.log` run normal vs run saat scan penuh (ambang "telat" 30 detik).

---

## 3. Keputusan jadwal A3 — **MENUNGGU hasil A2 (aturan, bukan selera)**

Sesuai aturan A3:

- **Jalur 1 (semua slot full)** dipilih HANYA bila: kedua run full selesai
  ≤ 4 menit, health < 1 detik, dan FastWatcher tidak telat > 30 detik.
- **Jalur 2 (berhenti & lapor)** bila salah satu syarat gagal → **crontab
  TIDAK diubah**, lalu usulan alternatif menunggu keputusan pemilik.

### Isi baris crontab producer

**SEBELUM (produksi saat ini di `deploy/vps/final-schedule.cron`):**

```
2,17,32,47 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-daytrade-producer.sh --execute >> /home/ubuntu/auto-cuan-runner/logs/daytrade-producer.log 2>&1
```

**SESUDAH — hanya bila Jalur 1 terpenuhi (default tetap FAST sampai keputusan):**

```
2,17,32,47 9-15 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-daytrade-producer.sh --execute --speed full >> /home/ubuntu/auto-cuan-runner/logs/daytrade-producer.log 2>&1
```

Karena hasil A2 belum ada, **crontab saat ini TIDAK diubah**. Wrapper
`run-daytrade-producer.sh` default ke `fast`, jadi jadwal lama berperilaku
identik sampai perubahan di atas diterapkan secara sengaja.

Sebelum mengubah crontab apa pun:

```bash
crontab -l > ~/crontab.backup-$(date +%Y%m%d-%H%M)
```

---

## 4. Scan malam DayTrade (B4) — **BELUM DIJALANKAN (menunggu malam setelah deploy)**

Perbaikan B memastikan scan malam 21:30 **tidak** lagi ter-skip oleh publish
fast. Setelah deploy selesai sebelum 21:30 WIB hari itu, scan malam diharapkan
men-scan sekitar 800 saham (bukan 258). Angka universe/scanned/durasi/publish
malam ini **belum ada** dan akan diisi dari `screeners.log` + meta
`daytrade_screener_meta` setelah run.

Cara verifikasi:

```bash
# meta setelah run malam
# (via tool read-only internal; kolom baru: run_speed, duration_ms)
# dan cek baris log:
grep -n "Day Trade" /home/ubuntu/auto-cuan-runner/logs/screeners.log | tail -20
```

Yang diharapkan di meta malam: `run_speed='full'`, `universe_count≈800`,
`scanned_count≈800`. Sebelum perbaikan, meta malam tetap `run_speed='fast'`
dengan 258 dan run malam di-skip.

---

## 5. Runbook deploy VPS (non-bursa) + migrasi

Langkah (semua di VPS, branch operasional tetap `feat/daytrade-screener-v1`,
**jangan** merge ke `main`):

```bash
# 0. Backup crontab (wajib sebelum menyentuh crontab)
crontab -l > ~/crontab.backup-$(date +%Y%m%d-%H%M)

# 1. Tarik commit yang sudah di-merge (fast-forward saja)
cd /home/ubuntu/auto-cuan
git fetch && git checkout feat/daytrade-screener-v1 && git pull --ff-only

# 2. Terapkan kolom meta baru (nullable; perlu sebelum run malam 21:30)
#    Jalankan supabase/daytrade-screener-run-speed-migration.sql lewat
#    jalur migrasi yang biasa dipakai (supabase SQL editor / psql).
#    SELECT run_speed, duration_ms FROM daytrade_screener_meta WHERE id='latest';

# 3. Restart PM2 SEKALI, DI LUAR jam bursa (sebelum 08:45 atau setelah 16:15)
pm2 restart autocuan-web

# 4. Health check harus 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/health
```

Bukti `git diff --stat` deploy minimal (perubahan yang menyentuh web/`api/`):

```
api/sector-hot.js       | ...
tools/run-all-screeners-vps.js
tools/run-daytrade-intraday-producer.js
deploy/vps/run-daytrade-producer.sh
supabase/daytrade-screener-run-speed-migration.sql
test/* (2 baru + 1 update)
tools/curated-build-tests.json
```

Restart `autocuan-web` diperlukan (ada perubahan `api/sector-hot.js` dan `lib/`).

---

## 6. Hasil cek UNKNOWN / PEMANTAUAN_KHUSUS (bagian C) — read-only

### 6.1 Metode

Komposisi universe fast 258 = `FAST_UNIVERSE_TICKERS` (kurasi) ∪ `sector_hot_group_members`,
diinterseksi dengan `stock_boards` lewat **aturan kelayakan yang sama** dengan mode
penuh (`dayTradeEligibilityReason`), lalu ditambah foreign discovery
(`foreign_watchlist_daily`, `universe_source='foreign_latest'`).

Enumerator live 34 UNKNOWN + 7 KHUSUS butuh kredensial Supabase **produksi**.
`.env` lokal berisi placeholder (`SUPABASE_URL` bukan URL valid), sehingga live
enumeration tidak bisa dijalankan dari workspace ini. Script read-only sudah
disiapkan: [`backtest/arjum-audit/audit_unknown_boards_partC.js`](backtest/arjum-audit/audit_unknown_boards_partC.js)
— jalankan di VPS/env produksi, tidak menulis apa pun, tidak mencetak kredensial.

### 6.2 Aturan yang meloloskan (analisis statis `dayTradeEligibilityReason`)

Urutan gate di `lib/daytrade-screener-engine.js`:

1. `invalid_or_unknown_board` **di-skip** bila `isVerifiedActiveFcaExit(ticker)`
   BENAR: `if (!isVerifiedActiveFcaExit && !ALLOWED.includes(board)) return ...`.
   → **Inilah satu-satunya aturan yang meloloskan papan UNKNOWN/PEMANTAUAN_KHUSUS.**
2. Sebelum gate papan, dua gate menghapus nama bermasalah:
   - `restricted_board_or_status` — regex `fca|call auction|pemantauan khusus|suspend|special watch|problem board|watchlist board`.
   - `suspended_fca_exit` — ticker FCA yang masih tersuspend dan belum terbukti aktif.
3. `AKSELERASI` dan `EKONOMI BARU` **selalu** gagal gate papan
   (`DAYTRADE_ALLOWED_BOARDS = ['UTAMA','PENGEMBANGAN']`), jadi **saham Akselerasi
   tidak mungkin lolos** (dikonfirmasi probe lokal: `BBCA/AKSELERASI → invalid_or_unknown_board`).

Probe lokal (tanpa DB) atas mesin kelayakan:

| ticker | board | activeExit | suspendExit | reason |
|---|---|---|---|---|
| ADES | UNKNOWN | true | false | `null` (LOLOS — FCA aktif terverifikasi) |
| BHIT | UNKNOWN | true | false | `null` (LOLOS — FCA aktif terverifikasi) |
| WIKA | PEMANTAUAN_KHUSUS | false | true | `suspended_fca_exit` |
| ZZZZ | UNKNOWN | false | false | `invalid_or_unknown_board` |
| KOPI | PEMANTAUAN_KHUSUS | false | false | `restricted_board_or_status` |
| BBCA | AKSELERASI | false | false | `invalid_or_unknown_board` |

**Kesimpulan:** ke-34 UNKNOWN dan ke-7 PEMANTAUAN_KHUSUS yang lolos adalah
**eks-FCA 92 saham** (manifest `data/fca-transition-2026-09-28.json`,
`active_as_of_status_date`) yang diverifikasi aktif. `stock_boards` masih
menyimpan label lama (`UNKNOWN`/`PEMANTAUAN_KHUSUS`, `is_fca`), dan bypass
`isVerifiedActiveFcaExit` sengaja mengabaikan label itu. Ini **perilaku by-design**,
bukan bug kelayakan.

### 6.3 Pertanyaan C2 (apakah ada di universe penuh 800? Akselerasi/Ekonomi Baru?)

- **Ada di universe penuh 800?** Ya. Kedua universe dibangun lewat aturan
  kelayakan yang sama, jadi nama FCA-aktif yang lolos di fast juga lolos di
  full (script part C mengisi kolom `in_full_universe` per ticker).
- **Akselerasi / Ekonomi Baru?** Tidak. Saham Akselerasi dan Ekonomi Baru
  di-hard-exclude di gate papan, sehingga tidak mungkin masuk ke universe fast
  maupun penuh.

### 6.4 Usulan (pemilik yang memutuskan — aturan kelayakan TIDAK diubah di sini)

Perbaikan opsional, semuanya hanya penyempurnaan label/diagnostik (tanpa
mengubah keanggotaan universe):

1. **Rapikan label papan eks-FCA di `stock_boards`** untuk 92 eks-FCA yang
   aktif: ganti `board='UNKNOWN'`/`'PEMANTAUAN_KHUSUS'` menjadi papan
   kontinu resmi (UTAMA/PENGEMBANGAN) sesuai sumber BEI, dan set `is_fca=false`.
   Ini menghilangkan "34 UNKNOWN" semata supaya UI/liga memakai `stock_boards`
   kanonik. Gunakan `tools/sync-stock-boards-from-bei-xlsx.py`.
2. **Tambah diagnostik `universe_source='fca_active_exit'`** pada baris yang
   lolos lewat bypass, agar laporan jumlah UNKNOWN/PEMANTAUAN_KHUSUS di masa
   depan otomatis menjelaskan asalnya tanpa audit manual.
3. **Tidak mengubah `DAYTRADE_ALLOWED_BOARDS`** — memperketat gate akan
   mengeluarkan 92 eks-FCA aktif dan menurunkan recall; itu keputusan bisnis,
   bukan perbaikan bug.

---

## 7. Perubahan file (A + B)

| File | Perubahan |
|---|---|
| `tools/run-daytrade-intraday-producer.js` | `parseArgs --speed fast|full` (default fast); timeout 6 menit (full)/4 menit (fast); abort `ABORTED_TIMEOUT` tanpa publish; `SKIPPED_RUNNING`; meta run_speed/universe/scanned/duration_ms; log RAM+loadavg |
| `deploy/vps/run-daytrade-producer.sh` | Meneruskan `--speed` (default fast) ke producer; lock single-flight tetap |
| `tools/run-all-screeners-vps.js` | `isFullScanPublishedToday()`; `runDayTrade` pakai predikat itu |
| `api/sector-hot.js` | `isPublishedFullScan()`; guard `already_done` pakai predikat itu; meta mencatat `run_speed`/`duration_ms`; `updateDtMeta` allow-list + degradasi aman; export `__test` baru |
| `supabase/daytrade-screener-run-speed-migration.sql` | Kolom nullable `run_speed`, `duration_ms` |
| `test/daytrade-intraday-producer-speed.test.js` | FUS-01..07 |
| `test/daytrade-full-universe-nightly-skip.test.js` | FUN-01..07 (fast 258/258 jalan; full 800/800 skip; tanpa run_speed jalan) |
| `test/run-all-screeners-vps.test.js` | Fixture meta DayTrade diperbarui ke full-scan |
| `tools/curated-build-tests.json` | Registrasi dua test baru |
| `backtest/arjum-audit/audit_unknown_boards_partC.js` | Script read-only untuk enumerasi bagian C |

**Tes:** `npm run test:full` → **All 707 test files passed**. CI `build-and-focused-tests` (yang menjalankan suite penuh) juga **pass** setelah perbaikan flakiness.

---

## 8. Sisa pekerjaan (butuh VPS + jam bursa/malam)

1. Deploy (§5) di luar jam bursa, `pm2 restart autocuan-web` sekali, health 200.
2. A2: satu run penuh manual 09:25 & 13:40 → isi tabel §2.
3. A3: pilih Jalur 1/2 sesuai syarat; ubah crontab hanya bila Jalur 1; backup dulu.
4. B4: verifikasi scan malam 21:30 men-scan ~800 saham → isi §4.
5. C: jalankan `audit_unknown_boards_partC.js` di env produksi → lengkapi daftar 34/7.