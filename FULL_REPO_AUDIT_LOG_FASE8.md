# AUTO-CUAN FULL REPO AUDIT LOG - FASE 8 (Database Schema, Supabase RPC, Migrations & Integrity)
Acuan: AUDIT_RULES.md | Branch: audit/aider-full-restart | Status: TUNTAS

| File | Status | Temuan Bug (ID) | Keterangan |
|---|---|---|---|
| supabase/multi-device-migration.sql | TUNTAS (AUDIT) | BUG-DB-003 | Missing NOT NULL and array type constraint |
| supabase/admin-device-approval-migration.sql | TUNTAS (AUDIT) | BUG-DB-001, BUG-DB-002, BUG-DB-005 | RLS disabled, missing FK cascade, missing status constraint |
| supabase/admin-telegram-command-login-migration.sql | TUNTAS (AUDIT) | BUG-DB-004 | consume_admin_command_device_grant returns stale 'pending' on expired grant |
| supabase/admin-telegram-maintenance-code-migration.sql | TUNTAS (AUDIT) | BERSIH (AUDIT) | Atomic lock, attempt limit, search_path verified |
| tools/vps-api-server.js | TUNTAS (AUDIT) | TOOLS-BUG-01, TOOLS-BUG-02, TOOLS-BUG-03 | Rate-limit missing, connection leak on I/O error, unbounded cache |
| tools/ai-eval-once-supervisor.js | TUNTAS (AUDIT) | TOOLS-BUG-04, TOOLS-BUG-05 | No unhandledRejection/fetch timeout, orphan crash recovery missing |
| supabase/subscription-phase-2-migration.sql | TUNTAS | - | Batch 2: Terverifikasi skema dasar langganan |
| supabase/subscription-manual-payment-migration.sql | TUNTAS | BUG-DB-006, BUG-DB-007, BUG-DB-008 | Batch 2: Race condition kuota, non-stacking entitlement, mutasi status terbuka |
| supabase/subscription-phase-5c-voucher-admin-migration.sql | TUNTAS | - | Batch 2: Validasi skema admin voucher |
| supabase/subscription-phase-5c-redemption-correction.sql | TUNTAS | - | Batch 2: Perbaikan redemption dasar |
| supabase/telegram-verification-v2-migration.sql | TUNTAS | - | Batch 3: search_path aman, FOR UPDATE row-level lock |
| supabase/telegram-member-lifecycle-hotfix.sql | TUNTAS | - | Batch 3: Lease lock aman, SECURITY DEFINER terlindungi |
| supabase/claim-ai-eval-run-atomically.sql | TUNTAS | - | Batch 3: Atomic single-statement lock aman |
| supabase/portfolio-state-persistence-migration.sql | TUNTAS | BUG-DB-009 | Batch 3: Missing trigger auto-update updated_at |
