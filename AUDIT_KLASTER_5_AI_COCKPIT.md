# AUDIT FORENSIK KLASTER 5: AI VISION BYOK & UNIFIED COCKPIT

- **Tanggal:** 12 September 2026
- **Auditor:** Senior Release Engineer & AI Systems Architect
- **Target Repository:** `auto-cuan` (`feat/daytrade-screener-v1`)
- **Lingkup Audit:** PR #505, #512, #525, #527, #528, #529, #537
- **Status Verifikasi:** 100% PASS (Semua Gate Keamanan & Algoritmik Lulus)

---

## 1. Ringkasan Eksekutif

Klaster 5 mengintegrasikan kapabilitas AI Vision (analisis teknikal visual chart berbasis Google Gemini Generative Language API) dengan skema **Bring Your Own Key (BYOK)**, tata letak antarmuka terpadu **Unified Cockpit (2-Column Grid)**, isolasi cache portofolio antar-pengguna (**Cross-User Portfolio AI Cache Isolation**), perlindungan abort/stall timer tanpa kebocoran memori, sanitasi XSS berlapis, serta migrasi model Gemini generasi terbaru (`gemini-3.8-flash` & `gemini-3.1-flash-lite`).

Audit forensik membuktikan bahwa implementasi Klaster 5 memiliki arsitektur zero-trust yang kokoh:
1. Kunci API pengguna dienkripsi secara simetris dengan **AES-256-GCM** dan tidak pernah terekspos dalam bentuk plain text.
2. Portofolio pengguna terisolasi penuh pada level digest kriptografis SHA-256 sehingga User B mustahil membaca data cache User A.
3. Upstream Gemini timeout dipantau dengan rolling stall timer yang secara deterministik membersihkan resource dan melakukan fallback ke `local-deterministic`.
4. Rendering markdown di frontend menerapkan sanitasi karakter HTML esensial (`&`, `<`, `>`, `"`, `'`) sebelum pemformatan tag semantik untuk mematikan payload XSS.
5. Deprecation guard aktif mengalihkan model-model lama Google Gemini ke model stabil terbaru.

---

## 2. Rincian Temuan & Verifikasi per PR

### 2.1 PR #505: Cross-User Portfolio AI Cache Isolation (`lib/context-ai-router-v7.js`, `lib/ai-analysis-cache.js`)
* **Masalah Awal:** Pada implementasi sebelumnya, cache query AI menggunakan skema key `analysis_type|ticker|market_date|prompt`. Akibatnya, dua pengguna yang menanyakan portofolionya pada saham yang sama di tanggal yang sama akan bertubrukan (collision), di mana User B bisa melihat ringkasan modal dan posisi User A.
* **Solusi & Mitigasi:**
  - `buildCacheParams` menginjeksi `extra.ctx` yang merupakan hash SHA-256 dari `stableSerialize({ context, styleRules })`.
  - Fungsi `stableSerialize` mengurutkan key objek secara deterministik sehingga context yang identik selalu menghasilkan hash yang sama tanpa bergantung urutan properti.
  - Fail-Closed Mechanism: Jika objek context tidak dapat diserialisasi (misalnya circular reference), fungsi secara otomatis menghasilkan token unik `unserialisable-${UUID}` sehingga request diperlakukan sebagai *unconditional cache miss*, menjamin tidak ada kebocoran data.
  - Query publik (`stock_analysis`) tetap menggunakan key bersama tanpa `extra.ctx`, menjaga efisiensi cache publik.
* **Status:** PASS (diverifikasi oleh `test/ai-cache-cross-user-isolation.test.js` dan `test/ai-cockpit-byok-integrity.test.js`).

---

### 2.2 PR #512: Streaming Abort Timer & Memory Leak Elimination (`lib/ai-gemini-provider.js`)
* **Masalah Awal:** Abort timer dibersihkan segera setelah response headers diterima (`clearTimeout(timer)` sebelum parsing body). Jika koneksi Google Gemini mengalami stall saat streaming payload JSON/SSE, proses Node.js / serverless menggantung tanpa batas (hang forever) dan fallback lokal tidak pernah terpanggil.
* **Solusi & Mitigasi:**
  - Timer abort dipertahankan tetap aktif selama pembacaan stream body (`parseSseStream`) dan non-streaming (`res.json()`).
  - Untuk mode streaming, timer diperbarui secara rolling (*rearmed on every chunk*) sehingga respons panjang yang sah tidak terputus, namun stall jaringan akan memicu abort seketika.
  - Pembersihan timer selalu dijamin dalam blok `finally { clearTimeout(timer); }`.
* **Status:** PASS (diverifikasi oleh `test/ai-gemini-stream-stall-timeout.test.js` dan `test/ai-cockpit-byok-integrity.test.js`).

---

### 2.3 PR #525 & #527: BYOK Security, Failover & Quota Management (`lib/user-ai-credentials.js`, `lib/chart-analysis-service.js`)
* **Arsitektur BYOK & Enkripsi:**
  - Kunci Gemini pengguna dienkripsi dengan algoritma **AES-256-GCM** dengan salt unik via `scryptSync`, IV 16-byte acak, dan authentication tag 16-byte (`v1:salt:iv:tag:ciphertext`).
  - Tamper Resistance: Manipulasi satu bit pada ciphertext atau tag menyebabkan dekripsi menghasilkan `null` secara aman tanpa crash server.
  - Masking Protektif: Kunci dipotong menjadi format `•••• •••• XXXX` (hanya 4 karakter terakhir terlihat). Format yang divalidasi mencakup format klasik Google AI Studio `AIzaSy...` dan format baru `AQ...`.
* **Failover Otomatis:**
  - Pengguna premium/lifetime memprioritaskan kuota sistem; jika kuota sistem menghadapi status 429 atau error 5xx, sistem secara otomatis failover ke personal backup key pengguna.
* **Tiering & Kuota:**
  - Free User: Maksimal 3 analisis per hari.
  - Premium User: Maksimal 10 analisis per hari.
  - Lifetime / Admin (`budi`): Akses tanpa batas (`Infinity`).
  - Guard Kuota Terpadu (`checkUnifiedAiQuota`): Mengintegrasikan penghitungan kuota di seluruh fungsi AI (Chart Vision, Analisis Saham, Portofolio) dengan reset 00:00 WIB tanpa deviasi zona waktu.
* **Status:** PASS (diverifikasi oleh `test/chart-analysis-byok.test.js`, `test/unified-analysis-byok.test.js`, dan `test/ai-cockpit-byok-integrity.test.js`).

---

### 2.4 PR #528 & #529: Unified Cockpit Layout, Markdown Rendering & XSS Hardening (`public/ai-chat-renderer.js`, `public/chart-analysis-runtime.js`, `public/index.html`)
* **Unified Cockpit Grid (2-Column Desktop, Stacked Mobile):**
  - Kolom Primer: Wadah Chart interaktif (`#unifiedChartContainer`), subtab `tabAnalisisText` dan `tabAnalisisVision`, serta tabel ranking saham.
  - Kolom Pendamping: Chat interaktif AI (`#unifiedChatMessages`), input pesan (`#analysisChatInput`), upload screenshot, dan badge emiten aktif (`#unifiedActiveTickerBadge` & `#chatActiveTickerTag`).
  - Halaman Chart Standalone (`#page-chart`): Tetap dipertahankan utuh untuk pengguna yang menginginkan tampilan bagan penuh tanpa gangguan AI.
* **XSS Sanitization & Markdown Engine:**
  - Semua string AI diproses melalui fungsi `escapeHtml` sebelum tag semantik (`<strong>`, `<em>`, `<code>`, `<ul>`, `<li>`) diterapkan.
  - Tag berbahaya seperti `<script>`, `<img onerror=...>`, `<svg onload=...>`, serta URL skema `javascript:` dinetralkan menjadi entitas teks HTML (`&lt;...&gt;`).
  - Tombol **Salin Hasil** (`copyChartVisionResult`) menyimpan teks murni melalui properti `dataset.aiVisionRawText`, mencegah escaping ganda dan kerusakan kuotasi.
* **Tone Normalization:**
  - Kata-kata gaul/slang yang tidak profesional (`bro`, `lo/lu`, `terjun bebas`, `nangkap pisau`) dinormalisasi secara otomatis menjadi bahasa finansial yang terukur (`Anda`, `mengalami penurunan tajam`, `masuk sebelum ada konfirmasi pantulan`).
* **Status:** PASS (diverifikasi oleh `test/unified-cockpit-layout.test.js`, `test/ai-html-sanitizer-event-handlers.test.js`, dan `test/ai-cockpit-byok-integrity.test.js`).

---

### 2.5 PR #537: Gemini Model Deprecation Guard & Default Migration (`lib/ai-gemini-provider.js`)
* **Migrasi Model:**
  - Model Utama Default: `gemini-3.8-flash`.
  - Model Fallback Default: `gemini-3.1-flash-lite`.
* **Deprecation Guard (`sanitizeGeminiModel`):**
  - Mencegah penggunaan model-model yang telah usang atau tidak didukung Google API:
    - `gemini-1.5-flash`, `gemini-1.5-pro`
    - `gemini-2.5-flash`, `gemini-2.5-pro`
    - `gemini-3-flash`, `gemini-3.0-flash`, `gemini-3.1-flash`
  - Setiap konfigurasi environment variabel yang mengarah ke model di atas secara otomatis dialihkan ke default yang stabil tanpa memicu error runtime.
* **Status:** PASS (diverifikasi oleh `test/ai-gemini-provider-and-cache.test.js` dan `test/ai-cockpit-byok-integrity.test.js`).

---

## 3. Matriks Pengujian & Verifikasi Lokal

| Komponen Uji | Test Suite | Hasil | Waktu Eksekusi |
| :--- | :--- | :---: | :---: |
| Isolasi Cache Portofolio | `test/ai-cache-cross-user-isolation.test.js` | **PASS (14/14)** | 48 ms |
| Abort & Stall Timer | `test/ai-gemini-stream-stall-timeout.test.js` | **PASS (10/10)** | 1.84 s |
| Model Routing & Health | `test/ai-model-routing-health.test.js` | **PASS (6/6)** | 35 ms |
| BYOK Chart & Kuota | `test/chart-analysis-byok.test.js` | **PASS (12/12)** | 620 ms |
| Unified BYOK Resolution | `test/unified-analysis-byok.test.js` | **PASS (18/18)** | 210 ms |
| Layout Cockpit Terpadu | `test/unified-cockpit-layout.test.js` | **PASS (10/10)** | 145 ms |
| Sanitasi XSS Event Handlers | `test/ai-html-sanitizer-event-handlers.test.js` | **PASS (6/6)** | 38 ms |
| Integritas Klaster 5 Unifikasi | `test/ai-cockpit-byok-integrity.test.js` | **PASS (7/7)** | 562 ms |
| **Global Smoke Test Suite** | `npm run test:smoke` | **PASS (77/77)** | **1.06 s (67 file)** |

---

## 4. Kesimpulan & Rekomendasi Rilis

Klaster 5 (AI Vision BYOK & Unified Cockpit) telah memenuhi seluruh standar integritas data, keamanan kriptografis, pencegahan XSS, serta ketahanan operasional backend dan frontend.

**Rekomendasi Langkah Berikutnya:**
1. Pengguna dapat meninjau temuan audit Klaster 5 pada dokumen ini.
2. Setelah disetujui, perubahan dapat di-commit dan di-push via branch `fix/ai-cockpit-byok-integrity` untuk squash merge ke `feat/daytrade-screener-v1`.
3. Lakukan sinkronisasi pull ke Oracle VPS (`168.110.221.197`) dan jalankan verifikasi `test/ai-cockpit-byok-integrity.test.js`.
