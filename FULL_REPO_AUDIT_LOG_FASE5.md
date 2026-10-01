# AUTO-CUAN FULL REPO AUDIT LOG - FASE 5 (Auth, Subscription, Admin & Security)
Acuan: AUDIT_RULES.md | Branch: audit/aider-full-restart | Status: BERJALAN

| File | Status | Temuan Bug (ID) | Keterangan |
|---|---|---|---|
| lib/password-credential.js | SELESAI DIAUDIT | - | Bersih. Hashing scrypt k1, salt 16-byte, timingSafeEqual, proteksi replay hash |
| lib/security-guard.js | SELESAI DIAUDIT | - | Bersih. Fail-closed admin target, rate-limit RPC, pepper HMAC, masking PII |
| lib/subscription-auth.js | SELESAI DIAUDIT | BUG-F5-01, BUG-F5-03 | Terkait integritas resolver hak akses & sesi |
| lib/entitlements.js | SELESAI DIAUDIT | BUG-F5-01, BUG-F5-02, BUG-F5-03 | Terbukti via test/security-fase5-batch1-bugs.test.js |
| lib/admin-session.js | SELESAI DIAUDIT | BUG-F5-05 | Inkompatibilitas payload token `dvh` vs `dev` saat logout unbinding |
| lib/user-ai-credentials.js | SELESAI DIAUDIT | BUG-F5-06 | `isSubscribedTier` meloloskan akun admin terblokir & paket lifetime revoked |
| lib/maintenance-state.js | SELESAI DIAUDIT | - | Bersih. JSON safe parsing, fail-open/closed terkontrol pada pembacaan konfigurasi |
| api/login-user.js | SELESAI DIAUDIT | BUG-F5-04, BUG-F5-05 | Bypass approval Telegram saat login admin via email, gagal unbind device logout |
| api/register-user.js | SELESAI DIAUDIT | - | Bersih. Validasi format email, sanitasi username allowlist regex, rate limit, terms audit |
| api/reset-password.js | SELESAI DIAUDIT | - | Bersih. Routing gateway terisolasi, handler diproteksi same-origin & rate limit |
| api/review-access.js | SELESAI DIAUDIT | BUG-F5-07 | Penerimaan token via query parameter (CWE-598) & timing leak panjang token |
