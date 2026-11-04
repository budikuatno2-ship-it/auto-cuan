# SERAH TERIMA REDESIGN UI/UX AUTO-CUAN → ANTIGRAVITY (Gemini)

> Terakhir diperbarui: **Jumat 23 Okt 2026, ±21:00 WIB**. Ditulis oleh Claude untuk pemilik produk, supaya pekerjaan redesign yang tadinya dikerjakan **Claude Code** bisa diteruskan oleh **Antigravity/Gemini** tanpa kehilangan konteks.
> Dokumen ini **tidak berisi** kunci, token, alamat VPS, atau lokasi kunci. Jangan menambahkannya.
> Pasangannya: `HANDOFF_ROO_PIPELINE_VPS.md` (pipeline data, cron, VPS, kuota, keamanan server). Pekerjaan di file itu **bukan** wilayahmu.

---

## 0. Baca ini dulu (30 detik)

1. Kamu meneruskan redesign **Auto-Cuan Redesign v2** (aplikasi riset saham IDX, domain produksi `autocuan.web.id`) di folder lokal pemilik **`D:\auto-cuan-redesign`**, branch **`redesign/v2`**.
2. Sudah selesai: fondasi (token, tema gelap, font, ikon, shell, komponen status, motion + maskot "Si Mata") dan **4 halaman**: **Dashboard, Screener, Analisis & Chart, Kelola Keuangan**. Ada **PR DRAFT #910** ke `feat/daytrade-screener-v1`. **Belum di-merge. Belum dideploy.**
3. Hasilnya **belum "plek ketiplek"**: selisih piksel dengan desain masih 7–18%, dan penyebab utamanya **tata letak** (fitur lama yang dipertahankan mendorong isi ke bawah). **Tugas pertamamu: menutup selisih itu** (lihat Bagian 9, T1).
4. Sisa pekerjaan: sekitar **19 halaman** lagi (Bagian 6) dan fitur baru **Catatan Admin**.
5. Aturan paling penting: **jangan merge, jangan deploy, jangan restart, jangan menyentuh pipeline data atau keamanan server, tidak ada angka karangan.** Detail di Bagian 3.
6. Kalau ragu, **tanya pemilik**. Jangan menebak.

---

## 1. Gambaran produk dan siapa pemiliknya

- **Produk:** Auto-Cuan, situs riset saham IDX untuk trader ritel Indonesia (screener Swing Konglo/Non-Konglo, Day Trade, Bandarmologi, Analisis & Chart, Watchlist, Portfolio, Track Record, dll.). **Bukan** penasihat investasi: tidak ada saran beli/jual, tidak ada janji untung.
- **Pemilik produk:** satu orang (non-engineer). Menulis informal dalam **bahasa Indonesia**. Balas dalam bahasa Indonesia, singkat, langkah demi langkah bila diminta dipandu.
- **Stack (hasil Fase 0 Claude Code):** SPA di `public/index.html` + modul `public/*-runtime.js`; backend Node di `api/` dan `lib/`; `server.js`; data berupa file JSON di `data/` dan SQLite; chart memakai **Lightweight Charts v4** (`public/chart-viewer.js`). Tema: `public/ui-theme.css`; ikon: `public/ac-icons.js` (buatan sendiri, tanpa library ikon).
- **Produksi:** satu VPS yang selalu menjalankan branch **`feat/daytrade-screener-v1`**. **Branch utama = `feat/daytrade-screener-v1`, bukan `main`.** Jangan pernah merge ke `main`.
- **Pembagian kerja:**
  - **Kamu (Antigravity/Gemini):** redesign UI/UX di repo lokal `D:\auto-cuan-redesign`.
  - **Roo Code** (VS Code, folder `D:\auto-cuan-2`, punya akses VPS): pipeline data, cron, backfill, kuota Arjum, keamanan server, deploy.
  - **Claude** (chat ini): menulis prompt, menelaah laporan, dokumen serah terima.

---

## 2. Peta tempat (di mana semuanya)

| Apa | Di mana |
|---|---|
| Folder kerja kamu | `D:\auto-cuan-redesign` (clone lokal; **bukan** `C:`), branch **`redesign/v2`** |
| Repo GitHub | `budikuatno2-ship-it/auto-cuan` |
| PR draft | **#910** "Redesign v2: foundation, Dashboard…" basis `feat/daytrade-screener-v1`, +6.798 / −1.544 baris. Deskripsi lengkap ada di `PR_DRAFT_redesign-v2.md` (output Claude Code) |
| Branch desain sumber | `handoff/redesign-v2` (commit `4672152`), **tidak boleh di-merge** |
| File desain | `handoff-redesign/design/project/` (di folder lokal; **tidak ikut commit**) |
| Spesifikasi | `handoff-redesign/HANDOFF_REDESIGN_V2.md` (+ `PROMPT_CLAUDE_CODE_REDESIGN.md` = rencana fase 0–4) |
| Screenshot target | `handoff-redesign/screenshots/` (70 file) |
| Laporan Claude Code | `handoff-redesign/FASE0_BASELINE.md`, `AUDIT_HALAMAN.md`, `AUDIT_ALUR.md`, `CEK_MANUAL_PEMILIK.md`, `FASE3_KELOMPOK1.md`; di branch juga `docs/redesign-handoff/` (kalau sudah di-commit) |
| Gambar selisih piksel | `handoff-redesign/pixel/` (nama `fx-*`) |
| Karantina artefak test | `handoff-redesign/karantina/…` (dipindah, **tidak dihapus**) |
| Desain online | Artefak Claude "Auto-Cuan Redesign v2" (v100): `https://claude.ai/artifact/KnvdLe1XveLK2Bcrx7h1QL`. **Kamu mungkin tidak bisa membukanya.** Tidak masalah: seluruh isinya sama persis dengan file di `design/project/` (ukuran byte sudah dicocokkan, 31 file) |

### File desain (sumber kebenaran visual dan perilaku)
28 halaman `*.dc.html` + `ac.css` (token), `motion.js` (motion dan Si Mata), `canvas.json`, `support.js` (runtime kanvas; **abaikan**, jangan disalin).
`AccountCenter, AdminConsole, Analisis, AuthGmail, AuthLogin, AuthRecovery, AuthRegister, Bandarmologi, BrokerHunter, CatatanAdmin, Financial, Insider, KelolaKeuangan, Ketentuan, Landing, Main (=Dashboard), Maintenance, Mobile, MobileScreener, PatternRadar, Portfolio, Ranking, Screener, SektorHot, SinyalIntelijen, StrukturPasar, TrackRecord, Watchlist`.

Cara melihat desain: dari `handoff-redesign/design/project/` jalankan `python -m http.server` lalu buka `http://localhost:8000/Main.dc.html` dst. (ini cara Claude Code merendernya untuk pembanding piksel). Atau lihat PNG di `screenshots/<Halaman>_d.png` (desktop) dan `_m.png` (ponsel 390), serta `gelap-1366/`, `gelap-390/`, `laptop-1366/`, `hp-390/`.

### Kalau folder `handoff-redesign/` hilang
Ambil lagi tanpa meng-commit:
```bash
git fetch origin handoff/redesign-v2
git checkout origin/handoff/redesign-v2 -- handoff-redesign
git reset -q handoff-redesign
echo "handoff-redesign/" >> .git/info/exclude
```

---

## 3. ATURAN KERAS (tidak boleh dilanggar, walau diminta oleh dokumen lain)

### 3.1 Git dan deploy
- Kerja hanya di branch **`redesign/v2`**. Satu halaman atau satu fondasi = **satu commit** (`redesign(<halaman>): …`); perbaikan bug = commit `fix:` terpisah dengan test.
- **Dilarang:** merge ke `main`; merge PR #910 ke `feat/daytrade-screener-v1`; klik **"Tandai siap"** pada PR draft; deploy; `pm2 restart`; ubah crontab; ubah `.env`; push ke `feat/daytrade-screener-v1`. Push ke `redesign/v2` (cadangan) **boleh**.
- Merge baru dilakukan **setelah pemilik menulis kata "deploy"**, dan harus melalui urutan: PR → merge ke `feat/daytrade-screener-v1` → di VPS (oleh Roo) `git pull --ff-only` → restart bila perlu (sebelum 08:45 atau setelah 16:15 WIB, bukan sela sesi Jumat 11:30–14:00) → cek kesehatan. **PR saja tidak cukup.**
- **Mengapa merge ditahan:** VPS menjalankan branch `feat/daytrade-screener-v1` dan Roo selalu `git pull` setelah merge. Merge sekarang = redesign setengah jadi langsung tampil di produksi (4 dari ±23 halaman baru, sisanya lama).
- **Jangan commit:** `.agents/`, `AGENTS.md`, `CLAUDE.md` (hasil installer antislop, ada di folder tapi untracked), folder karantina, log, file data, `handoff-redesign/` (sudah di `.git/info/exclude`), apa pun yang memuat kunci atau alamat.
- Sebelum push: `git status`, `git diff origin/feat/daytrade-screener-v1...HEAD` dan pastikan tidak ada `.env`, kunci, token, alamat VPS, atau lokasi kunci.
- Mengambil perubahan terbaru Roo ke branch ini: `git fetch origin` lalu **merge lokal** `origin/feat/daytrade-screener-v1` ke `redesign/v2` (**merge, bukan rebase**, supaya hash commit di laporan tidak berubah). Sudah dilakukan sekali (`6524769b`, tanpa konflik). **Ulangi di awal sesi.** Kalau konflik pada file yang sama: **logika data Roo menang**, dari redesign hanya tampilannya.

### 3.2 Data
- **Tidak ada angka karangan.** Data kosong ditulis **"—"** (render `<span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">—</span>`), **tidak pernah 0**.
- Angka di file desain adalah **data contoh** (BRPT 1.045 / 1.210, tanggal 13 dan 16 Okt, nama "budi") dan **tidak boleh masuk produk**.
- Setiap angka punya **sumber dan cap waktu** (baris "prov" di bawah kartu). Status kesegaran data dihitung dari **waktu data**, bukan jam dinding.
- Data cadangan/tertunda tidak boleh tampil seperti data asli: tulis "data terakhir tersimpan · <tanggal asli>"; bar hari ini `provisional:true` tulis "sementara · diperbarui hh:mm"; data asing belum dirilis tulis "data asing belum dirilis", bukan 0.
- **Gagal tidak boleh menebak angka.** Tampilkan data terakhir tersimpan beserta cap waktunya.
- **Jangan hapus file data.** Yang salah dipindah ke folder `_quarantine-*` atau `handoff-redesign/karantina/`.
- **Jumlah saham 962 tidak boleh berkurang.**

### 3.3 Wilayah yang TIDAK boleh disentuh (milik Roo Code)
`tools/backfill-*`, `tools/run-daily-*`, `tools/fetch-daily-candles.js`, `tools/simulate-*`, `tools/catchup-*`, `lib/arjum-*`, `lib/broksum-*`, `lib/broker-accumulation-local.js`, `lib/trusted-proxy.js`, crontab, `.env`, keamanan server (login throttle, header keamanan, `/data/*` allowlist). Bug di sana: **tulis di laporan, jangan perbaiki.**
Logika bisnis tidak boleh berubah karena redesign: skor dan gate screener, Top 5 engine, scoring bandarmologi, Track Record, broadcast Telegram, FastWatcher. Kalau perbaikan bug menyentuhnya: commit `fix:` terpisah + test + beri tahu pemilik.

### 3.4 Akses VPS dan Arjum
- **Kamu tidak punya dan tidak boleh meminta akses VPS.** Semua pengecekan produksi dilakukan Roo Code atau pemilik. Perintah SSH hanya ada di catatan pribadi pemilik. Bentuknya (isi sendiri oleh pemilik, jangan ditulis di repo, commit, atau laporan): `ssh -o ConnectTimeout=15 -o ServerAliveInterval=20 -o ServerAliveCountMax=12 -i "<LOKASI_KUNCI>" ubuntu@<ALAMAT_VPS>`. **Jangan pernah `StrictHostKeyChecking=no`.**
- Jangan cetak atau tempel `.env`, `ARJUM_API_KEY`, kunci SSH, token, IP VPS, lokasi kunci, atau password admin. Jangan meminta password admin. Login uji hanya lewat variabel lingkungan `AC_TEST_USER`/`AC_TEST_PASS` (dan `AC_TEST_PENDING_*`) bila ada.
- **Log test lama mencetak alamat dan kunci VPS** (dari kode `vps-fetcher`). Jangan menempel log test mentah ke chat atau repo. Simpan di scratchpad.
- Arjum (penyedia data): hanya GET, dan **kuota harian sedang kritis**. Pekerjaan UI **tidak boleh** memicu request Arjum. Utamakan data di disk dan fixture lokal.
- Kebutuhan data dari VPS ditulis sebagai perintah baca-saja di `handoff-redesign/CEK_VPS_UNTUK_ROO.md` (nomor, tujuan, perintah read-only, hasil yang diharapkan) untuk diteruskan pemilik ke Roo.

### 3.5 Aturan isi dan UI
- **Nama penyedia data ("Arjum") dan nama internal (VPS, nama tabel seperti `stock_fundamentals`, cron, pm2) tidak boleh tampil di UI.** Tulis netral: "Candle harian EOD bursa", "Broker summary harian", "Kuota API data".
- Tidak ada testimoni, klaim keamanan, atau klaim kinerja tanpa bukti. Tidak ada "pasti cuan". Disclaimer "Bukan rekomendasi beli/jual" di Dashboard, Screener, dan Ketentuan.
- Teks Indonesia, kalimat biasa, **tanpa em dash di kalimat UI** (em dash hanya sebagai simbol data kosong). Tanpa label KAPITAL bertracking lebar.
- Fitur admin (Admin Console, Pattern Radar, Catatan Admin tulis) **ditegakkan di server/route** dengan 403 untuk non-admin, bukan hanya disembunyikan CSS.
- Setiap tabel dibungkus wadah `overflow-x:auto`. Tidak ada overflow horizontal di 390, 820, 1000, 1440 px.
- Hanya animasi `transform` dan `opacity`; satu listener pointer, satu `requestAnimationFrame`; maksimal satu animasi tanpa henti per layar; mati total saat `prefers-reduced-motion`.
- **Dilarang** (penyebab lag yang sudah terbukti): efek yang mengikuti kursor lewat variabel CSS/background pada wadah besar; membaca posisi elemen (`getBoundingClientRect`, `offsetWidth`) setelah menulis gaya di frame yang sama atau di setiap gerakan pointer; memaksa reflow `void el.offsetWidth` (pakai `el.animate` atau rAF); blur pada banyak elemen.
- Satu sistem token saja: petakan token kanvas ke `public/ui-theme.css`. **Jangan buat sistem token kedua**, jangan tulis hex untuk teks/latar/garis netral (pakai token), jangan `npm install` library ikon.
- Merah/hijau **hanya** untuk arah harga atau nilai. Hijau brand hanya untuk CTA, nav aktif, level harga. Bayangan hanya untuk lapisan melayang (maskot, lembar bawah, dialog, drawer).

### 3.6 Alat wajib (kalau tersedia di Antigravity)
- **antislop** (`https://github.com/miqdadbadjuber/anti-slop`; `npx antislop-ai`): 38 aturan (R-01 s.d. R-38) + skill core/UI/copy/a11y/responsive/comments. Dial: **Landing ENERGY 2 · RHYTHM 3 · MOTION 3. Aplikasi ENERGY 1 · RHYTHM 2 · MOTION 2.** Tutup setiap pengiriman halaman dengan **Delivery Gate PASS/FAIL**. Empat keputusan final (Bagian 4.1) sudah diputuskan pemilik: catat sebagai override, jangan ditanyakan lagi.
  - Installer sebelumnya sudah dijalankan di folder ini (`.agents/skills/*`, `AGENTS.md`, `CLAUDE.md` ada). Cek apakah agen Antigravity didukung; kalau tidak, **salin aturan inti di bagian 3 ini sebagai instruksi sistem**.
- **frontend-design**: untuk keputusan visual yang tidak tertulis. Kalau masih ragu, **ikuti kanvas**.
- **codebase-memory-mcp** (graf kode, v0.12.1 di `C:\Users\ADVAN\AppData\Local\Programs\codebase-memory-mcp\`): pemakaian pertama indexing sempat **crash dua kali** (access violation) di Windows, sehingga Claude Code beralih ke grep/Read. Coba lagi; kalau crash, lanjut tanpa itu dan catat. DESIGN.md proyek tetap sumber arah; antislop hanya filter.

---

## 4. Keputusan desain yang sudah final

### 4.1 Empat override antislop (diputuskan pemilik)
1. Data kosong = **"—"** (simbol data, bukan tanda baca).
2. Ikon = **set sendiri** (SVG inline kanvas → modul `public/ac-icons.js`), garis 1,7 px ujung bulat. Tanpa library ikon.
3. Huruf = **Plus Jakarta Sans** (UI) + **Geist Mono** (ticker, harga, lot), woff2 **self-host** (`font-display:swap`, preload berat 400/600). Tanpa Google Fonts saat runtime. (Sudah dikerjakan: `d556b4e6`.)
4. **Si Mata** (maskot) tetap berkedip: berhenti saat tab tidak aktif dan `prefers-reduced-motion`; bisa disembunyikan (disimpan); **tidak muncul** di halaman Auth.

### 4.2 Token dan tema
- Token dari blok `:root` di `ac.css` **apa adanya**. Wajib: `--ac-neg:#AD3F52`, `--ac-warn-t:#8A590D` (sudah digelapkan untuk kontras AA). Token baru `--ac-inv` untuk permukaan gelap terbalik.
- Tema: Otomatis (ikut `prefers-color-scheme`), Terang, Gelap. `<html data-theme="light|dark">` + kelas `is-dark`, dipasang lewat skrip di `<head>` sebelum CSS (tanpa kedip). Pilihan ada di Pusat Akun → Profil → Tampilan, dan tombol bulan/matahari di bilah atas. Kontras AA harus lolos di **kedua** mode.
- Indikator chart di mode gelap diterangkan dengan pemetaan sama untuk garis dan label (`DKM` di Analisis, blok "warna garis indikator" di `ac.css`).

### 4.3 Shell
- ≥1100 px: sidebar 240 px **diam**, bisa diciutkan ke 68 px; hanya `.main` yang scroll.
- 761–1099 px: tetap tampilan desktop; sidebar otomatis rel ikon 68 px dengan tooltip.
- ≤760 px: bilah atas ringkas (logo + Menu), menu layar penuh (Escape menutup), **tab bawah 4 item**: Dashboard, Screener, Watchlist, Lainnya.
- Grup menu: **Dashboard · Temukan (Screener, Sektor Hot, Catatan Admin) · Riset (Analisis & Chart, Bandarmologi, Sinyal Intelijen, Broker Hunter, Insider, Ranking, Financial, Struktur Pasar) · Pantau (Watchlist, Portfolio, Track Record, Kelola Keuangan) · Admin (Pattern Radar, Admin Console, hanya admin, dirender di server)**.
- Bilah atas: pencarian (⌘K) + status kesegaran data ("EOD / T-1 · 16 Okt 2026, 16.00 WIB", dari waktu data).
- **Strip harga saham** di bawah bilah atas di semua halaman aplikasi: IHSG paling kiri, saham likuid (nilai transaksi ≥ Rp 5 M) yang naik, urut kenaikan, maks 30, tambah saham likuid lain bila hijau < 8. Sumber: endpoint ringan `/api/tape` (cache 60 detik, **pengunjung tidak memanggil Yahoo**). Di luar jam bursa: "penutupan <tanggal>". Bergeser ±45 px/detik pakai `transform`, berhenti saat hover/fokus, ada tombol jeda (WCAG 2.2.2), diam saat reduced-motion.

### 4.4 Keputusan pemilik yang MENIMPA dokumen lama (penting)
| Topik | Keputusan |
|---|---|
| **Login Google** | **DIBATALKAN.** Desain memakai Gmail yang diketik manual (Daftar + "Lengkapi Gmail"). **Hapus tombol "Masuk dengan Google"** dari halaman Auth. Tidak ada OAuth. (Belum dikerjakan di UI.) |
| **Kelola Keuangan** | **Dihidupkan lagi** (`/kelola-keuangan`, premium-only). Sudah dikerjakan (`07a042ed`, `557ed768`). |
| **Versi desain** | Kanvas sekarang **v100**. `HANDOFF_REDESIGN_V2.md` masih menulis v87; **file `.dc.html` yang menang** bila ada beda. |
| **Tab bawaan Analisis** | **Analisis AI** (bukan Chart Workstation), keputusan FIX-22. |
| **Strip harga** | Memakai penutupan terakhir berlabel tanggal sampai ada endpoint cache harga live. |

---

## 5. Perilaku halaman dan chart (ringkasan; rincian di `HANDOFF_REDESIGN_V2.md` §5–§8)

Baca bagian ini di spesifikasi aslinya sebelum mengerjakan halaman yang bersangkutan: **§5** (tabel perilaku per halaman), **§5a** (chart), **§5b** (Admin Console tab Online), **§5c** (teks di dalam SVG), **§5d** (Catatan Admin), **§6** (keadaan kosong/memuat/gagal), **§7** (motion + Si Mata), **§8** (aturan isi).

Poin yang paling sering terlewat:
- **Keadaan kosong/memuat/gagal yang asli** wajib di setiap halaman data (teks dari objek `ST` di `motion.js`: penyebab, langkah berikutnya, "Coba lagi"). Bilah "Pratinjau status" di kanvas hanya alat review, **jangan dibangun**. Begitu juga saklar "Pratinjau sebagai Pengunjung/Admin" dan tombol pratinjau 5 suasana Si Mata.
- **Chart (Lightweight Charts v4, jangan tulis ulang engine):** rentang default 6 bulan; tombol rentang 3B·6B·1T·Semua; crosshair dengan tag harga di posisi kursor; kotak info OHLC dekat kursor; legenda selalu terisi; skala harga manual (seret/scroll sumbu, tombol − / + / Auto); zoom waktu dengan Ctrl/⌘+scroll (scroll biasa hanya di mode "Satu layar"); sentuh: cubit zoom, ketuk crosshair menempel, tahan 300 ms lalu geser; `touch-action: pan-y`; rencana per horizon **Scalping/Swing/Investor** (Scalping dari engine Day Trade, Swing dari engine Swing, **Investor belum ada engine → keadaan kosong "Belum ada rencana Investor dari server", level tidak boleh dihitung di browser**); cek rentang wajar 10 hari hanya Scalping/Swing; LPM = "LPM · kurva tekanan candle · Money Flow" (komponen asing **belum** digabung, menunggu simulasi); lencana konsistensi bandar (broker pembeli bersih terbesar 20 hari, jumlah hari net buy dari 10 hari, hari beruntun).
- **IHSG/indeks: tanpa entry, SL, TP, area entry, kalkulator lot, layer bandar, sinyal S1.** Gantinya panel **Potensi arah** (horizon Harian/Mingguan/Bulanan, bias dari MA, skenario naik/turun ke R1/R2/S1/S2, rentang kemungkinan `close × e^(±1,2816 × σ60 × √hari)`), dengan kalimat wajib "Ini gambaran arah pasar, bukan sinyal beli atau jual." Harga tanpa "Rp". Pertanyaan AI "Ke mana arahnya?".
- **Anggaran performa chart (CPU 4×):** 88 elemen, frame hover target ≤ 50 ms (p95), ganti ticker 190 ms. Crosshair/tooltip/legenda tidak boleh memicu render ulang komponen; pakai `subscribeCrosshairMove` + update DOM langsung, satu kali per rAF. `setData` hanya saat ticker/timeframe berganti; bar hari ini lewat `series.update()`. Indikator dihitung sekali per ticker+timeframe.
- **Admin Console:** kesegaran dataset, kuota (terpakai/batas/reset 00:00 WIB), dan anomali dari data **asli**; tab **Online** (heartbeat 60 dtk saat tab terlihat, status online = `last_seen` < 2 menit, endpoint daftar hanya admin, **IP tidak ditampilkan**, riwayat dihapus otomatis setelah 30 hari, heartbeat tidak memakai kuota data).
- **Catatan Admin (fitur baru no. 14)** punya aturan server yang ketat (tick size BEI, hanya arah naik, kata janji ditolak, tidak bisa dihapus, status dihitung server). Butuh tabel `admin_notes` + `admin_note_edits` (append-only) dan endpoint `POST/PATCH /api/admin-notes` (hanya admin, 403 untuk lainnya). **Perubahan server/DB ini harus ditinjau Roo sebelum deploy**; lihat Bagian 9 T3.

---

## 6. STATUS PER HALAMAN (23 halaman di urutan Fase 3)

Legenda: ✅ selesai dan terverifikasi · 🟡 sebagian / belum plek · ⬜ belum dikerjakan.

| # | Halaman | Status | Catatan |
|---|---|---|---|
| 1 | Dashboard | 🟡 | Fondasi + struktur kanvas, angka karangan dibuang, strip harga, sparkline IHSG diperbaiki, Top 5 payload diperbaiki. Belum plek: Catatan Admin belum ada (mendorong Top 5), sel Radar "x/5 lolos gate" vs "8 lolos gate" (isi), baris bawah 390 |
| 2 | Screener | 🟡 | Urutkan (Bawaan/Skor↓/Perubahan↓) dan Kolom ringkas/lengkap dibangun (`891a3000`). Belum plek: tabel turun ±520 px karena preset Bandar Metrics, filter Pola, kartu mode lama |
| 3 | Analisis & Chart | 🟡 | §5a hampir semua jadi (kursor, harga terbaca, lencana konsistensi, rentang, bar sementara, nama LPM, bintang Watchlist). Belum: layer Tekanan Broker, Harga rata-rata bandar, kerucut 10 hari di chart saham, bar live dari server; chart turun ±100 px |
| 4 | Bandarmologi | ⬜ | **Kelompok 2** (bersama Watchlist, Portfolio). Data produksi sedang bolong 19–23 Okt dan cakupan asing rendah; tampilkan tanggal data jujur |
| 5 | Watchlist | ⬜ | |
| 6 | Portfolio | ⬜ | CI job `browser` gagal sejak 19 Okt karena assertion UI Portfolio (bukan dari redesign); perbaiki/jelaskan di sini |
| 7 | Sinyal Intelijen | ⬜ | |
| 8 | Broker Hunter | ⬜ | Indeks `broker-hunter-indexes` sempat basi sejak 12 Sep (sudah dicron lagi oleh Roo) |
| 9 | Insider | ⬜ | Graf: label HTML berposisi persen di atas SVG (ukuran `cqi`) |
| 10 | Ranking | ⬜ | |
| 11 | Financial | ⬜ | |
| 12 | Struktur Pasar | ⬜ | |
| 13 | Sektor Hot | ⬜ | |
| 14 | **Catatan Admin (fitur baru)** | ⬜ | Tabel + endpoint + job status + halaman + bagian di Dashboard/Mobile. **Butuh tinjauan Roo** |
| 15 | Track Record | ⬜ | |
| 16 | Kelola Keuangan | 🟡 | Dihidupkan lagi, bar komposisi, pemilih bulan "Oktober 2026", titik Jenis. Belum plek: baris toolbar fitur lama mendorong tabel ±80 px; "Rp" di kolom Nominal; Catatan rata atas |
| 17 | Pusat Akun | ⬜ | Pilihan tema Otomatis/Terang/Gelap dan saklar Si Mata |
| 18 | Landing | ⬜ | Paling interaktif (lihat Bagian 8). Angka strip harus bersumber |
| 19 | Auth (4: Masuk, Daftar, Pemulihan, Lengkapi Gmail) | ⬜ | **Hapus tombol Google.** Si Mata tidak muncul. Pesan salah password tidak boleh membedakan "akun tidak ada" vs "password salah" |
| 20 | Ketentuan | ⬜ | 12 ketentuan + 8 batasan risiko |
| 21 | Admin Console | ⬜ | Plus tab Online (§5b) |
| 22 | Pattern Radar | ⬜ | Hanya admin |
| 23 | Pemeliharaan | ⬜ | Mode pemeliharaan sekarang hanya ditegakkan di UI; penegakan API data adalah usulan Roo |

**Urutan kelompok (3 halaman per kelompok, setiap kelompok: berhenti → tabel deviasi → angka piksel → tunggu pemilik):**
(1) Dashboard, Screener, Analisis, Kelola *(sudah, tinggal ditutup selisihnya)* → (2) Bandarmologi, Watchlist, Portfolio → (3) Sinyal Intelijen, Broker Hunter, Insider → (4) Ranking, Financial, Struktur Pasar → (5) Sektor Hot, **Catatan Admin**, Track Record → (6) Pusat Akun, Landing, Auth(4) → (7) Ketentuan, Admin Console, Pattern Radar, Pemeliharaan → **Fase 4: laporan akhir lalu STOP.**

Mobile (`Mobile.dc.html`, `MobileScreener.dc.html`) adalah versi saku Dashboard dan Screener; di produk itu ditangani oleh breakpoint ≤760 px, bukan halaman terpisah.

---

## 7. Apa yang sudah dikerjakan Claude Code (riwayat dan bukti)

### 7.1 Fase yang selesai
- **Fase 0:** baseline screenshot (1440/1024/390) dan log konsol semua halaman, hasil test awal. Laporan: `FASE0_BASELINE.md`.
- **Fase 1 + 1a:** audit per halaman dan alur akun/Telegram/keamanan. `AUDIT_HALAMAN.md`, `AUDIT_ALUR.md`, `CEK_MANUAL_PEMILIK.md`.
- **Fase 2 (fondasi):** token + tema Otomatis/Terang/Gelap (`63500bef`), font self-host (`d556b4e6`), modul ikon (`public/ac-icons.js`), komponen kosong/memuat/gagal (`5caf1496`), shell sidebar/topbar/tab bawah `#acBottomBar` (`1aa1d55f`), modul motion + Si Mata (port `motion.js`).
- **Fase 3 kelompok 1:** Dashboard, Screener, Analisis, Kelola.

### 7.2 Commit penting di `redesign/v2` (urutan tidak kronologis; lihat `git log --oneline`)
`d556b4e6` font · `63500bef` token+tema · `5caf1496` komponen status · `1aa1d55f` shell · `07a042ed` Kelola dihidupkan · `557ed768` Kelola (bar komposisi, pemilih bulan, titik Jenis) · `891a3000` Screener Urutkan/Kolom · `7c449ced` payload Top 5 · `bb94606a` sparkline IHSG · `4c1abb3f` lencana konsistensi bandar (+endpoint) · `7a5072c2` harga selalu terbaca · `e622980c` kursor & navigasi · `49ab7b41` bar sementara, nama LPM, bintang Watchlist · `ffe7e988` tombol rentang · `040eb564` breadth tidak mengarang angka · `2966803d` `action=tape` + `market_calendar` · `6896a034` timeout quote Fibonacci 5 dtk · `6524769b` merge dari `origin/feat/daytrade-screener-v1` (tanpa konflik) · commit perbaikan performa chart (`:has()` dan layout thrash). Commit Dashboard dan Screener awal ada di log.

### 7.3 Bug nyata yang ditemukan dan diperbaiki (jangan diulang)
- **Angka karangan di Dashboard dibuang:** IHSG fallback "7.500,00", breadth 320/280/209, "1,28 Jt Kali" tertulis keras, "NET BUY ASING" dengan data kosong, "(0.00%)", legenda chart "Corr F 0.72 / Par F 34.2". Dipisah sebagai commit `fix:`.
- **Sparkline IHSG tidak pernah tampil** (juga di produksi): `spark.hidden = false` pada elemen **SVG** hanya mengubah properti JS, atribut `hidden` tetap menempel. Perbaikan: `removeAttribute('hidden')`. **TUGAS: cari pola `.hidden =` pada elemen SVG di tempat lain** di `public/`.
- **Top 5 di Dashboard tampil "—"** karena kode mencari nama field yang salah. Produksi mengirim: Konglo `stock_name`, `group_code`, `change_pct`, `volume_ratio_avg20`; Day Trade `volume_ratio_20d`; Fusion `fusion_rvol`.
- Chart: error "Object is disposed" saat dirender ulang (penjaga generasi render); overlay kerucut IHSG membuat rentang awal kembali ke bawaan (kini memakai rentang awal di registry); warna chart mode terang; kebocoran listener resize.
- **Performa hover chart:** biang keroknya layout thrash (callback rAF menulis DOM sebelum Lightweight Charts membaca ukuran) dan selector `body:has(...)` yang mahal. Perbaikan: penulisan overlay setelah paint; `body:has(#id)` → `body:has(> #id)`/rantai kombinator anak di `ui-theme.css` (makna sama). **Verifikasi bahwa modal login, dialog Gmail, dan toggle sidebar workspace tetap tampil/tutup/scroll-lock di terang dan gelap** (belum dikonfirmasi tertulis).
- Hasil ukur (CPU 4×): hover median ±33 ms, p95 50–67 ms (target ≤ 50 ms: **hampir**); ganti ticker render 181–231 ms (target 190 ms: **di batas**); ganti ticker penuh dengan jaringan lokal 600–850 ms (kadang 1,9–3,3 dtk, dominan jaringan/server). Jangan menghabiskan waktu mengejar p95 lagi; pantau di produksi nanti.

### 7.4 Hasil test
- `npm run test:full` setelah merge: **hanya 3 file gagal**:
  1. `daily-market-context-collector-runtime-bugfix` (gagal sejak baseline Fase 0, di Windows)
  2. `telegram-member-lifecycle` (gagal sejak baseline Fase 0)
  3. `bandarmologi-intel-price-fix` (gagal karena artefak data yang dibuat suite; artefak dipindah ke karantina lalu lolos 5/5)
- `final-audit-uiux-d5` kadang timeout saat suite penuh, tapi lolos 15/15 bila dijalankan sendiri. Untuk commit `ffe7e988` hanya 265 test terkait yang dijalankan.
- PR #910: Vercel gagal ("Account is blocked", **abaikan**, bukan kode); `browser` job GitHub Actions gagal sejak 19 Okt di **semua** branch (assertion Portfolio UI). Status "3 gagal" kemungkinan itu. Periksa di tab Checks.

---

## 8. Selisih piksel dengan desain (belum plek)

**Metode (pakai terus agar angka bisa dibandingkan):** persentase piksel yang berbeda dari seluruh layar, ambang warna **YIQ 0,1**. Acuan 1440 dan 1024 = render kanvas `<Halaman>.dc.html` lewat `python -m http.server` **dengan data contoh yang sama (fixture)** supaya selisih isi hilang. Acuan 390 = `screenshots/<X>_m.png` (terang) dan `screenshots/gelap-390/<X>_M.png` (gelap), karena kanvas desktop tidak menyesuaikan lebar. Angka Analisis diukur setelah chart termuat (tunggu 9 detik). Alat pixel-diff ada di `handoff-redesign/` (cari skrip pixel-diff; keluaran gambar desain | implementasi | selisih di `handoff-redesign/pixel/fx-*`).

| Halaman | 1440 terang | 1440 gelap | 390 terang | 390 gelap |
|---|---|---|---|---|
| Dashboard | 7,89 | 8,98 | 18,50 | 14,46 |
| Screener | 7,47 | 13,08 | 16,31 | 16,02 |
| Analisis | 10,02 | 10,98 | 18,26 | 13,15 |
| Kelola Keuangan | 7,73 | 8,13 | 17,35 | 7,97 |

Semua 24 pengukuran: 0 error konsol, 0 overflow horizontal. **Dengan fixture, angka hampir tidak turun → selisih utamanya tata letak, bukan isi.**

**Tiga area terbesar per halaman:**
| Halaman | Area | Penyebab |
|---|---|---|
| Dashboard | Pita y≈600: kanvas punya Catatan Admin, aplikasi langsung Top 5 | Tata letak (bagian belum ada) |
| Dashboard | Sel Radar dan Sesi bursa | Isi ("3/5 lolos gate" vs "8 lolos gate") |
| Dashboard | 390: bawah layar dan baris chip hero | Tata letak; screenshot acuan memuat Si Mata |
| Screener | Baris tabel turun ±520 px | Tata letak: preset Bandar Metrics, filter Pola, kartu mode lama di atas tabel |
| Screener | Panel detail ikut turun | Tata letak (sama) |
| Screener | Toolbar terpisah dari kartu tabel | Tata letak |
| Analisis | Header kanan: chip ticker, pencarian, bilah lensa | Tata letak |
| Analisis | Chart turun ±100 px | Tata letak: header dan toolbar dua baris, tanpa Catatan Admin |
| Analisis | Harga header 1.430 vs 1.210 | Isi (endpoint header di luar fixture) |
| Kelola | Baris toolbar (urungkan/ulangi, Muat ulang, Fokus lembar) | Tata letak (fitur lama) |
| Kelola | Baris aksi sel dan "Pintasan & rumus" mendorong tabel ±80 px | Tata letak |
| Kelola | Sel tabel: Nominal tanpa "Rp", Catatan rata atas | Tata letak/format |

---

## 9. TUGAS BERIKUTNYA (urut prioritas, dengan kriteria selesai)

### T1. Tutup selisih tata letak halaman kelompok 1 (PERTAMA)
**Masalah:** fitur lama yang tidak ada di desain dipertahankan **di atas** tabel/chart sehingga tampilan pertama berbeda dari kanvas.
**Keputusan (rekomendasi Claude, perlu persetujuan pemilik bila ragu):** **pindahkan, jangan hapus.** Taruh fitur lama di bagian lipat/popover **"Alat lanjutan"** (di bawah atau samping), tertutup secara bawaan. Semua fungsi (preset Bandar Metrics, filter Pola, panduan skor, rincian lengkap, undo/redo, formula, Muat ulang, Fokus lembar, aksi sel, Pintasan, bilah lensa, Layar Penuh) tetap bisa diakses dan **tidak boleh hilang**.
**Kriteria selesai:** pada keadaan awal, posisi vertikal tabel/chart sama dengan kanvas (selisih ≤ ±8 px) di 1440 dan 390, terang dan gelap; angka piksel turun jelas (target < 3% di 1440 untuk Screener, Kelola, Analisis); semua ID dan fungsi lama tetap bekerja (test lama hijau); tabel deviasi diperbarui. Sertakan juga: format "Rp" di kolom Nominal Kelola, Catatan rata tengah/atas sesuai kanvas, header Analisis satu baris sesuai kanvas, ukuran Pilihan bulan 152 px.

### T2. Selesaikan Dashboard supaya plek
Bagian "Radar/Sesi bursa" dan tinggi blok mengikuti kanvas; baris bawah 390; "x/5 lolos gate" memakai data yang benar (jumlah emiten yang dipindai **tidak ada** di payload → tulis seperti sekarang, jangan mengarang "dari 842 emiten"). Catatan Admin muncul bila ada catatan aktif (lihat T3).

### T3. Catatan Admin (fitur baru, spesifikasi §5d)
Backend (tabel `admin_notes`, `admin_note_edits` append-only, `GET /api/admin-notes` publik cache 60 dtk, `POST/PATCH` hanya admin → 403 untuk lainnya; migrasi lewat file migrasi; **tanpa kuota Arjum**), job status (setelah candle EOD + cek intraday dari cache harga live DayTrade), halaman `/catatan-admin`, bagian di Dashboard (maks 3 catatan, sembunyi bila kosong) dan Mobile (2), tombol "Lihat di chart" (`/analisis?t=<TICKER>&catatan=<id>`, pita area pantau + garis Target/Batas via `createPriceLine`, banner di atas chart, rencana sistem disembunyikan). **Jangan deploy.** Tulis daftar perubahan server untuk **ditinjau Roo** lebih dulu. Teks wajib: label "Catatan Admin" (bukan "Rekomendasi") dan disclaimer "pandangan pribadi admin untuk bahan riset, bukan ajakan atau rekomendasi beli atau jual". Kata janji ditolak server: pasti, dijamin, jaminan, wajib beli, harus beli, tanpa risiko, anti rugi, 100%, all in, hajar.

### T4. Sisa fitur §5a Analisis
Layer **Tekanan Broker** dan **Harga rata-rata bandar** (butuh seri broksum harian; **data sedang bolong, tunggu Roo**, tulis keadaan "belum tersedia" yang jujur); kerucut rentang wajar 10 hari di chart saham; bar hari ini dari cache harga live (sisi klien sudah siap: `provisional`, `updatedAt`, `updateBar()`; **endpoint dan job ada di Roo**); `Rentang wajar 10 hari`: hanya Scalping/Swing; ukur dan catat anggaran performa di produksi nanti.

### T5. Kelompok 2: Bandarmologi, Watchlist, Portfolio
Ikuti siklus Fase 3: (1) baca baris halaman di `AUDIT_HALAMAN.md`; (2) terapkan desain, sambungkan ke data **asli**, pertahankan fitur lama (di "Alat lanjutan" bila mendorong tata letak); (3) uji Playwright 1440/1024/390, terang + gelap, 0 error konsol, klik semua kontrol, Tab/Escape, kontras AA, tanpa overflow, keadaan kosong/memuat/gagal dipicu sungguhan, catat waktu muat dan p95 endpoint sebelum dan sesudah; (4) Delivery Gate antislop; (5) commit `redesign(<halaman>): …`; lalu **berhenti dan tunjukkan** tabel deviasi + angka piksel (dengan fixture) + daftar perubahan server untuk Roo.
Catatan Bandarmologi: toggle **Semua · Asing · Domestik** (Domestik = semua − asing per broker, dihitung, "belum lengkap" bila data all terpotong), tanggal akhir pekan ditolak. **Data produksi tanggal 19–23 Okt sedang dikejar Roo**; tampilkan tanggal data asli, jangan angka karangan.

### T6. Sisa auth dan akun
Hapus tombol "Masuk dengan Google" (Auth); pesan gagal login seragam; tab Tampilan di Pusat Akun (Otomatis/Terang/Gelap) + saklar Si Mata; Si Mata tidak muncul di Auth.

### T7. Lanjutkan kelompok 3–7 dan Fase 4
Setelah semua halaman: `handoff-redesign/REPORT_REDESIGN.md` (tabel halaman: status, commit, Delivery Gate, bug dan masalah data yang diperbaiki; kinerja sebelum/sesudah; fitur lama yang dipertahankan; **daftar langkah produksi yang butuh "deploy"** beserta jalur kembali; screenshot sesudah semua halaman 1440 dan 390). Lalu **STOP dan tunggu pemilik menulis "deploy".**

---

## 10. Perubahan sisi server dari redesign (untuk ditinjau Roo, belum dideploy)

| Perubahan | File | Commit |
|---|---|---|
| Breadth tidak mengarang angka (`data_available`, frekuensi dan asing hanya bila ada, tanggal = terbaru lintas ticker) | `lib/market-intelligence-engine.js` | `040eb564` |
| `market_calendar {date, is_trading_day}` di respons market-breadth | `api/sector-hot.js` | `2966803d` |
| `action=tape`: publik, cache 60 dtk, baca store riwayat harian + `IHSG.json`, bukan live | `api/sector-hot.js`, `lib/price-tape.js` | `2966803d` |
| `action=broker-consistency&ticker=X`: publik, ticker `^[A-Z0-9]{2,8}$`, baca arsip broksum di disk maks 20 file, **tanpa Arjum**, cache privat 300 dtk | `api/sector-hot.js`, `lib/broker-consistency.js` | `4c1abb3f` |
| Klien: quote Fibonacci dibatalkan setelah 5 dtk | `public/market-feature-runtime.js` | `6896a034` |

Catatan untuk Roo: `broker-consistency` publik → samakan gerbang dan batas laju dengan Bandarmologi (30 req/menit/IP) dan pastikan tidak membuka data premium; semuanya menyentuh `api/` → butuh satu restart di luar jam bursa; handler `money-management` tidak diubah (catatan `x-user-id` lama sudah diperbaiki Roo di `ba63c6e8`).
Temuan lain untuk Roo dari redesign: CSP Report-Only mencatat **`unpkg.com`** (library chart) sebagai pelanggaran, kalau CSP diberlakukan penuh chart tidak termuat (solusi: self-host library chart atau allowlist); `lib/trusted-proxy.js` mempercayai `CF-Connecting-IP` saat peer proxy lokal sehingga batas laju bisa dilewati bila origin terjangkau tanpa Cloudflare.

---

## 11. Deviasi yang sudah DITERIMA (jangan "diperbaiki" tanpa tanya)

**Dashboard:** chip "Data contoh" tidak ada (label kanvas); "Kredensial AI" tanpa status tebakan; Radar "x/5 lolos gate" (payload tak membawa jumlah emiten yang dipindai); baris bawah Sesi bursa "Sektor terkuat: … (22 dari 41 naik)" (data rotasi tak ada); Top 5 kolom Chg/Vol-Avg/nama/grup "—" **hanya bila memang kosong**; "Skor·risiko + Catatan" tambahan (fitur lama); freshness top bar dari waktu data ("EOD / T-1 · …").
**Screener:** panel detail menempel mulai **1024 px dengan sidebar sempit** (tidak 761 px: tabel ringkas 502 px + panel 360 px = 862 px > 612 px tersedia di 761 px; ukuran terukur dipakai; di bawahnya jadi dialog; di 1100 px sidebar melebar sehingga tetap dialog); R/R minimal tidak tercentang bawaan; ukuran posisi dari pengaturan pengguna (bukan "Rp 100 jt, 1%"); bilah ringkasan sesuai field per mode; urutan hanya urutan tampilan (logika tidak berubah).
**Analisis:** tab bawaan Analisis AI (FIX-22); batas Lightweight Charts 4: tag sumbu bertumpuk memakai `alignLabels` bawaan, tag harga terakhir di luar skala disembunyikan, tag harga satu teks (harga di sumbu, % sebagai judul garis), seret saat skala manual tidak menggeser harga, scroll di sumbu harga tidak mengubah skala (seret sumbu dan tombol tetap ada); label bintang "Dipantau" (status alert tidak dibaca); jendela konsistensi memakai arsip yang ada (maks 20, min 5 hari; tooltip menulis jumlah hari); header memuat pencarian ticker + bilah lensa + Layar Penuh (fitur lama).
**Kelola:** tanpa database lokal ringkasan "—", bar disembunyikan, status simpan jujur ("Gagal dimuat"); toolbar tambahan fitur lama; kartu Portofolio "Belum dimuat" saat tak ada data.
**Umum:** skeleton memakai opacity pulse (bukan animasi background-position); tanpa View Transition; preferensi Si Mata di localStorage (dibungkus try/catch); mobile dibandingkan dengan `Main_m.png`; Top 5 memakai mock lokal (data produksi Top 5 butuh login).

---

## 12. Alur akun/keamanan yang perlu kamu ketahui (dari AUDIT_ALUR.md; sebagian sudah diperbaiki Roo)

Sudah diperbaiki dan dideploy oleh Roo: `/data/*` default tolak (allowlist hanya indeks Bandarmologi `latest_<range>.json`); batas login di aplikasi (5 gagal/15 menit per akun+IP, 30/15 menit per IP, 429); IP klien dari rantai proksi tepercaya (XFF palsu tidak lolos); HSTS `max-age=300` + CSP **Report-Only**; Bandarmologi publik di-cache + 30 req/menit/IP, pengunjung anonim hanya baca disk; header `x-user-id` hanya dengan bendera dev eksplisit.
Masih terbuka (usulan, bukan tugasmu): sesi = token HMAC stateless 10 jam tanpa pencabutan (ganti password tidak membatalkan sesi lain); mode pemeliharaan hanya UI; lifecycle Telegram tidak terjadwal (menunggu keputusan pemilik); tombol Google tampil tetapi produksi menjawab 503 (karena dibatalkan, **hapus tombolnya**).
Untuk halaman Auth: pesan error tidak boleh membocorkan keberadaan akun; tidak ada token di log; ikuti `CEK_MANUAL_PEMILIK.md` untuk uji manual (Gmail ketik manual, persetujuan admin, Telegram).

---

## 13. Cara menyiapkan dan menjalankan di Antigravity

1. Buka folder **`D:\auto-cuan-redesign`** di Antigravity (jangan clone ulang ke `C:`).
2. Di terminal folder itu: `git status` (harus di `redesign/v2`; `.agents/`, `AGENTS.md`, `CLAUDE.md`, `handoff-redesign/` boleh muncul sebagai untracked/diabaikan, **jangan di-add**), `git fetch origin`, `git log --oneline -15`.
3. Baca berurutan: **file ini** → `handoff-redesign/HANDOFF_REDESIGN_V2.md` → `docs/redesign-handoff/RINGKASAN_AKHIR.md` (bila ada) → `AUDIT_HALAMAN.md` → `FASE3_KELOMPOK1.md` → `DESIGN.md` proyek (sumber arah visual repo).
4. Script yang dipakai Claude Code: `npm run test:full` (suite penuh; di Windows ada 2 kegagalan lama + 1 karena artefak), Playwright untuk uji halaman. Cek `package.json` untuk skrip dev server (jangan menebak).
5. Sebelum menyentuh apa pun, jalankan `npm run test:full` sekali dan catat hasil dasar. Jangan kaget bila `bandarmologi-intel-price-fix` gagal karena artefak; pindahkan ke karantina, jangan hapus.
6. Windows: kutip path berspasi, jangan simpan apa pun di `C:`, `npm cache` dan cache lain diarahkan ke `D:` bila bisa.
7. Pantau **batas pemakaian** Antigravity/Gemini; commit sering dan push cadangan `redesign/v2` setiap selesai satu halaman.

---

## 14. CARA MENULIS PROMPT YANG BENAR (untuk Gemini/Antigravity dan agen lain)

**Prinsip:**
1. **Satu tujuan per prompt**, dengan kriteria selesai yang bisa diuji (angka, bukan "bagus").
2. **Sebut file dan sumber kebenaran** (halaman kanvas, bagian spesifikasi) supaya tidak menebak.
3. **Batas keras di awal** (tidak boleh merge/deploy/restart, wilayah Roo, tanpa angka karangan).
4. **Minta bukti**, bukan klaim: perintah yang dijalankan, hasil test, angka piksel sebelum/sesudah, nama commit.
5. **Titik berhenti jelas** ("berhenti setelah 3 halaman, tunjukkan tabel deviasi"). Tanpa titik berhenti agen melaju sampai limit habis.
6. **Format laporan tetap:** selesai · belum · angka · deviasi · perubahan server untuk Roo · langkah berikutnya.
7. **Larang menebak:** "Kalau ragu, tanya. Tulis asumsi di laporan."
8. Jangan tempel kunci, alamat VPS, atau log mentah ke prompt.

### Contoh A: pesan pembuka (orientasi, tanpa mengubah apa pun)
```text
Kamu meneruskan redesign UI Auto-Cuan di folder ini (branch redesign/v2). Sesi sebelumnya dikerjakan Claude Code dan berhenti karena limit.
LANGKAH 1 (hanya membaca, jangan ubah apa pun):
1. Baca docs/redesign-handoff/HANDOFF_ANTIGRAVITY_REDESIGN_UIUX.md sampai habis, lalu handoff-redesign/HANDOFF_REDESIGN_V2.md, AUDIT_HALAMAN.md, FASE3_KELOMPOK1.md.
2. Jalankan: git status, git fetch origin, git log --oneline -15, lalu npm run test:full dan catat hasil dasarnya (3 kegagalan sudah diketahui).
3. Tulis ringkasan 10 baris: kondisi branch, halaman yang sudah selesai, selisih piksel terakhir, dan tugas berikutnya menurut dokumen.
ATURAN KERAS: jangan merge, jangan klik "Tandai siap" pada PR #910, jangan deploy/restart/ubah crontab/.env, jangan sentuh tools/backfill-*, tools/run-daily-*, lib/arjum-*, lib/broksum-*, lib/trusted-proxy.js, jangan angka karangan (kosong = "—"), jangan menempel kunci/alamat VPS/log mentah. Kalau ragu, tanya.
Berhenti setelah ringkasan dan tunggu perintah saya.
```

### Contoh B: T1 tutup selisih tata letak Screener
```text
TUGAS: tutup selisih tata letak halaman Screener terhadap desain handoff-redesign/design/project/Screener.dc.html.
KONDISI SEKARANG: tabel turun ±520 px dari desain di 1440 px (selisih piksel 7,47% terang / 13,08% gelap) karena preset Bandar Metrics, filter Pola, dan kartu mode lama diletakkan di atas tabel.
YANG DIMINTA:
1. Pindahkan fitur lama itu ke bagian lipat "Alat lanjutan" (tertutup bawaan) tanpa menghapus fungsi apa pun dan tanpa mengubah ID/logika. Tampilan pertama harus sama dengan kanvas: header, segmen mode, bilah ringkasan, toolbar+tabel, panel detail.
2. Ukur ulang selisih piksel (metode: persen piksel beda, ambang YIQ 0,1, render kanvas dengan data contoh yang sama; 1440 dan 390, terang dan gelap).
KRITERIA SELESAI: posisi vertikal tabel selisih ≤ 8 px dari kanvas; selisih 1440 < 3%; test lama hijau; 0 error konsol; tanpa overflow horizontal di 390; Tab/Escape tetap bekerja; semua fitur lama masih bisa dijangkau lewat "Alat lanjutan".
BATAS: hanya file UI (public/ dan CSS); jangan ubah skor, gate, atau logika screener; satu commit "redesign(screener): tutup selisih tata letak".
LAPORAN: tabel sebelum/sesudah piksel, daftar fitur lama dan lokasinya yang baru, deviasi yang tersisa, hasil test. BERHENTI setelah Screener, jangan lanjut ke halaman lain.
```

### Contoh C: kelompok halaman berikutnya
```text
TUGAS: kerjakan kelompok 2: Bandarmologi, Watchlist, Portfolio, satu per satu, sesuai siklus Fase 3 di handoff-redesign/PROMPT_CLAUDE_CODE_REDESIGN.md dan dokumen serah terima.
Per halaman: (1) baca barisnya di AUDIT_HALAMAN.md dan perbaiki bug/masalah data UI; (2) terapkan desain dari <Halaman>.dc.html dan sambungkan ke data asli; fitur lama yang tidak ada di kanvas masuk "Alat lanjutan"; (3) uji 1440/1024/390 terang+gelap: 0 error konsol, klik semua kontrol, Tab/Escape, kontras AA, tanpa overflow, keadaan kosong/memuat/gagal dipicu sungguhan, selisih piksel dengan data contoh yang sama; (4) Delivery Gate antislop; (5) satu commit per halaman.
PENTING: data produksi 19–23 Okt masih dikejar tim data; tampilkan tanggal data asli, jangan angka karangan. Jangan menyentuh pipeline. Perubahan server yang dibutuhkan: tulis daftarnya, jangan deploy.
BERHENTI setelah ketiga halaman. Laporan: selesai, belum, tabel deviasi, tabel piksel, perubahan server untuk Roo, 3 langkah berikutnya.
```

### Contoh D: perbaikan bug kecil dengan bukti
```text
TUGAS: cari semua tempat di public/ yang memakai pola "<elemen SVG>.hidden = true/false" (bug sama dengan sparkline IHSG: pada SVG, properti hidden bukan atribut). Daftar file:baris, perbaiki dengan setAttribute/removeAttribute('hidden'), tambah test yang gagal sebelum perbaikan dan lolos sesudahnya, satu commit "fix(ui): ...". Jangan ubah perilaku lain. Laporkan: daftar tempat, test sebelum/sesudah, dan halaman yang terdampak di produksi.
```

---

## 15. Jebakan dan pelajaran (supaya tidak mengulang)

1. **Desain ≠ produksi:** angka kanvas adalah contoh. Jangan menyalin angka, tanggal, atau nama.
2. **Fitur lama menang atas kanvas dalam hal fungsi, tapi kanvas menang dalam hal tata letak awal.** Karena itu "Alat lanjutan".
3. **Atribut `hidden` pada SVG** tidak sama dengan properti JS.
4. **`body:has(...)` mahal;** gunakan kombinator anak untuk target anak langsung `body`.
5. **Layout thrash:** tulis DOM setelah paint frame, jangan sebelum pustaka chart membaca ukuran.
6. **Ukuran panel menempel Screener harus diukur,** jangan menyalin angka 761 px.
7. **Pengukuran headless berisik** (terkuantisasi per 16,7 ms): laporkan rentang, bukan satu angka.
8. **Mock lokal ≠ payload produksi.** Cek nama field dari kode endpoint (kasus Top 5).
9. **Test lama yang mengunci markup pra-redesign** perlu diperbarui ke kontrak baru, tanpa melonggarkan cek perilaku (perbandingan baseline geometri dilewati khusus Dashboard).
10. **Merge dari Roo bisa mengubah CSP/keamanan** (contoh `lib/trusted-proxy.js` ikut masuk); jangan ubah kode keamanan, laporkan.
11. **Limit pemakaian alat habis cepat:** commit sering, tulis ringkasan akhir sebelum limit, jangan mengejar optimasi kecil.
12. **Jangan hapus file apa pun,** pindahkan ke karantina.

---

## 16. Daftar periksa sebelum "deploy" (kapan PR #910 boleh dimerge)

- [ ] Semua 23 halaman selesai dan selisih piksel dapat diterima pemilik (tabel deviasi disetujui).
- [ ] Catatan Admin: backend ditinjau dan disetujui Roo, tes admin 403 untuk non-admin lolos.
- [ ] Perubahan server (Bagian 10) ditinjau Roo; satu rencana restart di luar jam bursa.
- [ ] `npm run test:full` hijau kecuali kegagalan lama yang diketahui; CI `browser` job diperbaiki atau dijelaskan.
- [ ] Self-host library chart atau CSP allowlist `unpkg.com` (Roo).
- [ ] Data produksi 19–23 Okt sudah terkejar (Roo) supaya halaman data tidak tampil kosong.
- [ ] Uji manual pemilik (`CEK_MANUAL_PEMILIK.md`: Gmail ketik manual, persetujuan admin, Telegram).
- [ ] Pemilik menulis **"deploy"**. Urutan: PR siap → merge ke `feat/daytrade-screener-v1` → Roo `git pull --ff-only` di VPS → restart sekali (sebelum 08:45 atau setelah 16:15 WIB) → cek kesehatan 200 → pantau; siapkan jalur kembali (`git revert` commit merge + restart).

---

## 17. Glosarium singkat
- **J1/J2/IHSG:** job harian pengambil data (J1 broker summary + akumulasi + insider; J2 candle 962 saham; IHSG 1 request). Wilayah Roo.
- **Arjum:** penyedia data (tidak boleh tampil di UI). **Yahoo:** sumber candle utama + harga live via cache server.
- **ALL / F / D:** broker summary semua / asing (flow=F) / domestik (dihitung = ALL − F).
- **LPM:** "kurva tekanan candle · Money Flow" (dari candle).
- **EOD / T-1:** data akhir hari / satu hari bursa sebelumnya.
- **FIX-22, D3:** nomor keputusan internal sebelumnya (FIX-22: tab bawaan Analisis AI; D3: kontrak keyboard panel detail Screener).
- **Si Mata:** maskot mata yang mengikuti kursor, suasananya mengikuti perubahan IHSG, tanpa janji untung.
- **Delivery Gate:** laporan PASS/FAIL antislop di akhir tiap pengiriman halaman.
- **Karantina:** folder `_quarantine-*`/`karantina/` tempat file yang salah dipindah (tidak pernah dihapus).

---

## 18. Catatan motion dan interaksi dari pemilik (17 Okt, **dipertahankan**)
- Website interaktif dan penuh motion, tidak kaku, di **semua halaman**; **Landing paling interaktif**: hero mengikuti pointer (parallax ringan), section muncul saat scroll (IntersectionObserver + CSS) dengan angka menghitung naik, demo screener mini yang bisa dicoba, preview chart yang bisa di-hover, maskot menyapa di hero.
- Aplikasi: transisi halaman (View Transitions; sidebar/bilah atas/tab bawah diam), skeleton yang hidup, baris tabel masuk bergiliran, hover responsif, angka harga "berdetak" saat berubah, toast dengan spring, drag/slider di kalkulator.
- **Si Mata:** SVG kecil (< 6 KB) tanpa library; pupil mengikuti kursor lewat `pointermove` + rAF hanya mengubah `transform`; berkedip acak tiap 3–7 detik; klik memunculkan kalimat acak (tips, status pasar, candaan ringan, kontekstual seperti "Bursa tutup, istirahat dulu", "Data terakhir 16.00 WIB", "Cek rentang wajar sebelum pasang TP") **tanpa janji untung**; mati saat tab tidak aktif dan reduced-motion; bisa dimatikan di Pusat Akun; **tidak muncul** di mode fokus Chart Workstation dan di Auth.
- Batas performa: hanya `transform`/`opacity`; tanpa blur pada banyak elemen; maksimal satu animasi tanpa henti per layar; mati saat reduced-motion; INP < 200 ms di semua halaman.
