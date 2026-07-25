'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const core = require('../lib/telegram-membership');
const membershipWebhook = require('../lib/telegram-membership-webhook');
const membershipService = require('../lib/telegram-membership-service');
const telegramVerification = require('../lib/telegram-verification');
const telegramBot = require('../lib/telegram-verify-bot');
const loginHandler = require('../api/login-user');

function response() {
  return { statusCode: 0, body: null, headers: {}, status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; return this; }, send(v) { this.body=v; return this; }, setHeader(k,v) { this.headers[k]=v; } };
}
function activeAccount(lifetime) { return { verified:true, entitlement:{ status:'active', lifetime:!!lifetime, endsAt:lifetime?null:'2099-01-01T00:00:00Z' } }; }
async function withBotStubs(stubs, fn) {
  const old={}; for (const [k,v] of Object.entries(stubs)) { old[k]=telegramBot[k]; telegramBot[k]=v; }
  try { return await fn(); } finally { for (const [k,v] of Object.entries(old)) telegramBot[k]=v; }
}

test('safe secret comparison fails closed',()=>{
 assert.equal(core.safeEqual(undefined,undefined),false); assert.equal(core.safeEqual('',''),false); assert.equal(core.safeEqual('x','x'),true); assert.equal(core.safeEqual('x','xx'),false);
 assert.equal(loginHandler.secretsMatch(undefined,undefined),false); assert.equal(loginHandler.secretsMatch('',''),false); assert.equal(loginHandler.secretsMatch('x','x'),true);
});
test('consolidated webhook rejects an absent expected secret',async()=>{
 const old={...process.env}; delete process.env.TELEGRAM_VERIFY_WEBHOOK_SECRET;
 const res=response(); await loginHandler({method:'POST',query:{action:'telegram-verify-webhook'},headers:{},body:{update_id:1}},res);
 assert.equal(res.statusCode,401); process.env=old;
});
test('website verification code still dispatches to existing secure processor',async()=>{
 const original=telegramVerification.processWebhookUpdate; let received=false;
 telegramVerification.processWebhookUpdate=async update=>{received=update.message.text==='ABCD-EFGH';return {outcome:'verified'};};
 try { const result=await loginHandler.dispatchTelegramUpdate({update_id:2,message:{text:'ABCD-EFGH',chat:{type:'private'}}},{supabase:{},bot:{},membership:membershipWebhook}); assert.equal(result.outcome,'verified'); assert.equal(received,true); }
 finally { telegramVerification.processWebhookUpdate=original; }
});
test('dynamic menus match unverified, unpaid, and active states',()=>{
 assert.deepEqual(core.menuFor({verified:false}),['Verifikasi Akun','Paket','Hubungi Admin']);
 assert.deepEqual(core.menuFor({verified:true}),['Akun Saya','Paket','Beli Paket','Gunakan Voucher','Hubungi Admin']);
 assert.deepEqual(core.menuFor(activeAccount(false)),['Akun Saya','Paket Aktif','Beli / Perpanjang','Akses Channel','Gunakan Voucher','Cara Pakai','Hubungi Admin']);
});
test('dashboard session policy denies term users and permits Lifetime/admin',async()=>{
 const fake=value=>({rpc:async()=>({data:value,error:null})});
 assert.equal(await loginHandler.mayIssueDashboardSession(fake({allowed:false}),{id:'u'},'normal'),false);
 assert.equal(await loginHandler.mayIssueDashboardSession(fake({allowed:true}),{id:'u'},'normal'),true);
 assert.equal(await loginHandler.mayIssueDashboardSession(fake({allowed:false}),{id:'u'},'budi'),true);
});
test('admin binding is private, hashed, single-use through the service contract',async()=>{
 let calls=0; const db={claimUpdate:async()=>true,bindAdmin:async(id,chat,code)=>{calls++;assert.equal(id,99);assert.equal(chat,99);assert.equal(code,'ONETIME');return calls===1;}};
 await withBotStubs({sendMessage:async()=>({})},async()=>{
  assert.equal(await membershipWebhook.processUpdate({update_id:3,message:{text:'ADMIN ONETIME',from:{id:99},chat:{id:99,type:'private'}}},db),'admin_bound');
  assert.equal(await membershipWebhook.processUpdate({update_id:4,message:{text:'ADMIN ONETIME',from:{id:99},chat:{id:99,type:'private'}}},db),'admin_bind_failed');
  assert.equal(await membershipWebhook.processUpdate({update_id:5,message:{text:'ADMIN ONETIME',from:{id:99},chat:{id:-1,type:'group'}}},db),'private_only');
 });
});
test('expired/cancelled purchase states reject proof and approval',()=>{
 const now=new Date('2026-01-02T00:00:00Z');
 assert.equal(core.purchaseAllowsProof({status:'awaiting_payment',expiresAt:'2026-01-01'},now),false);
 assert.equal(core.purchaseAllowsApproval({status:'awaiting_admin_review',expiresAt:'2026-01-01'},now),false);
 assert.equal(core.purchaseAllowsApproval({status:'cancelled',expiresAt:'2027-01-01'},now),false);
 assert.equal(core.purchaseAllowsApproval({status:'awaiting_admin_review',expiresAt:'2027-01-01'},now),true);
});
test('voucher reservation finalizes only on approval and releases on abandonment',()=>{
 assert.equal(core.voucherReservationAfter('awaiting_payment'),'reserved'); assert.equal(core.voucherReservationAfter('approved'),'finalized');
 assert.equal(core.voucherReservationAfter('expired'),'released'); assert.equal(core.voucherReservationAfter('cancelled'),'released');
});
test('channel access creates a join-request invite bound to Telegram id',async()=>{
 const calls=[]; const db={claimUpdate:async()=>true,account:async()=>activeAccount(false),channelGrant:async()=>({grantId:'g'}),recordChannelInvite:async(g,id,invite)=>calls.push([g,id,invite])};
 const old=process.env.TELEGRAM_VERIFY_CHANNEL_ID;process.env.TELEGRAM_VERIFY_CHANNEL_ID='-1001';
 await withBotStubs({createChatInviteLink:async(chat,opts)=>{assert.equal(chat,'-1001');assert.equal(opts.expireSeconds,900);return 'https://t.me/+safe';},sendMessage:async()=>({})},async()=>assert.equal(await membershipWebhook.processUpdate({update_id:6,message:{text:'Akses Channel',from:{id:77},chat:{id:77,type:'private'}}},db),'channel'));
 assert.deepEqual(calls,[['g',77,'https://t.me/+safe']]);process.env.TELEGRAM_VERIFY_CHANNEL_ID=old;
});
test('membership join request validates Telegram identity before Telegram calls',async()=>{
 const calls=[]; const db={claimChannelJoin:async(id,invite)=>id===77&&invite==='invite'?{grantId:'g'}:null};
 const bot={approveChatJoinRequest:async(c,id)=>calls.push(['approve',c,id]),revokeChatInviteLink:async(c,i)=>calls.push(['revoke',c,i])};
 assert.equal(await membershipWebhook.processChannelJoinRequest({chat_join_request:{from:{id:77},chat:{id:-1},invite_link:{invite_link:'invite'}}},{db,bot}),true);
 assert.deepEqual(calls,[['approve',-1,77],['revoke',-1,'invite']]);
 assert.equal(await membershipWebhook.processChannelJoinRequest({chat_join_request:{from:{id:88},chat:{id:-1},invite_link:{invite_link:'invite'}}},{db,bot}),false);
});
test('expiry enforcement defaults dry-run and requires both enablement and exact confirmation',async()=>{
 let removed=0; const db={expiryCandidates:async()=>[{grant_id:'g',telegram_user_id:77}],revokeChannelGrant:async()=>{removed++;}};
 const bot={banChatMember:async()=>{removed++;},unbanChatMember:async()=>{removed++;}};
 let report=await membershipService.runChannelExpiryEnforcement({db,bot,enabled:false,confirm:'REMOVE_EXPIRED_MEMBERS',channelId:'c'});assert.deepEqual(report,{dry_run:true,candidates:1,removed:0,failures:0});assert.equal(removed,0);
 report=await membershipService.runChannelExpiryEnforcement({db,bot,enabled:true,confirm:'wrong',channelId:'c'});assert.equal(report.dry_run,true);assert.equal(removed,0);
 report=await membershipService.runChannelExpiryEnforcement({db,bot,enabled:true,confirm:'REMOVE_EXPIRED_MEMBERS',channelId:'c'});assert.equal(report.removed,1);assert.equal(removed,3);
});
test('proof validation bounds MIME, metadata, and byte size',()=>{assert.equal(core.validateProof({mime_type:'image/jpeg',file_size:50,file_id:'Ab_1'}).ok,true);assert.equal(core.validateProof({mime_type:'text/html',file_size:50,file_id:'Ab_1'}).ok,false);assert.equal(core.validateProof({mime_type:'image/png',file_size:core.MAX_PROOF_BYTES+1,file_id:'Ab_1'}).ok,false);});
test('voucher hashing and server discount math are deterministic',()=>{assert.equal(core.voucherHash('ab-cd','pepper'),core.voucherHash('ABCD','pepper'));assert.deepEqual(core.calculatePrice({id:'p',price_idr:10000},{discount_type:'percent',discount_value:25,package_ids:['p']},new Date()),{subtotal:10000,discount:2500,finalAmount:7500});});
test('migration packages are inactive until an operator configures prices',()=>{const sql=fs.readFileSync('supabase/telegram-membership-v1-migration.sql','utf8');assert.match(sql,/active boolean NOT NULL DEFAULT false/);assert.match(sql,/false,null,10/);assert.match(sql,/status='released'/);assert.match(sql,/expires_at>now\(\)/);});
test('recursive Vercel API JavaScript function count remains exactly 12',()=>{const {execFileSync}=require('child_process');const count=execFileSync('bash',['-lc',"find api -type f -name '*.js' | wc -l"],{encoding:'utf8'}).trim();assert.equal(count,'12');});
test('membership remains isolated from stock-signal notifier and browser secrets',()=>{assert.doesNotMatch(fs.readFileSync('lib/telegram-membership-webhook.js','utf8'),/telegram-notifier/);for(const f of fs.readdirSync('public'))if(/\.(js|html)$/.test(f))assert.doesNotMatch(fs.readFileSync('public/'+f,'utf8'),/VOUCHER_CODE_PEPPER|ADMIN_TELEGRAM_BIND_PEPPER|SUPABASE_SERVICE_ROLE_KEY/);});
