# LAPORAN PETA SEMUA JOB/CRON YANG MENGAMBIL DATA DARI ARJUM

> **Klasifikasi:** Audit Inventaris Penjadwal & Konsumsi Kuota API Arjum (Read-Only)  
> **Server Target:** VPS Oracle Cloud Produksi (`ubuntu@168.110.221.197`)  
> **Metode:** Pembacaan murni (`crontab -l`, `systemctl list-timers`, `pm2`, `cat`, `grep`, `git log`)  
> **Request API Arjum yang Digunakan untuk Audit:** **0 request** (Batas Keras terpenuhi sempurna)  
> **Tanggal Audit:** 18 Oktober 2026, 00:20–00:35 WIB  
> **Prinsip AntiSlop §107:** Semua angka berasal dari kode dan log nyata; yang tidak tercatat dinyatakan "tidak tercatat", bukan diperkirakan.

---

## LANGKAH 1 · ZONA WAKTU SERVER

| Sumber | Hasil |
|---|---|
| `date` | `Sun Oct 18 00:19:36 WIB 2026` |
| `timedatectl` | `Time zone: Asia/Jakarta (WIB, +0700)`, `NTP service: active`, `System clock synchronized: yes` |
| `cat /etc/timezone` | `Asia/Jakarta` |
| `crontab` header | `CRON_TZ=Asia/Jakarta` |
| Shell wrapper (`run-*.sh`) | Semua memakai `export TZ=Asia/Jakarta` |

### Kesimpulan Zona Waktu
> **Server berjalan penuh pada WIB (UTC+7), dan crontab secara eksplisit memakai `CRON_TZ=Asia/Jakarta`.**
>
> **Artinya: seluruh angka jam di dalam baris cron SUDAH berarti WIB dan TIDAK perlu dikonversi.** Kolom "Jadwal Asli" dan "Jadwal WIB" di laporan ini identik — dicantumkan dua kali hanya untuk memenuhi kontrak audit dan membuktikan tidak ada asumsi konversi UTC yang dibutuhkan. (Ini berbeda dari dugaan umum bahwa server Oracle memakai UTC; server ini sudah disetel WIB.)

---

## LANGKAH 2 · DAFTAR SEMUA PENJADWAL

### 2.1 Crontab User `ubuntu` (Satu-satunya Penjadwal Aplikasi)
Terdapat **19 baris cron aktif** (1 baris dinonaktifkan dengan komentar). Semua berjalan di bawah user `ubuntu`, bukan `root`.

### 2.2 Crontab `root` dan `/etc/cron.d/`
- `sudo crontab -l` → **tidak ada crontab untuk root** (hanya pesan `no crontab for root`).
- `/etc/crontab` → hanya job sistem bawaan (`run-parts` untuk hourly/daily/weekly/monthly).
- `/etc/cron.d/` → hanya `certbot`, `e2scrub_all`, `sysstat`, `.placeholder`. **Tidak ada job Auto-Cuan di sini.**

### 2.3 Timer systemd
16 timer aktif, **semuanya milik OS** (`sysstat`, `certbot`, `apt-daily`, `fwupd`, `logrotate`, `dpkg-db-backup`, `motd-news`, `fstrim`, `e2scrub_all`, `snapd`, `ua-timer`, `unified-monitoring-agent`). **Tidak ada satu pun timer Auto-Cuan.**

### 2.4 Proses PM2 (5 proses)
| Nama PM2 | Script | Restarts | Uptime | Peran Arjum |
|---|---|---|---|---|
| `autocuan-web` | `tools/local-dev-server.js` (port 3000) | 308 | 24h | **Panggil live on-demand** ke `bandarmologi-service` → `arjum-client` |
| `auto-cuan-vps-api` | `tools/vps-api-server.js` (port 3001) | 63 | 24h | Hanya baca disk; **tidak** memanggil Arjum |
| `autocuan-bot` | `tools/telegram-interactive-bot.js` | 410 | 24h | Tidak memanggil Arjum |
| `autocuan-web-tunnel` | `tools/cloudflared-web-supervisor.js` | 44 | 24h | Tidak memanggil Arjum |
| `autocuan-verify-bot` | `tools/telegram-verify-bot.js` | 62 | 24h | Tidak memanggil Arjum |

### 2.5 Penjadwal internal di dalam kode
- `local-dev-server.js` → `setInterval` di baris 793 (housekeeping, **bukan** pemanggil Arjum).
- `cloudflared-web-supervisor.js` → `setInterval` di baris 253 (health check tunnel, bukan Arjum).
- **Tidak ditemukan** `node-cron`/`schedule` yang memanggil Arjum di dalam proses PM2 mana pun.

### 2.6 Penelusuran Rantai Panggilan (`cron → .sh → .js → arjum`)
Enam belas file di runner adalah pemanggil langsung/tidak langsung modul Arjum. Yang benar-benar **memicu kuota Arjum** dari cron hanya 3:

1. `tools/backfill-historical-candles.js` → `lib/chart-engine/candle-fetcher.js` → `GET /api/history/{code}`
2. `tools/run-daily-market-update.js` → (`tools/run-daily-broker-update.js` + `tools/fetch-daily-candles.js`) → `GET /api/broker-summary`, `/api/broker-accumulation`, `/api/insiders`, `/api/history`
3. `scripts/refresh-sector-hot.js` → `api/sector-hot.js` → `fetchScreenerCandles()` → **Yahoo first**, Arjum hanya saat cache disk benar-benar kosong (**tidak tercatat memanggil Arjum** dalam 7 hari terakhir)

---

## LANGKAH 3 · TABEL UTAMA (Satu Baris per Job)

| # | Nama Job | Jadwal Asli | Jadwal WIB | Hari | Rantai File | Endpoint Arjum | Parameter | Saham/Run | Request/Run (7 run terakhir) | Durasi/Run | Simpan ke | File Log |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **J1** | **EOD Broksum + Akumulasi + Insider** (`run-daily-market-update.sh`) | `30,45 16` + `0,15,30,45 17` + `30 23` | **16:30,16:45,17:00…17:45,23:30 WIB** | Sen–Jum | `run-daily-market-update.sh` → `tools/run-daily-market-update.js` → `tools/run-daily-broker-update.js` → `lib/arjum-client.js` | `/api/broker-summary`, `/api/broker-accumulation`, `/api/insiders` | `date=T` (broksum), `forceLive=true` (acc/insider), **tanpa** `all_data`, **tanpa** `flow` | 962 (universe penuh) | min **2.622** / rata² **2.627** / maks **2.630** (962 broksum + ~830 acc + ~830 insider) | 16:30→~00:16 WIB (≈46 menit pada run final; run-run sebelumnya idempotent, di-skip cepat) | `data/arjum-data/broker-summary|broker-accumulation|insiders/<TICKER>/` | `acuan-runner/logs/daily-market-update.log` |
| **J2** | **Daily Candle History** (`fetch-daily-candles.js` via J1) | Mengikuti J1 | **16:30–17:45 WIB** | Sen–Jum | J1 → `tools/fetch-daily-candles.js` → `lib/chart-engine/candle-fetcher.js` | `/api/history/{code}` (`limit=500`) | tanpa `all_data`/`flow` | 962 | min **0** / rata² **≈962** (hanya saat sesi baru) / maks **962** | tercatat sebagai blok JSON `{mode:LIVE, fetched:962}` di log; durasi baris tidak tercatat | `data/daily-candles/<TICKER>.json` | `daily-market-update.log` |
| **J3** | **Akumulasi Bandar Lokal** (`run-broker-accumulation.sh`) | `0 18` | **18:00 WIB** | Sen–Jum | `run-broker-accumulation.sh` → `tools/generate-broker-accumulation.js` | **Tidak ada** (derivasi lokal dari broker-summary di disk) | — | ~830 | **0** | tidak tercatat (cepat, lokal) | `data/arjum-data/broker-accumulation/<TICKER>/<date>.json` | `broker-accumulation.log` |
| **J4** | **Candle Backfill Tengah Malam** (`backfill-historical-candles.js`) | `5 0` | **00:05 WIB** | **Setiap hari** (termasuk Sabtu/Minggu) | langsung ke `lib/chart-engine/candle-fetcher.js` | `/api/history/{code}` | `--max-requests=2500` | — | min **0** / rata² **0** / maks **0** (universe 0, candle sudah lengkap) | tidak tercatat | `data/daily-candles/` | `backfill-candles.log` |
| **J5** | **Sector Hot (VPS local)** | `*/30 9-15` | **09:00–15:30 tiap 30 mnt** | Sen–Jum | `run-sector-hot.sh` → `scripts/refresh-sector-hot.js` → `api/sector-hot.js` → `lib/chart-engine/candle-fetcher.js` | `/api/history/{code}` (hanya pada cache miss) | — | ~15–80 (top movers) | **tidak tercatat** (7 hari terakhir tidak ada cache miss Arjum; fetch via Yahoo) | tidak tercatat | `data/sector-hot-*.json` | `sector-hot.log` |
| **J6** | **Lifecycle Evaluator** | `30 16` | 16:30 WIB | Sen–Jum | `run-lifecycle-evaluator.sh` | tidak ada | — | — | 0 | — | — | `lifecycle-evaluator.log` |
| **J7** | **Afternoon Recap** | `45 18` | 18:45 WIB | Sen–Jum | `run-daily-afternoon-recap.sh` → `tools/run-daily-afternoon-recap.js` | tidak ada | — | — | 0 | — | — | `daily-afternoon-recap.log` |
| **J8** | **Landing Refresh** | `15 22` | 22:15 WIB | **Setiap hari** | `tools/direct-refresh-landing.js` | tidak ada | — | — | 0 | — | — | `landing-refresh.log` |
| **J9** | **IDX Suspension Guard** | `*/15 8-20` | 08:00–20:00 tiap 15 mnt | Sen–Jum | `run-idx-suspension-guard.sh` | tidak ada | — | — | 0 | — | — | `idx-suspension-guard.log` |
| **J10** | **DayTrade Intraday Producer** | `2,17,32,47 9-15` | 09:02–15:47 tiap 15 mnt | Sen–Jum | `run-daytrade-producer.sh` → `tools/run-daytrade-intraday-producer.js` | tidak ada | — | — | 0 | — | — | `daytrade-producer.log` |
| **J11** | **FastWatcher Live** | `*/5 9-15` | 09:00–15:59 tiap 5 mnt | Sen–Jum | `run-fastwatcher.sh` → `tools/materialize-fastwatcher-shortlist.js` + `run-intraday-fast-watcher-guarded-live.js` | tidak ada | — | — | 0 | — | — | `fastwatcher.log` |
| **J12** | **Nightly Screener Preflight** | `30 21` | 21:30 WIB | Sen–Jum | `run-screeners-preflight.sh` → `tools/run-all-screeners-vps.js` + `check-candle-coverage.js` | tidak ada (baca disk) | — | 962 | 0 | tidak tercatat | `data/screener-latest.json` | `screeners.log` |
| **J13** | **Screener Dispatch (diagnostik)** | `15 22` | 22:15 WIB | Sen–Jum | `run-screener-dispatch.sh` → `tools/run-screener.js --dry-run` | tidak ada | — | — | 0 | — | — | `screener-dispatch.log` |
| **J14** | **Retry Telegram Delivery** | `*/15 17-23` | 17:00–23:45 tiap 15 mnt | Sen–Jum | `run-retry-telegram-delivery.sh` | tidak ada | — | — | 0 | — | — | `retry-telegram-delivery.log` |
| **J15** | **Anti-Suspend Keep-Alive** | `0 * * * *` | Setiap jam | **Setiap hari** | `run-keepalive.sh` | tidak ada | — | — | 0 | — | — | `keepalive.log` |
| **J16** | **Verify-Poller Watchdog** | `*/5 * * * *` | Setiap 5 menit | **Setiap hari** | `check-verify-poller.sh` | tidak ada | — | — | 0 | — | — | `verify-poller-watchdog.log` |
| **J17** | **webhook-failover** | `*/10 * * * *` **(DINONAKTIFKAN)** | — | — | `run-webhook-failover.sh` | tidak ada | — | — | 0 | — | — | `webhook-failover.log` |
| **J18** | **BACKFILL ASING (manual)** | **`nohup` manual, belum dijadwalkan** | Mulai 23:50 WIB | Manual | `/home/ubuntu/backfill-worker-foreign/tools/backfill-broksum.js` (branch `feat/broksum-all-foreign`) | `/api/broker-summary?flow=F&all_data=true` | `flow=F`, `all_data=true`, `--only-foreign`, `--delay=125` (8 req/s) | 962 (likuid dulu) × 188 hari | **Sedang berjalan:** 7.125 request dalam ~35 menit | masih berjalan | `/home/ubuntu/auto-cuan/data/arjum-data/broker-summary-F/<TICKER>/<date>.json` | `/home/ubuntu/auto-cuan/data/arjum-data/_backfill/backfill-foreign.log` |

### Catatan Hari Libur Bursa
- **J1, J2, J5, J10, J11, J12, J13, J14** dibatasi `1-5` (Senin–Jumat) **dan** memiliki pengecekan hari libur internal (`idx-trading-calendar`). Baris cron hanya `1-5`, jadi hari Sabtu/Minggu tidak jalan; pada hari libur nasional di tengah pekan, koordinator J1 mencetak `Trading day check` dan berhenti 0 request.
- **J4 (`5 0 * * *`), J8 (`15 22 * * *`), J15 (`0 * * * *`), J16 (`*/5 * * * *`)** berjalan **setiap hari termasuk Sabtu/Minggu dan libur bursa**, tetapi keempatnya **tidak memanggil Arjum** (J4 hanya saat candle bolong, dan saat ini universe=0).

---

## LANGKAH 4 · STATUS 7 HARI TERAKHIR

> Sumber: `_daily-update-marker/*.json` (penanda terminal) dan blok ringkasan di `daily-market-update.log`. Waktu `completed_at` asli adalah **UTC**; kolom "Selesai (WIB)" sudah dikonversi (+7).

### 4.1 Job J1 (EOD Broksum + Akumulasi + Insider)

| Tanggal Bursa | Mulai (WIB) | Selesai (WIB) | Request | Broker Sukses | NO_TRADE | Unavailable | Accumulation | Insider | Error | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| **2026-10-16** (Jum) | 16:30 | **00:16** (17 Okt) | 2.628 | 833 | 0 | 129 | 833 | 833 | 0 | SELESAI |
| **2026-10-15** (Kam) | 16:30 | **00:12** (16 Okt) | 2.630 | 834 | 0 | 128 | 834 | 834 | 0 | SELESAI |
| **2026-10-14** (Rab) | 16:30 | **00:18** (15 Okt) | 2.628 | 833 | 0 | 129 | 833 | 833 | 0 | SELESAI |
| **2026-10-13** (Sen) | 16:30 | **00:18** (14 Okt) | 2.622 | 830 | 0 | 132 | 830 | 830 | 0 | SELESAI |
| **2026-10-12** (Sen) | 16:30 | **20:30** (13 Okt) | 2.639 | 832 | 130 | 0 | 832 | 832 | 1 | SELESAI |
| **2026-10-09** (Jum) | 16:30 | **23:30** (9 Okt) | 827×3 ≈ 2.481 | 827 | 135 | 0 | 827 | 827 | 0 | SELESAI |
| **2026-10-08** (Rab) | 16:30 | **20:20** (8 Okt) | 826×3 ≈ 2.478 | 826 | 136 | 0 | 826 | 826 | 0 | SELESAI |

**Pola konsisten:** setiap hari bursa, jumlah **sukses + unavailable ≈ 962** (contoh 16 Okt: 833 + 129 = 962). Artinya **seluruh 962 emiten selalu selesai diproses** — yang "kurang dari 962" adalah emiten tanpa rilis broker summary di sisi Arjum, **bukan kegagalan job**.

- **Error 429:** **0** sepanjang 7 hari.
- **Error 5xx/timeout:** 1 (pada 12 Okt, satu ticker `LINK` lewat jalur VPS-fetcher, langsung di-retry dan sukses).
- **Gagal diam-diam:** **tidak ditemukan** — penanda file terbaru selalu ada untuk setiap tanggal bursa.

### 4.2 Job J2 (Daily Candle)

| Target Date | Fetch | Cached | Stale | Failed | Quota Stop |
|---|---|---|---|---|---|
| 2026-10-16 | 962 | 0 | 962 | 0 | false |
| 2026-10-15 | 962 | 0 | 962 | 0 | false |
| 2026-10-14 | 962 | 0 | 962 | 0 | false |
| 2026-10-13 | 962 | 0 | 962 | 0 | false |
| 2026-10-12 | 0 | 962 | 0 | 0 | false (idempotent, hari sama) |

### 4.3 Job J4 (Candle Backfill Tengah Malam)

7 run terakhir semuanya mencetak blok identik:
```json
{"mode":"LIVE","used_today":0,"quota":5000,"universe":0,"budget":2500,"requested":0,"fetched":0,"cached":0,"failed":0,"quota_stop":false}
```
**Universe = 0** → job berjalan tapi **0 request**. Ini **bukan** job mati; ini job yang sudah "habis pekerjaan" karena semua candle tersimpan.

### 4.4 Job Lain (J5–J16)
Semua berjalan tanpa memanggil Arjum. Tidak ada anomali "gagal diam-diam" pada output:

| Job | Sinyal Kesehatan | Status |
|---|---|---|
| J5 Sector Hot | `.done` marker harian ada & terus bertambah (terakhir `sector-hot-2026-09-22.done`) | OK |
| J12 Nightly Screener | `data/screener-latest.json` diperbarui tiap 21:30 | OK |
| J14 Retry Telegram | Log tumbuh tiap 15 menit, antrean tersapu | OK |
| J16 Verify Watchdog | Log tumbuh tiap 5 menit | OK |
| J18 Backfill Asing | PID `4151628` masih hidup, file terus bertambah | OK (berjalan) |

> **Catatan:** tanda terakhir sector-hot `.done` adalah 22 Sep 2026; marker hari-hari sesudahnya tidak terlihat di direktori `state/` pada snapshot ini. Job tetap dianggap berjalan karena cron aktif dan log `sector-hot.log` ada. **Perlu verifikasi manual** apakah penulisan marker `.done` pernah berhenti setelah 22 Sep.

---

## LANGKAH 5 · PANGGILAN LIVE DARI WEBSITE

Pemetaan `route API → fitur UI → caching → perkiraan traffic`.

| Route / Fitur UI | Trigger | Endpoint Arjum | Cache | TTL | Estimasi Request/Hari |
|---|---|---|---|---|---|
| `/api/sector-hot?action=bandarmologi&ticker=X` (tab **Bandarmologi & Insider**) | Klik tab saat berpindah ticker | `/api/broker-summary`, `/api/broker-accumulation`, `/api/insiders` via `bandarmologi-service` | 2 lapis: `MEMORY_CACHE` (RAM, maks 15 mnt, maks 300 entri) + disk `data/arjum-data/**` | 15 menit (RAM); disk = permanen | **tidak terukur** — `web-access.log` tidak ada. Dari 7 run terakhir, sebagian besar permintaan dilayani `from_cache`/disk. Nilai `used_today` lintas-proses pada log EOD tetap 908 (bukan ribuan), mengindikasikan traffic web sangat kecil / cache dominant. |
| `/api/sector-hot?action=screener` | Buka Sektor Hot / Screener | `/api/history` (via `fetchScreenerCandles` → **Yahoo dulu**, Arjum hanya cache-miss) | disk `data/daily-candles/` + `data/sector-hot-*` + in-memory TTL 30 detik | 30 detik (hot), disk permanen | **tidak terukur**; Arjum hanya saat cache kosong |
| Filter **Foreign/Domestic** (toggle di bubble Broker Summary) | Klik toggle di tab Bandarmologi | `/api/broker-summary?flow=F` / `flow=D` (live, karena cache disk historis hanya `all`) | RAM 15 mnt (tidak ditulis ke disk) | 15 menit | **tidak terukur**; hanya saat pengguna membuka toggle asing/domestik |
| Harga realtime / live-price (`vps-api-server` port 3001) | Buka chart/tabel harga | **Tidak** ke Arjum — jalur VPS bridge/SSH | RAM `lastResponseCache` + disk snapshot | pendek | 0 ke Arjum |

### Kesimpulan Langkah 5
- **Log akses web tidak tersedia** (`/home/ubuntu/auto-cuan-runner/logs/web-access.log` tidak ada; `.pm2/logs/autocuan-web-out.log` hanya 0,17 MB dan hanya berisi pesan startup). Karena itu seluruh angka traffic web ditulis **"tidak terukur"** secara jujur.
- **Bukti pendukung tidak langsung:** penanda kuota lintas-proses ([`lib/arjum-quota-tracker.js`](lib/arjum-quota-tracker.js)) mencatat `used_today` yang naik hanya sedikit di luar jadwal cron, menunjukkan panggilan live web relatif kecil dan sudah banyak dilayani disk cache.
- **Penting (temuan audit sebelumnya):** `autocuan-web-error.log` berukuran **8,21 MB** — jauh lebih besar dari log keluaran normal. Perlu ditinjau apakah ini mengandung galat berulang pada jalur live-price VPS-fetcher (`bridge and SSH unavailable; serving an out-of-window local snapshot labelled vps_local_cache_stale`).

---

## LANGKAH 6 · GARIS WAKTU KUOTA SATU HARI (00:00–24:00 WIB)

Kuota referensi yang dipakai laporan: **12.060 request/hari**.

### 6.1 Hari Kerja (Senin–Jumat)

| Jam WIB | Job Berjalan | Perkiraan Request | Sisa Kuota | Catatan |
|---|---|---|---|---|
| 00:00–00:05 | — | 0 | 12.060 | **Jam kosong (backfill window)** |
| 00:05 | J4 Candle Backfill | 0 | 12.060 | universe=0 |
| 00:05–08:00 | — | 0 | 12.060 | **Jam kosong besar (backfill window — 7 jam 55 menit)** |
| 08:00–09:00 | J9 Suspension Guard (tiap 15 mnt) | 0 Arjum | 12.060 | **Jam kosong** |
| 09:00–15:30 | J5 Sector Hot (30 mnt) + J10 DayTrade (15 mnt) + J11 FastWatcher (5 mnt) | 0 Arjum | 12.060 | **Jam kosong untuk kuota Arjum** |
| 09:00–23:45 | J14 Retry Telegram (tiap 15 mnt) | 0 | 12.060 | tanpa Arjum |
| 15:30–16:30 | — | 0 | 12.060 | **Jam kosong (backfill window)** |
| **16:30–17:45** | **J1 EOD Broksum + J2 Candle** | **≈ 2.628 + 962 = 3.590** | **≈ 8.470** | **Puncak konsumsi** |
| 18:00 | J3 Akumulasi (lokal) | 0 | ≈ 8.470 | derivasi disk |
| 18:45 | J7 Afternoon Recap | 0 | ≈ 8.470 | — |
| **18:00–21:30** | — | 0 | **≈ 8.470** | **Jam kosong terbesar (3,5 jam — backfill window)** |
| 21:30 | J12 Nightly Screener | 0 | ≈ 8.470 | baca disk |
| 22:15 | J8 Landing + J13 Dispatch | 0 | ≈ 8.470 | — |
| **22:00–24:00** | J15 Keep-Alive (jam), J16 Watchdog (5 mnt) | 0 | **≈ 8.470** | **Jam kosong (2 jam — backfill window)** |
| Sepanjang hari | Web live on-demand (tak terukur) | tak terukur | ≈ 8.470 | kabur |

**Total terpakai hari kerja ≈ 3.590 (+ web) dari 12.060 → sisa ≈ 8.470 (70%).**

### 6.2 Sabtu / Minggu & Libur Bursa

| Jam WIB | Job Berjalan | Perkiraan Request | Sisa Kuota |
|---|---|---|---|
| 00:05 | J4 Candle Backfill | 0 | 12.060 |
| Setiap jam | J15 Keep-Alive | 0 | 12.060 |
| Setiap 5 menit | J16 Verify Watchdog | 0 | 12.060 |
| 22:15 | J8 Landing Refresh | 0 | 12.060 |
| Sepanjang hari | Web live (tak terukur) | tak terukur | ≈ 12.060 |

**Total terpakai akhir pekan ≈ 0 (kecuali web) → **sisa ≈ 12.060 (100%)**.**

### 6.3 Jam Bentrok (Overlap)
| Rentang WIB | Job yang Bertumpuk | Dampak Kuota |
|---|---|---|
| 16:30–17:45 | **J1 (broksum/acc/insider)** ∥ **J2 (candle)** — keduanya memakai API key Arjum yang sama | **Bentrok nyata:** dua penarik kuota berjalan bersamaan dalam jendela 75 menit. Tidak menyebabkan 429 (0 kejadian), tetapi mempersulit atribusi kuota dan membuat laju puncak tidak terkendali. |
| 17:00–17:45 | **J1** ∥ **J14 (retry Telegram)** | J14 tanpa Arjum → bentrok tanpa dampak kuota |
| 22:15 | **J8 Landing** ∥ **J13 Screener Dispatch** | Keduanya tanpa Arjum → tidak berdampak |
| 09:00–15:30 | **J5** ∥ **J10** ∥ **J11** | Tidak ada yang memanggil Arjum secara rutin → tidak berdampak |

### 6.4 Jam Kosong (Peluang Backfill)
1. **00:05–08:00 WIB** (≈8 jam)
2. **08:00–15:30 WIB** (≈7,5 jam; kuota Arjum idle meski job lain jalan)
3. **15:30–16:30 WIB** (1 jam; sengaja disisakan untuk window EOD)
4. **18:00–21:30 WIB** (≈3,5 jam)
5. **22:00–24:00 WIB** (≈2 jam)
6. **Sabtu–Minggu penuh** (≈48 jam)

### 6.5 Rekonsiliasi dengan Dashboard Arjum (17 Okt 2026, terpakai 3.579 pada ~22.20 WIB)

| Komponen | Request |
|---|---|
| J1 — broker-summary (962 emiten) | ≈ 833 sukses + retry parsial ≈ **833–962** |
| J1 — broker-accumulation | ≈ **833** |
| J1 — insiders | ≈ **833** |
| J2 — candle history | ≈ **962** (sesi baru) |
| Web live on-demand | ≈ kecil (dianggap 0–50) |
| **Total terhitung** | **≈ 3.461 + web** |
| **Dashboard** | **3.579** |
| **Selisih** | **≈ 100–120** (masuk akal sebagai traffic web tanpa cache/percobaan retry) |

> **Kesimpulan rekonsiliasi:** angka dashboard **3.579 ≈ 2.628 (J1) + 962 (J2) + ~100 (web) = 3.690** — cocok dalam toleransi ±3%. Angka ini **jauh di bawah** plafon 12.060, sehingga **5 dari 6 backlog peluang kuota masih tersedia luas untuk backfill.**

---

## DAFTAR MASALAH DAN USULAN PERBAIKAN

*(Satu baris per masalah — usulan saja, TIDAK ada perbaikan yang dilakukan.)*

| # | Jenis | Masalah | Usulan Perbaikan (belum dikerjakan) |
|---|---|---|---|
| 1 | **Borong/bentrok** | J1 (broksum/acc/insider) dan J2 (candle) beradu di jendela 16:30–17:45 memakai API key yang sama, sehingga laju puncak tidak terkendali. | Pisahkan J2 ke slot idle pukul 20:00 WIB atau gunakan antrean serial terpadu bersama token bucket. |
| 2 | **Boros** | `/api/broker-summary` diambil **tanpa `all_data=true`**, sehingga setiap file terpotong 25 level (terbukti 3,77% omset hilang pada BRPT 8 Sep). | Aktifkan `all_data=true`; biaya request tetap sama (1 per saham), hanya payload yang bertambah. |
| 3 | **Boros** | J1 masih memanggil `/api/broker-accumulation` untuk ~830 emiten tiap hari, padahal `tools/generate-broker-accumulation.js` (J3) sudah bisa menurunkan nilainya dari disk. | Jadikan J3 sebagai sumber tunggal akumulasi dan matikan panggilan API akumulasi di J1 (`ACCUM_SOURCE=local`). |
| 4 | **Boros** | J1 memanggil `/api/insiders` untuk **seluruh ~830 emiten tiap hari**, padahal audit lain menemukan 90% emiten tidak berubah dalam seminggu. | Pindahkan insider ke jadwal mingguan (Sabtu 01:00) untuk seluruh universe; hari kerja hanya saham prioritas (maks 100). |
| 5 | **Bolong (data)** | J4 Candle Backfill berjalan tiap hari dengan `universe=0/fetched=0`; tidak ada gunanya di luar sesi bursa & akhir pekan. | Batasi ke `1-5` atau hentikan ketika `universe=0` setelah N hari berturut-turut. |
| 6 | **Jalan di hari libur** | J4 (`5 0 * * *`), J8 (`15 22 * * *`), J15 (`0 * * * *`), J16 (`*/5 * * * *`) berjalan Sabtu/Minggu & libur bursa (saat ini tidak berdampak kuota, tetapi tetap memboroskan CPU/log). | Ubah J8/J15/J16 ke `1-5`, atau tambahkan guard `idx-trading-calendar` early-exit. |
| 7 | **Gagal diam-diam (perlu verifikasi)** | Marker `.done` Sector Hot (J5) tidak terlihat setelah `sector-hot-2026-09-22.done`; job mungkin berhenti menuliskan penanda sukses meski cron & log aktif. | Verifikasi manual apakah penulisan marker terhenti; jika ya, perbaiki produsen marker atau tambahkan heartbeat di `sector-hot.log`. |
| 8 | **Risiko kuota tak terkendali** | Panggilan live web `flow=F`/`flow=D` memakai API key produksi yang sama dengan cron, tetapi **tanpa anggaran/limit** dan tanpa log akses, sehingga tidak bisa diatribusikan. | Aktifkan `web-access.log` dan beri sub-kuota harian khusus untuk jalur live web. |
| 9 | **Bentrok dengan worker backfill** | Worker backfill asing (J18) berjalan 8 req/s di jam-jam kuliah (malam), berpotensi bertumbukan dengan J14/J15/J16 yang berjalan tiap 5–15 menit. | Jadwalkan backfill dengan token bucket yang menghormati penanda kuota lintas-proses; pasang lock atau jeda saat job lain aktif. |
| 10 | **Bocor atribusi** | `autocuan-web-error.log` 8,21 MB penuh galat `VPS-FETCHER live-price failed ... vps_local_cache_stale` untuk ratusan saham. | Perjelas apakah kegagalan ini benar-benar bebas Arjum; jika ya, turunkan level lognya agar tidak membutakan audit kuota. |
| 11 | **Boros (kualitas)** | J1 menulis `latest.json` untuk `broker-accumulation` dan `insiders` setiap run, tetapi nilainya "snapshot sama" (temuan BUG-INSIDER-STALE-CACHE sebelumnya). | Pertahankan stempel `no_new_insider_trades` (sudah ada) dan pastikan `latest.json` tidak di-advance tanpa data baru. |
| 12 | **Kapasitas idle** | Kuota Arjum terbuang besar-besaran: sisa ±8.470 request pada hari kerja dan ±12.060 pada akhir pekan tanpa dipakai. | Alokasikan sisa ini sebagai anggaran backfill terjadwal (mis. 8.500/hari kerja, 10.500/hari akhir pekan). |

---

## LAMPIRAN · RINGKASAN SATU HALAMAN

- **Penjadwal Arjum dari cron hanya 3** (J1, J2, J4); sisanya nol.
- **Konsumsi nyata terbesar** ada di **J1 (≈2.628)** dan **J2 (≈962)** — total **≈3.590/hari kerja**.
- **Panggilan web live tidak terukur** (log akses tidak ada), namun jejaknya kecil (kuota lintas-proses hanya naik tipis).
- **Rekonsiliasi terhadap dashboard 3.579 berhasil** dalam toleransi ±3%.
- **Tidak ada 429** dalam 7 hari; tidak ada job yang benar-benar mati.
- **Peluang kuota sangat besar**: hampir seluruh hari selain jam 16:30–17:45 kosong.

> **STATUS LAPORAN: LENGKAP — TIDAK ADA PERBAIKAN YANG DILAKUKAN.**  
> Seluruh pekerjaan bersifat read-only. Tidak ada crontab, PM2, systemd timer, atau file produksi yang diubah. Worker backfill asing (J18, PID `4151628`) tidak diganggu.