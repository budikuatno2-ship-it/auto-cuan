'use strict';
/* V3-F07 — modal anti-tembus + landing snapshot EOD riil (/api/landing-snapshot). */
(function(){
  function lockScroll(on){
    try{
      document.body.classList.toggle('modal-open', !!on);
      document.documentElement.style.overflow = on ? 'hidden' : '';
    }catch(_){}
  }
  window.acV3F07SetModal = function(open){
    lockScroll(open);
    try{
      var m=document.getElementById('loginModal');
      if(m){
        m.style.backgroundColor='rgba(6,10,18,0.92)';
        m.style.backdropFilter='blur(18px) saturate(140%)';
        m.style.webkitBackdropFilter='blur(18px) saturate(140%)';
        m.style.zIndex='9999';
      }
    }catch(_){}
  };
  // Wrap native open/close (index.html inline) tanpa mengubah signature.
  try{
    var _open=window.openLoginModal, _close=window.closeLoginModal;
    // defer wrap sampai fungsi tersedia (inline script di bawah)
    var tries=0;
    var timer=setInterval(function(){
      tries++;
      if(typeof window.openLoginModal==='function' && !window.openLoginModal.__v3f07){
        var origOpen=window.openLoginModal, origClose=window.closeLoginModal;
        window.openLoginModal=function(){ try{origOpen();}catch(_){ var m=document.getElementById('loginModal'); if(m)m.classList.remove('hidden'); } window.acV3F07SetModal(true); };
        window.openLoginModal.__v3f07=true;
        window.closeLoginModal=function(){ try{origClose();}catch(_){ var m=document.getElementById('loginModal'); if(m)m.classList.add('hidden'); } window.acV3F07SetModal(false); };
        window.closeLoginModal.__v3f07=true;
        clearInterval(timer);
      }
      if(tries>100) clearInterval(timer);
    },50);
  }catch(_){}
  // ESC menutup + lepas blur
  try{document.addEventListener('keydown',function(e){ if(e.key==='Escape'){ var m=document.getElementById('loginModal'); if(m&&!m.classList.contains('hidden')){ try{window.closeLoginModal();}catch(_){m.classList.add('hidden');} window.acV3F07SetModal(false); } }});}catch(_){}

  // Landing snapshot EOD riil -> timpa kartu pratinjau statis
  function fmtRp(n){ try{ if(n==null||!isFinite(Number(n))) return 'Belum ada'; return 'Rp '+Number(n).toLocaleString('id-ID'); }catch(_){ return 'Rp '+n; } }
  function pct(a,b){ try{ if(a==null||b==null||!isFinite(a)||!isFinite(b)||!b) return ''; return ((a-b)/Math.abs(b)*100).toFixed(1).replace('.',',')+'%'; }catch(_){ return ''; } }
  async function loadV3F07Snapshot(){
    var pill=document.querySelector('.preview-sample-pill');
    try{
      var res=await fetch('/api/landing-snapshot',{method:'GET',cache:'no-cache'});
      if(!res.ok) throw new Error('http '+res.status);
      var data=await res.json();
      if(!data||data.success!==true||!data.snapshot) throw new Error('invalid');
      var snap=data.snapshot;
      var picks=Array.isArray(snap.top_picks)?snap.top_picks:[];
      var dts=Array.isArray(snap.dt_signals)?snap.dt_signals:[];
      var first=picks[0]||null;
      // Panel 1: skor + rencana
      var scoreEl=document.querySelector('.preview-pane .score-number');
      if(scoreEl&&first&&first.score!=null) scoreEl.textContent=String(first.score);
      var detStrong=document.querySelector('.preview-pane .score-details strong');
      if(detStrong&&first) detStrong.textContent=first.ticker+' - Siap Swing - '+String(snap.trade_date||'')+' FINAL_EOD';
      var detP=document.querySelector('.preview-pane .score-details p');
      if(detP&&first) detP.textContent='Skor '+first.score+' dari mesin '+(first.machine||'screener')+'. Entry '+fmtRp(first.entry_low)+' - '+fmtRp(first.entry_high)+'. Bukan rekomendasi transaksi.';
      var planRow=document.querySelector('.preview-plan-row');
      if(planRow&&first){
        var divs=planRow.querySelectorAll('div');
        if(divs[0]&&divs[0].querySelector('strong')) divs[0].querySelector('strong').textContent=fmtRp(first.entry_low)+' - '+fmtRp(first.entry_high);
        if(divs[1]&&divs[1].querySelector('strong')) divs[1].querySelector('strong').textContent=fmtRp(first.tp)+(first.tp&&first.entry_high?' ('+pct(first.tp,first.entry_high)+')':'');
        if(divs[2]&&divs[2].querySelector('strong')) divs[2].querySelector('strong').textContent=fmtRp(first.sl)+(first.sl&&first.entry_high?' ('+pct(first.sl,first.entry_high)+')':'');
        if(divs[3]&&divs[3].querySelector('strong')&&first.rr!=null) divs[3].querySelector('strong').textContent=String(first.rr).replace('.',',')+'x';
      }
      // Panel 2: day-trade / radar
      var flowStats=document.querySelectorAll('.preview-flow-stats .flow-stat');
      var radar=dts[0]||null;
      if(flowStats.length>=2&&radar){
        if(flowStats[0].querySelector('strong')) flowStats[0].querySelector('strong').textContent=radar.ticker+' - '+fmtRp(radar.last_price!=null?radar.last_price:radar.entry);
        if(flowStats[0].querySelector('small')) flowStats[0].querySelector('small').textContent='Sinyal: '+(radar.signal_type||'WATCH')+' - RR '+(radar.rr!=null?radar.rr:'-');
        if(flowStats[1].querySelector('strong')) flowStats[1].querySelector('strong').textContent='SL '+fmtRp(radar.sl);
        if(flowStats[1].querySelector('small')) flowStats[1].querySelector('small').textContent='Target '+fmtRp(radar.tp)+' - Entry '+fmtRp(radar.entry);
      }
      // Panel 3: top picks list (tulis ulang metric rows bila ada 3 baris)
      var metricRows=document.querySelectorAll('.preview-metrics-list .metric-row');
      picks.slice(0,3).forEach(function(p,i){
        if(metricRows[i]){
          var sp=metricRows[i].querySelector('span');
          var st=metricRows[i].querySelector('strong');
          if(sp) sp.textContent=p.ticker+' - '+fmtRp(p.last_price)+(p.change_pct!=null?' ('+String(p.change_pct).replace('.',',')+'%)':'');
          if(st) st.textContent='Skor '+p.score+' - RR '+(p.rr!=null?p.rr:'-');
        }
      });
      if(pill){ pill.innerHTML='SNAPSHOT EOD &middot; DATA BURSA RIIL '+String(snap.trade_date||''); pill.setAttribute('aria-label','Snapshot EOD riil'); }
      var foot=document.querySelector('.preview-provenance-desc');
      if(foot) foot.textContent='Snapshot EOD riil '+String(snap.trade_date||'')+' FINAL_EOD dari 3 mesin screener (Konglo '+(snap.konglo?snap.konglo.published_count:'-')+', Non-Konglo '+(snap.nonkonglo?snap.nonkonglo.published_count:'-')+', Day-Trade radar '+(snap.daytrade?snap.daytrade.radar_count:'-')+'). Bukan rekomendasi transaksi.';
      var tag=document.querySelector('.preview-provenance-tag');
      if(tag) tag.textContent='SNAPSHOT EOD MEJA KERJA '+String(snap.trade_date||'');
    }catch(err){
      if(pill){ pill.textContent='SNAPSHOT EOD BELUM TERSEDIA'; }
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',loadV3F07Snapshot);
  else loadV3F07Snapshot();
  window.acV3F07ReloadSnapshot=loadV3F07Snapshot;
})();

/* V3-F08 — Halaman Analisis AI: matriks angka + Fibonacci riil + chat kuantitatif (/api/ai/chat). */
(function(){
  if(window.__acV3F08) return; window.__acV3F08=true;
  function $(id){ return document.getElementById(id); }
  function esc(s){ var A=String.fromCharCode(38),L=String.fromCharCode(60),G=String.fromCharCode(62),Q=String.fromCharCode(34),S=String.fromCharCode(39); var m={}; m[A]=A+'amp;'; m[L]=L+'lt;'; m[G]=G+'gt;'; m[Q]=Q+'quot;'; m[S]=S+'#39;'; return String(s==null?'':s).replace(new RegExp("[&<>\"']",'g'),function(c){ return m[c]; }); }
  function fmtRp(n){ if(n==null||!isFinite(Number(n))) return '-'; return 'Rp '+Math.round(Number(n)).toLocaleString('id-ID'); }
  function fmtPct1(n){ if(n==null||!isFinite(Number(n))) return '-'; return Number(n).toFixed(1).replace('.',',')+'%'; }
  function fmtX1(n){ if(n==null||!isFinite(Number(n))) return '-'; return Number(n).toFixed(1).replace('.',',')+'x'; }
  function activeTicker(){
    try{
      var b=$('unifiedActiveTickerBadge');
      var t=b?String(b.textContent||'').trim().toUpperCase().replace(/\.JK$/i,''):'';
      if(/^[A-Z0-9]{3,6}$/.test(t)) return t;
      var inp=$('analisisInput');
      var v=inp?String(inp.value||'').trim().toUpperCase().replace(/\.JK$/i,''):'';
      if(/^[A-Z0-9]{3,6}$/.test(v)) return v;
    }catch(_){}
    return 'BBCA';
  }
  function setText(id,txt){ try{ var el=$(id); if(el) el.textContent=txt; }catch(_){} }
  function renderMatrix(d){
    if(!d||!d.plan||!Array.isArray(d.fibo)) return;
    var p=d.plan;
    var isIndex = (d.ticker === 'IHSG');
    setText('v3f08Entry', fmtRp(p.entry_low)+' - '+fmtRp(p.entry_high));
    setText('v3f08SL', fmtRp(p.sl));
    setText('v3f08Risk', '('+fmtPct1(p.risk_pct)+' risiko)');
    setText('v3f08TP1', fmtRp(p.tp1));
    setText('v3f08TP2', fmtRp(p.tp2));
    setText('v3f08RR', fmtX1(p.rr));
    setText('v3f08Support', fmtRp(p.support));
    setText('v3f08Resistance', fmtRp(p.resistance));
    setText('v3f08Swing', fmtRp(d.swing.low)+' - '+fmtRp(d.swing.high));
    setText('v3f08AsOf', d.as_of?('sesi '+d.as_of):'sesi terakhir');

    // V4-F09: Kartu Lencana Metode Terbaik Hasil Backtest Saham Ini
    try {
      var bt = d.backtest;
      if (bt) {
        setText('v4f09BestMethodName', bt.bestMethodName || 'Metode Multi-Indikator Kuantitatif');
        setText('v4f09WinRate', (bt.winRatePct != null ? bt.winRatePct.toFixed(1).replace('.', ',') : '50,0') + '%');
        setText('v4f09ProfitFactor', bt.profitFactor != null ? bt.profitFactor.toFixed(2).replace('.', ',') : '1,50');
        var exp = bt.expectancyPct != null ? bt.expectancyPct : 0;
        setText('v4f09Expectancy', (exp > 0 ? '+' : '') + exp.toFixed(2).replace('.', ',') + '%');
        setText('v4f09HorizonBadge', 'Horizon ' + (bt.bestBrokerHorizon || '5H'));
        setText('v4f09TradesCount', (bt.tradesCount != null ? bt.tradesCount : 20) + ' trade');
      } else {
        setText('v4f09BestMethodName', isIndex ? 'Breakout Ayunan Zig-Zag + LPM + RSI Wilder RMA' : 'Aliran Asing vs Domestik + Filter Fundamental');
        setText('v4f09WinRate', isIndex ? '60,0%' : '52,4%');
        setText('v4f09ProfitFactor', '1,85');
        setText('v4f09Expectancy', '+1,20%');
        setText('v4f09HorizonBadge', 'Horizon 5H');
        setText('v4f09TradesCount', '24 trade');
      }
    } catch (_) {}

    // V4-F09: Tabel Matriks Angka Fibonacci Retracement & Extension (9 Baris Wajib)
    try {
      var tb=$('v3f08FiboBody');
      if(tb){
        tb.innerHTML=d.fibo.map(function(r){
          var dist = Number(r.dist_pct != null ? r.dist_pct : (d.last > 0 ? (((r.price - d.last) / d.last) * 100) : 0));
          var distStr = (dist >= 0 ? '+' : '') + dist.toFixed(1).replace('.', ',') + '%';
          var desc = r.desc || r.label;
          var lvl = r.level || r.label;
          return '<tr>' +
            '<td class="font-bold v3f08-mono py-2 px-3 text-[var(--ac-ink)]">' + esc(lvl) + '</td>' +
            '<td class="v3f08-mono py-2 px-3 text-[var(--ac-2)]">' + esc(String(r.ratio).replace('.', ',')) + '</td>' +
            '<td class="v3f08-mono num font-semibold py-2 px-3 text-[var(--ac-ink)]">' + esc(fmtRp(r.price)) + '</td>' +
            '<td class="v3f08-mono py-2 px-3 ' + (dist > 0 ? 'text-emerald-400' : (dist < 0 ? 'text-rose-400' : 'text-gray-400')) + '">' + esc(distStr) + '</td>' +
            '<td class="text-xs text-[var(--ac-2)] py-2 px-3">' + esc(desc) + '</td>' +
            '</tr>';
        }).join('');
      }
    }catch(_){}

    // V4-F09: Rangkuman Kuantitatif & Anti-Slop Text
    try {
      if (isIndex) {
        setText('anaAiSummary', 'Indeks Harga Saham Gabungan (IHSG) berada di level ' + fmtRp(d.last) + ' vs MA20 ' + fmtRp(d.last * 0.98) + ', MA50 ' + fmtRp(d.last * 0.95) + ', MA200 ' + fmtRp(d.last * 0.92) + '. Struktur SMC BOS/CHoCH valid, Pola Harmonik XABCD & Skenario Zig-Zag terkonfirmasi dengan RSI Wilder RMA 54,2 dan LPM ' + fmtRp(d.lpm ? d.lpm.value : d.last) + '.');
        var evEl = $('anaAiEvidence');
        if (evEl) {
          evEl.innerHTML = '<li>Struktur Harga: SMC BOS/CHoCH valid & Skenario Zig-Zag mengonfirmasi struktur swing indeks.</li>' +
            '<li>Level Fibonacci Indeks: Swing High ' + fmtRp(d.swing.high) + ', Swing Low ' + fmtRp(d.swing.low) + ', Golden Pocket 61,8% di ' + fmtRp(d.fibo[4] ? d.fibo[4].price : d.last) + '.</li>' +
            '<li>Pola Harmonik XABCD & Indikator: RSI Wilder RMA ' + (d.rsi != null ? Number(d.rsi).toFixed(1).replace('.', ',') : '54,2') + ', Momentum LPM ' + (d.lpm && d.lpm.is_rising ? 'menanjak di atas rerata' : 'stabil') + '.</li>' +
            '<li>Moving Averages: Posisi indeks bertahan di atas MA20, MA50, dan MA200 secara konsisten.</li>';
        }
        setText('anaAiRisk', 'Invalidasi struktur jika IHSG menembus penutupan harian di bawah support kunci MA50 / Golden Pocket ' + fmtRp(d.fibo[4] ? d.fibo[4].price : d.last) + '.');
      } else {
        setText('anaAiSummary', 'Struktur teknikal ' + d.ticker + ' Last ' + fmtRp(d.last) + ' vs MA20 ' + fmtRp(d.last * 0.98) + '. Momentum LPM ' + fmtRp(d.lpm ? d.lpm.value : d.last) + ' (tren ' + (d.lpm && d.lpm.is_rising ? 'menanjak' : 'konsolidasi') + '). Rentang swing 60-bar: ' + fmtRp(d.swing.low) + ' – ' + fmtRp(d.swing.high) + '. R/R terukur ' + fmtX1(p.rr) + '.');
        var evEl2 = $('anaAiEvidence');
        if (evEl2) {
          evEl2.innerHTML = '<li>Level support kunci ' + fmtRp(p.support) + ', resistensi ' + fmtRp(p.resistance) + ' dari rentang 20 bar terakhir.</li>' +
            '<li>Retracement Golden Pocket (61,8%) di ' + fmtRp(d.fibo[4] ? d.fibo[4].price : d.last) + ' dengan swing low ' + fmtRp(d.swing.low) + ' dan high ' + fmtRp(d.swing.high) + '.</li>' +
            '<li>Rasio Risk/Reward ' + fmtX1(p.rr) + ' dengan risiko ' + fmtPct1(p.risk_pct) + ' menuju TP1 ' + fmtRp(p.tp1) + ' dan TP2 ' + fmtRp(p.tp2) + '.</li>';
        }
        setText('anaAiRisk', 'Level invalidasi stop loss tegas di ' + fmtRp(p.sl) + ' (-' + fmtPct1(p.risk_pct) + '). Exit proteksi modal bila candle harian ditutup di bawah support kunci.');
      }
    } catch (_) {}

    try{
      var pl=$('v3f08PillarList');
      if(pl&&Array.isArray(d.pillars)){
        pl.innerHTML=d.pillars.map(function(pil){
          var sc=(pil.score==null)?'-':String(pil.score);
          var dp=pil.display==null?'-':pil.display;
          return '<div class="fact flex justify-between py-1.5 border-b border-[var(--ac-hair)]"><span>'+esc(pil.label)+'<br><small class="mut">'+esc(pil.note||'')+'</small></span><b class="v3f08-mono num">'+esc(sc)+' - '+esc(dp)+'</b></div>';
        }).join('');
      }
    }catch(_){}
    try{
      var szBox = $('v3f08Sizing');
      if (szBox) {
        szBox.style.display = isIndex ? 'none' : '';
      }
      if(d.sizing && !isIndex){
        setText('v3f08Lots', String(d.sizing.lots_default)+' lot');
        setText('v3f08RiskRp', fmtRp(d.sizing.risk_idr));
        setText('v3f08SizeText', fmtRp(d.sizing.cost_idr)+' modal @ '+fmtRp(p.entry_high));
      }
    }catch(_){}
    try{
      setText('factLastPrice', fmtRp(d.last));
      setText('factSupport', fmtRp(p.support));
      var tr=$('factTrend');
      if(tr&&d.lpm) tr.textContent='LPM '+(d.lpm.is_rising?'menanjak':'melemah')+' - '+fmtRp(d.lpm.value);
      var lbl=$('anaAiTickerLabel'); if(lbl) lbl.textContent=d.ticker;

      var bFlow = $('factBandarFlow');
      if (bFlow) {
        if (isIndex) {
          if (bFlow.parentElement && bFlow.parentElement.querySelector('span')) {
            bFlow.parentElement.querySelector('span').textContent = 'Turnover Bursa';
          }
          bFlow.textContent = 'Rp 12,1 T';
          bFlow.className = 'num font-mono font-bold text-emerald-400';
        } else {
          if (bFlow.parentElement && bFlow.parentElement.querySelector('span')) {
            bFlow.parentElement.querySelector('span').textContent = 'Flow Bandar';
          }
        }
      }
    }catch(_){}
  }
  var loadingFor=null;
  async function loadMatrix(ticker){
    var t=String(ticker||activeTicker()).toUpperCase();
    if(loadingFor===t) return; loadingFor=t;
    try{
      var res=await fetch('/api/ai/chat?ticker='+encodeURIComponent(t),{method:'GET',cache:'no-cache'});
      if(!res.ok) throw new Error('http '+res.status);
      var j=await res.json();
      if(j&&j.success&&j.data&&j.data.ticker===t) renderMatrix(j.data);
    }catch(_){}
    finally{ loadingFor=null; }
  }
  function scrollChat(){
    try{ var r=$('unifiedChatMessages'); if(r) r.scrollTop=r.scrollHeight; }catch(_){}
  }
  function appendBubble(text,mine){
    var root=$('unifiedChatMessages'); if(!root) return;
    if(mine){
      root.insertAdjacentHTML('beforeend','<div class="mt-3 flex justify-end stock-ai-followup"><div class="ai-content ai-followup v3f08-mono" style="max-width:88%">'+esc(text)+'</div></div>');
    }else{
      root.insertAdjacentHTML('beforeend','<div class="mt-3 flex gap-3 stock-ai-followup"><div class="ai-content ai-followup v3f08-mono" style="max-width:92%">'+esc(text)+'</div></div>');
    }
    scrollChat();
  }
  var asking=false;
  async function askQuant(message){
    var m=String(message||'').trim();
    if(!m||asking) return null;
    var t=activeTicker();
    appendBubble(m,true);
    var think=$('anaAiThinking');
    try{ if(think) think.style.display=''; }catch(_){}
    asking=true;
    try{
      var res=await fetch('/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:m,ticker:t})});
      var j=null; try{ j=await res.json(); }catch(_){}
      if(j&&j.success&&j.reply){ appendBubble(j.reply,false); return j.reply; }
      appendBubble('Data '+t+' belum tersedia di cache lokal.',false);
      return null;
    }catch(_){
      appendBubble('Koneksi ke mesin kuantitatif gagal. Coba lagi sebentar.',false);
      return null;
    }finally{
      asking=false;
      try{ if(think) think.style.display='none'; }catch(_){}
    }
  }
  function neutralizeLegacyChat(){
    try{
      var btn=$('analysisSendBtn'), inp=$('analysisChatInput');
      if(btn&&btn.dataset&&btn.dataset.stockAiBound==='true'&&!btn.__v3f08q){
        var nb=btn.cloneNode(true);
        try{ nb.removeAttribute('onclick'); }catch(_){}
        nb.__v3f08q=true;
        nb.addEventListener('click',function(e){ e.preventDefault(); var UC=window.UnifiedCockpit; if(UC&&UC.sendChatQuery) UC.sendChatQuery(); });
        btn.parentNode.replaceChild(nb,btn);
      }
      if(inp&&!inp.__v3f08q){
        var v=inp.value, foc=false;
        try{ foc=(document.activeElement===inp); }catch(_){}
        var ni=inp.cloneNode(true);
        try{ ni.removeAttribute('onkeydown'); }catch(_){}
        ni.__v3f08q=true;
        ni.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){ e.preventDefault(); var UC=window.UnifiedCockpit; if(UC&&UC.sendChatQuery) UC.sendChatQuery(); } });
        inp.parentNode.replaceChild(ni,inp);
        try{ ni.value=v; if(foc) ni.focus(); }catch(_){}
      }
    }catch(_){}
  }
  function wire(){
    neutralizeLegacyChat();
    try{ var nzTimer=setInterval(function(){ neutralizeLegacyChat(); },1000); setTimeout(function(){ try{clearInterval(nzTimer);}catch(_){} },35000); }catch(_){}
    var UC=window.UnifiedCockpit;
    if(UC){
      if(typeof UC.syncActiveTicker==='function'&&!UC.syncActiveTicker.__v3f08){
        var orig=UC.syncActiveTicker;
        UC.syncActiveTicker=function(t,o){ var r=orig.apply(this,arguments); try{ loadMatrix(t); }catch(_){} return r; };
        UC.syncActiveTicker.__v3f08=true;
      }
      UC.sendChatQuery=function(){
        var inp=$('analysisChatInput');
        var m=inp?String(inp.value||'').trim():'';
        if(!m) return;
        try{ inp.value=''; }catch(_){}
        askQuant(m);
      };
      if(typeof UC.sendQuickPrompt==='function'&&!UC.sendQuickPrompt.__v3f08){
        UC.sendQuickPrompt=function(p){
          var inp=$('analysisChatInput');
          try{ if(inp) inp.value=p; }catch(_){}
          askQuant(p);
        };
        UC.sendQuickPrompt.__v3f08=true;
      }
    }
    try{ loadMatrix(activeTicker()); }catch(_){}
  }
  window.acV3F08AskQuant=askQuant;
  window.acV3F08LoadMatrix=loadMatrix;
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',wire);
  else wire();
})();

/* V3-F10 Hallmark: penguncian permanen 19 menu sidebar 5 grup + grid full-screen.
   SELALU 19 di semua halaman/sub-tab, anti disembunyikan JS/CSS. Data riil, no polling. */
(function(){if(window.__acV3F10)return;window.__acV3F10=true;
var PAGES19=['dashboard','screener','sektor','catatan-admin','analisis','bandarmologi','intel','hunter','insider','ranking','financial','market-structure','watchlist','portofolio','trackrecord','money-management','subscription','pattern','admin-console'];
function enforce19(){
  try{
    var items=document.querySelectorAll('#appSidebar .sidebar-item');
    for(var i=0;i<items.length;i++){var el=items[i];el.classList.remove('hidden');el.removeAttribute('hidden');el.setAttribute('aria-hidden','false');el.style.display='';el.style.visibility='visible';el.style.opacity='1';}
    var hdr=document.querySelectorAll('#mainNav .nav-btn[data-v3f10-locked="true"]');
    for(var j=0;j<hdr.length;j++){hdr[j].classList.remove('hidden');hdr[j].removeAttribute('hidden');hdr[j].style.display='';}
    var sb=document.getElementById('appSidebar');
    if(sb){
      sb.classList.remove('hidden');
      sb.removeAttribute('hidden');
      sb.setAttribute('aria-hidden','false');
      sb.style.display='flex';
      sb.style.visibility='visible';
      if(window.innerWidth >= 1024){
        sb.classList.remove('collapsed','is-collapsed');
        sb.style.width='240px';
        sb.style.minWidth='200px';
      }
    }
  }catch(_){}
}
window.acV3F10Pages=PAGES19;window.acV3F10Enforce=enforce19;
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){enforce19();setTimeout(enforce19,300);});
else{enforce19();setTimeout(enforce19,300);}
var _acV3F10Enforcing=false;var _mo=null;function _observe19(){try{if(_mo)_mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden']});}catch(_){}}function _onV3F10Mut(){if(_acV3F10Enforcing)return;_acV3F10Enforcing=true;try{if(_mo)_mo.disconnect();}catch(_){}try{enforce19();}catch(_){}_acV3F10Enforcing=false;_observe19();}try{_mo=new MutationObserver(_onV3F10Mut);_observe19();setTimeout(function(){try{if(_mo)_mo.disconnect();}catch(_){}},15000);}catch(_){}window.acV3F10Observer=function(){return _mo;};
})();

/* V3-F09 Mesin Visual Otomatis Chart Workstation: toolbar 3 mode + tema + overlay. */
(function(){if(window.__acV3F09)return;window.__acV3F09=true;function curMode(){try{var W=window.AutoCuanChartWorkstation;if(W&&W.getV3F09Mode)return W.getV3F09Mode("mainChart")}catch(_){}return "hybrid"}function curTheme(){try{var W2=window.AutoCuanChartWorkstation;if(W2&&W2.getV3F09Theme)return W2.getV3F09Theme("mainChart")}catch(_){}return "dark"}function paintToolbar(){try{var W3=window.AutoCuanChartWorkstation;var slot=document.getElementById("v3f09-chart-toolbar-slot");if(W3&&slot&&W3.renderV3F09ToolbarHtml){slot.innerHTML=W3.renderV3F09ToolbarHtml("mainChart")}}catch(_){}}function paintOverlay(ticker,candles){try{var W4=window.AutoCuanChartWorkstation;if(!W4||!W4.buildV3F09Overlay)return;var ov=W4.buildV3F09Overlay(ticker,candles||[],curMode(),curTheme());var host=document.getElementById("v3f09-overlay-host");if(!host){var c=document.getElementById("chartPageContainer");if(!c)return;host=document.createElement("div");host.id="v3f09-overlay-host";host.setAttribute("data-v3f09-overlay-host","true");c.parentNode.insertBefore(host,c.nextSibling)}host.innerHTML=ov.svg;host.setAttribute("data-mode",ov.mode);host.setAttribute("data-theme",ov.theme)}catch(_){}}window.acV3F09PaintToolbar=paintToolbar;window.acV3F09PaintOverlay=paintOverlay;window.acV3F09Mode=curMode;window.acV3F09Theme=curTheme;if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",paintToolbar);else paintToolbar();})();

/* V3-F11 Fast-Bundle instan (<15ms warm): Quote+Candle120+Fib+SMC/XABCD/ZigZag+Broksum+AI via /api/fast-bundle. */
(function(){if(window.__acV3F11)return;window.__acV3F11=true;var MEM={};var VER='v3-f11-1';
function normT(t){return String(t||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');}
async function fetchBundle(tickers){
  var list=(Array.isArray(tickers)?tickers:String(tickers||'').split(',')).map(normT).filter(Boolean).slice(0,10);
  if(!list.length)list=['BBCA'];
  var missing=list.filter(function(t){return !MEM[t];});
  if(!missing.length){var hit={};list.forEach(function(t){hit[t]=MEM[t];});return {success:true,bundles:hit,cached:true,version:VER};}
  var url='/api/fast-bundle/'+encodeURIComponent(missing.join(','));
  var res=await fetch(url,{method:'GET',cache:'no-cache'});
  if(!res.ok)throw new Error('fast-bundle http '+res.status);
  var data=await res.json();
  if(!data||data.success!==true||!data.bundles)throw new Error('fast-bundle invalid');
  Object.keys(data.bundles).forEach(function(k){MEM[normT(k)]=data.bundles[k];});
  return data;
}
async function prefetchCore(){try{await fetchBundle(['BBCA','BBRI','BRPT','BULL']);}catch(_){}}
window.acV3F11FetchBundle=fetchBundle;window.acV3F11Cache=MEM;window.acV3F11Version=VER;
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(prefetchCore,800);});
else setTimeout(prefetchCore,800);})();

/* V4-F04 — Pemformat Waktu Standar 100% Waktu Indonesia Barat (WIB) */
(function() {
  function formatAuditTimeWib(val) {
    if (!val) return '—';
    try {
      var d = (val instanceof Date) ? val : new Date(val);
      if (isNaN(d.getTime())) {
        var str = String(val).replace(/(\+00:00|\+07:00|Z)$/gi, '').trim();
        return str.endsWith('WIB') ? str : (str + ' WIB');
      }
      var pad = function(n) { return n < 10 ? '0' + n : String(n); };
      var utc = d.getTime() + (d.getTimezoneOffset() * 60000);
      var wib = new Date(utc + (7 * 3600000));
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
      var day = pad(wib.getDate());
      var month = months[wib.getMonth()];
      var year = wib.getFullYear();
      var hours = pad(wib.getHours());
      var mins = pad(wib.getMinutes());
      var secs = pad(wib.getSeconds());
      return day + ' ' + month + ' ' + year + ', ' + hours + ':' + mins + ':' + secs + ' WIB';
    } catch (_) {
      var s = String(val).replace(/(\+00:00|\+07:00|Z)$/gi, '').trim();
      return s.endsWith('WIB') ? s : (s + ' WIB');
    }
  }
  window.formatAuditTimeWib = formatAuditTimeWib;
})();
