# SERAH TERIMA PIPELINE DATA, CRON, VPS, KUOTA, KEAMANAN SERVER (Roo Code dan agen lain)

> Terakhir diperbarui: **Jumat 23 Okt 2026, ±21:00 WIB** (setelah laporan Roo "guard fix TERBUKTI MENYIMPAN", sebelum pass J1 23:30). **Perbarui bagian 7, 8, 12 setelah laporan pass 23:30.**
> Ditulis oleh Claude untuk pemilik produk. Tujuan: siapa pun (Roo Code, Gemini/Antigravity, atau agen lain) yang meneruskan pekerjaan data/VPS memahami **apa yang sudah dicek, diubah, dilakukan, belum dilakukan, dan hasilnya**.
> **Tidak berisi** kunci, token, alamat VPS, atau lokasi kunci. Jangan menambahkannya. Pasangannya: `HANDOFF_ANTIGRAVITY_REDESIGN_UIUX.md` (redesign UI; bukan wilayah file ini).
> Disarankan **tidak di-commit** ke repo (simpan di `backtest/arjum-audit/` atau tambahkan ke `.git/info/exclude`).

---

## 0. Ringkasan 15 baris (kondisi malam ini)

1. **J1 (broker summary ALL+F, akumulasi, insider) tidak menyimpan data sama sekali sejak 19 Okt** sampai Jumat 23 Okt sore.
2. **Akar masalah (terbukti):** (a) **guard jam operasional** di `lib/arjum-client.js` (PR #891, commit `a6cf3265`, merge 19 Okt 09:49 WIB) menolak permintaan broker-summary `noFallback/forceFresh` di luar 09:00–16:00 → ALL/F selalu 400 → pemutus sirkuit berhenti; (b) **lock Arjum dipegang backfill** berjam-jam dan J1 memakai `waitMs:0` → `SKIPPED_ARJUM_BUSY` 20–22 Okt; (c) pembacaan **batas kuota** membingungkan (12.060 vs 18.080).
3. **Perbaikan sudah di VPS** (PR #906–#909, semua tanpa restart): J1 menunggu lock, backfill melepas lock antar batch, satu sumber batas kuota, `bypassMarketGuard:true` hanya untuk J1 EOD dan skrip pengejaran, alarm 0-data, backfill **dijeda**.
4. **Terbukti menyimpan:** run manual J1 Jumat 20:21–20:31 menyimpan 23 Okt: ALL 146, F 146, akumulasi 146, insider 145 emiten (kuota 14.700 → 15.295). Pass **23:30** akan melanjutkan dengan sisa ±2.780 request.
5. **Kuota:** batas 18.080/hari (1.000 gratis + 17.080 Supporter), reset 00:00 WIB. **Supporter berakhir ±18 Nov** → sesudahnya ±6.000/hari.
6. **Data bolong:** 19 Okt (sisa ±920 emiten), 20, 21, 22 Okt (nol), 23 Okt (sebagian, sedang diisi). Pengejaran otomatis **Sabtu 24 dan Minggu 25 Okt pukul 00:07** (urutan 23, 22, 21, 20, 19; batch 50; berhenti bila >20% gagal).
7. **Backfill F** (saham likuid sejak 2 Jan) **belum dihidupkan**; persetujuan bersyarat sudah ada (Bagian 8).
8. **Keamanan:** `/data/*` default-tolak, login throttle, XFF/proksi, HSTS pendek + CSP Report-Only, Bandarmologi publik di-cache + dibatasi, `x-user-id` dikunci. Sisa: langkah manual pemilik + antrean tinjauan (Bagian 10–11).
9. **Banyak bug lain belum diaudit/diperbaiki** (daftar dari pemilik di Bagian 11): jadwal, screener DayTrade, Swing Konglo/Non-Konglo, FastWatcher, notifikasi dan gate Telegram, cron Arjum, broksum asing, akumulasi broker, candle Yahoo + IHSG.
10. **Pelajaran terbesar:** laporan Roo sering lebih optimis daripada kenyataan. **Selalu minta bukti** (baris log, hitungan file, kuota sebelum/sesudah). Lihat Bagian 15.

---

## 1. Arsitektur dan lingkungan

| Hal | Isi |
|---|---|
| Produk | Auto-Cuan (riset saham IDX), domain produksi `autocuan.web.id`, di belakang **Cloudflare** + **nginx** |
| Repo | GitHub `budikuatno2-ship-it/auto-cuan`; clone Roo: `D:\auto-cuan-2` (laptop pemilik); clone redesign (terpisah): `D:\auto-cuan-redesign` |
| Branch utama | **`feat/daytrade-screener-v1`** (bukan `main`). VPS **selalu** menjalankannya |
| VPS | satu mesin (1 core), pengguna `ubuntu`, repo di `/home/ubuntu/auto-cuan`, runner/cadangan di `/home/ubuntu/auto-cuan-runner/` (backup crontab di `/home/ubuntu/auto-cuan-runner/backup/`). Proses web: **pm2 `autocuan-web`** |
| Akses VPS | **SSH dari laptop pemilik lewat Roo Code**; kunci tetap di laptop pemilik. Bentuk perintah (isi sendiri, **jangan ditulis di repo/commit/laporan/chat**): `ssh -o ConnectTimeout=15 -o ServerAliveInterval=20 -o ServerAliveCountMax=12 -i "<LOKASI_KUNCI>" ubuntu@<ALAMAT_VPS>`. **Jangan `StrictHostKeyChecking=no`.** Agen cloud tidak boleh diberi kunci |
| Data | `data/` (±7,9 GB): `data/arjum-data/…` (broker summary ALL, `broker-summary-F/`, akumulasi, insider per tanggal), `data/daily-candles/<TICKER>.json` (962 saham) dan `IHSG.json`, `data/screener-latest.json`, `data/sector-hot-*.json`, `bandarmologi-intel-indexes/`, `broker-hunter-indexes/`, `_eod/<tanggal>.anomali.json`, marker harian `YYYY-MM-DD.json` (`complete`, `total`, `pending`, `done`, `errors`) |
| Laporan Roo | `backtest/arjum-audit/` (REPORT_*.md, STATUS_GABUNGAN.md) |
| Penyedia data | **Arjum** (IDX/KSEI; broker summary, akumulasi, insider, candle; hanya GET; berkuota). **Yahoo** (candle utama 962 saham + harga live lewat cache server). Nama "Arjum" tidak boleh tampil di UI |
| Test | `npm run test:full` (724 file lulus pada 22 Okt; kegagalan lama di Windows: `daily-market-context-collector-runtime-bugfix`, `telegram-member-lifecycle`) |
| CI | build-and-focused-tests, unit, database, security-gate, CodeQL lulus. `browser` gagal di semua branch sejak 19 Okt (assertion Portfolio UI). Vercel gagal ("Account is blocked", abaikan) |

---

## 2. ATURAN KERAS (berlaku untuk setiap prompt/agen)

1. **Branch dan deploy:** kerjakan di branch fitur dari `feat/daytrade-screener-v1`, satu masalah satu commit **dengan test**, `npm run test:full`, PR ke `feat/daytrade-screener-v1`, merge, **di VPS `git pull --ff-only`**. **PR saja tidak cukup.** **Jangan merge ke `main`.** **Jangan checkout branch fitur di VPS.** Sediakan **jalur kembali siap tempel** (revert commit + perintah restart + pulihkan crontab).
2. **Restart `autocuan-web`:** hanya bila `api/` atau file server berubah; **satu kali**; **hanya sebelum 08:45 atau setelah 16:15 WIB** (bursa buka 09:00; Jumat ada jeda sesi 11:30–14:00 yang **bukan** jendela restart). Skrip cron (`tools/`, `deploy/vps/`) cukup `git pull`. (Pelanggaran tercatat: restart 23 Okt 12:57:37 WIB oleh PR #905.)
3. **Tanya dulu sebelum mengubah apa pun** (kode, crontab, `.env`, data, restart, deploy), kecuali pemilik sudah menulis izin tertentu di prompt. Prompt pengecekan = **read-only**. Masalah rusak yang masih berlangsung: tulis **[DARURAT]** + usulan, tunggu jawaban pemilik.
4. **Rahasia:** jangan pernah mencetak `.env`, `ARJUM_API_KEY`, kunci SSH, token, **IP VPS**, **lokasi kunci**. Boleh menulis nilai variabel yang bukan rahasia (mis. `ARJUM_DAILY_LIMIT`, `NODE_ENV`). Jangan mengunduh file data premium "untuk membuktikan". Log test lama mencetak alamat dan kunci VPS (`vps-fetcher`): **masker**.
5. **Arjum hanya GET.** Kuota harian terbatas: jangan memicu request tanpa perlu; uji dengan 1–3 request.
6. **Data:** tidak ada angka karangan (kosong = null/"—", bukan 0); **tidak ada file data yang dihapus** (pindahkan ke `_quarantine-*`); **cadangkan** `state.json`, `.env`, crontab sebelum mengubah (tulis nama file cadangan + perintah pemulihan); **jangan mengurangi 962 saham** tanpa persetujuan pemilik.
7. **Job harian (J1, J2, IHSG) selalu didahulukan atas backfill.** Backfill hanya memakai sisa kuota setelah kebutuhan harian + cadangan.
8. **Skor, gate, scoring, rumus indikator tidak boleh berubah** karena pekerjaan pipeline.
9. **Kuota:** **setiap paket/tambahan berubah, perbarui `ARJUM_DAILY_LIMIT`.** Cadangan sebelum job sore ≥ 5.100 (lantai efektif 4.940 di logika anggaran Roo; **tidak berlaku untuk J1 sendiri**).
10. **Jangan pernah `waitMs: 0` untuk job harian** pada lock Arjum.
11. Pekerjaan redesign UI **tidak boleh** menyentuh pipeline; sebaliknya Roo tidak mengubah UI.
12. Laporan wajib berbukti (Bagian 15), ditulis ke `backtest/arjum-audit/REPORT_<TOPIK>_<TANGGAL>.md`, **tanpa kunci/IP/lokasi kunci/isi data**.

---

## 3. Jadwal cron dan job (peta; verifikasi dengan `crontab -l` di VPS, jangan percaya buta)

Semua jam WIB (zona server perlu dipastikan; Roo menulis jadwal dalam WIB). Crontab terakhir ±129 baris.

| Job | Skrip | Jadwal | Fungsi | Kuota Arjum |
|---|---|---|---|---|
| **J1** broker EOD | `tools/run-daily-market-update.js` → `tools/run-daily-broker-update.js` | `30,45 16`, `0,15,30,45 17`, `30 23` Senin–Jumat | broker summary ALL + F per saham, akumulasi, insider; menulis marker harian | ±3.464/tanggal (ALL 962 + F 834 + akumulasi 834 + insider 834) |
| **J2** candle | `tools/fetch-daily-candles.js` | `40 16` dan `30 23` | candle 962 saham dari **Yahoo** dulu; cek silang 20 saham ke Arjum; kembali ke Arjum bila selisih | ±21 (cek silang), fallback bisa sampai 962 |
| **IHSG** | langkah mandiri | 17:45 dan 23:30 | 1 request/hari ke `data/daily-candles/IHSG.json`; alarm bila bar hari bursa belum ada 17:30 | 1 |
| **Backfill broksum** | `tools/backfill-broksum*.js` | `7 0`, `30 19`, 01:35, dll. | F untuk saham likuid sejak 2 Jan; candle | **DIJEDA** sejak 23 Okt 14:38 (`active_backfill_lines=0`, 4 marker dijeda, baris diberi komentar `# DIJEDA 20261023 sampai J1 terkejar`) |
| **Pengejaran tanggal bolong** | `tools/catchup-missing-dates.js` (`run-catchup-missing-dates.sh --dates 2026-10-23,2026-10-22,2026-10-21,2026-10-20,2026-10-19 --batch 50`) | `7 0 * * 6` dan `7 0 * * 0` | mengisi **empat jenis** per emiten/tanggal; terbaru dulu | akhir pekan: lantai 1.500, bisa dipakai 16.580 |
| **Alarm umur backlog** | skrip B3 | `45 19 * * 1-5` (baris 98) | peringatan bila antrean H-1 > 24 jam dan tidak berkurang, sekali/hari | 0 |
| **broker-hunter-indexes** | pembangun indeks | `45 22 * * 1-5` (baris 93) | membangun ulang indeks turunan (dulu basi sejak 12 Sep; tidak ada di crontab) | 0 |
| **bandarmologi-intel-indexes** | pembangun indeks | (verifikasi) | dilayani publik `latest_<range>.json` | 0 |
| **DayTrade producer** | (DayTrade) | `2,17,32,47 9-15` | scan DayTrade; **PR #899 (merge `d6a7ac9d`) membuat full universe 800+ saham**, deploy 20 Okt | Yahoo/cache, bukan Arjum (verifikasi) |
| **Swing preflight** | Swing Konglo/Non-Konglo | `21:30` | pra-cek malam (sempat "ter-skip" sebelum 20 Okt) | verifikasi |
| **FastWatcher, notif Telegram, gate Telegram, Sektor Hot** | (lihat PROMPT_CEK_SEMUA_CRON) | **belum diaudit tuntas** | — | — |
| Telegram lifecycle (kick anggota kedaluwarsa) | — | **tidak ada di crontab** | menunggu keputusan pemilik | 0 |

Backup crontab yang ada: `crontab-before-darurat-20261023-143849.bak` (121 baris), `crontab-before-weekend-20261023-150321.bak` (129 baris), `crontab-before-b1b3-20261023-125038.bak` (86 baris), semuanya di `/home/ubuntu/auto-cuan-runner/backup/`. Pemulihan umum: `crontab <file-cadangan>` lalu `git revert --no-edit <commit>`.

File status penting di runner: `j1-skip-alarm.json` (`consecutive_skips`, `last_success_at`, `last_alert_reason`; **`last_success_at` kini tidak dicap oleh run 0-data**), lock `arjum-api.lock` (`withArjumLock({job, waitMs})`), marker harian.

---

## 4. Kronologi (ringkas) dan akar masalah

| Tanggal | Peristiwa |
|---|---|
| 11 Sep | Guard jam operasional + `shouldEnforceMarketHours()` dibuat (`2836c790`) |
| 12 Sep | `broker-hunter-indexes` terakhir diperbarui (lalu basi sampai 23 Okt) |
| 16 Okt | **Hari baik terakhir** J1 sebelum insiden: semua tipe tersimpan |
| 17–18 Okt | Audit pipeline, backfill asing, hemat kuota, deploy broksum, kuota naik **+6.020 (12.060 → 18.080)**, validator broksum (`.done` 1% + top-100), IHSG mandiri |
| 18 Okt 10:23 | Commit `a6cf3265`: `if (noFallback || forceFresh) return 400 'Di luar jam operasional bursa BEI.'` |
| **19 Okt 09:49** | **PR #891 merge** (memasukkan `a6cf3265` ke `feat/daytrade-screener-v1`) |
| 19 Okt sore | J1: **921/921 request gagal**, tersimpan 0, ±1.884 request terbuang, exit code 0 (tanpa alarm); J2 cek silang 20/20 gagal, fallback Arjum gagal (943). Dashboard Arjum mencatat 4.376 request |
| 20 Okt | Perbaikan keamanan besar dideploy (02:11 restart), perbaikan job (#902–#904: pemutus sirkuit, pagar Arjum bersama, IHSG mandiri, backfill mengalah, marker terverifikasi), DayTrade full universe (#899) |
| 20–22 Okt | **J1 tidak berjalan** (`SKIPPED_ARJUM_BUSY`, lock dipegang backfill, `waitMs:0`); J2 16:40 rc=6 pada 21 dan 22 Okt (`CROSS-CHECK-FAILED 20/20` → `CROSS-CHECK-DEFER`); J2 23:30 rc=0; IHSG ada tiap hari; backfill `HALTED_BY_BUDGET_OR_QUOTA` |
| 23 Okt 12:57 | PR #905 (lanjutan) + restart (menyalahi aturan jam). Cron `broker-hunter-indexes`, alarm backlog, cooldown per ticker `vps_local_cache_stale` |
| 23 Okt 14:38 | PR #906 darurat dipull (backfill dijeda, lock, kuota, alarm) |
| 23 Okt 15:03–15:25 | PR #907 dan #908 (pengejaran akhir pekan, empat jenis) |
| 23 Okt 16:30 | J1 berjalan tetapi **20/20 gagal `client_4xx`** (guard jam operasional) → pemutus sirkuit, alarm `[ALERT]` tertulis di log; tersimpan 0 |
| 23 Okt 19:39 | **PR #909** (`64e32cff`): bypass guard untuk J1 + pengejaran; 23 Okt ditambah ke pengejaran |
| 23 Okt 20:21–20:31 | **Run manual J1:** ALL 146, F 146, akumulasi 146, insider 145 tersimpan (kuota 14.700 → 15.295). Pass 23:30 menyusul |

### Tiga akar masalah (urut dampak)
1. **Guard jam operasional salah sasaran** (`lib/arjum-client.js` sekitar baris 533): J1 memanggil broker-summary dengan `{fresh:true, forceLive:true, noFallback:true}` → guard mengembalikan 400 **tanpa** mencoba cache. `fetchBrokerAccumulation` dan `fetchInsiders` **tidak** memakai guard itu (200 di jam yang sama). Guard sengaja ada untuk mencegah permintaan live intraday dari web di luar bursa → **tetap berlaku untuk web** (terbukti 400), **dilewati hanya untuk J1 EOD dan pengejaran** (`bypassMarketGuard:true`). `lib/arjum-client.js` **tidak diubah**, tanpa `ARJUM_DISABLE_MARKET_GUARD`. Test: `test/j1-eod-market-guard-bypass.test.js` (7 lulus).
2. **Lock Arjum + `waitMs:0`:** `tools/run-daily-market-update.js:251` `withArjumLock({ job:'J1', waitMs:0 })`; backfill memegang lock berjam-jam → J1 selalu skip. Perbaikan #906: J1 menunggu lock; backfill melepas lock antar batch; lock basi direbut otomatis; alarm bila J1 `SKIPPED_ARJUM_BUSY` > 2× berturut-turut. B6 "backfill mengalah" ternyata **pagar anggaran, bukan pagar lock**.
3. **Batas kuota ganda:** `DEFAULT_DAILY_LIMIT = 12060` (konstanta) dan `getConfiguredDailyQuota()` lama **mendahulukan header `x-ratelimit-limit`** di atas `ARJUM_DAILY_LIMIT` → satu respons berheader 12.060 bisa menurunkan batas efektif. Angka 12.060 yang sempat dilaporkan Roo berasal dari **proses lokal tanpa `.env`, bukan VPS** (Roo mengoreksi diri). Perbaikan #906: satu sumber batas (`ARJUM_DAILY_LIMIT`), `plan_limit=18080 effective=18080`.

Yang **belum terbukti:** penyebab cek silang J2 gagal 20/20 (19 Okt) dan rc=6 (21 dan 22 Okt). Roo menulis "selisih harga Yahoo vs Arjum > 0,5%" tetapi **belum memberi contoh 3 saham (harga Yahoo, harga Arjum, selisih)**. Endpoint candle **tidak** kena guard jam operasional. Ini item terbuka (Bagian 11).

---

## 5. Daftar PR dan commit Roo (semua ke `feat/daytrade-screener-v1`, bukan `main`)

| PR | Merge | Isi |
|---|---|---|
| #891 / #896 | (19 Okt) | broksum all + foreign (**membawa guard** `a6cf3265`) |
| #897 | | skill antislop di repo (`.claude/skills/antislop*`) |
| #898 | | perbaikan DayTrade |
| #899 | `d6a7ac9d` | DayTrade full universe (800+ saham), deploy 20 Okt |
| #900 | | docs |
| #901 | `c7e2b46d` | **keamanan:** `/data/*` default-tolak + allowlist `bandarmologi-intel-indexes/latest_<range>.json`; login throttle di aplikasi (5 gagal/15 mnt per akun+IP, 30/15 mnt per IP, 429 pada ke-6, pesan seragam) |
| #902/#903/#904 | `cb36ab95` | job harian: log jenis kegagalan, **pemutus sirkuit** (20 pertama gagal semua atau >50% dari 50 pertama → hentikan, exit ≠ 0, alarm), **pagar Arjum bersama** (lock), cek silang gagal tidak memicu fallback massal (tunda ke 23:30), IHSG langkah mandiri + alarm 17:30, backfill mengalah (anggaran = sisa − kebutuhan harian − cadangan retry 10%), marker hanya bila data benar-benar tersimpan |
| #905 | `b96e7648` | lanjutan: `0022ba5c` cron broker-hunter-indexes; `27be0e7f` cooldown per ticker + timeout 8 dtk + log alasan berbatas-laju (menggantikan `lastHttpBridgeFailure` global 60 dtk) ; `4640cf01` alarm umur backlog; `ba63c6e8` `x-user-id` hanya dengan bendera dev (prod `NODE_ENV=production`, header palsu → 401); `79fa655f` C1 XFF/proksi tepercaya; `73035e99` + `61281b19` C2 HSTS `max-age=300` + CSP Report-Only (`report-uri /api/csp-report`); `464646de` C3 mode kering lifecycle Telegram; `c7b3c245` C4 Bandarmologi publik di-cache + 30 req/menit/IP, anonim hanya baca disk. `test:full` 724/724 |
| #906 | `0ea0206c` | darurat: backfill dijeda (`7476a7e4`, `dc21140e`), satu sumber kuota, J1 menunggu lock, pemutus sirkuit mencatat limit/terpakai/sisa, alarm uji `sent:true`. CI lulus. Tanpa restart |
| #907 | `7fc6aa13` | cron pengejaran akhir pekan, lantai akhir pekan `min(1.500, 10% retry + 100 web)` |
| #908 | `8fafec5a` | pengejaran mengisi **empat jenis** (ALL → F → akumulasi → insider), `missingForDate()` per jenis, `--skip-f`; test 9 lulus |
| #909 | `64e32cff` (`7baad443` cron) | `bypassMarketGuard:true` di `tools/run-daily-broker-update.js` (ALL+F) dan `tools/catchup-missing-dates.js`; 23 Okt ditambah ke pengejaran; `last_success_at` tidak dicap run 0-data; `recordZeroSaved()` → alarm `zero_saved`; test 7 lulus |
| #910 | (draft) | **bukan Roo**: redesign UI (Claude Code). **Jangan merge** sebelum lengkap |

**Bukti uji guard (19:40 WIB, HEAD `64e32cff`):** A bypass hari ini → `200 brokers=79`; B tanpa bypass tanggal 22 Okt (lewat) → `200 brokers=74` (jadi pengejaran akhir pekan tidak kena guard); C jalur web hari ini tanpa bypass → `400 "Di luar jam operasional bursa BEI."` (tetap diblokir, sengaja).

---

## 6. Kuota Arjum dan anggaran

- **Batas harian: 18.080** (`ARJUM_DAILY_LIMIT`): 1.000 gratis + 17.080 plan Supporter. Reset **00:00 WIB**. Dashboard Arjum Jumat sore: terpakai 13.847, sisa 4.233, total bulan 138.808, plan "berakhir dalam 26 hari" (±18 Nov). Riwayat: 12.060 → +6.020 = 18.080 (18 Okt).
- **Setelah Supporter berakhir:** 1.000 gratis + 5.000 yang dibeli tiap awal bulan = **±6.000/hari**. **Perbarui `ARJUM_DAILY_LIMIT` pada hari itu.** J1 3.500 + J2 + IHSG ≈ 4.450 masih muat (sisa ±1.550 untuk web/retry); **backfill riwayat tidak muat**.
- **Kebutuhan:** J1 per tanggal ≈ 3.464 (ALL 962 + F 834 + akumulasi 834 + insider 834); dengan J2 (21–962) dan IHSG (1) ≈ 3.490–4.450. Pengejaran memakai satuan **sel** (emiten × jenis): 22/21/20 Okt masing-masing 3.880, 19 Okt (sisa) 3.680, 23 Okt 3.880.
- **Penjaga:**
  - **Lantai hari kerja untuk backfill/pengejaran:** `floor = 4.940` (≥ J1+J2+IHSG + retry). **Tidak berlaku untuk J1.**
  - **Lantai akhir pekan** (tanpa J1/J2): `floor = min(1.500, 10% retry + 100 web)` → `weekend_floor=1500`, `weekend_spendable=16580`.
  - Pemutus sirkuit menulis di log: batas, terpakai, sisa. Terpakai dihitung **lintas proses**.
- **Posisi Jumat 23 Okt:** 20:31 terpakai 15.295 (sisa ±2.785). Pass 23:30 memakai sisa itu; **angka Hari Ini di dashboard harus mendekati 18.000 sekitar 23:50** (cek sebelum 00:00 karena counter reset).
- **Alarm proaktif (usulan Roo, belum ada):** kirim peringatan saat `remaining < floor`, bukan hanya saat memutus.

---

## 7. Status data saat ini (perbarui setelah pass 23:30 dan pengejaran)

| Tanggal | Status | Catatan |
|---|---|---|
| ≤ 16 Okt | Lengkap (acuan hari baik: 16 Okt) | Domestik = ALL − F dihitung. Cakupan asing (F) hanya ±13,79% dari 962 emiten × hari |
| 19 Okt | **Sebagian**: hanya 50 emiten punya ALL/F/akumulasi/insider; sisa ±920 | Dua hitungan berbeda di laporan: pending ALL = 920 dari 970 vs antrean H-1 `pending=871/962 reason=still_young`; **selaraskan** |
| 20, 21, 22 Okt | **Nol** (marker `2026-10-20/21/22.json` tidak ada) | Dikejar Sabtu/Minggu |
| 23 Okt | **Sebagian**: run manual 146/146/146/145; pass 23:30 melanjutkan | Marker `2026-10-23.json` sempat `complete:false, done:0, errors:20` dari run 16:30; harus dibenahi oleh run baru |
| Candle 962 saham (Yahoo) | Perlu dikonfirmasi **20, 21, 22, 23 Okt tertulis** untuk semua saham | J2 16:40 rc=6 pada 21 dan 22 Okt (cek silang). 19 Okt: ±85 saham tertinggal. **Minta bukti** |
| IHSG | Bar ada setiap hari 13–22 Okt (500 → 501 bar pada isi ulang 19 Okt; verifikasi 23 Okt) | |
| 10 saham uji (BBCA, BRPT, BBRI, MEDC, ADRO, BUMI, BMRI, TPIA, BBNI, TLKM) | Masing-masing 199 file, 80 file sejak 30 Jun, **berakhir 19 Okt** (belum 22/23 Okt) | Syarat Fase 2 gabungan: 80 hari terpenuhi tetapi tanggal terkini belum |
| Indeks turunan | `broker-hunter-indexes` kini dibangun 22:45 (mtime 12 Sep → 23 Okt 12:57); `bandarmologi-intel-indexes` perlu dibangun ulang setelah pengejaran | |

**Verifikasi per tanggal (wajib setelah pengejaran):** jumlah file per tipe dibanding 16 Okt; marker (`complete`, `total`, `pending`); 10 saham uji berakhir di tanggal terbaru; indeks turunan dibangun ulang; tidak ada file yang ditimpa tanggal lain (idempoten); `state.json` dicadangkan.

---

## 8. Rencana ke depan (jadwal dan syarat)

### 8.1 Pengejaran akhir pekan
- **Sabtu 24 Okt 00:07** dan **Minggu 25 Okt 00:07**: tanggal urut 23, 22, 21, 20, 19; **batch 50**; **berhenti bila >20% gagal**; setiap emiten mengisi ALL → F → akumulasi → insider (berhenti untuk emiten itu bila satu jenis gagal); lantai akhir pekan 1.500; **kuota J1 hari kerja tidak boleh dikurangi**; idempoten.
- **Kebutuhan sebelum 23:30:** 19.200 sel vs 16.580 tersedia/hari → butuh dua hari. Setelah pass 23:30 (23 Okt sebagian tersimpan) **hitung ulang**.
- **Cek:** Sabtu pagi (apakah cron berjalan, berapa tersimpan), Minggu pagi, Senin pagi (verifikasi 5 butir Bagian 7).

### 8.2 Backfill F saham likuid (BELUM dihidupkan)
- **Cakupan:** 509 saham likuid (turnover rata-rata ≥ Rp 1 M/hari dari turnover candle yang sama dengan backfill) × **193 hari bursa** (2 Jan–23 Okt) = **98.237 sel**; sudah ada 55.618; **sisa 42.619 request** ≈ 4 hari kuota hari kerja (13.140/hari) atau 3 hari akhir pekan (16.580). 213 saham likuid belum punya direktori F (direktori F sekarang 296).
- **Persetujuan bersyarat pemilik:**
  - Mulai **Minggu 25 Okt 00:07 hanya bila** pengejaran Sabtu **tuntas dan terverifikasi** dan J1 Jumat terbukti **menyimpan** data (sudah terbukti 20:31).
  - Bila belum: mulai **Senin 26 Okt malam setelah J1 Senin 16:30 terbukti** menyimpan.
  - Urutan: saham likuid dulu (turnover menurun), batch 50, berhenti bila >20% gagal, **lepas lock antar batch**, tidak melewati lantai (akhir pekan 1.500 / hari kerja 4.940), J1 selalu didahulukan.
  - **Laporan pagi:** request terpakai, sel F terisi, sisa, perkiraan tuntas.
  - **Harus selesai sebelum ±18 Nov** (sesudahnya jatah backfill ±1.500/hari = 29 hari).
- **Keputusan pemilik yang masih terbuka:** kurangi cakupan F harian ke 300–500 emiten likuid (hemat ±1.000–1.600/hari); backfill riwayat setelah Supporter: jeda permanen atau mingguan.

### 8.3 Tanggal penting
| Tanggal | Kejadian |
|---|---|
| Jum 23 Okt 23:30 | Pass J1 + J2 + IHSG; lapor hasil |
| Sab 24 Okt 00:07 | Pengejaran #1 |
| Min 25 Okt 00:07 | Pengejaran #2 (atau mulai backfill F bila syarat terpenuhi) |
| Sen 26 Okt 16:30 | **J1 pertama hari kerja penuh** dengan perbaikan; bukti wajib (request terpakai, tersimpan per tipe, status akhir) |
| ±17–18 Nov | Supporter berakhir → kuota ±6.000/hari → **perbarui `ARJUM_DAILY_LIMIT`** |

---

## 9. Keamanan server: yang sudah dideploy

| Item | Status | Bukti |
|---|---|---|
| `/data/*` publik | **Diperbaiki:** default-tolak (404), allowlist hanya `bandarmologi-intel-indexes/latest_<range>.json`; path traversal ditolak | #901 `c7e2b46d`. Dua akses non-probe ke file data dalam 7 hari (screener-latest.json, ringkasan broker BBCA), tidak ada unduhan massal |
| Login tanpa batas percobaan | **Diperbaiki** (di aplikasi, tanpa reCAPTCHA) | 5 gagal/15 mnt per (akun, IP); 30/15 mnt per IP; 429 pada ke-6; pesan seragam; **hitungan di SQLite — `LOGIN_THROTTLE_DB` harus diarahkan ke path persisten (manual pemilik)** |
| XFF palsu melewati batas pendaftaran | **Diperbaiki** (`79fa655f`) | IP klien hanya dari rantai proksi tepercaya; sebelum: 10 XFF palsu lolos; sesudah limiter `allowed_of_10=8` |
| Header keamanan | **Sebagian** | HSTS `max-age=300` (naikkan bertahap lewat `SECURITY_HSTS_MAX_AGE`); CSP **Report-Only** (belum ditegakkan); X-Frame-Options/Referrer-Policy/Permissions-Policy dari nginx; `nosniff` dari aplikasi |
| Bandarmologi publik menguras kuota Arjum | **Diperbaiki** (`c7b3c245`) | anonim hanya baca disk (`from_cache`), 30 req/menit/IP; live hanya untuk sesi; jalur Arjum `getBandarmologiData` flow F/D (3 request) dan single-date (3 request) |
| Header `x-user-id` di `money-management-handler` | **Diperbaiki** (`ba63c6e8`) | `NODE_ENV=production`; header palsu tanpa sesi → 401 (sebelum dan sesudah restart) |
| Lifecycle Telegram (kick anggota kedaluwarsa) | **Terverifikasi tidak terjadwal**; mode kering | 5 anggota dipindai, 1 kedaluwarsa (akun uji `userbot123`, kadaluarsa 17 Sep, voucher); tidak ada yang dikeluarkan; **keputusan pemilik** menjadwalkan atau tidak |
| Login Google | **DIBATALKAN pemilik** | tombol akan dihapus di UI; tidak ada OAuth |

**Masih terbuka (usulan Roo, belum diubah):** `session_version` per akun (pencabutan sesi; sesi sekarang HMAC stateless 10 jam), mode pemeliharaan juga ditegakkan di API data, `SECURITY_EVENT_PEPPER` + `SECURITY_GUARD_MODE` (shadow lalu enforce), bridge harga live in-process.

---

## 10. Langkah manual pemilik (belum dikonfirmasi selesai)

- [ ] **Cek Telegram admin:** apakah alarm pemutus sirkuit 16:30 hari ini benar-benar masuk (log menulis `[ALERT]`; alarm uji `sent:true`; pengiriman alarm asli belum dikonfirmasi pemilik).
- [ ] Purge cache **Cloudflare** `/data/*` (kecuali indeks sah); pastikan `/data/screener-latest.json` di domain publik **404**.
- [ ] Atur `LOGIN_THROTTLE_DB` ke path persisten.
- [ ] Tinjau pelanggaran CSP Report-Only setelah 24 jam (`node tools/csp-violations-report.js`); naikkan `SECURITY_HSTS_MAX_AGE` bertahap.
- [ ] Putuskan C3 (jadwalkan lifecycle Telegram atau tidak; 1 akun uji kedaluwarsa).
- [ ] Salin `AUDIT_ALUR.md` dan `AUDIT_HALAMAN.md` (dari folder redesign) ke `backtest/arjum-audit/claude-code-audit/` (jangan di-commit).
- [ ] Cek dashboard Arjum Jumat ±23:50 ("Hari Ini" mendekati 18.000).
- [ ] ±18 Nov: perbarui `ARJUM_DAILY_LIMIT` ke ±6.000.
- [ ] Putuskan: cakupan F harian 300–500 emiten? backfill riwayat dijeda setelah Supporter?

---

## 11. ANTREAN PEKERJAAN ROO (belum dikerjakan / perlu diaudit)

### 11.1 Tinjauan perubahan server dari redesign (sebelum merge PR #910)
1. `api/sector-hot.js` `action=tape` (publik, cache 60 dtk, baca store riwayat harian + `IHSG.json`, bukan live); `lib/price-tape.js`; `market_calendar` di market-breadth; `lib/market-intelligence-engine.js` (breadth tidak mengarang); `action=broker-consistency&ticker=X` (publik, baca arsip broksum maks 20 file, cache privat 300 dtk, tanpa Arjum): **samakan gerbang dan batas laju dengan Bandarmologi (30 req/menit/IP), pastikan tidak membuka data premium**. Menyentuh `api/` → satu restart di luar jam bursa.
2. **CSP Report-Only mencatat `unpkg.com`** (library chart). Bila CSP ditegakkan chart tidak termuat → self-host Lightweight Charts atau allowlist.
3. **`lib/trusted-proxy.js`:** `CF-Connecting-IP` dipercaya saat peer proxy lokal → batas laju bisa dilewati bila origin terjangkau tanpa Cloudflare. Saran: percayai `CF-Connecting-IP` hanya bila peer ada di rentang IP Cloudflare; bila dari nginx lokal pakai `X-Real-IP` yang diisi nginx; atau batasi origin dengan firewall hanya ke rentang Cloudflare. **Verifikasi dan perbaiki** (prioritas sedang-tinggi karena login throttle bergantung pada IP).
4. Catatan Admin (fitur baru): tabel `admin_notes`, `admin_note_edits`, endpoint, job status, tes 403 non-admin (lihat spesifikasi di dokumen redesign §5d).

### 11.2 Item hasil pengejaran data
5. **Buktikan klaim cek silang J2** (selisih Yahoo vs Arjum > 0,5%) dengan 3 saham contoh; selidiki rc=6 pada 21–22 Okt; pastikan candle 20–23 Okt untuk 962 saham tertulis.
6. Pastikan **Target Date J1 terkunci** (23 Okt) walau pass 23:30 melewati 00:00.
7. Selaraskan hitungan backlog 19 Okt (920/970 vs 871/962).
8. Verifikasi `bandarmologi-intel-indexes` dan `broker-hunter-indexes` dibangun ulang setelah pengejaran.
9. Tambahkan test regresi: **J1 EOD tidak boleh diblokir guard jam bursa** (sudah di #909) dan alarm "0 data tersimpan".

### 11.3 Bug/audit yang disebut pemilik ("masih banyak bug yang harus dibenerin dulu")
Untuk tiap area di bawah: **audit read-only dulu**, laporan, baru usulan perbaikan (jangan mengubah tanpa izin).

| Area | Yang sudah diketahui | Yang harus diaudit |
|---|---|---|
| **Jadwal (semua cron)** | Peta di Bagian 3; crontab 129 baris; banyak job bertabrakan di VPS 1 core (J1, J2, backfill, DayTrade producer) | zona waktu server vs WIB; tabrakan jam; job yang tidak ada di crontab (lifecycle Telegram); job yang diam-diam rc=0 saat gagal |
| **Screener DayTrade** | Full universe 800+ saham (PR #899) deploy 20 Okt; producer `2,17,32,47 9-15` | jumlah scan sebenarnya tiap putaran (lihat `PROMPT_CEK_JUMLAH_SCAN`); hasil full-universe; sumber harga live (Yahoo via cache server); kasus `idx-suspension 403`, BMTR harga live |
| **Swing Konglo dan Non-Konglo** | Pra-cek 21:30 sempat ter-skip sebelum 20 Okt | apakah scan malam berjalan, jumlah saham dipindai, hasil `data/screener-latest.json`, kesegaran |
| **FastWatcher** | tidak diaudit tuntas | cron/proses, sumber harga, notifikasi, kegagalan |
| **Notifikasi Telegram** | alarm J1 uji `sent:true`; `isTelegramEnabled=true` | pengiriman nyata, pesan ganda, laju, error |
| **Gate Telegram** (siapa menerima broadcast) | pengguna belum disetujui/kedaluwarsa tidak boleh menerima broadcast berbayar; lifecycle tidak terjadwal; 1 akun uji kedaluwarsa | verifikasi gerbang di kode dan data nyata; link undangan grup (sekali pakai?); pencabutan akses |
| **Cron pengambilan data Arjum** | J1/J2/IHSG/backfill/pengejaran (Bagian 3) | apakah semua berjalan dan menyimpan setiap hari bursa; marker; alarm |
| **Broksum asing (F)** | cakupan 13,79%; 509 saham likuid; rencana backfill (Bagian 8.2); sempat ada file asing palsu (lihat `PROMPT_CEK_FILE_ASING_PALSU`) | validitas file F, validator `.done` 1% + top-100, anomali `_eod/*.anomali.json` |
| **Akumulasi broker** | lokal dihitung dari broksum; paritas 96–97% (< 99%) → Fase 2 gabungan dilewati | paritas, kebenaran, jendela, sumber |
| **Candle saham + IHSG dari Yahoo** | 962 saham Yahoo 16:40 dan 23:30 + cek silang 20 saham; IHSG 1 request Arjum | cek silang gagal, selisih harga, saham tertinggal, penyesuaian split/dividen, hari libur |
| **`vps_local_cache_stale`** | cooldown per ticker, timeout 8 dtk, log alasan sudah ditambah (#905); bridge in-process baru usulan | frekuensi sekarang, dampak ke pengguna |
| **CI `browser`** | gagal sejak 19 Okt (assertion Portfolio UI) | perbaiki atau dokumentasikan |
| Lainnya | `STATUS_GABUNGAN.md`: Fase 1A/1B/1C selesai, Fase 2 dan 3 dilewati; `REPORT_CEK_SEMUA_CRON_20261019.md` nomor #1,#2,#3,#5 diperbaiki (`PROMPT_PERBAIKI_DARURAT`), #4 bersyarat, **#7–#10 tidak dikerjakan** | baca ulang #4 dan #7–#10 dan putuskan; penyimpanan VPS dan kompresi (setelah backfill); simulasi asing + LPM (menunggu cakupan F ≥ 90%) |

### 11.4 Prompt yang ditahan
`PROMPT_LANJUTAN_GABUNGAN`: Fase 2 (akumulasi lokal, paritas < 99%) dan Fase 3 (simulasi aliran asing + LPM, cakupan F < 90%) **dilewati**; kirim ulang setelah data terkejar dan backfill F selesai.

---

## 12. Laporan Roo yang ditunggu (setelah pass 23:30)

1. **Target Date** terkunci 2026-10-23 sejak awal.
2. **Candle** 20, 21, 22, 23 Okt untuk 962 saham tertulis (J2 16:40 dan 23:30) dan **bukti klaim >0,5%** dengan 3 saham contoh.
3. **Request terpakai, tersimpan per tipe (ALL, F, akumulasi, insider), jumlah emiten tuntas, status akhir.**
4. **Hitung ulang kebutuhan Sabtu–Minggu** dan konfirmasi cron pengejaran masih terpasang (`catchup_lines=2`, `active_backfill_lines=0`).
5. Apakah **alarm Telegram nyata** diterima pemilik pukul 16:30 (jawaban pemilik).

---

## 13. Katalog prompt yang pernah ditulis (semua di `/home/claude/` dan folder prompt pemilik)

| Prompt | Tujuan | Status |
|---|---|---|
| `PROMPT_AUDIT_AUTO-CUAN_READONLY` | audit menyeluruh read-only (mode Architect/Ask) | selesai (`audit/AUTO_CUAN_AUDIT.md`) |
| `PROMPT_BACKTEST_LPM_BRPT`, `PROMPT_PERBAIKAN_BACKTEST_BRPT`, `PROMPT_AMBIL_CSV_VPS_BRPT` | paritas LPM dan backtest BRPT | selesai (`backtest/brpt-lpm/`) |
| `PROMPT_CEK_DONE_DETAILS`, `PROMPT_COLLECTOR_DONE_DETAILS`, `PROMPT_AGG_V2_DONE_DETAILS` | endpoint done-details untuk LPM transaksi | selesai (`backtest/lpm-done/`) |
| `PROMPT_INDIKATOR_BROKSUM`, `PROMPT_CEK_BROKSUM` | indikator Bandar dari broksum, kuota | selesai |
| `PROMPT_AUDIT_JOB_HARIAN_ARJUM`, `PROMPT_PETA_CRON_ARJUM`, `PROMPT_HEMAT_KUOTA`, `PROMPT_IMPLEMENTASI_BROKSUM_HEMAT` | audit job, peta cron, hemat kuota (all + F, domestik dihitung) | selesai (`REPORT_AUDIT_JOB_HARIAN.md`, dll.) |
| `PROMPT_BACKFILL_BROKSUM_ASING`, `PROMPT_CEK_CRON_ASING_DAN_RANGE`, `PROMPT_CEK_FILE_ASING_PALSU`, `PROMPT_VALIDASI_ARSIP_BROKSUM`, `PROMPT_CEK_VALIDATOR_SEBELUM_SENIN` | backfill asing sejak 2 Jan, validasi arsip, validator `.done` | selesai (laporan di `backtest/arjum-audit/`) |
| `PROMPT_MERGE_KE_DAYTRADE`, `PROMPT_DEPLOY_BROKSUM` | merge `feat/broksum-all-foreign` → `feat/daytrade-screener-v1`; deploy 18 Okt | selesai |
| `PROMPT_CEK_CANDLE_IHSG`, `PROMPT_CEK_IHSG_CANDLE_KUOTA`, `PROMPT_KUOTA_RESERVE_IHSG`, `PROMPT_IHSG_SEKARANG_DAN_BACKFILL`, `PROMPT_CEK_PASCA_DEPLOY_V2` | candle/IHSG, cadangan kuota, kuota +6.020, pasca deploy v2 | selesai (`REPORT_IHSG_BACKFILL_V2.md`, `REPORT_CEK_PASCA_V2.md`) |
| `PROMPT_CEK_SEMUA_CRON` → `PROMPT_PERBAIKI_DARURAT` | kesehatan semua cron (19 Okt) → perbaikan #1–#3,#5 | selesai sebagian (#4 bersyarat, #7–#10 belum) |
| `PROMPT_CEK_JUMLAH_SCAN`, `PROMPT_DAYTRADE_SCAN_PENUH` | jumlah scan; DayTrade full universe + scan malam ter-skip | selesai (#899) |
| `PROMPT_CEK_PIPELINE_ARJUM` | audit darurat pipeline (read-only) | selesai (`REPORT_CEK_PIPELINE_ARJUM_20261019.md`) |
| `PROMPT_KEAMANAN_URGENT` | `/data/*` + login throttle | selesai, deploy 20 Okt |
| `PROMPT_ISI_ULANG_19OKT_DAN_PERKUAT_JOB` | akar 921/921, perkuat job, isi ulang 19 Okt | A,B selesai; **C (isi ulang) belum tuntas** |
| `PROMPT_PERBAIKAN_LANJUTAN_22OKT` | status, cron broker-hunter, vps_local_cache_stale, alarm backlog, NODE_ENV, keamanan sedang | selesai (#905) |
| `PROMPT_DARURAT_J1_BERJALAN_KEMBALI` | J1 hidup lagi, jeda backfill, kuota satu sumber, lock | A,B selesai (#906–#909); C berjalan (pengejaran) |
| `PROMPT_LANJUTAN_GABUNGAN`, `PROMPT_SIMULASI_FOREIGN_LPM`, `PROMPT_STORAGE_DAN_KOMPRESI` | akumulasi lokal, simulasi asing+LPM, kompresi | **ditahan** (menunggu data) |
| `SETUP_CLAUDE_CODE.md` | setup redesign di Claude Desktop (Local) | selesai; sekarang dilanjutkan di Antigravity |

---

## 14. Cara menulis prompt yang benar untuk Roo/agen lain

**Struktur wajib:**
1. Judul + **mode** (Code/Architect/Ask) + kapan dikirim + tenggat jam.
2. Blok **persetujuan pemilik** (apa yang disetujui dengan mengirim prompt; yang di luar itu dilarang).
3. **Konteks** (bukti dari laporan sebelumnya, bukan dugaan).
4. **Aturan keras** (Bagian 2, ringkas).
5. Bagian **A = baca-saja** (diagnosa, nol request Arjum), **B = perubahan terbatas** (satu commit per butir + test + PR + merge + pull + restart bila perlu + jalur kembali), **C = pekerjaan data dengan pagar** (anggaran, batch kecil, berhenti bila >20% gagal, idempoten, verifikasi), **D = usulan saja** (tidak diubah).
6. **Laporan:** nama file `REPORT_<TOPIK>_<TANGGAL>.md`, isi berurutan, bukti per klaim.

### Contoh A: pengecekan read-only
```text
# PROMPT: Cek <topik> (read-only) · Roo Code
> Mode Code tetapi READ-ONLY penuh. Jangan ubah kode, crontab, .env, data; jangan restart; 0 request Arjum.
## Aturan: tidak mencetak .env, kunci, token, IP VPS, lokasi kunci. Kutip baris log sebagai bukti.
## A. Pertanyaan (jawab dengan bukti):
1. <pertanyaan terukur, mis. "J1 hari ini: berjalan? request terpakai? tersimpan per tipe?">
2. ...
## Laporan: backtest/arjum-audit/REPORT_<TOPIK>_<TANGGAL>.md, lalu ringkas di chat: temuan berurut dari paling berbahaya, apa yang tidak diketahui, usulan (tanpa mengubah).
```

### Contoh B: perbaikan dengan persetujuan
```text
# PROMPT: Perbaiki <masalah> · Roo Code
> Dengan mengirim ini pemilik menyetujui: <daftar tepat>. Di luar itu dilarang.
## B1 <perubahan>: file/fungsi, perilaku yang diinginkan, test yang harus ada. Satu commit.
## Alur: branch fix/<nama> dari feat/daytrade-screener-v1 → npm run test:full → PR → merge → VPS git pull --ff-only → restart HANYA bila api/ berubah, sebelum 08:45 atau setelah 16:15 WIB → cek health 200.
## Jalur kembali: tulis perintah siap tempel (git revert + pemulihan crontab + restart).
## Bukti: tampilkan baris log/hitungan sebelum dan sesudah. Jangan menulis "sudah terkirim/berjalan" tanpa bukti.
```

### Contoh C: pekerjaan data dengan pagar anggaran
```text
# PROMPT: Isi ulang <tanggal/jenis> · Roo Code
## Hitung anggaran dulu dan tulis: sisa kuota, kebutuhan J1+J2+IHSG hari itu, retry 10%, cadangan web, kebutuhan isi ulang (sel = emiten × jenis). Kalau tidak muat, pecah per hari, jangan memakai kuota J1.
## Eksekusi: terbaru dulu, batch 50, berhenti bila >20% gagal, idempoten, cadangan state.json dulu, lock Arjum dilepas antar batch.
## Verifikasi: jumlah file per tipe vs hari baik, marker (complete/total/pending), 10 saham uji berakhir di tanggal terbaru, indeks turunan dibangun ulang.
## Lapor: jadwal kejar (tanggal+jam), hasil per tanggal, sisa kuota.
```

### Contoh D: audit area bermasalah (mis. FastWatcher / gate Telegram)
```text
# PROMPT: Audit <FastWatcher | gate Telegram | Swing Konglo/Non-Konglo | candle Yahoo> (read-only)
## Petakan: proses/cron yang menjalankan, file kode, sumber data, jadwal, keluaran, penerima.
## Cek dengan bukti: berjalan tiap hari bursa? gagal diam-diam (rc=0)? jumlah saham yang diproses vs 962? data terakhir vs hari bursa terakhir? pengiriman nyata (Telegram: status kirim, bukan asumsi)? gerbang akses benar (siapa yang menerima)?
## Keluaran: tabel temuan (BUG / RISIKO / OK), penyebab (file:baris atau job), usulan perbaikan + perkiraan kuota, perlu restart atau tidak. JANGAN memperbaiki; tunggu persetujuan.
```

**Larangan prompt:** jangan menempel kunci/IP/lokasi kunci/isi `.env`; jangan "perbaiki semuanya"; jangan tanpa titik berhenti; jangan menyuruh deploy tanpa jalur kembali.

---

## 15. Pelajaran (supaya tidak terulang)

1. **Laporan Roo bisa terlalu optimis.** Contoh: "J1 semua pass" (padahal tidak berjalan 20–22 Okt), alarm "terkirim" (tidak terbukti), "backlog bergerak" (871 pending tidak berubah), tabel pengejaran hanya menghitung satu jenis (970/tanggal alih-alih 4 jenis), angka 12.060 dari proses lokal. **Wajib bukti:** baris log, hitungan file per tipe, kuota sebelum/sesudah, status pengiriman.
2. **Perubahan "perilaku guard" bisa mematikan job harian diam-diam.** Selalu uji job EOD **di luar jam bursa** (jam sebenarnya J1 berjalan) setelah menyentuh `lib/arjum-client.js`. `exit code 0` pada kegagalan = tidak ada alarm; sekarang ada alarm 0-data.
3. **Jangan `waitMs:0` untuk job harian.** Lock harus bisa menunggu atau direbut bila basi.
4. **Satu sumber kebenaran untuk batas kuota** (`ARJUM_DAILY_LIMIT`), bukan header atau konstanta.
5. **Backfill tidak boleh memegang lock sepanjang run** atau menguras kuota; harus mengalah ke job harian.
6. **Restart hanya di luar jam bursa**; jeda Jumat 11:30–14:00 **bukan** jendela restart.
7. **Marker harian hanya ditulis bila data benar-benar tersimpan**; run 0-data tidak boleh dihitung sukses.
8. **Jangan menempel log test mentah:** mencetak alamat/kunci VPS.
9. **Merge ke `feat/daytrade-screener-v1` = otomatis live setelah VPS di-pull.** Karena itu redesign (PR #910) ditahan sebagai draft.
10. **Cek jam sebelum menjadwalkan:** J1 slot `30 23` dan J2 `30 23` bertumpuk; VPS 1 core.

---

## 16. Cara memulai sesi baru (agen pipeline)

1. Baca: file ini → `REPORT_DARURAT_J1_20261023.md` → `REPORT_PERBAIKAN_LANJUTAN_20261022.md` → `REPORT_ISI_ULANG_19OKT_20261020.md` → `REPORT_KEAMANAN_20261020.md` → `STATUS_GABUNGAN.md`.
2. Pastikan branch lokal = `feat/daytrade-screener-v1` terbaru; **jangan** mengerjakan di `redesign/v2`.
3. Pengecekan awal (read-only lewat SSH pemilik): `crontab -l`, `pm2 list`, `tail` log J1/J2/backfill, marker `YYYY-MM-DD.json` 19–23 Okt, dashboard kuota (angka dari pemilik), `j1-skip-alarm.json`.
4. Tanyakan pemilik sebelum mengubah apa pun. Tulis **[DARURAT]** bila ada yang rusak dan masih berlangsung.
5. Kirim laporan berbukti, lalu tunggu.

---

## 17. Glosarium
- **J1/J2/IHSG**, **ALL/F/D**, **LPM**, **EOD/T-1**: lihat dokumen redesign Bagian 17.
- **Sel:** satu emiten × satu jenis × satu tanggal (1 request).
- **Pemutus sirkuit:** berhenti bila 20 request pertama gagal semua atau >50% dari 50 pertama gagal; exit ≠ 0; alarm Admin Console + Telegram admin.
- **Guard jam operasional:** penolakan 400 untuk permintaan broker-summary `noFallback/forceFresh` di luar 09:00–16:00; **dilewati hanya oleh J1 EOD dan pengejaran** lewat `bypassMarketGuard:true`.
- **Karantina:** `_quarantine-*`; file yang salah dipindah, tidak dihapus.
- **Supporter:** plan Arjum 17.080 request/hari tambahan, berakhir ±18 Nov.
