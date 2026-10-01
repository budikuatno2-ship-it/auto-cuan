# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 5 (Auth, Subscription, Admin & Security)
Dokumentasi temuan bug Fase 5. Read-only kode produksi, dibuktikan lewat failing unit test di test/.
Fokus khusus: Validasi token/password, paywall bypass (Free vs Pro/VIP), role elevation, timing attack, rate limit.

---

### BUG-F5-01: Bypass Status Blokir Akun Admin pada `getEntitlements`
- **Severity**: HIGH
- **Lokasi**: `lib/entitlements.js:33-41`
- **Kutipan Kode**:
