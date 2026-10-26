# LAPORAN FORENSIK 04: KUALITAS DATA, KEAMANAN SISTEM, ARSITEKTUR & MASTER DAFTAR BUG (18 MODUL)
**Tanggal Audit:** 24 Oktober 2026  
**Status Sifat:** 100% READ-ONLY FORENSIC MEGA AUDIT  
**Modul Tercakup:** Modul 14, Modul 18, dan Tabel Master Seluruh Bug  
**Auditor:** Roo Autonomous Software Engineer

---

## MODUL 14: KUALITAS DATA, KECEPATAN & KONTROL FRESHNESS

### 1. Kebijakan Caching & Latensi
Sistem Auto-Cuan menerapkan arsitektur caching 3-tier:
1. **Tier 1 (Browser SWR):** Diimplementasikan via [`public/tab-keepalive-runtime.js`](public/tab-keepalive-runtime.js:1). Klien menyimpan state data per ticker dalam `sessionStorage`. Perpindahan tab antar-lensa (Chart, Bandarmologi, Financial) merender tampilan secara instan (< 16ms / 60fps) tanpa flash putih, sementara data terbaru diverifikasi di latar belakang (stale-while-revalidate).
2. **Tier 2 (VPS Memory & Local Disk):** Data broker summary unclipped dan market context disimpan dalam file JSON terindeks pada filesystem VPS (`data/arjum-data/` dan `data/broker-hunter-indexes/`), menghilangkan kebutuhan memanggil API eksternal untuk request yang sama.
3. **Tier 3 (Database PostgreSQL):** Snapshot materialized disimpan dalam tabel PostgreSQL Supabase untuk konsumsi publik.

### 2. Deteksi Data Stale & Warning Banners
* Pada antarmuka pengguna ([`public/wave3-primitives-preview.html`](public/wave3-primitives-preview.html:367), [`public/market-feature-runtime.js`](public/market-feature-runtime.js:1)), jika timestamp data penutupan terakhir lebih tua dari hari bursa aktif sebelumnya, sistem menampilkan banner peringatan oranye:
  `"Data Penutupan Belum Terbaru · Snapshot terakhir dicatat pada YYYY-MM-DD HH:MM WIB"`.
* Nilai yang tidak tersedia dirender secara jujur sebagai `—` atau `Belum Terverifikasi`, melarang keras pemaksaan angka menjadi `0` atau `Rp 0` (kebijakan anti-slop).

### 3. Performa Rendering Frontend
* **Lightweight Charts V4:** Menggunakan canvas 2D terakselerasi perangkat keras dengan touch handling selektif (drag horizontal untuk pan chart, sedangkan scroll vertikal diserahkan ke dokumen halaman agar navigasi mobile tidak terjebak).
* **Ukuran Asset:** Tailwind CSS di-compile statis menjadi file tunggal berukuran 42 KB (8 KB gzipped) di [`public/tailwind-build.css`](public/tailwind-build.css:1), menghindari kompilasi runtime browser yang membebani CPU klien.

---

## MODUL 18: KEAMANAN SISTEM, JARINGAN, ARSITEKTUR & TEMUAN BUG

### 1. Kerentanan Jaringan & Nginx Proxy (Missing Real-IP Header)
* **Temuan:** Berkas [`deploy/nginx/autocuan`](deploy/nginx/autocuan:1) menggunakan direktif `limit_req_zone $binary_remote_addr zone=autocuan_limit:10m rate=30r/s;`.
* **Cacat Keamanan:** Nginx tidak memiliki konfigurasi `set_real_ip_from` Cloudflare IP ranges dan `real_ip_header CF-Connecting-IP;`.
* **Dampak:** Karena traffic web melewati CDN Cloudflare, variabel `$binary_remote_addr` berisi alamat IP proxy Cloudflare, BUKAN alamat IP pengunjung asli. Jika satu pengguna mengirimkan request berlebih, rate limiter Nginx akan memblokir seluruh pengguna lain yang kebetulan dialihkan melalui simpul edge Cloudflare yang sama!

### 2. Kebocoran Informasi Kredensial & Hardcoded Path
* Pada [`deploy/nginx/autocuan:45`](deploy/nginx/autocuan:45): Terdapat hardcoded alamat IP publik VPS (`<IP_VPS>`).
* Pada [`lib/vps-data-fetcher.js:29-30`](lib/vps-data-fetcher.js:29): Terdapat hardcoded Windows private key path (`D:\Private Key Oracle\ssh-key-2026-07-02.key`) dan target host `ubuntu@<IP_VPS>`.
* Pada [`deploy/vps/telegram-interactive-bot.env.example`](deploy/vps/telegram-interactive-bot.env.example:1): Terdapat hardcoded ID grup Telegram internal.

### 3. Keamanan Database Supabase & Row Level Security (RLS)
* **RLS Enforcement:** Tabel-tabel sensitif (`user_profiles`, `telegram_verification_challenges`, `subscription_payments`, `security_login_limits`) memiliki status `ENABLE ROW LEVEL SECURITY;`.
* **Proteksi Service Role:** Seluruh penulisan data sistem dan screener picks dibatasi hanya untuk koneksi yang menggunakan `SUPABASE_SERVICE_ROLE_KEY`, sedangkan koneksi publik / anonim hanya memiliki hak baca parsial atau eksekusi fungsi `SECURITY DEFINER` yang tervalidasi.

---

## MASTER DAFTAR TEMUAN BUG & KEKURANGAN SISTEM (18 MODUL)

Tabel berikut merangkum seluruh temuan defek, anomali logika, dan risiko arsitektur yang teridentifikasi secara objektif selama audit forensik:

| No | Modul | Severity | Lokasi File & Baris | Deskripsi Masalah | Akar Masalah | Dampak Nyata | Rekomendasi Solusi |
|:---:|:---:|:---:|:---|:---|:---|:---|:---|
| **1** | Modul 12 | **CRITICAL** | [`lib/broksum-flow.js:46-50`](lib/broksum-flow.js:46) | Kalkulasi Aliran Domestik ($D = \text{ALL} - F$) menimpa data All sebagai Domestik jika Foreign Broksum kosong | `if (!foreignBroksum) return Object.assign({}, allBroksum, { flow: 'D', is_complete: true })` | Total Turnover disalahartikan sebagai Pembelian/Penjualan Domestik murni saat data asing belum terunduh | Kembalikan objek dengan `is_complete: false` dan `status: 'foreign_missing'` |
| **2** | Modul 18 | **HIGH** | [`deploy/nginx/autocuan:1-10`](deploy/nginx/autocuan:1) | Rate limiter Nginx membaca IP Cloudflare bukannya Client Real IP | Ketiadaan direktif `set_real_ip_from` dan `real_ip_header CF-Connecting-IP` | Seluruh pengguna di satu edge Cloudflare bisa terkena blokir rate-limit bersamaan | Pasang daftar CIDR IP Cloudflare dan aktifkan `real_ip_header CF-Connecting-IP;` di Nginx |
| **3** | Modul 18 | **HIGH** | [`lib/vps-data-fetcher.js:29-30`](lib/vps-data-fetcher.js:29) & [`deploy/nginx/autocuan:45`](deploy/nginx/autocuan:45) | Hardcoded IP publik VPS dan Absolute Windows SSH Key Path | Nilai statis ditulis langsung ke dalam source code repositori | Potensi kebocoran informasi topologi server dan kegagalan fungsi di mesin lain | Pindahkan konfigurasi ke variabel lingkungan (`.env`): `VPS_SSH_KEY_PATH` & `VPS_IP` |
| **4** | Modul 1 | **HIGH** | [`supabase/daytrade-screener-run-speed-migration.sql:1`](supabase/daytrade-screener-run-speed-migration.sql:1) | DayTrade scanner sempat membeku (stalled) 20 hari (30 Sep – 20 Okt 2026) | Run FAST 15-menit menuliskan flag `completed` pada runner status, mematikan full scan EOD | Evaluasi menyeluruh 800+ emiten terhenti setiap malam | Pertahankan pemisahan eksplisit `run_speed = 'FULL'` vs `'FAST'` (sudah dipatch) |
| **5** | Modul 10 | **MEDIUM** | [`tools/backfill-broksum.js:247-290`](tools/backfill-broksum.js:247) | Hardcoded daftar tanggal bursa dari 2026-01-02 hingga 2026-10-16 | Array statis alih-alih membaca tabel `idx_trading_calendar` | Script backfill tidak dapat memproses tanggal setelah 16 Oktober tanpa edit kode manual | Hubungkan ke fungsi `getIdxTradingDays()` dari `lib/idx-trading-calendar.js` |
| **6** | Modul 13 | **MEDIUM** | [`deploy/vps/final-schedule.cron`](deploy/vps/final-schedule.cron:30) & filesystem VPS | Tidak adanya log rotation pada runner logs di `/home/ubuntu/auto-cuan-runner/logs/` | Output cron diarahkan dengan `>>` tanpa konfigurasi `logrotate` | Ukuran file log membengkak (> 200 MB), berisiko menghabiskan kapasitas disk partisi root VPS | Pasang konfigurasi `/etc/logrotate.d/autocuan` dengan rotasi harian dan kompresi gzip |
| **7** | Modul 18 | **MEDIUM** | [`lib/vps-data-fetcher.js:65`](lib/vps-data-fetcher.js:65) | Penggunaan `execFileSync` synchronous blocking saat fetch file remote VPS | Eksekusi child process SSH secara sinkron | Event loop Node.js membeku selama koneksi SSH berlangsung (hingga timeout 20 detik) | Refactor menjadi asynchronous berbasis `child_process.execFile` dengan Promise |
| **8** | Modul 11 | **MEDIUM** | Filesystem VPS: `data/arjum-data/` | Ketiadaan file `latest.json` untuk kategori AKUMULASI dan INSIDER | Runner hanya menulis `latest.json` untuk ALL dan F | Modul yang mengandalkan pointer `latest.json` pada akumulasi gagal membaca cache terbaru | Tambahkan pembuatan symlink/file `latest.json` saat job akumulasi & insider selesai |
| **9** | Modul 13 | **LOW** | Root repositori | Keberadaan 5 file artefak sampah 0-byte berkarakter aneh di root | Kesalahan syntax command piping terminal | Mengotori struktur repositori git | Hapus 5 file junk: `console.log(p.name`, `missing')`, `{console.log('KEYS`, `{try{const`, `tmp_fail.log` |
| **10** | Modul 17 | **LOW** | [`deploy/vps/telegram-interactive-bot.env.example:5`](deploy/vps/telegram-interactive-bot.env.example:5) | Hardcoded ID grup Telegram internal di file template contoh | ID grup `-100...` tertulis di file `.env.example` | Mengekspos identifier internal grup/channel ke publik repositori | Ganti nilai ID grup dengan placeholder `<TELEGRAM_GROUP_ID>` |
