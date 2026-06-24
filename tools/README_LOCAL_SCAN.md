# Auto-Cuan Local Scan Runner

Jalankan screener scan dari CMD lokal. Hasil langsung update ke website.

## Cara Pakai Paling Gampang

1. Pull latest branch.
2. Jalankan `tools\SETUP_LOCAL_SCAN_ENV.bat` **sekali saja** (setup env).
3. Double-click `tools\AUTO_CUAN_SCAN_MENU.bat`.
4. Pilih scan dari menu.
5. Buka/refresh website untuk lihat hasil.

Setelah setup selesai, kamu hanya perlu double-click `AUTO_CUAN_SCAN_MENU.bat` setiap kali mau scan.

## Desktop Shortcut

Biar lebih gampang:

1. Klik kanan `tools\AUTO_CUAN_SCAN_MENU.bat`
2. Pilih "Send to" > "Desktop (create shortcut)"
3. Rename shortcut jadi "Auto-Cuan Scan Menu"

## Setup (Sekali Saja)

### Opsi 1: Pull otomatis dari Vercel (recommended)

Jika sudah install Vercel CLI dan sudah login:

```
cd auto-cuan
npx vercel env pull .env.local --environment=preview
```

Atau double-click `tools\SETUP_LOCAL_SCAN_ENV.bat` dan pilih "y" saat ditanya.

### Opsi 2: Buat manual

Buat file `.env.local` di ROOT project dengan isi:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
CRON_SECRET=your-cron-secret
```

Nilai bisa dicopy dari:
- Vercel Dashboard > Project > Settings > Environment Variables
- Supabase Dashboard > Settings > API

## Kenapa Butuh Environment Variables?

Runner ini menjalankan logic scan yang sama persis dengan yang berjalan di server (Vercel).
Hasilnya ditulis langsung ke Supabase, sehingga website otomatis menampilkan hasil terbaru.

Variable yang diperlukan:

| Variable | Keterangan |
|----------|-----------|
| `SUPABASE_URL` | URL project Supabase (untuk baca/tulis data) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key Supabase (akses penuh) |
| `CRON_SECRET` | Secret autentikasi scan (sama dengan Vercel env) |

## Menu Scan

| No | Pilihan | Fungsi |
|----|---------|--------|
| 1 | Run Konglo | Scan Swing Konglo |
| 2 | Run Non-Konglo | Scan Swing Non-Konglo |
| 3 | Run Swing All | Konglo dulu, lalu Non-Konglo |
| 4 | Run Day Trade Morning | Day Trade mode Morning |
| 5 | Run Day Trade Midday | Day Trade mode Midday |
| 6 | Run Day Trade Afternoon | Day Trade mode Afternoon |
| 7 | Run Day Trade Full | Day Trade Full Scan |
| 8 | Exit | Keluar |

## Shortcut Langsung (Opsional)

| File | Fungsi |
|------|--------|
| `RUN_KONGLO.bat` | Langsung jalankan Konglo |
| `RUN_NON_KONGLO.bat` | Langsung jalankan Non-Konglo |
| `RUN_SWING_ALL.bat` | Langsung jalankan Swing All |
| `RUN_DAYTRADE_MORNING.bat` | Langsung Day Trade Morning |
| `RUN_DAYTRADE_MIDDAY.bat` | Langsung Day Trade Midday |
| `RUN_DAYTRADE_AFTERNOON.bat` | Langsung Day Trade Afternoon |
| `RUN_DAYTRADE_FULL.bat` | Langsung Day Trade Full |

## Urutan Rekomendasi

1. **Run Konglo** — scan grup konglomerat
2. **Run Day Trade** (sesuai jam) — radar intraday
3. **Run Non-Konglo** atau **Swing All** — scan di luar jam trading

## Catatan Penting

- Day Trade scan berbasis candle harian sebagai radar awal. Konfirmasi intraday tetap wajib.
- Secret tidak pernah di-print ke console.
- Jangan share `.env.local` ke siapapun.
- Jangan commit `.env.local` ke git (sudah otomatis di-ignore).
- `.bat` file hanya bisa jalan dari folder project (butuh `node_modules`, `api/`, `lib/`).
