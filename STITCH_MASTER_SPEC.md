# Auto-Cuan — Master Design Specification & Google Stitch Prompt Catalog
**Document Version:** 1.0 (Master Compilation)  
**Target Platform:** Google Stitch (AI Web Prototyping & Visual Generation)  
**Source Baseline:** [`DESIGN.md`](DESIGN.md:1) v1.1, [`public/index.html`](public/index.html:1), [`public/partials/`](public/partials/), and runtime DOM architecture  
**Mode:** Continuous Financial Workstation (Anti Card-Wall)  
**Primary Currency / Tickers:** Indonesian Rupiah (IDR), Indonesia Stock Exchange (IDX: BBCA, BBRI, BMRI, TLKM, ASII, BRPT, MEDC, etc.)  

---

## 1. Executive Overview & Stitch Generation Guidelines

Auto-Cuan is a calm, high-density, serious financial intelligence workstation for Indonesian equities (IDX). It is **not** a crypto casino, neon terminal, or generic SaaS dashboard cluttered with isolated floating cards ("card wall"). 

### The Core Paradigm: Continuous Workspace over Card-Wall
When feeding prompts into Google Stitch, enforce the following fundamental rules:
1. **Continuous Surface Rhythm:** Group components using **alignment → spacing (4px scale) → hairline dividers (`#E2E7E4`) → subtle tonal shifts (`#F8FAF9`)**. Floating cards with drop shadows must only be used where an object genuinely requires a floating boundary (dialogs, popovers, mobile sheets, or command palettes).
2. **Brand Emerald vs Financial Semantics:**
   - Brand emerald (`#0F7458` / `#10B981`) is reserved for primary actions, selected states, and brand identity.
   - Financial green (`#247A43` / `#34D399`) represents positive price change, profit, and net buying.
   - Financial red (`#C13F4D` / `#FB7185`) represents loss, negative movement, and selling.
   - Positive rows or cards must **never** be bathed entirely in solid green or red. Color reinforces numeric values (`+2.45%`), never overwhelms containers.
3. **Typography & Tabular Numerals:** All prices, volume, percentage changes, market cap, and financial metrics must use fixed-width figures: `font-variant-numeric: tabular-nums lining-nums;` and right-alignment in data tables.
4. **Indonesian Financial Formatting:**
   - Currency format: `Rp 10.450`, `Rp 25.000.000`. Group separator is dot `.`, decimal is comma `,` (`41,82%`).
   - Units: `jt` (juta), `M` (miliar), `T` (triliun), `lot` (100 lembar), `lembar` (individual shares). Never mix `lot` and `lembar`.
   - Missing data renders as an em-dash `—`, never synthetic `0`.

---

## 2. Global Design System Tokens & Motion Engine

### 2.1 Canonical Light Theme Tokens (Primary Baseline §4.1)
```css
:root {
  /* Surfaces & Canvas */
  --ac-canvas: #F3F5F4;
  --ac-surface: #FFFFFF;
  --ac-surface-raised: #F8FAF9;
  --ac-surface-hover: #EEF2F0;

  /* Typography / Ink */
  --ac-ink: #17211E;
  --ac-text-secondary: #52605B;
  --ac-text-muted: #5F6C66;
  --ac-text-tertiary: #5F6C66;

  /* Borders & Hairlines */
  --ac-line-hairline: #E2E7E4;
  --ac-line-default: rgba(18, 35, 29, 0.14);
  --ac-line-strong: rgba(18, 35, 29, 0.20);
  --ac-control-border: #7D8683;
  --ac-control-border-hover: #65726C;

  /* Brand Emerald */
  --ac-brand: #0F7458;
  --ac-brand-hover: #0B6049;
  --ac-brand-soft: #E8F3EE;
  --ac-focus: #0F7458;

  /* Financial Semantics */
  --ac-positive: #247A43;
  --ac-positive-soft: rgba(36, 122, 67, 0.09);
  --ac-negative: #C13F4D;
  --ac-negative-soft: rgba(193, 63, 77, 0.09);
  --ac-warning: #A96D13;
  --ac-warning-text: #96610F;
  --ac-warning-soft: rgba(169, 109, 19, 0.09);
  --ac-info: #315F9A;
  --ac-info-soft: rgba(49, 95, 154, 0.09);

  /* System State Aliases */
  --ac-success: #247A43;
  --ac-danger: #C13F4D;
}
```

### 2.2 Dark Mode Tokens (Night Research Mode §4.2)
```css
[data-theme="dark"], html.dark {
  /* Matte, Low-Glow Night Research Surfaces */
  --ac-canvas: #090D16;
  --ac-surface: #10151F;
  --ac-surface-raised: #161C29;
  --ac-surface-hover: #19202E;

  /* Text & Ink */
  --ac-ink: #F4F6F8;
  --ac-text-secondary: #9AA4B2;
  --ac-text-muted: #93A1B5;

  /* Hairlines & Boundaries */
  --ac-line-hairline: rgba(255, 255, 255, 0.08);
  --ac-line-default: rgba(148, 163, 184, 0.16);
  --ac-line-strong: rgba(148, 163, 184, 0.28);
  --ac-control-border: #475569;
  --ac-control-border-hover: #64748B;

  /* Brand & Accents */
  --ac-brand: #10B981;
  --ac-brand-hover: #059669;
  --ac-brand-soft: rgba(16, 185, 129, 0.12);
  --ac-focus: #10B981;

  /* Financial Semantics */
  --ac-positive: #34D399;
  --ac-positive-soft: rgba(52, 211, 153, 0.12);
  --ac-negative: #FB7185;
  --ac-negative-soft: rgba(251, 113, 133, 0.12);
  --ac-warning: #F59E0B;
  --ac-warning-text: #FBBF24;
  --ac-warning-soft: rgba(245, 158, 11, 0.12);
  --ac-info: #60A5FA;
  --ac-info-soft: rgba(96, 165, 250, 0.12);
}
```

### 2.3 Categorical Chart Palette (§103.1)
Distinct categorical series (e.g. broker codes, market cap tiers, sector groupings) must never reuse financial positive/negative colors:
- **Light Mode:** Cat 1 `#315F9A` (Navy), Cat 2 `#7357A6` (Purple), Cat 3 `#94602B` (Bronze/Amber), Cat 4 `#2F6F86` (Teal), Cat 5 `#8C4F73` (Plum), Cat 6 `#536A7C` (Slate).
- **Dark Mode:** Cat 1 `#8BB2E8`, Cat 2 `#B9A0E3`, Cat 3 `#DFB277`, Cat 4 `#7FB7CF`, Cat 5 `#D995B7`, Cat 6 `#A9BDCF`.

### 2.4 Typography & Scale (§5, §6)
- **Primary Font Family:** System Sans / Inter (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif`).
- **Monospace Family:** JetBrains Mono / SF Mono / Consolas (`monospace` for codes, order IDs, timestamps).
- **Type Roles:**
  - Display / Hero: 36px – 52px (weight 800/900).
  - Page Title: 24px – 28px (weight 700).
  - Section Title: 18px – 20px (weight 600).
  - Component Title / Subtitle: 14px – 16px (weight 600).
  - Standard Body: 14px – 15px (weight 400).
  - Dense Workstation UI: 13px – 14px (weight 400/500).
  - Data Table Cells & Headers: 12px – 13px (weight 500/600).
  - Evidence Metadata & Timestamps: 11px – 12px (secondary ink).

### 2.5 Spacing (§7) & Sizing Tokens (§103.3)
- **Base Grid:** 4px.
- **Scale:** `4px (1) / 8px (2) / 12px (3) / 16px (4) / 20px (5) / 24px (6) / 32px (8) / 40px (10) / 48px (12) / 64px (16)`.
- **Dimensions:**
  - `--ac-sidebar-width`: 240px (collapsed rail: 68px).
  - `--ac-topbar-height`: 52px.
  - `--ac-row-dense`: 38px (header: 36px).
  - `--ac-row-comfort`: 42px.
  - `--ac-control-sm`: 36px; `--ac-control-md`: 42px.
  - `--ac-touch-target`: 44px minimum hit area on touchscreens.

### 2.6 Radius Tokens (§8) & Elevation (§9)
- **Radius:**
  - `xs`: 4px (tags, sub-badges).
  - `sm`: 6px (table buttons, small inputs).
  - `md`: 8px (standard buttons, form controls, segment tracks).
  - `lg`: 12px (panels, continuous bounded surfaces).
  - `xl`: 16px (modals, dialog sheets).
  - `full`: 999px (capsules, avatar badges).
- **Elevation:**
  - `Level 0` (Canvas, metric strips, tables): No shadow (`box-shadow: none`).
  - `Level 1` (Raised panels): Border hairline + faint tint `rgba(0,0,0,0.02)`.
  - `Level 2` (Dialogs, popovers, mobile sheets): `0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)`.

### 2.7 Z-Index Hierarchy (§103.2)
`--ac-z-base: 0; --ac-z-sticky: 20; --ac-z-shell: 40; --ac-z-popover: 60; --ac-z-drawer: 80; --ac-z-modal: 100; --ac-z-toast: 120; --ac-z-critical-gate: 140;`

### 2.8 Motion & Transition Engine (§50)
- Speeds: Press `90ms`, Hover `140ms`, State/Toggle `190ms`, Drawer/Sheet `260ms`, Editorial Story `420ms`.
- Curves: Standard `cubic-bezier(.2,.8,.2,1)`, Emphasized `cubic-bezier(.16,1,.3,1)`, Exit `cubic-bezier(.4,0,1,1)`.
- Accessibility: Respect `prefers-reduced-motion: reduce` by setting animation durations to 0s and forcing opacity to 1 immediately.

---

## 3. Audit & Architectural Reconstruction of "Kelola Keuangan" (Money Management)

### 3.1 Historical Context & Decommissioning Reasons (§3.2)
In the current application runtime, the "Kelola Keuangan" tab is removed from the active sidebar navigation. As documented in [`DESIGN.md`](DESIGN.md:110) (§3.2):
> *"Kelola Keuangan is not part of the target Auto-Cuan product experience. It must not appear in global navigation, mobile More, command search, landing, account, onboarding, or dashboard shortcuts... Visual retirement of this feature must never delete user data or database schema automatically."*

When a user attempts to navigate to `navigateTo('money-management')` or `navigateTo('kelola-keuangan')`, the router in [`public/index.html`](public/index.html:6589) intercepts the route with:
```js
if (page === 'money-management' || page === 'kelola-keuangan') {
    if (typeof showToast === 'function') showToast('Fitur Kelola Keuangan sudah dinonaktifkan permanen.', 'warning');
    page = 'dashboard';
    subTab = undefined;
}
```

### 3.2 Preserved Repository Artifacts
The entire original feature architecture remains fully intact across multiple source files:
1. **Markup Partial:** [`public/partials/money-management.partial.html`](public/partials/money-management.partial.html:1) and [`partials/money-management.partial.html`](partials/money-management.partial.html:1) (7,286 bytes).
2. **Stylesheets:** [`public/money-sheet.css`](public/money-sheet.css:1) and [`public/spreadsheet-grade.css`](public/spreadsheet-grade.css:1).
3. **Frontend Runtime Logic:**
   - [`public/money-sheet-runtime.js`](public/money-sheet-runtime.js:1) (client data synchronization).
   - [`public/money-sheet-grid.js`](public/money-sheet-grid.js:1) (spreadsheet grid interaction, cell editing, formula evaluation).
   - [`public/money-sheet-model.js`](public/money-sheet-model.js:1) (in-memory data store).
   - [`public/money-sheet-formulas.js`](public/money-sheet-formulas.js:1) (`SUM`, `AVERAGE`, `ROUND`, math operators).
4. **Backend Endpoint & Mock Data:**
   - [`api/money-management.js`](api/money-management.js:1) and [`lib/money-management-handler.js`](lib/money-management-handler.js:1).
   - [`lib/mock-preview-data.js`](lib/mock-preview-data.js:97) (`MOCK_MONEY_MANAGEMENT` with cashflow, journal, and summary).

### 3.3 Complete Reconstructed DOM Structure
The page is organized into 4 vertical zones:

```text
[Zone 1: Page Heading & Month Selector]
  - Eyebrow: "KEUANGAN PRIBADI"
  - Title: "Kelola Keuangan"
  - Subtitle: "Anggaran bulanan yang bisa Anda atur. Portofolio terhubung, tanpa pencatatan ganda."
  - Right Control: Month Picker (input[type="month"] #mmSheetMonth)

[Zone 2: Continuous Budget Overview Strip (4 Metric Tiles)]
  - Tile 1: "Pemasukan" -> Rp 34.500.000 (Seluruh sumber penghasilan)
  - Tile 2: "Pengeluaran" -> Rp 16.500.000 (Kebutuhan dan pengeluaran pilihan)
  - Tile 3: "Tabungan & transfer" -> Rp 18.000.000 (Alokasi bulan ini, bukan nilai aset)
  - Tile 4: "Sisa anggaran" -> Rp 13.000.000 (Status: Siap dialokasikan)

[Zone 3: Linked Portfolio Summary Card]
  - Header: Icon Briefcase + "Portofolio terhubung" + Status: "Tersinkron · 4 posisi"
  - Metric 1: "Eksposur rencana" -> Rp 27.400.000
  - Metric 2: "P/L dari harga tersimpan" -> +Rp 1.845.000 (+6,73%)
  - Action Button: "Buka Portofolio ↗"
  - Explanatory Note: "Ringkasan mengikuti sumber data Portofolio. Nilai rencana dan P/L bukan arus kas bulan ini; tidak ditambahkan atau dikurangkan otomatis dari anggaran."

[Zone 4: Interactive Cashflow Spreadsheet Grid (Excel-like Workspace)]
  - Header: "Anggaran bulanan" + Subtitle + Action: [Fokus lembar] + Save State: "Tersimpan 17:04 WIB"
  - Primary Toolbar:
      [+ Tambah baris] | [↶ Undo] [↷ Redo] | [🔍 Cari pos anggaran] | [Sort: Urutan Asli / Nominal / Nama] | [Ekspor CSV] [Muat ulang] [Simpan (Primary)]
  - Cell Range Edit Toolbar:
      [Salin] [Kosongkan sel] [Isi ke bawah (Ctrl+D)] [Sisipkan baris] [Hapus baris]
  - Formula Bar:
      [Cell Address: "D4"] [fx] [Formula Input: "=SUM(D1:D3)"]
  - Collapsible Helper Details: "Pintasan & rumus" (Keyboard navigation & math guide)
  - Spreadsheet Grid Table (#mmCashflowSpreadsheetTable):
      Columns:
      1. [#]: Row Number (sticky left index)
      2. [A]: Jenis (Pemasukan, Pengeluaran, Tabungan, Transfer)
      3. [B]: Kategori (Gaji, Bisnis, Kebutuhan, Hiburan, Investasi)
      4. [C]: Nama Pos (Gaji Kantor, Belanja Bulanan, Listrik & Air, Trading IDX)
      5. [D]: Nominal (Rp) (Right-aligned tabular-nums, formula support)
      6. [E]: Catatan (Text description)
      7. [Actions]: Delete / context menu
  - Grid Status Bar: "8 baris · nominasi Rp 69.000.000" | "Pilih sel untuk mengedit"
  - Monthly Notes: Textarea for overall financial reflection.
```

---

## 4. Master Layout & Google Stitch Prompts per Page

Below is the complete catalog of all 14 major feature modules, containing:
1. **Current DOM Architecture:** Exact hierarchy, components, and field names.
2. **Ready-to-Paste Google Stitch Prompt:** Formulated in English with precise Indonesian UI text, strict design tokens, continuous workspace rules, realistic IDX sample data, and clean component composition.

---

### 4.1 Landing Page (Public Showcase & Narrative)

#### Current DOM Layout
- **Container:** `<section id="landingPage" class="landing-shell">` with background radial gradients.
- **Top Navigation Bar:** Logo ("Auto-Cuan"), navigation links (`Pasar`, `Screener`, `Investigasi`, `Fundamental`, `Asisten AI`, `Monitoring`, `Integritas Data`), Theme Toggle button (`#landingThemeToggle`), Login CTA (`#landingLoginBtn`), Register CTA (`#landingCtaHeader`).
- **Hero Section (`#landingHero`):**
  - Eyebrow: `"MEJA KERJA RISET PASAR MODAL IDX"`
  - Display Title: `"Baca pasar. Susun rencana. Jaga konteks."`
  - Subtitle: Narrative explanation of disciplined equity analysis.
  - CTAs: Primary Emerald button (`"Mulai Sekarang ↗"`), Secondary button (`"Jelajahi Alur Riset ↓"`).
  - Value Badges: 3 inline trust chips (`01 Sumber data transparan`, `02 Eksekusi mandiri di sekuritas`, `03 Nilai kosong bukan nol`).
  - Hero Product Window (`#landingPreview`): Dark-mode interactive workstation frame showcasing IDX Market Pulse (IHSG 7.125,40), active conglomerate sector performance, and live top radar pick.
- **Market Pulse Section (`#landingMarket`):** Macro condition, IHSG trend status, sector rotation cards.
- **Screener Workflow Showcase (`#landingScan`):** Konglo, Non-Konglo, Day Trade tabs showcase.
- **Investigate Section (`#landingInvestigate`):** Broker flow accumulation and insider ownership network teaser.
- **Validate Section (`#landingValidate`):** Fundamental PBV/BVPS and market structure (Free Float & HSC).
- **AI Assistant Section (`#landingAi`):** Factual evidence synthesis without anthropomorphic hype.
- **Trust & Rules Section (`#landingTrust`):** Market schedules, exchange session rules, and risk disclosure.
- **Footer:** Brand copyright, navigation index, and disclaimer note.

#### Ready-to-Paste Stitch Prompt
```text
Design a world-class, premium public landing page for "Auto-Cuan" — a precision financial intelligence workstation for Indonesian Stock Exchange (IDX) equities.

Visual Style & Tokens:
- Canvas background: Light theme with soft warm neutral #F3F5F4, high-contrast crisp white panels #FFFFFF, subtle hairline borders in #E2E7E4, deep charcoal ink #17211E, and secondary text #52605B.
- Brand Accent: Precision emerald #0F7458 (interactive elements, active states, buttons).
- Financial Semantics: Profit green #247A43, loss red #C13F4D, caution amber #A96D13. Tabular numbers for all stock figures.
- Philosophy: "Continuous Workspace over Card Wall" — avoid bubbly floating cards and generic SaaS templates. Use subtle hairlines, generous whitespace (4px grid), and structured data ribbons.

Header Navigation:
- Left: "Auto-Cuan" wordmark with a subtle geometric green terminal spark icon.
- Center Links: "Pasar", "Screener", "Investigasi", "Fundamental", "Asisten AI", "Monitoring".
- Right Actions: Theme Toggle (Sun/Moon), Text button "Masuk", and primary solid emerald pill button "Mulai Sekarang ↗".

Hero Section:
- Eyebrow tag: "MEJA KERJA RISET PASAR MODAL IDX" in uppercase letterspaced mono font.
- Main Headline (editorial display, 52px, bold): "Baca pasar. Susun rencana. Jaga konteks."
- Supporting Paragraph: "Auto-Cuan menyatukan riset saham, struktur kepemilikan pasar, portofolio mandiri, dan konfluensi bukti dalam satu meja kerja yang tenang. Tidak ada angka sintetis saat data bursa belum tersedia."
- CTAs: Solid emerald button "Mulai Sekarang ↗" alongside quiet bordered button "Jelajahi Alur Riset ↓".
- Trust Strip: 3 horizontal micro-indicators: "01 Sumber data transparan", "02 Eksekusi mandiri di sekuritas", "03 Nilai kosong bukan nol".
- Live Product Preview Frame: A sleek, continuous desktop workstation preview showing real IDX data: IHSG index at 7.142,85 (+0,62%), Sector Leaders (Barito Group +3,4%, Astra +1,2%), and a preview trading plan for BBCA (Entry: 10.250, SL: 10.050, TP1: 10.600).

Content Flow Sections:
1. "Kondisi Pasar": IHSG market breadth strip (312 Menguat, 218 Melemah, 185 Stagnan), session badge "Sesi 2 Aktif · WIB".
2. "Screener 3 Kategori": Minimalist table preview showing Konglo, Non-Konglo, and Day Trade momentum picks with Setup Scores.
3. "Investigasi Transaksi": Visual split previewing Broker Summary accumulation (Top Net Buyer: ZP Rp 87,1 M) and Insider Network graph.
4. "Uji Fundamental & Struktur Pasar": Factual verified snapshot showing PBV 4,32x, BVPS Rp 2.370, Free Float 41,82%, and HSC compliance status.
5. "Asisten AI Berbasis Bukti": Clean structured AI response card highlighting Summary, Supporting Evidence, and Execution Risks.
6. Footer & Legal Disclaimer: "Bukan rekomendasi beli atau jual. Keputusan investasi sepenuhnya di tangan pengguna."
```

---

### 4.2 Authentication Surfaces (Login, Register, Mandatory Gmail, Recovery)

#### Current DOM Layout
- **Modal Container:** Direct children of `<body>`, overlayed with fixed backdrop `z-[9999] bg-black/70 backdrop-blur-sm`.
- **Login Modal (`#loginModal`):**
  - Title: `"Masuk"` with close icon button (`&times;`).
  - Fields: `loginUsername` ("Email atau username" with Gmail helper note), `loginPassword` (with eye toggle `#loginPasswordToggle`).
  - Action Button: Solid Emerald `#loginBtn` ("Masuk").
  - Alternative: Divider `"atau"` + Google Auth button (`#loginGoogleBtn`).
  - Footer: Text link `"Lupa Password?"` triggering `#openSelfResetModal`.
- **Register Modal (`#registerModal`):**
  - Fields: `regEmail` ("Gmail" required), `regUsername`, `regPassword`, `regPasswordConfirm`.
  - Terms Consent Checkbox: `#regTermsAccepted` with clickable link to Service Terms.
  - Action Button: `#registerBtn` ("Daftar").
  - Success Approval Panel (`#registerApprovalPanel`): Shows User Code, One-time Telegram Verification Code (`#registerVerificationCode`), expiry countdown, and status card: `"Menunggu Persetujuan Admin"`.
- **Mandatory Gmail Onboarding Modal (`#mandatoryGmailModal` / `.legacy-gmail-dialog`):**
  - Blocking modal for legacy accounts without Gmail.
  - Informational alert: explains identity consolidation and Telegram recovery binding.
  - Field: New Gmail address + confirmation.
- **Self-Reset / Password Recovery Modal (`#selfResetModal`):**
  - Multi-step wizard: Step 1 Enter Gmail/Username → Step 2 Verification code sent to connected Telegram bot → Step 3 Input new password and confirmation.

#### Ready-to-Paste Stitch Prompt
```text
Design a set of cohesive, calm, and distraction-free authentication interfaces for Auto-Cuan (Light-first financial workstation).

Visual Guidelines:
- Backdrop: Soft muted darkening #17211E at 40% opacity with subtle backdrop blur.
- Dialog Surface: Clean pure white #FFFFFF, 16px radius, crisp hairline border #E2E7E4, no aggressive colorful glow.
- Typography: Clear labels in #17211E (13px font-weight 600), inputs with #7D8683 border, 8px radius, focusing to emerald #0F7458 outline.
- Brand Primary: Emerald #0F7458 solid button with white text (height 42px).

Screens to Include in One Harmonious Canvas:
1. "Masuk (Login Dialog)":
   - Header: "Masuk ke Auto-Cuan" with subtitle "Akses meja kerja riset saham IDX".
   - Form Fields:
     * Label "Email atau Username", placeholder "nama@gmail.com atau username", with sub-text "Masukkan Gmail atau username terdaftar".
     * Label "Password", placeholder "••••••••", with toggle eye icon.
   - Primary Button: "Masuk ke Workspace".
   - Divider line with label "atau".
   - Secondary Button: "Masuk dengan Google" featuring official Google 'G' icon.
   - Footer: Link "Lupa password akun?".

2. "Daftar Akun Baru (Registration Dialog)":
   - Header: "Daftar Akun Baru" with security note "Wajib menyertakan Gmail aktif".
   - Form Fields: Gmail ("nama@gmail.com"), Username ("trader_cuan"), Password ("Min. 8 karakter"), Konfirmasi Password.
   - Checkbox: "Saya menyetujui Syarat & Ketentuan Layanan Auto-Cuan".
   - Primary Button: "Daftar Sekarang".

3. "Status Registrasi & Verifikasi Telegram (Post-Registration State)":
   - Clean verification card: "Pendaftaran Berhasil Diterima".
   - Status badge: Amber pill "Menunggu Persetujuan Admin".
   - Highlight Box (soft blue #315F9A with 8% background):
     * Label "KODE VERIFIKASI TELEGRAM (SATU KALI)"
     * Code display in large spaced mono: "AC-892415"
     * Instruction: "Salin kode ini dan kirimkan ke bot Telegram resmi @AutoCuanVerifyBot untuk mengaktifkan akun."
     * Button: "Buka Bot Telegram ↗".

4. "Mandatory Gmail Onboarding (Legacy Gate Dialog)":
   - Non-dismissible focused dialog: "Lengkapi Identitas Akun".
   - Context: "Auto-Cuan mewajibkan identitas Gmail untuk sinkronisasi perangkat aman dan notifikasi bursa."
   - Input: "Masukkan Alamat Gmail Aktif" + Button: "Simpan & Lanjutkan".
```

---

### 4.3 Account Center (Profil, Keamanan, Preferensi, Pengaturan AI, Langganan)

#### Current DOM Layout
- **Container:** `<div id="acCenterModal">` or `#page-portofolio` modal container, managed by [`public/account-center-v1.js`](public/account-center-v1.js:1).
- **Header:** Identity banner with avatar circle (`AC` or user initial), username (`budi`), role badge (`ADMIN` / `PRO TRADER`), and active package label.
- **Navigation Tabs:** Horizontal or segmented tab strip:
  1. `Profil`: Account overview, registration timestamp, registered Gmail.
  2. `Keamanan & Koneksi`: Telegram connection status (Telegram ID, Bot pairing status, Zero-link pair code), Change Password triggers, active sessions.
  3. `Preferensi Trading`: Modal Trading Awal (`Rp 50.000.000`), Toleransi Risiko per Transaksi (`1,0%`), Dana Cadangan (`10%`), Maksimal Posisi Aktif (`4`).
  4. `Pengaturan AI (BYOK)`: Google Gemini API Key input field (masked `••••••••AIzaSy...`), validation state badge (`Terkoneksi` / `Belum Diatur`), model selector (`gemini-2.0-flash` / `gemini-1.5-pro`).
  5. `Langganan`: Active entitlement (`LIFETIME VIP`), voucher redemption form (`Kode Voucher`, button `Aktifkan`), and plan catalog summary.
  6. `Peraturan & Ketentuan`: 12 scrollable legal clauses for platform governance.

#### Ready-to-Paste Stitch Prompt
```text
Design the "Account Center" (Pusat Pengaturan Akun) for Auto-Cuan financial workstation.

Layout Structure:
- Desktop: Continuous settings workstation with a left sub-navigation sidebar (width 220px) and a right settings canvas (max-width 840px).
- Theme: Canonical Light Theme (Canvas #F3F5F4, Surface #FFFFFF, Hairlines #E2E7E4, Brand Emerald #0F7458).

Left Sub-Navigation Menu:
- User Card: Circle avatar with initials "BD", bold username "budi", badge "PRO TRADER / ADMIN".
- Menu Items:
  1. "Profil Akun" (Active, soft emerald background #E8F3EE, green text).
  2. "Keamanan & Koneksi".
  3. "Preferensi Trading".
  4. "Pengaturan AI (BYOK)".
  5. "Status Langganan".
  6. "Ketentuan Layanan".
  7. Divider + "Keluar dari Sesi" (muted red text).

Main Content Panels (Rendered as cohesive tabs):
1. "Profil & Identitas":
   - Section kicker: "IDENTITAS AKUN"
   - Read-only fields: Username ("budi"), Email ("budi.investor@gmail.com"), Tanggal Bergabung ("14 Januari 2026"), Status Approval ("Terverifikasi Administrator").

2. "Keamanan & Koneksi Telegram":
   - Status banner: Emerald border, icon checkmark "Telegram Terhubung (@budi_trader · ID: 94819284)".
   - Action: Button "Putus Koneksi" (quiet) and "Uji Kirim Sinyal Bot".
   - Password section: Fields "Password Lama", "Password Baru", button "Perbarui Password".

3. "Preferensi Trading & Manajemen Risiko":
   - Explanatory note: "Parameter dasar untuk perhitungan ukuran posisi otomatis pada Screener dan Portfolio Planner."
   - 2-column grid inputs:
     * "Modal Trading Aktif (Rp)": Rp 100.000.000
     * "Toleransi Risiko per Transaksi (%)": 1,0% (Rp 1.000.000)
     * "Porsi Dana Cadangan / Cash (%)": 20% (Rp 20.000.000)
     * "Batas Maksimal Posisi Terbuka": 4 Saham

4. "Pengaturan AI (Bring Your Own Key - BYOK)":
   - Header: "Google Gemini API Key"
   - Context: "Kunci API disimpan di penyimpanan lokal browser Anda dan digunakan untuk analisis teknikal multi-emiten."
   - Input: Masked key `AIzaSyD-98124••••••••••••••••••••` with "Ganti Kunci" & "Tes Koneksi".
   - Model dropdown: "Gemini 2.0 Flash (Default · Cepat & Akurat)".
   - Status chip: Green dot "Kunci Valid & Kuota Tersedia".

5. "Langganan & Voucher":
   - Current plan card: "VIP LIFETIME ACCESS" with validity "Tanpa Batas Waktu".
   - Voucher input bar: Text field "Masukkan Kode Voucher Promo" + Button "Klaim Voucher".
```

---

### 4.4 Dashboard (Kondisi Pasar, Market Breadth IDX, Top 5 Radar)

#### Current DOM Layout
- **Page Container:** `<div id="page-dashboard" class="page-content" data-ac-ui="v2">`.
- **Top Greeting Hero (`.dashboard-hero`):**
  - Left: Session freshness dot + badge (`"EOD / T-1"` or `"Live Session 2"`), Warning badge (`"Konfirmasi manual wajib"`), Title `"Halo, budi"`, Subtitle `"Dashboard ringkas untuk Day Trade, Swing Konglo, dan Swing Non-Konglo. Watchlist/pantau tidak sama dengan BUY agresif."`.
  - Right: Approval badge (`Approved`), BYOK API Key button (`#openAiApiKeyModal`), Disclaimer note `"Bukan rekomendasi beli/jual."`.
- **Market Condition Band (`.market-band` / `#ihsgSummaryCard`):**
  - Tile 1 (`IDX · IHSG`): Value `7.142,85`, Delta `+44,12 (+0,62%)`, Status `Normal / Uptrend`, link `"Buka analisis IHSG →"`.
  - Tile 2 (`Radar Hari Ini`): Value `8 Saham`, Unit `"lolos gate"`, note `"Menunggu Top 5 final dikunci"`.
  - Tile 3 (`Waktu As-Of Pasar`): Value `15:58 WIB`, note `"Semua angka radar memakai candle harian yang sudah selesai (T-1, format WIB)"`.
- **Market Breadth Strip (`#dashboardMarketBreadthWrap`):**
  - Horizontal bar visualizing IDX distribution: 312 Saham Naik (Green), 218 Saham Turun (Red), 185 Saham Stagnan (Gray), Nilai Transaksi: `Rp 12,4 Triliun`.
- **Radar Hari Ini (Top 5 Ranked Decision Rows):**
  - Container: `#dashboardTop5List`.
  - Table / Decision rows displaying:
    * Rank (#1 to #5)
    * Ticker & Company Name (e.g. `BRPT - Barito Pacific Tbk`)
    * Konglomerasi Group badge (`Prajogo Pangestu`)
    * Setup Tier (`Tier 1 · Swing Ready`)
    * Exec Quality (`A+`)
    * Price & Daily Change (`Rp 1.045 · +3,45%`)
    * Volume Ratio (`Vol/Avg20: 2,8x`)
    * Plan Levels: Entry `1.030–1.050`, Stop Loss `995 (-4,5%)`, TP1 `1.120 (+7,5%)`, R/R `1 : 1,67`
    * Action button: `"Analisis"` and star to watchlist.
- **Safety Disclosure Note:** Explains that high-risk and avoid stocks are quarantined.
- **Top 5 History Section (`#top5HistoryList`):**
  - Tabs: `Aktif Dipantau` vs `TP History`.
  - Historical outcome records verifying past signals.

#### Ready-to-Paste Stitch Prompt
```text
Design the executive "Dashboard" for Auto-Cuan Indonesian Equity Intelligence Workstation.

Design Philosophy:
- Continuous, calm financial desk (Light theme: #F3F5F4 background, #FFFFFF panels, hairline borders #E2E7E4, deep slate text #17211E).
- Strictly NO "card-wall" of isolated chunky boxes. Use a structured vertical hierarchy with continuous data bands.

Top Hero Area:
- Left: Inline metadata badge with green pulse dot "Bursa Buka · Sesi 2 (14:32 WIB)" + Amber badge "Konfirmasi manual wajib".
- Heading: "Halo, budi" (28px font-bold) with subtext "Pusat keputusan pasar modal IDX: pantauan momentum terukur, bukan rekomendasi beli otomatis."
- Right: Account status "Akun Terverifikasi" + button "API Key BYOK".

Market Condition Band (Horizontal continuous ribbon):
- Metric 1: "IDX Composite (IHSG)" -> "7.142,85" (+0,62% / +44,12 pt) with mini trend sparkline in positive green #247A43.
- Metric 2: "Market Breadth IDX" -> Visual segmented progress bar: "312 Menguat (52%)" | "218 Melemah (36%)" | "185 Flat (12%)" · Total Transaksi: Rp 11,8 T.
- Metric 3: "Saringan Gate Hari Ini" -> "8 Saham Lolos" dari 842 emiten terpindai.
- Metric 4: "Status Siklus Sektor" -> "Rotasi Masuk: Energi & Infrastruktur".

Primary Section: "Top 5 Radar Hari Ini" (Decision Rows):
- Header: Title "Top 5 Radar Hari Ini" with helper text "High-probability setup hasil konsensus teknikal & broker flow".
- Structured Decision List (Dense table/row format, height 44px per row, tabular-nums):
  * Row 1: Rank #1 | Ticker "BRPT" (Barito Pacific Tbk) | Group "Prajogo Pangestu" | Tier "Tier 1 · Swing Ready" | Exec "A+" | Harga "Rp 1.045" (+3,45%) | Vol/Avg "2,8x" | Plan: Entry 1.030-1.050, SL 995, TP1 1.120, R/R 1:1,7 | Action button "Riset ↗".
  * Row 2: Rank #2 | Ticker "MEDC" (Medco Energi Internasional) | Group "Panigoro" | Tier "Tier 1" | Exec "A+" | Harga "Rp 1.380" (+4,15%) | Vol/Avg "3,2x" | Plan: Entry 1.360-1.385, SL 1.310, TP1 1.480, R/R 1:1,8 | Action button "Riset ↗".
  * Row 3: Rank #3 | Ticker "BBCA" (Bank Central Asia) | Group "Djarum" | Tier "Tier 2 · Pullback" | Exec "A" | Harga "Rp 10.250" (+0,98%) | Vol/Avg "1,4x" | Plan: Entry 10.150-10.250, SL 9.950, TP1 10.600, R/R 1:1,5 | Action button "Riset ↗".
  * Row 4: Rank #4 | Ticker "ADRO" (Alamtri Resources) | Group "Boy Thohir" | Tier "Tier 2" | Exec "B" | Harga "Rp 3.720" (+1,64%) | Vol/Avg "1,1x" | Plan: Entry 3.680-3.720, SL 3.580, TP1 3.920, R/R 1:1,7 | Action button "Riset ↗".
  * Row 5: Rank #5 | Ticker "ASII" (Astra International) | Group "Astra" | Tier "Tier 2 · Rebound" | Exec "B" | Harga "Rp 5.150" (+0,49%) | Vol/Avg "0,9x" | Plan: Entry 5.100-5.150, SL 4.980, TP1 5.350, R/R 1:1,4 | Action button "Riset ↗".

Bottom History Section:
- Collapsible audit ledger "Top 5 Riwayat": Shows previous 5 days' locked candidates, tracking TP1 Hit (+7,5%), Breakeven, and Closed status with full transparency.
```

---

### 4.5 Screener 3-in-1 (Konglo, Non-Konglo, Day Trade + Detail Pane)

#### Current DOM Layout
- **Page Container:** `<div id="page-screener" class="page-content" data-premium-page="true" data-ac-ui="v2">`.
- **Header:** Title `"Screener Saham"`, subtitle `"Penyaring momentum saham otomatis: Swing Konglomerat, Swing Non-Konglo, dan Day Trade Momentum."`.
- **Mode Segmented Switcher (`.ac-segmented`):**
  - Segment 1: `Konglo` (`#scrTypeKonglo`)
  - Segment 2: `Non-Konglo` (`#scrTypeNonKonglo`)
  - Segment 3: `Day Trade` (`#scrTypeDayTrade`)
- **Quick Preset & Pattern Personality Filter Bar (`#patternFilterContainer`):**
  - Dropdown selector: `Semua pola`, `Aliran asing + harga di atas MA5 (WR 64.2%)`, `Akumulasi asing kuat (WR 61.2%)`, `Harga di atas MA20 (WR 60.6%)`, `Volume 1,2–1,5x`, dll.
  - Checkbox: `"Hanya Win Rate ≥ 60%"`.
- **Konglo Pane (`#screenerKongloPane`):**
  - Sub-filters: Ticker Search (`#kgTickerSearch`), Status filter (`Entry tersentuh`, `Masuk area entry`, `Menunggu pullback`, `Hindari`), Risk Profile filter (`Low`, `Medium`, `High`, `Very High`), Hide Very High checkbox (`#kgHideVeryHigh`).
  - View switcher: `Tabel` vs `Plan View (Card Grid)` + `Export PDF`.
  - Summary badges: Universe (840), Scanned (120), Published (19).
  - Main Table (`#screenerTableWrap`):
    * Columns: `Ticker`, `Group`, `Tier`, `Exec`, `Setup`, `Last`, `Chg%`, `RSI`, `Vol/Avg20`, `Timing`, `Arah`, `Catatan`.
    * Sticky First Column: Ticker.
- **Docked Desktop Detail Pane (`.ac-split-view__pane` / `#screenerDetailPane`):**
  - Width: 340px docked right.
  - Content: Selected Ticker (`BRPT`), Tier badge (`Tier 1`), Price Plan (Entry Range, Stop Loss, Target TP1, Target TP2, Risk/Reward Ratio), Volume Analysis, Risk Guard parameters, and primary button `"Buka Analisis Saham"`.
- **Non-Konglo Pane (`#screenerNonKongloPane`):**
  - Focused on Main & Development Board non-group tickers (e.g. `ACES`, `ERAA`, `MYOR`).
  - Columns include: `Ticker`, `Sektor`, `Tier`, `Exec`, `Setup`, `Price`, `Chg%`, `RSI14`, `Volume`, `Entry Plan`, `Risk`.
- **Day Trade Pane (`#screenerDayTradePane`):**
  - 22 Columns: `#`, `Ticker`, `Board`, `Status`, `Setup Score`, `Exec`, `Setup`, `Last`, `Chg%`, `Vol/Avg20`, `Tx Today`, `Pre-Spike`, `Momentum`, `Timing`, `Arah`, `Time Plan`, `Catatan`.
- **Mobile Detail Sheet (`#screenerMobileSheet`):** Slide-up bottom sheet with swipe handle for mobile touchscreens.

#### Ready-to-Paste Stitch Prompt
```text
Design the complete "Screener Saham" (Stock Screener Workstation) for Auto-Cuan.

Screen Layout:
- Workspace header with 3-segment switcher: [Konglo] [Non-Konglo] [Day Trade].
- Quick Filter Ribbon: Search ticker, Setup status (Semua, Area Entry, Tunggu Pullback), Pattern Filter ("Aliran Asing + MA5 · WR 64.2%"), checkbox "Win Rate ≥ 60%".
- Master-Detail Split Screen (Continuous layout):
  * Left / Main Area (75% width): High-density data table with sticky header and sticky first column.
  * Right Area (25% width, 340px): Docked "Trading Plan & Risk Detail Pane" updating live when any table row is clicked.

Table Specifications (Konglo Mode):
- Row height: 38px (Dense workstation format).
- Typography: Inter 12px, tabular-nums for numeric columns, right-aligned numbers.
- Columns:
  1. Ticker (Sticky, bold text, e.g. BRPT, BBCA, MEDC, ADRO, AMMN)
  2. Grup Konglomerasi (Badge: Prajogo Pangestu, Djarum, Panigoro, Salim)
  3. Tier (Pill: Tier 1, Tier 2)
  4. Exec (Quality badge: A+, A, B)
  5. Setup (Text: Breakout Pullback, Support Rebound, Momentum Contin.)
  6. Harga Terakhir (Rp 1.045, Rp 10.250, Rp 1.380)
  7. Perubahan Harian (+3,45% in #247A43, -1,20% in #C13F4D)
  8. RSI 14 (Numeric, e.g. 58,4)
  9. Rasio Volume 20D (e.g. 2,8x, 1,4x, 3,2x)
  10. Area Entry (Rp 1.030 - 1.050)
  11. Stop Loss (Rp 995)
  12. TP1 / TP2 (Rp 1.120 / Rp 1.180)
  13. R/R Ratio (1 : 1,7)

Docked Detail Pane (Right Side):
- Header: Ticker "BRPT" + Pill "Tier 1 · Exec A+" + Close "×".
- Price Plan Section:
  * Planned Entry: Rp 1.030 – Rp 1.050 (Current: Rp 1.045)
  * Stop Loss: Rp 995 (-4,78% · Risiko per lot: Rp 5.000)
  * Target Profit 1: Rp 1.120 (+7,18% · Potensi cuan: Rp 7.500/lot)
  * Target Profit 2: Rp 1.180 (+12,9%)
  * Risk/Reward: 1 : 1,67 (Memenuhi syarat minimal 1 : 1,5)
- Evidence Checklist:
  * [✓] Akumulasi broker top 3 positif (Net +Rp 14,2 M)
  * [✓] Volume perdagangan di atas rata-rata 20 hari (2,8x)
  * [✓] Di atas Exponential Moving Average 20 hari
- Bottom Action: Full-width solid emerald button "Buka Chart & Analisis AI ↗".
```

---

### 4.6 Sektor Hot (Group Konglomerat Hot)

#### Current DOM Layout
- **Page Container:** `<div id="page-sektor" class="page-content" data-premium-page="true" data-ac-ui="v2">`.
- **Header:** Title `"Grup Konglomerat Hot"`, subtitle `"T+1 · BY GROUP · Kinerja rata-rata per grup konglomerat besar. Klik grup untuk detail."`.
- **View Toggle (`.ac-segmented`):** `Tabel` (`#sektorBtnTable`) vs `Grid` (`#sektorBtnGrid`).
- **Main Sektor Groups Table (`#sektorGroupsTable`):**
  - Columns:
    1. `#`: Rank index (1 to 12).
    2. `Grup`: Group code (e.g. `PRAJOGO`, `SALIM`, `DJARUM`, `ASTRA`, `PANIGORO`, `BAKRIE`, `MNC`, `LIPPO`).
    3. `Nama Konglomerasi`: Full descriptive title (e.g. `Barito Pacific Group`, `Salim Group`, `Djarum Group`).
    4. `Saham`: Count of monitored constituents (e.g. `5`, `8`, `4`).
    5. `Rata-rata %`: Average group return today (e.g. `+2,84%`, `+1,15%`, `-0,42%`).
    6. `Top Saham`: Leading constituent ticker (e.g. `BRPT (+4,2%)`, `INDF (+1,8%)`, `BBCA (+0,9%)`).
    7. `Vol/Avg30`: Volume ratio relative to 30-day baseline (e.g. `2,1x`).
    8. `Aksi`: Detail trigger button `"Lihat"`.
- **Sektor Detail View (`#sektorDetailView`):**
  - Back button: `"← Sektor"`.
  - Header: Group name, aggregate market cap, average PE/PBV, and summary narrative.
  - Constituent Table (`#sektorDetailTable`): Breakdown of all individual stocks in that conglomerate with price, volume, broker flow, and trading signal.

#### Ready-to-Paste Stitch Prompt
```text
Design the "Sektor Hot (Grup Konglomerat Hot)" workstation interface for Auto-Cuan.

Context & Semantics:
- In the Indonesian stock market, tracking conglomerate groups (Barito, Salim, Astra, Djarum, Bakrie) gives vital institutional rotation signals.
- Tone: Factual institutional research screen in Canonical Light Theme (#F3F5F4 canvas, #FFFFFF tables).

Header Area:
- Title: "Grup Konglomerat Hot" with kicker "ROTASI INSTITUSI & KONGLOMERASI IDX".
- Subtitle: "Pemantauan performa harian dan perputaran modal di 12 grup konglomerasi terbesar bursa."
- Controls: Segmented switch [Tabel Klasemen] [Grid Heatmap], Search emiten/grup, Last Updated badge "T-1 · Penutupan Bursa Kemarin".

Master Table View (Default Spreadsheet-grade):
- Columns:
  1. Rank (#1 sampai #10)
  2. Kode Grup (Pills: PRAJOGO, SALIM, DJARUM, ASTRA, PANIGORO, BOY THOHIR)
  3. Nama Konglomerasi (Barito Pacific Group, Indofood / Salim Group, Djarum / BCA Group)
  4. Jumlah Saham (e.g. 5 saham, 9 saham)
  5. Rerata Perubahan (+3,42% green, +1,85% green, -0,65% red)
  6. Saham Penggerak Terkuat (BRPT +5,2%, ICBP +2,4%, BBCA +1,1%)
  7. Rasio Volume vs 30D (2,4x, 1,6x, 0,9x)
  8. Arah Aliran Institusi (Akumulasi Kuat, Netral, Distribusi Ringan)
  9. Tindakan (Button "Detail Grup →")

Drill-Down / Expanded State (When clicking a group row, e.g. "Barito Pacific Group"):
- Group Summary Strip:
  * Total Kapitalisasi Pasar: Rp 385,4 Triliun
  * Net Foreign Flow Hari Ini: +Rp 64,8 Miliar
  * Rerata PBV: 3,12x
- Constituent Stocks Table:
  * BRPT: Rp 1.045 (+3,45%) | Vol 2,8x | Bandar: Akumulasi Besar | Sinyal: Swing Ready
  * BREN: Rp 6.850 (+2,24%) | Vol 1,5x | Bandar: Akumulasi Normal | Sinyal: Hold
  * TPIA: Rp 7.200 (+0,70%) | Vol 0,8x | Bandar: Netral | Sinyal: Watchlist
  * PTRO: Rp 14.100 (+4,83%) | Vol 3,1x | Bandar: Akumulasi Kuat | Sinyal: Day Trade
  * CUAN: Rp 6.200 (-1,20%) | Vol 0,6x | Bandar: Distribusi Tipis | Sinyal: Hindari
```

---

### 4.7 Chart Workstation & Analisis AI (Unified AI Cockpit)

#### Current DOM Layout
- **Page Container:** `<div id="page-analisis" class="page-content" data-partial-loaded="true">` mounting [`public/partials/analisis-saham.partial.html`](public/partials/analisis-saham.partial.html:1).
- **Cockpit Top Search & Shared Ticker Context Bar (`.unified-top-bar`):**
  - Search input (`#analisisInput`): `Ketik ticker: BBCA, BBRI, TLKM...`.
  - Primary button (`#btnJalankanAnalisis`): `"Analisis Saham"`.
  - API Key button: `"API Key"`.
  - Active Ticker Context Badge: Ticker (`BBCA`), Company Name (`Bank Central Asia Tbk`), Sector (`Finansial`), Last Quote (`Rp 10.250 +100 (+0,98%)`).
  - Quick Ticker Chips: `IHSG`, `BBCA`, `BBRI`, `BMRI`, `TLKM`, `ASII`.
- **Multi-Lens Horizontal Sub-Navigation Strip (`#analisisLensesNav`):**
  - Lenses: `Chart & AI` (`#tabAnalisisChart`), `Bandarmologi` (`#tabBandarmologi`), `Broker Hunter` (`#tabBrokerHunter`), `Sinyal Intelijen` (`#tabSinyalIntelijen`), `Struktur Pasar` (`#tabMarketStructure`), `Financial` (`#tabFinancial`), `Insider` (`#tabJejaringInsider`), `Ranking` (`#tabRankingHarian`), `Pattern Radar` (`#tabAnalisisPattern`).
- **Sub-Tab Switcher (`#analisisChartSubtabWrap`):**
  - Switcher buttons: `Analisis AI` (`#tabAnalisisText`), `Chart Workstation` (`#tabChartWorkstationLens`), `Chart & AI Vision` (`#tabAnalisisVision`).
- **Mode 1: Analisis AI Result (`#panelAnalisisText` / `#subPanelAnalisisAI`):**
  - Two-column layout:
    * Left (Main): AI synthesis markdown output (`#analisisResult`) showing Summary, Evidence checklist, Technical levels, and Interactive Follow-up Composer (`#analisisFollowUp` / `#analysisChatInput`).
    * Right (Context): Key indicators strip (RSI 58,4, MACD bullish crossover, Support Rp 10.050, Resisten Rp 10.500, Foreign Net 7D +Rp 412 M).
- **Mode 2: Chart Workstation (`#panel-tab-chart`):**
  - Full-width TradingView-grade interactive candlestick canvas using Lightweight Charts 4.1.1.
  - Indicator overlays: Exponential Moving Averages (EMA 20, EMA 50, EMA 200), RSI panel below, Volume colored by net volume.
  - Trading Plan Price Lines (§19.3): Automatically draws horizontal price lines on the chart:
    * Entry Price (Sky blue line with axis label: `Entry Rp 10.250`)
    * Stop Loss (Rose red line with axis label: `SL Rp 9.950`)
    * Target 1 (Emerald green line with axis label: `TP1 Rp 10.600`)
    * Target 2 (Emerald green line with axis label: `TP2 Rp 11.000`)
  - Range Bar: `1D`, `1W`, `1M`, `3M`, `1Y`, `ALL`.

#### Ready-to-Paste Stitch Prompt
```text
Design the "Chart Workstation & Analisis AI Cockpit" for Auto-Cuan (Indonesian Stock Market Intelligence).

Layout Overview:
- Topbar: Shared ticker identity bar. Ticker "BBCA" (Bank Central Asia Tbk · Finansial), Last Price "Rp 10.250" (+0,98%), Quick chips for popular IDX tickers.
- Sub-navigation Lens Bar: Segmented horizontal pills for [Chart & AI Workstation], [Bandarmologi], [Broker Hunter], [Sinyal Intel], [Struktur Pasar], [Financial], [Insider].
- Dual-Mode Switcher: Clean toggle between [Chart Workstation] and [Analisis AI].

Mode A: Interactive Candlestick Chart Workstation:
- Main Candlestick Chart Area (Height 520px, dark-on-light or crisp clean workstation canvas):
  * Daily Japanese Candlestick series for BBCA showing recent uptrend.
  * Technical Overlays: EMA 20 (Cyan line), EMA 50 (Orange line), EMA 200 (Purple line).
  * Trading Plan Horizontal Price Lines (Drawn with explicit right-axis price labels):
    - Sky Blue line: "Entry Rp 10.250"
    - Crimson Red line: "Stop Loss Rp 9.950 (-2,93%)"
    - Emerald Green line: "TP1 Rp 10.600 (+3,41%)"
    - Emerald Green line: "TP2 Rp 11.000 (+7,32%)"
  * Sub-chart 1: Volume Histogram with institutional foreign flow coloring.
  * Sub-chart 2: RSI (14) indicator oscillating around 58.4 (Neutral-Bullish zone).
- Chart Header Controls: Timeframe selector (D, W, M), Indicator toggles (MA, Bollinger, RSI, CMF), Reset Zoom button.

Mode B: Analisis AI Result (Structured Research Synthesis):
- Clean 2-column continuous reading panel:
  * Left Column: Structured AI interpretation formatted as:
    1. "Rangkuman Eksekutif": BBCA berkonsolidasi sehat di atas support dinamis EMA 20 setelah akumulasi asing masif selama 3 sesi berturut-turut.
    2. "Bukti Pendukung Transaksi":
       - Asing mencatatkan net buy Rp 185 Miliar pada perdagangan hari ini.
       - Broker ZP dan CC menguasai 42% volume pembelian dengan harga rata-rata Rp 10.230.
    3. "Level Rencana & Manajemen Risiko": Entry ideal 10.150–10.250. Wajib cut loss jika closing harian menembus ke bawah 9.950.
    4. "Hal yang Perlu Dipantau": Rilis laporan keuangan kuartalan dan arah suku bunga BI-Rate minggu depan.
  * Interactive AI Chat Composer at bottom: Input "Tanya lanjutan mengenai BBCA: apakah aman avg down jika koreksi ke 10.100?" + Send button.
  * Right Column: Metric Fact Sheet (PBV 4,32x, Free Float 41,82%, 52W High Rp 10.450, 52W Low Rp 8.700).
```

---

### 4.8 Bandarmologi & Broker Hunter

#### Current DOM Layout
- **Page Container:** Rendered inside `#page-analisis` as `#panel-tab-bandarmologi` and `#panel-tab-hunter`.
- **Bandarmologi Sub-tabs:** Switcher between `Broker Summary` (`#subTabBrokerSummary`) and `Akumulasi Broker` (`#subTabAkumulasiBroker`).
- **Broker Summary View:**
  - Date & Ticker Selector: Date picker (default `2026-09-25`), Ticker (`BBCA`).
  - Institutional Verdict Banner: Status pill (`BIG ACCUMULATION` in emerald), Action (`BUY`), Score (`92/100`), Volume Ratio (`2,8x`), Net Foreign (`+Rp 185,0 M`), Net Bandar (`+Rp 245,0 M`).
  - Two-Column Orderflow Split:
    * Left: `Top Buyers (Pembeli Terbesar)` Table. Columns: `Broker` (ZP, CC, AK), `Nama Sekuritas` (Maybank, Mandiri, UBS), `Volume (Lot)`, `Nilai (Rp)`, `Harga Rerata (Avg)`.
    * Right: `Top Sellers (Penjual Terbesar)` Table. Columns: `Broker` (YP, PD, NI), `Nama Sekuritas` (Mirae Asset, Indo Premier, BNI), `Volume (Lot)`, `Nilai (Rp)`, `Harga Rerata (Avg)`.
- **Akumulasi Broker View:**
  - Aggregated 1-Day, 3-Day, 5-Day, and 20-Day accumulation delta tables and bubble flow visualization.
- **Broker Hunter View (`#panel-tab-hunter`):**
  - Primary Identity: Broker selector dropdown (`ZP - Maybank Sekuritas`, `CC - Mandiri Sekuritas`, `AK - UBS Sekuritas`, `YP - Mirae Asset`).
  - Period selector: `1 Hari`, `3 Hari`, `1 Minggu`, `1 Bulan`.
  - Output Table: Top 10 Stocks bought/sold by that specific broker, showing `Ticker`, `Nama Emiten`, `Total Nilai Beli`, `Total Nilai Jual`, `Net Flow (Rp)`, `Harga Rerata Beli`.

#### Ready-to-Paste Stitch Prompt
```text
Design the "Bandarmologi & Broker Hunter" institutional orderflow analysis interface for Auto-Cuan.

Visual Tone & Layout:
- Theme: Calm financial research workstation (Light palette: Canvas #F3F5F4, Surface #FFFFFF, Hairline borders #E2E7E4).
- Structure: Two-column split comparing Institutional Buyers vs Institutional Sellers, preceded by a master accumulation score strip.

Section 1: Bandarmologi Cockpit (Ticker: BBCA):
- Header Bar: Ticker "BBCA", Date Picker "25 Sep 2026", button "Hitung Ulang Flow".
- Accumulation Score Strip:
  * Verdict Badge: Dark emerald pill "BIG ACCUMULATION (Skor 92/100)".
  * Net Bandar Value: "+Rp 245,0 Miliar" in green #247A43.
  * Net Foreign Value: "+Rp 185,0 Miliar" (Asing Net Buy).
  * Konsentrasi Top 3 Buyer: "68,4% (Sangat Terkonsentrasi)".
- Side-by-Side Orderflow Tables (Height 320px, dense tabular figures):
  * Left Table: "TOP BUYERS (Pembeli Terbesar)"
    Columns: Broker | Nama Sekuritas | Volume (Lot) | Total Nilai (Rp) | Harga Rata-rata
    - Row 1: ZP | Maybank Sekuritas | 85.000 lot | Rp 87,1 M | Rp 10.250
    - Row 2: CC | Mandiri Sekuritas | 62.000 lot | Rp 63,4 M | Rp 10.230
    - Row 3: AK | UBS Sekuritas | 51.000 lot | Rp 52,3 M | Rp 10.250
    - Row 4: BK | J.P. Morgan Sekuritas | 34.000 lot | Rp 34,8 M | Rp 10.240
  * Right Table: "TOP SELLERS (Penjual Terbesar)"
    Columns: Broker | Nama Sekuritas | Volume (Lot) | Total Nilai (Rp) | Harga Rata-rata
    - Row 1: YP | Mirae Asset Sekuritas | 38.000 lot | Rp 38,9 M | Rp 10.240
    - Row 2: PD | Indo Premier Sekuritas | 29.000 lot | Rp 29,7 M | Rp 10.240
    - Row 3: XC | Ajaib Sekuritas | 22.000 lot | Rp 22,5 M | Rp 10.235
    - Row 4: XL | Stockbit Sekuritas | 18.000 lot | Rp 18,4 M | Rp 10.250

Section 2: Broker Hunter (Investigasi Jejak Broker Tertentu):
- Broker Selector Dropdown: "ZP - PT Maybank Sekuritas Indonesia (Asing/Campuran)".
- Lookback Range: "5 Hari Perdagangan Terakhir".
- Result Table (Top 5 Saham yang Sedang Dikoleksi ZP):
  1. BBCA: Net Buy Rp 184,2 M | Harga Avg Rp 10.220 | Status: Akumulasi Aktif
  2. BMRI: Net Buy Rp 92,5 M | Harga Avg Rp 6.850 | Status: Akumulasi Aktif
  3. ASII: Net Buy Rp 41,0 M | Harga Avg Rp 5.120 | Status: Buy on Weakness
  4. TLKM: Net Sell -Rp 18,4 M | Harga Avg Rp 2.940 | Status: Distribusi Ringan
```

---

### 4.9 Sinyal Intelijen & Insider Network

#### Current DOM Layout
- **Page Container:** `#panel-tab-intel` and `#panel-tab-insider` in [`public/partials/analisis-saham.partial.html`](public/partials/analisis-saham.partial.html:1).
- **Sinyal Intelijen (Evidence Board):**
  - Ticker context search (`#intelSearchInput`).
  - Master Signal Card: Primary recommendation (`SWING ACCUMULATION READY`), Probability (`Tinggi`), Freshness timestamp.
  - Multi-Pillar Evidence Grid (4 evidentiary cards):
    1. `Pilar 1: Anomali Volume & Transaksi`: Volume 2,8x vs 20D average, Transaction frequency spike at support.
    2. `Pilar 2: Aliran Dana Asing (Foreign Flow)`: Net foreign buy 3 days consecutive, parabolic flow inflection.
    3. `Pilar 3: Struktur Kepemilikan & Free Float`: Free Float 41,82%, tidak ada pengendalian HSC bermasalah.
    4. `Pilar 4: Konfluensi Teknikal`: Candle Bullish Engulfing di MA20, RSI 58 keluar dari oversold.
- **Insider Network (`#panel-tab-insider`):**
  - Search input: Ticker or Person/Entity name.
  - Visual Network Graph (`#insiderNetworkGraph`): Interactive relationship map connecting directors, commissioners, controlling shareholders, and cross-owned listed companies (e.g. Robert Budi Hartono connecting BBCA, TOWR, BELI).
  - Shareholder Roster Table:
    * Columns: `Nama Pemilik / Afiliasi`, `Kategori (Pengendali / Direksi / Publik)`, `Jumlah Lembar Saham`, `Persentase (%)`, `Perubahan Terakhir`.

#### Ready-to-Paste Stitch Prompt
```text
Design the "Sinyal Intelijen & Insider Network" research surface for Auto-Cuan equities workstation.

Visual System:
- Theme: Editorial financial intelligence (Canonical Light: Canvas #F3F5F4, Surface #FFFFFF, Hairlines #E2E7E4, Brand Emerald #0F7458).
- Typography: Inter with clean hierarchy and tabular figures.

Module 1: Sinyal Intelijen (Evidence Board - Ticker: BBCA):
- Status Strip:
  * Signal Verdict: "KONFLUENSI AKUMULASI TINGGI" with green badge "Validitas: 4/4 Bukti Konfirmasi".
  * Summary: "Terdeteksi dorongan beli simultan antara aliran dana asing, konsentrasi broker institusi, dan rebound teknikal di atas moving average."
- 4-Column Evidence Matrix (Continuous bordered panel):
  * Box A: "1. Aliran Asing (Foreign Flow)" -> Net Buy 3D berturut-turut total Rp 412 Miliar. Asing menyerap 64% total volume transaksi.
  * Box B: "2. Deteksi Broker Bandar" -> Top 3 broker (ZP, CC, AK) melakukan akumulasi bersih tanpa perlawanan distribusi retail.
  * Box C: "3. Struktur Penawaran (Supply)" -> Tekanan jual di orderbook tipis di bawah Rp 10.400. Free float terkunci 41,82%.
  * Box D: "4. Indikator Teknikal" -> Breakout garis tren minor, RSI 58,4 (momentum positif tanpa overbought).

Module 2: Insider Network (Peta Relasi Pemegang Saham & Orang Dalam):
- Header: Title "Jejaring Afiliasi & Transaksi Orang Dalam (BBCA)" with search entity input.
- Split View:
  * Left Side (Interactive Relationship Node Graph preview, height 360px):
    - Central Node: "PT Bank Central Asia Tbk (BBCA)"
    - Connected Parent Node: "PT Dwimuria Investama Andalan (54,94%)"
    - Ultimate Beneficiary Nodes: "Robert Budi Hartono" and "Michael Bambang Hartono"
    - Cross-links to other IDX entities: "TOWR (Sarana Menara)" & "BELI (Global Digital Niaga)".
  * Right Side (Tabel Pemegang Saham Terdaftar):
    Columns: Nama Pemegang Saham | Hubungan | Jumlah Saham | Kepemilikan (%)
    - PT Dwimuria Investama Andalan | Pengendali | 67.729.832.500 lembar | 54,94%
    - Publik (Free Float Wajar) | Investor Publik | 51.528.167.500 lembar | 41,82%
    - Jahja Setiaatmadja | Presiden Direktur | 40.811.211 lembar | 0,03%
    - Armand Wahyudi Hartono | Wakil Presdir | 19.852.300 lembar | 0,02%
```

---

### 4.10 Financial & Struktur Pasar

#### Current DOM Layout
- **Page Container:** `#panel-tab-financial` and `#panel-tab-market-structure` in [`public/partials/analisis-saham.partial.html`](public/partials/analisis-saham.partial.html:1).
- **Financial (Verified Snapshot Contract §79.2):**
  - Ticker context: `BBCA`.
  - 4 Core Fundamental Metric Tiles (Continuous strip, no empty giant canvas):
    1. `PBV (Price to Book Value)`: `4,32x` (Benchmark industri perbankan: 1,85x).
    2. `BVPS (Book Value Per Share)`: `Rp 2.372`.
    3. `Market Cap`: `Rp 1.263,5 Triliun` (Rank #1 IDX).
    4. `Saham Beredar`: `123,2 Miliar lembar`.
  - Provenance & Trust Row: `Periode: Q2 2026 Terverifikasi · Sumber Fundamental: IDX Financial Statement · Diperbarui: 15 Okt 2026 WIB`.
  - Historical Valuation Table: PBV standard deviation bands (-1 SD, Mean, +1 SD).
- **Struktur Pasar (Universe List-First Contract §79.3):**
  - Search & Filters: Search input (`#marketStructureSearchInput`), Sector filter, Quick filters: `[Semua] [FF Rendah <15%] [HSC Aktif] [Data Belum Lengkap]`.
  - Universe List Table (`#marketStructureTable`):
    * Columns: `Kode`, `Emiten`, `Sektor`, `Free Float %`, `Status HSC`, `Pemegang Saham Terbesar`, `Kelengkapan`, `As-of`.
    * Sample Rows:
      - `BBCA` | Bank Central Asia | Finansial | `41,82%` | `— (HSC Belum Diketahui)` | PT Dwimuria Investama (54,94%) | Lengkap | 31 Agu 2026
      - `BREN` | Barito Renewables | Infrastruktur | `11,73%` | `HSC Waspada (<15%)` | PT Barito Pacific (64,67%) | Lengkap | 31 Agu 2026
  - Docked Desktop Detail Pane (`#marketStructureDetailPane`):
    * Free Float percentage with Low Free Float threshold benchmark (`<15%`).
    * HSC (High Shareholder Concentration) audit risk verdict.
    * Shareholder roster breakdown table (Owner, Category, Lots, %).

#### Ready-to-Paste Stitch Prompt
```text
Design the "Financial & Struktur Pasar (Market Structure)" evidence screens for Auto-Cuan IDX Workstation.

Design Directives:
- Adhere strictly to DESIGN.md §79.2 (Verified Financial Snapshot) and §79.3 (Universe List-First Struktur Pasar).
- Tone: Institutional audit desk, high density, transparent data provenance. Light theme with hairlines #E2E7E4 and tabular numbers.

Module 1: Financial (Verified Snapshot - Ticker: BBCA):
- Ticker Header: "BBCA - Bank Central Asia Tbk" | Sektor: "Perbankan / Finansial".
- Verified Snapshot Ribbon (4 continuous flat tiles with hairline separators):
  * PBV (Price-to-Book): "4,32x" (Rerata 5 Tahun: 4,10x)
  * BVPS (Nilai Buku per Saham): "Rp 2.372"
  * Kapitalisasi Pasar: "Rp 1.263,5 Triliun" (#1 IHSG)
  * Total Lembar Beredar: "123,2 Miliar Lembar"
- Data Provenance Row (Plain aligned metadata in secondary ink):
  "Laporan Keuangan: Q2 2026 (Audited) · Sumber Data: KSEI & Keterbukaan IDX · Terakhir Diverifikasi: 15 Okt 2026 WIB"
- Financial Valuation Comparison:
  * Table comparing BBCA against peers (BBRI PBV 2,15x, BMRI PBV 1,42x, BBNI PBV 1,18x).

Module 2: Struktur Pasar (Universe Table + Docked Detail Pane):
- Header Bar: Title "Struktur Pasar IDX" with subtitle "Audit Free Float, konsentrasi pengendali (HSC), dan risiko likuiditas emiten."
- Filter Controls:
  * Search bar: "Cari ticker atau nama pemegang saham..."
  * Filter chips: [Semua Emiten (842)] [Free Float Rendah <15% (48)] [HSC Terdeteksi (29)] [Data Belum Lengkap (12)]
- Master Table (Table-First, height 400px, scrollable):
  Columns: Ticker | Nama Emiten | Sektor | Free Float (%) | Status HSC | Pemegang Saham Pengendali | As-of
  - BBCA | Bank Central Asia Tbk | Finansial | 41,82% | Normal | PT Dwimuria Investama (54,94%) | 31 Agu 2026
  - BBRI | Bank Rakyat Indonesia Tbk | Finansial | 46,75% | Normal | Negara Republik Indonesia (53,19%) | 31 Agu 2026
  - BREN | Barito Renewables Energy | Energi | 11,73% | Waspada (<15%) | PT Barito Pacific Tbk (64,67%) | 31 Agu 2026
  - AMMN | Amman Mineral Internasional | Tambang | 17,20% | Pantau | PT Sumber Gemilang (32,44%) | 31 Agu 2026
- Docked Detail Pane for Selected Row (BREN):
  * Ticker "BREN" with Amber Warning Badge "Free Float < 15%".
  * Free Float: 11,73% (Di bawah batas rekomendasi likuiditas wajar 15%).
  * Evaluasi HSC: 3 pemegang saham teratas menguasai 84,2% total lembar saham.
  * Catatan Risiko: "Risiko volatilitas tinggi akibat peredaran saham di publik terbatas."
  * Action: "Buka Analisis Saham BREN ↗".
```

---

### 4.11 Ranking Harian (Market Ranking Spreadsheet)

#### Current DOM Layout
- **Page Container:** `#panel-tab-ranking` in [`public/partials/analisis-saham.partial.html`](public/partials/analisis-saham.partial.html:1).
- **Header:** Title `"Ranking Harian Pasar"`, subtitle `"Klasemen saham teraktif, momentum RSI, dan akumulasi institusi harian."`.
- **Search & Quick Ticker Selector:** Inputs `#rankingTickerSearchInput` and `#rankingSearchInput`.
- **Ranking Matrix Table (`#rankingTableWrap`):**
  - Spreadsheet-grade table styling (compact rows 38px, sticky header).
  - Columns:
    1. `#`: Rank position (1 to 50+).
    2. `Ticker`: Stock code.
    3. `Harga`: Last close price.
    4. `RSI 14`: Relative Strength Index with directional badge.
    5. `Jarak 52W High`: Distance to 52-week peak (`-2,4%`, `-18,5%`).
    6. `Vol vs 7D`: Volume ratio relative to 7-day average (`2,8x`, `1,2x`).
    7. `Foreign Terakhir`: Net foreign flow for latest session (`+Rp 185 M`, `-Rp 24 M`).
    8. `Foreign 3D`: 3-day accumulated foreign flow.
    9. `Foreign 7D`: 7-day accumulated foreign flow.
    10. `Skor Ranking`: Computed algorithmic composite score (0–100).
    11. `Tindakan`: Detail button.

#### Ready-to-Paste Stitch Prompt
```text
Design the "Ranking Harian (Market Spreadsheet Matrix)" interface for Auto-Cuan.

Visual Tone & Layout:
- Pure spreadsheet-grade data workstation: compact row height (38px), fixed column widths, sticky dark header, tabular numbers, zero decorative illustration.
- Theme: Canonical Light Theme (Background #F3F5F4, Table Surface #FFFFFF, Hairlines #E2E7E4, Deep Ink #17211E).

Header Controls:
- Page Title: "Ranking Harian Pasar Modal IDX" (20px font-bold).
- Subtitle: "Klasemen kuantitatif seluruh emiten aktif berdasarkan volume, momentum harga, dan arus modal."
- Toolbar: Search input "Filter saham...", Metric selector (Semua, Top Gainers, Top Foreign Buy, RSI Rebound), and "Ekspor Excel / CSV".

Spreadsheet Matrix Table (10 Columns, 10 visible sample rows):
Columns:
1. # (Rank number: 1, 2, 3...)
2. Ticker (Bold ticker link: BBCA, MEDC, BRPT, BBNI, ADRO, TLKM, ASII, BMRI, AMMN, PGAS)
3. Harga Terakhir (Rp 10.250, Rp 1.380, Rp 1.045, Rp 5.450, Rp 3.720...)
4. Chg % (+0,98%, +4,15%, +3,45%, +2,35%, +1,64%...)
5. RSI (14) (58,4, 66,2, 62,8, 54,1, 48,9...)
6. Jarak ke 52W High (-1,92%, -0,72%, -4,55%, -8,12%, -12,4%...)
7. Vol vs 7D Rata-rata (1,4x, 3,2x, 2,8x, 1,9x, 1,1x...)
8. Net Foreign Hari Ini (+Rp 185,0 M, +Rp 42,1 M, +Rp 64,8 M, +Rp 28,5 M...)
9. Net Foreign 3 Hari (+Rp 412,5 M, +Rp 89,4 M, +Rp 112,0 M, +Rp 54,2 M...)
10. Skor Momentum (Composite 0-100: 94, 91, 88, 85, 82...)

Interactive States:
- Hover row state with subtle background tint #EEF2F0.
- Clicking any row smoothly pins a bottom mini-summary preview showing stock profile and link to Chart Workstation.
```

---

### 4.12 Monitoring Suite (Watchlist, Portfolio Command Center, Track Record)

#### Current DOM Layout
- **Watchlist (`#page-watchlist`):**
  - Provenance: `Lensa Monitor: Watchlist & Alert Pribadi`.
  - Header with `Riwayat Alert` modal trigger and `Refresh` button.
  - Continuous Summary Strip (`#watchlistSummaryStrip`): Total Saham Dipantau (`12 Saham`), Alert Harga Aktif (`3 Alert Menunggu Trigger`).
  - Table Filter Bar: `Semua`, `Ada Alert`, `Naik Hari Ini`, `Turun Hari Ini`.
  - Table: `Ticker`, `Nama Emiten`, `Harga`, `Perubahan`, `Target Beli/Alert`, `Status Alert`, `Tindakan`.
- **Portfolio Command Center (`#page-portofolio` mounting [`public/partials/portfolio-command-center.partial.html`](public/partials/portfolio-command-center.partial.html:1)):**
  - Navigation Tab Strip (`#tabStrip`):
    1. `Hari Ini (Overview)` (`#page-today`): Decision hero (`"Bangun rencana yang jelas sebelum mengambil posisi"`), metric grid (Rencana/posisi, Perlu perhatian, Total eksposur Rp 27,4 M, Estimasi risiko), cards for `Tindakan Hari Ini`, `Apa yang Berubah? (Snapshot)`, `Kualitas Data`, and `Sektor Hot Setelah Close`.
    2. `Rencana Posisi (Planner)` (`#page-planner`): Budget-to-Stock Planner (Modal, Risk profile, Dana cadangan, Max posisi) + Rencana Posisi Manual (Entry, SL, TP1, TP2, kalkulasi lot dan alokasi).
    3. `Pantauan (Positions/Watch)` (`#page-watch`): Active positions table (`Ticker`, `Status`, `Lot`, `Entry`, `Harga`, `P/L`, `Stop`, `TP1 / TP2`, `Aksi`).
    4. `Risiko & Avg Down (Risk Lab)` (`#page-risk`): Cut Loss & Average Down Guard calculator, evaluating mathematical guard thresholds before averaging down.
    5. `Skenario Posisi` (`#page-scenarios`): Profit/loss scenario table under TP1, TP2, and trailing stop triggers.
    6. `Jurnal (Trading Journal)` (`#page-journal`): Personal trading diary recording entry reason, emotional state, discipline adherence, and post-trade review.
    7. `Asisten AI Portofolio` (`#page-ai`): AI portfolio audit diagnosing sector concentration, aggregate risk exposure, and stop loss vulnerability.
- **Track Record (`#page-trackrecord`):**
  - Provenance: `Lensa Audit: Audit Sinyal Sistem · Evaluasi Berbasis Aturan`.
  - Continuous Summary Strip: Total Sinyal (142), Sinyal Selesai (128), Win Rate Terverifikasi (68,4%), Profit Factor (2,14), Sinyal Aktif (14).
  - Outcome Audit Ledger Table: Transparent chronological record of all signals generated by Auto-Cuan algorithms with exact entry date, exit date, achieved price, and outcome category (`TP1 HIT`, `TP2 HIT`, `STOPPED OUT`, `EXPIRED`).

#### Ready-to-Paste Stitch Prompt
```text
Design the unified "Monitoring & Portfolio Command Center" suite for Auto-Cuan equities workstation.

Visual System:
- Theme: Calm, serious, institutional (Light Theme: #F3F5F4 background, #FFFFFF continuous work area, hairline borders #E2E7E4, deep charcoal ink #17211E).
- Tabular figures for all portfolio balances, position counts, and profit/loss amounts.

Tab Navigation Strip:
[Hari Ini (Overview)] [Rencana Posisi] [Posisi Aktif] [Risk Lab & Avg Down] [Skenario] [Jurnal] [Asisten AI]

Panel 1: "Hari Ini (Decision Cockpit Overview)":
- Decision Banner: "Bangun rencana yang jelas sebelum mengambil posisi." Subtext: "Command Center membaca data rencana lokal mandiri. Tidak melakukan eksekusi broker otomatis."
- Metric Strip (4 flat continuous tiles):
  * Total Portofolio: Rp 124.500.000
  * Eksposur Berjalan: Rp 48.200.000 (38,7% alokasi)
  * Unrealized P/L: +Rp 3.420.000 (+7,09%) in green #247A43
  * Risiko Terbuka (Max Risk to SL): Rp 1.450.000 (1,16% modal total)
- 2-Column Dashboard Grid:
  * Left: "Tindakan Hari Ini": Alert card for MEDC (Mendekati area TP1 di Rp 1.480) & BRPT (Trailing stop dinaikkan ke Rp 1.020).
  * Right: "Kualitas Data & Kesiapan": 4/4 harga terverifikasi live, update 15:42 WIB.

Panel 2: "Rencana Posisi (Position Planner)":
- Form "Kalkulator Ukuran Posisi & Batas Risiko":
  * Inputs: Modal Alokasi (Rp 50.000.000), Toleransi Risiko (1% = Rp 500.000), Ticker (BRPT), Harga Beli (Rp 1.045), Stop Loss (Rp 995).
  * Output Calculation Card:
    - Ukuran Posisi Maksimal: 100 Lot (10.000 lembar)
    - Total Modal Dibutuhkan: Rp 10.450.000
    - Estimasi Kerugian jika Kena SL: -Rp 500.000 (-4,78%)
    - Potensi Cuan di TP1 (Rp 1.120): +Rp 750.000 (+7,18%)
    - Rasio Risk/Reward: 1 : 1,50 (Lolos Batas Keamanan)

Panel 3: "Posisi Aktif (Active Holdings Ledger)":
- High-density table:
  Columns: Ticker | Lot | Harga Beli | Harga Saat Ini | Nilai Posisi | P/L (Rp) | P/L (%) | Stop Loss | Target 1 | Aksi
  - BRPT | 100 lot | Rp 1.010 | Rp 1.045 | Rp 10.450.000 | +Rp 350.000 | +3,47% | Rp 995 | Rp 1.120 | [Ubah Plan]
  - MEDC | 80 lot | Rp 1.325 | Rp 1.380 | Rp 11.040.000 | +Rp 440.000 | +3,98% | Rp 1.310 | Rp 1.480 | [Ubah Plan]
  - BBCA | 20 lot | Rp 10.150 | Rp 10.250 | Rp 20.500.000 | +Rp 200.000 | +0,98% | Rp 9.950 | Rp 10.600 | [Ubah Plan]

Panel 4: "Audit Track Record Sinyal Sistem":
- Transparent performance ledger: Total Sinyal Selesai (142), Win Rate (68,4%), Profit Factor (2,14). Chronological audit rows with exact entry, exit, duration, and verified result tags (TP1 HIT, TP2 HIT, SL HIT).
```

---

### 4.13 Kelola Keuangan / Personal Money Management (Reconstructed Specification)

#### Current DOM Layout
- **Page Container:** `<section id="page-money-management" class="page-content money-sheet" data-premium-page="true">` from [`public/partials/money-management.partial.html`](public/partials/money-management.partial.html:1).
- **Header:**
  - Eyebrow: `"KEUANGAN PRIBADI"`.
  - Title: `"Kelola Keuangan"`.
  - Subtitle: `"Anggaran bulanan yang bisa Anda atur. Portofolio terhubung, tanpa pencatatan ganda."`.
  - Control: Month selector `<input id="mmSheetMonth" type="month">`.
- **Overview Metric Strip (`.ms-overview`):**
  - 4 tiles: `Pemasukan` (`Rp 34.500.000`), `Pengeluaran` (`Rp 16.500.000`), `Tabungan & transfer` (`Rp 18.000.000`), `Sisa anggaran` (`Rp 13.000.000`).
- **Linked Portfolio Card (`.ms-portfolio`):**
  - Icon + `"Portofolio terhubung"` status (`"Tersinkron · 4 posisi"`).
  - Metric 1: `"Eksposur rencana"` (`Rp 27.400.000`).
  - Metric 2: `"P/L dari harga tersimpan"` (`+Rp 1.845.000`).
  - Button: `"Buka Portofolio ↗"`.
- **Spreadsheet Workbook Section (`.ms-workbook`):**
  - Header: `"Anggaran bulanan"` + Save state badge (`"Tersimpan 17:04 WIB"`).
  - Main Toolbar (`.ms-toolbar`):
    * Button `+ Tambah baris` (`#mmAddRow`).
    * Undo & Redo buttons (`#mmUndo`, `#mmRedo`).
    * Search input (`#mmSheetSearch`).
    * Sort dropdown (`#mmSheetSort`: Urutan asli, Nominal terbesar, Nama A–Z).
    * Button `Ekspor CSV` (`#mmExport`).
    * Button `Muat ulang` (`#mmReload`).
    * Primary Button `Simpan` (`#mmBtnSaveCashflow`).
  - Cell Edit Toolbar (`.ms-edit-toolbar`):
    * `Salin`, `Kosongkan sel`, `Isi ke bawah`, `Sisipkan baris`, `Hapus baris`.
  - Formula Bar (`.ms-formula-bar`):
    * Cell Address (`#mmCellAddress` e.g. `D4`).
    * Formula symbol `fx`.
    * Formula Input (`#mmFormulaInput` supporting `=SUM(D1:D3)`, `=ROUND(D1*0.1)`).
  - Collapsible Shortcuts Help (`.ms-help`).
  - Spreadsheet Grid (`#mmCashflowSpreadsheetTable` inside `#mmSheetViewport`):
    * Columns: `#`, `A Jenis`, `B Kategori`, `C Nama pos`, `D Nominal (Rp)`, `E Catatan`, `Tindakan`.
    * Rows: Salary, side projects, rent, groceries, living, emergency fund, and trading capital allocation.
  - Status & Notes: Row count, active selection stats, and Monthly Reflection textarea (`#mmCashflowNotes`).

#### Ready-to-Paste Stitch Prompt
```text
Design the "Kelola Keuangan (Personal Cashflow & Portfolio-Linked Spreadsheet)" interface for Auto-Cuan.

Context:
- A specialized financial workspace bridging personal cashflow budgeting with active stock market allocation without double-entry confusion.
- Theme: Clean spreadsheet aesthetic in Canonical Light Theme (#F3F5F4 canvas, #FFFFFF tables, #E2E7E4 borders, #0F7458 emerald accents).

Header & Month Switcher:
- Eyebrow: "KEUANGAN PRIBADI & ALOKASI TRADING"
- Main Title: "Kelola Keuangan Bulanan"
- Subtitle: "Atur arus kas bulanan, alokasi modal investasi saham, dan pantau sinkronisasi portofolio dalam satu lembar kerja."
- Control: Month Picker dropdown "Oktober 2026".

Continuous Overview Metric Strip (4 Aligned Data Tiles):
1. "Total Pemasukan": Rp 34.500.000 (Gaji pokok & dividen)
2. "Pengeluaran Rutin": Rp 16.500.000 (Kebutuhan & gaya hidup)
3. "Tabungan & Investasi": Rp 18.000.000 (Dana darurat & modal trading)
4. "Sisa Anggaran Bersih": Rp 13.000.000 (Surplus siap alokasi)

Linked Portfolio Summary Banner:
- Card with soft emerald tint and brief icon: "Portofolio Auto-Cuan Terhubung (Tersinkron · 4 Posisi Aktif)".
- Displays: "Eksposur Modal Saham: Rp 27.400.000" | "Unrealized P/L Tersimpan: +Rp 1.845.000 (+6,7%)".
- Button: "Buka Portofolio Command Center ↗".
- Note: "Nilai aset saham tidak tercampur otomatis dengan kas bulanan untuk menjaga kepatuhan disiplin anggaran."

Excel-Grade Cashflow Spreadsheet Workbook:
- Formula Bar (Top of table):
  * Active Cell Address Box: [ D4 ]
  * Function symbol: [ fx ]
  * Formula input line: "=SUM(D1:D3)"
- Spreadsheet Action Toolbar:
  * [+ Tambah Baris] | [↶ Urungkan] [↷ Ulangi] | [🔍 Cari pos anggaran...] | [Urutkan: Nominal Terbesar] | [Salin Sel] [Isi ke Bawah] | [Ekspor CSV] [Simpan Perubahan (Primary Emerald)]
- Spreadsheet Grid Table (Numbered Rows & Lettered Columns):
  Columns:
  #  | A Jenis        | B Kategori       | C Nama Pos Anggaran        | D Nominal (Rp)      | E Catatan
  1  | Pemasukan      | Gaji Pokok       | Gaji Bulanan Kantor        | Rp 25.000.000       | Transfer tanggal 25
  2  | Pemasukan      | Bisnis/Sampingan | Proyek Konsultasi Ritel    | Rp 7.500.000        | Klien freelance
  3  | Pemasukan      | Dividen Saham    | Dividen Interim BBCA & BBRI| Rp 2.000.000        | Masuk RDN
  4  | Pengeluaran    | Kebutuhan Pokok  | Sewa Tempat Tinggal & PLN  | Rp 6.500.000        | Rutin awal bulan
  5  | Pengeluaran    | Kebutuhan Pokok  | Belanja Rumah Tangga       | Rp 5.500.000        | Supermarket & makan
  6  | Pengeluaran    | Gaya Hidup       | Langganan Internet & Hibur | Rp 4.500.000        | Streaming & gym
  7  | Tabungan       | Dana Darurat     | Setoran Rekening Khusus    | Rp 5.000.000        | Target 6x pengeluaran
  8  | Alokasi Modal  | Saham IDX        | Alokasi Tambahan Modal RDN | Rp 13.000.000       | Transfer ke akun sekuritas
- Grid Footer:
  * Status text: "8 baris anggaran terisi · Total akumulasi: Rp 69.000.000"
  * Monthly Reflection Note: Text box "Catatan Keuangan Bulan Ini: Alokasi modal trading 37,7% dari total surplus; disiplin tidak menambah risiko."
```

---

### 4.14 Pattern Radar & Subscription Gate

#### Current DOM Layout
- **Pattern Radar (`#tabAnalisisPattern` / `#panel-tab-pattern`):**
  - Visibility: Restricted to `ADMIN` (budi).
  - Header: `"Pattern Radar (Admin Only)"` with algorithm status `"Mesin Deteksi Pola Harmonik & Fibonacci"`.
  - Parameter controls: Lookback window (50–500 bars), Tolerance percentage (1%–5%), Pattern types (`Double Bottom`, `Cup & Handle`, `ABCD Harmonic`, `Bullish Flag`).
  - Results Table: `Ticker`, `Pola`, `Tingkat Kemiripan (Similarity %)`, `Konfirmasi Breakout`, `Target Proyeksi`, `Status Evaluasi`.
- **Subscription Modal & Paywall Gate (`#subscriptionModal` / `#page-subscription`):**
  - Standalone Dormant Page / Modal triggered by `#nav-subscription`.
  - Header: `"Paket & Hak Akses Akun Auto-Cuan"`.
  - Active Plan Badge: `PRO TRADER / VIP` (Lifetime / Aktif).
  - Features Matrix: Real-time Radar Top 5, 3 Screener Engines, Full Bandarmologi Flow Map, Unlimited BYOK AI Queries, Telegram Bot Instant Signals.
  - Voucher Activation Box: Code entry field + `Klaim Voucher`.

#### Ready-to-Paste Stitch Prompt
```text
Design the "Pattern Radar (Advanced Pattern Recognition)" and "Subscription & Membership Gate" interfaces for Auto-Cuan.

Theme & Aesthetic:
- Professional, restrained, technical desk (Canonical Light #F3F5F4, Surface #FFFFFF, Hairlines #E2E7E4, Emerald Accent #0F7458).

Interface 1: Pattern Radar (Algorithmic Technical Pattern Scanner - Admin Desk):
- Header: Title "Pattern Radar" with Admin badge "Akses Khusus Administrator (budi)".
- Subtitle: "Deteksi formasi pola harga klasik dan harmonik pada 840+ saham IDX menggunakan korelasi z-score & Pearson."
- Configuration Toolbar:
  * Dropdown Pola: [Semua Pola: Double Bottom, Bull Flag, Cup & Handle, ABCD Harmonic]
  * Minimum Similarity Threshold: [85% Kemiripan]
  * Horizon Proyeksi: [20 Hari Bursa]
- Scan Results Table:
  Columns: Ticker | Nama Saham | Pola Terdeteksi | Kemiripan (%) | Area Breakout | Target Proyeksi | Status Validasi
  - BBRI | Bank Rakyat Indonesia | Double Bottom | 92,4% | Rp 5.100 | Rp 5.450 (+6,8%) | Terkonfirmasi
  - BRPT | Barito Pacific | Bullish Flag | 89,1% | Rp 1.050 | Rp 1.180 (+12,4%) | Menunggu Volume
  - MEDC | Medco Energi | Ascending Triangle | 87,5% | Rp 1.390 | Rp 1.550 (+11,5%) | Terkonfirmasi
  - ICBP | Indofood CBP | Cup and Handle | 86,0% | Rp 11.200 | Rp 11.900 (+6,2%) | Membentuk Handle

Interface 2: Subscription & Entitlement Modal (Status Keanggotaan):
- Title: "Status Langganan & Akses Meja Kerja"
- Current Plan Hero:
  * Banner: Soft emerald border #0F7458, title "PRO TRADER / VIP ACCESS".
  * Badge: "Aktif (Lifetime)".
  * Feature Checklist:
    [✓] Akses penuh Screener Konglomerasi, Non-Konglo, & Day Trade
    [✓] Bandarmologi & Broker Hunter tanpa batas emiten
    [✓] Asisten AI dengan integrasi Google Gemini API (BYOK)
    [✓] Notifikasi bot Telegram real-time saat jam perdagangan bursa
- Voucher Claim Box:
  * Input "Masukkan Kode Voucher / Token Akses" with button "Aktifkan Voucher".
```

---

## 5. Visual Evidence Index (`tmp/stitch-screenshots/`)

All 39 high-resolution full-page evidence screenshots have been automatically generated and stored in [`tmp/stitch-screenshots/`](tmp/stitch-screenshots/) without modifying any core production files:

| # | Filename | Size (KB) | Subject & Context |
|---|---|---:|---|
| 01 | `01-landing.png` | 2,072 KB | Full Landing Page (Hero, Market Pulse, Screener Showcase, Trust) |
| 02 | `02-auth-login.png` | 1,872 KB | Auth Modal: Masuk (Login Dialog, Google button, forgot password) |
| 03 | `03-auth-register.png` | 1,875 KB | Auth Modal: Daftar Akun Baru (Gmail, credentials, consent) |
| 04 | `04-auth-recovery.png` | 1,887 KB | Auth Modal: Pemulihan Password / Self-Reset via Telegram Bot |
| 05 | `05-dashboard.png` | 209 KB | Workstation Dashboard (Light theme, market band, Top 5 Radar) |
| 06 | `06-dashboard-dark.png` | 209 KB | Workstation Dashboard (Night Research Mode / Dark theme) |
| 07 | `07-account-center.png` | 364 KB | Account Center: Profil, identity, role summary |
| 08 | `08-screener-konglo.png` | 358 KB | Screener: Swing Konglomerat 3-7D table & filters |
| 09 | `09-screener-nonkonglo.png` | 161 KB | Screener: Swing Non-Konglo Main & Development board table |
| 10 | `10-screener-daytrade.png` | 158 KB | Screener: Day Trade Momentum 22-column scanner table |
| 11 | `11-sektor-hot.png` | 75 KB | Sektor Hot: Grup Konglomerat Hot klasemen table |
| 12 | `12-analisis-ai.png` | 107 KB | Analisis & Chart: AI Cockpit synthesis & interactive chat |
| 13 | `13-chart-workstation.png` | 107 KB | Chart Workstation: Candlestick, indicator overlays, plan levels |
| 14 | `14-bandarmologi.png` | 196 KB | Bandarmologi: Broker Summary & Akumulasi buyers/sellers |
| 15 | `15-sinyal-intelijen.png` | 80 KB | Sinyal Intelijen: 4-pillar evidence board & confluence scores |
| 16 | `16-broker-hunter.png` | 71 KB | Broker Hunter: Individual broker tracking & top 10 picks |
| 17 | `17-insider-network.png` | 163 KB | Insider Network: Relational graph & shareholder roster |
| 18 | `18-financial.png` | 167 KB | Financial: Verified fundamental snapshot (PBV, BVPS, Cap) |
| 19 | `19-struktur-pasar.png` | 287 KB | Struktur Pasar: Universe Free Float & HSC audit list |
| 20 | `20-ranking.png` | 103 KB | Ranking Harian: Spreadsheet-grade quantitative matrix |
| 21 | `21-pattern-radar.png` | 69 KB | Pattern Radar: Harmonic & classical chart pattern scanner |
| 22 | `22-watchlist.png` | 96 KB | Watchlist: Personal stock monitoring & price alert triggers |
| 23 | `23-track-record.png` | 148 KB | Track Record: Verified system signal audit ledger & stats |
| 24 | `24-portfolio-overview.png` | 134 KB | Portfolio Command Center: Sub-tab 1 Hari Ini (Decision Cockpit) |
| 25 | `25-portfolio-planner.png` | 252 KB | Portfolio Command Center: Sub-tab 2 Rencana Posisi (Planner) |
| 26 | `26-portfolio-positions.png` | 55 KB | Portfolio Command Center: Sub-tab 3 Pantauan Posisi (Holdings) |
| 27 | `27-portfolio-risk-lab.png` | 73 KB | Portfolio Command Center: Sub-tab 4 Risiko & Avg Down Guard |
| 28 | `28-portfolio-journal.png` | 57 KB | Portfolio Command Center: Sub-tab 5 Trading Journal |
| 29 | `29-portfolio-ai.png` | 101 KB | Portfolio Command Center: Sub-tab 6 Asisten AI Portofolio |
| 30 | `30-kelola-keuangan.png` | 123 KB | Kelola Keuangan: Reconstructed cashflow spreadsheet & portfolio |
| 31 | `31-subscription.png` | 280 KB | Langganan: VIP status, entitlements & voucher claim |
| 32 | `32-mobile-dashboard-390.png`| 341 KB | Responsive View: Dashboard on iPhone 390x844 |
| 33 | `33-mobile-screener-390.png` | 150 KB | Responsive View: Screener decision rows on iPhone 390x844 |
| 34 | `34-account-center-security.png`| 364 KB | Account Center: Keamanan & Koneksi Telegram bot pairing |
| 35 | `35-account-center-terms.png` | 362 KB | Account Center: Peraturan & Ketentuan 12-clause legal scroll |
| 36 | `36-mandatory-gmail.png` | 209 KB | Onboarding: Mandatory Gmail identity binding modal |
| 37 | `37-screener-detail-pane.png`| 201 KB | Screener: Docked 340px desktop Trading Plan detail pane |
| 38 | `38-sektor-hot-detail.png` | 62 KB | Sektor Hot: Constituent stocks drill-down table |
| 39 | `39-chart-technical.png` | 86 KB | Standalone Technical Chart compatibility surface |

---

## 6. How to Use with Google Stitch

1. **Copy the Global Tokens (§2)** into the system instructions or style settings of Google Stitch.
2. **Select the Target Feature Prompt (§4.1 – §4.14)** and paste it directly into the generation field.
3. **Reference the Corresponding Screenshot (`tmp/stitch-screenshots/`)** as visual ground-truth to inspect existing component hierarchy and data flow before applying visual enhancements.
4. **Enforce Zero Card-Wall Hierarchy:** Ensure Stitch generates continuous data bands with `#E2E7E4` hairline dividers and `#F8FAF9` tonal surfaces instead of generic floating cards.
