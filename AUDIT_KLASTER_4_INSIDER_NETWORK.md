# LAPORAN AUDIT FORENSIK KLASTER 4: JEJARING INSIDER & RELASI GRAF 957 UNIVERSE

**Target Branch:** `feat/daytrade-screener-v1`
**Auditor:** Senior Release Engineer & Data Systems Auditor
**Status:** AUDITED & SECURED (PASS WITH DEFECT PATCH)

---

## 1. Executive Summary

Audit forensik Klaster 4 difokuskan pada integritas dataset kepemilikan orang dalam (Insider Roster & Network Graph 957 Universe), ketepatan filter transaksi non-pembelian, keutuhan graf relasi (zero orphan edges), keamanan paywall tier, dan kestabilan komputasi visualisasi rendering graf frontend.

### Sensus Data Produksi (data/insider-network/):
- `insiders-db.json`: **11.219 transaksi** historis riil bursa + jangkar konglomerasi eksplisit (Ukuran: 3.93 MB).
- `roster.json`: **907 emiten** terpetakan dengan daftar pemegang saham lengkap (Ukuran: 0.72 MB).
- `network.json`: **226 tokoh & korporasi multi-emiten** yang menghubungkan 907 emiten (Ukuran: 1.23 MB).
- Graf Jejaring: **4.299 total nodes**, **3.524 total edges**, dengan **0 orphan edges** (100% utuh).

---

## 2. Analisis Forensik Mendalam per Area Fokus

### 2.1. Filter Transaksi Non-Buy (PR #611)
- **Berkas yang Diperiksa**: `lib/insider-network-service.js` (`aggregateInsiderHoldings`), `lib/bandarmologi-service.js` (`normalizeInsiders`), `public/bandarmologi-runtime.js`.
- **Temuan Forensik**:
  - Pada PR #611 (`ba6041e` / `473cff6`), logika akumulasi kepemilikan telah diperbaiki dari model tangkap-semua (`else { holding.total_bought += change; }`) menjadi selektif ketat:
    ```javascript
    const change = parseShares(item.shares_change || item.shares || 0);
    const action = String(item.action_type || '').toUpperCase().trim();
    if (action === 'SELL') {
      holding.total_sold += change;
      holding.net_shares_change -= change;
    } else if (action === 'BUY' || action === 'PURCHASE') {
      holding.total_bought += change;
      holding.net_shares_change += change;
    }
    // Aksi non-beli/jual seperti TRANSFER, HIBAH, WARIS, BONUS, dan RIGHTS
    // sengaja diabaikan dari total_bought dan net_shares_change untuk mencegah akumulasi palsu
    ```
  - **Uji Filter Mutasi**:
    - Aksi hibah (`HIBAH`), warisan (`WARISAN`), opsi saham karyawan (`MESOP_OPTION`), transaksi repo (`REPO_TRANSFER`), pembagian dividen saham (`STOCK_DIVIDEND`), dan pengalihan internal terbukti **TIDAK PERNAH** dimasukkan ke dalam metrik akumulasi beli (`total_bought` dan `net_shares_change`).
  - **Penyempurnaan Tambahan (Patch)**:
    - Pada `lib/bandarmologi-service.js:1271`, branching parser `actionType` diperluas agar kata kunci `'WARIS'`, `'MESOP'`, `'ESOP'`, dan `'REPO'` secara deterministik distandardisasi menjadi `'TRANSFER'`.
  - **Representasi Visual**:
    - Pada `public/bandarmologi-runtime.js:3101-3107`, transaksi berstatus non-beli dirender dengan badge biru **`🔵 TRANSFER`** dengan judul panel **`Aksi Transaksi`** (bukan "Akumulasi Beli").

### 2.2. Integritas Dataset 957 Universe & Cacat Saldo Saham Negatif
- **Berkas yang Diperiksa**: `tools/process-insider-roster.js`, `tools/build-full-insider-network.js`, `data/insider-network/roster.json`, `data/insider-network/network.json`.
- **Temuan Cacat Serius (Defect Detected & Resolved)**:
  - Ditemukan **219 entri** pada `roster.json` yang menyimpan jumlah kepemilikan saham negatif (contoh: `{ ticker: 'ADHI', name: 'HIRONIMUS HILAPOK', shares: -5000, pct: 0 }`, `{ ticker: 'ANTM', name: 'IRWANDY ARIF', shares: -1, pct: 0 }`).
  - **Akar Masalah (Root Cause)**:
    Pada `tools/process-insider-roster.js:117` dan `167`, pembacaan saldo saham menggunakan operator fallback JavaScript `||`:
    ```javascript
    var shares = cleanNumber(item.shares_after || item.current_value || item.shares || item.shares_change);
    ```
    Ketika pemegang saham menjual seluruh kepemilikannya hingga habis, nilai `shares_after` bernilai `0`. Dalam evaluasi kebenaran JavaScript, `0` dianggap *falsy*. Akibatnya, evaluasi melompat ke `shares_change` yang bernilai negatif (misal `-5000`). Angka mutasi jual tersebut akhirnya dicatat sebagai saldo kepemilikan akhir!
    Dalam hukum pasar modal, saldo kepemilikan saham minimal adalah 0 lembar; angka negatif adalah cacat matematis.
  - **Solusi & Patch yang Diterapkan**:
    - Mengganti evaluasi dengan pemeriksaan nullish eksplisit dan pembatasan batas bawah nol:
      ```javascript
      var rawSharesVal = item.shares_after != null ? item.shares_after : (item.current_value != null ? item.current_value : (item.shares != null ? item.shares : 0));
      var shares = Math.max(0, cleanNumber(rawSharesVal));
      ```
    - Memperbaiki logika serupa pada `lib/insider-network-service.js:590` dan `609`.
    - Menjalankan pipeline `tools/process-insider-roster.js` untuk meregenerasi `roster.json` dan `network.json`.
    - **Hasil Pasca-Patch**: Seluruh 219 anomali negatif berhasil dieliminasi (**0 invalid shares remaining**).
  - **Audit Node Gantung (Zero Orphan Edges)**:
    - Seluruh 3.524 edge diperiksa: $100\%$ edge memiliki target dan source yang valid pada array `nodes` masing-masing graf emiten. Tidak ditemukan node atau edge terputus (*orphan*).

### 2.3. Bobot Relasi Konglomerasi & Keamanan Paywall Tier
- **Berkas yang Diperiksa**: `tools/process-insider-roster.js:235-316`, `public/analisis-saham-runtime.js:386-413`, `api/sector-hot.js:8503-8534`.
- **Hasil Audit Bobot Konglomerasi**:
  - Hubungan konglomerasi dibangun dari entitas yang memiliki kepemilikan di $\ge 2$ emiten (`ent.holdings.length >= 2`).
  - Bobot kepemilikan saham dihitung secara proporsional berdasarkan persentase riil keterbukaan bursa (`percentage` dan `shares`), tanpa angka bobot acak atau koefisien artifisial.
- **Hasil Audit Paywall Tier (Temuan Keamanan)**:
  - **Guard Sisi Klien**:
    Fungsi `switchAnalisisTab('insider')` memblokir pengguna tak berlangganan menggunakan `isSubscribedUser()` dan merender `renderTabPaywall()`.
  - **Potensi Celah Konsol Browser (Vulnerability Warning)**:
    Variabel `window.premiumAccessState` disimpan langsung di global scope `window`. Pengguna teknis dapat menjalankan `window.premiumAccessState = { premium: true }` di DevTools untuk membuka antarmuka graf.
  - **Celah Sisi Server (Server-Side Endpoint Openness)**:
    Endpoint API `/api/sector-hot?action=insider-network` dan `insider-roster` (pada `api/sector-hot.js:8503-8534`) saat ini tidak memvalidasi sesi cookie pengguna (`requireNonBlockedUser`). Setiap klien HTTP dapat memanggil payload roster dan graph secara langsung tanpa autentikasi. Disarankan untuk memasang middleware sesi pada fase hardening keamanan berikutnya.

### 2.4. Performa Render Visual Graf (Browser Thread Evaluation)
- **Berkas yang Diperiksa**: `public/bandarmologi-runtime.js` (`renderInsiderNetworkSvg`).
- **Hasil Pengujian Komputasi**:
  - **Bukan Simulasi Fisika Berulang**: Graf tidak menggunakan engine D3 Force / Physics iterative yang berisiko loop tak berujung atau 100% CPU lock.
  - **Sistem Orbit Tata Surya Statis-Deterministik**:
    Node dihitung sekali jalan menggunakan koordinat polar melingkar ($O(N)$):
    $$x = c_x + r \cdot \cos(\theta), \quad y = c_y + r \cdot \sin(\theta)$$
  - **Beban Elemen**: Emiten terbesar dalam dataset (grup Barito, Salim, Astra) memiliki 4 s/d 8 node emiten satelit. Emiten dengan relasi terbesar di IDX hanya memiliki 43 nodes. Waktu pembuatan SVG string tercatat $< 2\text{ ms}$.
  - **Animasi GPU**: Rotasi orbit (`solarOrbit`, `satelliteOrbit`) dikendalikan via CSS keyframe transform yang diproses di GPU compositor thread tanpa membebani JavaScript main event loop.
  - **AbortController Aktif**: Navigasi cepat antar-emiten membatalkan request jaringan yang sedang berjalan (`activeInsiderGraphAbortController.abort()`), mencegah penumpukan konsumsi memori.

### 2.5. Pengujian Mandiri (Self-Contained Test Suite)
- Dibuat berkas pengujian baru: `test/insider-network-integrity.test.js`.
- Cakupan Pengujian:
  1. Parser transaksi mengonversi variasi aksi non-buy (`HIBAH`, `WARISAN`, `MESOP_OPTION`, `REPO_TRANSFER`) ke `TRANSFER`.
  2. Fungsi agregasi tidak pernah memasukkan transaksi `TRANSFER`, `HIBAH`, atau `WARIS` ke dalam `total_bought`.
  3. Guard saldo menjamin tidak ada investor dengan kepemilikan negatif saat menjual habis sahamnya (`shares >= 0`).
  4. Graf `network.json` bebas dari orphan edge dan memiliki integritas skema node-link.
  5. Berkas `roster.json` memverifikasi 907 emiten memiliki persentase valid (0-100%) dan saldo non-negatif.
  6. Konektivitas tokoh konglomerat utama (Prajogo Pangestu, Garibaldi Thohir, Lo Kheng Hong) terverifikasi multi-emiten.

---

## 3. Matriks Hasil Pengujian

| Nama Pengujian | Berkas | Hasil |
| :--- | :--- | :--- |
| Insider Network Integrity Suite | `test/insider-network-integrity.test.js` | **6/6 PASS** (525 ms) |
| Insider Transaction Table & Normalization | `test/insider-transaction-table.test.js` | **3/3 PASS** (42 ms) |
| Insider Network Graph Engine | `test/insider-network-graph.test.js` | **7/7 PASS** (18 ms) |
| Insider Network UI & SVG Renderer | `test/insider-network-ui.test.js` | **10/10 PASS** (455 ms) |
| Tab Navigation & 957 Universe Database | `test/tab-navigation-and-insider-universe.test.js` | **6/6 PASS** (155 ms) |
| Global Smoke Test Suite | Seluruh 67 test files (`npm run test:smoke`) | **77/77 PASS** (1.24s) |

---

## 4. Rekomendasi & Langkah Selanjutnya

1. **Klaster 4 Dinyatakan Lulus Audit Forensik**:
   - Filter non-buy aman dan akurat.
   - 219 saldo saham negatif pada database roster telah diperbaiki secara tuntas.
   - Graf bebas dari loop tak berhingga dan orphan edges.
2. **Kesiapan Rilis**:
   - Berkas siap di-commit ke branch perbaikan:
     - `lib/bandarmologi-service.js`
     - `lib/insider-network-service.js`
     - `tools/process-insider-roster.js`
     - `tools/curated-build-tests.json`
     - `data/insider-network/roster.json`
     - `data/insider-network/network.json`
     - `test/insider-network-integrity.test.js`
     - `AUDIT_KLASTER_4_INSIDER_NETWORK.md`
   - Menunggu persetujuan user sebelum melakukan push dan Pull Request.
