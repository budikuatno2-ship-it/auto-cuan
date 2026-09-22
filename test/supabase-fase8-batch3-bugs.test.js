const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portfolioSqlPath = path.resolve(__dirname, '../supabase/portfolio-state-persistence-migration.sql');
const claimSqlPath = path.resolve(__dirname, '../supabase/claim-ai-eval-run-atomically.sql');

const portfolioSql = fs.readFileSync(portfolioSqlPath, 'utf8');
const claimSql = fs.readFileSync(claimSqlPath, 'utf8');

test('DATABASE FASE 8 BATCH 3: Schema Lifecycle, Portfolio State & Atomic Locking', async (t) => {

  await t.test('BUG-DB-009: app_user_portfolio_state tidak memiliki trigger auto-update updated_at', () => {
    // Tabel memiliki indeks updated_at DESC, namun ketiadaan trigger membuat timestamp basi
    // jika update query hanya memutasi kolom state.
    const hasTrigger = /CREATE\s+TRIGGER[\s\S]*?app_user_portfolio_state/i.test(portfolioSql) ||
                       /update_updated_at_column/i.test(portfolioSql);
    assert.strictEqual(
      hasTrigger,
      true,
      'app_user_portfolio_state wajib memiliki trigger BEFORE UPDATE untuk menjaga akurasi timestamp updated_at'
    );
  });

  await t.test('BUG-DB-010: claim_ai_eval_run aman dan fail-closed terhadap akses publik', () => {
    // Validasi kepatuhan guardrail: security definer + fixed search_path + revoke public
    const hasSearchPath = /set\s+search_path\s*=\s*pg_catalog,\s*public/i.test(claimSql);
    const hasRevoke = /revoke\s+all\s+on\s+function.*claim_ai_eval_run.*from\s+public/i.test(claimSql);
    assert.strictEqual(hasSearchPath && hasRevoke, true, 'claim_ai_eval_run harus memiliki search_path eksplisit dan revoke publik');
  });

});
