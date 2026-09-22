const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Baca konten SQL migrasi Fase 8 Batch 2
const manualSqlPath = path.resolve(__dirname, '../supabase/subscription-manual-payment-migration.sql');
const phase2SqlPath = path.resolve(__dirname, '../supabase/subscription-phase-2-migration.sql');

const manualSql = fs.readFileSync(manualSqlPath, 'utf8');
const phase2Sql = fs.readFileSync(phase2SqlPath, 'utf8');

test('DATABASE FASE 8 BATCH 2: Subscription, Manual Payment & Voucher Integrity', async (t) => {

  await t.test('BUG-DB-006: create_manual_subscription_payment tidak mengunci baris voucher dengan FOR UPDATE (Race Condition Kuota)', () => {
    // Pada saat validasi kuota voucher di create_manual_subscription_payment,
    // query SELECT voucher harus menggunakan FOR UPDATE untuk mencegah over-redeem pada transaksi konkuren.
    const createPaymentRegex = /CREATE OR REPLACE FUNCTION.*create_manual_subscription_payment[\s\S]*?BEGIN([\s\S]*?)END;/i;
    const match = manualSql.match(createPaymentRegex);
    assert.ok(match, 'Fungsi create_manual_subscription_payment harus ada di subscription-manual-payment-migration.sql');

    const body = match[1];
    // Pastikan SELECT voucher memiliki klausa FOR UPDATE
    const hasForUpdateOnVoucher = /SELECT[\s\S]*?FROM[\s\S]*?vouchers[\s\S]*?FOR UPDATE/i.test(body) ||
                                  /SELECT[\s\S]*?FROM[\s\S]*?subscription_vouchers[\s\S]*?FOR UPDATE/i.test(body);
    assert.strictEqual(
      hasForUpdateOnVoucher,
      true,
      'Query pengecekan voucher wajib menggunakan row lock FOR UPDATE untuk konsistensi kuota'
    );
  });

  await t.test('BUG-DB-007: review_manual_subscription_payment menimpa masa aktif bukan memperpanjang (No Entitlement Stacking)', () => {
    // Saat pembayaran disetujui, jika user memiliki sisa langganan aktif,
    // tanggal berakhir baru harus dihitung dari GREATEST(now(), current_period_end) + interval, bukan langsung now() + interval
    const hasStackingLogic = /GREATEST\s*\(\s*(?:now\(\)|current_timestamp)\s*,\s*(?:\w+\.)?(?:expires_at|current_period_end)\s*\)/i.test(manualSql);
    assert.strictEqual(
      hasStackingLogic,
      true,
      'Persetujuan langganan manual wajib mendukung stacking (perpanjangan akumulatif dari current_period_end)'
    );
  });

  await t.test('BUG-DB-008: State transition pembayaran manual tidak menjaga immutability pada status final', () => {
    // UPDATE pada review_manual_subscription_payment harus memiliki klausul WHERE status = 'awaiting_transfer'
    // atau 'pending' agar tidak dapat diubah berulang-ulang setelah approved/rejected
    const reviewPaymentRegex = /CREATE OR REPLACE FUNCTION.*review_manual_subscription_payment[\s\S]*?BEGIN([\s\S]*?)END;/i;
    const match = manualSql.match(reviewPaymentRegex);
    assert.ok(match, 'Fungsi review_manual_subscription_payment harus ada');

    const body = match[1];
    const guardsTerminalState = /WHERE[\s\S]*?status\s*=\s*'(?:awaiting_transfer|pending|submitted)'/i.test(body);
    assert.strictEqual(
      guardsTerminalState,
      true,
      'Review pembayaran harus memvalidasi status awal secara ketat untuk mencegah mutasi ganda status terminal'
    );
  });

});
