# PROMPT: Merge `feat/broksum-all-foreign` ke `feat/daytrade-screener-v1`, lalu VPS kembali mengikuti branch utama (Roo Code)

> Mode **Code**. Tempel seluruh isi di bawah garis. Boleh dijalankan **malam ini**.
> **Pemilik menyetujui:** PR dan merge `feat/broksum-all-foreign` → `feat/daytrade-screener-v1`, push branch itu, dan VPS pindah ke `feat/daytrade-screener-v1`.
> **Jangan merge ke `main`. Jangan hapus `feat/broksum-all-foreign`.**

## Kenapa

`feat/daytrade-screener-v1` adalah branch utama pemilik, yang biasa dipakai untuk deploy. Sekarang VPS menjalankan `feat/broksum-all-foreign`. Kalau suatu saat ada deploy atau pull dari branch utama, semua perbaikan data (broksum, IHSG, Yahoo, validator) bisa hilang.

## Batas keras

1. Jangan cetak `.env`, kunci, IP VPS, atau lokasi kunci SSH. Jangan pakai `StrictHostKeyChecking=no`.
2. **Jangan ganggu worker backfill**, dan jangan pindah branch di VPS saat worker sedang jalan. Cek lock file dulu.
3. **Jangan ubah crontab,** kecuali ada baris yang menyebut nama branch secara langsung (langkah 5).
4. `pm2 restart autocuan-web` **hanya kalau isi kode berubah**, paling banyak satu kali, lalu cek health check 200.

## Langkah

1. **Cek posisi kedua branch:**
   - `git fetch --all`;
   - catat hash HEAD keduanya dan hash yang sedang jalan di VPS;
   - jalankan `git log --oneline feat/broksum-all-foreign..feat/daytrade-screener-v1`, yang menampilkan commit di branch utama yang belum ada di branch broksum.
2. **Siapkan cadangan:**
   - buat tag `pre-merge-broksum-20261018` di HEAD `feat/daytrade-screener-v1` dan push tag-nya;
   - salin `crontab -l` ke `~/crontab.backup-20261018c.txt`.
3. **Kalau branch utama tidak punya commit tambahan** (bisa fast-forward):
   - buat PR `feat/broksum-all-foreign` → `feat/daytrade-screener-v1`;
   - ringkasan PR: broksum all + asing, backfill, IHSG, candle Yahoo + cek silang, validator, dan pengaman Domestik. Sebutkan laporan di `backtest/arjum-audit/`;
   - jalankan semua test;
   - merge (fast-forward) dan push.

   **Kalau branch utama punya commit tambahan:** merge `feat/daytrade-screener-v1` ke `feat/broksum-all-foreign` dulu di lokal, selesaikan konflik (logika data dari broksum dipertahankan), jalankan semua test, baru lanjut PR dan merge seperti di atas. **Kalau ada konflik di logika bisnis** (screener, Top 5, scoring), berhenti dan laporkan.
4. **Pindahkan VPS:**
   - pastikan worker backfill tidak sedang jalan;
   - `git fetch`, `git checkout feat/daytrade-screener-v1`, `git pull --ff-only`;
   - bandingkan isi kode dengan commit yang tadi jalan (`git diff --stat <hash lama> HEAD`):
     - **sama persis** (fast-forward): tidak perlu restart;
     - **berbeda**: jalankan semua test, restart sekali, lalu cek health check 200.
5. **Cari skrip yang menyebut nama branch:** `deploy/vps/*.sh`, crontab, dokumentasi deploy, `CEK_SENIN.md`. Ganti `feat/broksum-all-foreign` menjadi `feat/daytrade-screener-v1`. Tulis diff-nya di laporan.
6. **Aturan kerja ke depan.** Tulis di `backtest/arjum-audit/ATURAN_BRANCH.md`:
   - VPS **selalu** menjalankan `feat/daytrade-screener-v1`;
   - pekerjaan baru dikerjakan di branch fitur, lalu test → PR → merge ke `feat/daytrade-screener-v1` → VPS `git pull --ff-only` → restart kalau perlu;
   - tidak ada merge ke `main` tanpa perintah pemilik.
7. **Jalur kembali** (tulis di laporan, siap tempel):
   - `git checkout feat/broksum-all-foreign` di VPS;
   - `git reset` branch utama ke tag `pre-merge-broksum-20261018`, hanya dengan izin pemilik;
   - restart kalau perlu.

## Laporan

Tulis `backtest/arjum-audit/REPORT_MERGE_DAYTRADE.md`. Tampilkan juga di chat:
1. Fast-forward atau merge commit, plus link PR dan hash akhir.
2. Branch yang sekarang jalan di VPS, dan apakah web direstart.
3. Skrip atau crontab yang diubah, kalau ada.
