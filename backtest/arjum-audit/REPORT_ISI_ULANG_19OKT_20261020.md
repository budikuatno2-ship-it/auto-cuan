# REPORT — Isi Ulang 19 Okt, Akar 921/921, dan Penguatan Job Harian

**Tanggal:** Selasa, **20 Oktober 2026** (audit 08:00–13:10 WIB).
**VPS:** branch `feat/daytrade-screener-v1`, HEAD `011b116f` (merge PR #902) → `1b64c8de` (PR #903).
**Mode:** Bagian A read-only (0 request Arjum) · Bagian B perubahan kode (alur disetujui) · **Bagian C dijalankan dengan pagar anggaran** · Bagian D & E read-only.
**Tanpa kunci, IP VPS, atau lokasi kunci.** Semua angka dari keluaran nyata.

---

## 1. BAGIAN A — Akar penyebab 921/921

### A1. Jenis kegagalan
**Tidak ada jenis kegagalan yang tercatat.** J1 pada 19 Okt mencatat `Error / Gagal: 921` — angka belaka. Kode J1 pada saat itu hanya menambah `errorCount++` tanpa menulis status/jenis error ([`tools/run-daily-broker-update.js`](tools/run-daily-broker-update.js) cabang `else` sebelum B1). **Ini adalah temuan, bukan kelalaian data**: tanpa B1, akar 921/921 mustahil dibuktikan.

Bukti **sebelum** 19 Okt di window yang sama, dari `backfill-broksum.log`:
```
[BACKFILL-PROVIDER] FOREIGN SSIA 2026-01-12 transient error (status=502, error=The origin web server returned an invalid or incomplete response to Cloudflare. ...); consecutive5xx=1
[BACKFILL-PROVIDER] FOREIGN SSIA 2026-01-09 transient error (status=530, error=The host is configured as a Cloudflare Tunnel, but Cloudflare is currently unable to reach it.); consecutive5xx=2
[BACKFILL-HALT] 5 consecutive provider errors (>= 5). Provider appears down — stopping for this run.
Status: HALTED_BY_PROVIDER_ERROR   (Requests Sent: 1670)
```
→ **Arjum/Cloudflare memang sedang tidak sehat pada 19 Okt sore-malam** (502 origin overloaded, 530 tunnel unreachable). Independen dari mesin kita.

### A2. Lini waktu per menit job Arjum (19 Okt)
| Waktu WIB | Job | Aktivitas | Hasil |
|---|---|---|---|
| 16:30–17:45 | J1 | 8 pass (16:30,16:45,17:00,17:15,17:30,17:45) | marker 19 Okt: `done:0, errors:0, pending:962` — semua pass "Belum Terbit" (Arjum belum terbit) |
| 16:40:01–16:44:26 | J2 candle | cross-check **20/20 GAGAL** → mass fallback Arjum | `fetched 0, failed 943, stale 943`, **rc=0** (tidak ada alarm) |
| 19:30 | backfill broksum | 1.670 request | `HALTED_BY_PROVIDER_ERROR` (502/530 beruntun) |
| 23:30:01–23:31:37 | J2 candle (pass 2) | cross-check **20/20 OK** | `fetched 859 (yahoo 818), failed 83` — pulih sebagian |
| **23:30** | **J1 `--final`** | **921 request broker-summary, SEMUA GAGAL** | **`Status: GAGAL`, `errors 921`, 0 tersimpan** |

**Tumpang tindih:** J1 `--final` dan J2 pass-2 **keduanya mulai pada menit 23:30**, bersamaan dengan backfill 19:30 yang masih mungkin berjalan. Puncak(paralel) = **3 konsumen Arjum** (J1 + J2 + backfill), masing-masing dengan throttle 800 ms **per proses** → gabung ~375 req/menit ke satu host.

### A3. Pembatasan paralelisme & laju
| Aspek | J1 | J2 | Backfill |
|---|---|---|---|
| Throttle | 800 ms (lib/arjum-client.js, **per proses**) | 50 ms + fetch internal | 125 ms (8 req/s) |
| Retry | **tidak ada** untuk request gagal | tidak ada | 3× (2s/8s/30s) untuk 5xx |
| **Lock antar job** | **TIDAK ADA** | **TIDAK ADA** | lock sendiri saja |
| Pelayan sama | 1 vCPU, 5 proses PM2 | idem | idem |

`lib/arjum-client.js` membuat **antrian serial per proses** (`requestQueue`), tetapi **tidak ada koordinasi antar proses**. Induk masalah: **tidak ada pagar Arjum bersama**.

### A4. Perbandingan dengan hari baik (16 Okt)
| | 16 Okt (baik) | 19 Okt (rusak) |
|---|---|---|
| J1 | 2.628 req → **833 tersimpan**, 0 error | 921 req → **0 tersimpan**, 921 error |
| J2 | — | 16:40 `failed 943` (rc=0) → 23:30 `fetched 859` |
| Backfill | — | `HALTED_BY_PROVIDER_ERROR` (502/530) |
| Arjum | sehat | **502/530** |

### A5. Kesimpulan
**Penyebab paling mungkin: kegagalan hulu Arjum (502/530) pada jendela 18:00–23:30 WIB 19 Okt, diperparah oleh tidak adanya koordinasi antar job (J1/J2/backfill) sehingga tiga proses menembak Arjum bersamaan, dan diperparah lagi oleh tidak adanya pemutus sirkuit sehingga 921 + 943 request tetap dibakar saat penyedia sedang sakit.**

**Tingkat keyakinan: SEDANG-TINGGI** untuk "Arjum sedang sakit" (502/530 terbukti di log backfill pada window yang sama). **RENDAH-MENENGAH** untuk "paralelisme adalah pemicu" — hanya 2 bukti tumpang tindih, dan 502/530 bisa terjadi tanpa beban pun (Arjum/Cloudflare tunnel-nya sendiri yang bermasalah).

**Yang masih tidak diketahui:**
1. **Status/jenis persis** dari 921 kegagalan J1 (tidak pernah dicatat) → kini dapat diketahui (**B1** sudah aktif).
2. Berapa permintaan Arjum **benar-benar** menerima trafik bersamaan pada 23:30 (tidak ada access log Arjum di VPS).
3. Apakah Arjum memulih **sepenuhnya** setelah 23:30 — dari probe 20 Okt 12:24 (IHSG) Arjum **sudah sehat** (lihat Bagian C).

---

## 2. BAGIAN B — Penguatan job harian (satu commit per masalah, dengan test)

| # | Commit | Isi | Uji |
|---|---|---|---|
| **B1** | `b1db2c36` | `lib/arjum-failure-log.js` — klasifikasi tiap kegagalan (`rate_limited`/`provider_5xx`/`transport`/`auth`/`client_4xx`/`parse`/`unknown`) + ringkasan per run per jenis | `test/arjum-failure-log.test.js` (8 uji) |
| **B2** | `0cdf714b` | **Pemutus sirkuit di J1**: 20 pertama gagal semua **atau** >50% dari 50 pertama gagal → berhenti, tandai `GAGAL`, **exit code 5**, peringatan Admin Console + Telegram admin | `test/arjum-circuit-breaker.test.js` (3 uji) |
| **B3** | `1318acc1`, `1933335f` | **Pagar Arjum bersama** (J1/J2/backfill): file lock lintas proses, perebutan lock basi, *reentrant*, **hanya diambil pada fase request** (hari bursa tetap `MARKET_CLOSED`) | `test/arjum-shared-lock.test.js` (6 uji) |
| **B4** | `bd55a5f3` | **Cross-check gagal tidak memicu fallback massal** lagi; ditunda ke pass 23:30 (**exit code 6**), dengan override opt-in | `test/candle-crosscheck-defer.test.js` (2 uji) |
| **B5** | `c6bb724b` | **IHSG jadi langkah mandiri** (`tools/fetch-ihsg-candle.js` + `deploy/vps/run-ihsg-candle.sh` + cron 17:45/23:30): 1 request/hari, idempoten, **peringatan kalau bar hari bursa belum ada setelah 17:30 WIB** | `test/ihsg-standalone-fetch.test.js` (5 uji) |
| **B6** | `b4d37fd9`, `1b64c8de`, `6de639e6` | **Backfill mengalah**: reserve = **lantai** sisa kuota yang harus dijaga; nilainya = **permintaan job harian yang masih tertunda** (sesi hari ini + backlog H-1) × 4 per ticker + buffer retry 10%; **1 task gagal → skip & lanjut**, bukan halt total | `test/backfill-daily-job-priority.test.js` (7 uji) |
| **B7** | `9a5a397c` | **Hari hanya ditandai selesai bila datanya benar-benar ada di disk** (diverifikasi per ticker, bukan dari hitungan) | `test/daily-marker-integrity.test.js` (2 uji) |

**Pagar verifikasi:** `npm run test:full` → **All 716 test files passed successfully** (7 file uji baru didaftarkan di `tools/curated-build-tests.json`).

**PR & merge:**
| PR | Isi | Merge commit | Waktu |
|---|---|---|---|
| **#902** | B1–B7 (satu commit per masalah) | `011b116f` | 20 Okt 12:20 WIB |
| **#903** | perbaikan semantik reserve B6 (lantai kuota = permintaan harian yang masih tertunda) | `acbc401c` | 20 Okt 13:48 WIB |
| **#904** | laporan audit ini + `.gitignore` skrip audit lokal | `cb36ab95` | 20 Okt 14:03 WIB |

**Tidak ada merge ke `main`.** Keduanya ke `feat/daytrade-screener-v1`.

**Deploy ke VPS:** `git pull --ff-only` → HEAD **`acbc401c`**, **tanpa `pm2 restart`** (PR ini **tidak** menyentuh `api/` atau file server). Cadangan: `crontab.backup-before-job-harian-guard-20261020-122112.txt`, `state.json.bak-*`, `.env.bak-*`.

**Verifikasi deploy (dry-run backfill, 0 request Arjum):**
```
[BUDGET] Kebutuhan job harian yang masih tertunda: 7332 request; lantai kuota backfill: 8066
Mode:            WEEKDAY (Reserve Quota: 8066)
```
→ **lantai 8.066 > sisa 4.900** ⇒ backfill 19:30 **tidak bisa** memotong kuota J1 malam ini. (Sebelum diperbaiki, PR #902 masih memberi `Reserve Quota: 60` ⇒ backfill bisa menghabiskan seluruh hari.)

**Jalur kembali:**
```bash
cd /home/ubuntu/auto-cuan
git revert -m 1 --no-edit acbc401c        # PR #903
git revert -m 1 --no-edit 011b116f        # PR #902
# kembalikan crontab:
crontab /home/ubuntu/crontab.backup-before-job-harian-guard-20261020-122112.txt
```

**Status CI:** `browser` dan `Vercel` gagal — **pre-existing**, identik pada PR #900/#901 yang sudah merge (`AssertionError: Portfolio keeps six primary tabs…` dan `Account is blocked`). Semua gate lain (`unit`, `build-and-focused-tests`, `security-gate`, `command-login`, `database`, `portfolio-persistence`, `webkit-keyboard`, `Analyze JavaScript`, `CodeQL`) **lulus**.

---

## 3. BAGIAN C — Isi ulang 19 Okt dengan pagar anggaran

### C1. Perhitungan anggaran (ditulis sebelum eksekusi)
| Pos | Nilai |
|---|---|
| `ARJUM_DAILY_LIMIT` | 18.080 |
| Terpakai 20 Okt (backfill 00:07) | 12.980 |
| Sisa kotor | 5.100 |
| **Cadangan job harian (J1 + J2 + IHSG + retry 10%)** | **4.840** |
| **Sisa yang boleh dipakai refill** | **260** |

**Keputusan: refill 19 Okt HANYA memakai sisa 260; cadangan sore 4.840 tidak boleh disentuh sama sekali.** Total kebutuhan penuh (2.760–3.590) **melebihi** 260 → **dipecah**: hanya 50 saham likuid yang diisi sekarang; sisanya (871) dialirkan lewat antrean H-1 coordinator pada malam-malam berikutnya (masing-masing ≈ 3.484 request/hari, ≥ 2 malam).

### C2. Eksekusi (urutan, batch kecil, berhenti bila gagal >20%)
| Langkah | Aksi | Request | Hasil |
|---|---|---|---|
| 1 | **IHSG 19 Okt** (1 request — sekaligus uji kesehatan Arjum) | 1 | ✅ `fetched: true` → **IHSG 501 bar, bar terakhir 2026-10-19** (close 4.996,609). **Arjum sudah sehat** |
| 2 | **Broker summary ALL + F**, 50 saham likuid (batch kecil) | 100 | ✅ **50/50 ALL + 50/50 F** tertulis, `Error/Gagal: 0` |
| 3 | **Akumulasi + insider**, 50 saham yang sama | 100 | ✅ **50/50 + 50/50** tertulis (`end_date: 2026-10-19`; insider `no_new_insider_trades: true`) |
| 4 | **Candle 19 Okt**, 84 ticker tertinggal (Yahoo-first, `ARJUM_DAILY_LIMIT` proses dibatasi 60) | 2 | ✅ bar 19 Okt untuk 82 ticker; 1 (CNTX) tidak ada di Yahoo **dan** kehabisan kuota Arjum → tersisa |
| | **TOTAL** | **203** | |

**Kuota akhir 20 Okt: 13.180 (broker) + 2 (candle).** Cadangan sore utuh: 4.900 tersisa.

### C2b. Temuan kapasitas (ditemukan saat menghitung anggaran) — 19 Okt butuh ≥ 2 malam
Permintaan yang masih tertunda per 20 Okt: sesi 20 Okt sendiri (962 ALL + 834 F + 834 accum + 834 insider = **3.464**) **ditambah** backlog 19 Okt (871 ticker × 4 = **3.484**) = **7.332**, sedangkan sisa kuota hanya **4.900**. **Artinya backfill 19:30 dan J1 23:30 tidak mungkin dua-duanya prototypenya.**
Tindakan yang diambil: reserve floor backfill (B6/PR #903) kini **menghitung permintaan yang masih tertunda secara nyata** (bukan angka tetap 4.400). Diverifikasi di VPS (dry-run, 0 request): `Kebutuhan job harian yang masih tertunda: 7332 request; lantai kuota backfill: 8066` → **lantai 8.066 > sisa 4.900**, sehingga **backfill 19:30 tidak boleh memotong kuota J1**. J1 malam ini (16:30–23:30) memakai sisa 4.900 untuk sesi 20 Okt; backlog 19 Okt dilanjutkan pada malam-malam berikutnya (±3.484/malam, perlu **≥ 2 malam**).

### C3. Verifikasi
| Jenis | 19 Okt | 16 Okt (acuan) |
|---|---|---|
| broker-summary (ALL) | **50** | 833 |
| broker-summary-F | **50** | 135 |
| broker-accumulation | **50** | 833 |
| insiders | **50** | 833 |
| **candle dengan bar 2026-10-19** | **963 / 964** (hanya CNTX yang belum) | — |
| **IHSG** | **501 bar**, terakhir 2026-10-19 | 500 bar, terakhir 2026-10-16 |
| **10 saham uji paritas** (BBCA, BRPT, BBRI, MEDC, ADRO, BUMI, BMRI, TPIA, BBNI, TLKM) | **semua 5 stream berakhir 2026-10-19** ✅ | — |

### C4. Kebersihan marker (PENTING)
Marker 19 Okt dari run chunk sempat berisi `complete: true` untuk **universe 50 ticker**, dan `previousDateNeedsWork()` di coordinator **tidak** membandingkan `universe_hash` → 19 Okt akan **dihapus dari antrean H-1** dan 871 ticker sisanya tak akan pernah terisi. Perbaikan: marker ditulis ulang dengan `complete: false`, `total_tickers: 962`, `universe_hash` universe penuh, dan `no_trade_tickers` = **41 ticker yang di-BUKTIKAN ulang** dari candle 19 Okt (`volume == 0`, 41/41 terbukti) → **0 request Arjum** malam ini untuk 41 ticker itu. Marker lama **dipindah ke `_daily-update-marker/_quarantine/`** (tidak dihapus).

**Status akhir 19 Okt: `complete=false, done=50, pending=871, no_trade=41`.** 19 Okt tetap di antrean H-1.

---

## 4. BAGIAN D — Indeks turunan & harga live (read-only)

### D1. `bandarmologi-intel-indexes/` dan `broker-hunter-indexes/`
| Indeks | Dibuat oleh | Ada di crontab? | Terakhir berubah | Isi |
|---|---|---|---|---|
| `bandarmologi-intel-indexes/latest_*.json` (**dilayani publik**) | `tools/run-bandarmologi-intel.js` | **TIDAK** | **20 Okt 12:27** (diperbarui oleh refill J1) | `updated_at: 2026-10-19` ✅ |
| `broker-hunter-indexes/<KODE>_<range>.json` | `tools/run-broker-hunter-indexer.js` | **TIDAK** | **12 Sep 17:12** | payload hanya berisi tanggal **2026-09-07/08** → **basi ~5 minggu** |

**Usulan (belum dikerjakan):**
1. Tambahkan **satu baris cron** untuk `run-broker-hunter-indexer.js` (mis. 22:45, setelah J1/J2 selesai) — saat ini indeks ini **tidak pernah dibangun ulang** di VPS.
2. `bandarmologi-intel-indexes` **sudah** terperbarui hari ini (12:27) karena J1 memanggil `computeAndSaveIntel()` — jadi tidak perlu cron tambahan, tetapi perlu dipastikan tetap dipanggil setelah refill 19 Okt selesai.

### D2. `vps_local_cache_stale` — akar sebenarnya
**Pesan:** `bridge and SSH unavailable; serving an out-of-window local snapshot labelled vps_local_cache_stale`.
**Mekanisme (terbukti dari kode + pengukuran):**
1. `lib/vps-data-fetcher.js` mencoba **bridge HTTP** ke `http://127.0.0.1:3001/api/broker-summary?ticker=…&date=latest` dengan **menypawn satu child process Node per ticker** (`execFileSync(process.execPath, ['-e', …])`) dan **timeout 3.000 ms**.
2. Kalau bridge tidak mengembalikan payload broker yang valid, variabel modul `lastHttpBridgeFailure` di-set → **cooldown 60 detik yang bersifat GLOBAL (per proses, bukan per ticker)** → **semua ticker lain ikut kehilangan bridge selama 60 detik** (sampai `remaining`/file lokal basi dilayani apa adanya).
3. Cabang `else` tersebut **men-set cooldown tanpa menulis satu baris log pun** — itu sebabnya **0 baris** `http live-price` / `127.0.0.1:3001` di seluruh log, padahal ada **52.287** baris `vps_local_cache_stale`.
4. **Bukti bridge-nya sehat**: dari shell, `GET 127.0.0.1:3001/api/broker-summary` → **HTTP 200, 81 broker, `broker_date_max: 2026-10-19`**, waktu respons **185–206 ms**. Tidak ada `StrictHostKeyChecking=no` pada probe saya; bridge tidak butuh SSH sama sekali.
5. **Pola yang cocok dengan mekanisme di atas:** 19 Okt → 19 baris stale, hanya **2 ticker** (BMTR ×18 tiap 15 menit, LINK ×1) — BMTR/LINK punya `latest.json` 16 Okt (basi) jadi harus menyentuh bridge. 12 Okt → 4.170 baris stale untuk **205 ticker berbeda**, masing-masing ±22 baris — persis pola "satu ticker memicu timeout → **60 detik blackout global** → semua ticker berikutnya dilayani basi", berulang ~22 putaran.
6. **Hipotesis Akar (tingkat keyakinan: TINGGI untuk mekanismenya, SEDANG untuk pemicunya):** pada 1 vCPU yang dibebani (5 proses PM2 + 3 job Arjum bersamaan), **spawn child-process Node per ticker + timeout 3 detik terlampaui** → bridge dianggap gagal → cooldown global → semua ticker dengan file lokal basi dilayani snapshot basi. **Yang memicu timeout pertama TIDAK tercatat** — itulah inti temuannya (tanpa log, mustahil dibuktikan).

**Dampak ke pengguna:** harga "live" yang tampil adalah **VWAP hari bursa terakhir** (16 Okt), diberi label `vps_local_cache_stale` (jujur, bukan "live"). Tidak ada permintaan Arjum terbuang dari jalur ini.

**Usulan (belum dikerjakan):**
1. Naikkan timeout bridge 3.000 → **8.000 ms** (vps-api sudah terbukti 200 dalam ~200 ms; 3 detik terlalu ketat saat 1 vCPU sibuk).
2. **Per-cooldown per ticker**, bukan global (atau reset `lastHttpBridgeFailure` per ticker).
3. **Catat alasan kegagalan bridge** (wajib) — hari ini 0 baris log untuk 52 ribu kejadian.
4. Jalankan bridge **in-process** (port 3001 sudah lokal) alih-alih menypawn child process Node.

---

## 5. BAGIAN E — Google login (read-only; pemilik yang mengisi)

### E1. Alamat redirect & nama variabel
- **Alamat redirect yang dipakai kode** (alur **tautan akun**, bukan login):
  `https://autocuan.web.id/api/reset-password?action=account-google-link-callback`
  (di kode: `lib/google-oauth-service.js` → `buildAuthorizationUrl()`; endpoint pembangun: `POST /api/reset-password` body `action=account-google-link-url`; endpoint penerima: `action=account-google-link-callback`).
- **Origin publik:** `https://autocuan.web.id` (dari `server_name` nginx; `www.autocuan.web.id` juga sah).

| Variabel `.env` (nama saja) | Wajib untuk |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` (atau `GOOGLE_CLIENT_ID`) | **login** (popup GIS) **dan** tautan akun |
| `GOOGLE_OAUTH_CLIENT_SECRET` (atau `GOOGLE_CLIENT_SECRET`) | **hanya** alur tautan akun (code exchange) |
| `GOOGLE_OAUTH_REDIRECT_URI` (atau `GOOGLE_REDIRECT_URI`) | **hanya** alur tautan akun |

> **Penting:** login utama memakai **Google Identity Services** (`window.google.accounts.id.initialize({client_id, callback})`) — **popup, tanpa redirect URI**. Jadi untuk **membuka tombol "Masuk dengan Google"** cukup **Client ID** + mendaftarkan *Authorized JavaScript origin* `https://autocuan.web.id` di Google Cloud. `REDIRECT_URI` + `CLIENT_SECRET` baru dibutuhkan untuk **tautan akun**.

### E2. Alur pengguna baru → persetujuan admin
`POST /api/auth/google-register` → `app_users` dengan **`is_approved: false`**, `verification_code` dikirim → respons **`status: 'PENDING_VERIFICATION'`** + link bot Telegram. **Jadi pengguna baru masuk status menunggu persetujuan admin** (persetujuan lewat Admin Console), bukan langsung aktif.

### E3. Langkah pemilik
1. Google Cloud Console → **APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application**.
2. **Authorized JavaScript origins**: `https://autocuan.web.id` (dan `https://www.autocuan.web.id` bila dipakai).
3. **Authorized redirect URIs**: `https://autocuan.web.id/api/reset-password?action=account-google-link-callback` (untuk alur tautan akun).
4. Salin **Client ID** dan **Client Secret** ke `.env` VPS (nama variabel di tabel E1), lalu `pm2 restart autocuan-web --update-env` (sekali, di luar jam bursa).
5. Verifikasi: `GET /api/auth/google` harus **200** (bukan 503) dan popup GIS terbuka.

### E4. Hasil uji (menunggu pemilik mengisi)
**Saat ini (20 Okt 13:06 WIB): `GET /api/auth/google` → `503`** (Client ID belum diisi) dan `GET /api/reset-password?action=account-google-link-callback` → `302` (rute ada & hidup).
**Status: BELUM DIUJI** — menunggu pemilik mengisi `.env` dan menulis "OAuth sudah diisi". Setelah itu: 1 restart di luar jam bursa → uji `GET /api/auth/google` = **200** dan popup redirect ke `accounts.google.com` (bukan 503).

---

## 6. Ringkasan angka (tidak ada angka karangan)

| Item | Nilai |
|---|---|
| Data hilang 19 Okt (saat audit) | broker summary ALL/F, akumulasi, insider: **0 file** |
| File 19 Okt setelah refill | **50 / 50 / 50 / 50** (dari 833 / 135 / 833 / 833 pada 16 Okt) |
| Sisa 19 Okt | **871 ticker** (antrean H-1, ±3.484 request/malam) |
| Candle 19 Okt | **963 / 964** (CNTX belum) |
| IHSG | **501 bar**, terakhir 2026-10-19 |
| Request Arjum terpakai refill | **203** (1 IHSG + 100 ALL/F + 100 accum/insider + 2 candle) |
| Kuota 20 Okt | 13.180 / 18.080 → **sisa 4.900** (cadangan sore 4.840 utuh) |
| Lantai kuota backfill (setelah PR #903) | **8.066** > sisa 4.900 ⇒ backfill 19:30 **tidak** bisa memotong kuota J1 |
| Permintaan harian yang masih tertunda | **7.332** (sesi 20 Okt 3.464 + backlog 19 Okt 3.484) ⇒ perlu **≥ 2 malam** |
| Request terbuang 19 Okt (insiden) | **±1.884** (921 J1 + 943 candle + ~20 cross-check) |
| Baris `vps_local_cache_stale` | **52.287** (0 baris log penyebab) |
| Indeks `broker-hunter-indexes` | basi sejak **12 Sep** |
| Indeks `bandarmologi-intel-indexes` | **terbaru 20 Okt 12:27** (`updated_at: 2026-10-19`) |
| File untracked di VPS | 7 (termasuk `data/market.db` **0 byte**) |

---

## 7. Peringatan yang masih terbuka

> **[DARURAT] 19 Okt belum tuntas.** Terisi **50 / 50 / 50 / 50** (ALL / F / akumulasi / insider); **871 ticker masih kosong** (butuh ±3.484 request). Antrean H-1 **sudah dipulihkan** (marker `complete=false`, 41 NO_TRADE terbukti ulang dari candle 19 Okt). Kebutuhan tertunda = sesi 20 Okt (**3.464**) + backlog 19 Okt (**3.484**) = **7.332** vs sisa kuota **4.900** → **butuh ≥ 2 malam**. Malam ini J1 memproses sesi 20 Okt; backlog 19 Okt dialirkan ke malam-malam berikutnya. **Belum ada alarm kalau antrean ini macet** → usulan: alarm harian "umur backlog tertunda".

> **[DARURAT] `broker-hunter-indexes` tidak pernah dibangun ulang sejak 12 Sep** (tidak ada di crontab) → fitur Broker Hunter menampilkan data ~5 minggu lamanya. Usulan: 1 baris cron (22:45) + `tools/run-broker-hunter-indexer.js`.

> **[DARURAT] `lib/vps-data-fetcher.js` tidak mencatat alasan kegagalan bridge** → 52.287 kejadian tanpa bukti penyebab, padahal bridge-nya sendiri sehat (200 / 185–206 ms). Usulan: catat alasannya, naikkan timeout 3.000 → 8.000 ms, jadikan cooldown per-ticker, dan jalankan bridge **in-process** (port 3001 lokal) alih-alih spawn child process per ticker.

---

## 8. Lampiran

Perintah & skrip audit (semua read-only kecuali langkah C yang disetujui): [`backtest/arjum-audit/`](backtest/arjum-audit/)
— `roo_ssh.js` (SSH read-only, `BatchMode=yes`), `rcmd_*.sh` (probe VPS), `add_curated_tests.js`, `dbg_marker.js`, `grep_repo.js`, `grep_bridge.js`, `read_slice.js`, `ci_base_check.js`.

Laporan sebelumnya: [`REPORT_CEK_PIPELINE_ARJUM_20261019.md`](backtest/arjum-audit/REPORT_CEK_PIPELINE_ARJUM_20261019.md:1) · [`REPORT_KEAMANAN_20261020.md`](backtest/arjum-audit/REPORT_KEAMANAN_20261020.md:1)
