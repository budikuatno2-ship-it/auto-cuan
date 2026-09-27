# AUDIT VISUAL & PEMETAAN WORKSPACE AUTO-CUAN

**Status dokumen:** BLUEPRINT LOKAL — READ-ONLY AUDIT
**Tanggal audit:** 2026-09-27
**Mode:** Isolasi perencanaan. Tidak ada file produksi yang diubah, tidak ada build test dijalankan, tidak ada `git commit` / `git push`.
**File yang dibuat:** `docs/AUDIT-VISUAL-PEMETAAN.md` (hanya file ini).

---

## 0. CATATAN METODOLOGI & BATAS AUDIT

Dokumen ini disusun dengan disiplin *evidence-first*. Setiap klaim diberi label salah satu dari tiga status berikut:

| Label | Arti |
|---|---|
| **[FAKTA]** | Terverifikasi langsung dari isi file lokal, lengkap dengan nomor baris. |
| **[HIPOTESIS]** | Penjelasan yang masuk akal dan didukung petunjuk kuat di kode, tetapi **belum** dikonfirmasi lewat runtime/browser. Perlu verifikasi sebelum diimplementasikan. |
| **[TIDAK TERVERIFIKASI]** | Klaim dari direktif yang **tidak dapat dibuktikan** dari analisis statis codebase. Bisa benar di runtime, tetapi bukti lokal tidak mendukungnya apa adanya. |

### 0.1 Temuan Korektif atas Asumsi Direktif (WAJIB DIBACA SEBELUM IMPLEMENTASI)

Audit menemukan **tiga perbedaan material** antara penamaan di direktif dan realitas codebase. Ini bukan nitpick — implementasi yang mengikuti nama lama akan gagal total karena selektornya tidak ada.

**Koreksi 1 — Tidak ada satu pun `id="tab-*"` di codebase.**
**[FAKTA]** Pencarian penuh `public/index.html` untuk pola `id="tab-` mengembalikan **nol hasil**. Direktif menyebut `#tab-dashboard`, `#tab-analisis`, `#tab-sektor-hot`, `#tab-portofolio`, `#tab-watchlist`, `#tab-track-record`, `#tab-macro-deepscan`, `#tab-kelola-keuangan`. **Semua nama itu tidak ada.**

Sistem navigasi sebenarnya memakai **dua atribut berbeda**:
- Tombol navigasi: `data-sidebar-page="<slug>"` (di sidebar) dan `data-page="<slug>"` (di nav-btn header)
- Panel konten: `id="page-<slug>"`

Pemetaan resmi (terverifikasi):

| # | `data-sidebar-page` (baris) | `id` panel (baris) | Slug navigasi |
|---|---|---|---|
| 1 | `dashboard` (469) | `page-dashboard` (614) | `dashboard` |
| 2 | `analisis` (473) | `page-analisis` (742) | `analisis` |
| 3 | `sektor` (477) | `page-sektor` (912) | `sektor` |
| 4 | `screener` (481) | `page-screener` (951) | `screener` |
| 5 | `portofolio` (485) | `page-portofolio` (1392) | `portofolio` |
| 6 | `watchlist` (489) | `page-watchlist` (1822) | `watchlist` |
| 7 | `trackrecord` (493) | `page-trackrecord` (1493) | `trackrecord` |
| 8 | `deepscan` (497) | `page-deepscan` (1945) | `deepscan` |
| 9 | `money-management` (501) | `page-money-management` (2009) | `money-management` |

Perhatikan: direktif menulis `#page-stock-analysis` dan `#tab-kelola-keuangan`. Yang benar adalah **`page-analisis`** dan **`page-money-management`**. Selain itu ada 3 panel halaman tambahan di luar 9 tab: `page-subscription` (611), `page-chart` (1312), `page-news` (1344).

**Koreksi 2 — "Double header" bukan dua `.app-header` yang identik.**
**[FAKTA]** Hanya ada **satu** `<header class="app-header ...">` (baris 524). Yang menciptakan duplikasi visual adalah `<nav class="mobile-nav-row header-shell">` yang berada **di dalam** header yang sama (baris 568–607), berisi 9 tombol `.nav-btn` dengan `data-page` (570, 574, 578, 582, 586, 590, 594, 598, 602) — daftar tujuan yang **persis sama** dengan 9 tombol sidebar di baris 469–501.

Komentar di dalam kode sendiri mengakui hal ini (baris 446–452):
> *"This is the single navigation surface for the app: the old horizontal header nav was a second copy of the same nine destinations."*

Jadi kondisi sebenarnya adalah **tiga salinan** dari sembilan tujuan yang sama: sidebar (469–501) + nav-row header (570–602) + tidak ada salinan ketiga kecuali mobile. Yang perlu diputuskan adalah apakah `mobile-nav-row` dipertahankan sebagai affordance mobile atau dihapus sepenuhnya setelah sidebar menjadi collapsible.

**Koreksi 3 — Logo sidebar secara statis SUDAH dibatasi ukurannya.**
**[FAKTA]** `.brand-mark` didefinisikan di `premium-workstation-core.css` baris 198–206 dengan `width: 34px !important; height: 34px !important`. Untuk konteks sidebar, `ui-theme.css` baris 2775–2776 menambahkan:
```
.sidebar-brand .brand-mark { display: grid; place-items: center; flex: 0 0 34px; }
.sidebar-brand .brand-mark svg { width: 18px; height: 18px; }
```
**[TIDAK TERVERIFIKASI]** Klaim "SVG logo tidak memiliki batasan ukuran sehingga meluap" **tidak dapat direproduksi dari analisis statis**. Aturan pembatas ada dan spesifisitasnya cukup.

Namun audit menemukan **kerapuhan nyata yang relevan** — lihat BAB 2.1 untuk analisis lengkap beserta bukti asimetrinya.

---

## BAB 1: BEDAH 11 REFERENSI EKSTERNAL & STANDAR SPESIFIKASI TEKNIS

**[CATATAN BATAS]** Audit ini berjalan tanpa akses jaringan. Isi 11 referensi di bawah **tidak diverifikasi dengan mengunjungi URL-nya**. Yang disajikan adalah (a) aturan arsitektur yang ditetapkan direktif, dan (b) status adopsinya di codebase berdasarkan bukti baris lokal. Kolom "Status di Codebase" adalah bagian yang dapat dipertanggungjawabkan secara teknis.

---

### 1.1 TanStack Table — `https://github.com/tanstack/table`

**Aturan yang diadopsi:**

| # | Aturan | Rasional |
|---|---|---|
| 1 | **Headless model** — logika tabel (sorting, filtering, pagination) terpisah dari markup. Tabel tidak "memiliki" DOM-nya. | Memungkinkan satu mesin tabel melayani 9 tab tanpa memaksa satu komponen monolitik. |
| 2 | **DOM semantik `<table>`** — gunakan `<table><thead><tbody><tfoot>`, bukan `<div role="table">`. | Aksesibilitas bawaan: screen reader sudah paham struktur tabel asli. |
| 3 | **`thead` sticky**: `position: sticky; top: 0; z-index: 2` | Header tetap terbaca saat 500+ baris di-scroll. |
| 4 | **`border-collapse: separate` + `border-spacing: 0`** | Syarat teknis mutlak agar `position: sticky` pada `<th>` dan `<td>` berfungsi. Dengan `border-collapse: collapse`, sticky header pecah di Chrome/Safari. |
| 5 | **Compact row density 34–36px** | Kepadatan informasi workstation finansial. |
| 6 | **Numeric right-alignment + `font-variant-numeric: tabular-nums lining-nums`** | Digit lebar tetap sehingga titik desimal sejajar satu kolom. Tanpa ini, angka tidak dapat dibandingkan secara vertikal. |

**Status di codebase — mayoritas SUDAH diterapkan [FAKTA]:**

| Aturan | Bukti lokal | Status |
|---|---|---|
| DOM semantik | `index.html` 1065, 1164, 1274, 1985, 2071, 2197 | ✅ |
| `border-collapse: separate; border-spacing: 0` | `premium-workstation-core.css` 763–767; `index-shell.css` 412 | ✅ |
| Sticky thead `z-index: 2` | `premium-workstation-core.css` 779–786 (`top: 0; z-index: 2`) | ✅ |
| Sticky thead `z-index: 3` (lapisan lebih baru) | `spreadsheet-grade.css` 163–172 | ✅ |
| Row height 34–36px | `spreadsheet-grade.css` 300 (`height: 34px` untuk `thead th`), 315 (`height: 36px` untuk `tbody td`) | ✅ |
| `tabular-nums lining-nums` | `spreadsheet-grade.css` 282–283, 327; `premium-workstation-core.css` 766, 851 | ✅ |
| Token row height | `premium-workstation-core.css` 97–98 (`--ac-row-h: 36px; --ac-row-h-dense: 31px`) | ✅ |

**Celah yang teridentifikasi [FAKTA]:**
- **Dua rezim sticky `z-index` yang tidak konsisten.** `premium-workstation-core.css` 779–786 memakai `z-index: 2`; `spreadsheet-grade.css` 163–172 memakai `z-index: 3`. Karena `spreadsheet-grade.css` dimuat **terakhir** (lihat `index.html` 125), tabel yang cocok dengan kedua selektor akan memakai `3`. Tetapi tabel yang hanya cocok dengan selektor pertama tetap di `2`. Ini menciptakan risiko header tertimpa sel sticky kolom-pertama yang ber-`z-index: 3` (`premium-workstation-core.css` 829).
- **`border-collapse: collapse` masih dipakai di beberapa tabel** yang tidak termasuk kontrak spreadsheet-grade: `index.html` 1065 (`border-collapse min-w-[1100px]`), 1164, 1274, 1622, 1794, 1985. Tabel-tabel ini memakai `sticky top-0` pada `thead` (1066, 1165, 1275, 1623, 1795, 1986) — kombinasi yang secara teknis rapuh.

---

### 1.2 Inspo MCP — `https://github.com/Nutlope/inspo` & `https://inspomcp.dev/`

**Aturan yang diadopsi:**

| # | Aturan | Rasional |
|---|---|---|
| 1 | **Capture layout** — ambil pola tata letak yang sudah terbukti, jangan menciptakan tata letak baru per halaman. | Sembilan tab harus terasa seperti satu produk. |
| 2 | **Visual context extraction** — ekstrak token (warna, jarak, radius, bayangan) dari referensi menjadi variabel, bukan nilai literal. | Memungkinkan dark/light di-switch tanpa menulis ulang setiap komponen. |
| 3 | **Standardisasi surface state** — setiap permukaan punya himpunan state baku: default / hover / active / focus-visible / disabled / empty / loading / error. | Mencegah satu tab punya 5 gaya "kosong" yang berbeda. |

**Status di codebase:**

- **Surface state — sebagian besar SUDAH ada [FAKTA].** Himpunan kelas kanonik didefinisikan di `premium-workstation-core.css` 337–393 (`.ac-surface`, `.panel`, `.dashboard-card`, `.feature-card`, `.portfolio-card`, `.skeleton-card`, `.landing-auth-card`, `.faq-item`, `.subscription-summary`, `.dashboard-pick-card`, `.portfolio-row-card`, `.mock-card`, `.chart-shell`, `.portfolio-shell`). Hover seragam di 385–393. Empty state di 1643–1670 (`.empty-state`, `.empty-state-icon`, `.empty-state-text`). Skeleton di 1672–1676.
- **Tokenisasi — SEBAGIAN, dengan cacat serius [FAKTA].** Terdapat **tiga lapisan token yang saling tumpang tindih** dan tidak sinkron:
  - `ui-theme.css` 42–188 → `--color-*`, `--ac-*` (dideklarasikan sebagai "THE token layer")
  - `premium-workstation-core.css` 9–99 → `--color-*` (duplikat!), `--pw-*`, `--ac-*` (duplikat!)
  - `spreadsheet-grade.css` 34–44 → `--sp-*`
  
  Ini adalah **pelanggaran langsung** terhadap prinsip "visual context extraction": token yang sama (`--color-bg-canvas`, `--color-text-primary`, `--color-border-subtle`, `--ac-*`) dideklarasikan di lebih dari satu file dengan nilai yang harus dijaga manual agar sinkron. Lihat BAB 2.4 untuk konsekuensi konkretnya di light mode.

---

### 1.3 NeedMCP — `https://needmcp.com/`

**Aturan yang diadopsi:**

| # | Aturan | Rasional |
|---|---|---|
| 1 | **Inspeksi browser headless** — audit visual dilakukan pada DOM yang benar-benar ter-render, bukan pada markup sumber. | Bug seperti "sidebar hilang" hanya muncul setelah JS berjalan. |
| 2 | **Audit visual layer** — periksa computed style, bukan hanya stylesheet yang ditulis. | Menangkap konflik cascade yang tidak terlihat dari membaca satu file. |

**Status di codebase — infrastruktur audit SUDAH ADA [FAKTA]:**

- `public/unified-cockpit.css` (463 baris) — stylesheet cockpit
- Artefak investigasi di root repo: `tmp_investigasi/inspect-layout.js`, `tmp_investigasi/measure.html`, `public/tmp-measure.html`, `public/tmp-measure2.html`, `public/tmp-verify.html` (terdaftar di daftar file workspace).
- **[CATATAN]** File-file `tmp-*` di atas **tidak ditemukan** saat audit dijalankan (`ENOENT` pada keempat path). Kemungkinan sudah dibersihkan. Yang tersisa hanya jejaknya di daftar tab VS Code. Ini berarti audit visual headless **pernah** dilakukan tetapi artefaknya tidak dipertahankan sebagai bukti yang dapat direproduksi.

**Rekomendasi:** setiap klaim visual di BAB 2 yang berlabel **[HIPOTESIS]** harus ditutup dengan pengukuran `getBoundingClientRect()` pada DOM ter-render sebelum implementasi. Skrip pengukuran yang dipakai sebelumnya tidak boleh dihapus sampai blueprint ini disetujui.

---

### 1.4 Awesome Design MD — `https://github.com/VoltAgent/awesome-design-md`

**Aturan yang diadopsi:**

| # | Aturan | Rasional |
|---|---|---|
| 1 | **Kontrak design token: skala spacing 8px** | Semua jarak kelipatan 8 (atau 4 untuk fine-tuning). Menghilangkan "magic number" 7px, 11px, 13px. |
| 2 | **WCAG AA: rasio kontras minimal 4.5:1** untuk teks normal. | Kepatuhan aksesibilitas, bukan estetika. |
| 3 | **Larangan tegas: border neon acak.** | Border harus fungsional (memisahkan/mengelompokkan), bukan dekoratif. |
| 4 | **Larangan tegas: cardification berlebih ("AI-slop").** | Tidak setiap potongan konten dibungkus kartu ber-border ber-shadow ber-radius. |

**Status di codebase — terdapat PELANGGARAN terukur [FAKTA]:**

**Pelanggaran 1 — Skala spacing tidak 8px.** Nilai jarak yang teramati di `premium-workstation-core.css` dan `ui-theme.css`:
- `gap: 7px` (`premium-workstation-core.css` 2103), `gap: 9px` (2801), `padding: 9px 15px` (1393), `padding: 5px 9px` (967), `padding: 6px 9px` (250), `gap: 2px` (302), `gap: 3px` (1129), `padding: 3px 7px` (526), `min-height: 31px` (426, 967, 1740), `min-height: 38px` (2857), `height: 34px` (300), `height: 36px` (315)
- Hanya sebagian yang kelipatan 8 (`padding: 12px`, `padding: 14px`, `gap: 8px`, `gap: 10px`).

**Pelanggaran 2 — Kontras berpotensi di bawah 4.5:1.** Kandidat terkuat:
- `premium-workstation-core.css` 452: `.ac-section-hint { color: #596779 }` — pada latar `#0d1320` (rasio perkiraan ≈ 3.1:1). **Gagal AA untuk teks normal.**
- `premium-workstation-core.css` 411: `.panel-subtitle { color: #6f7e91 }` — pada `#09111a` (perkiraan ≈ 4.0:1). **Di bawah ambang.**
- `premium-workstation-core.css` 1668–1670: `.empty-state-text { color: #657487 !important }` — perkiraan ≈ 3.7:1. **Gagal AA.**
- `ui-theme.css` 2805: `.user-role { color: var(--color-text-muted); font-size: 9px }` — `--color-text-muted: #738096` pada `--color-bg-surface: #0d1320`, perkiraan ≈ 4.1:1, **dan** ukuran 9px sangat kecil. **Gagal AA dan di bawah batas keterbacaan.**

**Pelanggaran 3 — Border neon & cardification.** Border aksen yang berulang tanpa fungsi struktural:
- `premium-workstation-core.css` 477: `.dashboard-hero { border: 1px solid rgba(45, 212, 163, .13) }` + `485–491` `::before` bar vertikal gradien emerald + `493–501` `::after` garis horizontal gradien emerald
- `premium-workstation-core.css` 668–678: `#page-dashboard .panel::before` bar 2px emerald
- `premium-workstation-core.css` 1013–1032: `.dt-card-item::before` bar 2px + `::after` garis gradien emerald — diterapkan ke **setiap** kartu screener
- `premium-workstation-core.css` 2174–2181: `.radar-panel::before` garis gradien emerald
- `premium-workstation-core.css` 1015–1021: `content: ''` bar dekoratif pada setiap card item

Total ada **minimal 7 pseudo-element dekoratif beraksen emerald** yang tidak menyampaikan informasi apa pun. Ini persis pola yang dilarang.

---

### 1.5 Refero Design — `https://refero.design/`

**Aturan yang diadopsi (pola dashboard fintech: Linear, Robinhood, Stripe):**

| # | Aturan | Nilai target |
|---|---|---|
| 1 | **Surface slate bertingkat** | `#090d16` → `#0d1320` → `#111a2a` (tiga tingkat, tidak lebih) |
| 2 | **Typographic density** | Skala kecil dan rapat; label 9–11px, nilai 15–24px |
| 3 | **Hairline divider 1px transparan** | `rgba(148,163,184,.08–.12)`, bukan `#1c2333` solid |

**Status di codebase — tiga tingkat surface SUDAH tepat [FAKTA]:**

`premium-workstation-core.css` 12–14 mendefinisikan persis nilai yang diminta:
```
--color-bg-canvas: #090d16;
--color-bg-surface: #0d1320;
--color-bg-elevated: #111a2a;
```
Ditambah `--color-bg-hover: #162033` (15). Ini **sesuai spesifikasi Refero** dan harus dipertahankan sebagai kontrak.

Hairline divider juga sudah benar: `--color-border-subtle: rgba(148, 163, 184, .12)` (19), `--color-border-default: rgba(148, 163, 184, .20)` (20).

**Celah [FAKTA]:** token surface ini **didefinisikan dua kali** — sekali di `ui-theme.css` 43–46 dan sekali lagi di `premium-workstation-core.css` 12–15. Nilainya identik hari ini, tetapi tidak ada mekanisme yang menjaganya tetap identik.

---

### 1.6 UI Layouts — `https://ui-layouts.com`

**Aturan yang diadopsi:**

| # | Aturan | Nilai target |
|---|---|---|
| 1 | **App-shell flex 2-kolom** | Sidebar dan konten adalah **sibling** dalam satu flex row |
| 2 | **Sidebar kiri murni collapsible** | 240px normal → 72px icon-only |
| 3 | **Main workspace scroll container independen** | Wajib `min-width: 0` |

**Status di codebase — SUDAH DIIMPLEMENTASIKAN dengan benar [FAKTA]:**

`ui-theme.css` 2706–2711:
```
.app-layout { display: flex; align-items: flex-start; width: 100%; min-height: 100vh; }
```
`ui-theme.css` 2713–2726:
```
.app-sidebar { position: sticky; top: 0; width: 240px; height: 100vh; flex: 0 0 auto; ... z-index: 60; }
```
`ui-theme.css` 2728–2731:
```
.app-sidebar.collapsed, .app-sidebar.is-collapsed { width: 72px; }
```
`ui-theme.css` 2818–2823:
```
.app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
```

Komentar di `ui-theme.css` 2815–2817 secara eksplisit menjelaskan peran `min-width: 0`:
> *"`min-width: 0` is what stops a wide table inside a page from forcing the flex row wider than the viewport — without it the column refuses to shrink below its content and the sidebar is pushed off-screen."*

**[FAKTA] Ini adalah jawaban teknis atas keluhan "sidebar hilang".** Penyebabnya bukan sidebar yang di-hide, melainkan kolom konten yang menolak menyusut. Lihat BAB 3.2 untuk rantai bukti lengkap.

**Celah [FAKTA]:** markup aktual **tidak** memiliki wrapper `.app-main-viewport` yang didefinisikan di `ui-theme.css` 2808–2813. Struktur HTML sebenarnya (`index.html` 453–521) adalah `.app-layout` → `.app-sidebar` + `.app-main` **langsung**. Kelas `.app-main-viewport` didefinisikan tetapi tidak pernah dipakai — CSS mati.

---

### 1.7 FeralUI Gradients — `https://feralui.dev/gradients`

**Aturan yang diadopsi:**

| # | Aturan |
|---|---|
| 1 | **Formula CSS:** `background` statis berupa **radial mesh halus** dari `#090d16` ke `#0b0f19` |
| 2 | **Tanpa pattern grid kaku** — hapus grid berulang yang menutupi seluruh halaman |

**Status di codebase — SUDAH DIIMPLEMENTASIKAN [FAKTA]:**

`spreadsheet-grade.css` 58–66 adalah implementasi persisnya:
```
body {
  background-color: var(--sp-bg-mid);
  background-image:
    radial-gradient(1100px 620px at 12% -12%, var(--sp-mesh-1), transparent 62%),
    radial-gradient(900px 540px at 88% -6%, var(--sp-mesh-2), transparent 60%),
    radial-gradient(1000px 700px at 50% 108%, var(--sp-mesh-3), transparent 65%);
  background-attachment: fixed;
  background-repeat: no-repeat;
}
```
Dengan token `--sp-bg-deep: #090d16` dan `--sp-bg-mid: #0b0f19` (`spreadsheet-grade.css` 36–37) — **persis nilai yang diminta direktif**.

Grid lama sudah dinetralkan: `premium-workstation-core.css` 2066–2074 menetapkan `body::before { opacity: 0; background-image: none }`, dan `spreadsheet-grade.css` 71–73 menegaskan kembali `body::before { background-image: none }`.

**Celah [FAKTA] — mesh ditimpa oleh lapisan lama:**
- `premium-workstation-core.css` 129–139 masih menetapkan `body { background-color: var(--pw-bg); background-image: radial-gradient(980px 400px at 50% -250px, rgba(45,212,163,.035), transparent 72%) }`
- `ui-theme.css` 2674–2676 menetapkan `html.light body { background-image: none !important }`
- `spreadsheet-grade.css` 75–80 menetapkan `html.light body { background-image: <mesh> }`

Karena `spreadsheet-grade.css` dimuat terakhir dan `!important` di `ui-theme.css` 2675 hanya berlaku pada deklarasi yang sama-sama `!important`, mesh light mode **menang** — tetapi ini adalah kemenangan yang rapuh dan bergantung pada urutan muat, bukan pada desain.

---

### 1.8 21st.dev — `https://21st.dev/`

**Aturan yang diadopsi (micro-components bursa):**

| # | Komponen | Spesifikasi |
|---|---|---|
| 1 | **Percentage pill** | Tinggi 20–22px |
| 2 | **Status dot** | Diameter 6px dengan ring halus 2px |

**Status di codebase [FAKTA]:**

- **Percentage pill — SUDAH ada.** `spreadsheet-grade.css` 374: `.percentage-chip { display: inline-flex; align-items: center; min-height: 20px; padding: 1px 7px; border-radius: 999px; font-variant-numeric: tabular-nums; }` — **tepat 20px**, sesuai spesifikasi bawah. Varian warna di 372–373 (`.is-up` / `.is-down`) memakai token `--color-positive` / `--color-negative`.
- **Pill status generik.** `spreadsheet-grade.css` 354–367: `.sp-pill { padding: 2px 9px; border-radius: var(--sp-pill-radius); font-size: 10px; font-weight: 800; }` dengan `--sp-pill-radius: 999px` (43).
- **Status dot — SUDAH ada, tetapi tidak konsisten ukurannya.** Titik status ditemukan dalam beberapa ukuran berbeda:
  - `index.html` 543, 621: `.header-status-dot` (ukuran ditentukan di CSS, bukan 6px eksplisit)
  - `index.html` 653: `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500">` = **6px** ✅ (Tailwind `w-1.5` = 0.375rem = 6px)
  - `index.html` 556: `<span class="w-2 h-2 rounded-full bg-emerald-400">` = **8px** ❌
  - `index.html` 794, 862: `<span class="w-2 h-2 rounded-full bg-emerald-400">` = **8px** ❌
  - `index.html` 2239: `<span class="w-2 h-2 rounded-full bg-emerald-500">` = **8px** ❌
  
  **[HIPOTESIS]** Empat dari lima dot berukuran 8px, bukan 6px. Standarisasi ke token tunggal (`.status-dot` dengan `width:6px;height:6px` + `box-shadow: 0 0 0 2px <ring>`) akan menghilangkan variasi ini.

---

### 1.9 Uiverse — `https://uiverse.io/`

**Aturan yang diadopsi:**

| # | Aturan |
|---|---|
| 1 | **Pola switch dark/light minimalis** |
| 2 | **Compact button 28×28px** |
| 3 | **Aksesibel**, ditempatkan di **sidebar footer** |

**Status di codebase — SUDAH SESUAI [FAKTA]:**

`ui-theme.css` 2777–2790:
```
.sidebar-collapse-toggle,
.theme-toggle-compact {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border: 1px solid var(--color-border-default);
  border-radius: 8px;
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
}
```
**Tepat 28×28px**, sesuai spesifikasi.

Markup di `index.html` 514–516:
```html
<button id="themeToggleCompact" type="button" onclick="toggleAppTheme()" class="theme-toggle-compact" aria-label="Toggle Theme" title="Ganti tema terang/gelap">
    <span id="sidebarThemeIcon" aria-hidden="true">🌙</span><span class="sr-only" id="sidebarThemeLabel">Dark Mode</span>
</button>
```

**[FAKTA] Aksesibilitas sudah benar:** `aria-label` ada, ikon dekoratif di-`aria-hidden="true"`, label teks tersedia via `.sr-only`, dan `title` memberikan tooltip.

**[KOREKSI atas versi awal audit]** Versi pertama dokumen ini menyatakan emoji dan label toggle bersifat statis. **Itu SALAH.** `applyAppTheme()` memang memperbarui keduanya — `index.html` 7753–7756:
```javascript
7753: var sbIcon = document.getElementById('sidebarThemeIcon');
7754: var sbLabel = document.getElementById('sidebarThemeLabel');
7755: if (sbIcon) sbIcon.textContent = isLight ? '☀️' : '🌙';
7756: if (sbLabel) sbLabel.textContent = isLight ? 'Light Mode' : 'Dark Mode';
```

**Mekanisme lengkap yang terverifikasi [FAKTA]:**
| Fungsi | Baris | Tugas |
|---|---|---|
| `applyAppTheme(theme)` | 7743–7760 | Pasang `html.light` (7745), `data-theme` (7746), `body.light` (7747), background inline (7748), ikon+label header (7749–7752), ikon+label sidebar (7753–7756), meta theme-color (7757–7758), `localStorage` (7759) |
| `toggleAppTheme()` | 7761–7764 | Baca state dari `html.light` (7762), panggil `applyAppTheme()` dengan kebalikannya (7763) |
| `initAppTheme()` | 7765–7769 | Baca `localStorage` (7766–7767), panggil `applyAppTheme()` (7768) |
| Auto-init | 7770–7774 | `DOMContentLoaded` → `initAppTheme()` |

**Kesimpulan:** mekanisme toggle **sudah benar dan lengkap**, termasuk sinkronisasi label dan `aria` state. Tidak ada cacat di sini.

**[HIPOTESIS] Satu celah kecil yang tersisa — *flash of incorrect label*:** bootstrap di `index.html` 56–67 memasang kelas `html.light` **sebelum paint** (baris 60), tetapi `initAppTheme()` baru berjalan pada `DOMContentLoaded` (7770–7774). Jadi ada jendela singkat di mana tema sudah terang namun label tombol masih menampilkan nilai default dari markup (🌙 / "Dark Mode") di `index.html` 515. Ini adalah label yang tertunda, **bukan label yang permanen salah**. Dampak rendah. Untuk konfirmasi: throttle CPU 6× di DevTools dan amati tombol tema pada hard reload dengan `localStorage['autocuan_theme'] === 'light'`.

---

### 1.10 GSAP / Awwwards — `https://gsap.com/showcase/` & `https://www.awwwards.com/`

**Aturan yang diadopsi — Performance ceiling:**

| # | Larangan | Alasan |
|---|---|---|
| 1 | **Three.js** | Tidak ada kebutuhan 3D; biaya bundle + GPU besar. |
| 2 | **WebGL** | Sama; tidak ada nilai untuk tabel data. |
| 3 | **Scroll-jacking** | Merusak aksesibilitas dan persepsi performa. |
| 4 | **CSS blur berat** | `filter: blur()` besar memaksa composite layer dan menghancurkan FPS pada laptop. |

**Status di codebase — mayoritas PATUH [FAKTA]:**

- **Tidak ada Three.js / WebGL.** Pencarian seluruh `public/*.js` dan `index.html` tidak menemukan `three.js`, `THREE.`, `WebGLRenderingContext`, atau `canvas.getContext('webgl')`. Chart memakai Lightweight Charts (`unified-cockpit-runtime.js` 96–103) yang berbasis Canvas 2D.
- **Tidak ada scroll-jacking.** Tidak ada `scroll-behavior: smooth` yang dipaksakan global, tidak ada `scroll-snap` pada container utama, tidak ada event `wheel` yang di-preventDefault.
- **Reduced-motion dihormati.** `premium-workstation-core.css` 2002–2040 menonaktifkan transisi dan transform saat `prefers-reduced-motion: reduce`.

**Celah [FAKTA] — blur masih dipakai di beberapa tempat:**
- `premium-workstation-core.css` 185: `.app-header { backdrop-filter: blur(18px) saturate(118%) }`
- `premium-workstation-core.css` 1132: `#page-analisis > div:first-child { backdrop-filter: blur(14px) }`
- `premium-workstation-core.css` 1355: `.landing-hero::before { filter: blur(96px) }` — **96px, sangat berat**
- `premium-workstation-core.css` 1450: `.landing-hero .landing-card::after { filter: blur(46px) }`
- `premium-workstation-core.css` 1576: `#authChoiceModal { backdrop-filter: blur(8px) !important }`
- `ui-theme.css` 2738: `.sidebar-scrim { backdrop-filter: blur(3px) }`

**[HIPOTESIS]** `filter: blur(96px)` pada `premium-workstation-core.css` 1355 adalah satu-satunya pelanggaran berat. Namun perlu dicatat bahwa ini berada di **landing page**, bukan di dashboard, dan `premium-workstation-core.css` 2032–2034 sudah menonaktifkannya saat reduced-motion. Dampak pada dashboard diperkirakan nol. **Verifikasi dengan Chrome Performance profile sebelum mengubahnya.**

---

### 1.11 HolverAI Dashboard — `https://api.holver.id/`

**Aturan yang diadopsi — Benchmark layout utama:**

| # | Aturan | Target |
|---|---|---|
| 1 | Sidebar vertikal kokoh | Kolom tetap, bukan overlay |
| 2 | Tombol collapse **di atas** | Di header sidebar |
| 3 | Profil user di **footer paling bawah** | Bersebelahan dengan theme switcher |
| 4 | **Kontras item aktif** | Item aktif harus langsung terlihat |

**Status di codebase — 3 dari 4 SESUAI [FAKTA]:**

| Aturan | Bukti | Status |
|---|---|---|
| Sidebar vertikal kokoh | `ui-theme.css` 2713–2726 (`position: sticky; width: 240px; height: 100vh`) | ✅ |
| Tombol collapse di atas | `index.html` 464 (di dalam `.sidebar-brand`, 456–467) + `ui-theme.css` 2761–2769 | ✅ |
| Profil + theme switcher di footer | `index.html` 506–517 (`sidebar-footer` → `user-profile-badge` 507 + `themeToggleCompact` 514) | ✅ |
| **Kontras item aktif** | `ui-theme.css` 2874–2878 | ❌ **BERMASALAH** |

**Cacat kontras item aktif [FAKTA]:**

`ui-theme.css` 2874–2878:
```
.sidebar-item.active {
  color: #090d16;
  background-color: #ffffff;
  border-color: #ffffff;
}
```

Item aktif menjadi **putih solid dengan teks hampir hitam**. Ini masalah serius:
1. **Tidak konsisten dengan bahasa visual produk.** Seluruh aplikasi memakai emerald sebagai satu-satunya aksen utama (`premium-workstation-core.css` 5–6: *"emerald as the single primary accent"*). Item aktif putih adalah aksen **kedua** yang tidak diminta.
2. **Bertabrakan dengan mode Light.** Di light mode, `ui-theme.css` 2646–2650 menimpanya menjadi `background-color: #ecfdf5; color: #047857` — jadi item aktif berubah **warna dan makna** antara dark dan light tanpa alasan desain.
3. **Menghasilkan kontras yang terlalu tinggi** (putih vs near-black ≈ 19:1) sehingga justru menarik perhatian berlebihan ke navigasi, bukan ke konten.
4. Di **dark mode**, item aktif putih adalah elemen paling terang di seluruh layar — mengalahkan hierarki nilai data di tabel.

**[HIPOTESIS]** Ini kemungkinan besar adalah sisa dari eksperimen desain yang tidak pernah diselaraskan dengan token `--color-accent`. Perbaikan yang diusulkan ada di BAB 4.3.

---

### 1.12 Ringkasan Kepatuhan BAB 1

| # | Referensi | Status | Aksi utama |
|---|---|---|---|
| 1 | TanStack Table | 🟡 Sebagian | Satukan rezim `z-index` sticky; perbaiki `border-collapse` di tabel non-kontrak |
| 2 | Inspo MCP | 🔴 Bermasalah | Konsolidasi 3 lapisan token yang tumpang tindih |
| 3 | NeedMCP | 🟡 Infra ada | Pertahankan skrip pengukuran sampai blueprint disetujui |
| 4 | Awesome Design MD | 🔴 Melanggar | Hapus 7 pseudo-element dekoratif; perbaiki 4 kontras gagal AA; adopsi skala 8px |
| 5 | Refero Design | 🟢 Sesuai | Pertahankan `#090d16 → #0d1320 → #111a2a` sebagai kontrak beku |
| 6 | UI Layouts | 🟢 Sesuai | Hapus `.app-main-viewport` mati |
| 7 | FeralUI Gradients | 🟢 Sesuai | Perjelas urutan kemenangan mesh dark/light |
| 8 | 21st.dev | 🟡 Sebagian | Standarkan status dot ke 6px |
| 9 | Uiverse | 🟢 Sesuai | Perbaiki label toggle yang statis |
| 10 | GSAP/Awwwards | 🟢 Patuh | Tinjau `blur(96px)` di landing |
| 11 | HolverAI | 🔴 1 dari 4 gagal | Perbaiki kontras item aktif sidebar |

---

## BAB 2: ROOT CAUSE CACAT VISUAL PRODUKSI (BUKTI BARIS KODE LOKAL)

### 2.1 Logo Auto-Cuan di Sidebar Kiri

**Klaim direktif:** *"Tag `<svg>` logo Auto-Cuan tidak memiliki batasan ukuran (width/height inline atau CSS max-width) sehingga meluap di sidebar."*

**Temuan audit:**

**[FAKTA] Markup logo sidebar — `index.html` 458:**
```html
<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l5-5 4 4 7-8"/></svg></span>
```

**[FAKTA] Bandingkan dengan logo header — `index.html` 534–536:**
```html
<div class="brand-mark w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-lg flex-shrink-0">
    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path ... /></svg>
</div>
```

**Asimetri kritis yang terkonfirmasi:**

| Atribut | Logo header (535) | Logo sidebar (458) |
|---|---|---|
| Kelas ukuran pada `<svg>` | ✅ `class="w-5 h-5"` (20×20px) | ❌ **tidak ada** |
| Atribut `width`/`height` inline | ❌ tidak ada | ❌ **tidak ada** |
| Kelas pada wrapper | ✅ `w-9 h-9` (36×36px) | hanya `brand-mark` |
| Kelas `flex-shrink-0` | ✅ ada | ❌ tidak ada |
| Atribut `stroke-width` | ✅ `2` | ✅ `2` |
| Atribut `fill` | ✅ `none` | ✅ `none` |
| Atribut `stroke` | ✅ `currentColor` | ✅ `currentColor` |

**[FAKTA] Aturan CSS yang mengikat logo sidebar:**
- `premium-workstation-core.css` 198–206: `.brand-mark { position: relative; width: 34px !important; height: 34px !important; border: 1px solid rgba(45,212,163,.24); border-radius: 8px !important; background: #0c2a21 !important; }`
- `premium-workstation-core.css` 220–222: `.brand-mark svg { color: #73e7c5 !important; }` — **hanya warna, tidak ada ukuran**
- `ui-theme.css` 2775: `.sidebar-brand .brand-mark { display: grid; place-items: center; flex: 0 0 34px; }`
- `ui-theme.css` 2776: `.sidebar-brand .brand-mark svg { width: 18px; height: 18px; }` ← **inilah satu-satunya pembatas ukuran SVG**
- `index-shell.css` 663: `img, svg, video, canvas, table { max-width: 100%; }` — pembatas lebar maksimum, bukan tinggi

**Analisis:**

**[FAKTA]** Klaim "tidak memiliki batasan ukuran" **tidak akurat secara literal**: ada **dua** pembatas — `flex: 0 0 34px` pada wrapper (`ui-theme.css` 2775) dan `width/height: 18px` pada SVG (`ui-theme.css` 2776).

**[HIPOTESIS] Namun ada kerapuhan nyata yang menjelaskan gejala yang dilaporkan:**

1. **SVG tidak punya ukuran intrinsik.** Tanpa atribut `width`/`height`, dan tanpa kelas `w-5 h-5` seperti versi header, ukuran SVG sidebar **sepenuhnya bergantung pada satu baris tunggal** di `ui-theme.css` 2776. Jika baris itu gagal dimuat, di-override, atau berubah urutannya, SVG default ke `width:100%; height:100%` dari containing block — dan containing block-nya adalah `.brand-mark` yang `display: grid; place-items: center`.

2. **Grid + SVG tanpa ukuran = risiko ekspansi.** Dalam konteks `display: grid` tanpa definisi `grid-template-columns`/`rows` eksplisit, item grid (SVG) diperlakukan sebagai grid item. SVG dengan `viewBox` dan tanpa ukuran akan mengisi area grid. Karena `.brand-mark` ber-`width: 34px !important`, batasnya 34px — **kecuali** `!important` itu sendiri yang kalah.

3. **Rantai `!important` yang bertabrakan.** `premium-workstation-core.css` 200–201 memakai `!important` untuk `width`/`height`. `ui-theme.css` 2775 **tidak** memakai `!important` untuk `flex: 0 0 34px`. Jika ada stylesheet lain yang menetapkan `.brand-mark` dengan `!important`, atau jika `flex` diabaikan karena elemen bukan flex item, maka **satu-satunya** yang tersisa adalah `ui-theme.css` 2776 — dan itu bergantung pada SVG benar-benar menjadi anak langsung dari `.brand-mark`.

4. **Perbedaan urutan muat.** `ui-theme.css` dimuat di `index.html` 122, sedangkan `premium-workstation-core.css` dimuat via `@import` di dalam `premium-workstation.css` (`index.html` 123). `@import` dievaluasi **setelah** stylesheet yang mengimpornya di-parse. Dalam praktik browser, sheet hasil `@import` biasanya diterapkan setelah `ui-theme.css` untuk properti yang sama — **kecuali** `premium-workstation.css` gagal dimuat, dalam hal ini seluruh `--pw-*` token dan aturan `.brand-mark` hilang.

**Kesimpulan BAB 2.1:**

| Pertanyaan | Jawaban |
|---|---|
| Apakah SVG punya `width`/`height` inline? | **Tidak** — terkonfirmasi `index.html` 458 |
| Apakah SVG punya kelas ukuran? | **Tidak** — berbeda dari versi header di 535 |
| Apakah ada pembatas CSS? | **Ya, dua** — `ui-theme.css` 2775 dan 2776 |
| Apakah pembatas itu cukup? | **Ya secara statis**, tetapi bergantung pada satu baris tanpa `!important` |
| Apakah klaim "meluap" dapat direproduksi statis? | **Tidak** |
| Apakah ada cacat nyata? | **Ya** — SVG tanpa ukuran intrinsik + ketergantungan pada satu baris CSS tanpa fallback |

**Perbaikan yang diusulkan (BAB 4.3):** berikan SVG `width="18" height="18"` sebagai atribut inline **dan** pertahankan aturan CSS. Ukuran intrinsik menghilangkan seluruh kelas kegagalan ini tanpa bergantung pada cascade.

---

### 2.2 Sidebar Footer Berantakan ("B budi PRO PLAN" & Icon Bulan Menumpuk)

**Klaim direktif:** *"Temukan nomor baris elemen avatar, `#sidebarUserName`, role badge, dan tombol theme toggle. Tunjukkan CSS selector yang hilang atau tidak mendefinisikan layout Flexbox untuk footer tersebut."*

**[FAKTA] Markup lengkap — `index.html` 506–517:**
```html
506: <div class="sidebar-footer">
507:     <div class="user-profile-badge" title="Profil pengguna">
508:         <div class="user-avatar" aria-hidden="true">B</div>
509:         <div class="user-info sidebar-label">
510:             <span class="user-name" id="sidebarUserName">budi</span>
511:             <span class="user-role">PRO PLAN</span>
512:         </div>
513:     </div>
514:     <button id="themeToggleCompact" type="button" onclick="toggleAppTheme()" class="theme-toggle-compact" aria-label="Toggle Theme" title="Ganti tema terang/gelap">
515:         <span id="sidebarThemeIcon" aria-hidden="true">🌙</span><span class="sr-only" id="sidebarThemeLabel">Dark Mode</span>
516:     </button>
517: </div>
```

**[FAKTA] CSS Flexbox untuk footer INI ADA dan lengkap:**
- `ui-theme.css` 2794–2800: `.sidebar-footer { display: flex; align-items: center; gap: 8px; padding: 12px; border-top: 1px solid var(--color-border-subtle); }`
- `ui-theme.css` 2801: `.user-profile-badge { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1; }`
- `ui-theme.css` 2802: `.user-avatar { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 30px; border-radius: 50%; background: var(--color-bg-hover); color: var(--color-text-primary); font-size: 12px; font-weight: 700; }`
- `ui-theme.css` 2803: `.user-info { display: grid; min-width: 0; }`
- `ui-theme.css` 2804: `.user-name { overflow: hidden; color: var(--color-text-primary); font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }`
- `ui-theme.css` 2805: `.user-role { color: var(--color-text-muted); font-size: 9px; font-weight: 700; letter-spacing: .08em; }`
- `ui-theme.css` 2806: `.app-sidebar.collapsed .sidebar-footer { flex-direction: column; }`

**[TIDAK TERVERIFIKASI]** Klaim "CSS selector hilang / tidak mendefinisikan Flexbox" **tidak didukung bukti**. Flexbox didefinisikan dengan benar dan lengkap.

**Namun audit menemukan EMPAT cacat nyata yang menjelaskan gejala "berantakan":**

#### Cacat 2.2.A — Tabrakan nama kelas `.sidebar-footer` antara dua komponen berbeda [FAKTA]

Ada **dua** elemen berbeda yang memakai `.sidebar-footer`:

1. **Sidebar chat** (`index.html` 437–442) — di dalam `<aside id="chatSidebar" class="sidebar hidden">` (427)
2. **Sidebar workspace** (`index.html` 506–517) — di dalam `<aside id="appSidebar" class="app-sidebar hidden">` (455)

Dan ada **dua** aturan CSS untuk nama yang sama:
- `index-shell.css` 425: `.sidebar-footer { padding: 12px 16px; border-top: 1px solid #1c2333; flex-shrink: 0; }`
- `ui-theme.css` 2794–2800: `.sidebar-footer { display: flex; align-items: center; gap: 8px; padding: 12px; border-top: 1px solid var(--color-border-subtle); }`

`index-shell.css` dimuat di `index.html` 119, `ui-theme.css` di 122 — jadi `ui-theme.css` menang untuk properti yang dideklarasikan ulang (`padding`, `border-top`). Tetapi `flex-shrink: 0` dari `index-shell.css` 425 **bertahan** karena tidak dideklarasikan ulang.

**Konsekuensi [HIPOTESIS]:** `flex-shrink: 0` pada `.sidebar-footer` berarti footer **menolak menyusut** saat ruang vertikal sidebar terbatas. Digabung dengan `.sidebar-nav { flex: 1; overflow-y: auto }` (`ui-theme.css` 2793), footer mendapat perlakuan yang tidak diinginkan dalam kondisi sidebar pendek (mis. viewport laptop dengan tinggi 600px): footer mengambil ruangnya lebih dulu, nav menyusut dan scroll. Ini dapat memproduksi tampilan "berantakan" yang dilaporkan.

#### Cacat 2.2.B — `.user-info` memakai kelas `.sidebar-label` yang di-hide saat collapsed [FAKTA]

`index.html` 509: `<div class="user-info sidebar-label">`

`ui-theme.css` 2741–2748:
```
.app-sidebar.collapsed .sidebar-label,
.app-sidebar.collapsed .sidebar-brand-text,
.app-sidebar.collapsed .sidebar-badge,
.app-sidebar.is-collapsed .sidebar-label,
.app-sidebar.is-collapsed .sidebar-brand-text,
.app-sidebar.is-collapsed .sidebar-badge {
  display: none !important;
}
```

**[FAKTA]** Karena `.user-info` **juga** memakai `.sidebar-label`, seluruh nama pengguna dan role **hilang** saat sidebar collapsed. Yang tersisa hanya avatar 30px. Ditambah `ui-theme.css` 2806 (`.app-sidebar.collapsed .sidebar-footer { flex-direction: column }`), hasilnya adalah avatar + tombol tema ditumpuk vertikal dalam kolom 72px.

**[HIPOTESIS]** Ini kemungkinan besar adalah sumber dari keluhan "icon bulan menumpuk". Dalam state collapsed:
- `.sidebar-footer` menjadi `flex-direction: column`
- `.user-avatar` tetap 30×30px (`flex: 0 0 30px`, 2802)
- `.user-profile-badge` tetap `flex: 1` (2801) — di kolom vertikal, `flex: 1` mengontrol **tinggi**, bukan lebar
- `#themeToggleCompact` 28×28px (`flex: 0 0 28px`, 2783)

Total: 30px avatar + 8px gap + 28px tombol = **66px** di dalam sidebar 72px dengan `padding: 12px` (2798). Padding 12px × 2 = 24px, sehingga ruang tersedia hanya **48px** untuk konten 66px. **[HIPOTESIS] Konten meluap (overflow) — dan `ui-theme.css` 2725 menetapkan `overflow-x: hidden` pada `.app-sidebar`, sehingga tidak ada scrollbar; konten terpotong atau tumpang tindih.**

Ini adalah **cacat terukur** yang perlu dikonfirmasi dengan pengukuran DOM.

#### Cacat 2.2.C — Nilai profil di-hardcode di HTML [FAKTA]

`index.html` 508: `<div class="user-avatar" aria-hidden="true">B</div>` — huruf "B" literal
`index.html` 510: `<span class="user-name" id="sidebarUserName">budi</span>` — "budi" literal
`index.html` 511: `<span class="user-role">PRO PLAN</span>` — "PRO PLAN" literal

**[FAKTA]** Hanya `#sidebarUserName` yang diperbarui oleh JS: `index.html` 4784 (`var sidebarName = document.getElementById('sidebarUserName')`).

**[HIPOTESIS]** Avatar "B" **tidak pernah** diperbarui — selalu huruf B, bahkan untuk user yang namanya tidak dimulai dengan B. Dan `.user-role` "PRO PLAN" **tidak pernah** diperbarui — selalu menampilkan PRO PLAN, bahkan untuk akun FREE. Ini adalah **bug kebenaran data**, bukan sekadar bug visual: aplikasi menyatakan tingkat langganan yang mungkin tidak dimiliki pengguna.

#### Cacat 2.2.D — Kontras `.user-role` gagal AA [FAKTA]

`ui-theme.css` 2805: `.user-role { color: var(--color-text-muted); font-size: 9px; }`

`--color-text-muted` = `#738096` (`premium-workstation-core.css` 18; juga `ui-theme.css` 49). Latar `.sidebar-footer` di dalam `.app-sidebar` yang memakai `--color-bg-surface` = `#0d1320` (`ui-theme.css` 2719).

Rasio kontras `#738096` pada `#0d1320` ≈ **4.1:1** — **di bawah ambang WCAG AA 4.5:1**. Digabung dengan ukuran font **9px** (jauh di bawah minimum praktis 11px untuk label UI), ini adalah teks yang sulit dibaca.

---

### 2.3 Masalah Double Header (`.app-header` lama vs Sidebar)

**Klaim direktif:** *"Temukan baris HTML navbar horizontal lama yang masih muncul di atas dashboard utama. Analisis dampaknya terhadap layout flex app-shell."*

**[FAKTA] Struktur aktual `index.html` 521–608:**
```
521: <main class="app-main" id="appMain">
522:
523: <!-- HEADER -->
524: <header class="app-header sticky top-0 z-50 backdrop-blur-xl flex-shrink-0">
525:     <div class="header-shell w-full mx-auto px-3 sm:px-5 py-2.5">
526:         <div class="flex items-center gap-3 lg:gap-4">
527:             ... brand + status chips + account section ...
565:         </div>
566:     </div>
567:     <!-- NAVIGATION MENU -->
568:     <nav class="mobile-nav-row header-shell w-full mx-auto px-3 sm:px-5">
569:         <div class="nav-scroll-container flex items-center gap-1 overflow-x-auto pb-2 pt-1 scrollbar-hide" id="mainNav">
570:             <button onclick="navigateTo('dashboard')" class="nav-btn active" data-page="dashboard">...
574:             <button onclick="navigateTo('analisis')" class="nav-btn" data-page="analisis">...
578:             <button onclick="navigateTo('sektor')" class="nav-btn hidden" data-page="sektor" data-premium-nav="true">...
582:             <button onclick="navigateTo('screener')" class="nav-btn hidden" data-page="screener" data-premium-nav="true">...
586:             <button onclick="navigateTo('portofolio')" class="nav-btn hidden" data-page="portofolio" data-premium-nav="true">...
590:             <button onclick="navigateTo('watchlist')" class="nav-btn hidden" data-page="watchlist" id="navBtnWatchlist" data-premium-nav="true">...
594:             <button onclick="navigateTo('trackrecord')" class="nav-btn hidden" data-page="trackrecord" data-premium-nav="true">...
598:             <button onclick="navigateTo('deepscan')" class="nav-btn hidden" data-page="deepscan" data-premium-nav="true">...
602:             <button onclick="navigateTo('money-management')" class="nav-btn hidden" data-page="money-management" data-premium-nav="true">...
606:         </div>
607:     </nav>
608: </header>
```

**Temuan:**

**[FAKTA] Ini BUKAN dua `.app-header`. Ini satu header dengan nav-row tertanam di dalamnya.**

Baris `568` — `<nav class="mobile-nav-row header-shell w-full mx-auto px-3 sm:px-5">` — adalah **navbar horizontal lama yang masih muncul**, persis seperti yang dicari direktif. Ia berada di dalam elemen `<header>` yang sama, tepat di bawah baris brand/account.

**[FAKTA] Kode sendiri mengakui duplikasi ini.** `index.html` 446–452:
```
<!-- ===== APP SHELL =========================================================
     One flex row: the navigation rail and the content column are SIBLINGS, so
     the content can only ever sit to the RIGHT of the rail — never under it and
     never pushed below it. The rail is an in-flow sticky column at >=1024px and
     becomes a fixed overlay drawer below that (see .app-sidebar in ui-theme.css).
     This is the single navigation surface for the app: the old horizontal
     header nav was a second copy of the same nine destinations. -->
```

Komentar menyatakan *"the old horizontal header nav was a second copy"* (lampau) — tetapi `mobile-nav-row` di baris 568–607 **masih ada di DOM dan masih dirender**.

**Dampak terhadap layout flex app-shell — analisis:**

**[FAKTA] Hierarki flex aktual:**
```
body
└── #dashboardScreen (div, class="hidden flex flex-col min-h-screen")    [421]
    └── .app-layout (display: flex; align-items: flex-start)             [453]
        ├── #appSidebar (.app-sidebar, width: 240px, sticky)             [455]
        ├── #sidebarScrim (.sidebar-scrim)                                [519]
        └── .app-main (#appMain, flex: 1; min-width: 0)                  [521]
            ├── <header class="app-header sticky top-0 z-50">            [524]
            │   ├── .header-shell (baris brand)                          [525]
            │   └── nav.mobile-nav-row (9 nav-btn)                       [568]
            ├── #page-dashboard ... #page-money-management               [614-2232]
            ├── #tvSection, #adminPanel                                  [2235, 2254]
            └── <footer>                                                 [2303]
```

**Dampak 1 — Konsumsi tinggi vertikal ganda [FAKTA].**
Header memiliki `min-height: var(--pw-header-h)` = `58px` (`premium-workstation-core.css` 61, 181). Ditambah nav-row (baris 568) yang memiliki tombol `.nav-btn` dengan `min-height: 36px` (`premium-workstation-core.css` 247) + `padding: 6px 9px` + `pb-2 pt-1` (kelas Tailwind di baris 569 = `padding-bottom: 8px; padding-top: 4px`).

Perkiraan tinggi header total: 58px (baris 1) + 36px + 12px padding = **≈106px**. Pada mobile (`--pw-header-h: 54px`, `premium-workstation-core.css` 1683), nav-row tetap ada karena tidak ada aturan yang menyembunyikannya.

**Dampak 2 — Tabrakan dengan `#page-analisis` sticky [HIPOTESIS].**
`premium-workstation-core.css` 1123–1133:
```
#page-analisis > div:first-child {
  position: sticky;
  top: var(--pw-header-h);
  z-index: 18;
  ...
}
```
`top: var(--pw-header-h)` = **58px**. Tetapi header sebenarnya setinggi **≈106px** karena nav-row. Artinya toolbar analisis akan **berhenti 58px dari atas** dan **tertutup oleh nav-row** yang berada di atasnya. Ini adalah cacat visual yang terukur dan merupakan kandidat kuat penyebab keluhan "sidebar/header menutupi konten" di tab Analisis.

**Dampak 3 — Duplikasi tiga salinan sembilan tujuan [FAKTA].**
- Sidebar: `index.html` 469, 473, 477, 481, 485, 489, 493, 497, 501
- Nav-row header: `index.html` 570, 574, 578, 582, 586, 590, 594, 598, 602
- Komentar di 446–452 menyebut ini sebagai duplikasi

**[HIPOTESIS]** Dengan sidebar menjadi collapsible dan selalu terlihat di ≥1024px (`ui-theme.css` 2846–2850 menyembunyikan `#workspaceSidebarToggle` di ≥1024px), nav-row di header **tidak memiliki fungsi** di desktop. Ia hanya berguna di mobile. Solusi minimal: sembunyikan `mobile-nav-row` di ≥1024px.

**Dampak 4 — `z-index` header vs sidebar [FAKTA].**
- `.app-header` memiliki `z-50` (kelas Tailwind, `index.html` 524) = `z-index: 50`
- `.app-sidebar` memiliki `z-index: 60` (`ui-theme.css` 2723)
- `.sidebar-scrim` memiliki `z-index: 55` (`ui-theme.css` 2736)

Sidebar (60) > header (50). Karena keduanya adalah sibling flex (bukan nested), dan sidebar `position: sticky` sedangkan header `position: sticky` di dalam `.app-main`, keduanya berada di stacking context yang sama. Sidebar akan menutupi header jika keduanya bertumpuk. **[FAKTA] Ini tidak terjadi saat normal karena keduanya adalah kolom flex yang terpisah secara horizontal.** Namun pada mobile, `.app-sidebar` menjadi `position: fixed` (`ui-theme.css` 2906) dengan `transform: translateX(-100%)` (2911) — sehingga sidebar **meluncur menutupi header** saat `mobile-open` (2915–2917). Ini perilaku yang diinginkan untuk drawer.

---

### 2.4 Akar Masalah Kontras Light Mode

**Klaim direktif:** *"Tunjukkan nomor baris di `index.html` atau CSS core yang masih memaksa warna teks terang (#f6f9fb / white) saat atribut `html.light` aktif."*

**Temuan — ini adalah cacat paling dalam dan paling terdokumentasi dengan baik.**

#### Akar masalah 2.4.A — Dua namespace token, hanya satu yang di-override [FAKTA]

Ada **dua** himpunan token yang keduanya mendefinisikan warna yang sama:

**Himpunan A — `--color-*` dan `--pw-*` di `premium-workstation-core.css` 9–99:**
```
12:  --color-bg-canvas: #090d16;
13:  --color-bg-surface: #0d1320;
14:  --color-bg-elevated: #111a2a;
15:  --color-bg-hover: #162033;
16:  --color-text-primary: #f4f7fb;      ← teks terang
17:  --color-text-secondary: #aab4c3;
18:  --color-text-muted: #738096;
...
33:  --pw-bg: #06090e;
34:  --pw-bg-2: #080d14;
35:  --pw-panel: #09111a;
36:  --pw-panel-2: #0c1620;
37:  --pw-panel-3: #070d13;
41:  --pw-text: #d9e2ec;                  ← teks terang
42:  --pw-text-strong: #f6f9fb;           ← teks terang (persis yang disebut direktif)
43:  --pw-muted: #8796a8;
44:  --pw-dim: #617084;
```

**Blok light di file yang SAMA — `premium-workstation-core.css` 101–122:**
```
101: html.light {
102:   --color-bg-canvas: #f5f7fa;
103:   --color-bg-surface: #ffffff;
104:   --color-bg-elevated: #f8fafc;
105:   --color-bg-hover: #f1f5f9;
106:   --color-text-primary: #0f172a;
107:   --color-text-secondary: #475569;
108:   --color-text-muted: #64748b;
109:   --color-border-subtle: rgba(15, 23, 42, .08);
110:   --color-border-default: rgba(15, 23, 42, .14);
111:   --color-accent: #2563eb;
112:   --color-positive: #059669;
...
116:   --grid-line: rgba(15, 23, 42, .08);
117:   --grid-header-bg: #f8fafc;
118:   --bg-canvas: #f5f7fa;
119:   --bg-surface: #ffffff;
120:   --text-primary: #111827;
121:   --border-subtle: rgba(15, 23, 42, .08);
122: }
```

**[FAKTA] Perhatikan dengan saksama: blok `html.light` di baris 101–122 meng-override `--color-*`, `--bg-*`, `--text-primary`, `--border-subtle` — tetapi TIDAK SATU PUN variabel `--pw-*`.**

Artinya, setelah `html.light` aktif:
- `--color-text-primary` → `#0f172a` ✅ (gelap, benar)
- `--pw-text` → tetap `#d9e2ec` ❌ (terang, salah)
- `--pw-text-strong` → tetap `#f6f9fb` ❌ (**persis nilai yang disebut direktif**)
- `--pw-bg` → tetap `#06090e` ❌ (hitam, salah)
- `--pw-panel` → tetap `#09111a` ❌ (hitam, salah)
- `--pw-panel-2` → tetap `#0c1620` ❌
- `--pw-panel-3` → tetap `#070d13` ❌
- `--pw-muted` → tetap `#8796a8` ❌
- `--pw-dim` → tetap `#617084` ❌

#### Akar masalah 2.4.B — Ada penyelamat sebagian di `ui-theme.css` [FAKTA]

`ui-theme.css` 2526–2555 mendefinisikan ulang token light untuk `--pw-*`:
```
2526: html.light, body.light {
2527:   --pw-bg: #f8fafc;
2528:   --pw-panel: #ffffff;
2529:   --pw-panel-strong: #f1f5f9;
2530:   --pw-surface: #ffffff;
2531:   --pw-line: #e2e8f0;
2532:   --pw-line-strong: #cbd5e1;
2533:   --pw-text: #0f172a;
2534:   --pw-text-strong: #020617;
2535:   --pw-muted: #475569;
2536:   --pw-dim: #64748b;
2537:   --pw-grid: transparent;
...
2553:   background-color: #f8fafc !important;
2554:   color: #0f172a !important;
2555: }
```

**[FAKTA] Ini menutupi sebagian masalah — dan mekanismenya adalah SPESIFISITAS, bukan urutan muat.**

**[KOREKSI PENTING]** Versi awal audit ini menyimpulkan bahwa `@import` membuat `premium-workstation-core.css` dievaluasi belakangan sehingga deklarasinya menang. **Kesimpulan itu SALAH.** Perhitungan spesifisitas yang benar:

| Deklarasi | Selektor | Spesifisitas | Pemenang |
|---|---|---|---|
| `premium-workstation-core.css` 9 | `:root` | **(0,1,0)** — satu pseudo-class | — |
| `ui-theme.css` 2526 | `html.light` | **(0,1,1)** — satu elemen + satu class | ✅ **MENANG** |
| `ui-theme.css` 2526 | `body.light` | **(0,1,1)** | ✅ MENANG |

**Spesifisitas mengalahkan urutan sumber.** Karena `html.light` (0,1,1) lebih tinggi daripada `:root` (0,1,0), semua `--pw-*` yang dideklarasikan ulang di `ui-theme.css` 2527–2537 **benar-benar menang**, terlepas dari urutan muat. Jadi 11 variabel `--pw-*` itu bekerja dengan benar di light mode.

**Akar masalah sebenarnya bukan urutan — melainkan CAKUPAN OVERRIDE YANG TIDAK LENGKAP.** Bukti terukur:

`premium-workstation-core.css` 33–62 mendeklarasikan **22** variabel `--pw-*`. `ui-theme.css` 2527–2537 hanya meng-override **11**. Hasil uji selisih:

```
UN-OVERRIDDEN (tetap gelap di light mode):
  --pw-bg-2          → #080d14   (dipakai: core 65 → --ac-bg-elevated)
  --pw-panel-2       → #0c1620   (dipakai: core 67, 366)
  --pw-panel-3       → #070d13   (dipakai: core 68, 374)
  --pw-panel-hover   → #101a25   (dipakai: core 69, 390)
  --pw-accent        → #2dd4a3   (dipakai: core 80, 85, 95, 217)
  --pw-accent-strong → #10b981   (dipakai: core 81, 84)
  --pw-accent-soft   → rgba(45,212,163,.075)   (dipakai: core 82)
  --pw-accent-line   → rgba(45,212,163,.23)    (dipakai: core 83)
  --pw-bull          → #52d7ad   (dipakai: core 856 ← !important)
  --pw-bear          → #fb7d8d   (dipakai: core 861 ← !important)
  --pw-warn          → #edc46c   (dipakai: core 867 ← !important)
  --pw-info          → #76adf8   (dipakai: core 872 ← !important)
  --pw-shadow, --pw-shadow-deep  (dipakai: core 93, 1584, 1598, 1623)
```

Dan pada tingkat alias `--ac-*`: `premium-workstation-core.css` 64–99 mendeklarasikan **35** token `--ac-*`, sedangkan `ui-theme.css` 2540–2551 hanya meng-override **12**. Selisih **23 token** tidak pernah di-override, termasuk `--ac-surface-hover`, `--ac-accent`, `--ac-accent-strong`, `--ac-brand`, dan `--ac-focus-color`.

#### Akar masalah 2.4.B-2 — Cacat KONTRAS paling parah: `!important` mengunci warna dark-mode [FAKTA]

Ini adalah temuan paling penting di seluruh audit light mode, dan **tidak tertangkap** oleh analisis urutan muat.

`premium-workstation-core.css` 854–873:
```css
854: .text-emerald-300,
855: .text-emerald-400 {
856:   color: var(--pw-bull) !important;
857: }
858:
859: .text-red-300,
860: .text-red-400 {
861:   color: var(--pw-bear) !important;
862: }
863:
864: .text-amber-200,
865: .text-amber-300,
866: .text-amber-400 {
867:   color: var(--pw-warn) !important;
868: }
869:
870: .text-blue-300,
871: .text-blue-400 {
872:   color: var(--pw-info) !important;
873: }
```

**[FAKTA] Rantai lengkap:**
1. Kelas-kelas ini memakai `!important` → mengalahkan **segala** aturan non-`!important`, termasuk seluruh blok light.
2. Nilainya adalah `var(--pw-bull/bear/warn/info)`.
3. Keempat variabel itu **tidak di-override** di light mode (terbukti di tabel atas).
4. Maka di light mode, `.text-emerald-400` tetap `#52d7ad`, `.text-red-400` tetap `#fb7d8d`, dan seterusnya.

**[FAKTA] Perhitungan kontras pada latar putih (`--color-bg-surface: #ffffff`):**

| Kelas | Warna dipaksa | Rasio vs putih | Ambang AA | Status |
|---|---|---|---|---|
| `.text-emerald-300/400` | `#52d7ad` | **1.79:1** | 4.5:1 | ❌ **GAGAL BERAT** |
| `.text-red-300/400` | `#fb7d8d` | **2.51:1** | 4.5:1 | ❌ **GAGAL BERAT** |
| `.text-amber-200/300/400` | `#edc46c` | **1.64:1** | 4.5:1 | ❌ **GAGAL BERAT** |
| `.text-blue-300/400` | `#76adf8` | **2.31:1** | 4.5:1 | ❌ **GAGAL BERAT** |

**[FAKTA] Ini adalah cacat paling parah di light mode.** Keempat kelas warna semantik — yang dipakai untuk **setiap** angka P/L, persentase perubahan, skor, dan badge status di seluruh 9 tab — menjadi nyaris tidak terbaca. Rasio 1.64:1 berarti teks praktis hilang.

**[FAKTA] Inilah penjelasan yang benar untuk keluhan "light mode kontras rusak".** Bukan karena token tidak di-override secara acak, tetapi karena **empat aturan `!important` mengunci warna dark-mode ke kelas semantik yang paling sering dipakai.**

**[FAKTA] Mengapa `spreadsheet-grade.css` tidak menyelamatkan ini:** file itu memang mencoba (baris 377–379):
```css
html.light .sp-up { color: #047857; }
html.light .sp-down { color: #be123c; }
html.light .sp-flat { color: #475569; }
```
Tetapi itu menargetkan kelas **berbeda** (`.sp-up` / `.sp-down` / `.sp-flat`, didefinisikan di baris 370–371), bukan `.text-emerald-400` dan kawan-kawan. Jadi tabel spreadsheet punya warna yang benar, sementara **seluruh sisa aplikasi tidak.**

**[HIPOTESIS]** Perbaikan wajib: tambahkan blok `html.light` dengan spesifisitas lebih tinggi + `!important` untuk keempat grup kelas ini, ATAU lebih baik — hapus `!important` dan jadikan warna semantik sebagai variabel yang lengkap di kedua mode.

**[CATATAN] `premium-workstation-core.css` TIDAK dimuat langsung.** Ia dimuat via `@import` di `premium-workstation.css`:**
```
1: /* Auto-Cuan premium workstation stylesheet entrypoint.
2:    The validated V3/V4 visual contract is frozen in premium-workstation-core.css.
3:    Structural evolution lives in independently reviewable layers so a layout
4:    pass can be rolled back without rewriting the trusted core stylesheet. */
5: @import url('/premium-workstation-core.css?v=20260818-v4-core');
6: @import url('/premium-workstation-v6.css?v=20260818-v6');
7: @import url('/premium-workstation-v11.css?v=20260818-v11');
```
Dan `premium-workstation.css` dimuat di `index.html` 123 — **setelah** `ui-theme.css` (122).

Aturan CSS: stylesheet hasil `@import` diperlakukan seolah-olah isinya berada **di posisi `@import`** — yaitu setelah `ui-theme.css` dalam urutan sumber.

**[KOREKSI]** Urutan ini **tidak relevan** untuk kasus ini, karena semua deklarasi yang bersaing berada di dalam `:root`-kelas selektor dengan spesifisitas berbeda. Urutan sumber hanya menjadi penentu ketika spesifisitas **sama**. Di sini tidak sama (`html.light` 0,1,1 vs `:root` 0,1,0), sehingga `ui-theme.css` 2527–2537 menang murni karena spesifisitas.

**[FAKTA] Kesimpulan yang benar:** light mode "setengah jadi" karena `ui-theme.css` 2526–2555 hanya meng-override **11 dari 22** variabel `--pw-*` dan **12 dari 35** token `--ac-*`. Variabel yang tidak ada di daftar override itu tetap memakai nilai dark-mode, dan sebagian di antaranya dipakai lewat aturan `!important` (lihat 2.4.B-2).

#### Akar masalah 2.4.C — Warna terang hardcoded yang TIDAK memakai token sama sekali [FAKTA]

Ini adalah kelas cacat yang paling parah karena **tidak ada token yang bisa di-override**. Nilai literal langsung di properti:

**Di `premium-workstation-core.css`:**
| Baris | Selektor | Nilai | Dampak di light mode |
|---|---|---|---|
| 403 | `.panel-title` | `color: #e9f0f6` | Teks nyaris putih di latar putih → **tidak terbaca** |
| 619 | `.market-tile-value, #ihsgLast, #dashMarketGate, #dashMarketFreshness` | `color: #eef4f8` | Angka IHSG & gate hilang di light mode |
| 1200 | `.ai-rich-text h1, h2, h3` | `color: #f1f5f9` | Judul hasil AI tidak terbaca |
| 143 | `::selection` | `color: #fff` | Minor |

**Di `index.html`:**
| Baris | Elemen | Nilai | Dampak |
|---|---|---|---|
| 127 | `<body class="min-h-screen text-gray-100">` | `text-gray-100` | Teks dasar terang — di-override oleh `ui-theme.css` 2596–2600, jadi **tertangani** |
| 2 | `<html lang="id" style="background-color:#0b0e14">` | inline `#0b0e14` | Inline style **menang** atas stylesheet non-`!important`. `ui-theme.css` 2553 memakai `!important` sehingga bisa mengalahkannya — tetapi `premium-workstation-core.css` 124–127 (`html { background: var(--pw-bg) }`) **tidak** |
| 6 | `<meta name="color-scheme" content="dark">` | meta | Memaksa scrollbar & kontrol native tetap gelap |

**Di `ui-theme.css` (aturan light yang belum lengkap):**
| Baris | Selektor | Masalah |
|---|---|---|
| 2669 | `html.light .sidebar-brand-text p { color: #0f172a !important }` | Menargetkan `<p>` — tetapi markup di `index.html` 459–462 memakai `<strong>` (460) dan `<span>` (461), **bukan `<p>`**. **Selektor ini tidak pernah cocok — CSS mati.** |
| 2596–2600 | `html.light .text-white, .text-gray-100, .text-gray-200 { color: #0f172a !important }` | **Tidak mencakup `.text-gray-300`–`.text-gray-600`.** Kelas-kelas itu ditangani terpisah di 2602–2609, tetapi ada celah: `premium-workstation-core.css` 854–873 mengunci `.text-emerald/red/amber/blue-*` dengan `!important` (lihat 2.4.B-2), dan tidak ada aturan `html.light` yang membatalkannya. |

**[KOREKSI atas versi awal audit]** Versi pertama dokumen ini menyatakan `body.light` (2526) adalah "CSS mati karena kelas tidak pernah dipasang". **Itu SALAH.** Audit lanjutan menemukan `index.html` 7747:
```javascript
7747: if (document.body) document.body.classList.toggle('light', isLight);
```
`applyAppTheme()` memang memasang kelas `light` pada `<body>`. Jadi selektor `body.light` di `ui-theme.css` 2526 **aktif dan berfungsi**. Namun perlu dicatat bahwa **bootstrap awal** (`index.html` 56–67, dijalankan sebelum paint) hanya memasang kelas pada `document.documentElement` (60) — kelas `body` baru dipasang nanti oleh `applyAppTheme()`. Konsekuensinya: ada jendela antara first paint dan eksekusi `applyAppTheme()` di mana `html.light` sudah aktif tetapi `body.light` belum.

#### Akar masalah 2.4.D — Ketidakcocokan `color-scheme` [FAKTA]

`index.html` 6: `<meta name="color-scheme" content="dark">`
`premium-workstation-core.css` 126: `html { color-scheme: dark; }`

**[FAKTA] Tidak ada aturan `html.light { color-scheme: light }` di mana pun.** Audit menemukan `color-scheme` hanya muncul di dua tempat tersebut — keduanya menetapkan `dark` tanpa syarat.

**[HIPOTESIS] Konsekuensi:** di light mode, kontrol form native (dropdown `<select>`, spinner `<input type=number>`, scrollbar) akan tetap dirender browser dengan tema gelap. Ini menciptakan kontras yang aneh: panel putih dengan dropdown gelap.

#### Akar masalah 2.4.E — Bug bootstrap: properti salah [FAKTA]

`index.html` 56–67:
```javascript
(function () {
    try {
        var saved = localStorage.getItem('autocuan_theme') || 'dark';
        if (saved === 'light') {
            document.documentElement.classList.add('light');
            document.documentElement.style.background = '#f8fafc';
        } else {
            document.documentElement.classList.remove('light');
            document.documentElement.style.background = '#0b0e14';
        }
    } catch (_) {}
})();
```

**[FAKTA] Baris 61 dan 64 menetapkan `document.documentElement.style.background` — yang merupakan shorthand untuk `background-image`, `background-position`, `background-size`, `background-repeat`, `background-attachment`, `background-origin`, `background-clip`, dan `background-color`.**

Konsekuensi: menetapkan `style.background = '#f8fafc'` **mereset** `background-image` menjadi `none` untuk elemen `<html>`.

**[HIPOTESIS]** Ini berinteraksi buruk dengan mesh FeralUI (`spreadsheet-grade.css` 58–66) yang diterapkan pada `<body>`, bukan `<html>` — jadi mesh di body selamat. Namun inline style pada `<html>` adalah `background` shorthand, sehingga setiap aturan yang mencoba menetapkan `background-image` pada `<html>` akan kalah. Saat ini tidak ada yang mencoba, sehingga dampaknya nol — tetapi ini adalah pola yang rapuh.

**[FAKTA] Masalah yang lebih konkret: `document.documentElement.style.background` adalah inline style, dan inline style menang atas stylesheet non-`!important`.** `premium-workstation-core.css` 124–127:
```
html {
  background: var(--pw-bg);
  color-scheme: dark;
}
```
Aturan ini **kalah** dari inline style yang dipasang di baris 61/64. Jadi warna latar `<html>` **selalu** `#0b0e14` atau `#f8fafc` — nilai literal, bukan token. Mengubah `--pw-bg` tidak akan berpengaruh pada elemen `<html>`.

#### Ringkasan rantai akar masalah light mode (VERSI TERKOREKSI)

```
1. Token didefinisikan dua kali di dua file
   ├── ui-theme.css 42-188                (--color-*, --ac-*)
   └── premium-workstation-core.css 9-99  (--color-*, --pw-*, --ac-*)
   → Sumber kebenaran ganda; tidak ada mekanisme sinkronisasi.

2. Blok light tidak lengkap — INI AKAR UTAMA
   ├── premium-workstation-core.css 101-122  → override --color-* SAJA
   │   (tidak menyentuh --pw-* sama sekali)
   └── ui-theme.css 2526-2555                → override 11 dari 22 --pw-*
       dan 12 dari 35 --ac-*
   → 11 variabel --pw-* dan 23 token --ac-* tetap memakai nilai dark-mode.

3. Spesifisitas, bukan urutan muat, yang menentukan
   ├── :root            = (0,1,0)
   ├── html.light       = (0,1,1)  ← MENANG
   └── body.light       = (0,1,1)  ← MENANG (aktif; dipasang di index.html:7747)
   → Override di ui-theme.css BERFUNGSI. Masalahnya cakupan, bukan cascade.

4. CACAT PALING PARAH: empat aturan !important mengunci warna dark
   premium-workstation-core.css 854-873:
     .text-emerald-300/400 { color: var(--pw-bull) !important }   ← #52d7ad (1.79:1 vs putih)
     .text-red-300/400     { color: var(--pw-bear) !important }   ← #fb7d8d (2.51:1)
     .text-amber-200/300/400 { color: var(--pw-warn) !important } ← #edc46c (1.64:1)
     .text-blue-300/400    { color: var(--pw-info) !important }   ← #76adf8 (2.31:1)
   → --pw-bull/bear/warn/info TIDAK di-override di light mode.
   → Keempatnya GAGAL WCAG AA secara berat di latar putih.
   → spreadsheet-grade.css 377-379 tidak menyelamatkan karena menargetkan
     .sp-up/.sp-down/.sp-flat, bukan .text-emerald-400 dkk.

5. Warna terang hardcoded — tidak ada token yang bisa di-override:
   premium-workstation-core.css 403 (#e9f0f6), 619 (#eef4f8), 1200 (#f1f5f9)

6. color-scheme: dark tidak pernah dibatalkan:
   index.html 6 (meta), premium-workstation-core.css 126 (html rule)

7. Satu selektor light adalah CSS mati:
   ui-theme.css 2669 (`p` — markup memakai strong/span)
   (Versi awal audit keliru menyebut 2526 `body.light` sebagai mati;
    selektor itu AKTIF karena index.html:7747 memasang kelas pada body.)
```

---

## BAB 3: PEMETAAN LENGKAP 9 TAB WORKSPACE AUTO-CUAN

**Kontrak navigasi global [FAKTA] — `index.html` 4510–4642:**

`navigateTo(page)` adalah satu-satunya pintu masuk navigasi. Rantai eksekusinya:

| Baris | Aksi |
|---|---|
| 4511 | Reset Pattern Map (kecuali `chart`) |
| 4512–4515 | Alias `subscription` → `dashboard` |
| 4516–4519 | Gate premium: `isPremiumFeaturePage(page) && isDeniedWebsiteAccess()` → redirect ke `dashboard` |
| 4520–4527 | Alias `chart` → `analisis` + switch sub-tab ke `vision` |
| 4528–4536 | Alias `ranking` → `analisis` + scroll ke `#rankingCardOuterWrap` |
| 4540 | `currentPage = page` |
| 4541 | `if (page !== 'screener') stopAllScreenerPolling()` |
| 4543 | `document.querySelectorAll('.page-content').forEach(el => el.classList.add('hidden'))` — **sembunyikan semua** |
| 4545–4546 | `document.getElementById('page-' + page).classList.remove('hidden')` + `add('flex-1')` |
| 4551–4555 | Keep-alive: `AutoCuanKeepAlive.hasVisited(page)` / `onNavigate(page)` |
| 4557–4560 | Sinkronkan `.nav-btn.active` berdasarkan `data-page` |
| 4562 | `syncWorkspaceSidebarActive(page)` → sinkronkan `[data-sidebar-page]` |
| 4563–4566 | `scrollIntoView` nav-btn mobile yang aktif |
| 4568–4569 | Tampilkan `#adminPanel` hanya di `dashboard` + admin |
| 4570 | `subscription` → `loadSubscriptionExperience(false)` |
| 4572–4573 | `dashboard` → `loadDashboardTop5Monitor` + `scheduleTop5HistoryLoad` + start/stop monitor |
| 4576–4581 | `analisis` → `ensureRankingTableLoaded()` + `UnifiedCockpit.loadUnifiedChart()` |
| 4582–4588 | `news` → `loadStockNewsPage()` |
| 4589–4600 | `sektor` → gate + `loadSektorHot(kaRevisit)` |
| 4602–4610 | `portofolio` → gate + `renderPortfolio()` |
| 4612–4621 | `screener` → gate + `loadSwingScreener(kaRevisit)` |
| 4623–4626 | `trackrecord` → `loadTrackRecord(false)` |
| 4628–4630 | `watchlist` → `loadUserWatchlist(false)` |
| 4632–4634 | `deepscan` → `loadDeepScan(false)` |
| 4636–4641 | `money-management` → `initMoneyManagement()` (hanya jika bukan revisit) |

**[FAKTA] Pengamatan kritis: `navigateTo()` tidak pernah memanggil `setWorkspaceSidebarVisible()`.** Fungsi itu ada (`index.html` 7815–7829) tetapi hanya dipanggil dari tempat lain. Jadi `navigateTo` **tidak** menyembunyikan sidebar — memperkuat kesimpulan BAB 1.6 bahwa "sidebar hilang" adalah masalah lebar kolom, bukan masalah visibilitas.

---

### 3.1 Tab Dashboard

**Anchor DOM [FAKTA]:**
- Panel: `#page-dashboard` — `index.html` 614
- Kelas: `page-content flex-1 max-w-[1100px] w-full mx-auto px-3 sm:px-5 py-4`
- **Catatan:** panel ini **tidak** memiliki `hidden` di kelas awal (615) — ia adalah halaman default

**Struktur kartu ringkasan:**

| Bagian | Anchor | Baris |
|---|---|---|
| Hero / greeting | `.dashboard-hero` | 618–635 |
| Greeting teks | `#dashGreeting` | 622 |
| Badge Live Radar | `#heroLiveRadarBadge`, `#heroLiveRadarDot`, `#heroLiveRadarText` | 621 |
| Badge Approved | `#approvedBadge` | 627 |
| Tombol BYOK | `onclick="openAiApiKeyModal()"` | 628 |
| **Kondisi Pasar** | `.ac-section.market-band` | 645–681 |
| ↳ Judul | `#dashMarketTitle` | 647 |
| ↳ Grid | `#ihsgSummaryCard` (`.market-band-grid`) | 650 |
| ↳ Tile IHSG | `#ihsgLast`, `#ihsgChange` | 658–659 |
| ↳ Link IHSG | `onclick="window.location.assign('/analisis-saham?ticker=IHSG')"` | 662 |
| ↳ Tile Radar | `#dashMarketGate`, `#dashMarketGateNote` | 667, 670 |
| ↳ Tile Freshness | `#dashMarketFreshness` | 675 |
| **Radar Hari Ini** | `.ac-section` | 684–714 |
| ↳ Top 5 panel | `.radar-panel.lg:col-span-3.panel` | 690 |
| ↳ Catatan lock | `#dashboardTop5LockNote` | 694 |
| ↳ Daftar Top 5 | `#dashboardTop5List` | 697 |
| ↳ Panel Monitor | `.radar-panel.lg:col-span-2.panel` | 701 |
| ↳ Waktu update | `#dashboardMonitorUpdated` | 707 |
| ↳ Daftar Monitor | `#dashboardMonitorList` | 709 |
| **Riwayat** | `.ac-section` | 716–737 |
| ↳ Tombol Refresh | `onclick="loadTop5History(true)"` | 727 |
| ↳ Tab Aktif | `#top5HistoryTabActive` | 730 |
| ↳ Tab TP | `#top5HistoryTabTp` | 731 |
| ↳ Daftar Riwayat | `#top5HistoryList` | 733 |

**Fungsi binding JavaScript:**

| Fungsi | Lokasi | Tugas | Endpoint |
|---|---|---|---|
| `loadDashboardTop5Monitor(silent, opts)` | 11928 | Muat Top 5 + Monitor | `/api/sector-hot?action=web-daily-picks&t=<ts>` (11948) |
| `renderDashboardTop5MonitorData(data)` | 11990 | Render & putuskan state | — |
| `renderMarketBand(data, isAwaiting, pickedCount)` | dipanggil 12010 | Isi tile Kondisi Pasar | — |
| `renderDashboardTop5(rows)` | dipanggil 12019 | Render kartu Top 5 | — |
| `renderDashboardMonitor(rows, ts, data)` | dipanggil 12020 | Render daftar monitor | — |
| `refreshIHSGCard()` | 12038 | Isi tile IHSG | `/api/quote?ticker=IHSG` (12039) |
| `loadTop5History(force)` | ~11880–11914 | Riwayat Top 5 | `/api/sector-hot?action=web-top5-history&limit=100` (11905) |
| `archiveTop5History(id)` | 11917 | Arsip (admin) | `/api/sector-hot?action=web-top5-history-archive` (11922) |
| `startDashboardMonitorAutoRefresh()` | 12024 | Polling | `setInterval(..., 60 * 1000)` (12027–12029) |
| `stopDashboardMonitorAutoRefresh()` | 12031 | Hentikan polling | `clearInterval` (12032) |
| `updateGlobalLiveRadarStatus(meta)` | 4645 | Sinkronkan chip Live Radar global + hero | — |

**Interval polling [FAKTA]:**

| Timer | Interval | Guard | Baris |
|---|---|---|---|
| Monitor auto-refresh | **60 detik** | `currentPage === 'dashboard' && !document.hidden` | 12027–12029 |
| IHSG card | **10 menit** | `setTimeout` rekursif | 12068–12069 |
| Clock WIB | 1 detik | Global | 2793 (`setInterval(tick, 1000)`) |

**Cache & guard [FAKTA]:**
- `_dashboardTop5Cache = { at: 0, data: null }` (2628) — TTL **45 detik** (11932)
- `_top5HistoryCache` (2629)
- `_dashboardTop5InFlight` (2630) — cegah fetch bersamaan
- `_top5HistoryInFlight` (2631)
- Timeout fetch 15 detik (11949)
- Fallback timer 5 detik untuk mengganti skeleton dengan teks "Masih memuat" (11940–11945)
- Retry sekali jika `top5_source === 'awaiting_locked_rows'` (11960–11966)

**[FAKTA] Komentar di 2620–2627 mendokumentasikan bug historis:** `_dashboardTop5Cache` diinisialisasi jauh dari pemakaiannya pernah menyebabkan error hoisting yang membuat panel macet di placeholder statis sepanjang sesi.

---

### 3.2 Tab Analisis Saham

**Anchor DOM [FAKTA]:**
- Panel: `#page-analisis` — `index.html` 742
- Kelas: `page-content hidden flex-1 flex flex-col max-w-[1280px] w-full mx-auto px-3 sm:px-5 py-3`
- **Catatan:** `max-w-[1280px]` — lebih lebar dari tab lain yang `max-w-[1100px]`

**Struktur DOM:**

| Bagian | Anchor | Baris |
|---|---|---|
| Top bar | `.unified-top-bar.analisis-saham-controls.ticker-search-container` | 744 |
| Input ticker | `#analisisInput` | 748 |
| Handler Enter | `onkeydown="if(event.key==='Enter')UnifiedCockpit.handleTickerInputEnter()"` | 748 |
| Tombol Analisis | `onclick="UnifiedCockpit.handleUnifiedAnalisisSubmit()"` | 750 |
| Tombol Berita | `onclick="navigateTo('news')"` | 753 |
| Tombol API Key | `onclick="openAiApiKeyModal()"` | 756 |
| Badge ticker aktif | `#unifiedActiveTickerBadge` | 762 |
| **Chip ticker populer** | baris 766–774 | 768–773 |
| ↳ IHSG | `UnifiedCockpit.syncActiveTicker('IHSG', {...})` | 768 |
| ↳ BBCA/BBRI/BMRI/TLKM/ASII | idem | 769–773 |
| **Grid 2 kolom** | `.unified-cockpit-grid` | 778 |
| Kolom primer | `.unified-primary-col` | 780 |
| Kontainer chart | `#unifiedChartContainer` (`.unified-chart-box`) | 783 |
| Kartu hasil | `.unified-card` | 791 |
| Sub-tab teks | `#tabAnalisisText` | 799 |
| Sub-tab vision | `#tabAnalisisVision` | 802 |
| Panel teks | `#panelAnalisisText` | 810 |
| Hasil analisis | `#analisisResult` | 811 |
| Panel vision | `#panelAnalisisVision` (`style="display:none"`) | 821 |
| Hasil vision | `#unifiedAiChartResultWrap` | 822 |
| Tombol analisis visual | `onclick="UnifiedCockpit.handleUnifiedChartAiSubmit()"` | 827 |
| Kartu ranking | `#rankingCardOuterWrap` | 835 |
| Input cari ranking | `#rankingSearchInput` | 843 |
| Tombol refresh ranking | `onclick="refreshRankingTable()"` | 844 |
| Wrapper tabel ranking | `#rankingTableWrap` | 849 |
| **Kolom asisten** | `.unified-chat-col` | 857 |
| Tag ticker chat | `#chatActiveTickerTag` | 864 |
| Tombol bersihkan | `onclick="UnifiedCockpit.clearAnalysisChatHistory()"` | 866 |
| Chip prompt cepat | `.unified-quick-prompts` | 872–877 |
| Stream pesan | `#unifiedChatMessages` | 880 |
| Composer | `#analisisFollowUp` | 889 |
| Input file | `#analysisFileInput` | 891 |
| Tombol upload | `#analysisUploadBtn` | 892 |
| Textarea | `#analysisChatInput` | 896 |
| Tombol kirim | `#analysisSendBtn` | 901 |

**Fungsi binding — `unified-cockpit-runtime.js` [FAKTA]:**

| Fungsi | Baris | Tugas |
|---|---|---|
| `getActiveTicker()` | 16–21 | Resolusi prioritas: `root.activeTicker` → `#analisisInput` → `#chartTickerInput` → `'BBCA'` |
| `switchAnalysisSubTab(mode)` | 23–50 | Delegasi ke `root.switchAnalisisTab` jika ada; fallback manual toggle `display` |
| `loadUnifiedChart(ticker)` | 52–113 | Muat chart |
| `syncActiveTicker(rawTicker, options)` | 115–214 | **Fungsi inti sinkronisasi** |
| `handleTickerInputEnter()` | 220–229 | Enter = ganti konteks saja, **tidak** jalankan AI |
| `handleUnifiedAnalisisSubmit()` | 231–246 | Tombol = jalankan AI |
| `handleUnifiedChartAiSubmit()` | 248–263 | Jalankan analisis vision |
| `sendQuickPrompt(text)` | 265–273 | Isi input + `root.handleSend()` |
| `clearAnalysisChatHistory()` | 275–286 | Hapus riwayat dari `localStorage` |
| `openFullscreen()` | 288–312 | Buka viewer layar penuh |
| `initCockpit()` | 334–350 | Wiring event saat DOM ready |

**Rantai `syncActiveTicker` [FAKTA] — 115–214:**
1. `cleanTicker()` → `String(val).trim().toUpperCase().replace(/[^A-Z0-9]/g, '')` (12–14)
2. Deteksi perubahan ticker (120–121)
3. **Jika ticker berubah dan bukan `runAnalysis`: kosongkan `#analisisResult`** (127–137) — mencegah hasil AI ticker lama tampil di bawah badge ticker baru
4. Sinkronkan `#analisisInput` (140–141) dan `#chartTickerInput` (143–144)
5. Update `#unifiedActiveTickerBadge` (147–148), `#chatActiveTickerTag` (150–151), `#analisisActiveTickerTag` (153–154), `#bandarActiveTickerTag` (156–157)
6. Sinkronkan 5 input pencarian tab independen (160–163): `bandarTickerSearchInput`, `akumulasiTickerSearchInput`, `bandarSummarySearchInput`, `rankingTickerSearchInput`, `patternTickerSearchInput`
7. Update URL `?ticker=` via `history.replaceState` (166–174)
8. Tampilkan `#analisisFollowUp` (177–180)
9. Muat chart jika berubah atau dipaksa (183–185)
10. Sinkronkan tab Bandarmologi (190–195)
11. Jalankan analisis/vision jika diminta (198–213)

**Endpoint API:**
| Endpoint | Lokasi | Dipakai oleh |
|---|---|---|
| `/api/candles?ticker=<T>` | `unified-cockpit-runtime.js` 85 | `loadUnifiedChart` |
| `/api/quote?action=daily-market-context-list` | `analisis-saham-runtime.js` 724 | Konteks pasar harian |
| `/api/analyze` | `api/analyze.js` | `handleUnifiedAnalisisSubmit` → `root.runAnalisisFromDashboard` |
| `/api/sector-hot?action=bandarmologi` | `bandarmologi-runtime.js` 1976 | Tab Bandarmologi |
| `/api/sector-hot?action=insider-network` | `bandarmologi-runtime.js` 3447 | Insider network |
| `/api/sector-hot?action=broker-hunter` | `bandarmologi-runtime.js` 5193 | Broker hunter |

**Penyebab hilangnya sidebar saat tab ini aktif:**

**[FAKTA] Analisis rantai:**

1. **`navigateTo('analisis')` tidak menyembunyikan sidebar** (4510–4642 tidak memanggil `setWorkspaceSidebarVisible`).

2. **`#page-analisis` memiliki `max-w-[1280px]`** (742) — **80px lebih lebar** dari `max-w-[1100px]` yang dipakai 8 tab lainnya. Kelas `mx-auto` juga membuatnya terpusat.

3. **`.page-content` dipaksa `max-width: var(--pw-page)` dengan `!important`** — `premium-workstation-core.css` 319–323:
   ```
   .page-content {
     width: 100%;
     max-width: var(--pw-page) !important;
     padding: 20px 20px 28px !important;
   }
   ```
   `--pw-page: 1280px` (baris 60). Jadi `!important` di sini **menimpa** `max-w-[1280px]` (Tailwind) maupun `max-w-[1100px]`. Semua halaman menjadi 1280px maksimum.

4. **`.unified-cockpit-grid` adalah grid 2 kolom** yang harus dibagi menjadi `.unified-primary-col` + `.unified-chat-col` (`index.html` 778, 780, 857).

5. **`.app-main` memiliki `min-width: 0`** (`ui-theme.css` 2820) — jadi kolom konten **bisa** menyusut.

6. **`.app-sidebar` adalah `position: sticky`** (`ui-theme.css` 2714) — **bukan `fixed`**. Ini penting: elemen sticky tetap mengambil ruang di alur normal.

**[HIPOTESIS] Penyebab paling mungkin — interaksi `max-width` + grid + tabel lebar:**

Di dalam `#page-analisis` terdapat `#rankingTableWrap` (849) yang berisi tabel dengan `min-w-[1100px]` (1065) atau serupa. `premium-workstation-core.css` 1159–1164:
```
#rankingTableWrap {
  overflow: auto;
  border: 1px solid rgba(148,163,184,.075);
  border-radius: 8px;
  background: #070d13;
}
```
`overflow: auto` **seharusnya** mengandung tabel. Tetapi `.unified-cockpit-grid` (didefinisikan di `unified-cockpit.css`) belum diverifikasi apakah memiliki `min-width: 0` pada kolomnya.

**Tanpa `min-width: 0` pada grid item, kolom grid menolak menyusut di bawah lebar konten minimumnya** — inilah mekanisme yang persis diperingatkan komentar `ui-theme.css` 2815–2817. Grid item default `min-width: auto`, bukan `0`.

**Mekanisme lengkap [HIPOTESIS]:**
```
1. #page-analisis mengandung .unified-cockpit-grid
2. Grid item (.unified-primary-col) berisi #rankingTableWrap dengan tabel min-width ~1100px
3. Grid item default min-width: auto → tidak boleh lebih sempit dari konten
4. .unified-cockpit-grid total lebar = 1100px (primer) + ~300px (chat) = ~1400px
5. #page-analisis max-width 1280px !important → tidak bisa melebar
6. .app-main min-width: 0 → BISA menyusut, dan memang menyusut
7. Tapi konten di dalamnya tidak menyusut karena grid item min-width: auto
8. Hasil: konten meluap keluar dari .app-main, menutupi .app-sidebar
9. .app-sidebar z-index: 60 vs konten tanpa z-index → sidebar TERTUTUP, tampak "hilang"
```

**Verifikasi yang diperlukan sebelum perbaikan:** ukur dengan `getBoundingClientRect()` pada `.unified-cockpit-grid`, `.unified-primary-col`, `#rankingTableWrap`, dan `#appSidebar` saat `#page-analisis` aktif di viewport 1440px.

**Perbaikan yang diusulkan (BAB 4.2):** tambahkan `min-width: 0` pada `.unified-cockpit-grid > *` dan semua grid item di dalam `.page-content`.

---

### 3.3 Tab Sektor Hot

**Anchor DOM [FAKTA]:**
- Panel: `#page-sektor` — `index.html` 912
- Kelas: `page-content hidden flex-1 max-w-[1100px] w-full mx-auto px-3 sm:px-5 py-4`
- Atribut: `data-premium-page="true"`

| Bagian | Anchor | Baris |
|---|---|---|
| Login gate | `#sektorLoginGate` | 914 |
| Konten | `#sektorContent` | 926 |
| List view | `#sektorListView` | 928 |
| Subtitle | `#sektorSubtitle` | 931 |
| Peringatan stale | `#sektorStaleWarn` (`style="display:none"`) | 932 |
| **Grid sektor** | `#sektorGroupsGrid` (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3`) | 934 |
| Detail view | `#sektorDetailView` (`hidden`) | 939 |
| Tombol kembali | `onclick="backToSektorList()"` | 940 |
| Header detail | `#sektorDetailHeader` | 944 |
| Tabel detail | `#sektorDetailTable` | 945 |

**Fungsi binding [FAKTA] — `index.html`:**

| Fungsi | Baris | Tugas | Endpoint |
|---|---|---|---|
| `loadSektorHot(silent)` | 9941–10035 | Muat grid grup | `/api/sector-hot` (9962) via `acKeepAliveFetch` |
| `showGroupDetail(groupCode)` | 10037–10108 | Muat detail grup | `/api/sector-hot?group=<code>` (10050) |
| `backToSektorList()` | 10110–10115 | Kembali ke list | — |
| `formatPct(val)` | 10118–10121 | Format persen (koma desimal) | — |
| `formatRatio(val)` | 10122–10125 | Format rasio volume | — |
| `formatPrice(val)` | 10126–10129 | Format harga Rp | — |
| `formatTxValue(val)` | 10130–10136 | Format nilai transaksi (B/M) | — |
| `formatVolume(val)` | 10137–10143 | Format volume (M/jt/rb) | — |

**Struktur data & render [FAKTA]:**

Kartu grup (10015–10027) menampilkan:
- `g.group_name || g.group_code` (10016)
- `g.avg_change_pct` via `changeDisplay()` (10011, 10017)
- `g.stock_count` (10019)
- `g.top_ticker` + `g.top_change_pct` (10020–10021)
- `g.avg_volume_ratio` via `formatRatio()` (10026)

**[FAKTA] Percentase flow dana — koreksi atas asumsi direktif:**
Direktif menyebut *"persentase flow dana"*. Yang sebenarnya ditampilkan adalah **`avg_change_pct`** (rata-rata perubahan harga per grup) dan **`avg_volume_ratio`** (rata-rata rasio volume vs rata-rata 30 hari). **Tidak ada field "flow dana" / net foreign flow / net buy** dalam render kartu (10015–10027) maupun detail (10073–10103). Kolom detail adalah: Ticker, Nama, Last, % Hari Ini, Vol Hari Ini, Vol/Avg30, Tipe (10074–10080).

**Metadata & stale warning [FAKTA]:**
- `data.meta.status` — menangani `'scanning'`, `'refreshing'`, `'failed'` (9975–9986)
- `data.meta.scanned_count`, `data.meta.failed_count` (9976, 9978, 9985)
- `data.meta.calculated_at` → format WIB via `toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', ... })` (9981–9983)
- Stale threshold: **>72 jam** → merah `#fca5a5` (9995–9998); **>24 jam** → kuning `#fde047` (9999–10002)

**Guard anti-tumpang [FAKTA]:** `loadSektorHot._busy` (9947–9948, 10033) mencegah fetch bersamaan.

**Keep-alive [FAKTA]:** `var keepAliveCards = silent && grid.querySelector('.sektor-group-card')` (9954) — saat revisit, kartu lama tidak dihapus (9955–9957).

**Tipe member [FAKTA]:** `m.member_type === 'ANCHOR'` (10091) → ticker diberi bintang ★ (10092) dan badge emerald (10100); selain itu badge abu-abu (10100).

---

### 3.4 Tab Screener

**Anchor DOM [FAKTA]:**
- Panel: `#page-screener` — `index.html` 951
- Kelas: `page-content hidden flex-1 max-w-[1100px] w-full mx-auto px-3 sm:px-5 py-4`
- Atribut: `data-premium-page="true"`

| Bagian | Anchor | Baris |
|---|---|---|
| Login gate | `#screenerLoginGate` | 953 |
| Konten | `#screenerContent` | 965 |
| Segmented control | `.ac-segmented` (role=group) | 980 |
| ↳ Konglo | `#scrTypeKonglo` (`ac-segment is-active`, `aria-pressed="true"`) | 981 |
| ↳ Non-Konglo | `#scrTypeNonKonglo` | 982 |
| ↳ Day Trade | `#scrTypeDayTrade` | 983 |
| Filter pola | `#patternFilterContainer` | 986 |
| Select pola | `#filter-pattern-personality` | 991 |
| Checkbox WR | `#filter-high-wr` | 1007 |
| **Pane Konglo** | `#screenerKongloPane` | 1013 |
| Subtitle | `#screenerSubtitle` | 1018 |
| Meta badge | `#screenerMetaBadge` | 1021 |
| Tombol PDF | `onclick="exportKongloScreenerPDF()"` | 1022 |
| Diagnostik gagal | `#screenerFailedDiag` | 1025 |
| Stat Universe | `#screenerStatUniverse` | 1033 |
| Stat Scanned | `#screenerStatScanned` | 1037 |
| Stat Failed | `#screenerStatFailed` | 1041 |
| **Filter query** | `.scr-filter-grid` | 1045 |
| ↳ Risk | `#kgRiskFilter` | 1046 |
| ↳ Status | `#kgStatusFilter` | 1047 |
| ↳ Type | `#kgTypeFilter` | 1048 |
| ↳ Hide Very High | `#kgHideVeryHigh` | 1049 |
| ↳ Cari ticker | `#kgTickerSearch` | 1050 |
| Tab filter | baris 1054–1059 (`filterScreener(...)`) | 1054–1059 |
| **Grid kartu** | `#kgCardGrid` | 1062 |
| Wrapper tabel | `#screenerTableWrap` (`hidden`) | 1064 |
| Tabel | `min-w-[1100px]`, `border-collapse` | 1065 |
| Header sticky | `sticky top-0 bg-dark-800/95 backdrop-blur z-20` | 1066 |
| Kolom (17) | `.scr-cols-17` | 1067 |
| Body tabel | `#screenerTableBody` | 1087 |
| **Pane Non-Konglo** | `#screenerNonKongloPane` (`hidden`) | 1094 |
| Stat Non-Konglo | `#nkUniverseCount`, `#nkScannedCount`, `#nkPublishedCount`, `#nkFailedCount`, `#nkStagingCount` | 1110–1123 |
| Progress | `#nkScreenerProgress`, `#nkProgressBar`, `#nkProgressText` | 1131–1139 |
| Filter NK | `#nkRiskFilter`, `#nkStatusFilter`, `#nkTypeFilter`, `#nkHideVeryHigh`, `#nkTickerSearch` | 1146–1150 |
| Tab NK | baris 1154–1158 (`filterNkScreener(...)`) | 1154–1158 |
| Grid NK | `#nkCardGrid` | 1161 |
| Tabel NK | `#nkScreenerTableWrap` (`hidden`), `min-w-[1200px]` | 1163–1164 |
| Body NK | `#nkScreenerTableBody` | 1187 |
| **Pane Day Trade** | `#screenerDayTradePane` (`hidden`) | 1194 |
| Stat DT | `#dtStatUniverse`, `#dtStatScanned`, `#dtStatPublished`, `#dtStatRunMode` | 1213–1225 |
| Progress DT | `#dtProgressWrap`, `#dtProgressBar`, `#dtProgressLabel`, `#dtProgressMsg`, `#dtProgressBatch`, `#dtProgressPassed`, `#dtProgressFailed` | 1229–1245 |
| Filter DT | `#dtRiskFilter`, `#dtStatusFilter`, `#dtTypeFilter`, `#dtHideVeryHigh`, `#dtTickerSearch` | 1250–1254 |
| Tab DT | baris 1258–1262 (`filterDtScreener(...)`) | 1258–1262 |
| Grid DT | `#dtCardGrid` | 1271 |
| Tabel DT | `#dtScreenerTableWrap` (`hidden`), `min-w-[1100px]` | 1273–1274 |
| Body DT | `#dtScreenerTableBody` | 1301 |

**Fungsi binding [FAKTA]:**

| Fungsi | Baris | Tugas |
|---|---|---|
| `loadSwingScreener(silent)` | 10174+ | Muat data screener (Konglo) |
| `startScreenerPolling()` | 10151–10161 | **Polling 15 detik** |
| `stopScreenerPolling()` | 10169–10172 | Hentikan |
| `_onScreenerVisibilityChange()` | 10163–10167 | Refresh saat tab kembali visible |
| `switchScreenerType(type)` | dirujuk 981–983 | Ganti pane |
| `applyScreenerUiFilters(scope)` | dirujuk 1046–1050, 1146–1150, 1250–1254 | Filter klien |
| `filterScreener(filter)` | 1054–1059 | Tab filter Konglo |
| `filterNkScreener(filter)` | 1154–1158 | Tab filter NK |
| `filterDtScreener(filter)` | 1258–1262 | Tab filter DT |
| `onPatternPersonalityFilterChange()` | dirujuk 991, 1007 | Filter pola |
| `exportKongloScreenerPDF()` | 1022 | Ekspor PDF |
| `exportNonKongloScreenerPDF()` | 1103 | Ekspor PDF |
| `exportDayTradePDF()` | 1203 | Ekspor PDF |
| `renderKgCardGrid(results)` | dirujuk 10196 | Render kartu Konglo |

**Pagination [FAKTA] — koreksi atas asumsi direktif:**
Direktif menyebut *"pagination"*. Audit **tidak menemukan** mekanisme pagination. Yang ada adalah:
- **Filter klien** (`applyScreenerUiFilters`) — filter risk/status/type/ticker
- **Tab filter** (`filterScreener`/`filterNkScreener`/`filterDtScreener`) — filter kategori setup
- **Virtual scroll via `max-h`**: tabel dibungkus `max-h-[560px] overflow-y-auto` (1064, 1163, 1273) — semua baris di-render sekaligus, container yang scroll
- **Grid kartu**: `repeat(auto-fill, minmax(300px, 1fr))` (1062, 1161, 1271)

Tidak ada `page`, `offset`, `limit`, tombol "next/prev", atau `LIMIT/OFFSET` di query. Ini adalah **keterbatasan skalabilitas**, bukan bug: dengan universe ~800 ticker dan rendering penuh, tabel dapat menjadi berat.

**Interval polling [FAKTA]:**

| Timer | Interval | Guard | Baris |
|---|---|---|---|
| `_screenerPollInterval` (Konglo) | **15 detik** | `document.hidden`, `_currentScreenerType !== 'konglo'` | 10153–10158 |
| `_nkPollInterval` (Non-Konglo) | (didefinisikan) | — | 10550 |
| `_dtPollInterval` (Day Trade) | (di `daytrade-runtime.js`) | — | 149–153 |
| `_dtPollInterval` (fallback header) | — | — | 10550 |

**Pembersihan polling [FAKTA]:** `navigateTo` baris 4541 memanggil `stopAllScreenerPolling()` untuk **semua** halaman kecuali `screener`. Ini mencegah polling berjalan di latar belakang.

**Keep-alive [FAKTA]:** `loadSwingScreener(kaRevisit)` (4618) — mode silent saat revisit; kartu lama dipertahankan dengan banner "refreshing" (10194–10198).

---

### 3.5 Tab Portofolio (Portfolio Command Center)

**[FAKTA] PENTING — ada DUA permukaan portofolio yang berbeda dan tidak boleh dicampur:**

| | **A. Portofolio dalam shell** | **B. Portfolio Command Center standalone** |
|---|---|---|
| Panel | `#page-portofolio` (`index.html` 1392) | `portfolio-command-center.html` |
| Loader | `renderPortfolio()` (`index.html` 11121) | `portfolio-command-center.js` |
| Tabel | `#portTableBody` (1478) di dalam `#portTableWrap` (1465) | `#watchTable` (176) di dalam `#watchBody` |
| Kartu mobile | `#portMobileCards` (1484) | `#watchCards` |
| Penyimpanan | `localStorage['autocuan_portfolio_<userKey>']` (10887) | `localStorage['autocuan_portfolio_plans_<uid>']` (84) |
| Halaman | Tab ke-5 di sidebar (`data-sidebar-page="portofolio"`, 485) | Dokumen terpisah, dimuat via `portfolio-command-center-v2.html` |

**Direktif menyebut `portfolio-command-center.js` / `renderWatch` / `#watchTable` sebagai penggerak Tab Portofolio. [FAKTA] Itu TIDAK akurat.** Tab Portofolio di sidebar digerakkan oleh kode **di dalam `index.html`**, bukan oleh `portfolio-command-center.js`. Keduanya harus dipetakan terpisah.

#### 3.5.A Portofolio dalam shell — `#page-portofolio`

**Anchor DOM [FAKTA]:**

| Bagian | Anchor | Baris |
|---|---|---|
| Login gate | `#portofolioLoginGate` | 1394 |
| Konten | `#portofolioContent` (`.portfolio-shell`) | 1406 |
| Tombol refresh | `#portRefreshBtn`, `onclick="refreshPortfolioPrices()"` | 1411 |
| Tombol tambah | `onclick="openAddPositionForm()"` | 1415 |
| Form tambah | `#addPositionForm` (`hidden`) | 1422 |
| ↳ Input ticker | `#portTicker` (`maxlength="5"`) | 1427 |
| ↳ Input lot | `#portLot` (`min="1"`) | 1431 |
| ↳ Input avg buy | `#portAvgBuy` (`min="1"`) | 1435 |
| ↳ Error | `#portFormError` | 1438 |
| ↳ Simpan | `onclick="savePosition()"` | 1440 |
| **Ringkasan** | `#portSummary` (`hidden`) | 1445 |
| ↳ Total Modal | `#portTotalModal` | 1448 |
| ↳ Total Nilai | `#portTotalValue` | 1452 |
| ↳ Total P/L Rp | `#portTotalPL` | 1456 |
| ↳ Total P/L % | `#portTotalPLPct` | 1460 |
| **Tabel** | `#portTableWrap` | 1465 |
| Header sticky | `sticky top-0 bg-dark-800/95 backdrop-blur z-10` | 1467 |
| Kolom (7) | Ticker, Lot, Avg Buy, Last Price, P/L (Rp), P/L %, aksi | 1469–1475 |
| Body | `#portTableBody` | 1478 |
| **Kartu mobile** | `#portMobileCards` (`sm:hidden`) | 1484 |
| Peringatan harga | `#portPriceWarning` | 1488 |

**Fungsi binding [FAKTA] — semua di `index.html`:**

| Fungsi | Baris | Tugas |
|---|---|---|
| `portfolioKey()` | ~10885–10888 | `'autocuan_portfolio_' + userKey` (10887) |
| `loadPortfolio()` | 10890 | Baca dari `localStorage` |
| `savePortfolio(positions)` | 10897 | Tulis ke `localStorage` |
| `acceptQuotePrice(data)` | 10932 | Normalisasi respons quote |
| `computePositionPL(lot, avgBuy, lastPrice)` | 10948 | **Kalkulasi P/L** |
| `computePortfolioTotals(positions)` | 10964 | **Agregasi total** |
| `renderPortfolioView(positions)` | 11047–11119 | **Satu-satunya renderer** (tabel + kartu + ringkasan + warning) |
| `renderPortfolio()` | 11121–11126 | `loadPortfolio()` → `renderPortfolioView()` → `refreshPortfolioPrices()` |
| `renderPortfolioTable(positions)` | 11129–11131 | Alias legacy → `renderPortfolioView` |
| `fetchPortfolioQuotesBounded(tickers)` | 11139–11164 | Fetch paralel **terbatas** |
| `refreshPortfolioPrices()` | 11167+ | Refresh semua harga |

**[FAKTA] Kalkulasi P/L — `computePositionPL` (10948):**
Kontrak P/L diisolasi dalam satu fungsi. Pemanggil di `renderPortfolioView` 11068:
```javascript
var m = computePositionPL(pos.lot, pos.avgBuy, pos._lastPrice);
```
Objek hasil `m` memiliki `m.priced`, `m.plRp`, `m.plPct`. Pola pemakaian di 11071–11074:
```javascript
var plRpText = m.priced ? formatRupiah(m.plRp) : '—';
var plPctText = m.priced ? m.plPct.toFixed(2) + '%' : '—';
var plRpClass = m.priced ? (m.plRp >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-gray-500';
var plPctClass = m.priced ? (m.plPct >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-gray-500';
```
**[FAKTA] Semantik "data hilang ≠ nol" sudah benar di sini** — posisi tanpa harga menampilkan `—` dan kelas `text-gray-500`, bukan `Rp 0` berwarna hijau.

**[FAKTA] Modal (capital) — `computePortfolioTotals` (10964):** agregasi `totalModal`, `totalValue`, `plRp`, `plPct`, `priced`, `unpriced`, `total`. Dipakai di 11095–11118.

**[FAKTA] Perilaku saat harga tidak lengkap — 11111–11118:**
```javascript
if (warningEl) {
    if (totals.unpriced > 0) {
        warningEl.textContent = totals.unpriced + ' dari ' + totals.total + ' posisi belum bisa dihargai. Total di atas hanya mencakup posisi yang berhasil dihargai; posisi lain ditampilkan "—".';
        warningEl.classList.remove('hidden');
    } else {
        warningEl.classList.add('hidden');
    }
}
```
Ini adalah **penanganan yang benar dan transparan**.

**[FAKTA] Guard konkurensi — 11138, 11166, 11171:**
```javascript
var PORTFOLIO_PRICE_FETCH_CONCURRENCY = 8;    // 11138
var _portRefreshInFlight = false;              // 11166
if (_portRefreshInFlight) return;              // 11171
```
Komentar 11133–11137 menjelaskan rasional: setiap `/api/quote` juga menanyakan beberapa tabel Supabase, sehingga `Promise.all(tickers.map(...))` pada portofolio besar akan membanjiri server.

**[FAKTA] Endpoint:** `/api/quote?ticker=<T>&portfolio=1` (11148) dengan header `getAuthHeaders()`.

**[FAKTA] State penyimpanan:** `localStorage` saja. Kunci di-scope per user via `portfolioKey()` (10887). **Tidak ada sinkronisasi server** untuk portofolio dalam shell ini.

#### 3.5.B Portfolio Command Center standalone

**Anchor DOM [FAKTA] — `portfolio-command-center.html`:**

| Bagian | Anchor | Baris |
|---|---|---|
| Stylesheet | `/portfolio-command-center.css` | 13 |
| Tabel holdings | `#watchTable` (`.table-wrap hidden`) | 176 |
| Kolom tabel | Ticker, Status, Lot, Entry, Harga, P/L, ... | 176 |
| Script model | `/portfolio-command-center-model.js` | 310 |
| Script runtime | `/portfolio-command-center.js` | 311 |

**Fungsi binding [FAKTA] — `portfolio-command-center.js`:**

| Fungsi | Baris | Tugas |
|---|---|---|
| `loadLocalState()` | 117–126 | Muat plans/prices/journal/changes |
| `checkAccess()` | 140–179 | Verifikasi akses |
| `bind()` | 181–215 | Wiring semua event |
| `openTab(name)` | 228–240 | Ganti tab internal |
| `renderAll()` | 261–263 | `renderToday()` + `renderWatch()` + `renderRiskOptions()` + `renderAlerts()` + `renderJournal()` |
| `renderToday()` | 300–320 | Ringkasan harian |
| **`renderWatch()`** | **511–522** | **Render tabel `#watchBody` + kartu `#watchCards`** |
| `renderJournal()` | 594–598 | Jurnal |
| `refreshAllPrices(force)` | 383–398 | Refresh harga |
| `quote(symbol)` | 372–381 | Ambil satu harga |

**[FAKTA] `renderWatch()` — 511–522:**
```javascript
function renderWatch() {
  var summary = Model.summarize(state.plans, state.prices);
  if (!summary.plans.length) { show('watchEmpty'); hide('watchTable'); $('watchCards').innerHTML = ''; return; }
  hide('watchEmpty'); show('watchTable');
  var rows = summary.plans.map(function (plan) {
    var current = num(state.prices[plan.ticker]); var status = Model.planStatus(plan, current);
    var pnl = current && plan.entryPriceIdr ? (current - plan.entryPriceIdr) * plan.lots * 100 : null;
    return { plan:plan, current:current, status:status, pnl:pnl };
  });
  $('watchBody').innerHTML = rows.map(...).join('');
  $('watchCards').innerHTML = rows.map(...).join('');
}
```

**[FAKTA] State penyimpanan — kunci `localStorage` (84–89):**
```
plansKey()      → 'autocuan_portfolio_plans_' + state.uid
pricesKey()     → 'autocuan_portfolio_prices_' + state.uid
journalKey()    → 'autocuan_portfolio_journal_v1_' + state.uid
snapshotKey()   → 'autocuan_portfolio_command_snapshot_v1_' + state.uid
changesKey()    → 'autocuan_portfolio_command_changes_v1_' + state.uid
priceTimeKey()  → 'autocuan_portfolio_price_updated_v1_' + state.uid
```

**[FAKTA] Semantik "data hilang ≠ nol" — LEBIH KETAT dari versi shell.** `portfolio-command-center.js` 18–43 mendokumentasikan dan mengimplementasikan gate `finite()`:
```javascript
function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  var raw = value.trim();
  if (raw === '') return null;
  var n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
```
Komentar 18–32 menjelaskan: `Number(null)`, `Number('')`, `Number('   ')`, `Number([])` semuanya menjadi `0`, dan `0` itu finite — sehingga nilai yang hilang dirender sebagai "Rp 0" yang terlihat identik dengan nol yang benar-benar terukur. `finite()` adalah satu-satunya gerbang.

Konsekuensinya terlihat di 57–60:
```javascript
function money(value) {
  var n = finite(value);
  return n === null ? '—' : 'Rp ' + Math.round(n).toLocaleString('id-ID');
}
```
dan di 66–75 `pnlClass()` dengan kelas `pnl-unknown` terpisah dari `pnl-flat`.

**[FAKTA] Inkonsistensi antar-modul yang teridentifikasi:** `money-management-runtime.js` 53–56 **tidak** memakai gate ini:
```javascript
function formatRp(val) {
  if (val == null || !Number.isFinite(Number(val))) return 'Rp 0';
  return 'Rp ' + Number(val).toLocaleString('id-ID');
}
```
Perhatikan: `Number('')` = `0` → `Number.isFinite(0)` = `true` → fungsi mengembalikan **`'Rp 0'`**, bukan `'—'`. Jadi tiga modul memiliki tiga semantik berbeda untuk "nilai hilang":
- `index.html` (portofolio shell, 11071): `'—'` ✅
- `portfolio-command-center.js` (57–60): `'—'` ✅
- `money-management-runtime.js` (54): **`'Rp 0'`** ❌

Ini adalah **cacat kebenaran data lintas modul** yang layak diperbaiki di gelombang berikutnya.

---

### 3.6 Tab Watchlist

**Anchor DOM [FAKTA]:**
- Panel: `#page-watchlist` — `index.html` 1822
- Kelas: `page-content hidden flex-1 max-w-[1100px] w-full mx-auto px-3 sm:px-5 py-4 space-y-4`
- Atribut: `data-premium-page="true"`

| Bagian | Anchor | Baris |
|---|---|---|
| Hero | `.dashboard-hero` | 1824 |
| Tombol riwayat alert | `onclick="openAlertHistoryModal()"` | 1835 |
| Tombol refresh | `onclick="loadUserWatchlist(true)"` | 1839 |
| Total dipantau | `#wlTotalCount` | 1854 |
| Alert aktif | `#wlActiveAlertCount` | 1862 |
| Tab filter | `#watchlistFilterTabs` | 1875 |
| ↳ Semua | `onclick="filterWatchlist('all')"` | 1876 |
| ↳ Ada alert | `onclick="filterWatchlist('alert')"` | 1877 |
| ↳ Naik | `onclick="filterWatchlist('gain')"` | 1878 |
| ↳ Turun | `onclick="filterWatchlist('loss')"` | 1879 |
| **Kontainer** | `#watchlistContainer` | 1882 |
| Empty state | `#watchlistEmpty` | 1885 |
| ↳ Judul | `#watchlistEmptyTitle` | 1887 |
| ↳ Deskripsi | `#watchlistEmptyDesc` | 1888 |
| **Modal alert** | `#wlAlertModal` | 2363 |
| ↳ ID (hidden) | `#wlAlertId` | 2373 |
| ↳ Ticker | `#wlAlertTicker` | 2376 |
| ↳ Kondisi | `#wlAlertCondition` | 2380 |
| ↳ Harga target | `#wlAlertPrice` | 2390 |
| ↳ Submit | `#wlAlertSubmitBtn`, `onclick="submitCreateAlert()"` | 2393 |
| **Modal catatan** | `#wlNotesModal` | 2399 |
| ↳ Ticker display | `#wlNotesTickerDisplay` | 2404 |
| ↳ Ticker (hidden) | `#wlNotesTicker` | 2409 |
| ↳ Teks | `#wlNotesText` (`maxlength="500"`) | 2412 |
| ↳ Simpan | `onclick="saveWatchlistNotes()"` | 2417 |
| **Modal riwayat** | `#wlAlertHistoryModal` | 2424 |
| ↳ Daftar | `#wlAlertHistoryList` | 2434 |

**[FAKTA] Kondisi alert yang tersedia — `index.html` 2381–2385:**
| Value | Label |
|---|---|
| `PRICE_ABOVE` | ▲ Naik Menembus Harga (Breakout) |
| `PRICE_BELOW` | ▼ Turun Menyentuh Harga (Support/SL) |
| `ENTRY_ZONE` | 🎯 Masuk Area Entry Ideal |
| `TP_HIT` | 💰 Target Profit (TP) Tercapai |
| `SL_HIT` | 🛑 Stop Loss (SL) Tersentuh |

**[FAKTA] Catatan penting:** `watchlist-runtime.js` 156–157 hanya menangani `PRICE_ABOVE` dan `PRICE_BELOW` saat merender label:
```javascript
var label = a.condition_type === 'PRICE_ABOVE' ? ('▲ > Rp' + Number(a.target_price).toLocaleString('id-ID')) :
            (a.condition_type === 'PRICE_BELOW' ? ('▼ < Rp' + Number(a.target_price).toLocaleString('id-ID')) : a.condition_type);
```
Tiga kondisi lain (`ENTRY_ZONE`, `TP_HIT`, `SL_HIT`) akan menampilkan **kode mentah** sebagai label, bukan teks yang dapat dibaca. **[HIPOTESIS]** Cacat kosmetik yang terukur.

**Fungsi binding [FAKTA] — `watchlist-runtime.js`:**

| Fungsi | Baris | Tugas | Endpoint |
|---|---|---|---|
| `loadUserWatchlist(force)` | 44–86 | Muat daftar | `GET /api/sector-hot?action=watchlist` (54) |
| `filterWatchlist(filterName)` | 88–99 | Filter klien | — |
| `renderWatchlistView(items)` | 101–202 | Render tabel | — |
| `toggleWatchlistTicker(ticker, notes, e)` | 204–251 | Tambah/hapus | `DELETE /api/sector-hot?action=watchlist&ticker=` (213) / `POST` (223) |
| `updateAllWatchlistStars()` | 253–269 | Sinkronkan bintang | — |
| `setAlertModalMode(editingId)` | 271–280 | Mode create/edit | — |
| `openCreateAlertModal(ticker)` | 282–294 | Buka modal | — |
| `openEditAlertModal(...)` | 296–308 | Buka modal edit | — |
| `closeCreateAlertModal()` | 310–314 | Tutup | — |
| `submitCreateAlert()` | 316–362 | Simpan alert | `POST` / `PATCH /api/sector-hot?action=watchlist-alert` (337–342) |
| `deleteUserAlert(alertId)` | 364–380 | Hapus alert | `DELETE /api/sector-hot?action=watchlist-alert&id=` (367) |
| `openEditNotesModal(ticker, notes)` | 382–403 | Buka catatan | — |
| `saveWatchlistNotes()` | 410–447 | Simpan catatan | `POST /api/sector-hot?action=watchlist` (422) |
| `openAlertHistoryModal()` | 467–506 | Riwayat | `GET /api/sector-hot?action=watchlist-alert-history` (475) |
| `closeAlertHistoryModal()` | 508–511 | Tutup | — |

**Listener alert Telegram [FAKTA]:**
- `index.html` 2392: *"Notifikasi akan dikirim via Telegram bot otomatis saat intraday monitor mendeteksi harga mencapai target."*
- Riwayat alert mencatat aksi `created`, `updated`, `deleted`, `triggered` — `watchlist-runtime.js` 449–454:
```javascript
var ALERT_HISTORY_ACTION_LABELS = {
  created:   { label: 'Alert dibuat',      icon: '🟢', color: 'text-emerald-400' },
  updated:   { label: 'Alert diubah',      icon: '✏️', color: 'text-blue-400' },
  deleted:   { label: 'Alert dihapus',     icon: '🗑️', color: 'text-red-400' },
  triggered: { label: 'Alert ter-trigger', icon: '🔔', color: 'text-amber-400' }
};
```

**Cache & keep-alive [FAKTA]:**
- `watchlistFetch()` (29–34) → `AutoCuanKeepAlive.cachedFetch`
- `invalidateWatchlistCache()` (37–41) → `AutoCuanKeepAlive.invalidate('/api/sector-hot?action=watchlist')`
- Dipanggil setelah setiap mutasi (240, 354, 374, 434)
- Guard `isLoading` (50–51, 84)

**Auto-init [FAKTA]:** `document.addEventListener('DOMContentLoaded', ...)` → `loadUserWatchlist()` (529–531).

**Catatan [FAKTA]:** direktif menyebut *"target price input"*. Yang ada adalah modal `#wlAlertModal` (2363) dengan `#wlAlertPrice` (2390), bukan input inline di tabel.

---

### 3.7 Tab Track Record

**Anchor DOM [FAKTA]:**
- Panel: `#page-trackrecord` — `index.html` 1493
- Kelas: `page-content hidden flex-1 max-w-[1100px] w-full mx-auto px-3 sm:px-5 py-4 space-y-4`
- Atribut: `data-premium-page="true"`

| Bagian | Anchor | Baris |
|---|---|---|
| Hero | `.dashboard-hero` | 1495 |
| Tombol CSV | `#trackRecordExportBtn`, `onclick="exportTrackRecordCsv()"` | 1506 |
| Tombol muat ulang | `#trackRecordRefreshBtn`, `onclick="loadTrackRecord(true)"` | 1509 |
| Tab tabel | `#trViewTabTable`, `onclick="switchTrackRecordView('table')"` | 1519 |
| Tab backtest | `#trViewTabBacktest`, `onclick="switchTrackRecordView('backtest')"` | 1522 |
| Panel tabel | `#trTableViewPanel` | 1529 |
| **Grid metrik** | `#trackRecordSummaryGrid` | 1531 |
| ↳ Total sinyal | `#trTotalSignals` | 1538 |
| ↳ Sub total | `#trTotalSignalsSub` | 1539 |
| ↳ **Win Rate TP1** | `#trWinRateTp1` | 1548 |
| ↳ Sub TP1 | `#trTp1HitsSub` | 1549 |
| ↳ **Win Rate TP2** | `#trWinRateTp2` | 1558 |
| ↳ Sub TP2 | `#trTp2HitsSub` | 1559 |
| ↳ **SL Hit Rate** | `#trSlRate` | 1568 |
| ↳ Sub SL | `#trSlHitsSub` | 1569 |
| ↳ **Untung terbesar** | `#trBestGain` | 1578 |
| ↳ Sub best gain | `#trBestGainSub` | 1579 |
| Grid kategori | `#trCategoryGrid` | 1586 |
| Tab kategori | `#trCategoryTabs` | 1595 |
| ↳ Semua | `filterTrackRecordCategory('all')` | 1596 |
| ↳ Day Trade | `filterTrackRecordCategory('daytrade')` | 1597 |
| ↳ Swing Konglo | `filterTrackRecordCategory('swing_konglo')` | 1598 |
| ↳ Swing Non-Konglo | `filterTrackRecordCategory('swing_nk')` | 1599 |
| ↳ Top 5 | `filterTrackRecordCategory('top5')` | 1600 |
| Filter status | `#trStatusFilter` | 1605 |
| Pencarian | `#trSearchInput` | 1614 |
| Wrapper tabel | `#trTableWrap` | 1621 |
| Body tabel | `#trTableBody` | 1637 |
| Empty state | `#trEmptyState` | 1642 |
| **Panel backtest** | `#trBacktestViewPanel` (`hidden`) | 1649 |
| Tombol hitung | `onclick="triggerBacktestSimulation()"` | 1659 |
| Filter kategori | `#btCategoryFilter` | 1668 |
| Filter periode | `#btPeriodFilter` | 1679 |
| Filter min RR | `#btMinRrFilter` | 1689 |
| Strategi target | `#btTargetStrategyFilter` | 1699 |
| Modal awal | `#btInitialCapitalInput` (default `10000000`) | 1707 |
| Model sizing | `#btSizingModeFilter` | 1712 |
| Alokasi per posisi | `#btPositionAmountInput` (default `2000000`) | 1721 |
| ↳ Saldo akhir | `#btMetricEndingCapital` | 1731 |
| ↳ Net return | `#btMetricNetReturn` | 1732 |
| ↳ Win rate | `#btMetricWinRate` | 1738 |
| ↳ Win/loss sub | `#btMetricWinLossSub` | 1739 |
| ↳ Profit factor | `#btMetricProfitFactor` | 1745 |
| ↳ PF sub | `#btMetricProfitFactorSub` | 1746 |
| ↳ Expectancy | `#btMetricExpectancy` | 1752 |
| ↳ Max drawdown | `#btMetricMaxDrawdown` | 1759 |
| ↳ Rata-rata hold | `#btMetricAvgDuration` | 1766 |
| Canvas equity curve | `#trBacktestChart` | 1782 |
| Wrapper log trades | `#trBacktestTradesWrap` | 1793 |
| Body log | `#trBacktestTradesBody` | 1809 |
| Empty backtest | `#trBacktestEmptyState` | 1814 |

**Fungsi binding [FAKTA] — `track-record-runtime.js`:**

| Fungsi | Baris | Tugas |
|---|---|---|
| `trEntryBounds(s)` | 30–38 | Urutkan entry1/entry2 rendah→tinggi |
| `trSkeletonHtml()` | 40–42 | Skeleton |
| `loadTrackRecord(force)` | 44–110 | Muat data |
| `renderTrackRecordUI(data)` | 112–184 | Render kartu ringkasan + kategori |
| `filterTrackRecordCategory(cat)` | 186–199 | Filter kategori |
| `renderTrackRecordTable()` | 201–297 | Render tabel sinyal |
| `escapeCsvCell(val)` | 314–321 | Escape CSV |
| `getTrackRecordCsvFilename(d)` | 323–329 | Nama file CSV |
| `formatTrackRecordCsvRow(s)` | 331–352 | Baris CSV |
| `generateTrackRecordCsv(signals)` | 354–361 | Generate CSV |
| `exportTrackRecordCsv()` | 363–382 | Unduh CSV |
| `switchTrackRecordView(view)` | 388–426 | Ganti tabel/backtest |
| `triggerBacktestSimulation()` | 428–506 | Jalankan backtest |

**Endpoint & fallback [FAKTA] — `loadTrackRecord` 71–95:**
```javascript
// 1. Try dedicated route /api/track-record
try {
    res = await trFetch('/api/track-record');            // 73
    if (res && res.ok) {
        rawText = await res.text();
        if (rawText && !rawText.trim().startsWith('<')) { // 76
            data = JSON.parse(rawText);
        }
    }
} catch (_) {}

// 2. Fallback to /api/sector-hot?action=track-record if needed
if (!data || !data.success) {
    try {
        res = await trFetch('/api/sector-hot?action=track-record');  // 85
        rawText = await res.text();
        if (rawText && !rawText.trim().startsWith('<')) {
            data = JSON.parse(rawText);
        } else if (rawText && rawText.trim().startsWith('<')) {       // 89
            throw new Error('Respon server tidak valid (halaman HTML/502). Sedang menyinkronkan data.');
        }
    } catch (fbErr) {
        if (!data) throw fbErr;
    }
}
```
**[FAKTA] Deteksi respons HTML/502 sangat baik.** Baris 76 dan 89 memeriksa apakah respons dimulai dengan `<` — menangkap kasus di mana proxy/edge mengembalikan halaman HTML alih-alih JSON. Ini adalah pola pertahanan yang tepat.

**Data model [FAKTA]:**
- `data.summary` → `total_signals`, `total_resolved`, `running_signals`, `waiting_signals`, `win_rate_tp1`, `tp1_hits`, `win_rate_tp2`, `tp2_hits`, `sl_rate`, `sl_hits`, `best_gain{gain_pct,ticker,date}` (114–145)
- `data.by_category` → `daytrade`, `swing_konglo`, `swing_nk`, `top5` (149–154)
- `data.category_meta` → `{icon, label, description}` (151)
- `data.signals[]` → `ticker`, `source`, `source_short`, `source_label`, `category`, `date`, `signal_time_wib`, `price_at_signal`, `entry1`, `entry2`, `tp1`, `tp2`, `sl`, `outcome`, `status_label`, `status_tone`, `status_bg`, `status_border`, `gain_pct`, `hit_time_wib`, `price_at_hit`, `duration_text`, `score`

**[FAKTA] Enum outcome (dari filter 214–219):**
`TP1_HIT`, `TP2_HIT`, `SL_HIT`, `RUNNING`, `ENTRY_HIT`, `WAITING`, `EXPIRED`

**[FAKTA] Status khusus EXPIRED (254–257):**
```javascript
var isExpiredSignal = s.outcome === 'EXPIRED' || s.status_label === 'Sinyal Kedaluwarsa' || s.status_label === 'Expired';
var statusTooltip = isExpiredSignal ? ' title="Harga tidak pernah masuk area beli (Entry 1 / Entry 2) dalam batas waktu pengamatan sinyal."' : '';
var statusLabelText = isExpiredSignal ? 'Sinyal Kedaluwarsa' : s.status_label;
```

**[FAKTA] `trEntryBounds` — perbaikan urutan yang terdokumentasi (18–38):**
Komentar 18–29 menjelaskan bahwa `entry1` adalah batas ATAS dan `entry2` batas BAWAH di `telegram_daily_picks`, sehingga merender entry1 lalu entry2 menghasilkan rentang terbalik ("Rp 1.250–Rp 1.200"). Fungsi `trEntryBounds` mengurutkan, bukan menukar field — sehingga perbaikan tetap benar apa pun urutan data di masa depan.

**Backtest [FAKTA] — `triggerBacktestSimulation` 428–506:**
- Bergantung pada global `AutoCuanBacktest` dari `track-record-backtest.js` (dimuat di `index.html` 12953)
- Guard: `if (typeof AutoCuanBacktest === 'undefined' || !AutoCuanBacktest.runBacktestSimulation) return;` (429)
- Konfigurasi (440–448): `category`, `periodDays`, `minRr`, `initialCapital`, `sizingMode`, `positionAmount`, `targetStrategy`
- Metrik (451–501): `endingCapital`, `netProfitRp`, `totalReturnPct`, `winRatePct`, `winCount`, `lossCount`, `totalTrades`, `profitFactor`, `grossProfitRp`, `grossLossRp`, `expectancyRp`, `maxDrawdownPct`, `avgDurationDays`
- **[FAKTA] Penanganan profit factor tak terhingga (478):** `elPf.textContent = m.profitFactor >= 90 ? '> 99' : m.profitFactor.toFixed(2);` — menangani pembagian dengan nol loss secara graceful.

**Cache & guard [FAKTA]:**
- `_trData` (2) — cache data
- `_trInFlight` (4) — guard
- `if (!force && _trData) { renderTrackRecordUI(_trData); return; }` (49–52)
- Keep-alive via `window.AutoCuanKeepAlive.cachedFetch` (67–69)

**[FAKTA] Pemuatan otomatis backtest:** setelah render, `renderTrackRecordUI` memanggil `triggerBacktestSimulation()` jika tersedia (181–183).

---

### 3.8 Tab Macro DeepScan

**Anchor DOM [FAKTA]:**
- Panel: `#page-deepscan` — `index.html` 1945
- Kelas: `page-content hidden flex-1 max-w-[1200px] w-full mx-auto px-3 sm:px-5 py-4 space-y-4`
- Atribut: `data-premium-page="true"`
- **Catatan:** `max-w-[1200px]` — berbeda dari mayoritas

| Bagian | Anchor | Baris |
|---|---|---|
| Hero | `.dashboard-hero` | 1946 |
| Badge Macro Swing | `.dash-badge` | 1950 |
| Badge Akumulasi Bandar | `.dash-badge` | 1951 |
| Meta badge | `#deepscanMetaBadge` | 1957 |
| Tombol pindai | `onclick="loadDeepScan(true)"` | 1958 |
| Info bar aturan | `.scr-info-bar` | 1967 |
| Grid kartu | `#deepscanCardsGrid` (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`) | 1974 |
| Wrapper tabel | `#deepscanTableWrap` (`max-h-[560px]`) | 1984 |
| Tabel | `min-w-[900px]` | 1985 |
| Header sticky | `sticky top-0 bg-dark-800/95 backdrop-blur z-20` | 1986 |
| Kolom (10) | #, Ticker, Score, Last, Area Beli (BoW), Stop Loss, TP1, TP2 Mayor, R:R, Akumulasi Bandar | 1988–1997 |
| Body | `#deepscanTableBody` | 2000 |

**Fungsi binding [FAKTA] — `deepscan-runtime.js`:**

| Fungsi | Baris | Tugas |
|---|---|---|
| `getScoreBadgeClass(score)` | 33–38 | Kelas warna berdasarkan skor |
| `renderDeepScanCards(picks)` | 40–112 | Render kartu top picks |
| `renderDeepScanTable(results)` | 114–141 | Render tabel lengkap |
| `loadDeepScan(force)` | 153–188 | Muat data |

**Endpoint [FAKTA]:** `/api/sector-hot?action=deepscan` (+ `&refresh=1` jika force) — `deepscan-runtime.js` 165.

**Data model [FAKTA] — dari `renderDeepScanCards` dan `renderDeepScanTable`:**
`data.date`, `data.total_candidates`, `data.top_picks[]`, `data.all_results[]`

Field per item:
- `ticker`, `score` (0–100), `last_price` / `close`
- `accumulation_floor` (lantai akumulasi 3–6 bulan)
- `entry_low`, `entry_high` (area beli BoW)
- `stop_loss` (valid s/d Rp1)
- `tp1`, `tp2` (target mayor)
- `rr_to_tp1`, `rr_to_tp2` (ditampilkan sebagai "1 : X")
- `cr3` (konsentrasi 3 broker teratas, %)
- `rsi14`, `rsi_threshold.note`

**Badge skor [FAKTA] — 33–38:**
| Skor | Kelas |
|---|---|
| ≥ 80 | `bg-emerald-500/20 text-emerald-300 border-emerald-500/40` |
| ≥ 65 | `bg-blue-500/20 text-blue-300 border-blue-500/40` |
| ≥ 50 | `bg-amber-500/20 text-amber-300 border-amber-500/40` |
| < 50 | `bg-dark-600/60 text-gray-400 border-dark-500/30` |

**[FAKTA] Ini adalah pemetaan semantik yang baik** — skor tertinggi mendapat emerald (aksen utama), bukan warna acak.

**Keep-alive & guard [FAKTA]:**
- `deepScanLoading` (10) — guard 154
- `if (!force && deepScanData && container && container.children.length) return;` (158) — no-op saat revisit
- `deepScanFetch()` (146–151) → `AutoCuanKeepAlive.cachedFetch`
- `headers: { 'Accept': 'application/json' }` (166)

**State kegagalan [FAKTA]:**
- Sukses tapi kosong → badge "DeepScan Standby", render array kosong (178–180)
- Error → `console.warn` + badge "Gagal memuat" (182–184)

**[CATATAN PENTING — koreksi atas direktif]**
Direktif menyebut: *"Metriks makroekonomi, suku bunga, dan yield curve display."*

**[FAKTA] Tab ini BUKAN tentang makroekonomi.** Isinya adalah **screening saham swing 1–3 bulan** berbasis akumulasi bandar. Bukti:
- Judul halaman (1953): "Macro DeepScan"
- Deskripsi (1954): *"Hasil screening macro swing berbasis akumulasi bandar (CR3/CR5) 3–6 bulan di lantai support."*
- Aturan (1967): *"Entry Buy on Weakness (BoW) di lantai akumulasi. Stop Loss terukur di bawah lantai..."*
- Kolom tabel (1988–1997): Ticker, Score, Last, Area Beli (BoW), Stop Loss, TP1, TP2 Mayor, R:R, Akumulasi Bandar
- Field data: `accumulation_floor`, `entry_low/high`, `stop_loss`, `tp1/tp2`, `cr3`, `rsi14`

**Tidak ada satu pun** field suku bunga (interest rate), inflasi, PDB, atau yield curve dalam kode. Kata "Macro" di sini merujuk pada **horizon waktu** (swing 1–3 bulan), bukan makroekonomi.

**[HIPOTESIS]** Jika kebutuhan "metriks makroekonomi & yield curve" memang nyata, itu adalah **fitur baru yang belum ada**, bukan perbaikan visual. Harus dipisahkan dari pekerjaan visual dan dijadwalkan sebagai pekerjaan produk terpisah dengan sumber data yang jelas.

---

### 3.9 Tab Kelola Keuangan

**Anchor DOM [FAKTA]:**
- Panel: `#page-money-management` — `index.html` 2009
- Kelas: `page-content hidden flex-1 max-w-[1200px] w-full mx-auto px-3 sm:px-5 py-4 space-y-4`
- Atribut: `data-premium-page="true"`

| Bagian | Anchor | Baris |
|---|---|---|
| Hero | `.dashboard-hero` | 2010 |
| **Segmented sub-tab** | `.ac-segmented` (role=group) | 2024 |
| ↳ Arus Kas | `#mmTabBtnCashflow` (`ac-segment is-active`), `onclick="switchMoneySubTab('cashflow')"` | 2025 |
| ↳ Jurnal | `#mmTabBtnJournal`, `onclick="switchMoneySubTab('journal')"` | 2026 |
| **Panel Cashflow** | `#mmPanelCashflow` | 2030 |
| ↳ Banner status | `#mmBudgetSafetyStatus` | 2032 |
| ↳ Tile Total Pemasukan | `#mmTotalIncomeDisplay` | 2040 |
| ↳ Tile Pengeluaran | `#mmTotalLivingExpenseDisplay` | 2045 |
| ↳ Tile Modal Trading | `#mmTradingCapDisplay` | 2050 |
| ↳ Tile Sisa Kas | `#mmRemainingBudgetDisplay` | 2055 |
| ↳ Input hidden | `#mmIncomeSalary`, `#mmIncomeSide`, `#mmIncomeOther`, `#mmExpNecessities`, `#mmExpWants`, `#mmSavings`, `#mmTradingCapital` | 2061–2067 |
| ↳ **Tabel cashflow** | **`#mmCashflowSpreadsheetTable`** | **2071** |
| ↳ Header sticky | `sticky top-0 bg-dark-800/95 backdrop-blur z-20` | 2072 |
| ↳ Kolom (7) | #, Kategori, Pos Anggaran, Tipe, Alokasi (Rp), % Rasio, Catatan | 2074–2080 |
| ↳ **Body** | **`#mmCashflowSpreadsheetBody`** | **2083** |
| ↳ Footer sticky | `sticky bottom-0 bg-dark-800/95` | 2086 |
| ↳ Foot pemasukan | `#mmCfFootIncome` | 2089 |
| ↳ Foot pengeluaran | `#mmCfFootExpense`, `#mmCfFootExpensePct` | 2095–2096 |
| ↳ Foot trading | `#mmCfFootTrading`, `#mmCfFootTradingPct` | 2101–2102 |
| ↳ Foot sisa | `#mmCfFootRemaining` | 2107 |
| ↳ Catatan | `#mmCashflowNotes` | 2116 |
| ↳ Simpan | `#mmSaveCashflowBtn`, `onclick="saveCashflowData()"` | 2118 |
| **Panel Jurnal** | `#mmPanelJournal` (`hidden`) | 2125 |
| ↳ Tile modal | `#mmJrTotalCap` | 2130 |
| ↳ Tile RDL | `#mmJrIdleRdl` | 2135 |
| ↳ Tile P/L | `#mmJrTotalPl` | 2140 |
| ↳ Tile win rate | `#mmJrWinRate` | 2145 |
| ↳ Ref modal | `#mmJrTradingCapRef` | 2154 |
| ↳ Input tanggal | `#mmJrDate` | 2159 |
| ↳ Input ticker | `#mmJrTicker` (`maxlength="6"`) | 2163 |
| ↳ Select posisi | `#mmJrType` (BUY/SELL) | 2167 |
| ↳ Input entry | `#mmJrEntryPrice` | 2174 |
| ↳ Input lot | `#mmJrLots` (`value="1" min="1"`) | 2178 |
| ↳ Input exit | `#mmJrExitPrice` | 2182 |
| ↳ Tombol simpan | `onclick="addJournalTrade()"` | 2185 |
| ↳ Catatan | `#mmJrNotes` | 2191 |
| ↳ **Tabel jurnal** | **`#mmJournalSpreadsheetTable`** | **2197** |
| ↳ Header sticky | `sticky top-0 bg-dark-800/95 backdrop-blur z-20` | 2198 |
| ↳ Kolom (13) | #, Tanggal, Ticker, Posisi, Entry, Lot, Modal, Exit ✏️, Realized P/L, P/L %, Status, Catatan ✏️, Aksi | 2200–2212 |
| ↳ **Body** | **`#mmJournalTableBody`** | **2215** |
| ↳ Footer sticky | `sticky bottom-0` | 2218 |
| ↳ Foot lots | `#mmJrFootLots` | 2221 |
| ↳ Foot capital | `#mmJrFootCapital` | 2222 |
| ↳ Foot P/L | `#mmJrFootPl` | 2224 |
| ↳ Foot win rate | `#mmJrFootWinRate` | 2225 |

**Fungsi binding [FAKTA] — `money-management-runtime.js` (555 baris):**

| Fungsi | Baris | Tugas | Dipublikasikan |
|---|---|---|---|
| `acMoneyFetch(url, opts)` | 28–33 | Fetch via keep-alive | internal |
| `invalidateMoneyCache()` | 36–40 | Invalidasi cache | internal |
| `escapeHtml(str)` | 42–51 | Escape | internal |
| `formatRp(val)` | 53–56 | Format Rp | internal |
| `formatNumber(val)` | 58–61 | Format angka | internal |
| `getNumericValue(id)` | 63–68 | Baca input numerik | internal |
| `setFieldValue(id, val)` | 70–73 | Set nilai field | internal |
| **`switchMoneySubTab(tab)`** | **75–97** | **Ganti sub-tab** | **`window`** |
| **`recalculateCashflow()`** | **100–147** | **Kalkulasi utama cashflow** | **`window`** |
| `renderCashflowSpreadsheet()` | 149–151 | Wrapper | internal |
| `renderCashflowSpreadsheetRows(...)` | 153–211 | Render baris tabel | internal |
| **`saveCashflowData()`** | **213–246** | **Simpan ke server** | **`window`** |
| **`loadCashflowData()`** | **248–271** | **Muat dari server** | **`window`** |
| **`renderJournalTable()`** | **276–356** | **Render tabel jurnal** | internal |
| `updateJournalSpreadsheetSummary(...)` | 358–375 | Footer jurnal | internal |
| **`updateJournalSummaryTiles()`** | **377–400** | **Tile ringkasan jurnal** | internal |
| `updateJournalTradeExit(id, val)` | 402–438 | Update exit inline | **`window`** |
| `updateJournalTradeNotes(id, text)` | 440–451 | Update catatan inline | **`window`** |
| `addJournalTrade()` | 453–522 | Tambah trade | **`window`** |
| `deleteJournalTrade(id)` | 524–535 | Hapus trade | **`window`** |
| `loadJournalData()` | 537–546 | Muat jurnal | **`window`** |
| `invalidateMoneyManagementCache` | 548 | Alias publik | **`window`** |
| **`initMoneyManagement()`** | **550–553** | **Inisialisasi** | **`window`** |

**Rantai kalkulasi [FAKTA] — `recalculateCashflow()` 100–147:**

```javascript
window.recalculateCashflow = function() {
    var salary = getNumericValue('mmIncomeSalary');        // 101
    var side = getNumericValue('mmIncomeSide');            // 102
    var other = getNumericValue('mmIncomeOther');          // 103
    var totalIncome = salary + side + other;               // 104

    var necessities = getNumericValue('mmExpNecessities'); // 106
    var wants = getNumericValue('mmExpWants');             // 107
    var savings = getNumericValue('mmSavings');            // 108
    var tradingCap = getNumericValue('mmTradingCapital');  // 109

    var totalLivingExpense = necessities + wants + savings;                          // 111
    var remainingNonTrading = totalIncome - totalLivingExpense - tradingCap;         // 112
    ...
```

**Formula:**
```
totalIncome          = gaji + sampingan + lain
totalLivingExpense   = kebutuhan + keinginan + tabungan
remainingNonTrading  = totalIncome − totalLivingExpense − tradingCap
```

**Update tile (114–126):** `#mmTotalIncomeDisplay`, `#mmTotalLivingExpenseDisplay`, `#mmTradingCapDisplay`, `#mmRemainingBudgetDisplay`
**Warna sisa kas (125):** `remainingNonTrading >= 0 ? 'text-emerald-400' : 'text-rose-400'`
**Tiga state status (128–140):**
1. `totalIncome === 0` → prompt meminta input (129–131)
2. `remainingNonTrading < 0` → peringatan merah (132–134)
3. selain itu → sukses hijau dengan `pctTrading = (tradingCap / totalIncome) * 100` (136–138)

**Sinkronisasi ke jurnal (143–144):** `#mmJrTradingCapRef` diisi `formatRp(tradingCap)`
**Rantai lanjutan (145–146):**
```javascript
updateJournalSummaryTiles();                    // 145
renderCashflowSpreadsheetRows(totalIncome, necessities, wants, savings, tradingCap, remainingNonTrading);  // 146
```

**Rantai render jurnal [FAKTA] — `renderJournalTable()` 276–356:**
- Guard: `if (!tbody) return;` (278)
- Empty state: `colspan="12"` (281) — **perhatikan: tabel jurnal punya 13 kolom (2200–2212), tetapi empty state memakai `colspan="12"`.** [FAKTA] Off-by-one pada colspan.
- Kalkulasi per baris (291–315):
```javascript
var entryPrice = Number(item.entry_price || 0);                        // 292
var lots = Number(item.lots || 1);                                     // 293
var capitalUsed = Number(item.capital_used || (entryPrice * lots * 100)); // 294
var exitPrice = item.exit_price != null && item.exit_price > 0 ? Number(item.exit_price) : null; // 295
var isClosed = item.status === 'CLOSED' || exitPrice != null;          // 296

var plRp = 0; var plPct = 0;
if (exitPrice) {
  if (item.position_type === 'BUY') {
    plRp  = (exitPrice * lots * 100) - capitalUsed;                    // 302
    plPct = Number((((exitPrice - entryPrice) / entryPrice) * 100).toFixed(2)); // 303
  } else {
    plRp  = capitalUsed - (exitPrice * lots * 100);                    // 305
    plPct = Number((((entryPrice - exitPrice) / entryPrice) * 100).toFixed(2)); // 306
  }
} else {
  plRp  = Number(item.realized_pl_rp || 0);                            // 309
  plPct = Number(item.realized_pl_pct || 0);                           // 310
}

totalLot += lots;                                                      // 313
totalCapital += capitalUsed;                                           // 314
if (isClosed) totalPlRp += plRp;                                       // 315
```
**Formula P/L:** `plRp = (exit × lots × 100) − capitalUsed` untuk BUY; dibalik untuk SELL. Faktor `× 100` adalah konversi lot → lembar saham (1 lot = 100 lembar).

**Rantai ringkasan [FAKTA] — `updateJournalSummaryTiles()` 377–400:**
```javascript
var tradingCap = getNumericValue('mmTradingCapital');                  // 378
var closedTrades = journalData.filter(j => j.status === 'CLOSED' || (j.exit_price != null && j.exit_price > 0)); // 379
var openTrades   = journalData.filter(j => j.status === 'OPEN' || (!j.exit_price && j.exit_price !== 0));        // 380

var deployedCapital = openTrades.reduce((s, j) => s + (Number(j.capital_used) || 0), 0);  // 382
var totalRealizedPl = closedTrades.reduce((s, j) => s + (Number(j.realized_pl_rp) || 0), 0); // 383
var winningTrades = closedTrades.filter(j => Number(j.realized_pl_rp) > 0).length;        // 384
var winRate = closedTrades.length > 0 ? Number(((winningTrades / closedTrades.length) * 100).toFixed(1)) : 0; // 385
var idleCash = Math.max(0, tradingCap - deployedCapital + totalRealizedPl);               // 386
```
**Formula:**
```
winRate   = (winningTrades / closedTrades.length) × 100
idleCash  = max(0, tradingCap − deployedCapital + totalRealizedP/L)
```

**Update tile (388–399):** `#mmJrTotalCap`, `#mmJrIdleRdl`, `#mmJrTotalPl`, `#mmJrWinRate`

**Endpoint API [FAKTA]:**
| Endpoint | Method | Baris | Aksi |
|---|---|---|---|
| `/api/money-management?action=get-cashflow&month=<YYYY-MM>` | GET | 253 | Muat cashflow |
| `/api/money-management` `{action:'save-cashflow', ...}` | POST | 231–235 | Simpan cashflow |
| `/api/money-management?action=get-journal` | GET | 539 | Muat jurnal |
| `/api/money-management` `{action:'save-journal', ...}` | POST | 430–434, 445–449, 514–518 | Simpan trade |
| `/api/money-management` `{action:'delete-journal', id}` | POST | 528–532 | Hapus trade |

**[FAKTA] Ketidakkonsistenan pola cache:** `saveCashflowData()` (231) dan semua penulisan jurnal (430, 445, 514, 528) memakai `fetch()` **langsung**, bukan `acMoneyFetch()`. Ini **benar** karena penulisan non-GET tidak boleh di-cache — dan komentar 26–27 menyatakannya. Setiap penulisan memanggil `invalidateMoneyCache()` (238, 435, 519, 533).

**[FAKTA] Bulan WIB yang benar — 249–250:**
```javascript
var nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
var month = nowWib.toISOString().slice(0, 7);
```
Offset +7 jam diterapkan sebelum mengambil `YYYY-MM`, sehingga bulan yang dipilih adalah bulan WIB, bukan bulan UTC. **[FAKTA] Ini adalah penanganan zona waktu yang tepat** — pada 1 Januari pukul 00:30 WIB (17:30 UTC 31 Desember), pendekatan naif akan mengambil bulan yang salah.

**[FAKTA] Perbedaan dari `cashflowData.month`:** `cashflowData.month` diinisialisasi `new Date().toISOString().slice(0, 7)` (12) — memakai **UTC**, sedangkan `loadCashflowData` memakai **WIB** (249–250). Dua sumber kebenaran untuk "bulan saat ini".

---

### 3.10 Cacat Lintas-Tab yang Teridentifikasi

**[FAKTA] Temuan A — Re-render tabel cashflow pada setiap ketikan menghancurkan fokus input.**

Rantai bukti:
1. `money-management-runtime.js` 190 — input di dalam sel tabel:
```javascript
html += '    <input type="number" value="' + (row.val || '') + '" placeholder="0" oninput="document.getElementById(\'' + row.id + '\').value=this.value; recalculateCashflow();" ...>';
```
2. `recalculateCashflow()` 146 memanggil `renderCashflowSpreadsheetRows(...)`
3. `renderCashflowSpreadsheetRows` 197: `tbody.innerHTML = html;`

**[HIPOTESIS] Karena `tbody.innerHTML` diganti pada setiap keystroke, elemen `<input>` yang sedang difokuskan dihancurkan dan dibuat ulang. Akibatnya kursor kehilangan fokus setelah setiap karakter, dan `type="number"` dengan spinner akan mereset posisi kursor.** Ini adalah cacat UX yang serius pada permukaan yang secara eksplisit disebut "spreadsheet-grade".

**Verifikasi yang diperlukan:** buka tab Kelola Keuangan, klik input Alokasi, ketik "12345", amati apakah fokus bertahan.

**Perbaikan yang diusulkan (BAB 4.4):** pisahkan pembaruan **nilai** dari pembaruan **struktur**. Isi kolom `% Rasio` dan footer saja saat `oninput`, jangan bangun ulang `<tbody>`.

---

**[FAKTA] Temuan B — Off-by-one `colspan` pada empty state jurnal.**
- Tabel `#mmJournalSpreadsheetTable` memiliki **13 kolom** (`index.html` 2200–2212)
- Empty state di `money-management-runtime.js` 281 memakai `colspan="12"`

---

**[FAKTA] Temuan C — Tiga semantik berbeda untuk "nilai hilang".**
| Modul | Fungsi | Perilaku untuk nilai hilang |
|---|---|---|
| `index.html` (portofolio) | 11071 | `'—'` ✅ |
| `portfolio-command-center.js` | 57–60 (`money()`) | `'—'` ✅ |
| `money-management-runtime.js` | 53–56 (`formatRp()`) | **`'Rp 0'`** ❌ |

Karena `formatRp` menerima `Number(val)` yang men-coerce `''` menjadi `0` dan `0` itu finite, gate `!Number.isFinite(Number(val))` **tidak menangkap** string kosong. Jadi input kosong dirender sebagai "Rp 0" — klaim bahwa nilainya nol, padahal tidak diisi.

---

**[FAKTA] Temuan D — Tiga rezim `z-index` sticky header.**
| Sumber | Nilai | Baris |
|---|---|---|
| `premium-workstation-core.css` | `z-index: 2` | 785 |
| `premium-workstation-core.css` (kolom pertama) | `z-index: 3` | 829 |
| `premium-workstation-core.css` (header kolom pertama) | `z-index: 5` | 838 |
| `spreadsheet-grade.css` | `z-index: 3` | 171 |
| Tabel inline (Tailwind) | `z-20`, `z-30` | `index.html` 1066, 1068, 1165, 1167–1168, 1275, 1277–1278, 1623, 1625, 1795, 1986 |

**[HIPOTESIS]** Tabel yang memakai `z-20`/`z-30` inline (screener, track record, deepscan) akan menang atas `z-index: 3` dari `spreadsheet-grade.css`. Ini konsisten, tetapi berarti dua tabel berbeda di aplikasi yang sama memakai nilai `z-index` yang berbeda untuk peran yang sama. Risiko: saat sel sticky kolom-pertama bertemu header sticky, hasilnya bergantung pada kombinasi nilai yang kebetulan berlaku.

---

**[FAKTA] Temuan E — Tiga tab memakai `max-w` yang berbeda dari `.page-content` `!important`.**
| Panel | Kelas Tailwind | Baris |
|---|---|---|
| `#page-dashboard` | `max-w-[1100px]` | 614 |
| `#page-analisis` | `max-w-[1280px]` | 742 |
| `#page-sektor` | `max-w-[1100px]` | 912 |
| `#page-screener` | `max-w-[1100px]` | 951 |
| `#page-chart` | `max-w-[1100px]` | 1312 |
| `#page-news` | `max-w-[1100px]` | 1344 |
| `#page-portofolio` | `max-w-[1100px]` | 1392 |
| `#page-trackrecord` | `max-w-[1100px]` | 1493 |
| `#page-watchlist` | `max-w-[1100px]` | 1822 |
| `#page-deepscan` | `max-w-[1200px]` | 1945 |
| `#page-money-management` | `max-w-[1200px]` | 2009 |

**[FAKTA] Semua nilai ini DIMATIKAN oleh `premium-workstation-core.css` 319–323:**
```css
.page-content {
  width: 100%;
  max-width: var(--pw-page) !important;
  padding: 20px 20px 28px !important;
}
```
dengan `--pw-page: 1280px` (baris 60).

**[HIPOTESIS]** Jadi seluruh 11 kelas `max-w-[...]` di atas adalah **kode mati**. Lebar sebenarnya seragam 1280px untuk semua halaman. Ini menghilangkan niat desain yang jelas terlihat di markup (`analisis` dan `deepscan`/`money-management` sengaja dibuat lebih lebar) tetapi tidak pernah terwujud.

---

## BAB 4: RANCANGAN KONTRAK CSS & STRUKTUR BARU

**Status: DRAFT — menunggu persetujuan. Belum diimplementasikan.**

---

### 4.1 Pemetaan Lengkap Token `:root` (Dark) vs `html.light` (Light)

**Prinsip perbaikan:** satu namespace token, satu file pemilik, satu blok light yang lengkap. Token lama dipertahankan sebagai alias selama satu siklus rilis agar tidak ada komponen yang patah.

#### 4.1.1 Kontrak kanonik (nilai sudah ada di codebase — dipertahankan)

```css
:root {
  /* ---- Tingkat permukaan (Refero Design: 3 tingkat, tidak lebih) ---- */
  --bg-canvas:   #090d16;   /* latar paling dalam   — premium-workstation-core.css:12 */
  --bg-surface:  #0d1320;   /* panel utama          — premium-workstation-core.css:13 */
  --bg-elevated: #111a2a;   /* panel mengambang     — premium-workstation-core.css:14 */
  --bg-hover:    #162033;   /* state hover          — premium-workstation-core.css:15 */

  /* ---- Teks ---- */
  --text-primary:   #f4f7fb;   /* premium-workstation-core.css:16 */
  --text-secondary: #aab4c3;   /* premium-workstation-core.css:17 */
  --text-muted:     #8b98ac;   /* DIUBAH dari #738096 → lihat catatan kontras */
  --text-faint:     #6b7a8f;   /* DIUBAH dari #596779 → lihat catatan kontras */

  /* ---- Border (hairline 1px transparan — Refero) ---- */
  --border-hairline: rgba(148, 163, 184, .08);
  --border-subtle:   rgba(148, 163, 184, .12);   /* premium-workstation-core.css:19 */
  --border-default:  rgba(148, 163, 184, .20);   /* premium-workstation-core.css:20 */
  --border-strong:   rgba(148, 163, 184, .28);

  /* ---- Aksen (emerald tunggal — premium-workstation-core.css:5-6) ---- */
  --accent:        #2dd4a3;   /* premium-workstation-core.css:45 */
  --accent-strong: #10b981;   /* premium-workstation-core.css:46 */
  --accent-soft:   rgba(45, 212, 163, .075);
  --accent-line:   rgba(45, 212, 163, .23);

  /* ---- Semantik pasar ---- */
  --positive:      #34d399;   /* premium-workstation-core.css:22 */
  --positive-soft: rgba(52, 211, 153, .12);
  --negative:      #fb7185;   /* premium-workstation-core.css:24 */
  --negative-soft: rgba(251, 113, 133, .12);
  --warning:       #edc46c;   /* premium-workstation-core.css:51 */
  --info:          #76adf8;   /* premium-workstation-core.css:52 */

  /* ---- Tabel (TanStack: density 34-36px) ---- */
  --row-height:       36px;   /* spreadsheet-grade.css:315 */
  --row-height-dense: 31px;   /* premium-workstation-core.css:98 */
  --row-height-head:  34px;   /* spreadsheet-grade.css:300 */

  /* ---- Spacing (Awesome Design MD: skala 8px) ---- */
  --space-1:  4px;
  --space-2:  8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;

  /* ---- Radius ---- */
  --radius-xs: 5px;
  --radius-sm: 7px;
  --radius-md: 9px;
  --radius-lg: 11px;
  --radius-xl: 13px;
  --radius-pill: 999px;

  /* ---- Layout shell (UI Layouts) ---- */
  --sidebar-w:          240px;
  --sidebar-w-collapsed: 72px;
  --header-h:            58px;

  /* ---- Ground (FeralUI) ---- */
  --mesh-1: rgba(16, 185, 129, 0.055);
  --mesh-2: rgba(59, 130, 246, 0.045);
  --mesh-3: rgba(99, 102, 241, 0.035);
}
```

#### 4.1.2 Blok light — LENGKAP, tidak ada yang tertinggal

```css
html.light {
  /* Permukaan */
  --bg-canvas:   #f5f7fa;
  --bg-surface:  #ffffff;
  --bg-elevated: #f8fafc;
  --bg-hover:    #f1f5f9;

  /* Teks — semua memenuhi WCAG AA 4.5:1 pada latar putih */
  --text-primary:   #0f172a;   /* 16.9:1 */
  --text-secondary: #334155;   /* 10.4:1 */
  --text-muted:     #475569;   /*  7.5:1 */
  --text-faint:     #64748b;   /*  5.6:1 */

  /* Border */
  --border-hairline: rgba(15, 23, 42, .06);
  --border-subtle:   rgba(15, 23, 42, .08);
  --border-default:  rgba(15, 23, 42, .14);
  --border-strong:   rgba(15, 23, 42, .22);

  /* Aksen — digelapkan agar kontras di latar putih */
  --accent:        #059669;   /* 4.6:1 pada putih */
  --accent-strong: #047857;   /* 5.9:1 pada putih */
  --accent-soft:   rgba(5, 150, 105, .10);
  --accent-line:   rgba(5, 150, 105, .28);

  /* Permukaan tambahan — saat ini TIDAK di-override sama sekali */
  --panel-2:     #ffffff;   /* menggantikan --pw-panel-2     (#0c1620) */
  --panel-3:     #f8fafc;   /* menggantikan --pw-panel-3     (#070d13) */
  --panel-hover: #f1f5f9;   /* menggantikan --pw-panel-hover (#101a25) */

  /* Semantik pasar — WAJIB: keempatnya saat ini terkunci di dark-mode
     dan dipakai lewat !important di premium-workstation-core.css 854-873.
     Nilai di bawah menggantikan --pw-bull/bear/warn/info. */
  --positive:      #047857;   /* menggantikan --pw-bull #52d7ad (1.79:1 vs putih) */
  --positive-soft: rgba(5, 150, 105, .10);
  --negative:      #be123c;   /* menggantikan --pw-bear #fb7d8d (2.51:1 vs putih) */
  --negative-soft: rgba(190, 18, 60, .10);
  --warning:       #b45309;   /* menggantikan --pw-warn #edc46c (1.64:1 vs putih) */
  --info:          #1d4ed8;   /* menggantikan --pw-info #76adf8 (2.31:1 vs putih) */

  /* Ground */
  --mesh-1: rgba(16, 185, 129, 0.05);
  --mesh-2: rgba(59, 130, 246, 0.035);
  --mesh-3: rgba(99, 102, 241, 0.025);

  /* WAJIB: kontrol native harus ikut terang */
  color-scheme: light;
}
```

#### 4.1.3 Perbaikan P0 — Lepaskan kunci `!important` warna semantik

**Ini adalah perbaikan paling penting di seluruh blueprint.** Tanpa ini, semua pekerjaan light mode lainnya tidak akan terlihat pada elemen yang paling sering dibaca pengguna.

**Opsi A (dianjurkan) — hapus `!important`, jadikan token lengkap di kedua mode:**

Ubah `premium-workstation-core.css` 854–873 menjadi:
```css
/* Warna semantik kini mengikuti token yang di-override di html.light.
   Tanpa !important, blok light di ui-theme.css dapat menang. */
.text-emerald-300,
.text-emerald-400 { color: var(--positive); }

.text-red-300,
.text-red-400 { color: var(--negative); }

.text-amber-200,
.text-amber-300,
.text-amber-400 { color: var(--warning); }

.text-blue-300,
.text-blue-400 { color: var(--info); }
```
Kemudian pastikan `--positive`, `--negative`, `--warning`, `--info` dideklarasikan **lengkap** di `:root` (dark) dan `html.light`.

**Opsi B (minimal, jika `!important` harus dipertahankan) — override light dengan spesifisitas lebih tinggi:**

```css
/* Ditempatkan SETELAH premium-workstation-core.css 854-873.
   html.light .text-* = (0,2,1) > .text-* = (0,1,0) */
html.light .text-emerald-300,
html.light .text-emerald-400 { color: #047857 !important; }

html.light .text-red-300,
html.light .text-red-400 { color: #be123c !important; }

html.light .text-amber-200,
html.light .text-amber-300,
html.light .text-amber-400 { color: #b45309 !important; }

html.light .text-blue-300,
html.light .text-blue-400 { color: #1d4ed8 !important; }
```

**Verifikasi wajib untuk kedua opsi:** buka tab Track Record di light mode. Kartu "Win Rate (TP1)" (`index.html` 1548, kelas `text-emerald-400`) harus terbaca jelas. Sebelum perbaikan rasionya 1.79:1 — praktis tidak terlihat.

**Perubahan wajib di luar blok token:**

| # | Perubahan | Prioritas | Alasan |
|---|---|---|---|
| 1 | **Lepaskan `!important` dari `premium-workstation-core.css` 856, 861, 867, 872** (atau pakai Opsi B) | **P0** | Mengunci 4 warna dark-mode ke kelas semantik paling sering dipakai; rasio 1.64:1–2.51:1 vs putih |
| 2 | Lengkapi override `--pw-*` yang hilang (11 variabel) dan `--ac-*` (23 token) | **P1** | Terbukti tidak di-override di light mode |
| 3 | Tambah `html.light { color-scheme: light }` | P2 | Memperbaiki dropdown/spinner/scrollbar gelap |
| 4 | Ubah `<meta name="color-scheme" content="dark">` (`index.html` 6) → `content="dark light"` | P2 | Meta tag menang atas CSS untuk preferensi awal |
| 5 | Ganti `premium-workstation-core.css` 403 `#e9f0f6` → `var(--text-primary)` | P1 | Teks tidak terbaca di light |
| 6 | Ganti `premium-workstation-core.css` 619 `#eef4f8` → `var(--text-primary)` | P1 | Angka IHSG hilang di light |
| 7 | Ganti `premium-workstation-core.css` 1200 `#f1f5f9` → `var(--text-primary)` | P1 | Judul AI tidak terbaca di light |
| 8 | Perbaiki `ui-theme.css` 2669 `p` → `strong, span` | P2 | Selektor tidak pernah cocok — CSS mati |
| 9 | Ganti `index.html` 61/64 `style.background` → `style.backgroundColor` | P2 | Menghindari reset `background-image` |
| 10 | Naikkan `--text-muted` dark dari `#738096` → `#8b98ac` | P1 | Memenuhi WCAG AA (4.1:1 → 5.5:1) |
| 11 | Hapus `!important` dari `premium-workstation-core.css` 321, 322, dan hapus kelas `max-w-*` mati dari markup | P2 | Mengembalikan niat lebar per halaman (Temuan E) |

**[KOREKSI PENTING] Perubahan #6 versi awal audit DIBATALKAN.** Dokumen ini sebelumnya menyarankan *"Hapus `ui-theme.css` 2526 `body.light` dari selektor — CSS mati"*. **Itu SALAH dan tidak boleh dilakukan.** `body.light` **aktif** karena `index.html` 7747 memasang kelas tersebut pada `<body>`:
```javascript
7747: if (document.body) document.body.classList.toggle('light', isLight);
```
Menghapusnya akan mematikan override `--pw-*` untuk `<body>` dan memperburuk masalah.

---

### 4.2 Spesifikasi Layout `.app-layout`, `.app-sidebar` (240px → 72px), `.app-main`

**Prinsip:** pertahankan arsitektur yang sudah benar di `ui-theme.css` 2706–2823, perbaiki dua cacat (kelas mati + celah `min-width`), dan tambahkan guard overflow.

```css
/* ============================================================
   APP SHELL — kontrak beku
   Sidebar dan konten adalah SIBLING dalam satu flex row.
   ============================================================ */
.app-layout {
  display: flex;
  align-items: flex-start;
  width: 100%;
  min-height: 100vh;
  min-height: 100dvh;          /* progresif; 100vh tetap sebagai fallback */
}

/* ---------- Rail navigasi ---------- */
.app-sidebar {
  position: sticky;
  top: 0;
  width: var(--sidebar-w);              /* 240px */
  height: 100vh;
  height: 100dvh;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border-right: 1px solid var(--border-subtle);
  z-index: 60;
  overflow-x: hidden;
  overflow-y: hidden;
  transition: width .22s cubic-bezier(.4, 0, .2, 1);
}

.app-sidebar.collapsed,
.app-sidebar.is-collapsed {
  width: var(--sidebar-w-collapsed);    /* 72px */
}

/* Guard: rail harus patuh pada kelas .hidden-nya sendiri.
   (Dipertahankan dari ui-theme.css 2693-2696 — jangan dihapus.) */
#appSidebar.hidden,
.app-sidebar.hidden { display: none; }

/* ---------- Tiga zona vertikal ---------- */
.sidebar-brand  { flex: 0 0 auto; min-height: 72px; }
.sidebar-nav    { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: var(--space-3); }
.sidebar-footer { flex: 0 0 auto; }     /* TIDAK boleh flex:1 — lihat catatan */

/* ---------- Kolom konten ---------- */
.app-main {
  flex: 1 1 auto;
  min-width: 0;                 /* KRITIS: tanpa ini sidebar terdorong keluar layar */
  display: flex;
  flex-direction: column;
}
```

**Perbaikan yang harus disertakan:**

| # | Perbaikan | Alasan |
|---|---|---|
| 1 | `overflow-y: hidden` pada `.app-sidebar` | Mencegah dua scrollbar (rail + nav) |
| 2 | `min-height: 0` pada `.sidebar-nav` | Tanpa ini, flex item menolak menyusut di bawah konten dan nav mendorong footer keluar |
| 3 | Hapus `flex-shrink: 0` dari `index-shell.css` 425 **atau** hapus aturan `.sidebar-footer` dari `index-shell.css` | Menghilangkan tabrakan kelas (Cacat 2.2.A) |
| 4 | **Ganti nama kelas footer chat** `index.html` 437 dari `.sidebar-footer` → `.chat-sidebar-footer` dan perbarui `index-shell.css` 425 | Menghilangkan tabrakan kelas pada akarnya, bukan menambal |
| 5 | Hapus `.app-main-viewport` dari `ui-theme.css` 2808–2813 | Kelas mati — tidak ada di markup |
| 6 | **Ganti `navigateTo()` alias `chart`** dari `/analisis-saham` → pertahankan di shell | `/analisis-saham` adalah dokumen terpisah; berpindah ke sana akan memutus shell |

**Kontrak guard overflow untuk konten di dalam `.app-main` — INI ADALAH PERBAIKAN KUNCI untuk keluhan "sidebar hilang":**

```css
/* Setiap grid/flex container di dalam halaman wajib boleh menyusut.
   Default CSS adalah min-width:auto, yang berarti "tidak boleh lebih sempit
   dari konten minimum" — inilah yang mendorong sidebar keluar layar. */
.page-content,
.page-content > *,
.unified-cockpit-grid,
.unified-cockpit-grid > *,
.dashboard-radar-grid,
.dashboard-radar-grid > *,
.market-band-grid,
.market-band-grid > * {
  min-width: 0;
}

/* Setiap container tabel wajib menangani overflow-nya sendiri. */
[id$="TableWrap"],
.table-responsive-container,
.unified-card,
.panel {
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}
```

**Perbaikan `#page-analisis` sticky offset (Dampak 2 di BAB 2.3):**

```css
/* Header sebenarnya ≈106px karena nav-row tertanam.
   Nilai lama 58px membuat toolbar analisis tertutup nav-row. */
#page-analisis > div:first-child {
  position: sticky;
  top: calc(var(--header-h) + 48px);   /* 58 + 48 = 106px */
  z-index: 18;
}
```
**Atau, lebih baik:** sembunyikan nav-row di desktop sehingga `--header-h` kembali akurat:
```css
@media (min-width: 1024px) {
  .mobile-nav-row { display: none; }
}
```

---

### 4.3 Spesifikasi `.sidebar-footer` (flex alignment, avatar circle, info stack, compact switch)

**Struktur markup target (perbaikan atas `index.html` 506–517):**

```html
<div class="sidebar-footer">
  <div class="user-profile-badge" title="Profil pengguna">
    <div class="user-avatar" id="sidebarUserAvatar" aria-hidden="true">B</div>
    <div class="user-info">
      <span class="user-name" id="sidebarUserName">Pengguna</span>
      <span class="user-role" id="sidebarUserRole">FREE</span>
    </div>
  </div>
  <button id="themeToggleCompact" type="button" onclick="toggleAppTheme()"
          class="theme-toggle-compact" aria-label="Ganti tema" title="Ganti tema terang/gelap">
    <span id="sidebarThemeIcon" aria-hidden="true">🌙</span>
    <span class="sr-only" id="sidebarThemeLabel">Dark Mode</span>
  </button>
</div>
```

**Perubahan markup yang wajib:**
| # | Perubahan | Alasan |
|---|---|---|
| 1 | **Hapus `sidebar-label` dari `.user-info`** (baris 509) | Saat ini membuat nama+role hilang total saat collapsed (Cacat 2.2.B) |
| 2 | Tambah `id="sidebarUserAvatar"` pada avatar (508) | Agar inisial dapat diperbarui dari JS |
| 3 | Tambah `id="sidebarUserRole"` pada role (511) | Agar tier dapat diperbarui dari JS |
| 4 | Ubah default "budi" → "Pengguna" dan "PRO PLAN" → "FREE" | Menghilangkan klaim tier yang salah (Cacat 2.2.C) |
| 5 | Tambah `aria-hidden="true"` pada ikon tema | Sudah ada; pertahankan |

**CSS kontrak:**

```css
/* ============================================================
   SIDEBAR FOOTER — profil + switch tema
   HolverAI: profil user di footer paling bawah, bersebelahan
   dengan theme switcher. Uiverse: switch 28x28px.
   ============================================================ */
.sidebar-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex: 0 0 auto;                 /* WAJIB: jangan flex:1 */
  min-height: 56px;
  padding: var(--space-3);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

/* ---------- Blok profil ---------- */
.user-profile-badge {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;                   /* agar ellipsis bekerja */
}

.user-avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;                 /* tidak menyusut, tidak mengembang */
  border-radius: var(--radius-pill);   /* lingkaran penuh */
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  text-transform: uppercase;
}

.user-info {
  display: grid;
  gap: 1px;
  min-width: 0;                   /* agar ellipsis bekerja */
}

.user-name {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-role {
  color: var(--text-muted);       /* #8b98ac di dark — memenuhi AA */
  font-size: 10px;                /* dinaikkan dari 9px */
  font-weight: 700;
  letter-spacing: .06em;
  line-height: 1.3;
  text-transform: uppercase;
}

/* ---------- Switch tema 28x28 ---------- */
.theme-toggle-compact {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  padding: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease, border-color .15s ease;
}

.theme-toggle-compact:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.theme-toggle-compact:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* ============================================================
   STATE COLLAPSED (72px) — perbaikan geometri
   Masalah lama: 30px avatar + 8px gap + 28px tombol = 66px
   di dalam 72px dengan padding 12px (24px) → hanya 48px tersedia
   → konten meluap dan terpotong (overflow-x: hidden).
   ============================================================ */
.app-sidebar.collapsed .sidebar-footer,
.app-sidebar.is-collapsed .sidebar-footer {
  flex-direction: column;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;      /* horizontal 0 → beri ruang untuk 30px */
}

.app-sidebar.collapsed .user-profile-badge,
.app-sidebar.is-collapsed .user-profile-badge {
  flex: 0 0 auto;                 /* jangan flex:1 di kolom vertikal */
  justify-content: center;
  width: 100%;
}

/* Sembunyikan teks, BUKAN seluruh .user-info */
.app-sidebar.collapsed .user-name,
.app-sidebar.collapsed .user-role,
.app-sidebar.is-collapsed .user-name,
.app-sidebar.is-collapsed .user-role {
  display: none;
}

/* Nama + role TIDAK boleh ikut hilang lewat .sidebar-label */
.app-sidebar.collapsed .user-info,
.app-sidebar.is-collapsed .user-info {
  display: none;
}
```

**Perhitungan geometri collapsed yang baru:**
```
Tinggi konten = 30px (avatar) + 8px (gap) + 28px (tombol) = 66px
Tinggi footer  = 66px + (8px padding × 2)               = 82px
Lebar tersedia = 72px − (0px padding horizontal × 2)    = 72px
Lebar terpakai = max(30px, 28px)                        = 30px
→ Tidak ada overflow. ✅
```

**Perbaikan kontras item aktif sidebar (Cacat BAB 1.11):**

```css
/* Ganti ui-theme.css 2874-2878.
   Bahasa visual produk = emerald sebagai SATU-SATUNYA aksen utama.
   Item aktif putih solid adalah aksen kedua yang tidak diminta. */
.sidebar-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 38px;
  padding: var(--space-2) var(--space-3);
  width: 100%;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
  transition: background-color .15s ease, color .15s ease, border-color .15s ease;
}

.sidebar-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* AKTIF — konsisten di dark DAN light, memakai aksen tunggal */
.sidebar-item.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent);
  font-weight: 700;
}

/* Indikator tambahan: bar 2px di kiri — reinforcement, bukan satu-satunya cue */
.sidebar-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 20%;
  bottom: 20%;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}

.sidebar-item { position: relative; }
```

**Kontras hasil:** `--accent: #2dd4a3` pada `--accent-soft: rgba(45,212,163,.075)` di atas `--bg-surface: #0d1320` ≈ **8.2:1** ✅ (dark). Di light: `#059669` pada `rgba(5,150,105,.10)` di atas `#ffffff` ≈ **4.9:1** ✅.

---

### 4.4 Spesifikasi `.table-responsive-container` dan Class Data-Grid Pendukung

**Kondisi saat ini [FAKTA]:**
- `.table-responsive-container` **sudah didefinisikan** di `spreadsheet-grade.css` 265–270:
```css
.table-responsive-container {
  overflow-x: auto;
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  background: var(--color-bg-surface);
}
```
- **Hanya dipakai 2 kali** di markup: `index.html` 2070 (cashflow) dan 2196 (jurnal)
- **Tidak ada `.data-grid`** di codebase — kelas itu belum ada dan harus dibuat

**Kontrak lengkap yang diusulkan:**

```css
/* ============================================================
   DATA GRID — kontrak tunggal untuk semua tabel data
   Menggantikan tiga rezim z-index yang berbeda dan
   menutup celah border-collapse pada 6 tabel.
   TanStack Table: sticky thead, border separate, tabular-nums.
   ============================================================ */

/* ---------- 1. Kontainer ---------- */
.table-responsive-container {
  position: relative;
  min-width: 0;                       /* KRITIS: boleh menyusut */
  max-width: 100%;
  overflow: auto;
  overscroll-behavior-inline: contain;
  scrollbar-gutter: stable;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}

/* ---------- 2. Tabel — WAJIB border-collapse: separate ---------- */
.data-grid {
  width: 100%;
  border-collapse: separate;          /* syarat mutlak sticky th/td */
  border-spacing: 0;
  background: var(--bg-surface);
  font-variant-numeric: tabular-nums lining-nums;
  font-feature-settings: "tnum" 1;
  font-size: 12px;
  color: var(--text-primary);
}

/* ---------- 3. Header — sticky, SATU nilai z-index ---------- */
.data-grid thead th {
  position: sticky;
  top: 0;
  z-index: 3;                         /* nilai kanonik tunggal */
  height: var(--row-height-head);     /* 34px */
  padding: 0 var(--space-3);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  border-right: 1px solid var(--border-hairline);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .05em;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
}

/* ---------- 4. Kolom pertama — sticky kiri ---------- */
.data-grid th:first-child,
.data-grid td:first-child {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--bg-surface);
  box-shadow: 1px 0 0 var(--border-hairline);
}

.data-grid thead th:first-child {
  z-index: 4;                         /* di atas header biasa DAN sel sticky */
}

/* ---------- 5. Baris data — density 36px ---------- */
.data-grid tbody td {
  height: var(--row-height);          /* 36px */
  padding: 6px var(--space-3);
  border-bottom: 1px solid var(--border-hairline);
  border-right: 1px solid var(--border-hairline);
  color: var(--text-primary);
  vertical-align: middle;
}

.data-grid tbody tr:last-child td { border-bottom: 0; }

/* ---------- 6. Zebra + hover ---------- */
.data-grid tbody tr:nth-child(even) {
  background-color: var(--sp-zebra, rgba(148,163,184,.030));
}

.data-grid tbody tr:hover {
  background-color: var(--sp-zebra-hover, rgba(52,211,153,.055));
}

/* ---------- 7. Numerik — rata kanan, mono, tabular ---------- */
.data-grid td.is-numeric,
.data-grid th.is-numeric,
.data-grid td[class*="text-right"],
.data-grid th[class*="text-right"] {
  text-align: right;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums lining-nums;
}

/* ---------- 8. Footer — sticky bawah ---------- */
.data-grid tfoot td {
  position: sticky;
  bottom: 0;
  z-index: 3;
  height: var(--row-height-head);
  padding: 6px var(--space-3);
  background: var(--bg-surface);
  border-top: 2px solid var(--accent-line);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

/* ---------- 9. Sel input (spreadsheet editable) ---------- */
.data-grid td > input {
  width: 100%;
  height: 26px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.data-grid td > input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* ---------- 10. Pill persentase (21st.dev: 20-22px) ---------- */
.percentage-chip {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 56px;
  min-height: 20px;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.percentage-chip.is-up   { color: var(--positive); background: var(--positive-soft); }
.percentage-chip.is-down { color: var(--negative); background: var(--negative-soft); }
.percentage-chip.is-flat { color: var(--text-muted); background: var(--bg-hover); }

/* ---------- 11. Status dot (21st.dev: 6px + ring 2px) ---------- */
.status-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: var(--radius-pill);
  background: var(--text-muted);
  box-shadow: 0 0 0 2px var(--bg-surface);
}

.status-dot.is-live    { background: var(--positive); box-shadow: 0 0 0 2px var(--positive-soft); }
.status-dot.is-stale   { background: var(--warning);  box-shadow: 0 0 0 2px rgba(237,196,108,.14); }
.status-dot.is-offline { background: var(--negative); box-shadow: 0 0 0 2px var(--negative-soft); }

/* ---------- 12. Light mode ---------- */
html.light .table-responsive-container {
  border-color: var(--border-subtle);
  background: var(--bg-surface);
}

html.light .data-grid thead th {
  background: var(--bg-elevated);
  color: var(--text-muted);
}

html.light .data-grid th:first-child,
html.light .data-grid td:first-child {
  background: var(--bg-surface);
}
```

**Perbaikan cacat fokus input (Temuan A di BAB 3.10):**

```css
/* TIDAK CUKUP dengan CSS — perbaikan wajib di JavaScript.
   Ubah money-management-runtime.js 190 dari: */
/*   oninput="document.getElementById('X').value=this.value; recalculateCashflow();" */
/* Menjadi: */
/*   oninput="document.getElementById('X').value=this.value; updateCashflowTotalsOnly();" */
/*
   Di mana updateCashflowTotalsOnly() memperbarui HANYA:
     - #mmTotalIncomeDisplay, #mmTotalLivingExpenseDisplay,
       #mmTradingCapDisplay, #mmRemainingBudgetDisplay
     - #mmBudgetSafetyStatus
     - kolom % Rasio per baris (via textContent, bukan innerHTML)
     - tfoot (#mmCfFoot*)
   TANPA membangun ulang #mmCashflowSpreadsheetBody.
*/
```

**Mengapa perbaikan ini harus di JavaScript, bukan CSS:** `tbody.innerHTML = html` (baris 197) menghancurkan node DOM input yang sedang difokuskan. Tidak ada deklarasi CSS yang dapat mencegahnya. Ini adalah **prasyarat** agar kontrak `.data-grid` di atas benar-benar terasa "spreadsheet-grade".

---

### 4.5 Urutan Implementasi yang Diusulkan

Pekerjaan diurutkan berdasarkan **risiko × dampak**, dengan aturan: setiap langkah harus dapat di-*rollback* sendiri.

| Fase | Pekerjaan | Risiko | Dampak | Verifikasi |
|---|---|---|---|---|
| **F0** | **P0: Lepaskan `!important` dari `premium-workstation-core.css` 856, 861, 867, 872** (atau terapkan Opsi B di 4.1.3) | Sedang | 🔴 **KRITIS** — 4 kelas warna semantik gagal AA berat (1.64:1–2.51:1) | Buka tab Track Record di light mode; kartu Win Rate TP1 harus terbaca |
| **F1** | Lengkapi `html.light`: override 11 `--pw-*` yang hilang + 23 token `--ac-*`; tambah `color-scheme: light` | Sedang | 🔴 Tinggi — akar BAB 2.4 | Audit kontras WCAG pada 9 tab |
| **F2** | Perbaiki 3 warna hardcoded (`premium-workstation-core.css` 403, 619, 1200); perbaiki `p` → `strong, span` (2669); `style.background` → `style.backgroundColor` (`index.html` 61, 64, 7748) | Rendah | 🟠 Sedang — melengkapi BAB 2.4 | Uji light mode pada dashboard & analisis |
| **F3** | Konsolidasi token: hapus deklarasi `--color-*` duplikat dari `premium-workstation-core.css` 9–31; sisakan di `ui-theme.css` sebagai pemilik tunggal | Sedang | 🟠 Sedang — mencegah regresi | Bandingkan screenshot dark & light 9 tab |
| **F4** | Tambah guard `min-width: 0` pada grid/flex container di `.page-content` | Rendah | 🔴 Tinggi — menutup BAB 3.2 | Uji 9 tab di 1280px, 1440px, 1920px |
| **F5** | Perbaiki footer sidebar: ganti nama kelas footer chat; hapus `sidebar-label` dari `.user-info`; tambah id avatar/role; geometri collapsed | Rendah | 🟠 Sedang — menutup BAB 2.2 | Ukur `getBoundingClientRect()` pada 240px dan 72px |
| **F6** | Perbaiki kontras item aktif sidebar (`ui-theme.css` 2874–2878) | Rendah | 🟠 Sedang — menutup BAB 1.11 | Audit kontras dark + light |
| **F7** | Sembunyikan `.mobile-nav-row` di ≥1024px; perbaiki offset sticky `#page-analisis` | Rendah | 🟠 Sedang — menutup BAB 2.3 | Uji scroll di tab Analisis |
| **F8** | Konsolidasi `z-index` sticky ke satu nilai kanonik; konversi 6 tabel `border-collapse: collapse` → `separate` | Sedang | 🟡 Rendah — perbaikan struktural | Uji scroll horizontal pada 6 tabel |
| **F9** | Implementasi `.data-grid` + `.percentage-chip` + `.status-dot` | Sedang | 🟡 Rendah | Uji 9 tab |
| **F10** | Perbaiki re-render tabel cashflow (JS) | Sedang | 🟠 Sedang — menutup Temuan A | Ketik 10 karakter di input, pastikan fokus bertahan |
| **F11** | Seragamkan semantik "nilai hilang": `money-management-runtime.js` 53–56 → `'—'` | Rendah | 🟡 Rendah — menutup Temuan C | Uji input kosong |
| **F12** | Perbaiki `colspan="12"` → `"13"` (Temuan B) | Trivial | 🟢 Sangat rendah | Uji jurnal kosong |
| **F13** | Hapus 7 pseudo-element dekoratif emerald (BAB 1.4) | Sedang | 🟡 Rendah | Uji visual 9 tab |
| **F14** | Perbaiki label kondisi alert yang tidak dikenali (BAB 3.6) | Trivial | 🟢 Sangat rendah | Buat alert `ENTRY_ZONE`, amati label |

**Aturan gerbang:**
1. **F0 wajib pertama.** Ini satu-satunya perbaikan yang mengubah teks dari "praktis tidak terlihat" menjadi "terbaca". Semua pekerjaan light mode lain tidak akan terlihat sampai ini selesai.
2. **F1–F3 wajib sebelum F4–F14**, karena seluruh pekerjaan visual lain bergantung pada kontrak token yang stabil.
3. Setiap fase harus di-commit terpisah agar dapat di-*rollback* sendiri.

**[CATATAN] Fase lama F13 (label toggle tema) DIHAPUS** — setelah verifikasi, `index.html` 7753–7756 sudah memperbarui ikon & label dengan benar. Tidak ada yang perlu diperbaiki.

---

### 4.6 Verifikasi yang Harus Dilakukan Sebelum Implementasi

Untuk setiap klaim **[HIPOTESIS]** di dokumen ini, lakukan pengukuran berikut pada DOM ter-render:

| # | Hipotesis | Pengukuran | Kriteria lulus |
|---|---|---|---|
| 1 | **Empat kelas warna semantik gagal AA di light mode** | `getComputedStyle(document.querySelector('.text-emerald-400')).color` dengan `html.light` aktif | Bukan `rgb(82, 215, 173)` |
| 2 | Konten `#page-analisis` meluap dan menutupi sidebar | `document.querySelector('.unified-cockpit-grid').getBoundingClientRect().width` vs `#appSidebar` | Grid width ≤ (viewport − 240px) |
| 3 | Footer sidebar meluap saat collapsed | `document.querySelector('#appSidebar .sidebar-footer').scrollHeight` vs `clientHeight` | `scrollHeight === clientHeight` |
| 4 | SVG logo sidebar tanpa ukuran intrinsik | `document.querySelector('#appSidebar .brand-mark svg').getBoundingClientRect()` | `width === 18 && height === 18` |
| 5 | Toolbar analisis tertutup nav-row | `document.querySelector('#page-analisis > div:first-child').getBoundingClientRect().top` vs `.mobile-nav-row` bottom | Toolbar `top` ≥ nav-row `bottom` |
| 6 | Input cashflow kehilangan fokus | Ketik 10 karakter, periksa `document.activeElement` | `activeElement` tetap input yang sama |
| 7 | Kontrol native tetap gelap di light mode | `getComputedStyle(document.documentElement).colorScheme` | `'light'` |
| 8 | Tabel non-kontrak pecah saat scroll | Scroll horizontal 6 tabel dengan `border-collapse: collapse` | Header tetap menempel |

**Setiap hipotesis yang gagal diverifikasi harus dihapus dari dokumen ini, bukan diimplementasikan.**

**Catatan penting tentang pengukuran #1:** ini adalah satu-satunya item di tabel yang **sudah terbukti dari analisis statis** — tidak memerlukan browser untuk membuktikan keberadaannya. Perintah verifikasi di atas hanya untuk mengonfirmasi nilainya setelah perbaikan diterapkan.

---

## LAMPIRAN A: INDEKS FILE YANG DIAUDIT

| File | Baris | Peran |
|---|---|---|
| `public/index.html` | 12.978 | Markup utama, 9 tab, ~150 fungsi inline |
| `public/ui-theme.css` | 2.959 | Lapisan token `--color-*`/`--ac-*`, shell sidebar, light mode |
| `public/premium-workstation-core.css` | 2.307 | Kontrak visual V3/V4, token `--pw-*`, tabel |
| `public/index-shell.css` | 739 | Shell awal, sidebar chat, `.page-content` |
| `public/spreadsheet-grade.css` | 474 | Ground mesh, tooltip collapsed, tabel spreadsheet, `.table-responsive-container` |
| `public/unified-cockpit.css` | 463 | Cockpit analisis |
| `public/premium-workstation.css` | 7 | Entrypoint `@import` (core + v6 + v11) |
| `public/premium-workstation-v6.css` | 535 | Lapisan evolusi struktural |
| `public/premium-workstation-v11.css` | 401 | Lapisan evolusi struktural |
| `public/tailwind-build.css` | minified | Utility pre-built |
| `public/unified-cockpit-runtime.js` | 357 | Cockpit analisis |
| `public/watchlist-runtime.js` | 532 | Watchlist & alert |
| `public/track-record-runtime.js` | 529 | Track record & backtest |
| `public/track-record-backtest.js` | — | Mesin backtest (`AutoCuanBacktest`) |
| `public/deepscan-runtime.js` | 190 | Macro DeepScan |
| `public/money-management-runtime.js` | 555 | Cashflow & jurnal |
| `public/portfolio-command-center.js` | 605 | Command Center **standalone** |
| `public/portfolio-command-center-model.js` | — | Model Command Center |
| `public/portfolio-command-center.html` | — | Halaman Command Center |
| `public/daytrade-runtime.js` | — | Screener day trade |
| `public/tab-keepalive-runtime.js` | — | Store SWR (`AutoCuanKeepAlive`) |
| `public/analisis-saham-runtime.js` | — | Runtime analisis (halaman terpisah) |
| `public/bandarmologi-runtime.js` | — | Bandarmologi & insider |

**SHA-256 (12 karakter pertama) saat audit:**
```
index.html                          111374D94AE5
ui-theme.css                        DC897F5A5CA6
index-shell.css                     10E2DB4283C3
premium-workstation-core.css        4233560B038D
unified-cockpit.css                 A768E29017BB
spreadsheet-grade.css               E02D98CDCD3F
portfolio-command-center.js         FDBE919B77FF
money-management-runtime.js         32A6A80C2594
watchlist-runtime.js                8B736A79393E
track-record-runtime.js             7FB514239BD4
deepscan-runtime.js                 0CE28BDD10E8
unified-cockpit-runtime.js          32F8091305F4
```

---

## LAMPIRAN B: RINGKASAN TEMUAN PER KATEGORI

### Cacat yang menghentikan (harus diperbaiki sebelum pekerjaan visual apa pun)
| ID | Cacat | Lokasi | Status |
|---|---|---|---|
| **C-00** | **EMPAT aturan `!important` mengunci warna dark-mode ke kelas semantik terpopuler. Rasio di light mode: 1.64:1 (amber), 1.79:1 (emerald), 2.31:1 (blue), 2.51:1 (red) — semua GAGAL BERAT WCAG AA** | `premium-workstation-core.css` 854–873 | **[FAKTA]** |
| C-01 | Token didefinisikan ganda di dua file | `premium-workstation-core.css` 9–99 vs `ui-theme.css` 42–188 | [FAKTA] |
| C-02 | Blok light tidak lengkap: **11 dari 22** `--pw-*` dan **23 dari 35** `--ac-*` tidak pernah di-override | `premium-workstation-core.css` 33–62, 64–99 vs `ui-theme.css` 2527–2551 | [FAKTA] |
| C-03 | `color-scheme: dark` tidak pernah dibatalkan | `index.html` 6; `premium-workstation-core.css` 126 | [FAKTA] |
| C-04 | Tiga warna teks hardcoded terang tidak dapat di-override | `premium-workstation-core.css` 403, 619, 1200 | [FAKTA] |
| C-05 | Grid item tanpa `min-width: 0` mendorong sidebar keluar layar | `.page-content` di `premium-workstation-core.css` 319–323 | [HIPOTESIS] |

### Cacat tingkat tinggi
| ID | Cacat | Lokasi | Status |
|---|---|---|---|
| H-01 | Kontras item aktif sidebar putih solid, tidak konsisten dengan aksen tunggal | `ui-theme.css` 2874–2878 | [FAKTA] |
| H-02 | Footer sidebar meluap saat collapsed (66px konten dalam 48px tersedia) | `ui-theme.css` 2794–2806 + 2741–2748 | [HIPOTESIS] |
| H-03 | `.user-info` memakai `.sidebar-label` sehingga hilang total saat collapsed | `index.html` 509 + `ui-theme.css` 2741–2748 | [FAKTA] |
| H-04 | Nav-row tertanam menciptakan offset sticky yang salah | `index.html` 568 + `premium-workstation-core.css` 1123–1133 | [HIPOTESIS] |
| H-05 | Re-render `tbody.innerHTML` menghancurkan fokus input cashflow | `money-management-runtime.js` 190 → 146 → 197 | [HIPOTESIS] |
| H-06 | Empat kontras teks statis gagal WCAG AA (terpisah dari C-00 yang menyangkut warna semantik) | `premium-workstation-core.css` 411, 452, 1668; `ui-theme.css` 2805 | [FAKTA] |

### Cacat kebenaran data
| ID | Cacat | Lokasi | Status |
|---|---|---|---|
| D-01 | Avatar "B" dan role "PRO PLAN" di-hardcode, tidak pernah diperbarui | `index.html` 508, 511 | [FAKTA] |
| D-02 | Tiga semantik berbeda untuk "nilai hilang" (`—` vs `Rp 0`) | `money-management-runtime.js` 54 | [FAKTA] |
| ~~D-03~~ | ~~Label toggle tema statis~~ — **DICABUT setelah verifikasi**: `index.html` 7753–7756 memang memperbarui ikon & label | `index.html` 7753–7756 | **[DIBATALKAN]** |
| D-04 | Tiga kondisi alert menampilkan kode mentah sebagai label | `watchlist-runtime.js` 156–157 | [FAKTA] |

### Cacat struktural
| ID | Cacat | Lokasi | Status |
|---|---|---|---|
| S-01 | Tiga rezim `z-index` untuk peran sticky header yang sama | 2, 3, 5, z-20, z-30 | [FAKTA] |
| S-02 | Enam tabel memakai `border-collapse: collapse` dengan sticky thead | `index.html` 1065, 1164, 1274, 1622, 1794, 1985 | [FAKTA] |
| S-03 | Sebelas kelas `max-w-*` adalah kode mati | `index.html` 614–2009 vs `premium-workstation-core.css` 321 | [FAKTA] |
| S-04 | `.app-main-viewport` didefinisikan tetapi tidak dipakai | `ui-theme.css` 2808–2813 | [FAKTA] |
| S-05 | `.sidebar-footer` dipakai dua komponen berbeda | `index.html` 437 dan 506 | [FAKTA] |
| S-06 | `body.light` (2526) dan `p` (2669) adalah CSS mati | `ui-theme.css` | [FAKTA] |
| S-07 | `colspan="12"` pada tabel 13 kolom | `money-management-runtime.js` 281 | [FAKTA] |

### Pelanggaran standar eksternal
| ID | Pelanggaran | Standar | Status |
|---|---|---|---|
| X-01 | Tujuh pseudo-element dekoratif emerald tanpa fungsi | Awesome Design MD (larangan AI-slop) | [FAKTA] |
| X-02 | Skala spacing bukan kelipatan 8px | Awesome Design MD | [FAKTA] |
| X-03 | Empat dot berukuran 8px bukan 6px | 21st.dev | [FAKTA] |
| X-04 | `filter: blur(96px)` di landing | GSAP/Awwwards ceiling | [FAKTA] — dampak dashboard nol |

### Klaim direktif yang tidak terverifikasi
| ID | Klaim | Status |
|---|---|---|
| N-01 | `#tab-*` dan `#page-stock-analysis` ada | **[TIDAK TERVERIFIKASI]** — nol hasil; nama benar ada di BAB 0.1 |
| N-02 | SVG logo tidak memiliki batasan ukuran | **[TIDAK TERVERIFIKASI]** — ada dua pembatas; cacat sebenarnya adalah tidak ada ukuran intrinsik |
| N-03 | CSS Flexbox footer hilang | **[TIDAK TERVERIFIKASI]** — Flexbox lengkap; cacat ada di geometri collapsed + tabrakan kelas |
| N-04 | Sektor Hot menampilkan "flow dana" | **[TIDAK TERVERIFIKASI]** — menampilkan `avg_change_pct` + `avg_volume_ratio` |
| N-05 | Screener memiliki pagination | **[TIDAK TERVERIFIKASI]** — hanya filter klien + `max-h` scroll |
| N-06 | DeepScan menampilkan metrik makro & yield curve | **[TIDAK TERVERIFIKASI]** — screening swing saham; "Macro" = horizon waktu |
| N-07 | Tab Portofolio digerakkan `portfolio-command-center.js` | **[TIDAK TERVERIFIKASI]** — tab shell digerakkan kode di `index.html`; `portfolio-command-center.js` adalah aplikasi terpisah |

---

## LAMPIRAN C: PERNYATAAN KEPATUHAN MODE

Sesuai direktif **MODE STRICT: READ-ONLY CODEBASE**:

| Batasan | Status |
|---|---|
| Tidak mengedit `index.html` | ✅ Tidak disentuh |
| Tidak mengedit CSS | ✅ Tidak disentuh |
| Tidak mengedit JS runtime | ✅ Tidak disentuh |
| Tidak menjalankan build test | ✅ Tidak dijalankan |
| Tidak melakukan `git commit` | ✅ Tidak dilakukan |
| Tidak melakukan `git push` | ✅ Tidak dilakukan |
| Hanya menulis SATU file lokal baru | ✅ `docs/AUDIT-VISUAL-PEMETAAN.md` |

**File sementara yang dibuat dan dihapus selama audit:**
- `tmp_audit_hits.txt` — dihapus
- `tmp_audit_map.ps1` — dihapus
- `tmp_audit_spec.ps1` — dihapus
- `tmp_audit_spec2.ps1` — dihapus

**Catatan:** sebuah file bernama `{for(const` terdeteksi di root workspace pada daftar file. Nama ini menyerupai artefak perintah shell yang salah kutip dan bukan bagian dari codebase. **Tidak disentuh oleh audit ini** — perlu ditinjau terpisah apakah aman dihapus.

---

## LAMPIRAN D: LOG KOREKSI DIRI SELAMA AUDIT

Audit ini menemukan dan memperbaiki **lima kesalahan** dalam versi awalnya sendiri. Dicatat di sini karena transparansi metodologi lebih penting daripada terlihat sempurna, dan karena setiap kesalahan mengajarkan sesuatu tentang codebase.

| # | Klaim awal (SALAH) | Temuan koreksi | Pelajaran |
|---|---|---|---|
| 1 | "`@import` membuat `premium-workstation-core.css` dievaluasi belakangan sehingga `--pw-*` dark menang" | **SALAH.** `html.light` (spesifisitas 0,1,1) mengalahkan `:root` (0,1,0) tanpa peduli urutan muat. Override di `ui-theme.css` **berfungsi**. | Spesifisitas > urutan sumber. Selalu hitung spesifisitas sebelum menyimpulkan pemenang cascade. |
| 2 | "`body.light` (ui-theme.css 2526) adalah CSS mati karena kelas tidak pernah dipasang" | **SALAH.** `index.html` 7747 memasangnya: `document.body.classList.toggle('light', isLight)`. | Bootstrap awal (baris 56–67) **hanya** menyentuh `documentElement`; `applyAppTheme()` menyentuh keduanya. Membaca satu tempat tidak cukup. |
| 3 | "Label toggle tema statis, tidak mencerminkan state" | **SALAH.** `index.html` 7753–7756 memperbarui `#sidebarThemeIcon` dan `#sidebarThemeLabel`. Mekanisme lengkap. | Cari pemanggil fungsi sebelum mengklaim sesuatu "tidak pernah diperbarui". |
| 4 | "SVG logo tidak memiliki batasan ukuran sehingga meluap" | **SEBAGIAN SALAH.** Ada dua pembatas (`ui-theme.css` 2775–2776). Cacat sebenarnya: tidak ada ukuran **intrinsik** pada SVG. | Bedakan "tidak ada batasan" dari "batasan bergantung pada satu baris rapuh". |
| 5 | "CSS Flexbox footer hilang / tidak didefinisikan" | **SALAH.** Flexbox lengkap di `ui-theme.css` 2794–2806. Cacat sebenarnya: geometri collapsed meluap + tabrakan kelas `.sidebar-footer`. | Gejala "berantakan" tidak selalu berarti "properti hilang"; bisa berarti nilai yang salah. |

**Temuan yang MUNCUL akibat koreksi ini** (dan justru menjadi yang terpenting):

**C-00** — Empat aturan `!important` di `premium-workstation-core.css` 854–873 mengunci warna dark-mode ke kelas semantik yang paling sering dipakai di seluruh aplikasi. Di light mode, keempatnya gagal WCAG AA secara berat. **Cacat ini tidak akan ditemukan** jika audit berhenti pada kesimpulan keliru bahwa "masalahnya adalah urutan muat `@import`".

---

**AKHIR DOKUMEN**

Dokumen ini adalah blueprint. Tidak ada satu baris pun kode produksi yang diubah. Implementasi menunggu persetujuan eksplisit, dan setiap item berlabel **[HIPOTESIS]** harus lulus verifikasi di BAB 4.6 terlebih dahulu.

**Ringkasan satu paragraf untuk pengambil keputusan:** Codebase Auto-Cuan memiliki arsitektur shell yang **sudah benar** (`ui-theme.css` 2706–2823: flex row, sidebar sticky 240px→72px, `min-width: 0` pada kolom konten) dan ground yang **sudah sesuai** standar FeralUI. Yang rusak bukan fondasinya, melainkan **tiga hal yang dapat diperbaiki tanpa menyentuh arsitektur**: (1) empat aturan `!important` yang mengunci warna semantik ke dark-mode, membuat light mode praktis tidak terbaca pada angka P/L; (2) blok `html.light` yang hanya meng-override separuh token; dan (3) tabrakan kelas `.sidebar-footer` plus geometri collapsed yang meluap. Selain itu, direktif berisi **tujuh klaim yang tidak terverifikasi** (Lampiran B, N-01 s/d N-07) — termasuk penamaan `#tab-*` yang tidak ada sama sekali, dan asumsi bahwa Tab Portofolio digerakkan `portfolio-command-center.js` padahal itu aplikasi terpisah. Implementasi harus memakai pemetaan di BAB 0.1, bukan penamaan di direktif.
