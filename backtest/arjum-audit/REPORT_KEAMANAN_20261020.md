# Laporan Keamanan — /data/* terbuka & login tanpa batas percobaan

**Tanggal:** 20 Okt 2026 (WIB)
**Branch:** `fix/security-data-login` → PR #901 → merge ke `feat/daytrade-screener-v1`
**Deploy:** VPS, `pm2 restart autocuan-web` **satu kali** pada **2026-10-20 02:11:52 WIB**
**Catatan:** Laporan ini tidak memuat kunci, token, IP VPS, atau isi file data.

---

## 1. Hasil A1–A4

### A1 — Aturan `/data/` sebelum perbaikan
- `tools/local-dev-server.js` memakai `serveData = createStaticResponder({ rootDir: DATA_DIR, maxBytes: 2MB })` **tanpa allowlist dan tanpa pemeriksaan sesi**. Setiap file di bawah `data/` (screener premium, broker summary mentah, seluruh tree ±7,9 GB) dapat diunduh siapa saja; file >2 MB bahkan ter-potong.
- Nginx (`deploy/nginx/autocuan`) **tidak punya blok `/data/`**, jadi `/data/*` jatuh ke origin (127.0.0.1:3000) tanpa gate tambahan.
- Kode status 3 jalur contoh (origin, sebelum perbaikan):
  - `latest_7d.json` (indeks bandarmologi) → **200**
  - `daily-candles/<TICKER>.json` (candle) → **200**
  - `broker-hunter-indexes/<KODE>-7d.json` (broker summary) → **200**
  - kontrol `__does_not_exist*.json` → 404 (untuk membedakan 404-karena-tidak-ada)

### A2 — Pemakai sah `/data/` dan allowlist final
- Satu-satunya pembaca `/data/` **lewat HTTP tanpa sesi** adalah frontend:
  `public/bandarmologi-runtime.js` → `GET /data/bandarmologi-intel-indexes/latest_<range>.json`
  (fallback statis untuk scanner "Sinyal Intelijen Bandarmologi").
- `lib/bandarmologi-intel-service.js` membaca folder indeks yang sama **dari disk** (server-side), bukan lewat `/data/*` HTTP — tidak terpengaruh.
- Bot Telegram, skrip, dan layanan lain tidak ada yang membaca `/data/` lewat HTTP.
- **Allowlist final (minimum & aman):** hanya
  `bandarmologi-intel-indexes/latest_<range>.json` (`<range>` ∈ {1d,5d,7d,14d,30d,60d}).
  Tidak ada pemakai sah lain yang perlu ditambahkan.

### A3 — Permintaan `/data/` 7 hari terakhir (hanya hitungan & pola)
Sumber: `/var/log/nginx/autocuan_access.log*` (12–19 Okt). Hanya jalur dan jumlah; tanpa IP.

| Tanggal | total | legit | non-legit |
|---|---|---|---|
| 12 Okt | 1 | 0 | 1 |
| 14 Okt | 3 | 0 | 3 |
| 15 Okt | 4 | 4 | 0 |
| 16 Okt | 4 | 1 | 3 |
| 17 Okt | 1 | 0 | 1 |
| 19 Okt | 2 | 0 | 2 |

- **Total 15 permintaan**: 5 legit (`latest_*`), **10 non-legit** pada **6 jalur berbeda**.
- Jalur non-legit (pola scanner otomatis, bukan pengunduhan data):
  `/data/.git/config` (4), `/data/.env` (2), `/data/%2eenv` (1),
  `/data/config%2einc%2ephp%2ebak` (1), `/data/screener-latest.json` (1),
  `/data/arjum-data/broker-summary/BBCA/latest.json` (1).
- **Kesimpulan: tidak ada indikasi pengunduhan massal.** Permintaan berupa probe file sensitif/umum (`.env`, `.git`), bukan enumerasi/unduhan data premium berukuran besar.

### A4 — `/api/login-user` dan `SECURITY_GUARD_MODE`
- Mode guard default di produksi = `enforce` (saat `SECURITY_GUARD_MODE` kosong). Namun guard **butuh `SECURITY_EVENT_PEPPER`** untuk hashing; pepper **tidak diisi**. Tanpa pepper, `context.ready=false` → guard bersifat **fail-open**. Untuk non-admin: tidak ada blokir. Untuk admin: fail-closed hanya bila pepper ada (pepper tidak ada → tetap fail-open).
- reCAPTCHA: `RECAPTCHA_SECRET_KEY` **tidak diisi** → `verifyRecaptcha` **fail-open** (selalu ok).
- Bukti produksi (kredensial sampah, hanya kode status): `normal=400`, `budi=400`, `review=400`, dan **8 percobaan gagal berturut-turut = 400** (tanpa 429) → **tidak ada batas percobaan yang efektif**.
- Tidak ada batas per akun/IP yang tidak bergantung reCAPTCHA.
- Risiko mengaktifkan guard (`enforce` + pepper) tanpa controlling: bila skema Supabase `security_login_*` belum ada / pepper salah, admin bisa terkunci (503) karena `shouldFailClosedAdmin` default true di produksi. Karena itu perbaikan B2 tidak bergantung pada guard.

---

## 2. PR, commit, merge, dan deploy

- **PR:** https://github.com/budikuatno2-ship-it/auto-cuan/pull/901 (base `feat/daytrade-screener-v1`)
- **Commit (satu masalah = satu commit, dengan test):**
  - B1: `89b43eba` — `fix(security): default-deny /data/* static route (B1)`
  - B2: `7886587d` — `fix(security): in-app login attempt throttle with backoff (B2)`
- **Merge commit:** `c7e2b46d` (merged 2026-10-19T19:10:56Z = 02:10:56 WIB).
- **Deploy VPS:** branch `feat/daytrade-screener-v1`, `git pull --ff-only` (0 ahead / 12 behind → fast-forward) `672a7557 → c7e2b46d`.
- **Restart:** `pm2 restart autocuan-web --update-env` **satu kali** pada **2026-10-20 02:11:52 WIB** (PID 40491 → 68505). Restart ini **menggabungkan** deploy DayTrade yang belum jalan + perbaikan keamanan, sesuai instruksi (hanya 1 restart, sebelum 08:45, di luar jam bursa).
- **Tidak** merge ke `main`. **Tidak** checkout branch lain di VPS. **0 request Arjum.**

---

## 3. Cek sesudah deploy

- Health origin: `GET /register.html` → **200**.
- `/data/*` (origin, sesudah perbaikan):
  - indeks `latest_7d.json` → **200**
  - candle `daily-candles/<TICKER>.json` → **404**
  - broker summary `broker-hunter-indexes/<KODE>-7d.json` → **404**
  - jalur tak ada → 404 (seragam, tidak membocorkan keberadaan file)
- Halaman Bandarmologi tetap memuat: `/analisis-saham.html` → **200**, `/bandarmologi` → **302** (redirect default tab bandarmologi).
- B2 di produksi (username sekali-pakai, kredensial sampah): `400 400 400 400 400 429` → throttle aktif pada percobaan ke-6. Store `/tmp/autocuan-login-throttle.sqlite` dibuat (tahan restart).
- `npm run test:full` lokal: **All 709 test files passed successfully!**

---

## 4. Jalur kembali (siap tempel, di VPS)

```bash
cd /home/ubuntu/auto-cuan

# Opsi A (disarankan) - revert hanya merge keamanan, DayTrade tetap:
git revert -m 1 --no-edit c7e2b46d
pm2 restart autocuan-web --update-env

# Opsi B - revert per perubahan:
git revert --no-edit 7886587d   # B2 throttle login
git revert --no-edit 89b43eba   # B1 allowlist /data
pm2 restart autocuan-web --update-env

# Opsi C - reset ke commit sebelum deploy (ikut membatalkan deploy DayTrade):
git reset --hard 672a7557
pm2 restart autocuan-web --update-env
```

(Cek pasca-rollback: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/register.html` → 200.)

---

## 5. Langkah manual pemilik

1. **Purge cache Cloudflare untuk `/data/*`** (kecuali indeks `bandarmologi-intel-indexes/latest_*` yang sah). File premium yang sudah ter-cache di edge **masih bisa diunduh** sampai di-purge; origin sudah 404, tetapi edge belum tentu. Roo tidak punya akses Cloudflare.
2. **Persistensi throttle:** set `LOGIN_THROTTLE_DB` ke path persisten (mis. `/home/ubuntu/auto-cuan-data/login-throttle.sqlite`) agar hitungan tahan reboot. Default saat ini `/tmp/...` → tahan restart PM2, hilang saat reboot.
3. **Google login (503 di produksi):** variabel yang belum diisi:
   - `GOOGLE_OAUTH_CLIENT_ID` (atau `GOOGLE_CLIENT_ID`)
   - `GOOGLE_OAUTH_CLIENT_SECRET` (atau `GOOGLE_CLIENT_SECRET`)
   - `GOOGLE_OAUTH_REDIRECT_URI` (atau `GOOGLE_REDIRECT_URI`)
   Langkah: buat OAuth client di Google Cloud Console, set redirect URI ke URL callback produksi, isi 3 variabel di env proses web, lalu restart.

---

## 6. Usulan B3 (tidak diubah)

1. **`SECURITY_GUARD_MODE`.** Disarankan mengisi `SECURITY_EVENT_PEPPER` (≥32 char) dan menjalankan guard dalam mode `shadow` dahulu, baru `enforce`. Risiko: tanpa skema Supabase `security_login_*` atau pepper yang benar, admin dapat terkunci (503) karena `SECURITY_GUARD_FAIL_CLOSED_ADMIN` default true di produksi. Selama rollout, set `SECURITY_GUARD_FAIL_CLOSED_ADMIN=0` untuk mencegah admin terkunci. B2 sudah menutup celah fail-open, jadi guard bersifat lapisan tambahan.
2. **Pencabutan sesi.** Usulan: tambah kolom `session_version` (int) di `app_users`; sertakan `session_version` di dalam token sesi bertanda-tangan; naikkan saat ganti password; saat verifikasi sesi, tolak token bila `token.session_version !== db.session_version`. Alternatif: tabel denylist `jti` per sesi.
3. **Google login.** Lengkapi 3 variabel di atas (nama saja) + langkah pemilik; setelah terisi, tombol "Masuk dengan Google" akan berfungsi.
4. **Mode pemeliharaan.** Saat ini hanya ditegakkan di UI; API data tetap melayani. Usulan: middleware bersama yang membaca `app_settings.maintenance_mode` pada endpoint data dan menjawab 503 (kecuali admin), agar tidak dapat dilewati dari sisi klien.

---

## Ringkasan perubahan
- `lib/data-route-allowlist.js` (baru) — gate default-deny murni (tanpa I/O), menolak traversal/backslash/NUL sebelum perbandingan prefix.
- `tools/local-dev-server.js` — `/data/*` default-deny; 404 (bukan 403) untuk non-allowlist.
- `lib/login-throttle.js` (baru) — throttle persist (SQLite), 5/15 mnt per (akun,IP), 30/15 mnt per IP, backoff 400ms–5s, blok sementara yang lepas otomatis.
- `api/login-user.js` — cek throttle sebelum lookup, `registerFailure` pada gagal kredensial, `clearFailure` saat sukses.
- Test: `test/data-route-allowlist.test.js`, `test/login-throttle.test.js` (terdaftar di `tools/curated-build-tests.json`).
- Tidak ada perubahan skor, gate, scoring, atau alur data.