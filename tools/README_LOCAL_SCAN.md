# Auto-Cuan Local Scan Runner

Jalankan screener scan dari CMD lokal. Hasil langsung update ke website.

**Tidak perlu install Node.js, npm, npx, atau Vercel CLI.**

## Cara Pakai Paling Gampang

1. Pull/download repo terbaru.
2. Double-click `tools\AUTO_CUAN_SCAN_MENU.bat`.
3. Pertama kali: isi API URL dan CRON_SECRET (sekali saja).
4. Pilih scan dari menu.
5. Buka/refresh website Auto-Cuan untuk lihat hasil.

Setelah setup pertama, kamu hanya perlu double-click `AUTO_CUAN_SCAN_MENU.bat`.

## Desktop Shortcut

Biar lebih gampang:

1. Klik kanan `tools\AUTO_CUAN_SCAN_MENU.bat`
2. Pilih "Send to" > "Desktop (create shortcut)"
3. Rename shortcut jadi "Auto-Cuan Scan"

## Setup Pertama Kali

Saat pertama kali menjalankan menu, kamu akan diminta:

| Input | Keterangan | Contoh |
|-------|-----------|--------|
| API Base URL | URL deployment Vercel | `https://auto-cuan-xxxx.vercel.app` |
| CRON_SECRET | Secret dari Vercel Env Variables | (tersembunyi saat diketik) |
| Bypass Token | Opsional — kosongkan jika tidak perlu | (kosong) |

Nilai disimpan di: `%USERPROFILE%\.auto-cuan-scan.env`
(di luar repo, tidak pernah ter-commit)

Untuk mengubah config, pilih menu **8. Settings**.

## Tidak Perlu Install Apapun

- Tidak perlu Node.js
- Tidak perlu npm / npx
- Tidak perlu Vercel CLI
- Tidak perlu Supabase key di laptop
- Cukup Windows + PowerShell (sudah ada di semua Windows 10/11)

## Cara Kerja

Runner ini memanggil API Vercel yang sudah jalan (endpoint yang sama dengan Streamlit runner).
Hasilnya langsung tersimpan di Supabase, sehingga website otomatis menampilkan data terbaru.

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
| 8 | Settings | Ubah config |
| 9 | Exit | Keluar |

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
- Config tersimpan di `%USERPROFILE%\.auto-cuan-scan.env` (luar repo).
- Jangan share config file ke siapapun.
- File `.bat` hanya memanggil PowerShell runner, tidak mengandung secret.


## Day Trade Auto Loop

Menu `4` dan `5` sekarang menjalankan Day Trade otomatis berulang:

- `4. Start Day Trade Fast AUTO LOOP`
- `5. Start Day Trade Full AUTO LOOP`

Default:
- Mulai: `09:10` WIB
- Stop: `15:40` WIB
- Interval: `30` menit

Cara stop manual: tekan `Ctrl+C` atau tutup jendela CMD.

Opsional override sebelum membuka menu dari CMD:

```cmd
set AUTO_RUN_START=09:10
set AUTO_RUN_END=15:40
set AUTO_RUN_INTERVAL_MINUTES=30
tools\AUTO_CUAN_SCAN_MENU.bat
```

Tidak perlu Node.js, npm, npx, atau Vercel CLI.


## Jam Istirahat Otomatis

Day Trade auto loop tidak akan memulai scan baru pada jam istirahat:

- Senin-Kamis: 12:00-13:30 WIB
- Jumat: 11:30-14:00 WIB

Kalau jadwal next run jatuh di jam istirahat, runner otomatis menunggu sampai jam istirahat selesai, lalu lanjut lagi.
