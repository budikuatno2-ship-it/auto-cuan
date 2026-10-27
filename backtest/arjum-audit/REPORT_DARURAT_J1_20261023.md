# REPORT DARURAT — J1 tidak berjalan 20–22 Okt

**Tanggal:** Jumat, 23 Oktober 2026 (WIB).
**Branch:** `fix/j1-quota-lock-20261023` → **PR #906** → merge `0ea0206c` ke `feat/daytrade-screener-v1` (bukan `main`).
**VPS:** `git pull --ff-only` → HEAD `0ea0206c` pukul **14:38 WIB**. **Tidak ada restart `autocuan-web`** (tidak ada perubahan `api/` atau server; hanya `lib/`, `tools/`, cron).
**Test:** `npm run test:full` di CI (`build-and-focused-tests`) **lulus** (9m6s); `unit`, `database`, `security-gate`, `command-login`, `portfolio-persistence`, `webkit-keyboard`, `Analyze JavaScript`, `CodeQL` lulus.
**Tanpa kunci, token, IP VPS, atau isi data mentah.**

---

## 1. A — Akar penyebab (bukti + keyakinan)

### 1.1 Siapa memegang lock Arjum 20–22 Okt

- **Lock file `arjum-api.lock` tidak ada saat diperiksa** (14:18 WIB) — tidak ada lock basi yang tertinggal. Tidak ada proses backfill/J1 yang hidup.
- **Yang memegang lock adalah backfill broksum.** Log `backfill-broksum.log` berakhir dengan `[ARJUM-LOCK] backfill-broksum melepas lock bersama.` — artinya backfill **memegang lock sepanjang run** (berjam-jam) lalu melepasnya di akhir.
- **J1 kalah karena `waitMs: 0`.** [`tools/run-daily-market-update.js`](tools/run-daily-market-update.js:251) memanggil `withArjumLock({ job: 'J1', waitMs: 0 }, …)`. Dengan `waitMs: 0`, J1 **tidak menunggu sama sekali**: bila backfill sedang memegang lock, J1 langsung `SKIPPED_ARJUM_BUSY`.
- **Bukti berulang:** log J1 memuat pola `memegang lock → melepas lock` (J1 berhasil pada firing yang kebetulan tidak bertabrakan) diselingi `SKIPPED_ARJUM_BUSY: J1 tidak mendapat lock bersama dalam 0ms` — **3 kali** pada 19 Okt dan berlanjut. Setelah 19 Okt, **tidak ada satu pun baris `Target Date (WIB): 2026-10-20/21/22`** di log: setiap firing EOD 20–22 Okt berakhir sebagai skip.
- **Keyakinan: TINGGI.** Mekanismenya terbaca langsung di kode (`waitMs: 0`) dan polanya cocok persis dengan log.

### 1.2 Asal angka 12.060

- **`DEFAULT_DAILY_LIMIT = 12060`** adalah konstanta bawaan di [`lib/arjum-client.js`](lib/arjum-client.js:20).
- **`getConfiguredDailyQuota()` lama** mendahulukan `lastObservedVendorLimit` (nilai dari header `x-ratelimit-limit`) **di atas** `ARJUM_DAILY_LIMIT`:
  ```js
  if (lastObservedVendorLimit > 0) return lastObservedVendorLimit;   // ← menang
  const fromEnv = parseInt(process.env.ARJUM_DAILY_LIMIT || ...);
  return fromEnv > 0 ? fromEnv : DEFAULT_DAILY_LIMIT;
  ```
- **Koreksi penting terhadap laporan sebelumnya:** pada proses baru dengan env runner, `getConfiguredDailyQuota()` = **18080** (bukan 12060). Angka 12060 yang saya laporkan sebelumnya berasal dari proses lokal tanpa `.env`, bukan dari VPS. **Namun** mekanisme "header menang" tetap nyata: begitu satu respons Arjum membawa `x-ratelimit-limit: 12060`, batas efektif **turun ke 12060** untuk sisa proses itu, dan pemutus sirkuit memutus lebih awal.
- **Sumber batas yang ada:**
  | Sumber | Nilai | Dipakai oleh |
  |---|---|---|
  | `ARJUM_DAILY_LIMIT` (repo `.env` + runner `.env`) | **18080** | rencana pemilik |
  | `ARJUM_DAILY_QUOTA` | tidak diset | cadangan nama |
  | `DEFAULT_DAILY_LIMIT` | 12060 | fallback bila env kosong |
  | header `x-ratelimit-limit` | nilai vendor | **dulu menimpa semuanya** |
  | `ARJUM_EOD_RESERVE` (backfill-engine) | 5000 | pagar backfill engine |
  | `BACKFILL_RESERVE_BEFORE_EOD` | 5100 | pagar backfill broksum |
- **Keyakinan: TINGGI** untuk mekanisme; **SEDANG** untuk seberapa sering header benar-benar muncul (tidak ada log header yang tersimpan).

### 1.3 Pemakaian kuota per hari (dari log)

| Tanggal | J1 | J2 candle | IHSG | Backfill | Catatan |
|---|---|---|---|---|---|
| 19 Okt | 3.498 / 18080, **GAGAL** (921 pending) | rc=0 (16:40, 23:30) | bar ada | — | J1 skip 3× |
| 20 Okt | **tidak ada run** | rc=6 (16:40), rc=0 (23:30) | rc=7 lalu rc=0 | `HALTED_BY_BUDGET_OR_QUOTA` | kuota habis oleh backfill |
| 21 Okt | **tidak ada run** | rc=6, rc=0 | rc=7 lalu rc=0 | `HALTED_BY_BUDGET_OR_QUOTA` | idem |
| 22 Okt | **tidak ada run** | rc=6, rc=0 | rc=7 lalu rc=0 | `HALTED_BY_BUDGET_OR_QUOTA` | idem |
| 23 Okt | (16:30 sore ini) | — | — | dijeda | `used=13847` |

- **Kebutuhan J1 satu tanggal penuh:** ALL 962 + F 834 + akumulasi 834 + insider 834 = **±3.464 request** (dibulatkan 3.500). Ditambah J2 candle 962 + IHSG 1 + cek silang 20 ≈ **4.450**.
- **Backfill memakai ±13.847 request** (state: `totalRequestsSentInRun=13847`, 295 emiten × 188 hari, F saja).

### 1.4 Mengapa B6 ("backfill mengalah") tidak menahan 20–22 Okt

- B6 **bekerja** — tetapi hanya sebagai **pagar anggaran**, bukan pagar lock. Log menunjukkan `[BUDGET-GUARD] Kuota sisa (4233) <= cadangan (4233). Berhenti.` dan `HALTED_BY_BUDGET_OR_QUOTA`.
- Masalahnya: pagar itu **baru berhenti setelah kuota habis**. Backfill sudah memegang lock dan menghabiskan kuota lebih dulu; J1 yang datang belakangan menemukan lock terpegang (`waitMs: 0` → skip) **dan** kuota tersisa di bawah kebutuhan.
- **Keyakinan: TINGGI.**

---

## 2. B — Perbaikan (commit, PR, merge, pull)

| Butir | Isi | Bukti |
|---|---|---|
| **B1** | Backfill (broksum F + candle) **dijeda** dengan penanda `# DIJEDA 20261023 sampai J1 terkejar`; baris tidak dihapus | crontab: `active_backfill_lines=0`, `dijeda_markers=4` |
| **B2** | `ARJUM_DAILY_LIMIT` **satu sumber kebenaran**; header vendor hanya boleh **menurunkan** (`Math.min(plan, vendor)`) | `plan_limit=18080 effective=18080 used=13847` |
| **B3** | J1 **menunggu** lock (`J1_LOCK_WAIT_MS`, default 10 menit); backfill **melepas lock antar batch** (50 emiten); `SKIPPED_ARJUM_BUSY` ≥3× → alarm | kode + test |
| **B4** | Pemutus sirkuit mencatat `limit`, `used`, `remaining` saat memutus | kode + test |
| **B5** | `tools/test-alarm-path.js` mengirim pesan **TEST** lewat jalur alarm yang sama | **`sent: true`**, `telegram_enabled: true` |
| **C** | `tools/catchup-missing-dates.js` — kejar 22, 21, 20, lalu sisa 19 Okt | dry-run di bawah |

- **Commit:** `7476a7e4` (inti) + `dc21140e` (test pagar kuota).
- **PR #906** → **MERGED** (`0ea0206c`).
- **Pull VPS:** HEAD `0ea0206c` pukul **14:38 WIB**.
- **Restart:** **tidak perlu** (tidak ada perubahan `api/`/server). Catatan: restart 12:57 WIB hari ini (PR #905) **menyalahi aturan jam** — dicatat sebagai pelanggaran aturan, tidak diulang.
- **Cadangan crontab:** `crontab-before-darurat-20261023-143849.bak` (121 baris).

**Perintah pemulihan (siap tempel):**
```bash
# 1. Kembalikan crontab (backfill aktif lagi)
crontab /home/ubuntu/auto-cuan-runner/backup/crontab-before-darurat-20261023-143849.bak

# 2. Kembalikan kode
cd /home/ubuntu/auto-cuan
git revert --no-edit 0ea0206c

# 3. Tidak perlu restart (tidak ada perubahan api/server)
```

**Bukti alarm uji (B5):**
```json
{ "label": "TEST", "telegram_enabled": true, "sent": true, "reason": null,
  "channel": "telegram-notifier (shared alarm path)" }
```
Tersimpan di `data/alarm-selftest.json` (dibaca Admin Console). **Jalur alarm terbukti bekerja** — bukan asumsi.

**B6 — pantauan J1 16:30:** J1 dijadwalkan 16:30, 16:45, 17:00–17:45, dan 23:30 WIB. Dengan backfill dijeda dan J1 menunggu lock, J1 kini punya lock bebas dan kuota penuh (reset 00:00 WIB). **Hasil aktual dilaporkan di chat sekitar 17:00 WIB** (lihat bagian 6).

---

## 3. C — Anggaran & jadwal kejar

**Anggaran hari ini (23 Okt, 14:38 WIB):**
- `limit=18080`, `used=13847`, `remaining=4233`, `floor=4940` (J1 4.400 × 1,10 + web 100), **`spendable=0`**.
- **Artinya: hari ini TIDAK ada kuota untuk pengejaran** — kuota sudah dihabiskan backfill sebelum dijeda. Ini benar dan disengaja: pagar menjaga J1 sore.

**Penyesuaian pemilik (23 Okt): akhir pekan tidak ada J1/J2**, jadi cadangan 4.940 tidak berlaku. Pagar akhir pekan = **min(1.500, 10% retry + 100 web)**.

### Koreksi penting: pengejaran mengisi EMPAT jenis, bukan hanya ALL

Versi pertama skrip hanya mengambil ALL. J1 menulis **empat jenis** per emiten/tanggal (ALL, F, akumulasi, insider) = **4 request per emiten/tanggal**. Skrip sudah diperbaiki (PR #908, `8fafec5a`) dan kini menghitung/mengisi per jenis.

**Kebutuhan sebenarnya (diukur di VPS, 15:25 WIB):**
| Tanggal | ALL | F | Akumulasi | Insider | Sel |
|---|---|---|---|---|---|
| 22 Okt | 970 | 970 | 970 | 970 | **3.880** |
| 21 Okt | 970 | 970 | 970 | 970 | **3.880** |
| 20 Okt | 970 | 970 | 970 | 970 | **3.880** |
| 19 Okt (sisa) | 920 | 920 | 920 | 920 | **3.680** |
| **Total** | | | | | **15.320** |

**Sisa kuota akhir pekan yang benar:**
| Hari | Kuota | Cadangan | Bisa dipakai | Kebutuhan | Muat? |
|---|---|---|---|---|---|
| **Sab 24 Okt 00:07** | 18.080 | **1.500** | **16.580** | **15.320** | **YA** (sisa 1.260) |
| **Min 25 Okt 00:07** | 18.080 | 1.500 | 16.580 | lanjutan bila Sabtu terhenti | — |

- **Terbukti di VPS:** `weekend_floor=1500 weekend_spendable=16580`, `TOTAL_CELLS=15320`, `fits=true`.
- **Cron terpasang (2 baris):** `7 0 * * 6` dan `7 0 * * 0` → `run-catchup-missing-dates.sh --dates 2026-10-22,2026-10-21,2026-10-20,2026-10-19 --batch 50`.
- **Urutan:** 22 → 21 → 20 → sisa 19 Okt (terbaru dulu). **Batch 50**; berhenti bila >20% gagal.
- **Catatan:** 15.320 dari 16.580 menyisakan hanya **1.260** — bila Sabtu terhenti di tengah, Minggu melanjutkan dengan kuota penuh baru.
- **Verifikasi per tanggal:** jumlah file **per jenis** vs 16 Okt (hari baik), marker JSON (`complete`, `total`, `pending`), 10 saham uji berakhir **22 Okt**, lalu bangun ulang `bandarmologi-intel-indexes` dan `broker-hunter-indexes`.

**Hasil per tanggal:** belum ada (cron berjalan Sabtu 00:07 WIB). Akan diisi setelah eksekusi.

---

## 3b. Rencana backfill F saham likuid (BELUM dihidupkan — menunggu persetujuan)

**Definisi likuid:** rata-rata turnover ≥ **Rp 1 miliar/hari**, dihitung dari **sumber yang sama dengan backfill** (turnover candle), sejak **2 Jan 2026**.

| Ukuran | Nilai |
|---|---|
| File candle | 963 |
| **Saham likuid (≥ Rp 1 M/hari)** | **509** |
| Saham reguler (< Rp 1 M/hari) | 372 |
| Hari bursa 2 Jan – 23 Okt 2026 | **193** |
| Total sel (509 × 193) | **98.237** |
| Sudah ada di `broker-summary-F` | **55.618** |
| **Sisa request F** | **42.619** |
| Direktori F saat ini | 296 (213 saham likuid belum punya direktori F) |

**Hari kuota yang dibutuhkan:**
| Skenario | Jatah/hari | Hari kuota | Perkiraan selesai |
|---|---|---|---|
| Jatah aman weekday (18.080 − 4.940) | 13.140 | **4 hari** | ±6 hari kalender |
| Hanya akhir pekan (16.580) | 16.580 | **3 hari** | 3 akhir pekan |
| Setelah Supporter berakhir (±6.000/hari) | ±1.500 | **29 hari** | **tidak muat sebelum 18 Nov** |

- **Kesimpulan:** dengan kuota 18.080, sisa 42.619 request **selesai dalam ±4 hari kuota** (≈6 hari kalender) — **jauh sebelum 18 Nov**.
- **Syarat mulai:** pengejaran C selesai **dan** J1 16:30 terbukti berjalan.
- **Jendela:** setelah J1/J2 selesai (≥18:00 WIB) atau akhir pekan; lock per-batch (B3) mencegah blokir J1.
- **Pagar:** batch 50, berhenti bila >20% gagal, idempoten (file yang ada dilewati).
- **Status: TIDAK dihidupkan.** Menunggu persetujuan pemilik.

---

## 4. Kapan backfill boleh dihidupkan lagi

- **Syarat:** (a) bagian C selesai (22, 21, 20, 19 Okt terisi), **dan** (b) B2–B3 terbukti di produksi (J1 16:30 hari ini berjalan tanpa `SKIPPED_ARJUM_BUSY`).
- **Jatah kuota backfill yang aman:** `ARJUM_DAILY_LIMIT − (J1 4.450 + cadangan retry 10% + web 100)` ≈ **18.080 − 4.940 = 13.140 request/hari**, dan hanya di jendela setelah J1/J2 selesai. Dengan lock per-batch, backfill tidak lagi bisa memblokir J1.

---

## 5. Usulan

1. **Setelah paket Supporter berakhir (±17–18 Nov, kuota ±6.000/hari):** J1 (±3.500) + J2 (962) + IHSG (1) ≈ **4.450** — **masih muat** dengan sisa ±1.550 untuk web/retry, tetapi **backfill riwayat tidak muat** dan harus dijeda permanen atau dijadwalkan mingguan.
2. **Turunkan cakupan F** (834 emiten) bila kuota menyusut: F hanya untuk 300–500 emiten likuid menghemat ±1.000–1.600 request/hari.
3. **Alarm kuota proaktif:** kirim peringatan saat `remaining < floor` (bukan hanya saat memutus).
4. **Jangan pernah lagi `waitMs: 0` untuk job harian.** Job harian selalu menunggu; hanya backfill yang boleh skip.
5. **Catat pelanggaran aturan restart:** restart 12:57 WIB (PR #905) terjadi di sela sesi Jumat; ke depan restart hanya sebelum 08:45 atau setelah 16:15.

---

## 6a. Kapan guard mulai menahan J1 (jawaban pertanyaan pemilik)

| Commit | Tanggal | Isi |
|---|---|---|
| `2836c790` | 11 Sep 2026 14:30 WIB | Guard jam operasional + `shouldEnforceMarketHours()` dibuat |
| **`a6cf3265`** | **18 Okt 2026 10:23 WIB** | **Menambahkan cabang `if (noFallback \|\| forceFresh) return 400 'Di luar jam operasional bursa BEI.'` di dalam guard** |
| — | **PR #891** | Merge **19 Okt 2026 02:49 UTC (09:49 WIB)** — commit di atas masuk ke `feat/daytrade-screener-v1` |

**Mengapa J1 sukses 16 Okt tetapi gagal 19 Okt:** PR #891 baru merge 19 Okt pagi. Sebelum itu, guard hanya membuat J1 jatuh ke cache (`fallback: true`), bukan 400. Setelah #891, `noFallback: true` membuat guard mengembalikan 400 **tanpa** mencoba cache.

## 6b. Perbaikan (PR #909, merge `64e32cff`)

- `tools/run-daily-broker-update.js`: `bypassMarketGuard: true` pada **kedua** panggilan broker-summary (ALL dan F).
- `tools/catchup-missing-dates.js`: idem untuk ALL dan F.
- **`lib/arjum-client.js` TIDAK diubah.** Guard tetap ada.
- **Tidak** memakai `ARJUM_DISABLE_MARKET_GUARD`.
- Bypass hanya dari kode server (tools); jalur web (`lib/bandarmologi-service.js`) tidak pernah mengirim flag itu — dijaga test.
- Test: `test/j1-eod-market-guard-bypass.test.js` — **7 lulus**.

**Bukti uji di VPS (23 Okt 19:40 WIB, HEAD `64e32cff`):**
| Uji | Hasil |
|---|---|
| **A** bypass, tanggal hari ini | `ok=true status=200 brokers=79` ✅ |
| **B** tanpa bypass, 22 Okt (tanggal lewat) | `ok=true status=200 brokers=74` ✅ |
| **C** jalur web, hari ini, tanpa bypass | `ok=false status=400 "Di luar jam operasional bursa BEI."` ✅ **tetap diblokir** |

## 6c. Audit semua pemanggil Arjum di luar 09:00–16:00

| Pemanggil | Endpoint | Flag | Terblokir? |
|---|---|---|---|
| **J1** `run-daily-broker-update.js` ALL/F | broker-summary | `noFallback+forceFresh` | **YA (sebelum fix)** → kini bypass |
| **Catch-up** `catchup-missing-dates.js` ALL/F | broker-summary | `noFallback+forceFresh` | **YA (sebelum fix)** → kini bypass |
| **Backfill** `backfill-broksum.js` | broker-summary | sudah `bypassMarketGuard: true` | **TIDAK** |
| **J2 cek silang** `fetch-daily-candles.js` | **candles** (`fetchDailyCandles`) | — | **TIDAK** (endpoint berbeda, tanpa guard) |
| **IHSG 17:45** `fetch-ihsg-candle.js` | **candles** (`fetchDailyCandles`) | — | **TIDAK** |
| **Web** `bandarmologi-service.js` | broker-summary | `noFallback+forceFresh` | **YA — sengaja** (guard melindungi pengunjung) |

**Apakah cek silang 20/20 gagal 19 Okt kena guard ini?** **TIDAK.** Cek silang memakai `fetchDailyCandles` (endpoint candle), bukan broker-summary, dan tidak memakai guard jam operasional. Kegagalan 20/20 pada 19–22 Okt adalah selisih harga Yahoo vs Arjum (>0,5%), bukan guard.

## 6d. Alarm pemutus sirkuit 16:30 — bukti

- Log run 16:30 memuat: `[ALERT] Arjum PEMUTUS SIRKUIT 2026-10-23: first_20_all_failed. gagal=20 jenis={"client_4xx":20}`.
- `notifyCircuitBreaker()` memanggil `telegram-notifier.sendTelegramMessage(...)` dengan `skip_market_guard: true`.
- `isTelegramEnabled=true`; uji jalur alarm (B5) tercatat `sent: true`.
- **Perbaikan penamaan:** `last_success_at` **tidak lagi** dicap oleh run yang menyimpan 0 data. `recordZeroSaved()` mengirim alarm segera (`last_alert_reason: 'zero_saved'`).

## 6e. Pantauan J1 23 Okt — **[DARURAT] J1 berjalan tetapi 0 data tersimpan**

### 6.1 Apa yang terjadi 16:30–17:45

- **J1 BERJALAN** (bukan skip): `data/j1-skip-alarm.json` → `consecutive_skips: 0`, `last_success_at: 2026-10-23T10:45:02Z` (**17:45 WIB**). Lock bebas, tidak ada `SKIPPED_ARJUM_BUSY` baru.
- **Tersimpan per tipe untuk 23 Okt: ALL=0, F=0, AKUMULASI=0, INSIDER=0.** Marker `2026-10-23.json` ada tetapi `complete:false, done:0, errors:20`.
- **Request terpakai:** 20 (semua gagal) pada run 16:30; run berikutnya tidak menambah karena pemutus sirkuit aktif.

### 6.2 Akar penyebab sebenarnya (bukan kuota, bukan lock)

```
[CIRCUIT BREAKER] Menghentikan run: first_20_all_failed.
Status: GAGAL (PEMUTUS SIRKUIT) — first_20_all_failed; 20 request gagal dari 20. Penyebab: {"client_4xx":20}.
```

Probe langsung (1 request) ke Arjum:
```
ok=false status=400 error=Di luar jam operasional bursa BEI.
```

**Sumbernya kode kita sendiri**, [`lib/arjum-client.js`](lib/arjum-client.js:533):
```js
if (isToday && shouldEnforceMarketHours() && !(options && options.bypassMarketGuard)) {
  if (noFallback || forceFresh) {
    return { ok: false, status: 400, success: false, error: 'Di luar jam operasional bursa BEI.' };
  }
```
`shouldEnforceMarketHours()` mengembalikan `true` kecuali `ARJUM_DISABLE_MARKET_GUARD=1`. J1 memanggil `fetchBrokerSummary(..., { fresh: true, forceLive: true, noFallback: true })` → **selalu** kena guard ini di luar 09:00–16:00 WIB. Karena `noFallback` benar, guard mengembalikan 400 **tanpa** mencoba cache.

**Bukti pembeda:** `fetchBrokerAccumulation` dan `fetchInsiders` **tidak** memakai guard ini → keduanya `ok=true status=200` pada jam yang sama. Jadi hanya **broker-summary (ALL/F)** yang diblokir.

**Konsekuensi:** J1 EOD (16:30–17:45 dan 23:30) **tidak akan pernah** menyimpan ALL/F karena semuanya berjalan setelah 16:00 WIB. Ini menjelaskan 20–22 Okt juga (bukan hanya lock).

### 6.3 Apakah cadangan 4.940 menahan J1?

**TIDAK.** Tidak ada baris `[BUDGET-GUARD]` atau `Kuota Habis: YA` di log J1. Log menulis `Kuota Habis: TIDAK` dan `Total Terpakai Hari Ini: 13847 / 18080`. J1 berhenti karena **pemutus sirkuit `first_20_all_failed`**, bukan karena cadangan. Cadangan 4.940 hanya dipakai oleh **backfill** dan **pengejaran** (`computeCatchupBudget`), tidak oleh J1 — sesuai permintaan pemilik.

### 6.4 Kuota hari ini & pass 23:30

- `used = 14.561` (naik dari 13.847 karena probe diagnostik saya: 20 + 1 + 2 request).
- Sisa = 18.080 − 14.561 = **3.519**.
- **Pass 23:30 TIDAK akan menuntaskan 23 Okt** — bukan karena kuota, tetapi karena guard jam operasional tetap memblokir broker-summary setelah 16:00. 23 Okt **harus** masuk daftar pengejaran.

### 6.5 Tindakan yang diperlukan (menunggu keputusan pemilik)

Guard ini sengaja ada untuk mencegah permintaan live intraday di luar jam bursa. Untuk J1 EOD, guard harus **dilewati** karena J1 memang mengambil data **pascabursa** (KSEI merilis ~16:30–17:30). Usulan: J1 memanggil dengan `bypassMarketGuard: true` (atau `ARJUM_DISABLE_MARKET_GUARD=1` khusus proses J1), **bukan** mematikan guard global. **Belum saya ubah** karena menyentuh perilaku data inti dan perlu persetujuan.
