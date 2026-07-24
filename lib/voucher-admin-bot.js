'use strict';
const crypto=require('crypto');
const vouchers=require('./vouchers');
const {isVoucherAdminBotEnabled,getVoucherAdminCapability}=require('./subscription-capability');
const {createVoucherAdminSender}=require('./voucher-admin-sender');
const SESSION_TTL_MS=20*60*1000, CHUNK_SIZE=100, MESSAGE_CODE_LIMIT=40, DOCUMENT_BYTES=900000;
const TYPES=['PERCENT_30','PERCENT_50','PERCENT_100','LIFETIME'];
const TERM_PLANS=['PREMIUM_1_MONTH','PREMIUM_2_MONTHS','PREMIUM_3_MONTHS'];
const MENU='🔐 <b>Admin Voucher</b>\nPilih menu atau gunakan /buatvoucher, /daftarvoucher, /detailvoucher, /nonaktifkanvoucher, /auditvoucher, /statistiklifetime, /batal.';
function menuKeyboard(){return {inline_keyboard:[[{text:'Buat Voucher',callback_data:'v:begin'}],[{text:'Daftar Voucher',callback_data:'v:list'}],[{text:'Detail Voucher',callback_data:'v:detail'}],[{text:'Nonaktifkan Voucher',callback_data:'v:disable'}],[{text:'Audit Voucher',callback_data:'v:audit'}],[{text:'Statistik Lifetime',callback_data:'v:stats'}]]};}
function safeReference(prefix){return prefix+'-'+crypto.randomBytes(6).toString('hex').toUpperCase();}
function validRef(value){return typeof value==='string'&&/^(?:VB|VV)-[A-F0-9]{12}$/.test(value);}
function adminUpdate(update){const q=update&&update.callback_query, m=update&&(update.message||q&&q.message), from=(q&&q.from)||(m&&m.from), chat=m&&m.chat; if(!Number.isSafeInteger(update&&update.update_id)||!m||!from||chat.type!=='private'||!Number.isSafeInteger(from.id)||!Number.isSafeInteger(chat.id)||chat.id!==from.id||!vouchers.isVoucherAdminTelegramUser(from.id)||m.forward_from||m.forward_sender_name||m.sender_chat) return null; return {message:m,from,chat,callback:q||null};}
function parseCommand(text){const m=/^\/(start|menu|buatvoucher|daftarvoucher|detailvoucher|nonaktifkanvoucher|auditvoucher|statistiklifetime|batal)(?:@\w+)?(?:\s+([A-Za-z0-9-]+))?\s*$/i.exec(typeof text==='string'?text:''); return m&&{name:m[1].toLowerCase(),argument:m[2]||null};}
function formatCodes(codes, batch){return codes.map(c=>c+' | '+batch.voucher_type+' | '+batch.plan_code).join('\n');}
async function processVoucherAdminUpdate(update,deps) {
 const d=deps||{}, db=d.db, sender=d.sender||createVoucherAdminSender(d), cap=d.capability||await getVoucherAdminCapability(db,d.env);
 if(!isVoucherAdminBotEnabled(d.env)||!cap.ready||!db) return {outcome:'unavailable'};
 const input=adminUpdate(update); if(!input) return {outcome:'ignored'};
 // RPC deliberately stores only update id/outcome, never update/text/callback data.
 const claimed=await db.rpc('claim_voucher_admin_webhook_update',{p_update_id:update.update_id}); if(claimed.error||claimed.data===false) return {outcome:'duplicate'};
 const reply=async(text,extra)=>sender.sendMessage(input.chat.id,text,extra);
 const command=parseCommand(input.message.text);
 if(command){
  if(command.name==='start'||command.name==='menu') {await reply(MENU,{reply_markup:menuKeyboard()}); return {outcome:'menu'};}
  if(command.name==='batal'){await db.rpc('clear_voucher_admin_session',{p_telegram_user_id:input.from.id}); await reply('Percakapan voucher dibatalkan.'); return {outcome:'cancelled'};}
  if(command.name==='buatvoucher'){const r=await db.rpc('start_voucher_admin_session',{p_telegram_user_id:input.from.id,p_expires_at:new Date(Date.now()+SESSION_TTL_MS).toISOString()}); if(r.error) return {outcome:'failed'}; await reply('Pilih tipe voucher.',{reply_markup:{inline_keyboard:[TYPES.map(t=>({text:t.replace('PERCENT_','')+(t==='LIFETIME'?'Lifetime':'%'),callback_data:'v:type:'+t}))]}}); return {outcome:'started'};}
  if(['daftarvoucher','detailvoucher','nonaktifkanvoucher','auditvoucher','statistiklifetime'].includes(command.name)){const result=await db.rpc('voucher_admin_command',{p_command:command.name,p_reference:command.argument&&validRef(command.argument)?command.argument:null}); if(command.name==='statistiklifetime') await reply('Statistik Lifetime\nAkses lifetime tidak memiliki batas jumlah pengguna.'); else await reply('Permintaan admin diterima. Gunakan referensi aman pada menu untuk hasil terperinci.'); return {outcome:result.error?'failed':'command'};}
 }
 if(!input.callback) {
   const quantity=typeof input.message.text==='string' && /^[1-9][0-9]*$/.test(input.message.text.trim()) ? Number(input.message.text.trim()) : 0;
   if (!Number.isSafeInteger(quantity) || quantity<1) return {outcome:'ignored'};
   const advanced=await db.rpc('set_voucher_admin_quantity',{p_telegram_user_id:input.from.id,p_requested_quantity:quantity,p_confirmation_key:crypto.randomUUID()});
   if (advanced.error || !advanced.data) { await reply('Jumlah tidak dapat digunakan. Mulai ulang dengan /buatvoucher.'); return {outcome:'invalid_quantity'}; }
   const session=advanced.data, lifetime=session.voucher_type==='LIFETIME';
   const summary='<b>Konfirmasi batch</b>\nTipe: '+session.voucher_type+'\nPaket: '+session.plan_code+'\nJumlah: '+quantity+'\nMulai: segera\nBerakhir: tanpa kedaluwarsa\nMaks/kode: 1\nMaks/pengguna: 1'+(lifetime?'\nJumlah pengguna lifetime tidak dibatasi.':'');
   await reply(summary,{reply_markup:{inline_keyboard:[[{text:'Konfirmasi buat',callback_data:'v:confirm:'+session.confirmation_key},{text:'Batal',callback_data:'v:cancel'}]]}});
   return {outcome:'quantity'};
 }
 const data=input.callback.data; if(typeof data!=='string'||!/^v:(?:begin|list|detail|disable|audit|stats|continue:VB-[A-F0-9]{12}|type:(?:PERCENT_30|PERCENT_50|PERCENT_100|LIFETIME)|plan:[A-Z0-9_]+|confirm:[A-F0-9-]{16,64}|cancel)$/.test(data)){await sender.answerCallbackQuery(input.callback.id,{text:'Tombol kedaluwarsa.'});return {outcome:'stale'};}
 await sender.answerCallbackQuery(input.callback.id);
 if(data==='v:begin'){const r=await db.rpc('start_voucher_admin_session',{p_telegram_user_id:input.from.id,p_expires_at:new Date(Date.now()+SESSION_TTL_MS).toISOString()});if(r.error)return {outcome:'failed'};await reply('Pilih tipe voucher.',{reply_markup:{inline_keyboard:[TYPES.map(t=>({text:t.replace('PERCENT_','')+(t==='LIFETIME'?'Lifetime':'%'),callback_data:'v:type:'+t}))]}});return {outcome:'started'};}
 if(data.startsWith('v:type:')){const type=data.slice(7); const lifetime=type==='LIFETIME'; const r=await db.rpc('advance_voucher_admin_session',{p_telegram_user_id:input.from.id,p_step:lifetime?'quantity':'plan',p_voucher_type:type,p_plan_code:lifetime?'LIFETIME':null});if(r.error)return {outcome:'failed'};if(lifetime){await reply('Paket Lifetime dipilih otomatis. Kirim jumlah voucher sebagai angka bulat positif.');return {outcome:'type'};}await reply('Pilih paket.',{reply_markup:{inline_keyboard:[TERM_PLANS.map(p=>({text:p,callback_data:'v:plan:'+p}))]}});return {outcome:'type'};}
 if(data.startsWith('v:plan:')){const plan=data.slice(7);const r=await db.rpc('advance_voucher_admin_session',{p_telegram_user_id:input.from.id,p_step:'quantity',p_voucher_type:null,p_plan_code:plan});if(r.error)return {outcome:'failed'};await reply('Kirim jumlah voucher sebagai angka bulat positif.');return {outcome:'plan'};}
 if(['v:list','v:detail','v:disable','v:audit'].includes(data)){const command={ 'v:list':'daftarvoucher','v:detail':'detailvoucher','v:disable':'nonaktifkanvoucher','v:audit':'auditvoucher'}[data];const result=await db.rpc('voucher_admin_command',{p_command:command,p_reference:null});await reply(result.data&&result.data.message||'Tidak ada data voucher yang dapat ditampilkan.');return {outcome:result.error?'failed':'command'};}
 if(data.startsWith('v:continue:')) return continueBatch(input,d,reply,sender,data.slice(11));
 if(data==='v:stats'){await db.rpc('voucher_admin_command',{p_command:'statistiklifetime',p_reference:null});await reply('Statistik Lifetime\nAkses lifetime tidak memiliki batas jumlah pengguna.');return {outcome:'command'};}
 if(data==='v:cancel'){await db.rpc('clear_voucher_admin_session',{p_telegram_user_id:input.from.id});await reply('Percakapan voucher dibatalkan.');return {outcome:'cancelled'};}
 if(data.startsWith('v:confirm:')) return confirm(input,d,reply,data.slice(10),sender);
 return {outcome:'menu'};
}
async function deliverOneChunk(input,d,reply,sender,batch){
 const claim=await d.db.rpc('claim_voucher_admin_batch_chunk',{p_batch_reference:batch.batch_reference}); if(claim.error||!claim.data||claim.data.done)return {outcome:'complete',generated:0};
 const chunk=claim.data, count=chunk.count, codes=[]; for(let i=0;i<count;i++) codes.push(vouchers.generateVoucherCode());
 try { const saved=await d.db.rpc('insert_voucher_admin_batch_items',{p_batch_reference:batch.batch_reference,p_chunk_index:chunk.chunk_index,p_items:codes.map(code=>({code_hash:vouchers.voucherCodeHash(code),code_hint:vouchers.voucherCodeHint(code)}))}); if(saved.error)throw new Error('unavailable');
  if(count<=MESSAGE_CODE_LIMIT)await reply('<b>'+batch.batch_reference+'</b>\n<pre>'+formatCodes(codes,batch)+'</pre>'); else await sender.sendDocument(input.chat.id,'vouchers-'+batch.batch_reference+'-'+chunk.chunk_index+'.txt',Buffer.from(formatCodes(codes,batch),'utf8'));
  const fin=await d.db.rpc('finalize_voucher_admin_batch_chunk',{p_batch_reference:batch.batch_reference,p_chunk_index:chunk.chunk_index});if(fin.error)throw new Error('unavailable');
  const next=fin.data&&fin.data.complete?'':' Lanjutkan: /menu'; return {outcome:'delivered',generated:count,message:next};
 }catch(_){await d.db.rpc('cancel_voucher_admin_batch_chunk',{p_batch_reference:batch.batch_reference,p_chunk_index:chunk.chunk_index});return {outcome:'delivery_failed',generated:0};}
}
async function confirm(input,d,reply,key,sender){const made=await d.db.rpc('create_voucher_admin_batch',{p_telegram_user_id:input.from.id,p_confirmation_key:key});if(made.error||!made.data)return {outcome:'failed'};const result=await deliverOneChunk(input,d,reply,sender,made.data);if(result.outcome==='delivered'&&result.message)await reply('Bagian dikirim. Gunakan tombol lanjutkan.',{reply_markup:{inline_keyboard:[[{text:'Lanjutkan batch',callback_data:'v:continue:'+made.data.batch_reference}]]}});return result;}
async function continueBatch(input,d,reply,sender,reference){const r=await d.db.rpc('get_voucher_admin_batch_progress',{p_batch_reference:reference});if(r.error||!r.data)return {outcome:'failed'};const result=await deliverOneChunk(input,d,reply,sender,r.data);if(result.outcome==='delivered'&&result.message)await reply('Bagian dikirim. Lanjutkan batch.',{reply_markup:{inline_keyboard:[[{text:'Lanjutkan batch',callback_data:'v:continue:'+reference}]]}});return result;}

module.exports={SESSION_TTL_MS,CHUNK_SIZE,MESSAGE_CODE_LIMIT,DOCUMENT_BYTES,TYPES,TERM_PLANS,MENU,menuKeyboard,safeReference,validRef,adminUpdate,parseCommand,processVoucherAdminUpdate,confirm,continueBatch,deliverOneChunk};
