# Serah-terima desain: Auto-Cuan Redesign v2

> Versi kanvas: **v87** (18 Okt 2026). Sumber visual: folder `design/` di paket ini, ditambah `screenshots/` (desktop 1440 dan ponsel 390).
> Dokumen ini adalah **spesifikasi**. Angka di dalam desain adalah **data contoh** dan tidak boleh disalin ke produk.

---

## 1. Arah desain

| | |
|---|---|
| Karakter | Meja kerja riset yang tenang. Latar netral hangat, satu hijau brand, angka tabular |
| Pengguna | Trader ritel IDX yang membaca angka berjam-jam |
| Dial antislop | Landing: ENERGY 2 · RHYTHM 3 · MOTION 3. Aplikasi: ENERGY 1 · RHYTHM 2 · MOTION 2 |
| Motif identitas | Candle (latar hero, pita fitur, logo) dan penomoran 01–07 di landing |
| Tema | Terang dan gelap. Bawaan ikut sistem perangkat (Otomatis) |

## 2. Keputusan yang sudah final (4 item antislop)

1. **Data kosong ditulis "—"**, karena itu simbol data, bukan tanda baca.
   - Render sebagai `<span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">—</span>`.
   - Data kosong **tidak pernah** ditulis 0.
   - Di kalimat UI tetap tidak boleh ada em dash.
2. **Ikon memakai set sendiri, bukan library ikon.**
   - Ambil SVG inline dari kanvas (sidebar, tab bawah, tombol), lalu jadikan satu modul `icons.js` / komponen `Icon`.
   - Garis 1,7px, ujung bulat. Dipilih supaya selaras dengan garis chart.
   - Jangan `npm install lucide`.
3. **Huruf: Plus Jakarta Sans** untuk teks UI, dan **Geist Mono** untuk ticker, harga, dan lot.
   - Plus Jakarta Sans dibuat untuk identitas kota Jakarta, punya angka tabular (`tnum`), dan bukan huruf default AI.
   - Geist Mono membuat ticker dan angka gampang dibedakan.
   - Font di-*self-host* (woff2 di repo) dengan `font-display: swap` dan `preload` untuk berat 400/600. Jangan bergantung pada Google Fonts saat runtime.
4. **Si Mata (maskot) tetap berkedip**, karena permintaan pemilik produk. Aturannya:
   - Berhenti saat tab tidak aktif dan saat `prefers-reduced-motion`.
   - Bisa disembunyikan, dan pilihan itu disimpan.
   - **Tidak muncul** di halaman Auth (Masuk, Daftar, Pemulihan, Lengkapi identitas), supaya fokus ke form dan karena nama pengguna belum diketahui.

## 3. Token (dari `design/project/ac.css`)

Warna, radius, bayangan, dan easing diambil **apa adanya** dari blok `:root` di `ac.css`.

Yang wajib dipertahankan:
- `--ac-neg:#AD3F52` dan `--ac-warn-t:#8A590D`. Keduanya sudah digelapkan supaya lolos kontras AA.
- Merah dan hijau **hanya** untuk arah harga atau nilai.
- Hijau brand hanya untuk CTA, nav aktif, dan level harga.
- Shadow hanya untuk lapisan melayang: maskot, lembar bawah, dialog, dan drawer.

Kalau repo sudah punya `docs/DESIGN-SYSTEM.md` dan `public/ui-theme.css`, petakan token kanvas ke token yang ada. **Jangan** membuat sistem token kedua.

## 3a. Mode gelap

**Cara memilih mode:**
- Pilihan **Otomatis** (ikut `prefers-color-scheme`), **Terang**, dan **Gelap** ada di Pusat Akun → Profil → Tampilan.
- Tombol bulan/matahari di bilah atas setiap halaman aplikasi, Landing, Ketentuan, dan header HP mengganti terang/gelap secara langsung.
- Pilihan disimpan per pengguna. Di kanvas disimpan di `localStorage['ac-theme']`; di produk sebaiknya disimpan juga di akun.

**Cara kerja:**
- `<html data-theme="light|dark">` (tanpa atribut = otomatis) dan kelas `is-dark`.
- Pasang lewat skrip kecil **di `<head>` sebelum CSS dirender**, supaya tidak ada kedip terang.

**Token:**
- Semua warna lewat token di `ac.css`. Blok gelap ada di `:root[data-theme="dark"]` dan `@media (prefers-color-scheme:dark)`.
- Token baru `--ac-inv` dipakai untuk permukaan gelap terbalik: chip aktif, toast, tombol segmen aktif.

**Aturan mode gelap:**
- Tombol utama memakai teks gelap di atas hijau terang.
- Warna indikator chart diterangkan dengan pemetaan yang sama untuk garis dan label (lihat `DKM` di Analisis dan blok "warna garis indikator" di `ac.css`).
- Simpul graf Insider memakai isian gelap.
- Kontras AA sudah dicek otomatis di kedua mode: 0 teks gagal di 27 halaman.

**Jangan menulis warna hex langsung** untuk teks, latar, atau garis netral. Pakai token.

## 4. Shell aplikasi

**Desktop lebar (≥ 1100px):**
- Sidebar 240px **diam**. Hanya area konten yang di-scroll (`.app{height:100dvh;overflow:hidden}`, `.main{overflow-y:auto}`).
- Sidebar bisa diciutkan ke 68px (ikon saja).

**Laptop kecil / jendela sempit (761–1099px):**
- Tetap tampilan desktop, bukan tampilan ponsel.
- Sidebar otomatis jadi rel ikon 68px dengan tooltip nama menu. Tombol di logo membuka sidebar penuh.
- Grup menu: **Dashboard · Temukan (Screener, Sektor Hot) · Riset (Analisis & Chart, Bandarmologi, Sinyal Intelijen, Broker Hunter, Insider, Ranking, Financial, Struktur Pasar) · Pantau (Watchlist, Portfolio, Track Record, Kelola Keuangan) · Admin (Pattern Radar, Admin Console)**.
- Grup Admin hanya dirender untuk admin, **di server/route**, bukan cuma disembunyikan dengan CSS.

**Ponsel (≤ 760px):**
- Sidebar menjadi bilah atas ringkas: logo dan tombol **Menu**.
- Menu membuka daftar lengkap layar penuh. Menu tertutup dengan Escape atau setelah memilih halaman.
- Ada **tab bawah 4 item**: Dashboard, Screener, Watchlist, Lainnya.
- Bilah pencarian dan status kesegaran ikut ter-scroll.

**Bilah atas halaman:** pencarian (⌘K) dan **status kesegaran data**, misalnya "EOD / T-1 · 16 Okt 2026, 16.00 WIB". Status ini **wajib** diambil dari waktu data, bukan jam dinding.

### 4a. Strip harga saham (di bawah bilah atas)

Strip ini tampil di **semua halaman aplikasi** dan di Dashboard HP.

**Isi:**
- IHSG di posisi paling kiri.
- Saham **likuid** (nilai transaksi hari ini ≥ Rp 5 M) yang **naik**, diurutkan dari kenaikan terbesar. Maksimal 30 saham.
- Kalau saham hijau kurang dari 8, tambahkan saham paling likuid lainnya.
- Tidak ada label rekomendasi.

**Sumber data:**
- Cache harga live server, yang juga dipakai DayTrade.
- Satu endpoint ringan (`/api/tape`), di-cache 60 detik.
- Pengunjung **tidak** memanggil Yahoo langsung.
- Di luar jam bursa, tampilkan harga penutupan terakhir dengan label "penutupan <tanggal>".

**Gerak:**
- Bergeser horizontal memakai `transform`, sekitar 45 px per detik.
- Berhenti saat kursor di atasnya atau saat fokus keyboard.
- Ada **tombol jeda** (WCAG 2.2.2). Pilihannya diingat per pengguna.
- `prefers-reduced-motion`: strip diam, tapi bisa digeser manual.

**Interaksi:** klik item membuka Analisis untuk ticker itu.

**Kinerja:** saat diam, halaman tidak boleh menggambar ulang (sudah diuji di kanvas: 0 paint dalam 3 detik).

## 5. Perilaku per halaman

| Halaman | Isi utama | Interaksi wajib | Data asli (cek di VPS) |
|---|---|---|---|
| Landing | Hero "Baca pasar…", spotlight candle BRPT, pratinjau Dashboard/Screener/Bandarmologi, kalkulator, bagian 01–07 | Candle muncul di sekitar kursor; segmen pratinjau; pita fitur berhenti saat hover/fokus; maskot menyapa | Candle Arjum untuk hero; angka strip harus bersumber |
| Masuk, Daftar, Pemulihan, Lengkapi Gmail | Form | Validasi per kolom; OTP auto-advance; tidak ada data terisi | Auth, Telegram verifikasi, persetujuan admin |
| Dashboard | Kondisi pasar, Top 5 Radar (klik baris menampilkan rencana), karantina, riwayat Top 5 | Baris membuka rencana; tab Aktif/Riwayat | Top 5 engine, IHSG, breadth, sesi bursa |
| Screener | 3 mode (Konglo, Non-Konglo, Day Trade), tabel dan panel detail (rencana trading, ukuran posisi, bukti gate) | Filter status; R/R ≥ 1,5; urutkan; kolom ringkas/lengkap; Cetak/PDF; bintang watchlist. Panel detail terbuka di layar < 1600px menyembunyikan kolom Setup | `data/screener-latest.json`, candle harian, broksum |
| Sektor Hot | Klasemen grup dan heatmap | Klik grup untuk melihat konstituen | `data/sector-hot-*.json` |
| Analisis & Chart | Header ticker, kalkulator rencana, chart workstation (mode Simpel sampai Pro), panel layer 9 grup, Analisis AI. Detail chart di §5a | Preset mode; TF 1D/1W; rentang; layer RSI, MACD, Fibonacci, MA, VMA, Tekanan Broker, harga rata-rata bandar, konsistensi; crosshair | Candle 500 sesi, broksum harian, broksum asing (F) |
| Bandarmologi | Ringkasan aliran dan pembeli/penjual terbesar, **toggle Semua · Asing · Domestik**, tab Akumulasi | Tanggal (akhir pekan ditolak); hitung ulang; urut periode akumulasi | Broksum `all_data`, `broker-summary-F/`, domestik = semua − asing per broker, akumulasi lokal |
| Sinyal Intelijen | Papan bukti 4 pilar dan bukti dasar | Tab Papan bukti/Scanner | Asing, broker, KSEI, candle |
| Broker Hunter | Daftar broker, lalu saham yang sedang dikoleksi/dilepas | Rentang 1 hari/3 hari/1 minggu/1 bulan; drill-down ke Bandarmologi | Broksum agregat per broker |
| Insider | Graf relasi pengendali dan tabel pemegang saham | Klik simpul untuk sorotan; reset | KSEI, insider |
| Ranking | Tabel harian dan preset | Klik judul kolom untuk urut; CSV | Candle, asing |
| Financial | Snapshot valuasi dan laporan per periode | Tab Laba Rugi/Neraca/Arus Kas/Rasio; kuartalan/tahunan; Δ YoY; tampilkan pos kosong; CSV | `stock_fundamentals`, financial-statements |
| Struktur Pasar | Free Float, HSC, status | Filter chip; urut; detail emiten | KSEI dan keterbukaan IDX |
| Pattern Radar (admin) | Pindai pola | Pola, ambang kemiripan, jalankan pindai | Candle |
| Watchlist | Daftar pantau dan alert | Filter; hapus dengan opsi urungkan; riwayat alert | Watchlist pengguna, harga |
| Portfolio | Hari ini, rencana posisi, posisi aktif, Risk Lab, skenario, jurnal, Asisten AI | Simpan dan ubah rencana | Data portofolio pengguna, harga tersimpan |
| Track Record | Statistik sinyal dan tabel | Filter status | Track record service |
| Kelola Keuangan | Anggaran bulanan seperti spreadsheet | Bulan (dengan keadaan kosong); tambah/hapus baris; urutkan; CSV; catatan | Data pengguna |
| Pusat Akun | Profil, keamanan, preferensi, AI, langganan | Ganti password; tier AI | Akun |
| Admin Console | Ringkasan (pengguna, persetujuan, **kuota Arjum**, status), kesegaran dataset, persetujuan, pengguna, maintenance, voucher, job & data, log audit | Konfirmasi ketik ulang untuk aksi berbahaya; semua aksi masuk log | Status job **asli** dari log VPS |
| Ketentuan | 12 ketentuan dan 8 batasan risiko | Anchor | Teks statis |
| Mobile (Dashboard, Screener) | Versi saku dengan tab bawah | Lembar "Lainnya"; filter; bintang | Sama dengan desktop |

## 5a. Chart (Analisis & Chart)

Pakai Lightweight Charts yang sudah ada di repo (`public/chart-viewer.js`). Perilaku yang wajib ada:

**Harga selalu terbaca:**
- Sumbu harga kanan dengan langkah "rapi" sesuai fraksi harga IDX (1/2/5/10/25).
- Tag harga terakhir berwarna (naik hijau, turun merah) berisi harga dan % perubahan, plus garis putus-putus selebar chart.
- Tag di sumbu tidak boleh bertumpuk. Urutannya: harga terakhir tetap di tempat, tag lain didorong ke atas atau bawah.
- Label tertinggi ▲ dan terendah ▼ di rentang yang tampil.
- Legenda O/H/L/C/Vol dan nilai MA di kiri atas selalu terisi: candle terakhir, atau candle di bawah kursor.

**Kursor:**
- Crosshair dengan tag harga **di posisi kursor** (bukan harga close) dan tag tanggal di sumbu bawah.
- Kotak info di dekat kursor: tanggal, buka, tertinggi, terendah, tutup, perubahan %, volume. Kotak pindah sisi kalau dekat tepi.

**Navigasi:**
- Zoom: scroll di mode satu layar, Ctrl/⌘ + scroll (atau pinch) di mode biasa, supaya scroll halaman tidak dibajak.
- Geser: seret chart. Klik dua kali untuk kembali ke candle terbaru.
- Rentang default **6 bulan**.
- **Skala harga (zoom vertikal):** untuk melihat angka lebih rapat, misalnya 2.000 → 2.050 → 2.100.
  - Cara pakai:
    - seret sumbu harga ke atas untuk memperbesar, ke bawah untuk memperkecil;
    - scroll di atas sumbu harga;
    - tombol − / + / Auto di pojok kanan atas panel harga.
  - Zoom **menahan posisi harga terakhir** di layar.
  - Saat skala manual, seret chart juga menggeser harga ke atas atau bawah.
  - Klik dua kali sumbu harga atau tombol Auto untuk kembali ke skala otomatis.
  - Ganti ticker atau timeframe mengembalikan skala ke Auto.
  - Langkah angka di sumbu mengikuti fraksi harga IDX dan otomatis makin rapat saat diperbesar.
  - Label dan tag yang berada di luar area harga disembunyikan. Pengecualiannya tag harga terakhir: tag ini menempel di tepi atas atau bawah.
  - Di Lightweight Charts, pakai `priceScale().applyOptions({autoScale})`, plus drag dan scroll bawaan sumbu harga. Tetap pertahankan tombol − / + / Auto dan perilaku yang sama.

**Rencana per horizon (wajib terpisah):**
- Kalkulator punya pilihan **Rencana untuk: Scalping · Swing · Investor**. Setiap horizon punya entry, SL, TP1, TP2, area entry, dan aturan batal sendiri. Level Scalping dan Swing **tidak boleh sama**.
- Mode chart memilih horizon otomatis:

  | Mode | Horizon | Rentang awal |
  |---|---|---|
  | Simpel | Swing | 6 bulan |
  | Scalping | Scalping | 3 bulan |
  | Swing | Swing | 6 bulan |
  | Investor | Investor | 1 tahun |
  | Pro | tetap yang terakhir dipilih | 6 bulan |

  Pengguna tetap bisa mengganti horizon secara manual.
- **Sumber level di produk:**
  - Scalping dari engine Day Trade.
  - Swing dari engine Swing (Konglo/Non-Konglo).
  - Investor: belum ada engine, jadi tampilkan keadaan kosong "Belum ada rencana Investor dari server". Level **tidak boleh** dihitung di browser.
  - Angka di kanvas untuk Scalping dan Investor hanya contoh yang dihitung dari ATR.
- **Cek rentang wajar 10 hari** hanya untuk Scalping dan Swing. Untuk Investor tampil "Tidak dipakai".
- **LPM** tampil dengan nama "LPM · kurva tekanan candle · Money Flow". Hitungannya dari candle.
  - Komponen asing (foreign flow) **belum** digabung. Penggabungannya menunggu hasil `PROMPT_SIMULASI_FOREIGN_LPM.md`, dan baru dilakukan kalau lolos uji out-of-sample.
  - Kalau tidak lolos, data asing tampil sebagai alat baca, tanpa label sinyal.
- **Lencana konsistensi bandar** di kanan atas chart berisi: kode broker pembeli bersih terbesar 20 hari, jumlah hari net buy dari 10 hari terakhir dengan bar, dan berapa hari beruntun.

**IHSG / COMPOSITE (dan indeks lain): tanpa entry, SL, TP**

Indeks tidak bisa dibeli langsung, jadi chart indeks **tidak boleh** menampilkan:
- entry, SL, TP;
- area entry;
- kalkulator lot;
- layer bandar (broker summary);
- sinyal S1.

Di layer itu tampil keterangan "Khusus saham" / "Tidak ada broker summary untuk indeks". Sebagai gantinya ada panel **Potensi arah**:
- **Horizon: Harian (1–5 hari) · Mingguan (2–4 minggu) · Bulanan (1–3 bulan).** Mode chart memilih horizon sama seperti saham: Scalping → Harian, Swing/Simpel → Mingguan, Investor → Bulanan.
- **Bias:** Cenderung naik / Cenderung turun / Mendatar. Dihitung dari posisi harga terhadap rata-rata bergerak, sesuai horizon:

  | Horizon | Yang dibandingkan |
  |---|---|
  | Harian | close vs MA20, kemiringan MA20 |
  | Mingguan | close vs MA50, MA20 vs MA50, kemiringan MA50 |
  | Bulanan | close vs MA200, MA50 vs MA200 |

  Alasannya ditulis di bawah bias, ditambah RSI14 (jenuh jual/beli).
- **Skenario naik** ke R1 (R2 bila R1 tembus) dan **skenario turun** ke S1 (S2 bila S1 jebol). Level diambil dari pivot 66/126/250 sesi sesuai horizon. Skenario yang searah bias diberi label "UTAMA". Kalau tidak ada level, pakai batas rentang (p90/p10). Kalau target di luar rentang, tulis "di luar rentang, butuh waktu lebih lama".
- **Rentang kemungkinan:** close × e^(±1,2816 × σ60 × √hari), dengan hari = 5/20/60 (sekitar 8 dari 10 kemungkinan). Rentang ini dihitung dari volatilitas, **bukan** prediksi arah.
- **Bias berubah bila:** level yang membatalkan bias.

**Tampilan di chart:**
- area biru (kerucut) rentang kemungkinan ke kanan candle terakhir;
- dua panah skenario: yang utama tebal dan solid, yang lain putus-putus;
- tag ▲/▼ target di sumbu harga;
- R1/R2/S1/S2 di kiri.

**Aturan lain:**
- Harga ditampilkan tanpa "Rp".
- Tautan header: Struktur Pasar dan Sektor Hot (bukan Bandarmologi/Financial).
- Pertanyaan AI "Entry di mana?" diganti "Ke mana arahnya?".
- Salinan wajib memuat: "Ini gambaran arah pasar, bukan sinyal beli atau jual."
- Di produk, candle IHSG diambil dari data indeks asli. **Seri IHSG di kanvas adalah data contoh.**

**Performa chart (wajib, ini yang membuat chart tidak lag):**

| Ukuran | Sebelum | Sesudah |
|---|---|---|
| Elemen chart | 1.076 | 88 |
| Frame hover, tengah / terburuk 5% (CPU 4×, laptop) | 83 / 283 ms | 16,7 / ≤50 ms |
| Frame hover di HP | | 60 fps |
| Ganti ticker | 390 ms | 190 ms |

Aturan:
- **Crosshair, tooltip, label harga/tanggal kursor, dan legenda OHLC saat hover** tidak boleh memicu render ulang komponen. Di Lightweight Charts, pakai `subscribeCrosshairMove`, lalu perbarui DOM tooltip/legenda secara langsung, dibatasi satu kali per `requestAnimationFrame`.
- **Data:** `setData` hanya saat ticker atau timeframe berganti. Bar hari ini diperbarui dengan `series.update()`.
- **Indikator** dihitung sekali per ticker + timeframe (memo, atau Web Worker untuk yang berat), bukan di setiap render.
- **Tidak ada pembacaan posisi elemen di handler gerak.** Posisi chart di-cache dan diperbarui hanya saat resize atau scroll.
- **Gestur desktop:**
  - seret = geser waktu;
  - Ctrl/⌘ + scroll (atau scroll di mode satu layar) = zoom waktu;
  - seret atau scroll di sumbu harga = skala harga;
  - klik dua kali = kembali.
- **Gestur sentuh:**
  - geser satu jari horizontal = geser waktu; geser vertikal = scroll halaman (`touch-action: pan-y`);
  - **cubit = zoom waktu**;
  - **ketuk = crosshair menempel**;
  - **tahan 300 ms lalu geser = menggeser crosshair**;
  - ketuk di luar chart = tutup.
- Opsi Lightweight Charts yang setara:
  - `kineticScroll: {touch: true}`;
  - `trackingMode: {exitMode: TrackingModeExitMode.OnNextTap}`;
  - `handleScale: {pinch: true, axisPressedMouseMove: {time: true, price: true}}`.

**Bar hari ini selama jam bursa:**
- Bar ini dirakit dari cache harga live server (satu proses yang mengambil banyak saham per request, diperbarui setiap 1–2 menit). Pengunjung tidak memanggil sumber harga langsung.
- Tampilkan label kecil "sementara · diperbarui hh:mm". Setelah job sore selesai, bar ini diganti bar final.
- Screener Swing hanya memakai bar final.

**Mode "Satu layar":**
- Dibuka dengan tombol "Satu layar" atau tombol F, ditutup dengan Esc.
- Chart memenuhi layar dengan tinggi pas, tanpa scroll halaman.
- Panel harga minimal 58% tinggi. Panel indikator mengecil secara proporsional.
- Header ringkas (ticker, harga, perubahan) dan toolbar tetap terlihat. Maskot dan tab bawah disembunyikan.

**Teks tajam:** ukuran teks chart tidak boleh ikut mengecil saat layar sempit. Chart digambar sesuai lebar piksel asli.

**Ponsel:** label tag diringkas (T1, T2, En, Bd), dan teks konsistensi bandar disembunyikan.

**Timeframe dan navigasi:**
- Label tanggal di sumbu bawah menampilkan tahun setiap kali tahun berganti.
- Ganti ticker, timeframe, atau rentang selalu mereset geseran ke candle terbaru.
- Mode Scalping memaksa timeframe 1D.
- Semua garis indikator di panel harga dipotong (clip) di dalam area harga, supaya tidak menabrak legenda atau panel bawah. Ini paling terlihat di 1W rentang pendek.

## 5b. Admin Console · tab Online (siapa yang sedang akses)

**Isi halaman:**
- Ringkasan:
  - online sekarang (detak sesi kurang dari 2 menit);
  - aktif 15 menit terakhir;
  - masuk hari ini (sejak 00.00 WIB);
  - tidak aktif lebih dari 7 hari.
- Tabel:
  - kolom: pengguna, status (Online / Aktif X menit lalu / Terakhir X lalu), halaman yang sedang dibuka, perangkat (browser · OS), lama sesi, masuk terakhir;
  - filter: Semua / Online / Hari ini / Tidak aktif > 7 hari;
  - pencarian.
- Pembaruan otomatis tiap 30 detik.
- Di Ringkasan ada tautan "N online sekarang" yang membuka tab ini.

**Cara kerja di produk:**
- Browser mengirim *heartbeat* tiap 60 detik selama tab terlihat (pakai `visibilitychange`, bukan saat tab di belakang). Isinya: user id, halaman, dan perangkat dari user-agent yang sudah diringkas.
- Server menyimpan `last_seen`, `last_page`, `session_start`, dan `device`.
- Status online = `last_seen` kurang dari 2 menit lalu.
- Endpoint daftar online **hanya untuk admin**, dicek di server.
- **Alamat IP tidak ditampilkan.**
- Riwayat aktivitas dihapus otomatis setelah 30 hari.
- Heartbeat tidak boleh memakai kuota API data.

## 5c. Teks di dalam gambar SVG

Teks yang isinya berubah (harga, label simpul, label kuartal) **tidak** ditulis sebagai `<text>` SVG di kanvas. Teks itu ditaruh sebagai HTML di atas SVG.

Di repo, pakai cara yang konsisten:
- Lightweight Charts untuk chart harga.
- Label HTML berposisi persen di atas SVG, untuk graf Insider dan bar Financial. Ukuran hurufnya memakai `cqi`, supaya tetap terbaca di HP.

## 6. Keadaan non-normal (wajib di setiap halaman data)

- Kanvas punya **"Pratinjau status"** (Normal/Kosong/Memuat/Gagal). Itu **alat review desain saja**, jangan ikut dibangun.
- Yang dibangun: keadaan **kosong**, **memuat**, dan **gagal** yang asli untuk setiap halaman. Teksnya pakai salinan di `motion.js` → objek `ST`. Isinya penyebab, langkah berikutnya, dan "Coba lagi".
- **Gagal tidak boleh menebak angka.** Tampilkan data terakhir yang tersimpan beserta cap waktunya.

## 7. Motion

Aturan:
- Hanya `transform` dan `opacity`, satu listener pointer, dan satu `requestAnimationFrame`.
- Maksimal satu animasi tanpa henti per layar.
- Mati total saat `prefers-reduced-motion`.

Yang dipakai:
- Kartu masuk bergiliran (`rise d0…d5`).
- Tombol utama sedikit tertarik ke kursor (magnet).
- Ripple saat ditekan.
- Angka berkedip hijau/merah saat berubah.
- Indikator segmen bergeser.
- Pindah halaman: View Transition singkat (keluar 110 ms, masuk 200 ms). Sidebar, bilah atas, dan tab bawah **diam**, hanya isi yang berganti.
- Prefetch halaman tujuan saat kursor berada di atas tautan menu.

**Dilarang (penyebab lag yang ditemukan di kanvas):**
- Efek yang mengikuti kursor dengan mengubah variabel CSS atau background pada wadah besar, misalnya spotlight kartu. Efek ini memaksa hitung ulang gaya seluruh isi kartu, termasuk chart, di setiap gerakan mouse. Sudah dihapus.
- Membaca posisi elemen (`getBoundingClientRect`, `offsetWidth`) setelah menulis gaya di frame yang sama, atau di setiap gerakan pointer. Cache posisinya, lalu baca dulu baru tulis.
- Memaksa reflow (`void el.offsetWidth`) untuk mengulang animasi. Pakai Web Animations API (`el.animate`) atau `requestAnimationFrame`.

**Target kinerja** (uji dengan CPU diperlambat 4×):
- **Klik dan pindah tab:** INP < 200 ms di semua halaman. Kanvas sekarang 48–192 ms.

**Si Mata** (`motion.js`):
- Dua mata, pupil mengikuti kursor.
- Sapaan per halaman yang memakai **nama pengguna dan waktu WIB**.
- Bicara saat tab di dalam halaman berpindah.
- Kalimat: tips, status, atau candaan ringan. **Tidak pernah** menjanjikan untung.
- Bisa disembunyikan atau dipanggil lagi.

**Si Mata ikut suasana IHSG** (Dashboard dan Dashboard HP): perubahan IHSG hari itu dibaca dari elemen bertanda `data-ihsg-chg`.

| Perubahan IHSG | Suasana | Ekspresi |
|---|---|---|
| ≥ +1,5% | gembira | senyum lebar, alis naik, lompat kecil sekali |
| +0,3% s.d. +1,5% | senang | senyum |
| −0,3% s.d. +0,3% | tenang | mulut lurus |
| −1,5% s.d. −0,3% | khawatir | alis khawatir, cemberut |
| ≤ −1,5% | cemas | khawatir + tetes keringat |

Aturan kalimat:
- Menyapa dengan nama dan menyebut persentasenya.
- Menyemangati atau menenangkan. Contoh: "cek stop loss", "tarik napas dulu", "jangan kejar harga".
- **Tidak pernah** menyuruh beli atau jual, dan tidak menjanjikan apa pun.

Aturan lain:
- `aria-label` ikut menyebut suasananya.
- Lompatan mati saat `prefers-reduced-motion`.
- Di kanvas ada tombol pratinjau 5 suasana di bilah "Pratinjau status". Itu alat review, **bukan** spesifikasi.

## 8. Aturan isi

- Setiap angka punya **sumber** dan **cap waktu** di baris "prov" di bawah kartunya.
- Tidak ada testimoni, klaim keamanan, atau klaim kinerja tanpa bukti. Tidak ada "pasti cuan".
- "Bukan rekomendasi beli/jual" ada di Dashboard, Screener, dan Ketentuan.
- Teks Indonesia, kalimat biasa. Tidak ada label KAPITAL bertracking lebar.
- **Nama penyedia data (Arjum) dan nama internal tidak boleh tampil di UI.** Ini termasuk VPS, nama tabel seperti `stock_fundamentals`, cron, dan pm2. Sumber ditulis netral, misalnya "Candle harian EOD bursa", "Broker summary harian", atau "Laporan keuangan emiten". Admin Console memakai "Kuota API data".
- **Setiap tabel dibungkus wadah scroll horizontal** (`overflow-x:auto`), supaya tidak ada kolom yang terpotong atau halaman yang ikut melebar di 390, 820, 1000, dan 1440px. Ini termasuk tabel di tab/segmen yang tidak tampil di awal.

## 9. Yang **bukan** spesifikasi (abaikan saat implementasi)

- Semua angka contoh. Contohnya BRPT 1.045 di halaman kebanyakan dan 1.210 di Analisis; keduanya contoh, bukan data.
- Tanggal contoh 13 Okt / 16 Okt.
- Nama pengguna "budi" dan email contoh.
- Bilah "Pratinjau status".
- `support.js` (runtime kanvas) dan sintaks `{{…}}`, `sc-for`, `sc-if` (template kanvas). Terjemahkan ke pola yang dipakai repo.
