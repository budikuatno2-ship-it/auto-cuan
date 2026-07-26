'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const root=path.join(__dirname,'..'), migration=fs.readFileSync(path.join(root,'supabase','subscription-phase-2-migration.sql'),'utf8'), login=fs.readFileSync(path.join(root,'api','login-user.js'),'utf8'), admin=fs.readFileSync(path.join(root,'api','admin-users.js'),'utf8')+fs.readFileSync(path.join(root,'lib','admin-users-handler.js'),'utf8');
const vouchers=require('../lib/vouchers'), identity=require('../lib/subscription-identity');
test('Phase 5B stores only HMAC voucher codes and redeems atomically through service-only RPCs',()=>{
  process.env.VOUCHER_CODE_PEPPER='phase5b-test-pepper-long-enough'; const hash=vouchers.voucherCodeHash(' abcdef12 ');
  assert.match(hash,/^[a-f0-9]{64}$/); assert.notEqual(hash,'ABCDEF12'); assert.equal(vouchers.normalizeVoucherCode('abc-def12'),null);
  for(const name of ['subscription_vouchers','subscription_voucher_redemptions','quote_subscription_voucher','redeem_subscription_voucher','FOR UPDATE','redemption_idempotency_key','SECURITY DEFINER','SET search_path']) assert.match(migration,new RegExp(name));
  assert.match(migration,/REVOKE ALL ON FUNCTION public\.quote_subscription_voucher[\s\S]*FROM PUBLIC, anon, authenticated/);
});
test('voucher browser actions and protected service actions fail closed with subscription capability',()=>{
  assert.match(login,/voucher-(quote|redeem)/); assert.match(login,/if \(!isSubscriptionFeatureEnabled\(\)\) return res\.status\(503\)/);
  assert.match(admin,/voucherActions/); assert.match(admin,/protectedSubscriptionActions\.indexOf\(action\) >= 0 && !isSubscriptionFeatureEnabled\(\)/);
  assert.equal(fs.readdirSync(path.join(root,'api')).filter(x=>x.endsWith('.js')).length,12);
});
test('voucher Telegram foundation accepts only the fixed owner ID and keeps web UI absent',()=>{
  assert.equal(vouchers.VOUCHER_ADMIN_TELEGRAM_USER_ID,6396446903); assert.equal(vouchers.isVoucherAdminTelegramUser(6396446903),true); assert.equal(vouchers.isVoucherAdminTelegramUser(7),false);
  assert.match(login,/voucher-admin-telegram-webhook/); assert.match(login,/TELEGRAM_VOUCHER_ADMIN_WEBHOOK_SECRET/); assert.match(migration,/p_telegram_user_id<>6396446903/);
  assert.equal((fs.readFileSync(path.join(root,'public','index.html'),'utf8').match(/voucher/gi)||[]).length,0);
});
test('event metadata allowlist exposes voucher facts but drops secrets',()=>{
  assert.deepEqual(identity.safeEventMetadata('voucher_redeemed',{voucher_code_hint:'AB12',plan_code:'PREMIUM_1_MONTH',duration_days:30,token:'secret'}),{voucher_code_hint:'AB12',plan_code:'PREMIUM_1_MONTH',duration_days:30});
});
