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

## BUG-021 — Fallback alias entry tertukar di sebelas tempat (laten)

- **Severity** : LOW (laten — tidak terjangkau pada jalur mana pun yang saya baca)
- **Area** : normalisasi level entry
- **Lokasi** : `api/sector-hot.js:4024-4025`, `:6843-6844`, `:7789-7790`, `:13230`, `:13245-13246`, `:13341`, `lib/idx-tick-normalization.js:965`, `lib/trade-plan-v2-integration.js:135-136`, dan `lib/trade-plan-v2-source-adapters.js:129-130`, `:209-210`, `:338-339` — **sebelas tempat**

Semula saya catat sebagai catatan tunggal. Setelah menyelesaikan pembacaan seluruh
file (13.902 baris), jumlahnya menjadi **enam** — jelas sebuah pola, bukan
kekhilafan sekali.

**Konvensi yang berlaku di file ini** (dinyatakan di `api/sector-hot.js:3519-3520`):

```js
r.entry1 = high; // conservative representative for upside calculation
r.entry2 = low;
```

`entry1` = batas **atas**, `entry2` = batas **bawah**.

**Ketiga tempat yang membalik konvensi itu di cabang fallback-nya:**

```js
// :4024-4025 — deriveRiskReasonDetails
var entryLow  = toNum(r.entry_low  || r.entry1 || r.entry_1);   // entry1 = HIGH
var entryHigh = toNum(r.entry_high || r.entry2 || r.entry_2 || entryLow); // entry2 = LOW
```

```js
// :6843-6844 — buildDashboardPickRow
entry1: toNum(row.entry1 != null ? row.entry1 : (raw.entry1 != null ? raw.entry1 : raw.entry_low)),
entry2: toNum(row.entry2 != null ? row.entry2 : (raw.entry2 != null ? raw.entry2 : raw.entry_high)),
```

```js
// :7789-7790 — buildWebTop5HistoryRow
entry1: toNum(row.entry1 != null ? row.entry1 : (raw.entry1 != null ? raw.entry1 : raw.entry_low)),
entry2: toNum(row.entry2 != null ? row.entry2 : (raw.entry2 != null ? raw.entry2 : raw.entry_high)),
```

Pada ketiganya, kalau cabang terakhir yang terpakai, `entry1` menerima nilai
**terendah** dan `entry2` nilai **tertinggi** — terbalik dari konvensinya.

**Kenapa tetap LOW dan bukan lebih tinggi.** Saya telusuri jangkauannya satu per satu:

- `:4024-4025` — satu-satunya pemanggil `deriveRiskReasonDetails` adalah
  `enrichSignalQuality` (`:4074`), dan di sana `deriveConfidenceTier` → `getEntry1`
  → `normalizeCandidateEntryAliases` sudah mengisi `r.entry_low`/`r.entry_high`
  lebih dulu (`:3517-3518`). Cabang fallback-nya tidak pernah jalan.
- `:6843-6844` dan `:7789-7790` — `row.entry1`/`row.entry2` adalah kolom
  `telegram_daily_picks` yang selalu diisi ketiga penulisnya (lihat BUG-016), dan
  `raw.entry1`/`raw.entry2` diperiksa sebelum `raw.entry_low`/`raw.entry_high`.
  Jadi cabang terakhirnya butuh baris tanpa `entry1` di kolom **maupun** di
  `raw_payload` — tidak saya temukan produsen yang menghasilkan bentuk itu.

**Tiga tempat tambahan yang ditemukan di bagian akhir file** (jalur monitor swing):

```js
// :13230 — getSwingMonitorTp1UpsidePct
var entryHigh = toNum(candidate.entry_high || candidate.entry2 || candidate.entry || candidate.entry1);
```

```js
// :13245-13246 — diagnoseSwingMonitorCandidate
var entryLow  = toNum(candidate && (candidate.entry_low  || candidate.entry1 || candidate.entry));
var entryHigh = toNum(candidate && (candidate.entry_high || candidate.entry2 || candidate.entry));
```

```js
// :13341 — formatSwingMonitorFallbackTelegramMessage
lines.push('Entry: ' + fmtPrice(c.entry_low || c.entry1 || c.entry) + ' - ' + fmtPrice(c.entry_high || c.entry2 || c.entry));
```

**Yang membuatnya layak dicatat.** Konsekuensinya berbeda-beda kalau cabang fallback
sampai jalan:

- `:7789-7790` — `getHistoryEntryUsage` (`:7668`) menguji `low <= entry2` lebih dulu,
  jadi entry terbalik akan melaporkan "Entry 2" tersentuh padahal Entry 1 yang
  tersentuh, dan `return_from_entry_pct` dihitung dari batas yang salah.
- `:13230` — `upside` dihitung dari batas **bawah**, sehingga membesar. Nilai itu
  langsung menjadi gate: `else if (upside == null || upside < 5) reason = 'below_min_tp1_upside'`
  (`:13273`). Kandidat yang seharusnya gagal ambang bisa lolos.
- `:13341` — ini **terlihat pengguna**: rentangnya dirender ke Telegram dengan
  pemisah `' - '`, jadi kalau fallback jalan, pesan monitor Swing mencetak rentang
  entry terbalik — gejala yang sama dengan BUG-016, tapi di Telegram, bukan web.

Ketiganya tetap tidak terjangkau pada jalur yang saya baca: `selectSafeSwingMonitorCandidates`
(`:13327`) dan `buildSwingMonitorFallbackDiagnostics` (`:13288`) sama-sama memanggil
`normalizeCandidateEntryAliases(c, category)` lebih dulu, dan baris sumbernya
(`swing_screener_latest`, `swing_screener_non_konglo_latest`) punya kolom
`entry_low`/`entry_high`.

**Bukti terkuat: modul bersama sudah melakukannya dengan benar — di empat tempat.**

`lib/idx-tick-normalization.js` adalah modul yang dipakai setiap gate. Di sana pola
alias yang sama muncul lima kali, dan **empat di antaranya dijaga secara eksplisit**:

```js
// :86, :211, :370 — penjaga tukar-kalau-terbalik
var entryLow  = firstNum(candidate, ['entry_low', 'entry1', 'entry_1']);
var entryHigh = firstNum(candidate, ['entry_high', 'entry2', 'entry_2']);
if (entryLow != null && entryHigh != null && entryLow > entryHigh) {
  var tmp = entryLow; entryLow = entryHigh; entryHigh = tmp;
}
```

```js
// :244-250 — dikumpulkan lalu di-min/max
var entryLow  = entries.length ? Math.min.apply(Math, entries) : null;
var entryHigh = entries.length ? Math.max.apply(Math, entries) : null;
```

Yang **kelima** tidak dijaga:

```js
// :965 — deriveCandlePotentialRange
var entryHigh = firstNum(input, ['entry_high', 'entry2', 'entry2n', 'entry']);
```

Konsekuensinya kalau cabang `entry2` sampai terpakai: `entryAraRoom` (`:969`) dihitung
dari batas bawah, sehingga nilainya lebih besar — dan `entryNearAra` (`:975`,
`entryAraRoom <= 3`) jadi **lebih sulit menyala**. Itu penjaga "entry terlalu dekat ARA";
melemahkannya berarti gagal-terbuka.

Jadi penulis modul ini jelas tahu masalahnya dan sudah menuliskan obatnya empat kali.
Tujuh lokasi yang tersisa hanya belum ikut.

**Perbaikan yang diusulkan.** Pakai `Math.min`/`Math.max` atau penjaga tukar di atas —
persis seperti yang **sudah dilakukan repo ini sendiri** di:

```js
// :6707-6708 — evaluateMonitorStatus
entryLow  = entry1 != null && entry2 != null ? Math.min(entry1, entry2) : ...
entryHigh = entry1 != null && entry2 != null ? Math.max(entry1, entry2) : ...
```

```js
// :8319 — formatMonitorBatchRow
entryRangeStr = fmtPrice(Math.min(entry1, entry2)) + '\u2013' + fmtPrice(Math.max(entry1, entry2));
```

```js
// :7060 — buildMonitorPlanIdentity
var entryLow = entryA != null && entryB != null ? Math.min(entryA, entryB) : ...
```

Jadi polanya sudah ada di rumah sendiri; tiga tempat itu saja yang belum ikut.

**Risiko.** Rendah — karena tidak terjangkau, perbaikannya no-op pada data yang ada
sekarang, dan menjadi benar kalau suatu saat ada produsen baris berbentuk lain.

### Tambahan setelah membaca modul Trade Plan V2 — empat lokasi lagi (total **sebelas**)

Pola yang sama muncul lagi di keluarga `trade-plan-v2`, dan kali ini pada modul yang
**seluruhnya** ada di belakang flag mati-secara-default (`TRADE_PLAN_V2_SHADOW_ENABLED`
/ `TRADE_PLAN_V2_PUBLIC_ENABLED`, `lib/trade-plan-v2-flags.js:59-66`) atau di alat CLI
offline. Jadi tidak ada satupun yang aktif di produksi hari ini — tetapi keempatnya
membaca `entry1` sebagai batas bawah:

```js
// lib/trade-plan-v2-integration.js:135-136 — buildLegacyTradePlan
entry_low: pick(['entry_low', 'entry1', 'entry_1']),
entry_high: pick(['entry_high', 'entry2', 'entry_2']),
```

```js
// lib/trade-plan-v2-source-adapters.js:129-130 — adaptDayTrade
const entryLow = pickNum(gen, ['entry_low', 'entry1', 'entry_1']);
const entryHigh = pickNum(gen, ['entry_high', 'entry2', 'entry_2']);
```

```js
// lib/trade-plan-v2-source-adapters.js:209-210 — adaptSwingKonglo
const entryLow = pickNum(gen, ['entry_low', 'entry1']);
const entryHigh = pickNum(gen, ['entry_high', 'entry2']);
```

```js
// lib/trade-plan-v2-source-adapters.js:338-339 — adaptSwingNonKonglo
const entryLow = pickNum(gen, ['entry_low', 'entry1']);
const entryHigh = pickNum(gen, ['entry_high', 'entry2']);
```

**Kenapa keempat ini lebih penting daripada tujuh yang pertama, seandainya flag-nya
dinyalakan.** Di tujuh lokasi sebelumnya nilai terbalik hanya *ditampilkan* atau masuk
ke satu gate. Di adapter, nilainya dipakai untuk **memilih struktur pasar**, dan itu
terjadi **sebelum** penjaga tukar milik mesin (`lib/trade-plan-v2.js:743-745`) sempat
bekerja:

```js
// lib/trade-plan-v2-source-adapters.js:216-222 — batas atas dipakai sebagai plafon swing low
const confirmedSwingLow = getLatestConfirmedSwingLow(source.candles, entryLow, CONFIRMED_PIVOT_LOOKBACK);
```

```js
// lib/trade-plan-v2-source-adapters.js:230-234 — batas bawah dipakai sebagai lantai resistance
const confirmedResistance = getNearestConfirmedResistance(source.candles, entryHigh, CONFIRMED_PIVOT_LOOKBACK);
if (confirmedResistance && confirmedResistance.local_resistance > entryHigh) {
```

Kalau alias terbalik terpakai, pivot yang berada **di dalam zona entry** lolos sebagai
`local_resistance`. Mesin lalu memotong TP1 di bawah/di dalam zona entry
(`lib/trade-plan-v2.js:1046-1052`), `tp1` jadi `null`, dan rencana turun ke WARNING
tanpa TP1 — padahal strukturnya sebenarnya sehat.

**Jangkauan cabang alias itu, diperiksa satu per satu:**

- `adaptDayTrade` dan kedua adapter swing dipanggil dari `buildPlanFromSource`
  (`lib/trade-plan-v2-integration.js:187`), dan satu-satunya pemakainya di produksi
  adalah `attachShadowTradePlanV2` — yang keluar lebih dulu kalau flag shadow mati
  (`:293`). Tabel sumbernya (`daytrade_screener_latest`, `swing_screener_latest`,
  `swing_screener_non_konglo_latest`) punya kolom `entry_low`/`entry_high`
  (`supabase/daytrade-screener-migration.sql:45`, `supabase/swing-screener-migration.sql:25`,
  `supabase/swing-screener-non-konglo.sql:30`), jadi alias `entry1` tidak terpakai.
- `adaptStoredRow` (`lib/trade-plan-v2-source-adapters.js:449-457`) dipakai alat
  offline `tools/run-trade-plan-v2-replay-preview.js` atas file ekspor. **Di sinilah
  cabang alias benar-benar bisa jalan**: `telegram_daily_picks` menyimpan `entry1`/`entry2`
  dan **tidak** punya `entry_low`/`entry_high` (`supabase/telegram-daily-picks-migration.sql:12-13`).
  Kalau operator mengekspor tabel itu dan menjalankan replay, laporan
  perbandingannya salah batas. Alat baca-saja, tidak menulis apa pun.
- `buildLegacyTradePlan` dipakai `resolvePublicTradePlan`, tapi payload legacy-nya
  hanya dirender kalau `source === 'trade_plan_v2'` (`lib/telegram-templates.js:396`),
  yang butuh flag publik menyala.

Ini **tidak mengubah severity** keseluruhan (masih LOW, masih laten di produksi), tapi
menambah bobot rekomendasi: satu perbaikan alias yang seragam menutup sebelas lokasi
sekaligus, termasuk keempat yang akan langsung aktif begitu rollout Trade Plan V2
dinyalakan.

**Status** : DITEMUKAN — belum diperbaiki. Dengan sebelas kemunculan, satu terlihat di
Telegram (`:13341`), satu melemahkan penjaga ARA (`idx-tick-normalization.js:965`), dan
obatnya sudah tertulis empat kali di modul bersama repo ini sendiri, **saya
merekomendasikan ini dikerjakan**. Perbaikannya no-op pada data yang ada sekarang
(sudah saya buktikan laten di setiap lokasi), jadi risikonya sangat rendah. Saya tetap
menunggu kata Anda karena diff-nya menyentuh tiga file.

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

### Instance kedua yang lebih menyesatkan — diagnostik gate yang SALAH, bukan sekadar kurang

Ditemukan saat membaca `handleTelegramDailyPicks`. Pada jalur fallback watchlist,
`api/sector-hot.js:6214-6218`:

```js
if (candidatePassesTop5WatchlistGate(poolCandidate)) {
  watchlistSafeFromPool.push(poolCandidate);
} else {
  watchlistBlockedCount++;
  var poolRejEntry = { ticker: poolCandidate.ticker };
  var poolDiag = diagnosePublicSafetyGateRejection(poolCandidate, 'daily_top5');
  poolRejEntry.reason = poolDiag.category || 'watchlist_gate_blocked';
  poolRejEntry.detailed_reason = poolDiag.detailed_reason || 'Blocked by candidatePassesTop5WatchlistGate';
```

Kandidat ditolak oleh `candidatePassesTop5WatchlistGate` (`:4851`), tetapi alasannya
diambil dari `diagnosePublicSafetyGateRejection` — diagnostik untuk **gate yang
berbeda**. Kedua gate itu punya aturan yang tidak sama: gate watchlist menuntut grade
A/B/A+ (atau C dengan RR >= 2.5), RR >= 1.5, dan `entry_status` dalam daftar tertentu
— syarat-syarat yang **tidak ada sama sekali** di gate keselamatan publik.

Akibatnya, kandidat yang diblokir gate watchlist karena (misalnya) grade C dengan
RR 1.8 akan dilaporkan dengan kategori dari gate lain yang justru ia lolosi.

**Dan cadangannya tidak pernah jalan.** `diagnosePublicSafetyGateRejection` selalu
mengembalikan `category` yang truthy — jalur terakhirnya mengembalikan
`{ category: 'unknown', ... }`, bukan string kosong. Jadi pada
`poolDiag.category || 'watchlist_gate_blocked'`, sisi kanan **tidak pernah
terpakai**: `'watchlist_gate_blocked'` dan `'Blocked by
candidatePassesTop5WatchlistGate'` adalah kode mati. Yang benar-benar tampil di
diagnostik adalah `'unknown'` — dengan `detailed_reason` berbunyi *"No specific
rejection identified (possible logic mismatch)"*.

**Perbaikan yang diusulkan.** Buat diagnostik tersendiri untuk gate watchlist, atau
minimal jangan panggil diagnostik gate lain di sini — kembalikan
`'watchlist_gate_blocked'` secara langsung, yang setidaknya jujur.

### Catatan kecil di sekitarnya (bukan bug)

`var rejectedByGate = []` dideklarasikan dua kali di fungsi yang sama
(`api/sector-hot.js:6108` dan `:6122`). Karena `var`, deklarasi kedua menimpa yang
pertama dengan array kosong baru. Tidak ada yang di-`push` di antara keduanya, jadi
**tidak ada data yang hilang** — hanya duplikasi yang sebaiknya dibersihkan.

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

---

## BUG-020 — Observasi harga tanpa timestamp dianggap SEGAR, bukan basi (monitor entry/TP/SL)

- **Severity** : MEDIUM jika terjangkau — **jangkauannya belum bisa saya pastikan** (butuh akses DB, lihat di bawah)
- **Area** : Auto Monitor — pencatatan hit Entry/TP1/TP2/SL
- **Lokasi** : `api/sector-hot.js:6678`

**Kode asli.**

```js
// api/sector-hot.js:6678-6679
var priceTimestampStale = !!(px && px.at && isMonitorTimestampStale(px.at));
var priceObservationUsable = !!(px && px.last != null && !px.bestEffort && !priceTimestampStale);
```

**Root cause.** `px.at &&` melakukan short-circuit. Kalau `px.at` bernilai `null`,
seluruh ekspresi menjadi `false` — artinya **"tidak basi"**. Padahal fungsi yang
dipanggilnya menjawab sebaliknya untuk masukan yang sama:

```js
// api/sector-hot.js:7224-7226
function isMonitorTimestampStale(value, sourceLabel) {
  if (!value) return true;
```

Jadi `isMonitorTimestampStale(null)` berkata **basi**, tetapi baris `:6678` justru
menyimpulkan **segar** — karena fungsinya tidak pernah dipanggil untuk kasus itu.

**Dampak.** `priceTimestampStale` adalah salah satu dari dua penjaga di gerbang
transisi (`api/sector-hot.js:6709`):

```js
if (px.bestEffort || priceTimestampStale) {
  ...
  if (activeBefore) return result(status, ..., 'Harga monitor perlu revalidasi; status aktif dipertahankan tanpa hit baru.', ...);
  return result('NEEDS_REVALIDATION', ..., 'Timestamp harga monitor tidak cukup segar untuk membuat transisi baru.', ...);
}
```

Observasi dengan `at === null` dan `bestEffort === false` **lolos dari penjaga ini**
dan masuk ke logika transisi penuh — sehingga `SL_HIT`, `TP1_HIT`, atau `TP2_HIT`
bisa dicatat dari observasi yang umurnya tidak diketahui sama sekali.

Itu justru kebalikan dari maksud yang dinyatakan kode di sekitarnya. Komentar di
`:6712-6713` berbunyi: *"Preserve an already-active lifecycle state, but never
create a new transition from a stale or close-only observation."* Penjaga ini
dirancang gagal-tertutup; pada kasus timestamp hilang ia gagal-terbuka.

Karena hasil monitor mengalir ke `telegram_daily_picks` lalu ke Track Record
(`lib/track-record-service.js`), hit yang tercatat dari observasi tak bertanggal
akan ikut menghitung win-rate.

**Jangkauan — ini yang belum pasti, dan saya tidak akan memolesnya jadi kesimpulan.**
Kasusnya menuntut baris DB dengan `last_price` terisi tetapi kolom timestamp-nya
kosong. `fetchLatestPriceForMonitor` (`api/sector-hot.js:6597`) mengambil `at` dari:

| sumber | kolom `at` |
|---|---|
| `daytrade_screener_latest` | `calculated_at` |
| `swing_screener_latest` | `price_asof \|\| calculated_at \|\| price_date` |
| `swing_screener_non_konglo_latest` | `price_asof \|\| calculated_at \|\| price_date` |

Jalur swing punya tiga lapis cadangan, jadi praktis kecil kemungkinannya kosong.
Jalur Day Trade hanya bergantung pada `calculated_at` — satu kolom, tanpa cadangan.
**Saya tidak punya akses ke database produksi**, jadi saya tidak bisa menyatakan
apakah `daytrade_screener_latest.calculated_at` pernah `NULL` di sana. Kalau tidak
pernah, perbaikannya no-op; kalau pernah, ia mengubah outcome yang tercatat.

**Yang bisa Anda cek dalam satu kueri** (read-only, tidak mengubah apa pun):

```sql
select count(*) from daytrade_screener_latest
where last_price is not null and calculated_at is null;
```

**Perbaikan yang diusulkan.** Selaraskan `:6678` dengan jawaban fungsinya sendiri:

```js
var priceTimestampStale = !!(px && (!px.at || isMonitorTimestampStale(px.at)));
```

(`px` dijamin non-null dan `px.last != null` di titik ini, karena penjaga
`if (!px || px.last == null)` di `:6703` sudah `return` lebih dulu.)

**Risiko.** Perbaikan ini membuat monitor **lebih ketat**: observasi tanpa timestamp
akan menghasilkan `NEEDS_REVALIDATION` alih-alih mencatat hit. Itu memang maksud
kode aslinya, tapi efeknya menyentuh angka yang tercatat di Track Record — dan
karena itu menyentuh perilaku bisnis.

**Karena itu saya belum mengerjakannya.** Aturan No. 8 Anda meminta saya bertanya
lebih dulu sebelum mengubah perilaku bisnis, dan saya juga belum bisa membuktikan
kasusnya terjadi di produksi. Dua hal itu bersama-sama membuat "tunggu keputusan"
jadi jawaban yang benar, bukan "langsung perbaiki".

**Verifikasi (kalau disetujui).** Test unit atas `evaluateMonitorStatus` dengan
`px = { last: <harga>, high: <di atas TP1>, low: ..., at: null, bestEffort: false }`,
memastikan hasilnya `NEEDS_REVALIDATION` dan bukan `TP1_HIT`.

**Status** : DITEMUKAN — menunggu keputusan Anda (dan idealnya hasil kueri di atas)

---

## BUG-022 — Sesi Yahoo tanpa high/low membuat `support` runtuh jadi 0 (Swing Non-Konglo)

- **Severity** : MEDIUM
- **Area** : Screener Swing Non-Konglo — penurunan level entry/SL/TP
- **Lokasi** : `api/sector-hot.js:10061-10065` (`fetchNkQuoteData`)

**Kode asli.**

```js
// Filter out null days
const validDays = [];
for (let i = 0; i < timestamps.length; i++) {
  if (closes[i] != null && volumes[i] != null) {
    validDays.push({ ts: timestamps[i], open: opens[i], high: highs[i], low: lows[i], close: closes[i], volume: volumes[i] });
  }
}
```

**Root cause.** Yahoo mengirim tiap deret OHLCV **secara terpisah**, jadi satu sesi
bisa punya `close` dan `volume` sementara `high`/`low`-nya `null` (suspend, atau
lubang di feed vendor). Predikat di atas hanya memeriksa `close` dan `volume`,
sehingga hari seperti itu tetap masuk dengan `high: null, low: null`.

Lalu:

```js
const support = Math.min(...last20Lows);
```

JavaScript mengubah `null` menjadi `0` di dalam `Math.min`. **Satu** low `null`
sudah cukup untuk membuat `support` runtuh jadi 0.

**Dampak — direproduksi, bukan diduga.** Deret 25 sesi untuk saham di harga 1024,
satu sesi suspend:

| | hari suspend disimpan | seharusnya |
|---|---:|---:|
| `support` | **0** | 1002 |
| `pullbackEntryHigh` (Fib 0.382) | **395** | 1014 |

Selisih 61% pada zona entry. `support` menggerakkan `pullbackEntryHigh`,
`priceInEntryZone`, klasifikasi `setupType`, lalu `entry_low` dan `stop_loss`.
Pada cabang `rebound` hasilnya `entry_low = Math.round(support) = 0` dan
`stop_loss = Math.round(support * 0.96) = 0`.

**Kenapa tidak pernah terlihat.** Asimetri antara `Math.min` dan `Math.max`:

```
Math.min(990, null, 995) === 0      // null menang
Math.max(1010, null, 1015) === 1015 // null tidak pernah menang
```

Jadi `resistance` tetap tampak wajar sementara `support` diam-diam 0. Tidak ada
nilai yang terbaca janggal sampai level yang dipublikasikan sendiri yang janggal.

`applyNkHardFilters` (`api/sector-hot.js:10487`) juga tidak menangkapnya — ia
memeriksa `lastPrice`, `tradedDays20d`, `avgTxValue20d`, `riskReward`, dan
`volumeRatioAvg20`; tidak satu pun menyentuh integritas OHLC. Dan `riskReward`
sendiri dihitung **dari** level yang sudah rusak, jadi ia bisa saja tetap >= 1.5.

**Bukti bahwa ini kekhilafan, bukan pilihan sengaja.** Tiga parser Yahoo lain di
file yang sama sudah bertahan terhadap bentuk ini:

| parser | baris | yang diperiksa |
|---|---|---|
| `fetchScreenerCandles` | `2332` | close, open, high, low, volume |
| `fetchChartOhlcRows` | `5468` | o/h/l/c + `isFinite` |
| **`fetchNkQuoteData`** | `10062` | **hanya close + volume** |

`fetchNkQuoteData` satu-satunya yang berbeda.

**Perbaikan.** Wajibkan setiap kaki OHLCV ada dan finite; kalau tidak, harinya
dibuang — persis seperti parser sejenis. Diekstrak jadi `parseNkValidDays()` agar
predikatnya bisa diuji langsung.

**Ini bukan perubahan perilaku bisnis.** Tidak ada formula entry/SL/TP, gate, atau
aturan ranking yang disentuh. Formulanya identik; ia hanya berhenti disuapi `null`.
Karena itu saya kerjakan langsung, berbeda dari BUG-014/015/020 yang memang
mengubah keluaran indikator atau ambang.

**Risiko.** Ticker yang feed-nya berlubang menghasilkan candle lebih sedikit; yang
jatuh di bawah ambang 20 sesi yang **sudah ada** akan dilewati pada run itu alih-alih
diberi skor dari level rusak. Itu hasil yang diinginkan.

**Verifikasi.** `test/nk-quote-null-ohlc.test.js` — 14 test. Termasuk satu test yang
menerapkan **predikat lama** ke input yang sama dan memastikan `support` runtuh jadi
0, sehingga berkasnya merekam cacatnya sendiri dan bukan sekadar keberadaan helper
baru. Batasnya juga dipatok: volume 0 tetap disimpan (nol adalah data nyata, berbeda
dari `null`), `undefined`/`NaN`/`Infinity` ditolak, input kosong/pendek tidak
melempar. Suite penuh 320/320 lolos.

**Yang belum pasti dan saya sebut apa adanya:** saya tidak bisa membuktikan seberapa
sering Yahoo mengembalikan bentuk ini untuk ticker IDX — tidak ada akses log
produksi. Yang bisa saya tunjukkan hanya (a) efeknya kalau terjadi, direproduksi di
atas, dan (b) tiga parser lain di repo ini sudah bertahan terhadapnya.

**Status** : DIPERBAIKI — PR #504 (`fix/nk-quote-null-ohlc`), draft

---

## Catatan tambahan pada BUG-015 (RSI 0/0) — salinan di `nkCalcRSI`

```js
// api/sector-hot.js:10919-10921
if (avgLoss === 0) return 100;
const rs = avgGain / avgLoss;
return 100 - (100 / (1 + rs));
```

Salinan ke-8 dari pola BUG-015. Seri harga yang benar-benar datar dilaporkan
sebagai RSI 100. Menunggu keputusan yang sama.

---

## Hipotesis yang saya periksa dan TIDAK terbukti — `verifyHighConvictionTelegramSignal`

Saya catat ini karena sempat tampak seperti bug serius di jalur publish, dan
pembaca berikutnya kemungkinan akan mencurigainya juga.

Ada dua pola pemanggilan yang berbeda di repo:

```js
// api/sector-hot.js:5144-5146 — normalizeCombinedCandidate: MERGE dulu
var verified = verifyTelegramSignal(r, ...);
if (verified) r = Object.assign(r, verified);
var high = verified ? verifyHighConvictionTelegramSignal(r, ...) : null;
```

```js
// api/sector-hot.js:12417 (publish Day Trade), :13438 dan :13640 (publish Swing
// Konglo), :9613 (diagnostik NK) — oper `verified` LANGSUNG
var high = verifyHighConvictionTelegramSignal(verified, 'daytrade');
```

Kalau `verifyTelegramSignal` mengembalikan objek **parsial**, tiga jalur publish itu
akan menyuapi pemeriksa high-conviction dengan baris yang kurang field — dan itu
menentukan kandidat mana yang dipublikasikan.

Saya baca fungsinya (`api/sector-hot.js:12898`) dan **hipotesisnya gugur**:

```js
var r = Object.assign({}, row);
r.verified_risk_label = verifiedRisk;
...
return r;
```

Ia mengembalikan **klon utuh** dari baris masukan plus field tambahan. Jadi mengoper
`verified` langsung setara dengan mengoper hasil merge-nya. Kedua pola sama benar;
tidak ada bug, dan tidak ada yang perlu diubah.

---

## BUG-023 — `avg_volume_20d` yang dipublikasikan adalah taksiran, padahal angka sebenarnya sudah dihitung

- **Severity** : LOW (tampilan; tidak saya temukan gate yang membacanya)
- **Area** : Screener Swing Non-Konglo
- **Lokasi** : `api/sector-hot.js:10905` (`calculateNkSetupScore`)

**Kode asli.**

```js
// Compute avg_volume_20d
var avgVolume20d = (q.lastPrice > 0) ? Math.round(q.avgTxValue20d / q.lastPrice) : 0;
```

Kolomnya bernama `avg_volume_20d` — rata-rata **volume** 20 hari — tetapi yang diisi
adalah rata-rata **nilai transaksi** dibagi harga **terakhir**.

**Root cause.** `avgTxValue20d` adalah Σ(close × volume)/20, yaitu rata-rata memakai
harga **tiap hari**. Membaginya dengan `lastPrice` hanya benar kalau harga tidak
bergerak selama 20 hari itu. Kalau saham naik dari 900 ke 1100 (rata-rata close
~1000), hasilnya `avgVolume × 1000/1100` — meleset sekitar **9% ke bawah**. Semakin
besar pergerakan 20 hari, semakin besar melesetnya.

**Yang membuat ini layak dicatat:** angka yang benar **sudah dihitung** beberapa
baris sebelumnya dan ikut dibawa di objek quote:

```js
// api/sector-hot.js:10111
const avgVol20 = last20.map(d => d.volume).reduce((a, b) => a + b, 0) / 20;
```

```js
// api/sector-hot.js:10427 — ikut dikembalikan
avgVol20: avgVol20,
```

Jadi ini bukan keterbatasan data, hanya nilai yang benar diabaikan dan diganti
taksiran. `q.avgVol20` bisa langsung dipakai.

**Dampak.** Saya telusuri pembacanya: `avg_volume_20d` ada di `NK_STAGING_COLUMNS`
dan `NK_LATEST_COLUMNS`, tetapi gate likuiditas (`deriveStaleLiquidityLabels`)
memakai `traded_days_20d`, `value_today`, `avg_value_7d`, dan `freq`; sedangkan
`classifyVolumeThrust` memakai `volume_ratio_20d`/`volume_ratio_avg20`. Kecocokan
`avg_volume_20d` lain di `lib/` (`daytrade-screener-engine-v7.js`,
`intraday-volume-pace.js`) berada di jalur Day Trade/intraday yang memakai sumber
berbeda, bukan kolom NK ini. Jadi sejauh yang saya baca, dampaknya tampilan saja.

**Perbaikan yang diusulkan.** `var avgVolume20d = Math.round(q.avgVol20 || 0);`

**Kenapa belum saya kerjakan.** Ini mengubah nilai kolom yang dipublikasikan. Meski
saya tidak menemukan gate yang membacanya, "tidak saya temukan" bukan "tidak ada" —
saya belum membaca seluruh repo. Menunggu keputusan Anda, sekalian dengan
BUG-014/015/020.

**Status** : DITEMUKAN — menunggu keputusan

---

## Catatan tambahan pada BUG-014 (sentinel 0 vs tidak diketahui) — instance yang paling mudah terjadi

- **Lokasi** : `api/sector-hot.js:11125` (`deriveDayTradeTimeframeContext`)

```js
var rp = r.range_position || 50; // 0=low, 100=high
```

`range_position` 0 berarti **close persis di low hari itu** — sinyal bearish yang
nyata dan sering terjadi (hari ARB, tekanan jual sampai penutupan). Operator `||`
mengubahnya jadi 50, yaitu "netral".

Akibatnya dua cabang ini tidak pernah menyala untuk kasus yang justru paling ekstrem:

```js
else if (chg <= -2 && rp <= 30) tf1d = 'Bearish close near low';
...
else if (rp <= 20 && chg <= 0) tf1d = 'Close near low';
```

Berbeda dari BUG-014 yang aslinya (di mana `volume_ratio_avg20 = 0` menandakan saham
tanpa volume — kasus yang argumentatif), di sini nilai 0 sepenuhnya wajar dan sering.
Ini instance keluarga BUG-014 dengan jangkauan praktis paling besar.

Dampaknya ke `tf_1d_context`, `tf_summary`, dan `derived_risk` — label tampilan Day
Trade. Perbaikan: `var rp = r.range_position != null ? Number(r.range_position) : 50;`

Masuk keluarga BUG-014 dan menunggu keputusan yang sama, bukan temuan terpisah.

Catatan pembanding: `lib/daytrade-screener-engine.js:279-280` yang **memproduksi**
nilai ini sudah benar — ia memakai `Number.isFinite` dan hanya jatuh ke 50 kalau
hasilnya bukan angka, bukan kalau hasilnya 0. Jadi produsennya membedakan 0 dari
"tidak diketahui"; konsumennya di `api/sector-hot.js` yang tidak.

---

## Catatan kebersihan (bukan bug) — `api/sector-hot.js`

1. **`getWibDateString` dideklarasikan dua kali** (`:3313` dan `:8877`). Satu-satunya
   nama fungsi yang duplikat di file ini. Karena deklarasi fungsi di-hoist, yang
   kedua menang untuk semua pemanggil — dan **kedua badannya identik** secara
   perilaku (`Date.now() + 7 jam` lalu `toISOString().slice(0,10)`), jadi tidak ada
   perbedaan hasil. Duplikasi mati yang sebaiknya dihapus, bukan bug.

2. **`var crypto = require('crypto')` lokal** di `:2464` dan `:2511` membayangi
   `const crypto = require('crypto')` di `:58`. Sempat saya curigai bisa menabrak
   global WebCrypto (yang tidak punya `createHmac`), tetapi impor modul-level di
   `:58` ada dan kedua deklarasi lokal itu memuat modul yang sama. Aman; hanya
   redundan.

3. **Kueri yang hasilnya langsung dibuang** di `handleNkScreenerFinalize`: `:9741`
   mengambil staging `limit(30)`, lalu `:9779` mengambil lagi `limit(200)` dan
   `topCandidates` ditimpa dari hasil kedua. Kueri pertama praktis sia-sia (hanya
   terpakai kalau kueri kedua mengembalikan null tanpa error). Satu round trip
   Supabase yang bisa dihemat — efisiensi, bukan kebenaran.

4. **Cabang mati** di `evaluateMonitorStatus:6781`:
   `return result(active ? 'RUNNING' : 'ENTRY_MISSED', ...)`. Pada titik itu
   `activeBefore` sudah pasti false (sudah `return` lebih awal) dan `entryTouched`
   juga false (sudah `return` di cek sebelumnya), jadi `active` selalu false dan
   cabang `'RUNNING'` tidak pernah terpilih. Tidak berbahaya, hanya menyesatkan
   pembaca.

---

## Asimetri yang saya periksa dan biarkan — jarak entry Day Trade vs Swing

```js
// api/sector-hot.js:10946 — deriveSwingLabels
var entryDistancePct = entryHigh > 0 && lastPrice > 0 ? ((lastPrice - entryHigh) / entryHigh) * 100 : 0;
```

```js
// api/sector-hot.js:11091 — deriveDayTradeLabels
var riskDist = (entryLow > 0 && lastPrice > 0) ? ((lastPrice - entryLow) / lastPrice) * 100 : 0;
```

Dua perbedaan sekaligus: batas acuannya (`entry_high` vs `entry_low`) dan
penyebutnya (`entryHigh` vs `lastPrice`). Keduanya lalu dipakai untuk memilih label
`entry_timing`.

**Saya tidak menaikkannya jadi bug.** Namanya memang berbeda — `entryDistancePct`
("jarak dari entry") vs `riskDist` ("jarak risiko") — dan pembacaan yang masuk akal
adalah keduanya memang mengukur hal yang berbeda. Menyamakannya akan mengubah label
Day Trade, yaitu perilaku bisnis (aturan No. 8). Saya catat supaya Anda tahu
keduanya tidak sebanding kalau suatu saat dibandingkan berdampingan.

---

## BUG-024 — Pencocokan substring `ARA`/`ARB` terlalu longgar di `getDayTradeRadarStatus` (laten)

- **Severity** : LOW (laten — tidak ada string produksi yang memicunya saat ini, lihat pengukurannya di bawah)
- **Area** : Day Trade — pemilihan alasan radar dan penjaga blok fatal
- **Lokasi** : `api/sector-hot.js:12242`

**Kode asli.**

```js
if (raw.indexOf('ARA_ARB') >= 0 || raw.indexOf('ARA') >= 0 || raw.indexOf('ARB') >= 0) found.ARA_ARB_MONITOR = true;
```

`raw` adalah teks status/verdict/reason yang sudah di-`toUpperCase()` dan spasi/tanda
hubungnya diganti `_`. Pencocokannya substring polos, tanpa batas kata.

**Kenapa ini berbahaya kalau terpicu.** `ARA_ARB_MONITOR` adalah **prioritas
tertinggi** dalam daftar:

```js
var priority = ['ARA_ARB_MONITOR', 'CHASE_RISK_MONITOR', 'RADAR', 'WAIT_PULLBACK', ...];
```

jadi ia menimpa setiap alasan radar lain yang lebih tepat. Lebih penting lagi, ia
membuka penjaga fatal di `hasFatalDayTradeRadarBlock` (`api/sector-hot.js:12291`):

```js
if (r.buy_execution_realistic === false && !getDayTradeRadarStatus(r)) return true;
```

Kandidat dengan `buy_execution_realistic === false` (eksekusi tidak realistis)
seharusnya diblokir. Tapi kalau `getDayTradeRadarStatus` mengembalikan sesuatu —
termasuk hasil cocokan palsu — ekspresinya jadi false dan kandidat itu **lolos**.
Penjaga yang dimaksudkan gagal-tertutup menjadi gagal-terbuka.

**Terbukti terlalu longgar.** Saya jalankan fungsinya (diekstrak apa adanya) atas
kata-kata Indonesia sehari-hari:

| teks | hasil |
|---|---|
| `Harga dekat/mentok ARA; jangan chase agresif.` | ARA_ARB_MONITOR ✅ benar |
| `Narrow range/doji, pasar belum putuskan **arah**` | ARA_ARB_MONITOR ❌ |
| `Setup **sementara** belum layak entry` | ARA_ARB_MONITOR ❌ |
| `Penurunan cukup **parah**, hindari dulu` | ARA_ARB_MONITOR ❌ |
| `Harga bergerak **antara** support dan resistance` | ARA_ARB_MONITOR ❌ |
| `Belum ada **cara** masuk yang aman` | ARA_ARB_MONITOR ❌ |
| `Bergerak ke **utara**` | ARA_ARB_MONITOR ❌ |
| `**Barang** masih ditahan bandar` | ARA_ARB_MONITOR ❌ |

8 dari 8 kata umum cocok palsu (`bARAng`, `sementARA`, `pARAh`, `antARA`, `cARA`,
`utARA`, `ARAh`).

**Jangkauan — dan di sini saya menahan diri, bukan melebihkan.** Kata-kata di atas
saya karang sendiri, jadi belum membuktikan apa pun soal produksi. Karena itu saya
sapu seluruh repo (`api/`, `lib/`, `public/`, `tools/`) untuk **setiap literal string
yang benar-benar di-assign ke salah satu dari 19 field** yang dibaca fungsi ini —
437 nilai. Hasilnya:

- **Tidak satu pun literal produksi di jalur Day Trade yang memicu cocokan palsu.**
- Yang tersaring hanya konstanta sah (`NEAR_ARA`, `NEAR_ARB` di
  `lib/idx-tick-normalization.js`), fixture test, dan satu string di
  `public/portfolio-ai-runtime-v2.js` ("gangguan **sementara**") yang berada di
  subsistem berbeda dan tidak masuk ke kandidat Day Trade.

Jadi statusnya **laten**, bukan aktif.

**Yang tidak bisa saya buktikan.** Sapuan itu hanya menjangkau *literal*. Beberapa
field ini juga menerima teks yang dirangkai saat runtime — misalnya
`statusReason = metricLine + '.' + entryNote + ' ' + statusReason`
(`api/sector-hot.js:10850`) dan `excluded_reason` dari gate yang isinya gabungan.
Teks semacam itu tidak bisa saya enumerasi secara statis, jadi saya **tidak bisa
menyatakan tidak mungkin terpicu** — hanya bahwa tidak ada literal yang memicunya.

**Perbaikan yang diusulkan.** Teksnya sudah dinormalkan (`[\s-]+` → `_`), jadi cukup
cocokkan sebagai token utuh, bukan substring:

```js
if (/(^|_)(ARA|ARB|ARA_ARB)(_|$)/.test(raw)) found.ARA_ARB_MONITOR = true;
```

**Risiko.** Karena tidak ada pemicu produksi yang ditemukan, perbaikannya no-op pada
data sekarang — dan menutup celah gagal-terbuka di `hasFatalDayTradeRadarBlock` kalau
suatu saat ada yang menulis "arah" atau "sementara" ke salah satu field itu.

**Verifikasi (kalau disetujui).** Test dengan kedelapan kata di atas plus ARA/ARB
asli, memastikan hanya yang asli yang cocok — dan satu test yang memastikan kandidat
`buy_execution_realistic === false` dengan teks berisi "sementara" tetap diblokir
`hasFatalDayTradeRadarBlock`.

**Status** : DITEMUKAN — belum diperbaiki (laten; digabung ke PR pembersihan bersama
BUG-021 kalau Anda setuju)

---

## BUG-025 — `includesAny()` memotong teksnya di 300 karakter, sehingga gate keselamatan gagal-terbuka

- **Severity** : **HIGH** (menyentuh seluruh keluarga gate keselamatan publik)
- **Area** : semua gate berbasis teks — Telegram publik, Top 5, Top 5 Watchlist, Day Trade, radar fallback
- **Lokasi** : `api/sector-hot.js:12856` (`includesAny`), berpasangan dengan `api/sector-hot.js:12862` (`joinTelegramTexts`) dan `api/sector-hot.js:12808` (`safeTelegramText`)

**Kode asli.**

```js
// api/sector-hot.js:12856
function includesAny(text, words) {
  var t = safeTelegramText(text, 300, '').toLowerCase();
  for (var i = 0; i < words.length; i++) if (t.indexOf(words[i]) >= 0) return true;
  return false;
}
```

```js
// api/sector-hot.js:12862
function joinTelegramTexts(parts) {
  return parts.map(function(p) { return safeTelegramText(p, 120, ''); }).filter(Boolean).join(' | ');
}
```

```js
// api/sector-hot.js:12808 — safeTelegramText memotong, bukan sekadar merapikan
if (text.length > maxLen) text = text.slice(0, Math.max(0, maxLen - 1)).trim() + '…';
```

**Root cause.** `includesAny` adalah **pencocok**, bukan pemformat tampilan. Tetapi ia
melewatkan masukannya melalui `safeTelegramText(..., 300, ...)`, yang **memotong di
300 karakter**. Semua yang berada setelah karakter ke-300 tidak pernah diperiksa.

Pasangannya memperburuk: `joinTelegramTexts` menyatukan **banyak** field, masing-masing
sampai 120 karakter, dipisah `' | '`. Tiga field penuh saja sudah 366 karakter — sudah
melewati batas.

**Dibuktikan, bukan diduga.** Saya jalankan ketiga fungsi itu apa adanya atas kandidat
berbentuk persis seperti yang dibangun `candidatePassesPublicTelegramSafetyGate`, dengan
kata kunci pemblokir diletakkan di field yang lebih belakang:

```
joined length          : 392
contains keyword?      : true          <- teksnya JELAS mengandung 'very high risk'
includesAny() says     : false         <- tapi gate-nya bilang tidak ada
```

Yang benar-benar dilihat `includesAny` berakhir di
`"... Consolidation - harga dekat resistance dengan trend/volume membaik |…"` —
field terakhir tidak pernah sampai.

**Seberapa luas.** Diukur, bukan dikira:

| | jumlah |
|---|---:|
| pemanggilan `includesAny` di `api/sector-hot.js` | **101** |
| di antaranya yang disuapi teks gabungan | **53** |
| pemanggilan `joinTelegramTexts` | 56 |
| yang menggabung ≥ 6 field | **33** |
| field terbanyak dalam satu panggilan | **40** |

Panggilan 40-field bisa menghasilkan ~4.800 karakter, dan `includesAny` hanya memeriksa
300 pertama — sekitar **6%** dari teks yang dimaksudkan diperiksa.

**Dampak.** Yang paling langsung adalah pemeriksaan yang **hanya** berupa teks, tanpa
padanan terstruktur:

- `hasFatalDayTradeRadarBlock` (`api/sector-hot.js:12277`) menggabung **26 field** ke
  `allText`, lalu mencari `'invalid candle'`, `'below sl'`, `'sl kena'`,
  `'invalidation hit'`, `'impossible execution'`, `'data rusak'`. Ini blok **fatal**.
- `publicTelegramSafetyTextHasReject(guardText)` di
  `candidatePassesPublicTelegramSafetyGate`.
- Daftar kata kunci breakout (`'false breakout'`, `'needs close confirmation'`, …) dan
  freshness (`'stale'`, `'expired'`, `'needs revalidation'`, …).

**Peredam yang jujur harus saya sebut:** banyak gate memeriksa **field terstruktur lebih
dulu** — misalnya `risk === 'very high risk'` dari `normalizeTelegramRiskLabel(...)`,
`candidate.trading_plan_valid === false`, `entryStatus === 'INVALID_BELOW_SL'`. Untuk
kondisi-kondisi itu, cek teks hanyalah lapis kedua, dan lapis pertamanya tetap bekerja.
Jadi ini **bukan** berarti setiap gate bocor. Yang bocor adalah kondisi yang tidak punya
lapis terstruktur.

**Yang belum bisa saya ukur.** Berapa banyak kandidat nyata yang teks gabungannya benar-benar
melewati 300 karakter — itu butuh data produksi. Yang bisa saya tunjukkan: `status_reason`
Non-Konglo saja dirakit sebagai `metricLine + '.' + entryNote + ' ' + statusReason`
(`api/sector-hot.js:10850`) dan rutin melebihi 120 karakter, sehingga hanya butuh dua
sampai tiga field terisi lagi untuk melewati batas.

**Perbaikan yang diusulkan.** Jangan memotong di dalam pencocok:

```js
function includesAny(text, words) {
  if (text == null || typeof text === 'object') return false;
  var t = String(text).toLowerCase();
  for (var i = 0; i < words.length; i++) if (t.indexOf(words[i]) >= 0) return true;
  return false;
}
```

(Batas 120 per field di `joinTelegramTexts` sebaiknya juga ditinjau, tetapi memperbaiki
`includesAny` saja sudah menghapus pemotongan tingkat kedua yang paling merusak.)

**KENAPA SAYA BELUM MENGERJAKANNYA — ini yang perlu keputusan Anda.**

Perbaikannya membuat gate **lebih ketat**: kandidat yang selama ini lolos karena kata
kunci pemblokirnya terpotong akan mulai diblokir. Arahnya lebih aman, dan memang itu
maksud kode aslinya. Tapi **besarnya tidak saya ketahui** — bisa jadi beberapa kandidat
per hari, bisa jadi banyak. Itu langsung memengaruhi berapa sinyal yang terbit ke
Telegram dan ke web.

Menurut aturan No. 8 Anda, perubahan sebesar itu bukan keputusan saya.

**Yang saya sarankan:** jalankan dulu pengukurannya tanpa mengubah perilaku. Saya bisa
menambahkan diagnostik dry-run yang menghitung, untuk setiap kandidat, apakah teks
gabungannya melewati 300 karakter dan apakah ada kata kunci pemblokir yang hilang karena
terpotong. Itu murni observasi — tidak ada gate yang berubah — dan hasilnya memberi tahu
kita persis berapa besar dampak perbaikannya sebelum diterapkan.

**Verifikasi (kalau disetujui).** Test yang membangun teks gabungan >300 karakter dengan
kata kunci pemblokir di ujung, memastikan gate menolaknya; plus test bahwa teks pendek
berperilaku persis sama seperti sebelumnya.

**Status** : DITEMUKAN — **menunggu keputusan Anda**. Saya sarankan langkah pengukuran
dulu, bukan langsung perbaikan.

---

## BUG-026 — `PRE_SPIKE_WATCH` hanya bisa dicapai kandidat yang LEBIH BURUK (urutan klasifikasi terbalik)

- **Severity** : MEDIUM
- **Area** : Day Trade — klasifikasi status dan hitungan "priority opportunity"
- **Lokasi** : `lib/daytrade-screener-engine.js:880-884` (cabang `EARLY_RADAR`) vs `:887` (cabang `PRE_SPIKE_WATCH`)

**Root cause.** Cabang berambang **lebih rendah** dievaluasi lebih dulu:

```js
// :880 — EARLY_RADAR, ambang 62
else if (compositeScore >= DT_INITIAL.early_radar_score && hardFails.length === 0 && !isAfternoon &&
         data.change_pct >= -0.5 && data.change_pct <= 5.0 &&
         data.distance_to_breakout_pct <= 5.0 && !hasDistribution) {
  status = 'EARLY_RADAR';
```

```js
// :887 — PRE_SPIKE_WATCH, ambang 70 (tidak pernah tercapai kalau yang di atas cocok)
else if (compositeScore >= DT_INITIAL.prespike_score && hardFails.length === 0 && !hasLowVolume && !isAfternoon) {
```

Ambangnya (`lib/daytrade-screener-constants.js:9-11`): `early_radar_score: 62`, `prespike_score: 70`.

**Dibuktikan.** Saya panggil `classifyStatus` yang diekspor, dengan kandidat yang memenuhi **setiap** syarat `PRE_SPIKE_WATCH` (volume 1,5 ≥ 1,2; tanpa hard fail; bukan sesi sore; `change_pct` 2% ≤ 5%):

```
score 62  -> EARLY_RADAR
score 68  -> EARLY_RADAR
score 70  -> EARLY_RADAR      <- ambang PRE_SPIKE terlampaui, tetap kalah
score 72  -> EARLY_RADAR
score 74  -> EARLY_RADAR
score 75  -> READY_BREAKOUT
```

**Dan inilah bagian yang membalik maknanya.** Saya telusuri kapan `PRE_SPIKE_WATCH` *bisa* muncul:

```
EARLY_RADAR       | chg  2%, dist 3%   <- kandidat lebih baik
PRE_SPIKE_WATCH   | chg -1%, dist 3%   <- harga TURUN
PRE_SPIKE_WATCH   | chg  2%, dist 6%   <- JAUH dari breakout
```

Jadi `PRE_SPIKE_WATCH` — label yang berarti *"volume mulai masuk, tunggu breakout"* — hanya
tercapai kalau kandidatnya **turun** atau **jauh dari breakout**. Kandidat yang justru
*naik* dan *dekat* breakout malah mendapat label yang lebih lemah.

Cabang `PRE_SPIKE_WATCH` kedua (lewat `near_breakout_score` 65, `:911`) terbayangi dengan
cara yang sama:

```
EARLY_RADAR       | score 66, dist 2%
PRE_SPIKE_WATCH   | score 66, dist 2%, chg -1%
```

**Dampak.** Bukan soal keselamatan — `EARLY_RADAR` justru lebih konservatif, jadi tidak
ada sinyal berbahaya yang terbit. Yang rusak adalah pelaporan dan pemeringkatan:

1. **`top_count` sistematis terlalu rendah.** Di `api/sector-hot.js:11760-11768`,
   `priorityRadarCount` hanya menghitung `PRE_SPIKE_WATCH`; `EARLY_RADAR` tidak. Angka
   "PRIORITY OPPORTUNITY" yang dilaporkan karena itu kehilangan kandidat skor 70–74 yang
   paling menjanjikan.
2. **Peringkat Telegram lebih rendah.** `setupPriority` (`api/sector-hot.js:12406`) memberi
   `PRE_SPIKE_WATCH` = 3 dan `EARLY_RADAR` = 4, jadi setup yang lebih baik diurutkan di
   bawah setup yang lebih lemah.
3. **Labelnya menyesatkan.** Untuk rentang skor 62–74, kedua label berarti kebalikan dari
   yang tertulis.

**Perbaikan yang diusulkan.** Dua pilihan, saya rekomendasikan yang pertama:

- **(a)** Pindahkan cabang `EARLY_RADAR` ke **bawah** kedua cabang `PRE_SPIKE_WATCH`.
  Paling kecil perubahannya dan mengembalikan urutan ambang yang wajar (75 → 70 → 65 → 62).
- **(b)** Tambahkan `compositeScore < DT_INITIAL.prespike_score` ke syarat `EARLY_RADAR`.
  Eksplisit, tetapi menyisakan cabang `near_breakout` (65) yang masih terbayangi.

**Kenapa belum saya kerjakan.** Ini mengubah klasifikasi status, yang langsung mengubah
`top_count`, urutan seleksi Telegram, dan kandidat mana yang masuk digest. Itu perilaku
bisnis — aturan No. 8 Anda meminta saya bertanya lebih dulu.

**Belum pasti:** saya tidak bisa memastikan urutan ini kekhilafan atau sengaja. Yang bisa
saya tunjukkan adalah akibatnya — label yang lebih kuat hanya diberikan kepada kandidat
yang lebih lemah — dan itu sulit dibaca sebagai maksud yang disengaja.

**Verifikasi (kalau disetujui).** Test atas `classifyStatus` dengan skor 70/72/74 pada
kandidat yang memenuhi syarat `PRE_SPIKE_WATCH`, memastikan hasilnya `PRE_SPIKE_WATCH`;
plus test bahwa skor 62–69 tetap `EARLY_RADAR` (tidak ada promosi yang tidak diinginkan).

**Status** : DITEMUKAN — menunggu keputusan Anda

---

## Catatan tambahan pada BUG-018 (fetch tanpa timeout) — inventaris menyeluruh seluruh repo

Setelah BUG-018 diperbaiki di `api/sector-hot.js` (PR #502), saya sapu **seluruh repo**
untuk pola yang sama: setiap pemanggilan `fetch(` yang tidak membawa `signal` dari
`AbortController` maupun `AbortSignal.timeout` dalam 14 baris berikutnya.

**Hasil: 62 lokasi di luar `test/`.** Dipilah menurut kepentingannya:

### Sisi server, BELUM diperbaiki, dan yang paling penting

| lokasi | fungsi | kenapa penting |
|---|---|---|
| `lib/daytrade-screener-engine.js:160` | `fetchDayTradeCandles` | **Volume tertinggi di seluruh sistem.** Dipanggil per-ticker di sepanjang universe Day Trade (~760 ticker pada full scan). Satu upstream menggantung menghabiskan anggaran batch. |
| `lib/daytrade-intraday-observe.js:253` | pengamat intraday | jalur observasi VPS |
| `api/quote.js:109, 666, 1067, 1115` | Supabase REST | sudah dicatat sebelumnya sebagai catatan BUG-005 |
| `scripts/refresh-sector-hot.js:45` | refresh operasional | dijalankan manual/cron |
| `tools/*` (11 lokasi) | skrip operasional | dijalankan operator, dampak terbatas |

### Sudah diperbaiki (jangan dihitung dua kali)

Sapuan ini dijalankan dari branch `fix/nk-quote-null-ohlc`, yang bercabang dari
`feat/daytrade-screener-v1` dan **belum memuat** PR #497 maupun #502. Karena itu
scan-nya masih menampilkan:

- `lib/analyze-legacy.js:547, 594, 711, 1518, 1599` — **sudah diperbaiki di PR #497**
- `api/sector-hot.js:2088, 2310, 2348` — **sudah diperbaiki di PR #502**

Saya sebutkan supaya angkanya tidak salah dibaca sebagai regresi. Delapan lokasi itu
sudah tertutup; yang tersisa adalah daftar di atas.

### Sisi frontend (`public/`, 26 lokasi)

Profil risikonya berbeda: ini `fetch` di browser, tidak memakan anggaran fungsi
serverless. Akibat terburuknya adalah spinner yang berputar selamanya kalau permintaan
menggantung. Dua file sudah punya pembungkus timeout sendiri
(`public/portfolio-supabase-sync.js:115`, `public/portfolio-command-center.js:103`),
yang menunjukkan polanya sudah dikenal di repo ini — hanya belum merata.

### Yang diabaikan

`_disabled_api_backup/analyze.real.js` (5 lokasi) — direktori nonaktif, tidak dimuat
runtime.

**Rekomendasi.** Satu PR lanjutan "timeout upstream — sisa `lib/`" yang memakai
`fetchWithTimeout` persis seperti di PR #502, mencakup
`lib/daytrade-screener-engine.js:160` dan `lib/daytrade-intraday-observe.js:253`.
Keduanya sisi server dan keduanya di jalur produksi. Belum saya kerjakan karena sudah
ada 11 PR terbuka dan saya tidak mau melebarkan #502 yang sudah hijau — katakan saja
kalau Anda mau PR itu dibuat.

---

## Catatan tambahan pada BUG-015 (RSI 0/0) — salinan ke-9

```js
// lib/daytrade-screener-engine.js:2010-2015
var avgGain = gains / period;
var avgLoss = losses / period;
if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) return null;
if (avgLoss === 0) return 100;
```

Salinan ke-9. Penjagaan `Number.isFinite`-nya lebih baik dari salinan lain, tetapi
kasus 0/0 (seri benar-benar datar) tetap mengembalikan 100.

---

## Catatan laten — `calcMA` membagi dengan `period`, bukan dengan jumlah nilai yang benar-benar dijumlahkan

- **Lokasi** : `lib/daytrade-screener-engine.js:1995-2004`

```js
function calcMA(arr, period) {
  if (!arr || arr.length < period || !period || period <= 0) return null;
  var slice = arr.slice(arr.length - period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) {
    var val = Number(slice[i]);
    if (Number.isFinite(val)) sum += val;   // <- melewati nilai non-finite
  }
  var ma = sum / period;                     // <- tetap dibagi period penuh
  return Number.isFinite(ma) ? ma : null;
}
```

Kalau ada nilai non-finite, ia dilewati **tanpa mengurangi pembagi**. Dua nilai buruk
dari 20 menghasilkan MA sekitar 10% terlalu rendah. MA20 yang terlalu rendah membuat
`_aboveMA20` lebih mudah bernilai true, yang menaikkan `scoreMomentum` dan `scoreTrend`
— jadi ini akan menyentuh skor, bukan sekadar tampilan.

**Tidak terjangkau lewat jalur produksi.** `fetchDayTradeCandles`
(`lib/daytrade-screener-engine.js:181`) memeriksa kelima kaki OHLCV sebelum memasukkan
sebuah candle — **justru pemeriksaan yang tidak ada di parser NK (BUG-022)** — jadi
`closes`/`volumes` yang sampai ke `calcMA` dijamin finite dan loop-nya tidak pernah
melewati apa pun.

Yang membuatnya layak dicatat: `runDayTradeBatch` menerima `options.fetchCandles`
(`:1706`), pengambil candle yang bisa disuntikkan. Pemanggil yang menyuntikkan
pengambil tanpa validasi akan mendapat MA yang diam-diam terlalu rendah, bukan `NaN`
yang kentara. Perbaikannya sepele: hitung pembaginya (`count`) dan bagi dengan itu,
atau kembalikan `null` begitu ada nilai non-finite.

**Status** : DITEMUKAN — laten, tidak diperbaiki

---

## BUG-027 — Peringatan "JANGAN chase" dibaca sistem sebagai bukti bahwa harga SEDANG di-chase

- **Severity** : **HIGH**
- **Area** : Day Trade — verdict sinyal, quality gate, alasan radar, label risiko
- **Lokasi akar** : `lib/idx-tick-normalization.js:837` + `:881` (`deriveSignalVerdict`), berpasangan dengan `lib/daytrade-screener-engine.js:1180` (`generateTimePlan`)

**Inti masalahnya.** `deriveSignalVerdict` mendeteksi "chase" dengan mencocokkan kata di
teks bebas kandidat:

```js
// lib/idx-tick-normalization.js:837
var noteText = [r.notes, r.status_reason, r.entry_timing, r.time_plan, r.telegram_verdict, ...].filter(Boolean).join(' ').toLowerCase();
```

```js
// lib/idx-tick-normalization.js:881
var chaseExtended = entry === 'CHASE_RISK' || entry === 'EXTENDED' || hasAny(noteText, ['chase', 'extended', 'long candle']);
```

`time_plan` ikut di dalamnya. Dan `time_plan` untuk `PRE_SPIKE_WATCH` **selalu** berisi
kata itu — karena isinya justru nasihat untuk tidak chase:

```js
// lib/daytrade-screener-engine.js:1180
if (status === 'PRE_SPIKE_WATCH') {
  return base + 'Tunggu volume spike + break resistance. JANGAN chase. Sabar menunggu konfirmasi.';
}
```

Jadi **peringatan sistem agar jangan chase dibaca oleh gate-nya sendiri sebagai bukti
bahwa harga sedang di-chase.**

**Dibuktikan.** Saya jalankan `generateTimePlan` yang diekspor untuk tiap status, lalu
`deriveSignalVerdict` atas kandidat yang sehat (`IN_ENTRY_AREA`, plan valid, Low Risk,
RR sehat, Liquid, respect valid, grade A):

```
A_PLUS_SETUP           clean
READY_BREAKOUT         clean
PRE_SPIKE_WATCH        time_plan CONTAINS trigger word
EARLY_RADAR            clean
MOMENTUM_CONTINUATION  clean

tanpa time_plan        -> ENTRY_AREA      | Entry    | grade A
dengan time_plan       -> WAIT_PULLBACK   | Hindari  | grade C
```

Kandidat yang sama, satu-satunya perbedaan adalah teks nasihatnya sendiri.

**Rantainya nyata sampai produksi** — saya telusuri tiap sambungannya:

1. `time_plan` **disimpan** ke `daytrade_screener_latest` (kolom di upsert batch,
   `api/sector-hot.js:11492`).
2. Dibaca kembali dengan `select('*')` di `handleDayTradeScreenerRead`.
3. `enrichSignalQuality(r, 'Day Trade')` → `attachEntryStatus(r)` →
   `idxTick.deriveSignalVerdict(r)` (`api/sector-hot.js:4005`) — **dengan baris utuh**,
   termasuk `time_plan`.
4. `noteText` di `lib/idx-tick-normalization.js:837` memungutnya.

**Dampaknya lebih luas dari satu fungsi.** Teks yang sama juga dipungut tiga tempat lain
di `api/sector-hot.js`, dan semuanya memakai daftar kata yang mengandung `'chase'`:

| lokasi | akibatnya |
|---|---|
| `:4005` → `deriveSignalVerdict` | `signal_action` = `WAIT_PULLBACK`, `action_label` = **`Hindari`**, confidence dipaksa ke **C** |
| `:4182` → `deriveFinalTopQualityGate` | `addChip('Chase risk / Extended', -12)` — **penalti skor −12** |
| `:4031` → `deriveRiskReasonDetails` | alasan risiko keliru: "Chase risk after long candle" |
| `:4182` → `getPotentialRadarReason` | alasan radar keliru: `CHASE_RISK_MONITOR` |

Dan `action_label: 'Hindari'` lalu ditangkap `hasHindariAction()`
(`api/sector-hot.js:4396`), yang **memblokir kandidat itu dari Telegram dan Top 5**.

**Arah kegagalannya aman, tapi akibatnya tetap serius.** Ini gagal-**tertutup**: tidak
ada sinyal berbahaya yang terbit. Yang terjadi adalah **kandidat `PRE_SPIKE_WATCH` yang
sah ditekan secara sistematis** — diberi label "Hindari", dipotong skornya 12 poin, dan
diblokir dari publikasi, semata karena nasihatnya sendiri memuat kata "chase".

**Digabung dengan BUG-026, keluaran Day Trade tertekan dua kali:**

- **BUG-026** membuat `PRE_SPIKE_WATCH` nyaris tidak pernah tercapai untuk skor 70–74
  (kalah oleh cabang `EARLY_RADAR` yang ambangnya lebih rendah).
- **BUG-027** membuat yang *berhasil* mencapainya langsung dilabeli "Hindari".

Dua sebab yang berdiri sendiri, masing-masing sudah saya buktikan, dan keduanya menekan
jalur "priority opportunity" yang sama. Kalau Anda merasa sinyal Day Trade lebih sedikit
dari yang diharapkan, dua ini kandidat penjelasannya.

**Perbaikan yang diusulkan.** Jangan menyimpulkan keadaan pasar dari teks nasihat.
Urut dari yang paling saya rekomendasikan:

- **(a)** Buang `r.time_plan` dari `noteText` di `lib/idx-tick-normalization.js:837`.
  `time_plan` memang berisi instruksi, bukan pengamatan — sumber yang salah untuk
  mendeteksi keadaan. Field terstruktur `entry_status` (`CHASE_RISK`/`EXTENDED`) sudah
  memberi jawaban yang benar dan sudah diperiksa di baris yang sama.
- **(b)** Andalkan `entry_status` saja untuk `chaseExtended`, buang pencocokan teksnya.
  Paling bersih, tetapi menghapus lapis kedua yang mungkin diinginkan untuk sumber lain.
- **(c)** Terapkan hal yang sama pada tiga lokasi di `api/sector-hot.js` (`:4031`,
  `:4182` ×2) yang memungut `time_plan` untuk keperluan yang sama.

**Kenapa belum saya kerjakan.** Perbaikannya membuat kandidat `PRE_SPIKE_WATCH` berhenti
diblokir — artinya **lebih banyak sinyal terbit**. Itu perubahan perilaku bisnis yang
langsung terasa, dan aturan No. 8 Anda meminta saya bertanya lebih dulu. Berbeda dari
BUG-025 yang membuat gate lebih ketat, yang ini membuatnya lebih longgar — jadi justru
lebih perlu persetujuan Anda, bukan kurang.

**Verifikasi (kalau disetujui).** Test yang memberi kandidat sehat dengan `time_plan`
hasil `generateTimePlan('PRE_SPIKE_WATCH', ...)` dan memastikan hasilnya tetap
`ENTRY_AREA`/`Entry`; plus test bahwa kandidat yang benar-benar chase
(`entry_status = 'CHASE_RISK'`) tetap diblokir.

**Status** : DITEMUKAN — **menunggu keputusan Anda**

---

## BUG-028 — Jawaban Portofolio AI satu pengguna bisa tersaji ke pengguna lain

- **Severity** : **CRITICAL** (kebocoran data antar-pengguna, jalur produksi aktif)
- **Area** : Portofolio AI — cache jawaban (prioritas P2 Anda)
- **Lokasi** : `lib/context-ai-router-v7.js:393-399` (baca) dan `:419-426`, `:466-473`
  (tulis), memakai kunci dari `lib/ai-analysis-cache.js:24-32`
- **Status** : **SUDAH DIPERBAIKI** — PR #505 (`fix/ai-cache-cross-user-leak`), draft

### Gejala

Dua pengguna berbeda yang bertanya hal yang sama pada hari yang sama di menu
Portofolio AI bisa menerima jawaban yang identik — dan jawaban itu dihitung dari
**portofolio pengguna yang pertama bertanya**.

### Root cause

Jawaban `portfolio_chat` dibangun dari isi portofolio penanya sendiri. Isinya
lengkap — ticker, harga entry, stop loss, TP, **jumlah lot**, **modal**,
**estimasi rugi maksimal**, jurnal:

```js
// lib/context-ai-router-v4.js:655-672 — portfolioContext
const plans = (Array.isArray(input.plans) ? input.plans : []).slice(0, 25).map((p) => {
  ...
  return {
    ticker,
    entry: number(p.entryPriceIdr != null ? p.entryPriceIdr : p.entry),
    stop_loss: number(p.stopLossIdr != null ? p.stopLossIdr : p.stop),
    lots: number(p.lots),
    estimated_max_loss: number(p.estimatedMaxLossIdr != null ? p.estimatedMaxLossIdr : p.riskBudgetIdr),
    capital: number(p.capitalIdr),
    ...
```

Jawaban itu lalu disimpan ke cache yang **dipakai bersama semua pengguna** —
tabel Supabase `ai_analysis_cache` (diakses dengan service-role key, tanpa RLS
per pengguna) plus satu `Map` tingkat proses yang hidup selama container Vercel
hangat.

Kuncinya tidak memuat portofolionya sama sekali:

```js
// lib/ai-analysis-cache.js:24-32 — computeCacheKey
const ticker = String(params.ticker || '').toUpperCase().trim();
const analysisType = String(params.analysisType || 'stock_analysis').trim().toLowerCase();
const prompt = String(params.prompt || '').trim();
const marketDate = String(params.marketDate || new Date().toISOString().slice(0, 10)).trim();
const extra = params.extra ? JSON.stringify(params.extra) : '';

const raw = analysisType + '|' + ticker + '|' + marketDate + '|' + prompt + '|' + extra;
return crypto.createHash('sha256').update(raw).digest('hex');
```

Dan pemanggilnya tidak pernah mengisi `extra`:

```js
// lib/context-ai-router-v7.js:393-399 (sebelum perbaikan)
const cached = await getCachedAnalysis({
  ticker,
  analysisType,
  prompt: message,
  marketDate
});
```

Untuk `portfolio_chat`, `ticker` bernilai `null` (`context.ticker` tidak ada pada
konteks portofolio), `extra` kosong. Yang tersisa sebagai pembeda hanyalah
**tanggal** dan **kalimat pertanyaannya**.

Pembacaan cache itu terjadi di **langkah 1** handler — sebelum identitas
pemanggil pernah dilihat sama sekali. Penulisannya (`:419` jalur streaming,
`:466` jalur JSON) memakai kunci yang sama.

### Dampak

Pertanyaan pada menu Portofolio AI sebagian besar berupa kalimat baku
("evaluasi portofolio saya", "berapa risiko saya"), sehingga tabrakan bukan
kasus langka — justru kasus yang biasa. Yang bocor bukan sekadar teks umum:
jawaban model memuat angka yang diturunkan dari holding penanya pertama —
ticker, jumlah lot, modal, dan estimasi rugi maksimal.

TTL bawaannya 4 jam (`DEFAULT_TTL_SECONDS`), dan handler menulis dengan
`ttlSeconds: 4 * 3600`, jadi satu jawaban bertahan sepanjang satu sesi
perdagangan.

### Bukti

`test/ai-cache-cross-user-isolation.test.js` menjalankan handler sungguhan ujung
ke ujung — provider Gemini di-stub di batas modul (`lib/ai-gemini-provider`),
tanpa Supabase, memori cache dibersihkan per uji. Dua portofolio berbeda
(BBCA 10 lot vs GOTO 4.000 lot), pertanyaan sama, tanggal sama.

Sebelum perbaikan, 6 dari 10 uji isolasi gagal, sementara empat uji
"cache masih bekerja" lolos:

```
ok     1 - the stub wiring works: a first ask reaches the model, not the cache
ok     2 - the same user asking twice is served from the cache (the cache still works)
not ok 3 - user B is NOT served the answer computed from user A portfolio
not ok 4 - and the leaked answer is not merely relabelled: B must not be a cache hit on A
ok     5 - the same portfolio content from a different object identity still hits the cache
not ok 6 - adding a position invalidates the cached answer
not ok 7 - changing only the lot size invalidates the cached answer
not ok 8 - an empty portfolio does not collide with a populated one
ok     9 - a different question on the same portfolio is still separated
not ok 10 - the streaming path is isolated too
```

Uji 10 penting: jalur streaming (yang dipakai UI) bocor sama persis.

### Perbaikan

Satu fungsi `buildCacheParams` menjadi satu-satunya tempat identitas cache
dibentuk — dipakai oleh pembacaan di atas dan **kedua** penulisan di bawah,
supaya keduanya tidak bisa lagi bergeser sendiri-sendiri (pergeseran seperti itu
sendiri adalah kelas bug: menulis dengan satu kunci, membaca dengan kunci lain).

Untuk sumber yang membawa konteks privat, kunci ditambah `extra.ctx` — digest
SHA-256 dari konteks yang sudah dinormalisasi plus `styleRules`. Serialisasinya
stabil terhadap urutan properti, jadi portofolio yang isinya sama tetap berbagi
satu entri; ini yang dijaga uji 2 dan 5, supaya perbaikannya bukan sekadar
"matikan cache-nya".

Konteks yang tidak bisa diserialisasi **gagal-tertutup** ke tag unik per
permintaan, bukan kembali ke kunci bersama (uji 14).

### Yang sengaja tidak diubah

Jalur `stock_analysis_followup` tetap memakai bentuk kunci lama, dan itu
dipastikan byte-identik oleh uji 11. Konteksnya data pasar publik untuk satu
ticker pada satu tanggal, sudah diwakili `ticker + market_date + prompt`;
melebarkannya hanya mengurangi cache-hit tanpa menutup kebocoran apa pun.

**Catatan terpisah, belum saya kerjakan** — pada jalur itu snapshot analisis dan
`styleRules` juga tidak ikut kunci, sehingga jawaban bisa berasal dari snapshot
beberapa jam sebelumnya, atau memakai gaya bahasa pengguna lain. Itu soal
**kesegaran dan gaya**, bukan kebocoran data. Memperbaikinya berarti cache-hit
pada jalur inilah — sumber penghematan token terbesar — yang ikut turun. Saya
menunggu keputusan Anda, dan tidak mengerjakannya di PR ini karena satu PR = satu
kelompok masalah.

### Risiko

Cache-hit untuk `portfolio_chat` akan turun: sekarang hanya mengena kalau isi
portofolio **dan** pertanyaannya sama persis. Itu memang harga yang benar —
"hit" yang hilang itu sebelumnya adalah jawaban yang salah. Tambahan panggilan
Gemini hanya pada jalur portofolio.

**Rollback**: revert satu commit. Tidak ada migrasi, tidak ada perubahan skema,
tidak ada perubahan `.env`. Baris cache lama tetap ada dan kedaluwarsa sendiri
dalam 4 jam; saya tidak menyentuh data produksi.

### Verifikasi

`node tools/run-build-test-suite.js` → **320 berkas uji lolos**, sebelum dan
sesudah. Delta: +1 berkas, +14 uji, 0 gagal. Tiga uji lama yang menyemai cache
dengan kunci tanpa konteks (`test/ai-gemini-provider-and-cache.test.js`,
`test/ai-cache-telemetry.test.js`, `test/ai-streaming-response.test.js`) kini
menyemai memakai kunci yang benar-benar dibentuk router, sehingga maksud aslinya
utuh.

### Tambahan setelah membaca `lib/context-ai-router-v4.js` sampai tuntas

Dua hal yang mempertajam temuan ini, keduanya saya periksa sesudah PR #505 dibuka.

**Pertama — batas jangkauannya.** Kebocoran ini terjadi **antar pengguna premium
yang sudah login**, bukan terbuka untuk anonim. Pintu masuknya dijaga lebih dulu:

```js
// api/analyze.js:106-115
if (req && req.method === 'POST') {
  const allowed = await requireAnalyzeAccess(req, res);
  if (!allowed) return;
}
...
return await handleContextAI(await prepareContextRequest(req), res);
```

`requireAnalyzeAccess` → `requirePremiumEntitlement` → `resolvePremiumAccess` →
`requireNonBlockedUser` → `requireAuthenticatedSession`. Jadi penyerang harus
punya akun premium yang aktif dan tidak diblokir. Itu **tidak** menurunkan
tingkat keparahannya — data yang bocor tetap holding finansial pengguna lain —
tetapi batasnya perlu disebut apa adanya.

**Kedua — dan ini yang paling menentukan: repo ini sudah punya obatnya, di
modul yang sama, di rantai yang sama.** `lib/context-ai-router-v4.js` — yang
dipanggil v7 lewat v6 dan v5 — menyusun kunci cache-nya begitu:

```js
// lib/context-ai-router-v4.js:855-859 — requestKey
function requestKey(userId, source, task, message, context, historyRows) {
  return crypto.createHash('sha256').update(JSON.stringify({
    userId, source, task, message: message.toLowerCase(), context: cacheKeyContext(context), historyRows
  })).digest('hex');
}
```

`userId` **dan** seluruh konteks ikut di kunci. Penulisnya bahkan sudah
memikirkan bagian yang halus — field mana yang harus dikeluarkan supaya cache
tetap bisa mengena:

```js
// lib/context-ai-router-v4.js:830-836 — komentar aslinya
// The cache key must describe WHAT was asked about, not WHEN. `captured_at` is
// stamped fresh on every hydration and `age_minutes` ticks every minute, so
// hashing them verbatim gave every request a unique key: the positive cache
// never hit ...
// The freshness CLASSIFICATION is semantic and stays in the key, because an
// answer built on a stale price is not interchangeable with one built on a
// fresh price.
```

Jadi cache v7 bukan keputusan desain yang berbeda — ia **regresi** terhadap
implementasi yang sudah benar dan sudah ada di berkas yang diimpornya sendiri.
Ini pola yang sama yang sudah empat kali muncul di audit ini: **mesin intinya
ditulis benar; bug-nya ada di lapisan yang memakai atau meniru mesin itu.**

---

## Catatan (bukan bug) — `isSameOrigin` ada di jalur v4, tidak ada di jalur v7

- **Sifat** : pertahanan berlapis yang hilang, **tidak** dapat dieksploitasi hari ini
- **Lokasi** : `lib/context-ai-router-v4.js:558` vs rantai `api/analyze.js:109`

`verify()` di v4 memeriksa asal permintaan sebelum apa pun:

```js
// lib/context-ai-router-v4.js:558-560
async function verify(req) {
  if (!isSameOrigin(req)) return { ok: false, status: 403, error: 'Permintaan ditolak.' };
  const auth = requireAuthenticatedSession(req);
```

Jalur v7 tidak lewat `verify()`. Ia dijaga `requireAnalyzeAccess`, dan seluruh
rantainya (`requirePremiumEntitlement` → `resolvePremiumAccess` →
`requireNonBlockedUser` → `requireUserSession` → `requireAuthenticatedSession`,
`lib/subscription-auth.js:9-100`) **tidak memanggil `isSameOrigin` sama sekali**.

**Kenapa saya tidak menyebutnya bug.** Cookie sesinya `SameSite=Strict`:

```js
// lib/admin-session.js:178-182
function cookieFlags() {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (isProduction()) flags.push('Secure');
  return flags;
}
```

Permintaan lintas-situs tidak akan pernah membawa cookie itu, jadi CSRF-nya
mustahil terlepas dari ada atau tidaknya pemeriksaan `isSameOrigin`. Komentar di
`isSameOrigin` sendiri (`lib/admin-session.js:163`) menyatakan hal yang sama:
ketika header asal tidak tersedia ia sengaja tidak memblokir, "rely on SameSite
cookie". Lapisan kedua ini juga membutuhkan content-type JSON, yang tidak bisa
dikirim `<form>` lintas-situs tanpa preflight CORS.

**Kenapa tetap saya catat.** Kalau suatu saat `SameSite` dilonggarkan menjadi
`Lax` — misalnya untuk mendukung alur pembayaran atau OAuth yang kembali dari
domain lain — jalur v4 masih terlindung dan jalur v7 tidak. Menambahkan satu
baris `isSameOrigin` di `requireAnalyzeAccess` akan menyamakan keduanya. Saya
**tidak** mengerjakannya: tidak ada bug yang sedang berjalan, dan menambah
pemeriksaan asal pada endpoint produksi bisa memutus klien yang sah kalau ada
pemakaian yang belum saya lihat. Kalau Anda mau, saya kerjakan sebagai PR
terpisah.

### Hipotesis yang dibantah di sini

`timedOutCount` di `lib/context-ai-router-v4.js:1047` membaca `x.timed_out`
(snake_case), sementara `callModel` mengembalikan `timedOut` (camelCase).
Sekilas seperti selalu bernilai 0, yang akan membuat `AI_ALL_MODELS_TIMED_OUT`
tidak pernah muncul. **Tidak benar** — `runModels` menerjemahkannya saat
mendorong ke `attempts`:

```js
// lib/context-ai-router-v4.js:877-882
attempts.push({
  model, status: result.status, ok: result.ok, latency_ms: result.latency,
  reason: result.reason || null, timed_out: Boolean(result.timedOut),
```

Saya catat supaya pembaca berikutnya tidak menelusuri ulang jalur yang sama.

### Yang perlu saya tanyakan

Saya **tidak** menghapus baris `ai_analysis_cache` bertipe `portfolio_chat` yang
sudah tertulis sebelum perbaikan ini. Baris itu tidak akan pernah dibaca lagi
oleh kode baru dan kedaluwarsa sendiri dalam ≤4 jam. Kalau Anda ingin
membersihkannya lebih cepat, itu keputusan Anda — saya tidak menyentuh data
produksi tanpa persetujuan.

---

## Catatan: hipotesis yang dibantah — chain `context-ai-router` v4/v5/v6 bukan orphan

Anda menyebut versi lama router AI sudah **dihapus** di PR #434 dan meminta saya
mencurigai sisa import yatim. Saya periksa, dan pada kondisi repo sekarang
**tidak begitu**: v4, v5 dan v6 masih ada dan masih dipakai — bukan sisa, tapi
rantai delegasi aktif.

```js
// lib/context-ai-router-v7.js:14-15
const handleContextAIV6 = require('./context-ai-router-v6');
const handleContextAIV4 = require('./context-ai-router-v4');
```

```js
// lib/context-ai-router-v6.js:15
const handleContextAIV5 = require('./context-ai-router-v5');
```

```js
// lib/context-ai-router-v5.js:502
const handleContextAIV4 = require('./context-ai-router-v4');
```

Dan v7 tidak hanya mengimpor v4 untuk berjaga-jaga — ia memanggil isinya di jalur
utama, termasuk untuk membangun konteks dan prompt setiap permintaan:

```js
// lib/context-ai-router-v7.js:305-307
const context = source === 'stock_analysis_followup'
  ? handleContextAIV4._test.stockContext(body.context)
  : handleContextAIV4._test.portfolioContext(body.context);
```

Satu-satunya pintu masuk produksi adalah `api/analyze.js:4`, dan itu menunjuk ke
v7. Jadi: tidak ada import yatim di sini, tetapi juga **tidak benar** bahwa versi
lama sudah dihapus — menghapus salah satu dari v4/v5/v6 sekarang akan
mematikan Analisis Saham dan Portofolio AI. Saya catat ini supaya asumsi itu
tidak dipakai sebagai dasar pembersihan.

Satu-satunya rujukan yang memang tinggal nama ada di
`tools/apply-production-hotfixes.js:57-58`, dan itu daftar berkas untuk sebuah
alat hotfix, bukan `require`.

---

## REKOMENDASI-01 — HTML buatan model dikirim mentah lalu dibersihkan dengan regex (utang teknis)

- **Sifat** : rekomendasi arsitektural, **bukan** temuan bug. Saya **tidak** menemukan bypass yang berhasil pada kode setelah PR sanitizer saya.
- **Lokasi** : `lib/analyze-legacy.js:836` (`sanitizeOutput`) dan `public/index.html:10560` (`sanitizeAIHtml`)

### Apa yang saya lihat

Jalur Analisis Saham lama mengembalikan **HTML yang ditulis model** apa adanya:

```js
// lib/analyze-legacy.js:360
return res.status(200).json({ html: sanitizeOutput(html, fcaConfirmed, intent), intent: intent, ... });
```

Nama `sanitizeOutput` menyesatkan. Isinya pembersih **format dan konten**, bukan
keamanan — ia mengurus bintang markdown, guard FCA, header laporan yang bocor,
paragraf kosong. Ia **tidak pernah** menyentuh `<script>`, atribut `on*`,
`javascript:`, `<iframe>`, atau `<base>`. Satu-satunya lapisan keamanan ada di
klien: `sanitizeAIHtml` (`public/index.html:10560`).

### Hipotesis yang dibantah

Saya menduga ada jalur render yang melewati sanitizer. Tiga tempat memakai
`data.html` tanpa memanggil `sanitizeAIHtml` secara langsung
(`public/index.html:5607`, `:5748`, `:5818`) — tapi ketiganya lewat
`addAIBubble`, dan `addAIBubble` membersihkan di dalamnya:

```js
// public/index.html:6040 — di dalam addAIBubble
var sanitizedHtml = sanitizeAIHtml(clientSanitizeFCA(html));
```

Dua jalur sisanya (`:3354`, `:3830`) memanggilnya langsung. Jadi **tidak ada
jalur render yang melewati sanitizer**. Saya catat supaya tidak ditelusuri ulang.

### Kenapa tetap saya angkat

Dua hal yang tidak berubah walau semua jalur sudah tertutup:

**Pertama, sanitizer berbasis regex rapuh secara struktural.** Repo ini sudah
membuktikannya sendiri dua kali. Komentar di `public/index.html:10569`
mencatat bypass entity-encoding yang pernah lolos, dan PR
`fix/ai-html-sanitizer-handler-bypass` menutup tiga bentuk pemisah atribut yang
diterima tokenizer HTML tetapi tidak oleh regex lama:

```html
<img/src=x/onerror=...>
<img src=x/onerror=...>
<img src="x"onerror=...>
```

Dua bypass yang sudah ditemukan pada satu fungsi yang sama adalah pola, bukan
kebetulan.

**Kedua, ada transformasi yang berjalan SESUDAH sanitizer.**

```js
// public/index.html:6041-6043
sanitizedHtml = normalizeFinalStockHtml(sanitizedHtml);
```

`normalizeFinalStockHtml` (`:10385`) menyisipkan `<br>` dan spasi ke dalam
string yang sudah dibersihkan. Menulis ulang string HTML setelah sanitasi adalah
pola yang secara umum melahirkan mutation-XSS. **Saya sudah mencoba dan tidak
berhasil membuat bypass lewat jalur ini** — sisipannya hanya `<br>` dan spasi,
dan di dalam nilai atribut (berkutip maupun tidak) karakter `<` tetap literal
menurut tokenizer. Jadi ini saya sebut sebagai risiko struktural, **bukan
kerentanan**. Saya menolak menaikkannya menjadi temuan tanpa PoC yang jalan.

### Yang saya sarankan (tidak saya kerjakan)

Repo ini **sudah punya jawabannya**, di modul yang lebih baru:
`public/ai-chat-renderer.js` tidak pernah mempercayai HTML dari model. Ia
menerima **teks**, meng-escape lebih dulu, baru menerapkan markdown:

```js
// public/ai-chat-renderer.js:110-117 — inlineFormat
function inlineFormat(value) {
  var html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
```

Dengan urutan itu tidak ada regex yang perlu menebak apa yang berbahaya —
tidak ada markup model yang pernah menjadi markup. Menyeragamkan jalur Analisis
Saham lama ke pola yang sama akan menghapus seluruh kelas masalah ini.

**Kenapa tidak saya kerjakan sekarang.** Ini refactor besar yang menyentuh
tampilan produksi: template `decision-card`/`decision-grid`, guard FCA, dan
belasan normalizer label teknikal semuanya bergantung pada model yang benar-benar
mengeluarkan HTML. Mengubahnya bukan perbaikan bug, dan aturan 7 Anda menyuruh
saya mencatatnya sebagai rekomendasi, bukan menjalankannya. Kalau Anda mau ini
dikerjakan, saya sarankan bertahap: mulai dari jalur chat bebas (paling tidak
bergantung template), bukan dari jalur analisis penuh.

---

## BUG-029 — Angka apa pun di pesan dibaca sebagai harga saham

- **Severity** : **HIGH** (jalur produksi aktif, terlihat pengguna, prioritas P1 Anda)
- **Area** : Analisis Saham — kartu deterministik `stock_fixed_report` dan `ihsg_fixed_report`
- **Lokasi** : `lib/analyze-legacy.js:201` (saham) dan `:138` (IHSG)
- **Status** : **SUDAH DIPERBAIKI** — PR #506 (`fix/analyze-price-scraped-from-any-number`), draft

### Gejala

Kartu Analisis Saham bisa menampilkan harga yang sama sekali bukan harga saham
itu — dan seluruh level teknikalnya kosong (`—`) padahal seharusnya terisi.

### Root cause

Kartu deterministik dibangun dari blok `[Auto-Cuan Market Data]` yang ditempel
browser. Blok itu **hanya ada kalau fetch quote di browser berhasil**:

```js
// public/index.html:5597-5598
var quoteCtx = await fetchQuoteContext(ticker);
if (quoteCtx) enrichedMsg += quoteCtx;
```

Kalau gagal, server jatuh ke aturan ini:

```js
// lib/analyze-legacy.js:201
var priceMatch = chatMessage.match(/\b(\d{2,6})\b/);
if (priceMatch) extractedPrice = parseFloat(priceMatch[1]);
```

```js
// lib/analyze-legacy.js:138
var ihsgPriceMatch = chatMessage.match(/\b(\d{4,5}(?:\.\d+)?)\b/);
```

Angka 2–6 digit **pertama di mana pun dalam pesan** menjadi harga:

| Pesan pengguna | Harga yang dipakai | Seharusnya |
|---|---|---|
| `beli 100 lot BBCA harga sekarang 9250` | **100** | 9250 |
| `BBCA gimana prospek 2026?` | **2026** | (tidak ada) |
| `IHSG proyeksi 2026 gimana?` | **2026** | (tidak ada) |

### Dampak — yang membuatnya HIGH dan bukan sekadar angka salah

Server mengambil quote otoritatifnya sendiri **hanya kalau ia masih belum punya
harga**:

```js
// lib/analyze-legacy.js:211-212
// Server-side fallback: fetch stock quote directly only if still no data
if (!stockData || !stockData.last) {
  var ssStockQuote = await fetchServerSideQuote(detectedStockTicker);
```

Jumlah lot yang terpungut **memenuhi** syarat itu. Jadi `fetchServerSideQuote`
dilewati — padahal itu satu-satunya sumber yang akan mengembalikan harga benar
**berikut** MA20/50/100/200, RSI14, support dan resistance.

Jadi bug ini mengubah situasi yang sepenuhnya bisa dipulihkan (quote browser
gagal → server ambil sendiri → kartu lengkap dan benar) menjadi kartu dengan
harga salah dan seluruh level teknikal `—`.

**Yang TIDAK terjadi, supaya saya tidak melebih-lebihkan:** entry/SL/TP tidak
dikarang dari harga palsu itu. Saya periksa `buildStockFixedTemplate`
(`:1095-1200`): tanpa `support1`/`resistance1`/`ma20` semua level jadi `—`, dan
keputusannya jatuh ke cabang netral `Tunggu Konfirmasi / Watchlist`. Jadi yang
salah adalah **harga yang ditampilkan** dan **kelengkapan kartu**, bukan angka
rencana trading. Saya tetap menilai HIGH karena harga yang ditampilkan adalah
angka paling dasar di halaman itu, dan `quote_last_used` yang dikembalikan API
ikut salah.

### Urutan sumber yang terbalik

`body.context.currentPrice` — harga dari analisis **sebelumnya** — dulu diperiksa
sebelum quote server (`:203-205`). Jadi harga basi bisa mendahului harga hidup.

### Perbaikan

`extractStatedPrice(message, ticker)` hanya menerima harga yang benar-benar
**dinyatakan**: berlabel (`harga sekarang`, `harganya`, `di harga`, …), atau
ticker yang langsung diikuti angka (`BBCA 9250`), atau satu-satunya angka dalam
pesan yang tidak mengandung apa pun lain yang bisa dikira harga. Blok
`[Info: ...]` dan `[Auto-Cuan ...]` tidak pernah ditambang.

Kalau tidak ada yang memenuhi syarat hasilnya `null` — dan `null` itulah yang
membuat quote otoritatif akhirnya diambil.

**Repo ini sudah punya obatnya, di browser.** `detectPrice()`
(`public/index.html:5199`) sudah menyelesaikan masalah ini dengan benar sejak
awal, dengan prioritas berlabel lalu `TICKER <angka>`. Perbaikannya meniru
aturan itu, sehingga divergensi antara "apa yang browser anggap harga" dan "apa
yang server anggap harga" hilang. Ini pola yang sama untuk **kelima** kalinya di
audit ini: yang benar sudah ditulis di satu tempat, yang salah adalah tiruan
yang lebih kasar di tempat lain.

Urutan sumber sekarang: blok Market Data → harga yang dinyatakan → quote server →
`context.currentPrice` (terakhir).

Sekalian: pemisah ribuan dan desimal dibedakan, jadi `"7.850,25"` tidak lagi
menjadi `785025`.

### Verifikasi

`test/analyze-stated-price-extraction.test.js`, **19 uji**. Uji 0 menerapkan
aturan lama secara harfiah untuk mendokumentasikan cacatnya. Suite:
**320 berkas uji lolos**, sebelum dan sesudah. Delta +1 berkas, +19 uji.

### Yang perlu Anda putuskan

Sekarang pertanyaan seperti `"BBCA gimana prospek 2026?"` — tanpa quote browser
**dan** dengan quote server ikut gagal — berakhir tanpa harga sama sekali,
sehingga tidak ada kartu template dan jalur AI yang menjawab. Sebelumnya selalu
ada kartu, tapi kartu yang berbohong. Saya memilih tidak menebak. Kalau Anda
lebih suka selalu ada kartu, saya bisa tambahkan pesan eksplisit "harga belum
tersedia" alih-alih diam — bilang saja.

---

## BUG-030 — Satu pesan Telegram gagal meracuni seluruh batch Top 5

- **Severity** : **HIGH** (jalur produksi aktif; sinyal terkirim berhenti dipantau)
- **Area** : pengiriman Telegram → registrasi monitor entry/TP/SL
- **Lokasi** : `lib/telegram-delivery.js:762-786` (`finalizePreparedDelivery`), dipicu dari `api/sector-hot.js:6512`
- **Status** : **SUDAH DIPERBAIKI** — PR #507 (`fix/telegram-delivery-batch-poisoning`), draft

### Gejala

Sinyal Top 5 yang **sudah masuk** ke Telegram bisa berhenti dipantau untuk
entry, TP1, TP2 dan SL — tanpa error apa pun yang terlihat. Sekaligus, pesan
yang benar-benar gagal terkirim tidak pernah bisa dikirim ulang.

### Root cause

Jalur Top 5 malam mengirim **beberapa** pesan untuk satu batch: satu header,
satu kartu per kandidat, dan (mode watchlist) satu footer.

```js
// api/sector-hot.js:5887 — header
var sendResult = safePicks.length > 0 ? await telegramNotifier.sendTelegramMessage(header) : ...;
var telegramResults = [sendResult];
```

```js
// api/sector-hot.js:5941 — satu kartu per kandidat
var detailResult = await telegramNotifier.sendTelegramMessage(finalDetailText, { timeout_ms: 2500 });
telegramResults.push(detailResult);
```

Semuanya diserahkan ke `finalizePreparedDelivery`, yang meringkasnya menjadi
**satu** state lalu menuliskannya ke **setiap** baris:

```js
// lib/telegram-delivery.js:762-786 (sebelum perbaikan)
var status = 'DELIVERY_RETRYABLE';
if (classified.delivered) status = 'WAITING';
else if (classified.uncertain) status = 'DELIVERY_UNCERTAIN';
...
var saved = await supabase
  .from('telegram_daily_picks')
  .update(update)        // satu status untuk semua
  .in('id', ids);
```

Dan agregatnya menghitung header serta footer seolah-olah keduanya baris
kandidat:

```js
// lib/telegram-delivery.js:220-224
if (summary.sent_count > 0 && summary.sent_count < classified.length) {
  summary.delivery_state = 'delivery_uncertain';
}
```

Untuk 5 kandidat ada 6 hasil (header + 5 kartu). Kalau **satu saja** gagal —
termasuk header — `sent_count` menjadi 5 dan `classified.length` 6, sehingga
seluruh 5 baris ditandai `DELIVERY_UNCERTAIN` dengan `first_sent_at` tetap
`null`.

### Dampak

Ini bukan status kosmetik. Dua konsekuensi, keduanya diam:

```js
// lib/telegram-delivery.js:330-336 — monitorRowIsTrackable
var status = normalizeDeliveryStatus(row);
if (status.indexOf('DELIVERY_') === 0) {
  return false;
}
```

Sinyal yang **sudah terkirim** ke pengguna tidak lagi masuk pemantauan
entry/TP1/TP2/SL.

```js
// lib/telegram-delivery.js:284-292 — rowBlocksRetry
return (
  status === 'DELIVERY_PENDING' ||
  status === 'DELIVERY_IN_PROGRESS' ||
  status === 'DELIVERY_UNCERTAIN' ||
  status === 'DELIVERY_FAILED'
);
```

Pesan yang **benar-benar gagal** juga terkunci: tidak pernah bisa dikirim ulang.

Kasus yang paling mungkin terjadi justru yang paling bersih: **header gagal,
kelima kartu kandidat sukses** — kelima baris ditandai tidak pasti, dan tidak
satu pun dipantau. Header dikirim dengan `sendTelegramMessage(header)` tanpa
`timeout_ms` eksplisit, sedangkan kartu kandidat memakai `timeout_ms: 2500`.

### Jangkauan — hanya Top 5

Saya periksa keempat pemanggil satu per satu. Hanya jalur Top 5
(`api/sector-hot.js:6512`) yang meneruskan **banyak** hasil. Tiga lainnya —
Day Trade (`:12682`), Swing Konglo (`:13537`), Swing Non-Konglo (`:13736`) —
mengirim **satu** pesan untuk seluruh batch dan meneruskan satu `send_result`;
di sana `classified.length === 1` dan agregatnya memang jawaban yang benar.
Ketiganya tidak terkena, dan tidak saya ubah.

### Perbaikan

`finalizePreparedDelivery` menerima `row_results` opsional, sejajar dengan
`preparation.row_ids`, berisi hasil pengiriman masing-masing baris. Status
ditulis per kelompok status, bukan satu untuk semua. Baris tanpa hasil sendiri
tidak pernah dicatat terkirim — ia tetap `DELIVERY_RETRYABLE`. Tanpa
`row_results`, perilakunya persis seperti sebelumnya (dijaga uji 8 dan 13).

`sendDailyTop5Telegram` mengembalikan `per_candidate_results`, sejajar indeksnya
dengan array `picks` yang ia terima — yaitu `top5DeliveryPrep.send_candidates`,
yang sejajar pula dengan `row_ids`.

### Verifikasi

`test/telegram-delivery-per-row-status.test.js`, **13 uji**. Sebelum perbaikan
**7 gagal**. Uji 1, 8 dan 10 lolos di kedua sisi: uji 8 membuktikan perbaikannya
bukan sekadar mengubah perilaku lama, dan uji 10 mengikat status ke akibat
nyatanya lewat `monitorRowIsTrackable()` dan `rowBlocksRetry()`.

Suite: **320 berkas uji lolos**, sebelum dan sesudah. Delta +1 berkas, +13 uji.

### Yang perlu Anda putuskan

Baris yang **terlanjur** ditandai `DELIVERY_UNCERTAIN` oleh bug ini tidak
diperbaiki oleh PR #507 — saya tidak menyentuh data produksi. Kalau Anda mau,
saya siapkan query **baca-saja** untuk menghitung berapa banyak baris seperti
itu ada dan sejak kapan, lalu Anda yang memutuskan apakah perlu diperbaiki:

```sql
select date, monitor_source, count(*)
from telegram_daily_picks
where status = 'DELIVERY_UNCERTAIN' and first_sent_at is null
group by date, monitor_source
order by date desc;
```

---

## Catatan (bukan bug) — pemasangan baris hasil INSERT berdasarkan indeks

- **Sifat** : ketahanan, **tidak** terjangkau pada PostgreSQL
- **Lokasi** : `lib/telegram-delivery.js:611-616`

```js
inserted.forEach(function(row, index) {
  prepared.push({
    row: row,
    candidate: toInsert[index].candidate
  });
});
```

Baris hasil `INSERT ... RETURNING *` dipasangkan ke kandidatnya **berdasarkan
posisi array**. Ada penjaga jumlah tepat di atasnya
(`if (inserted.length !== toInsert.length)`), tapi tidak ada penjaga urutan.

**Kenapa saya tidak menyebutnya bug.** PostgreSQL mengembalikan baris `RETURNING`
untuk `INSERT ... VALUES (...), (...)` sederhana dalam urutan `VALUES`-nya, dan
itulah bentuk yang dipakai PostgREST di sini. Saya tidak menemukan cara
membuatnya berbeda. Jadi ini **tidak terjangkau**, bukan cacat aktif.

**Kenapa tetap saya catat.** Kalau suatu saat urutannya berbeda, kandidat akan
dipasangkan ke baris yang salah — dan konsekuensinya persis sekelas BUG-030:
pesan ticker A dicatat pada baris ticker B, monitor melacak plan yang keliru.
Perbaikannya gratis: cocokkan dengan kunci identitas (`ticker|monitor_source|plan_lock_id`)
yang sudah dihitung tepat di atas, bukan dengan indeks. Saya tidak
mengerjakannya karena tidak ada bug yang sedang berjalan, dan diff-nya menyentuh
jalur publikasi. Bilang saja kalau Anda mau.

---

## Catatan (bukan bug) — rentang entry dirender tiga cara berbeda di satu modul

- **Sifat** : ketidakkonsistenan tampilan; format utamanya **sengaja dikunci uji**, jadi saya tidak mengubahnya
- **Lokasi** : `lib/telegram-templates.js:414`, `:281-283`, `:691`, `:724`

Dalam satu berkas yang sama, zona entry yang sama dirender tiga cara:

```js
// :414 — formatSignalCard (kartu sinyal utama)
lines.push('Entry: ' + fmtPrice(e1) + ' / ' + fmtPrice(e2));   // e1 = Math.max, e2 = Math.min  -> TINGGI dulu
```

```js
// :281-283 — formatMonitorHitMessage (notifikasi entry tersentuh)
var eLow = Math.min(entry1, entry2);
var eHigh = Math.max(entry1, entry2);
return 'harga masuk area entry ' + fmtPrice(eLow) + '-' + fmtPrice(eHigh);   // RENDAH dulu
```

```js
// :691 — formatMonitorUpdateMessage (pantauan berkala)
lines.push('Entry: ' + fmtPrice(p.entry1) + ' | Last: ' + fmtPrice(p.last));  // hanya batas ATAS
```

`formatRadarDigestMessage` (`:724`) mengikuti pola kartu sinyal (tinggi dulu).

### Kenapa saya TIDAK menyebutnya bug dan TIDAK mengubahnya

Format kartu sinyal **dikunci oleh uji repo ini sendiri**:

```js
// test/telegram-templates.test.js:162
assert.match(msg, /Entry: Rp5\.050 \/ Rp5\.000/);
```

```js
// test/telegram-templates.test.js:169
assert.match(withAtr, /Entry: Rp2\.900 \/ Rp2\.870/);
```

Jadi ini keputusan yang disengaja, bukan kekhilafan. Dan pemisahnya `/`, yang
terbaca sebagai "atau", bukan `–` yang secara tipografis berarti rentang. Urutan
tinggi-dulu juga konsisten dengan konvensi `entry1` = batas atas
(`api/sector-hot.js:3519`) dan masuk akal untuk zona limit-buy: "beli maksimal di
5.050, idealnya 5.000".

**Ini berbeda dari BUG-016 yang sudah saya perbaiki**, dan saya perlu menyatakan
itu dengan jelas supaya tidak terlihat seperti standar ganda. Di BUG-016 tabel web
mencetak `entry1–entry2` dengan **en-dash** — tanda yang secara tipografis berarti
rentang — sehingga rentang menurun benar-benar terbaca salah, dan tidak ada uji
yang menguncinya. Di sini pemisahnya `/` dan formatnya dikunci uji. Dua kasus yang
berbeda, dan saya memperlakukannya berbeda.

### Yang mungkin ingin Anda putuskan

Yang tersisa adalah ketidakkonsistenannya, bukan formatnya: pengguna melihat
kartu sinyal (`Rp5.050 / Rp5.000`, tinggi dulu) lalu — kalau harga masuk zona —
notifikasi monitor (`Rp5.000-Rp5.050`, rendah dulu) untuk zona yang sama persis.
Dan pantauan berkala hanya menampilkan batas atas dengan label "Entry" polos,
yang bisa dibaca sebagai satu harga entry tunggal.

Kalau Anda mau diseragamkan, saya sarankan menyeragamkan **notifikasi monitor**
mengikuti kartu sinyal (bukan sebaliknya), karena kartu sinyal yang dikunci uji
dan yang paling sering dilihat. Itu perubahan kecil di dua tempat, plus
memperbarui satu uji. Saya tidak mengerjakannya tanpa kata Anda karena ini
mengubah teks yang dikirim ke pengguna.

---

## BUG-031 — Alert watchlist bisa diarahkan ke chat Telegram siapa pun

- **Severity** : **HIGH** (keamanan; penyalahgunaan bot resmi untuk mengirim pesan ke pengguna lain)
- **Area** : watchlist pengguna → alert Telegram
- **Lokasi** : `lib/user-watchlist-service.js:308` (`createAlert`), dikirim di `:471-479` (`evaluateActiveUserAlerts`), dipanggil dari `api/sector-hot.js:8098`
- **Status** : **SUDAH DIPERBAIKI** — PR #508 (`fix/watchlist-alert-arbitrary-chat-id`), draft

### Gejala

Pengguna Auto-Cuan bisa menerima pesan alert dari bot resmi untuk ticker yang
tidak pernah ia pasang — dikirim atas perintah pengguna lain, berulang sesuai
jadwal cron.

### Root cause

Handler HTTP meneruskan body permintaan **apa adanya**:

```js
// api/sector-hot.js:8097-8099 — handleUserWatchlistAlert
var payload = req.body || {};
var createRes = await userWatchlistService.createAlert(supabase, userId, payload);
```

Dan `createAlert` mempercayai `notification_chat_id` dari body itu:

```js
// lib/user-watchlist-service.js:308-318 (sebelum perbaikan)
let chatId = payload.notification_chat_id ? Number(payload.notification_chat_id) : null;
if (!chatId) {
  const tg = await supabase
    .from('app_user_telegram_verifications')
    .select('telegram_private_chat_id')
    .eq('user_id', userId)
    .maybeSingle();
  ...
}
```

Binding milik pengguna hanya dicari **kalau body tidak menyebutkan tujuan**.
Nilai yang tersimpan itulah yang dipakai pengirimnya:

```js
// lib/user-watchlist-service.js:471-479 — evaluateActiveUserAlerts
if (alert.notification_chat_id) {
  ...
  const sendRes = await telegramNotifier.sendTelegramMessage(msg, {
    chat_id: alert.notification_chat_id,
    timeout_ms: 3000
  });
```

`telegramNotifier` di sini adalah **bot Auto-Cuan utama** (`./telegram-notifier`),
bukan bot verifikasi.

### Dampak, dengan batasnya dinyatakan jujur

Satu pengguna yang sudah login bisa membuat bot resmi produk ini mengirim pesan
ke chat pribadi pengguna lain, terjadwal dan berulang, dengan isi yang sebagian
ia tentukan (ticker dan level harga muncul di dalam pesan).

Dua batas yang harus disebut supaya tidak melebih-lebihkan:

- Butuh akun yang **sudah login dan tidak diblokir** (`requireNonBlockedUser`,
  `api/sector-hot.js:8090`). Ini bukan lubang anonim.
- Bot Telegram hanya bisa mengirim ke chat yang **pernah memulai percakapan
  dengannya**. Jadi sasaran praktisnya sesama pengguna bot Auto-Cuan, atau grup
  tempat bot itu anggota — bukan sembarang nomor Telegram.

Justru batas kedua itu yang membuatnya relevan: sasaran yang bisa dijangkau
persis adalah **pengguna lain produk ini**.

### Masalah sekelas, satu baris di bawahnya

```js
// lib/user-watchlist-service.js:328 (sebelum perbaikan)
watchlist_id: payload.watchlist_id || null,
```

Kunci asing lain yang diterima dari body tanpa pemeriksaan kepemilikan.

### Perbaikan

Tujuan pengiriman adalah properti **akun**, bukan properti **permintaan**.
`notification_chat_id` dari body tidak dibaca sama sekali lagi; chat id selalu
di-resolve dari binding Telegram terverifikasi milik pengguna. Kalau akun belum
punya binding, alert memang tidak punya tujuan — itu jawaban yang benar, bukan
alasan memakai nilai dari permintaan. `watchlist_id` hanya disimpan setelah
terbukti milik pengguna itu.

### Kenapa ini no-op untuk pemakaian normal

Klien sungguhan hanya mengirim tiga field:

```js
// public/watchlist-runtime.js:275-279
body: JSON.stringify({
  ticker: ticker,
  condition_type: cond,
  target_price: price
})
```

Tidak ada pemanggil sah yang mengirim kedua field itu. Uji 4, 6 dan 7 lolos di
**kedua sisi** perbaikan.

### Verifikasi

`test/watchlist-alert-notification-target.test.js`, **7 uji**. Sebelum perbaikan
4 gagal. Suite: **320 berkas uji lolos**, sebelum dan sesudah. Delta +1 berkas,
+7 uji.

### Yang perlu Anda putuskan

Baris `app_user_alerts` yang terlanjur menyimpan `notification_chat_id` bukan
milik pemiliknya **tidak** diperbaiki oleh PR #508 — saya tidak menyentuh data
produksi. Query **baca-saja** untuk memeriksa apakah ini pernah dimanfaatkan:

```sql
select a.id, a.user_id, a.ticker, a.created_at
from app_user_alerts a
left join app_user_telegram_verifications v on v.user_id = a.user_id
where a.notification_chat_id is not null
  and (v.telegram_private_chat_id is null
       or a.notification_chat_id <> v.telegram_private_chat_id);
```

Kalau hasilnya kosong, tidak ada yang pernah memakainya.

---

## BUG-032 — Reset password oleh admin menyimpan hash mentah tanpa validasi

- **Severity** : **MEDIUM** (kualitas penyimpanan kredensial + kemungkinan akun terkunci diam-diam)
- **Area** : admin — aksi `reset_password`
- **Lokasi** : `lib/admin-users-handler.js:246-289`
- **Status** : **SUDAH DIPERBAIKI** — PR #509 (`fix/admin-reset-password-unprotected`), draft

### Gejala

Dua hal, keduanya diam:

1. Akun yang password-nya direset admin tersimpan dalam bentuk yang **bisa
   diputar ulang** sebagai hash login, sampai pemiliknya kebetulan login lagi.
2. Kalau nilai yang dikirim bukan 64-hex, akun itu **tidak bisa login lagi** —
   tanpa error di mana pun.

### Root cause

```js
// lib/admin-users-handler.js:249-251 (sebelum perbaikan)
if (!newPasswordHash) {
  return res.status(400).json({ success: false, error: 'Password hash diperlukan.' });
}
```

```js
// lib/admin-users-handler.js:284-287 (sebelum perbaikan)
const { error: updateError } = await supabase
  .from('app_users')
  .update({ password_hash: newPasswordHash })
  .eq('id', user.id);
```

Hanya dicek "tidak kosong", lalu ditulis apa adanya.

### Kenapa itu salah — repo ini menyatakan alasannya sendiri

```js
// lib/password-credential.js:5-8
// The leading "k" makes the stored value fail the public 64-hex client-hash
// validator, so a database value cannot be replayed directly as a login hash.
```

Dan ketiga jalur tulis kredensial lainnya memang memakainya:

| jalur | baris |
|---|---|
| daftar akun baru | `api/register-user.js:147` |
| upgrade saat login | `api/login-user.js:428` |
| reset via Telegram | `lib/reset-password-legacy-handler.js:252` |

Baris hasil reset admin justru mendarat di cabang **legacy**:

```js
// lib/password-credential.js:68-72 — verifyStoredCredential
const legacy = normalizeClientHash(stored);
if (!legacy) return { ok: false, needsUpgrade: false };
const ok = safeEqualText(legacy, clientHash);
return { ok, needsUpgrade: ok };
```

Nilai di kolom `password_hash` sama persis dengan yang dikirim klien saat login,
jadi siapa pun yang bisa membaca kolom itu (kunci service-role, backup, atau
kebocoran SQL di tempat lain) bisa memakainya langsung untuk login.

Validator yang tepat pun sudah ada dua berkas di sebelah
(`lib/reset-password-legacy-handler.js:72-75`).

### Batasnya, supaya tidak dilebih-lebihkan

Ini **bukan** eskalasi hak akses. Pemicunya harus sudah punya sesi admin, dan
admin memang berhak menetapkan password akun lain. Yang memburuk adalah
**kualitas penyimpanan** kredensial untuk akun yang direset admin — dan
kemungkinan terkunci diam-diam kalau nilainya malformed.

### Perbaikan

Body wajib membawa hash **klien** (64 hex); bentuk `k1...` yang sudah
terlindungi pun ditolak karena itu bentuk simpanan, bukan masukan. Yang ditulis
adalah hasil `protectClientHash`.

**Ini kali keenam pola yang sama muncul di audit ini**: hal yang benar sudah
ditulis di tiga tempat, satu tempat tidak ikut. Daftar sejauh ini —
`fetchDayTradeCandles` vs parser NK (BUG-022), `Number.isFinite` vs `|| 50`
(BUG-014), penjaga tukar entry ×4 vs 11 lokasi (BUG-021), `requestKey` v4/v5 vs
cache v7 (BUG-028), `detectPrice` browser vs regex server (BUG-029), dan
sekarang `protectClientHash` ×3 vs reset admin (BUG-032).

### Verifikasi

`test/admin-reset-password-credential.test.js`, **8 uji**. Sebelum perbaikan 5
gagal. Uji 3, 7 dan 8 lolos di kedua sisi (password salah tetap ditolak, hash
kosong tetap 400, akun `budi` tetap tidak bisa direset). Uji 2 membuktikan
perbaikannya tidak memutus login.

Suite: **320 berkas uji lolos**, sebelum dan sesudah. Delta +1 berkas, +8 uji.

### Yang perlu Anda putuskan

Baris yang sudah terlanjur tersimpan dalam bentuk legacy tidak diubah PR #509 —
saya tidak menyentuh data produksi. Baris itu akan ter-upgrade sendiri saat
pemiliknya login (`api/login-user.js:428`). Query **baca-saja** untuk
menghitungnya:

```sql
select count(*) from app_users where password_hash !~ '^k1[a-f0-9]{62}$';
```

---

## REKOMENDASI-02 — `security-gate` merah kalau registry npm sedang gangguan

- **Sifat** : kerapuhan CI, **bukan** bug aplikasi. Tidak saya perbaiki — mengubah kebijakan CI adalah keputusan Anda.
- **Bukti** : PR #496, commit `3ea3403`, job `security-gate` gagal

### Apa yang terjadi

```
Repository security audit passed: no tracked credential files or high-confidence secret patterns found.
...
npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Service Unavailable
{ error: 'Service Unavailable' }
npm error audit endpoint returned an error
##[error]Process completed with exit code 1.
```

Pemindai rahasia milik repo sendiri (`tools/repo-security-audit.js`) **lolos**.
Yang menggagalkan job adalah langkah berikutnya, `npm audit --omit=dev
--audit-level=high`, yang mendapat **503 dari registry.npmjs.org**.

### Kenapa saya angkat

Ini terjadi pada PR yang **hanya berisi dokumentasi** — `package.json` tidak
disentuh sama sekali, dan satu-satunya dependensi runtime repo ini adalah
`@supabase/supabase-js`. Artinya gangguan di npmjs.org membuat **setiap** PR
merah, apa pun isinya, termasuk keenam status check wajib Anda.

Kejadian ini sudah pulih sendiri: pada head #496 yang sekarang `security-gate`
kembali hijau tanpa saya ubah apa pun. Jadi tidak ada yang perlu diperbaiki
hari ini — tapi penyebabnya masih ada.

### Pilihan kalau Anda mau ini ditutup

Dua opsi, dengan trade-off berbeda:

1. **Toleransi kegagalan jaringan saja.** Jalankan `npm audit --json`, dan
   anggap gagal hanya kalau keluarannya benar-benar melaporkan kerentanan
   `high`/`critical` — bukan kalau perintahnya sendiri error. Gerbangnya tetap
   nyata, tapi tidak lagi bergantung pada ketersediaan registry.
   Risikonya: kalau audit tidak pernah berhasil dijalankan, kerentanan baru
   bisa lolos tanpa ada yang sadar, kecuali langkah itu juga mencetak peringatan
   yang terlihat.

2. **Biarkan seperti sekarang.** Merah palsu memang mengganggu, tapi tidak
   pernah meloloskan apa pun yang berbahaya, dan pulih sendiri saat registry
   normal.

**Rekomendasi saya: opsi 1**, dengan syarat langkah itu tetap mencetak
peringatan mencolok ketika audit tidak bisa dijalankan — supaya "tidak bisa
diperiksa" tidak diam-diam terbaca sebagai "aman". Saya tidak mengerjakannya:
ini menyentuh workflow CI dan keenam check wajib Anda, dan aturan 7 Anda
menyuruh saya mencatat utang seperti ini sebagai rekomendasi, bukan
menjalankannya.

---

## REKOMENDASI-03 — Fitur "Top 5 chart image" seluruhnya kode mati

- **Sifat** : utang teknis (kode mati). **Bukan** bug — tidak terjangkau, jadi tidak ada perilaku yang salah hari ini.
- **Lokasi** : `api/sector-hot.js:5177`, `:5599-5612`, `:5614-5626`, `:5628-5641`, `:5643-5680`

### Apa yang saya temukan

Pengirimnya tidak pernah dipanggil dari mana pun:

```js
// api/sector-hot.js:5643
async function sendTop5ChartAttachments(req, picks) {
```

Dan handler yang ia tuju tidak pernah dipasang di router:

```js
// api/sector-hot.js:5658 — satu-satunya penyebutan action ini di seluruh repo
var photoUrl = baseUrl + '/api/sector-hot?action=telegram-top5-chart-image&ticker=' + ...
```

```js
// api/sector-hot.js:5628
async function handleTelegramTop5ChartImage(req, res, supabase) {
```

Routernya rantai `if (action === '...')` eksplisit (`api/sector-hot.js:109-208`),
dan `telegram-top5-chart-image` tidak ada di dalamnya. Saya sapu seluruh repo di
luar `test/`: `sendTop5ChartAttachments`, `handleTelegramTop5ChartImage`,
`makeTop5ChartToken`, `verifyTop5ChartToken`, `buildTop5PhotoCaption` dan
`getRequestBaseUrl` **hanya** muncul di dalam kelompok fungsi ini sendiri.

Jadi: pengirim yang tidak dipanggil siapa pun, menunjuk ke handler yang tidak
dirutekan siapa pun.

### Kenapa saya catat, padahal tidak berbahaya

Dua alasan.

**Pertama, supaya pembaca berikutnya tidak salah alarm.** Kelompok ini
mengandung pola yang secara sekilas terlihat seperti SSRF:

```js
// api/sector-hot.js:5599-5603
function getRequestBaseUrl(req) {
  var proto = req.headers['x-forwarded-proto'] || 'https';
  var host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host;
}
```

URL yang dibangun dari header permintaan itu diserahkan ke Telegram, yang akan
mengambilnya dari sisi server lalu memposting hasilnya sebagai foto. Kalau kode
ini hidup, saya akan mengangkatnya sebagai temuan. Karena mati, tidak. Saya
tuliskan supaya tidak perlu ditelusuri ulang.

**Kedua, kalau fitur ini suatu saat dihidupkan lagi**, `getRequestBaseUrl` harus
diperbaiki lebih dulu: `x-forwarded-host` dan `host` sama-sama berasal dari
permintaan. Base URL sebaiknya diambil dari environment (`APP_BASE_URL`), bukan
dari header. Token HMAC-nya (`makeTop5ChartToken`) sendiri sudah benar — ada
kedaluwarsa dan diverifikasi terhadap ticker.

### Yang saya sarankan (tidak saya kerjakan)

Hapus kelima fungsi itu, atau hidupkan fiturnya dengan `getRequestBaseUrl`
diperbaiki lebih dulu. Aturan 7 Anda menyuruh saya mencatat utang seperti ini
sebagai rekomendasi, bukan mengeksekusinya — dan menghapus kode dari
`api/sector-hot.js` bukan keputusan yang pantas saya ambil sendiri. Bilang saja
kalau Anda mau salah satunya dikerjakan.

---

## BUG-033 — TTL 12 jam di luar jam bursa tidak pernah benar-benar berlaku

- **Severity** : **MEDIUM** (beban upstream, bukan kesalahan data)
- **Area** : cache OHLCV Day Trade (VPS/lokal)
- **Lokasi** : `lib/daytrade-ohlcv-cache.js:253-260`
- **Status** : **SUDAH DIPERBAIKI** — PR #510 (`fix/ohlcv-cache-offhours-ttl`), draft

### Gejala

Di luar jam bursa dan akhir pekan, setiap scan tetap menembak Yahoo lagi setiap
15 menit untuk data yang tidak mungkin berubah.

### Root cause

Modulnya menyatakan maksudnya sendiri:

```js
// lib/daytrade-ohlcv-cache.js:182-186
 * During IDX market hours (Mon-Fri 09:00-15:30 WIB), use the configured TTL.
 * Outside market hours, extend TTL significantly (12 hours)
 * since data won't change.
```

Tapi pemeriksaan sadar-jam-bursa itu dikurung **di dalam** pemeriksaan mentah:

```js
// lib/daytrade-ohlcv-cache.js:253-260 (sebelum perbaikan)
if (cached.hit && !cached.stale && cached.candles.length >= 20) {
  // Re-check with market-aware freshness
  if (isCacheFresh(cached.updatedAtMs, nowMs, ttlMs)) {
    stats.cacheHit++;
    return cached.candles;
  }
}
```

Sementara `cached.stale` dihitung terhadap `ttlMs` **mentah**, tanpa tahu jam
bursa:

```js
// lib/daytrade-ohlcv-cache.js:85-87
var age = nowMs - updatedAtMs;
var stale = !updatedAtMs || age > ttlMs;
```

Gerbang luar selalu lebih ketat daripada gerbang dalam, jadi jendela 12 jam tidak
pernah bisa melebarkan apa pun.

### Dampak

Bukan kesalahan data — di luar jam bursa candle memang tidak berubah, jadi
angka yang dipakai sama saja. Yang salah adalah **bebannya**: panggilan Yahoo
yang seharusnya tidak perlu, pada scan batch lintas banyak ticker.

Itu bukan biaya netral di sistem ini: timeout upstream pada provider yang sama
persis adalah isi BUG-018 (PR #502). Semakin banyak panggilan, semakin besar
paparan terhadap timeout dan rate limit yang sudah pernah menggigit.

### Perbaikan

Kesegaran diputuskan hanya oleh `isCacheFresh`, yang memang sudah menerapkan
`getEffectiveTtl`. Di dalam jam bursa perilakunya tidak berubah sama sekali.

### Dua uji lama ikut berubah — dan saya perlu menyatakannya terang

`test/daytrade-ohlcv-cache.test.js` punya dua uji yang memundurkan timestamp
cache 20 menit dan 1 jam lalu memastikan Yahoo dipanggil — memakai **jam dinding
sungguhan**. Keduanya sudah bergantung waktu sejak awal, dan selama ini lolos di
jam berapa pun **justru karena cabang sadar-jam-bursa itu tidak terjangkau**.
Begitu cabangnya hidup, keduanya gagal ketika dijalankan di luar jam bursa
(persis yang terjadi: 06:20 WIB).

Jamnya saya patok ke Kamis 11:00 WIB, sehingga "basi" berarti persis seperti yang
uji itu maksudkan. Maksud aslinya utuh; yang hilang hanya flake laten. Saya tidak
melemahkan, melewatkan, atau mengarantina uji apa pun.

### Catatan proses — harness uji pertama saya salah

Percobaan pertama saya menambal `module.exports.readCache`, padahal
`fetchWithCache` memanggil binding tingkat-modul, sehingga tambalannya tidak
berpengaruh. Hasilnya menyesatkan: enam uji gagal, termasuk beberapa yang
seharusnya lolos pada kode saat itu. Saya tidak memakai hasil itu — saya tulis
ulang harness-nya memakai direktori cache sementara sungguhan di disk, dan
barulah gambarannya benar: **tepat dua** yang gagal, keduanya kasus di luar jam
bursa.

Saya catat ini karena hasil pertama itu, kalau dipercaya, akan membuat saya
melaporkan cacat yang lebih besar daripada yang sebenarnya ada.

### Verifikasi

`test/daytrade-ohlcv-cache-offhours-ttl.test.js`, **9 uji**. Sebelum perbaikan
tepat 2 gagal. Tujuh yang lolos di kedua sisi — termasuk semua kasus "tidak
berubah" dan ketiga batas — itulah yang membuktikan perbaikannya sempit.

Suite: **320 berkas uji lolos**, sebelum dan sesudah. Delta +1 berkas, +9 uji.

---

## BUG-034 — Host header dari klien menentukan tautan review di Telegram admin

**Severity:** MEDIUM
**Area:** Subscription / pembayaran manual — notifikasi admin
**Status:** SUDAH DIPERBAIKI — PR #511

### Lokasi

`lib/subscription-manual-handler.js:45-51` (kode asli)

```js
function publicBaseUrl(req) {
  const configured = String(process.env.SUBSCRIPTION_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return host ? proto + '://' + host : 'https://autocuan.web.id';
}
```

Dipakai di `lib/subscription-manual-handler.js:142`:

```js
const reviewUrl = publicBaseUrl(req) + '/dashboard?paymentReview=' + encodeURIComponent(row.payment_reference);
```

dan dikirim sebagai tombol inline ke Telegram admin di `:144-146`:

```js
const sent = await sender.sendMessage(ADMIN_TELEGRAM_ID, paymentAdminText(row, username, 'submitted'), {
  reply_markup:{ inline_keyboard:[[{ text:'Buka & Konfirmasi', url:reviewUrl }]] }
});
```

### Gejala

Tombol "Buka & Konfirmasi" di chat admin dapat mengarah ke origin sembarang yang
ditentukan oleh orang yang mengirim permintaan `submit`.

### Root cause

`X-Forwarded-Host` dan `Host` sepenuhnya dikendalikan pengirim pada klien
non-browser. Satu-satunya guard adalah `isSameOrigin()` di
`lib/admin-session.js:164-176`, yang hanya membandingkan `Origin`/`Referer`
dengan `Host`:

```js
const u = new URL(candidate);
return u.host === host;
```

Menyetel keduanya ke nilai palsu yang **sama** akan lolos. Guard itu memang
dirancang melawan CSRF dari browser, bukan melawan pemalsuan header oleh klien
langsung — dan untuk CSRF ia bekerja. Yang keliru adalah menyimpulkan darinya
bahwa `Host` layak dipercaya.

### Dampak

Setiap akun yang sudah login dan tidak diblokir dapat memicunya. Ambang aksesnya
rendah: `requireSubscriptionOnboardingUser` di `lib/subscription-auth.js:120-126`
hanya menuntut sesi valid, username cocok, dan `is_blocked !== true` —
persetujuan (`is_approved`) tidak diperlukan, sesi onboarding pun cukup.

Tautan phishing tiba lewat kanal admin milik aplikasi sendiri, jadi tampak
tepercaya. Ini bukan pengambilalihan langsung, tetapi menempatkan tautan pilihan
penyerang di tempat yang paling dipercaya admin.

**Belum pasti:** apakah Vercel menimpa `x-forwarded-host` yang datang dari klien.
Saya tidak dapat memverifikasinya dari lingkungan ini — preview Vercel tidak
terjangkau lewat proxy. Terlepas dari itu, kode ini tidak seharusnya memercayai
header tersebut: mitigasi platform bukan sesuatu yang kita kendalikan, tidak kita
uji, dan bisa berubah tanpa kita ketahui.

### Perbaikan

Base URL kini diambil berurutan dari: `SUBSCRIPTION_PUBLIC_BASE_URL` (divalidasi
sebagai URL http/https sungguhan), lalu host dari header **hanya bila** ada di
allowlist (`autocuan.web.id`, `www.autocuan.web.id`, ditambah
`SUBSCRIPTION_ALLOWED_HOSTS`), lalu origin produksi kanonik.

### Risiko

Rendah. Bila `SUBSCRIPTION_PUBLIC_BASE_URL` sudah diset di produksi, perilaku
tidak berubah sama sekali. Bila tidak diset, deployment preview akan menaut ke
produksi alih-alih ke host preview — untuk tautan yang dikirim ke admin, itu
justru perilaku yang diinginkan.

### Verifikasi

6 dari 11 uji di `test/subscription-manual-admin-notification.test.js`; empat di
antaranya khusus untuk bug ini. Suite penuh 320 berkas lolos.

---

## BUG-035 — Notifikasi admin tak terbatas pada submit ulang pembayaran

**Severity:** MEDIUM
**Area:** Subscription / pembayaran manual — notifikasi admin
**Status:** SUDAH DIPERBAIKI — PR #511

### Lokasi

`lib/subscription-manual-handler.js:319-321` (kode asli)

```js
if (submitted.error || !submitted.data) return res.status(409).json({ success:false, error:'Konfirmasi transfer belum dapat dikirim.' });
const row = await paymentRow(db, reference);
const notified = row ? await notifyAdminSubmitted(req, db, row) : false;
```

### Gejala

Memanggil `submit` berulang kali dengan referensi yang sama mengirim pesan
Telegram baru ke admin setiap kali, tanpa batas.

### Root cause

Fungsi SQL `submit_manual_subscription_payment` bersifat idempoten. Untuk baris
yang sudah `submitted` ia mengembalikan data **tanpa mengubah apa pun** —
`supabase/subscription-manual-payment-migration.sql:166-168`:

```sql
IF m.status='submitted' THEN
  RETURN jsonb_build_object('payment_reference',m.payment_reference,'status',m.status,'submitted_at',m.submitted_at);
END IF;
```

Payload itu truthy, sehingga penjaga `if (submitted.error || !submitted.data)` di
`:319` lolos dan handler memperlakukannya seperti submit pertama.

Ini pola struktural yang sama yang sudah berulang dalam audit ini, dan kini yang
**ketujuh** kalinya: lapisan inti ditulis benar — SQL-nya idempoten dengan sengaja
— tetapi lapisan yang memakainya tidak ikut membaca sinyal idempotensi itu.
Bandingkan BUG-022, BUG-014, BUG-021, BUG-028, BUG-029, BUG-032.

### Dampak

1. Spam tak terbatas ke chat admin, dipicu oleh akun pengguna biasa.
2. Setiap pengiriman menimpa `admin_telegram_message_id` di `:149`. Akibatnya
   `updateAdminNotification()` (`:157-166`) saat approve/reject hanya menyunting
   pesan **terakhir**. Pesan "KONFIRMASI PEMBAYARAN" yang lebih lama tertinggal
   di chat admin dengan tombol yang masih hidup, meski pembayarannya sudah
   diputuskan — admin bisa membuka dan memproses ulang sesuatu yang sudah selesai.
3. Digabung dengan BUG-034, tautan yang dikendalikan penyerang dapat dibanjirkan,
   bukan dikirim sekali.

### Perbaikan

Notifikasi dilewati bila `admin_telegram_message_id` sudah tercatat. Pengiriman
yang gagal tidak mencatat id apa pun, sehingga percobaan ulang tetap diizinkan —
perilaku berguna itu sengaja dipertahankan dan diuji terpisah.

### Risiko

Rendah, dengan satu batas yang saya sebutkan terang-terangan: **sisa race yang
sempit masih ada.** Dua permintaan `submit` bersamaan yang sama-sama membaca
`admin_telegram_message_id` masih null dapat menghasilkan dua notifikasi. Itu
terbatas pada beberapa pesan, bukan tak terbatas. Perbaikan yang sepenuhnya
atomik menuntut kolom klaim baru, yaitu migrasi skema — tidak saya lakukan tanpa
persetujuan Anda (aturan 6).

### Verifikasi

2 dari 6 uji yang gagal sebelum perbaikan menyasar bug ini langsung; dua uji lain
memotret perilaku yang harus dipertahankan (submit pertama tetap memberi
notifikasi, percobaan ulang setelah kegagalan pengiriman tetap diizinkan). Suite
penuh 320 berkas lolos.

### Pertanyaan data (read-only, belum dijalankan)

```sql
SELECT payment_reference, status, admin_telegram_message_id, submitted_at, reviewed_at
FROM public.subscription_manual_payments
WHERE status = 'submitted' AND admin_telegram_message_id IS NOT NULL
ORDER BY submitted_at DESC
LIMIT 50;
```

---

## Modul yang dibaca penuh dan bersih pada putaran ini

### `lib/daytrade-outcome-collector.js` (535 baris) — bersih

Alat bukti offline yang dijalankan manual, bukan jalur web. Yang saya periksa:

- **Path.** `assertExternalPath` (`:107-124`) menolak path relatif, root, symlink
  di komponen mana pun (`assertNoSymlinkComponents`, `:97-105`), dan menolak
  target yang berada **di dalam** repo lewat `fs.realpathSync.native`. Ketat.
- **Ack berlapis.** `--execute`, `--market-day-confirmed`,
  `--continuous-segment-confirmed` semuanya wajib (`:141-143`).
- **Waktu.** `strictUtc` (`:126-131`) menuntut format UTC eksak, bukan sekadar
  `Date.parse`. Akhir pekan Jakarta ditolak dua kali — untuk tanggal bursa
  (`:152`) dan untuk saat eksekusi (`:394`). Horizon wajib sudah lewat (`:395`).
- **Validasi bar** (`:290-317`): ticker cocok, rentang di dalam horizon,
  urutan tidak mundur dan tidak tumpang tindih, `source_as_of` berada di antara
  akhir bar dan batas bukti, OHLC positif dan konsisten (`low` benar-benar
  terendah, `high` benar-benar tertinggi).
- **Anti duplikasi finalisasi** berlapis: kunci semantik (`:239-250`), audit
  pohon sebelum **dan** sesudah persiapan (`:399`, `:471-473`), serta deteksi
  tabrakan dalam satu batch (`:470`).

Satu catatan, bukan bug: `manifest.relative_path` di `:212` dan `:262` dipakai
lewat `path.resolve(root, ...)` tanpa dipastikan tetap di dalam `root`. Manifest
berasal dari pohon bukti milik operator sendiri, dan isi berkas tidak pernah
keluar dari proses (gunzip pada berkas non-gzip melempar dan ditangkap), jadi
tidak ada kanal kebocoran. Saya catat sebagai kekerasan defensif yang kurang,
bukan temuan.

### `lib/voucher-admin-bot.js` (333 baris) — bersih

- `adminUpdate` (`:42-51`) menuntut chat privat, `chat.id === from.id`, id admin
  Telegram yang tepat, dan menolak pesan yang diteruskan atau dikirim atas nama
  channel. Gate admin dijalankan **sebelum** dedupe update, sehingga update dari
  non-admin tidak menghabiskan `update_id`.
- Pengiriman kode voucher memakai sender mentah, sengaja **tidak** transient
  (`:252-254`), sementara semua prompt/menu bersifat transient. Pesan kode tidak
  pernah membawa `reply_markup`, jadi tidak pernah menjadi `q.message` dan tidak
  bisa terhapus oleh `cleanupOrigin`. Saya periksa titik ini secara khusus karena
  penghapusan yang salah akan menghilangkan kode voucher yang sudah dibuat.
- Siklus klaim → prepare → deliver → record → finalize menutup kasus tidak pasti
  lewat `markAttemptUncertain`, termasuk saat pencatatan sukses tetapi finalisasi
  gagal (`:277-282`).

Dua catatan kecil, bukan bug: konstanta `DOCUMENT_BYTES` (`:12`) tidak pernah
dipakai; dan jumlah voucher tidak dibatasi atas — `/^[1-9][0-9]*$/` di `:138` dan
`p_requested_quantity > 0` di
`supabase/subscription-phase-5c-voucher-admin-migration.sql:252` sama-sama tanpa
batas atas. Hanya admin yang bisa memicunya, terhadap datanya sendiri, dan chunk
diklaim 100 per penekanan tombol sehingga tidak ada proses liar. Saya catat
sebagai kebersihan operasional, bukan celah.

### `lib/telegram-unified-subscription.js` (332 baris) — bersih

- `privateMessage` (`:20-28`) menuntut chat privat dan `chat.id === from.id`.
- Kunci idempotensi diturunkan deterministik dari `update_id` dengan namespace
  terpisah untuk `trial`, `voucher-quote`, dan `voucher-redeem` (`:44-50`),
  sehingga pengiriman ulang webhook Telegram tidak menggandakan entitlement —
  dipasangkan dengan penjaga di
  `supabase/subscription-phase-2-migration.sql:224`.
- Gate admin voucher tetap `isVoucherAdminTelegramUser` (`:290`), meski
  klasifikasi `v:` diarahkan lebih dulu.

Satu catatan asimetri, bukan bug hari ini: pada `:242` voucher dianggap
"perlu bayar" hanya bila tipenya `PERCENT_30`/`PERCENT_50`, selebihnya langsung
ditebus. Di `lib/subscription-manual-handler.js:294` logikanya kebalikan dan
fail-closed. Untuk keempat tipe yang ada sekarang keduanya menghasilkan perilaku
benar; asimetri ini baru berbahaya bila tipe voucher baru ditambahkan. Saya
sebutkan agar tidak terlewat saat itu terjadi, bukan sebagai temuan.

### `lib/vouchers.js` (12 baris) — bersih

Kode `AC-` + 12 karakter dari alfabet 31 simbol tanpa karakter ambigu ≈ 59 bit;
brute force lewat `/voucher` tidak layak. `voucherCodeHash` fail-closed bila
`VOUCHER_CODE_PEPPER` tidak ada atau lebih pendek dari 16 karakter (`:8`), jadi
tidak ada mode diam-diam tanpa pepper.

### Catatan tentang SQL yang saya baca sambil lalu

`supabase/subscription-phase-2-migration.sql:226-228` menempatkan pemeriksaan
`IF NOT FOUND` **setelah** satu pernyataan `IF` lain. Dalam PL/pgSQL `FOUND` tidak
diubah oleh `IF` biasa, jadi perilakunya benar hari ini, dan voucher yang tidak
ada tetap berujung `voucher unavailable`. Saya sebutkan hanya sebagai urutan yang
rapuh, bukan bug — dan saya tidak mengusulkan mengubah migrasi yang sudah jalan.

---

## Koreksi angka cakupan

Laporan saya sebelumnya menyebut 54 SELESAI / 8 SEDANG / 716 BELUM. Angka
sebenarnya pada branch ini sebelum putaran ini adalah **52 SELESAI / 7 SEDANG /
719 BELUM** (total 778). Setelah putaran ini: **57 SELESAI / 7 SEDANG / 714
BELUM**. Angka yang benar adalah yang dihitung langsung dari `AUDIT_COVERAGE.md`
di atas.

---

## Putaran lanjutan — klaster entitlement dan akses admin: bersih

Sepuluh berkas dibaca baris pertama sampai terakhir, 1.241 baris. **Tidak ada
temuan.** Yang saya periksa, per berkas:

### `lib/entitlements.js` (68 baris)

Modul kecil yang menentukan siapa dapat Premium. Fail-closed di setiap cabang:

- `resolveEntitlements:61` — bila `account.id` bukan UUID, langsung kembali
  tanpa membaca database sama sekali, hasilnya free-only.
- `:65` — bila query gagal, yang diteruskan adalah `[]`, bukan error. Komentar di
  `:57-58` menyatakan niat itu secara eksplisit: *"Never turn a storage error
  into premium access."* Kodenya benar-benar melakukan itu.
- `isActive:17-22` — baris lifetime **wajib** ber-`expires_at` null; baris
  non-lifetime **wajib** punya `expires_at` yang finite dan belum lewat. Baris
  dengan bentuk campuran (misalnya plan_code tak dikenal yang di
  `subscription-phase-2-migration.sql:233` menghasilkan `expiry` NULL dan
  `lifetime` false) jatuh ke tidak-aktif, bukan ke aktif-selamanya. Ini persis
  arah kegagalan yang benar.
- Urutan prioritas `:46-51` lifetime → berbayar → trial sudah benar; trial tidak
  pernah menutupi paket berbayar.

Satu catatan, bukan bug: cabang `username === 'budi'` di `:37` dievaluasi
**sebelum** cek `is_blocked` di `:41`, jadi admin tidak bisa mengunci dirinya
sendiri lewat pemblokiran akun. Itu tampak disengaja untuk mencegah lockout.

### `lib/subscription-auth.js` (135 baris)

`requireNonBlockedUser:36-40` membandingkan username dari sesi bertanda tangan
dengan username tersimpan dan menolak bila tidak cocok — sesi lama yang
username-nya sudah berganti ikut tertolak. `requirePremiumEntitlement:96`
memakai `access.premium !== true`, bukan `access_level`, sehingga admin (yang
`access_level`-nya `'admin'`, bukan `'premium'`) tetap lolos. Saya cek seluruh
repo: satu-satunya perbandingan `access_level` di luar modul ini ada di
`public/subscription-access-gate-v1.js:30`, dan itu hanya untuk label tampilan.

### `lib/admin-access-legacy.js` (500 baris)

Sebelumnya berstatus SEDANG; kini dibaca penuh. Klaim utamanya benar:

- `requestAccess:151-177` memang **tidak pernah** memanggil `bot.sendMessage`.
  Pemanggil anonim hanya bisa membuat baris dorman.
- Pesan Telegram baru terkirim di `activateFromDeepLink:198-253`, dan hanya
  setelah `activate_admin_access_request` mencocokkan id Telegram pengirim
  dengan binding admin terverifikasi. Bila tidak cocok, balasan generik masuk ke
  chat **pengirim**, bukan chat admin.
- Approve/deny (`:318-383`) menyerahkan cek identitas ke SQL memakai
  `callback.from.id`, bukan sesuatu dari isi pesan.
- Dedupe webhook dijalankan di kedua jalur, dengan `completeWebhookUpdate` di
  blok `finally` sehingga status update selalu tercatat.
- `consumeAccess:257-270` menuntut ref berentropi tinggi **dan** cookie binding
  browser; keduanya di-hash sebelum menyentuh SQL.
- Sisi SQL (`supabase/admin-telegram-access-migration.sql:309-332`) menambah
  throttle per-IP (5 per 5 menit) dan batas global (100 per 5 menit).

**Yang paling menarik dari berkas ini bukan temuan, melainkan pembanding.**
`lib/reset-password-legacy-handler.js:297-306` menolak memakai `x-forwarded-for`
generik justru karena tidak terbukti tepercaya di luar Vercel, dan memilih
**tidak** menerapkan lapisan per-IP daripada membatasi berdasarkan nilai yang
bisa dipalsukan:

```js
function trustedRateLimitIp(req) {
  const header = req && req.headers && req.headers['x-vercel-forwarded-for'];
  const first = String(header || '').split(',')[0];
  return securityGuard.normalizeIp(first);
}
```

Itu penalaran yang tepat — dan persis penalaran yang tidak diterapkan di
`lib/subscription-manual-handler.js` (BUG-034). Jadi BUG-034 bukan celah yang
luput dari pengetahuan tim; repo ini **sudah** memiliki disiplinnya, hanya tidak
diterapkan di satu tempat. Ini kemunculan **kedelapan** dari pola struktural yang
sama dalam audit ini: satu lapisan benar, lapisan lain menirunya keliru.

### Enam berkas kecil, semuanya fail-closed

- `lib/subscription-identity.js` (18) — token 32 byte CSPRNG, hanya HMAC yang
  tersimpan, pepper wajib ≥16 karakter, metadata event dibatasi allowlist.
- `lib/voucher-admin-sender.js` (28) — mati bila token <16 karakter, timeout 8
  detik dengan `AbortController`, semua galat Telegram diseragamkan.
- `lib/subscription-capability.js` (57) — hanya string `"true"` persis yang
  mengaktifkan; `getVoucherAdminCapability` menuntut marker skema
  `phase5c-complete-v4` yang persis, sehingga migrasi lama tetap tertutup meski
  tabelnya kebetulan sudah ada.
- `lib/subscription-catalog.js` (45) — validasi harga dan jendela promo ketat.
- `lib/subscription-voucher-claim.js` (177) — lihat catatan di bawah.
- `lib/telegram-voucher-admin-continuation.js` (145) — backstop fail-closed;
  bentuk perintah admin tersembunyi dari non-admin ditelan diam-diam (`:78-80`).

### Satu catatan defensif yang sengaja saya turunkan dari "temuan"

`lib/subscription-voucher-handler.js:47-55` meneruskan kunci idempotensi milik
klien ke `redeem_subscription_voucher`, dan pencarian di
`supabase/subscription-phase-2-migration.sql:224` **tidak dibatasi `user_id`**:

```sql
SELECT * INTO r FROM public.subscription_voucher_redemptions WHERE redemption_idempotency_key=p_redemption_idempotency_key;
IF FOUND THEN RETURN jsonb_build_object('redeemed',true,'entitlement_id',r.entitlement_id); END IF;
```

Secara teori, mengirim ulang kunci milik orang lain menghasilkan
`redeemed: true` tanpa entitlement apa pun diberikan — sukses palsu.

Saya **tidak** melaporkannya sebagai bug, dan ini alasannya:

1. Tidak ada eskalasi hak: tidak ada entitlement yang dibuat untuk penyerang.
2. Tidak ada kebocoran data: `activationFacts` di
   `lib/subscription-voucher-claim.js:75-76` sudah membatasi pencarian dengan
   `id` **dan** `user_id`, jadi fakta milik korban tidak pernah ikut terkirim.
3. Tidak terjangkau dalam praktik: saya periksa seluruh frontend
   (`public/account-center-v1.js:318,337`,
   `public/subscription-manual-payment-v1.js:151,188`,
   `public/subscription-voucher-claim-v1.js:33`) — setiap panggilan memakai
   `randomUUID()` baru, dan UUID tidak bisa ditebak.

Yang tersisa hanyalah kekerasan defensif yang kurang, dan itu baru berbahaya
bila suatu saat ada klien yang menurunkan kunci secara deterministik. Saya catat
di sini supaya tidak terlewat kalau itu terjadi, bukan untuk menggemukkan daftar
temuan.

---

## BUG-036 — Timeout AI dimatikan sebelum body dibaca; permintaan bisa menggantung selamanya

**Severity:** HIGH
**Area:** AI — Analisis Saham (P1) dan Portofolio (P2)
**Status:** SUDAH DIPERBAIKI — PR #512

### Lokasi

`lib/ai-gemini-provider.js:260` (jalur streaming) dan `:82` (non-streaming),
kode asli:

```js
const res = await fetchFn(endpoint, { ..., signal: controller.signal });

clearTimeout(timer);

...
let accumulatedText = '';
if (res.body) {
  accumulatedText = await parseSseStream(res.body, options.onChunk);
}
```

### Gejala

Permintaan AI yang tidak pernah selesai dan tidak pernah memberi galat. Di jalur
streaming, browser memegang koneksi SSE terbuka yang berhenti mengirim chunk dan
tidak pernah menutup.

### Root cause

`AbortController` dipasang untuk membatasi keseluruhan operasi, tetapi timernya
dimatikan tepat setelah promise `fetch` selesai. `fetch` selesai begitu **header**
tiba, bukan setelah body habis dibaca — jadi seluruh pembacaan body berjalan
tanpa batas waktu.

Tidak ada lapisan di atasnya yang menutup celah ini.
`lib/context-ai-router-v7.js:393` dan `:449` menyerahkan seluruh pembatasan waktu
ke provider dan tidak memasang timeout sendiri.

### Dampak

1. Invokasi serverless menggantung tanpa batas.
2. **Fallback lokal tidak pernah jalan.** Blok `catch` di
   `lib/context-ai-router-v7.js:428-441` hanya berjalan bila ada yang dilempar.
   Di sini tidak ada yang dilempar — tidak ada yang gagal, semuanya hanya
   menunggu. Jadi jaring pengaman yang sudah ditulis dengan benar itu justru
   tidak pernah terpasang untuk mode kegagalan ini.
3. Pengguna melihat Analisis Saham atau Portofolio menggantung tanpa pesan galat
   dan tanpa jawaban cadangan.

Bentuknya cocok dengan keluhan P1/P2 Anda. Saya **tidak** mengklaim ini penyebab
persis dari yang Anda alami — saya belum melihat gejalanya langsung, jadi
**belum pasti**. Yang terbukti: kondisi menggantungnya nyata dan reprodusibel.

### Perbaikan

Jalur streaming memakai **timer diam**, bukan tenggat total: dipasang untuk
respons awal, lalu dipasang ulang setiap ada byte masuk. Yang dibatasi adalah
keheningan, bukan durasi total — tenggat total akan memotong jawaban panjang
yang sehat. Jalur non-streaming: timer kini menutupi fetch **dan** pembacaan
body, yang memang sudah menjadi arti dari satu `timeoutMs` yang dikirim
pemanggil. Keduanya dibersihkan di `finally`.

### Risiko

Rendah, **tetapi bukan nol, dan ini bagiannya.** Sebelum perbaikan, stream yang
diam tidak pernah dibatalkan. Sesudahnya, diam lebih dari `timeoutMs` (9 detik di
produksi) dibatalkan dan jatuh ke jawaban deterministik lokal. Bila Gemini pernah
berhenti lebih dari 9 detik **di tengah** jawaban yang sehat, permintaan itu kini
memakai fallback padahal dulu akhirnya berhasil.

Penilaian saya: jeda 9 detik di tengah stream `gemini-2.5-flash` sudah patologis,
dan fallback jauh lebih baik daripada menggantung. Kalau Anda ingin lebih
longgar, jendela diam bisa dipisahkan dari timeout koneksi — saya tidak menambah
parameter baru tanpa Anda minta.

### Verifikasi

`test/ai-gemini-stream-stall-timeout.test.js`, **10 uji**, 3 gagal sebelum
perbaikan. Ketiganya adalah kasus menggantung dan pada kode lama **menggantung
selamanya**; harness membungkusnya dengan penjaga `settlesWithin()` supaya
kegagalannya terlihat sebagai "tidak pernah selesai" alih-alih menggantungkan
seluruh suite.

Empat uji yang sudah lulus sebelum perbaikan sengaja mengunci perilaku yang
tidak boleh berubah. Yang terpenting: **"a slow but steadily progressing stream
is NOT aborted"** — sepuluh chunk, masing-masing di dalam jendela diam, totalnya
jauh melampauinya. Uji itu akan gagal kalau saya memilih tenggat total, dan
itulah sebabnya ia ada.

Suite: **320 berkas lolos**. Delta +1 berkas, +10 uji.

---

## Catatan proses — skrip patch saya sempat salah, dan hasilnya tidak saya pakai

Percobaan pertama menerapkan perbaikan BUG-036 memakai `str.replace` Python,
yang **mengganti semua kemunculan**, bukan yang pertama saja seperti di
JavaScript. `generateGeminiContent` dan `streamGeminiAnalysis` punya blok
`try { const res = await fetchFn(...) ... clearTimeout(timer);` yang identik
persis, sehingga satu penggantian menyentuh keduanya sekaligus dan penggantian
berikutnya tidak lagi cocok.

Skripnya berhenti di `assert` sebelum menulis apa pun, jadi berkasnya tidak
pernah rusak. Saya tulis ulang dengan memisahkan berkas menjadi dua bagian di
`function validateGeminiEndpoint` dan menuntut `count(old) == 1` di setiap
penggantian, supaya kesalahan seperti ini gagal keras alih-alih diam-diam
mengedit tempat yang salah.

Saya catat karena ini kedua kalinya dalam audit ini sebuah *tooling* saya sendiri
hampir menghasilkan laporan yang keliru (yang pertama: harness uji
`daytrade-ohlcv-cache`). Keduanya ketahuan karena hasilnya diperiksa, bukan
dipercaya.

---

## Ringkasan CI — kegagalan `security-gate` di PR #510 sudah pulih

Bentuknya **berbeda** dari REKOMENDASI-02. Yang dulu: HTTP 503 dari
registry.npmjs.org. Yang ini: HTTP **400** dengan pesan
`Invalid package tree, run npm install to rebuild your package-lock.json`,
muncul setelah langkah itu menggantung ~5 menit 15 detik.

Bukan milik PR #510, dan ini buktinya:

1. Diff PR #510 tidak menyentuh `package.json` maupun `package-lock.json` sama
   sekali — hanya `lib/daytrade-ohlcv-cache.js`, dua berkas uji, dan
   `tools/curated-build-tests.json`.
2. Dalam **job yang sama**, lima menit sebelumnya, `npm ci` sudah memeriksa
   pohon paket yang sama tanpa keberatan: *"added 9 packages, and audited 10
   packages in 2s / found 0 vulnerabilities"*. Jadi pohonnya tidak invalid;
   endpoint audit-nya yang menolak.
3. `tools/repo-security-audit.js` — pemindai rahasia milik repo sendiri — lulus
   di run yang sama.
4. Langkah yang persis sama lulus di PR #511 beberapa menit kemudian (2 menit 40
   detik, hijau).

Saya pakai satu kali jalan ulang yang diizinkan, dan hasilnya **hijau**. Tidak
ada komentar berdiri-mundur yang saya pasang di #510, karena tidak ada yang perlu
dimundurkan — kegagalannya pulih sendiri. Komentar untuk kasus ini sudah ada
satu di #496 dan tidak saya duplikasi.

Ini kejadian ketiga di dua PR. Usulan penanganannya tetap seperti di
REKOMENDASI-02, dan tetap menunggu keputusan Anda.

---

## BUG-037 — Orang luar tanpa akun bisa memblokir pairing laptop admin, terus-menerus

**Severity:** MEDIUM
**Area:** Akses admin — zero-link laptop pairing (jalur P0)
**Status:** **MENUNGGU KEPUTUSAN ANDA — belum saya perbaiki** (lihat alasannya di bawah)

### Lokasi

`supabase/admin-telegram-zero-link-pairing-migration.sql:277-291` (pencarian
kandidat) dan `:361-374` (persetujuan). Kedua tempat menghitung permintaan
pending secara **global**:

```sql
SELECT count(*)::integer INTO v_count
  FROM public.admin_command_pair_requests AS pr
 WHERE pr.state = 'pending'
   AND pr.expires_at > now();

IF v_count <> 1 THEN
  RETURN QUERY SELECT 'ambiguous'::text, ...;
  RETURN;
END IF;
```

Tidak ada penyaringan berdasarkan siapa yang membuat permintaan itu — memang
tidak bisa, karena pembuatnya belum teridentifikasi pada saat itu.

### Gejala

Admin mengirim `/akses`, dan alih-alih tombol "Hubungkan Laptop" selalu muncul
pesan *"Ada lebih dari satu browser yang sedang meminta pairing."* Pairing laptop
tidak pernah bisa diselesaikan, tanpa ada yang salah di sisi admin.

### Root cause dan keterjangkauan

Endpoint pendaftaran permintaan pairing dapat dicapai **tanpa autentikasi apa
pun**. `lib/admin-command-zero-link-browser.js:113-120` hanya menuntut
`isSameOrigin(req)` dan `pagePath === '/dashboard'`:

```js
if (!isSameOrigin(req)) return res.status(403).json({ success: false, state: 'rejected' });
const pagePath = String(req.body && req.body.pagePath || '');
if (pagePath !== '/dashboard' && pagePath !== '/dashboard/') { ... }
```

`isSameOrigin` (`lib/admin-session.js:164-176`) hanya membandingkan Origin dengan
Host, jadi klien non-browser lolos dengan menyetel keduanya sama. Itu memang
bukan cacat `isSameOrigin` — fungsinya melawan CSRF dari browser, dan untuk itu
ia bekerja.

**Yang membuat ini murah dan bisa dipertahankan tanpa batas:** limiter per-IP
(5 per 5 menit, `:189-198`) dan batas global (100 per 5 menit, `:200-207`) hanya
diperiksa pada jalur "belum ada baris untuk `pair_hash` ini". Bila `pair_hash`
sudah punya baris, fungsi masuk ke cabang `IF FOUND` dan **mendaur ulang baris
itu** (`:169-186`) tanpa menyentuh pemeriksaan rate limit sama sekali.

Jadi dua cookie tetap, di-poll setiap kurang dari 2 menit (`PAIR_TTL_MS`), dari
**satu** alamat IP, cukup untuk menjaga `count(pending) = 2` selamanya — dan
limiter per-IP tidak pernah ikut berbicara.

### Dampak

Jalur zero-link untuk menghubungkan laptop admin lumpuh selama serangan
berlangsung. Yang **tidak** terdampak, dan karena itu ini bukan penguncian total:

- tombol "📱 Buka di HP" di menu `/akses` yang sama — memakai grant token
  langsung, tidak lewat mekanisme pairing ini;
- jalur tantangan admin yang disetujui lewat Telegram di
  `lib/admin-access-legacy.js`.

Jadi: penolakan layanan pada satu dari beberapa jalur akses admin, oleh pihak
tanpa akun, berbiaya hampir nol, dan bisa dipertahankan terus-menerus.

### Mengapa saya TIDAK memperbaikinya sendiri

Aturan `v_count <> 1 → ambiguous` **bukan kelalaian**. Komentar di `:264-265`
menyatakannya sebagai keputusan sadar: *"multiple requests fail closed instead of
guessing which browser is the admin's."* Itu arah kegagalan yang benar, dan
melonggarkannya adalah keputusan keamanan, bukan perbaikan bug. Aturan 8 Anda
berlaku di sini, jadi saya berhenti dan bertanya.

### Dua opsi, dengan trade-off yang berbeda

**Opsi A — admin memilih di antara beberapa kandidat (rekomendasi saya).**
Ketika ada lebih dari satu permintaan pending, jangan menolak; tampilkan tombol
per kandidat berlabel `display_tag` masing-masing. Admin sudah diminta mencocokkan
ID itu dengan yang tampil di layar laptopnya — teksnya sudah ada di
`lib/admin-command-zero-link-pairing.js:122`: *"Pastikan ID ini sama dengan yang
tampil di halaman maintenance laptop."*

- Untung: serangan ini kehilangan dayanya sepenuhnya; permintaan orang luar hanya
  menjadi tombol yang tidak pernah ditekan admin.
- Rugi: memindahkan beban pembedaan ke mata admin. Bila admin menekan tanpa
  membaca ID, ia bisa menyetujui browser penyerang. Hari ini kesalahan itu
  mustahil karena sistemnya menolak duluan.
- Ukuran: perubahan sedang, menyentuh SQL **dan** menu Telegram.

**Opsi B — biarkan apa adanya, perbaiki hanya limiternya.**
Pindahkan pemeriksaan rate limit agar juga berlaku pada jalur daur-ulang, supaya
serangan menjadi lebih mahal.

- Untung: perubahan kecil, tidak menyentuh perilaku keamanan sama sekali.
- Rugi: **tidak menyelesaikan masalahnya.** Penyerang cukup memakai beberapa IP.
  Ini memperlambat, bukan menutup.
- Ukuran: kecil, hanya SQL.

**Rekomendasi saya: Opsi A**, karena hanya opsi itu yang benar-benar menutup
jalur serangannya, dan karena verifikasi `display_tag` sudah menjadi bagian dari
alur yang diminta ke admin — jadi kita tidak menambah kewajiban baru, hanya
mengandalkan yang sudah ada. Tapi ini menaruh satu keputusan keamanan di tangan
manusia yang sekarang dijaga mesin, dan itu keputusan Anda, bukan saya.

Kalau Anda tidak ingin keduanya sekarang, itu juga jawaban yang sah — dampaknya
terbatas pada satu jalur akses dan Anda punya dua jalur lain.

### Kueri read-only untuk melihat apakah ini pernah terjadi

```sql
SELECT date_trunc('hour', created_at) AS jam,
       count(*) AS permintaan,
       count(DISTINCT requester_ip_hash) AS ip_berbeda,
       count(*) FILTER (WHERE state = 'consumed') AS berhasil
FROM public.admin_command_pair_requests
WHERE created_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC
LIMIT 100;
```

Belum saya jalankan.

---

## Yang bersih pada putaran ini

### `lib/admin-command-zero-link-pairing.js` (323 baris)

Sisi Node-nya bersih. Yang saya periksa secara khusus, karena kalau salah akibatnya
berat: `finishPairCallback` (`:153-203`) **tidak** melakukan cek identitas admin di
JavaScript — ia langsung meneruskan `callback.from.id` ke RPC. Saya tidak
menganggap itu aman begitu saja; saya baca SQL-nya. Gate-nya memang ada di
`supabase/admin-telegram-zero-link-pairing-migration.sql:343-354`: `p_telegram_user_id`
wajib cocok dengan binding Telegram terverifikasi milik akun `budi`, dan bila tidak
cocok hasilnya `identity_mismatch`. Jadi pembagian tugasnya benar, bukan lubang.

Selain itu: dedupe webhook di setiap jalur dengan `completeWebhookUpdate` di
`finally`; `pairRequestRef` memvalidasi bentuk ref sebelum dipakai; dan
`handleOldLaptopCallback` (`:205-247`) sengaja mendahulukan permintaan browser
yang hidup di atas binding perangkat lama — itulah jalur pemulihan setelah data
situs dihapus, dan alasannya ditulis di komentar.

### `lib/admin-command-zero-link-browser.js` (221 baris)

Rahasia 32 byte CSPRNG, hanya hash SHA-256 yang tersimpan (`hashSecret:49-52`),
cookie `HttpOnly` + `SameSite=Strict` + `Secure` di produksi, dan IP hanya diambil
dari `x-vercel-forwarded-for` — disiplin yang sama dengan
`lib/reset-password-legacy-handler.js`, dan di sini diterapkan dengan benar.
Sesi hanya dibuat bila RPC mengembalikan `ok` **dan** username-nya persis `budi`
(`:161`), jadi ada dua penjaga, bukan satu.

Berkas ini bersih; keterlibatannya di BUG-037 adalah bahwa endpoint-nya memang
dirancang terbuka, dan itu memang keharusan alur ini — masalahnya ada di
penghitungan ambiguitas, bukan di sini.

---

## Catatan CI — CodeQL pada PR #511, sudah diperbaiki

CodeQL menandai berkas uji saya sendiri
(`test/subscription-manual-admin-notification.test.js`) dengan *"Incomplete URL
substring sanitization"* pada `!url.includes('evil.example.com')`.

Peringatannya mengenai assertion uji, bukan sanitizer — tetapi kelemahan yang
dijelaskan CodeQL nyata pada istilahnya sendiri: pemeriksaan itu lolos untuk
`https://autocuan.web.id/dashboard?paymentReview=evil.example.com`, dan yang lebih
penting, ia tidak pernah benar-benar mengunci **ke mana** tombol admin menunjuk.
Regresi yang mengalihkan tombol ke host ketiga akan lolos begitu saja.

Semua assertion URL di berkas itu kini mem-parsing URL dan membandingkan `origin`,
`protocol`, `host`, `pathname`, dan parameter `paymentReview` secara eksplisit.
Saya pastikan cakupan regresinya tidak melemah dengan mengembalikan
`publicBaseUrl()` ke bentuk lama: assertion yang sudah diperkuat tetap
menggagalkan 4 dari 11 uji. CodeQL kini hijau di head baru.

Ini bukan "menyenangkan linter" — assertion-nya memang lebih kuat sesudahnya.

---

## Klaster akses admin selesai — empat berkas terakhir, semuanya bersih

915 baris, dibaca baris pertama sampai terakhir. **Tidak ada temuan.**

### `lib/admin-maintenance-code-browser.js` (356) + `lib/admin-maintenance-code.js` (249)

Ini bentuk paling berisiko di seluruh permukaan autentikasi: **login dengan kode
6 digit**, ruangnya hanya 10⁶. Saya tidak menganggapnya aman karena "ada
attempts_remaining di responsnya" — saya baca SQL-nya dan hitung ruang
serangannya.

Yang benar-benar menjaganya, berlapis:

- **Maksimal 5 percobaan per grant.** `supabase/admin-telegram-maintenance-code-migration.sql:277-294`
  menaikkan `code_attempts` pada setiap tebakan salah dan mengunci di 5 dengan
  `state = 'expired'`:

  ```sql
  IF v_grant.token_hash IS DISTINCT FROM p_token_hash THEN
    v_attempts := v_grant.code_attempts + 1;
    UPDATE public.admin_command_login_grants AS g
       SET code_attempts = v_attempts,
           state = CASE WHEN v_attempts >= 5 THEN 'expired' ELSE g.state END,
  ```

- **TTL 2 menit** (`CODE_TTL_MS`), **sekali pakai** (`state = 'consumed'`), dan
  hanya **satu** grant pending yang pernah dipertimbangkan (`ORDER BY created_at
  DESC LIMIT 1`).
- **Kode hanya bisa diterbitkan oleh admin terverifikasi**, lewat `/akses` di
  Telegram, dan **hanya saat mode maintenance menyala**. Penyerang tidak punya
  cara menerbitkan grant baru.
- **Pepper wajib**: `hashCode` (`lib/admin-maintenance-code.js:23-30`) adalah
  HMAC-SHA256 dengan `SESSION_SECRET`, dan mengembalikan `null` bila secret tidak
  ada — sehingga fiturnya mati, bukan terbuka.
- `generateCode` memakai `crypto.randomInt(0, 1000000)` — CSPRNG dan seragam,
  bukan `Math.random`.
- Bahkan pada jalur sukses, SQL **memverifikasi ulang** bahwa binding Telegram
  admin masih ada sebelum mengembalikan `ok` (`:296-309`).

**Hitungan ruang serangannya:** selama satu kode hidup, penyerang punya 5 tebakan
dari 10⁶ → peluang 0,0005%. Untuk peluang yang berarti ia butuh ratusan ribu
grant, dan grant hanya lahir dari `/akses` milik admin. Jadi angka 6 digit di
sini aman **karena** batas percobaan dan penerbitan yang terkunci, bukan karena
panjang kodenya. Kalau salah satu lapis itu hilang, ini langsung jadi CRITICAL —
saya catat begitu supaya jelas apa yang sedang menahan beban.

Sisi browser juga rapi: `notify` dan `cleanup` menuntut sesi admin **dan**
kepemilikan baris — `loadOwnedGrant` (`:150-164`) membatasi dengan `id`,
`user_id`, **dan** `grant_purpose`, jadi satu ref tidak bisa dipakai menyentuh
grant milik jalur lain.

Satu detail desain yang saya periksa khusus karena mudah salah:
`cleanupOldMessages` menghapus pesan Telegram lama **setelah** OTP baru terkirim,
dan mengecualikan grant berjalan lewat `.neq('id', keepGrantId)`. Jadi
pembersihan tidak bisa menghapus kode yang baru saja dikirim ke admin.

### `lib/admin-command-login.js` (278)

Bersih. Yang menonjol, dan relevan dengan BUG-034:

```js
function canonicalBaseUrl() {
  const configured = String(process.env.AUTH_RECOVERY_BASE_URL || '').trim();
  if (configured) {
    try {
      const u = new URL(configured);
      if (u.protocol === 'https:' && u.hostname === 'autocuan.web.id') return 'https://autocuan.web.id';
    } catch (_) {}
  }
  return DEFAULT_BASE_URL;
}
```

URL login dibangun dari konstanta yang divalidasi, **tidak pernah** dari header
permintaan — persis disiplin yang hilang di `lib/subscription-manual-handler.js`.
Ini datapoint **ketiga** dalam repo ini (bersama `reset-password-legacy-handler.js`)
yang menerapkannya dengan benar, dan makin menegaskan bahwa BUG-034 adalah satu
tempat yang terlewat, bukan celah pengetahuan.

Selebihnya: identitas diperiksa lewat `adminContext` sebelum grant dibuat di
kedua jalur (`:129`, `:181`), token 32 byte CSPRNG dengan hanya hash yang
tersimpan, TTL 2 menit, dan dedupe webhook dengan `completeWebhookUpdate` di
`finally`.

### `lib/maintenance-state.js` (32)

Bersih, dan fail-closed **dua arah** — yang layak disebut karena mudah keliru:
galat penyimpanan menghasilkan `available: false`, bukan diam-diam "tidak sedang
maintenance"; dan hanya `maintenanceMode === true` yang persis yang menyalakan.
Pemanggil di `admin-maintenance-code-browser.js:181-187` memang membedakan
keduanya: `available:false` → 503, `enabled:false` → 409.

---

## BUG-038 — Retensi 7 hari foreign flow diam-diam tidak pernah benar-benar berlaku

**Severity:** LOW
**Area:** Ingestion foreign flow — admin CSV upload
**Status:** **MENUNGGU KEPUTUSAN ANDA — belum saya perbaiki** (alasannya: aturan 6)

### Lokasi

`lib/admin-foreign-upload.js:216-221`

```js
for (const tickerBatch of chunk(tickers, RETENTION_TICKER_BATCH_SIZE)) {
  const lookup = await supabase
    .from('foreign_watchlist_daily')
    .select('id,ticker,trade_date')
    .in('ticker', tickerBatch)
    .order('trade_date', { ascending: false });
```

Tidak ada `.limit()`, tidak ada anggaran baris, dan `RETENTION_TICKER_BATCH_SIZE`
tetap 50 tanpa memperhitungkan berapa tanggal per ticker.

### Root cause

Respons PostgREST dipotong di sisi server. Ini **bukan dugaan saya** — repo ini
sudah pernah kena, dan mencatatnya sendiri di `lib/foreign-flow-store.js:15-18`:

```js
// Keep every request comfortably below common PostgREST/Supabase max-row
// response caps. The old whole-universe query asked for ~7 * 771 rows in one
// response; a server-side 1,000-row cap could silently return only the newest
// session for most tickers, which made Foreign 7D equal Foreign Terbaru.
const SAFE_QUERY_ROW_BUDGET = 900;
```

Pembacanya sudah dibetulkan: batch dihitung dari `count`, dan `.limit(fetchLimit)`
dipasang eksplisit (`:41`, `:51`). Penulis retensinya tidak ikut dibetulkan.

Ini kemunculan **kesembilan** dari pola struktural yang sama dalam audit ini —
dan kali ini repo bahkan sudah punya catatan post-mortem tertulis yang menempel
pada implementasi yang benar, sementara implementasi yang salah ada di berkas
sebelah.

### Kapan ini benar-benar terjadi

Bukan teori. Satu upload boleh berisi sampai `MAX_ROWS = 5000` baris (`:6`).
Upload 50 ticker × 100 tanggal = 5.000 baris:

1. `upsertRows` menulis semuanya.
2. `enforceRetention` untuk 50 ticker pertama butuh 5.000 baris, tapi hanya
   menerima ~1.000 yang terbaru.
3. Per ticker terlihat ~20 tanggal: 7 disimpan, ~13 dihapus.
4. Sekitar 80 tanggal per ticker **tidak pernah terlihat**, jadi tidak pernah
   dihapus — dan pada upload berikutnya urutannya sama, jadi mereka tertinggal
   selamanya.

Dalam kondisi mapan (≤7 tanggal per ticker → 350 baris) tidak ada masalah.
Masalahnya muncul begitu tabel sempat menumpuk.

### Dampak — sengaja saya batasi, bukan saya besar-besarkan

**Arah kegagalannya aman: kode ini menghapus terlalu sedikit, tidak pernah
terlalu banyak.** Pemotongan membuang baris paling lama dari hasil, dan baris
yang tidak terlihat tidak masuk `deleteIds`.

**Konsumennya juga tidak terpengaruh.** `lib/foreign-flow-store.js:58` hanya
mengambil `count` baris terbaru per ticker, dan
`lib/daily-foreign-context.js` membatasi setiap jendela dengan `slice(0, n)`.
Jadi baris basi **tidak pernah** ikut masuk ke perhitungan Foreign 3D/5D/7D,
streak, atau apa pun yang menyentuh keputusan trading.

Yang tersisa: pertumbuhan penyimpanan, dan janji "retensi 7 hari" yang tidak
ditepati. Itu saja. Saya catat LOW karena memang segitu, bukan lebih.

### Perbaikan yang saya usulkan (belum diterapkan)

Samakan dengan disiplin pembacanya — hitung anggaran baris, dan paginasi sampai
habis:

```js
const RETENTION_KEEP_DATES = 7;
const RETENTION_ROW_BUDGET = 900;

// Sejajar dengan lib/foreign-flow-store.js: jangan pernah bergantung pada satu
// respons besar yang bisa dipotong PostgREST tanpa memberi tahu.
const perTickerBudget = Math.max(RETENTION_KEEP_DATES + 1, 32);
const tickerBatchSize = Math.max(1, Math.floor(RETENTION_ROW_BUDGET / perTickerBudget));

for (const tickerBatch of chunk(tickers, tickerBatchSize)) {
  let offset = 0;
  const collected = [];
  for (;;) {
    const lookup = await supabase
      .from('foreign_watchlist_daily')
      .select('id,ticker,trade_date')
      .in('ticker', tickerBatch)
      .order('trade_date', { ascending: false })
      .order('id', { ascending: true })     // urutan stabil saat tanggal seri
      .range(offset, offset + RETENTION_ROW_BUDGET - 1);
    if (lookup.error) throw new Error(`Retention lookup gagal: ${lookup.error.message}`);
    const batch = lookup.data || [];
    collected.push(...batch);
    if (batch.length < RETENTION_ROW_BUDGET) break;
    offset += RETENTION_ROW_BUDGET;
  }
  // ... sisanya seperti sekarang, memakai `collected`
}
```

Catatan: `order('id')` sekunder itu penting. Tanpa urutan tie-break yang stabil,
paginasi pada tanggal yang seri bisa melewatkan atau menggandakan baris di batas
halaman — dan kode sekarang pun tidak punya tie-break.

### Kenapa saya TIDAK menerapkannya sendiri

Karena efek nyatanya di produksi adalah **menghapus baris yang selama ini
menumpuk**. Itu masuk aturan 6 Anda: jangan menghapus data produksi tanpa
persetujuan. Secara niat, kode ini memang sudah seharusnya menghapusnya — tapi
"sudah seharusnya" bukan izin, dan jumlah yang terhapus pada upload berikutnya
bisa jauh lebih besar dari yang pernah terjadi selama ini.

Saya siapkan patch-nya, dan menunggu Anda.

### Kueri read-only untuk melihat berapa yang akan terhapus

Belum saya jalankan.

```sql
WITH ranked AS (
  SELECT id, ticker, trade_date,
         dense_rank() OVER (PARTITION BY ticker ORDER BY trade_date DESC) AS rnk
  FROM public.foreign_watchlist_daily
)
SELECT count(*) AS baris_di_luar_7_hari,
       count(DISTINCT ticker) AS ticker_terdampak,
       min(trade_date) AS tanggal_terlama
FROM ranked
WHERE rnk > 7;
```

---

## Yang bersih pada putaran ini

### `lib/admin-foreign-upload.js` — selain BUG-038

- **Gate admin ada, dan saya periksa di pemanggilnya**, bukan diasumsikan:
  `api/admin-users.js:158` memanggil `requireBudiAdmin(req)` sebelum
  `handleAdminForeignUpload`. Modul ini sendiri memang tidak punya cek auth, dan
  itu benar — tapi hanya karena pemanggilnya punya.
- Parser CSV (`:23-65`) menangani kutip berpasangan (`""`), CRLF, dan melempar
  bila kutip tidak ditutup — tidak diam-diam menerima baris rusak.
- Batas berlapis: 3 MB (`:113`), 5.000 baris (`:137`), ticker maksimal 12
  karakter dan hanya `[A-Z0-9]` (`:86-97`).
- Duplikat `tanggal|ticker` **ditolak** dengan galat (`:150-152`), bukan
  ditimpa diam-diam.
- `normalizeDate` memverifikasi ulang lewat round-trip
  `parsed.toISOString().slice(0,10) !== iso` (`:80`), jadi tanggal seperti
  `2026-02-31` tertolak, bukan bergeser diam-diam ke 3 Maret.

Satu catatan kecil, bukan bug: `foreign_net: close * nbsa` (`:163`) tidak
diperiksa `Number.isFinite` setelah perkalian, walaupun kedua faktornya sudah
diperiksa. Hanya bisa dipicu admin yang mengunggah angka absurd, dan hasilnya
galat penyimpanan, bukan data salah yang diam-diam masuk.

### `lib/foreign-flow-store.js` (73) — bersih

Justru menjadi pembanding untuk BUG-038: anggaran baris eksplisit, ukuran batch
diturunkan dari `count`, `.limit(fetchLimit)` terpasang, dan alasannya
didokumentasikan dengan insiden nyata. Ini contoh yang benar; masalahnya ada di
berkas sebelah yang tidak ikut dibetulkan.

### `lib/daily-foreign-context.js` (101) — bersih

Yang layak disebut: sesi yang hilang dihitung sebagai **missing**, bukan nol.
`sessions_missing` dan `foreign_net_7d_data_quality` ikut dikembalikan, sehingga
"tidak ada data" tidak pernah menyamar jadi "arus asing nol". Itu perbedaan yang
sering diabaikan dan di sini ditangani benar.

---

## PEMUTAKHIRAN BUG-038 — buktinya jauh lebih kuat dari yang saya tulis semula

Waktu menulis BUG-038 saya menyebut repo ini "sudah tahu tentang cap PostgREST".
Setelah membaca `lib/stock-daily-history-store.js`, kenyataannya lebih tajam:
**bug yang persis sama sudah pernah ditemukan dan diperbaiki di modul saudaranya**,
lengkap dengan catatan post-mortem. Yang tertinggal hanya satu berkas.

`lib/stock-daily-history-store.js:54-73`, docstring `enforceRetention`:

> *"this lookup query previously had NO `.limit()` at all, so on a deployment
> where PostgREST caps a single response around ~1,000 rows ... fetching an
> unbounded 'all history for up to 50 tickers, ordered by date' response would
> silently get truncated to mostly-recent rows ... **confirmed bug — retention
> was silently a no-op across the ticker universe** on any deployment large
> enough to hit the response cap."*

Bandingkan dengan `lib/admin-foreign-upload.js:216-221` hari ini: pola query yang
sama persis — `.in('ticker', tickerBatch).order('trade_date', {ascending:false})`
tanpa `.limit()`, dengan `RETENTION_TICKER_BATCH_SIZE = 50` yang juga sama.
Kalimat "all history for up to 50 tickers, ordered by date" di docstring itu
menggambarkan kode yang masih hidup di berkas sebelah.

Jadi urutannya: cap 1.000 baris ini sudah memakan korban **tiga kali** di repo
ini — `getLatestSessionsForTickers` (RSI jadi N/A), `foreign-flow-store`
(Foreign 7D sama dengan Foreign Terbaru), dan `stock_daily_history`
`enforceRetention` (retensi jadi no-op). Ketiganya diperbaiki.
`admin-foreign-upload.js` tidak ikut tersapu.

### Ini mengubah dua hal dalam rekomendasi saya

**Pertama, tingkat keyakinan.** Ini bukan lagi "secara teori bisa terpotong".
Repo Anda sendiri sudah mengonfirmasinya sebagai bug nyata, dua kali, dengan
gejala yang tercatat.

**Kedua — dan ini yang penting untuk aturan 6 Anda — kekhawatiran saya soal
"penghapusan besar sekaligus" ternyata sudah ada jawabannya di repo ini.**
Perbaikan yang sudah ada tidak menghapus seluruh backlog dalam satu tembakan.
Ia memakai `RETENTION_TRIM_HEADROOM = 100` (`:23-28`):

> *"How many rows PAST the retention boundary enforceRetention fetches per
> ticker on each run, so a ticker with an existing backlog ... drains down to
> the retention target over a handful of daily collector runs instead of at
> most 1 row/day."*

Artinya perbaikan untuk BUG-038 **bukan desain baru dari saya**, melainkan port
dari pola yang sudah teruji di repo ini — dan pola itu memang dirancang untuk
menguras backlog **bertahap**, bukan sekaligus. Itu memperkecil risiko yang
tadinya membuat saya berhenti.

### Rekomendasi saya sekarang: perbaiki

Sebelumnya saya netral. Sekarang saya merekomendasikan memperbaikinya, dengan
mem-port `enforceRetention` dari `stock-daily-history-store.js` apa adanya
(anggaran baris + `.limit(fetchLimit)` + headroom), bukan patch karangan saya
sendiri di catatan BUG-038 sebelumnya.

**Tetap saya tunggu persetujuan Anda**, karena efek nyatanya tetap penghapusan
baris produksi, dan aturan 6 Anda tidak membedakan apakah penghapusan itu "sudah
seharusnya terjadi". Bedanya sekarang: penghapusannya bertahap, polanya sudah
terbukti di produksi Anda sendiri, dan kueri read-only di catatan BUG-038 bisa
dipakai menghitung dulu berapa banyak yang akan terkena.

---

## BUG-039 — Baris tertua di jendela retensi selalu kehilangan `previous_close`

**Severity:** LOW
**Area:** Ingestion — `stock_daily_history`
**Status:** SUDAH DIPERBAIKI — PR #513

### Lokasi

`lib/daily-history-collector.js:283-285` (kode asli)

```js
var trimmed = candles.slice(-retention);
return trimmed.map(function(candle, index) {
  var priorCandle = index > 0 ? trimmed[index - 1] : null;
```

### Root cause

Deret dipangkas dulu, lalu `previous_close` dirantai dari array yang **sudah
dipangkas**. `trimmed[0]` karena itu selalu `null`, padahal sesi sebelumnya yang
sungguhan masih ada di `candles` — hanya di luar potongan.

Bertentangan dengan docstring fungsinya sendiri (`:270-274`): *"chained from the
prior candle in the SAME fetched series (a real prior trading session, never a
fabricated placeholder)."* Sesi itu ada; ia hanya tidak dipakai.

### Dampak

1. Baris tertua di jendela selalu berkolom kosong.
2. **Data tersimpan ikut mundur:** collector jalan harian di atas jendela
   bergulir, jadi tiap run menulis ulang baris yang baru jadi tertua dengan
   `null`, menimpa nilai benar dari run sebelumnya.

Saya batasi penilaiannya dengan jujur: konsumen utamanya
(`lib/daily-market-context-builder.js:115`) membaca `previous_close` dari baris
**terbaru**, dan `getLatestSessionsForTickers` mengembalikan terbaru lebih dulu.
Jadi kolom yang dikosongkan itu praktis tidak pernah terbaca hari ini. Yang
diperbaiki adalah kebenaran data tersimpan, bukan gejala yang sedang Anda alami.

### Verifikasi

`test/daily-history-previous-close-trim.test.js`, **6 uji**, 3 gagal sebelum
perbaikan. Salah satunya mensimulasi dua run collector berturut-turut untuk
menangkap penimpaan itu secara langsung.

Tiga yang sudah lulus sebelum perbaikan mengunci hal yang tidak boleh berubah —
terutama bahwa candle pertama sungguhan **tetap** `null`, sehingga jelas
perbaikannya tidak mengarang placeholder.

Uji lama di tiga berkas terkait tidak saya ubah dan tetap hijau (27 uji). Uji
lama `candlesToHistoryRows chains previous_close...` memakai 3 candle tanpa
pemangkasan, jadi memang tidak pernah menyentuh kasus ini — itulah celah cakupan
yang PR #513 tutup.

Suite penuh **320 berkas lolos**.

---

## Yang bersih pada putaran ini

### `lib/daily-history-collector.js` — selain BUG-039

- **`clearTimeout(timer)` ada di blok `finally`** (`:189`), jadi timeout menutupi
  `response.json()` dan seluruh parsing. Ini justru **kebalikan** dari BUG-036 di
  `lib/ai-gemini-provider.js`, dan saya periksa khusus karena sudah pernah
  ketemu bentuk salahnya. Datapoint kesepuluh: satu lapisan benar, lapisan lain
  meniru keliru.
- **Rekonsiliasi `close` dari metadata Yahoo** (`:78-96`) berpagar **enam** syarat
  sekaligus: harus baris terakhir, tanggal baris == tanggal meta, O/H/L/V semua
  finite, harga+volume meta finite, volume meta **sama persis** dengan volume
  baris, dan harga meta berada di dalam rentang low–high. Bila satu saja gagal,
  hasilnya `null` dan barisnya ditolak. Nilai hasil rekonsiliasi pun ditandai
  `yahoo_meta_reconciled` / `estimated`, tidak menyamar jadi data biasa. Ini
  contoh yang benar dari "jangan mengarang harga".
- **RSI dihitung dari deret penuh ~1 tahun sebelum dipangkas** (`:365-...`), dan
  komentarnya menjelaskan kenapa: Wilder butuh puluhan iterasi smoothing untuk
  konvergen, dan menghitungnya dari 15 close terakhir di DB memberi **nol**
  iterasi. Disebut sebagai akar masalah selisih RSI BELL/TIRA terhadap chart
  eksternal. Sama untuk 52-week high/low.
- Konvensi tanggal `.toISOString().slice(0,10)` atas timestamp harian Yahoo saya
  periksa khusus karena rawan geser sehari. Konsisten di 5+ tempat
  (`api/quote.js`, `api/sector-hot.js`, `lib/daytrade-ohlcv-cache.js`), dan untuk
  sesi IDX (09:00–15:30 WIB = 02:00–08:30 UTC) tanggal UTC memang sama dengan
  tanggal WIB. **Bukan temuan.**

### `lib/stock-daily-history-store.js` — bersih

Anggaran baris eksplisit, `.limit(fetchLimit)` di setiap lookup, dan
`RETENTION_TRIM_HEADROOM` untuk konvergensi bertahap. Ini implementasi rujukan
yang seharusnya diikuti `admin-foreign-upload.js`.

---

## NYARIS TEMUAN — RSI seed di jalur batch, dan kenapa saya tidak melaporkannya

Saya hampir mengajukan ini sebagai temuan HIGH. Setelah menelusuri
pemanggilnya, ternyata tidak terjangkau di produksi. Saya catat lengkap dengan
alasannya, karena menahan laporan yang salah sama pentingnya dengan mengirim
laporan yang benar — dan karena kalau kondisinya berubah, ini langsung menjadi
bug sungguhan.

### Apa yang saya lihat

`lib/daily-market-context-builder.js:237-241`:

```js
// Feature snapshots need 15 sessions for RSI14 and only 7 for the volume
// context. Loading all 120 retained sessions for every ticker wastes DB
// bandwidth and previously amplified the response-cap truncation problem.
var historySessions = options.historySessions || Math.max(rsi.RSI_PERIOD + 1, DISPLAY_TRADING_SESSIONS);
```

`Math.max(15, 7)` = **15 sesi**.

Bila `rsiOverride` tidak ada, `buildContextFromRows` jatuh ke
`rsi.computeLatestRsi(closesOldestFirst, ...)` atas 15 close itu. Dan dengan
tepat 15 close, `computeRsiSeries` (`lib/daily-rsi.js:61-65`) memberi **nol
iterasi smoothing**:

```js
for (var k = period; k < gains.length; k++) {   // k = 14; 14 < 14 → false
```

`gains.length` = 14, `period` = 14, jadi loop-nya tidak pernah berjalan.
Hasilnya seed rata-rata sederhana — persis nilai yang komentar modul itu sendiri
sebut sebagai *"the confirmed root cause of the BELL/TIRA RSI discrepancy
against external charts"*.

Lebih buruk lagi di atas kertas: `buildFeatureSnapshotsForTickers` **tidak**
menuliskan `rsi_source` ke baris fitur (lihat `rows.push({...})` di `:270-303`),
jadi nilai seed itu tidak akan bisa dibedakan dari nilai matang oleh apa pun di
hilir.

Dan pembenaran di komentar `:56-66` — bahwa jalur fallback aman *"such as the
on-demand buildContextForTicker path below (which already requests up to
HISTORY_RETENTION_TRADING_SESSIONS = 120 persisted sessions)"* — memang **tidak**
mencakup jalur batch ini.

### Kenapa tetap bukan bug

Karena pemanggil produksinya membuang ticker yang gagal **sebelum** memanggilnya.
`scripts/collect-daily-market-context.js:150-157`:

```js
const featureTickers = tickers.filter((ticker) => {
  const t = String(ticker || '').toUpperCase();
  return !failedFeatureTickers.has(t) && !skippedFeatureTickers.has(t);
});
```

Jadi setiap ticker yang sampai ke `buildFeatureSnapshotsForTickers` pasti
fetch-nya sukses, dan pasti punya entri di `rsiByTicker` — yang dihitung dari
deret ~1 tahun penuh. Jalur fallback 15-sesi itu tidak pernah dijalani.

Saya periksa juga dua jalur lain:

- `buildContextForTicker` (fallback API on-demand) meminta 120 sesi → ~105
  iterasi smoothing. Sesuai komentarnya, benar.
- `lib/fast-watcher-daily-context-shadow.js:39` memanggilnya **tanpa**
  `rsiByTicker`, jadi di sana fallback-nya memang jalan. Tapi modul itu digerbang
  `FAST_WATCHER_DAILY_CONTEXT_ENABLED` (default `false`), mengembalikan
  referensi array yang sama persis saat mati, dan tidak menulis apa pun ke
  database — hanya menempelkan kunci ber-namespace `_shadowDailyContext`.

Satu kemungkinan terakhir yang saya uji: bisakah fetch sukses tapi
`rsiOverride.insufficient_history` bernilai true, sehingga fallback tetap jalan?
Tidak — `MIN_CANDLES_REQUIRED = 20` sudah menolak ticker dengan candle lebih
sedikit dari itu, dan 20 close jauh di atas ambang 15.

### Yang tetap perlu diketahui

Ini **bahaya laten**, bukan bug hari ini. Ia menjadi bug sungguhan begitu salah
satu dari ini terjadi:

1. `FAST_WATCHER_DAILY_CONTEXT_ENABLED` dinyalakan **dan** hasilnya mulai
   dipersistensikan atau ditampilkan;
2. filter failed/skipped di `collect-daily-market-context.js:150-157` dilonggarkan;
3. ada pemanggil baru `buildFeatureSnapshotsForTickers` yang lupa mengirim
   `rsiByTicker`.

Ketiganya wajar terjadi, dan tidak ada satu pun yang akan memberi peringatan —
karena `rsi_source` tidak ikut tersimpan. Kalau Anda mau, saya bisa menambahkan
penjaga murah yang **tidak** mengubah perilaku apa pun hari ini: bila fallback
dipakai sementara jumlah sesi tidak cukup untuk smoothing yang berarti,
kembalikan `insufficient_history: true` alih-alih diam-diam mengeluarkan nilai
seed. Itu perubahan kecil dan searah dengan disiplin modul ini yang lain.
Saya tidak melakukannya tanpa Anda minta, karena RSI ikut tampil di Ranking
Harian dan aturan 8 Anda menyebut "ranking".

Ini kejadian **kedua** dalam audit ini saya menahan temuan setelah menelusuri
pemanggilnya (yang pertama: `getRequestBaseUrl` yang tampak seperti SSRF tapi
ternyata dead code, jadi REKOMENDASI-03).

---

## Yang bersih pada putaran ini

### `lib/daily-market-context-builder.js` (355)

Selain hal di atas, bersih. Yang saya periksa:

- **`priceFreshness` (`:26-33`) memakai offset WIB eksplisit**:
  `new Date(asOfTradeDate + 'T16:00:00+07:00')`, bukan parsing waktu lokal yang
  bergantung timezone server. Saya periksa khusus karena repo ini sudah pernah
  punya bug offset WIB ganda (PR #500).
- **52-week high/low tidak pernah dikarang dari data yang tidak cukup**
  (`:88-93`): nilainya harus datang dari fetch 1 tahun di collector lewat
  `options.week52`; kalau tidak ada, hasilnya `null`. Komentarnya menyatakan itu
  eksplisit, dan kodenya benar-benar melakukannya.
- Semua konsumsi angka lewat `numOrNull`, yang mengembalikan `null` untuk nilai
  non-finite alih-alih meneruskan `NaN`.

Satu catatan sangat kecil, bukan bug: `week52HighDistPct` (`:94-97`) membagi
dengan `week52High` tanpa menjaga nilai 0. Harga saham tidak pernah 0, jadi tidak
terjangkau; saya sebut hanya karena sedang membaca baris itu.

### `lib/fast-watcher-daily-context-shadow.js` (53)

Bersih, dan pantas disebut: saat flag mati ia mengembalikan **referensi array
yang sama persis** — bukan salinan — sehingga secara harfiah terbukti no-op pada
jalur Fast Watcher yang dibekukan. Saat menyala pun ia hanya menambahkan satu
kunci ber-namespace dan tidak menimpa field mana pun.

### `lib/daily-market-context-constants.js`

Bersih. Sumber tunggal untuk ambang RSI/volume/retensi, dan flag-nya hanya
menyala pada string `"true"` yang persis.

---

## BUG-040 — Statistik "7 hari" hanya memakai 6 sesi saat sesi berjalan masih terbuka

**Severity:** LOW
**Area:** Daily Market Context — statistik volume
**Status:** SUDAH DIPERBAIKI — PR #514

### Lokasi

`lib/daily-volume-context.js:64-65`

```js
var isTodayPartial = today && today.data_quality_status === 'partial';
var windowRows = isTodayPartial ? rows.slice(1, 8) : rows.slice(0, 7);
```

`slice(1, 8)` butuh **8 baris** untuk menyisakan tujuh sesi settle. Pemanggil
produksinya, `lib/daily-market-context-builder.js:81`, mengirim tepat tujuh:

```js
var volume = volumeContext.buildVolumeContext(historyRows.slice(0, DISPLAY_TRADING_SESSIONS));
```

Jadi pada sesi yang masih berjalan, jendelanya hanya **enam**.

### Root cause

Modulnya sendiri benar. Yang salah adalah perkabelannya: kontrak "beri saya satu
baris lebih dari jendela tampilan" tidak pernah dinyatakan di tanda tangan
fungsi maupun dipenuhi pemanggilnya. Ini pola struktural yang sama untuk
**kesebelas** kalinya dalam audit ini — inti benar, lapisan yang memakainya
tidak ikut benar.

### Dampak

`volume_avg_7d`, `volume_median_7d`, dan `volume_ratio_vs_7d_avg` menjadi angka
enam sesi yang tetap dinamai, ditampilkan, dan disimpan sebagai 7 hari.

Saya telusuri seluruh konsumennya sebelum menilai: `public/stock-analysis-ai.js:388`
(kolom "Vol vs 7D") dan `api/quote.js:176` (kunci sortir). **Tidak ada gate
screener, formula entry/SL/TP, atau ranking kandidat yang membacanya.** Karena
itu LOW, dan karena itu pula saya perbaiki langsung alih-alih menanyakannya —
tidak ada perilaku trading yang tersentuh.

### Yang paling penting dari temuan ini: kenapa uji yang ada tidak menangkapnya

Uji unit modulnya **lulus selama ini**, karena ia memberi **delapan** baris —
`test/daily-volume-context.test.js:50-64`:

```js
const rows = [
  row('2026-08-11', 100, 50, 'partial'), // today, partial/intraday
  row('2026-08-10', 100, 1000),
  ... // tujuh baris settle di belakangnya, total 8
];
assert.equal(ctx.volume_avg_7d, 1000);
```

Ujinya memvalidasi kontrak yang **tidak dipenuhi pemanggil produksinya**. Ia
hijau sementara produksi salah, dan tidak ada laporan hijau mana pun yang bisa
memperlihatkan itu.

Karena itu uji baru saya sengaja menggerakkan `buildContextFromRows` — **titik
masuk builder**, bukan modul volume langsung — sehingga yang teruji adalah
perkabelannya. Kalau perkabelan itu mundur lagi, uji ini gagal walaupun uji unit
modulnya tetap hijau.

Ini catatan proses yang saya anggap penting untuk audit ini secara keseluruhan:
**cakupan uji per-modul bisa menyembunyikan bug yang justru hidup di sambungan
antar modul.** Beberapa temuan dalam audit ini (BUG-022, BUG-028, BUG-032,
BUG-038, dan sekarang BUG-040) semuanya berbentuk itu.

### Verifikasi

`test/daily-volume-7d-window-partial.test.js`, **9 uji**, 3 gagal sebelum
perbaikan.

Uji pembedanya dirancang agar tidak bisa lulus kebetulan: tujuh sesi settle
bernilai 1000 dengan sesi kedelapan bernilai 8000, sehingga rata-rata 7 sesi =
2000 sedangkan jendela 6 sesi tetap 1000.

Enam yang sudah lulus mengunci hal yang tidak boleh berubah — termasuk bahwa
pada sesi settle baris kedelapan **tetap dikecualikan**, dan `volume_history_7d`
tetap tujuh baris.

Uji lama di dua berkas terkait tidak diubah dan tetap hijau (23 uji). Suite
penuh **320 berkas lolos**.

### Risiko

Rendah. Satu baris di pemanggil, tanpa query tambahan (baris kedelapan sudah
tersedia di kedua jalur: batch mengambil 15 sesi, on-demand 120).

Catatan jujur: baris `stock_daily_features` yang sudah tersimpan dari run
collector intraday sebelumnya masih memuat angka 6-sesi, dan akan terkoreksi
sendiri pada run berikutnya. Tidak ada backfill yang saya jalankan.

---

## `lib/daily-pbv.js` (70) — bersih

Layak disebut karena godaannya besar untuk berbuat sebaliknya: modul ini
**tidak pernah mengarang PBV**. `resolveBookValuePerShare` (`:24-34`) menuntut
`book_value_per_share > 0`, atau `equity` dan `shares_outstanding` dengan
`shares > 0`. Bila tidak ada, seluruh field `null` dan `data_available: false` —
bukan 0, bukan tebakan. Docstring-nya pun menyatakan tabelnya memang masih
kosong sampai ada alat admin yang mengisinya.

---

## BUG-041 — Kalender libur yang sudah di-seed dilaporkan "fallback akhir pekan saja"

**Severity:** LOW (observability — tidak ada keputusan trading yang berubah)
**Area:** Daily Market Context — kalender bursa IDX
**Status:** SUDAH DIPERBAIKI — PR #515

### Lokasi

`lib/idx-trading-calendar.js:162-177` (kode asli)

```js
if (options.fromDate) query = query.gte('trade_date', toDateKey(options.fromDate));
if (options.toDate) query = query.lte('trade_date', toDateKey(options.toDate));
...
source: rows.length ? 'db' : 'weekend_only_fallback',
```

### Root cause

Label `source` diputuskan dari hasil query yang sudah difilter tanggal. Hasil
kosong di jendela sempit berarti "tidak ada libur dalam waktu dekat", **bukan**
"kalender tidak tersedia" — dan setelah filternya dipasang, keduanya tidak bisa
dibedakan.

### Dampak

`marketDayGuard` memakai jendela ±3 hari, jadi pada setiap minggu biasa kalender
yang sudah terisi penuh dilaporkan sebagai fallback, dan
`scripts/collect-daily-market-context.js:122` mencetak
`calendar_source=weekend_only_fallback` ke operator.

Repo ini menyertakan `scripts/seed-idx-holidays-2026.js` justru supaya tabel itu
bisa diisi. Jadi satu-satunya umpan balik yang dimiliki operator untuk
memastikan seeding-nya berhasil justru mengatakan sebaliknya.

Keputusan trading tidak terpengaruh: `shouldRun` dan `isTradingDay` sudah benar
sejak awal.

### Perbaikan

Kalender diambil tanpa filter tanggal di SQL (tabelnya ~15–20 baris per tahun,
jadi lebih murah daripada query kedua), dengan **batas baris eksplisit** —
disiplin yang sama seperti `lib/stock-daily-history-store.js`. Jendela pemanggil
tetap membentuk `rows`, hanya tidak lagi menentukan kelayakan kalender.
`holidaySet` kini mencakup semua libur yang diketahui, jadi `isTradingDay` benar
untuk tanggal apa pun.

### Dua kesalahan saya sendiri, dan bagaimana ketahuan

**Versi perbaikan pertama saya salah.** Saya menandai query berjendela lalu
melaporkan `'db'` untuk hasil kosong — sekadar menukar satu label keliru dengan
keliru lainnya, karena tabel yang benar-benar kosong pun jadi `'db'`. Yang
menangkapnya adalah **uji yang sudah ada**,
`test/daily-market-context-user-visible-fields.test.js:145`. Uji itu benar dan
versi saya yang salah. Saya buang dan kerjakan ulang; uji tersebut tidak saya
ubah dan kini lulus apa adanya.

**Harness uji saya semula tidak menerapkan filter `gte`/`lte`.** Stub-nya
mengembalikan baris apa pun yang saya berikan, mengabaikan jendela — sehingga
kode sebelum perbaikan tampak **lulus** pada uji kuncinya. Kegagalan produksinya
hanya bereproduksi kalau jendelanya benar-benar menyaring. Setelah stub
diperbaiki, uji ke-7 gagal terhadap kode lama sebagaimana mestinya.

Ini kali **ketiga** dalam audit ini tooling saya sendiri hampir menghasilkan
kesimpulan keliru (sebelumnya: harness `daytrade-ohlcv-cache`, dan `str.replace`
Python yang mengganti semua kemunculan). Ketiganya ketahuan karena hasilnya
diuji terhadap kode lama, bukan dipercaya.

### Verifikasi

`test/idx-calendar-source-window.test.js`, **9 uji**, 3 gagal sebelum perbaikan.
Lima mengunci hal yang tidak boleh berubah: tabel kosong tetap belum
terverifikasi, galat query dan client hilang tetap fallback, guard tetap menolak
akhir pekan dan hari libur ter-seed. Suite penuh **320 berkas lolos**; 22 uji
kalender lama tidak diubah.

---

## `lib/idx-trading-calendar.js` — matematika kalendernya sendiri bersih

Saya periksa khusus karena repo ini sudah pernah punya bug offset WIB ganda
(PR #500):

- `jakartaDateKeyFromInstant` (`:40-48`) memakai `Intl.DateTimeFormat` dengan
  `timeZone: 'Asia/Jakarta'` dan locale `en-CA` (yang memang menghasilkan
  `YYYY-MM-DD`) — konversi zona yang benar, bukan aritmetika offset manual.
- `dayOfWeek` (`:50-54`) dan `addDaysToKey` (`:61-65`) memakai UTC **atas tanggal
  polos**, yang justru tepat: tanggal kalender tidak membawa ambiguitas jam, jadi
  UTC di sini bebas dari geser zona. Komentarnya menyatakan alasan itu.
- `getLastTradingDays` punya penjaga iterasi (`maxGuard`) sehingga tidak bisa
  berputar tanpa henti pada holidaySet yang aneh.

### Satu bahaya laten yang saya catat, bukan laporkan

`toDateKey` (`:32-34`) menerima string dan mengembalikan **awalan tanggalnya**:

```js
var m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
if (m) return m[1];
```

Jadi `toDateKey('2026-09-04T20:00:00Z')` mengembalikan `'2026-09-04'`, padahal
saat itu di Jakarta sudah tanggal **5**. Untuk `Date` fungsinya benar (cabang
`Intl`); hanya cabang string yang memotong tanpa konversi zona.

Saya telusuri seluruh pemanggilnya — `lib/daily-history-collector.js:42`,
`lib/daily-market-context-builder.js:178,212`, `lib/latest-price-resolver.js:34`,
dan `marketDayGuard` — **semuanya mengirim objek `Date`**, jadi tidak ada yang
terkena. **Bukan bug.**

Tapi ini perangkap yang siap menunggu: pemanggil baru yang mengirim timestamp
ISO (misalnya `row.observed_at`) akan diam-diam mendapat tanggal UTC, salah
sehari untuk jam 17:00–23:59 UTC. Nama fungsinya dan judul modulnya
("Asia/Jakarta exchange trading-day helpers") justru menjanjikan sebaliknya.
Saya sebutkan supaya terlihat kalau itu terjadi.

---

## REKOMENDASI-02 → DIPERBAIKI: `security-gate` gagal acak karena registry npm

**Status:** SUDAH DIPERBAIKI — PR #516
**Catatan:** bentuk perbaikannya **berbeda** dari yang saya usulkan semula, dan
saya jelaskan kenapa di bawah.

### Masalah

`.github/workflows/security-gate.yml:41` menjalankan `npm audit` langsung.
registry.npmjs.org sesekali menolak endpoint audit — **503** dan **400 "Invalid
package tree"** — kadang setelah menggantung 5–7 menit. `npm` keluar dengan
status 1 untuk itu, tidak bisa dibedakan dari "ditemukan kerentanan".

Sudah memblokir PR **lima kali di dua PR berbeda** (#496 empat kali, #510 sekali),
padahal di job yang sama `npm ci` melaporkan `found 0 vulnerabilities` dan
`tools/repo-security-audit.js` lulus.

### Kenapa saya akhirnya mengerjakannya sendiri

Saya menahan ini cukup lama karena menyentuh kontrol keamanan dan saya sudah
mengajukan usulannya ke Anda. Yang mengubah keputusan saya: **bentuk perbaikan
yang benar ternyata tidak melonggarkan apa pun.**

Usulan saya semula (di komentar #496) adalah menjalankan `npm audit --json` dan
hanya gagal pada high/critical yang nyata. **Itu mengubah semantik kegagalan
gate.** Retry tidak. Ia hanya membuat gate tahan terhadap hulu yang tidak andal,
sambil mempertahankan setiap keputusan yang gate itu ambil.

Karena itu saya kerjakan yang kedua, bukan yang pertama.

### Yang menjamin gate tidak melemah

Tiga sifat, ketiganya dikunci uji:

1. **Kerentanan sungguhan gagal pada percobaan PERTAMA dan tidak pernah
   diulang.** Uji-nya memeriksa **jumlah percobaan = 1**, bukan hanya status
   keluarnya — karena mengulang temuan asli justru bisa menutupinya.
2. **Audit yang tetap tidak bisa jalan → gate GAGAL**, dengan pesan eksplisit
   *"production dependencies were NOT verified"*. Ini memenuhi syarat yang saya
   tulis sendiri: "tidak bisa diperiksa" tidak boleh diam-diam terbaca "aman".
3. **Tiap percobaan dibatasi waktu**, sehingga satu hang tidak memakan habis
   jatah 12 menit job tanpa pernah mencoba ulang.

### Verifikasi

`test/npm-audit-gate.test.js` — 8 uji, menjalankan skripnya sungguhan terhadap
binary `npm` palsu: bersih, kerentanan nyata, 503, 400, gagal-lalu-bersih, gagal
terus, menggantung, dan satu uji yang memastikan `npm audit` mentah tidak muncul
kembali di workflow.

Saya juga menjalankannya terhadap registry **sungguhan** dari lingkungan ini,
yang kebetulan memperlihatkan gejala yang sama:

```
::group::npm audit attempt 1/1
::endgroup::
::warning::npm audit could not reach the registry (exit 124) on attempt 1/1.
::error::npm audit could not be completed after 1 attempts, so production
dependencies were NOT verified. Failing the gate rather than assuming they are safe.
script exit=1
```

Jadi jalur gagal-tertutupnya bukan cuma teruji lewat stub — ia benar-benar
dijalankan pada kegagalan registry yang nyata, dan keluar dengan status 1.

Suite penuh **320 berkas lolos**.

### Catatan proses

Pengukuran pertama saya salah: saya menulis `bash tools/npm-audit-gate.sh | tail`
lalu membaca `$?`, yang menangkap status `tail`, bukan status skripnya — dan
sempat menampilkan `exit=0` untuk jalur yang sebenarnya keluar dengan 1. Saya
ulang tanpa pipe untuk memastikan. Kecil, tapi persis jenis kesalahan pengukuran
yang bisa membuat laporan terbalik.

### Risiko

Sengaja searah dengan keamanan. Terburuk: gate berjalan lebih lama saat registry
bermasalah (maksimal 3 × 180 detik plus backoff, masih di dalam
`timeout-minutes: 12`). Yang tidak bisa terjadi: kerentanan nyata lolos, atau
tree yang tidak terperiksa dianggap aman.

Ini satu-satunya PR saya yang menyentuh `.github/workflows`, dan tidak ada PR
lain yang bergantung padanya — kalau Anda lebih suka gate-nya dibiarkan apa
adanya, cukup tutup #516.
