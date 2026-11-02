# REPORT — Cek Kesehatan SEMUA Cron & Job (pasca-merge + deploy)

**Tanggal cek:** Senin, 19 Oktober 2026, 10:35–11:01 WIB (jam bursa, sesi 1)
**Branch VPS:** `feat/daytrade-screener-v1` @ `e057953e`
**Sifat tugas:** **READ-ONLY** — 0 request Arjum, tidak ada restart, tidak ada perubahan crontab/kode/data.
**Kuota Arjum terpakai saat cek:** 1.828 / 18.080 (10,1%)

---

## 0. RINGKASAN EKSEKUTIF

| Status | Jumlah | Job |
|---|---|---|
| 🔴 **DARURAT (jam bursa)** | 1 | **DayTrade intraday producer** — mati total sejak **13 Okt 09:02** (6 hari bursa) |
| 🟠 **Bermasalah (serius)** | 4 | Backfill broksum (halt 502), Backfill candle (universe 0), Swing Konglo (STALE), Swing Non-Konglo (STALE) |
| 🟡 **Bermasalah (kecil)** | 3 | J2 candle harian (log tak ada), idx-suspension (403), live-price BMTR (stale) |
| 🟢 **Aman** | 9 | FastWatcher, Sektor Hot, J1 EOD marker, regime IHSG, api/candles, keepalive, landing-refresh, retry-telegram, lifecycle-evaluator |

> **Kesimpulan penting:** **TIDAK ADA** satu pun kerusakan di atas yang disebabkan oleh merge PR #891/#896.
> DayTrade mati sejak **13 Okt** (6 hari sebelum merge), Swing stale sejak **5 Okt**, backfill candle `universe:0` sejak cron dipasang. Merge hanya mengubah `api/candles.js` + `INSIDER_MODE` — dan `api/candles` terbukti **15/15 sehat**.

---

## 1. TABEL SEMUA JOB

Legenda status: 🟢 aman · 🟡 kecil · 🟠 serius · 🔴 darurat

| # | Job | Jadwal WIB | Rantai file | Sumber data | Run terakhir | Status | Output terakhir | Error di log |
|---|---|---|---|---|---|---|---|---|
| 1 | **DayTrade producer** | `2,17,32,47 9-15` (tiap 15 mnt) | `run-daytrade-producer.sh` → `tools/run-daytrade-intraday-producer.js` → `api/sector-hot?action=daytrade-screener-run` | Lokal (scan internal) | **19 Okt 10:32** (gagal) | 🔴 **DARURAT** | **Tidak ada** — abort sebelum publish | `Unexpected DayTrade producer status: missing` (setiap run) |
| 2 | **FastWatcher** | `*/5 9-15` | `run-fastwatcher.sh --send` | Lokal + Yahoo | 19 Okt 10:35 | 🟢 aman | radar ledger `2026-10-19.json`; `telegram_sent:1` pada run terakhir | 0 error |
| 3 | **Swing Konglo** | nightly `21:30` (via screeners-preflight) | `run-screeners-preflight.sh` → runner | Lokal snapshot | **5 Okt 19:15** | 🟠 serius | `STALE_SNAPSHOT` — kirim dibatalkan | snapshot 2026-09-30 vs expected 2026-10-05 (age 3 sesi) |
| 4 | **Swing Non-Konglo** | nightly `21:30` | idem | Lokal snapshot | **5 Okt 19:30** | 🟠 serius | `STALE_SNAPSHOT` — kirim dibatalkan | idem |
| 5 | **Nightly screener** | `30 21` | `run-screeners-preflight.sh --execute --send` | Lokal | **16 Okt 21:33** | 🟡 kecil | `screeners.log` 220 rows, snapshot 5,974,976 B | jalan tapi berhenti sejak 16 Okt (tidak ada run 19 Okt karena baru 11:01) |
| 6 | **Top 5 / radar** | ikut nightly | fase 5–6 screeners-preflight | Lokal | 16 Okt 21:33 | 🟡 kecil | `Top 5 generation: Skipped/read-only` | — |
| 7 | **Telegram pagi** | via nightly/top5 | `telegram-daily-picks` | Lokal | 16 Okt | 🟡 kecil | `telegram-daily-picks 0` rows di snapshot | 0 sinyal |
| 8 | **Afternoon Recap** | `45 18` | `run-daily-afternoon-recap.sh --send` | Lokal | 16 Okt 18:45 | 🟢 aman | `Status: SENT`, Total Sinyal 0 | — |
| 9 | **Sektor Hot** | `*/30 9-15` | `run-sector-hot.sh --force-local` | **Yahoo** (0 Arjum) | **19 Okt 10:31** | 🟢 aman | 177 ok / 2 failed, 48 grup, 179 ticker, 59,9 s | 2 ticker no-data (BTEL, dll) |
| 10 | **Live-price cache** | on-demand (web) | `lib/vps-data-fetcher.js` | Bridge/SSH lokal | 19 Okt 10:47 | 🟡 kecil | snapshot lokal `vps_local_cache_stale` | `live-price BMTR failed: bridge and SSH unavailable` (tiap 15 mnt) |
| 11 | **J1 EOD (broksum all+F+insider+accum)** | `30,45 16`, `0,15,30,45 17`, `30 23` | `run-daily-market-update.sh` → `run-daily-broker-update.js` | **Arjum** | marker `2026-10-16` complete @ 18 Okt 02:08 | 🟢 aman (riwayat) | marker complete=true | — |
| 12 | **J2 candle (Yahoo+IHSG+crosscheck)** | `40 16`, `30 23` | `run-daily-candles.sh` → `tools/fetch-daily-candles.js` | Yahoo + Arjum (21 req) | **tidak ada log** (lock 29 Sep) | 🟡 kecil | tidak ada `daily-candles.log` | log tidak pernah dibuat |
| 13 | **J3 akumulasi lokal** | ~~`0 18`~~ | `run-broker-accumulation.sh` | — | — | ⚪ nonaktif | baris cron dikomentari (J1 single-writer) | sesuai desain |
| 14 | **Backfill broksum 00:07** | `7 0 1-5` | `tools/backfill-broksum.js --mode=weekday` | **Arjum** | 19 Okt 00:07–00:20 | 🟠 serius | `Requests Sent: 1828`, `Status: HALTED_BY_BUDGET_OR_QUOTA` | **Cloudflare 502** pada TCPI 2026-08-03 |
| 15 | **Backfill broksum 19:30** | `30 19 1-5` | idem | Arjum | 18 Okt 19:30 (tidak ada di log hari ini) | ⏳ belum jatuh tempo | — | — |
| 16 | **Backfill candle 00:05** | `5 0 * * *` | `tools/backfill-historical-candles.js --max-requests=2500` | Arjum | 19 Okt 00:05 | 🟠 serius | **`universe: 0`** — 0 request | tidak error, tapi daftar ticker kosong |
| 17 | **Market-regime** | on-demand | `lib/market-regime.js` | Disk IHSG + **Yahoo live** | 19 Okt 11:00 | 🟢 aman | 501 candle; **bar hari ini 2026-10-19 close 4919.14** | — |
| 18 | **Track Record** | via nightly | `api/sector-hot?action=track-record` | Lokal/Supabase | 16 Okt | 🟡 kecil | ikut snapshot beku | — |
| 19 | **monitor-picks** | via telegram retry | `run-retry-telegram-delivery.sh` | Supabase | 18 Okt 23:45 | 🟢 aman | `sent=0 failed=0 of 0` | — |
| 20 | **Webhook/failover** | **nonaktif** (`#`) | `run-webhook-failover.sh` | — | 25 Sep 17:00 | ⚪ nonaktif | long-polling via PM2 | sesuai desain |
| 21 | **Lifecycle evaluator** | `30 16` | `run-lifecycle-evaluator.sh --apply` | Lokal | 16 Okt 16:30 | 🟢 aman | `Rows updated: 7/7`, errors 0 | — |
| 22 | **Landing refresh** | `15 22` | `tools/direct-refresh-landing.js` | Lokal | 18 Okt 22:15 | 🟢 aman | `ok:true`, sectors 4, dt_signals 0 | — |
| 23 | **idx-suspension-guard** | `*/15 8-20` | `run-idx-suspension-guard.sh` | IDX | 19 Okt 10:45 | 🟡 kecil | `fresh:false`, suspended 48 | `IDX session HTTP 403` |
| 24 | **Keepalive** | `0 * * * *` | `run-keepalive.sh` | Lokal | 19 Okt 10:00 | 🟢 aman | skip (load cukup) | — |
| 25 | **verify-poller watchdog** | `*/5` | `check-verify-poller.sh` | PM2 | 19 Okt 10:50 | 🟢 aman | — | — |

---

## 2. [DARURAT] DayTrade intraday producer — MATI SEJAK 13 OKT

### Gejala
Setiap 15 menit log menulis:
```
batch 0: status=unknown scanned=0/0
ERROR: Unexpected DayTrade producer status: missing
```
**Tidak ada** `status=published`, **tidak ada** `snapshot : materialized`.

### Bukti timeline (`daytrade-producer.log`)
| Tanggal | Hasil |
|---|---|
| s.d. **12 Okt 15:47** | ✅ 4 batch `running → published`, snapshot 188 rows (97 kali sukses total) |
| **13 Okt 09:02 → sekarang** | ❌ `status=unknown scanned=0/0` + `ERROR ... status: missing` (setiap run) |

### Akar masalah (terbukti)
1. `api/sector-hot.js` baris **160–172** memasang `timeoutGuard` global **3.500 ms**:
   ```js
   const timeoutGuard = setTimeout(() => {
     timeoutFired = true;
     if (!res.headersSent) {
       res.status(200).json({ success: true, data: [], rows: [],
         note: 'Fallback: response completed via timeout guard',
         generated_at: new Date().toISOString() });
     }
   }, 3500);
   ```
2. Scan penuh 258 emiten **butuh >3,5 detik**. Probe langsung membuktikan respons yang diterima producer:
   ```json
   {"success":true,"data":[],"rows":[],
    "note":"Fallback: response completed via timeout guard"}
   ```
   → **tidak ada field `status`**.
3. `tools/run-daytrade-intraday-producer.js:124` membaca `last.status` → kosong → baris 165:
   ```js
   throw new Error('Unexpected DayTrade producer status: ' + (status || 'missing'));
   ```
4. Scan **sebenarnya tetap berjalan** di background — probe `action=daytrade-screener` (read-only) menunjukkan:
   ```
   status: "scanning", message: "Batch 1/4 done. Scanned 75/258. Passed: 0."
   universe_count: 258, scanned_count: 75, published_count: 25
   ```
   Jadi **mesin scan hidup, tapi orkestrator producer selalu abort** sebelum batch berikutnya.

### Dampak
- `data/screener-latest.json` **beku sejak 16 Okt 16:47** (umur **3.544 menit ≈ 2,5 hari**).
- Snapshot berisi **0 rows** (file 5,98 MB tapi array kosong).
- DayTrade screener di web & `telegram-daily-picks` memakai data basi.
- Snapshot malam 21:30 pun menulis ulang dari data basi (16 Okt: 220 rows, tapi hari ini tidak ada run baru).

### Usulan perbaikan (BELUM dikerjakan — menunggu persetujuan)
1. **Prioritas 1 (hari ini):** naikkan/lewati `timeoutGuard` untuk `HEAVY_COMPUTE_ACTIONS` (mis. `daytrade-screener-run`, `nk-screener-run`, `refresh-screener`) — jangan kirim fallback 200 tanpa `status`.
2. **Prioritas 2:** buat `timeoutGuard` mengembalikan `{ status: 'running', scanned_count, universe_count }` agar producer bisa lanjut batch, bukan abort.
3. **Prioritas 3:** tambahkan alarm Telegram bila `screener-latest.json` > 2 jam pada jam bursa.

---

## 3. Penyebab Backfill 00:07 Hanya Memakai 1.828 Kuota

### Fakta
```
Mode: WEEKDAY (Reserve Quota: 5100)
Requests Sent:       1828
Tasks Skipped:      25986
Invalid After Retry: 0
Status:              HALTED_BY_BUDGET_OR_QUOTA
```
`usage.json` → `{"date":"2026-10-19","used":1828,"updated_at":"2026-10-18T17:20:02Z"}` (= 00:20 WIB).
Mulai 00:07, berhenti 00:20 → **13 menit**, 1.828 request (≈2,3 req/s, pacing 125 ms).

### Akar masalah (BUKAN kuota habis)
Baris terakhir sebelum halt:
```
[BACKFILL-STOP] Respon tidak valid untuk FOREIGN TCPI 2026-08-03:
  status=502, ok=false, error=The origin web server returned an invalid or
  incomplete response to Cloudflare. This typically indicates the origin is
  overloaded or misconfigured.
```
Kode `tools/backfill-broksum.js:830–831`:
```js
console.error(`[BACKFILL-STOP] Respon tidak valid untuk FOREIGN ...`);
quotaHalted = true;   // ← 502 diperlakukan SAMA dengan kuota habis
break;
```
Lalu baris 878 menulis label menyesatkan:
```js
Status: ${quotaHalted ? 'HALTED_BY_BUDGET_OR_QUOTA' : 'COMPLETED_OR_LIMITED'}
```

**Jadi:** backfill berhenti karena **satu respons 502 dari Cloudflare** (vendor overload), **bukan** karena sisa kuota ≤ 5.100. Sisa kuota saat itu masih ±16.252.

### Faktor pendukung
- `Tasks Skipped: 25.986` — mayoritas task memang sudah selesai (cache valid), jadi hanya 1.828 yang perlu diambil. Ini **normal** untuk backfill lanjutan.
- Tidak ada worker tertahan akibat pindah branch: lock `_backfill/` tidak ada file `.lock`, `state.json` ter-update 00:20.
- Tidak ada indikasi circuit breaker (hanya 502 tunggal, bukan 429).

### Dampak
- Backfill tidak selesai; sisa task akan dicoba lagi pada slot **19:30 WIB** (hari ini) — aman untuk kuota.
- Label status salah → menyulitkan monitoring (terlihat seperti kuota habis padahal bukan).

### Usulan perbaikan (BELUM dikerjakan)
1. Bedakan `provider_error_halt` (502/503/timeout) dari `quota_halted`; tambahkan retry 2–3× dengan backoff sebelum `break`.
2. Perbaiki label ringkasan: `HALTED_BY_PROVIDER_ERROR` vs `HALTED_BY_BUDGET_OR_QUOTA`.
3. Lanjutkan ke task berikutnya (skip ticker yang 502) alih-alih menghentikan seluruh backfill.

---

## 4. Jam Bursa Sekarang (Sesi 1, 09:00–11:01 WIB)

| Pertanyaan | Jawaban | Bukti |
|---|---|---|
| DayTrade dapat harga live? | ❌ **TIDAK** — producer abort sebelum scan selesai | `status=unknown scanned=0/0` setiap run |
| FastWatcher dapat harga live? | ✅ **YA** | radar `2026-10-19.json`, `telegram_sent:1`, 0 error |
| Bar hari ini tersedia? | ❌ **TIDAK** — 0 dari 964 file candle punya bar `2026-10-19` | `with_today_bar: 0` (normal: J2 jalan 16:40) |
| Regime pasar pakai IHSG live? | ✅ **YA** | `fetchIhsgDailyCandles()` → 501 bar, **terakhir `2026-10-19` close 4919.14** |
| Broadcast Telegram pagi terkirim? | ⚠️ **Tidak ada sinyal** | `telegram-daily-picks 0` rows; Afternoon Recap terakhir 16 Okt `SENT` (0 sinyal) |

---

## 5. Dampak Perubahan Merge (dicek satu per satu)

### 5.1 `api/candles.js` — ✅ **SEHAT (15/15)**
| Ticker | 1y | 2y | 3y | 5y | max |
|---|---|---|---|---|---|
| **BBCA** | 238 | 472 | 711 | 1.198 | 268 |
| **BRPT** | 238 | 472 | 711 | 1.198 | 292 |
| **IHSG** | 500 | 500 | 500 | 500 | 500 |

- Semua `http=200`, `success=true`, `n>0`, `source="Data Historis T-1"`.
- `latest.date = 2026-10-16` untuk 1y–5y (benar: T-1, hari ini belum tutup).
- ⚠️ **Catatan kecil:** `range=max` mengembalikan `last=2026-10-01` dengan `n` lebih kecil (268/292) — perilaku ini **pre-existing** (bukan regresi merge), tapi layak diperiksa terpisah.

### 5.2 Screener Swing Konglo & Non-Konglo — 🟠 **STALE (bukan merge)**
```
STALE_SNAPSHOT: mode=swing-konglo snapshot=2026-09-30 expected=2026-10-05
                age_sessions=3 reason=STALE_SNAPSHOT
Kirim: dibatalkan (snapshot tidak fresh ... tidak ada pengiriman Telegram)
```
- Log terakhir **5 Okt**, artinya job ini **sudah tidak berjalan sejak 5 Okt** — jauh sebelum merge (18 Okt).
- Karena snapshot beku, **tidak bisa** membandingkan jumlah kandidat/skor 5 saham dengan Jumat 16 Okt.
- Format candle **tidak berubah** (sumber sama: `data/daily-candles/*.json`, skema `{date, open, high, low, close, volume}`) → merge tidak mengubah kontrak.

### 5.3 Insider `daily` (semua saham) — ✅ **kuota aman**
```
used_today      = 1.828
limit           = 18.080
remaining       = 16.252
EOD estimate    = 962 (All) + 833 (F) + 962 (Accum) + 962 (Insider) + 21 (candle) = 3.740
reserve 5.100   → TERCUKUPI (sisa 16.252 > 3.740)
```
Bahkan dengan `INSIDER_MODE=daily` untuk **seluruh 962 saham**, kebutuhan EOD ±3.740 request **jauh di bawah** sisa kuota. **Tidak ada risiko kuota habis sore ini.**

---

## 6. CI yang Gagal

### 6.1 `browser` — "Precision workspace regression"
- **Penyebab:** langkah `Run python tools/test-precision-app.py` gagal pada assertion:
  ```
  AssertionError: Portfolio keeps six primary tabs and scenarios out of the primary strip
  ```
  (`tools/test-precision-app.py:54`) — mengharapkan tepat **6** `[data-tab]` di `#portofolioPartialMount #tabStrip` dan `scenarios` hanya di `.pcc-subnav`.
- **Sejak kapan:** gagal di **semua PR sejak 17 Okt** (termasuk branch `feat/backtest-quant-lpm-intensity`, `feat/chart-workstation-lpm-intensity-v1`) — **bukan** akibat merge ini.
- **Dampak produksi:** **tidak ada** (ini gate CI, bukan runtime).

### 6.2 `Vercel` — "Account is blocked"
- Pesan: `Account is blocked.` (deployment diblokir di sisi akun Vercel).
- **Apakah Vercel masih dipakai produksi?** **TIDAK.** Bukti:
  - Crontab produksi 100% memakai path VPS (`/home/ubuntu/auto-cuan/...`).
  - `deploy/vps/final-schedule.cron` menegaskan "VPS LOCAL ONLY" untuk Sektor Hot.
  - Webhook Vercel **dinonaktifkan** (baris `# */10 ... run-webhook-failover.sh`), verifikasi bot pakai **long polling PM2**.
  - `base URL` semua job = `http://127.0.0.1:3000` (lokal).
- **Kesimpulan:** Vercel hanya **sisa lama**; kegagalannya tidak berdampak ke produksi.

---

## 7. Kesimpulan per Job + Usulan (diurutkan paling mendesak)

| Prioritas | Job | Status | Usulan (MENUNGGU PERSETUJUAN) |
|---|---|---|---|
| **1** | DayTrade producer | 🔴 mati 6 hari | Longgarkan `timeoutGuard` untuk heavy actions; kembalikan `status:'running'` + counter, bukan fallback kosong. **Dampak langsung ke sinyal live hari ini.** |
| **2** | Backfill candle 00:05 | 🟠 `universe:0` | Tambahkan `cd /home/ubuntu/auto-cuan &&` pada 5 baris cron `node tools/...` (atau pakai `path.join(__dirname,'..')` di `loadTickers`). **0 request terbuang saat ini, tapi tidak ada candle yang di-backfill.** |
| **3** | Backfill broksum | 🟠 halt 502 | Retry 2–3× backoff; bedakan label `HALTED_BY_PROVIDER_ERROR`; skip ticker gagal, lanjut task berikutnya. |
| **4** | Swing Konglo + Non-Konglo | 🟠 stale sejak 5 Okt | Perbaiki generator snapshot swing (job tidak pernah jalan). Sampai itu, broadcast swing tetap tidak terkirim. |
| **5** | J2 candle harian | 🟡 tanpa log | Pastikan wrapper `run-daily-candles.sh` menulis ke `daily-candles.log`; verifikasi jam 16:40 hari ini benar-benar jalan. |
| **6** | Nightly screener / Top 5 / Track Record | 🟡 ikut beku | Pulih otomatis setelah #1 diperbaiki (snapshot materialization butuh data DayTrade). |
| **7** | idx-suspension | 🟡 403 IDX | Ganti sumber/UA atau tambahkan retry; `fresh:false` sejak 24 Sep. |
| **8** | live-price BMTR | 🟡 stale | Bridge/SSH tidak tersedia untuk BMTR; periksa jalur bridge. |
| **9** | CI `browser` | ℹ️ pre-existing | Perbaiki selector `#portofolioPartialMount #tabStrip` (6 tab) di `tools/test-precision-app.py`. Tidak urgent untuk produksi. |
| **10** | CI `Vercel` | ℹ️ non-produksi | Abaikan atau nonaktifkan integrasi Vercel karena produksi full VPS. |

---

## 8. Batas Kepatuhan Tugas

- ✅ **0 request Arjum** — semua probe memakai endpoint lokal (`127.0.0.1:3000`) dan pembacaan file.
- ✅ **Tidak ada restart** PM2 (uptime `autocuan-web` tetap 42 mnt dari deploy sebelumnya).
- ✅ **Tidak ada perubahan** crontab, kode, `.env`, atau data.
- ✅ Tidak ada kredensial/IP/lokasi kunci SSH yang dicetak.
- Probe hanya **membaca**; `daytrade-screener-run` dipanggil **1×** untuk reproduksi (endpoint internal, bukan Arjum) — perilakunya sama dengan cron yang memang berjalan tiap 15 menit.

---

## 9. Lampiran — Perintah Reproduksi (read-only)

```bash
# 1. Gejala DayTrade
tail -n 20 /home/ubuntu/auto-cuan-runner/logs/daytrade-producer.log

# 2. Status scan sebenarnya (read-only)
node -e "const r=require('/home/ubuntu/auto-cuan/tools/run-all-screeners-vps');const e=r.loadEnvFiles();
r.makeClient(r.resolveBaseUrl(e),e.CRON_SECRET).call({action:'daytrade-screener'})
 .then(x=>console.log(x.status,x.meta&&x.meta.message));"

# 3. Backfill halt
grep -n 'BACKFILL-STOP\|Status:' /home/ubuntu/auto-cuan-runner/logs/backfill-broksum.log | tail -n 5

# 4. Backfill candle universe 0
cat /home/ubuntu/auto-cuan-runner/logs/backfill-candles.log | head -n 20

# 5. api/candles semua range
for r in 1y 2y 3y 5y max; do curl -s "http://127.0.0.1:3000/api/candles?ticker=BBCA&range=$r" | head -c 120; echo; done

# 6. Regime IHSG live
node -e "require('/home/ubuntu/auto-cuan/lib/market-regime').fetchIhsgDailyCandles()
 .then(c=>console.log(c.slice(-2)));"
```
