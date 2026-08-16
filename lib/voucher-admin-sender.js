'use strict';
// Server-only Telegram transport for voucher administration. It intentionally
// shares AutoCuan Verification's bot token; admin authorization is enforced by
// verified Telegram identity + service-role-only RPCs, not by a separate bot.
const TIMEOUT_MS=8000;
function configured(env) { const e=env||process.env; return e.VOUCHER_ADMIN_BOT_ENABLED==='true' && e.SUBSCRIPTION_FEATURE_ENABLED==='true' && typeof e.TELEGRAM_VERIFY_BOT_TOKEN==='string' && e.TELEGRAM_VERIFY_BOT_TOKEN.length>=16; }
function telegramError() { return new Error('voucher delivery unavailable'); }
function createVoucherAdminSender(options) {
  const opts=options||{}, env=opts.env||process.env, fetcher=opts.fetch||global.fetch;
  async function call(method, payload, multipart) {
    if (!configured(env) || typeof fetcher!=='function') throw telegramError();
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),TIMEOUT_MS);
    try {
      const response=await fetcher('https://api.telegram.org/bot'+env.TELEGRAM_VERIFY_BOT_TOKEN+'/'+method,{method:'POST',headers:multipart?{}:{'content-type':'application/json'},body:multipart||JSON.stringify(payload),signal:controller.signal});
      const body=await response.json().catch(()=>null);
      if (!response.ok || !body || body.ok!==true) throw telegramError();
      return body.result;
    } catch (_) { throw telegramError(); } finally { clearTimeout(timeout); }
  }
  return {
    sendMessage:(chat_id,text,extra)=>call('sendMessage',Object.assign({chat_id,text,parse_mode:'HTML',disable_web_page_preview:true},extra)),
    editMessageText:(chat_id,message_id,text,extra)=>call('editMessageText',Object.assign({chat_id,message_id,text,parse_mode:'HTML'},extra)),
    deleteMessage:(chat_id,message_id)=>call('deleteMessage',{chat_id,message_id}),
    answerCallbackQuery:(callback_query_id,extra)=>call('answerCallbackQuery',Object.assign({callback_query_id},extra)),
    sendDocument:(chat_id,filename,content,extra)=>{ if(!configured(env)||typeof FormData==='undefined'||typeof Blob==='undefined') return Promise.reject(telegramError()); const form=new FormData(); form.set('chat_id',String(chat_id)); form.set('document',new Blob([content],{type:'text/plain;charset=utf-8'}),filename); Object.entries(extra||{}).forEach(([k,v])=>form.set(k,String(v))); return call('sendDocument',null,form); }
  };
}
module.exports={TIMEOUT_MS,configured,createVoucherAdminSender};
