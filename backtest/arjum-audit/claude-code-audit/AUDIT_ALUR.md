# Audit alur publik, akun, dan Telegram · Fase 1a (20 Okt 2026)

Metode:
- Telusur kode: route, handler, tabel, dan pesan error.
- Test otomatis yang ada, dengan mock Google dan Telegram: 52 file test auth/admin/sesi/Telegram/pemulihan/keamanan, **563 test lolos, 0 gagal**.
- Cek produksi read-only: GET tanpa sesi ke domain produksi. Tidak ada form yang dikirim dan tidak ada login.
- Cek konfigurasi VPS: hanya **ada/tidaknya** nama variabel di file env. Nilainya tidak pernah dicetak.

Tidak ada akun uji (`AC_TEST_USER` tidak diset), jadi alur yang butuh login di produksi dipindah ke `CEK_MANUAL_PEMILIK.md`.

Tingkat risiko: **TINGGI** = bisa disalahgunakan sekarang tanpa akun; **SEDANG** = perlu kondisi tambahan; **RENDAH** = kebersihan.

## Ringkasan diurutkan dari yang paling berbahaya

| # | Risiko | Temuan | Bukti | Perbaikan | Butuh "deploy"? |
|---|---|---|---|---|---|
| 1 | **TINGGI** | **Seluruh folder `data/` di server bisa diunduh publik tanpa login.** Termasuk `/data/screener-latest.json` (hasil screener premium, 3,9 MB) dan file mentah broker summary dari penyedia data berlisensi (`/data/arjum-data/broker-summary/<T>/…`). Folder ini 7,9 GB. File token bot tidak ikut terbuka karena ada di folder runner, bukan `data/` | GET produksi `/data/screener-latest.json` → 200, 3.892.190 byte; `/data/arjum-data/broker-summary/BBCA/latest.json` → 200. Kode: `tools/local-dev-server.js:1657-1658` (`serveData` untuk semua path `/data/`) | Batasi ke allowlist yang dipakai frontend saja: `/data/bandarmologi-intel-indexes/latest_*` (`public/bandarmologi-runtime.js:4582`). Path lain 404. Tambah test | ya |
| 2 | **TINGGI** | **Tidak ada batas percobaan login di produksi.** `SECURITY_GUARD_MODE=off` dan `RECAPTCHA_SECRET_KEY` tidak diset, sehingga reCAPTCHA berjalan *fail-open* (`lib/recaptcha-verify.js:45-46`). Tebakan password ke `/api/login-user` tidak dibatasi | Cek nama variabel di semua file env VPS; `api/login-user.js:634-670` | Pilihan pemilik: (a) nyalakan guard `shadow` lalu `enforce` setelah migrasi Supabase dicek, atau (b) pasang batas per IP + per username di handler (in-memory, memakai IP asli dari Cloudflare, lihat #4). Saran: (b) sekarang, (a) menyusul | ya |
| 3 | **SEDANG** | **Password diganti, sesi lain tetap hidup sampai 10 jam.** Sesi adalah token HMAC stateless (`lib/admin-session.js:20-22`, `SESSION_MAX_AGE_SECONDS = 36000`). Tidak ada versi sesi per akun. Logout hanya menghapus cookie di browser itu | Kode | Tambah `pwv` (versi credential) ke token dan cek terhadap DB di `requireAuthenticatedSession`, atau simpan `sessions_revoked_at` per akun | ya |
| 4 | **SEDANG** | **Batas pendaftaran bisa dilewati** dengan header `X-Forwarded-For` palsu: IP klien diambil dari nilai **pertama** header itu, yang dikirim klien (`lib/request-rate-limit.js:52-65`) | Kode | Di belakang Cloudflare pakai `CF-Connecting-IP`, atau nilai XFF **terakhir** yang ditambahkan proxy tepercaya | ya |
| 5 | **SEDANG** | **Mode pemeliharaan hanya di UI.** Server tidak menolak API data saat pemeliharaan aktif; layar pemeliharaan hanya overlay di browser | `lib/maintenance-state.js` hanya dibaca oleh `api/maintenance-settings.js` dan alur kode admin; tidak ada pemeriksaan di `api/sector-hot.js`/`api/quote.js` | Tolak (503) endpoint data untuk non-admin saat `maintenanceMode=true`, dengan cache status 30 detik | ya |
| 6 | **SEDANG** | **Anggota yang masa aktifnya habis tidak dikeluarkan dari grup/channel Telegram.** Tidak ditemukan jalur `banChatMember`/pencabutan berdasarkan kedaluwarsa. Job lifecycle (`tools/run-telegram-lifecycle.sh`: pengingat dan tinjauan 30 hari) **tidak ada di crontab** | Kode + `crontab -l` | Keputusan pemilik: jadwalkan lifecycle; tambah langkah keluarkan anggota kedaluwarsa (butuh desain + test) | ya |
| 7 | **SEDANG** | **Tombol "Masuk dengan Google" tampil, padahal fitur mati di produksi.** `GET /api/auth/google` menjawab 503 "belum dikonfigurasi"; tidak ada `GOOGLE_*CLIENT_ID` di env VPS | GET produksi; `public/index.html:848` (sebelum perbaikan) | **Diputuskan pemilik 20 Okt: Google login dibatalkan.** Tombol dan pemisah "atau" dihapus dari modal Masuk (belum di-commit, belum deploy). Lihat bagian "Keputusan pemilik: Google login dibatalkan" | ya |
| 8 | **SEDANG** | Header keamanan halaman `/` di produksi: **tidak ada `Content-Security-Policy`** dan **tidak ada HSTS** (`vercel.json` punya keduanya, tetapi server VPS tidak mengirimnya). `X-Content-Type-Options` terkirim dua kali | `curl -D -` produksi | Kirim header yang sama dari `tools/local-dev-server.js` untuk HTML, minimal `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`. Beacon Cloudflare sudah ditolak CSP di `methodology.html` (lihat Fase 0) | ya |
| 9 | **SEDANG** | **Aturan password tidak bisa ditegakkan di server.** Klien mengirim hash, bukan password, jadi panjang/kerumitan hanya dicek di browser | `api/login-user.js:711`, `lib/password-credential.js` | Dicatat. Perubahan skema credential di luar cakupan redesign | tidak (catatan) |
| 10 | **SEDANG** | Endpoint publik Bandarmologi bisa memicu request **live ke penyedia data** saat tanggal/ticker belum ada di arsip (3 request per kombinasi: summary, akumulasi, insider). Pengunjung anonim bisa menghabiskan kuota harian | `lib/bandarmologi-service.js:2105-2117`, `2431-2437`; dispatch sebelum gerbang premium (`api/sector-hot.js:211`) | Untuk pengunjung tanpa sesi: hanya baca arsip, tanpa request live. Atau batasi per IP | ya |
| 11 | RENDAH | Pendaftaran membocorkan keberadaan email ("Email sudah digunakan.") | `api/register-user.js:186,237` | Pesan netral + verifikasi lewat Telegram | ya |
| 12 | RENDAH | Masa berlaku token pendaftaran bot: komentar bilang 10 menit, kode **2 jam** | `lib/telegram-register-token.js:14` vs `:24` | Samakan (keputusan pemilik: 10 menit lebih aman) | ya |
| 13 | RENDAH | Admin dari login Google ditentukan dari nama: `adm: user.username === 'budi'` | `lib/auth-service.js` (jalur Google, saat ini mati) | Ambil flag admin dari kolom peran di DB, sama seperti login biasa | ya |

Tidak ditemukan:
- Secret/token di JavaScript klien (pola kunci API, JWT service role, token bot, kunci reCAPTCHA).
- Open redirect lewat `next`/`redirect`: satu-satunya `location.assign` dinamis memakai `auth_url` dari server (`public/legacy-gmail-runtime.js:67`).
- Akses admin tanpa sesi: endpoint admin menolak GET (405); endpoint tulis memeriksa sesi admin di server (`requireAdminSession`, `lib/admin-session.js:155`) dan same-origin (`isSameOrigin`). Endpoint premium menjawab 401 tanpa sesi.
- `/.env` dan `/.git/config` di produksi: 404.

## Keputusan pemilik: Google login dibatalkan (20 Okt 2026)

- Google login **tidak** diaktifkan dan **tidak** disiapkan flag OAuth.
- Akun memakai Gmail yang **diketik manual**, di form Daftar dan di Lengkapi Gmail.
- Penyimpangan dari kanvas: `AuthLogin.dc.html` masih memuat "atau Masuk dengan Google". Keputusan pemilik menimpa kanvas, dan penyimpangan ini dicatat (bukan kelalaian).

**Yang diubah di UI** (branch `redesign/v2`, belum di-commit):
- `public/index.html`: tombol `#loginGoogleBtn` dan pemisah "atau" dihapus dari modal Masuk.
- `public/ui-theme.css`: semua aturan `.login-google-*` dihapus (tiga blok: Wave 8B, kontras terang/gelap, Wave 8D, plus satu aturan di media query HP).
- `test/wave8b-login-account-refinements.test.js`: test lama yang mewajibkan tombol ada diganti test yang memastikan tombol dan CSS-nya tidak ada.
- Bukti: modal Masuk di 390 dan 1440 tanpa tombol Google, 0 error halaman (`handoff-redesign/audit/login-tanpa-google-390.png`, `-1440.png`). Test terkait (58 file yang membaca modal Masuk atau `ui-theme.css`) lolos. D3 sempat gagal saat dijalankan paralel, lalu lolos 14/14 saat sendiri, sama seperti baseline.

**Kode OAuth Google lama dibiarkan, tidak dihapus.** Roo yang memutuskan nanti. Daftar file terkait:

| File | Isi yang terkait Google |
|---|---|
| `lib/google-oauth-service.js` | Konfigurasi OAuth (client id/secret/redirect dari env), `state` + PKCE, tukar kode, verifikasi token ID, `email_verified` |
| `lib/google-link-state.js` | Status tautan Google per akun |
| `lib/auth-service.js` | `GET/POST /api/auth/google` dan `/api/auth/google-register`; 503 kalau client id kosong; jalur yang menentukan admin dari nama `budi` (temuan #13) |
| `lib/legacy-gmail-handler.js` | Aksi `account-google-link-url`, `account-google-link-callback`, `account-google-status`; juga aksi dorman `account-email-complete` (Gmail diketik manual), yang akan dipakai halaman Lengkapi Gmail |
| `lib/reset-password-legacy-handler.js` | Membaca status tautan Google (`readGoogleLinkState`) untuk profil akun |
| `api/reset-password.js` | Meneruskan aksi `account-google-*` ke handler di atas |
| `supabase/subscription-trial-google-link-migration.sql` | Tabel/kolom tautan Google dan RPC `consume_oauth_state` |
| `public/index.html` | Fungsi klien yang sekarang tidak terjangkau lagi: `initiateGoogleAuth()` (sekitar baris 6093), pemuat skrip `accounts.google.com/gsi/client`, modal `#googleCompleteProfileModal` dan `submitGoogleProfile` (`/api/auth/google-register`) |
| `public/legacy-gmail-runtime.js` | Dialog "Hubungkan Akun Google" dengan tombol "Tautkan Akun Google" (redirect OAuth). Hanya muncul kalau server bilang `google_link_required`, jadi tidak muncul selama OAuth mati. **Diganti oleh halaman Lengkapi Gmail (Gmail diketik manual) di Fase 3**, memakai aksi dorman `account-email-complete` |
| `public/account-center-v1.js:247` | Tampilan Pusat Akun membedakan `auth_provider === 'google'` |
| `test/auth-google-security.test.js`, `test/wave8-auth-account-system-states.test.js`, `test/wave8-trial-google-link-contract.test.js` | Test untuk kode OAuth di atas (masih lolos, tidak diubah) |
| `tools/capture-wave8d-evidence.js` | Skrip bukti lama yang mencari `.login-google-btn`; akan gagal kalau dijalankan lagi, tidak dipakai di alur kerja sekarang |

## Rincian per alur

### 1. Landing
- Langkah: muat `/` anonim di 390/1024/1440, cek tautan, angka, meta, 404.
- Hasil:
  - Landing snapshot dari Supabase `kv_store` (diperbarui 19 Okt 22:15), bertanda `stale:false`.
  - Angka strip memakai data snapshot, bukan karangan. Sumbernya tertulis "Level dari snapshot, bukan harga langsung."
  - Meta `canonical`/`og:url` ke domain produksi ada.
  - 404 memakai `404.html` (status 404).
  - Muat produksi di 390px: 2,0 detik (`networkidle2`), HTML 236 KB setelah brotli.
- Bug:
  - Probe `/api/reset-password` selalu 401 untuk pengunjung anonim.
  - Tombol Google mati (#7).
  - Kontras 12 teks gagal (lihat `AUDIT_HALAMAN.md`).
  - LCP belum diukur (perlu trace Lighthouse, dijadwalkan di Fase 3 Landing).

### 2. Masuk (email/username + password)
- Pesan salah password dan akun tidak ada **sama** (`GENERIC_CREDENTIAL_ERROR`). Status blokir/belum disetujui baru muncul setelah password benar (`api/login-user.js:690-720`). **Lolos.**
- Batas percobaan: **tidak aktif di produksi** (#2).
- "Ingat saya": sesi tetap 10 jam, tidak ada pilihan lebih panjang. Perlu cek manual apakah ada kotak centangnya.
- Cookie `ac_sess`: `HttpOnly; SameSite=Strict; Secure` (produksi) (`lib/admin-session.js:179-183`). **Lolos.**
- Logout di semua tab: cookie dihapus server (`api/login-user.js:614`); tab lain ikut keluar di request berikutnya. Sesi di perangkat lain **tidak** dicabut (#3).
- Sesi kedaluwarsa: `exp` dicek server (`lib/admin-session.js:119`). **Lolos.**

### 3. Daftar
- Validasi server: persetujuan ketentuan, Gmail wajib (`@gmail.com`), username 2–30 karakter dengan karakter terbatas, username/email ganda ditolak.
- Kode verifikasi lewat Telegram. Panel persetujuan admin ada (`registerApprovalPanel`).
- Pesan sukses: ada (`registerSuccess`).
- Pilihan paket saat daftar: tidak ada; paket dipilih di Pusat Akun.
- Bug: #4, #9, #11.

### 4. Daftar/masuk lewat Google
- Produksi: **tidak dikonfigurasi** (503).
- Kode: `lib/google-oauth-service.js` memakai `state` acak 32 byte, disimpan dan dipakai sekali lewat RPC `consume_oauth_state`. Ada PKCE (`codeVerifier`). Email tanpa `email_verified` ditolak (`:341`, `:384`). `client_id` hanya dibaca dari env server.
- Email Google yang sama dengan akun lama: langsung masuk ke akun itu (`lib/auth-service.js`, jalur Google), aman karena token ID Google diverifikasi tanda tangannya dan email wajib terverifikasi.
- Aturan "Gmail wajib" (legacy): akun ber-email Gmail harus masuk dengan email, bukan username (`api/login-user.js:700-709`).
- Batal di tengah jalan dan akun tanpa email terverifikasi: dicakup test (lolos), cek manual setelah OAuth aktif.

### 5. Menunggu persetujuan admin
- Server: endpoint premium memakai `requirePremiumEntitlement` (`api/sector-hot.js:320-324`); tanpa persetujuan → 401/403. `web-daily-picks` dan `web-top5-history` menjawab `gated:true` tanpa data. **Dicek di server, lolos** (tanpa sesi).
- Akun pending dengan sesi: belum bisa diuji di produksi (tidak ada `AC_TEST_PENDING_USER`). Masuk ke cek manual.
- Setujui/tolak: `api/admin-users.js` (POST, admin + same-origin). Notifikasi ke pengguna lewat bot verifikasi. Detail di cek manual.

### 6. Bot Telegram
- Menghubungkan akun: token pendaftaran acak, sekali pakai (status `used` + `used_at`), kedaluwarsa (`lib/telegram-register-token.js:126-155`). TTL 2 jam (#12).
- Token tidak ditemukan di pemanggilan `console.log` handler Telegram.
- Memutus hubungan, daftar perintah, pilihan langganan broadcast: cek manual.
- Broadcast berbayar ke pengguna kedaluwarsa: belum terbukti dari kode, masuk cek manual + #6.

### 7. Grup Telegram
- Link undangan dibuat per orang: `createChatInviteLink` dengan `expire_date` (~30 menit) dan mode join-request, lalu dicabut (`revokeChatInviteLink`) setelah dipakai (`lib/telegram-verification.js:1512-1520`, `1976-1991`). Tidak ada `member_limit` karena memakai persetujuan join-request. **Bukan link permanen.**
- Link hanya dikirim lewat DM bot, tidak ada di halaman publik (grep `t.me/+` di `public/`: tidak ada).
- Anggota kedaluwarsa: **tidak dikeluarkan** (#6).

### 8. Pemulihan password
- Kode pemulihan lewat Telegram: request berlaku 10 menit, izin reset 10 menit (`lib/auth-recovery.js:7-9`), dipakai lewat RPC (sekali pakai).
- Kebocoran "email terdaftar atau tidak": pesan perlu dicek manual di UI.
- Sesi lain keluar setelah ganti password: **tidak** (#3).

### 9. Peran dan akses (request langsung ke API)
- Tanpa sesi:
  - `admin-users`, `admin-logs`, `reset-password?action=account-profile` → 405 untuk GET (hanya POST);
  - `screener`, `daytrade-screener`, `sector-hot`, `daily-market-context-list`, `money-management` → 401;
  - `create-screener-share-link`, `debug-members`, `landing-snapshot-refresh` → 401.
- Dengan sesi non-admin: endpoint tulis memanggil `requireAdminSession` → 403 (dicakup test `admin-session-auth`, `admin-token-security-fix`, lolos). Uji langsung di produksi butuh akun uji non-admin.
- Pattern Radar: di UI hanya disembunyikan untuk non-admin (`public/index.html:6612`). Datanya memakai endpoint screener/candle yang juga terbuka untuk anggota premium. Tidak ada data khusus admin yang bocor, tapi "khusus admin" belum ditegakkan di server. Akan dibuat route admin di Fase 3 no.22.
- Catatan Admin §5d belum ada (fitur baru).

### 10. Mode pemeliharaan
- Pengguna melihat layar pemeliharaan (`#maintenanceScreen`). Admin masuk lewat kode admin Telegram (`lib/admin-maintenance-code*.js`, cookie perangkat `HttpOnly; SameSite=Strict`).
- Server tidak memblok API data (#5).

## Keamanan lintas alur

| Cek | Hasil |
|---|---|
| Secret di JS klien | Tidak ditemukan |
| Open redirect `next`/`redirect` | Tidak ditemukan |
| Cookie sesi | `HttpOnly` + `Secure` + `SameSite=Strict` |
| CSRF di POST | `SameSite=Strict` + `isSameOrigin` (Origin/Referer) di endpoint admin, log, maintenance, profil. Kalau Origin dan Referer sama-sama kosong, request diloloskan (mengandalkan SameSite) |
| Data pribadi di log | Login gagal tidak mencatat username. `autocuan-web-error.log` didominasi peringatan harga basi. Belum ada audit penuh isi log |
| Header | Produksi `/`: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` ada; **CSP dan HSTS tidak ada** (#8) |
| Port jembatan data 3001 | Server mengikat `0.0.0.0:3001`, tetapi tidak terjangkau dari luar (firewall). Aman untuk sekarang; sebaiknya diikat ke `127.0.0.1` |
