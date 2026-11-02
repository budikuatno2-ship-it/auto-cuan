# Audit per halaman · Fase 1 (19–20 Okt 2026)

Cara audit:
- UI: skrip `handoff-redesign/tools/audit-ui.js` di dev server lokal (mock `/preview`) pada lebar 1440 dan 390. Mengecek konsol, overflow, tabel tanpa wadah scroll, em dash, nama internal, teks error, loading lebih dari 8 detik, kontras (dihitung, rumus WCAG), target sentuh, dan fokus Tab. Hasil mentah: `handoff-redesign/audit/ui-audit.json`.
- Data: cek read-only di VPS (file, log, crontab, curl localhost 10 kali per endpoint) dan baca kode.
- Batasan: tidak ada akun uji, jadi endpoint premium di produksi hanya terlihat sampai 401. Angka di screenshot lokal adalah mock dev server, bukan data produksi.

Kolom "Butuh deploy?": **ya** kalau perbaikannya baru terasa di produksi setelah merge + pull + restart, atau kalau menyangkut data/job di VPS.

## A. Tabel temuan per halaman

| Halaman | Bug UI | Masalah data | Penyebab (file:baris atau job) | Perbaikan | Butuh "deploy"? |
|---|---|---|---|---|---|
| **Semua halaman aplikasi** | Teks Inggris campur: "Score", "Grade", "Risk", "BUY", "Refresh", "Failed", "Low Risk", "Detail →", "Saham Turun (Losers)". Format persen pakai titik ("78.4%", "+1.25%"), bukan koma. Target sentuh < 44px: 3–12 per layar di 390px | Status kesegaran memakai waktu data (benar), tapi "kemarin" dihitung dari kalender. Senin pagi dengan data Jumat langsung jadi "stale" | `public/index.html:6853-6873` (`yesterday` = tanggal − 1 hari, bukan hari bursa sebelumnya) | Pakai kalender bursa (`lib/idx-trading-calendar.js` sudah ada) untuk hari bursa sebelumnya; seragamkan formatter angka `id-ID` saat Fase 2 | ya |
| **Semua halaman** | Kontras: chip "Hari ini" 3,25:1 di bilah atas (11px) muncul di semua layar | | Token lama `#6B7280` di atas `#1C2333` | Diganti token `ac.css` saat Fase 2 | ya |
| Landing | Kontras gagal 12 teks, contoh "Perbarui ↻" 2,67:1, "IDXENERGY" 2,82:1, angka hijau `#16A34A` di putih 3,30:1. Tombol "Masuk dengan Google" tampil padahal fitur mati di produksi (dead control, R-26) | Landing snapshot segar (19 Okt 22:15 WIB). Pengunjung anonim memanggil `/api/reset-password` dan selalu dapat 401 | `public/index.html:848` tombol Google; `/api/auth/google` di produksi menjawab 503 "belum dikonfigurasi" | Tombol Google **dihapus** (keputusan pemilik 20 Okt, Google login dibatalkan; detail di `AUDIT_ALUR.md`). Jangan panggil probe sesi kalau tidak ada tanda login | ya |
| Auth (Masuk, Daftar, Pemulihan) | Lihat `AUDIT_ALUR.md` | | | | |
| Dashboard | "Gagal memuat Top 5 History." di lokal (mock tidak ada). Angka breadth hijau/merah 3,11–3,14:1 | Market breadth `asOfDate` masih 16 Okt pada 19 Okt 23.44 WIB padahal 879 candle 19 Okt sudah ada | `lib/market-intelligence-engine.js` `calculateMarketBreadth` membaca dataset yang belum ikut 19 Okt (job candle 16:40 gagal, lihat bagian C) | Tampilkan tanggal asli breadth di baris prov (sudah ada "Data Pasar per…"); sumber datanya urusan Roo | ya |
| Screener | Em dash di kalimat UI: "Swing A+ — setup lengkap…", "Sebagian data gate belum tersedia — status…". Teks "Failed" mentah. Kontras gagal 31 teks (contoh 3,80:1 "Oversold" 10px) | Payload `/data/screener-latest.json` 3,9 MB bisa diunduh publik (lihat Keamanan) | `public/index.html` (teks gate), `signal-gate-transparency.js` | Ganti em dash dengan titik dua/titik; terjemahkan status mentah | ya |
| Sektor Hot | Kontras 3 teks; label "BY GROUP" kapital Inggris | Dari Supabase `sector_hot_*` (cron */30 09–15). Belum bisa dicek tanpa login | | Terjemahkan label | ya |
| Analisis & Chart | Kontras 2 teks | `/api/candles` dan `/api/quote` BBCA menyajikan 16 Okt (`t1_status: calendar_unverified`) pada 19 Okt malam, sementara file candle disk sudah 19 Okt. IHSG di disk berhenti 16 Okt | `api/quote.js` membaca store riwayat (`lib/stock-daily-history-store.js`), bukan `data/daily-candles`; kalender T-1 "unverified" | Tampilkan "data terakhir tersimpan · 16 Okt" saat `t1_verified=false`; asal data urusan Roo | ya |
| Bandarmologi | **"Error memuat data bandarmologi: selectedDate is not defined"**. Tabel broker gelap: kontras 1,82–1,86:1 (judul, nilai Rp, snapshot) | Broksum per ticker terakhir 16 Okt; `_daily-market-update/2026-10-19.json` `archive_complete:false`. Belum ada teks "data asing belum dirilis" | `public/bandarmologi-runtime.js:2023` menulis ke variabel tak dideklarasikan dalam mode strict (`'use strict'` baris 2), dari commit `6631c635`. Terjadi setiap tanggal jatuh ke "terbaru" | Hapus assignment liar (pakai `currentBandarDate`), tambah test. Tampilkan "data asing belum dirilis" saat `flow=F` tidak ada di arsip | ya |
| Sinyal Intelijen | Em dash: "Data hunter bersifat agregat rentang — streak…" | `as_of_date` 16 Okt. p95 690 ms (dingin), p50 105 ms, di atas anggaran 500 ms saat dingin | `lib/bandarmologi-intel-service.js` hitung di request pertama | Hangatkan cache setelah job EOD, atau simpan hasil per tanggal | ya |
| Broker Hunter | Judul pakai em dash "Broker Hunter — Top 10…" | **Data basi 5+ minggu**: default target `2026-09-08`, `generated_at` 9 Sep; index `data/broker-hunter-indexes/` terakhir 12 Sep | Job pembangun index broker hunter tidak terjadwal di crontab | UI: tampilkan tanggal asli besar-besar ("data terakhir tersimpan · 8 Sep"). Data: Roo | ya |
| Insider | | `network.json` 12 Sep, `roster_30sep2026.json` 13 Okt (KSEI bulanan, wajar) | | Tampilkan "Per 30 Sep 2026" dari field data | ya |
| Ranking | Teks "klik ticker untuk memuat…" tidak berubah (bukan loading macet) | Butuh login (401 tanpa sesi), tidak bisa diukur di produksi | `api/quote.js:284` daily-market-context-list; SQLite `market_rows` punya indeks `(table_name,row_key)` | Ukur setelah ada akun uji | belum bisa dinilai |
| Financial | | Periode terakhir BBCA "Q1 2026" (diambil 13 Okt). Sumber di payload bernama `'arjum financial-statements'` | `public/analisis-saham-runtime.js:630` memetakan ke label netral (sudah benar, nama tidak tampil) | Tidak perlu, cukup jaga pemetaan | tidak |
| Struktur Pasar | Kontras 40 teks, contoh "962 emiten terdaftar…" 2,34:1, header "Kode" 9px 2,34:1 | Payload **3,4 MB** per request (962 emiten penuh), 1,4 detik dari produksi setelah brotli 449 KB. `as_of` 30 Sep | `api/sector-hot.js` `handleMarketStructureList` tanpa paginasi/field terpilih | Kirim kolom yang dipakai tabel saja + paginasi/virtual; cache 60 detik | ya |
| Pattern Radar | Kontras paling buruk: "Buka Chart" 1,48:1, "Scan Ulang" 1,74:1, "Analisis Teknikal" 2,28:1 | | Hijau terang di atas putih | Token baru | ya |
| Watchlist | Persen hijau `#10B981` di putih 2,54:1 | Butuh login | | Token `--ac-pos` | ya |
| Portfolio | Kontras teks kecil 3,31:1 (10,5px) di Skenario | Simpan ke `localStorage` + Supabase | | Token | ya |
| Track Record | Persen hijau 2,54:1 | **"500 Sinyal" ditampilkan sebagai total**, padahal handler memotong `limit` 500 baris terbaru. Angka kosong ditulis `0` (fallback ke 0 di render) | `api/sector-hot.js` handleTrackRecord `limit` default 500; `public/track-record-runtime.js:175,186,199` | Label jujur "dari 500 sinyal terakhir" + "—" untuk kosong. Hitungan statistik tidak diubah (logika bisnis) | ya |
| Kelola Keuangan | | | **Dinonaktifkan** di `public/index.html:6601` (FINAL-BUG-004), padahal ada di kanvas | **Keputusan pemilik 20 Okt: dihidupkan kembali sesuai kanvas.** Lihat bagian F | ya |
| Pusat Akun | Em dash: "Daftar ini hanya referensi baca — jalankan…". Kontras 22–23 teks | | `account-center-v1.js` | Ganti tanda baca | ya |
| Ketentuan | Kontras 14 teks (warisan bilah atas) | Teks statis | | | ya |
| Admin Console | Belum ada sebagai halaman; sekarang panel di Dashboard + `admin-ai-eval.html`, `admin-foreign.html` | Field anomali tersedia di `_daily-market-update/<tgl>.json` (`archive_complete:false` untuk 19 Okt). Tab Online belum ada endpoint heartbeat | | Bangun di Fase 3 no.21 | ya |
| Pemeliharaan | Lolos semua cek otomatis | | | | |
| Catatan Admin | Belum ada | | | Fitur baru Fase 3 no.14 | ya |

Tidak ditemukan di halaman mana pun: overflow horizontal dokumen di 390px, tabel yang tampil tanpa wadah scroll (tabel di tab tersembunyi baru dicek saat Fase 3), elemen tanpa cincin fokus pada 25 langkah Tab pertama.

## B. Sumber data per halaman dan tab

"Data terakhir" dicek 19 Okt 23.17–23.55 WIB dan 20 Okt dini hari.

| Halaman | Tab | Endpoint | File/tabel sumber | Job pengisi + jadwal WIB | Data terakhir | Status |
|---|---|---|---|---|---|---|
| Landing | hero, snapshot | `sector-hot?action=landing-snapshot` | Supabase `kv_store` | `direct-refresh-landing.js` 22:15 setiap hari | 19 Okt 22:15 | segar |
| Dashboard | Kondisi pasar | `sector-hot?action=market-breadth` | candle disk | `run-daily-candles.sh` 16:40, 23:30 | 16 Okt | **basi 1 hari bursa** |
| Dashboard | Top 5 Radar, Riwayat | `web-daily-picks`, `web-top5-history(-archive)` | Supabase `telegram_daily_picks` | screener 21:30, dispatch 22:15 | butuh login | tidak terukur |
| Screener | Konglo / Non-Konglo / Day Trade | `screener`, `nk-screener-results`, `daytrade-screener` | Supabase `swing_screener_*`, `daytrade_screener_*`; `data/screener-latest.json` | 21:30 (`run-screeners-preflight.sh`), DayTrade 09:02–15:47 tiap 15 mnt | `screener-latest.json` 19 Okt 21:32 | segar |
| Sektor Hot | klasemen, konstituen | `sector-hot`, `sector-hot?group=` | Supabase `sector_hot_*` | `run-sector-hot.sh` */30 09–15 | butuh login | tidak terukur |
| Analisis | chart | `candles`, `quote` | store riwayat + `data/daily-candles` | 16:40, 23:30 | 16 Okt (store), 19 Okt (disk 879/964) | **tidak sinkron** |
| Analisis | IHSG | `candles?ticker=IHSG` | `data/daily-candles/IHSG.json` | J2 IHSG | 16 Okt | **basi** |
| Bandarmologi | Semua | `sector-hot?action=bandarmologi` | `arjum-data/broker-summary/<T>/` | backfill 00:07, 19:30; J1 16:30–17:45 | 16 Okt | **basi, 19 Okt belum diarsip** |
| Bandarmologi | Asing | `…&flow=F` | `broker-summary-F/` (83 ticker) | backfill | 16 Okt | cakupan 83 ticker |
| Bandarmologi | Domestik | `…&flow=D` | all − F | | 16 Okt | "belum lengkap" sudah ditangani Roo |
| Bandarmologi | Akumulasi | | `broker-accumulation/` | J1 | 16 Okt | |
| Sinyal Intelijen | Papan bukti, Scanner | `bandarmologi-intel` | `bandarmologi-intel-indexes/` | J1 | 16 Okt | basi 1 hari |
| Broker Hunter | 1 hari / 3 hari / 1 minggu / 1 bulan | `broker-hunter` | `broker-hunter-indexes/` | **tidak ada di crontab** | 8 Sep (index 12 Sep) | **basi 6 minggu** |
| Insider | graf, tabel | `insider-network`, `insider-roster` | `data/insider-network/*.json` | manual/KSEI | network 12 Sep, roster 30 Sep | wajar (bulanan) |
| Ranking | tabel | `quote?action=daily-market-context-list` | SQLite `market_rows` | `market.sqlite` diubah 19 Okt 21:32 | butuh login | tidak terukur |
| Financial | 4 tab laporan | `quote?action=financial-snapshot` | `arjum-data/financial-statements/` | J1 | Q1 2026 (ambil 13 Okt) | wajar |
| Struktur Pasar | daftar, detail | `market-structure-list` | roster KSEI + override | manual | 30 Sep | wajar |
| Track Record | statistik, tabel | `track-record` | Supabase `telegram_daily_picks` | lifecycle 16:30 | sinyal terbaru 19 Okt | segar, tapi dipotong 500 baris |
| Admin Console | Job & data | (belum ada) | `_daily-market-update/<tgl>.json` | J1 | 19 Okt, `archive_complete:false` | |

## C. Kondisi data VPS (wilayah Roo, tidak diubah)

1. **Job candle 19 Okt 16:40 gagal tapi `rc=0`.** Cek silang Yahoo 20/20 selisih > 0,5%, fallback penyedia data `fetched 0, failed 943`. Job 23:30 berhasil sebagian: `fetched 859, failed 83`. Sisa 84 ticker masih 16 Okt dan 1 ticker berhenti di 29 Jul.
2. **IHSG di disk berhenti 16 Okt** setelah dua job 19 Okt. Belum ada field `provisional`/`updatedAt` di file.
3. **Broksum 19 Okt belum ada.** Backfill terakhir `HALTED_BY_PROVIDER_ERROR` (502/530 dari tunnel penyedia). `archive_complete:false`.
4. **Broker Hunter index tidak diperbarui sejak 12 Sep**, dan tidak ada job di crontab.
5. **Job lifecycle anggota Telegram** (`tools/run-telegram-lifecycle.sh`) tidak ada di crontab.
6. Store riwayat untuk `/api/quote` dan `/api/candles` tidak ikut data candle 19 Okt (`t1_status: calendar_unverified`).
7. Log `autocuan-web-error.log` 8,6 MB berisi 52.278 baris `vps_local_cache_stale`. Penyebabnya jalur bridge/SSH lokal tidak tersedia (lihat D, koreksi Roo).

## D. `vps_local_cache_stale` (wilayah Roo)

- Masih terjadi 19 Okt, setiap 15 menit sepanjang jam bursa (BMTR, LINK).
- **Penyebab (koreksi Roo, 20 Okt): jalur bridge/SSH lokal tidak tersedia.** Saat itu terjadi, `lib/vps-data-fetcher.js:810-930` (`fetchLivePriceFromVpsSync`) jatuh ke snapshot lokal di luar jendela dan memberinya label `vps_local_cache_stale`.
- Hipotesis saya sebelumnya (penyebabnya karena nilai yang dipakai adalah VWAP T-1) **dibantah Roo dan ditarik**.
- Pemakai fungsi ini: `lib/latest-price-resolver.js:110`, `lib/bandarmologi-service.js:367`, `lib/bandarmologi-intel-service.js:634`.
- Perbaikan jalur bridge/SSH dikerjakan Roo; redesign tidak mengubah `lib/vps-data-fetcher.js`.
- Bagian tampilan yang tetap dikerjakan redesign di Fase 3: setiap harga yang datang dengan label `vps_local_cache_stale` atau label cadangan lain ditampilkan "data terakhir tersimpan · <tanggal asli>", bukan seolah harga berjalan.

## E. Kecepatan endpoint (dari VPS, curl localhost, 10 kali)

| Endpoint | Ukuran | p50 | p95 (≈ maks dari 10) | Catatan |
|---|---|---|---|---|
| landing-snapshot | 0,7 KB | 1 ms | 953 ms | request pertama dingin |
| market-breadth | 1,3 KB | 4 ms | 7 ms | |
| bandarmologi BBCA 16 Okt | 158 KB | 3 ms | 162 ms | |
| available-dates | 2,6 KB | 1 ms | 3 ms | |
| broker-hunter | 1,8 KB | 1 ms | 2 ms | data basi |
| bandarmologi-intel BBCA | 3 KB | 105 ms | **690 ms** | di atas anggaran saat dingin |
| insider-network BBCA | 12 KB | 2 ms | 397 ms | |
| insider-roster | 2,3 KB | 1 ms | 24 ms | |
| market-structure-list | **3,4 MB** | 26 ms | 33 ms | berat di jaringan: 449 KB br, 1,4 detik dari luar |
| track-record | 311 KB | 201 ms | 323 ms | |
| financial-snapshot BBCA | 6,9 KB | 1 ms | **529 ms** | dingin |
| candles BBCA | 107 KB | 2 ms | 375 ms | |
| quote BBCA | 3,3 KB | 1 ms | **541 ms** | dingin |
| screener / daytrade / sektor / ranking | | | | 401 tanpa login, tidak terukur |

- Tidak ada kompresi di server asal. Cloudflare yang mengompres (brotli).
- `api/sector-hot.js` timeout guard 3,5 detik menjawab `success:true, data:[]` untuk read yang lambat (`api/sector-hot.js:182-193`). Roo sudah mengecualikan job berat. Untuk UI, jawaban ini tetap terlihat seperti "kosong" padahal sebenarnya gagal. Usul: guard menambah `note:'timeout'` (sudah ada) dan UI membaca `note` untuk menampilkan keadaan gagal + data terakhir tersimpan. Perubahan di UI saja.

## F. Kelola Keuangan: kenapa dinonaktifkan, dan rencana menghidupkan

**Alasan dinonaktifkan (dari kode dan dokumen):**
- Ini **keputusan produk, bukan karena ada bug.** `DESIGN.md` §3.2 menulis: "Kelola Keuangan is not part of the target Auto-Cuan product experience" dan melarangnya tampil di navigasi, menu HP, pencarian, landing, akun, onboarding, dan pintasan Dashboard. Pada saat yang sama, data dan skema database dilarang dihapus.
- Eksekusinya bernama FINAL-BUG-004, 4 Okt 2026:
  - commit `53491892` "fix: clean deprecated UI and unify theme tokens";
  - commit `4f5f0c6e` "fix: make decommissioned route deterministic…";
  - test penjaga `test/final-wave-4a-targeted.test.js` (suite 1);
  - catatan di `REDESIGN-LOG.md:250`, `:1768-1770` dan `STITCH_MASTER_SPEC.md:172`.
- Tidak ada laporan cacat teknis yang dijadikan alasan. Handler server, tabel `user_personal_cashflow`, dan runtime `money-sheet-*.js` sengaja dibiarkan.

**Keputusan baru pemilik (20 Okt):** dihidupkan kembali sesuai kanvas `KelolaKeuangan.dc.html`. Konsekuensinya:
- `DESIGN.md` §3.2 diperbarui dengan catatan keputusan ini.
- Test FINAL-BUG-004 diganti test yang menjaga perilaku baru.

**Pemeriksaan sisi server untuk endpoint yang dipakai kanvas** (`/api/money-management?action=get-sheet|save-sheet|portfolio-summary`, `lib/money-sheet-handler.js`):

| Cek | Hasil |
|---|---|
| Login | Wajib sesi `ac_sess` atau akses premium (`lib/money-management-handler.js:30-53`). Tanpa sesi → 401 (dicek di produksi: `get-sheet` → 401 `UNAUTHORIZED`). Header uji `x-user-id` hanya berlaku di luar produksi |
| Same-origin | Ditolak 403 kalau Origin/Referer berbeda (`lib/money-sheet-handler.js:22`); header CORS wildcard dicabut untuk endpoint ini (`:20`) |
| Method | `save-sheet` hanya POST, lainnya GET (`:23`) |
| Validasi | Bulan `YYYY-MM` 1900–2199 (`:39`); isi lembar dinormalisasi `Sheet.normalize` (`public/money-sheet-model.js`); catatan maksimal 500 karakter (`:55`); revisi wajib dan berupa bilangan bulat aman (`:56-58`) |
| Tabrakan dua tab/perangkat | Compare-and-swap `sheet_revision`, bentrok → 409 dengan pesan jelas (`:61-68`) |
| Gagal penyimpanan | 503 dengan pesan "belum disimpan", tidak mengarang data (`:11-15`, `:71`) |

**Untuk Roo (keamanan, tidak diubah redesign):** aksi lama `save-cashflow`, `save-journal`, `delete-journal` di `lib/money-management-handler.js` tidak dipakai kanvas, tapi masih aktif:
- tanpa cek same-origin;
- CORS `*`;
- angka tidak divalidasi (nilai salah menjadi 0);
- `save-journal` meneruskan `b.id` dari klien ke `upsert`. Kalau `id` baris milik akun lain diketahui, baris itu bisa ditimpa dan pindah pemilik (`:228-238`).

Saran: matikan aksi lama atau tambahkan `.eq('user_id', user.id)` pada pembaruan.

**Urutan kerja:** halaman dibangun setelah fondasi Fase 2 (token, shell, ikon, status) selesai, karena halaman ini memakai fondasi itu. Ini satu-satunya halaman Fase 3 yang dikerjakan sebelum pemilik menulis "mulai Fase 3", atas permintaan eksplisit pemilik.

**Hasil (22 Okt, commit `07a042ed`):**
- Halaman aktif di `/kelola-keuangan`. Menu ada di grup Pantau setelah Track Record dan di lembar "Lainnya" HP. Gerbang premium sama dengan halaman premium lain.
- Diperiksa di browser pada 1440/1024/390, terang dan gelap, dalam tiga keadaan: ada data, lembar kosong, dan database tidak tersedia. Data contoh dipasang lewat intersepsi request di skrip uji, tidak ada di kode aplikasi.
  - 0 error halaman, 0 overflow horizontal.
  - Lembar kosong menampilkan "—" di ringkasan, tidak lagi Rp 0.
  - Tanpa database: "Database belum tersedia. Tidak ada data yang disimpan."
- Keyboard: ubah nominal lalu Enter memperbarui total; Ctrl+Z mengembalikan; panah dan Tab berpindah sel; input "abc" ditolak dengan pesan "Gunakan rupiah bulat…".
- Screenshot: `audit/kelola-data-*.png`, `audit/kelola-empty-*.png`, `audit/kelola-none-*.png`, `audit/kelola-more-390.png`.

**Penyimpangan dari kanvas:**

| Bagian | Kanvas | Implementasi | Alasan |
|---|---|---|---|
| Bar komposisi di bawah ringkasan | Ada (pengeluaran, tabungan, sisa) | Belum dibuat | Butuh perubahan runtime di luar penggantian tampilan; dicatat untuk Fase 3 |
| Pilih bulan | `<select>` "Oktober 2026" | `<input type="month">` lama | Format nama bulan mengikuti bahasa browser; runtime dan validasi bulan memakai input ini |
| Kolom Jenis | Titik warna + label | `<select>` yang bisa diubah | Jenis harus bisa diedit di sel; titik warna tidak bisa diletakkan di dalam `<select>` |
| Alat tambahan | Tidak ada | Urungkan/ulangi, baris edit (Salin, Kosongkan sel, Isi ke bawah, Sisipkan baris, Hapus baris), "Pintasan & rumus", "Fokus lembar", "Muat ulang" | Fitur lama yang sudah dipakai; tidak dihapus |
| Tombol di HP | 30 px | Minimal 44 px pada layar sentuh | Target sentuh (R-03) |
| Status portofolio di bawah judul | "Tersinkron · 4 posisi" | Teks dari runtime | Mengikuti sumber data Portofolio, tidak dikarang |

**Untuk Roo (keamanan, tidak diubah):** `resolveUser` di `lib/money-management-handler.js` menerima header `x-user-id` kalau `NODE_ENV` bukan `production`. `ecosystem.config.js` sudah mengisi `NODE_ENV=production` untuk PM2, jadi aman selama server dijalankan lewat PM2. Batas preview di `tools/local-dev-server.js` lebih ketat (`NODE_ENV`, `VERCEL_ENV`, atau `pm_id`); `resolveUser` hanya membaca `NODE_ENV`. Kalau server pernah dijalankan tanpa ecosystem, header itu ikut berlaku. Belum dicek di VPS.
