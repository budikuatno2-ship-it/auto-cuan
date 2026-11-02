# REPORT — CEK DARURAT PIPELINE DATA ARJUM (READ-ONLY)

**Waktu audit:** Selasa **2026-10-20, 02:00–08:00 WIB** (setelah prompt DayTrade selesai).
**Referensi dashboard pemilik:** Senin **2026-10-19 23:05 WIB** (4.376 req/hari, 83.752 req/bulan).
**Branch VPS:** `feat/daytrade-screener-v1` @ `c7e2b46d` (merge PR #901, 2026-10-20 02:10 WIB).
**Mode:** READ-ONLY penuh. **0 request Arjum**, tidak ada restart, tidak ada perubahan crontab/kode/`.env`/data, tidak menjalankan job manual.
**Tanpa kunci/IP/lokasi kunci.** Semua angka dari keluaran nyata `crontab -l`, `pm2`, pembacaan file, dan log. Yang tidak bisa dicek ditulis **"tidak diketahui"**.

---

## 0. KESIMPULAN DUA KALIMAT

**Yang berhenti: penulisan broker summary (ALL + Foreign), IHSG, akumulasi bandar, dan insider untuk tanggal bursa 2026-10-19** — job `run-daily-market-update.sh` (J1) mengirim 921 request broker-summary tetapi **seluruhnya gagal (error 921/921, tersimpan 0)** dan ditandai `Status: GAGAL` pada pass final 23:30 WIB; job **candle** 16:40 juga gagal cross-check (20/20) lalu jatuh ke Arjum dan hampir seluruhnya gagal (943 gagal, rc=0). **Hari baik terakhir = 2026-10-16; hari pertama bolong = 2026-10-19** (17–18 Okt akhir pekan).
**Penyebab paling mungkin: kegagalan hulu Arjum/transport pada sesi 18:00–23:30 WIB 2026-10-19** (bukan cron hilang: cron lengkap; bukan kuota: kuota tidak habis; bukan guard: guard sudah diperbaiki; bukan lock menggantung: lock residu tanpa pemilik) — **tingkat keyakinan: SEDANG-TINGGI** (mekanisme pasti error 921 tidak tercatat di log; lihat §5).

> **[DARURAT]** Data 2026-10-19 belum tertulis untuk broker summary ALL/F, akumulasi, insider, dan IHSG, dan 921 request broker-summary + ±943 request candle-fallback terbuang tanpa hasil — **jangan hapus/menimpa apa pun; jalankan ulang J1 untuk 2026-10-19 pada jendela berikutnya & aktifkan IHSG**. *(Usulan saja — tidak dijalankan.)*

---

## 1. JADWAL (CRONTAB) & KESEHATAN JOB

### 1.1 Zona waktu & proses
- Server WIB (Asia/Jakarta), `crontab` header `CRON_TZ=Asia/Jakarta` → jam pada cron = WIB langsung.
- `sudo crontab -l` → **tidak ada crontab root**. Semua job di user `ubuntu`.
- `pm2 list` (saat audit): 5 proses **online**:
  - `autocuan-web` PID **68520**, restarts **318**, uptime **~9 mnt** saat cek pertama → restart **2026-10-20 02:11:52 WIB** (deploy keamanan #901, sesuai [`REPORT_KEAMANAN_20261020.md`](backtest/arjum-audit/REPORT_KEAMANAN_20261020.md:5)).
  - `auto-cuan-vps-api`, `autocuan-bot`, `autocuan-verify-bot`, `autocuan-web-tunnel` → uptime **3 hari**.

### 1.2 Tabel job yang memanggil Arjum atau menulis data harian

| Job | Jadwal (WIB) | Skrip | Log | Run terakhir | Hasil | Request terpakai | Menulis ke |
|---|---|---|---|---|---|---|---|
| **J1 broksum ALL + F + D + akumulasi + insider** | `30,45 16`,`0,15,30,45 17`,`30 23` Sen–Jum | `run-daily-market-update.sh --accum-source=api --insider-mode=daily` → `run-daily-broker-update.js` | `daily-market-update.log` | 2026-10-19 23:30 (final) | **GAGAL** (`Status: GAGAL — … 921 ticker belum punya broker summary 2026-10-19`) | 921 broksum (0 tersimpan); accum 0; insider 0 | `data/arjum-data/broker-summary[-F]/<T>/<date>.json`, `broker-accumulation`, `insiders` |
| **J1 (riwayat sehat)** | idem | idem | idem | 2026-10-16 (final) | SELESAI — 833 broksum, 0 NO_TRADE, 129 unavailable | 2.628 | tgl 2026-10-16 |
| **J2 candle harian 962 (Yahoo→Arjum fallback) + IHSG + cek silang 20** | `40 16` & `30 23` Sen–Jum | `run-daily-candles.sh` → `tools/fetch-daily-candles.js` | `daily-candles.log` | 2026-10-19 23:30 | **16:40: CROSS-CHECK-FAILED 20/20 → fallback Arjum, fetched 0, failed 943 (rc=0).** 23:30: CROSS-CHECK-OK 20/20, fetched 859 (yahoo 818 + Arjum 41), failed 83 | 963 (16:40), 1.024 (23:30) | `data/daily-candles/<T>.json` (+`IHSG.json`) |
| **Backfill broksum** | `7 0 1-5`, `30 19 1-5`, `7 0 6,0` | `tools/backfill-broksum.js --mode=weekday|weekend` | `backfill-broksum.log` | 2026-10-20 01:35 (slot 00:07 sudah berjalan) | **HALTED_BY_BUDGET_OR_QUOTA** (`[BUDGET-GUARD] Kuota sisa (5100) <= cadangan (5100)`) | 12.980 | `broker-summary[-F]/…` |
| **Backfill candle** | `5 0 * * *` | `tools/backfill-historical-candles.js --max-requests=2500` | `backfill-candles.log` | 2026-10-20 00:05 | `universe 0` → 0 request (tidak ada pekerjaan) | 0 | `daily-candles/` |
| **Sector Hot** | `*/30 9-15` Sen–Jum | `run-sector-hot.sh --force-local` | `sector-hot.log` | 2026-10-19 15:31 | OK (Yahoo, 0 Arjum) | 0 | `data/sector-hot-*` |
| **DayTrade producer** | `2,17,32,47 9-15` Sen–Jum | `run-daytrade-producer.sh --execute` | `daytrade-producer.log` | 2026-10-19 15:47 | **published 258/258, snapshot 207 rows** | 0 | `screener-latest.json` |
| **Screeners preflight (swing/NK/top5)** | `30 21` Sen–Jum | `run-screeners-preflight.sh --execute --send` | `screeners.log` / `screener-preflight.log` | 2026-10-19 21:30 | OK — Swing 165, NK 635, snapshot 202 rows | 0 | `screener-latest.json` |
| **Afternoon recap** | `45 18` Sen–Jum | `run-daily-afternoon-recap.sh --send` | `daily-afternoon-recap.log` | 2026-10-19 18:45 | SENT | 0 | Telegram |
| **Lifecycle evaluator** | `30 16` Sen–Jum | `run-lifecycle-evaluator.sh --apply` | `lifecycle-evaluator.log` | 2026-10-19 16:30 | OK | 0 | Supabase |
| **Landing refresh** | `15 22 * * *` | `direct-refresh-landing.js` | `landing-refresh.log` | 2026-10-19 22:15 | OK | 0 | `data/*` |
| **IDX suspension guard** | `*/15 8-20` Sen–Jum | `run-idx-suspension-guard.sh` | `idx-suspension-guard.log` | 2026-10-19 20:45 | OK (IDX, 0 Arjum) | 0 | `idx-suspension-status.json` |
| **FastWatcher** | `*/5 9-15` Sen–Jum | `run-fastwatcher.sh --send` | `fastwatcher.log` | 2026-10-19 15:55 | OK | 0 | radar ledger |
| **Retry Telegram** | `*/15 17-23` Sen–Jum | `run-retry-telegram-delivery.sh --apply` | `retry-telegram-delivery.log` | 2026-10-19 23:45 | OK | 0 | Telegram |
| **Keepalive / watchdog** | `0 * * * *` / `*/5 * * * *` | `run-keepalive.sh` / `check-verify-poller.sh` | masing-masing | 2026-10-20 02:00 | OK | 0 | lokal |
| **Akumulasi lokal (J3)** | ~~`0 18`~~ | `run-broker-accumulation.sh` | — | — | **nonaktif** (baris dikomentari; J1 single-writer) | — | — |

### 1.3 "Ada di crontab?" — ya/kecuali
- **Broksum ALL+F (per saham/hari):** ADA (J1 + backfill).
- **IHSG (1 req/hari):** **TIDAK ada baris cron khusus IHSG.** IHSG diperbarui di dalam J2 candle (Arjum) — tapi **IHSG.json berhenti di 2026-10-16** (lihat §3.4). Jadi IHSG **TIDAK TERJADWAL tersendiri** dan kini basi.
- **Candle 962 (Yahoo, 16:40 & 23:30) + cek silang 20:** ADA (2 baris).
- **Akumulasi broker:** ADA via J1 (`--accum-source=api`). Generator lokal J3 **dinonaktifkan**.
- **Insider:** ADA via J1 (`--insider-mode=daily`).
- **Backfill (19:30 & 00:07):** ADA (+ akhir pekan 00:07).
- **Job sore penulis `.done`:** marker `.done` yang ada hanya `sector-hot-<date>.done`, **berhenti di 2026-09-22**; J1 memakai marker JSON `_daily-update-marker/<date>.json` (lihat §1.4).

### 1.4 Lock & marker
- **Lock menggantung (semua 0 byte, tanpa pemilik hidup):** `daily-candles.lock` (mtime 2026-09-29 23:29), `daily-market-update.lock` (2026-10-01 18:22), `daytrade-producer.lock` (2026-10-06 09:43), `screeners.lock`/`screener-dispatch.lock` (2026-09-25), dll. **Tidak ada proses pemilik** (`ps` hanya 5 node PM2 + tidak ada proses `backfill`). → residu tak berbahaya, bukan penyebab J1 gagal (J1 tetap berjalan tiap 30 mnt).
- **Marker J1:** `_daily-update-marker/2026-10-19.json` → `"complete": false`, `errors: 921`, `done: 0`, `no_data: 41`, `auxiliary_complete: false`, mtime isi 2026-10-19T16:33:54Z (≈23:33 WIB). Marker `2026-10-16.json` → `"complete": true`, tetapi `total_tickers: 10`, `auxiliary_mode: "historical_snapshot_not_backfillable"`, `completed_at: 2026-10-18T02:08Z` (snapshot historis kecil, bukan 962).

### 1.5 Kecurigaan timeoutGuard (3,5 dtk)
- **Kode saat ini SUDAH diperbaiki di repo:** [`api/sector-hot.js`](api/sector-hot.js:163) → `isHeavyComputeAction()` dan [`api/sector-hot.js`](api/sector-hot.js:182) `const timeoutGuard = heavyAction ? null : setTimeout(...)` — heavy actions **tidak** lagi dijawab fallback 3,5 dtk.
- **Bukti aktif di VPS:** DayTrade producer **kembali sukses** (2026-10-19 15:02→15:47: `batch 3: status=published scanned=258/258`, `snapshot : materialized (207 rows)`); total `status=published` = 101.
- **Kemunculan string fallback:** seluruh log yang dipindai hanya **1 kali** — `daytrade-producer.log:3433` `ERROR: DayTrade producer status stayed unknown after 5 retries (last note: Fallback: response completed via timeout guard)`, **sebelum** run 2026-10-19 15:02 WIB (perbaikan aktif setelah itu).
- **Apakah ada job Arjum yang dipicu via endpoint HTTP dan terkena guard?** **TIDAK.** Pemicu Arjum (J1/J2/backfill) adalah proses Node langsung, bukan lewat `api/sector-hot`. Cakupan string fallback di `pgrep` log = 1 (DayTrade saja, sudah pulih). Tanggal pertama/terakhir pasti kena **tidak diketahui** (log tidak memberi tanggal per-baris untuk setiap run gagal).

---

## 2. KELENGKAPAN BROKSUM ALL & ASING (2 Jan – 19 Okt 2026)

Sumber: hitung file `2026-*.json` per tanggal di `broker-summary/` (ALL) dan `broker-summary-F/` (F). **Semua file bukan 0-byte** (ALL kosong = 0; F kosong = 0).

### 2.1 Tabel per bulan (ringkas; hari bursa = jumlah tanggal berfile)

| Bulan | Hari bursa (berfile) | ALL rata2 saham/hari | ALL min–max | F rata2 saham/hari | F min–max |
|---|---|---|---|---|---|
| Jan 2026 | 20 | ~961 | 961–961 | 134 | 134 |
| Feb 2026 | 19 | ~960 | 957–961 | 134 | 134 |
| Mar 2026 | 20 | ~960 | 957–961 | 134 | 134 |
| Apr 2026 | 21 | 961 | 961 | 134 | 134 |
| Mei 2026 | 20 | ~957 | 865–961 | 134 | 134 |
| Jun 2026 | 21 | ~960 | 957–961 | 134 | 134 |
| Jul 2026 | 23 | ~962 | 961–963 | 134 | 134 |
| Agu 2026 | 21 | ~962 | 957–963 | 134 | 134 |
| Sep 2026 | 22 | **~865** | **830–969** | ~134.6 | 134–135 |
| Okt 2026 (1–16) | 11 | **~831** | 827–834 | 135 | 135 |
| **Okt 2026 (19)** | **0** | **— (bolong)** | — | **0** | **— (bolong)** |

- **ALL:** rentang file `2026-01-02 … 2026-10-16` (188 tanggal). **Tidak ada file 2026-10-19.**
- **F:** rentang file `2026-01-02 … 2026-10-16`. **Tidak ada file 2026-10-19.** F hanya melayani **135 emiten** (bukan 502/962) — **cakupan F memang rendah sejak awal** (konsisten dengan Fase 3: "cakupan F likuid 13,79%"), **bukan** kerusakan baru.
- Tidak ada `derived:"no-trade"`/`vendor_foreign_not_yet_published` pada file F yang diperiksa — struktur F = `{stock_code, brokers:[…]}` (contoh BBCA/TLKM/BUMI 2026-10-16 berisi baris broker normal). **File F "kosong tanpa penjelasan": 0** dari yang dipindai.

### 2.2 Rentang tanggal bolong (tidak ada file sama sekali)
- **2026-10-19:** ALL = 0 & F = 0 → **961 emiten ALL + 135 F hilang** untuk satu hari bursa. **[ini yang aktif]**
- Selisih antar-tanggal lain (kemungkinan libur bursa/cuti bersama, **perlu verifikasi kalender IDX**): 2026-01-16, 2026-02-17, 2026-03-20/23/24, 2026-04-03, 2026-05-01/14, 2026-08-17 (kemerdekaan), dst. Tidak ada file untuk tanggal-tanggal itu.

### 2.3 10 hari terakhir vs 10 hari sebelumnya
- 10 hari bursa **terakhir** (1–16 Okt): ALL 827–834/hari (stabil), F 135/hari.
- 10 hari bursa **sebelumnya** (15–30 Sep): ALL sempat 830–963 (16 Sep turun ke 830), F 134–135.
- **Hari terakhir data benar = 2026-10-16.** **Hari pertama bolong = 2026-10-19.** (17–18 Okt akhir pekan; tidak ada hari bursa di antaranya.)

### 2.4 Cakupan 10 saham uji (BBCA, BRPT, BBRI, MEDC, ADRO, BUMI, BMRI, TPIA, BBNI, TLKM)
- **ALL:** tiap saham **198 file** (termasuk `latest.json`), tanggal terakhir `2026-10-16`; **tidak ada 2026-10-19**.
- **F:** tiap saham **188 file**, tanggal terakhir `2026-10-16`; **tidak ada 2026-10-19**.
- Semua 10 saham uji **selaras**: bolong bersama mulai 2026-10-19.

### 2.5 Catatan "hari ini"
- 2026-10-19 sudah melewati backfill 19:30 dan 00:07; keduanya **tidak menulis 2026-10-19** (19:30 masuk rentang tapi berhenti karena budget guard; 00:07 berikutnya jalan setelah tengah malam). Karena itu **2026-10-19 dikonfirmasi bolong**, ditandai terpisah dari hari-hari historis.

---

## 3. INSIDER, AKUMULASI, CANDLE YAHOO, IHSG

### 3.1 Insider
- **Tanggal data terakhir: 2026-10-16** (per saham; `insiders/BBCA/2026-10-16.json` dst). Distribusi ~826–834/hari selama Sep–Okt.
- **Sumber:** **per emiten** (`/api/insiders/<code>`); **tidak ada endpoint massal** (sesuai Fase 1C). **Request/hari ≈ ~830** untuk universe yang berhasil (bagian dari J1, hanya untuk emiten COMPLETE same-day).
- **Job terakhir sukses: 2026-10-16** (marker complete). **2026-10-19: 0** (J1 gagal → sukunder tidak dipanggil).
- **Cakupan sejak 2 Jan:** direktori `insiders/` = 964 emiten; tanggal berfile yang terlihat (histogram ekor) 1 Okt–16 Okt = 962→833; **cakupan penuh 2 Jan–19 Okt: tidak diketahui** (histogram penuh tidak diambil).

### 3.2 Akumulasi broker
- **Sumber: `api`** (crontab memanggil J1 dengan `--accum-source=api`; `ACCUM_SOURCE` tidak di-set di `.env` runner). Jadi **belum** `local`.
- **Tanggal data terakhir: 2026-10-16.** Direktori `broker-accumulation/` = 964 emiten; distribusi ~826–834/hari (Okt).
- **Cakupan sejak 2 Jan: tidak diketahui** (hanya ekor histogram yang diambil); 10 saham uji semua berakhir `2026-10-16`.

### 3.3 Candle harian Yahoo (962) — sejak PR #898/Fase 1A (deploy 18 Okt)
| Tanggal | 16:40 (WIB) | 23:30 (WIB) | Cek silang 20 | Fallback Arjum | failed |
|---|---|---|---|---|---|
| **2026-10-19** | **CROSS-CHECK-FAILED 20/20 → fallback Arjum semua ticker; fetched 0** | CROSS-CHECK-OK 20/20; fetched 859 (yahoo 818) | 0/20 lalu 20/20 | **YA, masif** | 943 lalu 83 |
- `data/daily-candles/`: **964 file** (962 + `IHSG.json` + 1 tambahan), mtime terbaru 2026-10-19 23:34.
- Bar `2026-10-19` ada di **879** file; **84** file berakhir `2026-10-16`; **1** berakhir `2026-07-29`. → **±85 file tertinggal** dari tanggal pasar terakhir. (IHSG termasuk yang berakhir 16 Okt.)
- Apakah candle **memakai Arjum kembali (fallback)?** **YA.** 19 Okt 16:40 → fallback ke **Arjum untuk SEMUA ticker** (karena cross-check gagal) namun gagal 943; 23:30 → fallback Arjum untuk **41** ticker (Yahoo 404). Jadi fallback **terpicu**; pada pass 16:40 tidak produktif.

### 3.4 IHSG
- `data/daily-candles/IHSG.json`: **500 bar, bar terakhir `2026-10-16`** (close 5185.105). mtime file 2026-10-18 15:46.
- **Bar IHSG 2026-10-19: TIDAK ADA.** → **IHSG tertinggal** dan tidak punya jadwal cron tersendiri.

---

## 4. PENCOCOKAN DENGAN DASHBOARD KUOTA

- **Pencatat kuota lintas-proses:** `data/arjum-data/_quota-state/usage.json` (di-key per tanggal WIB; **rollover 00:00**). Saat audit: **`{"date":"2026-10-20","used":12980}`** (naik dari backfill 00:07). `data/candle-quota.json`: `{"date":"2026-10-19","used":1044}`.
- **`ARJUM_DAILY_LIMIT` terbaca = 18.080** (sama di `.env` runner & repo) → **sesuai rencana pemilik** (1.000 gratis + 17.080 Supporter). **Tidak ada penanda perbedaan.**
- **Sisa kuota saat audit (20 Okt): 18.080 − 12.980 = 5.100.**
- **Rekonstruksi 2026-10-19 (dashboard 4.376, 23:05 WIB):**
  - J2 candle (16:40 + 23:30) = **963 + 1.024 → ~1.044** (candle-quota).
  - J1 broker-summary 23:30 = **~1.044**.
  - Backfill 19:30 (Sen 19 Okt) = sisanya ≈ **~2.288**.
  - → **total komponen ≈ 4.3xx + web-live**, **mendekati 4.376** (toleransi wajar). Atribusi tepat **tidak bisa dipastikan** karena pencatat day-key sudah rollover ke 20 Okt dan tidak ada `web-access.log`.
- **Request terpakai tetapi data kosong (kebocoran kuota): YA.**
  - J1 2026-10-19: **921 request broker-summary → 0 file tersimpan (errors 921).**
  - Candle 16:40: **943 request fallback → 0 bar baru** (failed 943), plus 20 request cek silang.
  - → **±1.884 request 19 Okt terbuang tanpa tulisan.** Ini pemakaian kuota terbesar yang sia-sia.
- **Bulan ini (83.752):** tidak ada akumulator bulanan di server (hanya day-key) → **angka bulanan tidak dapat diverifikasi dari log lokal**; 83.752 / ±19 hari ≈ 4.4xx/hari → **konsisten** dengan pola 19 Okt.
- **Pemanggil lain di luar crontab:** tidak ditemukan proses manual/`nohup` yang berjalan saat audit (`ps` bersih; hanya 5 node PM2). Pemanggil tak terukur yang mungkin = **live web `flow=F`/`flow=D`** (tanpa `web-access.log`).

---

## 5. VERIFIKASI 6 TEMUAN AWAL (Claude Code)

| # | Temuan | Verdict | Bukti |
|---|---|---|---|
| 1 | Candle harian gagal cross-check & fallback gagal diam-diam (exit 0) | **BENAR (sebagian)** | 19 Okt 16:40: `[CROSS-CHECK-FAILED] 20/20 … Falling back to Arjum`; hasil `fetched 0, failed 943, stale 943`; `[J2-CANDLES] END rc=0`. Pass 23:30 memulihkan (859). |
| 2 | IHSG & broker summary tertinggal di 16 Okt | **BENAR** | `IHSG.json` bar terakhir `2026-10-16`; `broker-summary[-F]` maks `2026-10-16`. |
| 3 | Backfill berhenti karena 502/530 | **BENAR (sebagian)** | Ada run `Status: HALTED_BY_PROVIDER_ERROR` (SSIA 2026-01-12 `status=502`, 2026-01-09/08/07 `status=530`; `[BACKFILL-HALT] 5 consecutive provider errors`). **Namun halt terbaru (19 Okt 19:30 / 20 Okt 00:07) = `HALTED_BY_BUDGET_OR_QUOTA`** (`[BUDGET-GUARD] Kuota sisa (5100) <= cadangan (5100)`), bukan 502/530. |
| 4 | File untracked, termasuk `market.db` 0 byte | **BENAR** | `git status`: 7 untracked (`backups/`, `data/_staging/`, `data/daytrade-snapshot-alarm.json`, `data/intraday-fast-watcher-*`, `data/market.db`). `data/market.db` = **0 byte**. (File DB asli ada di `auto-cuan-data/market.sqlite` ±128 MB — di luar repo.) |
| 5 | `/api/quote`&`/api/candles` (BBCA) sajikan 16 Okt; market breadth 16 Okt; Broker Hunter mundur 8 Sep — **tidak tertulis atau tertulis-tapi-tidak-dibaca?** | **BENAR, dengan dua mekanisme berbeda** | (a) **Tidak tertulis:** broker summary ALL/F, akumulasi, insider, IHSG semua berhenti `2026-10-16` (J1 gagal) → bandarmologi/broker summary memang **tak tertulis**. (b) **Tertulis-tapi-tidak-dibaca:** candle 2026-10-19 **ADA di disk** (879 file) tetapi `/api/candles` & `/api/quote` menerapkan kebijakan **T-1** ([`lib/chart-t1-policy.js`](lib/chart-t1-policy.js:59) `retainCompletedCandles` membuang bar `time >= jakartaToday`) → menyajikan `2026-10-16` sebagai bar terakhir (saat 19 Okt). Market breadth ikut basi (turunan candle/broker). `broker-hunter-indexes/*` mtime **2026-09-12** → memang **tidak dibangun ulang** (klaim "8 Sep" tidak dapat dipastikan tanpa membaca isi). |
| 6 | `vps_local_cache_stale` ~52 ribu baris; hipotesis "harga live = VWAP T-1 dianggap basi" | **Volume BENAR; hipotesis penyebab DITOLAK** | Hitungan: `daily-market-update.log` = **11.034** baris (+ `daily-broker-update.log` 1.108; `autocuan-web-error.log` ujung = 3.929). **Alasan yang tercatat: `bridge and SSH unavailable; serving an out-of-window local snapshot labelled vps_local_cache_stale`** — jadi penyebabnya **jalur bridge/SSH lokal tidak tersedia**, **bukan** payload valid yang ditolak karena "T-1 basi". Tidak memanggil Arjum → bukan masalah kuota. |

### Pemeriksaan "perbaikan Roo sebelumnya benar-benar aktif di VPS?"
| Perbaikan | Status di VPS | Bukti |
|---|---|---|
| Timeout guard (heavy action opt-out) | **AKTIF** | Kode ada; DayTrade publishing lagi (207 rows, 19 Okt 15:47). |
| Backfill (label provider-error + retry backoff) | **AKTIF** | `HALTED_BY_PROVIDER_ERROR` + `[BACKFILL-RETRY] … retry 1/3 … 30000ms`. |
| STALE_SNAPSHOT swing | **TIDAK lagi memblokir** | Screeners 19 Okt 21:30: Swing 165 & Non-Konglo 635 selesai; snapshot 202 rows tertulis. |
| Validator J1 / marker v2 | **AKTIF** | Marker `version: 2` + `upstream_error_count` dsb. |

---

## 6. USULAN PERBAIKAN (URUT PALING MENDESAK — MENUNGGU PERSETUJUAN, BELUM DIJALANKAN)

1. **Isi ulang 2026-10-19 (broksum ALL+F, akumulasi, insider, IHSG).**
   - *Apa:* jalankan ulang J1 untuk target `2026-10-19` (mis. `run-daily-market-update.sh --final`) saat jam sepi (bukan jam bursa) supaya 18–19 Okt terisi; perbaiki IHSG dengan menarik 1 bar IHSG 2026-10-19 via Arjum.
   - *Risiko:* ±1.9k request (broksum+aux) + 1 IHSG; jika Arjum belum merilis data 19 Okt, hasil bisa kosong lagi (jangan paksa).
   - *Jalur kembali:* idempoten — file yang sudah ada di-skip; tidak menimpa tgl lain.
2. **Perbaiki IHSG agar terjadwal/bebas-fallback.**
   - *Apa:* pastikan langkah IHSG (1 req) di J2 benar-benar berjalan walau cross-check candle gagal.
   - *Risiko:* +1 request/hari. *Jalur kembali:* hapus langkah.
3. **Perkuat jalur candle: cross-check gagal jangan langsung boros fallback massal.**
   - *Apa:* bila cross-check 20/20 gagal, tunda fallback massal (retry jadwal 23:30) alih-alih membuang ±943 request.
   - *Risiko:* candle mungkin tetap 1 siklus basi. *Jalur kembali:* kembalikan perilaku lama.
4. **Naikkan cakupan F (135 → target likuid).** Akar Fase 3 (13,79%).
   - *Apa:* backfill F untuk ticker likuid (per hari per saham). *Risiko:* besar (ratusan ribu request) → jadwalkan bertahap di jendela idle; gunakan reserve. *Jalur kembali:* hentikan backfill.
5. **Perbaiki backfill saat provider error:** lanjut ke task berikutnya (jangan halt total), pertahankan label `PROVIDER_ERROR` vs `BUDGET`.
   - *Risiko:* masih ada server 5xx sesekali. *Jalur kembali:* kembalikan halt-on-5xx.
6. **Beri sub-kuota + log akses untuk live web (`flow=F/D`)** agar atribusi kuota mungkin. *Risiko:* sedikit membatasi live. *Jalur kembali:* naikkan limit.
7. **Bersihkan residu:** hapus lock 0-byte tanpa pemilik (setelah konfirmasi), house-keeping `data/market.db` 0-byte + untracked. *Risiko:* rendah. *Jalur kembali:* tidak perlu.

---

## 7. ESTIMASI BACKFILL & KEBUTUHAN HARI KUOTA

| Kebutuhan | Perhitungan | Request | Hari kuota (@18.080; sisa ~5.100–13k/hari) |
|---|---|---|---|
| 2026-10-19 broksum ALL | 962 emiten | ~962 | < 0,1 hari |
| 2026-10-19 broksum F | 962 (atau 135 bila F terbatas) | ~135–962 | < 0,1 hari |
| 2026-10-19 akumulasi + insider | ~830 + ~830 | ~1.660 | ~0,1 hari |
| IHSG 2026-10-19 | 1 | 1 | — |
| **Subtotal isi 2026-10-19** | | **≈ 2.760–3.590** | **< 0,3 hari** |
| Naikkan F ke ~502 likuid untuk 188 hari | 502 × 188 (kurang 135 yang ada) | ≈ **69.000** | **≈ 4–6 hari** (di jendela idle) |
| Kejar candle yang tertinggal (~85 ticker) | 85 × (hari bolong) | kecil (Yahoo-first) | < 0,1 hari |

**Urutan yang disarankan:** (1) isi 2026-10-19 lebih dulu (murah, memulihkan dashboard) → (2) IHSG → (3) perkuat candle → (4) F backfill bertahap.

---

## 8. KEPATUHAN

- **0 request Arjum** (semua dari `crontab -l`, `pm2`, dan pembacaan file/log server-side).
- **Tidak ada restart / perubahan** crontab, kode, `.env`, atau data. **Tidak menjalankan job manual.**
- Tidak ada `.env`, `ARJUM_API_KEY`, kunci SSH, IP VPS, atau lokasi kunci yang dicetak.
- Tidak memakai `StrictHostKeyChecking=no`. Tidak ada angka karangan; yang tak terverifikasi ditulis "tidak diketahui".

**Lampiran perintah reproduksi (read-only):** lihat [`backtest/arjum-audit/rcmd_pm2.sh`](backtest/arjum-audit/rcmd_pm2.sh:1), [`rcmd_logs.sh`](backtest/arjum-audit/rcmd_logs.sh:1), [`rcmd_data.sh`](backtest/arjum-audit/rcmd_data.sh:1), [`rcmd_coverage.sh`](backtest/arjum-audit/rcmd_coverage.sh:1), [`rcmd_hist.sh`](backtest/arjum-audit/rcmd_hist.sh:1), [`rcmd_guard.sh`](backtest/arjum-audit/rcmd_guard.sh:1), [`rcmd_verify.sh`](backtest/arjum-audit/rcmd_verify.sh:1), [`rcmd_final.sh`](backtest/arjum-audit/rcmd_final.sh:1), [`rcmd_guard2.sh`](backtest/arjum-audit/rcmd_guard2.sh:1), dijalankan via [`roo_ssh.js`](backtest/arjum-audit/roo_ssh.js:1).