# FULL REPO BUG FINDINGS

Hasil audit mendalam lintas repo. Branch kerja: `audit/full-repo-deep-dive`.

## RINGKASAN SESI INI

File kode dibaca tuntas sesi ini: 46 file (daftar lengkap di `FULL_REPO_AUDIT_LOG.md`).
Total temuan: 1 CRITICAL, 14 HIGH, 7 MEDIUM, 4 LOW (26 temuan).

### Modul dengan temuan CRITICAL/HIGH (prioritas batch perbaikan berikutnya)
1. **Pipeline Harga** — `api/quote.js` vs `api/candles.js` definisi harga terakhir berbeda (CRITICAL); pivot dari candle belum close (HIGH).
2. **Integrasi AI** — model Gemini bertabrakan antar modul, `gemini-3-flash` deprecated tapi jadi default narasi (CRITICAL); narasi hanya baca `GEMINI_API_KEY_PRIMARY` (HIGH); model safety-net hardcode `gemini-3.6-flash` (HIGH); label model hardcode di UI (HIGH).
3. **Bandarmologi/Broker** — 4 literal tanggal `2026-09-11`; gerbang freshness literal `2026-08-01` (HIGH).
4. **Jejaring Insider** — fallback ke data insider FABRIKASI bila file DB tak terbaca (HIGH).
5. **VPS Data Fetcher / Broker Hunter** — default tanggal literal `2026-09-08` (7 tempat) dan `2026-09-07` (HIGH).
6. **Auth/Keamanan** — kredensial legacy `budi` dengan hash hardcoded di sumber, plus kunci enkripsi BYOK fallback hardcoded (HIGH + MEDIUM).

### Modul tuntas tanpa bug (sudah diverifikasi)
`lib/password-credential.js`, `lib/request-rate-limit.js`, `lib/free-user-approval.js`, `lib/admin-session.js`, `lib/entitlements.js`, `lib/subscription-auth.js`, logika gate `lib/swing-screener-engine.js`, `api/candles.js`, `lib/chart-t1-policy.js`.

### BELUM DIAUDIT (sesi lanjutan — lihat `FULL_REPO_AUDIT_LOG.md`)
`api/sector-hot.js` (14.808 baris), `lib/daytrade-screener-engine*.js`, `lib/bandarmologi-intel-service.js`, `public/bandarmologi-runtime.js` (5.435 baris), semua `lib/intraday-*`/`lib/daytrade-*`/`lib/trade-plan-v2*`/`lib/telegram-*`, `lib/context-ai-router-v4/v5/v6.js`, sisa `public/*`, `tools/` (~102), `supabase/*.sql` (56), `.github/workflows/*`, `test/` (~521), dan 20 dokumen audit lama.
Setiap temuan wajib punya lokasi + kutipan + penjelasan + bukti + arah perbaikan.
Semua klaim dokumen audit lama TIDAK diwarisi — divertifikasi ulang dari kode kini.

Status: **AUDIT BERJALAN — BELUM SELESAI**. Modul yang belum dibaca belum tercantum di sini.
Total temuan sejauh ini: 1 CRITICAL, 14 HIGH, 7 MEDIUM, 4 LOW.

## MODUL: Screener Engine Swing (lib/swing-screener-engine.js) — catatan tuntas

- Struktur gate R/R & penalty engine TERLIHAT KONSISTEN dan terdokumentasi (hard gate R:R >= 1.8, status "Tunggu Pullback" dilarang High Conviction, RSI overbought dilarang jadi edge bullish). Tidak ditemukan bug CRITICAL/HIGH di file ini.
- [LOW] Konstanta `MIN_SWING_HIGH_CONVICTION_VOLUME = 1.0` ([`lib/swing-screener-engine.js:29`](lib/swing-screener-engine.js:29)) diekspor tetapi TIDAK dipakai; logika justru memakai angka literal `1.0` (plafon volume kering, baris 140) dan `1.2` (meritocracy lock, baris 148). Konstanta mati + angka tersebar. **Arah perbaikan:** hapus konstanta mati atau ganti literal agar satu sumber.

## MODUL: Kredensial Password (lib/password-credential.js) — catatan tuntas

- Desain kokoh: format `k1` memperbesar salt acak + `scryptSync`, perbandingan `timingSafeEqual`, dan jalur legacy hanya untuk migrasi ("needsUpgrade") — nilai `k1` tidak bisa diputar ulang sebagai hash legacy. Tidak ditemukan bug.

## MODUL: Rate Limit (lib/request-rate-limit.js) — catatan tuntas

- Implementasi sliding-window benar dan jujur soal batasnya (per-instance Map). Kunci bucket hanya dari alamat yang diamati server. Tidak ditemukan bug.

## MODUL: Free User Approval (lib/free-user-approval.js) — catatan tuntas

- `generateApprovalCode` sengaja deterministik & publik (bukan kredensial) — sudah didokumentasikan dan tidak dipakai sebagai faktor auth. `maskUsername` menyanitasi karakter injeksi. Tidak ditemukan bug.


## MODUL: VPS Data Fetcher & Broker Hunter (tanggal literal tersebar)

### [HIGH] `lib/vps-data-fetcher.js` memakai default tanggal literal `'2026-09-08'` di 7 tempat
- **Lokasi:** [`lib/vps-data-fetcher.js:243`](lib/vps-data-fetcher.js:243), `:247`, `:315`, `:319`, `:548`, `:551` (+1)
- **Kutipan kode bermasalah:**
  ```js
  function fetchBrokerSummaryFromVpsSync(ticker, date = '2026-09-08') {
  ...
  const safeDate = String(date || '2026-09-08').trim().replace(/[^0-9\-a-zA-Z]/g, '');
  ...
  async function ensureBrokerSummary(ticker, date = '2026-09-08') {
  ```
- **Penjelasan:** Semua pemanggil yang tidak mengirim `date` akan meminta data broker-summary untuk **2026-09-08** selamanya. Setelah tanggal itu, jalur ini menyajikan/menulis data sesi lama. Karena VPS bridge ini menjadi sumber data Bandarmologi pada runtime ter-deploy, kesalahan tanggal di sini langsung menjadi "data/harga ngaco" di UI.
- **Bukti verifikasi riil:** Belum dicek ke produksi. Bukti kode: 7 literal tanggal tetap pada default parameter dan fallback, jauh tertinggal dari tanggal sistem (2026-09-17).
- **Usulan arah perbaikan:** Ganti default dengan `null` lalu resolve ke `getEffectiveTradingDate()`/hari bursa terakhir; hapus semua literal.

### [HIGH] `lib/broker-hunter-service.js` memakai daftar tanggal literal `['2026-09-07']`
- **Lokasi:** [`lib/broker-hunter-service.js:368`](lib/broker-hunter-service.js:368) dan `:417`
- **Kutipan kode bermasalah:**
  ```js
  targetDates = ['2026-09-07'];
  ...
  : (targetDates[0] || '2026-09-07');
  ```
- **Penjelasan:** Halaman Broker Hunter dapat menghitung akumulasi/distribusi dari tanggal tetap 2026-09-07 ketika daftar tanggal dinamis kosong, sehingga ranking broker menampilkan data sesi lama tanpa peringatan.
- **Bukti verifikasi riil:** Belum. Bukti kode: literal tanggal.
- **Usulan arah perbaikan:** Ganti dengan `discoverAvailableDates()` hasil sebenarnya; bila kosong, kembalikan status "belum ada data" alih-alih tanggal tetap.

### [MEDIUM] Dua literal `'2026-09-11'` tambahan di `lib/bandarmologi-service.js`
- **Lokasi:** [`lib/bandarmologi-service.js:808`](lib/bandarmologi-service.js:808) dan `:1984`
- **Kutipan kode bermasalah:**
  ```js
  const targetDate = date === 'latest' || !date ? (raw.date || raw.broker_start_date || '2026-09-11') : date;
  const resolvedDate = (normSummary && normSummary.range_label) || ... || '2026-09-11';
  ```
- **Penjelasan:** Melengkapi temuan sebelumnya — total empat literal `'2026-09-11'` di modul yang sama. Menegaskan bahwa tanggal fallback ini adalah pola sistemik, bukan insiden tunggal.
- **Bukti verifikasi riil:** Belum. Bukti kode: literal.
- **Usulan arah perbaikan:** Sama — hilangkan literal tanggal; pakai resolusi hari bursa dinamis.

---

## MODUL: Konversi Tanggal UTC Naif (kelas bug yang sama tersebar luas)

### [MEDIUM] Label tanggal candle memakai potongan UTC (`toISOString().slice(0,10)`) di banyak modul data
- **Lokasi (contoh):** [`lib/chart-image-renderer.js:150`](lib/chart-image-renderer.js:150), [`lib/daily-history-collector.js:136`](lib/daily-history-collector.js:136), `:149`, [`lib/bandarmologi-intel-service.js:389`](lib/bandarmologi-intel-service.js:389), `:628`, [`lib/bandarmologi-service.js:1302`](lib/bandarmologi-service.js:1302), [`lib/context-ai-router-v7.js:428`](lib/context-ai-router-v7.js:428), [`lib/bandarmologi-screener-scoring.js:151`](lib/bandarmologi-screener-scoring.js:151), [`lib/ai-analysis-cache.js:27`](lib/ai-analysis-cache.js:27)
- **Kutipan kode bermasalah:**
  ```js
  date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10)   // UTC, bukan WIB
  const candleDate = lastCandle && (lastCandle.date || (lastCandle.time ? new Date(lastCandle.time*1000).toISOString().slice(0,10) : null));
  const marketDate = String(params.marketDate || new Date().toISOString().slice(0, 10)).trim();
  ```
- **Penjelasan:** Untuk timestamp ≥ 17:00 UTC (00:00 WIB keesokan hari), potongan UTC menghasilkan tanggal WIB yang mundur satu hari. Ini kelas bug yang sudah diperbaiki di `lib/latest-price-resolver.js` (memakai `toDateKey`), tetapi masih tersisa di banyak modul lain. Efek nyata: label sesi harga/candle dan kunci cache harian (mis. `marketDate` untuk AI cache) bisa memakai tanggal yang salah pada rentang 00:00–06:59 WIB — cache AI bisa salah hari, dan candle terakhir bisa diberi tanggal keliru.
- **Bukti verifikasi riil:** Belum. Bukti kode: pola identik pada 9+ lokasi. Perlu uji pada jam 00:00–07:00 WIB.
- **Usulan arah perbaikan:** Ganti semua dengan `lib/chart-t1-policy.js` `formatJakartaDate()` atau `idx-trading-calendar.toDateKey()`; tambahkan satu test regresi lintas-modul.

---

## MODUL: Data Contoh/Shadow yang Ter-commit (potensi tampil sebagai data nyata)

### [MEDIUM] `lib/intraday-shadow-scoring.js` dan `lib/intraday-collector-vps-audit.js` menyimpan tanggal contoh ter-hardcode
- **Lokasi:** [`lib/intraday-shadow-scoring.js:51-53`](lib/intraday-shadow-scoring.js:51), [`lib/intraday-collector-vps-audit.js:35`](lib/intraday-collector-vps-audit.js:35)
- **Kutipan kode bermasalah:**
  ```js
  '2026-07-20', '2026-07-21', '2026-07-22'
  const SAMPLE_DATE = '2026-07-23';
  ```
- **Penjelasan:** Modul shadow/audit memakai tanggal contoh tetap. Bila modul ini dipanggil tanpa argumen pada runtime, hasilnya mengacu ke sesi Juli 2026 dan dapat dilaporkan sebagai data terkini.
- **Bukti verifikasi riil:** Belum. Bukti kode: literal tanggal.
- **Usulan arah perbaikan:** Wajibkan argumen tanggal eksplisit; hapus default literal.

### [LOW] Aset scratch ter-commit di `public/`: `tmp-measure.html`, `tmp-measure2.html`, `tmp-ci-touch-batch1.js`
- **Lokasi:** `public/tmp-measure.html`, `public/tmp-measure2.html`, `public/tmp-ci-touch-batch1.js`, `tmp_investigasi/`
- **Penjelasan:** File pengukuran/CI sementara ter-commit dan ter-deploy di `public/` (disajikan Vercel sebagai aset publik). Bukan bug fungsional, tapi menambah permukaan publik yang tak perlu dan membingungkan audit.
- **Bukti verifikasi riil:** File terbukti ada di listing `public/` dan `tmp_investigasi/`.
- **Usulan arah perbaikan:** Hapus dari repo; `tmp_investigasi/` sudah di-`.gitignore` tetapi file lama masih terlacak.

### [LOW] `data/arjum-data/broker-summary/` berisi folder ticker non-saham (`AUDITSCALE5D/14D/30D/60D`, `B4TST`, `DBGT4`, `NOACC`)
- **Lokasi:** `data/arjum-data/broker-summary/`
- **Penjelasan:** Direktori ini di-`.gitignore` (`data/arjum-data/`) sehingga artefak lokal tidak masuk git, TETAPI `lib/broker-hunter-service.js:129` dan `discoverAvailableDates()` melakukan `readdirSync` atas folder ini tanpa validasi format ticker IDX. Bila artefak ini ada di runtime/VPS, ticker palsu bisa masuk universe brokeral. (Catatan: `.gitignore` meng-ignore, jadi risiko hanya pada runtime lokal/VPS, bukan bundle git.)
- **Bukti verifikasi riil:** Direktori terbukti ada (hasil `dir /b /s`). Pemakai yang mengiterasi sudah diidentifikasi (`lib/broker-hunter-service.js:114-134`).
- **Usulan arah perbaikan:** Validasi `/^[A-Z]{4}$/` saat membangun universe dari `readdirSync`.

## MODUL: Auth / Keamanan (api/login-user.js, lib/user-ai-credentials.js)

### [HIGH] Kredensial legacy `budi` di-hardcode di sumber (`LEGACY_BUDI_PASSWORD_HASH`) — hash yang diterima diketahui publik
- **Lokasi:** [`api/login-user.js:198-208`](api/login-user.js:198) dan [`api/login-user.js:469-495`](api/login-user.js:469)
- **Kutipan kode bermasalah:**
  ```js
  const LEGACY_BUDI_PASSWORD_HASH = crypto.createHash('sha256').update('._autocuan_salt_2024', 'utf8').digest('hex');
  function matchesLegacyBudiPassword(passwordHash) { ... timingSafeEqual(...) }
  ...
  const legacyBudiMayLogin = legacyBudiPasswordMatches && Boolean(getSessionSecret()) &&
    user.is_blocked === false && user.is_approved === true && isRegisteredDevice(user, deviceId);
  ```
- **Penjelasan:** Jalur kompatibilitas ini menerima nilai `passwordHash` tertentu (hash dari salt literal yang tertulis di repo) untuk username `budi`, tanpa memverifikasi password terhadap DB. Karena salt/hash ada di source (repo publik / bisa dibaca siapa pun yang punya akses kode), nilai `passwordHash` yang dibutuhkan untuk lolos **dapat dihitung siapa pun** — ia adalah kredensial tetap, bukan rahasia. Syarat tambahan (device terdaftar, akun approved, SESSION_SECRET ada) menaikkan hambatan, tetapi tetap: ini backdoor kredensial statis untuk akun admin. Setiap leak repo/branch (repo ini punya 557 branch) berarti admin takeover bila device id diketahui/didaftarkan.
- **Bukti verifikasi riil:** Belum diuji live. Bukti kode: literal salt + jalur yang menerimanya tanpa cek DB — pasti ada jalur kredensial statis.
- **Usulan arah perbaikan:** Hapus jalur kompatibilitas legacy ini (sudah ada migrasi `needsUpgrade` untuk user normal), atau batasi ke env khusus non-produksi dan wajibkan rotasi kredensial DB.

### [MEDIUM] Enkripsi BYOK memakai kunci master fallback hardcoded `'autocuan-chart-ai-key-secret-seed'`
- **Lokasi:** [`lib/user-ai-credentials.js:14-20`](lib/user-ai-credentials.js:14)
- **Kutipan kode bermasalah:**
  ```js
  const secret = process.env.APP_SECRET || process.env.ENCRYPTION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'autocuan-chart-ai-key-secret-seed';
  return crypto.scryptSync(secret, 'autocuan-chart-ai-salt', KEY_LENGTH);
  ```
- **Penjelasan:** Bila ketiga env tidak tersedia, kunci enkripsi API key pengguna (BYOK) jatuh ke konstanta yang tertulis di repo. Siapa pun dengan dump DB `user_ai_credentials` dapat mendekripsi API key Gemini milik user. Dalam praktik, `SUPABASE_SERVICE_ROLE_KEY` biasanya terpasang sehingga fallback ini jarang aktif — tetapi ketiadaan guard eksplisit membuat kesalahan konfigurasi berujung pada kebocoran kunci.
- **Bukti verifikasi riil:** Belum. Bukti kode langsung.
- **Usulan arah perbaikan:** Ganti fallback dengan fail-closed: bila tidak ada `APP_SECRET`/`ENCRYPTION_SECRET`, jangan enkripsi/simpan; kembalikan error konfigurasi.

### [MEDIUM] `Origin` yang dikendalikan klien bisa memicu bypass device-binding (`isVercelPreviewRequest`)
- **Lokasi:** [`api/login-user.js:22-34`](api/login-user.js:22) dan [`api/login-user.js:586-597`](api/login-user.js:586)
- **Kutipan kode bermasalah:**
  ```js
  const origin = String(req.headers.origin || '').trim().toLowerCase();
  if (origin) { try { const u = new URL(origin); if (u.hostname.endsWith('.vercel.app')) return true; } catch (_) {} }
  ```
- **Penjelasan:** `isVercelPreviewRequest` mempercayai header `Origin` (sepenuhnya dikendalikan klien). Permintaan ke produksi dengan `Origin: https://apa-saja.vercel.app` akan dianggap "preview" dan melewati pemeriksaan batas 3 perangkat (`api/login-user.js:588`). Password tetap wajib, jadi ini bukan bypass autentikasi, tetapi menghapus kontrol batas perangkat/anti-sharing. Demikian pula `x-forwarded-host` bila diteruskan proxy.
- **Bukti verifikasi riil:** Belum. Bukti kode jelas.
- **Usulan arah perbaikan:** Tentukan mode preview dari host request yang benar-benar diterima platform (mis. bandingkan `req.headers.host` dengan domain produksi), bukan dari `Origin` klien.


### [MEDIUM] `public/bandarmologi-runtime.js` juga memakai fallback tanggal literal `'2026-09-11'` untuk pemilih tanggal
- **Lokasi:** [`public/bandarmologi-runtime.js:134`](public/bandarmologi-runtime.js:134) dan [`public/bandarmologi-runtime.js:169`](public/bandarmologi-runtime.js:169)
- **Kutipan kode bermasalah:**
  ```js
  selectedDate = selectedDate || ... || (dates && dates[0]) || '2026-09-11';
  ```
- **Penjelasan:** Sama seperti temuan di `lib/bandarmologi-service.js`: bila daftar tanggal kosong, UI memilih tanggal literal `2026-09-11` yang kini sudah basi. User dapat melihat tab Bandarmologi "terkunci" pada tanggal lama tanpa indikasi bahwa itu fallback. Konsisten dengan pola literal tanggal yang tersebar.
- **Bukti verifikasi riil:** Belum. Bukti kode: literal tanggal.
- **Usulan arah perbaikan:** Hilangkan literal; tampilkan status "tanggal belum tersedia" bila daftar kosong.

## MODUL: Jejaring Insider (lib/insider-network-service.js)

### [HIGH] Fallback ke data insider FABRIKASI (`SAMPLE_INSIDER_UNIVERSE`) bila file DB tidak terbaca — berisiko tampil sebagai data nyata di serverless
- **Lokasi:** [`lib/insider-network-service.js:17-355`](lib/insider-network-service.js:17) dan [`lib/insider-network-service.js:511-523`](lib/insider-network-service.js:511)
- **Kutipan kode bermasalah:**
  ```js
  const SAMPLE_INSIDER_UNIVERSE = [ /* 355 baris transaksi insider hardcoded: Belvin Tannadi, Prajogo Pangestu,
     Lo Kheng Hong, Anthoni Salim, Haji Isam, Garibaldi Thohir, BlackRock ... dengan harga/lot/tanggal spesifik */ ];
  ...
  function getEffectiveUniverse(recordsOverride) {
    const dedicated = loadDedicatedUniverse();   // baca data/insider-network/insiders-db.json via fs
    if (dedicated) return flattenAndNormalizeRecords(dedicated);
    return flattenAndNormalizeRecords(SAMPLE_INSIDER_UNIVERSE);  // <-- FALLBACK DATA PALSU
  }
  ```
- **Penjelasan:** Bila `data/insider-network/insiders-db.json` tidak ada atau gagal dibaca, modul ini mengembalikan **deretan transaksi insider yang dikarang** (harga, jumlah lembar, persentase, tanggal) dan menyajikannya lewat API agregasi/graf yang sama seperti data nyata — tanpa penanda apa pun bahwa itu data contoh. Di produksi Vercel, `vercel.json` tidak mendeklarasikan `includeFiles`, sehingga `data/insider-network/insiders-db.json` berpotensi TIDAK ikut ke bundle fungsi serverless → fallback ini aktif dan user melihat "transaksi insider" fiktif sebagai fakta. Ini persis pola "data ngaco" dan merupakan risiko kredibilitas tinggi.
- **Bukti verifikasi riil:** Belum ke produksi. Bukti repo: file `data/insider-network/insiders-db.json` ADA dan ter-commit (tidak di-ignore `.gitignore`), jadi secara lokal fallback tidak aktif; namun tidak ada jaminan file itu tersedia di runtime Vercel. Perlu dicek: panggil endpoint insider di produksi dan cocokkan dengan isi `data/insider-network/insiders-db.json`.
- **Usulan arah perbaikan:** Hapus fallback sampel (kembalikan `[]` + status `NO_DATA`), atau bungkus data sampel dengan flag `is_sample: true` yang wajib ditampilkan di UI. Tambahkan `includeFiles` bila file memang dibutuhkan di serverless.


## MODUL: Bandarmologi / Broker (lib/bandarmologi-service.js)

### [HIGH] Tanggal bursa fallback di-hardcode `'2026-09-11'` di 3 tempat — setelah tanggal itu, Bandarmologi dapat menampilkan tanggal & data lama sebagai "efektif"
- **Lokasi:** [`lib/bandarmologi-service.js:213`](lib/bandarmologi-service.js:213), [`lib/bandarmologi-service.js:220`](lib/bandarmologi-service.js:220), [`lib/bandarmologi-service.js:232`](lib/bandarmologi-service.js:232)
- **Kutipan kode bermasalah:**
  ```js
  if (!idxTradingCalendar.isTradingDay(targetKey)) {
    const prevTrading = idxTradingCalendar.previousTradingDay(targetKey);
    return prevTrading || '2026-09-11';            // <-- literal
  }
  if (!inputDate && hour < 18) {
    const prev = idxTradingCalendar.previousTradingDay(currentJktKey);
    return prev || '2026-09-11';                    // <-- literal
  }
  ...
  const fallbackEff = getEffectiveTradingDate(); return [fallbackEff, '2026-09-11', '2026-09-10', '2026-09-09', '2026-09-08', '2026-09-07'];
  ```
- **Penjelasan:** `getEffectiveTradingDate()` adalah penentu "hari bursa efektif" untuk seluruh data Bandarmologi/Broker. Ketika kalender libur (`idx_trading_calendar`) kosong/tidak dapat dibaca, fungsi ini jatuh ke tanggal literal `2026-09-11` yang ditulis pada suatu sesi. Setelah tanggal tersebut berlalu (sekarang 2026-09-17), fallback itu menjadi data masa lalu yang basi, bukan "hari bursa sebelumnya". Dampak konkret: bila `previousTradingDay` mengembalikan null (mis. karena tabel kalender tidak ada / gagal query), Bandarmologi menyajikan broker summary 2026-09-11 seolah-olah itu sesi terkini. Ini persis kelas "harga/data ngaco di web". Nilai literal ini juga membuat `getDynamicTradingDays` mengembalikan deretan tanggal mati.
- **Bukti verifikasi riil:** Belum dicek ke produksi. Bukti kode: literal tanggal yang jauh tertinggal dari tanggal sistem sekarang (lihat environment: 2026-09-17) — pasti basi, bukan dugaan.
- **Usulan arah perbaikan:** Ganti literal dengan perhitungan relatif (`addDaysToKey(currentJktKey, -1)` yang di-loop), atau hilangkan fallback literal dan biarkan fungsi mengembalikan `currentJktKey`/null dengan status eksplisit. Tambahkan test agar tak ada tanggal literal.

### [HIGH] Gerbang kesegaran `getReferencePrice` memakai batas tanggal literal `'2026-08-01'` — candle lama dapat lolos sebagai referensi harga
- **Lokasi:** [`lib/bandarmologi-service.js:299`](lib/bandarmologi-service.js:299)
- **Kutipan kode bermasalah:**
  ```js
  const isFresh = lastCandle && lastCandle.date && String(lastCandle.date) >= '2026-08-01';
  if (isFresh && Number(lastCandle.close) > 0) return Math.round(Number(lastCandle.close));
  ```
- **Penjelasan:** `getReferencePrice` menjadi acuan harga untuk visual bandarmologi. Gerbang "fresh" hanya membandingkan dengan tanggal tetap `2026-08-01`, bukan terhadap tanggal saat ini. Candle berumur sampai ~6 minggu (mis. 2026-08-05) masih dianggap fresh pada 2026-09-17, sehingga harga referensi bisa jauh dari harga pasar terkini dan membuat buble/CR3 terlihat tidak wajar. Seharusnya konsisten dengan kebijakan T-1 (bandingkan ke hari bursa sebelumnya).
- **Bukti verifikasi riil:** Belum. Bukti kode: literal tanggal tetap.
- **Usulan arah perbaikan:** Pakai `idxTradingCalendar.previousTradingDay(...)` / kebijakan T-1 untuk menentukan ambang freshness, bukan literal.

### [HIGH] Label model di kartu "Analisis Chart (AI)" di-hardcode `'Gemini 2.5 Flash'` — menyesatkan user bila model riil berbeda
- **Lokasi:** [`public/chart-analysis-runtime.js:269`](public/chart-analysis-runtime.js:269)
- **Kutipan kode bermasalah:**
  ```js
  cardHtml += '<div>...<span style="font-size:10px;color:#94a3b8">Model: ' + escapeHtml(analysisData.model || 'Gemini 2.5 Flash') + ...
  ```
- **Penjelasan:** Bila backend tidak mengirim `analysisData.model` (mis. hasil cache lama tanpa field model, atau respons fallback), UI menampilkan label "Gemini 2.5 Flash" padahal pada saat yang sama `lib/ai-gemini-provider.js` justru mendeprecate `gemini-2.5-flash` dan default-nya `gemini-3.8-flash`. User melihat nama model yang tidak pernah benar-benar dipakai — persis keluhan "AI-nya masih banyak bug" pada level tampilan. Selain itu label ini tidak ikut berubah bila model diubah via env, sehingga audit AI jadi menyesatkan.
- **Bukti verifikasi riil:** Belum dicek. Bukti kode: fallback string literal yang bertabrakan dengan default provider.
- **Usulan arah perbaikan:** Bila `analysisData.model` kosong, tampilkan "Model: —" atau ambil dari konstanta bersama, jangan hardcode nama model.

### [HIGH] Rantai fallback model di `context-ai-router-v7.js` memakai literal hardcode `'gemini-3.6-flash'` yang tidak dikelola konstanta provider
- **Lokasi:** [`lib/context-ai-router-v7.js:600-627`](lib/context-ai-router-v7.js:600) dan [`lib/context-ai-router-v7.js:750-766`](lib/context-ai-router-v7.js:750)
- **Kutipan kode bermasalah:**
  ```js
  // Attempt 4 (Safety Net): Try stable modern flash if all previous failed
  if (!geminiResult && attempt4Timeout != null && primaryModel !== 'gemini-3.6-flash' && fallbackModel !== 'gemini-3.6-flash') {
    console.warn('[ContextAI] Trying stable gemini-3.6-flash fallback...');
    geminiResult = await streamGeminiAnalysis({ ... model: 'gemini-3.6-flash', ... });
  ```
  ```js
  // Attempt 1: Primary key + Primary model (gemini-3-flash)   <-- komentar basi, bukan nilai riil
  ```
- **Penjelasan:** Nama model didefinisikan terpusat di `ai-gemini-provider.js` (`DEFAULT_GEMINI_MODEL`, `FALLBACK_GEMINI_MODEL`, `DEPRECATED_GEMINI_MODELS`), tetapi router menyisipkan model ke-3 yang di-hardcode `'gemini-3.6-flash'` di 4 tempat (2 streaming + 2 non-streaming). Model ini tidak ada dalam daftar deprecated MAUPUN konstanta default, jadi bila `gemini-3.6-flash` dihentikan Google, tak ada yang menandainya — safety net justru menjadi titik gagal tambahan yang menghabiskan budget handler (`HARD_HANDLER_BUDGET_MS`) sebelum jatuh ke fallback lokal. Komentar `(gemini-3-flash)` juga menyesatkan karena model itulah yang justru sudah dideprecate di provider.
- **Bukti verifikasi riil:** Belum ke produksi. Bukti kode: literal `'gemini-3.6-flash'` muncul lewat pencarian langsung, tidak berasal dari konstanta bersama — pasti tidak konsisten.
- **Usulan arah perbaikan:** Pindahkan model safety-net ke konstanta provider (mis. `SAFETY_NET_GEMINI_MODEL`) dan tambahkan ke `DEPRECATED_GEMINI_MODELS` bila nanti usang; perbarui komentar basi.

## MODUL: Integrasi AI (lib/ai-*, lib/context-ai-router-*, api/analyze.js)

### [CRITICAL] Nama model Gemini saling bertentangan antar modul — narasi AI Telegram & news memakai model yang sudah dideprecate/404
- **Lokasi:** [`lib/ai-gemini-provider.js:8-25`](lib/ai-gemini-provider.js:8) vs [`lib/ai-narration.js:52-54`](lib/ai-narration.js:52) vs [`api/quote.js:1178`](api/quote.js:1178)
- **Kutipan kode bermasalah:**
  ```js
  // lib/ai-gemini-provider.js
  const DEPRECATED_GEMINI_MODELS = new Set([
    'gemini-1.5-flash','gemini-1.5-pro','gemini-2.5-flash','gemini-2.5-pro',
    'gemini-3-flash','gemini-3.0-flash','gemini-3.1-flash'
  ]);
  const DEFAULT_GEMINI_MODEL  = sanitizeGeminiModel(process.env.GEMINI_MODEL, 'gemini-3.8-flash');
  const FALLBACK_GEMINI_MODEL = sanitizeGeminiModel(process.env.GEMINI_FALLBACK_MODEL, 'gemini-3.1-flash-lite');
  ```
  ```js
  // lib/ai-narration.js  <-- TIDAK memakai sanitizeGeminiModel
  function getModel() { return process.env.GEMINI_MODEL || 'gemini-3-flash'; }  // 'gemini-3-flash' ADA di daftar DEPRECATED
  ```
  ```js
  // api/quote.js (fetchNewsFromGemini)
  var geminiModel = (process.env.GEMINI_MODEL && ...bukan model lama...) ? process.env.GEMINI_MODEL : 'gemini-3.8-flash';
  ```
- **Penjelasan:** Tiga jalur AI memutuskan nama model secara independen dan hasilnya berbeda. `ai-gemini-provider.js` menyatakan `gemini-3-flash` sudah DEPRECATED (dan `gemini-3.1-flash` juga), tetapi `lib/ai-narration.js` justru menjadikannya default. Juga `.agents`/docs menyebut `gemini-3-flash` sebagai default. Bila `GEMINI_MODEL` tidak diset di lingkungan produksi, narasi AI Telegram akan memanggil model yang tidak valid → `GEMINI_MODEL_NOT_FOUND` (404) → `generateNote` mengembalikan `{ note: null }` (fallback diam-diam). Inilah wujud konkret "AI-nya masih banyak bug": fitur AI tampak aktif di config tetapi tidak pernah benar-benar menghasilkan output. Selain itu `ai-narration.js` tidak melalui `sanitizeGeminiModel`, jadi nilai env yang salah (mis. `gemini-2.5-flash`) tetap diteruskan mentah.
- **Bukti verifikasi riil:** Belum dicek ke produksi. Bukti kode kuat: satu modul mendeprecate sebuah nama model, modul saudaranya memakai nama itu sebagai default — kontradiksi internal pasti, bukan dugaan. Untuk final, cek `echo $GEMINI_MODEL` di VPS dan log `GEMINI_MODEL_NOT_FOUND` pada narasi.
- **Usulan arah perbaikan:** Suruh `lib/ai-narration.js` memakai `sanitizeGeminiModel(process.env.GEMINI_MODEL, DEFAULT_GEMINI_MODEL)` dari `ai-gemini-provider`, dan samakan default model di `api/quote.js` dengan konstanta provider. Satu daftar model otoritatif saja.

### [HIGH] Narasi AI gagal total (fallback diam) bila kunci hanya `GEMINI_API_KEY`, karena `ai-narration.js` hanya membaca `GEMINI_API_KEY_PRIMARY`
- **Lokasi:** [`lib/ai-narration.js:112-113`](lib/ai-narration.js:112)
- **Kutipan kode bermasalah:**
  ```js
  const primaryKey = (process.env.GEMINI_API_KEY_PRIMARY || '').trim();
  if (!primaryKey) return { note: null, source: 'fallback', error: 'missing_primary_key' };
  ```
- **Penjelasan:** Modul AI lain (`ai-gemini-provider.js:29-39`) membaca `API_KEY_ANALISA_SAHAM_PORTOFOLIO` lalu `GEMINI_API_KEY`. Narasi hanya membaca `GEMINI_API_KEY_PRIMARY`/`_BACKUP`. Bila produksi hanya mengeset `GEMINI_API_KEY` (nama yang dipakai `api/quote.js:794`), seluruh narasi Telegram selalu gagal dengan `missing_primary_key` dan tak pernah tampil — lagi-lagi bug AI yang tidak terlihat (fail-soft menyembunyikan akar masalah).
- **Bukti verifikasi riil:** Belum. Bukti kode: `api/quote.js:794` dan `ai-gemini-provider.js:34` memakai `GEMINI_API_KEY`, sedangkan narasi memakai nama berbeda.
- **Usulan arah perbaikan:** Tambahkan fallback ke `GEMINI_API_KEY`/`API_KEY_ANALISA_SAHAM_PORTOFOLIO` di `getNarrationConfigStatus` & `generateNote`, atau set `GEMINI_API_KEY_PRIMARY` di `.env` produksi.

### [MEDIUM] Validator anti-angka-rekaan AI melemahkan dirinya sendiri dengan mengecualikan SEMUA angka 0–31 dan 2020–2030
- **Lokasi:** [`lib/ai-narration-validator.js:164-172`](lib/ai-narration-validator.js:164)
- **Kutipan kode bermasalah:**
  ```js
  var fabricatedNumbers = aiNumbers.filter(function(n) {
    if (sourceNumbers.has(n)) return false;
    var num = parseFloat(n);
    if (num >= 0 && num <= 31) return false;      // dianggap "tanggal"
    if (num >= 2020 && num <= 2030) return false; // dianggap "tahun"
    return true;
  });
  ```
- **Penjelasan:** Aturan "AI tidak boleh menyebut angka" hanya divalidasi untuk angka >31. Angka harga saham yang lazim di bawah 32 (mis. `entry 25`, `SL 18`) atau nilai seperti `10`, `20` lolos tanpa terdeteksi sebagai angka rekaan. Validator jadi tidak konsisten: angka Rp 5.000 ditolak, tetapi angka "25" (yang bisa jadi hasil rekaan model) diterima. Tidak langsung merugikan, tapi melemahkan jaminan "no fabricated numbers".
- **Bukti verifikasi riil:** Belum. Bukti kode langsung.
- **Usulan arah perbaikan:** Batasi pengecualian tanggal hanya bila konteks kata sekitar adalah tanggal (mis. "tanggal 25" atau pola `YYYY-MM-DD`), bukan semua bilangan ≤31.

### [MEDIUM] `api/analyze.js` memanggil `checkUnifiedAiQuota(db, …)` dengan `db` yang bisa `null`
- **Lokasi:** [`api/analyze.js:172-186`](api/analyze.js:172)
- **Kutipan kode bermasalah:**
  ```js
  const db = getSupabase();               // bisa null bila SUPABASE_URL/KEY tidak ada
  if (allowed && allowed.access) {
    const quotaCheck = await checkUnifiedAiQuota(db, allowed.access);
  ```
- **Penjelasan:** `requireAnalyzeAccess` sudah lebih dulu mengembalikan `503 PREMIUM_ACCESS_UNAVAILABLE` bila `db` null, jadi idealnya jalur ini tak tercapai dengan db null. Namun `allowed.access` bisa berasal dari cabang Free/BYOK yang memakai `access` gagal (SUBSCRIPTION_REQUIRED); jika `checkUnifiedAiQuota` tidak null-safe terhadap db, ini berpotensi error 500. Perlu diverifikasi ke `lib/chart-analysis-service.js`.
- **Bukti verifikasi riil:** Belum — perlu baca `checkUnifiedAiQuota`.
- **Usulan arah perbaikan:** Guard `if (db) …` sebelum memanggil quota, atau pastikan `checkUnifiedAiQuota` null-safe.


---

## MODUL: Pipeline Harga (api/quote, api/candles, lib/*price*, lib/chart-*)

### [CRITICAL] `api/quote.js` dan `api/candles.js` memakai definisi "harga terakhir" yang BERBEDA — sumber utama "harga ngaco"
- **Lokasi:** [`api/quote.js:543-547`](api/quote.js:543) vs [`api/candles.js:155-175`](api/candles.js:155)
- **Kutipan kode bermasalah:**
  - `api/quote.js` (fetchYahooQuote):
    ```js
    for (var i = 0; i < timestamps.length; i++) {
      var c = closes[i], o = opens[i], h = highs[i], l = lows[i], v = volumes[i];
      if (c != null && o != null && h != null && l != null && !isNaN(c)) {
        candles.push({ close: ..., open: ..., high: ..., low: ..., volume: v || 0,
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10) }); // <-- label tanggal UTC naif
      }
    }
    ...
    var latest = candles[candles.length - 1];
    var lastPrice = latest.close;   // <-- memakai candle TERAKHIR APA ADANYA (termasuk bar berjalan hari ini)
    ```
  - `api/candles.js`:
    ```js
    var cutoff = t1Policy.retainCompletedCandles(candles, clock.now()); // buang candle hari ini (Jakarta-aware)
    candles = cutoff.candles;
    var latest = candles[candles.length - 1];  // <-- selalu candle SELESAI (T-1)
    ```
- **Penjelasan:** Dua endpoint ini memberi arti berbeda untuk "harga terakhir". `/api/candles` sengaja membuang candle yang belum selesai (kebijakan T-1 Jakarta, lihat [`docs/CHART_T1_DATA_POLICY.md`](docs/CHART_T1_DATA_POLICY.md:1)) sehingga chart & semua metrik (MA/RSI/pivot/fibonacci) memakai close kemarin. `/api/quote` TIDAK melakukan itu — ia memakai candle terakhir yang dikembalikan Yahoo, yang selama jam bursa adalah **bar hari ini yang masih berjalan** (harga belum final). Akibatnya:
  1. Halaman Analisis/quote menampilkan `last` = harga intraday berjalan, sementara chart di halaman yang sama menampilkan close T-1 → dua angka berbeda untuk ticker sama.
  2. Pivot point di quote dihitung dari candle hari-ini-yang-belum-close (`prevH/prevL/prevC = latest.*`), padahal komentar menyebut "from T-1 completed candle" (`api/quote.js:620`). Ini pivot yang salah secara metodologi klasik.
  3. Label tanggal candle di quote memakai `toISOString().slice(0,10)` = tanggal **UTC**, bukan WIB. Untuk bar dengan timestamp UTC ≥ 17:00 (WIB keesokan hari) label tanggalnya mundur sehari — persis kelas bug yang SUDAH diperbaiki di [`lib/latest-price-resolver.js:15-34`](lib/latest-price-resolver.js:15) dengan `toDateKey`, tetapi **tidak** diperbaiki di `api/quote.js`.
- **Bukti verifikasi riil:** Belum diverifikasi ke produksi langsung (butuh hari bursa). Bukti saat ini: definisi cutoff berbeda secara eksplisit antara dua file, dan komentar `api/quote.js:620` mengklaim "T-1 completed candle" padahal kode memakai candle terakhir yang tidak dijamin selesai. Perlu cek live: bandingkan `data.latest.last` dari `/api/quote?ticker=BBCA` vs `latest.close` dari `/api/candles?ticker=BBCA` pada jam bursa — jika berbeda, temuan terkonfirmasi.
- **Usulan arah perbaikan:** Jadikan kedua endpoint memakai satu sumber kebijakan: panggil `t1Policy.retainCompletedCandles(...)` (atau `previousWeekday`/`toDateKey`) di `api/quote.js` sebelum menghitung `latest`, pivot, MA, RSI. Ganti `new Date(timestamps[i]*1000).toISOString().slice(0,10)` dengan `t1Policy.formatJakartaDate(...)` agar konsisten WIB.

---

### [HIGH] `api/quote.js` memakai pivot dari candle yang belum close → level support/resistance & trading plan bergeser
- **Lokasi:** [`api/quote.js:620-652`](api/quote.js:620)
- **Kutipan kode bermasalah:**
  ```js
  // === PIVOT POINT CALCULATION (Classic) from T-1 completed candle ===
  var prevH = latest.high; var prevL = latest.low; var prevC = latest.close; var prevO = latest.open;
  ```
- **Penjelasan:** Komentar menyatakan sumber T-1, tetapi `latest` adalah candle terakhir array tanpa filter T-1 (lihat temuan di atas). Selama jam bursa, `latest.high/low/close` berubah tiap tick, sehingga pivotPoint/R1/R2/S1/S2 ikut berubah-ubah intraday dan tidak deterministik. Karena pivot ini menurunkan `tradingPlan` ([`api/quote.js:377-413`](api/quote.js:377)) dan `riskLabel`, user bisa melihat level entry/TP/SL yang bergerak tanpa refresh eksplisit — "harga level ngaco".
- **Bukti verifikasi riil:** Belum diverifikasi live; bukti kode: tidak ada filter tanggal sebelum baris 621, padahal helper filter sudah tersedia di modul lain.
- **Usulan arah perbaikan:** Filter `candles` ke < tanggal Jakarta hari ini sebelum `latest`/pivot, sama seperti `api/candles.js`.

---

### [MEDIUM] `lib/corporate-action-price-scale-guard.js` memakai median 5-field untuk blokir — bisa false-positive di saham berita
- **Lokasi:** [`lib/corporate-action-price-scale-guard.js:42-47`](lib/corporate-action-price-scale-guard.js:42)
- **Kutipan kode bermasalah:**
  ```js
  const ratio = median(ratioValues);
  const farMedian = ratio > 1.8 || ratio < 0.55;
  const blocked = (enoughEvidence && farMedian && (commonScale || ratio > 2.2 || ratio < 0.45)) || criticalFar;
  ```
- **Penjelasan:** Guard ini memblokir level bila median rasio level harga terhadap latest menyimpang jauh. `criticalFar` menandai `entry/stop_loss` yang >3x latest. Untuk saham yang benar-benar sedang ada aksi korporasi, ini benar; tetapi untuk kasus di mana `latest_price` yang dipakai justru yang STALE (mis. resolusi latest salah sumber), guard akan memblokir level yang sebenarnya valid. Ini memperkuat dampak temuan resolusi harga di atas: bila latest salah, guard menambah label NEEDS_REVALIDATION yang membingungkan user. Perlu dicatat sebagai interaksi, bukan bug murni di file ini.
- **Bukti verifikasi riil:** Belum. Perlu uji dengan row yang latest_price-nya sengaja salah.
- **Usulan arah perbaikan:** Setelah resolver harga diperbaiki, tambahkan test integrasi guard × resolver.

---

## MODUL: Resolusi Harga Screener (lib/latest-price-resolver.js)

### [MEDIUM] `isFresh` default jendela 48 jam memungkinkan harga "fresh" sampai 2 hari & tidak membedakan hari bursa
- **Lokasi:** [`lib/latest-price-resolver.js:37`](lib/latest-price-resolver.js:37)
- **Kutipan kode bermasalah:**
  ```js
  var maxHours = n(options && options.maxAgeHours) || 48;
  return now.getTime() - at.getTime() <= maxHours * 3600000 && now.getTime() >= at.getTime() - 3600000;
  ```
- **Penjelasan:** Default 48 jam berarti pada Senin pagi, harga dari Jumat (bisa >48 jam saat akhir pekan panjang/libur) ditandai `stale`, tetapi harga Jumat sore pada Sabtu masih dianggap fresh. Ini tidak salah secara fatal, namun pada kombinasi libur panjang (mis. cuti bersama) harga terakhir bisa >48 jam dan seluruh sumber jatuh ke `stale: true` → dengan `portfolioPriceOnly` di `api/quote.js` ini memicu `price_stale` dan harga tidak terisi. Perlu dipastikan fallback T-1 tetap ada untuk portfolio. Toleransi masa depan 1 jam (`now >= at - 1h`) sudah ada (baik).
- **Bukti verifikasi riil:** Belum.
- **Usulan arah perbaikan:** Ganti basis "48 jam" menjadi "jumlah sesi bursa" memakai `lib/idx-trading-calendar.js`, atau minimal naikkan default ke 72–96 jam untuk mengakomodasi libur panjang.

---

## MODUL: Kalender & Data Historis (lib/idx-trading-calendar.js, lib/stock-daily-history-store.js)

### [LOW] `lib/idx-trading-calendar.js` mendokumentasikan tabel `idx_trading_calendar` sebagai sumber, tetapi `docs/CHART_T1_DATA_POLICY.md` menyatakan tidak ada kalender libur otoritatif — dua sumber kontradiktif
- **Lokasi:** [`lib/idx-trading-calendar.js:9-17`](lib/idx-trading-calendar.js:9) vs [`docs/CHART_T1_DATA_POLICY.md:9-12`](docs/CHART_T1_DATA_POLICY.md:9)
- **Penjelasan:** `idx-trading-calendar.js` mengasumsikan ada tabel `idx_trading_calendar` (dan `marketDayGuard` bergantung padanya), sedangkan `chart-t1-policy.js`/dokumen T-1 menyatakan kalender libur tidak tersedia dan hanya weekday-only. Bila tabel itu kosong di produksi, `chart-t1-policy.js` tetap weekday-only tetapi `idx-trading-calendar.js` akan melaporkan `weekend_only_fallback` — dua modul bisa memberi status T-1 berbeda untuk hari libur. Ini inkonsistensi lintas modul yang berpotensi menampilkan data hari libur sebagai T-1 valid.
- **Bukti verifikasi riil:** Belum. Perlu cek apakah `idx_trading_calendar` terisi di Supabase produksi.
- **Usulan arah perbaikan:** Satukan kebijakan kalender; biasakan semua konsumen T-1 memakai `loadHolidayCalendar` + `previousTradingDay`, atau sebaliknya dokumentasikan bahwa weekday-only adalah satu-satunya kontrak.

---

## CATATAN DATA PRODUKSI (pra-verifikasi)

### [MEDIUM] Folder ticker non-saham di data produksi: `data/arjum-data/broker-summary/{AUDITSCALE14D,AUDITSCALE30D,AUDITSCALE5D,AUDITSCALE60D,B4TST,DBGT4,NOACC}`
- **Lokasi:** `data/arjum-data/broker-summary/` (lihat inventaris `tmp_inventory_data.txt`)
- **Penjelasan:** `broker-summary` seharusnya hanya berisi ticker IDX valid. Nama seperti `AUDITSCALE5D`, `B4TST`, `DBGT4`, `NOACC` merupakan artefak uji/audit. Jika kode apa pun mengiterasi seluruh isi direktori `broker-summary` (mis. memakai `readdirSync` untuk membangun universe), ticker palsu ini bisa masuk ke perhitungan bandarmologi/ranking. WAJIB dilacak pemakainya.
- **Bukti verifikasi riil:** Direktori terbukti ada di repo (hasil `dir /b /s`). Belum dilacak apakah ada kode yang mengiterasi direktori ini.
- **Usulan arah perbaikan:** Bersihkan direktori; tambahkan validasi format ticker (`/^[A-Z]{4}$/`) saat mengiterasi `broker-summary`.