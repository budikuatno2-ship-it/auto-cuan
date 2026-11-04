# Aturan proyek Auto-Cuan (redesign UI) — dibaca otomatis setiap sesi

Kamu bekerja di `D:\auto-cuan-redesign`, branch `redesign/v2`, meneruskan redesign UI Auto-Cuan (riset saham IDX). Pemilik menulis bahasa Indonesia informal; balas dalam bahasa Indonesia, singkat, langkah demi langkah.

## Sumber kebenaran (urut)
1. `docs/redesign-handoff/HANDOFF_ANTIGRAVITY_REDESIGN_UIUX.md`, `LAMPIRAN_WEB_ANTIGRAVITY.md`, dan `LAMPIRAN_PERFORMA_MULTIUSER.md` (status, tugas, aturan, performa).
2. `handoff-redesign/HANDOFF_REDESIGN_V2.md` (spesifikasi) + `handoff-redesign/design/project/*.dc.html`, `ac.css`, `motion.js` (visual dan perilaku) + `handoff-redesign/screenshots/`.
3. `DESIGN.md`, `docs/DESIGN-SYSTEM.md`, `public/ui-theme.css` di repo. Petakan ke sini; jangan buat sistem token kedua.
Kalau ragu atau dokumen bertentangan: **tanya pemilik**, jangan menebak. Tulis asumsi di laporan.

## Git (keras)
- Kerja hanya di `redesign/v2`. Satu halaman/fondasi = satu commit `redesign(<halaman>): …`; perbaikan bug = commit `fix(...)` terpisah dengan test.
- DILARANG: merge ke `main`; merge PR #910; menandai PR #910 siap ("Ready for review"); push ke `feat/daytrade-screener-v1`; `git push --force`; rebase branch yang sudah di-push; deploy; `pm2 restart`; ubah crontab atau `.env`.
- Boleh: push `redesign/v2` (cadangan) dan memperbarui deskripsi PR draft.
- Jangan pernah `git add -A` / `git add .`. Tambahkan file satu per satu. Jangan commit file **untracked** hasil installer/konfigurasi lokal: skill baru di `.agents/skills/`, folder `.agent/`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` di akar; juga `handoff-redesign/`, karantina, log, file data. (Folder `.agents/` sudah berisi file milik repo yang ter-track; jangan diubah atau dihapus tanpa izin.)
- Awal sesi: `git status`, `git fetch origin`, merge lokal `origin/feat/daytrade-screener-v1` ke `redesign/v2` (merge, bukan rebase). Konflik: logika data dari Roo menang, dari redesign hanya tampilan.
- Sebelum push: periksa diff tidak memuat kunci, token, alamat VPS, lokasi kunci, `.env`.

## Wilayah terlarang (milik Roo Code)
`tools/backfill-*`, `tools/run-daily-*`, `tools/fetch-daily-candles.js`, `tools/simulate-*`, `tools/catchup-*`, `lib/arjum-*`, `lib/broksum-*`, `lib/broker-accumulation-local.js`, `lib/trusted-proxy.js`, kode keamanan server (login throttle, header keamanan/CSP, allowlist `/data/*`), crontab, `.env`. Bug di sana: tulis di laporan, jangan perbaiki.
Logika bisnis tidak boleh berubah: skor dan gate screener, Top 5 engine, scoring bandarmologi, Track Record, broadcast Telegram, FastWatcher.
Perubahan di `api/` atau server yang memang dibutuhkan UI: boleh dibuat dalam commit terpisah, **wajib** didaftar di laporan "Perubahan server untuk ditinjau Roo". Tidak dideploy.

## VPS, rahasia, kuota
- Kamu tidak punya akses VPS dan tidak boleh memintanya. Kebutuhan data produksi ditulis sebagai perintah baca-saja di `handoff-redesign/CEK_VPS_UNTUK_ROO.md`.
- Jangan pernah mencetak, menyalin, atau menulis `.env`, `ARJUM_API_KEY`, kunci SSH, token, alamat VPS, lokasi kunci, password. Jangan minta password admin. Akun uji hanya dari variabel `AC_TEST_USER`/`AC_TEST_PASS`.
- Log test lama bisa memuat alamat/kunci VPS: jangan menempelnya ke chat, laporan, atau commit.
- Pekerjaan UI tidak boleh memicu request ke penyedia data (kuota kritis). Pakai data di disk dan fixture lokal.

## Data jujur
- Tidak ada angka karangan. Kosong = "—" (`<span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">—</span>`), tidak pernah 0.
- Angka, tanggal, nama di kanvas (BRPT 1.045/1.210, 13/16 Okt, "budi") adalah contoh; tidak boleh masuk produk.
- Setiap angka punya sumber + cap waktu. Kesegaran dari waktu data, bukan jam dinding. Data cadangan: "data terakhir tersimpan · <tanggal>". Bar `provisional`: "sementara · diperbarui hh:mm". Asing belum rilis: "data asing belum dirilis". Gagal: tampilkan data terakhir + cap waktu, jangan menebak.
- Jangan hapus file apa pun; pindahkan ke `handoff-redesign/karantina/<tanggal>/`.
- Jangan pernah membaca nama field dari mock; cek nama field dari kode endpoint.

## Aturan UI
- Nama penyedia data (Arjum) dan nama internal (VPS, tabel, cron, pm2) tidak tampil di UI.
- Bahasa Indonesia, kalimat biasa, tanpa em dash di kalimat UI, tanpa label KAPITAL bertracking lebar. Tanpa janji untung, tanpa saran beli/jual, tanpa testimoni/klaim tanpa bukti.
- Token dari `ac.css`; jangan tulis hex untuk teks/latar/garis netral. Merah/hijau hanya untuk arah harga/nilai. Bayangan hanya lapisan melayang.
- Font self-host (Plus Jakarta Sans, Geist Mono). Jangan menyalin `<link>` Google Fonts dari file kanvas. Ikon dari `public/ac-icons.js`; jangan `npm install` library ikon atau paket apa pun tanpa izin pemilik.
- Tidak ada skrip/gaya dari CDN luar (unpkg, jsdelivr, Google Fonts). Hindari skrip inline dan handler `onclick=` inline baru (CSP akan ditegakkan).
- Semua tabel dalam wadah `overflow-x:auto`; tanpa overflow horizontal di 390, 820, 1000, 1440 px.
- Animasi hanya `transform`/`opacity`, satu listener pointer, satu rAF, maksimal satu animasi tanpa henti per layar, mati saat `prefers-reduced-motion`. Dilarang: efek kursor yang menulis variabel CSS/background wadah besar, baca posisi setelah tulis gaya di frame sama, `void el.offsetWidth`, blur di banyak elemen, selector `body:has(...)` tanpa kombinator anak.
- Pada elemen SVG, sembunyikan/tampilkan dengan `setAttribute/removeAttribute('hidden')`, bukan `el.hidden =`.
- Fitur admin ditegakkan di server/route (403), bukan hanya CSS.
- Fitur lama yang tidak ada di kanvas: jangan dihapus; pindahkan ke bagian lipat "Alat lanjutan" bila mendorong tata letak.
- Keputusan pemilik: Login Google DIBATALKAN (jangan bangun tombol/tautan Google, walau ada di `AuthLogin.dc.html`); Kelola Keuangan aktif; tab bawaan Analisis = Analisis AI.

## Performa (web dipakai banyak orang sekaligus; fitur tidak boleh dipangkas)
- Cepat lewat cache, hitung sekali untuk banyak pengguna, pindah kerja berat, muat saat dibutuhkan, kompresi. Bukan lewat menghapus fitur, mengurangi data, atau menyembunyikan error.
- Tidak ada kerja sinkron baru di jalur permintaan server (`fs.*Sync`, `execSync`/`execFileSync`, `crypto.*Sync`). Perubahan server dicatat untuk Roo.
- Data yang sama untuk banyak pengguna dihitung sekali (cache bersama berkunci versi data, ETag/304). Isi pribadi/premium tidak pernah di-cache publik.
- Polling: ikuti irama data, kirim ETag (If-None-Match), berhenti saat tab tersembunyi dan di luar jam bursa, backoff saat 429/5xx (`Retry-After`), cukup satu tab yang polling. Jangan menambah parameter acak anti-cache.
- JS/CSS awal: jangan menambah tanpa alasan tertulis (KB). Kode halaman baru dimuat saat halaman dibuka (dengan prefetch hover yang sudah ada). Skrip baru `defer`, tanpa skrip inline baru, tanpa CDN luar.
- DOM: halaman tersembunyi jangan dirender penuh sekaligus; tabel besar dipaginasi atau virtual; hindari selector mahal (`:has()` luas, `*` bertingkat).
- Ukur sebelum/sesudah: metrik frontend (LCP, INP, TBT, KB diurai, jumlah DOM) di 390 dan 1440 dengan CPU 4×, dan `tools/perf/uji-beban.mjs` ke server lokal. Lampirkan angka di laporan.
- Jangan pernah uji beban ke produksi atau VPS. Alat menolak; jangan diakali.

## Alat
- antislop: isi dial (Aplikasi ENERGY 1 · RHYTHM 2 · MOTION 2; Landing ENERGY 2 · RHYTHM 3 · MOTION 3), tutup tiap halaman dengan Delivery Gate PASS/FAIL. Empat override final: "—" untuk kosong, ikon sendiri, Plus Jakarta Sans + Geist Mono, Si Mata tetap berkedip.
- Uji: `npm run test:full` (kegagalan lama yang diketahui: `daily-market-context-collector-runtime-bugfix`, `telegram-member-lifecycle`; `bandarmologi-intel-price-fix` bila ada artefak data, pindahkan artefak ke karantina). Playwright 1440/1024/390, terang+gelap.

## Cara kerja
- Rencanakan dulu, ubah sesedikit mungkin (diff kecil, jangan menulis ulang file besar), jalankan test, commit, laporkan dengan bukti (perintah, hasil, angka sebelum/sesudah).
- Berhenti di titik yang diminta pemilik. Setiap kelompok halaman: berhenti → tabel deviasi → angka piksel → daftar perubahan server untuk Roo.
- Akhir sesi atau sebelum batas pemakaian: commit, push `redesign/v2`, tambahkan catatan ke `docs/redesign-handoff/LOG_SESI.md` (tanggal, selesai, belum, angka, langkah berikutnya).
