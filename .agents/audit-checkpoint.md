# AUDIT_CHECKPOINT

Dokumen serah-terima audit `budikuatno2-ship-it/auto-cuan`.
Disusun **dari `AUDIT_COVERAGE.md` dan `AUDIT_FINDINGS.md`**, bukan dari ingatan —
setiap angka cakupan dihitung ulang dari tabel `AUDIT_COVERAGE.md`, setiap lokasi
`file:baris` disalin ulang dari blok temuan aslinya di `AUDIT_FINDINGS.md`.

Status CI di dokumen ini **diverifikasi ulang pada 4 September 2026**, bukan
disalin dari catatan lama.

---

## 1. Ringkasan eksekutif

### 1.1 Angka cakupan (dihitung ulang dari tabel `AUDIT_COVERAGE.md`)

| | file | baris |
|---|---:|---:|
| **TOTAL terdaftar** | **778** | **200.055** |
| SELESAI (dibaca baris 1 → baris terakhir) | 88 | 48.811 |
| SEDANG (sebagian) | 6 | 13.511 |
| BELUM (belum disentuh) | 684 | 137.733 |

Cakupan baris: **24,4% SELESAI**, 6,8% SEDANG, 68,8% BELUM.

> **Koreksi.** Baris ringkasan di kepala `AUDIT_COVERAGE.md` masih menulis
> *"54 SELESAI, 8 SEDANG, 716 BELUM"* — itu angka lama yang tidak ikut
> diperbarui. Angka yang benar adalah **88 / 6 / 684** di atas. Saya perbaiki
> baris itu pada commit yang sama dengan dokumen ini.

Per folder:

| folder | SELESAI | SEDANG | BELUM | baris BELUM | total baris |
|---|---:|---:|---:|---:|---:|
| `api/` | **12** | 0 | **0** | **0** | 19.046 |
| `lib/` | 70 | 1 | 86 | 21.323 | 48.931 |
| `public/` | 4 | 1 | 59 | 20.197 | 33.395 |
| `supabase/` | 0 | 3 | 46 | 7.333 | 8.932 |
| `tools/` | 0 | 1 | 75 | 13.336 | 13.657 |
| `test/` | 0 | 0 | 358 | 68.701 | 68.701 |
| `.agents/` | 0 | 0 | 23 | 637 | 637 |
| `.github/` | 0 | 0 | 14 | 1.074 | 1.074 |
| `_disabled_api_backup/` | 0 | 0 | 8 | 2.782 | 2.782 |
| `scripts/` | 0 | 0 | 7 | 1.492 | 1.492 |
| `deploy/` | 0 | 0 | 3 | 150 | 150 |
| `(root)` | 2 | 0 | 5 | 708 | 1.258 |

**`api/` sudah 100% selesai** — dua belas file, 19.046 baris, termasuk
`api/sector-hot.js` (13.902 baris) yang dibaca utuh.

### 1.2 Temuan

**44 BUG + 3 REKOMENDASI.**

| Severity | jumlah | sudah diperbaiki | belum |
|---|---:|---:|---:|
| CRITICAL | 2 | 2 | 0 |
| HIGH | 9 | 7 | 2 |
| MEDIUM | 17 | 11 | 6 |
| LOW | 16 | 5 | 11 |
| **Total** | **44** | **25** | **19** |

Dua HIGH yang belum diperbaiki (BUG-025 dan BUG-027) keduanya menunggu keputusan
Anda karena menyentuh gate keselamatan / perilaku bisnis (aturan No. 8).

### 1.3 PR terbuka

> ⚠️ **PEMUTAKHIRAN 4 September 2026, 09:14 UTC — keadaan berubah setelah §1.3 ini
> pertama ditulis.** Anda me-merge **PR #516**. Bagian ini sudah saya perbarui;
> §7 memuat rinciannya.

**Semula 22 PR milik saya (#495–#516). Sekarang: 1 MERGED, 21 masih terbuka,
semuanya draft.**

- **#516 SUDAH DI-MERGE** oleh pemilik repo pada 2026-09-04T09:14:16Z
  (commit `3319a5f` di `feat/daytrade-screener-v1`). REKOMENDASI-02 selesai dan
  sudah masuk base branch.
- **5 PR HIJAU dan bersih** — #495, #497, #498, #499, #501:
  6 check wajib lulus, tidak konflik dengan base yang baru.
- **15 PR SEKARANG KONFLIK** — #500, #502–#515. Semuanya konflik di **satu file
  yang sama**, `tools/curated-build-tests.json`, karena #516 ikut menambah satu
  baris di ujung daftar yang sama. **Ini persis tumpang-tindih yang saya
  peringatkan di §7** — sekarang ia nyata, bukan hipotesis. Bukan kegagalan CI,
  bukan bug: hanya dua penambahan di baris terakhir file yang sama.
- **1 PR TERBLOKIR: #496** (dokumentasi, termasuk dokumen ini). Lima check lulus,
  tetapi **`build-and-focused-tests` tidak pernah dijalankan** dan GitHub
  melaporkan `mergeable_state: "blocked"`. Check-nya path-filtered dan PR ini
  hanya menyentuh file `.md` di root, jadi secara struktural check itu **tidak
  bisa** terpenuhi. Rinciannya di §7.

**Status CI lama (6/6 hijau) diverifikasi pada 4 September 2026 pagi terhadap
base `63dbfd6`. Base sekarang `3319a5f`, jadi untuk 15 PR di atas status itu
tidak lagi mewakili keadaan sekarang sampai base yang baru di-merge masuk.**

Ada juga **3 PR dependabot** yang **bukan milik saya**: #464 (`@supabase/supabase-js`
2.106.1 → 2.112.4), #465 dan #466 (`github/codeql-action` 4.37.7 → 4.37.9). Ketiganya
sudah ready-for-review (bukan draft) dan tidak saya sentuh.

### 1.4 Pola struktural yang berulang — mesinnya benar, lapisan yang memakainya salah

Ini pola tunggal paling sering yang saya temukan sepanjang audit: **modul intinya
sudah benar, sering bahkan sudah didokumentasikan dengan disiplin — yang salah
adalah lapisan yang memanggilnya, meniru polanya setengah jalan, atau menyalin
rumusnya tanpa penjaganya.** Bukan mesinnya yang rusak; yang rusak adalah sambungan
antar-modul, dan justru sambungan itulah yang paling jarang punya test.

Saya mencatatnya **11 kali**: BUG-014, BUG-021, BUG-022, BUG-028, BUG-029, BUG-032,
BUG-035, BUG-038, BUG-040, BUG-042, dan kontras `clearTimeout` pada BUG-036.

Tiga contoh yang paling jelas:

1. **BUG-038 — `lib/admin-foreign-upload.js:216-221`.** Repo ini **sudah pernah
   mengalami bug yang persis sama, sudah memperbaikinya, dan sudah menuliskannya**.
   Docstring di `lib/stock-daily-history-store.js:54-73` berbunyi: *"this lookup query
   previously had NO `.limit()` at all … **confirmed bug — retention was silently a
   no-op across the ticker universe**"* — lengkap dengan konstanta peredamnya
   (`SAFE_QUERY_ROW_BUDGET = 900`, `RETENTION_TRIM_HEADROOM = 100`). Jalur foreign
   flow menulis kueri yang sama tanpa `.limit()`, jadi mewarisi bug yang sudah
   dipecahkan di sebelah.

2. **BUG-040 — `lib/daily-volume-context.js:64-65` vs pemanggilnya.**
   `buildVolumeContext` sendiri **benar**: ia butuh 8 baris untuk menghasilkan
   statistik 7 hari (7 sesi + 1 pembanding). `test/daily-volume-context.test.js:50-64`
   memberinya 8 baris dan **selalu lulus**. Satu-satunya pemanggil produksi,
   `lib/daily-market-context-builder.js:81`, memberinya 7. Test per-modul hijau,
   produksi salah — persis di seam-nya.

3. **BUG-036 — `lib/ai-gemini-provider.js:260` vs `lib/daily-history-collector.js`.**
   Modul kolektor mematikan timer abort-nya di `finally`, jadi benar. Provider Gemini
   mematikannya **sebelum body dibaca**, jadi permintaan streaming bisa menggantung
   selamanya. Pola yang benar ada di repo yang sama, hanya tidak ditiru di sini.

Konsekuensi metodologisnya, dan ini yang paling saya ingin diteruskan ke sesi
berikutnya: **test per-modul yang hijau bukan bukti jalur produksinya benar.**
BUG-022, BUG-028, BUG-032, BUG-038 dan BUG-040 semuanya hidup di seam, dan semuanya
lolos dari test unit yang sudah ada.

---

## 2. Tabel seluruh temuan

Diurutkan CRITICAL → HIGH → MEDIUM → LOW (bukan menurut nomor).

| No | Judul singkat | Severity | Lokasi (file:baris) | Status | PR # | Butuh keputusan Anda? |
|---|---|---|---|---|---|---|
| BUG-001 | Modal login/register/reset terkurung di dalam `#dashboardScreen` — **P0, tidak bisa login** | CRITICAL | `public/index.html:1522`, `:1539`, `:1598` | SUDAH DIPERBAIKI (PR #495) | 495 | Tidak |
| BUG-028 | Jawaban Portofolio AI satu pengguna bisa tersaji ke pengguna lain | CRITICAL | `lib/context-ai-router-v7.js:393-399`, `:419-426`, `:466-473` | SUDAH DIPERBAIKI (PR #505) | 505 | Tidak |
| BUG-003 | Kegagalan analisis nyata disembunyikan jadi pesan sukses palsu | HIGH | `public/index.html` — `runAnalisisFromDashboard()` (pra-perbaikan `:3288-3348`, catch `:3380-3384`) | SUDAH DIPERBAIKI (PR #497) | 497 | Tidak |
| BUG-004 | Balapan permintaan: hasil basi menimpa hasil terbaru | HIGH | `public/index.html` — `runAnalisisFromDashboard()` | SUDAH DIPERBAIKI (PR #497) | 497 | Tidak |
| BUG-008 | Risiko portofolio dilaporkan terlalu rendah (dipotong 30 posisi) | HIGH | `public/portfolio-ai-runtime-v2.js` — `contextNow()` (pra-perbaikan `:91`) | SUDAH DIPERBAIKI (PR #498) | 498 | Tidak |
| BUG-029 | Angka apa pun di pesan dibaca sebagai harga saham | HIGH | `lib/analyze-legacy.js:201` (saham), `:138` (IHSG) | SUDAH DIPERBAIKI (PR #506) | 506 | Tidak |
| BUG-030 | Satu pesan Telegram gagal meracuni seluruh batch Top 5 | HIGH | `lib/telegram-delivery.js:762-786`, dipicu `api/sector-hot.js:6512` | SUDAH DIPERBAIKI (PR #507) | 507 | Tidak |
| BUG-031 | Alert watchlist bisa diarahkan ke chat Telegram siapa pun | HIGH | `lib/user-watchlist-service.js:308`, dikirim `:471-479` | SUDAH DIPERBAIKI (PR #508) | 508 | Tidak |
| BUG-036 | Timer abort AI dimatikan sebelum body dibaca — permintaan bisa menggantung selamanya | HIGH | `lib/ai-gemini-provider.js:260` (streaming), `:82` (non-streaming) | SUDAH DIPERBAIKI (PR #512) | 512 | Tidak |
| **BUG-025** | **`includesAny()` memotong teks di 300 karakter — gate keselamatan gagal-TERBUKA** | **HIGH** | `api/sector-hot.js:12856`, berpasangan `:12862`, `:12808` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.1 (b)** |
| **BUG-027** | **Peringatan "JANGAN chase" dibaca sistem sebagai bukti harga SEDANG di-chase** | **HIGH** | `lib/idx-tick-normalization.js:837` + `:881`, berpasangan `lib/daytrade-screener-engine.js:1180` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.1 (a)** |
| BUG-005 | Lima `fetch` upstream tanpa timeout di jalur analisis | MEDIUM | `lib/analyze-legacy.js:547`, `:594`, `:711`, `:1518`, `:1599` | SUDAH DIPERBAIKI (PR #497) | 497 | Tidak |
| BUG-006 | Permintaan analisis frontend tanpa batas waktu | MEDIUM | `public/index.html` — fetch di `runAnalisisFromDashboard()` | SUDAH DIPERBAIKI (PR #497) | 497 | Tidak |
| BUG-009 | Penolakan nyata disamarkan jadi kategori kegagalan yang salah | MEDIUM | `public/portfolio-ai-runtime-v2.js` — `classifyFailure()` (pra-perbaikan `:482-524`) | SUDAH DIPERBAIKI (PR #498) | 498 | Tidak |
| BUG-011 | Handler `on*` inline lolos sanitizer pada separator tertentu | MEDIUM | `public/index.html` — `sanitizeAIHtml()` (pra-perbaikan `:10565-10566`) | SUDAH DIPERBAIKI (PR #499) | 499 | Tidak |
| BUG-018 | Tiga `fetch` upstream tanpa timeout di `api/sector-hot.js` | MEDIUM | `api/sector-hot.js:2088`, `:2310`, `:2348` | SUDAH DIPERBAIKI (PR #502) | 502 | Tidak |
| BUG-022 | Sesi Yahoo tanpa high/low membuat `support` runtuh jadi 0 (Swing Non-Konglo) | MEDIUM | `api/sector-hot.js:10061-10065` (`fetchNkQuoteData`) | SUDAH DIPERBAIKI (PR #504) | 504 | Tidak |
| BUG-032 | Reset password oleh admin menyimpan hash mentah tanpa validasi | MEDIUM | `lib/admin-users-handler.js:246-289` | SUDAH DIPERBAIKI (PR #509) | 509 | Tidak |
| BUG-033 | TTL 12 jam di luar jam bursa tidak pernah benar-benar berlaku | MEDIUM | `lib/daytrade-ohlcv-cache.js:253-260` | SUDAH DIPERBAIKI (PR #510) | 510 | Tidak |
| BUG-034 | Host header dari klien menentukan tautan review di Telegram admin | MEDIUM | `lib/subscription-manual-handler.js:45-51` | SUDAH DIPERBAIKI (PR #511) | 511 | Tidak |
| BUG-035 | Notifikasi admin tak terbatas pada submit ulang pembayaran | MEDIUM | `lib/subscription-manual-handler.js:319-321` | SUDAH DIPERBAIKI (PR #511) | 511 | Tidak |
| **BUG-013** | **Token & hash password mode review ter-commit di source, dengan default** | MEDIUM | `api/review-access.js:39`, `:62`; `public/index.html:2161`, `:2169` | **MENUNGGU KEPUTUSAN** (kode perbaikannya sudah ada di PR #501) | 501 | **Ya — §3.3 (a)** |
| **BUG-015** | **RSI 0/0 pada saham beku dilaporkan sebagai overbought ekstrem (6 salinan)** | MEDIUM | `api/quote.js:1466`, `api/candles.js:292`, `lib/daytrade-screener-engine.js:2069`, `lib/analyze-legacy.js:1394`, `api/sector-hot.js:2872` + salinan ke-9 | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.1 (c)** |
| **BUG-020** | **Observasi harga tanpa timestamp dianggap SEGAR, bukan basi (monitor entry/TP/SL)** | MEDIUM *(jika terjangkau — belum pasti)* | `api/sector-hot.js:6678` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.2 (a)** |
| **BUG-026** | **`PRE_SPIKE_WATCH` hanya bisa dicapai kandidat yang LEBIH BURUK** | MEDIUM | `lib/daytrade-screener-engine.js:880-884` vs `:887` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.1 (d)** |
| **BUG-037** | **Orang luar tanpa akun bisa memblokir pairing laptop admin, terus-menerus** | MEDIUM | `supabase/admin-telegram-zero-link-pairing-migration.sql:277-291` dan `:361-374` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.2 (b)** |
| **BUG-042** | **Hammer vs Hanging Man dibedakan hanya dari warna candle; yang bearish memblokir `A_PLUS_SETUP`** | MEDIUM | `lib/candle-pattern-engine.js:246-254` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.1 (e)** |
| **BUG-002** | **Test yang tidak terdaftar di kurasi tidak pernah dijalankan CI** | MEDIUM | `tools/curated-build-tests.json` vs `test/` (`tools/run-build-test-suite.js:52-58`) | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.3 (b)** |
| BUG-010 | Fallback lokal portofolio salah label | LOW | `lib/context-ai-router-v7.js` (pra-perbaikan `:259-260`) | SUDAH DIPERBAIKI (PR #498) | 498 | Tidak |
| BUG-012 | `getWIBDateString()` menghitung offset zona dua kali | LOW | `public/index.html:1887-1891`, dipakai `:1979` | SUDAH DIPERBAIKI (PR #500) | 500 | Tidak |
| BUG-016 | Rentang entry dirender terbalik (tinggi→rendah) di Track Record & CSV | LOW | `public/track-record-runtime.js:172-173`, `:239` | SUDAH DIPERBAIKI (PR #503) | 503 | Tidak |
| BUG-039 | Baris tertua di jendela retensi selalu kehilangan `previous_close` | LOW | `lib/daily-history-collector.js:283-285` | SUDAH DIPERBAIKI (PR #513) | 513 | Tidak |
| BUG-040 | Statistik "7 hari" hanya memakai 6 sesi saat sesi berjalan masih terbuka | LOW | `lib/daily-volume-context.js:64-65`, dipicu `lib/daily-market-context-builder.js:81` | SUDAH DIPERBAIKI (PR #514) | 514 | Tidak |
| BUG-041 | Kalender libur yang sudah di-seed dilaporkan "fallback akhir pekan saja" | LOW | `lib/idx-trading-calendar.js:162-177` | SUDAH DIPERBAIKI (PR #515) | 515 | Tidak |
| **BUG-038** | **Retensi 7 hari foreign flow diam-diam tidak pernah berlaku** | LOW | `lib/admin-foreign-upload.js:216-221` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.2 (c)** |
| **BUG-043** | **Pengumuman kanal legacy hangus permanen bila pengiriman Telegram gagal** | LOW | `lib/telegram-lifecycle.js:275-287` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.2 (d)** |
| **BUG-044** | **Grounding portofolio hanya menyimpan nominal terbesar dari pesan pengguna** | LOW | `lib/ai-runtime-grounding.js:69-82` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.3 (c)** |
| **BUG-017** | **`summary` Track Record tidak dihitung ulang setelah filter kategori** | LOW *(laten — jalur belum dipakai frontend)* | `api/sector-hot.js:8022-8030` | **LATEN — TIDAK TERJANGKAU** (belum diperbaiki) | — | Tidak mendesak |
| **BUG-019** | **Diagnostik gate Top 5 melaporkan "unknown" untuk dua penyebab penolakan nyata** | LOW *(hanya diagnostik)* | `api/sector-hot.js:4676` vs `:4410` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.3 (d)** |
| **BUG-021** | **Fallback alias entry tertukar di sebelas tempat** | LOW *(laten)* | `api/sector-hot.js:4024-4025`, `:6843-6844`, `:7789-7790`, `:13230`, `:13245-13246`, `:13341`; `lib/idx-tick-normalization.js:965`; `lib/trade-plan-v2-integration.js:135-136`; `lib/trade-plan-v2-source-adapters.js:129-130`, `:209-210`, `:338-339` | **LATEN — TIDAK TERJANGKAU** (belum diperbaiki) | — | Tidak mendesak |
| **BUG-023** | **`avg_volume_20d` yang dipublikasikan adalah taksiran padahal angka aslinya sudah dihitung** | LOW | `api/sector-hot.js:10905` (`calculateNkSetupScore`) | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.3 (e)** |
| **BUG-024** | **Pencocokan substring `ARA`/`ARB` terlalu longgar** | LOW *(laten)* | `api/sector-hot.js:12242` | **LATEN — TIDAK TERJANGKAU** (belum diperbaiki) | — | Tidak mendesak |
| **BUG-014** | **Sentinel `0` vs "tidak diketahui" tidak konsisten antara produsen dan gate** | LOW *(laten)* | `lib/daytrade-screener-engine.js:229-230` vs `lib/idx-tick-normalization.js:1081`, `:1091` | **MENUNGGU KEPUTUSAN** | — | **Ya — §3.1 (f)** |
| **BUG-007** | **Cabang SSE di frontend adalah kode mati — backend legacy tidak pernah streaming** | LOW | `public/index.html` (cabang streaming) vs `api/analyze.js:113-117` | **DICATAT — TIDAK DINAIKKAN** (sengaja tidak diubah; menghapusnya pembersihan, bukan perbaikan bug) | — | Tidak |

---

## 3. Keputusan yang menunggu Anda

**19 temuan belum saya sentuh.** Tiga di antaranya (BUG-017, BUG-021, BUG-024)
laten dan tidak butuh keputusan sekarang; satu (BUG-007) sengaja dibiarkan.
**Sisanya, 15 keputusan, ada di bawah ini.**

Dikelompokkan menurut urgensinya:
**(a)** menyentuh gate / strategi trading → butuh persetujuan eksplisit Anda (aturan No. 8);
**(b)** butuh satu kueri produksi read-only dulu sebelum diputuskan;
**(c)** sisanya.

---

### 3.1 Kelompok A — MENYENTUH GATE / STRATEGI TRADING

> Aturan No. 8 Anda: *"Sebelum mengubah perilaku bisnis (rumus entry/SL/TP, gate,
> ranking), tanya saya dulu. Bug fix ≠ mengubah strategi trading."*
> Semua di bawah ini masuk kategori itu. **Tidak satu pun saya kerjakan.**

#### (a) BUG-027 — Peringatan "JANGAN chase" dibaca sistem sebagai bukti harga sedang di-chase

- **Severity:** HIGH
- **Lokasi:** `lib/idx-tick-normalization.js:837` + `:881` (`deriveSignalVerdict`),
  berpasangan dengan `lib/daytrade-screener-engine.js:1180`. Efek turunannya di
  `api/sector-hot.js:4005`, `:4031`, `:4182` (dua kali).

**Apa yang salah.** Sistem menulis nasihat untuk pengguna — kalimat semacam
*"jangan chase di harga ini"*. Lalu, di langkah berikutnya, sistem membaca ulang
kalimat nasihatnya sendiri, menemukan kata "chase" di dalamnya, dan menyimpulkan
bahwa harga saham itu **sedang** dikejar-kejar pasar. Nasihat dibaca sebagai
pengamatan. Saham itu lalu dilabeli **"Hindari"**, skornya dipotong **−12 poin**,
dan `hasHindariAction()` (`api/sector-hot.js:4396`) **memblokirnya dari Telegram
dan dari Top 5** — semata karena nasihatnya sendiri memuat kata itu.

**Kalau diperbaiki, efeknya — ARAHNYA: sinyal Day Trade akan BERTAMBAH.** Kandidat
`PRE_SPIKE_WATCH` yang selama ini tertekan akan kembali muncul di Telegram dan Top 5,
dengan skor 12 poin lebih tinggi dan tanpa label "Hindari". Ini melonggarkan, bukan
mengetatkan.

**Kalau TIDAK diperbaiki, risikonya.** Kandidat yang sah terus ditekan secara
sistematis. Arah kegagalannya **aman** (gagal-tertutup — tidak ada sinyal berbahaya
yang terbit), tetapi digabung dengan BUG-026 di bawah, jalur "priority opportunity"
Anda tertekan dua kali dari dua sebab yang berdiri sendiri. **Kalau Anda merasa
sinyal Day Trade lebih sedikit dari yang seharusnya, dua temuan ini kandidat
penjelasannya.**

**Opsi:**
- **(a)** Buang `r.time_plan` dari `noteText` di `lib/idx-tick-normalization.js:837`.
  `time_plan` memang berisi instruksi, bukan pengamatan — sumber yang salah untuk
  mendeteksi keadaan pasar. Field terstruktur `entry_status` (`CHASE_RISK`/`EXTENDED`)
  sudah memberi jawaban yang benar dan sudah diperiksa di baris yang sama.
- **(b)** Andalkan `entry_status` saja, buang pencocokan teksnya. Paling bersih,
  tapi menghapus lapis kedua yang mungkin memang diinginkan untuk sumber lain.
- **(c)** Terapkan hal yang sama pada tiga lokasi di `api/sector-hot.js` yang
  memungut `time_plan` untuk keperluan serupa.

**Rekomendasi saya: (a)**, lalu (c) sebagai lanjutan. Perubahannya paling kecil dan
menyerang penyebabnya, bukan gejalanya.

---

#### (b) BUG-025 — Gate keselamatan gagal-TERBUKA karena teksnya dipotong di 300 karakter

- **Severity:** HIGH
- **Lokasi:** `api/sector-hot.js:12856` (`includesAny`), berpasangan dengan
  `:12862` (`joinTelegramTexts`) dan `:12808` (`safeTelegram…`)

**Apa yang salah.** Beberapa gerbang keselamatan bekerja dengan menggabungkan semua
catatan tentang satu saham menjadi satu teks panjang, lalu mencari kata-kata bahaya
di dalamnya — misalnya "invalid candle", "below sl", "sl kena", "data rusak". Tetapi
fungsi pencarinya memotong teks itu di karakter ke-300 sebelum mencari. **Kalau kata
bahayanya kebetulan berada setelah karakter ke-300, gerbang itu tidak melihatnya dan
sahamnya lolos.** Gagalnya ke arah yang salah: terbuka, bukan tertutup.

**Peredam yang jujur harus saya sebut:** banyak gate memeriksa **field terstruktur
lebih dulu** (`risk === 'very high risk'`, `candidate.trading_plan_valid === false`,
`entryStatus === 'INVALID_BELOW_SL'`). Untuk kondisi-kondisi itu, cek teks hanya
lapis kedua dan lapis pertamanya tetap bekerja. Yang benar-benar bocor adalah kondisi
yang **tidak punya** lapis terstruktur — di antaranya `hasFatalDayTradeRadarBlock`
(`api/sector-hot.js:12277`), yang menggabung **26 field** dan merupakan blok **fatal**.

**Yang belum bisa saya ukur — kecurigaan belum terverifikasi.** Berapa banyak kandidat
nyata yang teks gabungannya benar-benar melewati 300 karakter. Yang bisa saya
tunjukkan: `status_reason` Non-Konglo saja dirakit sebagai
`metricLine + '.' + entryNote + ' ' + statusReason` (`api/sector-hot.js:10850`) dan
rutin melebihi 120 karakter — jadi hanya butuh dua sampai tiga field terisi lagi
untuk melewati batas.

**Kalau diperbaiki, efeknya — ARAHNYA: sinyal akan BERKURANG.** Gate jadi lebih ketat.
Kandidat yang selama ini lolos karena kata pemblokirnya terpotong akan mulai diblokir.
**Besarnya tidak saya ketahui** — bisa beberapa per hari, bisa banyak.

**Kalau TIDAK diperbaiki, risikonya.** Sebuah blok yang dimaksudkan **fatal** bisa
diam-diam tidak berlaku, dan sinyal yang seharusnya ditahan bisa terbit ke Telegram.

**Opsi:**
- **(a) Ukur dulu, jangan ubah dulu — rekomendasi saya.** Saya tambahkan diagnostik
  dry-run yang menghitung, untuk setiap kandidat, apakah teks gabungannya melewati
  300 karakter dan apakah ada kata pemblokir yang hilang karena terpotong. Murni
  observasi — **tidak ada gate yang berubah** — dan hasilnya memberi tahu kita persis
  seberapa besar dampak perbaikannya sebelum diterapkan.
- **(b)** Langsung perbaiki `includesAny` supaya tidak memotong, terima berapa pun
  pengurangan sinyalnya.

**Rekomendasi saya: (a) dulu, baru (b).** Ini satu-satunya temuan di mana saya
menyarankan langkah pengukuran mendahului perbaikan, karena arah perubahannya
mengurangi sinyal dan besarannya tidak bisa saya perkirakan tanpa data produksi.

---

#### (c) BUG-015 — RSI saham beku dilaporkan sebagai overbought ekstrem

- **Severity:** MEDIUM
- **Lokasi:** enam salinan — `api/quote.js:1466`, `api/candles.js:292`,
  `lib/daytrade-screener-engine.js:2069`, `lib/analyze-legacy.js:1394`,
  `api/sector-hot.js:2872`, plus salinan `nkCalcRSI` dan salinan ke-9 (semuanya
  tercatat di `AUDIT_FINDINGS.md`)

**Apa yang salah.** RSI adalah indikator 0–100 yang mengukur seberapa kuat kenaikan
dibanding penurunan. Kalau sebuah saham **sama sekali tidak bergerak** — tidak naik,
tidak turun, misalnya karena disuspensi — perhitungannya jadi "nol dibagi nol".
Lima salinan rumus di repo ini menjawab **100** untuk kasus itu, yaitu nilai yang
berarti "naik sekuat-kuatnya, sangat overbought". Jawaban yang benar adalah **50**
(netral) — dan `lib/daily-rsi.js` memang sudah menjawab 50.

**Kalau diperbaiki, efeknya — ARAHNYA: saham beku berhenti dilabeli berisiko-ekstrem.**
`rsi14` masuk ke `calculateRiskLabel()` (`api/quote.js:445`) dan ke mesin screener,
jadi angka ini ikut menentukan label risiko dan penyaringan. Saham datar akan pindah
dari "overbought ekstrem" ke "netral", yang bisa membuatnya **lolos** penyaringan yang
sebelumnya menolaknya.

**Kalau TIDAK diperbaiki, risikonya.** Saham yang tidak bergerak terus dilaporkan
sebagai overbought ekstrem ke pengguna, dan label risikonya keliru.

**Opsi:**
- **(a)** Tambahkan `if (avgGain === 0 && avgLoss === 0) return 50;` sebelum penjaga
  yang ada, di keenam lokasi. Satu baris per lokasi.
- **(b)** Satukan keenamnya memanggil `lib/daily-rsi.js`. Lebih benar secara struktur,
  tetapi itu refactor — aturan No. 7 Anda menyuruh saya mencatatnya, bukan
  mengerjakannya.

**Rekomendasi saya: (a) sekarang, (b) dicatat sebagai utang.** Ini juga contoh
pola §1.4: `lib/daily-rsi.js` sudah benar, enam salinannya tidak ikut.

---

#### (d) BUG-026 — `PRE_SPIKE_WATCH` hanya bisa dicapai kandidat yang lebih buruk

- **Severity:** MEDIUM
- **Lokasi:** `lib/daytrade-screener-engine.js:880-884` (cabang `EARLY_RADAR`)
  vs `:887` (cabang `PRE_SPIKE_WATCH`)

**Apa yang salah.** Ada dua label kualitas untuk kandidat Day Trade. `PRE_SPIKE_WATCH`
seharusnya label yang **lebih kuat** (ambang skor 70), `EARLY_RADAR` yang lebih lemah
(ambang 62). Tetapi pemeriksaannya ditulis dengan urutan terbalik: yang berambang
lebih rendah diperiksa lebih dulu. Akibatnya kandidat berskor 70–74 selalu tertangkap
`EARLY_RADAR` dan **tidak pernah** bisa mencapai `PRE_SPIKE_WATCH`. Label yang lebih
kuat, pada rentang itu, hanya bisa diraih kandidat yang lebih lemah.

**Kalau diperbaiki, efeknya — ARAHNYA: `top_count` NAIK dan urutan Telegram berubah.**
`priorityRadarCount` (`api/sector-hot.js:11760-11768`) hanya menghitung
`PRE_SPIKE_WATCH`, jadi angka "PRIORITY OPPORTUNITY" yang dilaporkan selama ini
kehilangan kandidat skor 70–74 yang paling menjanjikan. `setupPriority`
(`api/sector-hot.js:12406`) memberi `PRE_SPIKE_WATCH` = 3 dan `EARLY_RADAR` = 4,
jadi setup yang lebih baik selama ini diurutkan **di bawah** setup yang lebih lemah.
Memperbaikinya mengubah kandidat mana yang masuk digest.

**Kalau TIDAK diperbaiki, risikonya.** Pelaporan dan pemeringkatan terus keliru; untuk
rentang skor 62–74, kedua label berarti kebalikan dari yang tertulis. Bukan soal
keselamatan — `EARLY_RADAR` justru lebih konservatif, jadi tidak ada sinyal berbahaya
yang terbit.

**Opsi:**
- **(a)** Pindahkan cabang `EARLY_RADAR` ke **bawah** kedua cabang `PRE_SPIKE_WATCH`.
  Perubahan paling kecil, mengembalikan urutan ambang yang wajar (75 → 70 → 65 → 62).
- **(b)** Tambahkan `compositeScore < DT_INITIAL.prespike_score` ke syarat `EARLY_RADAR`.
  Eksplisit, tetapi menyisakan cabang `near_breakout` (65) yang masih terbayangi.

**Rekomendasi saya: (a).**

**Kecurigaan belum terverifikasi:** saya **tidak bisa memastikan** urutan ini
kekhilafan atau disengaja. Yang bisa saya tunjukkan adalah akibatnya — label yang
lebih kuat hanya diberikan kepada kandidat yang lebih lemah — dan itu sulit dibaca
sebagai maksud yang disengaja.

---

#### (e) BUG-042 — Hammer dan Hanging Man dibedakan hanya dari warna candle

- **Severity:** MEDIUM
- **Lokasi:** `lib/candle-pattern-engine.js:246-254`

**Apa yang salah.** Hammer (pola bullish) dan Hanging Man (pola bearish) punya bentuk
lilin yang **identik**. Yang membedakan keduanya di buku pola mana pun adalah **tren
sebelumnya**: bentuk itu di ujung tren turun namanya Hammer, di ujung tren naik
namanya Hanging Man. Kode ini tidak melihat tren sama sekali — ia hanya melihat
**warna lilin hari itu**. Lilin hijau → Hammer (bullish), lilin merah → Hanging Man
(bearish). Akibat praktisnya: sebuah hammer merah yang muncul tepat di support —
justru situasi bullish yang klasik — dinamai Hanging Man, diberi bobot bearish, dan
**memblokir `A_PLUS_SETUP`**.

**Kalau diperbaiki, efeknya — ARAHNYA: sebagian kandidat yang selama ini diblokir
akan lolos, dan skornya berubah.** Ini perubahan klasifikasi, jadi mengubah kandidat
mana yang masuk digest.

**Kalau TIDAK diperbaiki, risikonya.** Setup bullish di support terus dihukum
sebagai bearish, secara sistematis.

**Opsi:**
- **(a)** Teruskan `ctx` ke `detectSingle`, lalu pilih nama dari tren (`changePct`
  beberapa sesi, atau posisi harga terhadap `ma20`), bukan dari warna. Memperbaiki
  penyebabnya. Ukuran: sedang.
- **(b)** Pagari sisi bearish-nya saja: tambahkan syarat konteks pada Hanging Man,
  supaya tidak lagi menghukum hammer merah di support. Perubahan paling kecil,
  menghilangkan asimetri yang paling tajam, tapi tidak memperbaiki penamaannya.
- **(c)** Biarkan. Sah bila Anda memang menganggap warna sebagai proksi yang cukup
  untuk day trade — kalau begitu saya sarankan menuliskannya sebagai keputusan sadar
  di komentar modul, supaya tidak terbaca sebagai kekeliruan oleh pembaca berikutnya.

**Rekomendasi saya: (a), tetapi JANGAN diterapkan tanpa perbandingan historis.**
Ini menyentuh klasifikasi kandidat, dan saya tidak akan mengubah strategi trading Anda
atas dasar kebenaran tekstual dari buku pola saja.

---

#### (f) BUG-014 — Sentinel `0` vs "tidak diketahui" tidak konsisten

- **Severity:** LOW (laten)
- **Lokasi:** `lib/daytrade-screener-engine.js:229-230` (produsen) vs
  `lib/idx-tick-normalization.js:1081` dan `:1091` (gate)

**Apa yang salah.** Ketika rata-rata volume sebuah saham tidak diketahui, produsen
datanya menuliskan angka `0`. Tetapi gerbang yang membacanya memperlakukan `0` sebagai
"volumenya nol", bukan sebagai "tidak tahu". `lib/analyze-legacy.js` sudah melakukan
hal yang benar — menuliskan `null`. Ini contoh pola §1.4 lagi: satu modul sudah benar,
modul di sebelahnya tidak ikut.

**Kalau diperbaiki, efeknya — ARAHNYA: kandidat dengan data volume tidak lengkap
berhenti dinilai sebagai "volume nol".** Menyentuh gate/grading.

**Kalau TIDAK diperbaiki, risikonya.** Laten hari ini — saya tidak menemukan jalur
produksi yang menjangkaunya. Risikonya adalah bug ini menjadi hidup begitu jalur
data berubah.

**Opsi:** samakan penandanya — produsen mengembalikan `null` saat rata-rata tidak
diketahui, seperti yang sudah dilakukan `analyze-legacy.js`.

**Rekomendasi saya:** kerjakan bersama BUG-021/BUG-024 dalam satu PR pembersihan
laten, **setelah** keputusan-keputusan kelompok A yang aktif selesai. Tidak mendesak.

---

### 3.2 Kelompok B — BUTUH SATU KUERI PRODUKSI READ-ONLY DULU

> **Seluruh SQL di bawah ini read-only dan BELUM PERNAH SAYA JALANKAN.**
> Saya tidak punya akses DB produksi, dan aturan No. 6 Anda melarang saya menyentuh
> data produksi. Kalau Anda jalankan sendiri dan kirim hasilnya, keputusannya jadi
> jauh lebih mudah — untuk BUG-020 hasilnya bahkan menentukan apakah ini bug nyata
> atau bukan.

#### (a) BUG-020 — Observasi harga tanpa timestamp dianggap SEGAR, bukan basi

- **Severity:** MEDIUM **jika terjangkau — jangkauannya belum bisa saya pastikan**
- **Lokasi:** `api/sector-hot.js:6678`

**Apa yang salah.** Monitor entry/TP/SL menolak memakai harga yang sudah kedaluwarsa —
itu benar. Tetapi ada satu celah: kalau sebuah observasi harga datang **tanpa cap
waktu sama sekali**, kode ini menganggapnya **segar**, padahal fungsi pengecek
usianya sendiri akan menjawab "basi" untuk kasus itu. `priceTimestampStale` adalah
salah satu dari dua penjaga di gerbang ini.

**Kueri untuk memastikan (read-only, tidak mengubah apa pun, belum saya jalankan):**

```sql
select count(*) from daytrade_screener_latest
where last_price is not null and calculated_at is null;
```

**Kalau hasilnya 0**, celah ini tidak pernah terjangkau di produksi dan bisa
diturunkan jadi catatan laten. **Kalau > 0**, ini bug nyata yang menyentuh angka
yang tercatat di Track Record.

**Kalau diperbaiki, efeknya — ARAHNYA: monitor jadi LEBIH KETAT.** Observasi tanpa
timestamp akan menghasilkan `NEEDS_REVALIDATION` alih-alih mencatat hit. Itu memang
maksud kode aslinya, tapi efeknya menyentuh **angka yang tercatat di Track Record** —
karena itu menyentuh perilaku bisnis.

**Kalau TIDAK diperbaiki, risikonya.** Hit TP/SL bisa tercatat berdasarkan harga yang
usianya tidak diketahui.

**Rekomendasi saya:** jalankan kueri dulu. Perbaikannya satu baris
(`var priceTimestampStale = !!(px && (!px.at || isMonitorTimestampStale(px.at)));`)
dan sudah saya siapkan, tapi saya tidak akan menerapkannya sebelum tahu apakah ada
yang berubah.

---

#### (b) BUG-037 — Orang luar tanpa akun bisa memblokir pairing laptop admin

- **Severity:** MEDIUM
- **Lokasi:** `supabase/admin-telegram-zero-link-pairing-migration.sql:277-291`
  (pencarian kandidat) dan `:361-374` (persetujuan)

**Apa yang salah.** Untuk memasangkan laptop baru ke akun admin, sistem membuat satu
"permintaan pairing" yang harus Anda setujui dari Telegram. Supaya aman, sistem
menolak menyetujui bila ada **lebih dari satu** permintaan pending — supaya tidak
salah menyetujui punya orang lain. Tetapi hitungannya **global**, bukan per-pengguna:
siapa pun dari internet bisa terus-menerus membuat permintaan pending, dan selama
permintaan-permintaan itu ada, **Anda tidak bisa memasangkan laptop Anda sendiri.**
Ini pemblokiran layanan, bukan pengambilalihan — penyerang tidak bisa masuk, tapi
bisa mengunci Anda di luar jalur ini.

**Kueri read-only untuk melihat apakah ini pernah terjadi (belum saya jalankan):**

```sql
SELECT date_trunc('hour', created_at) AS jam,
       count(*) AS permintaan,
       count(DISTINCT requester_ip_hash) AS ip_berbeda,
       count(*) FILTER (WHERE state = 'consumed') AS berhasil
FROM public.admin_command_pair_requests
GROUP BY 1 ORDER BY 1 DESC;
```

**Kalau diperbaiki, efeknya — ARAHNYA: pairing jadi bisa diselesaikan meski ada
permintaan lain menggantung**, dengan konsekuensi Anda yang memilih mana yang benar.

**Kalau TIDAK diperbaiki, risikonya.** Satu dari tiga jalur akses admin Anda bisa
diblokir oleh orang luar, terus-menerus. Anda masih punya dua jalur lain.

**Opsi:**
- **Opsi A — admin memilih di antara beberapa kandidat (rekomendasi saya).** Ketika
  ada lebih dari satu permintaan pending, jangan menolak; tampilkan tombol per
  kandidat berlabel `display_tag` masing-masing. Alurnya sudah meminta Anda
  mencocokkan ID itu dengan layar laptop — teksnya sudah ada di
  `lib/admin-command-zero-link-pairing.js:122`: *"Pastikan ID ini sama dengan yang
  tampil di halaman maintenance laptop."*
  *Untung:* serangan ini kehilangan dayanya sepenuhnya. *Rugi:* memindahkan beban
  pembedaan ke mata Anda — kalau Anda menekan tanpa membaca ID, Anda bisa menyetujui
  browser penyerang; hari ini kesalahan itu mustahil karena sistemnya menolak duluan.
  *Ukuran:* sedang, menyentuh SQL **dan** menu Telegram.
- **Opsi B — perbaiki hanya limiternya.** Pindahkan pemeriksaan rate limit agar juga
  berlaku pada jalur daur-ulang. *Untung:* kecil, tidak menyentuh perilaku keamanan.
  *Rugi:* **tidak menyelesaikan masalahnya** — penyerang cukup memakai beberapa IP.
- **Opsi C — biarkan.** Sah; dampaknya terbatas pada satu jalur akses dan Anda punya
  dua jalur lain.

**Rekomendasi saya: Opsi A**, karena hanya opsi itu yang benar-benar menutup jalur
serangannya, dan verifikasi `display_tag` sudah menjadi bagian dari alur yang diminta
ke Anda — jadi kita tidak menambah kewajiban baru. **Tapi ini menaruh satu keputusan
keamanan di tangan manusia yang sekarang dijaga mesin, dan itu keputusan Anda.**

---

#### (c) BUG-038 — Retensi 7 hari foreign flow diam-diam tidak pernah berlaku

- **Severity:** LOW
- **Lokasi:** `lib/admin-foreign-upload.js:216-221`

**Apa yang salah.** Data foreign flow seharusnya hanya disimpan 7 hari terakhir per
saham; sisanya dibersihkan tiap upload. Pembersihnya mencari baris lama tanpa batas
jumlah, sementara Supabase membalas maksimal ~1.000 baris. Untuk universe seukuran ini,
1.000 baris pertama sudah habis oleh saham-saham di awal abjad, jadi **pembersihannya
praktis tidak pernah menjangkau sebagian besar saham** dan datanya menumpuk terus.

**Bukti bahwa ini pola yang sudah dikenal repo ini** (§1.4, contoh pertama): docstring
di `lib/stock-daily-history-store.js:54-73` mencatat bug yang persis sama, sudah
dikonfirmasi dan sudah diperbaiki di jalur sebelah, lengkap dengan peredamnya
`RETENTION_TRIM_HEADROOM = 100` yang membuat backlog terkuras bertahap lintas
beberapa run harian, bukan sekaligus. Jadi perbaikan untuk BUG-038 **bukan desain
baru dari saya** — hanya mem-port yang sudah terbukti.

**Kueri read-only untuk melihat berapa yang akan terhapus (belum saya jalankan):**

```sql
WITH ranked AS (
  SELECT id, ticker, trade_date,
         dense_rank() OVER (PARTITION BY ticker ORDER BY trade_date DESC) AS rnk
  FROM public.foreign_watchlist_daily
)
SELECT count(*) AS baris_di_luar_7_hari FROM ranked WHERE rnk > 7;
```

**Kalau diperbaiki, efeknya — ARAHNYA: baris produksi akan TERHAPUS.** Itulah sebabnya
saya berhenti di sini. Perbaikannya berjalan bertahap (headroom 100 per ticker per run),
bukan penghapusan sekaligus.

**Kalau TIDAK diperbaiki, risikonya.** Tabel terus tumbuh; aturan retensi yang
tertulis di kode tidak mencerminkan keadaan sebenarnya.

**Rekomendasi saya: perbaiki**, dengan mem-port `enforceRetention` dari
`stock-daily-history-store.js` apa adanya (anggaran baris + `.limit(fetchLimit)` +
headroom) — **bukan** patch karangan saya sendiri. Sebelumnya saya netral soal ini;
setelah menemukan docstring di atas, saya condong memperbaiki.
**Tetap saya tunggu persetujuan Anda**, karena efek nyatanya tetap penghapusan baris
produksi, dan aturan No. 6 Anda tidak membedakan apakah penghapusan itu "sudah
seharusnya terjadi" atau tidak.

---

#### (d) BUG-043 — Pengumuman kanal legacy hangus permanen bila pengiriman gagal

- **Severity:** LOW
- **Lokasi:** `lib/telegram-lifecycle.js:275-287`

**Apa yang salah.** Untuk mencegah pengumuman terkirim dua kali, sistem "mengklaim"
pengumuman itu lebih dulu, baru mengirim. Tetapi kalau pengirimannya gagal, klaimnya
**tidak dilepas**. Barisnya tercatat seolah sudah terkirim, dan percobaan berikutnya
ditolak sebagai duplikat. Pengumumannya hangus permanen, dan catatannya berbohong:
kolomnya bernama `sentAt` padahal yang terjadi hanya "diklaim".

**Kueri read-only untuk melihat keadaannya sekarang (belum saya jalankan, dan saya
tidak menyentuh data):**

```sql
SELECT announcement_key, legacy_notice_sent_at, created_at
FROM public.telegram_legacy_channel_announcements;
```

Kalau barisnya ada tetapi Anda ingat pengumumannya tidak pernah benar-benar muncul di
kanal, berarti kasus ini sudah terjadi.

**Kalau diperbaiki, efeknya — ARAHNYA: pengumuman yang gagal bisa dicoba ulang.**
Opsi A butuh migrasi.

**Kalau TIDAK diperbaiki, risikonya.** Terbatas — ini jalur legacy sekali jalan yang
mungkin memang sudah selesai dijalankan.

**Opsi:**
- **Opsi A (rekomendasi saya).** Tambah `release_legacy_channel_announcement(p_key)`
  yang menghapus baris klaim, panggil pada cabang gagal, dan pisahkan `claimed_at`
  dari `sent_at` supaya barisnya jujur. Ini menyamakan jalur pengumuman dengan
  protokol yang sudah dijelaskan modulnya sendiri. **Saya siapkan migrasinya kalau
  Anda setuju** — tapi tidak saya jalankan sendiri (aturan No. 6).
- **Opsi B.** Perbaiki **penamaannya** saja — `sentAt` → `claimedAt` di JS — sehingga
  tidak ada yang mengklaim "terkirim" untuk sesuatu yang gagal. Tanpa migrasi, tanpa
  perubahan perilaku. Menyelesaikan separuh masalah (diagnosis), bukan separuhnya
  lagi (retry).
- **Opsi C.** Biarkan.

---

### 3.3 Kelompok C — SISANYA (tidak menyentuh gate, tidak butuh kueri DB)

#### (a) BUG-013 — Token & hash password mode review ter-commit di source

- **Severity:** MEDIUM. *Saya sengaja tidak menaikkannya ke HIGH tanpa bukti lebih
  jauh — batasan dampaknya ada di blok temuannya.*
- **Lokasi:** `api/review-access.js:39` (token default), `:62` (hash password),
  `public/index.html:2161` dan `:2169`

**Apa yang salah.** Mode review (untuk peninjau app-store) dijaga oleh sebuah token
dan sebuah password. Keduanya ada **di dalam kode sumber**, dan tokennya punya nilai
default yang dipakai kalau environment tidak diset. Karena repo ini bisa dibaca,
nilai setara-kredensial itu **sudah publik**.

> Sesuai aturan No. 5 Anda: saya **tidak menampilkan nilai lengkapnya** di dokumen
> mana pun. Ini tercatat sebagai temuan, bukan sebagai kutipan nilai.

**Ini satu-satunya keputusan yang perbaikannya SUDAH SIAP.** PR #501 sudah hijau dan
berisi tiga hal: hash password diambil dari environment (gagal-tertutup bila tidak
diset), default token dihapus (`REVIEW_ACCESS_TOKEN` menjadi wajib), dan gerbangnya
gagal-tertutup.

**Kalau diperbaiki, efeknya — ARAHNYA: mode review akan MATI sampai variabel
environment diset.** Ini bukan risiko teoretis; ini akibat langsung yang pasti terjadi.

**Kalau TIDAK diperbaiki, risikonya.** Kredensial yang setara publik terus berlaku.

**Urutan tindakan yang saya sarankan — penting, jangan dibalik:**
1. Set `REVIEW_ACCESS_TOKEN` dan `REVIEW_PASSWORD_HASH` di Vercel **lebih dulu**.
2. **Rotasi password akun `review`**, terlepas dari apa pun — nilai lamanya sudah publik.
3. **Baru** merge PR #501.

Kalau PR #501 di-merge sebelum langkah 1, **alur peninjauan app-store akan terputus.**
Saya **tidak** menyentuh `.env` di Vercel maupun VPS (aturan No. 6) — langkah 1 dan 2
harus Anda yang jalankan.

---

#### (b) BUG-002 — Test yang tidak terdaftar tidak pernah dijalankan CI

- **Severity:** MEDIUM
- **Lokasi:** `tools/curated-build-tests.json` vs `test/`
  (`tools/run-build-test-suite.js:52-58`)

**Apa yang salah.** Build hanya menjalankan file test yang **terdaftar** di satu file
kurasi. Test yang ditambahkan tanpa didaftarkan menjadi test mati — ada di repo, tidak
pernah dieksekusi. Contoh nyata yang saya temukan:
`test/auth-modal-and-ai-analysis-ui.test.js` ditambahkan di PR #494 tetapi tidak
terdaftar, jadi tidak pernah dijalankan CI.

**Kalau diperbaiki, efeknya — ARAHNYA: CI bisa jadi merah**, karena test yang selama
ini diam akan mulai berjalan dan sebagian mungkin gagal.

**Kalau TIDAK diperbaiki, risikonya.** Cakupan CI lebih kecil dari yang terlihat —
regresi yang seharusnya tertangkap bisa lolos. Ini risiko meta: ia melemahkan semua
jaring pengaman yang lain.

**Opsi:**
- **(a)** Tambahkan validator yang menggagalkan build bila ada `test/*.test.js` yang
  tidak terdaftar. Menutup lubangnya secara permanen.
- **(b)** Daftarkan sisa file yang belum masuk sekarang, tanpa validator. Menyelesaikan
  hari ini, tidak menyelesaikan besok.

**Rekomendasi saya: (a)**, dijalankan dalam satu PR terpisah **setelah** 22 PR yang
terbuka sekarang selesai — karena setiap PR saya menyentuh
`tools/curated-build-tests.json` dan validator baru berpotensi membuat semuanya merah
serentak.

---

#### (c) BUG-044 — Grounding portofolio hanya menyimpan nominal terbesar

- **Severity:** LOW. **Dampak nyatanya: belum pasti.**
- **Lokasi:** `lib/ai-runtime-grounding.js:69-82`

**Apa yang salah.** Ketika Anda menyebut beberapa angka rupiah dalam satu pesan
("saya punya 50 juta, mau alokasi 10 juta ke saham ini"), sistem hanya menyimpan
**yang terbesar** sebagai konteks untuk AI. Angka yang relevan dengan pertanyaannya
bisa jadi bukan yang terbesar.

**Kalau diperbaiki, efeknya — ARAHNYA: AI dapat konteks angka yang lebih lengkap.**
Tidak menyentuh gate mana pun.

**Kalau TIDAK diperbaiki, risikonya.** Sebagian jawaban Portofolio bisa memakai angka
yang salah. **Belum pasti seberapa sering** — saya tidak punya contoh percakapan nyata
yang meleset.

**Opsi:** **(a)** simpan 2–3 nominal teratas dan biarkan model memilih; **(b)**
prioritaskan nominal yang paling dekat dengan kata kunci niat ("pakai", "alokasi",
"untuk saham ini") — lebih tepat sasaran tapi lebih banyak heuristik bahasa;
**(c)** biarkan, dan jadikan `Math.max` keputusan tertulis di komentar.

**Rekomendasi saya: (a)**, karena paling sederhana dan tidak menambah tebakan bahasa
baru. **Tapi kalau Anda punya contoh percakapan Portofolio yang jawabannya meleset,
kirimkan** — itu jauh lebih menentukan daripada tebakan saya, dan bisa langsung saya
jadikan uji regresi.

---

#### (d) BUG-019 — Diagnostik gate Top 5 melaporkan "unknown" untuk dua penyebab nyata

- **Severity:** LOW (hanya diagnostik — **tidak** mengubah gate)
- **Lokasi:** `api/sector-hot.js:4676` (`diagnosePublicSafetyGateRejection`) vs
  `api/sector-hot.js:4410` (`candidatePassesPublicTelegramSafetyGate`)

**Apa yang salah.** Ada fungsi yang tugasnya menjelaskan *kenapa* sebuah kandidat
ditolak masuk Top 5. Fungsi itu tidak tahu tentang dua penyebab penolakan yang nyata,
jadi untuk kedua kasus itu ia menjawab "unknown". Gerbangnya sendiri bekerja benar —
yang salah hanya penjelasannya.

**Kalau diperbaiki, efeknya — ARAHNYA: tidak ada perubahan perilaku sama sekali**,
hanya laporan diagnostik yang jadi jujur. Risikonya sangat rendah.

**Kalau TIDAK diperbaiki, risikonya.** Ketika Anda bertanya "kenapa saham ini tidak
masuk Top 5", sistem kadang tidak bisa menjawab. Tidak ada dampak trading.

**Rekomendasi saya:** kerjakan, tapi **paling akhir**. Saya sengaja belum membuat PR
untuk ini: ia menyentuh `api/sector-hot.js` yang sudah disentuh tiga PR terbuka
(#502, #504, #507), dan menambah PR keempat di file yang sama menaikkan risiko
konflik tanpa memberi manfaat yang mendesak.

---

#### (e) BUG-023 — `avg_volume_20d` yang dipublikasikan adalah taksiran

- **Severity:** LOW (tampilan; **tidak saya temukan gate yang membacanya**)
- **Lokasi:** `api/sector-hot.js:10905` (`calculateNkSetupScore`)

**Apa yang salah.** Angka "rata-rata volume 20 hari" yang ditampilkan ke pengguna
adalah **taksiran**, padahal angka sebenarnya sudah dihitung dan tersedia di variabel
sebelah (`q.avgVol20`). Saya telusuri pembacanya: `avg_volume_20d` ada di
`NK_STAGING_COLUMNS` dan berakhir di tampilan — bukan di gerbang keputusan.

**Kalau diperbaiki, efeknya — ARAHNYA: angka yang ditampilkan berubah menjadi yang
benar.** Perbaikannya satu baris: `var avgVolume20d = Math.round(q.avgVol20 || 0);`

**Kalau TIDAK diperbaiki, risikonya.** Angka yang salah terus ditampilkan ke pengguna.
Tidak ada keputusan trading yang berubah — sejauh yang saya telusuri.

**Rekomendasi saya:** kerjakan, digabung dengan BUG-019 dalam satu PR
`api/sector-hot.js` terakhir setelah #502/#504/#507 selesai.

---

## 4. Rekomendasi non-bug

> Aturan No. 7 Anda: *"Jangan lakukan refactor besar demi gaya. Catat utang teknis
> besar sebagai rekomendasi terpisah, jangan dieksekusi."* Ketiganya saya catat,
> **tidak** saya kerjakan — kecuali REKOMENDASI-02 yang sudah Anda lihat hasilnya.

### REKOMENDASI-01 — HTML buatan model dikirim mentah lalu dibersihkan dengan regex

- **Sifat:** rekomendasi arsitektural, **bukan** temuan bug. Saya **tidak** menemukan
  bypass yang berhasil pada kode setelah PR sanitizer saya (#499).
- **Lokasi:** `lib/analyze-legacy.js:836` (`sanitizeOutput`) dan
  `public/index.html:10560` (`sanitizeAIHtml`)

**Apa yang salah.** Jalur Analisis Saham lama menerima **HTML yang ditulis oleh model
AI** apa adanya, lalu mencoba membersihkannya dengan pencocokan pola. Nama
`sanitizeOutput` menyesatkan: isinya pembersih **format dan konten** (bintang markdown,
guard FCA, header laporan yang bocor, paragraf kosong) — ia **tidak pernah** menyentuh
`<script>`, atribut `on*`, `javascript:`, `<iframe>`, atau `<base>`. Satu-satunya
lapisan keamanan ada di sisi klien.

**Hipotesis yang saya bantah sendiri.** Saya menduga ada jalur render yang melewati
sanitizer. Tiga tempat memakai `data.html` tanpa memanggil `sanitizeAIHtml` secara
langsung (`public/index.html:5607`, `:5748`, `:5818`) — tetapi **ketiganya lewat
`addAIBubble`, dan `addAIBubble` membersihkan di dalamnya.** Jadi hipotesisnya gugur.
Saya menolak menaikkan ini menjadi temuan tanpa PoC yang benar-benar jalan.

**Yang saya sarankan (tidak saya kerjakan).** **Repo ini sudah punya jawabannya.**
`public/ai-chat-renderer.js` tidak pernah mempercayai HTML dari model — ia menerima
**teks**, meng-escape lebih dulu, baru menerapkan markdown
(`public/ai-chat-renderer.js:110-117`). Dengan urutan itu, tidak ada regex yang perlu
menebak apa yang berbahaya, karena tidak ada markup model yang pernah menjadi markup.
Menyeragamkan jalur Analisis Saham lama ke pola yang sama akan **menghapus seluruh
kelas masalah ini** — dan sekali lagi ini pola §1.4: modul yang benar sudah ada di
repo, hanya tidak diikuti.

**Kenapa tidak saya kerjakan.** Refactor besar yang menyentuh tampilan produksi:
template `decision-card`/`decision-grid`, guard FCA, dan belasan normalizer label
teknikal semuanya bergantung pada model yang benar-benar mengeluarkan HTML. Kalau
Anda mau ini dikerjakan, saya sarankan **bertahap: mulai dari jalur chat bebas**
(paling tidak bergantung template), bukan dari jalur analisis penuh.

---

### REKOMENDASI-02 — `security-gate` merah kalau registry npm sedang gangguan ✅ SELESAI & TER-MERGE

- **Status: SUDAH DIPERBAIKI dan SUDAH DI-MERGE** — PR #516, di-merge oleh pemilik
  repo pada 2026-09-04T09:14:16Z (commit `3319a5f` di `feat/daytrade-screener-v1`).
  Ini satu-satunya rekomendasi yang sudah dieksekusi, karena ia menyentuh CI,
  bukan perilaku produksi — dan satu-satunya PR audit yang sudah masuk base.

**Apa yang salah.** `security-gate` menjalankan `npm audit` sekali. Kalau registry npm
sedang tidak bisa dihubungi, gate-nya merah — bukan karena ada kerentanan, tapi karena
jaringan. Gagal acak seperti ini melatih orang mengabaikan gate keamanan.

**Yang dikerjakan (PR #516).** `tools/npm-audit-gate.sh` yang mengulang **hanya**
ketika kegagalannya benar-benar kegagalan registry (`is_registry_failure()` mencocokkan
`audit endpoint returned an error|Service Unavailable|Bad Request|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|network`,
plus exit 124 untuk timeout), **gagal langsung** kalau yang ditemukan adalah kerentanan
nyata, dan **gagal-tertutup** setelah percobaan habis dengan pesan
*"production dependencies were NOT verified"*. Tunable lewat `NPM_AUDIT_ATTEMPTS`,
`NPM_AUDIT_TIMEOUT_SECONDS`, `NPM_AUDIT_BACKOFF_SECONDS`. Test:
`test/npm-audit-gate.test.js` (8 test).

---

### REKOMENDASI-03 — Fitur "Top 5 chart image" seluruhnya kode mati

- **Sifat:** utang teknis (kode mati). **Bukan** bug — tidak terjangkau, jadi tidak
  ada perilaku yang salah hari ini.
- **Lokasi:** `api/sector-hot.js:5177`, `:5599-5612`, `:5614-5626`, `:5628-5641`,
  `:5643-5680`

**Apa yang salah.** Lima fungsi untuk mengirim gambar chart ke Telegram ada di kode,
tetapi pengirimnya (`sendTop5ChartAttachments`, `api/sector-hot.js:5643`) **tidak
pernah dipanggil dari mana pun**, dan handler yang ia tuju **tidak pernah dipasang di
router** — `api/sector-hot.js:5658` adalah satu-satunya penyebutan action itu di
seluruh repo.

**Catatan penting kalau fitur ini suatu saat dihidupkan lagi:** `getRequestBaseUrl`
harus diperbaiki **lebih dulu**. URL yang dibangun dari header permintaan diserahkan
ke Telegram, yang akan mengambilnya dari sisi server lalu memposting hasilnya sebagai
foto. `x-forwarded-host` dan `host` sama-sama berasal dari permintaan — base URL
sebaiknya diambil dari environment (`APP_BASE_URL`). **Kalau kode ini hidup, saya
akan mengangkatnya sebagai temuan; karena mati, tidak.** (Ini kelas yang sama dengan
BUG-034, yang sudah diperbaiki di PR #511.) Token HMAC-nya sendiri
(`makeTop5ChartToken`) **sudah benar** — ada kedaluwarsa dan diverifikasi terhadap
ticker.

**Yang saya sarankan (tidak saya kerjakan).** Hapus kelima fungsi itu, **atau**
hidupkan fiturnya dengan `getRequestBaseUrl` diperbaiki lebih dulu. Menghapus kode
dari `api/sector-hot.js` bukan keputusan yang pantas saya ambil sendiri.

---

### Rekomendasi tambahan yang tercatat tapi belum jadi PR

**PR lanjutan "timeout upstream — sisa `lib/`".** Setelah BUG-018 diperbaiki, saya
menyapu **seluruh repo** untuk pola yang sama: setiap `fetch(` tanpa `signal` dari
`AbortController`/`AbortSignal.timeout` dalam 14 baris berikutnya. **Hasil: 62 lokasi
di luar `test/`.** Yang paling penting dan masih terbuka:

| lokasi | fungsi | kenapa penting |
|---|---|---|
| `lib/daytrade-screener-engine.js:160` | `fetchDayTradeCandles` | **Volume tertinggi di seluruh sistem** — dipanggil per-ticker sepanjang universe Day Trade (~760 ticker pada full scan). Satu upstream menggantung menghabiskan anggaran batch. |
| `lib/daytrade-intraday-observe.js:253` | pengamat intraday | jalur observasi VPS |
| `api/quote.js:109, 666, 1067, 1115` | Supabase REST | sudah tercatat sebagai catatan BUG-005 |
| `scripts/refresh-sector-hot.js:45` | refresh operasional | dijalankan manual/cron |
| `tools/*` (11 lokasi) | skrip operasional | dijalankan operator, dampak terbatas |

Sisi frontend (`public/`, 26 lokasi) profil risikonya berbeda — ini `fetch` di browser,
tidak memakan anggaran fungsi serverless; akibat terburuknya spinner berputar selamanya.
Dua file sudah punya pembungkus timeout sendiri (`public/portfolio-supabase-sync.js:115`,
`public/portfolio-command-center.js:103`), yang menunjukkan polanya sudah dikenal di
repo ini — hanya belum merata. `_disabled_api_backup/analyze.real.js` (5 lokasi)
diabaikan: direktori nonaktif, tidak dimuat runtime.

**Belum saya kerjakan** karena sudah ada 22 PR terbuka dan saya tidak mau melebarkan
#502 yang sudah hijau. **Katakan saja kalau Anda mau PR itu dibuat.**

---

## 5. Peta cakupan — yang SUDAH dibaca penuh

88 file, 48.811 baris, dibaca **baris 1 sampai baris terakhir** (bukan grep).

### `api/` — 12/12 SELESAI, 19.046 baris, **100% tuntas**

| file | baris | hasil |
|---|---:|---|
| `api/sector-hot.js` | 13.902 | **10 temuan.** Dibaca utuh 1–13902. BUG-018 (diperbaiki #502), BUG-022 (#504), BUG-017, BUG-019, BUG-021, BUG-023, BUG-024, BUG-025, BUG-020, REKOMENDASI-03. File terbesar dan paling produktif di seluruh audit. |
| `api/quote.js` | 2.747 | **2 temuan.** Dibaca utuh 2747/2747. BUG-015 (RSI datar) + 4 `fetch` tanpa timeout. |
| `api/login-user.js` | 568 | **bersih** — webhook secret constant-time, gate same-origin, anti-enumerasi. |
| `api/admin-users.js` | 474 | **bersih** — setiap aksi privileged lewat `requireBudiAdmin` (same-origin + sesi). |
| `api/review-access.js` | — | menghasilkan **BUG-013** (menunggu keputusan; perbaikannya siap di PR #501). |
| `api/analyze.js`, `api/candles.js`, dan 6 file `api/` lain | — | dibaca penuh; BUG-015 salinan di `api/candles.js:292`, sisanya bersih. |

### `lib/` — 70 SELESAI (27.144 baris), 1 SEDANG, 86 BELUM

Yang besar/penting dan **bersih**:

| file | baris | hasil |
|---|---:|---|
| `lib/telegram-verification.js` | 1.527 | **bersih** — modul paling sadar-keamanan yang saya baca setelah `idx-tick-normalization.js`. |
| `lib/trade-plan-v2.js` | 1.319 | **bersih sebagai mesin.** Seluruh modul hanya aktif di belakang flag `TRADE_PLAN_V2`. |
| `lib/context-ai-router-v4.js` | 1.161 | **bersih** — modul paling disiplin kedua. |
| `lib/telegram-templates.js` | 760 | **bersih.** Satu catatan konsistensi tampilan (rentang entry dirender tiga cara berbeda dalam satu modul). |
| `lib/context-ai-router-v5.js` | 551 | **bersih.** `requestKey` (`:301-305`) sudah memuat `userId` + konteks — kontras langsung dengan BUG-028 di v7. |
| `lib/daytrade-outcome-collector.js` | 535 | **bersih.** Validasi path anti-symlink, wajib di luar repo. |
| `lib/intraday-fast-watcher.js` | 509 | **bersih.** Shadow-only dan menegakkannya sendiri. |
| `lib/admin-access-legacy.js` | 500 | **bersih.** Dibaca penuh; challenge dorman. |
| `lib/security-guard.js` | 469 | **bersih.** `getMode` default `enforce` di produksi (gagal-tertutup). |
| `lib/reset-password-legacy-handler.js` | 431 | **bersih.** Secret dibandingkan timing-safe, body dibatasi 32 KB. `trustedRateLimitIp()` (`:297-306`) hanya memakai `x-vercel-forwarded-for` — **disiplin yang persis tidak dimiliki BUG-034**. |
| `lib/auth-recovery.js` | 406 | **bersih.** Token reset 256 bit, hanya hash yang disimpan. |
| `lib/admin-maintenance-code-browser.js` | 356 | **bersih.** Kode 6 digit dijaga berlapis; lockout 5 percobaan ada di `supabase/admin-telegram-maintenance-code-migration.sql:277-294`. |
| `lib/voucher-admin-bot.js` | 333 | **bersih.** Klaim/prepare/deliver/finalize per-chat. |
| `lib/telegram-unified-subscription.js` | 332 | **bersih.** Gate admin, chat privat, `chat.id === from.id`. |
| `lib/telegram-notifier.js` | 326 | **bersih.** Tidak pernah melempar, setiap `fetch` dibatasi `AbortController`. |
| `lib/daily-market-context-builder.js` | 355 | **bersih** sebagai modul — **nyaris** saya laporkan sebagai bug RSI; lihat §6 "kecurigaan yang saya tarik kembali". Menghasilkan BUG-040 di sisi wiring-nya. |

Yang **menghasilkan temuan**:

| file | baris | temuan |
|---|---:|---|
| `lib/daytrade-screener-engine.js` | 2.908 | BUG-026 (`:880-884` vs `:887`), BUG-014 (`:229-230`) |
| `lib/analyze-legacy.js` | 1.769 | BUG-005 (diperbaiki #497), BUG-029 (#506), BUG-007, BUG-015 salinan |
| `lib/idx-tick-normalization.js` | 1.124 | BUG-027 HIGH (`:837`, `:881`) |
| `lib/telegram-delivery.js` | 931 | BUG-030 HIGH (diperbaiki #507) |
| `lib/trade-plan-v2-integration.js` | 675 | BUG-021 (`:135-136`, laten) |
| `lib/admin-users-handler.js` | 580 | BUG-032 (diperbaiki #509) |
| `lib/user-watchlist-service.js` | 550 | BUG-031 HIGH (diperbaiki #508) |
| `lib/context-ai-router-v7.js` | 535 | BUG-010, BUG-028 CRITICAL (diperbaiki #505) |
| `lib/trade-plan-v2-source-adapters.js` | 498 | BUG-021 (`:129-130`, `:209-210`, `:338-339`) |
| `lib/candle-pattern-engine.js` | 379 | BUG-042 (`:246-254`). Geometri pola lain diperiksa satu per satu dan **benar**. |
| `lib/daily-history-collector.js` | 372 | BUG-039 (diperbaiki #513) |
| `lib/subscription-manual-handler.js` | 337 | BUG-034 + BUG-035 (diperbaiki #511) |
| `lib/admin-command-zero-link-pairing.js` | 323 | terkait BUG-037 (akar masalahnya di SQL) |
| `lib/daytrade-ohlcv-cache.js` | 319 | BUG-033 (diperbaiki #510) |
| `lib/telegram-lifecycle.js` | 317 | BUG-043. Jalur reminder & review request **bersih**. |
| `lib/ai-gemini-provider.js` | 309 | BUG-036 HIGH (diperbaiki #512) |

### `public/` — 4 SELESAI (2.071 baris), 1 SEDANG, 59 BELUM

| file | baris | hasil |
|---|---:|---|
| `public/portfolio-ai-runtime-v2.js` | 773 | BUG-008/009/010 (diperbaiki #498) |
| `public/stock-analysis-ai.js` | 694 | **bersih**; `describeFailure` jadi acuan kontrak error untuk `index.html` |
| `public/track-record-runtime.js` | 308 | BUG-016 (diperbaiki #503). Dibaca 1–308. |
| `public/index.html` | 11.127 | **SEDANG** — bagian yang dibaca menghasilkan BUG-001 (CRITICAL, diperbaiki #495), BUG-003/004/006 (#497), BUG-011 (#499), BUG-012 (#500), BUG-007. **File terbesar yang belum tuntas.** |

### `(root)` — 2 SELESAI

`vercel.json` (532 baris) — **bersih**; header keamanan, cache policy, cron 08:00 WIB.

### `supabase/`, `tools/`, `test/`, `scripts/` — 0 SELESAI

Tiga file `supabase/` berstatus SEDANG (fungsi kunci diperiksa penuh, sisa file belum):
`admin-telegram-access-migration.sql` (885), `auth-telegram-recovery-v1-migration.sql`
(527), `auth-recovery-v1-telegram-message-redaction-hotfix.sql` (187).
`tools/curated-build-tests.json` SEDANG → BUG-002.
`lib/intraday-fast-watcher-publisher.js` SEDANG (`:160-240` dibaca untuk menelusuri
konvensi `entry1`/`entry2`).

---

## 6. Peta cakupan — yang BELUM disentuh sama sekali

**684 file, 137.733 baris (68,8% dari repo).**

### `test/` — 358 file, 68.701 baris — **RISIKO RENDAH, boleh menunggu**

Setengah dari seluruh backlog baris ada di sini. Ini kode test, bukan kode produksi:
bug di sini tidak menyentuh pengguna. **Tapi ada satu nuansa yang perlu diteruskan:**
BUG-002 menunjukkan sebagian test **tidak pernah dijalankan**, dan §1.4 menunjukkan
**test per-modul yang hijau bisa menyembunyikan bug di seam antar-modul**. Jadi nilai
membaca `test/` bukan mencari bug di dalamnya, melainkan **mencari apa yang tidak
diuji**. Terbesar: `test/one-time-ai-research-all.test.js` (1.367),
`test/admin-telegram-access.test.js` (1.192), `test/fast-watcher-early-watch.test.js`
(1.186), `test/telegram-verification-v2.test.js` (1.110).

### `lib/` — 86 file, 21.323 baris — **RISIKO TERTINGGI, baca ini dulu**

Ini backlog produksi terbesar. Terpusat pada satu klaster:

| file | baris | perannya (sejauh yang saya tahu) |
|---|---:|---|
| `lib/intraday-shadow-scoring.js` | 1.261 | penilaian intraday mode shadow |
| `lib/intraday-shadow-trade-backtest.js` | 1.187 | backtest shadow |
| `lib/intraday-shadow-scoring-live.js` | 1.012 | penilaian shadow jalur live |
| `lib/daytrade-intraday-dry-run-gate.js` | 699 | **gate** dry-run intraday |
| `lib/intraday-fast-watcher-early-watch.js` | 575 | early-watch fast watcher |
| `lib/daytrade-intraday-policy.js` | 572 | **kebijakan** intraday |
| `lib/daytrade-experimental-admin-alert.js` | 554 | alert admin eksperimental |
| `lib/trade-plan-v2-daytrade-diagnostic.js` | 521 | diagnostik trade plan v2 |
| `lib/trade-plan-v2-sweep-diagnostic.js` | 475 | diagnostik sweep |
| `lib/trade-plan-v2-liquidity-sweep.js` | 449 | deteksi liquidity sweep |
| `lib/daytrade-intraday-staged-enable-runbook.js` | 439 | runbook pengaktifan bertahap |
| `lib/intraday-sample-summary.js` | 404 | ringkasan sampel intraday |

**Kenapa ini prioritas nomor satu:** empat file di dalamnya berisi kata `gate`,
`policy`, atau `scoring` — dan setiap temuan HIGH/CRITICAL saya sejauh ini datang dari
kelas file seperti itu. Klaster `intraday-shadow-*` saja 3.460 baris.

**Peredamnya (jujur):** `lib/intraday-fast-watcher.js` yang **sudah** saya baca
ternyata **bersih** dan menegakkan mode shadow-nya sendiri (`mode !== 'shadow'`).
Jadi ada kemungkinan klaster ini seluruhnya shadow-only dan tidak menyentuh produksi.
**Itu kecurigaan belum terverifikasi** — saya belum membaca file-filenya, jadi saya
tidak bisa memastikannya ke arah mana pun.

### `public/` — 59 file, 20.197 baris — **RISIKO CAMPURAN**

| file | baris | catatan |
|---|---:|---|
| `public/premium-workstation-core.css` | 2.268 | CSS — risiko rendah |
| `public/ui-theme.css` | 2.222 | CSS — risiko rendah |
| `public/market-feature-runtime.js` | 1.095 | **JS runtime — risiko sedang/tinggi** |
| `public/assets/idx-tickers.js` | 997 | daftar data — risiko rendah |
| `public/index-shell.css` | 738 | CSS — risiko rendah |
| `public/portfolio-command-center.js` | 602 | **JS runtime — jalur P2 Portofolio** |
| `public/pattern-stable-runtime.js` | 520 | JS runtime |
| `public/admin-maintenance-code.js` | 482 | **jalur akses admin** |
| `public/mobile-nav.js` | 473 | navigasi |
| `public/account-center-v1.js` | 449 | **jalur akun/auth** |
| `public/subscription-manual-payment-v1.js` | 438 | **jalur pembayaran** (sisi klien dari BUG-034/035) |

Sekitar 5.800 baris di antaranya CSS murni — bisa dilewati. Sisanya JS runtime.

> **Kecurigaan yang SUDAH saya verifikasi dan BUKAN bug** — supaya sesi berikutnya
> tidak menelusurinya lagi: `public/portfolio-command-center.js` mengirim header
> `X-User-Id`/`X-Username` lewat `authHeaders()`. Saya periksa sisi server: header itu
> **tidak dipercaya di mana pun**. Satu-satunya penyebutannya di server adalah komentar
> yang menyatakan header itu **ditolak secara eksplisit** — `api/quote.js:64-68` dan
> `api/sector-hot.js:7232`, `:7254`, `:7438`, `:7460`, `:9926`. **Bukan temuan.**
> (File ini tetap **BELUM tuntas dibaca**; saya hanya menelusuri satu pertanyaan itu,
> jadi statusnya bukan SELESAI.)

### `tools/` — 75 file, 13.336 baris — **RISIKO RENDAH, boleh menunggu**

Skrip operasional yang dijalankan operator, bukan jalur permintaan pengguna.
Terbesar: `tools/one-time-ai-research-all.js` (1.501),
`tools/intraday-sample-collector.js` (939), `tools/report-telegram-outcomes.js` (734),
`tools/run-ai-eval-cloud.js` (631). Sebelas di antaranya punya `fetch` tanpa timeout
(sudah tercatat di §4).

Satu pengecualian yang tidak boleh dianggap rendah: `tools/curated-build-tests.json`
(SEDANG) — sumber BUG-002.

### `supabase/` — 46 file, 7.333 baris — **RISIKO TINGGI per baris**

Folder terkecil dengan risiko per baris tertinggi: **BUG-037 hidup di sini**, dan
gate identitas beberapa jalur admin memang ditegakkan di SQL, bukan di JS.

| file | baris |
|---|---:|
| `supabase/telegram-verification-v2-migration.sql` | 561 |
| `supabase/telegram-member-lifecycle-hotfix.sql` | 477 |
| `supabase/security-phase-1-migration.sql` | 472 |
| `supabase/admin-telegram-command-login-migration.sql` | 445 |
| `supabase/admin-telegram-zero-link-pairing-migration.sql` | 409 |
| `supabase/subscription-phase-5c-voucher-admin-migration.sql` | 404 |
| `supabase/telegram-verification-v2-approval-gate-hotfix.sql` | 339 |
| `supabase/admin-telegram-maintenance-code-migration.sql` | 335 |

### `scripts/` — 7 file, 1.492 baris — **RISIKO SEDANG**

Kecil tapi tidak sepele: `scripts/collect-daily-market-context.js` (191) adalah
pemanggil produksi yang **membuat satu bahaya RSI menjadi tidak terjangkau** (lihat
di bawah). `scripts/apply-auth-reset-telegram-redaction-hotfix.js` (468),
`scripts/refresh-sector-hot.js` (304, `fetch` tanpa timeout di `:45`),
`scripts/idx-sync/sync_stock_summary_dates.ts` (275).

### `_disabled_api_backup/` — 8 file, 2.782 baris — **ABAIKAN**

Direktori nonaktif, tidak dimuat runtime. Terbesar `analyze.real.js` (1.632, 5 `fetch`
tanpa timeout — sudah saya kecualikan dari inventaris §4).

### `.github/` — 14 file, 1.074 baris — **RISIKO RENDAH**, sebagian sudah tersentuh

`security-gate.yml` sudah diubah di PR #516. Sisanya belum dibaca sebagai audit,
tetapi saya sudah memeriksa pemicunya untuk memverifikasi CI (lihat catatan
`migrations` di §7).

### `.agents/` (23 file, 637 baris) dan `deploy/` (3 file, 150 baris) — **RISIKO RENDAH**

Metadata task dan skrip deploy VPS.

### `(root)` — 5 file, 708 baris

`test-risk-guard.js` (489), `package-lock.json` (117), `intraday-sample.sh` (52),
`tailwind.config.js` (47), `tailwind.src.css` (3).

---

### Kecurigaan yang belum terverifikasi — **dilabeli eksplisit**

Ini hal-hal yang saya curigai tetapi **belum bisa saya buktikan**. Jangan diperlakukan
sebagai temuan, dan jangan dibuang begitu saja.

1. **Besaran BUG-025 (300 karakter) — belum terverifikasi.** Berapa banyak kandidat
   nyata yang teks gabungannya melewati 300 karakter. Butuh data produksi. Ini alasan
   saya menyarankan pengukuran dry-run lebih dulu (§3.1 b).
2. **Jangkauan BUG-020 — belum terverifikasi.** Apakah ada baris dengan `last_price`
   terisi tapi `calculated_at` kosong. Satu kueri menjawabnya (§3.2 a).
3. **Apakah BUG-026 disengaja — belum terverifikasi.** Saya tidak bisa memastikan
   urutan cabang itu kekhilafan atau keputusan sadar.
4. **Dampak nyata BUG-044 — belum terverifikasi.** Saya tidak punya contoh percakapan
   Portofolio yang jawabannya benar-benar meleset karena ini.
5. **Klaster `lib/intraday-shadow-*` (3.460 baris) — belum terverifikasi.** Saya
   menduga seluruhnya shadow-only dan tidak menyentuh produksi, karena
   `lib/intraday-fast-watcher.js` yang bertetangga terbukti begitu. **Saya belum
   membacanya**, jadi dugaan ini bisa salah ke arah mana pun.

### Bahaya laten yang saya catat tapi TIDAK saya naikkan jadi temuan

Ini disiplin yang saya jaga sepanjang audit: kalau setelah menelusuri pemanggilnya
sebuah kecurigaan ternyata **tidak terjangkau**, saya tidak menaikkannya jadi bug —
tapi saya catat supaya tidak hilang.

- **RSI seed 15 sesi di jalur batch.** Rekursi Wilder: dengan tepat `period+1` harga
  penutupan, loop penghalusan `for (k = period; k < gains.length; k++)` **tidak pernah
  berjalan**, jadi yang keluar adalah RSI seed yang belum dihaluskan. **Tidak
  terjangkau** karena `scripts/collect-daily-market-context.js:150-157` mengecualikan
  ticker yang gagal/dilewati sebelum jalur itu tercapai. Tiga syarat yang akan
  membuatnya nyata tercatat lengkap di `AUDIT_FINDINGS.md`.
- **Cabang mati `calcConfirmation`** (`if (X) return A; return A;`) — `confirmation`
  tidak dikonsumsi di mana pun.
- **Idempotency key yang dikendalikan klien** di `subscription-voucher-handler.js`.
- **Pengiriman ulang at-least-once saat commit gagal** di `telegram-lifecycle.js`
  (berbeda dari BUG-043, yang arahnya justru kebalikan).
- **`calcMA` membagi dengan `period`**, bukan dengan jumlah nilai yang benar-benar
  dijumlahkan.

### Hipotesis yang saya periksa dan **terbantah** — jangan diulang

- Jalur render AI yang melewati sanitizer → **terbantah**, ketiganya lewat
  `addAIBubble` yang membersihkan di dalamnya (REKOMENDASI-01).
- Chain `context-ai-router` v4/v5/v6 orphan → **terbantah**, bukan orphan.
- `verifyHighConvictionTelegramSignal` bocor → **terbantah**.
- IDOR pada otorisasi portofolio → **terbantah**, tidak ada.
- **Rahasia ter-commit** → diperiksa; satu-satunya hasilnya adalah BUG-013, yang
  nilainya **tidak saya tampilkan** (aturan No. 5).
- Header `X-User-Id`/`X-Username` dipercaya server → **terbantah** (§6, `public/`).

---

## 7. Tabel lengkap PR

Semua PR berbasis **`feat/daytrade-screener-v1`**. Status CI **diverifikasi ulang
4 September 2026** lewat `get_check_runs` pada commit HEAD masing-masing.

Enam check wajib: `security-gate`, `build-and-focused-tests`, `command-login`,
`portfolio-persistence`, `Analyze JavaScript` (CodeQL), dan `migrations`.

> **Catatan tentang `migrations`.** Job ini path-filtered — ia hanya berjalan kalau
> PR menyentuh path yang terdaftar. `.github/workflows/phase5c-postgres.yml` memicunya
> pada `test/subscription-*.test.js`, dan `.github/workflows/admin-access-postgres.yml`
> pada `lib/admin-access.js`/`api/reset-password.js`/dll. Karena itu `migrations`
> **hanya muncul di PR #511**; di PR lain ia tidak dijalankan sama sekali (bukan gagal,
> bukan pending). Ini perilaku yang benar, bukan celah.

| PR # | Judul | Isi | Status CI (diverifikasi sekarang) | Draft? | Ketergantungan ke PR lain |
|---|---|---|---|---|---|
| #495 | `fix(auth): move login/register/reset modals out of #dashboardScreen` | **BUG-001 CRITICAL (P0)** — `public/index.html` | ✅ HIJAU (6/6) | Draft | ⚠️ `public/index.html` bersama #497, #499, #500, #501 |
| #496 | `docs(audit): repo-wide audit coverage inventory and findings log` | `AUDIT_COVERAGE.md`, `AUDIT_FINDINGS.md` **(+ dokumen ini)** | ⚠️ **5/6 — `build-and-focused-tests` TIDAK PERNAH JALAN** (path-filtered; lihat catatan di bawah tabel). GitHub melaporkan `mergeable_state: "blocked"` | Draft | Tidak ada tumpang-tindih file, tapi **terblokir** — butuh keputusan Anda |
| #497 | `fix(ai): surface real analyze failures, drop stale results, bound providers` | **BUG-003, 004, 005, 006** — `lib/analyze-legacy.js`, `public/index.html` | ✅ HIJAU (6/6) | Draft | ⚠️ `public/index.html` (×4); `lib/analyze-legacy.js` bersama **#506** |
| #498 | `fix(portfolio-ai): stop understating portfolio risk and hiding real rejections` | **BUG-008, 009, 010** — `lib/context-ai-router-v7.js`, `public/portfolio-ai-runtime-v2.js` | ✅ HIJAU (6/6) | Draft | ⚠️ `lib/context-ai-router-v7.js` bersama **#505** |
| #499 | `fix(security): strip inline event handlers on every separator the parser accepts` | **BUG-011** — `public/index.html` | ✅ HIJAU (6/6) | Draft | ⚠️ `public/index.html` (×4) |
| #500 | `fix(wib): stop double-counting the zone offset in getWIBDateString()` | **BUG-012** — `public/index.html` | ✅ HIJAU (6/6) | Draft | ⚠️ `public/index.html` (×4) |
| #501 | `fix(security): make review access fail closed and take both secrets from env` | **BUG-013** — `api/review-access.js`, `public/index.html` | ✅ HIJAU (6/6) | Draft | ⚠️ `public/index.html` (×4). **🔴 JANGAN MERGE sebelum env Vercel diset — lihat §3.3 (a)** |
| #502 | `fix(screener): bound the three unbounded upstream fetches in sector-hot (BUG-018)` | **BUG-018** — `api/sector-hot.js` | ✅ HIJAU (6/6) | Draft | ⚠️ `api/sector-hot.js` bersama **#504, #507** |
| #503 | `fix(track-record): render the entry range low to high, not high to low (BUG-016)` | **BUG-016** — `public/track-record-runtime.js` | ✅ HIJAU (6/6) | Draft | Tidak ada |
| #504 | `fix(screener-nk): drop Yahoo sessions with missing OHLC before deriving levels (BUG-022)` | **BUG-022** — `api/sector-hot.js` | ✅ HIJAU (6/6) | Draft | ⚠️ `api/sector-hot.js` (×3) |
| #505 | `fix(ai): jawaban Portofolio AI satu pengguna bisa tersaji ke pengguna lain` | **BUG-028 CRITICAL** — `lib/context-ai-router-v7.js` | ✅ HIJAU (6/6) | Draft | ⚠️ `lib/context-ai-router-v7.js` bersama **#498** |
| #506 | `fix(analisis-saham): angka apa pun di pesan dibaca sebagai harga saham` | **BUG-029 HIGH** — `lib/analyze-legacy.js` | ✅ HIJAU (6/6) | Draft | ⚠️ `lib/analyze-legacy.js` bersama **#497** |
| #507 | `fix(telegram): satu pesan gagal meracuni seluruh batch Top 5` | **BUG-030 HIGH** — `lib/telegram-delivery.js`, `api/sector-hot.js` | ✅ HIJAU (6/6) | Draft | ⚠️ `api/sector-hot.js` (×3) |
| #508 | `fix(security): alert watchlist bisa diarahkan ke chat Telegram siapa pun` | **BUG-031 HIGH** — `lib/user-watchlist-service.js` | ✅ HIJAU (6/6) | Draft | Tidak ada |
| #509 | `fix(security): reset password oleh admin menyimpan hash mentah tanpa validasi` | **BUG-032** — `lib/admin-users-handler.js` | ✅ HIJAU (6/6) | Draft | Tidak ada |
| #510 | `fix(cache): TTL 12 jam di luar jam bursa tidak pernah benar-benar berlaku` | **BUG-033** — `lib/daytrade-ohlcv-cache.js` | ✅ HIJAU (6/6) | Draft | Tidak ada |
| #511 | `fix(subscription): stop trusting request headers and re-notifying on manual payment review` | **BUG-034 + BUG-035** — `lib/subscription-manual-handler.js` | ✅ HIJAU (**7/7** — satu-satunya PR yang juga menjalankan `migrations`) | Draft | Tidak ada |
| #512 | `fix(ai): keep the Gemini abort timer armed across the response body read` | **BUG-036 HIGH** — `lib/ai-gemini-provider.js` | ✅ HIJAU (6/6) | Draft | Tidak ada |
| #513 | `fix(history): chain previous_close across the retention trim boundary` | **BUG-039** — `lib/daily-history-collector.js` | ✅ HIJAU (6/6) | Draft | Tidak ada |
| #514 | `fix(volume): give buildVolumeContext the eighth row it needs on a partial session` | **BUG-040** — `lib/daily-market-context-builder.js` | ✅ HIJAU (6/6) | Draft | Tidak ada |
| #515 | `fix(calendar): stop a quiet holiday window from reading as an unverified calendar` | **BUG-041** — `lib/idx-trading-calendar.js` | ✅ HIJAU (6/6) | Draft | Tidak ada |
| ~~#516~~ | `fix(ci): retry the npm audit gate when the registry never answers` | **REKOMENDASI-02** — `.github/workflows/security-gate.yml`, `tools/npm-audit-gate.sh` | ✅ **SUDAH DI-MERGE** 2026-09-04T09:14:16Z → commit `3319a5f` | — | — |

> ### 🔴 Kenapa PR #496 terblokir — dan pilihan Anda
>
> `build-and-focused-tests` adalah salah satu dari 6 check wajib branch
> protection, tapi ia didefinisikan di
> `.github/workflows/web-hardening-regression.yml:7-16` dengan path filter:
> `public/**`, `api/**`, `lib/**`, `test/**`, `tools/**`, `.agents/**`,
> `package.json`, `package-lock.json`.
>
> PR #496 hanya mengubah tiga file `.md` di root repo. **Tidak satu pun cocok
> dengan filter itu**, jadi workflow-nya tidak pernah terpicu, check-nya tidak
> pernah muncul, dan branch protection menunggu selamanya sesuatu yang tidak
> akan pernah datang. Bukti bahwa ini spesifik #496 dan bukan aturan umum:
>
> | PR | draft? | base | `mergeable_state` | `build-and-focused-tests` |
> |---|---|---|---|---|
> | #496 (dokumentasi) | ya | `feat/daytrade-screener-v1` | **`blocked`** | **tidak ada** |
> | #513 (kode) | ya | `feat/daytrade-screener-v1` | `clean` | ada, lulus |
>
> **Ini bukan bug di kode Anda dan bukan kegagalan CI** — ini interaksi antara
> "required check" dan "path filter" yang memang dikenal di GitHub. Tapi
> akibatnya nyata: **PR dokumentasi apa pun tidak akan pernah bisa di-merge.**
>
> **Opsi, tidak satu pun saya kerjakan (semuanya menyentuh kebijakan CI):**
>
> - **(a) Tambahkan pola Markdown ke daftar `paths` di
>   `web-hardening-regression.yml`.** Paling sederhana. Efeknya: setiap PR
>   dokumentasi ikut menjalankan suite 320 test, termasuk PR yang hanya mengubah
>   satu kata.
> - **(b) Tambahkan job pendamping** dengan filter terbalik yang melaporkan
>   sukses seketika untuk perubahan non-kode. Ini pola resmi GitHub untuk
>   required check yang path-filtered. Lebih tepat, tapi menambah satu job ke
>   matriks CI.
> - **(c) Lepaskan `build-and-focused-tests` dari daftar required check** di
>   pengaturan branch protection. **Hanya Anda yang bisa** — saya tidak punya
>   akses ke pengaturan repo, dan saya juga tidak menyarankannya: itu
>   melemahkan gerbang untuk seluruh PR kode demi satu PR dokumentasi.
> - **(d) Merge #496 lewat admin override.** Sah untuk PR yang isinya nol kode
>   dan nol konfigurasi, tapi itu keputusan Anda, bukan saya.
>
> **Rekomendasi saya: (b), sebagai PR tersendiri.** (Semula saya menyarankan
> menggabungkannya ke PR #516 — **itu tidak lagi mungkin, #516 sudah di-merge.**)
> Opsi (b) memperbaiki kelasnya sekali untuk semua PR dokumentasi berikutnya,
> tanpa menjalankan suite kode pada perubahan Markdown dan tanpa melemahkan
> gerbang mana pun. **Belum saya kerjakan** — mengubah definisi gerbang CI bukan
> keputusan yang pantas saya ambil sendiri.
>
> **Sampai salah satu opsi dipilih, `AUDIT_COVERAGE.md`, `AUDIT_FINDINGS.md`
> dan `AUDIT_CHECKPOINT.md` tetap hidup di branch
> `docs/audit-coverage-and-findings` dan bisa dibaca di sana — dokumennya tidak
> hilang, hanya belum bisa masuk ke base branch.**
>

**PR dependabot (BUKAN milik saya, tidak saya sentuh):**

| PR # | Judul | Status | Draft? |
|---|---|---|---|
| #464 | `chore(deps): bump @supabase/supabase-js from 2.106.1 to 2.112.4` | tidak saya verifikasi | Ready |
| #465 | `chore(deps): bump github/codeql-action/analyze from 4.37.7 to 4.37.9` | tidak saya verifikasi | Ready |
| #466 | `chore(deps): bump github/codeql-action/init from 4.37.7 to 4.37.9` | tidak saya verifikasi | Ready |

### Peta tumpang-tindih file antar-PR — **baca sebelum menambah PR baru**

**Setiap PR (kecuali #496) menyentuh `tools/curated-build-tests.json`** untuk
mendaftarkan test barunya. Itu satu baris tambahan per PR — konfliknya sepele dan
selalu bisa diselesaikan dengan mempertahankan **kedua** baris. Tapi itu berarti
**merge berurutan akan memicu konflik di file itu setiap kali.**

Tumpang-tindih yang sungguh perlu perhatian:

| file | PR yang menyentuhnya | catatan |
|---|---|---|
| `public/index.html` | **#495, #497, #499, #500, #501** | 11.127 baris; lima PR di area berbeda, tapi tetap perlu urutan merge yang sadar |
| `api/sector-hot.js` | **#502, #504, #507** | 13.902 baris; tiga PR di fungsi berbeda |
| `lib/analyze-legacy.js` | **#497, #506** | dua PR |
| `lib/context-ai-router-v7.js` | **#498, #505** | dua PR |

**Urutan merge yang saya sarankan (diperbarui setelah #516 di-merge):**
~~#516~~ (sudah) → #495 → #497 → #499 → (#501 **hanya setelah env Vercel diset**) →
#502 → #504 → #507 → #498 → #505 → #506 → #500 → sisanya (bebas urutan).
#496 menunggu keputusan blocker di atas.

**Tapi sebelum urutan itu bisa dijalankan: 15 PR (#500, #502–#515) harus
di-merge-kan dulu dengan base yang baru** — semuanya konflik di
`tools/curated-build-tests.json`. Resolusinya mekanis dan sama untuk semuanya:
**pertahankan KEDUA entri** (milik #516 dan milik PR bersangkutan). Tidak ada
logika yang berubah; file itu hanya daftar berkas test yang dijalankan CI.
**Setiap merge base berikutnya akan memicu konflik yang sama lagi** pada PR yang
belum di-merge — itu sifat dari 21 PR yang semuanya menambah baris ke ujung satu
file yang sama.

---

## 8. Instruksi untuk sesi/alat berikutnya (Antigravity)

### 8.1 Prinsip kerja yang saya pakai — pertahankan

1. **Jangan menebak. Baca kodenya.** Setiap klaim bug wajib menyebut
   `path/file.js:baris` **dan mengutip kode aslinya**. Jangan mengomentari file yang
   belum dibaca.
2. **Jangan mengarang temuan supaya laporannya terlihat penuh.** Kalau satu modul
   bersih, tulis **"bersih"** plus apa saja yang diperiksa. Ada 15+ blok "bersih" di
   `AUDIT_FINDINGS.md` — itu bagian dari hasilnya, bukan ruang kosong.
3. **`SELESAI` hanya boleh untuk file yang dibaca baris 1 sampai baris terakhir.**
   Hasil grep **bukan** SELESAI. Kalau baru sebagian, tulis SEDANG dan sebutkan
   rentang barisnya.
4. **Telusuri pemanggilnya sebelum menaikkan sesuatu jadi temuan.** Lima kecurigaan
   saya gugur di langkah ini (daftar di §6). Itu fitur, bukan kekurangan.
5. **Satu PR = satu kelompok masalah.** Jangan menggabung perbaikan auth dengan
   perbaikan AI portofolio dalam satu PR.
6. **Jangan pernah push langsung ke branch terproteksi.** Branch baru `fix/<slug>`,
   commit, buka PR draft, pastikan **6 status check hijau**.
7. **Jangan commit rahasia.** Kalau menemukan rahasia ter-commit, laporkan sebagai
   temuan CRITICAL **tanpa menampilkan nilai lengkapnya**.
8. **Jangan menghapus data/tabel/file produksi.** Jangan menjalankan migrasi
   destruktif. Jangan mengubah `.env` di VPS/Vercel tanpa persetujuan pemilik.
9. **Sebelum mengubah perilaku bisnis (rumus entry/SL/TP, gate, ranking), tanya
   dulu.** Bug fix ≠ mengubah strategi trading.
10. **Jalankan build sebelum dan sesudah setiap perubahan, laporkan deltanya.**
    Perintahnya `node tools/run-build-test-suite.js` — **320 file test**. Tidak ada
    script lint maupun typecheck di repo ini; jangan mengarang keberadaannya.
11. **Setiap perbaikan datang dengan test yang GAGAL pada kode lama.** Kalau test
    barunya lulus pada kode sebelum perbaikan, testnya yang salah, bukan bug-nya yang
    tidak ada. Saya kena jebakan ini tiga kali; ketiganya tercatat di
    `AUDIT_FINDINGS.md` sebagai catatan proses, termasuk satu kali di mana **test yang
    sudah ada ternyata benar dan perbaikan pertama saya yang salah** — saya buang
    perbaikan saya, bukan test-nya.

### 8.2 Tiga sampai lima hal berikutnya untuk dibaca

**Urutan ini disusun menurut risiko × luas jangkauan, bukan menurut ukuran file.**

1. **`lib/daytrade-intraday-dry-run-gate.js` (699) + `lib/daytrade-intraday-policy.js`
   (572).** Dua file bernama **`gate`** dan **`policy`** — kelas file yang menghasilkan
   setiap temuan HIGH/CRITICAL saya. 1.271 baris untuk dua file. **Mulai dari sini.**
2. **Klaster `lib/intraday-shadow-*` (3.460 baris, 3 file).** Backlog produksi terbesar
   yang tersisa. Pertanyaan pertama yang harus dijawab: **apakah klaster ini benar-benar
   shadow-only?** `lib/intraday-fast-watcher.js` yang bertetangga menegakkan mode
   shadow-nya sendiri; kalau klaster ini juga begitu, seluruhnya bisa diturunkan
   prioritasnya. **Itu masih kecurigaan belum terverifikasi.**
3. **`supabase/` — 46 file, 7.333 baris.** Folder terkecil dengan risiko per baris
   tertinggi: BUG-037 hidup di sini, dan beberapa gate identitas admin ditegakkan di
   SQL, bukan JS. Mulai dari
   `supabase/admin-telegram-zero-link-pairing-migration.sql` (409, akar BUG-037), lalu
   `supabase/security-phase-1-migration.sql` (472) dan
   `supabase/telegram-verification-v2-migration.sql` (561).
4. **Menuntaskan `public/index.html` (11.127, SEDANG).** File terbesar yang belum
   tuntas, sudah menghasilkan 6 temuan termasuk satu CRITICAL. Yang sudah dibaca adalah
   bagian auth + AI; **sisanya belum**.
5. **`public/market-feature-runtime.js` (1.095) dan
   `public/portfolio-command-center.js` (602).** JS runtime terbesar yang belum dibaca.
   Untuk yang kedua, satu pertanyaan sudah terjawab (header `X-User-Id` **tidak**
   dipercaya server — §6); **sisa filenya belum dibaca.**

Yang **boleh ditunda**: `test/` (68.701 baris — kode test), `tools/` (13.336 —
skrip operasional), `.agents/` (637 — metadata), `deploy/` (150), dan CSS di `public/`
(~5.800 baris). `_disabled_api_backup/` (2.782) **boleh dilewati sepenuhnya** — tidak
dimuat runtime.

### 8.3 ⚠️ PERINGATAN — 22 PR draft berbagi satu base branch

**Semula 22 PR. Sekarang #516 sudah di-merge; 21 sisanya (#495–#515) masih
terbuka dan berbasis `feat/daytrade-screener-v1`.** Merge #516 saja sudah
membuat **15 dari 21** PR itu konflik — semuanya di `tools/curated-build-tests.json`.
**Harapkan hal yang sama setiap kali satu PR di-merge.** Sebelum membuat PR baru:

1. **Periksa tumpang-tindih file lebih dulu** dengan tabel di akhir §7. Lima PR
   menyentuh `public/index.html`, tiga menyentuh `api/sector-hot.js`.
2. **Setiap PR menyentuh `tools/curated-build-tests.json`.** Konfliknya sepele —
   selesaikan dengan mempertahankan **kedua** baris, jangan pilih salah satu.
3. **Jangan melebarkan PR yang sudah hijau.** Kalau menemukan bug baru di file yang
   sudah punya PR terbuka, buat PR baru atau tunggu yang lama di-merge. Itu sebabnya
   BUG-019 dan BUG-023 belum jadi PR (§3.3 d–e).
4. **Jangan menaruh dua kelompok masalah dalam satu PR** (aturan No. 4).

### 8.4 🔴 Keputusan di §3 dan §4 TIDAK BOLEH DIEKSEKUSI OTOMATIS

**Ini yang paling penting dari seluruh dokumen ini.**

**19 temuan dan 2 rekomendasi belum diperbaiki, dan itu DISENGAJA.** Bukan karena
kehabisan waktu — karena aturan No. 6 dan No. 8 pemilik repo melarangnya, dan
**pemilik repo belum menjawab satu pun dari keputusan-keputusan itu.**

**Kepada sesi/alat berikutnya: jangan menganggap dokumen ini sebagai daftar tugas.**
Setiap butir di §3 dan §4 butuh **konfirmasi ulang dari pemilik repo** sebelum
disentuh. Secara spesifik:

- **§3.1 (6 keputusan) mengubah gate/strategi trading.** BUG-027 dan BUG-026 akan
  **menambah** sinyal; BUG-025 akan **mengurangi** sinyal; BUG-042 dan BUG-015 akan
  **mengubah klasifikasi**. Menjalankannya tanpa persetujuan berarti mengubah strategi
  trading orang lain tanpa izin.
- **§3.2 (4 keputusan) butuh kueri produksi read-only dulu.** Keempat SQL di dokumen
  ini **read-only dan belum pernah dijalankan**. Untuk BUG-020, hasil kuerinya
  menentukan apakah ini bug nyata atau bukan. Untuk BUG-038, perbaikannya **menghapus
  baris produksi** — aturan No. 6 melarangnya tanpa persetujuan eksplisit.
- **§3.3 (5 keputusan)** lebih ringan, tapi **BUG-013 punya urutan tindakan yang tidak
  boleh dibalik**: set env Vercel → rotasi password `review` → **baru** merge PR #501.
  Membalik urutannya **memutus alur peninjauan app-store**.
- **§4:** REKOMENDASI-01 adalah refactor besar (aturan No. 7 — catat, jangan
  kerjakan). REKOMENDASI-03 berarti menghapus kode dari `api/sector-hot.js`.
  REKOMENDASI-02 **sudah selesai** (PR #516).

**Tidak ada data produksi yang disentuh sepanjang audit ini.** Tidak ada SQL yang
dijalankan. Tidak ada `.env` yang diubah di Vercel maupun VPS. Semua perubahan ada di
22 PR draft yang menunggu review.

### 8.5 Konteks teknis yang menghemat waktu Anda

- **Ini bukan Next.js.** `public/` statis + serverless `api/*.js` di Vercel. CommonJS,
  Node 22.x, satu-satunya dependency runtime `@supabase/supabase-js`.
- **Build = `node tools/run-build-test-suite.js`**, dan ia **hanya** menjalankan test
  yang terdaftar di `tools/curated-build-tests.json` (320 file). **Tidak ada** script
  lint atau typecheck. Ini juga isi BUG-002.
- **Sesi = cookie HMAC-SHA256 stateless `ac_sess`** (`lib/admin-session.js`),
  gagal-tertutup tanpa `SESSION_SECRET`.
- **`isSameOrigin()`** (`lib/admin-session.js:164-176`) hanya membandingkan host
  `Origin`/`Referer` dengan `Host`. Itu mengalahkan CSRF **dari browser**, bukan
  pemalsuan header oleh klien non-browser. Ingat batas ini saat menilai jalur admin.
- **Supabase/PostgREST membatasi respons di ~1.000 baris.** Repo ini sudah punya
  peredamnya sendiri: `SAFE_QUERY_ROW_BUDGET = 900` dan `RETENTION_TRIM_HEADROOM = 100`
  di `lib/stock-daily-history-store.js`. **Setiap kueri tanpa `.limit()` pada tabel
  besar adalah kandidat bug** — itu BUG-038, dan sebelumnya sudah pernah terjadi di
  `foreign-flow-store.js` (`:15-18`: *"a server-side 1,000-row cap could silently
  return only the newest session for most tickers, which made Foreign 7D equal Foreign
  Terbaru"*).
- **Konvensi entry: `entry1` = batas ATAS, `entry2` = batas BAWAH**
  (`api/sector-hot.js:3519-3520`). Berlawanan dengan intuisi, dan sumber BUG-016 serta
  BUG-021. **Pastikan ini sebelum menyentuh kode entry mana pun.**
- **Zona waktu bisnis WIB (Asia/Jakarta), BEI buka Senin–Jumat.** BUG-012 adalah
  offset zona yang dihitung dua kali.
- **Router AI yang aktif: `lib/context-ai-router-v7`.** v4/v5/v6 bukan orphan — sudah
  saya periksa. v4 dan v5 justru **lebih disiplin** dari v7: `requestKey` di v5
  (`:301-305`) sudah memuat `userId`, yang persis merupakan hal yang tidak dilakukan
  v7 dan menjadi BUG-028 (CRITICAL).
- **VPS hanya menjalankan `tools/ai-eval-once-supervisor.js`.** Selebihnya di Vercel.
- **Protokol pengiriman Telegram dua fase: claim → send → commit/release.** BUG-043
  adalah pelanggaran protokol ini di satu jalur; `lib/telegram-delivery.js` melakukannya
  dengan benar. Pola §1.4 lagi.

---

*Checkpoint ini disusun pada 4 September 2026 dari `AUDIT_COVERAGE.md` (778 baris
inventaris) dan `AUDIT_FINDINGS.md` (5.587 baris temuan). Status CI seluruh 22 PR
diverifikasi ulang pada tanggal yang sama. Tidak ada file produksi yang dibaca dalam
penyusunan dokumen ini.*
