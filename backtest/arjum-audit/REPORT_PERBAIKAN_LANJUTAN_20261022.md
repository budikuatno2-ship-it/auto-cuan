# REPORT PERBAIKAN LANJUTAN 22 OKT 2026 — Job, Indeks, Keamanan

**Tanggal:** Jumat, 23 Oktober 2026 (WIB) — eksekusi prompt bertanggal 22 Okt.
**Branch fitur:** `fix/status-jobs-index-security-20261022` (dari `feat/daytrade-screener-v1`).
**PR:** #905 → merge commit `b96e7648` ke `feat/daytrade-screener-v1`. **Tidak** di-merge ke `main`.
**VPS:** `git pull --ff-only` → HEAD `b96e7648`. `autocuan-web` di-restart **satu kali** pukul **12:57:37 WIB** (di luar jam bursa).
**Test:** `npm run test:full` → **724/724 file test lulus**.
**Tanpa kunci, token, IP VPS, atau isi data mentah.**

---

## 1. Status terkini (A) — read-only, 0 request Arjum

### 1.1 Backlog isi ulang 19 Okt — TIDAK berkurang

| Tipe | Emiten punya file 19 Okt | Emiten punya file 20 Okt | 21 Okt | 22 Okt |
|---|---|---|---|---|
| ALL (`broker-summary`) | **50** | 0 | 0 | 0 |
| F (`broker-summary-F`) | **50** | 0 | 0 | 0 |
| Akumulasi (`broker-accumulation`) | **50** | 0 | 0 | 0 |
| Insider (`insiders`) | **50** | 0 | 0 | 0 |

- Direktori emiten: ALL 970, F 296, Akumulasi 964, Insider 964.
- **Pending ALL 19 Okt = 920 dari 970** (dihitung langsung: direktori tanpa `2026-10-19.json`). Angka ini **sama** dengan 871–921 yang dilaporkan 20 Okt — **tidak ada kemajuan**.
- Marker harian: `2026-10-19.json` ada (mtime 20 Okt 12:36, hasil karantina `chunk50`), tetapi **`2026-10-20/21/22.json` tidak ada sama sekali**. Artinya J1 tidak pernah menulis marker untuk 20–22 Okt.
- **Kenapa tidak berkurang:** J1 (EOD broker-summary) tidak berjalan pada 20–22 Okt. Log `daily-market-update.log` berhenti pada target 19 Okt (`Status: GAGAL — 921 ticker belum punya broker summary 2026-10-19`). Tidak ada baris `Target Date (WIB): 2026-10-20/21/22`. Penyebab yang terlihat: `[ARJUM-LOCK] SKIPPED_ARJUM_BUSY` berulang (J1 kalah lock bersama dari job lain) dan pemutus sirkuit kuota (`[CIRCUIT BREAKER] ... Kuota harian akun kamu (1000 req/hari) sudah habis`). Backfill malam (00:07/19:30) memakai kuota untuk **F saja** (lihat 1.3), bukan ALL.

### 1.2 Hasil harian 20, 21, 22 Okt

| Job | 20 Okt | 21 Okt | 22 Okt |
|---|---|---|---|
| **J1** (broker-summary ALL/F/akumulasi/insider) | **tidak ada run** (tidak ada marker, tidak ada baris target) | **tidak ada run** | **tidak ada run** |
| **J2 candle 16:40** | rc=0 (cross-check OK) | **rc=6** — `CROSS-CHECK-FAILED 20/20`, `CROSS-CHECK-DEFER` (mass fallback ke Arjum DITOLAK) | **rc=6** — sama |
| **J2 candle 23:30** | rc=0 | rc=0 (`CROSS-CHECK-OK 20/20`) | rc=0 (`CROSS-CHECK-OK 20/20`) |
| **IHSG** | bar ada | bar ada | bar ada |
| **Backfill** | berhenti di batas cadangan kuota | idem | idem |

- **IHSG:** file `data/daily-candles/IHSG.json` berisi bar **13, 14, 15, 16, 19, 20, 21, 22 Okt** — **ada bar tiap hari**. Job 17:45 keluar rc=7 (peringatan "bar belum ada") lalu job 23:30 mengisi bar; ini perilaku yang dirancang (IHSG mandiri, 1 request).
- **Exit 5 (pemutus sirkuit):** tidak muncul sebagai kode keluar job; yang muncul adalah pesan `[CIRCUIT BREAKER]` di dalam proses (kuota/429). **Exit 6 (cross-check tertunda):** terpicu **2 kali** (21 & 22 Okt, pass 16:40).
- **`SKIPPED_ARJUM_BUSY`:** terpicu **berulang** di `daily-market-update.log` (J1 kalah lock bersama). Ini yang membuat J1 tidak berjalan.
- **Alarm Admin Console & Telegram:** **tidak dapat dibuktikan terkirim.** Tidak ada bukti pengiriman alarm backlog di log; justru itulah alasan B3 dibuat (alarm umur backlog kini ada dan sudah diuji).

### 1.3 Kuota

- `ARJUM_DAILY_LIMIT` di `.env` = **18080**; `getConfiguredDailyQuota()` membaca **12060** (nilai efektif yang dipakai kode).
- `usage.json` (23 Okt): `used=13847`, `updated_at=2026-10-22T18:49Z`.
- Backfill state: `totalRequestsSentInRun=13847`, `totalSent=244599`, `completedTickers=295` (F saja, 188 hari/emiten).
- **Sisa kuota efektif** = 12060 − 13847 = **negatif** (kuota efektif sudah terlampaui untuk hari itu). Dengan `ARJUM_DAILY_LIMIT=18080`, sisa = **4233**.
- **Hitung ulang realistis:** cadangan job harian (J1 ALL+F+akumulasi+insider untuk 962 emiten ≈ 3.000–3.500 request; J2 IHSG 1 + cek silang 20; backfill F) menghabiskan hampir seluruh kuota. Sisa untuk isi ulang ALL H-1 ≈ **0–1.000 request/hari**. Dengan 920 emiten × 3 request (summary+akumulasi+insider) ≈ **2.760 request**, backlog **tidak akan tuntas** selama J1 gagal berjalan dan kuota tetap 12.060–18.080. **Kesimpulan: backlog tidak akan tuntas dengan kuota sekarang; akar masalahnya J1 tidak berjalan (lock/kuota), bukan kurang malam.**

### 1.4 Sepuluh saham uji (BBCA, BRPT, BBRI, MEDC, ADRO, BUMI, BMRI, TPIA, BBNI, TLKM)

- Masing-masing: **199 file** di `broker-summary`, **80 file** sejak 30 Jun 2026 (≈80 hari bursa), rentang `2026-01-02` … `latest.json`.
- **Tanggal terakhir tersimpan = 19 Okt** (bukan 21 Okt). Syarat "80 hari bursa" **terpenuhi**, tetapi **tidak ada data 20–22 Okt** karena J1 tidak berjalan. **Fase 2 gabungan belum siap** untuk tanggal terkini.

### 1.5 `STATUS_GABUNGAN.md`

- **Ada** (`backtest/arjum-audit/STATUS_GABUNGAN.md`, update 18 Okt 21:47).
- Fase 1A **selesai & deployed**; 1B & 1C **selesai (read-only/rencana)**; **Fase 2 & 3 DILEWATI** (paritas akumulasi 96–97% < 99%; cakupan F 13,79% < 90%). Uji ulang dijadwalkan 22 Okt — **belum dijalankan**.

### 1.6 Langkah manual pemilik yang tertunda

- **Purge cache Cloudflare `/data/*`:** tidak dapat dicek dari server (aksi di dashboard Cloudflare). **Belum dapat dipastikan.**
- **`LOGIN_THROTTLE_DB` ke path persisten:** tidak dapat dipastikan dari server tanpa membaca nilai env (dilarang). **Perlu konfirmasi pemilik.**

---

## 2. B — Perbaikan job dan indeks

| Butir | Commit | Isi | Test |
|---|---|---|---|
| **B1** | `0022ba5c` | Cron `run-broker-hunter-indexer.sh` **22:45 WIB** hari bursa + wrapper baru | `test/broker-hunter-index-and-backlog-cron.test.js` |
| **B2** | `27be0e7f` | Cooldown bridge **per ticker** (bukan global 60 dtk), timeout probe **3s→8s**, log alasan berbatas-laju untuk cabang `else` | `test/vps-data-fetcher-per-ticker-cooldown.test.js` |
| **B3** | `4640cf01` | Alarm backlog H-1 (>24 jam & tidak berkurang) → Telegram + state Admin Console, sekali/hari; cron 19:45 WIB | `test/backlog-age-alarm.test.js` |
| **B4** | `ba63c6e8` | Identitas header hanya bila `ALLOW_DEV_HEADER_IDENTITY=1` (tidak ada di produksi), bukan `NODE_ENV !== 'production'` | `test/dev-header-identity.test.js` |

**B1 — bukti di VPS:**
- Cadangan crontab: `/home/ubuntu/auto-cuan-runner/backup/crontab-before-b1b3-20261023-125038.bak` (86 baris) dan `crontab-before-install-*.bak`.
- Baris **sebelum** (tidak ada): `broker_hunter_lines=0`.
- Baris **sesudah** (crontab baris 93): `45 22 * * 1-5 bash /home/ubuntu/auto-cuan/deploy/vps/run-broker-hunter-indexer.sh >> .../broker-hunter-indexer.log 2>&1`.
- Dijalankan sekali: `newest_index_mtime=2026-10-23 12:57:33 +0700` (sebelumnya **2026-09-12 17:12**). Index basi 6 minggu → **segar**.

**B2 — alasan angka:** timeout 8 dtk memberi ruang satu handshake tunnel dingin (teramati ~2,5 dtk) tanpa memblokir pemanggil; cooldown per ticker memastikan satu timeout hanya mematikan ticker itu. Log degradasi dibatasi 1 per ticker per 10 menit agar tidak membanjiri log (akar 52 rb baris).

**B3 — bukti di VPS:** dijalankan sekali; state `data/backlog-age-alarm.json` = `target_date=2026-10-19, pending=871, total_tickers=962, reason=still_young, should_alert=false` (episode baru dimulai; alarm akan menyala bila >24 jam dan tidak berkurang). Cron baris 98: `45 19 * * 1-5 ... run-backlog-age-alarm.sh`.

**B4 — nilai `NODE_ENV` yang terbaca (proses berjalan, bukan hanya ecosystem):**
- `pm2 jlist` → `autocuan-web | status=online | NODE_ENV=production | devFlags=none`.
- Uji header palsu **sebelum** restart: `x-user-id: 999999` → **401**.
- Uji header palsu **sesudah** restart (12:57 WIB): `x-user-id: 999999` → **401**. **Bukan [DARURAT].**

**Jalur kembali (siap tempel):**
```bash
cd /home/ubuntu/auto-cuan
git revert --no-edit b96e7648            # atau: git reset --hard cb36ab95
crontab /home/ubuntu/auto-cuan-runner/backup/crontab-before-b1b3-20261023-125038.bak
pm2 restart autocuan-web --update-env    # hanya bila api/ atau server berubah
```

---

## 3. C — Keamanan tingkat sedang (verifikasi + perbaikan)

| Butir | Verdict | Commit | Bukti uji |
|---|---|---|---|
| **C1** XFF palsu melewati batas | **BENAR** | `79fa655f` | Lihat di bawah |
| **C2** HSTS & CSP tidak ada | **BENAR** | `73035e99`, `61281b19` | Lihat di bawah |
| **C3** Anggota kedaluwarsa tidak dikeluarkan; lifecycle tidak di crontab | **BENAR** | `464646de` | Lihat di bawah |
| **C4** Bandarmologi publik bisa menghabiskan kuota | **BENAR** | `c7b3c245` | Lihat di bawah |

### C1 — BENAR
- **Sebelum:** `clientAddress` mengambil entri **pertama** `x-forwarded-for` (dikendalikan klien). Uji pra-perbaikan: 10 pendaftaran dengan XFF `10.9.9.1..10` semuanya lolos ke handler (tidak ada bucket bersama).
- **Sesudah:** IP hanya dari rantai proksi tepercaya. Bukti pada kode live di VPS:
  - `direct_peer_ignores_xff=203.0.113.9` (peer langsung, header diabaikan)
  - `trusted_hop_uses_last=198.51.100.7` (hop nginx, entri **terakhir**)
  - `cloudflare_uses_cf_header=198.51.100.7` (`CF-Connecting-IP` menang)
  - Limiter: `allowed_of_10=8` — 10 XFF palsu berbeda dari **satu** peer berbagi satu bucket (8 lolos, sisanya ditolak).
- Catatan: uji HTTP langsung ke origin mengembalikan 400 `TERMS_ACCEPTANCE_REQUIRED` (validasi ketentuan lebih dulu), sehingga bukti limiter diambil dari kode live + unit.

### C2 — BENAR
- **Sebelum:** origin `/` hanya mengirim `X-Content-Type-Options: nosniff`. **Tidak ada** HSTS, **tidak ada** CSP.
- **Siapa mengirim header:** `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` dikirim **nginx**; `X-Content-Type-Options` dari **aplikasi** (`lib/static-assets.js`). HSTS & CSP **tidak dikirim siapa pun** sebelum perbaikan.
- **Sesudah (origin, 12:57 WIB):**
  - `Strict-Transport-Security: max-age=300` (mulai pendek; naik via `SECURITY_HSTS_MAX_AGE`, `includeSubDomains` opt-in).
  - `Content-Security-Policy-Report-Only: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; ...; report-uri /api/csp-report` (**Report-Only**, bukan penegakan).
  - `X-Content-Type-Options: nosniff`.
- **Pelanggaran tercatat:** `data/csp-violations.jsonl` → `count=0` saat ini (baru aktif). Pembaca: `node tools/csp-violations-report.js`. **Laporan 24 jam** akan tersedia setelah 24 jam berjalan; belum ada data untuk dilaporkan sekarang.
- Kolektor dilayani dari `lib/security-headers.js` (bukan `api/`) agar anggaran 13 fungsi API tetap utuh.

### C3 — BENAR
- **Kenapa tidak terjadwal:** `tools/run-telegram-lifecycle.sh` ada dan env-nya ada (`telegram-lifecycle.env`, perms 600), tetapi **tidak ada baris crontab** (`telegram_lifecycle_lines=0`). Tidak ada jalur ban/kick di `lib/telegram-lifecycle.js` (hanya pengingat verifikasi + tinjauan 30 hari).
- **Mode kering (tidak mengeluarkan siapa pun):** `removed=0`, `scanned_members=5`, `counts={admin:1, expired:1, never_subscribed:3}`.
- **Daftar anggota kedaluwarsa (untuk pemilik):**

| user_id | username | telegram_user_id | kedaluwarsa | paket | sumber |
|---|---|---|---|---|---|
| `0d04efaf-1675-4705-84ba-4059a7724e7c` | `userbot123` | `5831709329` | 2026-09-17 | PREMIUM_1_MONTH | voucher |

- **Penjadwalan nyata menunggu persetujuan pemilik atas daftar ini.** Tidak ada yang dikeluarkan.

### C4 — BENAR
- **Jalur yang memanggil Arjum:** `lib/bandarmologi-service.js` `getBandarmologiData` — cabang flow F/D (3 request: summary+akumulasi+insider) dan cabang single-date (3 request). Dispatcher `api/sector-hot.js` merutekan `action=bandarmologi` **sebelum** gerbang premium.
- **Sesudah:** live fetch **default OFF** (`allowLiveFetch`), hanya sesi login yang mengaktifkan; anonim dibatasi **30 req/menit per IP** dan hanya baca disk. Bukti: anonim `BBCA` → `success=true, from_cache=true, date=Tanggal: 2026-10-19` (dari disk, tanpa request Arjum baru).

---

## 4. Langkah manual pemilik yang tersisa

1. **Purge cache Cloudflare `/data/*`** (kecuali `bandarmologi-intel-indexes`) — aksi di dashboard, tidak bisa dari server.
2. **`LOGIN_THROTTLE_DB`** ke path persisten — perlu konfirmasi pemilik (nilai env tidak dibaca).
3. **C3:** tinjau daftar 1 anggota kedaluwarsa di atas; beri persetujuan bila ingin penjadwalan/penghapusan dibuat.
4. **C2:** setelah 24 jam, jalankan `node tools/csp-violations-report.js` untuk melihat pelanggaran; naikkan `SECURITY_HSTS_MAX_AGE` bertahap.
5. **Backlog 19 Okt:** J1 harus berjalan lagi (lock bersama + kuota). Ini di luar cakupan prompt ini; perlu keputusan pemilik (naikkan kuota atau kurangi cakupan F).

---

## 5. Usulan (tidak diubah)

- Pencabutan sesi (`session_version` per akun, naik saat ganti password).
- Mode pemeliharaan juga ditegakkan di API data (kecuali admin).
- `SECURITY_EVENT_PEPPER` dan `SECURITY_GUARD_MODE` (`shadow` lalu `enforce`).
- Menjalankan bridge in-process (usulan B2, tidak diubah).
- Menjadwalkan `run-telegram-lifecycle.sh` **setelah** pemilik menyetujui daftar C3.

---

## 6. Ringkasan commit & PR

| Butir | Commit | Status |
|---|---|---|
| B2 | `27be0e7f` | merged |
| B4 | `ba63c6e8` | merged |
| C1 | `79fa655f` | merged |
| B1 | `0022ba5c` | merged |
| B3 | `4640cf01` | merged |
| C2 | `73035e99` + `61281b19` | merged |
| C3 | `464646de` | merged |
| C4 | `c7b3c245` | merged |
| Test alignment | `a76429cf`, `f6e55056` | merged |
| **PR** | **#905** → merge `b96e7648` | **MERGED** ke `feat/daytrade-screener-v1` |
| **VPS pull** | HEAD `b96e7648` | **selesai** |
| **Restart** | `autocuan-web` 12:57:37 WIB, health **200** | **selesai (1x)** |

CI: `unit`, `database`, `security-gate`, `command-login`, `portfolio-persistence`, `webkit-keyboard`, `build-and-focused-tests`, `Analyze JavaScript`, `CodeQL` **lulus**. `browser` (precision-workspace) **gagal di semua branch sejak 19 Okt** (assertion Portfolio UI, bukan dari perubahan ini). Vercel **gagal karena akun diblokir** (di luar kendali repo).
