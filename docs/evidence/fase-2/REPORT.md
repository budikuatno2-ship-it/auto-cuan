# LAPORAN BUKTI PENGUJIAN VISUAL & AUDIT DATA FASE 2R (FINANCIAL REMEDIATION)

**Tanggal Eksekusi:** 2026-10-13T21:56:13.976Z
**Target Lingkungan:** Local Development Server (http://127.0.0.1:3088) terhubung ke Data Nyata VPS SQLite
**Status Audit Silang 20 Ticker (AC-2.1):** 100% LULUS (Selisih Market Cap 0.00% across all 20 emiten)
**Status Helper WIB (AC-2.2):** 100% LULUS (5/5 tests pass across UTC, NY, Tokyo, Jakarta)
**Status Standarisasi Satuan:** 100% Menggunakan 'Jt', 'Mrd', 'T' (e.g. 122,04 Mrd lembar) & tabular-nums
**Status Kepatuhan AntiSlop:** 6 dari 6 Skill AntiSlop Terpenuhi 100%
**Status Zero Em Dash (AntiSlop-Copywriting):** Sifar em dash di seluruh antarmuka finansial
**Status Penanganan Nilai Hilang (AntiSlop B3):** Tidak ada konversi palsu missing data menjadi 0

---

## DAFTAR SCREENSHOT BUKTI & HASH INTEGRITAS SHA-256

Semua file gambar disimpan secara fisik di `D:\Auto-Cuan\evidence\fase-2\` (di luar repositori git) sesuai Bagian E8, B3, dan G3. File `.png` dikecualikan dari pelacakan git via `.gitignore`.

| No | Nama File | Ukuran | Hash SHA-256 | Deskripsi Skenario & Viewport |
|---|---|---|---|---|
| 1 | `08-fase-2-financial-bbca-income-quarterly-1920x1080.png` | 157.4 KB | `b0ffd56c61c920548ae66fb00346c90ef194bc219242d7b61f5a3f63b945fa2c` | BBCA Laba Rugi Kuartalan (1920x1080) - Data Nyata IDX Q1 2026 |
| 2 | `09-fase-2-financial-bbca-balance-quarterly-1920x1080.png` | 140.2 KB | `c2921dc1b9701865b919eabd8d5a015580bbc1d2c836ef110323945fd5309b07` | BBCA Neraca Kuartalan (1920x1080) - Posisi Akhir Periode |
| 3 | `10-fase-2-financial-bbca-cashflow-quarterly-1920x1080.png` | 158.8 KB | `66690254be94e933abb8d61acd2ed90497e0d2f6c28768785cc60a134acc8d0d` | BBCA Arus Kas Kuartalan (1920x1080) - Kuartal Diskret / Kumulatif Berjalan |
| 4 | `11-fase-2-financial-bbca-ratios-quarterly-1920x1080.png` | 135.8 KB | `78aafd3609622ecd641ee498c29f41166f163214ae8a4e30db13f68a37a92d14` | BBCA Rasio Keuangan Kuartalan (1920x1080) - Konsisten PBV 2.80x & Rasio Resmi |
| 5 | `12-fase-2-financial-bbca-income-annual-1920x1080.png` | 147.8 KB | `5cba735b924b3e1d4a909a1a43d2cf79455c7bd030fa0b8fefa9966f4080c55e` | BBCA Laba Rugi Tahunan FY (1920x1080) - Kumulatif 12 Bulan FY 2025 s.d. FY 2022 |
| 6 | `13-fase-2-financial-bbca-balance-annual-1920x1080.png` | 132.7 KB | `0f71c1170a105ba38b7d0fb8daf907d3604de1acb86a3bebffa71b820af8f129` | BBCA Neraca Tahunan FY (1920x1080) - Posisi Akhir Periode Tahunan |
| 7 | `14-fase-2-financial-bbca-cashflow-annual-1920x1080.png` | 147.6 KB | `c2fdb929915bc4b7b672f76071e988086b4bef02af480e8cc3a1241c0c9fd6ea` | BBCA Arus Kas Tahunan FY (1920x1080) - Kumulatif 12 Bulan |
| 8 | `15-fase-2-financial-bbca-ratios-annual-1920x1080.png` | 133.5 KB | `bb17a0b0de8453004560f315cc60531677a360794e80c7c8f295131de46e8d4f` | BBCA Rasio Keuangan Tahunan FY (1920x1080) |
| 9 | `16-fase-2-financial-tlkm-income-quarterly-1920x1080.png` | 147.2 KB | `915a6c5b1522927d346db459554c9369aa3491158aa27d1b788b64e43339778c` | TLKM (Non-Bank) Laba Rugi Kuartalan (1920x1080) - Data Nyata IDX Q1 2026, Header Quote Rp 2.240 |
| 10 | `17-fase-2-financial-tlkm-balance-quarterly-1920x1080.png` | 134.9 KB | `3bde0b5a3f6d4c3c6c64f5de6600d6cf0a7eaad10923086347e5563cd17f6172` | TLKM (Non-Bank) Neraca Kuartalan (1920x1080) - Posisi Akhir Periode |
| 11 | `18-fase-2-financial-tlkm-cashflow-quarterly-1920x1080.png` | 150.8 KB | `e56d6dc7ade9fef86a1e9d8c63a5ee233e86f02a33e90d8839663147cc13f637` | TLKM (Non-Bank) Arus Kas Kuartalan (1920x1080) - Kuartal Diskret / Kumulatif Berjalan |
| 12 | `19-fase-2-financial-tlkm-ratios-quarterly-1920x1080.png` | 132.8 KB | `f5c9d88a21433b47c27daa10c7d272dcccc2b8e5d6f093ad3c63711f88d1cdbf` | TLKM (Non-Bank) Rasio Keuangan Kuartalan (1920x1080) |
| 13 | `20-fase-2-financial-tlkm-income-annual-1920x1080.png` | 140.9 KB | `4734c7c50f1c5914ac690ddd1b39cfb25f0da7ad8411132c2a202ce6583a4e1f` | TLKM (Non-Bank) Laba Rugi Tahunan FY (1920x1080) - Kumulatif 12 Bulan |
| 14 | `21-fase-2-financial-tlkm-balance-annual-1920x1080.png` | 129.4 KB | `4a0def3aab22c150276b7cd6e01c618236109a8b1d9dd738b1c8af99cce04f1c` | TLKM (Non-Bank) Neraca Tahunan FY (1920x1080) - Posisi Akhir Periode Tahunan |
| 15 | `22-fase-2-financial-tlkm-cashflow-annual-1920x1080.png` | 143.2 KB | `558ea1547a73e6003446c998b99c6c638a4079ad18ed40f1748de68f29c2824a` | TLKM (Non-Bank) Arus Kas Tahunan FY (1920x1080) - Kumulatif 12 Bulan |
| 16 | `23-fase-2-financial-tlkm-ratios-annual-1920x1080.png` | 130.4 KB | `54c8dd27803add672e69d0bb982a1a97d6bb61508703942b50ebad5632b3ea50` | TLKM (Non-Bank) Rasio Keuangan Tahunan FY (1920x1080) |
| 17 | `24-fase-2-financial-bbca-desktop-1366x768.png` | 109.8 KB | `fd6d0ff23a353b0013384103bff67d9c0d4dac8473f31de2744fac6e1735f710` | BBCA Laba Rugi Kuartalan pada Viewport Laptop 1366x768 (Sidebar Navigation Longgar Tanpa Terpotong) |
| 18 | `25-fase-2-financial-bbca-tablet-768x1024.png` | 86.7 KB | `86ae208cb6e62dad3b2f6b8d44805754a0534600eaa45233757f50d768e97e7f` | BBCA Laba Rugi Kuartalan pada Viewport Tablet Portrait 768x1024 (Grid 2 Kolom Longgar) |
| 19 | `26-fase-2-financial-bbca-mobile-390x844-header.png` | 114.2 KB | `af615d7a03b2441b245cf589851ce05a555ecd74188c94e0b5d4ac1c4c0c1aff` | BBCA Mobile 390x844 (Header): Ticker BBCA Utuh, Target Sentuh 44px, Tanpa Judul/Input Ganda |
| 20 | `27-fase-2-financial-bbca-mobile-390x844-statements-table.png` | 98.7 KB | `bbf20500246f5b9a18b320ffd2373bb1c9a33a2656236566f021e59b7fbe0644` | BBCA Mobile 390x844 (Tabel Laporan Keuangan): Tampilan Langsung Tabel Finansial Multi-Periode |
| 21 | `28-fase-2-financial-bbca-mobile-360x780-statements-table.png` | 87.4 KB | `ea820ff9ca79e1e7d1fd0fdf43589d5a62b8181e822bea969ce82494005d3285` | BBCA Mobile 360x780 (Tabel Finansial): Zero OverflowX (scrollWidth 360 <= 360), Tabel Responsif |

---

## VERIFIKASI ZERO OVERFLOW & TARGET SENTUH MOBILE (ANTISLOP-LAYOUTMOBILE & ANTISLOP-HUMAN)
- **Viewport 390x844 (iPhone 12/13/14):** Ticker input `#analisisInput` mendapatkan lebar penuh (width: 100%, min-height: 44px). Kode saham `BBCA` tampil utuh 100% tanpa terpotong.
- **Target Sentuh Tombol:** Tombol `Analisis Saham` dan `API Key` memiliki `min-height: 44px` (memenuhi standar aksesibilitas WCAG AA).
- **Viewport 360x780 (Android Kecil):** Diukur langsung via DOM:
  - `document.documentElement.scrollWidth`: 360px (Target <= 360px: **PASS / TIDAK ADA OVERFLOW HORIZONTAL**)
  - `document.documentElement.clientWidth`: 360px
- **Eliminasi Judul & Input Ganda:** Header lokal `.ac-financial-header` pada sub-panel Financial disembunyikan (`display: none !important`). Header Ticker Terpadu di bagian atas menjadi satu-satunya sumber konteks ticker.
- **Responsif Tablet (768x1024):** Grid 4 kartu metrik berubah menjadi 2 kolom (`repeat(2, minmax(0, 1fr))`) sehingga teks metrik leluasa dan tidak berhimpitan.
- **Padding Navigasi Sidebar (1366x768):** `#appSidebar > .sidebar-nav` memiliki `padding-bottom: 32px` sehingga item navigasi terakhir (`Subscription`) tidak terpotong oleh footer.

---

## REKONSILIASI SUMBER DATA BBCA (AC-2.5 FAKTUIL)
- **Harga Penutupan Nyata:** Rp 5.950 (Per 13 Okt 2026, dari transaksi harian `stock_daily_history`).
- **Saham Beredar:** 122.042.299.500 lembar (122,04 Mrd lembar).
- **Market Cap Dinamis:** Rp 5.950 x 122.042.299.500 = **Rp 726,15 T** (menghilangkan angka lama Rp 1.275 T yang bersumber dari harga statis lama Rp 10.450).
- **Book Value Per Share (BVPS):** Rp 2.125,15.
- **Price to Book Value (PBV):** Rp 5.950 / Rp 2.125,15 = **2,80x** (konsisten di kartu metrik atas maupun tabel rasio).
