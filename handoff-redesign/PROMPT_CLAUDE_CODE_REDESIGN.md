# PROMPT: Implementasi Redesign v2 Auto-Cuan + audit bug dan data per halaman (Claude Code)

> Tempel seluruh isi di bawah garis ke Claude Code, di folder repo `auto-cuan`.
> **Langkah pertama (sesi cloud maupun lokal):** ambil folder desain dari branch `handoff/redesign-v2` tanpa meng-commit-nya:
> ```bash
> git fetch origin handoff/redesign-v2
> git checkout origin/handoff/redesign-v2 -- handoff-redesign
> git reset -q handoff-redesign
> echo "handoff-redesign/" >> .git/info/exclude
> ```
> Folder ini **tidak boleh** ikut ter-commit di branch kerja.
> `feat/broksum-all-foreign` (PR #891/#896) dan perbaikan DayTrade (PR #898) **sudah** di-merge ke `feat/daytrade-screener-v1`. Langsung mulai.
> **Folder `prompts-roo/` bukan untukmu.** Itu tugas Roo Code untuk data dan VPS. Jangan dijalankan.

---

## Peran dan sumber

Kamu mengimplementasikan desain **Auto-Cuan Redesign v2** ke repo asli. Sekaligus kamu memeriksa dan memperbaiki bug serta masalah data di setiap halaman yang disentuh.

Sumber, dari yang paling berwenang:
1. `handoff-redesign/HANDOFF_REDESIGN_V2.md`: spesifikasi, keputusan final, dan daftar yang **bukan** spesifikasi.
2. `handoff-redesign/design/project/*.dc.html`, `ac.css`, `motion.js`: sumber visual dan perilaku. Buka lewat `handoff-redesign/design/README.md`.
3. `handoff-redesign/screenshots/`: tampilan target laptop dan HP, mode terang dan gelap (`gelap-1366/`, `gelap-390/`).
4. `docs/DESIGN-SYSTEM.md`, `public/ui-theme.css`, dan `REDESIGN-LOG.md` di repo. **Petakan ke sini, jangan buat sistem kedua.**

## Alat wajib

- **codebase-memory-mcp:** kalau tool-nya tersedia (cek dengan `/mcp`), ketik "Index this project" sekali di awal. Kalau tidak tersedia, lanjut tanpa itu dan catat di laporan. Setelah itu, cari fungsi, route, dan pemanggil lewat graf ini **sebelum** membuka file, lalu baca file hanya bagian yang perlu. Tujuannya hemat token.
- **antislop:** jalankan `npx antislop-ai --mode during` sekali, supaya tidak ditanya mode setiap sesi.

## Wilayah kerja (pekerjaan data dikerjakan Roo Code)

- **Jangan mengubah pipeline data:**
  - `tools/backfill-*`, `tools/run-daily-*`, `tools/fetch-daily-candles.js`, `tools/simulate-*`;
  - `lib/arjum-*`, `lib/broksum-*`, `lib/broker-accumulation-local.js`;
  - crontab dan `.env`.

  Kalau menemukan bug di sana, tulis di laporan saja.
- **Sebelum Fase 1, baca laporan di `backtest/arjum-audit/`:** `REPORT_DEPLOY.md`, `REPORT_IHSG_BACKFILL_V2.md`, `REPORT_CEK_PASCA_V2.md`, `REPORT_VALIDASI_ARSIP.md`, `REPORT_VALIDATOR_J1.md`, dan `STATUS_GABUNGAN.md`. Temuan yang sudah selesai di sana **jangan dikerjakan ulang**.
- **Yang sudah ada dan tinggal dipakai UI:**
  - candle IHSG dari disk (`data/daily-candles/IHSG.json`);
  - bar hari ini dengan `provisional:true` dan `updatedAt`;
  - Domestik "belum lengkap" (`incomplete`);
  - data asing "belum dirilis";
  - field anomali di Admin Console (`anomaly_total`, `anomaly_pct`).

## Skill wajib

- **antislop** (https://github.com/miqdadbadjuber/anti-slop):
  - Sudah ada di repo: `.claude/skills/antislop*` (PR #897). **Jangan** pakai `/plugin`; perintah itu tidak tersedia di sesi cloud.
  - Isi dial ENERGY/RHYTHM/MOTION sesuai HANDOFF §1.
  - Setiap halaman ditutup dengan laporan **Delivery Gate PASS/FAIL**.
  - Empat override sudah diputuskan pemilik di HANDOFF §2. Catat sebagai override, jangan ditanyakan lagi.
- **frontend-design**: untuk keputusan visual yang tidak tertulis di HANDOFF. Kalau masih ragu, ikuti kanvas.

## Batas keras

1. **Git:**
   - Kerjakan di branch baru `redesign/v2`, dibuat dari **HEAD `feat/daytrade-screener-v1`**. Itu branch utama pemilik dan yang jalan di VPS, dan sudah berisi pekerjaan data dari `feat/broksum-all-foreign`.
   - Roo Code masih menambah perbaikan data yang di-merge ke `feat/daytrade-screener-v1`. Sebelum melapor di Fase 4, **rebase `redesign/v2` ke HEAD terbaru `feat/daytrade-screener-v1`**, lalu jalankan ulang semua test. Kalau ada konflik di file yang sama, pertahankan logika data dari Roo; dari redesign hanya tampilannya.
   - Satu halaman atau satu fondasi = satu commit.
   - **Tidak ada push, merge, PR, deploy, `pm2 restart`, atau perubahan crontab** sebelum pemilik menulis **"deploy"**.
   - Saat "deploy": PR `redesign/v2` → merge ke `feat/daytrade-screener-v1` (**bukan** `main`) → di VPS `git pull --ff-only` → restart → cek. Merge saja tidak cukup; VPS harus ikut di-pull.
2. **Logika bisnis tidak boleh berubah karena redesign.** Ini termasuk:
   - skor dan gate screener;
   - Top 5 engine;
   - scoring bandarmologi;
   - Track Record;
   - broadcast Telegram dan FastWatcher.

   Kalau perbaikan bug menyentuh logika ini, pisahkan ke commit `fix:` sendiri dan sertakan test.
3. **Data:**
   - Tidak ada angka karangan. Data kosong ditampilkan "—", bukan 0.
   - Angka contoh di kanvas **tidak boleh** masuk ke produk.
4. **VPS:**
   - **Sesi Local (Claude Desktop / laptop pemilik):**
     - Boleh SSH ke VPS **read-only**, memakai perintah ssh yang diberikan pemilik saat sesi berjalan. Kunci tetap di laptop.
     - Jangan menyalin kunci, IP, atau perintah ssh ke file repo, commit, atau laporan.
     - Jangan pakai `StrictHostKeyChecking=no`.
     - Perintah yang boleh sama dengan daftar di bawah. Kalau perlu perintah lain, tanya dulu.
     - Dalam mode ini, `CEK_VPS_UNTUK_ROO.md` tidak perlu dibuat; hasil cek langsung ditulis di laporan.
   - **Sesi cloud:** tidak punya akses SSH ke VPS, dan kunci SSH **tidak boleh** dimasukkan ke sesi ini.
   - Semua pengecekan yang butuh VPS (file data, SQLite, log, crontab, pm2) ditulis sebagai perintah read-only di `handoff-redesign/CEK_VPS_UNTUK_ROO.md`. Pemilik mengirim file itu ke Roo Code, lalu menempel hasilnya ke sesi ini.
   - Format setiap item di file itu: nomor, tujuan, perintah read-only (`ls`, `cat`, `tail`, `grep`, `sqlite3 -readonly` SELECT, `crontab -l`, `pm2 list/describe`, `curl -s localhost`), dan hasil yang diharapkan.
   - Jangan cetak `.env`, `ARJUM_API_KEY`, kunci SSH, token, atau IP VPS.
   - Perubahan data atau konfigurasi produksi hanya lewat langkah "deploy".
   - **Situs produksi:** kalau sesi ini bisa menjangkau domain produksi, boleh diakses read-only (GET, tanpa mengirim form). Login hanya memakai akun uji dari environment variable `AC_TEST_USER`/`AC_TEST_PASS` (dan `AC_TEST_PENDING_USER`/`AC_TEST_PENDING_PASS` kalau ada). **Jangan pernah** meminta password admin di chat.
5. **Arjum:**
   - Hanya GET, **maksimal 100 request** untuk seluruh audit.
   - Kuota harian sudah dipakai backfill, jadi utamakan data yang sudah ada di disk.
6. Admin Console dan Pattern Radar hanya untuk admin. Proteksinya **di route/server**, bukan hanya disembunyikan dengan CSS.

## Fase 0 · Kenali repo dan ambil baseline

1. Petakan stack yang sebenarnya:
   - SPA di `public/index.html`;
   - modul `public/*-runtime.js`;
   - `api/`, `lib/`;
   - cara routing dan mounting halaman.

   Buat tabel **halaman kanvas → file di repo → endpoint API → sumber data di VPS** (file atau tabel SQLite).
2. Ambil screenshot baseline semua halaman yang sekarang ada, di **1440, 1024, dan 390px**, plus log error konsol per halaman. Simpan di `handoff-redesign/baseline/`.
3. Jalankan semua test yang ada dan catat hasilnya. Test yang sudah gagal sebelum kamu mulai ditandai "gagal sejak awal".

## Fase 1 · Audit per halaman (bug + data), sebelum mengubah tampilan

Untuk **setiap** halaman di HANDOFF §5, isi satu baris `handoff-redesign/AUDIT_HALAMAN.md`:

| Halaman | Bug UI | Masalah data | Penyebab (file:baris atau job) | Perbaikan | Butuh "deploy"? |
|---|---|---|---|---|---|

**Bug UI yang dicek:**
- error konsol;
- tombol dan tautan mati;
- overflow horizontal di 390px;
- fokus keyboard;
- kontras di bawah AA;
- loading tanpa akhir;
- tampilan saat data kosong atau gagal;
- teks Inggris campur aduk;
- em dash di kalimat UI;
- nama penyedia data (Arjum) atau nama internal (VPS, nama tabel, cron) yang tampil di UI;
- tabel tanpa wadah scroll horizontal, sehingga kolom terpotong (cek juga tabel di setiap tab).

**Masalah data yang dicek di VPS dan di kode:**
- **Kesegaran:** tanggal data terakhir dibanding hari bursa terakhir. Status kesegaran di UI harus dari waktu data.
- **Kelengkapan:** jumlah saham (seharusnya 962, kecuali yang tidak rilis), hari yang bolong sejak 2 Jan 2026, dan field yang kosong.
- **Kebenaran:**
  - nilai kosong yang tampil sebagai 0;
  - satuan (lot vs lembar, Rp vs ribu);
  - pembulatan;
  - zona waktu (WIB).
- **Kecepatan:**
  - waktu respons p50/p95 setiap endpoint halaman (ukur 10 kali);
  - ukuran payload;
  - query tanpa indeks (`EXPLAIN QUERY PLAN`);
  - N+1 per ticker;
  - file JSON besar yang dibaca utuh setiap request;
  - cache yang tidak ada atau yang basi.
- **Sudah dikerjakan Roo Code (18 Okt) — pertahankan perilakunya, jangan dibuat ulang:**
  - candle 962 saham dari Yahoo (jam 16:40 dan 23:30) dengan cek silang 20 saham ke Arjum, dan otomatis kembali ke Arjum kalau ada selisih;
  - IHSG dari disk (`data/daily-candles/IHSG.json`) + bar live intraday saat jam bursa;
  - Bandarmologi Domestik "belum lengkap" untuk tanggal yang data all-nya terpotong;
  - validator broksum (`lib/broksum-validator.js`) dengan aturan `.done` 1% + top-100, ditambah file anomali `_eod/<tanggal>.anomali.json`;
  - field Admin Console: `anomaly_total`, `anomaly_pct`, `anomaly_top100`, `warnings_total`, `archive_complete`;
  - batas kuota dinamis dari `ARJUM_DAILY_LIMIT`.
- **Yang tetap harus kamu kerjakan di sisi tampilan:**
  - **Admin Console:**
    - tampilkan kesegaran dataset, kuota (terpakai / batas / reset 00:00 WIB), dan anomali hari itu dari data **asli**;
    - tab **Online** (HANDOFF §5b): endpoint heartbeat dan daftar online khusus admin; heartbeat tidak boleh memakai kuota API data.
  - **Data cadangan atau tertunda tidak boleh tampil seperti data asli:**
    - semua data yang berlabel fallback/cadangan: tampilkan "data terakhir tersimpan · <tanggal asli>";
    - bar hari ini yang `provisional:true`: tampilkan "sementara · diperbarui hh:mm".
  - **Data asing yang belum dirilis vendor:** tampilkan "data asing belum dirilis", bukan 0.
  - `autocuan-web-error.log` (`live-price … vps_local_cache_stale`): pastikan sudah diperbaiki. Kalau belum, perbaiki.

Ringkasan audit Fase 1 dikirim bersama Fase 1a (lihat di bawah).

## Fase 1a · Audit mendalam alur publik, akun, dan Telegram

Pemilik minta pemeriksaan **mendalam**, bukan sekilas. Untuk setiap alur di bawah:
1. Telusuri jalurnya di kode: route, handler, tabel, dan pesan error.
2. Uji di lokal dengan test otomatis. Pakai mock untuk Google dan Telegram; jangan memanggil layanan asli dari test.
3. Uji di produksi kalau bisa dan aman (lihat Batas keras 4).
4. Tulis hasilnya di `handoff-redesign/AUDIT_ALUR.md`, dengan format: alur, langkah, hasil, bug, risiko keamanan, perbaikan, dan apakah butuh "deploy".

**Alur yang wajib dicek:**
1. **Landing:**
   - semua tautan dan CTA;
   - angka yang tampil (asli atau karangan?);
   - waktu muat dan LCP di 390px;
   - meta/OG;
   - halaman 404.
2. **Masuk:**
   - email/username + password;
   - pesan salah password yang tidak membocorkan apakah akun ada;
   - batas percobaan (rate limit / lockout);
   - "ingat saya";
   - logout di semua tab;
   - sesi kedaluwarsa.
3. **Daftar:**
   - validasi field;
   - aturan password;
   - email ganda;
   - verifikasi email (kalau ada);
   - pesan sukses;
   - opsi paket/tingkat akun yang tersedia saat daftar.
4. **Daftar/masuk lewat Google:**
   - konfigurasi OAuth (client id hanya di server, redirect URI benar);
   - parameter `state` (anti-CSRF);
   - email Google yang sama dengan akun email/password yang sudah ada (digabung atau ditolak, dan apakah aman);
   - aturan "Gmail wajib" (legacy);
   - batal di tengah jalan;
   - akun Google tanpa email terverifikasi.
5. **Menunggu persetujuan admin:**
   - layar status "menunggu" untuk pengguna;
   - halaman dan API apa yang bisa diakses akun yang belum disetujui (**dicek di server**, bukan hanya UI);
   - setujui/tolak dari Admin Console;
   - notifikasi ke pengguna setelah disetujui atau ditolak;
   - akun yang ditolak lalu mencoba lagi.
6. **Bot Telegram:**
   - menghubungkan akun web ke Telegram (deep link `/start <token>`: token sekali pakai, ada masa berlaku, tidak muncul di log);
   - memutus hubungan;
   - perintah bot yang tersedia;
   - pilihan berlangganan broadcast;
   - pengguna yang belum disetujui atau masa aktifnya habis **tidak** menerima broadcast berbayar.
7. **Grup Telegram:**
   - cara pengguna diundang (link undangan: sekali pakai atau permanen?);
   - hanya akun yang disetujui yang mendapat link;
   - anggota yang masa aktifnya habis dikeluarkan atau link-nya dicabut;
   - link undangan tidak bocor di halaman publik.
8. **Pemulihan password:**
   - token sekali pakai dan kedaluwarsa;
   - tidak membocorkan apakah email terdaftar;
   - sesi lain keluar setelah password diganti.
9. **Peran dan akses:**
   - Admin Console, Pattern Radar, dan semua endpoint tulis (termasuk Catatan Admin §5d) mengembalikan 403 untuk non-admin;
   - uji dengan request langsung ke API, bukan lewat UI.
10. **Mode pemeliharaan:** apa yang dilihat pengguna, dan admin tetap bisa masuk.

**Keamanan yang dicek di semua alur:**
- secret atau token yang ikut ke JavaScript klien;
- open redirect di parameter `next`/`redirect`;
- cookie sesi `HttpOnly` + `Secure` + `SameSite`;
- CSRF di form POST;
- data pribadi di log;
- header keamanan dasar (CSP, `X-Frame-Options`/`frame-ancestors`).

**Yang tidak bisa diuji otomatis** (misalnya login Google sungguhan, atau bot Telegram di HP): tulis checklist manual langkah demi langkah di `handoff-redesign/CEK_MANUAL_PEMILIK.md`. Setiap langkah berisi hasil yang diharapkan dan kolom centang.

**Sumber data per tab (bukan hanya per halaman).** Lengkapi tabel Fase 0 sampai tingkat **tab** dan **sub-tab**:

| Halaman | Tab | Endpoint | File/tabel sumber | Job pengisi + jadwal WIB | Data terakhir | Status |
|---|---|---|---|---|---|---|

Kolom "Data terakhir" diisi dari hasil `CEK_VPS_UNTUK_ROO.md`. Setiap tab yang datanya basi, kosong, atau error masuk `AUDIT_HALAMAN.md`, lengkap dengan penyebabnya.

Kirim ringkasan Fase 1 + 1a ke pemilik sebagai **satu pesan**: tabel temuan diurutkan dari yang paling berbahaya, ditambah file `CEK_VPS_UNTUK_ROO.md` yang siap dikirim. Setelah itu lanjut ke Fase 2 tanpa menunggu, **kecuali** ada temuan keamanan tingkat tinggi. Kalau ada, berhenti dan tunggu pemilik.

## Fase 2 · Fondasi (sekali, sebelum halaman)

1. **Token dan mode gelap:**
   - Petakan `:root` **dan blok gelap** dari `design/project/ac.css` ke `public/ui-theme.css`.
   - Buat pilihan tema Otomatis/Terang/Gelap (HANDOFF §3a), dengan skrip di `<head>` supaya tidak ada kedip.
   - Uji kontras AA di **kedua** mode.
2. **Huruf:** Plus Jakarta Sans (UI) dan Geist Mono (angka/ticker), woff2 *self-host*, `font-display:swap`, `preload` untuk 2 berat.
3. **Ikon:** satu modul ikon dari SVG kanvas. Tanpa library.
4. **Shell:**
   - sidebar diam di desktop dan bisa diciutkan;
   - ikuti breakpoint HANDOFF §4: ≤760px bilah atas + Menu + tab bawah 4 item; 761–1099px rail ikon 68px; ≥1100px sidebar penuh;
   - bilah atas memuat pencarian dan status kesegaran.
5. **Komponen status:** kosong, memuat, dan gagal, dengan salinan dari objek `ST` di `motion.js`.
6. **Motion dan Si Mata:** port `motion.js` sebagai modul. Perilaku dan batasnya sesuai HANDOFF §7. Pengaturan tampil/sembunyi disimpan di akun kalau ada, kalau tidak di `localStorage` dengan try/catch.

## Fase 3 · Halaman, satu per satu

Urutan:
1. Dashboard
2. Screener
3. Analisis & Chart
4. Bandarmologi
5. Watchlist
6. Portfolio
7. Sinyal Intelijen
8. Broker Hunter
9. Insider
10. Ranking
11. Financial
12. Struktur Pasar
13. Sektor Hot
14. **Catatan Admin (fitur baru, lihat HANDOFF §5d):** tabel + endpoint + job status + halaman + bagian di Dashboard. Migrasi DB lewat file migrasi; tidak memakai kuota Arjum.
15. Track Record
16. Kelola Keuangan
17. Pusat Akun
18. Landing
19. Auth (4 halaman)
20. Ketentuan
21. Admin Console
22. Pattern Radar
23. Pemeliharaan

Untuk setiap halaman:
1. Perbaiki bug dan masalah data dari `AUDIT_HALAMAN.md` untuk halaman itu.
2. Terapkan desain. Sambungkan ke data **asli**. Pertahankan semua fitur lama yang tidak ada di kanvas. Kalau ada, tulis di laporan.
3. **Uji:**
   - Playwright di 1440, 1024, dan 390px, mode terang **dan** gelap, dibandingkan dengan `screenshots/<Halaman>_d.png` / `_m.png`;
   - 0 error konsol;
   - klik setiap kontrol;
   - Tab/Escape berfungsi;
   - kontras AA;
   - tidak ada overflow horizontal;
   - keadaan kosong/memuat/gagal dipicu sungguhan (misalnya endpoint dimatikan di test);
   - waktu muat halaman dan p95 endpoint dicatat sebelum dan sesudah.
4. Tulis Delivery Gate antislop, lalu commit `redesign(<halaman>): …`.

**Anggaran kinerja:**
- Respons data halaman p95 < 500 ms dari VPS.
- Tidak ada layout shift saat data masuk (skeleton setinggi konten).
- Tidak ada animasi selain `transform`/`opacity`.
- Chart tetap memakai Lightweight Charts yang sudah ada (`public/chart-viewer.js`). Jangan menulis ulang engine chart.

## Fase 4 · Laporan, lalu STOP

Tulis `handoff-redesign/REPORT_REDESIGN.md`:
1. Tabel halaman: status, commit, Delivery Gate, bug yang diperbaiki, dan masalah data yang diperbaiki.
2. Kinerja sebelum dan sesudah (p95 endpoint, waktu muat).
3. Fitur lama yang dipertahankan tapi tidak ada di kanvas.
4. **Daftar langkah produksi yang butuh "deploy"**, misalnya: perbaikan data atau job di VPS, indeks SQLite, restart, dan cron. Setiap langkah disertai jalur kembali.
5. Screenshot sesudah, untuk semua halaman di 1440 dan 390px.

**Berhenti di sini dan tunggu pemilik menulis "deploy".**
