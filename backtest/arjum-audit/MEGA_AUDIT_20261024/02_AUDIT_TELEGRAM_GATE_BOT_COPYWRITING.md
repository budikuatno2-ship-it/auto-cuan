# LAPORAN FORENSIK 02: AUDIT PIPELINE TELEGRAM, VERIFIKASI MEMBER, BOT ARSITEKTUR & COPYWRITING
**Tanggal Audit:** 24 Oktober 2026  
**Status Sifat:** 100% READ-ONLY FORENSIC MEGA AUDIT  
**Modul Tercakup:** Modul 5, Modul 6, Modul 16, Modul 17  
**Auditor:** Roo Autonomous Software Engineer

---

## MODUL 5: PIPELINE TELEGRAM & GATEKEEPER PENGIRIMAN SINYAL

### 1. Alur Transmisi Sinyal (End-to-End)
Sinyal perdagangan yang dihasilkan oleh worker screener (DayTrade, Swing Konglo, Swing Non-Konglo, dan FastWatcher) melewati pipeline tersentralisasi sebelum disiarkan ke channel Telegram:

```
[Screener Workers / FastWatcher]
       │
       ▼ (Menghitung Scoring & Validasi R/R >= 1.50)
[lib/telegram-notifier.js]
       │
       ▼ (Format Template & Verifikasi Entitlement Tier)
[lib/telegram-delivery.js] ──► [Database: telegram_delivery_queue]
       │
       ▼ (HTTP POST ke Telegram Bot API / Rate Limiter)
[Telegram Channels: VIP Member / Radar / Admin Alert]
```

### 2. Antrean Pengiriman & Mekanisme Retry Atomik
* **Queue Persistence:** Sinyal yang gagal terkirim (misalnya akibat rate limit HTTP 429 dari Telegram atau koneksi jaringan terputus) dicatat ke tabel PostgreSQL `telegram_delivery_queue` dengan status `pending`.
* **Retry Worker:** Skrip [`deploy/vps/run-retry-telegram-delivery.sh`](deploy/vps/run-retry-telegram-delivery.sh:1) dijalankan via cron setiap 15 menit (`*/15 17-23 * * 1-5`).
* **Exponential Backoff:** Setiap pesan memiliki counter `retry_count`. Percobaan ulang dibatasi maksimal 5 kali dengan backoff bertingkat (1m, 5m, 15m, 30m, 60m). Setelah 5 kegagalan, status diubah menjadi `dead_letter` dan memicu alert log ke admin.

### 3. Anti-Spam & Deduplikasi Pesan
* **Idempotency Key:** Setiap sinyal memiliki hash unik: $\text{MD5}(\text{ticker} + \text{screener\_type} + \text{date} + \text{timeframe})$.
* **Deduplication Window:** Jika hash yang sama sudah terkirim dalam 90 menit terakhir, pesan otomatis dibuang (dropped) tanpa pengiriman ganda.
* **Burst Control:** Pengiriman dibatasi maksimal 20 pesan per menit ke channel publik dan 30 pesan per detik secara global untuk mematuhi Telegram API Limits.

---

## MODUL 6: TELEGRAM REGISTRATION & VERIFIKASI MEMBER (CHALLENGE V2)

### 1. Alur Registrasi & Verifikasi Sesi
Proses otorisasi akun pengguna ke channel VIP Telegram diatur oleh [`api/bot-register.js`](api/bot-register.js:1), [`lib/telegram-verification.js`](lib/telegram-verification.js:1), dan skema migrasi [`supabase/telegram-verification-v2-migration.sql`](supabase/telegram-verification-v2-migration.sql:1):

1. **Inisiasi di Web:** Pengguna terautentikasi meminta kode verifikasi via dashboard web Auto-Cuan.
2. **Generasi Challenge OTP:** Sistem menghasilkan kode 6-digit alfanumerik kriptografis (`crypto.randomBytes(3)`) yang disimpan di tabel `telegram_verification_challenges` dengan masa berlaku (TTL) **15 menit**.
3. **Kirim Perintah ke Bot:** Pengguna membuka bot verifikasi Telegram ([`tools/telegram-verify-bot.js`](tools/telegram-verify-bot.js:1)) dan mengirimkan perintah `/verify <KODE_6_DIGIT>`.
4. **Pencocokan & Pairing:** Bot mencocokkan kode OTP terhadap `user_id`. Jika cocok dan belum kedaluwarsa, sesi dinyatakan valid dan ID Telegram (`telegram_chat_id`) dipasangkan ke profil pengguna.

### 2. Admin Approval Gate & Kontrol Multi-Perangkat
Berdasarkan patch [`supabase/telegram-verification-v2-approval-gate-hotfix.sql`](supabase/telegram-verification-v2-approval-gate-hotfix.sql:1) dan [`supabase/admin-device-approval-migration.sql`](supabase/admin-device-approval-migration.sql:1):
* **Approval Gate:** Akun baru atau perangkat baru membutuhkan approval admin (`is_approved = true`) sebelum invite link channel VIP digenerate.
* **Device Limit:** Satu akun dibatasi maksimal 2 perangkat aktif secara bersamaan. Jika pengguna login dari perangkat ketiga, perangkat paling lama akan dipensiunkan (`retired`) via [`supabase/auth-telegram-recovery-v1-device-retirement-hotfix.sql`](supabase/auth-telegram-recovery-v1-device-retirement-hotfix.sql:1).

### 3. Siklus Invite Link & Revokasi Otomatis
Berdasarkan audit [`supabase/telegram-member-lifecycle-hotfix.sql`](supabase/telegram-member-lifecycle-hotfix.sql:1) dan [`supabase/telegram-invite-message-cleanup-hotfix.sql`](supabase/telegram-invite-message-cleanup-hotfix.sql:1):
* **Single-Use Primary Link:** Link undangan channel Telegram VIP dibuat menggunakan API `createChatInviteLink` dengan batas pemakaian 1 kali (`member_limit = 1`) dan kedaluwarsa 24 jam.
* **Pembersihan Pesan Transien:** Pesan bot yang berisi link undangan langsung dihapus (`deleteMessage`) setelah 10 menit atau segera setelah pengguna bergabung ke grup untuk mencegah tautan diteruskan (forwarding leak) ke pihak ketiga.
* **Auto-Kick Saat Berlangganan Habis:** Worker [`deploy/vps/run-lifecycle-evaluator.sh`](deploy/vps/run-lifecycle-evaluator.sh:1) yang dieksekusi setiap hari jam 16:30 WIB membandingkan tanggal akhir langganan (`subscription_expires_at`). Member yang sudah lewat jatuh tempo otomatis dikeluarkan (`banChatMember` lalu `unbanChatMember` untuk kick) dari grup/channel VIP.

---

## MODUL 16: STANDAR COPYWRITING TELEGRAM & KONSISTENSI NADA

### 1. Struktur Format Template Sinyal
Seluruh pesan sinyal di Telegram diformat menggunakan MarkdownV2 / HTML steril tanpa tag yang rusak:

#### Template Format DayTrade / FastWatcher Alert:
```text
🚨 [AUTO-CUAN FASTWATCHER] DETEKSI MOMENTUM LIVE
Emiten: #BBCA (Bank Central Asia Tbk)
Harga Terakhir: Rp 10.450 (+2,45%)
Volume Pace: 2.8x di atas rata-rata sesi normal

📊 PROFIL SETUP:
• Skenario: Day Trade / Scalping Momentum
• Area Entry: Rp 10.350 – Rp 10.450
• Stop Loss: Rp 10.150 (-2,8%) [KETAT]
• Target 1 (50% Lot): Rp 10.850 (+3,8%)
• Target 2 (50% Lot): Rp 11.100 (+6,2%)
• Risk/Reward Ratio: 1 : 2.40x (Lolos Risk Gate)

🛡️ KONFIRMASI BANDAR:
• Akumulasi: Big Accumulation (Top 3 Net Buyer: BK, CC, ZP)
• Net Foreign Flow: +Rp 142,5 Miliar

⚠️ DISCLAIMER RESMI:
Informasi ini merupakan alat bantu analisis kuantitatif mandiri, bukan rekomendasi atau ajakan membeli/menjual saham. Kelola ukuran lot dan batasi risiko sesuai profil Anda.
```

### 2. Standar Tone & Aturan Bahasa
* **Nada Profesional & Tenang:** Tidak menggunakan bahasa spekulatif atau janji keuntungan ("Pasti Cuan", "Hajar Kanan", "To the Moon").
* **Eksplisitkan Angka Risiko:** Setiap sinyal WAJIB menyertakan nominal Stop Loss dan persentase risiko sebelum menyebutkan Target Profit.
* **Penekanan Edukasi:** Menyertakan instruksi pelepasan parsial (scale-out 50% di TP1 dan pemindahan Stop Loss ke Breakeven).

---

## MODUL 17: ARSITEKTUR TELERAM BOT DI VPS

### 1. Karakteristik 3 Bot Auto-Cuan

| Komponen Bot | Entry Script | Mode Eksekusi | Peran & Tanggung Jawab |
|---|---|---|---|
| **Interactive Bot** | [`tools/telegram-interactive-bot.js`](tools/telegram-interactive-bot.js:1) | PM2 Service (`autocuan-bot`) | Menjawab perintah interaktif pengguna (`/start`, `/quote`, `/bandar`, `/plan`, `/help`) |
| **Verify Bot** | [`tools/telegram-verify-bot.js`](tools/telegram-verify-bot.js:1) | PM2 Service (`autocuan-verify-bot`) | Menangani autentikasi 6-digit challenge, invite link delivery, dan pairing perangkat |
| **Notifier Dispatcher** | [`lib/telegram-notifier.js`](lib/telegram-notifier.js:1) | CLI Worker via Cron | Menerima sinyal dari screener dan mengirimkan siaran broadcast ke Channel VIP & Admin Alert |

### 2. Alasan Arsitektur: Long Polling PM2 vs Webhook
Berdasarkan dokumentasi pada [`deploy/vps/final-schedule.cron`](deploy/vps/final-schedule.cron:100) dan log perbaikan sistem:
* **Kegagalan Mode Webhook Sebelumnya:** Webhook sebelumnya diarahkan ke serverless endpoint Vercel dan tunnel Cloudflare (`cloudflared`). Vercel sering mengembalikan HTTP 402 (Payment/Plan Limit) atau mengalami timeout edge, sementara tunnel cloudflared kerap terputus mendadak di VPS Oracle.
* **Migrasi ke Long Polling Mandiri:** Kedua bot interaktif kini berjalan sebagai background process PM2 di VPS menggunakan protokol **Long Polling (`getUpdates`)**.
* **Proteksi Watchdog:** Cron watchdog [`deploy/vps/check-verify-poller.sh`](deploy/vps/check-verify-poller.sh:1) dijalankan setiap 5 menit untuk memastikan bot polling tidak hang dan tidak terjadi status `409 Conflict` (yang terjadi jika webhook masih terdaftar di server Telegram).

### 3. Keamanan Kredensial & Isolasi Token
* **Variabel Lingkungan:** Token bot diisolasi di file environment server (`/home/ubuntu/auto-cuan-runner/.env`) dengan izin akses `chmod 600`.
* **Zero Leak Enforced:** Tidak ada token mentah yang dicatat pada file log `pm2 logs` atau diekspos ke respon API klien.
