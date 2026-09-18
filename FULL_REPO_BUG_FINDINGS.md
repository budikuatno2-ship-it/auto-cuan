# FULL REPO BUG FINDINGS

Hasil audit mendalam lintas repo. Branch kerja: `audit/full-repo-deep-dive`.

## RINGKASAN

Total file kode dibaca tuntas: ~90 file (daftar lengkap di `FULL_REPO_AUDIT_LOG.md`).
Total temuan: **1 CRITICAL, 16 HIGH, 15 MEDIUM, 6 LOW (38 temuan)**.
Delapan klaim dokumen audit lama diverifikasi ulang langsung ke kode — **3 klaim "sudah selesai" ternyata BELUM diperbaiki**.

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
Total temuan sejauh ini: 1 CRITICAL, 17 HIGH, 20 MEDIUM, 12 LOW.

### [LOW] `deleteOldForeignRows` membaca SEMUA tanggal per ticker tanpa `.limit()`
- **Lokasi:** [`api/sector-hot.js:3185-3189`](api/sector-hot.js:3185)
- **Kutipan kode bermasalah:**
  ```js
  var dateRes = await supabase.from('foreign_watchlist_daily')
    .select('trade_date').eq('ticker', ticker)
    .order('trade_date', { ascending: false });   // tanpa .limit()
  ```
- **Penjelasan:** Ini jalur retensi foreign flow di `handleForeignImportUpload`. Berbeda dari `lib/admin-foreign-upload.js` (yang membaca lintas banyak ticker sekaligus dan kena cap respons), di sini query di-scope ke SATU ticker, jadi jumlah barisnya jauh lebih kecil dan tidak berisiko truncation lintas-universe. Namun tetap tanpa `.limit()` eksplisit — pada ticker dengan backlog besar, respons bisa besar. Bukan bug fungsional saat ini, tapi melanggar disiplin bounded-query yang dipakai modul lain.
- **Bukti verifikasi riil:** Bukti kode: tidak ada `.limit()`.
- **Usulan arah perbaikan:** Tambahkan `.limit(50)` (cukup untuk menentukan 7 tanggal terbaru).

### Catatan tuntas — `api/sector-hot.js` TUNTAS (14.808 baris, semua terbaca)
- `getWibDateString` ([`:3355`](api/sector-hot.js:3355)) dan `getWibHourString` ([`:3359`](api/sector-hot.js:3359)) BENAR: epoch + 7 jam lalu potongan UTC = tanggal/jam WIB.
- `isSignalPublicationTimeRestrictedWib` ([`:3380`](api/sector-hot.js:3380)) memblokir 09:00–09:15 dan 13:00–13:59 WIB dengan benar.
- `deriveFreshness` ([`:3422`](api/sector-hot.js:3422)) memakai `getJakartaDateFromTimestamp` (WIB-aware) dan membedakan Fresh/Delayed/Stale/Market-Close-Snapshot dengan benar.
- `parseForeignImportCsv` ([`:3136`](api/sector-hot.js:3136)) memvalidasi kolom wajib, tanggal, ticker, dan duplikat baris; `foreign_net` dihitung `nbsa * close` (bukan dikarang).
- Seluruh rantai gate keselamatan Telegram, monitor TP/SL, dedup, dan delivery-prep konsisten (lihat catatan batch sebelumnya).

### [MEDIUM] `enrichConfluenceRows` menghitung ulang confidence memakai kategori hardcoded `'Swing'` — ambang TP1 Non-Konglo jadi salah
- **Lokasi:** [`api/sector-hot.js:2995-2998`](api/sector-hot.js:2995)
- **Kutipan kode bermasalah:**
  ```js
  if (includeForeign) {
    Object.assign(r, foreignMap[...] || {...});
    if (r.confidence) {
      var confAfterForeign = deriveConfidenceTier(r, 'Swing');   // <-- kategori DIPAKSA 'Swing'
      r.confidence = confAfterForeign.confidence;
      r.confidence_label = confAfterForeign.confidence_label;
      r.confidence_notes = confAfterForeign.confidence_notes;
    }
  }
  ```
- **Penjelasan:** Ini bug yang **sudah diakui sendiri oleh kode**: komentar di [`api/sector-hot.js:11913-11918`](api/sector-hot.js:11913) menulis *"enrichConfluenceRows's confidence re-derivation hardcodes category='Swing' regardless of caller … That's a pre-existing bug worth its own fix"*. Dampak terverifikasi: fungsi ini dipanggil `includeForeign=true` dari **Swing Konglo** ([`:616`](api/sector-hot.js:616)) dan **Swing Non-Konglo** ([`:10610`](api/sector-hot.js:10610)). Untuk Non-Konglo, `deriveConfidenceTier(r, 'Swing')` memakai `getMinTp1UpsideForCategory('Swing')` = **5%**, padahal kategori sebenarnya menuntut **4.5%** (`cat.indexOf('non') >= 0` → 4.5). Jadi tier confidence Non-Konglo dihitung dengan ambang yang lebih ketat daripada spesifikasinya → sebagian kandidat turun tier secara tidak konsisten. Day Trade tidak terpengaruh karena dipanggil dengan `includeForeign=false` ([`:11919`](api/sector-hot.js:11919)).
- **Bukti verifikasi riil:** Bukti kode: hardcode + komentar pengakuan + pembanding `getMinTp1UpsideForCategory` (`day`→3, `non`→4.5, else→5).
- **Usulan arah perbaikan:** Teruskan `r.category` (atau kategori asli pemanggil) ke `deriveConfidenceTier` alih-alih literal `'Swing'`.


### [MEDIUM] Tabel "Daftar Pemegang Saham & Insider": persentase yang HILANG dirender "0.00%" (missing disajikan sebagai nol)
- **Lokasi:** [`public/bandarmologi-runtime.js:3728-3731`](public/bandarmologi-runtime.js:3728) dan `:3754`
- **Kutipan kode bermasalah:**
  ```js
  var pct = (r.percentage == null || r.percentage === '')
    ? 0
    : (typeof r.percentage === 'number' ? r.percentage : parseFloat(String(r.percentage).replace(/[%\s]/g, '')));
  if (!Number.isFinite(pct)) pct = 0;
  ...
  html += '... ' + (r.percentage_formatted || (pct.toFixed(2) + '%')) + ' ...';
  ```
- **Penjelasan:** Ketika data persentase kepemilikan tidak tersedia, `pct` dipaksa menjadi `0`, lalu dirender sebagai **"0.00%"** — persis kelas bug yang di seluruh repo ini secara eksplisit dijaga (`public/portfolio-command-center.js:18-43` menulis "MISSING DATA IS NOT ZERO" dan `lib/report-helpers.js` menangani null dengan hati-hati). Di halaman Jejaring Insider, seorang pemegang saham tanpa data persentase akan tampak seolah-olah memegang **0%** saham. Pada fitur yang menyajikan klaim kepemilikan, ini informasi yang salah, bukan kosmetik.
- **Bukti verifikasi riil:** Bukti kode: `0` sintetis dari cabang `== null`.
- **Usulan arah perbaikan:** Tampilkan `'—'` bila `percentage` null/kosong; jangan sintesis 0.

### Catatan tuntas — `public/bandarmologi-runtime.js` TUNTAS (5.435 baris, semua terbaca)
- `loadBandarmologiTab`/`loadBandarmologiIntel`/`loadBrokerHunter` memakai pola request-sequence + AbortController + timer yang benar dan konsisten.
- `computeConcentrationRatioMetrics` memakai rumus CR3/CR5 kanonik yang sama dengan server (perbaikan PR3 terkonfirmasi, termasuk guard sub-top-5 agar CR tidak mentok 100%).
- `stepBackToTradingDayIso` mencegah tanggal non-bursa ditampilkan (perbaikan PR2 terkonfirmasi), walaupun masih ada default literal (temuan LOW terpisah).
- Semua `innerHTML` yang memuat data dinamis melewati `escapeHtml`; atribut `onclick` memakai `escapeHtml` juga.

### [MEDIUM] `api/sector-hot.js` Non-Konglo juga menyimpan `price_date` dari potongan UTC naif
- **Lokasi:** [`api/sector-hot.js:11060`](api/sector-hot.js:11060)
- **Kutipan kode bermasalah:**
  ```js
  price_date: validDays[lastIdx].ts ? new Date(validDays[lastIdx].ts * 1000).toISOString().slice(0, 10) : null,
  ```
- **Penjelasan:** Ini jalur Non-Konglo (`fetchNkQuoteData`). Sama seperti Konglo ([`:1885`](api/sector-hot.js:1885)) dan jalur Top 5 chart ([`:5707`](api/sector-hot.js:5707)), tanggal sesi diambil dari potongan UTC, bukan konversi WIB. `price_date` adalah input kebijakan kesegaran (`attachPriceFreshness`/`validateScreenerPriceFreshness`), sehingga tanggal yang salah dapat menandai harga segar sebagai stale (atau sebaliknya). Sekarang **tiga jalur berbeda di file yang sama** memakai pola yang salah, sementara helper WIB (`getJakartaDateFromTimestamp`, `getJakartaDateString`) tersedia di file yang sama.
- **Bukti verifikasi riil:** Bukti kode: 3 lokasi identik.
- **Usulan arah perbaikan:** Ganti ketiganya dengan `getJakartaDateFromTimestamp(ts * 1000)`.

### [LOW] `formatDateDisplay` di UI Bandarmologi mengembalikan tanggal literal `'2026-09-11'` sebagai default
- **Lokasi:** [`public/bandarmologi-runtime.js:4162`](public/bandarmologi-runtime.js:4162)
- **Kutipan kode bermasalah:**
  ```js
  function formatDateDisplay(dateStr) {
    if (!dateStr) return '2026-09-11';
    ...
  ```
- **Penjelasan:** Fungsi pemformat tanggal pusat untuk seluruh tab Bandarmologi. Bila `dateStr` kosong, ia mengembalikan tanggal tetap yang kini basi. Karena `formatDateDisplay` dipanggil dari banyak tempat (label tanggal header, opsi dropdown tanggal, dan lain-lain), satu nilai kosong dapat menampilkan "2026-09-11" di beberapa lokasi UI sekaligus sebagai tanggal data. Total literal `'2026-09-11'` di modul Bandarmologi kini **8 tempat**.
- **Bukti verifikasi riil:** Bukti kode: literal pada default.
- **Usulan arah perbaikan:** Kembalikan `'—'` alih-alih tanggal tetap.

(1 temuan pernah dicatat lalu DITARIK setelah verifikasi ulang — lihat bagian "DITARIK".)

## MODUL: Context AI Router v4 (lib/context-ai-router-v4.js)

### [MEDIUM] Katalog model WeizeRouter di-hardcode sebagai daftar fallback, mencampur model yang belum tentu ada dengan daftar CATALOG
- **Lokasi:** [`lib/context-ai-router-v4.js:99-125`](lib/context-ai-router-v4.js:99)
- **Kutipan kode bermasalah:**
  ```js
  const CATALOG = Object.freeze([
    'wz/gpt-5.6-sol','wz/claude-opus-5','wz/claude-opus-4.8', ... 'wz/deepseek-v4-pro-none'
  ]);
  const DEFAULT_STOCK = Object.freeze(['wz/gpt-5.6-sol','wz/claude-sonnet-4.6', ...]);
  ...
  function configuredModels(source, task) {
    return economicalOrder(envModels(source, task).concat(defaultsFor(source, task), split(process.env.PORTFOLIO_AI_MODELS), CATALOG), source, task);
  }
  ```
- **Penjelasan:** `configuredModels` **selalu** menambahkan seluruh `CATALOG` (44 nama model) ke daftar kandidat. Jadi setiap request ke router v4 akan mencoba nama model hardcoded dari repo, termasuk yang mungkin sudah tidak dilayani provider. Komentar di file mengakui provider mengembalikan `wz_model_temporarily_unavailable` untuk semua route katalog-valid, dan ada latch outage instance-wide — artinya jalur ini secara rutin gagal dan jatuh ke fallback. Karena CATALOG adalah konstanta source (bukan env), mengubah model yang dilayani provider menuntut perubahan kode + deploy. Ini juga memperluas masalah "nama model tersebar di banyak modul" yang sudah tercatat (narasi, provider, safety-net, chart-analysis).
- **Bukti verifikasi riil:** Bukti kode; komentar internal file (baris 72-90) mengonfirmasi kegagalan produksi nyata pada jalur ini.
- **Usulan arah perbaikan:** Pindahkan katalog ke env/konfigurasi (atau hapus jalur v4 yang sudah dikonfirmasi tidak melayani inference), agar satu sumber daftar model saja.

### Catatan tuntas (tanpa bug) — `lib/intraday-volume-pace.js`
- `dateInJakarta` memakai `Intl.DateTimeFormat` timeZone Asia/Jakarta (BENAR untuk WIB), `tradingSchedule` membedakan Jumat (270 menit) vs Senin-Kamis (330 menit) sesuai jam bursa IDX, `sessionProgress` menangani BEFORE_OPEN/BREAK/AFTER_CLOSE, dan baseline volume dihitung eksklusif candle sesi berjalan. Kokoh.

### [HIGH] Data insider FABRIKASI diduplikasi di sisi klien (`FALLBACK_INSIDER_DATA`) — semua nama tak dikenal jatuh ke Belvin Tannadi
- **Lokasi:** [`public/bandarmologi-runtime.js:3041-3150`](public/bandarmologi-runtime.js:3041) dan `:3161-3173`
- **Kutipan kode bermasalah:**
  ```js
  var FALLBACK_INSIDER_DATA = {
    'belvin tannadi': { summary:{entity_name:'Belvin Tannadi',total_emitens:3}, nodes:[...], edges:[
      { ticker:'BUMI', shares:850000000, percentage:2.45, latest_price:142, latest_date:'2026-09-05' }, ... ] },
    'prajogo pangestu': {...}, 'lo kheng hong': {...}, 'anthoni salim': {...},
    'garibaldi thohir': {...}, 'blackrock inc.': {...}, 'haji isam': {...}, 'haji samsudin andi arsyad': {...}
  };
  ...
  function getEffectiveInsiderGraph(name) {
    var service = getInsiderNetworkService();
    if (service && ...) { var res = service.buildInsiderNetworkGraph({name:name}); if (res && res.nodes && res.nodes.length>0) return res; }
    var key = String(name||'').toLowerCase().trim();
    if (FALLBACK_INSIDER_DATA[key]) return FALLBACK_INSIDER_DATA[key];
    for (var k in FALLBACK_INSIDER_DATA) { if (k.includes(key) || key.includes(k)) return FALLBACK_INSIDER_DATA[k]; }
    return FALLBACK_INSIDER_DATA['belvin tannadi'] || null;   // <-- default ke data palsu
  }
  ```
- **Penjelasan:** Ini menggandakan masalah temuan HIGH sebelumnya (`SAMPLE_INSIDER_UNIVERSE` di `lib/insider-network-service.js`) langsung di dalam bundle browser. Akibatnya, meskipun backend diperbaiki kelak, UI masih akan menampilkan graf insider karangan: `getEffectiveInsiderGraph` mengembalikan data palsu untuk nama yang dikenal, dan untuk nama APA PUN yang tidak dikenal ia mengembalikan **Belvin Tannadi** — lengkap dengan harga, jumlah lembar, persentase, tanggal. Di halaman "Jejaring Insider", user dapat mencari sembarang nama dan mendapat graf "relasi insider" fiktif tanpa penanda apa pun bahwa itu data contoh. Ini risiko kredibilitas tinggi pada fitur yang menyajikan klaim kepemilikan.
- **Bukti verifikasi riil:** Bukti kode: literal data identik dengan versi backend; fallback terakhir adalah entri tetap. `getEffectiveSearchInsiders` juga membaca `FALLBACK_INSIDER_DATA` saat service kosong.
- **Bukti tambahan (verifikasi perilaku):** [`public/bandarmologi-runtime.js:3812-3814`](public/bandarmologi-runtime.js:3812) menetapkan `activeInsiderNetworkEntity = 'Belvin Tannadi'` sebagai default saat tab dibuka, sehingga tampilan awal halaman Jejaring Insider selalu memuat satu tokoh contoh dari data karangan. Cache `FALLBACK_INSIDER_DATA` juga ditimpa data live saat VPS merespons ([`:3229`](public/bandarmologi-runtime.js:3229), `:3248`), jadi entri palsu dan nyata bercampur dalam satu map tanpa penanda.
- **Usulan arah perbaikan:** Hapus `FALLBACK_INSIDER_DATA`; tampilkan estado "belum ada data relasi" bila service tidak mengembalikan hasil. Jangan pernah mengembalikan entri tertentu untuk nama tak dikenal, dan jangan jadikan tokoh contoh sebagai default tab.

### DITARIK (diverifikasi ulang = BUKAN bug) — recall volume pace v7 vs level yang dipublikasikan
- **Lokasi:** [`lib/daytrade-screener-engine-v7.js:120-134`](lib/daytrade-screener-engine-v7.js:120)
- **Klaim awal saya:** `levels` dihitung ulang dari `effective.analysis` tetapi tidak ditimpa ke `output`, sehingga skor/status mungkin memakai level berbeda dari yang dipublikasikan.
- **Hasil verifikasi ulang:** **Klaim ini SALAH — saya tarik.** `base.calculateLevels(data)` ([`lib/daytrade-screener-engine.js:646-795`](lib/daytrade-screener-engine.js:646)) hanya memakai `last_price/open_price/high_price/low_price/support/resistance/atr14/swingLow5/swingHigh10`. Overlay pace di v7 hanya mengubah field **volume** (`volume_ratio_20d`, `avg_volume_20d`, `avg_value_7d`, dll), bukan satupun input `calculateLevels`. Jadi `levels` hasil hitung ulang identik dengan level yang sudah ada di `row`; tidak ada ketidakkonsistenan. Tidak ada bug di sini.
- **Pelajaran metode:** temuan ini tidak lolos verifikasi ulang — dicatat eksplisit agar tidak dihitung sebagai bug dan agar sesi berikutnya tidak mengulanginya.


### [LOW] Tanggal literal `'2026-09-11'` juga muncul di header UI Bandarmologi
- **Lokasi:** [`public/bandarmologi-runtime.js:2244`](public/bandarmologi-runtime.js:2244)
- **Kutipan kode bermasalah:**
  ```js
  html += '    <span class="text-gray-400">Tanggal: <strong class="text-gray-200">' + escapeHtml(formatDateDisplay(bSum.date || currentBandarDate || '2026-09-11')) + '</strong></span>';
  ```
- **Penjelasan:** Melengkapi rangkaian literal tanggal di modul Bandarmologi (sebelumnya ditemukan di `lib/bandarmologi-service.js` 4x dan `bandarmologi-runtime.js` 2x). Ketika backend tidak mengirim `date`, header menampilkan "2026-09-11" — tanggal yang kini basi — seolah itu tanggal data yang ditampilkan. Total literal tanggal ini di modul Bandarmologi: **7 tempat**.
- **Bukti verifikasi riil:** Bukti kode: literal tanggal pada fallback render.
- **Usulan arah perbaikan:** Tampilkan "—" atau "Tanggal belum tersedia" alih-alih tanggal tetap.


### [LOW] `getRequestBaseUrl` mempercayai `x-forwarded-host`/`host` klien saat membangun URL chart Telegram
- **Lokasi:** [`api/sector-hot.js:5859-5863`](api/sector-hot.js:5859)
- **Kutipan kode bermasalah:**
  ```js
  function getRequestBaseUrl(req) {
    var proto = req.headers['x-forwarded-proto'] || 'https';
    var host = req.headers['x-forwarded-host'] || req.headers.host;
    return proto + '://' + host;
  }
  ```
- **Penjelasan:** Persis pola BUG-034 lama (host header menentukan tautan Telegram), yang di `lib/subscription-manual-handler.js` sudah diperbaiki. Di sini masih ada: URL gambar chart dikirim ke Telegram berasal dari header yang bisa dipengaruhi pemanggil. Risiko praktis dibatasi karena `handleTelegramDailyPicks` wajib `CRON_SECRET`, sehingga hanya pemegang rahasia yang bisa memicu — jadi LOW, bukan HIGH. Namun bila CRON_SECRET bocor, penyerang dapat mengarahkan gambar ke host mereka.
- **Bukti verifikasi riil:** Bukti kode; bandingkan dengan perbaikan di `lib/subscription-manual-handler.js`.
- **Usulan arah perbaikan:** Pakai base URL tetap dari env (mis. `PUBLIC_BASE_URL`) alih-alih header request.


## MODUL: Bandarmologi UI + Screener Chart (public/bandarmologi-runtime.js, api/sector-hot.js)

### [MEDIUM] Date OHLC chart Telegram/Pattern memakai potongan UTC naif (kembali)
- **Lokasi:** [`api/sector-hot.js:5707`](api/sector-hot.js:5707)
- **Kutipan kode bermasalah:**
  ```js
  rows.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), open: ..., });
  ```
- **Penjelasan:** Ini `fetchChartOhlcRows` yang dipakai untuk menggambar chart Telegram Top 5 — komentar di baris 5684 mengklaim "Match the web Chart page data source (/api/candles)". Justru di sinilah ia TIDAK match: `/api/candles` memakai `t1Policy.formatJakartaDate(...)` (WIB-aware), sedangkan baris ini memakai potongan UTC. Untuk bar dengan timestamp ≥ 17:00 UTC, tanggal candle bergeser satu hari → label tanggal chart Telegram berbeda dari chart web untuk ticker & hari yang sama. Kelas bug yang sama dengan temuan `api/quote.js`. Sudah ada helper WIB di file yang sama (`getJakartaDateFromTimestamp`).
- **Bukti verifikasi riil:** Bukti kode; bandingkan dengan `api/candles.js:157-158`.
- **Usulan arah perbaikan:** Pakai `getJakartaDateFromTimestamp(timestamps[i] * 1000)`.

### [LOW] Deklarasi `var items` ganda di `buildBrokerBubbleItems`
- **Lokasi:** [`public/bandarmologi-runtime.js:803`](public/bandarmologi-runtime.js:803) dan [`public/bandarmologi-runtime.js:874`](public/bandarmologi-runtime.js:874)
- **Kutipan kode bermasalah:**
  ```js
  // baris 803
  var items = [];
  var maxTxVal = 1;
  var maxAbsNet = 1;
  var codes = Object.keys(map);
  ... (loop mengisi map[codes[c]] dengan it.netVal/it.txVal, TIDAK memakai `items`) ...
  // baris 874
  var items = [];
  if (isGross) { ... items = buyerBrokers.concat(sellerBrokers); } else { ... }
  ```
- **Penjelasan:** Deklarasi pertama (`:803`) tidak pernah dipakai di antara baris 803–874 — loop hanya menghitung/menetapkan field pada `map[...]`. Deklarasi kedua (`:874`) sepenuhnya menimpa deklarasi pertama. Tidak merusak perilaku (deklarasi kedua tetap menang), tetapi menandakan variabel lama yang terbuang dan membuat pembaca berikutnya mengira ada alur data yang hilang.
- **Bukti verifikasi riil:** Bukti kode: rentang 804-873 tidak menyentuh `items`.
- **Usulan arah perbaikan:** Hapus deklarasi di baris 803.

### Catatan tuntas (tanpa bug) — `api/sector-hot.js` bagian yang dibaca batch ini
- Seluruh rangkaian **gate keselamatan Telegram** (baris 4328-5327) konsisten dan berlapis: `textHasFatalTopGuard`, `hasAvoidGrade`, `hasHindariAction`, `deriveFinalTopQualityGate`, `candidatePassesPublicTelegramSafetyGate`, `candidatePassesTop5WatchlistGate`, `candidatePassesTelegramCandidateDigestGate`, `candidatePassesMinUpside`, `rankCandidatesByPotential`. Setiap gate memblokir hal yang sama secara konsisten (avoid/hindari/very-high-risk/invalid-plan/stale/below-SL/weak-liquidity/ARA-ARB), dan frasa nasihat "jangan chase" dinetralkan sebelum dipakai mengambil kesimpulan (baris 4424, 4812, 5057) — perbaikan BUG-027 diterapkan di ketiga jalur. Kokoh.

### Catatan tuntas (tanpa bug) — `public/bandarmologi-runtime.js` bagian yang dibaca batch ini
- `loadBandarmologiTab` ([`:1816-1991`](public/bandarmologi-runtime.js:1816)) memakai pola request-sequence + AbortController yang benar: hasil yang datang terlambat dibuang (`thisRequestSeq !== bandarSummaryRequestSeq`), timer dibersihkan, dan fallback ke VPS tunnel hanya bila backend kosong/demo. Kokoh.
- Fallback "no data" ([`:1948-1982`](public/bandarmologi-runtime.js:1948)) mengembalikan struktur kosong eksplisit (`is_empty: true`, `status: 'NO_DATA'`) alih-alih angka palsu. Kokoh.
- Cache key VPS broker summary sudah menyertakan `range` ([`:1701`](public/bandarmologi-runtime.js:1701)) — perbaikan PR3 terkonfirmasi.

## MODUL: CI / Test Suite (tools/run-build-test-suite.js, tools/curated-build-tests.json)

### [MEDIUM] BUG-002 lama MASIH BELUM DIPERBAIKI — 58 file test tidak pernah dijalankan CI
- **Lokasi:** [`tools/run-build-test-suite.js:69-70`](tools/run-build-test-suite.js:69) vs `tools/curated-build-tests.json`
- **Kutipan kode bermasalah:**
  ```js
  const curatedTestFiles = JSON.parse(fs.readFileSync(curatedConfigFile, 'utf8'));
  const existingFiles = curatedTestFiles.filter(f => fs.existsSync(path.join(ROOT_DIR, f)));
  ```
- **Penjelasan:** Dihitung langsung: `test/*.test.js` = **453 file**, entri di `curated-build-tests.json` = **395**. Selisih **58 file test tidak pernah dieksekusi** oleh `npm run build`/`npm test`. Dokumen lama menandainya "MENUNGGU KEPUTUSAN" dan memang belum ada validator yang menggagalkan build bila ada test tak terdaftar. Konsekuensi: regresi pada 58 file itu tidak akan tertangkap CI — termasuk beberapa test yang relevan dengan temuan di laporan ini (mis. `test/bandarmologi-fix-pack-regression.test.js` yang sedang terbuka di editor).
- **Bukti verifikasi riil:** Perhitungan langsung dari filesystem vs isi JSON (bukan klaim dokumen).
- **Usulan arah perbaikan:** Tambahkan validator di `run-build-test-suite.js` yang gagal bila ada `test/*.test.js` tidak terdaftar, lalu daftarkan 58 file yang hilang.

### [HIGH] BUG-013 diperkuat — token review literal yang sama juga di-hardcode di runner build
- **Lokasi:** [`tools/run-build-test-suite.js:9-10`](tools/run-build-test-suite.js:9)
- **Kutipan kode bermasalah:**
  ```js
  const token = process.env.REVIEW_ACCESS_TOKEN || 'vercel-build-secure-token-entropy-minimum-32b';
  process.env.REVIEW_ACCESS_TOKEN = token;
  ```
- **Penjelasan:** Literal `'vercel-build-secure-token-entropy-minimum-32b'` yang sama dengan fallback di [`api/review-access.js:42`](api/review-access.js:42) muncul lagi di runner build. Ini membuktikan token itu memang nilai yang dipakai sistem (bukan sekadar sisa), dan karena tertulis di dua file source, ia dapat dibaca siapa pun yang melihat repo. Di lingkungan Vercel, `api/review-access.js` menerimanya sebagai token sah → gate review terbuka dengan kredensial publik. **Menegaskan temuan HIGH sebelumnya dengan bukti kedua.**
- **Bukti verifikasi riil:** Dua lokasi source berbeda memuat literal identik.
- **Usulan arah perbaikan:** Hapus literal di kedua file; wajibkan env.


### [LOW] BUG-042 lama SUDAH DIPERBAIKI — Hammer vs Hanging Man kini context-aware
- **Lokasi:** [`lib/candle-pattern-engine.js:248-271`](lib/candle-pattern-engine.js:248)
- **Kutipan kode (bukti perbaikan):**
  ```js
  // Context-aware trend helper for Hammer vs Hanging Man and Inverted Hammer vs Shooting Star (BUG-042)
  var isAtSupportOrPullback = false;
  if (ctx) { if (ctx.support && (c0.low <= ctx.support*1.03 || lastP <= ctx.support*1.03)) isAtSupportOrPullback = true;
             else if (ctx.changePct != null && ctx.changePct <= 0) isAtSupportOrPullback = true;
             else if (c1 && c0.close <= c1.close) isAtSupportOrPullback = true; }
  if (lowerShadow >= body*2 && upperR < 0.15 && bodyRatio < 0.4) {
    if (bull || isAtSupportOrPullback) return { name:'Hammer', bias:'Bullish', ... };
    return { name:'Hanging Man', bias:'Bearish', ... };
  }
  ```
- **Penjelasan:** Dokumen lama menyatakan Hammer vs Hanging Man dibedakan HANYA dari warna candle. Kini ada konteks support/changePct/prev-close. **Perbaikan terkonfirmasi.**

### [LOW] BUG-032 lama SUDAH DIPERBAIKI — reset password admin menyimpan kredensial terproteksi
- **Lokasi:** [`lib/admin-users-handler.js:261-268`](lib/admin-users-handler.js:261) dan `:293-299`
- **Kutipan kode (bukti perbaikan):**
  ```js
  const clientPasswordHash = passwordCredential.normalizeClientHash(newPasswordHash);
  if (!clientPasswordHash) return res.status(400).json({ success:false, error:'Password hash tidak valid.' });
  ...
  // Store the PROTECTED credential (random salt + scrypt), exactly like every other write path
  ```
- **Penjelasan:** Dokumen lama menyatakan hash mentah disimpan tanpa validasi. Kini divalidasi sebagai client-hash 64-hex dan disimpan dalam bentuk terproteksi (`k1` + salt acak + scrypt). **Perbaikan terkonfirmasi.**

### [LOW] `lib/daytrade-screener-engine-v7.js` — TUNTAS, tidak ditemukan bug
- Recall volume pace menegakkan batas keselamatan dengan disiplin: `isSafeStructure` memblokir status terminal/invalid, promosi dibatasi HANYA ke radar (`ENTRY_READY_STATUSES` → `EARLY_RADAR`), skor non-ready di-cap di 74 (`Math.min(adjustedScore, 74)`) sehingga tidak bisa memalsukan sinyal entry, dan `volume_pace_recall_applied` hanya true bila benar-benar berubah. Kokoh.

---

## CATATAN AKHIR STATUS VERIFIKASI KLAIM LAMA

| Klaim lama | Hasil verifikasi kode kini |
|---|---|
| BUG-013 token review | **BELUM DIPERBAIKI** (HIGH) |
| BUG-025 `includesAny` 300 char | **BELUM DIPERBAIKI** (HIGH) — hanya ditambah diagnostik |
| BUG-038 retensi foreign tanpa limit | **BELUM DIPERBAIKI** (MEDIUM) |
| BUG-015 RSI 0/0 | SUDAH diperbaiki |
| BUG-022 support runtuh 0 | SUDAH diperbaiki |
| BUG-027 "jangan chase" salah baca | SUDAH diperbaiki |
| BUG-032 reset password admin | SUDAH diperbaiki |
| BUG-042 Hammer/Hanging Man | SUDAH diperbaiki |

Kesimpulan: dari 8 klaim lama yang diverifikasi langsung ke kode, **3 masih belum diperbaiki** (2 di antaranya HIGH). Ini konsisten dengan keluhan user bahwa bug nyata masih ada meski dokumen mengklaim selesai.

### [HIGH] BUG-025 lama MASIH BELUM DIPERBAIKI — hanya dipasangi "diagnostik", pemotongan 300 karakter tetap aktif
- **Lokasi:** [`api/sector-hot.js:13643-13683`](api/sector-hot.js:13643)
- **Kutipan kode bermasalah:**
  ```js
  function includesAny(text, words) {
    ...
    var t = safeTelegramText(text, 300, '').toLowerCase();   // <-- teks DIPOTONG ke 300 char
    ...
    // BUG-025 Diagnostic (Dry-run, pure observation - does NOT alter gate behavior):
    if (text != null && typeof text !== 'object') {
      var rawText = String(text)...;                          // dihitung dari teks PENUH
      if (rawText.length > 300) {
        includesAnyDiagnostics.calls_exceeding_300++;
        if (!matched && ...) { /* catat missed match */ }
  ```
- **Penjelasan:** Dokumen lama menandai ini HIGH dan "MENUNGGU KEPUTUSAN". Kode sekarang menambahkan blok diagnostik yang secara eksplisit berkomentar **"does NOT alter gate behavior"** — jadi pemotongan 300 karakter **masih** terjadi. Fungsi ini dipakai gate keselamatan Telegram ([`:12806-12807`](api/sector-hot.js:12806)) untuk mendeteksi kata seperti `stale`, `invalid plan`, `weak liquidity`, `very high risk`. Bila kata pemicu berada di posisi >300 karakter dalam teks gabungan, gate gagal menemukannya → sinyal berisiko lolos sebagai "aman" (fail-OPEN). Perhatikan pula `joinTelegramTexts` ([`:13685-13687`](api/sector-hot.js:13685)) memotong SETIAP bagian ke 120 karakter, sehingga kata pemicu yang berada di ujung field panjang (mis. `status_reason` atau `plan_quality_note`) rutin terpotong sebelum `includesAny` bahkan melihatnya. Diagnostik hanya mencatat kejadian, tidak memperbaiki.
- **Bukti verifikasi riil:** Kode dibaca langsung. Komentar "does NOT alter gate behavior" adalah pengakuan eksplisit bahwa bug belum diperbaiki.
- **Usulan arah perbaikan:** Hapus batas 300 (atau naikkan jauh) di `includesAny` khusus untuk jalur gate; perbesar batas `joinTelegramTexts`. Jangan biarkan gate keselamatan bergantung pada pemotongan teks.

### [LOW] BUG-015 lama SUDAH DIPERBAIKI — RSI 0/0 kini dinetralkan ke 50, bukan overbought
- **Lokasi:** [`api/quote.js:1484`](api/quote.js:1484), [`api/candles.js:294`](api/candles.js:294), [`lib/daytrade-screener-engine.js:2174`](lib/daytrade-screener-engine.js:2174)
- **Kutipan kode (bukti perbaikan):** `if (avgGain === 0 && avgLoss === 0) return 50;`
- **Penjelasan:** Dokumen lama menyatakan RSI 0/0 pada saham beku dilaporkan sebagai overbought ekstrem di 6 salinan. Kini ketiga salinan utama yang diperiksa mengembalikan netral 50. **Perbaikan terkonfirmasi.** Dicatat agar tidak dihitung bug lagi.

### Catatan verifikasi batch ini
- `lib/password-credential.js` memakai `timingSafeEqual` + format `k1` acak — **klaim BUG-032 (reset password admin) perlu dicek di `lib/admin-users-handler.js`**, belum diverifikasi di sini.
- `api/review-access.js` memakai `crypto.timingSafeEqual` dan rate limiter — bagian timing-safe **sudah benar**; yang tersisa hanyalah fallback token BUG-013 di atas.

## MODUL: Verifikasi ulang klaim `AUDIT_FINDINGS.md` / `AUDIT_CHECKPOINT.md` (44 bug lama)

Dokumen lama mengklaim 44 BUG (25 "sudah diperbaiki", 19 "belum"). Berikut hasil cek ulang ke kode SEKARANG.

### [HIGH] BUG-013 lama MASIH BELUM DIPERBAIKI — token review masih punya default yang tertulis di source untuk lingkungan Vercel
- **Lokasi:** [`api/review-access.js:42-44`](api/review-access.js:42)
- **Kutipan kode bermasalah:**
  ```js
  const fallbackBuildToken = (process.env.VERCEL || process.env.VERCEL_ENV) ? 'vercel-build-secure-token-entropy-minimum-32b' : '';
  const token = process.env.REVIEW_ACCESS_TOKEN || fallbackBuildToken;
  const EXPECTED_TOKEN = String(token || '').trim();
  if (!EXPECTED_TOKEN || EXPECTED_TOKEN.length < 16) { /* 403 */ }
  ```
- **Penjelasan:** Logikanya sudah fail-closed bila env kosong **kecuali** di lingkungan Vercel — dan di situlah produksi berjalan. Panjang literal itu 39 karakter, jadi melewati gerbang `length < 16` dan diterima sebagai token yang sah. Siapa pun yang membaca source (dokumen lama menyebut repo ini publik; repo punya 557 branch) dapat memakai token itu untuk membuka `surface` review. Komentar di baris 37-41 mengklaim masalah ini sudah diperbaiki ("used to fall back to a literal default token"), padahal fallback literal masih ada untuk jalur yang justru paling penting.
- **Bukti verifikasi riil:** Kode kini dibaca langsung; dokumen lama menandainya "MENUNGGU KEPUTUSAN", dan memang belum berubah. Bukan hipotesis.
- **Usulan arah perbaikan:** Hapus `fallbackBuildToken` sepenuhnya; wajibkan `REVIEW_ACCESS_TOKEN` di semua lingkungan.

### [MEDIUM] BUG-038 lama MASIH BELUM DIPERBAIKI — retensi foreign flow masih tanpa `.limit()`
- **Lokasi:** [`lib/admin-foreign-upload.js:217-221`](lib/admin-foreign-upload.js:217)
- **Kutipan kode bermasalah:**
  ```js
  const lookup = await supabase.from('foreign_watchlist_daily')
    .select('id,ticker,trade_date').in('ticker', tickerBatch)
    .order('trade_date', { ascending: false });   // tidak ada .limit()
  ```
- **Penjelasan:** Persis pola yang sudah didokumentasikan dan diperbaiki di `lib/stock-daily-history-store.js:54-73` (docstring menyebutnya "confirmed bug — retention was silently a no-op"), tetapi `foreign_watchlist_daily` belum mendapat perbaikan yang sama. Pada deployment dengan cap respons PostgREST (~1.000 baris), hasil terpotong ke baris terbaru sehingga loop penghapusan tidak pernah menemukan baris melewati batas retensi → retensi 7 hari diam-diam tidak berlaku. Dokumen lama menandainya "MENUNGGU KEPUTUSAN"; kode membuktikan belum diperbaiki.
- **Bukti verifikasi riil:** Kode dibaca; bandingkan dengan `SAFE_QUERY_ROW_BUDGET`/`RETENTION_TRIM_HEADROOM` yang ada di store sebelah.
- **Usulan arah perbaikan:** Salin pola bounded-chunk dari `lib/stock-daily-history-store.js:74-113`.

### [LOW] BUG-027 lama SUDAH DIPERBAIKI — diverifikasi, jangan diulang di batch berikutnya
- **Lokasi:** [`lib/idx-tick-normalization.js:886`](lib/idx-tick-normalization.js:886)
- **Kutipan kode (bukti perbaikan):**
  ```js
  var cleanObservation = observationNotes.replace(/(?:jangan|anti|tidak|no)[ -]chase\b/g, ' ');
  ```
- **Penjelasan:** Dokumen lama menyatakan peringatan "JANGAN chase" dibaca sistem sebagai bukti harga sedang di-chase (BUG-027, HIGH). Kode kini secara eksplisit menghapus frasa nasihat `jangan/anti/tidak/no chase` dari catatan observasi sebelum dipakai mengambil kesimpulan, dan memisahkan `noteText` (nasihat) dari `cleanObservation` (observasi). **Perbaikan terkonfirmasi ada.** Ini contoh klaim lama yang BENAR — dicatat agar tidak dihitung bug lagi.

### [LOW] BUG-022 lama SUDAH DIPERBAIKI — diverifikasi
- **Lokasi:** [`api/sector-hot.js:1885`](api/sector-hot.js:1885) terkait klaim "support runtuh jadi 0"
- **Penjelasan:** Tidak ditemukan lagi jalur `high/low` Yahoo yang runtuh menjadi 0 untuk Swing Non-Konglo pada kode `calculateIndicators`/`analyzeDayTrade` yang dibaca; `deriveDataQualityStatus` ([`lib/daytrade-screener-engine.js:79-81`](lib/daytrade-screener-engine.js:79)) kini menolak candle dengan `high < low`, `close > high`, `close < low`, dsb → status `INVALID_CANDLE` alih-alih meneruskan `support = 0`. Perbaikan terlihat ada.

### Catatan metode
Pemeriksaan ini menegaskan peringatan awal: **klaim "sudah diperbaiki" sebagian benar dan sebagian keliru.** BUG-027 dan BUG-022 terkonfirmasi diperbaiki; BUG-013 dan BUG-038 terkonfirmasi BELUM. Setiap klaim lama harus diperlakukan sebagai hipotesis sampai kode membuktikannya.

## VERIFIKASI SILANG: VPS Data Fetcher (lib/vps-data-fetcher.js) — menegaskan temuan HIGH sebelumnya

- **Lokasi:** [`lib/vps-data-fetcher.js:243,247,315,319`](lib/vps-data-fetcher.js:243)
- **Kutipan:** `function fetchBrokerSummaryFromVpsSync(ticker, date = '2026-09-08')`, `const safeDate = String(date || '2026-09-08')...`, idem di versi async.
- **Bukti tambahan (verifikasi perilaku):** Kedua fungsi mencoba `candidateDates = [safeDate]` LALU `'latest'`, tetapi `safeDate` default adalah tanggal tetap `2026-09-08`. Selama file `2026-09-08.json` masih ada di VPS, pemanggil tanpa argumen tanggal akan menerima data sesi 2026-09-08 dan tidak pernah mencapai `'latest'`. Ini mengonfirmasi dampak nyata (bukan hanya hipotetis) dari temuan HIGH `vps-data-fetcher` sebelumnya: bridge harga Bandarmologi dapat menyajikan sesi lama sebagai hasil default.
- **Arah perbaikan:** Default harus `null`/`'latest'`, bukan tanggal tetap.

### Catatan tuntas (tanpa bug) — modul yang dibaca batch ini
- `lib/report-helpers.js`: `classifyOutcome` menegakkan kronologi TP-before-SL yang benar (posisi yang sempat hit TP tetap dihitung win walau SL menyusul), `getMonitorSource` menangani variasi nama sumber, `calculateRate` aman terhadap pembagian nol. Kokoh. **Ini penting untuk Track Record: tidak ditemukan bug di sini.**
- `lib/ai-context-snapshot-store.js`: sanitasi ketat (batas ukuran, validasi ticker, whitelist field), `price_meta` diteruskan sehingga AI tahu umur harga. Kokoh.
- `api/admin-users.js` (120 baris pertama): `requireBudiAdmin` cek same-origin + sesi admin terverifikasi + username 'budi'; `resolvePremiumPortfolioAccess` memakai `requirePremiumEntitlement`. Kokoh.
- `public/pattern-map.js`, `public/dashboard-top5-only-ui.js`, `public/unified-cockpit-runtime.js`: presentasi saja, authorisasi server-verified, sinkronisasi ticker konsisten. Kokoh.

## MODUL: Transparansi Gate Sinyal (public/signal-gate-transparency.js)

### [MEDIUM] Ambang batas di panel "Kenapa Sinyal Ini Lolos Gate?" TIDAK cocok dengan gate server — menyesatkan user
- **Lokasi:** [`public/signal-gate-transparency.js:57`](public/signal-gate-transparency.js:57), `:64`, `:90`, `:95`, `:99`
- **Kutipan kode bermasalah:**
  ```js
  var minValTarget = isNonKonglo ? 10e9 : (isDayTrade ? 3e9 : 5e9); // 10M Non-Konglo, 3M DT, 5M Konglo
  var minVolRatio = isDayTrade ? 1.2 : 1.0;
  rsiPassed = rsi <= 78 && rsi >= 35;
  var rsiThresholdText = '35 - 75 (Zona Aman)';   // <-- teks bilang 75, kode pakai 78
  var minRR = isDayTrade ? 1.2 : 1.5;
  ```
- **Penjelasan:** Panel ini menjawab pertanyaan user "kenapa sinyal ini muncul" dengan menampilkan nilai aktual vs ambang. Tetapi ambangnya di-hardcode di frontend dan TIDAK sama dengan gate server: gate likuiditas Day Trade sebenarnya `MIN_VALUE_TODAY = 1e9` / `MIN_AVG_VALUE_7D = 5e8` (`lib/daytrade-screener-engine.js:379-380`), sedangkan panel mengklaim 3e9. Selain itu teks ambang RSI berbunyi "35 - 75" padahal kode memakai `<= 78`. Jadi user membaca checklist yang secara faktual salah tentang gate yang sebenarnya menyaring sinyal — kelas "transparansi palsu".
- **Bukti verifikasi riil:** Perbandingan kode langsung: nilai frontend vs nilai backend berbeda numerik; teks vs kode berbeda (75 vs 78).
- **Usulan arah perbaikan:** Kirim ambang batas aktual dari backend bersama payload sinyal (mis. `gate_thresholds`), lalu tampilkan itu; atau kalau memang hanya indikatif, beri label "indikatif" dan selaraskan teks dengan kode.

### [LOW] Komentar satuan salah pada ambang likuiditas (`10e9` dilabeli "10M")
- **Lokasi:** [`public/signal-gate-transparency.js:57`](public/signal-gate-transparency.js:57)
- **Penjelasan:** `10e9 / 3e9 / 5e9` adalah 10 miliar / 3 miliar / 5 miliar, tetapi komentarnya menulis "10M / 3M / 5M". Komentar salah satuan memperbesar risiko orang mengubah angka berdasarkan label yang keliru.
- **Usulan arah perbaikan:** Perbaiki komentar menjadi "10 miliar / 3 miliar / 5 miliar".

### Catatan tuntas (tanpa bug) — `public/pattern-map.js`
- `validateCandidate` melakukan verifikasi ketat: ticker+timeframe+dataDate cocok dengan konteks, candle set identik dengan sumber (byte-identik per OHLC), urutan candle/pivot naik, pivot harus berada di dalam candle sumber dengan harga yang sama persis, PRZ valid, bukti konfirmasi wajib untuk status confirmed. Gate admin Pattern Map server-verified (bukan query/window flag). Sangat kokoh.

## MODUL: Portfolio (public/portfolio-command-center.js, public/portfolio-ai-runtime-v2.js)

### [MEDIUM] Refresh harga Portfolio tidak menulis metadata kesegaran → AI Portfolio menilai harga dengan umur yang salah
- **Lokasi:** [`public/portfolio-command-center.js:392-393`](public/portfolio-command-center.js:392) vs [`public/portfolio-ai-runtime-v2.js:79`](public/portfolio-ai-runtime-v2.js:79) & `:485`
- **Kutipan kode bermasalah:**
  ```js
  // portfolio-command-center.js — refreshAllPrices()
  rows.forEach(function (row) { if (row[1] && row[1] > 0) { state.prices[row[0]] = Math.round(row[1]); updated += 1; } });
  saveJson(pricesKey(), state.prices); localStorage.setItem(priceTimeKey(), String(Date.now()));
  ```
  ```js
  // portfolio-ai-runtime-v2.js — contextNow()
  var meta = readJson(pricesKey + '_meta_v1', {});
  ...
  priceMeta[row.ticker] = { at: entryMeta && entryMeta.iso ? ... : null, age_minutes: capturedMs != null ? Math.max(0, Math.round((now-capturedMs)/60000)) : null, provider_marked_stale: entryMeta && typeof entryMeta.stale === 'boolean' ? entryMeta.stale : null, ... };
  ```
- **Penjelasan:** Harga diperbarui oleh Command Center (dua tombol: `refreshToday`, `refreshPrices` → `refreshAllPrices`) tetapi **tidak pernah** menulis side-map `autocuan_portfolio_prices_<uid>_meta_v1` — hanya `portfolio-ai-runtime-v2.js:485` yang menulisnya. Akibatnya setelah user menekan "Refresh Harga" di Command Center, AI Portfolio membaca metadata lama/kosong: `provider_marked_stale` boleh tetap `true` dari pembacaan sebelumnya, dan `age_minutes` tetap menghitung dari waktu capture lama. AI lalu memberi peringatan "harga usang" tentang harga yang sebenarnya baru saja disegarkan, atau sebaliknya menganggapnya segar. Ini konflik data antar dua modul yang memakai sumber harga yang sama.
- **Bukti verifikasi riil:** Bukti kode: `findstr` menunjukkan `_meta_v1` hanya ditulis di `portfolio-ai-runtime-v2.js:485`, sedangkan penulis `state.prices` utama (`portfolio-command-center.js:393`) tidak menyentuhnya.
- **Usulan arah perbaikan:** Satukan penulis harga ke satu helper (tulis `prices` + `_meta_v1` bersama), atau Command Center memanggil helper metadata yang sama.

### Catatan tuntas (tanpa bug) — modul Portfolio yang dibaca
- `lib/portfolio-state-handler.js`: auth premium + same-origin, batas ukuran state, optimistic-concurrency via `expected_updated_at` + penanganan 23505 saat bootstrap race, sanitasi bentuk state. Kokoh.
- `public/portfolio-command-center.js`: pemisahan tegas "missing ≠ zero" (`finite()`), render portofolio lokal sebelum panggilan jaringan, fetch ber-timeout. Kokoh.
- `public/portfolio-runtime-fix.js`: migrasi ID rencana legacy deterministik + penghapusan atomic. Kokoh.

## MODUL: Kolektor Riwayat Harian (lib/daily-history-collector.js)

### [MEDIUM] `trade_date` yang DIPERSIST ke `stock_daily_history` dihitung dari potongan UTC naif
- **Lokasi:** [`lib/daily-history-collector.js:149`](lib/daily-history-collector.js:149) dan [`lib/daily-history-collector.js:136`](lib/daily-history-collector.js:136)
- **Kutipan kode bermasalah:**
  ```js
  var rowDate = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
  ...
  var metaDate = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10) : null;
  ```
- **Penjelasan:** `rowDate` menjadi `trade_date` yang di-upsert ke `stock_daily_history` — sumber untuk RSI, volume 7D, foreign flow, dan Ranking Harian. Untuk bar harian IDX, Yahoo umumnya menstempel timestamp sekitar 02:00 UTC (09:00 WIB), sehingga potongan UTC kebetulan benar; namun ini bergantung pada perilaku provider, bukan pada kebijakan WIB eksplisit. Bila provider menggeser stempel (mis. ke 17:00+ UTC), seluruh tanggal riwayat bergeser satu hari dan merusak semua turunannya. Modul lain di repo sudah memakai konversi WIB eksplisit; di sini tidak.
- **Bukti verifikasi riil:** Belum. Bukti kode: pola UTC-slice pada nilai yang dipersist sebagai tanggal sesi. Perlu cek sampel `stock_daily_history.trade_date` vs tanggal sesi IDX sebenarnya.
- **Usulan arah perbaikan:** Pakai `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })` (pola yang sudah dipakai `lib/chart-engine/candle-fetcher.js:43` dan `lib/idx-trading-calendar.js`).

### Catatan tuntas (tanpa bug) — `lib/chart-engine/candle-fetcher.js`
- Cache-first idempotent, kuota harian berbasis kunci WIB (`todayWibKey` memakai `Intl` timeZone Asia/Jakarta — BENAR), normalisasi payload menangani beberapa bentuk respons, sort oldest-first, clamp limit ≥ 20. Kokoh.

## MODUL: Bandarmologi Intel & Pattern (lib/bandarmologi-intel-service.js, lib/pattern-abcd.js, lib/intraday-fast-watcher.js, lib/trade-plan-v2.js, lib/telegram-notifier.js)

### [MEDIUM] Perbandingan kesegaran candle di `bandarmologi-intel-service.js` memakai tanggal UTC-naif → candle segar bisa ditolak sebagai stale
- **Lokasi:** [`lib/bandarmologi-intel-service.js:389`](lib/bandarmologi-intel-service.js:389) dan [`lib/bandarmologi-intel-service.js:628`](lib/bandarmologi-intel-service.js:628)
- **Kutipan kode bermasalah:**
  ```js
  const candleDate = lastCandle && (lastCandle.date || (lastCandle.time ? new Date(lastCandle.time*1000).toISOString().slice(0,10) : null));
  const bsDates = bandarmologiService.listDiskDates('broker-summary', clean);
  if (candleDate && bsDates && bsDates.length > 0 && candleDate < bsDates[0]) staleCandle = true;
  ```
- **Penjelasan:** Gerbang anti-stale (perbaikan PR4 untuk kasus CUAN/PTRO) bergantung pada `candleDate` yang dihitung dari potongan UTC. Untuk candle dengan timestamp ≥ 17:00 UTC, `candleDate` mundur satu hari sehingga bisa tampak lebih tua daripada `bsDates[0]` dan candle yang SEBENARNYA segar ditolak → harga jatuh ke VWAP broker-summary. Ini justru dapat memunculkan "harga ngaco" yang hendak dicegah perbaikan itu sendiri.
- **Bukti verifikasi riil:** Belum. Bukti kode: pola UTC-slice pada nilai yang dibandingkan dengan tanggal disk WIB.
- **Usulan arah perbaikan:** Pakai konversi WIB (+7 jam) seperti helper di file lain sebelum membandingkan.

### Catatan tuntas (tanpa bug) — modul yang dibaca batch ini
- `lib/pattern-abcd.js`: geometri ABCD v1 deterministik, menolak pivot ambigu/outside-bar, urutan pivot divalidasi, invalidation diprioritaskan sebelum confirmation pada candle ambigu, ATR/level divalidasi. Kokoh.
- `lib/intraday-fast-watcher.js`: validasi tanggal/ticker/time, allow-list READY vs NOT_READY, guard anti-chase (advance > 6%), dedup event ber-hash. Kokoh.
- `lib/trade-plan-v2.js`: satu engine kanonik untuk ketiga screener, profil ter-freeze, `normalizeScreenerType` konsisten, tidak membaca wall-clock/Supabase. Kokoh.
- `lib/telegram-notifier.js`: guard jam bursa, dedup cooldown stateful, throttle + backoff 429 retry_after, chunking pesan, tidak pernah melempar. Kokoh.
- `api/sector-hot.js` bagian `callAIConfirmation` (parser AI), `verifyCronSecret`, `normalizeScreenerStatus`, `deriveSwingLabels`, `scoreAndClassify`: konsisten.

## MODUL: Screener Konglo & Day Trade (api/sector-hot.js, lib/daytrade-screener-engine.js)

### [MEDIUM] `api/sector-hot.js` menyimpan `price_date` dari potongan UTC naif pada candle Yahoo
- **Lokasi:** [`api/sector-hot.js:1885`](api/sector-hot.js:1885)
- **Kutipan kode bermasalah:**
  ```js
  price_date: candles[lastIdx] && candles[lastIdx].time ? new Date(candles[lastIdx].time * 1000).toISOString().slice(0, 10) : null,
  ```
- **Penjelasan:** Sama seperti kelas bug tanggal UTC-naif: `price_date` yang dipersist ke `swing_screener_latest` bisa mundur satu hari untuk candle dengan timestamp UTC ≥ 17:00. Karena `price_date` dipakai untuk gerbang kesegaran harga (`attachPriceFreshness`/`validateScreenerPriceFreshness`), tanggal yang salah dapat membuat harga segar ditandai stale atau sebaliknya. Modul lain di file yang sama (`getJakartaDateString`, `getJakartaDateFromTimestamp`) sudah benar menambahkan +7 jam; baris ini tidak.
- **Bukti verifikasi riil:** Belum. Bukti kode: pola UTC-slice pada field tanggal yang dipakai gerbang freshness.
- **Usulan arah perbaikan:** Pakai `getJakartaDateFromTimestamp(candles[lastIdx].time * 1000)` yang sudah ada di file yang sama.

### [LOW] Cabang `status === 'Speculative'` di `deriveSwingLabels` adalah dead code
- **Lokasi:** [`api/sector-hot.js:11644`](api/sector-hot.js:11644)
- **Kutipan kode bermasalah:**
  ```js
  } else if (status === 'Speculative' || (status === 'Watchlist' && score < 60 && score >= 40)) {
  ```
- **Penjelasan:** Produsen status `scoreAndClassify` ([`api/sector-hot.js:2158-2184`](api/sector-hot.js:2158)) tidak pernah menghasilkan string `'Speculative'` — hanya `'Swing Ready'`, `'Wait Pullback'`, `'Rebound Speculative'`, `'Watchlist'`, `'Invalid'`. Jadi kondisi `status === 'Speculative'` tak pernah benar; hanya cabang `Watchlist && score<60` yang aktif. Tidak merugikan, tapi menandakan label status yang tidak sinkron antar fungsi.
- **Bukti verifikasi riil:** Bukti kode: pencarian seluruh file menunjukkan `'Speculative'` hanya muncul di sini sebagai pembanding, bukan sebagai nilai yang di-assign.
- **Usulan arah perbaikan:** Hapus kondisi mati atau selaraskan daftar status dengan produsennya.

### Catatan tuntas (tanpa bug) — `api/sector-hot.js` bagian yang dibaca
- `verifyCronSecret` ([`:9453`](api/sector-hot.js:9453)) memakai `crypto.timingSafeEqual` dengan cek panjang — aman.
- Parser AI line-protocol `callAIConfirmation` ([`:2222`](api/sector-hot.js:2222)) menangani banyak bentuk respons (content string/array, reasoning_content, output_text, JSON fallback) dan memvalidasi status ke CONFIRMED/CAUTION/REJECT — kokoh.
- `normalizeScreenerStatus`/`getCanonicalPriority` ([`:3010`](api/sector-hot.js:3010)) konsisten dengan filter AI (READY/REBOUND/WATCH).
- `deriveSwingLabels` ([`:11586`](api/sector-hot.js:11586)) membandingkan status dengan string yang benar-benar dihasilkan `scoreAndClassify` — sinkron.

### Catatan tuntas (tanpa bug) — `lib/daytrade-screener-engine.js` bagian yang dibaca
- Gate R/R keras (`classifyStatus` → `WAIT_PULLBACK` bila RR < MIN_RR_RATIO), guard Akselerasi, guard afternoon, guard candle-close (Batch 11) semuanya konsisten.
- `calculateDayTradeScore` menegakkan plafon 64 bila volume ratio < 1.0 (meritokrasi transaksi riil) — sesuai desain.
- `getMarketSessionStatus` ([`:153`](lib/daytrade-screener-engine.js:153)) memakai offset WIB +7h yang benar.

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

---

## MODUL: Template Deterministik & Kontrak Jawaban AI (lib/analyze-legacy.js, lib/ai-answer-contract.js, lib/ai-telemetry.js)

Batch ini membaca TUNTAS: `lib/ai-answer-contract.js` (254 baris), `lib/ai-telemetry.js` (76 baris), `lib/analyze-legacy.js` (1.920 baris). `lib/ai-telemetry.js` **BERSIH** (in-memory counter sederhana, tanpa payload sensitif, tanpa token leak). Temuan di dua file lain:

### [HIGH] Template deterministik "data-driven" mengarang RSI14=50, volume=1x, dan perubahan harga=0 saat data absen — lalu angka karangan itu dipakai menghitung Status/Bias/Confidence
- **Lokasi:** [`lib/analyze-legacy.js:1074-1076`](lib/analyze-legacy.js:1074) (IHSG), [`lib/analyze-legacy.js:1231-1233`](lib/analyze-legacy.js:1231) (saham), dipicu jalur `extractStatedPrice` [`lib/analyze-legacy.js:141-145`](lib/analyze-legacy.js:141) dan [`lib/analyze-legacy.js:206-210`](lib/analyze-legacy.js:206)
- **Kutipan kode bermasalah:**
  ```js
  // buildIHSGFixedTemplate
  var changePct = d.priceChange1D != null ? d.priceChange1D : 0;
  var volRatio = d.volumeVsAvg20 != null ? d.volumeVsAvg20 : 1;
  var rsi14 = d.rsi14 || 50;
  // buildStockFixedTemplate
  var changePct = d.priceChange1D != null ? d.priceChange1D : 0;
  var volRatio = d.volumeVsAvg20 != null ? d.volumeVsAvg20 : 1;
  var rsi14 = d.rsi14 || 50;
  // lalu dipakai di decision logic + dirender:
  html += '<div>RSI14: ' + idn(rsi14) + ' (' + rsiLabel + ')</div>';
  html += '<div>Volume: ' + ratio(volRatio) + ' avg 20D</div>';
  ```
- **Penjelasan:** Jalur `message_stated_price` membangun objek data dengan SEMUA field teknikal `null` kecuali `last` ([`:143`](lib/analyze-legacy.js:143), [`:208`](lib/analyze-legacy.js:208)); jalur ticker-mode juga hanya mengirim harga ([`:399`](lib/analyze-legacy.js:399)). Di template, field yang `null` DIGANTI nilai default (RSI=50 "netral", volume=1x "normal", change=0%) dan dirender sebagai fakta: kartu menampilkan "RSI14: 50 (netral)" dan "volume 1x rata-rata" padahal tidak ada data RSI/volume sama sekali. Lebih parah, default itu masuk ke decision logic ([`:1263-1281`](lib/analyze-legacy.js:1263)) sehingga Status/Bias/Confidence/Action ("Tunggu Konfirmasi", "Medium") dihitung dari angka yang tidak pernah ada. Ini kontradiksi desain dengan frontend yang justru sengaja OMIT field absen ("absent stays absent", [`public/market-feature-runtime.js:585-606`](public/market-feature-runtime.js:585)) dan dengan prompt AI yang berulang kali melarang mengarang angka. Kartu deterministik — yang dibuat justru untuk MENGHINDARI halusinasi AI — menjadi sumber angka rekaan di alur utama "user ketik ticker+harga".
- **Bukti verifikasi riil:** Bukti kode + kontrak frontend: `fetchQuoteContext` hanya menulis baris yang `!= null` (komentar eksplisit di `market-feature-runtime.js:626-632`), sehingga `d.rsi14`/`d.volumeVsAvg20` memang bisa `null` saat diparse `parseMarketDataFromMessage` ([`:1041-1067`](lib/analyze-legacy.js:1041) mengembalikan `null` untuk field absen). Jalur stated-price terlihat langsung: objek di [`:143`](lib/analyze-legacy.js:143) semua `null` kecuali `last`.
- **Usulan arah perbaikan:** Jangan substitusi nilai; render "—" untuk metrik absen dan JANGAN pakai metrik absen dalam decision logic (turunkan confidence atau tandai "data teknikal belum tersedia"). Samakan dengan kontrak `!= null` milik frontend.

### [MEDIUM] `provider` di respons ticker-mode selalu dilaporkan `'deepseek'` walau jawaban berasal dari Gemini
- **Lokasi:** [`lib/analyze-legacy.js:416-419`](lib/analyze-legacy.js:416)
- **Kutipan kode bermasalah:**
  ```js
  if (!tHtml) {
    return res.status(200).json({ html: '...', provider: 'fallback' });
  }
  return res.status(200).json({ html: sanitizeOutput(tHtml, fcaConfirmed, 'ticker_price_basic'), intent: 'ticker_price_basic', provider: tHtml ? 'deepseek' : 'gemini-fallback' });
  ```
- **Penjelasan:** Di titik baris 419, `tHtml` pasti truthy (jika falsy sudah `return` di baris 416). Ekspresi `tHtml ? 'deepseek' : 'gemini-fallback'` karena itu selalu bernilai `'deepseek'` — termasuk saat `tHtml` sebenarnya hasil `callGemini` ([`:413-414`](lib/analyze-legacy.js:413)). Label provider di respons jadi salah; audit/troubleshooting provider AI membaca data yang keliru (mis. mengira DeepSeek aktif padahal DeepSeek tidak dikonfigurasi). Ini kelas yang sama dengan temuan label model hardcode di UI (menyesatkan audit AI).
- **Bukti verifikasi riil:** Bukti kode langsung: cabang `!tHtml` sudah return lebih dulu; ternary tidak punya nilai lain yang mungkin.
- **Usulan arah perbaikan:** Simpan asal provider secara eksplisit (variabel `tProvider` diisi saat masing-masing call sukses) lalu kirim variabel itu.

### [MEDIUM] Daftar model Gemini deprecated disalin ulang 4× di `analyze-legacy.js` dengan isi BERBEDA dari daftar otoritatif provider (3 nama vs 7 nama)
- **Lokasi:** [`lib/analyze-legacy.js:457`](lib/analyze-legacy.js:457), [`lib/analyze-legacy.js:631`](lib/analyze-legacy.js:631), [`lib/analyze-legacy.js:1648`](lib/analyze-legacy.js:1648), [`lib/analyze-legacy.js:1730`](lib/analyze-legacy.js:1730)
- **Kutipan kode bermasalah:**
  ```js
  var geminiModel = (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL !== 'gemini-3-flash' && process.env.GEMINI_MODEL !== 'gemini-2.5-flash' && process.env.GEMINI_MODEL !== 'gemini-1.5-flash') ? process.env.GEMINI_MODEL : 'gemini-3.8-flash';
  ```
- **Penjelasan:** `lib/ai-gemini-provider.js` menetapkan daftar deprecated otoritatif berisi 7 nama (`gemini-1.5-flash`, `gemini-1.5-pro`, `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash`, `gemini-3.0-flash`, `gemini-3.1-flash`) dan fungsi `sanitizeGeminiModel`. `analyze-legacy.js` menyalin logika itu 4× dengan daftar hanya 3 nama — `gemini-1.5-pro`, `gemini-2.5-pro`, `gemini-3.0-flash`, `gemini-3.1-flash` LOLOS filter. Jika `GEMINI_MODEL` di lingkungan produksi bernilai salah satu nama yang lolos itu (atau daftar provider diperbarui lagi tanpa menyentuh file ini), jalur AI legacy memanggil model yang tidak valid → 404 → fallback diam. Ini memperkuat temuan CRITICAL "nama model bertabrakan antar modul" dengan satu lokasi baru.
- **Bukti verifikasi riil:** Bukti kode: 4 literal filter yang identik dan daftar provider yang lebih lengkap; `grep` `gemini-3.8-flash` menunjukkan salinan terpisah, bukan konstanta bersama.
- **Usulan arah perbaikan:** Impor `sanitizeGeminiModel`/konstanta dari `lib/ai-gemini-provider.js` dan hapus 4 salinan.

### [MEDIUM] `fetchServerSideQuote` menghitung pivot/MA/RSI dari candle TERAKHIR (termasuk bar hari berjalan) padahal seluruh label menyebut "Data Historis T-1"
- **Lokasi:** [`lib/analyze-legacy.js:1494-1557`](lib/analyze-legacy.js:1494) (khusus `lastIdx = candles.length - 1` di [`:1500`](lib/analyze-legacy.js:1500) dan pivot di [`:1537`](lib/analyze-legacy.js:1537))
- **Kutipan kode bermasalah:**
  ```js
  var lastIdx = candles.length - 1;
  var last = Math.round(candles[lastIdx].close * 100) / 100;
  ...
  var pivotPoint = Math.round(((high + low + last) / 3) * 100) / 100;
  var resistance1 = Math.round(((2 * pivotPoint) - low) * 100) / 100;
  ```
- **Penjelasan:** `fetchYahooChartOnce` mengambil `range=90d&interval=1d`; selama jam bursa bar terakhir adalah candle hari ini yang belum close. Pivot klasik, support/resistance, MA, dan RSI dihitung dari bar itu — bukan dari candle selesai T-1 — sehingga level pada kartu analisis berubah-ubah intraday dan tidak sesuai klaim "Basis Data: Data Historis T-1" yang ditulis di blok enrichment maupun prompt. Ini kelas bug yang SAMA dengan temuan CRITICAL `api/quote.js` (definisi harga terakhir) dan HIGH pivot `api/quote.js`, kini di jalur fallback `analyze-legacy` (dipakai saat frontend tidak mengirim data, dan oleh `api/analyze.js:5`).
- **Bukti verifikasi riil:** Bukti kode: tidak ada filter tanggal/cutoff sebelum `lastIdx`; `lib/chart-t1-policy.js` menyediakan kebijakan cutoff tetapi tidak dipanggil di file ini.
- **Usulan arah perbaikan:** Terapkan cutoff candle selesai (T-1) via `lib/chart-t1-policy.js`/`lib/idx-trading-calendar.js` sebelum menghitung `last`/pivot/MA/RSI, atau hentikan klaim T-1.

### [LOW] Validasi `direct_answer terlalu panjang` tidak pernah bisa terpicu (dead validation) — terbukti runtime
- **Lokasi:** [`lib/ai-answer-contract.js:187`](lib/ai-answer-contract.js:187) vs [`lib/ai-answer-contract.js:51`](lib/ai-answer-contract.js:51)
- **Kutipan kode bermasalah:**
  ```js
  direct_answer: clean(row.direct_answer || row.answer, 600),   // baris 51: sudah di-slice(0, 600)
  ...
  if (answer.direct_answer.length > 600) errors.push('direct_answer terlalu panjang');  // baris 187: tidak pernah true
  ```
- **Penjelasan:** `normalizeAnswer` men-`slice(0, 600)` sehingga `answer.direct_answer.length` maksimum 600; syarat `> 600` mustahil. Input yang terlalu panjang dipotong DIAM-DIAM lalu lolos validasi — kontrak kehilangan sinyal bahwa jawaban asli melampaui batas (sementara `renderPlainText` ikut memakai versi terpotong). Validasi dead code biasanya menandakan pemotongan yang seharusnya ditolak/lapor.
- **Bukti verifikasi riil:** Runtime `node -e` di sesi ini: `validateAnswer({direct_answer: 'x'.repeat(700), action:'a', invalidation:'i'})` → `normalized length: 600`, `errors: []`.
- **Usulan arah perbaikan:** Cek panjang SEBELUM normalisasi (pada `row.direct_answer` mentah), atau tambahkan warning saat pemotongan terjadi.

### [LOW] Variabel `explicitRatio` dihitung tetapi tidak pernah dipakai (dead variable)
- **Lokasi:** [`lib/ai-answer-contract.js:101`](lib/ai-answer-contract.js:101) vs [`:115`](lib/ai-answer-contract.js:115)
- **Kutipan kode bermasalah:**
  ```js
  const explicitRatio = /[x×%]\s*$/i.test(text);
  text = text.replace(/\s*[x×%]\s*$/i, '').trim();
  ...
  if (scale && (explicitCurrency || MONETARY_SCALE_CONTEXT.test(context || ''))) return base * scale;
  ```
- **Penjelasan:** Hasil deteksi rasio eksplisit (`x`/`%`) tidak dipakai di keputusan apa pun; `financialNumbersInText` mendeteksi ulang rasio lewat regex terpisah di [`:162`](lib/ai-answer-contract.js:162). Sisa refactor yang membingungkan pembaca kontrak.
- **Bukti verifikasi riil:** Bukti kode: pencarian `explicitRatio` di file hanya menemukan deklarasi (1 kemunculan).
- **Usulan arah perbaikan:** Hapus variabel atau pakai sebagai bagian keputusan `parseMatchedNumber`.

### [LOW] `handleChartVision` mengembalikan string pesan-error sebagai HTML → pemanggil menandai `provider: 'gemini-vision'` sebagai sukses
- **Lokasi:** [`lib/analyze-legacy.js:637`](lib/analyze-legacy.js:637), [`:646`](lib/analyze-legacy.js:646), [`:648`](lib/analyze-legacy.js:648) vs pemakaian [`:50-53`](lib/analyze-legacy.js:50)
- **Kutipan kode bermasalah:**
  ```js
  if (!response.ok) return '<p class="text-sm text-red-400">Analisis chart gagal. Coba upload ulang.</p>';
  ...
  chartHtml = await handleChartVision(GEMINI_API_KEY, images, image, body.mimeType, chatMessage);
  if (chartHtml) chartProvider = 'gemini-vision';
  ```
- **Penjelasan:** Handler DeepSeek mengembalikan `null` saat gagal (sehingga fallback berjalan), tetapi `handleChartVision` mengembalikan STRING pesan error. Pemanggil hanya memeriksa truthiness, jadi kegagalan Gemini Vision dilaporkan sebagai `provider: 'gemini-vision'` — seolah analisis berhasil. Telemetry/audit provider jadi salah, dan `evidenceType` dilaporkan seolah diproses penuh.
- **Bukti verifikasi riil:** Bukti kode langsung: tiga cabang error mengembalikan string HTML, bukan `null`.
- **Usulan arah perbaikan:** Kembalikan `null` untuk kegagalan (biarkan pemanggil merakit pesan gagal), atau tambahkan flag `{ok:false}`.

### [LOW] `geminiSearchNews` adalah dead code (didefinisikan, tidak pernah dipanggil)
- **Lokasi:** [`lib/analyze-legacy.js:542-544`](lib/analyze-legacy.js:542)
- **Kutipan kode bermasalah:**
  ```js
  async function geminiSearchNews(apiKey, ticker) {
    return null;
  }
  ```
- **Penjelasan:** Fungsi hanya mengembalikan `null` dan tidak ada satu pun pemanggil di seluruh repo (dikonfirmasi pencarian). Sisa fitur "news research" yang dimatikan; aman, tapi menambah kebingungan saat audit "apakah berita dikarang?".
- **Bukti verifikasi riil:** Pencarian repo: `geminiSearchNews` hanya muncul 1× (definisi).
- **Usulan arah perbaikan:** Hapus fungsi; jika grounding Google Search nanti diaktifkan, tambahkan dengan pemanggil yang jelas.

### [LOW] Echo `chatMessage` tanpa escape ke HTML pada intent `ticker_only` — refleksi HTML mentah (self-XSS) via trik blok `[Info:]`
- **Lokasi:** [`lib/analyze-legacy.js:285-290`](lib/analyze-legacy.js:285)
- **Kutipan kode bermasalah:**
  ```js
  if (intent === 'ticker_only') {
    return res.status(200).json({
      html: '<p class="text-sm text-gray-300"><strong class="text-emerald-400">' + chatMessage.trim().toUpperCase() + '</strong> terdeteksi. ...',
  ```
- **Penjelasan:** `routeIntent` menentukan `ticker_only` setelah MEMBUANG blok `[Info: ...]`/`[Auto-Cuan ...]` ([`:786-795`](lib/analyze-legacy.js:786)), tetapi respons ini merender `chatMessage` ASLI (belum dibersihkan) dengan `.toUpperCase()` — tanpa escaping. Pesan seperti `BBCA` + `\n[Info: <img src=x onerror=alert(1)>]` lolos sebagai `ticker_only`, lalu tag HTML user ikut dirender. Jalur ini tidak melewati `sanitizeOutput`. Karena payload berasal dari input user sendiri dampaknya self-XSS (LOW), tetapi kontrak "HTML selalu disanitasi" di file ini menjadi tidak konsisten.
- **Bukti verifikasi riil:** Bukti kode: `routeIntent` men-strip blok, jalur `ticker_only` mencetak string mentah; `sanitizeOutput` tidak dipanggil di jalur ini.
- **Usulan arah perbaikan:** Escape `chatMessage` (helper escape HTML) sebelum interpolasi, atau tampilkan ticker hasil `msg` yang sudah dibersihkan.

---

## MODUL: Telegram Templates & Trade Plan V2 (lib/telegram-templates.js, lib/trade-plan-v2.js, lib/telegram-notifier.js, lib/intraday-fast-watcher*.js)

Batch ini membaca TUNTAS: `lib/telegram-templates.js` (940), `lib/trade-plan-v2.js` (1.320), `lib/telegram-notifier.js` (648), `lib/intraday-fast-watcher.js` (510), `lib/intraday-fast-watcher-live.js` (320). **BERSIH**: `trade-plan-v2.js` (engine kanonik deterministik, tick-aware, TP2 gated breakout — kokoh), `telegram-notifier.js` (throttle, market guard, timeout terbatas, error body dipotong 200 char — tidak ada token leak), `intraday-fast-watcher.js` + `-live.js` (lock atomic, dedup key, shadow-only). Satu temuan di formatter Telegram:

### [MEDIUM] Kartu sinyal Telegram mencetak target TP yang DIKARANG saat `tp1`/`tp2` absen, dan label persentase target di-hardcode (tidak cocok dengan TP riil)
- **Lokasi:** [`lib/telegram-templates.js:615-616`](lib/telegram-templates.js:615) (daytrade legacy), [`lib/telegram-templates.js:620-621`](lib/telegram-templates.js:620) (swing legacy), label di [`lib/telegram-templates.js:597-604`](lib/telegram-templates.js:597) (jalur V2 public) dan [`:617`](lib/telegram-templates.js:617)/[`:622`](lib/telegram-templates.js:622)
- **Kutipan kode bermasalah:**
  ```js
  var tp1Text = tp1 ? fmtPrice(tp1) : fmtPrice(Math.round(e1 * 1.045));   // <-- target DIKARANG +4.5%
  var tp2Text = tp2 ? fmtPrice(tp2) : fmtPrice(Math.round(e1 * 1.075));   // <-- target DIKARANG +7.5%
  ...
  var tp1SwingText = tp1 ? fmtPrice(tp1) : fmtPrice(Math.round(refEntry * 1.055)); // <-- DIKARANG +5.5%
  ...
  lines.push('Target Profit 1 (+4.5%): ' + tp1Text + ' / Target Profit 2 (+7.5%): ' + tp2Text);
  ```
- **Penjelasan:** Dua masalah dalam satu jalur: (1) bila `tp1`/`tp2` tidak ada di row, formatter MENGARANG target dari persentase tetap (entry×1.045 / ×1.075 / ×1.055) lalu mengirimkannya ke pelanggan Telegram sebagai "Target Profit" — tanpa dasar struktural apa pun. Ini kelas "angka karangan tembus ke produksi" di kanal distribusi sinyal. (2) Label persentase `(+4.5%)`, `(+7.5%)`, `(+5% s/d +6% Partial TP 50%)` adalah string literal yang dicetak untuk nilai TP apa pun; padahal engine V2 menghitung TP1 dari R-target (1.15R daytrade / 1.35R swing, lihat [`lib/trade-plan-v2.js:66`](lib/trade-plan-v2.js:66)) yang di-cap resistance — persentase riil bervariasi per saham. Pelanggan membaca persentase yang tidak pernah dihitung dari data.
- **Bukti verifikasi riil:** Runtime di sesi ini — `formatSignalCard({entry_low:100, entry_high:102, stop_loss:95, tp1:103, tp2:110, ...}, 1, 'daytrade')` mencetak `Target Profit 1 (+4.5%): Rp103 / Target Profit 2 (+7.5%): Rp110`. TP1 103 dari entry_high 102 = **+0,98%** (bukan +4,5%); dari entry_low 100 = +3%. Label dan angka saling bertentangan di output nyata.
- **Usulan arah perbaikan:** Hapus fallback karangan — bila `tp1`/`tp2` absen, tampilkan `—` atau omit barisnya. Ganti label persentase dengan hitungan `((tp1/entryRef)-1)*100` yang diformat, atau hapus klaim persen sama sekali.

---

## MODUL: Fast Watcher Publisher → Tabel Produksi (lib/intraday-fast-watcher-publisher.js)

Batch ini membaca TUNTAS `lib/intraday-fast-watcher-pool.js` (448) dan `lib/intraday-fast-watcher-publisher.js` (501). Pool **BERSIH** (lock setup/plan deterministik, 2-dari-3 confirmation window, opening-velocity guard, adaptive watch, production-eligibility block terpasang). Temuan di publisher:

### [MEDIUM] `buildDbRow` MEMALSUKAN `daytrade_score` — skor hilang dikarang jadi 70, skor riil di bawah 50 dipaksa naik jadi 50 — lalu ditulis ke tabel produksi publik `daytrade_screener_latest`
- **Lokasi:** [`lib/intraday-fast-watcher-publisher.js:49`](lib/intraday-fast-watcher-publisher.js:49) (`finalScore`), dipakai di [`:56`](lib/intraday-fast-watcher-publisher.js:56) (`daytrade_score`), ditulis via [`upsertSystemRows`](lib/intraday-fast-watcher-publisher.js:270) di [`:395`](lib/intraday-fast-watcher-publisher.js:395)
- **Kutipan kode bermasalah:**
  ```js
  const finalScore = Math.max(50, Math.min(100, Math.round(publishScore ?? watchScore ?? engineScore ?? 70)));
  ...
  daytrade_score: finalScore,
  ```
- **Penjelasan:** Dua distorsi sekaligus pada field yang dibaca publik: (1) bila ketiga skor (`publishScore`, `watchScore`, `engineScore`) absen, skor DIKARANG menjadi **70**; (2) operator `Math.max(50, ...)` menaikkan paksa skor riil yang < 50 menjadi **50** — jadi skor sah seperti 42 (ambang extension pool adalah 42) tersimpan sebagai 50. Tabel `daytrade_screener_latest` adalah tabel PRODUKSI yang dikonsumsi langsung oleh halaman publik: `api/sector-hot.js:2748` mengambil top-50 `.order('daytrade_score', { ascending: false })` untuk kategori Day Trade, `:11742`/`:12423` memakai status `READY_BREAKOUT` sebagai gate sinyal, dan `:6869-6872` memakai baris tabel ini sebagai SUMBER HARGA OHLC. Akibatnya skor yang ditampilkan ke user untuk pick dari jalur fast-watcher bisa lebih tinggi daripada skor sebenarnya (atau sepenuhnya karangan), dan urutan ranking top-50 ikut salah. Ini persis kelas yang dihindari seluruh repo ("jangan mengarang angka"); jalur ini di belakang kill switch `FAST_WATCHER_PUBLISH_ENABLED`, tetapi ketika dinyalakan distorsinya langsung masuk ke produksi publik. Catatan tambahan: `status: 'READY_BREAKOUT'` juga hardcoded ([`:54`](lib/intraday-fast-watcher-publisher.js:54)) — pemetaan dari `READY_CONFIRMED` watcher ke skema tabel (perlu dicatat sebagai kontrak yang disengaja atau diperbaiki).
- **Bukti verifikasi riil:** Runtime di sesi ini: `buildDbRow({ticker:'TEST', watch_score:null, publish_score:null, observation:{}})` → `status: 'READY_BREAKOUT'`, `daytrade_score: 70` (dikarang), `quality_grade: 'B'`. `buildDbRow({watch_score:31, publish_score:42})` → `daytrade_score: 50` (skor riil 42 dinaikkan). `buildDbRow({observation:{score:88}})` → `88` (benar). Konsumen tabel terverifikasi di `api/sector-hot.js:2748, 6869, 11742, 12423`.
- **Usulan arah perbaikan:** Jangan substitusi skor — biarkan `null` bila tidak ada dan JANGAN clamp ke 50; bila skema tabel mewajibkan angka, turunkan ke `engineScore` tanpa floor dan tandai `score_source`. Tambahkan guard agar baris tanpa skor riil tidak ikut ranking publik.

---

## MODUL: Bandarmologi Service (lib/bandarmologi-service.js, 2.226 baris — TUNTAS)

### [MEDIUM] `accumulation_score` DIKARANG dari tanda net flow (70/30/75) lalu ditampilkan ke user sebagai "Acc Score: X/100"
- **Lokasi:** [`lib/bandarmologi-service.js:986`](lib/bandarmologi-service.js:986) (`synthesizeAccumulationFromSummary`), [`lib/bandarmologi-service.js:1131`](lib/bandarmologi-service.js:1131) (`normalizeBrokerAccumulation`); konsumen UI: [`public/bandarmologi-runtime.js:2842-2843`](public/bandarmologi-runtime.js:2842)
- **Kutipan kode bermasalah:**
  ```js
  // synthesizeAccumulationFromSummary
  return {
    ticker: ticker,
    accumulation_score: netFlow >= 0 ? 70 : 30,
    status: netFlow >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
  ...
  // normalizeBrokerAccumulation
  accumulation_score: raw.accumulation_score != null ? raw.accumulation_score : 75,
  ```
- **Penjelasan:** Tidak ada skor akumulasi yang benar-benar dihitung dari data broker — nilainya hanya fungsi tanda net flow (positif → 70, negatif → 30), dan jalur kedua memakai konstanta 75 ketika upstream tidak mengirim skor. Angka ini kemudian dirender di UI sebagai "Acc Score: 70/100" (badge di kartu Akumulasi Broker), yaitu angka presisi palsu yang terlihat seperti hasil analisis kuantitatif padahal hanya penanda arah. Karena `netFlow` sendiri bisa berasal dari jalur fallback/hunter (bukan VWAP murni), skor ini dapat muncul untuk data yang bahkan tidak lengkap.
- **Bukti verifikasi riil:** Bukti kode: dua lokasi substitusi (`70/30` dan `75`), plus grep menunjukkan konsumen tunggal di UI `public/bandarmologi-runtime.js:2842-2843` yang mencetak `/100`. Jalur `synthesizeAccumulationFromSummary` aktif setiap kali diskAcc kosong (`bandarmologi-service.js:1950-1963`) — jalur umum, bukan edge case.
- **Usulan arah perbaikan:** Hitung skor dari komponen nyata (mis. rasio net buy vs total, konsistensi multi-hari) atau tampilkan status kategorikal saja tanpa angka `/100`; bila skor tidak tersedia, render `—` bukan konstanta.

### [LOW] Literal tanggal `2026-09-11` sebagai default/fallback tanggal data di 4 jalur (termasuk payload tanggal NO_DATA)
- **Lokasi:** [`lib/bandarmologi-service.js:213`](lib/bandarmologi-service.js:213), [`:220`](lib/bandarmologi-service.js:220), [`:232`](lib/bandarmologi-service.js:232), [`:808`](lib/bandarmologi-service.js:808), dan [`:1984`](lib/bandarmologi-service.js:1984) (`resolvedDate` fallback `'2026-09-11'`)
- **Kutipan kode bermasalah:**
  ```js
  return prevTrading || '2026-09-11';                       // :213
  return prev || '2026-09-11';                              // :220
  return [fallbackEff, '2026-09-11', '2026-09-10', ...];    // :232
  const targetDate = date === 'latest' || !date ? (raw.date || raw.broker_start_date || '2026-09-11') : date;  // :808
  ```
- **Penjelasan:** Tanggal "hari terakhir" di-hardcode sebagai fallback ketika kalender gagal/tidak ada. Setiap kali kalender kosong atau upstream tidak menyertakan `date`, sistem akan mengklaim data bertanggal 2026-09-11 — tanggal yang makin lama makin basi — dan payload NO_DATA pun bisa berlabel tanggal itu. Ini memperkuat kelas temuan literal tanggal yang sudah tercatat di modul lain (bandarmologi/broker), dengan 4+ lokasi tambahan di file ini yang belum pernah didaftarkan. Karena modul ini sudah punya `idx-trading-calendar` yang bisa diandalkan, literal ini seharusnya tidak pernah menjadi jawaban terakhir.
- **Bukti verifikasi riil:** Bukti kode: 5 kemunculan literal terverifikasi via pencarian langsung di file; `getEffectiveTradingDate` memang memanggil `previousTradingDay` tetapi tetap jatuh ke literal ketika null.
- **Usulan arah perbaikan:** Hapus literal — bila kalender tidak tersedia kembalikan `null`/`NO_DATA` eksplisit, atau pakai tanggal file terbaru yang benar-benar ada di disk (`listDiskDates()[0]`) sebagai basis.

---

## MODUL: Tick Normalization (lib/idx-tick-normalization.js, 1.182 baris — TUNTAS)

File ini **BERSIH** pada bagian yang sudah dibaca sesi lalu (1-900). Batch ini membaca tuntas 900-1182 (deriveIdxAutoRejectLevels, deriveCandlePotentialRange, calculateQualityGrade). Guard ARA/ARB konservatif (hit → buy tidak realistis; near → pantau), TP realism berbasis candle potential, quality grade deterministik dengan gate `tick_normalized`. Satu temuan LOW:

### [LOW] Band ARB di-hardcode flat -15% (multiplier 0.85) untuk SEMUA tier harga, sementara ARA bertingkat (35/25/20%); tidak ada test yang mengunci dan tidak ada rujukan aturan di kode
- **Lokasi:** [`lib/idx-tick-normalization.js:981-984`](lib/idx-tick-normalization.js:981) (`getIdxAutoRejectBand`)
- **Kutipan kode bermasalah:**
  ```js
  var ara = 0.35;
  if (ref > 5000) ara = 0.20;
  else if (ref > 200) ara = 0.25;
  return { ara_pct: round2(ara * 100), arb_pct: -15, ara_multiplier: 1 + ara, arb_multiplier: 0.85, ara_band_label: label };
  ```
- **Penjelasan:** ARA dihitung bertingkat mengikuti tier harga, tetapi ARB selalu -15% tanpa tier dan tanpa rujukan peraturan di kode/komentar (label yang keluar hanya `normal_board_assumption`). Band ini dipakai untuk `arb_price`, `sl_below_arb`, `execution_reality_status`, dan (via `deriveCandlePotentialRange`) lantai `candle_potential_low` pada kartu analisis — jadi bila aturan ARB IDX berubah (atau berbeda per papan), seluruh klaim "rawan ARB" dan potensi candle ikut salah tanpa ada test yang menangkapnya: pencarian `arb_pct`/`getIdxAutoRejectBand` di `test/` tidak menemukan satu pun test yang mengunci nilai ini.
- **Bukti verifikasi riil:** Runtime di sesi ini — `getIdxAutoRejectBand(100)` → `ara 35% / arb -15%`; `getIdxAutoRejectBand(1000)` → `25% / -15%`; `getIdxAutoRejectBand(6000)` → `20% / -15%`. Pencarian test: nol referensi.
- **Usulan arah perbaikan:** Dokumentasikan sumber peraturan (tanggal + nomor aturan) dan tambahkan test yang mengunci tier ARA/ARB; bila ARB juga bertingkat per aturan terbaru, samakan pola tiering dengan ARA. Verifikasi eksternal ke aturan IDX berlaku sebelum mengubah nilai.

---

## MODUL: Bandarmologi Intel Service (lib/bandarmologi-intel-service.js, 1.754 baris — TUNTAS)

File dibaca baris-per-baris (chunk 1-300, 301-600, 601-900, 901-1200, 1201-1500, 1501-1754). **BERSIH pada bagian**: `getCachedClosePriceDetail` (bridge live dulu, provenance ikut payload), stale-candle guard PR4, guard "Pillar 9" (5D bearish/RSI>70 membatalkan badge akumulasi), rekonsiliasi net flow vs confluence badge, provenance `data_source` bridge vs baked. Tiga temuan:

### [MEDIUM] Denominator CR DIKARANG `top5Val × 1.75` saat total turnover tidak tersedia — CR5 selalu keluar 57,14% dan CR3 ikut ter-skala, lalu ditampilkan ke user sebagai metrik konsentrasi
- **Lokasi:** [`lib/bandarmologi-intel-service.js:1184-1192`](lib/bandarmologi-intel-service.js:1184); konsumen UI: [`public/bandarmologi-runtime.js:4742`](public/bandarmologi-runtime.js:4742), [`:4769`](public/bandarmologi-runtime.js:4769), [`:4847`](public/bandarmologi-runtime.js:4847), [`:4868`](public/bandarmologi-runtime.js:4868)
- **Kutipan kode bermasalah:**
  ```js
  // Denominator guard: Total market turnover must NEVER be equal to or less than top 5 buy val!
  if (totalTurnover <= top5Val) {
    if (ohlcvTurnover > 0 && ohlcvTurnover > top5Val) {
      totalTurnover = ohlcvTurnover;
    } else {
      totalTurnover = top5Val > 0 ? Math.round(top5Val * 1.75) : 0;   // <-- DENOMINATOR DIKARANG
    }
  }
  ...
  cr5 = Number(((top5Val / totalTurnover) * 100).toFixed(2));           // = 100/1.75 = 57.14 selalu
  ```
- **Penjelasan:** Ketika turnover pasar asli tidak tersedia (feed tidak menyertakan `total_turnover` dan cache OHLCV kosong), denominator diganti `top5Val × 1.75` — angka yang tidak berasal dari data mana pun. Konsekuensinya deterministik: `cr5 = 100/1.75 = 57.14` **selalu** di cabang itu, dan `cr3 = top3Val/(top5Val×1.75)×100` ikut ter-skala oleh konstanta karangan. Nilai ini bukan sekadar diagnostik internal: UI merendernya sebagai "CR3 X% / CR5 57.14%" dengan bar visual dan label status ("Akumulasi Terkonsentrasi" bila cr3 ≥ 40), dan scanner item memakai `item.cr3` sebagai metrik ("CR3 60+%"). User melihat angka konsentrasi presisi yang sebenarnya adalah artefak asumsi 1.75×. Ironisnya komentar di atas kode menyebut aturan anti-100%, tetapi solusinya justru mengganti satu distorsi dengan distorsi baru.
- **Bukti verifikasi riil:** Bukti kode + derivasi aritmetika: di cabang tersebut `cr5 = (top5Val / (top5Val×1.75))×100 = 57.142857… → "57.14"` (selalu). Konsumen UI terverifikasi via grep (`bandarmologi-runtime.js:4742,4769,4847,4868,4785`). Cabang ini reachable kapan pun `norm.total_turnover` absen — kondisi umum pada feed hunter fallback (yang bahkan tidak membawa `total_turnover`).
- **Usulan arah perbaikan:** Jangan mengarang denominator: bila turnover pasar tidak tersedia, kembalikan `cr3/cr5 = null` + `reason: 'TURNOVER_UNAVAILABLE'` dan biarkan UI menampilkan "—", atau hitung konsentrasi terhadap total nilai beli seluruh broker yang benar-benar ada (`allBrokers` sum) dan tandai basisnya eksplisit.

### [MEDIUM] Fallback hunter MEMFABRIKASI bukti "Silent Foreign Accumulation": `price_change_pct: 0.8` & `is_sideways: true` hardcoded, daily breakdown membagi total net secara rata
- **Lokasi:** [`lib/bandarmologi-intel-service.js:791-809`](lib/bandarmologi-intel-service.js:791) (khusus [`:798`](lib/bandarmologi-intel-service.js:798), [`:799`](lib/bandarmologi-intel-service.js:799), [`:805`](lib/bandarmologi-intel-service.js:805))
- **Kutipan kode bermasalah:**
  ```js
  if (foreignBuyers.length >= 2 && totalForeignNet > 0) {
    const days = Math.min((hunterData.target_dates && hunterData.target_dates.length) || numDays || 3, 5);
    return {
      ...
      triggered: true,
      consecutive_days: days,
      price_change_pct: 0.8,          // <-- DIKARANG, bukan diukur
      is_sideways: true,              // <-- DIKARANG, bukan hasil evaluasi
      ...
      daily_breakdown: (hunterData.target_dates || []).map(d => ({
        date: d,
        foreign_net: Math.round(totalForeignNet / days),   // <-- dibagi rata: tiap hari angka identik
        price: foreignBuyers[0].avg_price || 0
      })),
  ```
- **Penjelasan:** Cabang hunter-fallback men-trigger sinyal "Net Foreign Buy positif N hari berturut-turut ... sideways" padahal data hunter adalah AGREGAT rentang (bukan deret harian): tidak ada satu pun pengukuran harian yang membuktikan "berturut-turut", dan syarat sideways (`priceFluctuationPct <= 3.0` pada jalur utama) dilewati dengan konstanta `0.8`. `daily_breakdown` lalu memfabrikasi deret harian dengan membagi total net sama rata — setiap hari menampilkan angka identik, seolah observasi per-hari. Sinyal ini masuk ke `indexes.silent_foreign_accumulation` (`:1504-1513`) dan tampil di UI sebagai kategori scanner "🤫 Akumulasi Asing" (`bandarmologi-runtime.js:4782,4860`) — user melihat sinyal akumulasi asing yang "terbukti" dari data yang tidak pernah mendukung klaimnya. Berbeda dari jalur utama (yang benar-benar menghitung streak dari broker-summary harian), jalur ini adalah fabrikasi penuh.
- **Bukti verifikasi riil:** Bukti kode: konstanta literal pada tiga field, plus struktur `daily_breakdown` yang membagi rata. Jalur reachable saat `availableDates.length < 3` DAN ada hunter data (kondisi lazim untuk ticker yang baru masuk universe). Konsumen UI terverifikasi via grep.
- **Usulan arah perbaikan:** Cabang hunter tidak boleh mengklaim streak/sideways: kembalikan `triggered: false, reason: 'DAILY_SERIES_UNAVAILABLE'` atau turunkan menjadi sinyal agregat terpisah (mis. `FOREIGN_RANGE_AGGREGATE`) tanpa klaim per-hari; hapus `price_change_pct`/`is_sideways` karangan dan `daily_breakdown` rata-bagi.

### [LOW] Literal tanggal `2026-09-08` sebagai default tanggal fetch VPS + `2026-09-11` sebagai default `effective_date` (3 lokasi) di jalur intel
- **Lokasi:** [`lib/bandarmologi-intel-service.js:1303`](lib/bandarmologi-intel-service.js:1303) (`options.date || '2026-09-08'`), [`:1269`](lib/bandarmologi-intel-service.js:1269)/[`:1272`](lib/bandarmologi-intel-service.js:1272) (`effective_date: options.date || '2026-09-11'`), [`:1439`](lib/bandarmologi-intel-service.js:1439)/[`:1559`](lib/bandarmologi-intel-service.js:1559) (fallback `'2026-09-11'`)
- **Kutipan kode bermasalah:**
  ```js
  vpsFetcher.fetchBrokerSummaryFromVpsSync(clean, options.date || '2026-09-08');
  ...
  effective_date: options.date || '2026-09-11',
  ```
- **Penjelasan:** Sama kelasnya dengan temuan literal tanggal di `lib/bandarmologi-service.js` (batch 20), tetapi di file ini termasuk `'2026-09-08'` (tanggal yang bahkan lebih lama) sebagai tanggal fetch default — sehingga pada kondisi tanpa tanggal eksplisit, sistem menarik dan melabeli data sebagai tanggal tetap yang makin basi. Payload intel yang dipakai UI menyertakan `effective_date` ini sebagai "as_of_date".
- **Bukti verifikasi riil:** Bukti kode: 5 kemunculan literal terverifikasi via pencarian langsung; `getEffectiveTradingDate` tetap dipanggil tetapi fallback terakhirnya literal.
- **Usulan arah perbaikan:** Ganti dengan `getEffectiveTradingDate()`/tanggal disk terbaru; bila tak tersedia kembalikan `null` dan tandai payload sebagai `DATE_UNRESOLVED` alih-alih mengklaim tanggal tetap.

---

## MODUL: Frontend Day Trade Runtime (public/daytrade-runtime.js, public/fast-watcher-live-refresh.js)

`public/fast-watcher-live-refresh.js` (153) **BERSIH** (polling visibility-aware, abort timeout 8s, signature dedup, tidak refresh saat full screener berjalan). `public/daytrade-runtime.js` (398) **BERSIH** kecuali satu temuan LOW:

### [LOW] Statistik "Universe"/"Scanned" memakai fallback hardcoded 760/720 saat meta kosong — angka karangan yang tampil sebagai fakta
- **Lokasi:** [`public/daytrade-runtime.js:75-76`](public/daytrade-runtime.js:75) (frontend) dan sumbernya [`api/sector-hot.js:11927-11928`](api/sector-hot.js:11927) (Day Trade) + [`api/sector-hot.js:10626-10627`](api/sector-hot.js:10626) (Swing Non-Konglo, `720`)
- **Kutipan kode bermasalah:**
  ```js
  // public/daytrade-runtime.js
  var realDtUniverse = meta.universe_count || 760;
  var realDtScanned = meta.scanned_count || (data.results ? data.results.length : 760);
  ```
  ```js
  // api/sector-hot.js:11927-11928 (sumber yang sama)
  var dtUCount = (displayMeta && displayMeta.universe_count) ? displayMeta.universe_count : 760;
  var dtSCount = (displayMeta && displayMeta.scanned_count) ? displayMeta.scanned_count : ((sortedRows && sortedRows.length > 0) ? sortedRows.length : 760);
  ```
- **Penjelasan:** Ketika meta belum terisi (scan belum pernah jalan / meta kosong), UI menampilkan "Universe: 760" dan "Scanned: 760" — angka yang tidak berasal dari data mana pun, hanya konstanta yang diasumsikan sebagai ukuran universe IDX. Karena API sendiri sudah memakai fallback yang sama, frontend hanya mencerminkan perilaku itu, tetapi hasil akhirnya tetap: user melihat statistik cakupan scan yang terlihat presisi padahal karangan. Bila universe riil berbeda (mis. 800+ ticker terdaftar), angka ini menyesatkan tentang seberapa luas scan sebenarnya.
- **Bukti verifikasi riil:** Bukti kode: literal `760` di frontend dan API (dua jalur), `720` untuk NK; grep `760`/`720` di `FULL_REPO_BUG_FINDINGS.md` sebelumnya nol (belum pernah dicatat).
- **Usulan arah perbaikan:** Tampilkan `—`/`n/a` saat meta kosong alih-alih konstanta; bila perlu estimasi, ambil dari sumber universe resmi (`stock_boards` count) dan tandai sebagai estimasi.

### [MEDIUM] `mountRankingCardOnOwnPage()` mereferensikan identifier tak terdeklarasi `nodeToMove` → ReferenceError yang mematikan seluruh enhance Ranking Harian (termasuk banner sesi mixed-date)
- **Lokasi:** [`public/stock-analysis-ai.js:400`](public/stock-analysis-ai.js:400)
- **Kutipan kode bermasalah:**
  ```js
  var card = tableWrap.closest('.unified-card') || tableWrap.parentElement;
  if (card) {
    card.dataset.rankingPolished = 'true';
  }
  if (search) {
    search.placeholder = 'Cari ticker di ranking…';
  }
  nodeToMove.style.borderBottom = '0';   // <-- nodeToMove TIDAK PERNAH dideklarasikan
  ```
- **Penjelasan:** `nodeToMove` tidak dideklarasikan di file ini (var/let/const) maupun diekspor/diimpor dari tempat lain — pencarian seluruh repo hanya menemukan SATU kemunculan, yaitu baris ini. Saat elemen `rankingTableWrap` ada di DOM, `mountRankingCardOnOwnPage()` melewati early-return (`if (!tableWrap) return false`) lalu mencapai baris 400 dan melempar `ReferenceError: nodeToMove is not defined`. Karena `enhanceDailyRanking()` memanggil fungsi ini dan `init()` memanggilnya berulang di `setInterval` (sampai 30×), semuanya berhenti tepat sebelum: styling kartu, penyisipan badge `marketContextSessionBadge`, `wrapRenderRankingTableForSessionLabel()`, dan `updateRankingSessionLabel()`. Akibat nyata: fitur "catatan sesi / peringatan data tertinggal" Ranking Harian — yang justru ditulis khusus untuk bug audit 12 Agu 2026 (label T-1 statis) — tidak pernah tampil, dan konsol diisi error tiap detik selama 30 detik.
- **Bukti verifikasi riil:** Pencarian repo: `nodeToMove` muncul 1× (hanya baris 400); tidak ada deklarasi global. Alur panggil terverifikasi: `init()` → `enhanceDailyRanking()` → `mountRankingCardOnOwnPage()` ([`:648-675`](public/stock-analysis-ai.js:648)). Ini regresi refactor: kemungkinan sisa dari pemindahan node (`nodeToMove`) yang dulu ada.
- **Usulan arah perbaikan:** Hapus baris 400 (fungsi sudah tidak memindahkan node), atau deklarasikan `nodeToMove` yang dimaksud (mis. `tableWrap`/`card`) bila memang perlu menghapus border. Tambahkan guard agar exception tidak mematikan sisa enhance.

### [LOW] `mountRankingCardOnOwnPage()` menulis `card.style.*` tanpa null-guard meski `card` dijaga `if (card)` beberapa baris sebelumnya
- **Lokasi:** [`public/stock-analysis-ai.js:393-405`](public/stock-analysis-ai.js:393)
- **Kutipan kode bermasalah:**
  ```js
  var card = tableWrap.closest('.unified-card') || tableWrap.parentElement;
  if (card) { card.dataset.rankingPolished = 'true'; }
  ...
  card.style.background = 'linear-gradient(...)';   // <-- tanpa guard, padahal di atas di-guard
  ```
- **Penjelasan:** Pola guard tidak konsisten: `card` diperiksa `if (card)` untuk `dataset`, tetapi empat baris setelahnya diakses langsung (`card.style.*`) tanpa guard. Bila `tableWrap` terlepas dari DOM (`parentElement === null`), ini melempar TypeError. Dampak praktis kecil (elemen ranking biasanya terpasang), tetapi enkapsulasi guard yang setengah jalan menyembunyikan asumsi yang rapuh.
- **Bukti verifikasi riil:** Bukti kode langsung; guard hanya pada satu penggunaan dari lima.
- **Usulan arah perbaikan:** Bungkus blok styling dalam `if (card) { … }`, atau early-return saat `card` null.

---

## MODUL: Frontend Market Feature Runtime (public/market-feature-runtime.js, 1.510 baris — TUNTAS)

Batch ini membaca tuntas 601-1510 (sesi lama sudah 1-600). **BERSIH pada sebagian besar isi**: grounding blok `[Auto-Cuan Market Data]` sengaja OMIT field absen (`!= null`, tidak `|| 0`), pivot absen tidak lagi ditulis "undefined", Volume Intelligence tidak memakai `|| 0`, export chart PNG high-DPI aware. Satu temuan:

### [MEDIUM] Blok prompt `[Auto-Cuan Score]` memakai DUA skala berbeda untuk field berlabel sama — server `/25` vs fallback frontend `/30`
- **Lokasi:** [`public/market-feature-runtime.js:718-722`](public/market-feature-runtime.js:718) (jalur server) vs [`public/market-feature-runtime.js:734-738`](public/market-feature-runtime.js:734) (jalur fallback); sumber server [`api/quote.js:1736`](api/quote.js:1736), [`:1830`](api/quote.js:1830), [`:1884`](api/quote.js:1884)
- **Kutipan kode bermasalah:**
  ```js
  // jalur server (q.autoCuanScore)
  lines.push('Trend: ' + acs.components.trend + '/25');
  lines.push('Momentum: ' + acs.components.momentum + '/20');
  lines.push('Volume: ' + acs.components.volume + '/20');
  lines.push('Pivot: ' + acs.components.pivot + '/15');
  lines.push('Catalyst: ' + acs.components.catalyst + '/10');
  ...
  // jalur fallback (calculateAutoCuanScore lokal)
  lines.push('Trend Score: ' + acScore.trendScore + '/30');
  ...
  lines.push('Board Risk Score: ' + acScore.boardRiskScore + '/15');
  ```
- **Penjelasan:** Kedua jalur menulis blok dengan header SAMA (`[Auto-Cuan Score]`) tetapi skala komponen BERBEDA. Server (`api/quote.js`) memakai trend 25 / momentum 20 / volume 20 / pivot 15 / catalyst 10 / risk 10 (jumlah 100; `pivotScore = Math.min(15, …)`). Fallback frontend memakai trend **30** / rsi 20 / volume 20 / news 15 / board-risk 15 (jumlah 100). Karena `q.autoCuanScore` adalah field server (dikonfirmasi `api/quote.js:2138,2283-2284`), jalur fallback praktis jarang aktif — tetapi bila aktif, model AI membaca komponen berlabel sama dengan penyebut berbeda pada prompt yang sama, dan skor total tidak bisa dibandingkan lintas jalur. Prompt adalah grounding yang eksplisit dilindungi di file ini; dua kontrak angka dalam satu blok melemahkan jaminan itu.
- **Bukti verifikasi riil:** Bukti kode: `/25` vs `/30`, dan definisi server `Math.min(15, pivotScore)` + `rawScore = trend + momentum + volume + pivotScore + catalyst + risk` di `api/quote.js:1830,1884`.
- **Usulan arah perbaikan:** Satukan rubrik: fallback frontend harus memakai skala server (atau jalur fallback dihapus); beri label blok berbeda bila memang skala berbeda.

---

## MODUL: Foreign Flow (lib/foreign-flow-store.js, lib/foreign-flow-recap.js)

`lib/foreign-flow-store.js` (74) **BERSIH** — chunked query di bawah budget 900 baris, tidak mengarang `foreign_buy`/`foreign_sell` (selalu null, hanya `foreign_net`). `lib/foreign-flow-recap.js` (295) **BERSIH** kecuali satu temuan LOW:

### [LOW] `sendForeignFlowRecap` memanggil `telegramNotifier.sendMessage` yang TIDAK ADA (ekspor hanya `sendTelegramMessage`) — TypeError laten di fungsi tanpa pemanggil
- **Lokasi:** [`lib/foreign-flow-recap.js:270`](lib/foreign-flow-recap.js:270)
- **Kutipan kode bermasalah:**
  ```js
  const result = await telegramNotifier.sendMessage(message, {
    parse_mode: 'HTML',
    chat_id: options.chatId || null
  });
  ```
- **Penjelasan:** `lib/telegram-notifier.js` mengekspor `sendTelegramMessage` (bukan `sendMessage`). Diverifikasi runtime: `require('./lib/telegram-notifier').sendMessage === undefined`. Jadi bila `sendForeignFlowRecap` dipanggil dengan `send:true`, baris ini melempar `TypeError: telegramNotifier.sendMessage is not a function` — recap foreign flow tidak akan pernah terkirim. Saat ini dampaknya terbatas karena fungsi ini **tidak punya pemanggil** di seluruh repo (grep: hanya definisi + ekspor), sehingga ini bug laten di dead code; begitu ada yang menyambungkannya (mis. cron recap), ia langsung gagal.
- **Bukti verifikasi riil:** Runtime `node -e`: `has sendMessage: undefined`, `has sendTelegramMessage: function`; grep repo: `telegramNotifier.sendMessage` hanya 1 kemunculan (baris ini); `sendForeignFlowRecap` hanya 2 kemunculan (definisi + ekspor, tanpa pemanggil).
- **Usulan arah perbaikan:** Ganti ke `telegramNotifier.sendTelegramMessage(message, { chat_id, ... })` (perhatikan: `sendTelegramMessage` tidak menerima `parse_mode`; pesan memakai tag HTML `<b>`/`<code>` sehingga perlu mode HTML yang didukung sender, atau konversi ke teks polos). Tambahkan test yang benar-benar memanggil jalur kirim.

---

## MODUL: Broker Hunter Service (lib/broker-hunter-service.js, 548 baris — TUNTAS)

File dibaca baris-per-baris (1-300, 301-548). **BERSIH pada bagian inti**: `BROKER_PROFILES` dummy sudah dihapus (komentar eksplisit "Never use dummy data"), fast-path index disk + VPS, fallback on-the-fly menghitung dari broker-summary nyata, respons kosong jujur (`top_accumulated: []`, bukan mock). Satu temuan LOW:

### [LOW] Literal tanggal `'2026-09-07'` sebagai fallback `targetDates`/`date_range_label` saat tidak ada tanggal tersedia
- **Lokasi:** [`lib/broker-hunter-service.js:368`](lib/broker-hunter-service.js:368), [`:417`](lib/broker-hunter-service.js:417)
- **Kutipan kode bermasalah:**
  ```js
  if (targetDates.length === 0) {
    targetDates = ['2026-09-07'];
  }
  ...
  : (targetDates[0] || '2026-09-07');
  ```
- **Penjelasan:** Sama kelasnya dengan literal tanggal di `bandarmologi-service.js`/`bandarmologi-intel-service.js` (batch 20/22): ketika `discoverAvailableDates()` kosong, sistem mengklaim data bertanggal tetap `2026-09-07` alih-alih melaporkan "tanggal tidak tersedia". Karena `discoverAvailableDates()` membaca disk, kondisi ini terjadi saat cache broker-summary belum ada — tepat saat label tanggal paling menyesatkan.
- **Bukti verifikasi riil:** Bukti kode: 2 kemunculan literal terverifikasi via pencarian langsung.
- **Usulan arah perbaikan:** Kembalikan `target_dates: []` + `date_range_label: 'Tanggal tidak tersedia'` saat tidak ada tanggal, jangan mengarang tanggal tetap.

---

## MODUL: Insider Network Service (lib/insider-network-service.js, 1.125 baris — TUNTAS)

File dibaca baris-per-baris (1-300, 301-600, 601-900, 901-1125). **BERSIH pada bagian inti**: agregasi holding per entitas, search index dengan skoring deterministik, network graph (nodes/edges/links) untuk D3, aksi non-buy/sell (TRANSFER/HIBAH/WARIS/BONUS/RIGHTS) sengaja diabaikan dari `net_shares_change` (mencegah akumulasi palsu). Temuan HIGH fabrikasi `SAMPLE_INSIDER_UNIVERSE` (fallback `getEffectiveUniverse` baris 522) sudah tercatat di sesi lama. Dua temuan tambahan:

### [LOW] `getRosterForTicker` merender persentase yang HILANG sebagai "0.00%" (missing disajikan sebagai nol)
- **Lokasi:** [`lib/insider-network-service.js:1098-1099`](lib/insider-network-service.js:1098)
- **Kutipan kode bermasalah:**
  ```js
  percentage: r.percentage || 0,
  percentage_formatted: (r.percentage || 0).toFixed(2) + '%',
  ```
- **Penjelasan:** Ketika `r.percentage` tidak tersedia (null/undefined), nilai dipaksa `0` lalu dirender "0.00%" — kelas yang sama dengan temuan MEDIUM di `public/bandarmologi-runtime.js:3728` (missing disajikan sebagai nol), tetapi di lokasi berbeda. Pada tabel pemegang saham/insider, seorang pemegang saham tanpa data persentase akan tampak memegang 0%. Repo ini secara eksplisit menjaga prinsip "MISSING DATA IS NOT ZERO" di modul lain.
- **Bukti verifikasi riil:** Bukti kode: `|| 0` pada dua field berurutan; `r.percentage` berasal dari record yang bisa tidak punya field persentase.
- **Usulan arah perbaikan:** Bila `r.percentage == null`, kirim `percentage: null` + `percentage_formatted: '—'` alih-alih `0`/`0.00%`.

### [LOW] Literal tanggal `'2026-09-01'` sebagai fallback `last_date` di roster insider
- **Lokasi:** [`lib/insider-network-service.js:1102`](lib/insider-network-service.js:1102)
- **Kutipan kode bermasalah:**
  ```js
  last_date: r.date || '2026-09-01',
  ```
- **Penjelasan:** Sama kelasnya dengan literal tanggal di `bandarmologi-service.js`/`broker-hunter-service.js`: ketika record tidak punya tanggal, roster menampilkan tanggal tetap `2026-09-01` seolah transaksi terjadi pada tanggal itu.
- **Bukti verifikasi riil:** Bukti kode: 1 kemunculan literal.
- **Usulan arah perbaikan:** Kirim `last_date: null`/`'—'` saat tanggal tidak tersedia.

---

## MODUL: Frontend Bandarmologi Runtime (public/bandarmologi-runtime.js, 5.435 baris — TUNTAS 100%)

Batch ini menuntaskan sisa 3901-5435 (sesi lama 1-3900). **BERSIH pada sebagian besar isi**: render intel/scanner/hunter/insider network, abort controller + request-seq guard, `escapeHtml` konsisten, `formatDateDisplay` dengan weekend guard (PR2). Satu temuan baru:

### [LOW] Catatan scanner "Silent Foreign Accumulation" memfabrikasi "3 hari berturut-turut" saat `consecutive_days` absen
- **Lokasi:** [`public/bandarmologi-runtime.js:4860-4862`](public/bandarmologi-runtime.js:4860)
- **Kutipan kode bermasalah:**
  ```js
  } else if (bandarIntelScannerCategory === 'silent_foreign_accumulation') {
    var days = item.consecutive_days || 3;
    itNote = 'Akumulasi senyap asing ' + days + ' hari berturut-turut tanpa lonjakan harga drastis.';
  }
  ```
- **Penjelasan:** Bila `item.consecutive_days` tidak ada (null/0), UI menampilkan klaim "Akumulasi senyap asing **3 hari berturut-turut**" — angka yang tidak berasal dari data. Backend (`bandarmologi-intel-service.js`) hanya memasukkan item ke `indexes.silent_foreign_accumulation` saat `triggered` (yang mensyaratkan `consecutivePositiveDays >= 3`), sehingga field biasanya ada; namun fallback `|| 3` tetap bisa memfabrikasi klaim bila bentuk data berbeda (mis. file index statis `/data/bandarmologi-intel-indexes/latest_*.json` dengan skema lain). Sama kelasnya dengan temuan fabrikasi `price_change_pct: 0.8` di backend.
- **Bukti verifikasi riil:** Bukti kode: literal `|| 3` pada baris 4861; konsumen tunggal di scanner view.
- **Usulan arah perbaikan:** Bila `consecutive_days` absen, tampilkan "beberapa hari" atau `—`, jangan mengarang angka 3.

---

## MODUL: Frontend Watchlist & Track Record (public/watchlist-runtime.js 507, public/track-record-runtime.js 490 — TUNTAS)

Kedua file BERSIH pada inti: `watchlist-runtime` memakai `escapeHtml`/`escapeAttr` + `credentials:'same-origin'` + delegasi klik untuk catatan; `track-record-runtime` `trEntryBounds()` menormalkan urutan entry low-to-high (fix tampilan terdokumentasi), CSV export dengan `escapeCsvCell` yang benar. Satu temuan LOW:

### [LOW] `track-record-runtime.js` menulis teks error ke `innerHTML` tanpa escaping (dua lokasi)
- **Lokasi:** [`public/track-record-runtime.js:58`](public/track-record-runtime.js:58), [`:65`](public/track-record-runtime.js:65)
- **Kutipan kode bermasalah:**
  ```js
  tbody.innerHTML = '<tr>...Gagal memuat track record: ' + ((data && data.error) || 'Terjadi kesalahan.') + '</td></tr>';
  ...
  tbody.innerHTML = '<tr>...Gagal terhubung ke server: ' + (err.message || String(err)) + '</td></tr>';
  ```
- **Penjelasan:** Berbeda dari file yang sama yang memakai `escapeCsvCell` untuk CSV dan `public/watchlist-runtime.js` yang memakai `escapeHtml`, dua jalur error di sini menempelkan `data.error` (teks dari server) dan `err.message` (teks dari platform/fetch) langsung ke `innerHTML`. Bila pesan error server suatu saat memuat input user (mis. ticker) atau pesan fetch memuat URL, konten itu dirender sebagai HTML. Dampaknya LOW (sumber teks bukan input langsung user di jalur normal) dan belum terverifikasi bisa dikendalikan penyerang, tetapi enkapsulasi escaping tidak konsisten dalam satu file.
- **Bukti verifikasi riil:** Bukti kode: dua interpolasi mentah; pencarian file menunjukkan `escapeHtml` tidak ada padahal dipakai di file sibling.
- **Usulan arah perbaikan:** Bungkus `data.error`/`err.message` dengan helper `escapeHtml` sebelum interpolasi, konsisten dengan `watchlist-runtime.js`.

---

## MODUL: Frontend Portfolio AI + Pattern Radar (public/portfolio-ai-runtime-v2.js 844, public/pattern-stable-runtime.js 660 — TUNTAS 100%)

Kedua file dibaca baris-per-baris (seluruh rentang). **BERSIH — tidak ada bug baru tercatat.** Beberapa kecurigaan diperiksa langsung ke kode pendukung dan DITOLAK (dicatat sebagai bukti audit, bukan temuan):

- `portfolio-ai-runtime-v2.js` — pemanggilan `window.AutoCuanAI.renderMarkdown` ([`:209`](public/portfolio-ai-runtime-v2.js:209), `:339`) aman: [`public/ai-chat-renderer.js:148`](public/ai-chat-renderer.js:148) `inlineFormat` memanggil `escapeHtml` LEBIH DULU sebelum transform markdown → tidak ada jalur XSS dari jawaban model. `localFallback` jujur (menandai partial sum, "harga tersimpan bukan real-time"); `classifyFailure` memisahkan auth/kuota/server dari kegagalan provider sehingga fallback lokal tidak menyamar sebagai jawaban AI; `historyForRequest` membuang baris `local` agar ringkasan deterministik tak diajarkan ke model; `syncPortfolioPrices` worker-pool bounded 8 dengan sort "unpriced first".
- `pattern-stable-runtime.js` — `confidenceText` (`× 100`, [`:396`](public/pattern-stable-runtime.js:396)) BENAR: detector meng-clamp `confidence` ke 0–1 ([`lib/classic-chart-patterns.js:90`](lib/classic-chart-patterns.js:90), nilai literal 0.65–0.94), jadi "94%" valid, bukan 9400%. `esc()` dipakai konsisten di semua interpolasi HTML (ticker, nama, badge, reason, dataDate). `mapBounded` ([`public/ui-stability-fix.js:81`](public/ui-stability-fix.js:81)) menelan error per-worker (`catch (_) { results[index] = null; }`) → jalur sukses-lunak, bukan crash. State cache di-`persistCache()` TEPAT sebelum `progress()` memakai `state.total`; `render()` dipanggil di dalam try sebelum `state.loading` di-reset. `logout`/interval/`visibilitychange`/`focus` sudah ter-scope dengan benar.

### Suspicions verified and REJECTED (not findings)
1. **`fetchPrice` `price_age_hours` `Number(null) === 0`** ([`portfolio-ai-runtime-v2.js:418`](public/portfolio-ai-runtime-v2.js:418)) — pada produksi `/api/quote?portfolio=1` dengan sumber segar selalu men-stamp `price_age_hours` ([`api/quote.js:340`](api/quote.js:340), dari [`lib/latest-price-resolver.js:43`](lib/latest-price-resolver.js:43)); field absen hanya pada jalur upstream-fallback yang sudah ditandai `stale:true` ([`:343`](api/quote.js:343)). Tidak dikonfirmasi dapat terjadi di produksi.
2. **`state.total = tickers.length` vs jumlah hasil** ([`pattern-stable-runtime.js:528`](public/pattern-stable-runtime.js:528)) — `progress`/fase selesai memakai `state.rows.length`/`state.loaded` untuk syarat; nomor "dipindai N saham" memang sengaja menyebut jumlah ticker yang dipindai, bukan jumlah yang berpola. Aman.
3. **`markdown()` fallback `div.innerHTML.replace(/\n/g,'</p><p>')`** ([`portfolio-ai-runtime-v2.js:213`](public/portfolio-ai-runtime-v2.js:213)) — `textContent` di-set dulu lalu `innerHTML` dibaca, sehingga entity ter-escape (teks biasa, bukan HTML mentah). Aman.
4. **`patternPollInterval` state bocor saat logout** ([`pattern-stable-runtime.js:638`](public/pattern-stable-runtime.js:638)) — `clearPatternInterval` menutup variabel `var` yang di-hoist, jadi pemanggilan saat logout benar-benar membatalkan interval. Aman.

Total heading temuan tetap **82** (2 CRITICAL, 15 HIGH, 33 MEDIUM, 32 LOW) — batch ini tidak menambah temuan.

---

## MODUL: Frontend Pattern Safety + Portfolio Planner/Sync (4 file — TUNTAS)

Dibaca baris-per-baris. Tiga file BERSIH; satu temuan LOW (edge).

- `public/pattern-direction-safety.js` (323) — **BERSIH**. Model murni (tanpa DOM/observer — komentar menjelaskan penghapusan patcher lama yang menyebabkan 7014 mutasi/4s). `patternDirection` benar: `candidate.name` selalu `'Bullish ABCD'`/`'Bearish ABCD'` ([`lib/pattern-abcd.js:151`](lib/pattern-abcd.js:151)) → `labelDirection` mengembalikan arah tepat. `evaluateAbcdLevels` memakai angka otoritatif (bukan string ter-render), `statusRank` mengurutkan berdasarkan nilai keputusan.
- `public/pattern-tab-resume-guard.js` (137) — **BERSIH**. `createStableGate` mencegah denial transien saat focus+visibility bersamaan (in-flight dedup + `isAllowed()` re-check); `revealPatternPage` membersihkan ketiga atribut (`hidden`/`aria-hidden`/`inert`). Wrapper `refresh()` membuang argumen `force`, tetapi listener focus/visibility milik `pattern-map.js` sendiri tetap memanggil `refreshAccess(true)` lokal → re-check paksa tidak hilang; tidak ada bug terlihat.
- `public/portfolio-planner-v1.js` (240) — **BERSIH**. Position sizing BigInt (lot 100, bps 10000), validasi ketat (stop<entry, TP1>entry, TP2>TP1, batas risiko per profil), `safeNumber` mengembalikan null bila melewati MAX_SAFE_INTEGER, guidance jujur saat modal < 1 lot.

### [LOW] `pagehideSave` memakai `keepalive:true` dengan seluruh state portofolio (batas ~64KB browser)
- **Lokasi:** [`public/portfolio-supabase-sync.js:259-270`](public/portfolio-supabase-sync.js:259)
- **Kutipan kode bermasalah:**
  ```js
  function pagehideSave() {
    if (!hydrated || !dirty || !uid) return;
    try {
      fetch(ENDPOINT, {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'portfolio-state-save', portfolio_state: readLocalState(uid), expected_updated_at: cloudRevision })
      });
    } catch (_) {}
  }
  ```
- **Penjelasan:** `keepalive` request dibatasi ~64KB oleh browser (Chrome/Firefox). Bila state portofolio (plans + prices + price_meta + journal + snapshot + changes) melewati batas itu, flush terakhir saat navigasi/`pagehide` gagal senyap (tidak ada `.catch` pada promise fetch, hanya `try/catch` sinkron). Dampak sempit: save debounce (650ms) + change-watcher (700ms) biasanya sudah menyimpan perubahan dalam ~1,4s, jadi kehilangan data hanya bila perubahan terjadi <1,4s sebelum navigasi DAN state >64KB. Bukan bug fungsional pada portofolio normal, tetapi jalur flush terakhir tidak benar-benar menjamin tersimpan untuk state besar.
- **Bukti verifikasi riil:** Bukti kode: `keepalive:true` + body = `readLocalState(uid)` penuh; tidak ada penanganan kegagalan promise. Kunci `price_updated_at` terverifikasi cocok dengan `priceTimeKey()` Command Center ([`portfolio-command-center.js:89`](public/portfolio-command-center.js:89)).
- **Usulan arah perbaikan:** Untuk state besar, kirim hanya bagian yang berubah, atau tambahkan `.catch` yang menandai `dirty` tetap true + `setStatus('local-fallback', ...)` agar pengguna tahu belum tersimpan; atau andalkan `navigator.sendBeacon` dengan payload ringkas.

Total heading temuan kini **83** (2 CRITICAL, 15 HIGH, 33 MEDIUM, 33 LOW).

---

## MODUL: Frontend Pattern Map + Signal Gate Transparency (2 file — TUNTAS)

- `public/pattern-map.js` (363) — **BERSIH**. `validateCandidate` adalah validator kontrak renderer yang ketat (verifikasi OHLC, urutan candle, pivot cocok dengan candle sumber, ticker/timeframe/dataDate, `prz.low <= high`, `confirmationEvidence` wajib saat status `confirmed`) — tidak mendeteksi pola/mengarang level. Gate admin: hanya sesi admin `budi` terverifikasi server (`/api/admin-users`) boleh mengekspos Pattern Map; `mayBeAdmin()` hanya hint (tidak pernah memberi akses), storage-event mencabut akses saat logout. `levelLabel` memakai `en-US` tetapi TIDAK dipanggil di mana pun (grep: hanya definisi/ekspor) → tidak ada inkonsistensi render yang terlihat.
- `public/signal-gate-transparency.js` (295) — 1 temuan MEDIUM (di bawah).

### [MEDIUM] Panel "Kenapa Sinyal Ini Lolos Gate?" menandai gate PASS saat data absen & ambang RSI berbeda dari gate backend
- **Lokasi:** [`public/signal-gate-transparency.js:87-102`](public/signal-gate-transparency.js:87) (RSI/RR), [`public/signal-gate-transparency.js:65-66`](public/signal-gate-transparency.js:65) (volume)
- **Kutipan kode bermasalah:**
  ```js
  var rsiPassed = true; var rsiActualText = '-';
  if (rsi !== null) {
    rsiPassed = rsi <= 78 && rsi >= 35;               // ambang 35–78
    rsiActualText = rsi.toFixed(1) + ...;
  } else { rsiActualText = 'Dalam rentang aman'; }    // rsi null → tetap PASS
  var rsiThresholdText = '35 - 75 (Zona Aman)';       // teks ≠ kode (78 vs 75)
  ...
  var rrPassed = rr !== null ? (rr >= minRR) : true;  // rr null → PASS
  ```
- **Penjelasan:** Panel ini secara eksplisit menjawab "kenapa sinyal ini muncul" dan merender checklist ✅/⚠️ per gate. Tiga masalah nyata: (1) bila `rsi14`/`risk_reward` absen, gate ditandai **PASS** dengan teks "Dalam rentang aman"/"Terkalkulasi" — menyajikan "tidak diketahui" sebagai "lulus"; (2) ambang RSI di sini `35–78`, sedangkan gate keras backend `api/sector-hot.js` mensyaratkan `rsi14 >= 45 && rsi14 <= 70` dan **menolak** `rsi14 === null` (`failReasons.push('RSI tidak tersedia')`); (3) teks ambang yang ditampilkan ("35 - 75") tidak sama dengan kode (`78`). Akibatnya kartu bisa menampilkan "5/5 Gate Terpenuhi" untuk sinyal ber-RSI 40 atau 72 (yang justru gagal hard filter backend), atau saat RSI tak tersedia. Ini melanggar prinsip repo "MISSING DATA IS NOT PASS" dan menyesatkan karena panelnya khusus untuk transparansi alasan.
- **Bukti verifikasi riil:** Bukti kode lintas file — frontend `rsiPassed = rsi <= 78 && rsi >= 35` + `else { 'Dalam rentang aman' }` vs backend [`api/sector-hot.js:2135-2144`](api/sector-hot.js:2135) `rsi14 >= 45 && rsi14 <= 70` dan `rsi14 === null → failReasons`. Ambang volume frontend `>= 1.0`/DT `>= 1.2` selaras backend (`volume_ratio_avg20 >= 1.0`), tetapi `volRatio === null → 'Terkonfirmasi' + PASS` juga divergen.
- **Usulan arah perbaikan:** Samakan ambang dengan gate backend; saat input absen, render "Data tidak tersedia" dengan `passed:false` (unknown ≠ pass); perbaiki teks ambang RSI agar sama dengan kode.

Total heading temuan kini **84** (2 CRITICAL, 15 HIGH, 34 MEDIUM, 33 LOW).

---

## MODUL: Portfolio Command Model + Pattern Screener Extension (2 file — TUNTAS, BERSIH)

- `public/portfolio-command-center-model.js` (231) — **BERSIH**. Model murni (tanpa DOM): `budgetCapacity`/`affordability` lot 100 + reserve clamp 0–90; `planStatus` prioritas status deterministik (STOP_TOUCHED>TP2>TP1>NEAR_STOP>BELOW_ENTRY>NEAR_TP1>ACTIVE); `averageDownDecision` guard berurutan (cut-loss dulu, setup valid, dana, batas risiko); `compareSnapshots` event-driven; `journalSummary` `disciplinePct` null saat belum ada assessment. Catatan: `finite()` men-strip semua non-digit (mis. `"1.234,56"` → 123456), tetapi hanya tercapai bila `Number()` gagal lebih dulu; field IDR memakai `inputmode="numeric"` dan nilai tersimpan sudah number → tidak ada pemicu nyata.
- `public/pattern-screener-extension.js` (381) — **BERSIH**. `esc()` konsisten pada semua interpolasi HTML; `planConflict` menolak menggabungkan plan berlawanan arah (level Screener disembunyikan); MutationObserver di-throttle (`scheduled`) + `syncCard` early-return via `data-setup-signature` sehingga tulisan `innerHTML`-nya tidak memicu loop tak berujung.

Total heading temuan tetap **84** — batch ini tidak menambah temuan.

---

## MODUL: Portfolio Scenarios/RuntimeFix + Subscription Access/Voucher (5 file — TUNTAS, BERSIH)

- `public/portfolio-position-scenarios.js` (320) — **BERSIH**. `escapeHtml` konsisten; `installMoneyInputs` format Rupiah + `rawBeforeClick` mengembalikan digit mentah tepat sebelum handler kalkulasi (capture phase) agar nilai terformat tidak salah-parse; `installRiskGuard` pakai `stopImmediatePropagation` untuk mengambil alih tombol risk; `useBudgetMatch` tidak membawa harga sintetis apa pun.
- `public/portfolio-runtime-fix.js` (150) — **BERSIH**. `migrateLegacyPlans` idempoten (buat `id` stabil berbasis hash hanya untuk plan tanpa id, `return false` bila tak ada perubahan); `deletePlan` menghapus harga hanya bila ticker sudah tak dipakai plan lain; handler delete pakai capture + `stopImmediatePropagation`.
- `public/subscription-access-gate-v1.js` (146) — **BERSIH**. Mengganti resolver akses lama: premium HANYA dari entitlement server (`profile.subscription.entitlement.premium` dan `is_approved`), 401/403 → free, kegagalan jaringan → `state:'unavailable'` (fail-closed ke non-premium, bukan ke premium). Cache 20s + dedup `requestInFlight`. Backend tetap batas keamanan sebenarnya.
- `public/subscription-voucher-claim-v1.js` (73) — **BERSIH**. Butuh `crypto.randomUUID` (idempotency key aman), gate persetujuan terms, `stopImmediatePropagation` agar klaim lewat endpoint notification-aware tepat sekali; pesan jujur saat notifikasi admin gagal.
- `public/website-approved-access.js` (50) — **BERSIH**. Menyembunyikan UI subscription (akses dipegang gate server), `loadScriptOnce` idempoten via marker atribut.

Total heading temuan tetap **84** — batch ini tidak menambah temuan.

---

## MODUL: Mobile UI + Maintenance Guard + Mobile Nav (3 file — TUNTAS, BERSIH)

- `public/mobile-ui-runtime-v6.js` (19) — **BERSIH**. Hanya menyuntik CSS `@media (max-width:1023px)` untuk posisi launcher (safe-area aware). Tidak menyentuh logika drag.
- `public/maintenance-auth-guard.js` (37) — **BERSIH**. Menutup modal pilihan auth saat gate maintenance/status terlihat; membungkus `openAuthChoiceModal` agar tidak bisa dibuka saat maintenance. Guard UX di atas batas server.
- `public/mobile-nav.js` (474) — **BERSIH**. Launcher dibangun via `createElement` (tanpa innerHTML berisi label → tidak ada permukaan injeksi); tap didelegasikan ke tombol nav asli (semua gate/handler tetap jalan); `snapPosition` menjaga kontrol tetap di dalam safe area; MutationObserver di-throttle + `render()` early-return via signature; drag pakai pointer capture + ambang jarak; `applyShellVisibility` menyembunyikan launcher di luar `dashboardScreen` (landing/blocked/maintenance).

Total heading temuan tetap **84** — batch ini tidak menambah temuan.

---

## MODUL: Admin/Security Frontend (4 file — TUNTAS, BERSIH)

- `public/security-admin-runtime.js` (199) — **BERSIH**. `esc()` konsisten di semua interpolasi (ip, target, route, UA, reason, pesan error); tidak pernah menampilkan password/cookie/token/device ID; `when()` WIB via Intl; readiness pill jujur (DB/pepper/alert/fail-closed). `loading` guard mencegah request ganda.
- `public/admin-user-delete-enhancement.js` (111) — **BERSIH**. Konfirmasi ketik-username sebelum hapus; gate `isAdminBrowser()` (budi + is_admin) hanya menyembunyikan tombol (backend tetap batas); MutationObserver `requestAnimationFrame`-throttle + `deleteAccountReady` dedup; `budi`/`review` dikecualikan.
- `public/admin-tools-runtime.js` (143) — **BERSIH**. `securityMissingSteps` memandu aktivasi (migration/pepper/mode/shadow/fail-closed/alert) dengan penegasan "jangan taruh rahasia di halaman"; tombol Foreign/AI-Eval idempoten; observer settle via early-return.
- `public/admin-zero-link-pairing.js` (196) — **BERSIH**. Fail-closed (error polling tidak mengubah state UI/auth); `renderHint` menyaring `tag` ke `[A-Z0-9]{≤6}` dan `label` membuang `<>`; polling `stopped`/`inFlight` guard; konsumsi grant device sebelum berhenti (memperbaiki path /akses lama); diam saat `__AUTOCUAN_MAINTENANCE_CODE_ACTIVE__`.

Total heading temuan tetap **84** — batch ini tidak menambah temuan.

---

## MODUL: Manual Payment + Position Sizing (2 file — TUNTAS, BERSIH)

- `public/subscription-manual-payment-v1.js` (465) — **BERSIH**. `esc()` konsisten di semua interpolasi (referensi, bank, nominal, pengirim, catatan, status); `PAYMENT_REF_RE = /^PAY-[A-F0-9]{12}$/` memvalidasi deep-link `paymentReview` sebelum request; `idempotency_key` randomUUID untuk create/redeem; gate checkbox terms sebelum submit/redeem; polling visibility-aware + `PENDING_KEY` untuk resume; `adminReviewFromUrl` fail-closed (401/403 → pesan login admin). Voucher hint hanya 4 karakter terakhir.
- `public/position-sizing-calculator.js` (419) — **BERSIH**. `sanitizeNumber` menangani format lokal (titik ribuan/koma desimal); `calculate` lot 100 + clamp risk 0.1–10% + `cappedByCapital` jujur; `renderCardWidget`/`renderDetailSection` hanya menginterpolasi angka (bukan teks pengguna) ke innerHTML; `saveSettings` dispatch event + `refreshActiveViews` re-render kartu.

Total heading temuan tetap **84** — batch ini tidak menambah temuan.

---

## MODUL: Auth v2 + Account Center Lazy Loader (2 file — TUNTAS, BERSIH)

- `public/auth-v2.js` (448) — **BERSIH**. `validateServerSession` (session-status) hanya mempercayai `success===true && userId`; `storeSession` memaksa `is_admin` hanya bila `username==='budi'`; pesan error dirender via `textContent` (bukan innerHTML); `reset_token` divalidasi `/^[A-Za-z0-9_-]{32,100}$/` sebelum form reset; `autocuanAuthReady` resolve benar (komentar menjelaskan perbaikan bug lama). Semua fetch `/api/*` same-origin + timeout.
- `public/account-center-lazy-loader-v1.js` (329) — **BERSIH**. Lazy-load runtime (account-center/manual-payment/voucher) idempoten via flag global + `data-*` marker; kontrak registrasi menandai `termsAccepted`/`termsVersion`; markup terms statis (tanpa interpolasi data pengguna) → innerHTML aman; `installRegistrationContract` idempoten via `originalDoRegister`/`originalOpenRegister` guard.

Total heading temuan tetap **84** — batch ini tidak menambah temuan.

---

## MODUL: Account Center v1 (public/account-center-v1.js, 554 baris — TUNTAS, BERSIH)

- **BERSIH**. `esc()` dipakai konsisten di semua interpolasi (username, plan, harga, voucher hint, error). Voucher admin dibuat dengan `crypto.getRandomValues` (alphabet tanpa karakter ambigu), server hanya menyimpan HMAC/hash, daftar admin hanya menampilkan `code_hint` (4 karakter terakhir). `redeemVoucher`/`quoteVoucher` mewajibkan checkbox persetujuan + `idempotency_key` randomUUID. `loadTrialStatus`/`loadAdminVouchers` menulis error via `textContent`/`esc`. `request()` same-origin + timeout + fallback error aman. `installRegistrationContract` idempoten via guard `originalDoRegister`/`originalOpenRegister`. Markup terms statis (tanpa data pengguna).

Total heading temuan tetap **84** — batch ini tidak menambah temuan.

---

## MODUL: Track Record Backtest + UI Bugfix Pack (2 file — TUNTAS)

- `public/ui-bugfix-pack-v1.js` (382) — **BERSIH**. Sanitizer AI yang kokoh: allowlist tag (`ALLOWED_AI_TAGS`), drop tag berbahaya (`SCRIPT`/`IFRAME`/`FORM`/`SVG`/…), unwrap tag tak dikenal, buang semua `on*`/`style`/`id`, `hardenUrlAttributes` menetralkan `javascript:`/`vbscript:`/`data:` (termasuk decode entity + `srcset`), `safeAnchorHref` hanya izinkan http/mailto/tel/relatif, `_blank` dipaksa `rel="noopener noreferrer"`. Wheel-handoff + device-poll fail-safe.
- `public/track-record-backtest.js` (604) — 1 temuan MEDIUM (di bawah).

### [MEDIUM] Backtest Track Record diam-diam memakai 8 sinyal benchmark hardcoded saat data riil kosong, tanpa label demo
- **Lokasi:** [`public/track-record-backtest.js:55-64`](public/track-record-backtest.js:55) (data), [`:68`](public/track-record-backtest.js:68) (fallback); konsumen [`public/track-record-runtime.js:390`](public/track-record-runtime.js:390), [`:410`](public/track-record-runtime.js:410)
- **Kutipan kode bermasalah:**
  ```js
  var BENCHMARK_SIGNALS = [
    { ticker:'BBCA', date:'2026-08-05', entry1:9900, entry2:9800, tp1:10400, tp2:10800, sl:9600, outcome:'TP1_HIT', duration_text:'4 hari' },
    ... 8 sinyal fiktif ...
  ];
  function runBacktestSimulation(signals, rawConfig) {
    var list = (Array.isArray(signals) && signals.length > 0) ? signals.slice() : BENCHMARK_SIGNALS.slice();
  ```
- **Penjelasan:** `triggerBacktestSimulation` mengambil `_trData.signals` (data track record riil). Bila array itu kosong (user baru / belum ada sinyal / gagal muat), `runBacktestSimulation` mengganti input dengan `BENCHMARK_SIGNALS` — 8 trade fiktif (BBCA/BBRI/BREN/… dengan outcome TP1/TP2/SL yang dikarang). Hasilnya dirender sebagai metrik performa nyata: "Saldo Akhir", "Net Return", "Win Rate", "Profit Factor", "Expectancy", kurva ekuitas, dan tabel trade — TANPA penanda bahwa ini data demo. Pengguna bisa menyimpulkan strategi punya track record padahal itu angka benchmark bawaan. Ini kelas yang sama dengan temuan fabrikasi data lain (FALLBACK_INSIDER_DATA, accumulation_score) dan melanggar prinsip repo "jangan mengarang angka".
- **Bukti verifikasi riil:** Bukti kode: fallback `: BENCHMARK_SIGNALS.slice()` pada baris 68; konsumen `track-record-runtime.js:390` meneruskan `_trData.signals` yang bisa `[]`; tidak ada flag `isDemo`/label di `metrics` maupun renderer. Grep: `BENCHMARK_SIGNALS` hanya di file ini.
- **Usulan arah perbaikan:** Bila `signals` kosong, kembalikan hasil kosong + pesan "Belum ada sinyal untuk disimulasikan" (jangan pakai benchmark), atau tandai jelas `isDemo:true` dan tampilkan banner "Data contoh — bukan track record nyata" di UI.

Total heading temuan kini **85** (2 CRITICAL, 15 HIGH, 35 MEDIUM, 33 LOW).

---

## MODUL: Dashboard Top5 UI + Portfolio AI Workspace + tmp artifact (3 file — TUNTAS, BERSIH)

- `public/dashboard-top5-only-ui.js` (78) — **BERSIH**. Presentation-only (menyembunyikan monitor, memperluas kartu Top5, membersihkan teks catatan); observer `applyTop5OnlyLayout` idempoten (set `hidden`/`style` yang sama → tidak berubah → tidak re-trigger) + interval berhenti setelah observer terpasang. Tidak mengubah ranking/API.
- `public/portfolio-ai-workspace-v1.js` (33) — **BERSIH**. Hanya `scrollIntoView` ke `#page-ai` saat tab ai diklik/Enter; reduced-motion aware; tidak menyentuh logika AI.
- `public/tmp-ci-touch-batch1.js` (1) — artefak sisa ("touch batch 1 final"), tanpa kode. **Catatan pembersihan (bukan bug):** file ini (dan `public/tmp-measure*.html`) adalah artefak test/CI yang bocor ke `public/` — sebaiknya dihapus, sejalan dengan catatan folder `data/arjum-data/AUDITSCALE*/B4TST/DBGT4/NOACC`.

Total heading temuan tetap **85**.

---

## MODUL: AI Chat Renderer (rest) + Pattern Visual + Analisis Saham Runtime (3 file — TUNTAS)

- `public/ai-chat-renderer.js` (334; 1-319 sesi lalu + 320-334 batch ini) — **BERSIH**. `renderMarkdown`/`inlineFormat` meng-escape SEBELUM transform markdown (aman XSS); observer `polishNode` idempoten via `data-ai-rendered` signature.
- `public/pattern-visual.js` (360) — **BERSIH**. Pure SVG string builder (tanpa I/O); `finite` menolak null/'' (data absen tidak jadi "0"); `esc()` dipakai untuk name/ticker/dataDate/point label/level label; window pattern dipilih agar X tidak terpotong; gutter label di-spread dan yang tak muat dibuang (tidak menimpa sumbu).
- `public/analisis-saham-runtime.js` (1.114) — 1 temuan MEDIUM (di bawah).

### [MEDIUM] `analisis-saham-runtime.js` menyuntik HTML jawaban AI ke `innerHTML` TANPA `sanitizeAIHtml` (satu-satunya sink AI yang tidak disanitasi)
- **Lokasi:** [`public/analisis-saham-runtime.js:888-891`](public/analisis-saham-runtime.js:888) (sink), vs sink yang disanitasi di [`public/index.html:4447`](public/index.html:4447), [`:4451`](public/index.html:4451), [`:4987`](public/index.html:4987), [`:6424`](public/index.html:6424), [`:6462`](public/index.html:6462), [`:6836`](public/index.html:6836)
- **Kutipan kode bermasalah:**
  ```js
  var rawOutput = data.html || data.reply || '';
  if (rawOutput) {
    var html = convertStrayMarkdownBold(rawOutput.replace(/^```html\s*/i, '').replace(/```\s*$/i, ''));
    resultArea.innerHTML = '<div class="ai-content ...">' + html + '</div>' + ...
  ```
  ```js
  // public/analisis-saham-runtime.js:23-25 — hanya bold, TIDAK meng-escape
  function convertStrayMarkdownBold(html) {
    return String(html || '').replace(/\*\*([^*<>\n]+)\*\*/g, '<strong>$1</strong>');
  }
  ```
- **Penjelasan:** Jawaban AI (`data.html`/`data.reply`) disisipkan langsung ke `innerHTML` setelah HANYA transform bold. Tidak ada pemanggilan `sanitizeAIHtml`. Padahal alur AI yang sama di `index.html` SELALU menjalankan `sanitizeAIHtml(html)` lebih dulu, baru `convertStrayMarkdownBold` (mis. `:4447`+`:4451`). `sanitizeAIHtml` (global, `index.html:11729`) justru ditulis khusus untuk membuang `<script>`, event handler (`onerror`/`onload`), dan skema URL berbahaya (`javascript:`/entity-encoded) — dan `ui-bugfix-pack-v1.js` memperkuatnya. Karena `analisis-saham-runtime.js` dijalankan pada dokumen yang sama (mengakses `#analisisResult`, `#analisisInput`, `#headerUsername`), `sanitizeAIHtml` tersedia sebagai global — tetapi tidak dipanggil di sini. Model dapat terpengaruh input pengguna (chatMessage memuat ticker + konteks + blok kutipan), sehingga output bisa memuat markup/`onerror` yang di sini dieksekusi, sedangkan di jalur dashboard tidak. Ini regresi keamanan defense-in-depth: satu-satunya sink AI tanpa sanitizer.
- **Bukti verifikasi riil:** Grep `sanitizeAIHtml`: dipakai di `index.html` (6 sink) + di-hardening `ui-bugfix-pack-v1.js`; NOL kemunculan di `analisis-saham-runtime.js`. Grep `convertStrayMarkdownBold`: ada di `analisis-saham-runtime.js:23,890` dan `index.html:4451,11725`. Perbandingan langsung: `index.html` sanitize→bold; `analisis-saham-runtime.js` bold saja.
- **Usulan arah perbaikan:** Sebelum `innerHTML`, jalankan `if (typeof sanitizeAIHtml === 'function') html = sanitizeAIHtml(html);` (urutan sama seperti `index.html`: sanitize dulu, lalu `convertStrayMarkdownBold`). Jangan andalkan `escapeHtml` penuh karena output memang HTML.

Total heading temuan kini **86** (2 CRITICAL, 15 HIGH, 36 MEDIUM, 33 LOW).

---

## MODUL: public/index.html (12.342 baris) — audit bertahap

### [HIGH] Stored XSS di viewer log admin: `loadAdminLogs` menyisipkan `username`/`ticker` mentah ke `innerHTML`, padahal username tidak dibatasi charset
- **Lokasi:** [`public/index.html:7404-7405`](public/index.html:7404) (kartu analysis), [`:7418`](public/index.html:7418) (tabel generik); sumber data [`api/log.js:109-111`](api/log.js:109) + [`api/log.js:37-42`](api/log.js:37); validasi username [`api/register-user.js:101-108`](api/register-user.js:101)
- **Kutipan kode bermasalah:**
  ```js
  // public/index.html:7404-7405 (render kartu analysis)
  cardsHtml += '<span ...>' + (row.ticker || '-') + '</span>';
  cardsHtml += '<span ...>' + (row.username || '-') + '</span>';
  // public/index.html:7418 (tabel generik)
  logs.forEach(function(row) { ... keys.forEach(function(k) { var val = row[k] || '-'; ... tableHtml += '<td ...>' + val + '</td>'; }); });
  ```
  ```js
  // api/log.js:37-42 — hanya strip control char + cap panjang, TIDAK escape HTML
  function text(value, max) { return String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max); }
  // api/log.js:109-111 — username dari signed session (session.un) atau body
  const username = session ? text(session.un, LIMITS.username) || 'unknown' : text(body.username, LIMITS.username) || 'unknown';
  ```
  ```js
  // api/register-user.js:101-108 — username hanya dicek panjang, TANPA charset
  const usernameLower = String(username).trim().toLowerCase();
  if (!usernameLower || usernameLower.length < 2) { ... }
  if (usernameLower.length > 30) { ... }
  ```
- **Penjelasan:** `loadAdminLogs` (dipanggil dari panel admin) membangun HTML dengan menyisipkan `row.username` dan `row.ticker` LANGSUNG ke `innerHTML` tanpa `escapeAdminHtml`. Nilai-nilai itu berasal dari `login_logs`/`ai_analysis_logs` yang diisi `api/log.js`, yang hanya membuang karakter kontrol dan memotong panjang — tidak meng-escape HTML. Karena `api/register-user.js` TIDAK membatasi charset username (hanya 2–30 karakter), seorang penyerang dapat mendaftar dengan username seperti `<img src=x onerror=alert(document.cookie)>` (28 karakter, lolos batas 30). Username itu tersimpan apa adanya, lalu dirender sebagai HTML di panel admin → **stored XSS** yang dieksekusi di sesi admin (`budi`) saat admin membuka tab log. Ironisnya, tabel user yang lebih baru (`renderApprovedUsersTable`, `renderDeviceDetailsHtml`) SUDAH memakai `escapeAdminHtml`/`adminOnclickArg` — jadi ini inkonsistensi: jalur log lama tidak ikut di-escape. `ticker` (cap 12) juga mentah di tabel generik, dan endpoint `/api/log` menerima `ticker` dari body same-origin mana pun.
- **Bukti verifikasi riil:** Bukti kode lintas file: (1) `index.html:7404-7405,7418` interpolasi mentah; (2) `api/log.js:41` hanya strip control char; (3) `api/register-user.js:104-108` tanpa regex charset; (4) `escapeAdminHtml` ada di file yang sama (`:7556`) tetapi tidak dipakai di `loadAdminLogs`. Panjang `<img src=x onerror=alert(1)>` = 28 ≤ 30 → lolos validasi.
- **Usulan arah perbaikan:** Bungkus setiap nilai dinamis di `loadAdminLogs` dengan `escapeAdminHtml(...)` (kartu analysis + tabel generik, termasuk header `k`). Sebagai pertahanan berlapis, batasi charset username di `api/register-user.js` (mis. `/^[a-z0-9._-]{2,30}$/`) dan/atau escape saat menulis di `api/log.js`.

Total heading temuan kini **87** (2 CRITICAL, 16 HIGH, 36 MEDIUM, 33 LOW).

---

## MODUL: Pattern Safety Hardening + UI Stability Fix + Admin Maintenance Code (3 file — TUNTAS, BERSIH)

- `public/pattern-safety-hardening-v1.js` (186) — **BERSIH**. `safeFinite` menolak `null`/`''`/`false` (mencegah koersi ke 0 yang membuat data absen tampak level nyata); memasang patch lewat `Object.defineProperty` setter agar implementasi aman terpasang SEBELUM `pattern-direction-safety.js` dimuat; `tradePlanDirection` menolak entry satu sisi (tidak menyalin sisi yang hilang).
- `public/ui-stability-fix.js` (223) — **BERSIH**. `collectTickers`/`mapBounded` (concurrency 4, error per-worker ditelan), `cleanVisibleArtifacts` + `pruneStandaloneArtifacts` membersihkan artefak teks; observer `cleanNode` idempoten via `data-ui-cleaning`/`data-artifact` guard. `levelLabel` dead (tanpa pemanggil).
- `public/admin-maintenance-code.js` (483) — **BERSIH**. OTP 6 digit (input `\D` strip + `autocomplete=one-time-code`), consume via server, `setError` pakai `textContent`; `hydrateApprovedClientState` hanya untuk `budi`+`isAdmin`; lifecycle Telegram notify/cleanup `keepalive`; polling visibility-aware (`HIDDEN_POLL_MS`) + observer gate cleanup; OTP auto-delete dari server. Tidak ada kebocoran kode/secret.

Total heading temuan tetap **85**.