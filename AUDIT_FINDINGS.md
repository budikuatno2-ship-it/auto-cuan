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
