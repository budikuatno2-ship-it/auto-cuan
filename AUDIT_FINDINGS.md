# AUDIT_FINDINGS — Auto-Cuan

Semua temuan wajib menyertakan `path/file:baris` dan kutipan kode asli.
Modul yang sudah dibaca penuh dan bersih dicatat di bagian "Modul Bersih".

---

## BUG-001

- **Severity** : CRITICAL
- **Area** : Auth (P0 — blocker total)
- **Lokasi** : `public/index.html:1522` (`#loginModal`), `public/index.html:1539` (`#registerModal`), `public/index.html:1598` (`#selfResetModal`) — semuanya berada di dalam `#dashboardScreen` (`public/index.html:326`); logika yang mematikannya ada di `public/index.html:1838-1845`.
- **Gejala** : Pengunjung yang belum login menekan tombol **Login** atau **Daftar** di landing page, dan tidak terjadi apa-apa — modal tidak pernah muncul. Terjadi di HP maupun laptop. Tombol "Lupa Password?" juga mati. Ini blocker total: tidak ada satu pun jalur masuk ke aplikasi.
- **Root cause** :

  Ketiga modal autentikasi ditulis sebagai anak dari `#dashboardScreen`. Dibuktikan dengan parser HTML sungguhan (parse5) terhadap `public/index.html` sebelum perbaikan:

  ```
  loginModal        ancestors: [ "dashboardScreen" ]
  registerModal     ancestors: [ "dashboardScreen" ]
  selfResetModal    ancestors: [ "dashboardScreen" ]
  authChoiceModal   ancestors: []            <-- ini top-level, makanya ia muncul
  ```

  `setTopLevelView()` menyembunyikan DAN meng-`inert` setiap view yang tidak aktif — `public/index.html:1838-1845`:

  ```js
  var ids = { loading:'initialLoader', blocked:'blockedScreen', maintenance:'maintenanceScreen', serviceStatus:'serviceStatusScreen', landing:'landingPage', app:'dashboardScreen' };
  Object.keys(ids).forEach(function(key) {
      var el = document.getElementById(ids[key]); if (!el) return;
      var active = key === state;
      el.classList.toggle('hidden', !active);
      el.setAttribute('aria-hidden', active ? 'false' : 'true');
      if ('inert' in el) el.inert = !active;
  });
  ```

  Pengunjung yang belum login selalu berada di `setTopLevelView('landing')`, sehingga `#dashboardScreen` mendapat `class="hidden"` (`display:none`, lihat `public/index.html:71`) **dan** `inert = true`.

  Sementara itu fungsi pembuka modal hanya melepas `hidden` pada modal itu sendiri, tidak pernah pada leluhurnya — `public/index.html:2608`, `2745`, `2747`:

  ```js
  function openLoginModal() { updateLandingCtas(); document.getElementById('loginModal').classList.remove('hidden'); document.getElementById('loginError').classList.add('hidden'); }
  ```

  Karena leluhurnya `display:none`, melepas `hidden` pada anak tidak membuat apa pun terlihat; dan `inert` pada leluhur membuat seluruh subtree tidak bisa difokus/diklik. Jadi modal tidak muncul dan tidak bisa disentuh.

- **Dampak** : 100% pengguna yang belum login, di semua platform dan semua browser. Login, registrasi, dan self-service reset password semuanya tidak dapat dijangkau. Perbaikan terms-acceptance di PR #491 benar tetapi tidak pernah terlihat efeknya, karena form pendaftarannya sendiri tidak pernah tampil.
- **Perbaikan** : Memindahkan blok markup `#loginModal`, `#registerModal`, dan `#selfResetModal` keluar dari `#dashboardScreen`, menjadi anak langsung `<body>` dan bersebelahan dengan `#dashboardScreen` (persis seperti `#authChoiceModal` yang selama ini memang berfungsi). Murni relokasi markup — tidak ada satu baris logika, handler, id, atau class yang diubah.
- **Risiko** : Rendah. Ketiga modal berposisi `fixed inset-0 z-[9999]`, sehingga posisinya dalam alur dokumen tidak mempengaruhi tata letak. Tidak ada selector yang men-scope ke `#dashboardScreen ...` untuk ketiga modal ini. Rollback = `git revert` pada satu commit.
- **Verifikasi** :
  1. `test/auth-modals-outside-dashboard-screen.test.js` — merekonstruksi pohon elemen nyata dari `public/index.html`, menjalankan `setTopLevelView()` dan `open*Modal()` yang asli di dalam `vm`, lalu memastikan modal beserta field-nya tidak berada di bawah leluhur `display:none` maupun `inert`. Test ini **gagal 4/6 pada markup sebelum perbaikan** dan hijau setelahnya.
  2. Verifikasi browser sungguhan (Chromium headless, desktop 1440x900 dan profil mobile Pixel 5),
     menyajikan `public/` secara lokal dengan hanya `/api/maintenance-settings` di-stub ke
     `maintenanceMode:false`, lalu mengklik pemicu Login yang benar-benar terlihat dan mengetik
     ke field-nya:

     | | sebelum perbaikan | sesudah perbaikan |
     |---|---|---|
     | leluhur `#loginModal` | `["dashboardScreen"]` | `[]` |
     | computed `display` modal | `flex` | `flex` |
     | kotak `#loginUsername` | **0 x 0** | **311 x 46** |
     | kotak `#loginBtn` | **0 x 0** | **311 x 48** |
     | `fill('#loginUsername')` | **timeout 30 detik** | berhasil mengetik |
     | `click('#loginBtn')` | **timeout 8 detik** | terkirim |
     | `#loginError` setelah submit | tetap tersembunyi, kosong | pesan server tampil |

     Dua detail penting: (a) `display` modal itu sendiri memang sudah `flex` sebelum perbaikan —
     `openLoginModal()` bekerja persis seperti niatnya; elemennya hanya berukuran 0x0 karena
     leluhurnya `display:none`. Pemeriksaan yang hanya melihat class/style modal itu sendiri akan
     menyimpulkan "tidak ada masalah". (b) `#loginError` tetap tersembunyi setelah klik, jadi
     pengguna tidak mendapat umpan balik apa pun — cocok dengan gejala "tombol Login ditekan, tidak
     terjadi apa-apa", bukan "login gagal".
     Pola yang sama pada registrasi: `#regTermsAccepted` berukuran 0x0 dan `check()` timeout sebelum
     perbaikan; 13x16 dan berhasil dicentang setelahnya.
- **Status** : DIPERBAIKI (PR P0)

---

## BUG-002

- **Severity** : MEDIUM
- **Area** : Infra / CI
- **Lokasi** : `tools/curated-build-tests.json` vs `test/`
- **Gejala** : Sebagian file test tidak pernah dijalankan oleh `npm run build`, sehingga regresi yang seharusnya tertangkap bisa lolos.
- **Root cause** : `tools/run-build-test-suite.js:52-58` hanya menjalankan file yang terdaftar di `tools/curated-build-tests.json`. Test yang ditambahkan tanpa mendaftarkannya di sana menjadi test mati.

  ```js
  const curatedTestFiles = JSON.parse(fs.readFileSync(curatedConfigFile, 'utf8'));
  const existingFiles = curatedTestFiles.filter(f => fs.existsSync(path.join(ROOT_DIR, f)));
  ```

  Contoh konkret: `test/auth-modal-and-ai-analysis-ui.test.js` ditambahkan di PR #494 tetapi tidak terdaftar, jadi tidak pernah dieksekusi CI.
- **Dampak** : Cakupan CI lebih kecil dari yang terlihat.
- **Perbaikan** : (diusulkan, belum dieksekusi di PR ini) tambahkan validator yang menggagalkan build bila ada `test/*.test.js` yang tidak terdaftar, atau daftarkan sisa file yang belum masuk.
- **Status** : DITEMUKAN

---

## BUG-003

- **Severity** : HIGH
- **Area** : AI-Analisis (P1)
- **Lokasi** : `public/index.html` — `runAnalisisFromDashboard()`, blok fetch dan penanganan respons (sebelum perbaikan: baris 3288-3348 dan catch di 3380-3384)
- **Gejala** : Setiap kegagalan dari server muncul sebagai satu pesan yang sama: **"Analisis belum berhasil. Coba lagi."** Pengguna tidak pernah tahu alasan sebenarnya — sesi habis, belum berlangganan, kena rate limit, atau AI belum dikonfigurasi.
- **Root cause** : Handler tidak pernah memeriksa `response.ok`. Ia hanya membaca `data.html || data.reply`:

  ```js
  var data = await response.json();
  rawOutput = data.html || data.reply || '';
  ...
  if (rawOutput) { /* render */ } else { throw new Error('Tidak ada hasil.'); }
  ```

  Padahal `api/analyze.js:31-38` menolak permintaan dengan alasan yang jelas:

  ```js
  res.status(access.status || 403).json({
    success:false,
    code:access.code || 'PREMIUM_ACCESS_DENIED',
    error:access.error || 'Akses premium diperlukan.',
    access_level:access.access_level || 'free'
  });
  ```

  Karena body penolakan tidak punya `html` maupun `reply`, `rawOutput` menjadi `''` dan semuanya jatuh ke `catch` generik.

- **Dampak** : Fitur Analisis Saham terlihat "rusak total" bagi pengguna, padahal servernya bekerja benar. Lebih buruk lagi, saran "Coba lagi" **salah** untuk kasus yang tidak bisa diperbaiki dengan mengulang: menekan ulang saat belum berlangganan tidak akan pernah berhasil, dan mengulang saat kena rate limit justru memperburuk.

  Ini kemungkinan besar juga yang dialami pelapor: karena BUG-001 membuat login mustahil, tidak ada sesi, `/api/analyze` menjawab 401/403, dan yang terlihat hanyalah "Analisis belum berhasil. Coba lagi."

- **Bukti reproduksi (Chromium sungguhan, stub server mengembalikan body asli)** :

  | jawaban server | yang dilihat pengguna (sebelum) | yang dilihat pengguna (sesudah) |
  |---|---|---|
  | `403 PREMIUM_ACCESS_DENIED` + `"Akses premium diperlukan. Aktifkan langganan untuk memakai AI."` | Analisis belum berhasil. Coba lagi. | Akses premium diperlukan. Aktifkan langganan untuk memakai AI. |
  | `401` | Analisis belum berhasil. Coba lagi. | Sesi kamu sudah berakhir. Muat ulang halaman dan login lagi. |
  | `429` + `retry_after_seconds: 42` | Analisis belum berhasil. Coba lagi. | Terlalu banyak permintaan analisis dalam waktu singkat. Coba lagi sekitar 42 detik lagi. |
  | `200` + html | analisis tampil normal | tidak berubah |

- **Perbaikan** : `describeAnalisisFailure()` mencerminkan `describeFailure()` di `public/stock-analysis-ai.js:157-179`. Keduanya memanggil endpoint yang sama, jadi ada test yang memastikan keduanya tidak boleh berbeda pendapat soal `retryable`. Pesan dirender lewat `textContent`, tidak pernah digabung ke `innerHTML`, karena isinya berasal dari server.
- **Risiko** : Rendah. Jalur sukses tidak disentuh sama sekali (terbukti: keluaran probe `200` identik).
- **Verifikasi** : `test/ai-stock-analysis-failure-and-race.test.js` + probe browser di atas.
- **Status** : DIPERBAIKI (PR #497)

---

## BUG-004

- **Severity** : HIGH
- **Area** : AI-Analisis (P1)
- **Lokasi** : `public/index.html` — `runAnalisisFromDashboard()`, seluruh badan fungsi
- **Gejala** : Berpindah ticker dengan cepat membuat panel menampilkan analisis **emiten yang salah**.
- **Root cause** : Tidak ada penanda generasi permintaan. Fungsi ini `async` dan menulis `resultArea.innerHTML` tanpa syarat setelah `await`, sehingga respons lama yang datang belakangan menimpa respons baru.
- **Bukti reproduksi (Chromium sungguhan)** : BBCA dijawab terlambat 3 detik, BBRI dijawab langsung.

  ```
  yang terakhir diminta pengguna : BBRI
  yang tampil di panel           : "ANALYSIS FOR BBCA"
                                   + tombol "Lihat Chart BBCA" / "Lihat News BBCA"
                                   + updateAnalysisContext() mengarahkan chat lanjutan ke BBCA
  ```

- **Dampak** : Untuk aplikasi trading ini adalah kegagalan paling berbahaya di layar tersebut — analisis satu emiten tampil di bawah ticker emiten lain. Chat lanjutan kemudian membahas BBCA sementara pengguna yakin sedang menanyakan BBRI.
- **Perbaikan** : Setiap pemanggilan mengambil nomor urut **sebelum `await` pertama**, dan hanya boleh menyentuh DOM atau konteks chat selama masih memegang nomor terbaru. Pemanggilan yang sudah usang juga membatalkan stream reader-nya, bukan menghabiskannya.
- **Risiko** : Rendah, tetapi ini perubahan alur kontrol — ditutup oleh test yang mengeksekusi fungsi aslinya.
- **Verifikasi** : test "a slow earlier analysis never overwrites the ticker the user asked for last" (mengeksekusi fungsi sungguhan, bukan regex sumber) + probe browser.
- **Status** : DIPERBAIKI (PR #497)

---

## BUG-005

- **Severity** : MEDIUM
- **Area** : AI-Analisis (P1) / Infra
- **Lokasi** : `lib/analyze-legacy.js` — sebelum perbaikan baris 547 (`handleChartDeepSeek`), 594 (`handleChartVision`), 711 (`callGroq`), 1518 (`handleOrderbook`), 1599 (`handleBrokerSummary`)
- **Gejala** : Upload chart / orderbook / broker summary bisa menggantung sampai fungsi Vercel mati, lalu browser menerima halaman error HTML, bukan JSON.
- **Root cause** : Lima panggilan provider tanpa timeout, padahal tiga saudaranya sudah dibatasi 20 detik dengan komentar yang menjelaskan persis alasannya (`lib/analyze-legacy.js:423-426`):

  ```js
  // Bounded so a stuck upstream response can't hold the whole request open
  // until the platform's own function timeout (60s for this route) kills it.
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 20000);
  ```

  Jalur chart memanggil dua di antaranya berurutan (`handleChartDeepSeek` lalu `handleChartVision`, lihat `lib/analyze-legacy.js:46-53`), jadi keduanya bisa menghabiskan seluruh anggaran 60 detik.

- **Dampak** : Satu provider yang macet menghabiskan durasi fungsi, dan kegagalannya sampai ke pengguna sebagai error generik tanpa alasan.
- **Perbaikan** : Helper `fetchWithTimeout()`. Dua panggilan berantai dibatasi 22 detik masing-masing (22 + 22 < 60); sisanya memakai 20 detik yang sudah ada. Ada test yang mengambil batas 60 detik langsung dari `vercel.json`, jadi tetap benar bila `maxDuration` diubah.
- **Risiko** : Panggilan yang sangat lambat kini gagal lebih cepat dan terkendali, bukan mati bersama seluruh fungsi. Menurut saya ini lebih baik, tapi ini memang perubahan perilaku — saya sebutkan eksplisit.
- **Verifikasi** : test `fetchWithTimeout aborts a stalled upstream...` dan `no upstream provider call in lib/analyze-legacy.js is left unbounded` (memindai sumber sungguhan; gagal pada kode sebelum perbaikan).
- **Status** : DIPERBAIKI (PR #497)

---

## BUG-006

- **Severity** : MEDIUM
- **Area** : AI-Analisis (P1)
- **Lokasi** : `public/index.html` — fetch di `runAnalisisFromDashboard()`
- **Gejala** : Spinner "Mengambil data teknikal..." berputar selamanya bila platform atau provider menggantung.
- **Root cause** : Tidak ada `AbortController` sama sekali, padahal saudaranya `public/stock-analysis-ai.js:13,209-211` memakai batas 70 detik.
- **Perbaikan** : Batas 70 detik yang sama, dan `AbortError` diklasifikasikan sebagai "Analisis dihentikan karena terlalu lama" alih-alih pesan generik.
- **Status** : DIPERBAIKI (PR #497)

---

## BUG-007

- **Severity** : LOW
- **Area** : AI-Analisis / kode mati
- **Lokasi** : `public/index.html` (cabang streaming di `runAnalisisFromDashboard`) vs `api/analyze.js:113-117` dan `lib/analyze-legacy.js`
- **Gejala** : Tidak ada gejala bagi pengguna. Indikator "real-time" yang dijanjikan tidak pernah muncul pada analisis awal.
- **Root cause** : Frontend mengirim `stream: true` dan `Accept: text/event-stream`, tetapi `api/analyze.js` merutekan `source: 'chat_mode'` ke `lib/analyze-legacy.js`, yang sama sekali tidak punya dukungan SSE — `stream: false` di-hardcode pada payload provider dan tidak ada satu pun `res.write` atau `text/event-stream` di file itu. Jadi `isStreamResponse` selalu `false` dan seluruh blok pembaca SSE tidak pernah dieksekusi.
- **Dampak** : Kode mati yang menyesatkan pembaca berikutnya. Tidak merusak apa pun.
- **Perbaikan** : **Sengaja tidak diubah.** Menghapusnya adalah pembersihan, bukan perbaikan bug, dan cabang itu akan bekerja benar bila handler legacy suatu saat mendukung SSE. Saya hanya membuatnya ikut patuh pada penjaga staleness yang baru. Diserahkan ke pemilik repo sebagai keputusan.
- **Status** : DITEMUKAN (tidak diperbaiki, disengaja)

---

## BUG-008

- **Severity** : HIGH
- **Area** : AI-Portofolio (P2)
- **Lokasi** : `public/portfolio-ai-runtime-v2.js` — `contextNow()`, sebelum perbaikan baris 91 (`var normalized = plans.slice(0, 30).map(...)`) dan blok `summary` di baris 139-149
- **Gejala** : Untuk portofolio dengan lebih dari 30 posisi, AI Portofolio (dan angka di layar, dan ringkasan lokal) melaporkan **jumlah posisi lebih sedikit dan total risiko lebih kecil daripada kenyataan** — tanpa tanda apa pun bahwa datanya dipotong.
- **Root cause** : Seluruh agregat dihitung dari daftar yang sudah dipotong:

  ```js
  var normalized = plans.slice(0, 30).map(function (plan) { ... }).filter(Boolean);
  ...
  summary: {
    plan_count: normalized.length,          // = 30, bukan jumlah sebenarnya
    total_estimated_risk: totalRisk,        // hanya menjumlah 30 posisi pertama
    total_estimated_risk_is_partial: missingRisk > 0,   // false -> mengaku lengkap
    ...
  }
  ```

  `total_estimated_risk_is_partial` hanya menandai posisi yang **field risikonya kosong**, bukan posisi yang **dibuang seluruhnya** oleh `slice`. Jadi jumlah yang kurang justru dinyatakan lengkap.

- **Bukti reproduksi** (45 posisi, masing-masing risiko Rp 100.000 dan modal Rp 10.000.000):

  ```
  posisi yang benar-benar dimiliki : 45
  posisi yang dikirim ke AI        : 30
  summary.plan_count dilaporkan    : 30
  total risiko SEBENARNYA          : Rp 4.500.000
  total_estimated_risk ke AI       : Rp 3.000.000     <-- 33% lebih kecil
  ditandai partial?                : false            <-- diklaim lengkap
  total nilai SEBENARNYA           : Rp 450.000.000
  total_position_value ke AI       : Rp 300.000.000
  ada field truncation?            : tidak ada
  ```

- **Dampak** : Untuk asisten manajemen risiko, ini angka terburuk yang bisa salah. Pengguna diberi tahu risiko totalnya lebih kecil dari kenyataan, dengan penanda yang secara eksplisit menyatakan angka itu lengkap. Angka yang sama juga dipakai `#aiPlanCount` di layar (`public/portfolio-ai-runtime-v2.js:188`) dan ringkasan lokal offline — jadi bukan hanya masalah prompt.

  Ini melanggar dua invarian yang ditulis file itu sendiri:

  ```js
  // A missing number is not a zero. It is still excluded from the total, but
  // the count of what was excluded travels with the total so neither the AI
  // nor the local summary can present a partial sum as a complete one.
  ```
  ```js
  // A partial sum is never presented as a complete one.
  ```

- **Perbaikan** : Semua posisi dinormalisasi dan dihitung. Yang tetap dibatasi hanya **daftar rincian per posisi** yang masuk ke prompt, dan pembatasan itu kini diumumkan lewat `positions_in_context`, `positions_omitted_from_context`, dan `position_list_is_partial`. `plan_count` menjadi jumlah sebenarnya. Ringkasan lokal juga berhenti menyajikan pilihan "risiko terbesar" seolah berlaku untuk seluruh portofolio ketika daftarnya hanya sebagian. **Batas 30 itu sendiri tidak diubah**, jadi ukuran prompt dan biaya token tidak bergerak.
- **Risiko** : Ini mengubah angka yang dilihat pengguna — sengaja, karena angka lamanya salah. Rumusnya tidak diubah; hanya himpunan masukannya yang kini lengkap. Pengguna dengan ≤30 posisi tidak melihat perubahan apa pun. Rollback aman: tidak ada apa pun yang dipersistensi dalam bentuk baru.
- **Verifikasi** : `test/portfolio-ai-context-completeness.test.js` — gagal pada kode sebelum perbaikan dengan `expected: 45, actual: 30`.
- **Status** : DIPERBAIKI (PR #498)

---

## BUG-009

- **Severity** : MEDIUM
- **Area** : AI-Portofolio (P2)
- **Lokasi** : `public/portfolio-ai-runtime-v2.js` — `classifyFailure()`, sebelum perbaikan baris 482-524
- **Gejala** : Pengguna tanpa langganan aktif bertanya ke Asisten AI Portofolio, lalu mendapat ringkasan lokal, pesan "Jawaban AI belum bisa diambil. Ringkasan lokal ditampilkan.", dan tombol **Coba lagi yang tidak akan pernah berhasil**. Alasan sebenarnya tidak pernah muncul.
- **Root cause** : Tidak ada cabang untuk `402` maupun `SUBSCRIPTION_REQUIRED`, padahal itulah yang dikembalikan `api/analyze.js` dari `requirePremiumEntitlement()` (`lib/subscription-auth.js:96-108`). Permintaan jatuh ke cabang default yang menganggapnya kegagalan provider.

  Ini melanggar kontrak yang ditulis fungsi itu sendiri tepat di atasnya:

  ```js
  // A failure the user can act on (session, quota, server config) must never be
  // dressed up as "the AI is busy" with a local summary underneath it — that
  // hides the real problem and makes the fallback meaningless.
  ```

- **Catatan migrasi** : `public/stock-analysis-ai.js:164` sudah menangani 402 sejak PR #491. `portfolio-ai-runtime-v2.js` adalah satu-satunya permukaan AI yang tertinggal. Jadi memang ada celah migrasi seperti dugaan brief — hanya bukan berupa import yatim.
- **Perbaikan** : Tambah cabang `402` / `SUBSCRIPTION_REQUIRED` dan `ACCOUNT_NOT_APPROVED`, keduanya `fallback: false`.
- **Verifikasi** : test "a missing subscription is reported as itself, not as an AI outage" dan "session, quota and server-config failures never get a local summary".
- **Status** : DIPERBAIKI (PR #498)

---

## BUG-010

- **Severity** : LOW
- **Area** : AI-Portofolio (P2)
- **Lokasi** : `lib/context-ai-router-v7.js` — fallback lokal portofolio, sebelum perbaikan baris 259-260
- **Gejala** : Saat provider AI gagal, jawaban cadangan dari server menyebut jumlah posisi yang salah.
- **Root cause** : `` `Evaluasi Portofolio (${plans.length} posisi: ...)` `` memakai panjang daftar rincian yang sudah dipotong klien, bukan jumlah posisi sebenarnya.
- **Perbaikan** : Memakai `summary.plan_count` bila tersedia, dan menyebutkan berapa yang dirinci.
- **Status** : DIPERBAIKI (PR #498)

---

## Diperiksa dan bersih — otorisasi portofolio (tidak ada IDOR)

Brief meminta pengecekan IDOR ("user A bisa akses portofolio user B"). Sudah saya baca utuh dan **tidak ditemukan**:

- `lib/portfolio-state-handler.js:74-103` — `resolveAccount()` mengambil identitas hanya dari `requirePremiumEntitlement(req, supabase)`, lalu semua query memakai `.eq('user_id', account.id)` (baris 109, 141, 187, 201). Tidak ada satu pun id yang berasal dari body.
- `lib/subscription-auth.js:9-45` — identitas berasal dari sesi bertanda tangan (`requireAuthenticatedSession`), lalu dicocokkan ulang dengan baris `app_users` dan ditolak bila username tidak cocok.
- Penyimpanan memakai optimistic concurrency (`expected_updated_at`, baris 174-190), jadi dua perangkat tidak bisa saling menimpa diam-diam.
- `public/portfolio-ai-runtime-v2.js:69-74` memang mengirim header `X-User-Id` / `X-Username`, tetapi server tidak pernah membacanya untuk otorisasi. Ini header sisa yang tidak berbahaya — saya catat sebagai kebersihan kode, bukan kerentanan.

---

## BUG-011

- **Severity** : MEDIUM
- **Area** : Keamanan / UI (self-XSS persisten)
- **Lokasi** : `public/index.html` — `sanitizeAIHtml()`, sebelum perbaikan baris 10565-10566
- **Gejala** : Handler event inline lolos dari sanitizer dan **benar-benar dieksekusi** ketika hasil AI dipasang lewat `innerHTML`.
- **Root cause** : Kedua aturan penghapus handler mensyaratkan **spasi** sebelum nama handler:

  ```js
  output = output.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  output = output.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '');
  ```

  Tokenizer HTML lebih longgar: `/` sah sebagai pemisah atribut, dan sebuah atribut boleh dimulai persis setelah nilai berkutip. Terverifikasi di Chromium sungguhan pada origin http dengan gambar yang memang gagal dimuat:

  ```
  inert     <img src="/x.png" onerror=...>     (kasus yang memang tertangkap aturan lama)
  EXECUTED  <img/src="/x.png"/onerror=...>
  EXECUTED  <img src="/x.png"/onerror=...>
  EXECUTED  <img src="/x.png"onerror=...>
  ```

- **Jangkauan — saya sebutkan apa adanya, tidak dibesar-besarkan** : Sink-nya adalah balasan model AI itu sendiri, yang dirender dengan `innerHTML`, dan transkrip chat disimpan di `localStorage` lalu dirender ulang saat halaman dimuat. Pengguna yang mengarahkan model untuk menuliskan payload semacam itu mendapat eksekusi skrip **di sesinya sendiri**, dan berulang setiap reload.

  Saya mencari jalur lintas-pengguna dan **tidak menemukannya**: share mode merender baris screener, bukan HTML AI, dan `sanitizeAIHtml` hanya dipanggil atas keluaran AI milik pengguna yang sedang aktif. Jadi ini **self-XSS yang persisten, bukan lubang lintas-pengguna** — MEDIUM, bukan CRITICAL.

  Tetap penting: CSP aplikasi (`vercel.json`) hanya menyetel `base-uri`, `object-src`, dan `frame-ancestors`, **tanpa `script-src`**, jadi tidak ada lapisan lain yang menahan begitu sebuah handler lolos. Cookie sesi `HttpOnly` sehingga tidak bisa dibaca langsung, tetapi skrip yang tersuntik berjalan same-origin dan bisa memanggil `/api/*` sebagai pengguna itu.

- **Cacat kedua dari aturan yang sama (sudah ada sebelumnya)** : kedua aturan itu tidak dibatasi ke dalam tag, sehingga teks biasa ikut rusak:

  ```
  masuk  : <p>Strategi buy on weakness: onclick= bukan atribut di sini.</p>
  keluar : <p>Strategi buy on weakness: atribut di sini.</p>
  ```

  Saya verifikasi ini sudah terjadi sebelum perubahan saya, dengan menjalankan sanitizer yang belum diubah.

- **Perbaikan** : Mencocokkan **per tag**, menerima setiap pemisah yang diterima parser, dan tidak pernah menyentuh teks isi. Aturan baru menggantikan kedua aturan lama, jadi keduanya dihapus.
- **Verifikasi** : 15 payload di Chromium sungguhan (slash, double slash, kutip menempel untuk kedua jenis kutip, newline, tab, formfeed, nilai tanpa kutip, campuran huruf besar-kecil, serta handler pada `body`/`details`/`input`/`svg`) — **0 dari 15 dieksekusi**. `test/ai-html-sanitizer-event-handlers.test.js` mengunci ini, termasuk test penjaga yang memastikan kumpulan payload masih memuat kasus yang dilewatkan aturan lama.
- **Status** : DIPERBAIKI (PR #499)

---

## BUG-012

- **Severity** : LOW
- **Area** : Zona waktu / kuota
- **Lokasi** : `public/index.html:1887-1891` (`getWIBDateString`), dipakai di `:1979` (`getAIUsageKey`)
- **Gejala** : Kuota AI gratis untuk tamu (3 per hari WIB) me-reset pukul **17:00 WIB**, bukan tengah malam.
- **Root cause** : Offset dihitung dua kali:

  ```js
  var now = new Date();
  var wib = new Date(now.getTime() + (7 * 60 * 60 * 1000) - (now.getTimezoneOffset() * 60 * 1000));
  return wib.toISOString().slice(0, 10);
  ```

  `getTimezoneOffset()` untuk peramban di WIB bernilai `-420`, jadi `- (-420 * 60000)` menambah 7 jam **lagi** di atas 7 jam yang sudah ditambahkan. Totalnya `now + 14 jam`, lalu `toISOString()` (UTC). Yang benar cukup `now + 7 jam`.

  Terverifikasi:

  ```
  Waktu nyata            : 2026-09-03 18:00 WIB
  Browser di WIB (-420)  : 2026-09-04   <-- keliru, besok
  Browser di UTC (0)     : 2026-09-03
  Tanggal WIB yang benar : 2026-09-03
  ```

  Perhatikan bahwa rumus ini hanya benar untuk peramban yang berjalan di UTC — yaitu justru bukan pengguna Indonesia.

- **Dampak** : Terbatas. Nilai ini hanya membentuk kunci `localStorage` untuk kuota tamu 3/hari; bukan kontrol keamanan (gate premium ada di server). Efeknya tamu mendapat reset kuota gratis ~7 jam lebih awal setiap hari.
- **Perbaikan** : `getTime()` sudah berupa nilai epoch absolut yang tidak bergantung zona lokal, jadi cukup menggeser tepat +7 jam lalu membaca tanggal UTC-nya. Tanggal kini berganti tepat pukul 00:00 WIB (diverifikasi di 16:59:59Z dan 17:00:00Z).
- **Catatan tentang test-nya** : `test/wib-date-string.test.js` mensimulasikan peramban WIB (`getTimezoneOffset() = -420`), bukan mengandalkan zona mesin runner. Ini penting: **CI berjalan di UTC, di mana rumus lama justru menghasilkan jawaban yang benar** — test yang tidak memalsukan zona akan lolos terhadap bug ini dan tidak membuktikan apa pun. 4 dari 6 kasusnya gagal pada kode sebelum perbaikan.
- **Status** : DIPERBAIKI (PR #500)

---

## Diperiksa dan bersih — rahasia yang ter-commit

Brief meminta ini diperiksa. Hasil sapuan seluruh repo dan riwayat git:

- Tidak ada pola kunci API yang cocok (`AIza…`, `sk-…`, `ghp_…`, `xox[baprs]-…`, JWT, token bot Telegram `NNNNNNNN:AA…`) di file mana pun yang di-track.
- Tidak ada file `.env` yang pernah di-commit. Satu-satunya yang ada adalah `tools/streamlit_runner/.env.example`, dan isinya murni placeholder (`your-cron-secret-here`, `https://your-preview-url.vercel.app`) — tidak ada nilai asli.
- Tidak ada `process.env` di file mana pun di `public/`, jadi tidak ada rahasia yang bocor ke bundle klien.
- Tidak ada nilai literal panjang yang di-assign ke variabel bernama `API_KEY`/`SECRET`/`TOKEN`/`PASSWORD` di `public/`.

---

## BUG-013

- **Severity** : MEDIUM (lihat batasan dampaknya di bawah — saya sengaja tidak menaikkannya ke HIGH tanpa bisa memverifikasi kondisi database produksi)
- **Area** : Auth / Keamanan
- **Lokasi** : `api/review-access.js:39` (token default) dan `api/review-access.js:62` (hash password), plus `public/index.html:2161` dan `:2169`
- **Gejala** : Pengguna internet tanpa autentikasi berpotensi memperoleh **sesi login yang sah sebagai akun `review`**.
- **Root cause** : Dua rahasia berada di dalam kode sumber, dan **repositori ini publik** (dikonfirmasi lewat GitHub API: `"private": false`, `"visibility": "public"`).

  1. Token gerbang punya default yang tertulis di sumber:

     ```js
     const EXPECTED_TOKEN = process.env.REVIEW_ACCESS_TOKEN || 'autocuan-review-2026';
     ```

     Nilai yang sama juga tertulis dua kali di `public/index.html`, jadi bahkan tanpa membaca repo, siapa pun yang membuka halaman bisa membacanya.

  2. Hash password akun `review` ditulis langsung di sumber:

     ```js
     const REVIEW_PASSWORD_HASH = '42f38b0fcf1e35d9d2f82c462376f33145d1f450aeb216900db3356338686f2b';
     ```

     Komentar di atasnya menyatakan plaintext-nya sengaja tidak dicatat. Masalahnya, **peramban melakukan hashing di sisi klien** (`public/index.html:1872` `hashPassword()`), dan `/api/login-user` menerima `passwordHash` itu apa adanya. Untuk baris berformat lama, `lib/password-credential.js:69-72` membandingkan hash tersimpan dengan hash yang dikirim klien secara langsung. Jadi untuk baris format lama, **hash itu sendiri adalah kredensialnya** — plaintext tidak diperlukan.

- **Rantai eksploitasi** :
  1. `POST /api/review-access` dengan `{"token":"autocuan-review-2026"}` — menyemai baris `app_users` bernama `review` dengan `password_hash` format lama di atas.
  2. `POST /api/login-user` dengan `{"username":"review","passwordHash":"42f38b0f…","deviceId":"apa saja"}`. Klien non-peramban (mis. curl) tidak mengirim header `Origin` maupun `Referer`, dan `lib/admin-session.js:169` memang mengembalikan `true` bila tidak ada sinyal lintas-origin — jadi gerbang same-origin terlewati.
  3. `api/login-user.js:455` melewati gerbang approval khusus untuk `review`, lalu cabang di `:485` menerbitkan cookie sesi.
  4. Penyerang memegang `ac_sess` yang sah sebagai `review`.

- **Yang MEMBATASI dampaknya — saya sebutkan supaya tidak berlebihan** :
  - `lib/entitlements.js` **tidak** memberi `review` status premium. Tanpa baris `user_entitlements` aktif, ia `free`. Jadi `/api/analyze` (butuh premium) dan state portofolio tetap tertutup.
  - Ini bukan akses admin: `requireBudiAdmin` mensyaratkan username `budi`.
  - Ini tidak membuka data pengguna lain.
  - Yang terbuka adalah endpoint yang hanya butuh sesi terautentikasi, misalnya `api/quote.js:78`.
  - **Mitigasi penting**: login legacy yang berhasil memicu migrasi kredensial (`api/login-user.js:426-438`) ke format scrypt `k1…`. Setelah itu hash yang dipublikasikan **tidak lagi bisa dipakai** — penyerang butuh plaintext-nya. Jadi jendela serangan hanya terbuka selama baris `review` masih berformat lama.

- **Yang TIDAK bisa saya verifikasi** : kondisi baris `review` di database produksi saat ini (sudah bermigrasi atau belum), dan apakah `REVIEW_ACCESS_TOKEN` sudah diset di Vercel sehingga default di sumber tidak terpakai. Keduanya butuh akses yang tidak saya miliki. Karena itu saya tidak menaikkan severity ke HIGH, dan tidak menyatakan ini "pasti bisa dieksploitasi sekarang".
- **Perbaikan yang diusulkan** (belum dieksekusi — mengubah perilaku auth, jadi menunggu keputusan pemilik):
  1. Hapus hash password dari sumber; ambil dari environment, gagal-tertutup bila tidak diset.
  2. Hapus default `'autocuan-review-2026'`; wajibkan `REVIEW_ACCESS_TOKEN`, gagal-tertutup bila kosong.
  3. Rotasi password akun `review` terlepas dari apa pun, karena nilai setara-kredensialnya sudah publik.
- **Risiko perbaikan** : membuat gerbang gagal-tertutup akan **mematikan mode review** sampai variabel environment diset di Vercel. Itu bisa memutus alur peninjauan app-store, jadi bukan keputusan yang boleh saya ambil sendiri.
- **Status** : DITEMUKAN — menunggu keputusan

---

## BUG-014

- **Severity** : LOW (laten — lihat bagian "yang menutupinya"; saya sengaja tidak menaikkannya karena tidak bisa menunjukkan kasus hidup)
- **Area** : Screener / gate
- **Lokasi** : `lib/daytrade-screener-engine.js:229-230` (produsen) vs `lib/idx-tick-normalization.js:1081` dan `:1091` (gate)
- **Gejala** : Dua modul tidak sepakat soal nilai penanda untuk "rasio volume tidak diketahui". Produsen memakai `0`; gate ditulis dengan asumsi `null`.
- **Root cause** : Produsen menggabungkan "tidak diketahui" menjadi `0`:

  ```js
  var vol20 = calcMA(volumes, 20);                      // null bila < 20 candle
  var avg_volume_20d = (vol20 && Number.isFinite(vol20) && vol20 > 0) ? round0(vol20) : 0;
  var volume_ratio_20d = (avg_volume_20d > 0 && Number.isFinite(volume_today / avg_volume_20d)) ? round2(volume_today / avg_volume_20d) : 0;
  ```

  Sementara gate secara eksplisit membedakan "tidak diketahui" dari sebuah angka:

  ```js
  var isA = ... && (p.volume_ratio_20d == null || toNum(p.volume_ratio_20d, 0) >= 0.8);
  ...
  if (p.volume_ratio_20d != null && toNum(p.volume_ratio_20d, 0) < 0.8) bReason.push('volume kurang');
  ```

  Klausa `p.volume_ratio_20d == null ||` jelas ditulis supaya kasus "tidak diketahui" **tidak** dihukum. Nilai `0` dari produsen tidak akan pernah memenuhi `>= 0.8`, jadi kandidat itu turun dari grade A dan diberi label "volume kurang".

  Instance kedua yang saya temukan kemudian, di dalam **satu file yang sama**: `api/quote.js:406` menulis `quoteResult.volumeVsAvg20 || 0` (runtuh menjadi 0) sementara `api/quote.js:442` — 36 baris di bawahnya — meneruskan `quoteResult.volumeVsAvg20` apa adanya ke `calculateRiskLabel()` (mempertahankan `null`). Jadi dua pemanggil bersebelahan di file yang sama memperlakukan penanda ini secara berbeda.

  Modul saudaranya melakukan hal yang benar — `lib/analyze-legacy.js:1398` mengembalikan `null`:

  ```js
  var volumeVsAvg20 = volAvg20 > 0 ? Math.round((candles[lastIdx].volume / volAvg20) * 100) / 100 : null;
  ```

  Jadi ketidakkonsistenan ini nyata di dalam repo, bukan tafsiran saya.

- **Yang menutupinya (dan kenapa saya beri LOW, bukan HIGH)** : Kasus "rata-rata tidak diketahui" hanya terjadi bila candle < 20, dan kondisi itu sudah ditandai `SHORT_HISTORY` oleh `deriveDataQualityStatus` (`lib/daytrade-screener-engine.js:56-58`). `SHORT_HISTORY` termasuk status yang **mengeluarkan kandidat dari produksi** (`lib/intraday-production-eligibility.js:28-35`). Jadi jalur yang saya khawatirkan sudah tersaring lebih dulu oleh filter lain.

  Sisa ambiguitasnya: `volume_ratio_20d === 0` juga bisa berarti "hari ini benar-benar nol volume padahal rata-ratanya diketahui" — dan dalam kasus itu `0` memang benar dan gate memang seharusnya menghukumnya. Satu nilai memikul dua arti yang berbeda.

- **Yang TIDAK bisa saya buktikan** : sebuah kasus hidup di produksi di mana kandidat `SHORT_HISTORY` benar-benar sampai ke fungsi grading. Karena itu saya laporkan sebagai **laten**, bukan bug yang sedang menggigit.
- **Perbaikan yang diusulkan** : samakan penanda — produsen mengembalikan `null` saat rata-rata tidak diketahui, seperti yang sudah dilakukan `analyze-legacy.js`. **Belum dieksekusi**: ini menyentuh gate/grading, dan aturan Anda meminta saya bertanya dulu sebelum mengubah perilaku bisnis.
- **Status** : DITEMUKAN — menunggu keputusan

---

## BUG-015

- **Severity** : MEDIUM
- **Area** : Indikator / Screener
- **Lokasi** : `api/quote.js:1466`, `api/candles.js:292`, `lib/daytrade-screener-engine.js:2069`, `lib/analyze-legacy.js:1394`, `api/sector-hot.js:2872`, `api/sector-hot.js:10895` — enam salinan. Yang **benar** ada di `lib/daily-rsi.js:70-75`.
- **Gejala** : Saham dengan 14 hari harga penutupan yang sama persis (disuspensi, atau counter sangat tidak likuid) dilaporkan **RSI = 100** — "sangat overbought" — padahal harganya tidak bergerak sama sekali.
- **Root cause** : Enam implementasi hanya menjaga pembagian nol, tanpa membedakan "tidak ada pergerakan" dari "hanya naik":

  ```js
  if (avgLoss === 0) return 100;
  ```

  Ketika seri datar, `avgGain` **dan** `avgLoss` sama-sama 0. Rasionya `0/0` — tidak terdefinisi. Konvensinya (dan jawaban yang sudah dipakai repo ini sendiri) adalah 50.

  `lib/daily-rsi.js:70-75` sudah melakukannya dengan benar:

  ```js
  function rsiFromAverages(avgGain, avgLoss) {
    if (avgGain === 0 && avgLoss === 0) return 50;
    if (avgLoss === 0) return 100;
    ...
  }
  ```

  Jadi ini bukan pendapat saya tentang RSI "seharusnya" berapa — repo ini sudah memuat jawaban yang benar di satu tempat, dan enam salinan lain kehilangan penjagaannya.

- **Bukti reproduksi** (menjalankan fungsi aslinya, bukan membaca saja):

  ```
  seri                        quote.js  candles.js  screener-engine   lib/daily-rsi.js
  datar (15 x 1000)           100       100         100               50
  uptrend (1000..1140)        100       100         100               100
  ```

  Perhatikan barisnya: pada tiga implementasi itu, **seri datar tidak bisa dibedakan dari tren naik terkuat yang mungkin**.

- **Dampak** : `rsi14` masuk ke `calculateRiskLabel()` (`api/quote.js:445`) dan ke mesin screener, jadi angka ini ikut menentukan label risiko dan penyaringan. Saham beku dilaporkan sebagai overbought ekstrem.
- **Perbaikan yang diusulkan** : samakan keenam salinan dengan `lib/daily-rsi.js` — tambahkan `if (avgGain === 0 && avgLoss === 0) return 50;` sebelum penjagaan yang ada. Idealnya keenamnya memanggil satu implementasi bersama, tapi itu refactor; perbaikan minimalnya satu baris per lokasi.
- **Risiko** : mengubah nilai indikator, sehingga mengubah keluaran gate/risk label untuk kasus datar. **Belum dieksekusi** — aturan Anda meminta saya bertanya dulu sebelum mengubah perilaku bisnis.
- **Status** : DITEMUKAN — menunggu keputusan

---

## Catatan tambahan pada BUG-005 (fetch tanpa timeout) — instance baru di `api/quote.js`

Saat membaca `api/quote.js` saya menemukan pola yang sama seperti BUG-005, di file yang berbeda:

| fungsi | baris | timeout? |
|---|---|---|
| `fetchFreshScreenerLatestPrice` | `api/quote.js:109` | tidak ada |
| `fetchBoardData` | `api/quote.js:666` | tidak ada |
| `getCachedNews` | `api/quote.js:1067` | tidak ada |
| `saveCachedNews` | `api/quote.js:1115` | tidak ada |
| `fetchYahooQuote` | `api/quote.js:488` | ada, 8 detik |
| `fetchNewsFromCodeCrafters` | `api/quote.js:1020` | ada, 20 detik |
| `fetchNewsFromGemini` | `api/quote.js:1176` | ada, 20 detik |

Keempat yang tanpa timeout semuanya menuju Supabase REST. `api/quote.js` tidak punya entri `maxDuration` di `vercel.json`, jadi ia memakai batas default platform. Belum saya perbaiki — bukan kelompok masalah yang sama dengan PR yang sedang terbuka, dan saya ingin menggabungkannya dengan sisa audit `api/quote.js` yang belum selesai dibaca.

---

## Modul Bersih (sudah diperiksa, tidak ditemukan bug)

### Hipotesis "import yatim ke modul AI yang dihapus" — TIDAK TERBUKTI

Brief audit mencurigai adanya sisa import ke `lib/portfolio-ai.js`,
`lib/context-ai-router.js`, `-v2`, `-v3` setelah PR #434. Saya sapu seluruh repo
(`*.js`, `*.json`, `*.html`, `*.yml`, `*.md`, `*.sh`, di luar `node_modules`):

- **Tidak ada** satu pun `require()` atau import dinamis ke `lib/portfolio-ai`,
  `lib/context-ai-router` (tanpa suffix), `-v2`, atau `-v3`.
- Semua kecocokan string `portfolio-ai` menunjuk ke file **frontend yang ada**:
  `public/portfolio-ai-runtime-v2.js`, `public/portfolio-ai-workspace-v1.js`,
  `public/portfolio-ai-workspace-v1.css`. Bukan modul server yang dihapus.

Koreksi atas asumsi di brief: `lib/context-ai-router-v4.js`, `-v5.js`, dan `-v6.js`
**masih ada dan masih hidup**, bukan kode mati. Mereka membentuk rantai delegasi:

```
api/analyze.js:4          require('../lib/context-ai-router-v7')
lib/context-ai-router-v7.js:14   require('./context-ai-router-v6')
lib/context-ai-router-v6.js:15   require('./context-ai-router-v5')
lib/context-ai-router-v5.js      delegasi ke v4 (lihat komentar lib/context-ai-router-v4.js:257)
```

Jadi menghapus v4/v5/v6 akan merusak runtime. Ini dicatat supaya tidak ada yang
"membersihkan" file itu dengan asumsi keliru.

### Perlu diperiksa lebih lanjut (belum pasti)

`tools/apply-production-hotfixes.js:349` dan `test/approved-website-access-shell.test.js:22`
menyebut `public/portfolio-ai-recovery.js`, dan file itu **tidak ada** di repo. Build
tetap hijau, jadi kemungkinan besar keduanya menanganinya sebagai opsional — tetapi
saya belum membaca kedua file itu utuh, jadi belum bisa saya sebut aman maupun bug.

---

## BUG-016 — Rentang entry ditampilkan terbalik (tinggi→rendah) di Track Record & CSV

- **Severity** : LOW (kosmetik / keterbacaan, tidak menyentuh logika trading)
- **Area** : Track Record (frontend + kontrak data)
- **Lokasi** : `public/track-record-runtime.js:172-173`, `public/track-record-runtime.js:239`

**Gejala.** Kolom Entry di tabel Track Record dan di ekspor CSV menampilkan rentang
yang menurun, mis. `Rp 1.250–Rp 1.200`, bukan `Rp 1.200–Rp 1.250`.

**Kode asli.**

```js
// public/track-record-runtime.js:172-173
var entryText = s.entry1 ? formatRp(s.entry1) : '—';
if (s.entry2 && s.entry2 !== s.entry1) entryText += '–' + formatRp(s.entry2);
```

```js
// public/track-record-runtime.js:239
entryVal = (s.entry2 != null && s.entry2 !== s.entry1) ? (s.entry1 + '-' + s.entry2) : String(s.entry1);
```

**Root cause.** Di dalam tabel `telegram_daily_picks`, `entry1` adalah batas **atas**
dan `entry2` adalah batas **bawah**. Ketiga penulis tabel itu konsisten:

| penulis | baris | pemetaan |
|---|---|---|
| `api/sector-hot.js` (register plan terkunci) | `7136-7137` | `entry1: identity.entry_high, entry2: identity.entry_low` |
| `api/sector-hot.js` (`dailyPickInsertRowFromCandidate` ← `normalizeCombinedCandidate`) | `6997`, `5108-5109` | `entry1 = getEntry1(r)` → `entry_high`; `entry2 = getEntry2(r)` → `entry_low` |
| `lib/intraday-fast-watcher-publisher.js` | `211-212` | `entry1: entryHigh …, entry2: entryLow …` |

Konvensi itu dinyatakan eksplisit di `api/sector-hot.js:3519-3520`:

```js
r.entry1 = high; // conservative representative for upside calculation
r.entry2 = low;
```

dan di `api/sector-hot.js:3554`:

```js
if (high != null && high > 0) return high; // conservative entry reference for TP1 upside
```

Rantai datanya utuh dan sudah saya telusuri sampai ujung:
`telegram_daily_picks` → `api/sector-hot.js:8005` (`select('*')`) →
`lib/track-record-service.js:203-204` (diteruskan apa adanya:
`entry1: normalizeNumber(row.entry1), entry2: normalizeNumber(row.entry2)`) →
`public/track-record-runtime.js:172`. Tidak ada tahap yang menukar urutannya.

Jadi sisi data benar; yang salah hanya sisi tampilan, yang merangkai `entry1` lalu
`entry2` dengan tanda en-dash sehingga terbaca sebagai rentang naik padahal isinya
turun.

**Dampak.** Pengguna membaca "Entry 1.250–1.200" sebagai rentang yang keliru arah.
Tidak ada gate, ranking, atau perhitungan yang memakai string ini — murni tampilan
dan ekspor CSV.

**Perbaikan yang diusulkan.** Urutkan pada saat render, jangan sentuh data:
tampilkan `min(entry1, entry2)` lalu `max(entry1, entry2)`. Ini tidak mengubah
formula bisnis apa pun (bukan perubahan strategi), jadi tidak masuk aturan No. 8.

**Risiko.** Sangat rendah — hanya urutan dua angka pada satu string tampilan dan
satu kolom CSV. Rollback = revert satu commit.

**Verifikasi.** `test/track-record-entry-range-order.test.js` — 12 test. 11 gagal
terhadap file sebelum patch; yang ke-12 sengaja lolos di kedua sisi sebagai penjaga
bahwa perbaikannya *mengurutkan*, bukan *menukar buta*. Suite penuh 320/320 lolos.

Catatan kenapa ini lolos selama ini: fixture di `test/track-record-csv.test.js:62-63`
memakai `entry1: 4500, entry2: 4550` — menaik, kebalikan dari bentuk yang sebenarnya
ditulis produksi. Test itu tidak pernah melihat kasusnya. Suite tersebut tetap lolos
tanpa saya ubah (13/13).

**Status** : DIPERBAIKI — PR #503 (`fix/track-record-entry-range-order`), draft

---

## BUG-017 — `summary` Track Record tidak dihitung ulang setelah filter kategori

- **Severity** : LOW (laten — jalur ini belum dipakai frontend)
- **Area** : API Track Record
- **Lokasi** : `api/sector-hot.js:8022-8030`

**Kode asli.**

```js
var rows = q.data || [];
var result = trackRecordService.buildTrackRecordData(rows);

if (categoryFilter && categoryFilter !== 'all') {
  var cf = String(categoryFilter).toLowerCase();
  result.signals = result.signals.filter(function(s) {
    return s.source === cf || String(s.category).toLowerCase().indexOf(cf) >= 0;
  });
}

return res.status(200).json(result);
```

**Root cause.** `buildTrackRecordData(rows)` menghitung `result.summary`
(`total_signals`, `win_rate_tp1`, `sl_rate`, `resolved_win_rate`, dst.) atas
**seluruh** baris. Filter kategori lalu dipasang hanya pada `result.signals`.
`result.summary` dikirim apa adanya, jadi respons untuk
`?action=track-record&category=day-trade` berisi daftar sinyal satu kategori tetapi
angka ringkasan seluruh kategori.

**Dampak.** Pemanggil yang memakai parameter kategori akan menampilkan win-rate yang
tidak sesuai daftar yang ditampilkan di sebelahnya.

**Batas jangkauan — penting, jangan dilebihkan.** Frontend tidak pernah mengirim
parameter itu. Satu-satunya pemanggil endpoint ini adalah
`public/track-record-runtime.js:32`:

```js
var res = await fetch('/api/sector-hot?action=track-record');
```

tanpa `category` maupun `source`. UI **memang punya** filter kategori
(`public/index.html:1203-1209`, tab `#trCategoryTabs`), tetapi filter itu dikerjakan
sepenuhnya di sisi klien atas array `signals` yang sudah diterima
(`public/track-record-runtime.js:140-152`) — bukan dengan memanggil ulang API.
Jadi cabang filter di server itu **tidak pernah dieksekusi di produksi saat ini**:
kode mati yang akan menjadi bug begitu ada pemanggil yang memakai parameternya.
`result.by_category` sendiri sudah per kategori, jadi yang keliru hanya `summary`.

**Perbaikan yang diusulkan.** Saring `rows` **sebelum** memanggil
`buildTrackRecordData`, bukan menyaring hasilnya. Dengan begitu `summary` dan
`by_category` otomatis konsisten dengan daftar sinyal.

**Risiko.** Rendah. Karena jalurnya belum dipakai, perubahan tidak mengubah respons
yang beredar sekarang (tanpa parameter kategori hasilnya identik).

**Verifikasi.** Test yang memanggil handler dengan `category` terisi dan memeriksa
`summary.total_signals === signals.length`.

**Status** : DITEMUKAN — belum diperbaiki

---

## BUG-018 — Tiga `fetch` upstream tanpa timeout di `api/sector-hot.js`

- **Severity** : MEDIUM
- **Area** : Screener (AI confirmation + pengambilan candle/quote Yahoo)
- **Lokasi** : `api/sector-hot.js:2088`, `api/sector-hot.js:2310`, `api/sector-hot.js:2348`

Ini instance baru dari kelompok yang sama dengan BUG-005 (`lib/analyze-legacy.js`,
sudah diperbaiki di PR #497) dan catatan tambahan di `api/quote.js`.

**Kode asli.**

```js
// api/sector-hot.js:2088 — callAIConfirmation
var response = await fetch(baseUrl + '/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
  body: JSON.stringify({ ... })
});
```

```js
// api/sector-hot.js:2310 — fetchScreenerCandles
var response = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});
```

```js
// api/sector-hot.js:2348 — fetchYahooQuote
var response = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});
```

**Root cause.** Tidak ada `AbortController`, tidak ada `signal`, tidak ada
`AbortSignal.timeout`. `fetch` Node/undici tidak punya batas waktu bawaan untuk
respons yang menggantung; koneksi yang diterima lalu diam akan ditunggu sampai
fungsi serverless-nya sendiri yang dimatikan platform.

**Dampak.** `fetchScreenerCandles` dan `fetchYahooQuote` dipanggil per-ticker di
dalam loop screener. Satu upstream yang menggantung menghabiskan sisa anggaran waktu
fungsi, sehingga seluruh run screener gagal — bukan hanya ticker itu. Karena
`callAIConfirmation` sudah menangkap semua error dan mengembalikan
`{ data: [], diagnostic: ... }`, kegagalannya tenang: hasil AI kosong tanpa jejak
penyebab yang jelas.

**Perbaikan yang diusulkan.** Pakai pola yang sama dengan yang sudah dipasang di
`lib/analyze-legacy.js` pada PR #497: pembungkus `fetchWithTimeout(url, options, ms)`
berbasis `AbortController`, dengan batas yang cukup longgar (Yahoo ~10 detik, AI
~20 detik) supaya tidak memotong panggilan yang sehat.

**Risiko.** Rendah, tapi bukan nol: batas yang terlalu ketat akan menolak upstream
yang lambat-tapi-normal. Karena itu batasnya diambil longgar dan kegagalan tetap
jatuh ke jalur `return null` / `data: []` yang sudah ada — tidak ada perilaku baru.
Rollback = revert satu commit.

**Verifikasi.** `test/sector-hot-upstream-timeout.test.js` — 9 test, dua lapis:
perilaku (abort dibuktikan terhadap server HTTP lokal sungguhan yang menerima koneksi
lalu tidak pernah membalas — tanpa mocking `fetch`) dan wiring (memindai sumber dan
menolak setiap `await fetch(` yang tidak membawa `signal`, sehingga `fetch` telanjang
tidak bisa diselundupkan kembali). 9/9 gagal sebelum patch, 9/9 lolos sesudahnya.
Suite penuh 320/320 lolos.

Batas yang dipakai: Yahoo 12 detik, AI 20 detik — keduanya **lebih longgar** dari
yang sudah terbukti jalan di produksi pada host yang sama (`api/quote.js:488` = 8
detik; `fetchLatestPriceForMonitor` = 10 detik; `fetchNkQuoteData` = 5 detik).

**Status** : DIPERBAIKI — PR #502 (`fix/sector-hot-upstream-timeouts`), draft

Sisa keluarga yang sama dan **belum** disentuh: empat `fetch` ke Supabase REST di
`api/quote.js` (lihat catatan tambahan BUG-005 di atas).

---

## Catatan laten pada `api/sector-hot.js:4024-4025` — fallback alias entry tertukar

Bukan bug aktif, tapi saya catat karena mudah berubah jadi bug.

```js
// api/sector-hot.js:4024-4025
var entryLow  = toNum(r.entry_low  || r.entry1 || r.entry_1);
var entryHigh = toNum(r.entry_high || r.entry2 || r.entry_2 || entryLow);
```

Di file yang sama, `entry1` adalah batas **atas** dan `entry2` batas **bawah**
(`api/sector-hot.js:3519-3520`). Jadi kedua fallback itu **tertukar**: kalau
`entry_low`/`entry_high` tidak ada, `entryLow` akan menerima nilai tertinggi dan
`entryHigh` nilai terendah.

**Kenapa saya tidak menaikkannya jadi bug aktif.** Saya telusuri semua pemanggil
`deriveRiskReasonDetails` — satu-satunya adalah `enrichSignalQuality`
(`api/sector-hot.js:4074`), dan di sana `deriveConfidenceTier` → `getEntry1` →
`normalizeCandidateEntryAliases` sudah mengisi `r.entry_low` dan `r.entry_high`
lebih dulu (`api/sector-hot.js:3517-3518`) untuk setiap baris yang punya rentang.
Semua sumber baris yang saya telusuri (`daytrade_screener_latest`,
`swing_screener_latest`, `swing_screener_non_konglo_latest`) punya kolom
`entry_low`/`entry_high`. Jadi cabang fallback itu tidak pernah dieksekusi pada
jalur mana pun yang saya baca.

**Rekomendasi** (bukan perbaikan yang saya jalankan sekarang): tukar kedua fallback
agar sesuai konvensi file, atau — lebih tahan lama — pakai `Math.min`/`Math.max`
seperti yang sudah dilakukan `api/sector-hot.js:6707-6708`.

---

## Catatan tambahan pada BUG-015 (RSI 0/0) — salinan di `api/sector-hot.js`

```js
// api/sector-hot.js:3358-3363 — calcScreenerRSI
var avgGain = gains / period;
var avgLoss = losses / period;
if (avgLoss === 0) return 100;
var rs = avgGain / avgLoss;
return 100 - (100 / (1 + rs));
```

Pola yang sama dengan BUG-015: seri harga yang benar-benar datar (semua `diff === 0`,
jadi `avgGain === 0 && avgLoss === 0`) dilaporkan sebagai RSI 100. Masuk ke keluarga
BUG-015 dan menunggu keputusan yang sama, bukan temuan terpisah.


---

## Observasi (bukan bug) — hasil pemeriksaan `public/track-record-runtime.js`

File ini saya baca utuh, baris 1 sampai 308. Tiga hal saya periksa khusus dan
**tidak** saya naikkan menjadi bug, dengan alasannya masing-masing.

### 1. Kartu ringkasan tidak ikut berubah saat tab kategori diklik — ini disengaja

`filterTrackRecordCategory()` (`public/track-record-runtime.js:115-128`) hanya
memanggil `renderTrackRecordTable()`, jadi keempat kartu ringkasan di atas
(Total Sinyal / Win Rate TP1 / Target Maks TP2 / SL Hit Rate) tetap menampilkan
angka seluruh kategori.

Sempat saya curigai sebagai bug pelaporan. Setelah membaca markup-nya
(`public/index.html:1148-1210`) saya batalkan: tata letaknya menempatkan kartu
ringkasan global lebih dulu, lalu **bagian tersendiri berjudul "Performa Per
Kategori"** yang memang sudah memecah angka per kategori
(`public/track-record-runtime.js:102-105`), dan baru setelah itu Filter Bar berisi
tab kategori, filter status, dan kotak pencarian. Tab itu berada di dalam filter bar
milik tabel, sejajar dengan filter status dan pencarian yang juga hanya memengaruhi
tabel. Jadi ringkasan global yang tetap global adalah perilaku yang konsisten dengan
rancangannya, bukan cacat.

### 2. Tombol "Unduh CSV" mengekspor seluruh data, bukan yang sedang difilter — belum pasti

```js
// public/track-record-runtime.js:274
var csvContent = generateTrackRecordCsv(_trData.signals);
```

`_trData.signals` adalah himpunan penuh; tabel menampilkan `filtered`
(`public/track-record-runtime.js:140-152`). Jadi setelah memfilter ke satu kategori
atau satu status, CSV yang terunduh tetap berisi semua baris.

**Saya belum bisa menyebut ini bug.** Tombolnya duduk di header seksi
(`public/index.html:1137`), sebaris dengan "Muat Ulang", **di atas** kartu ringkasan
dan di atas filter bar — bukan di dekat tabel. Judulnya "Export data track record ke
CSV", bukan "ekspor tampilan ini". Penempatan dan labelnya sama-sama mendukung
pembacaan "unduh seluruh track record". Ini keputusan produk, bukan bug yang bisa
saya putuskan sendiri: kalau yang diinginkan adalah "ekspor sesuai filter", perbaikannya
sepele (ekstrak logika filter dari `renderTrackRecordTable` lalu pakai di kedua
tempat). Saya menunggu keputusan Anda dan tidak mengubah apa pun.

### 3. `escapeCsvCell` tidak menetralkan formula — pengerasan, bukan kerentanan aktif

```js
// public/track-record-runtime.js:218-225
function escapeCsvCell(val) {
    if (val == null) return '';
    var str = String(val);
    if (str.search(/([",\n\r])/g) !== -1) {
        str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}
```

Pengutipan RFC-4180-nya benar (tanda kutip digandakan, sel yang mengandung
`"` `,` CR/LF dikutip). Yang tidak ditangani adalah *CSV formula injection*: sel yang
diawali `=`, `+`, `-`, `@`, TAB, atau CR akan dieksekusi sebagai rumus oleh
Excel/Google Sheets.

**Saya telusuri kesebelas kolomnya dan tidak menemukan sel yang bisa dikendalikan
penyerang**: tanggal dan angka dibentuk oleh kode, `status_label`/`source_label`/
`outcome` berasal dari himpunan konstanta di `lib/track-record-service.js`,
`duration_text` dibangkitkan `formatDuration`. Satu-satunya yang berpotensi diawali
tanda adalah `gainVal` (`+12.3%` / `-8.1%`), dan itu dibentuk dari angka hasil
hitungan, bukan dari masukan.

Yang **belum bisa saya pastikan** adalah `s.ticker`: nilainya berasal dari kolom DB.
Sebagian besar penulis menormalkannya lewat `normalizeForeignTicker`
(`api/sector-hot.js:3400`, pola `^[A-Z0-9]{2,12}$`), tetapi saya belum membaca
seluruh penulis `telegram_daily_picks` sampai tuntas, jadi saya belum bisa menyatakan
setiap baris ticker pasti tersaring. Karena itu ini saya catat sebagai rekomendasi
pengerasan (awali sel yang dimulai `= + - @` dengan `'`), bukan temuan kerentanan.

---

## BUG-019 — Diagnostik gate Top 5 melaporkan "unknown" untuk dua penyebab penolakan yang nyata

- **Severity** : LOW (hanya diagnostik — tidak mengubah gate)
- **Area** : Telegram Top 5 / diagnostik dry-run
- **Lokasi** : `api/sector-hot.js:4676` (`diagnosePublicSafetyGateRejection`) vs `api/sector-hot.js:4410` (`candidatePassesPublicTelegramSafetyGate`)

**Gejala.** Saat Top 5 kosong dan Anda menjalankan dry-run untuk mencari tahu
sebabnya, sebagian kandidat dilaporkan sebagai:

```
category: 'unknown'
detailed_reason: 'No specific rejection identified (possible logic mismatch)'
```

padahal gate-nya punya alasan yang jelas.

**Root cause.** `diagnosePublicSafetyGateRejection` adalah salinan manual dari
seluruh rantai kondisi di `candidatePassesPublicTelegramSafetyGate`. Dua kondisi
ada di gate tetapi **tidak ikut disalin** ke diagnostiknya:

| kondisi | ada di gate | ada di diagnostik |
|---|---|---|
| `corporateActionGuard.applyCorporateActionPriceScaleGuard()` + `corporate_action_guard === 'BLOCKED'` | ya (`:4411-4413`) | **tidak** |
| `productionEligibility.classifyProductionEligibility(candidate).eligible` | ya (`:4523`) | **tidak** |

Dihitung langsung atas rentang barisnya:

```
gate      (4410-4675) : corporate_action_guard = 2 kemunculan, classifyProductionEligibility = 1
diagnostik(4676-4840) : corporate_action_guard = 0 kemunculan, classifyProductionEligibility = 0
```

Diagnostiknya memang memeriksa `isDataQualityRiskStatus(dataQualityStatus)`, yang
**bertumpang tindih sebagian** dengan `classifyProductionEligibility` tapi bukan
panggilan yang sama — jadi kandidat yang ditolak oleh kebijakan bersama itu lewat
tanpa terdeteksi diagnostiknya, lalu jatuh ke cabang terakhir `'unknown'`.

**Dampak.** Terbatas dan tidak menyentuh sinyal yang dipublikasikan: fungsi ini
dipanggil hanya di tiga tempat (`:6151`, `:6177`, `:6216`), semuanya jalur
diagnostik, dan komentarnya sendiri sudah menyatakan *"Does NOT change gating
behavior. Only used for dry_run/manual diagnostics"*. Yang rusak adalah **jalur
penelusurannya**: justru saat Anda paling butuh tahu kenapa Top 5 kosong, dua
penyebab nyata dilaporkan sebagai "tidak diketahui".

Perlu dicatat bahwa penulisnya sudah mengantisipasi ini — string cadangannya
berbunyi *"possible logic mismatch"*.

**Perbaikan yang diusulkan (minimal).** Tambahkan kedua pemeriksaan itu ke
`diagnosePublicSafetyGateRejection` **pada urutan yang sama** dengan gate, sehingga
kategori yang dilaporkan sama dengan alasan yang benar-benar menolak lebih dulu.
Perubahan ini murni aditif pada string diagnostik dan tidak bisa menyentuh gate.

**Utang teknis (tidak saya eksekusi — aturan No. 7).** Akar masalahnya bukan dua
kondisi yang terlewat, melainkan dua fungsi ~250 baris yang menyalin ~20 kondisi
yang sama secara manual dan pasti akan menyimpang lagi. Perbaikan yang tahan lama:
satu daftar aturan berurutan `[{ id, test, reason }]` yang dipakai gate (ambil
`.some()`) dan diagnostik (ambil yang pertama cocok). Itu refactor, bukan bug fix,
jadi saya catat sebagai rekomendasi.

**Risiko.** Sangat rendah untuk perbaikan minimalnya — tidak ada gate yang berubah,
hanya string kategori pada keluaran dry-run.

**Verifikasi.** Test yang memberi kandidat dengan `corporate_action_guard = 'BLOCKED'`
dan kandidat yang gagal `classifyProductionEligibility`, lalu memastikan gate menolak
**dan** diagnostiknya tidak lagi mengembalikan `'unknown'`.

**Status** : DITEMUKAN — belum diperbaiki. Saya sengaja belum membuat PR untuk ini:
nilainya rendah dibanding melanjutkan pembacaan, dan sudah ada sembilan PR terbuka.
Katakan saja kalau Anda mau ini dikerjakan sekarang.

---

## Modul bersih tambahan — gate keselamatan publik `api/sector-hot.js:4285-5085`

Rentang ini saya baca utuh dan **bersih**. Yang diperiksa khusus:

- **Arah kegagalan.** Seluruh gate (`candidatePassesPublicTelegramSafetyGate`,
  `candidatePassesTop5WatchlistGate`, `candidateTelegramEligible`) gagal **tertutup**:
  field yang hilang, grade kosong, atau plan tidak lengkap menghasilkan `return false`,
  bukan lolos. Contoh: `candidatePassesTop5WatchlistGate:5041` menolak grade kosong
  karena `''` tidak lolos cek `A`/`B`/`A+` maupun cabang `C`.

- **Prototype pollution pada lookup objek.** Ada belasan pola
  `{ CHASE_RISK: true, EXTENDED: true, ... }[status]` yang memakai objek literal
  sebagai himpunan. Pola ini biasanya rawan (`status = '__proto__'` atau
  `'constructor'` mengembalikan nilai truthy dari prototipe). Di sini **tidak
  terjangkau**: setiap kunci himpunannya HURUF BESAR dan setiap nilai yang dicari
  di-`.toUpperCase()` lebih dulu, sedangkan seluruh nama properti prototipe
  (`__proto__`, `constructor`, `toString`, `valueOf`, `hasOwnProperty`) huruf kecil
  atau camelCase. `'__PROTO__'`, `'CONSTRUCTOR'`, `'TOSTRING'` semuanya
  `undefined`. Saya catat justru karena kelas bug ini mudah muncul kalau nanti ada
  yang menghapus `.toUpperCase()`-nya.

- **`buildGateCalibrationDiagnostics:4350`** memakai `Object.hasOwn` — bukan
  `hasOwnProperty` lewat instance — jadi aman dari kunci bermasalah.

- **`candidatePassesTelegramCandidateDigestGate:4966`** memvalidasi geometri plan
  secara eksplisit (`tp1 <= entry1` dan `sl >= entry1` ditolak), bukan sekadar
  memeriksa keberadaan field.

Satu **asimetri yang disengaja** saya catat tanpa mengubahnya: di
`candidatePassesPublicTelegramSafetyGate:4672`,

```js
if (mode !== 'daytrade') return applyFinalTopQualityGate(candidate, mode || 'public_telegram').pass;
return true;
```

`applyFinalTopQualityGate` **tidak** dijalankan untuk `mode === 'daytrade'`.
Diagnostiknya di `:4820` mencerminkan asimetri yang sama, jadi keduanya konsisten —
ini tampak sengaja, bukan terlewat. Saya tidak menyentuhnya: mengubah gate mana yang
berlaku untuk Day Trade adalah perubahan perilaku bisnis (aturan No. 8), dan itu
keputusan Anda, bukan saya.
