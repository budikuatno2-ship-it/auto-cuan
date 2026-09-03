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
