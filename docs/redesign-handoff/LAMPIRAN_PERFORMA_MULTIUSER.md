# PERFORMA SAAT DIPAKAI BANYAK PENGGUNA — tanpa fitur yang dipangkas

> Dibuat **Sabtu 24 Okt 2026 dini hari** oleh Claude, berdasarkan **pembacaan kode** branch `redesign/v2` commit `bb94606` (sudah memuat `feat/daytrade-screener-v1` sampai PR #907). **Tidak ada kode yang diubah** dan **tidak ada akses ke VPS** dari sesi ini.
> Karena itu setiap temuan server berstatus **"terbukti di kode, perlu diverifikasi di VPS"**. Verifikasi dikerjakan Roo di Gelombang 0 sebelum ada perbaikan.
> Dokumen ini untuk tiga pihak: **pemilik** (keputusan), **Roo Code** (server, VPS, cron, nginx), **Antigravity/Gemini** (frontend). Pembagian wilayah tetap berlaku: Antigravity tidak menyentuh pipeline atau keamanan server.
> Tanpa kunci, token, alamat VPS, atau lokasi kunci.
> Alat pendukung yang sudah diuji ada di folder `alat-performa/` (uji beban, pengukur server, cache bersama; 20/20 test lulus).

---

## 0. Ringkasan untuk pemilik (baca ini saja kalau sempit waktu)

1. **Sekarang SATU proses Node (`autocuan-web`) melayani semua pengguna.** VPS-nya kemungkinan 1 core dan 5,8 GiB RAM (dari komentar kode; cek `nproc`). Pada jam bursa, proses yang sama **juga menjalankan scan DayTrade** setiap 15 menit.
2. **Lima penyebab terbesar web terasa berat saat ramai (prioritas P0):**
   - **P0-1** Scan DayTrade full-universe berjalan **di dalam** proses web (dipanggil cron lewat HTTP). Pengguna harus "antre" di belakang scan, tepat di jam bursa.
   - **P0-2** Ada **kerja sinkron** di jalur permintaan: kode membuka **proses Node baru secara sinkron** (dan bisa SSH sinkron) hanya untuk mengambil data. Selama itu, server berhenti melayani **semua** orang.
   - **P0-3** Batas laju nginx (10 permintaan/detik, burst 20) dihitung per alamat yang dilihat nginx. Kalau nginx melihat alamat Cloudflare atau `127.0.0.1` (bukan alamat asli pengguna), **semua pengguna berbagi satu jatah**. Akibatnya saat ramai, pengguna sah dapat error 503. **Wajib dicek.**
   - **P0-4** Setiap permintaan fitur premium menanyakan **Supabase 2 kali** untuk hak akses, tanpa cache. DayTrade menambah 2 kueri lagi, dan hasil yang **sama** dihitung ulang untuk setiap pengguna.
   - **P0-5** Halaman pertama harus mengurai **±3,2 MB**: HTML 1,08 MB (762 KB di antaranya skrip di dalam HTML; satu blok 744 KB), JS 1,37 MB dari **41 skrip tanpa `defer`**, CSS 0,79 MB, dan ±4.900 elemen DOM. HTML-nya juga tidak pernah di-cache browser.
3. **Simulasi (bukan angka produksi):** endpoint dengan kerja sinkron 25 ms membuat endpoint lain yang ringan **ikut lambat**. Dengan 40 pengguna, p95 endpoint ringan menjadi **116 ms** (seharusnya ±4 ms) dan CPU 82%. Dengan cache bersama, p95 kembali **±4 ms**, CPU **6%**, dan pembacaan database turun dari 359 menjadi **1**.
4. **Semua perbaikan di dokumen ini menjaga fitur 100%.** Caranya dengan cache, menghitung sekali untuk banyak orang, memindahkan kerja berat ke proses lain, memuat kode saat dibutuhkan, dan kompresi. Tidak ada yang dihapus.
5. **Rencana 5 gelombang:**
   - **G0** ukur dulu (Roo, baca-saja, bisa mulai kapan saja di luar jam bursa).
   - **G1** perbaikan cepat server (Roo).
   - **G2** perbaikan arsitektur server (Roo).
   - **G3** frontend (Antigravity, sejalan dengan redesign).
   - **G4** kapasitas (keputusanmu).
6. **Yang perlu kamu putuskan** (Bagian 10):
   - Target jumlah pengguna bersamaan.
   - Urutan pekerjaan ini terhadap redesign.
   - Cek paket Supabase (batas transfer data).
   - Naik ke 2 OCPU / 12 GB. Batas Always Free Oracle sekarang memang 2 OCPU / 12 GB, tetapi ada risiko kapasitas saat resize.
   - Aturan cache Cloudflare untuk data publik.

---

## 1. Prinsip: cepat tanpa memangkas

| Boleh (fitur tetap utuh) | Tidak boleh |
|---|---|
| Menghitung sekali, melayani banyak pengguna (cache bersama + ETag/304) | Menghapus fitur, kolom, layer, atau halaman |
| Memindahkan kerja berat ke proses/worker lain atau ke luar jam sibuk | Mengurangi 962 saham atau cakupan data |
| Mengganti kerja sinkron dengan asinkron (hasil identik) | Memperpanjang umur data **tanpa label** waktu |
| Memuat kode per halaman saat dibutuhkan (lazy-load + prefetch saat hover) | Menurunkan akurasi atau mengganti rumus demi kecepatan |
| Kompresi, cache browser/edge untuk data publik, aset berhash | Menyembunyikan error atau mengganti angka dengan tebakan |
| Membatasi laju per **pengguna asli**, bukan per alamat proksi | Menaikkan batas laju sampai server bisa dibanjiri |
| Menambah kapasitas (core, worker) | Mematikan keamanan (CSP, throttle login) demi kecepatan |

**Ukur sebelum dan sesudah. Tanpa angka, perubahan dianggap belum terbukti.**

---

## 2. Gambaran sistem sekarang (dari kode)

```
Browser ──► Cloudflare ──► (jalur ke origin: PERLU DICEK, nginx di VPS atau tunnel) ──► nginx
                                                                                      │
                                    ┌─────────────────────────────────────────────────┘
                                    ▼
         autocuan-web (pm2, 1 proses fork, 127.0.0.1:3000, server http Node bawaan: tools/local-dev-server.js)
            ├─ file statis public/ (LRU 16 MB, ETag sha256, brotli/gzip)    ├─ api/*.js (sector-hot.js 840 KB, quote, candles, …)
            ├─ data JSON di disk (data/…)                                   ├─ Supabase (akun, hak akses, hasil screener, Kelola, dll.)
            ├─ bridge auto-cuan-vps-api 127.0.0.1:3001                      └─ upstream: Yahoo, penyedia data berkuota, Gemini (BYOK)
            └─ DIPANGGIL CRON untuk scan DayTrade tiap 15 menit 09:02–15:47 (CPU dan RAM berat, RSS bisa > 512 MB)
Proses lain di mesin yang sama: auto-cuan-vps-api, autocuan-bot (Telegram), autocuan-verify-bot, autocuan-web-tunnel, dan semua cron.
```

**Jam sibuk server (WIB):**

| Jam | Beban |
|---|---|
| 08:55–09:15 | Bursa buka, banyak pengguna login dan membuka Dashboard |
| 09:02, :17, :32, :47 (sampai 15:47) | Scan DayTrade **di dalam proses web** |
| Setiap 5 menit (09–15) | Job FastWatcher |
| Setiap 30 menit (09–15) | Job Sektor Hot |
| Setiap 15 menit (08–20) | Penjaga suspensi |
| 15:50–16:15 | Penutupan |
| 16:30–17:45 | J1 (broker summary EOD) |
| 16:40 | J2 (candle 962 saham) |
| 16:30 | Lifecycle evaluator |
| 17:45 | IHSG |
| 18:45 | Recap Telegram. Lonjakan klik dari Telegram |
| 21:30 | Screener preflight |
| 22:15 | Landing refresh dan dispatch |
| 22:45 | Indeks broker hunter |
| 23:30 | J1 final, J2, dan IHSG |
| 00:07 (akhir pekan) | Pengejaran tanggal bolong |

Cron **tidak memakai `nice`/`ionice`**, jadi prioritas CPU-nya sama dengan web.

**Yang sudah baik (jangan dibuat ulang):**
- Penyaji file statis dengan LRU, ETag sha256, dan brotli/gzip yang di-cache (`lib/static-assets.js`).
- Cache SWR di browser 10 menit, prefetch saat hover menu, dan interval yang berhenti saat tab tersembunyi (`public/tab-keepalive-runtime.js`).
- Cache per ticker dengan cooldown di `vps-data-fetcher`, dan cache terbatas di beberapa modul.
- Konkurensi fetch DayTrade dibatasi 2.
- SQLite WAL + `busy_timeout` di `lib/vps-market-store.js`.
- Batas memori pm2 1 GB.
- `flock` pada wrapper cron.
- Keepalive Oracle yang hanya membakar CPU saat server diam.

---

## 3. Temuan berbukti (urut prioritas)

Rujukan file:baris mengacu ke `redesign/v2@bb94606`. **Pemilik** = siapa yang memperbaiki.

### P0 — paling menentukan saat ramai

| ID | Temuan | Bukti | Dampak saat ramai | Perbaikan tanpa memangkas | Pemilik |
|---|---|---|---|---|---|
| **P0-1** | Scan DayTrade full-universe berjalan **di dalam proses web** | `tools/run-daytrade-intraday-producer.js:319–330` memanggil `action=daytrade-screener-run` per batch ke web; `ecosystem.config.js:54–67` (1 proses fork; komentar: batch bisa mendorong RSS > 512 MB); cron `2,17,32,47 9-15` | Selama scan, permintaan pengguna mengantre di event loop yang sama. Risiko restart pm2 (batas 1 GB) memutus semua pengguna | Jalankan mesin scan di **proses terpisah**. Pilihan (a): skrip producer memanggil fungsi scan langsung di proses cron-nya sendiri. Pilihan (b): proses pm2 `autocuan-worker` dengan `nice`. Web hanya membaca hasil. **Jadwal, hasil, dan pesan Telegram sama persis** | Roo |
| **P0-2** | **Proses Node baru dibuat secara sinkron** untuk mengambil data, dan SSH sinkron, di jalur permintaan web | `lib/vps-data-fetcher.js:205–231` (`fetchJsonSync` → `execFileSync(process.execPath, ['-e', …])`, timeout sampai 8 dtk + 3 dtk); `:859` `fetchLivePriceFromVpsSync` (langkah 2 bridge sinkron); SSH `execFileSync('ssh', …)` di `:419, 487, 602, 654, 720, 800` (timeout 18–25 dtk, hanya bila ada kunci SSH). Dipanggil dari `lib/bandarmologi-service.js:366, 2161–2360`, `lib/bandarmologi-intel-service.js:527–634, 1557–1581`, `lib/latest-price-resolver.js:109`, `lib/broker-hunter-service.js:370`. Log produksi pernah berisi ±52 ribu baris `vps_local_cache_stale` (jalur ini sering dilalui) | Setiap panggilan **membekukan seluruh server**: membuat proses Node ±50–100 ms, lalu menunggu HTTP. Bila bridge lambat, bisa beberapa detik untuk SEMUA pengguna | Ubah pemanggil ke versi **async** yang sudah ada (`fetchBrokerSummaryFromVps`, dst.) atau baca langsung di proses (usulan "bridge in-process" Roo sendiri). Di VPS, jalur SSH tidak perlu sama sekali. Hasil data identik | Roo |
| **P0-3** | Batas laju nginx memakai `$binary_remote_addr` | `deploy/nginx/autocuan:17` (`rate=10r/s`), `:84, 107` (`burst=20 nodelay`). Tidak ada `real_ip_header`/`set_real_ip_from` di file ini. Belum diketahui apakah ada di konfigurasi global nginx | Bila nginx melihat alamat Cloudflare atau `127.0.0.1` (tunnel), **seluruh situs berbagi ±10 permintaan API/detik**. Pengguna sah dapat **503** saat ramai | Verifikasi jalur dan alamat yang terlihat (G0). Lalu `real_ip_header CF-Connecting-IP` + `set_real_ip_from` (rentang Cloudflare atau `127.0.0.1` bila tunnel), `limit_req_status 429`, dan zona terpisah per jenis endpoint | Roo |
| **P0-4** | Hak akses premium mengecek Supabase 2× per permintaan tanpa cache; isi yang sama dihitung ulang per pengguna | `lib/subscription-auth.js:26–33` (`app_users`) + `lib/entitlements.js:75` (`user_entitlements`), dipanggil di `api/sector-hot.js:357–363` untuk screener/DayTrade; `api/sector-hot.js:13170–13240` (DayTrade: 2 kueri lagi + pengayaan 50 baris per permintaan); FastWatcher memanggilnya tiap 20 dtk per pengguna | Latensi naik mengikuti Supabase, CPU terpakai untuk hasil yang sama, dan **transfer Supabase membengkak** (bisa melewati batas paket gratis) | Cache hak akses per pengguna (TTL 30–60 dtk, langsung dihapus saat admin menyetujui/memblokir/mengubah langganan). Cache isi bersama per versi data (`calculated_at`) dengan single-flight + ETag (`alat-performa/shared-cache.js`) | Roo |
| **P0-5** | Halaman awal sangat berat dan HTML tidak di-cache | `public/index.html` 1,08 MB (6 skrip inline 762 KB, termasuk **satu blok 744 KB di ±31% dokumen**; ±4.937 elemen, 146 SVG, 377 atribut `on…=`, 386 `style=`); 44 skrip eksternal 1,37 MB, **41 tanpa `defer`** (1 di `<head>`, 40 di body mulai ±31% dokumen), jadi parser berhenti di setiap skrip sampai diunduh dan dijalankan; 14 CSS 0,79 MB di `<head>` memblokir render (`ui-theme.css` 480 KB); HTML dikirim `private, no-store` (`lib/static-assets.js:12, 111–112`). Transfer pertama ±708 KB terkompresi, **±3,17 MB diurai** | Di HP menengah: detik-detik pemblokiran thread utama (klik terasa macet), dan setiap kunjungan mengunduh ulang HTML ±235 KB | Bagian 5 Gelombang 3: skrip inline ke file berhash (cache), `defer`, muat per halaman, pecah CSS, DOM tampil saat dibutuhkan, HTML `no-cache` + ETag (304) | Antigravity (+ Roo untuk `lib/static-assets.js`) |

### P1 — penting, risiko rendah

| ID | Temuan | Bukti | Perbaikan | Pemilik |
|---|---|---|---|---|
| P1-1 | `Connection: upgrade` dikirim untuk **semua** permintaan `/` dan `/api/`, sehingga keepalive ke Node tidak terpakai (koneksi TCP baru per permintaan) | `deploy/nginx/autocuan:55, 68, 93` | `map $http_upgrade $connection_upgrade { default upgrade; '' ''; }` lalu `proxy_set_header Connection $connection_upgrade;` | Roo |
| P1-2 | nginx menimpa **semua** respons `/api/` dengan `Cache-Control: private, no-store` (`add_header … always`) | `deploy/nginx/autocuan:96, 117` | Biarkan aplikasi menentukan header. Bawaan tetap `no-store` dari aplikasi. Endpoint **publik** boleh `public, max-age=15, s-maxage=30, stale-while-revalidate=60` | Roo |
| P1-3 | Node tanpa `keepAliveTimeout`/`headersTimeout` (bawaan 5 dtk) | `tools/local-dev-server.js:1715` | `server.keepAliveTimeout = 65000; server.headersTimeout = 66000;` (lebih lama dari keepalive nginx) untuk mencegah 502 sporadis | Roo |
| P1-4 | Body permintaan dibaca **tanpa batas ukuran** | `tools/local-dev-server.js:488–520` (`parseBody`) | Batas 256 KB (pengecualian unggah CSV dengan batas sendiri), jawab 413 | Roo |
| P1-5 | Tidak ada graceful shutdown. Setiap deploy/restart memutus permintaan yang sedang berjalan | tidak ada `SIGTERM`/`server.close` di `tools/local-dev-server.js` | Tangani SIGTERM/SIGINT: berhenti menerima, selesaikan yang berjalan (≤ 8 dtk), lalu keluar (`kill_timeout` pm2 10 dtk sudah cukup) | Roo |
| P1-6 | `scryptSync` memblokir event loop: login (N=16384) dan **setiap** enkripsi/dekripsi kunci AI menurunkan ulang kunci induk | `lib/password-credential.js:14, 30`; `lib/user-ai-credentials.js:26` (`getMasterKey()` tanpa memo) | Memo kunci induk (hasil identik). Login memakai `crypto.scrypt` asinkron dengan parameter sama (hash identik) | Roo |
| P1-7 | Pengambilan "on-demand" dengan **tanggal tertulis keras** `'2026-09-08'` di setiap permintaan Bandarmologi tanpa tanggal | `tools/local-dev-server.js:1635` → `lib/vps-data-fetcher.js:765–778` | Hapus tanggal bawaan. Lewati di VPS (data sudah lokal). Mencegah tunggu sampai 5 dtk per permintaan saat file tanggal itu tidak ada | Roo |
| P1-8 | Cron tanpa `nice`/`ionice` | `deploy/vps/*.sh` (0 kemunculan) | `nice -n 10 ionice -c2 -n7` untuk job batch (bukan web) | Roo |
| P1-9 | Klien Supabase dibuat **per permintaan** di beberapa endpoint | `api/login-user.js:96, 118, 267, 484, 553`; `api/admin-logs.js:32`; `api/maintenance-settings.js:136`; `api/review-access.js:70`; `api/reset-password.js:83` | Satu klien per proses (modul bersama) | Roo |
| P1-10 | Penulisan Kelola Keuangan "yang terakhir menang" (dua perangkat/tab bisa saling menimpa) | `lib/money-management-handler.js:152, 229` (hanya set `updated_at`) | Kendali konkurensi optimis: klien mengirim versi yang dimuat; server memperbarui hanya bila versi sama, kalau tidak **409**. UI menampilkan "Data diubah di perangkat lain · Muat ulang / Gabungkan". Pola sama untuk watchlist/portofolio | Roo (server) + Antigravity (UI) |
| P1-11 | Pustaka chart dimuat dari **unpkg** saat runtime; jsPDF dari 3 CDN | `public/market-feature-runtime.js:10`; `public/index.html` (cdnjs/jsdelivr/unpkg) | Self-host versi yang sama di `public/vendor/` (berhash, immutable), muat saat dibutuhkan | Antigravity (+ Roo untuk CSP) |
| P1-12 | Aset statis memakai `?v=` manual (bukan hash isi) dengan `max-age=3600` | `tools/local-dev-server.js:442–445`; komentar `deploy/nginx/autocuan` | Fingerprint isi saat server start: HTML ditulis ulang ke `?v=<hash>`; aset berhash `public, max-age=31536000, immutable`. Tidak ada lagi JS basi setelah deploy dan tidak ada revalidasi | Antigravity + Roo |
| P1-13 | Tautan berbagi screener publik membaca **seluruh** tabel Supabase setiap dibuka | `api/sector-hot.js:3031, 3050` (`handlePublicScreenerShare`) | Cache bersama per token (TTL 60 dtk) + ETag. Aman bila tautan dibuka ratusan orang dari Telegram | Roo |

### P2 — rapikan setelah P0/P1

- `Access-Control-Allow-Origin: *` di semua respons (`tools/local-dev-server.js:849`) → batasi ke origin sendiri (keamanan, wilayah Roo).
- Alamat VPS tertulis di repo sebagai nilai bawaan (`SSH_TARGET` di `lib/vps-data-fetcher.js:25`, juga di komentar dan `server_name` `deploy/nginx/autocuan`). Pindahkan ke variabel lingkungan dan hapus dari repo (kebersihan keamanan, wilayah Roo; jangan mencetak nilainya).
- Kueri `select('*')` di jalur panas → pilih kolom yang dipakai saja (hemat transfer Supabase).
- Penulisan log yang sangat sering (52 ribu baris stale): rotasi dan batas laju log (sebagian sudah ada).
- `fetch(… fw_live=Date.now())` di FastWatcher (`public/fast-watcher-live-refresh.js:77`) menggagalkan cache. Ganti dengan ETag + `cache: 'no-store'` bila perlu.
- Timer DOM di klien (50–250 ms) memang berhenti sendiri (`mobile-ui-runtime-v5.js:426`, `dashboard-top5-only-ui.js:68`, `security-admin-runtime.js:190`), tetapi ganti dengan `MutationObserver` atau event agar tidak membebani HP saat muat.
- `portfolio-supabase-sync.js` memeriksa perubahan lokal setiap **700 ms** (serialisasi state). Ganti dengan event saat data berubah + debounce.
- Heartbeat Admin Online (fitur baru, belum dibangun): **jangan** menulis ke database per heartbeat. Agregasi di memori, simpan batch tiap 30–60 dtk, jawab 204.

---

## 4. Target (SLO) dan hitungan kapasitas

### 4.1 Target yang diusulkan (konfirmasi angka penggunanya oleh pemilik)

- **Beban rencana:** 200 pengguna aktif bersamaan di jam bursa, lonjakan 3× (pukul 09:00, saat recap/broadcast Telegram).
- **Server** (diukur di VPS, termasuk saat scan DayTrade berjalan):
  - p95 API yang di-cache < 150 ms, API lain < 500 ms.
  - Error < 0,5%, **0 error 503/429 dari batas laju untuk pemakaian wajar**.
  - Keterlambatan event loop tambahan p99 < 50 ms.
  - CPU rata-rata < 70%, RSS web stabil < 600 MB.
- **Browser** (HP menengah, 4G, CPU 4× lebih lambat):
  - LCP < 2,5 dtk, INP < 200 ms, CLS < 0,1, Total Blocking Time < 600 ms.
  - JS yang diurai saat pertama ≤ 600 KB.
  - Elemen DOM awal < 1.500.
  - Kunjungan ulang mentransfer < 100 KB.

### 4.2 Hitungan sederhana

**CPU per detik = permintaan/detik × ms CPU per permintaan.**
- 60 permintaan/detik × 20 ms = 1.200 ms per detik = **120% satu core**, jadi macet.
- 60 permintaan/detik × 2 ms (dari cache) = **12%**, jadi lega.

**Anggaran polling per pengguna** (dari kode):

| Sumber | Interval | Kapan | Permintaan/menit per pengguna |
|---|---|---|---|
| FastWatcher | 20 dtk | halaman FastWatcher terlihat, jam bursa | 3 |
| Strip harga | 60 dtk | semua halaman aplikasi, tab terlihat | 1 |
| Progres scan DayTrade | 3 dtk | hanya saat scan berjalan dan halaman DayTrade terbuka | 20 (sementara) |
| Heartbeat online (rencana) | 60 dtk | tab terlihat | 1 |
| Navigasi | — | 1–3 klik/menit (beberapa API per klik) | ±2–6 |

Contoh: 200 pengguna × ±6/menit ≈ **20 permintaan/detik** rata-rata, puncak ±60/detik. Satu proses Node menangani ini dengan mudah **bila** sebagian besar dijawab dari cache (2–5 ms). Tidak bila tiap permintaan butuh 20–50 ms CPU ditambah 2–4 kueri Supabase, atau bila ada kerja sinkron.

---

## 5. Rencana bertahap

### Gelombang 0 — Ukur dan verifikasi (Roo, baca-saja, 0 request penyedia data berkuota)

Boleh mulai kapan saja **di luar jam bursa**.

1. **Jalur trafik dan alamat yang terlihat:**
   - Bagaimana `autocuan.web.id` mencapai origin (DNS proksi Cloudflare ke port 80/443 nginx, atau Cloudflare Tunnel)?
   - Alamat apa yang muncul di kolom alamat log akses nginx (sebarannya: alamat Cloudflare? `127.0.0.1`? alamat pengguna)?
   - Apakah ada `real_ip_header`/`set_real_ip_from` (`nginx -T`, tanpa mencetak rahasia)?
   - Berapa baris "limiting requests" di log error nginx 14 hari terakhir, per hari dan per jam?
2. **Beban per jam pada hari bursa:**
   - Per jam: jumlah permintaan per endpoint dan status (dari log akses), 5xx/503/429/499.
   - Waktu respons (bila log punya `$request_time`/`$upstream_response_time`; kalau tidak, tulis bahwa tidak ada).
3. **Scan DayTrade di proses web:**
   - Dari log producer: durasi per batch, `peak_rss`, `load1`.
   - Bandingkan waktu respons pengguna di dalam dan di luar jendela scan.
4. **Kerja sinkron:**
   - Frekuensi `[VPS-FETCHER]` (stale, degraded, spawn_or_timeout) per jam.
   - Daftar endpoint yang memicunya.
5. **Supabase:**
   - Jumlah kueri per permintaan untuk screener/DayTrade (dari kode).
   - Paket dan pemakaian transfer bulan ini (dari dashboard Supabase, oleh pemilik).
6. **Mesin:**
   - `nproc`, `uname -m`, `free -h`, dan shape di konsol OCI.
   - Proses pm2 dan memorinya.
   - Load average saat jam bursa.
7. **(Butuh izin pemilik) Pasang `perf-metrics`** (`alat-performa/perf-metrics.js` → `lib/perf-metrics.js`) di web: 1 baris `perf.track(req,res)`, log `[PERF]` per menit, header `Server-Timing`. Ini menyentuh `tools/local-dev-server.js`, jadi lewat PR + restart di luar jam bursa. Jalankan 1–2 hari bursa untuk **baseline**.
8. **(Butuh izin pemilik) Uji beban di salinan web** (port 3100, `127.0.0.1`, jam aman, hanya GET, akun uji) dengan `alat-performa/uji-beban.mjs`:
   - skenario `anon`, `premium`, `polling` pada 20/50/100 VU;
   - catat kurva p95 terhadap VU dan titik mulai melambat.
   - Pastikan salinan tidak menjalankan job latar.

**Keluaran:** `backtest/arjum-audit/REPORT_PERFORMA_G0_<tanggal>.md` dengan tabel per temuan P0/P1 (terbukti, tidak, atau tidak bisa dipastikan), angka baseline, dan usulan urutan.

### Gelombang 1 — Perbaikan cepat server (Roo, setelah G0 dan izin pemilik)

Satu butir satu commit dengan test. PR ke `feat/daytrade-screener-v1`, merge, `git pull` di VPS, restart **sekali** di luar jam bursa. Jalur kembali siap tempel.

| Butir | Isi | Kriteria terima |
|---|---|---|
| G1-1 | P0-2: hilangkan `execFileSync`/`execSync` dari jalur permintaan (async atau baca di proses) | Event loop tambahan p99 < 50 ms. Log stale/degraded turun. Hasil data identik (test perbandingan) |
| G1-2 | P0-3 + P1-1: real IP, `limit_req_status 429`, zona per jenis, map `Connection` | Alamat di log = alamat pengguna. 503 dari limit_req hilang untuk pemakaian wajar. Uji 1 IP tetap dibatasi |
| G1-3 | P1-3, P1-4, P1-5: timeout keepalive, batas body, graceful shutdown | 0 respons 502 saat uji beban. Unggah > batas → 413. Restart tidak memutus permintaan |
| G1-4 | P0-4 (bagian hak akses) + P1-9: cache hak akses 30–60 dtk dengan invalidasi + klien Supabase tunggal | Kueri Supabase per permintaan premium turun ≥ 50%. Blokir/setujui akun langsung berlaku (test) |
| G1-5 | P1-6: memo kunci induk AI + `scrypt` asinkron | Hash dan dekripsi identik (test). Event loop tidak melonjak saat login beruntun |
| G1-6 | P1-7: hapus tanggal `'2026-09-08'` dan pengambilan on-demand di VPS | p95 Bandarmologi turun. Tidak ada request ke bridge untuk tanggal fiktif |
| G1-7 | P1-8: `nice`/`ionice` untuk semua job batch | p95 web saat job sore berjalan tidak naik > 20% dari baseline |

### Gelombang 2 — Arsitektur server (Roo)

| Butir | Isi | Kriteria terima |
|---|---|---|
| G2-1 | **P0-1: pindahkan scan DayTrade keluar dari proses web** (worker/producer menjalankan mesin scan sendiri, `nice`) | Selama 09:02–15:47, p95 pengguna setara di dalam dan di luar jendela scan. RSS web stabil. Hasil scan, publikasi, dan Telegram identik (bandingkan 3 hari) |
| G2-2 | **Cache isi bersama** (`shared-cache.js`) + ETag/304 untuk DayTrade read, screener swing, `web-daily-picks`, `market-breadth`, `tape`, `landing-snapshot`, tautan berbagi, Sektor Hot. Kunci = versi data + parameter + tingkat akses | Uji beban 200 VU: p95 < 150 ms, CPU < 50%. Isi identik dengan versi tanpa cache (test) |
| G2-3 | **Cache edge untuk data PUBLIK saja:** header publik + Cache Rule Cloudflare untuk path itu persis. **Tidak pernah** untuk data premium/pribadi | `cf-cache-status: HIT` ≥ 80% untuk path publik. Data premium tetap `private` (test header) |
| G2-4 | P1-10: konkurensi optimis Kelola/watchlist/portofolio (server 409) | Uji dua tab: tidak ada penimpaan diam-diam |
| G2-5 | P1-13 + P2 (`select` kolom, CORS origin sendiri) | Transfer Supabase per hari turun (bandingkan dashboard) |

### Gelombang 3 — Frontend (Antigravity; sejalan dengan redesign, commit terpisah `perf(...)`)

**Aturan:** fitur dan tampilan identik.
- Selisih piksel tidak boleh memburuk (metode di lampiran web).
- `npm run test:full` hijau.
- Ukur sebelum dan sesudah dengan alat yang sama: `puppeteer-core` sudah ada di devDependencies, atau Playwright yang dipakai sesi sebelumnya.
- Perubahan di `lib/static-assets.js` / `tools/local-dev-server.js` dicatat untuk ditinjau Roo.

| Butir | Isi | Kriteria terima |
|---|---|---|
| F0 | Baseline per tampilan utama (Landing, Dashboard, Screener, Analisis, Bandarmologi) di 390 dan 1440: LCP, TBT/long task, INP (event timing), KB JS/CSS diurai, jumlah DOM, jumlah permintaan | Tabel baseline di laporan |
| F1 | HTML `no-cache` + ETag (304) menggantikan `private, no-store` (HTML tidak memuat data pribadi; data lewat API) | Kunjungan ulang: HTML 304 |
| F2 | Pindahkan 6 skrip inline (762 KB) ke file eksternal **dengan urutan yang sama** | HTML < 350 KB mentah. Perilaku identik |
| F3 | `defer` untuk semua skrip non-kritis (urutan terjaga). Skrip tema anti-kedip tetap kecil dan sinkron di `<head>` sebagai file eksternal (siap CSP) | Tidak ada error konsol. TBT turun |
| F4 | **Muat per halaman**: kode Bandarmologi (318 KB), Analisis/chart (±400 KB), Portofolio, Track Record, AI dimuat saat halaman pertama dibuka. Prefetch saat hover menu (mekanisme yang sudah ada) agar tidak terasa menunggu | JS diurai saat pertama ≤ 600 KB. Pindah halaman pertama kali < 300 ms setelah prefetch |
| F5 | Pecah CSS per halaman. Buang aturan mati **hanya dengan bukti** (coverage + selisih piksel tetap) | CSS diurai saat pertama ≤ 250 KB |
| F6 | DOM tampil saat dibutuhkan: halaman yang tidak terlihat jadi `<template>`/dibuat saat dibuka, atau `content-visibility:auto` + `contain-intrinsic-size` | DOM awal < 1.500 elemen. Recalc gaya saat hover turun |
| F7 | Fingerprint aset (P1-12) | Aset `immutable`. Setelah deploy tidak ada JS basi (uji: ubah satu file, pastikan URL berubah) |
| F8 | Self-host Lightweight Charts 4.1.1 dan jsPDF/autotable (versi sama), muat saat dibutuhkan (P1-11) | 0 permintaan ke CDN luar. Chart dan PDF bekerja |
| F9 | **Disiplin polling** (satu modul): ETag/304, berhenti di luar jam bursa (`market_calendar`), jitter ±10%, backoff saat 429/5xx sesuai `Retry-After`, **satu tab saja yang polling** (BroadcastChannel), tetap berhenti saat tab tersembunyi | Uji beban `polling`: ≥ 80% respons 304 saat data belum berubah |
| F10 | UI konflik untuk P1-10 ("Data diubah di perangkat lain") | Uji dua tab |
| F11 *(opsional, keputusan pemilik)* | Landing sebagai halaman ringan terpisah (HTML statis bisa di-cache edge), aplikasi dimuat setelah login | LCP Landing 390 < 1,8 dtk |

Atribut inline `on…=` (377) dan `style=` (386) dipindah bertahap. Ini bukan syarat performa, tetapi syarat agar CSP bisa ditegakkan tanpa merusak halaman.

### Gelombang 4 — Kapasitas (keputusan pemilik)

1. **Pastikan shape VPS** (konsol OCI; `nproc`, `uname -m`, `free -h`). Kalau ARM Ampere A1 1 OCPU / 6 GB, dokumentasi Oracle **saat ini** menyebut Always Free = **2 OCPU dan 12 GB total**, jadi menaikkan ke 2 OCPU / 12 GB masih dalam batas gratis.
   - **Risiko:**
     - Kapasitas ARM terbatas (core bisa tidak kembali saat resize/reboot). Cadangkan boot volume dulu dan lakukan Sabtu siang.
     - Aturan "instans diam" (selama 7 hari: CPU p95 < 20%, jaringan < 20%, memori < 20%) berbasis persen, jadi **keepalive harus dikalibrasi ulang** untuk 2 core.
     - Pastikan jenis akun (Always Free vs Pay-As-You-Go) agar tidak ada tagihan tak terduga.
2. Dengan 2 core, urutan terbaik:
   - Pertama, worker scan di core kedua (G2-1).
   - Setelah itu, bila perlu, web dijalankan 2 instance pm2 cluster. Cache per proses tidak masalah, dan throttle login di SQLite tetap bersama.
3. Lebih jauh: dua instans terpisah (web dan worker), atau paket berbayar. Perlu hitungan biaya.

---

## 6. Cara menguji (aman)

- **Jangan pernah** uji beban ke produksi di jam bursa, dari banyak IP, atau dengan akun admin. Jangan memicu penyedia data berkuota.
- **Lokal (laptop):** server lokal tidak punya data produksi. Bagus untuk mengukur **frontend** dan logika cache, tetapi tidak untuk angka server.
- **Server nyata:** salinan web di VPS pada port 3100, bind `127.0.0.1`, jam aman, hanya GET, akun uji, dengan izin pemilik. `uji-beban.mjs` menolak port 3000/3001 dan jam sibuk secara otomatis.
- **Langkah:**
  1. Baseline.
  2. Satu perubahan.
  3. Uji ulang dengan perintah yang sama.
  4. Bandingkan p95/p99, error, CPU, dan event loop.
  5. Lampirkan laporan JSON di PR.
- **Skenario wajib:** `anon` (Landing), `premium` (perpindahan halaman), `polling` (latar), lonjakan pukul 09:00 (ramp 30 dtk ke 3× VU), dan "selama job berjalan" (jalankan saat scan DayTrade di salinan, bila memungkinkan).
- **Frontend:** throttle CPU 4× dan jaringan 4G. Ukur LCP/INP/TBT/DOM/KB di 390 dan 1440 untuk setiap halaman yang diubah.

---

## 7. Observabilitas dan alarm

- **Dari `perf-metrics`:** event loop tambahan p50/p99/maks, CPU %, RSS/heap, p95 per rute, 5xx, dan 499 (klien menutup). Snapshot JSON per menit bisa ditampilkan di Admin Console → "Kesehatan server". Ini fitur admin, jadi ditegakkan di server.
- **Alarm Telegram admin** (sekali per kejadian, dengan batas laju):
  - Event loop p99 > 200 ms selama 5 menit.
  - p95 API > 1 dtk selama 5 menit.
  - 5xx > 2% selama 5 menit.
  - Limit_req 503/429 > 50 per 5 menit.
  - RSS > 850 MB (sebelum pm2 memaksa restart di 1 GB).
- **Header `Server-Timing`** untuk membedakan "server lambat" dari "jaringan lambat" (terlihat di DevTools dan di `uji-beban`).

---

## 8. Gerbang performa untuk setiap perubahan (checklist PR)

- [ ] Tidak ada `*Sync` (fs, child_process, crypto) baru di jalur permintaan web.
- [ ] Data yang sama untuk banyak pengguna dihitung sekali (cache bersama, kunci memuat versi data). Error tidak di-cache. Cache punya batas entri.
- [ ] Respons besar punya batas (pagination/kolom terpilih). Body permintaan dibatasi.
- [ ] Polling baru: interval sesuai irama data, ETag, berhenti saat tersembunyi/di luar jam bursa, dan backoff.
- [ ] Tidak ada dependensi atau CDN baru tanpa izin. Tambahan JS/CSS awal dicatat (KB) dan ada alasannya.
- [ ] Angka sebelum dan sesudah terlampir (uji beban dan/atau metrik frontend).
- [ ] Fitur, hasil, dan tampilan identik (test + selisih piksel).

---

## 9. Prompt siap kirim

### 9.1 Roo — Gelombang 0 (baca-saja; kirim di luar jam bursa, setelah data pengejaran beres)

Versi lengkap siap kirim: `PROMPT_ROO_PERFORMA_G0.md`. Ringkasnya:

```text
# PROMPT: Ukur dan verifikasi performa multi-pengguna (Gelombang 0, baca-saja) · Roo Code
Mode Code tetapi READ-ONLY: jangan ubah kode, crontab, .env, nginx, data; jangan restart; 0 request ke penyedia data berkuota. Jangan cetak .env, kunci, token, IP VPS, lokasi kunci. Kutip bukti (baris log, hitungan, perintah).
Bacaan wajib: LAMPIRAN_PERFORMA_MULTIUSER.md (bagian 3 dan 5) dari pemilik.
A. Jalur trafik: bagaimana autocuan.web.id mencapai origin (DNS proksi Cloudflare ke nginx 80/443, atau Cloudflare Tunnel; port berapa)? Sebaran alamat di log akses nginx (alamat Cloudflare? 127.0.0.1? alamat pengguna)? Ada real_ip_header/set_real_ip_from (nginx -T, tanpa rahasia)? Jumlah baris "limiting requests" di log error nginx 14 hari, per hari dan per jam.
B. Beban hari bursa (pilih 2 hari terakhir yang normal): permintaan per jam per endpoint dan status (5xx/503/429/499). Kalau log tidak punya waktu respons, tulis begitu.
C. Scan DayTrade: dari log producer, durasi per batch, peak_rss, load1; bandingkan dengan waktu respons pengguna di dalam/di luar jendela scan bila datanya ada.
D. Kerja sinkron: frekuensi [VPS-FETCHER] stale/degraded/spawn_or_timeout per jam, dan endpoint pemicunya. Konfirmasi atau bantah P0-2 dengan bukti.
E. Supabase: jumlah kueri per permintaan premium (dari kode); pemilik akan menyalin paket dan pemakaian transfer bulan ini.
F. Mesin: nproc, uname -m, free -h, pm2 list (memori per proses), load average jam bursa.
G. Untuk setiap temuan P0-1..P0-4 dan P1-1..P1-13: terbukti / tidak / tidak bisa dipastikan, dengan bukti.
H. USULAN saja (jangan dikerjakan): urutan Gelombang 1 dan 2, perkiraan dampak, risiko, jalur kembali.
Laporan: backtest/arjum-audit/REPORT_PERFORMA_G0_<tanggal>.md lalu ringkas di chat. Tanpa rahasia.
```

### 9.2 Roo — Gelombang 1 (kirim setelah laporan G0 disetujui pemilik)

Versi lengkap siap kirim: `PROMPT_ROO_PERFORMA_G1.md`. Ringkasnya:

```text
# PROMPT: Perbaikan cepat performa server (Gelombang 1) · Roo Code
Dengan mengirim ini pemilik menyetujui butir G1-1..G1-7 di LAMPIRAN_PERFORMA_MULTIUSER.md bagian 5, HANYA yang terbukti di laporan G0. Di luar itu dilarang.
Aturan: branch fix/perf-g1 dari feat/daytrade-screener-v1; satu butir satu commit dengan test; npm run test:full; PR ke feat/daytrade-screener-v1; merge; di VPS git pull --ff-only; restart autocuan-web SEKALI sebelum 08:45 atau setelah 16:15 WIB (bukan jeda Jumat 11:30–14:00); nginx: cadangkan konfigurasi, nginx -t, reload; tulis jalur kembali siap tempel untuk tiap butir. Hasil data harus identik (test perbandingan). Fitur tidak boleh berkurang.
Pakai alat-performa/perf-metrics.js (sebagai lib/perf-metrics.js) bila belum terpasang, dan alat-performa/uji-beban.mjs untuk uji sebelum/sesudah pada salinan web port 3100 di jam aman (bukan produksi).
Laporan: per butir: commit, bukti sebelum/sesudah (p95, event loop p99, 503/429, kueri Supabase per permintaan), jalur kembali, risiko tersisa.
```

### 9.3 Antigravity — Gelombang 3 (frontend; setelah T1 di dokumen utama, atau saat pemilik minta)

```text
TUGAS: performa frontend Auto-Cuan Gelombang 3, butir F0 lalu F1–F3 (satu butir satu commit "perf(web): …"). Baca docs/redesign-handoff/LAMPIRAN_PERFORMA_MULTIUSER.md bagian 3 (P0-5, P1-11, P1-12) dan 5 (Gelombang 3).
ATURAN: fitur dan tampilan IDENTIK (selisih piksel tidak boleh memburuk), npm run test:full hijau, tidak ada dependensi/CDN baru, tidak menyentuh pipeline/keamanan server. Perubahan di lib/static-assets.js atau tools/local-dev-server.js: commit terpisah, catat untuk ditinjau Roo.
F0: ukur baseline (puppeteer-core yang sudah ada atau Playwright): Landing, Dashboard, Screener, Analisis, Bandarmologi di 390 dan 1440, CPU 4× dan 4G: LCP, TBT/long task, INP (event timing), KB JS/CSS diurai, jumlah DOM, jumlah permintaan. Simpan skrip pengukur di tools/perf/ dan hasil di handoff-redesign/perf/ (tidak di-commit).
F1: HTML no-cache + ETag (304). F2: 6 skrip inline ke file eksternal dengan urutan sama. F3: defer skrip non-kritis dengan urutan terjaga; skrip tema anti-kedip sebagai file kecil sinkron di <head>.
BERHENTI setelah F3. Laporan: tabel sebelum/sesudah per halaman, selisih piksel, hasil test, daftar perubahan server untuk Roo, risiko.
```

---

## 10. Keputusan pemilik dan pertanyaan terbuka

1. **Target pengguna bersamaan** (usulan: 200, lonjakan 3×). Menentukan seberapa jauh G2 dan G4 perlu.
2. **Urutan:** usulan Claude adalah **G0 setelah data pengejaran beres (Senin malam)**, G1 minggu ini, G2 minggu depan. G3 berjalan sejalan dengan redesign (setelah T1).
3. **Paket Supabase dan pemakaian transfer bulan ini** (dashboard Supabase).
4. **Kapasitas Oracle:** setuju dicek dan (bila A1) dinaikkan ke 2 OCPU / 12 GB dengan prosedur aman?
5. **Cloudflare:** setuju data **publik** (`landing-snapshot`, `tape`, `market-breadth`, indeks Bandarmologi publik) di-cache di edge 15–60 detik? Data premium tidak pernah di-cache edge.
6. **Landing terpisah (F11):** perlu atau tidak?

---

## 11. Risiko dan larangan

- Jangan menaikkan batas laju sebelum IP asli terbaca benar (bisa membuka jalan banjir permintaan).
- Jangan meng-cache data premium/pribadi di Cloudflare atau di kunci cache bersama tanpa tingkat akses.
- Jangan memindahkan scan DayTrade tanpa membandingkan hasil 3 hari (publikasi dan Telegram harus identik).
- Jangan menegakkan CSP sebelum skrip inline, handler `on…=`, dan CDN dipindahkan. Halaman bisa rusak total.
- Jangan uji beban ke produksi atau di jam sibuk. Alat menolak secara otomatis; jangan diakali.
- Setiap perubahan server: satu commit, test, jalur kembali, restart di luar jam bursa.

Sumber batas Always Free Oracle: dokumentasi resmi "Always Free Resources" (docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm), dibaca 24 Okt 2026.
