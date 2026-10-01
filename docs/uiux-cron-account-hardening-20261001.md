# UI, akun, dan EOD — 1 Oktober 2026

## Temuan yang diverifikasi

- Branch perbaikan tertinggal dari default `feat/daytrade-screener-v1`. Default terbaru digabungkan, dengan perubahan terbaru pada login, UI, dan collector dipertahankan.
- Log VPS 30 September menunjukkan collector berjalan, tetapi mengirim **0 permintaan**: pemakaian harian 7862 dibandingkan dengan `--limit 5000`. Limit ticker keliru menjadi batas kuota harian.
- Crontab aktif memiliki blok managed lama dan tambahan di luar blok: broker retry/final serta candle retry saling drift.
- Financial/Struktur Pasar ada di partial, tetapi template tertanam di shell belum memiliki panelnya. Template dan partial sekarang disinkronkan, termasuk perbaikan input IME dan ikon dari shell terbaru.

## Perubahan

- Panel riset terhubung pada shell dan halaman standalone; respons ticker lama tidak boleh menimpa ticker baru. Nilai null ditampilkan sebagai belum tersedia, sedangkan nol tetap valid.
- Transisi panel singkat menghormati reduced motion. Kontrol Profil, Subscription, dan Logout terlihat; launcher navigasi lama tidak lagi menutupi tombol akun. Landing dan motion yang sudah ada pada default dipertahankan dan diuji.
- Empat dependensi worksheet dimuat berurutan hanya saat Kelola Keuangan dibuka. Load yang bersamaan memakai satu promise; kegagalan dapat dicoba ulang.
- Session status menandai akun legacy tanpa email. Dialog Gmail wajib dapat ditinggalkan melalui Logout; gagal memeriksa status tidak menutup dialog yang sudah diketahui wajib. Penyimpanan memakai identitas dari cookie bertanda tangan, validasi Gmail, dan compare-and-set agar email perangkat lain tidak tertimpa. Akun sistem budi/review tetap mengikuti pengecualian yang ada.
- Coordinator EOD membuka pekerjaan baru pukul **18:00 WIB pada hari bursa Senin–Jumat**. Cron memanggilnya setiap 30 menit sepanjang waktu untuk melanjutkan tanggal yang belum lengkap, termasuk setelah tengah malam dan akhir pekan. Hari libur ditangani oleh calendar guard.
- Broker summary, accumulation, insiders, dan candle/volume harus lengkap sebelum tanggal selesai. Cache sukses dipakai ulang; upstream error, kuota habis, empty broker result, atau gagal menyimpan tetap pending. Tidak ada `--final` pada cron. Dated marker lama diperiksa ulang; tanggal bursa yang terlewat sejak state terakhir ditemukan kembali.
- Satu lock melindungi coordinator dari firing yang bertumpuk. Installer menyelaraskan blok canonical dan menghapus job lama milik aplikasi di luar blok sambil menjaga job lain.

## Rollout setelah PR digabung

Audit VPS bersifat baca saja. Perubahan branch ini belum dipasang ke produksi dan crontab aktif belum diubah.

1. Deploy commit hasil merge dengan proses deployment repository yang berlaku; verifikasi SHA checkout VPS sebelum mengganti release. Pastikan environment runner dan kuota API aktual tersedia.
2. Periksa `timedatectl show -p Timezone --value`. Harus `Asia/Jakarta`; Debian/Ubuntu cron dapat mengabaikan `CRON_TZ`. Installer menolak pemasangan bila timezone sistem tidak cocok.
3. Jalankan `bash deploy/vps/install-cron-entries.sh --dry-run` dari checkout release. Tinjau diff: satu `run-daily-market-update.sh`, tanpa job broker/candle lama terpisah, dan job lain tetap ada.
4. Jalankan `bash deploy/vps/install-cron-entries.sh`, lalu periksa `crontab -l`. Backup otomatis tersimpan pada direktori runner `backup/`. Menjalankan installer lagi tidak menambah duplikat.
5. Periksa `daily-market-update.log`, dated broker marker, dan `_daily-market-update/<tanggal>.json` di direktori data runner. State pending harus tetap bertanggal sama saat retry. Data yang belum dipublikasikan tetap pending; pemasangan tidak menjamin upstream menyediakan seluruh data.

Rollback jadwal: pulihkan backup crontab yang dibuat installer. Rollback aplikasi: gunakan release sebelumnya melalui proses deployment yang berlaku. Tidak ada migrasi schema atau penghapusan data akun/cache pada perubahan ini.

## Validasi

- `npm test`: 592 file test; satu subtest file symlink dilewati bila Windows menolak izin, tetap berjalan pada Linux.
- `npm run build`: 75 file smoke test.
- Syntax JavaScript dan Bash, diff whitespace, audit kredensial repository.
- Chrome dengan API fixture lokal: Gmail wajib/ESC/save, panel Financial/Struktur Pasar, null versus nol, lazy worksheet, reduced motion, menu landing, kontrol akun, dan ukuran 390/768/1440 px. Tidak menggunakan akun produksi atau mengirim collector ke upstream dalam pengujian.

Acceptance setelah deploy: cek log retry tanggal 30 September dan EOD hari berikutnya serta pastikan semua empat sumber selesai atau memiliki status pending yang jujur. Pengujian lokal tidak menggantikan pemeriksaan ini.
