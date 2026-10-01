# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 8 (Database Schema, Supabase RPC, Migrations & Integrity)
Dokumentasi temuan bug Fase 8. Read-only kode produksi, dibuktikan lewat failing unit test di test/tools-fase8-bugs.test.js dan test/supabase-fase8-batch1-bugs.test.js.
Fokus khusus: Celah RLS, race condition, kebocoran resource connection pool, unhandled exception/rejection, dan timeout guard.

---

### [TOOLS-BUG-01] Missing Rate-Limit dan Connection Timeout Guard pada VPS API Server
- **Lokasi**: `tools/vps-api-server.js:76-88`, `tools/vps-api-server.js:185-195`
- **Kode Bermasalah**:

### BUG-DB-006: Missing FOR UPDATE pada Voucher Lookup di create_manual_subscription_payment
- **File:** supabase/subscription-manual-payment-migration.sql
- **Fungsi:** create_manual_subscription_payment
- **Deskripsi:** Query voucher tidak mengunci baris, membuka celah konkurensi pemakaian kuota berlebih.
- **Reproduksi:** test/supabase-fase8-batch2-bugs.test.js

### BUG-DB-007: Overwrite Masa Aktif Tanpa Entitlement Stacking pada Manual Payment Review
- **File:** supabase/subscription-manual-payment-migration.sql
- **Fungsi:** review_manual_subscription_payment
- **Deskripsi:** Tanggal kedaluwarsa dihitung dari now() bukan akumulatif dari current_period_end.
- **Reproduksi:** test/supabase-fase8-batch2-bugs.test.js

### BUG-DB-008: Ketiadaan Terminal State Guard pada Alur Approval Pembayaran Manual
- **File:** supabase/subscription-manual-payment-migration.sql
- **Fungsi:** review_manual_subscription_payment
- **Deskripsi:** Transisi status tidak mengunci status akhir, memungkinkan perubahan berulang setelah approved/rejected.
- **Reproduksi:** test/supabase-fase8-batch2-bugs.test.js

### BUG-DB-009: app_user_portfolio_state Kehilangan Trigger Otomatis updated_at
- **File:** supabase/portfolio-state-persistence-migration.sql
- **Objek:** Table public.app_user_portfolio_state
- **Deskripsi:** Tabel memiliki indeks updated_at DESC tetapi tidak ada trigger BEFORE UPDATE untuk menetapkan updated_at = now(). Mutasi partial pada state membuat timestamp tidak sinkron.
- **Reproduksi:** test/supabase-fase8-batch3-bugs.test.js
