# CHECKLIST OBSERVASI SENIN 19 OKTOBER 2026 & PROSEDUR OPERATOR (V2)

Dokumen ini memuat panduan pemantauan otomatis & manual pasca-deploy branch [`feat/broksum-all-foreign`](deploy/vps/final-schedule.cron) pada Minggu, 18 Oktober 2026, termasuk verifikasi ingesti candle IHSG harian, backfill All unclipped + F, dan kuota 18.080/hari.

---

## 1. Timeline Observasi Kritis Senin 19 Okt 2026 (WIB)

| Jam (WIB) | Komponen / Yang Dicek | Kriteria Sukses | Perintah Siap Tempel di Terminal VPS |
|---|---|---|---|
| **00:10** | **Backfill Jalan & Cadangan 5.100** | Worker backfill bangun pada 00:07 WIB. Karena Senin adalah hari kerja sebelum EOD, worker wajib menggunakan cadangan pre-EOD minimal **5.100 request**. Log mencatat `Reserve Quota: 5100`. | `tail -n 25 /home/ubuntu/auto-cuan-runner/logs/backfill-broksum.log` |
| **09:00–11:30** | **Live Market & Regime IHSG** | FastWatcher (`*/5 9-15`) dan DayTrade Producer (`*/15 9-15`) berjalan lancar. Market regime mengevaluasi harga live Yahoo intraday IHSG digabung riwayat disk 500 bar. | `curl -s "http://127.0.0.1:3000/api/candles?ticker=IHSG" \| head -c 200`<br>`tail -n 20 /home/ubuntu/auto-cuan-runner/logs/fastwatcher.log` |
| **14:00–16:00** | **Live Market Sesi 2** | Sesi perdagangan reguler berakhir pada 16:00 WIB. Kuota live terjaga aman di bawah 300 request. | `tail -n 20 /home/ubuntu/auto-cuan-runner/logs/daytrade-producer.log` |
| **17:00** | **J1 + J2 + IHSG Selesai & `.done`** | J1 (All+F+Accum+Insiders) & J2 (Candles 962 saham + IHSG) selesai. Sentinel `_eod/2026-10-19.done` tertulis. Sisa kuota Arjum >= 800 request. | `ls -l /home/ubuntu/auto-cuan/data/arjum-data/_eod/2026-10-19.done`<br>`cat /home/ubuntu/auto-cuan/data/arjum-data/_quota_tracker.json` |
| **19:30** | **Backfill Slot 2 (Weekday Pasca-EOD)** | Worker backfill bangun pada 19:30 WIB. Karena `.done` sudah ada, worker secara dinamis menurunkan cadangan ke **800 request** dan menyerap sisa kuota malam. | `tail -n 25 /home/ubuntu/auto-cuan-runner/logs/backfill-broksum.log` |
| **20:00** | **Bar IHSG 19 Okt Tercatat di Disk** | File `data/daily-candles/IHSG.json` sudah membawa bar resmi sesi penutupan 19 Oktober 2026 (501 bar total), di-merge rapi tanpa menghilangkan 500 bar historis sebelumnya. | `node -e "const d=JSON.parse(require('fs').readFileSync('/home/ubuntu/auto-cuan/data/daily-candles/IHSG.json')); const last=d.candles[d.candles.length-1]; console.log({ total: d.candles.length, last });"` |
| **21:30** | **Screener Malam (Preflight)** | Evaluasi swing konglo & non-konglo berjalan normal menggunakan data EOD resmi hari ini. | `tail -n 30 /home/ubuntu/auto-cuan-runner/logs/screeners.log` |

---

## 2. Perintah Siap Tempel Pemeriksaan Cepat

Jalankan blok ini di terminal VPS untuk verifikasi status komprehensif:

```bash
# 1. Cek kuota terpakai hari ini vs kuota total 18.080
node -e "
const qt = require('/home/ubuntu/auto-cuan/lib/arjum-quota-tracker');
const ac = require('/home/ubuntu/auto-cuan/lib/arjum-client');
console.log({
  configuredQuota: ac.getConfiguredDailyQuota(),
  usedToday: qt.getUsedToday(),
  remaining: qt.getRemainingToday(ac.getConfiguredDailyQuota())
});
"

# 2. Cek apakah worker backfill sedang berjalan atau lock aktif
ps aux | grep backfill-broksum | grep -v grep || echo "WORKER_IDLE"
cat /home/ubuntu/auto-cuan/data/arjum-data/_backfill/backfill.lock 2>/dev/null || echo "LOCK_FREE"

# 3. Cek kesehatan PM2 dan log error web
pm2 list
tail -n 20 /home/ubuntu/.pm2/logs/autocuan-web-error.log

# 4. Cek respons live API untuk IHSG dan Bandarmologi
curl -s "http://127.0.0.1:3000/api/candles?ticker=IHSG" | head -c 160 && echo ""
curl -s "http://127.0.0.1:3000/api/sector-hot?action=bandarmologi&ticker=BBCA&date=latest&flow=D" | head -c 160 && echo ""
curl -s "http://127.0.0.1:3000/api/sector-hot?action=bandarmologi&ticker=BBCA&date=latest&flow=F" | head -c 160 && echo ""
```

---

## 3. Prosedur Konfigurasi Kuota `ARJUM_DAILY_LIMIT`

Batas kuota harian saat ini diatur secara manual ke **18.080 request/hari** karena vendor Arjum tidak menyediakan header `x-ratelimit-limit`.

### Kapan Harus Mengubah Variabel Ini?
1. **Jika kuota akun diturunkan kembali ke 12.060:** (misalnya masa aktif kuota tambahan +6.020 berakhir).
2. **Jika pemilik membeli paket kuota tambahan baru:** (misalnya dinaikkan ke 24.000 atau lebih).

### Cara Mengubah Nilai Kuota:
Jalankan langkah berikut di VPS:
```bash
# 1. Ubah di file environment runner
sed -i 's/^ARJUM_DAILY_LIMIT=.*/ARJUM_DAILY_LIMIT=12060/' /home/ubuntu/auto-cuan-runner/.env

# 2. Ubah di file environment app
sed -i 's/^ARJUM_DAILY_LIMIT=.*/ARJUM_DAILY_LIMIT=12060/' /home/ubuntu/auto-cuan/.env

# 3. Restart autocuan-web agar membaca nilai baru
pm2 restart autocuan-web --update-env

# 4. Verifikasi bahwa nilai baru aktif terbaca
node -e "console.log('Active Quota:', require('/home/ubuntu/auto-cuan/lib/arjum-client').getConfiguredDailyQuota());"
```

### Mekanisme Pengaman Graceful Exit pada Status 429:
- Jika kuota akun vendor turun menjadi 12.060 sementara env belum diubah (masih 18.080):
  * Pada request ke-12.061, server Arjum akan merespons dengan HTTP 429 (`quota_exceeded`).
  * `arjumClient` secara otomatis mendeteksi status ini dan memicu circuit breaker lokal (`tripCircuitBreaker`).
  * Worker backfill (`backfill-broksum.js`) segera menangkap respons ini, mencatat `[BACKFILL-STOP]`, melepaskan lock file (`backfill.lock`), dan keluar dengan rapi **tanpa melakukan loop berulang**.
  * Sebelum EOD sore (16:30 WIB), worker selalu menyisakan cadangan 5.100 request sehingga kuota tidak akan pernah habis terpakai oleh backfill sebelum data sore selesai diunduh.

---

## 4. Prosedur Rollback Darurat

Jika ditemukan anomali kritis yang tidak dapat diatasi pada hari Senin:

```bash
# 1. Checkout commit stabil sebelumnya
cd /home/ubuntu/auto-cuan
git checkout feat/broksum-all-foreign

# 2. Pulihkan crontab dari backup Minggu
crontab /home/ubuntu/crontab.backup-20261018b.txt

# 3. Restart web server di PM2
pm2 restart autocuan-web

# 4. Verifikasi
pm2 status
```
