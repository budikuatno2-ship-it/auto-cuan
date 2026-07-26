(function () {
  'use strict';
  var access = window.__AUTOCUAN_PORTFOLIO_ACCESS__ || {};
  var uid = String(access.userId || localStorage.getItem('autocuan_user_id') || '');
  var chatKey = 'autocuan_portfolio_ai_chat_' + uid;
  var state = { messages: [] };

  function byId(id) { return document.getElementById(id); }
  function money(value) { var n=Number(value); return Number.isFinite(n) ? 'Rp '+Math.round(n).toLocaleString('id-ID') : '—'; }
  function readJson(key, fallback) { try { var raw=localStorage.getItem(key); return raw?JSON.parse(raw):fallback; } catch (_) { return fallback; } }
  function plansKey() { return 'autocuan_portfolio_plans_' + uid; }
  function pricesKey() { return 'autocuan_portfolio_prices_' + uid; }

  function currentContext() {
    var plans = readJson(plansKey(), []); if (!Array.isArray(plans)) plans=[];
    var prices = readJson(pricesKey(), {}); if (!prices || typeof prices!=='object') prices={};
    var withPrice=0, missing=0, totalRisk=0, totalValue=0;
    plans.forEach(function(p){
      var ticker=String(p.ticker||'').toUpperCase(), price=Number(prices[ticker]);
      if(Number.isFinite(price)&&price>0)withPrice++;else missing++;
      totalRisk+=Number(p.estimatedMaxLossIdr||p.riskBudgetIdr||0)||0;
      totalValue+=(Number(p.entryPriceIdr||0)||0)*(Number(p.lots||0)||0)*100;
    });
    return { plans:plans.slice(0,30), prices:prices, summary:{plan_count:plans.length,positions_with_price:withPrice,positions_missing_price:missing,total_estimated_risk:totalRisk,total_position_value:totalValue} };
  }

  function polishExistingUi() {
    var badge=document.querySelector('.badge'); if(badge) badge.textContent='Akses Disetujui';
    var title=document.querySelector('.brand h1'); if(title) title.textContent='Portfolio Decision Center';
    var sub=document.querySelector('.brand p'); if(sub) sub.textContent='Rencanakan posisi, pantau risiko, dan ambil keputusan dengan lebih tenang.';
    var tabs=document.querySelectorAll('.tab');
    var labels=['Ringkasan','Rencana Posisi','Pantauan','Risiko & Avg Down','Pengingat Harga','Asisten AI'];
    tabs.forEach(function(tab,index){if(labels[index])tab.textContent=labels[index]});
    document.querySelectorAll('h2').forEach(function(h){if(h.textContent.trim()==='Sektor Hot Setelah Close')h.textContent='Sektor Hot Terbaru'});
    document.querySelectorAll('p').forEach(function(p){if(p.textContent.indexOf('Membaca cache VPS')>=0)p.textContent='Ringkasan sektor yang terakhir diperbarui setelah pasar tutup.'});
    var json=byId('json'), imp=byId('import');
    if(json){
      var heading=json.previousElementSibling;
      if(heading){heading.textContent='Isi otomatis dari Screener';heading.insertAdjacentHTML('afterend','<div class="portfolio-friendly-note">Saat saham dibuka dari Screener, ticker dan level rencana akan terisi otomatis. Input manual tetap dapat digunakan.</div>')}
      json.style.display='none';
    }
    if(imp)imp.style.display='none';
  }

  function renderDataSummary() {
    var ctx=currentContext(), s=ctx.summary;
    if(byId('aiPlanCount'))byId('aiPlanCount').textContent=String(s.plan_count);
    if(byId('aiWithPrice'))byId('aiWithPrice').textContent=String(s.positions_with_price);
    if(byId('aiMissingPrice'))byId('aiMissingPrice').textContent=String(s.positions_missing_price);
    if(byId('aiTotalRisk'))byId('aiTotalRisk').textContent=money(s.total_estimated_risk);
    if(byId('aiTotalValue'))byId('aiTotalValue').textContent=money(s.total_position_value);
    var quality=byId('aiDataQuality');
    if(quality)quality.textContent=s.plan_count===0?'Belum ada rencana tersimpan.':(s.positions_missing_price>0?'Sebagian posisi belum memiliki harga terbaru.':'Data lokal cukup untuk analisis portofolio dasar.');
  }

  function saveChat(){try{localStorage.setItem(chatKey,JSON.stringify(state.messages.slice(-20)))}catch(_){}}
  function loadChat(){var rows=readJson(chatKey,[]);state.messages=Array.isArray(rows)?rows.slice(-20):[]}
  function addMessage(role,content,persist){state.messages.push({role:role,content:String(content||'')});if(persist!==false)saveChat();renderChat()}
  function renderChat(){
    var host=byId('aiMessages');if(!host)return;host.innerHTML='';
    if(!state.messages.length){var intro=document.createElement('div');intro.className='ai-message ai-system';intro.textContent='Tanyakan risiko, alokasi, rencana posisi, atau ceritakan kekhawatiranmu. Jawaban akan membedakan data, analisis logis, dan saran umum.';host.appendChild(intro)}
    state.messages.forEach(function(m){var div=document.createElement('div');div.className='ai-message '+(m.role==='user'?'ai-user':'ai-assistant');div.textContent=m.content;host.appendChild(div)});host.scrollTop=host.scrollHeight;
  }

  async function sendMessage(text){
    text=String(text||'').trim();if(!text)return;
    addMessage('user',text,true);var input=byId('aiInput'),send=byId('aiSend'),status=byId('aiStatus');if(input)input.value='';if(send)send.disabled=true;if(status)status.textContent='Menganalisis data portofolio…';
    try{
      var history=state.messages.slice(0,-1).slice(-8);
      var response=await fetch('/api/analyze',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'portfolio_chat',chatMessage:text,context:currentContext(),history:history})});
      var data=await response.json();if(!response.ok||!data.success)throw new Error(data.error||'Asisten AI belum tersedia.');
      addMessage('assistant',data.reply,true);if(status)status.textContent=data.portfolio_data_used?'Jawaban menggunakan data portofolio tersimpan.':'Jawaban umum; belum ada data portofolio yang digunakan.';
    }catch(error){addMessage('assistant',String(error&&error.message||'Asisten AI sedang tidak tersedia.'),true);if(status)status.textContent='Tidak ada data yang diubah.'}finally{if(send)send.disabled=false;renderDataSummary()}
  }

  function initAi(){
    loadChat();renderChat();renderDataSummary();
    var send=byId('aiSend'),input=byId('aiInput'),clear=byId('aiClear');
    if(send)send.onclick=function(){sendMessage(input&&input.value)};
    if(input)input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage(input.value)}});
    if(clear)clear.onclick=function(){state.messages=[];saveChat();renderChat();if(byId('aiStatus'))byId('aiStatus').textContent='Riwayat percakapan lokal dihapus.'};
    document.querySelectorAll('[data-ai-prompt]').forEach(function(btn){btn.onclick=function(){sendMessage(btn.getAttribute('data-ai-prompt'))}});
    window.addEventListener('storage',renderDataSummary);
  }

  function init(){polishExistingUi();initAi()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
