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
