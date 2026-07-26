'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const customer = require('../lib/telegram-membership-webhook');
const bot = require('../lib/telegram-verify-bot');
const core = require('../lib/telegram-membership');

function callback(data,id=1){
  return {update_id:id,callback_query:{id:'cb-'+id,data,from:{id:77},message:{chat:{id:77,type:'private'}}}};
}
function message(text,id=1,replyText){
  const out={update_id:id,message:{text,from:{id:77},chat:{id:77,type:'private'}}};
  if(replyText)out.message.reply_to_message={text:replyText};
  return out;
}
async function run(update,db){
  const sent=[];const answers=[];const actions=[];
  const oldSend=bot.sendMessage,oldAnswer=bot.answerCallbackQuery,oldAction=bot.sendChatAction;
  bot.sendMessage=async(chatId,text,options)=>{sent.push({chatId,text,options});return{};};
  bot.answerCallbackQuery=async(id,options)=>{answers.push({id,options});return true;};
  bot.sendChatAction=async chatId=>{actions.push(chatId);return true;};
  try{return{outcome:await customer.processUpdate(update,db),sent,answers,actions};}
  finally{bot.sendMessage=oldSend;bot.answerCallbackQuery=oldAnswer;bot.sendChatAction=oldAction;}
}
function baseDb(extra){return{claimUpdate:async()=>true,releaseUpdate:async()=>true,cancelCheckout:async()=>true,...extra};}
const package90={id:'p90',slug:'channel-90',name:'Bot 90 Hari',price_idr:120000,duration_days:90,lifetime:false,product_type:'membership'};

test('package buttons open detail and checkout screens without creating a purchase',async()=>{
  let purchases=0;
  const db=baseDb({packageBySlug:async()=>package90,createPurchase:async()=>{purchases++;}});
  const detail=await run(callback('package:channel-90',10),db);
  assert.equal(detail.outcome,'package_detail');
  assert.match(detail.sent[0].text,/Channel 30 hari pertama/);
  assert.match(detail.sent[0].text,/Rp10\.000/);
  assert.equal(purchases,0);
  const checkout=await run(callback('checkout:channel-90',11),db);
  assert.equal(checkout.outcome,'checkout');
  assert.match(checkout.sent[0].text,/Punya Voucher|kode voucher/);
  assert.equal(purchases,0);
});

test('voucher choice creates a short checkout session and uses ForceReply',async()=>{
  let began;
  const db=baseDb({packageBySlug:async()=>package90,beginCheckout:async(id,slug)=>{began={id,slug};}});
  const result=await run(callback('voucher:channel-90',20),db);
  assert.equal(result.outcome,'voucher_prompt');
  assert.deepEqual(began,{id:77,slug:'channel-90'});
  assert.equal(result.sent.length,2);
  assert.equal(result.sent[1].options.reply_markup.force_reply,true);
  assert.match(result.sent[1].text,/MASUKKAN KODE VOUCHER/);
});

test('only replies to the voucher prompt consume raw voucher text',async()=>{
  let voucher;
  const prompt='🎟️ MASUKKAN KODE VOUCHER\n\nPaket: Bot 90 Hari';
  const db=baseDb({
    account:async()=>({verified:true}),
    checkoutSession:async()=>({packageSlug:'channel-90',packageName:'Bot 90 Hari',priceIdr:120000}),
    checkoutPurchase:async(_id,code)=>{voucher=code;return{packageName:'Bot 90 Hari',finalAmount:90000,bankInstructions:'Transfer ke rekening staging.',purchaseId:'123e4567-e89b-42d3-a456-426614174000'};}
  });
  assert.equal(customer.isMembershipUpdate(message('SAVE2026',30)),false);
  const result=await run(message('SAVE2026',31,prompt),db);
  assert.equal(result.outcome,'voucher_purchase_created');
  assert.equal(voucher,'SAVE2026');
  assert.match(result.sent[0].text,/Rp90\.000/);
});

test('no-voucher checkout creates one purchase and exposes a cancellation button',async()=>{
  let calls=0;
  const purchase={packageName:'Bot 90 Hari',finalAmount:120000,bankInstructions:'Transfer ke rekening staging.',purchaseId:'123e4567-e89b-42d3-a456-426614174000'};
  const db=baseDb({packageBySlug:async()=>package90,createPurchase:async()=>{calls++;return purchase;}});
  const result=await run(callback('novoucher:channel-90',40),db);
  assert.equal(result.outcome,'purchase_created');
  assert.equal(calls,1);
  assert.equal(result.sent[0].options.reply_markup.inline_keyboard[0][0].callback_data,'cancelpurchase:'+purchase.purchaseId);
});

test('an awaiting-payment purchase can be cancelled through its own button',async()=>{
  let cancelled;
  const id='123e4567-e89b-42d3-a456-426614174000';
  const db=baseDb({cancelPurchase:async(telegramId,purchaseId)=>{cancelled={telegramId,purchaseId};return true;}});
  const result=await run(callback('cancelpurchase:'+id,50),db);
  assert.equal(result.outcome,'purchase_cancelled');
  assert.deepEqual(cancelled,{telegramId:77,purchaseId:id});
  assert.match(result.sent[0].text,/dibatalkan/);
});

test('channel access comes from server-owned channel flags rather than every paid term',()=>{
  const base={verified:true,accountStatus:'approved',blocked:false,botAccess:true,dashboardAccess:false,entitlement:{status:'active',lifetime:false,endsAt:'2099-01-01'}};
  assert.equal(core.accessFor({...base,channelAccess:false}).channel,false);
  assert.equal(core.accessFor({...base,channelAccess:true}).channel,true);
  assert.equal(core.accessFor({...base,entitlement:{status:'active',lifetime:true,endsAt:null},channelAccess:true,dashboardAccess:true}).dashboard,true);
});

test('V2 migrations encode checkout, Rp10k renewal, and hard channel expiry guards',()=>{
  const schema=fs.readFileSync('supabase/telegram-membership-v2-01-checkout-schema.sql','utf8');
  const approval=fs.readFileSync('supabase/telegram-membership-v2-02-channel-approval.sql','utf8');
  const expiry=fs.readFileSync('supabase/telegram-membership-v2-03-channel-expiry-guard.sql','utf8');
  assert.match(schema,/channel-addon-30/);
  assert.match(schema,/30,false,10000,true/);
  assert.match(schema,/Bot 30 Hari[\s\S]*Tidak termasuk akses channel/);
  assert.match(schema,/Bot 90 Hari[\s\S]*channel untuk 30 hari pertama/);
  assert.match(schema,/membership_checkout_sessions/);
  assert.match(schema,/membership_cancel_purchase/);
  assert.match(approval,/base_package\.duration_days=90/);
  assert.match(approval,/covered_end\+interval '30 days'/);
  assert.match(approval,/channel_not_included/);
  assert.match(expiry,/grant_row\.expires_at IS NOT NULL AND grant_row\.expires_at<=now\(\)/);
  assert.match(expiry,/expires_at IS NULL OR expires_at>now\(\)/);
  assert.doesNotMatch(schema+approval+expiry,/password_hash|device_id|raw_code|voucher_pepper/);
});
