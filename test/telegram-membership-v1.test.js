'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const core = require('../lib/telegram-membership');

test('customer menu is complete and excludes abandoned signal/performance items', () => {
 assert.deepEqual(core.MENU, ['Verifikasi Akun','Akun Saya','Paket','Beli / Perpanjang','Gunakan Voucher','Akses Channel','Cara Pakai','Hubungi Admin']);
 assert.ok(!core.MENU.some(x => /Sinyal Hari Ini|Performa/.test(x)));
});
test('verification expiry/single use and immutable Telegram takeover are database constrained', () => {
 const sql=fs.readFileSync('supabase/telegram-verification-v2-migration.sql','utf8');
 assert.match(sql,/expires_at/); assert.match(sql,/used_at/); assert.match(sql,/UNIQUE INDEX IF NOT EXISTS uq_autv_telegram_user_id/);
});
test('admin binding uses expiring hashed challenge and unique numeric identity', () => {
 const sql=fs.readFileSync('supabase/telegram-membership-v1-migration.sql','utf8');
 assert.match(sql,/membership_admin_bind_challenges/); assert.match(sql,/code_hash text NOT NULL UNIQUE/); assert.match(sql,/telegram_user_id bigint NOT NULL UNIQUE/);
});
test('access matrix denies verification-only dashboard and permits lifetime/admin', () => {
 assert.deepEqual(core.accessFor({verified:false}),{bot:false,channel:false,dashboard:false,reason:'unverified'});
 assert.equal(core.accessFor({verified:true}).dashboard,false);
 assert.deepEqual(core.accessFor({verified:true,entitlement:{status:'active',lifetime:false,endsAt:'2099-01-01'}}),{bot:true,channel:true,dashboard:false,reason:'term'});
 assert.equal(core.accessFor({verified:true,entitlement:{status:'active',lifetime:true}}).dashboard,true);
 assert.equal(core.accessFor({isAdmin:true}).dashboard,true);
});
test('purchase transitions reject duplicate approval',()=>{ assert.equal(core.canTransition('awaiting_admin_review','approved'),true); assert.equal(core.canTransition('approved','approved'),false); assert.equal(core.canTransition('draft','approved'),false); });
test('proof MIME, size and Telegram metadata validation',()=>{
 assert.equal(core.validateProof({mime_type:'image/jpeg',file_size:50,file_id:'Ab_1'}).ok,true);
 assert.equal(core.validateProof({mime_type:'text/html',file_size:50,file_id:'Ab_1'}).ok,false);
 assert.equal(core.validateProof({mime_type:'image/png',file_size:core.MAX_PROOF_BYTES+1,file_id:'Ab_1'}).ok,false);
});
test('pricing is server-owned and discount math bounded',()=>{
 assert.deepEqual(core.calculatePrice({id:'p',price_idr:10000},{discount_type:'percent',discount_value:25,package_ids:['p']},new Date()),{subtotal:10000,discount:2500,finalAmount:7500});
 assert.equal(core.calculatePrice({id:'p',price_idr:10000},{discount_type:'fixed',discount_value:99999},new Date()).finalAmount,0);
});
test('voucher normalization hashing, expiry and eligibility',()=>{
 assert.equal(core.normalizeVoucher(' ab-c d '),'ABCD'); assert.equal(core.voucherHash('ab-cd','pepper'),core.voucherHash('ABCD','pepper'));
 assert.throws(()=>core.calculatePrice({id:'p',price_idr:1},{valid_until:'2020-01-01',discount_type:'fixed',discount_value:1},new Date('2021-01-01')),/expired/);
 assert.throws(()=>core.calculatePrice({id:'p',price_idr:1},{package_ids:['q'],discount_type:'fixed',discount_value:1},new Date()),/ineligible/);
});
test('voucher limits and duplicates are enforced transactionally',()=>{ const sql=fs.readFileSync('supabase/telegram-membership-v1-migration.sql','utf8'); assert.match(sql,/redemption_count>=v.total_limit/); assert.match(sql,/per_account_limit/); assert.match(sql,/purchase_id uuid NOT NULL UNIQUE/); });
test('calendar-safe entitlement extension starts at later existing end',()=>{ assert.equal(core.extendEntitlement('2026-02-28T00:00:00Z',30,new Date('2026-01-01')).toISOString(),'2026-03-30T00:00:00.000Z'); });
test('channel access expiry is dry-run by default and exempts admin/lifetime',()=>{ const sql=fs.readFileSync('supabase/telegram-membership-v1-migration.sql','utf8'); assert.match(sql,/p_dry_run boolean DEFAULT true/); assert.match(sql,/membership_admin_telegram_links/); assert.match(fs.readFileSync('supabase/telegram-membership-existing-member-report.sql','utf8'),/EXEMPT_LIFETIME/); });
test('webhook secret, duplicates, malformed callbacks and oversized updates',()=>{ assert.equal(core.safeEqual('x','x'),true); assert.equal(core.validCallback('buy:abc'),true); assert.equal(core.validCallback('../bad'),false); assert.equal(core.isPrivate({message:{chat:{type:'group'}}}),false); const src=fs.readFileSync('api/telegram/membership-webhook.js','utf8'); assert.match(src,/payload_too_large/); assert.match(src,/claimUpdate/); assert.match(src,/x-telegram-bot-api-secret-token/); });
test('webhook implements executable package, voucher and retry-safe purchase paths',()=>{ const src=fs.readFileSync('api/telegram/membership-webhook.js','utf8'); assert.match(src,/db\.createPurchase/); assert.match(src,/^\s*const voucherPurchase =/m); assert.match(src,/releaseUpdate/); assert.doesNotMatch(src,/Promise\.resolve\(processUpdate/); });
test('protected admin RPC and same-origin authorization are present',()=>{ const src=fs.readFileSync('api/admin/membership-payments.js','utf8'); assert.match(src,/requireAdminSession/); assert.match(src,/isSameOrigin/); assert.match(src,/idempotency-key/); });
test('admin can inspect proof bytes without exposing a tokenized Telegram URL',()=>{ const src=fs.readFileSync('api/admin/membership-payments.js','utf8'); assert.match(src,/downloadFile/); assert.match(src,/private, no-store/); assert.doesNotMatch(src,/api\.telegram\.org/); });
test('no membership secrets are exposed to browser assets',()=>{ for(const f of fs.readdirSync('public')) if(f.endsWith('.js')||f.endsWith('.html')) assert.doesNotMatch(fs.readFileSync('public/'+f,'utf8'),/VOUCHER_CODE_PEPPER|TELEGRAM_MEMBERSHIP_WEBHOOK_SECRET|SUPABASE_SERVICE_ROLE_KEY/); });
test('portfolio, screener, chart, sector and analysis assets/routes remain',()=>{ ['public/portfolio-v1-loader.js','api/analyze.js','api/candles.js','api/sector-hot.js'].forEach(f=>assert.equal(fs.existsSync(f),true)); assert.equal(fs.readdirSync('api').filter(f=>f.endsWith('.js')).length,12); });
test('existing stock-signal bot stays isolated from membership bot',()=>{ assert.equal(fs.existsSync('lib/telegram-notifier.js'),true); assert.doesNotMatch(fs.readFileSync('api/telegram/membership-webhook.js','utf8'),/telegram-notifier/); });
