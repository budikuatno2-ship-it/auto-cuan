# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 7 (Frontend UI, Charts & Client Runtime)
Dokumentasi temuan bug Fase 7. Read-only kode produksi, dibuktikan lewat failing unit test di test/.
Fokus khusus: Kalkulasi lot/risk position sizing, simulasi portfolio, pattern safety, label direction, dan rendering geometri teknikal.

---

### BUG-F7-001: Sanitasi Angka Menghapus Titik Desimal pada Input 3 Digit Desimal
- **Lokasi**: `public/position-sizing-calculator.js:28-34`
- **Severity**: HIGH
- **Kutipan Kode**:

### BUG-F7-017: inlineFormat Stripping Merusak Identifier di Dalam Tag <code>
- **File:** public/ai-chat-renderer.js
- **Fungsi:** inlineFormat(value)
- **Deskripsi:** Regex pembersih merusak token di dalam <code>.
- **Reproduksi:** test/frontend-fase7-batch4-bugs.test.js

### BUG-F7-018: splitTableRow Memecah Sel Tabel pada Escaped Pipe
- **File:** public/ai-chat-renderer.js
- **Fungsi:** splitTableRow(line)
- **Deskripsi:** Baris tabel markdown di-split naif dengan tanda pipa.
- **Reproduksi:** test/frontend-fase7-batch4-bugs.test.js
