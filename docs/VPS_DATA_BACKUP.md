# Auto-Cuan VPS Data Backup

## Tujuan

Data market berat menjadi milik VPS/offline backup, sedangkan GitHub tetap menyimpan source code dan Supabase tetap control-plane kecil.

### Data asli

`/home/ubuntu/auto-cuan/data/` tidak memiliki retensi 14 hari. Candle 2020-sekarang, broker summary historis, HSC, Free Float, ownership, volume/OHLCV, reports, dan snapshot lain tetap disimpan selama masih ada di source data.

`/home/ubuntu/auto-cuan-data/` adalah root untuk market-data VPS-only baru. Semua data-plane yang dipindahkan dari Supabase harus diarahkan ke sini sehingga otomatis ikut backup.

## Backup VPS

- Lokasi: `/home/ubuntu/auto-cuan-backups/daily/`
- Jadwal: 01:30 WIB setiap malam
- Retensi: 14 snapshot lengkap terbaru secara default
- Snapshot memakai hard-link deduplication (`rsync --link-dest`), jadi file yang tidak berubah tidak digandakan secara fisik setiap malam.
- Retensi hanya menghapus snapshot backup lama, tidak pernah menghapus data asli.
- `.env`/API key plaintext tidak dimasukkan ke backup data.

### Install

```bash
cd /home/ubuntu/auto-cuan
chmod +x deploy/vps/backup-auto-cuan-data.sh deploy/vps/install-data-backup-cron.sh
./deploy/vps/install-data-backup-cron.sh
./deploy/vps/backup-auto-cuan-data.sh
ls -lah /home/ubuntu/auto-cuan-backups/daily/
readlink -f /home/ubuntu/auto-cuan-backups/latest
crontab -l
```

## Backup offline Windows D:

Script PowerShell sengaja menolak fallback ke C:.

Default:

`D:\AutoCuan-Backup\weekly\<snapshot>`

dan menyimpan 26 backup mingguan terbaru secara default.

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\windows\pull-vps-backup-to-d.ps1 -VpsHost '<IP-ATAU-HOST-VPS>'
```

Jalankan satu kali per minggu. Setelah selesai, copy folder snapshot yang sama ke flash disk eksternal. Idealnya gunakan dua flash disk bergantian.

## Data penting yang otomatis ikut

- `data/daily-candles/` — candle/OHLCV/volume historis
- `data/arjum-data/broker-summary/` — broker summary historis
- `data/market-structure/` — HSC / Free Float / ownership
- `data/insider-network/`
- `data/reports/`
- screener/cache/snapshot lain di bawah `data/`
- seluruh `/home/ubuntu/auto-cuan-data/` untuk data-plane VPS-only baru

Source code tidak perlu diduplikasi di backup data karena tersedia di GitHub. Restore VPS baru dilakukan dengan clone repo + restore kedua root data di atas.

## Restore target

Jika Oracle VPS hilang total:

1. Provision VPS pengganti.
2. Clone repo GitHub.
3. Copy snapshot offline terbaru dari D:/flash disk.
4. Restore `repo-data/` ke `/home/ubuntu/auto-cuan/data/`.
5. Restore `vps-data/` ke `/home/ubuntu/auto-cuan-data/`.
6. Provision `.env`/secret secara terpisah.
7. Install dependencies dan start PM2.

Dengan pola ini kehilangan maksimum market-data ditentukan oleh umur backup offline terakhir; backup VPS malam sebelumnya tetap membantu selama disk Oracle masih dapat diakses.
