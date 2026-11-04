# LAMPIRAN WEB UNTUK ANTIGRAVITY (Gemini): setup, kartu per halaman, standar web, uji, jebakan

> Pelengkap `HANDOFF_ANTIGRAVITY_REDESIGN_UIUX.md`. Dibuat **Jumat 23 Okt 2026, ±23:50 WIB**.
> File utama menjelaskan **status dan aturan**; lampiran ini menjelaskan **cara mengerjakan setiap halaman web sampai benar-benar selesai**.
> Tanpa kunci, token, alamat VPS, atau lokasi kunci.

Isi:
1. Memasang paket Antigravity (aturan otomatis + workflow)
2. Ritme kerja per sesi
3. Definisi "selesai" untuk setiap halaman (standar web)
4. Kartu per halaman (apa yang harus ada, data, jebakan, kriteria terima)
5. Kesiapan produksi web (CSP, cache Cloudflare, tautan langsung, meta, browser)
6. Cara menguji (Playwright, keadaan, CPU 4×, INP, selisih piksel)
7. Jebakan khas agen AI (termasuk Gemini)
8. Pertanyaan terbuka untuk pemilik (tanya, jangan menebak)
9. Koordinasi dengan Roo

---

## 1. Memasang paket Antigravity

Isi paket (`paket-antigravity.zip`):

| File | Taruh di | Fungsi |
|---|---|---|
| `GEMINI.md` | `D:\auto-cuan-redesign\GEMINI.md` (akar repo) | **Aturan proyek yang dibaca otomatis** setiap sesi oleh Antigravity (di bawah 12.000 karakter) |
| `.agent/workflows/mulai-sesi.md` | `D:\auto-cuan-redesign\.agent\workflows\` | Workflow awal sesi |
| `.agent/workflows/kerjakan-halaman.md` | sama | Workflow satu halaman (siklus Fase 3) |
| `.agent/workflows/akhiri-sesi.md` | sama | Workflow tutup sesi |
| `HANDOFF_ANTIGRAVITY_REDESIGN_UIUX.md` + `LAMPIRAN_WEB_ANTIGRAVITY.md` + `LAMPIRAN_PERFORMA_MULTIUSER.md` | `D:\auto-cuan-redesign\docs\redesign-handoff\` | Dokumen utama + lampiran (boleh di-commit) |
| `.agent/workflows/uji-performa.md` | `D:\auto-cuan-redesign\.agent\workflows\` | Workflow ukur performa sebelum/sesudah |
| `alat-performa/uji-beban.mjs` | `D:\auto-cuan-redesign\tools\perf\uji-beban.mjs` | Alat uji beban (boleh di-commit sebagai alat dev) |
| `alat-performa/perf-metrics.js`, `shared-cache.js`, `test/` | **untuk Roo** (jangan dipasang Antigravity ke server) | Pengukur server dan cache bersama, sudah diuji |

Langkah:
1. Salin file sesuai tabel.
2. Supaya file aturan tidak ikut ter-commit, jalankan sekali di terminal folder itu:
   ```
   echo GEMINI.md>> .git\info\exclude
   echo .agent/>> .git\info\exclude
   ```
   (`AGENTS.md` dan `CLAUDE.md` di akar, serta skill baru hasil installer antislop di `.agents/skills/`, juga jangan di-commit; tambahkan ke exclude dengan cara yang sama bila `git status` masih menampilkannya. Folder `.agents/` sendiri sudah berisi file milik repo yang ter-track, misalnya skill `frontend-design`, `code-review`, `systematic-debugging`, `verification-before-completion`; jangan dihapus. Antigravity akan membaca skill di `.agents/skills/` dan aturan antislop di `AGENTS.md`, jadi keduanya ikut membantu.)
3. Buka folder `D:\auto-cuan-redesign` di Antigravity. Di panel pengaturan/kustomisasi Antigravity, **pastikan aturan `GEMINI.md` dan ketiga workflow terlihat**. Catatan: dokumentasi pihak ketiga menyebut dua lokasi workspace: `.agent/` (lama) dan `.agents/` (baru). Kalau workflow tidak muncul, pindahkan folder `workflows` ke `.agents\workflows\`. Antigravity juga membaca `AGENTS.md` (sudah ada, berisi aturan antislop) dan skill di `.agents/skills/` (skill antislop dari installer).
4. Atur agar **perintah terminal meminta persetujuan** (bukan dijalankan otomatis), terutama `git push`, `git merge`, `npm install`, dan apa pun yang menghapus file.
5. Pesan pertama ke agen: jalankan workflow **mulai-sesi** (atau tempel Contoh A di dokumen utama Bagian 14).

---

## 2. Ritme kerja per sesi

1. **mulai-sesi:** baca log sesi terakhir, sinkron dengan `origin/feat/daytrade-screener-v1` (merge lokal), `npm run test:full`, ringkasan 10 baris, tunggu perintah.
2. **Satu tugas per perintah** (mis. "T1 Screener" atau "kerjakan-halaman Watchlist"). Agen membuat rencana singkat, lalu mengerjakan.
3. **Bukti dulu, klaim belakangan:** setiap laporan memuat perintah yang dijalankan, hasil test, angka piksel sebelum/sesudah, hash commit.
4. **Berhenti** di akhir tugas. Pemilik membaca laporan, lalu memberi tugas berikutnya.
5. **akhiri-sesi:** commit, push `redesign/v2`, catat di `docs/redesign-handoff/LOG_SESI.md`, perbarui deskripsi PR draft.
6. Kalau pemakaian mendekati batas: langsung akhiri-sesi. Jangan memulai halaman baru.

---

## 3. Definisi "selesai" untuk setiap halaman (standar web)

Satu halaman dianggap selesai **hanya bila semua butir ini lolos** dan dibuktikan di laporan.

**Visual**
- [ ] Tata letak awal sama dengan kanvas di 1440 dan 390 (posisi blok utama selisih ≤ 8 px); selisih piksel dengan data contoh yang sama: target **< 3%** di 1440, **< 6%** di 390 (kalau tidak tercapai, jelaskan per area).
- [ ] Mode terang **dan** gelap; tombol tema bekerja; tidak ada kedip terang saat muat di mode gelap.
- [ ] Breakpoint shell: ≤760 (bilah atas + Menu + tab bawah), 761–1099 (rel ikon 68 px), ≥1100 (sidebar 240 px). Breakpoint isi yang dipakai kanvas: 980, 900, 700, 560 px.
- [ ] Tidak ada overflow horizontal di 390, 820, 1000, 1440 px; setiap tabel dalam wadah `overflow-x:auto` (termasuk tabel di tab yang tersembunyi).
- [ ] Teks tidak terpotong; angka memakai Geist Mono dengan angka tabular.

**Data**
- [ ] Tersambung ke data **asli** (nama field dibaca dari kode endpoint).
- [ ] Tidak ada angka/tanggal/nama dari kanvas.
- [ ] Kosong = "—"; setiap kartu punya baris sumber + cap waktu; kesegaran dari waktu data.
- [ ] Keadaan **kosong, memuat, gagal** asli (teks dari objek `ST` di `motion.js`), dipicu sungguhan di test. Gagal menampilkan data terakhir + cap waktu, bukan tebakan.
- [ ] Skeleton setinggi konten (tidak ada layout shift saat data masuk).
- [ ] Format Indonesia: `Intl.NumberFormat('id-ID')`, tanggal dan jam **WIB** (`timeZone: 'Asia/Jakarta'`), lot = 100 lembar, harga mengikuti fraksi (tick) BEI, harga tanpa "Rp" di chart, "Rp" di nilai uang (mis. kolom Nominal Kelola).

**Aksesibilitas**
- [ ] Semua kontrol bisa dicapai dengan Tab, urutan logis, fokus terlihat; Escape menutup dialog/drawer/menu; fokus kembali ke pemicu setelah dialog ditutup.
- [ ] `aria-label` sesuai kanvas (kanvas sudah menuliskannya, misalnya "Jenis aliran", "Urutkan …", "Hapus … dari watchlist").
- [ ] Kontras AA di kedua mode; warna bukan satu-satunya pembeda (naik/turun juga punya tanda ▲/▼ atau +/−).
- [ ] Target sentuh di HP nyaman (± 40–44 px); tabel bisa digeser.
- [ ] `prefers-reduced-motion`: animasi mati, strip harga diam (bisa digeser manual).

**Kinerja**
- [ ] 0 error konsol.
- [ ] INP < 200 ms (CPU 4×) untuk klik/ganti tab; tidak ada task panjang berulang saat diam.
- [ ] p95 endpoint halaman < 500 ms (catat sebelum/sesudah); tidak ada request berulang tanpa perlu; tidak ada request ke penyedia data dari UI.
- [ ] Tidak ada pola terlarang (lihat `GEMINI.md` bagian Aturan UI).

**Isi**
- [ ] Bahasa Indonesia; tanpa em dash di kalimat; tanpa nama "Arjum"/internal; tanpa janji untung/saran beli-jual; disclaimer di tempat yang diwajibkan.

**Penutup**
- [ ] `npm run test:full` (hanya kegagalan lama yang diketahui).
- [ ] Delivery Gate antislop PASS (FAIL harus dijelaskan).
- [ ] Commit `redesign(<halaman>): …`; perubahan server dicatat untuk Roo.
- [ ] Tabel deviasi (elemen | desain | implementasi | alasan) diperbarui.

---

## 4. Kartu per halaman

Format: **Kanvas · Isi wajib · Data · Jebakan · Kriteria tambahan.** Isi wajib di bawah diambil langsung dari elemen file kanvas (judul, tab, tombol, kolom tabel, label). Perilaku rinci ada di `HANDOFF_REDESIGN_V2.md` §5. Elemen berpola `{{…}}` di kanvas adalah template; terjemahkan ke pola repo. Elemen "Pratinjau status", "Pratinjau sebagai Pengunjung/Admin", "Ulangi demo", "← Kembali ke formulir (demo)", dan tombol pratinjau suasana Si Mata **tidak dibangun**.

Semua halaman aplikasi berbagi: bilah atas (pencarian "Cari ticker, halaman, atau aksi… ⌘K", tombol tema "Ganti mode terang atau gelap", status kesegaran), strip harga ("Harga saham likuid hari ini"), sidebar/tab bawah, Si Mata (kecuali Auth dan mode fokus chart).

### 4.0 Kelompok 1 (sudah dikerjakan, tinggal ditutup)
- **Dashboard (`Main.dc.html`):** sapaan "Halo, <nama>"; tautan "Kredensial AI" (tanpa status tebakan); Kondisi pasar (breadth naik/flat/turun dengan aria-label jumlah); **Catatan Admin** (maks 3, tombol "Chart"; sembunyi bila kosong); **Top 5 Radar Hari Ini** (tautan "Riset", "Detail di Screener"; baris membuka rencana); ringkasan karantina ("N kandidat dikarantina: status Hindari, Potensi TP rendah, atau Risiko sangat tinggi"); **Riwayat Top 5** (tab "Aktif dipantau" / "Riwayat TP"). Si Mata membaca `data-ihsg-chg` untuk suasana.
- **Screener (`Screener.dc.html`):** mode Konglo/Non-Konglo/Day Trade; cari ticker; Status (Semua/Di area entry/Tunggu pullback); "R/R minimal 1 : 1,5"; Urutkan; Kolom; "Cetak / PDF" (butuh stylesheet cetak); kolom Ticker, (B), Tier, Exec, Skor, Harga, Chg, (H), Vol/Avg20, R/R, (K); "Hapus filter"; panel "Detail terpilih" (bintang watchlist, "Buka Chart & Analisis"). **T1: pindahkan preset/filter lama ke "Alat lanjutan".** Di layar < 1600 px dengan panel terbuka, kolom Setup disembunyikan.
- **Analisis (`Analisis.dc.html`):** konteks ticker (chip, bintang watchlist), tab Chart Workstation / **Analisis AI (bawaan)**, tautan header (Struktur Pasar, Sektor Hot), horizon, banner Catatan Admin, mode/layer (Matikan semua, Reset ke preset, Selesai), skala harga (−, +, Auto), Satu layar; Analisis AI: "Interpretasi model · <ticker>" dengan Rangkuman, Bukti dari data, Risiko & ketidakpastian, Konteks yang dipakai, pertanyaan cepat ("Apa arti LPM sekarang?", "Konfirmasi volume?"), input tanya lanjutan + Kirim; "Fakta ticker".
- **Kelola Keuangan (`KelolaKeuangan.dc.html`):** pilihan Bulan; ringkasan anggaran; bar komposisi (pengeluaran, tabungan, sisa); kartu Portofolio terhubung ("Buka Portofolio"); lembar "Anggaran bulanan" (+ Tambah baris, Hapus baris, cari pos, Urutkan baris: Nominal terbesar/Nama pos A–Z/Kelompok jenis, CSV, Simpan); kolom #, A · Jenis, B · Kategori, C · Nama pos, D · Nominal (Rp), E · Catatan; "Salin pos dari <bulan>"; Catatan bulan ini; Urungkan.

### 4.1 Bandarmologi (`Bandarmologi.dc.html`) — kelompok 2
- **Isi wajib:** tab **Broker Summary** / **Akumulasi Broker**; input **Tanggal** (akhir pekan dan libur ditolak dengan pesan jelas); tombol hitung ulang; segmen **Jenis aliran: Semua · Asing · Domestik**; ringkasan "verdict" 4 kolom (jadi 2 kolom ≤980 px, 1 kolom ≤560 px); tabel **Pembeli terbesar** dan **Penjual terbesar** (Broker, Sekuritas, Volume, Nilai, Rerata), label jenis aliran di judul; **Akumulasi bersih per broker** dengan pilihan periode dan kolom 1/3/5/20 hari + Arah; bar nilai (`.vbar`) dan bar divergen (`.div`).
- **Data:** broker summary semua (`all_data`), asing (`broker-summary-F/`), **Domestik = semua − asing per broker** (dihitung, tanpa request); tampilkan "belum lengkap" bila data semua terpotong (`incomplete`), "data asing belum dirilis" bila F belum ada; akumulasi lokal. **Pengunjung tanpa sesi hanya membaca disk dan dibatasi 30 request/menit/IP**; bila server menjawab 429, tampilkan pesan ramah, jangan mengulang otomatis.
- **Jebakan:** data produksi **19–23 Okt sedang dikejar** dan cakupan asing hanya ±14%: halaman harus jujur menulis tanggal data dan keterbatasan. Tombol hitung ulang **tidak boleh** memicu banyak request (nonaktif saat memuat, debounce). Jangan menampilkan nama penyedia data.
- **Kriteria tambahan:** ganti Semua/Asing/Domestik tanpa memuat ulang halaman; tanggal di URL (bisa dibagikan) bila pola repo mendukung.

### 4.2 Watchlist (`Watchlist.dc.html`)
- **Isi wajib:** tombol **Riwayat alert** (membuka panel dengan "Tutup"); tautan **+ Tambah dari Screener**; chip filter (dengan jumlah); tabel Ticker, Harga, Perubahan, Alert, Jarak ke alert, Catatan pantauan, Aksi; tombol per baris "Buka analisis <ticker>" dan "Hapus <ticker> dari watchlist"; **hapus dengan opsi Urungkan** (toast beberapa detik, data baru benar-benar dihapus setelah waktu habis atau dikirim dengan pembatalan yang andal).
- **Data:** watchlist pengguna (server), harga tersimpan dengan cap waktu. Bunyi alert mengikuti preferensi di Pusat Akun.
- **Jebakan:** alert di luar jam bursa; harga basi harus berlabel; jangan menyimpan watchlist hanya di localStorage.

### 4.3 Portfolio (`Portfolio.dc.html`)
- **Isi wajib:** **Perlu perhatian** (tombol "Lihat"); **Kualitas data**; **Kalkulator ukuran posisi** (Modal alokasi Rp, Toleransi risiko %, Ticker, Harga beli, Stop loss, Target 1, simpan); **Posisi aktif** (Ticker, Lot, Harga beli, Harga kini, Nilai posisi, P/L, P/L %, SL → TP1, "Ubah rencana"); **Guard average down** (Posisi, Tambah lot, Harga tambah); **Skenario posisi** (Kena SL, Capai TP1, Capai TP2); **Catatan baru** (Alasan & refleksi, Sesuai rencana, Simpan catatan); **Jurnal**; **Audit portofolio · interpretasi model**.
- **Data:** portofolio pengguna, harga tersimpan (berlabel waktu). Perhitungan ukuran posisi dan P/L harus sama dengan logika lama (jangan mengubah rumus).
- **Jebakan:** **CI job `browser` gagal sejak 19 Okt karena assertion UI Portfolio.** Saat redesign halaman ini, cari test itu, pahami assertion-nya, perbarui ke kontrak baru tanpa melonggarkan cek perilaku, dan laporkan. Ticker di kanvas (BRPT, MEDC, BBCA, ADRO) hanya contoh.

### 4.4 Sinyal Intelijen (`SinyalIntelijen.dc.html`)
- **Isi wajib:** tab **Papan bukti** / **Scanner**; ringkasan "N dari 4 bukti terkonfirmasi"; 4 pilar bukti (tombol, membuka detail "<pilar> · bukti dasar"); **Scanner konfluensi** (Ticker, Sinyal, Bukti, Asing 3H, Vol/Avg20, RSI 14, Kesegaran).
- **Data:** asing, broker, KSEI, candle. Pilar yang datanya belum tersedia ditulis "belum tersedia", **tidak dihitung sebagai terkonfirmasi**.
- **Jebakan:** kata "sinyal" tidak boleh berarti saran beli; tambahkan konteks bukti.

### 4.5 Broker Hunter (`BrokerHunter.dc.html`)
- **Isi wajib:** rentang (1 hari / 3 hari / 1 minggu / 1 bulan); "Pilih broker" dengan pencarian "Kode atau nama broker"; daftar broker (kode, nama, tipe, net); tabel **Sedang dikoleksi** (Ticker, Net, Rerata beli) dan **Sedang dilepas** (Ticker, Net, Rerata jual); tautan "Buka <ticker> di Bandarmologi →".
- **Data:** broksum agregat per broker, indeks `broker-hunter-indexes` (dibangun 22:45 hari bursa; sebelumnya sempat basi sejak 12 Sep). Tampilkan tanggal indeks.

### 4.6 Insider (`Insider.dc.html`)
- **Isi wajib:** judul "Jejaring Insider"; pencarian "Cari ticker, orang, atau entitas"; **Graf relasi** (klik simpul untuk sorotan; tombol "Reset sorotan"); panel **Detail entitas**; tabel **Pemegang saham terdaftar · <ticker>** (Nama, Hubungan, Jumlah saham, Kepemilikan).
- **Teknis:** label simpul sebagai **HTML berposisi persen di atas SVG** (ukuran huruf `cqi`), bukan `<text>` SVG; simpul berisi gelap di mode gelap; graf bisa dioperasikan keyboard (simpul fokusable) dan punya alternatif tabel.
- **Data:** KSEI, insider (jenis data harian J1 juga sedang bolong 19–23 Okt).

### 4.7 Ranking (`Ranking.dc.html`)
- **Isi wajib:** judul "Ranking Harian"; filter "Filter saham…"; preset (tombol); **CSV**; tabel dengan kolom #, dan judul kolom yang bisa diklik untuk mengurutkan (`aria-label "Urutkan <kolom>"`, panah arah, `aria-sort`); panel detail dengan "Tutup" dan "Buka Chart Workstation".
- **Data:** candle, asing. CSV memakai data yang sedang tampil, nama file bertanggal, pemisah dan desimal Indonesia jelas (atau tulis di kepala file).

### 4.8 Financial (`Financial.dc.html`)
- **Isi wajib:** cari ticker + chip ticker; "Muat ulang"; tautan "Buka Struktur Pasar"; **Laporan Keuangan** dengan Kategori (Laba Rugi / Neraca / Arus Kas / Rasio), Frekuensi (kuartalan / tahunan), "Pos kosong (N)", "Δ YoY", CSV; tabel Pos × periode; **Riwayat PBV & pita deviasi** (grafik); **Pembanding sektor** (Ticker, PBV, ROE); "Catatan metrik · Definisi dan cara hitung".
- **Teknis:** label batang sebagai HTML di atas SVG (`cqi`).
- **Data:** fundamental dan laporan keuangan emiten. **Nama tabel internal tidak boleh tampil**; tulis "Laporan keuangan emiten". Pos kosong = "—" dan bisa disembunyikan/ditampilkan.

### 4.9 Struktur Pasar (`StrukturPasar.dc.html`)
- **Isi wajib:** cari ticker; chip filter (dengan jumlah); Urutkan; tabel Ticker, Emiten, Free Float, HSC, Status struktur, Per tanggal; panel **Detail struktur** dengan "Buka analisis <ticker>".
- **Data:** KSEI dan keterbukaan informasi IDX; kolom "Per tanggal" wajib.

### 4.10 Sektor Hot (`SektorHot.dc.html`)
- **Isi wajib:** tab **Tabel klasemen** / **Heatmap**; pencarian "Cari grup atau emiten"; klasemen (#, Grup, Nama konglomerasi, Saham, Rerata %, Penggerak terkuat, Vol vs 30H, Arah aliran); heatmap ubin (tombol dengan aria-label "<grup>, rerata <x>"); drill-down: "← Semua grup", judul grup, "Saring di Screener", tabel **Konstituen** (Ticker, Nama, Harga, Chg, Vol/Avg, Bandar, Sinyal).
- **Data:** `data/sector-hot-*.json` (jangan tampilkan nama file). Warna heatmap hanya untuk arah nilai, dengan teks angka (bukan warna saja).

### 4.11 Catatan Admin (`CatatanAdmin.dc.html`) — fitur baru
- **Isi wajib:** ringkasan; tab **Aktif · N** / **Riwayat · N**; filter Semua/DayTrade/Swing; kartu catatan (status, bar posisi, log perubahan "Diedit N× · lihat perubahan", "Lihat di chart", "Edit" untuk admin); tabel **Riwayat** (Tayang, Ticker, Gaya, Hasil akhir, Perubahan, Lama, Keterangan); drawer admin (Kode saham, DayTrade/Swing, Alasan · tampil ke semua pengunjung, Area pantau dari–sampai, Target, Batas risiko, Masa berlaku, Alasan perubahan · wajib, "Tutup catatan", simpan); "+ Catatan baru" hanya admin.
- **Server:** spesifikasi lengkap di `HANDOFF_REDESIGN_V2.md` §5d (validasi tick size, hanya arah naik, kata janji ditolak, tidak bisa dihapus, status dihitung server dengan kalender bursa, 403 untuk non-admin, baca publik cache 60 dtk).
- **Jebakan:** saklar "Pratinjau desain: lihat sebagai Pengunjung/Admin" **tidak dibangun**; label "Catatan Admin" (bukan Rekomendasi) + disclaimer wajib; perubahan DB/endpoint harus ditinjau Roo sebelum deploy.

### 4.12 Track Record (`TrackRecord.dc.html`)
- **Isi wajib:** **Komposisi hasil** (bar); filter status (chip); tabel Dikunci, Ticker, Mode, Entry, SL, TP1, Keluar, Hasil %, Durasi, Status.
- **Data:** layanan track record (logika tidak boleh berubah). **Semua hasil tampil, termasuk yang rugi.** Tanpa klaim kinerja.

### 4.13 Pusat Akun (`AccountCenter.dc.html`)
- **Isi wajib:** nama pengguna; navigasi bagian; "Keluar dari sesi"; **Profil**; **Tampilan** (Mode warna: Otomatis/Terang/Gelap); **Keamanan & Koneksi** (uji dan saklar Telegram; ganti password: Password saat ini, password baru "Minimal 8 karakter, huruf dan angka"); **Preferensi Trading** (Modal trading Rp, Risiko per transaksi %, bunyi alert + "Tes suara", "Tampilkan maskot dan sapaannya"); **Pengaturan AI** (Kredensial baru "Tempel kredensial Gemini", "Validasi & simpan", mode Otomatis/Cepat/Teliti, Ganti kredensial, Uji koneksi, Hapus); **Langganan** (Kode voucher); **Ketentuan**.
- **Keamanan UI:** kredensial AI **tidak pernah dikirim balik** ke klien (tampilkan hanya status/4 karakter terakhir), tidak dicatat di log; field password `autocomplete` yang benar; keluar sesi di semua tab (event `storage`/BroadcastChannel). Pilihan tema dan maskot disimpan di akun bila ada endpoint, kalau tidak di localStorage dengan try/catch.

### 4.14 Landing (`Landing.dc.html`)
- **Isi wajib:** hero "Baca pasar. Susun rencana. Jaga konteks." + CTA **"Daftar dengan Gmail"** dan **"Coba kalkulator ↓"**; **Preview produk** (segmen Dashboard/Screener/Bandarmologi; tab Konglo/Non-Konglo/Day Trade; tabel Ticker, kolom mode, Harga, Chg, Skor); bagian 01–07 dengan judul: "Tetapkan kondisi pasar sebelum memilih saham.", "Pilah ratusan emiten ke tiga kategori terukur.", (judul screener dinamis), "Ukur posisi sebelum menekan tombol beli." (kalkulator: Modal, Risiko per trade, visual rentang wajar 10 hari dengan entry/SL/target), "Periksa bukti transaksi di balik pergerakan harga." (Bandarmologi & Broker Summary, Broker Hunter, Jejaring Insider, Sinyal Intelijen), "Uji fundamental dan ketersediaan saham di pasar.", "Interpretasi AI setelah semua bukti terkumpul.", "Kelola pantauan, portofolio, sinyal sistem, dan anggaran pribadi." (Niat, bukan posisi · Rencana & risiko · Audit sinyal sistem · Anggaran bulanan); prinsip "Kejelasan informasi lebih utama daripada janji hasil." (Sumber & kesegaran terlihat · Kosong bukan nol · Bukan penasihat investasi · Keputusan tetap di tangan Anda); penutup "Meja kerja tenang untuk keputusan investasi yang sadar." + "Masuk"; Si Mata menyapa (klik untuk pesan acak, sembunyikan, panggil lagi); pita fitur berhenti saat hover/fokus.
- **Data:** candle hero dari data asli; **"Angka di balik layar" hanya boleh angka yang bersumber** (atau dihapus; tanya pemilik). Pratinjau produk memakai data contoh **yang diberi label jelas sebagai contoh** atau data asli publik.
- **Motion:** paling interaktif (parallax ringan, section muncul saat scroll, angka menghitung naik, demo screener mini, preview chart bisa di-hover, maskot). Efek "candle di sekitar kursor" harus memakai `transform` pada elemen kecil atau satu canvas, **bukan** variabel CSS/background pada wadah besar.
- **Web:** title, meta description, Open Graph/Twitter card, favicon, `lang="id"`, LCP di 390 px (gambar hero dioptimalkan, font preload), halaman 404 (lihat Bagian 8).

### 4.15 Auth: Masuk, Daftar, Pemulihan, Lengkapi Gmail
- **Masuk (`AuthLogin.dc.html`):** "Masuk ke Auto-Cuan", tutup (×), Email atau username, Password (tampil/sembunyi), tombol masuk. **Kanvas masih memuat tautan "Masuk dengan Google": JANGAN dibangun** (Google dibatalkan pemilik; catat sebagai deviasi). Pesan gagal **seragam** (tidak membedakan akun tidak ada / password salah); tampilkan pesan ramah saat dibatasi (429) beserta waktu tunggu bila diberikan server.
- **Daftar (`AuthRegister.dc.html`):** tahapan; Gmail, Username ("huruf kecil, angka, garis bawah"), Password (min. 8), Konfirmasi, centang Syarat & Ketentuan; "Daftar sekarang"; layar "Akun dibuat" dengan tombol salin (ikuti alur yang ada di repo untuk verifikasi Telegram/persetujuan admin). Tombol "← Kembali ke formulir (demo)" tidak dibangun.
- **Pemulihan (`AuthRecovery.dc.html`):** 3 langkah ("Langkah N dari 3"): Gmail atau username → "Kirim kode ke Telegram" (+ "Kirim ulang kode", "Kembali") → "Verifikasi kode" (kode OTP auto-advance antar kotak) → Password baru + konfirmasi → "Password diperbarui" + "Masuk". Tidak membocorkan apakah akun terdaftar. "Ulangi demo" tidak dibangun.
- **Lengkapi Gmail (`AuthGmail.dc.html`):** "Lengkapi identitas akun", Alamat Gmail aktif + ulangi, tombol.
- **Umum:** validasi per kolom (pesan di bawah kolom, `aria-describedby`), tanpa data terisi, Si Mata **tidak** muncul, `autocomplete` (`username`, `current-password`, `new-password`, `one-time-code`).

### 4.16 Ketentuan (`Ketentuan.dc.html`)
- **Isi:** "Ketentuan dan batasan"; **Ketentuan layanan** (12 butir) dan **Batasan risiko** (8 butir) dengan anchor yang bisa ditautkan. Teks statis dari kanvas (bukan data contoh, tetapi cek ulang dengan pemilik bila ada perubahan legal).

### 4.17 Admin Console (`AdminConsole.dc.html`) — hanya admin (dicek di server)
- **Isi wajib:** tab/seksi; tautan "<N> online sekarang"; **Kesegaran dataset** (Dataset, Terakhir sukses, Jadwal, Status); **Online** (filter Semua/Online/Hari ini/Tidak aktif > 7 hari, cari pengguna, tabel Pengguna, Halaman, Perangkat, Lama sesi, Masuk terakhir; **tanpa IP**; perbarui 30 dtk); **Persetujuan akun** (Gmail, Daftar, Telegram, Aksi: Tolak/Setujui/Urungkan); **Pengguna** (cari username atau Gmail; Peran, Paket, Login terakhir, aksi); **Mode maintenance** (saklar, Mulai, Perkiraan selesai, Pesan untuk pengguna, kirim pemberitahuan Telegram, "Buka layar maintenance penuh"); **Buat voucher** (Kode, Paket: Pro Trader 30 hari / 90 hari / Lifetime, Kuota pemakaian, Kedaluwarsa) + **Voucher aktif**; **Job & data pipeline** (Job, Terakhir jalan, Durasi, status, tombol aksi); **Log audit**; dialog konfirmasi berbahaya ("Ketik <KATA> untuk konfirmasi" + Alasan wajib).
- **Data:** status job **asli** dari server; kuota ditulis "Kuota API data" (terpakai / batas / reset 00:00 WIB); anomali hari itu (`anomaly_total`, `anomaly_pct`, `anomaly_top100`, `warnings_total`, `archive_complete`).
- **Jebakan:** tombol aksi job (mis. menjalankan ulang) **berbahaya**: bisa memicu request penyedia data dan bentrok dengan job harian. **Jangan menyambungkan aksi job tanpa keputusan pemilik dan endpoint dari Roo**; default tampilkan status saja. Heartbeat online tidak memakai kuota data. Semua aksi admin masuk log audit.

### 4.18 Pattern Radar (`PatternRadar.dc.html`) — hanya admin
- **Isi wajib:** Pola (Semua pola, Double Bottom, Bullish Flag, Ascending Triangle, Cup & Handle); "Kemiripan min. N%"; tombol pindai; tabel Ticker, Pola, Bentuk, Kemiripan, Area breakout, Target proyeksi, Status validasi.
- **Jebakan:** "Target proyeksi" bukan janji; beri konteks. Pemindaian berat jangan memblokir UI (tunjukkan progres, bisa dibatalkan).

### 4.19 Pemeliharaan (`Maintenance.dc.html`)
- **Isi:** "Kami sedang memperbarui sistem", pesan dan perkiraan selesai dari Admin Console, tombol (muat ulang / cek lagi). Admin tetap bisa masuk. (Penegakan di API data adalah usulan Roo, bukan tugas UI.)

### 4.20 Mobile (`Mobile.dc.html`, `MobileScreener.dc.html`)
- Bukan halaman terpisah: hasil breakpoint ≤760 px. Dashboard HP menampilkan 2 Catatan Admin + Top 5 Radar; Screener HP berupa kartu baris ("<ticker> · <grup> <harga> <tier> Skor … · R/R …"), lembar detail ("Detail <ticker>", tutup ×, "Buka Chart & Analisis", bintang), menu "Semua halaman", tab bawah 4 item.

---

## 5. Kesiapan produksi web (wajib dipikirkan sebelum "deploy")

1. **CSP akan ditegakkan.** Sekarang `Content-Security-Policy-Report-Only` dengan `default-src 'self'` (+ aturan lain; baca string lengkapnya di kode server, commit `73035e99`/`61281b19`; **jangan ubah kode keamanan**). Konsekuensi untuk UI:
   - **Skrip tema di `<head>`** (anti-kedip) yang inline akan diblokir saat CSP ditegakkan. Pilihan: file kecil `public/theme-boot.js` yang dimuat sinkron di `<head>`, atau hash/nonce (urusan Roo). Catat pilihanmu di laporan.
   - Hindari `onclick="..."` inline, `javascript:` URL, dan `style="..."` baru (pakai kelas). Hitung yang sudah ada dan laporkan.
   - **Library chart dari `unpkg.com` tercatat melanggar CSP.** Self-host (salin file versi yang sama ke `public/vendor/`, muat dari sana) sebagai commit terpisah, lalu laporkan ke Roo.
   - **Jangan menyalin `<link>` Google Fonts** dari file kanvas (semua 28 file kanvas memuatnya); font sudah self-host.
2. **Cache Cloudflare:** pengguna bisa mendapat JS/CSS lama bersama HTML baru (tampilan rusak campur). Pastikan aset diberi versi (nama file berhash atau `?v=<hash commit>`), HTML tidak di-cache lama, dan tulis di daftar deploy: **purge cache Cloudflare** untuk HTML/JS/CSS setelah deploy.
3. **Tautan langsung dan refresh:** `/kelola-keuangan`, `/catatan-admin`, `/analisis?t=<TICKER>&catatan=<id>`, dan halaman lain harus tampil benar saat dibuka langsung atau di-refresh (cek routing server/SPA). Tombol Kembali browser bekerja; judul tab (`document.title`) berubah per halaman.
4. **Halaman 404** yang sesuai gaya (tidak ada di kanvas → tanya pemilik; usulan: tata letak Pemeliharaan dengan teks "Halaman tidak ditemukan" + tautan Dashboard).
5. **Meta:** Landing punya title/description/OG/favicon; halaman aplikasi yang butuh login sebaiknya `noindex` (keputusan pemilik).
6. **Dukungan browser:** Chrome/Edge terbaru, Safari iOS 16+ (unit `cqi`, `:has()`, `dvh`), Firefox terbaru. View Transitions dan fitur baru lain harus progresif (tanpa error bila tidak didukung).
7. **Penyimpanan lokal:** semua `localStorage` dibungkus try/catch; data penting (watchlist, portofolio, preferensi) disimpan di server.
8. **Cetak:** Screener "Cetak / PDF" butuh stylesheet `@media print` (tanpa sidebar, strip, maskot; tabel muat halaman; tanggal data tercetak).
9. **Waktu dan kalender:** semua tampilan WIB; hari bursa dan libur dari kalender bursa (ada `market_calendar` di respons breadth).
10. **Tidak ada rahasia di JS klien** (cek bundle untuk kunci/token), tidak ada `console.log` data pribadi.

---

## 6. Cara menguji

- **Matriks viewport:** 1440×900, 1024×768, 390×844 (plus pemeriksaan overflow di 820 dan 1000). Kedua tema: set `data-theme` atau `page.emulateMedia({ colorScheme: 'dark' })`.
- **Keadaan:** di Playwright, ganti respons endpoint dengan `page.route('**/api/<endpoint>**', r => r.fulfill({ status: 500 }))` (gagal), `fulfill({ json: [] })` atau bentuk kosong yang benar (kosong), dan tunda respons (memuat). Pastikan teks dari `ST` muncul dan tombol "Coba lagi" bekerja.
- **CPU 4×:** lewat CDP `Emulation.setCPUThrottlingRate { rate: 4 }`.
- **INP/hover:** ukur dengan `PerformanceObserver` tipe `event` (durasi interaksi) dan task panjang (`longtask`); laporkan median dan p95 sebagai rentang (pengukuran headless terkuantisasi 16,7 ms).
- **Selisih piksel:** metode tetap: persen piksel beda dari seluruh layar dengan ambang warna YIQ 0,1 (setara `pixelmatch` threshold 0.1); acuan 1440/1024 = render kanvas lewat `python -m http.server` di `handoff-redesign/design/project`, dengan **data contoh yang sama** (fixture); acuan 390 = `screenshots/<X>_m.png` dan `screenshots/gelap-390/<X>_M.png`. Simpan gambar desain | implementasi | selisih di `handoff-redesign/pixel/` (tidak di-commit). Untuk Analisis, tunggu chart termuat (±9 dtk).
- **Keyboard:** Tab melalui semua kontrol, Shift+Tab, Enter/Spasi, Escape, panah pada segmen/tab (`role="tablist"`).
- **Kontras:** cek otomatis teks di kedua mode (target 0 gagal).
- **Regresi:** `npm run test:full`; test lama yang mengunci markup pra-redesign diperbarui ke kontrak baru **tanpa** melonggarkan cek perilaku.
- Browser bawaan Antigravity boleh dipakai untuk melihat halaman localhost, tetapi **angka diambil dari skrip**, bukan dari kesan visual.

---

## 7. Jebakan khas agen AI (termasuk Gemini)

| Jebakan | Yang benar |
|---|---|
| Menulis ulang seluruh file besar (`public/index.html`, runtime) | Diff kecil dan terarah; pertahankan ID dan fungsi lama |
| Menebak nama field/endpoint | Baca kode endpoint; tulis "tidak diketahui" bila tidak ada |
| Mengisi angka contoh supaya "terlihat bagus" | "—" + cap waktu; data contoh hanya di test/fixture |
| Menghapus kode yang "tidak terpakai" | Jangan hapus fitur lama; pindahkan ke "Alat lanjutan" atau tanya |
| `npm install` paket baru (ikon, animasi, chart, UI kit) | Dilarang tanpa izin pemilik |
| `git add -A`, `git push --force`, rebase setelah push | Tambah file satu per satu; push biasa; merge, bukan rebase |
| Menandai PR siap / merge | Dilarang; tunggu "deploy" |
| Teks Inggris atau em dash di UI, nama "Arjum" | Bahasa Indonesia biasa; sumber netral |
| Melonggarkan test agar hijau | Perbarui test ke kontrak baru dengan cek perilaku yang sama |
| Mengejar optimasi kecil sampai batas pemakaian habis | Laporkan angka apa adanya, lanjut tugas berikutnya |
| Mengubah logika skor/gate saat merapikan tampilan | Logika tidak berubah; perbaikan bug = commit `fix` terpisah + test |
| Menyentuh file pipeline/keamanan karena "kelihatan salah" | Tulis di laporan untuk Roo |
| Menempel log test mentah | Log bisa memuat alamat/kunci VPS; ringkas saja |
| Melaporkan "selesai" tanpa bukti | Sertakan perintah, hasil, angka, hash commit |

---

## 8. Pertanyaan terbuka untuk pemilik (agen harus bertanya, bukan menebak)

1. **"Alat lanjutan"**: setuju fitur lama (preset, filter Pola, undo/redo, dll.) dipindah ke bagian lipat supaya tata letak sama dengan desain? (Rekomendasi: setuju.)
2. **Landing "Angka di balik layar"**: angka apa yang boleh tampil (harus bersumber dan bertanggal), atau bagian ini dihapus?
3. **Pratinjau produk di Landing**: pakai data asli publik, atau data contoh berlabel "contoh"?
4. **Halaman 404**: pakai usulan (gaya Pemeliharaan + tautan Dashboard)?
5. **SEO**: halaman aplikasi yang butuh login diberi `noindex`?
6. **Admin Console "Job & data pipeline"**: tombol aksi job boleh aktif dari UI? (Rekomendasi: tampilkan status saja sampai Roo menyediakan endpoint aman.)
7. **Status "Kredensial AI · terhubung"** di Dashboard: perlu endpoint ringan status kunci, atau tetap tanpa status?
8. **Radar "N lolos gate · dari M emiten"**: tambahkan jumlah emiten yang dipindai ke payload (perubahan server, tinjau Roo) atau biarkan "x/5"?
9. **Catatan Admin**: siapa saja admin, dan apakah butuh notifikasi Telegram nanti (sekarang tidak)?

---

## 9. Koordinasi dengan Roo

- Kebutuhan data/VPS → `handoff-redesign/CEK_VPS_UNTUK_ROO.md` (nomor, tujuan, perintah baca-saja, hasil yang diharapkan). Pemilik meneruskan ke Roo dan menempel hasilnya.
- Perubahan server yang dibuat untuk UI → bagian "Perubahan server untuk ditinjau Roo" di setiap laporan (file, commit, akses publik/admin, cache, batas laju, apakah memicu request penyedia data).
- Konflik merge di file Roo → berhenti dan laporkan.
- Antrean Roo yang menyangkut web: self-host library chart/CSP, `lib/trusted-proxy.js`, `broker-consistency` gerbang + batas laju, endpoint cache harga live (bar hari ini, strip harga live), Catatan Admin backend, CI `browser`, purge Cloudflare setelah deploy.
