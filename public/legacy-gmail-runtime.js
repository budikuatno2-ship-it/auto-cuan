(function(root){
 'use strict';
 var dialog,checking=null,generation=0;
 async function request(action,payload){
  var controller=new AbortController(),timer=root.setTimeout(function(){controller.abort();},10000);
  try{
   var r=await root.fetch('/api/reset-password',{
    method:'POST',
    credentials:'same-origin',
    cache:'no-store',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(Object.assign({action:action},payload||{})),
    signal:controller.signal
   });
   var d=await r.json();
   if(action==='account-google-status'&&d.google_link_state==='unavailable')return d;
   if(!r.ok||!d.success)throw new Error(d.error||'Data akun belum tersedia. Coba lagi.');
   return d;
  }finally{root.clearTimeout(timer);}
 }
 function mount(){
  if(dialog)return dialog;
  dialog=document.createElement('dialog');
  dialog.id='legacyGmailDialog';
  dialog.setAttribute('aria-labelledby','legacyGmailTitle');
  dialog.className='legacy-gmail-dialog';
  dialog.innerHTML=[
   '<div id="legacyGmailContent" class="google-link-content" style="padding:4px;">',
   '<span class="chip i" style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:rgba(49,95,154,.15);color:#86ade3;border:1px solid rgba(49,95,154,.3);">Langkah wajib · satu kali</span>',
   '<h2 id="legacyGmailTitle" style="margin:12px 0 6px;font-size:22px;letter-spacing:-.02em;font-weight:700;">Lengkapi identitas akun</h2>',
   '<p id="legacyGmailDescription" class="legacy-gmail-desc" style="margin:0 0 12px;font-size:13px;line-height:1.5;">Auto-Cuan kini memakai Gmail sebagai identitas akun untuk sinkronisasi perangkat, pemulihan lewat Telegram, dan notifikasi bursa. Akun lama perlu menautkan Gmail sekali sebelum melanjutkan.</p>',
   '<div style="display:grid;gap:8px;margin:12px 0 16px;padding:12px 14px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.03);font-size:12.5px;">',
   '  <div style="display:flex;gap:10px;align-items:center;"><span style="width:7px;height:7px;border-radius:50%;background:#10b981;display:inline-block;flex:none;"></span><span>Data watchlist, portofolio, dan anggaran Anda tetap utuh.</span></div>',
   '  <div style="display:flex;gap:10px;align-items:center;"><span style="width:7px;height:7px;border-radius:50%;background:#10b981;display:inline-block;flex:none;"></span><span>Username lama masih bisa dipakai untuk masuk.</span></div>',
   '</div>',
   '<div class="google-link-card" style="margin:0;">',
   '  <label for="legacyGmailEmail" style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">Alamat Gmail aktif</label>',
   '  <input id="legacyGmailEmail" type="email" placeholder="nama@gmail.com" autocomplete="email" style="width:100%;height:40px;padding:0 12px;border-radius:8px;border:1px solid #374151;background:#0b0e14;color:#fff;font-size:13px;box-sizing:border-box;">',
   '  <div style="height:10px;"></div>',
   '  <label for="legacyGmailEmailConfirm" style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">Ulangi alamat Gmail</label>',
   '  <input id="legacyGmailEmailConfirm" type="email" placeholder="nama@gmail.com" autocomplete="email" style="width:100%;height:40px;padding:0 12px;border-radius:8px;border:1px solid #374151;background:#0b0e14;color:#fff;font-size:13px;box-sizing:border-box;">',
   '  <p id="legacyGmailBonusNotice" class="legacy-gmail-notice" hidden style="margin-top:8px;font-size:11px;color:#a7f3d0;">Bonus hanya berlaku satu kali.</p>',
   '  <p id="legacyGmailError" role="alert" class="google-link-error" style="margin-top:8px;font-size:12px;color:#ef4444;"></p>',
   '  <button type="button" id="googleLinkBtn" class="google-link-btn" style="width:100%;height:44px;margin-top:14px;border-radius:8px;border:0;background:linear-gradient(135deg, #059669, #10b981);color:#fff;font-weight:700;font-size:14px;cursor:pointer;">Simpan &amp; lanjutkan</button>',
   '</div>',
   '<div id="googleLinkSuccess" class="google-link-success" hidden style="margin-top:12px;padding:12px;border-radius:8px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);text-align:center;">',
   '  <p class="google-link-success-title" style="margin:0;font-size:13px;font-weight:700;color:#10b981;">Gmail berhasil ditautkan ✓</p>',
   '  <p id="googleLinkMaskedEmail" class="google-link-masked-email" style="margin:4px 0 0;font-size:12px;font-family:monospace;"></p>',
   '  <p id="googleLinkBonusBadge" class="google-link-success-badge" hidden style="margin:4px 0 0;font-size:11px;color:#a7f3d0;"></p>',
   '</div>',
   '<div class="legacy-gmail-actions" style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;font-size:13px;">',
   '  <span style="color:#9ca3af;">Masuk sebagai <b id="legacyGmailCurrentUsername" style="color:#fff;">akun</b></span>',
   '  <button type="button" id="legacyGmailLogout" class="google-link-logout-btn" style="background:transparent;border:0;color:#9ca3af;cursor:pointer;font-size:13px;text-decoration:underline;">Keluar</button>',
   '</div>',
   '</div>'
  ].join('');
  document.body.appendChild(dialog);
  dialog.addEventListener('cancel',function(e){e.preventDefault();});

  try {
    var sess = root.__AUTOCUAN_AUTHENTICATED_SESSION__;
    var unameEl = document.getElementById('legacyGmailCurrentUsername');
    if (unameEl && sess && sess.username) unameEl.textContent = sess.username;
  } catch(_) {}

  var logoutBtn=document.getElementById('legacyGmailLogout');
  if(logoutBtn)logoutBtn.addEventListener('click',async function(){
   generation++;
   if(typeof root.logout==='function')await root.logout();
   if(!root.__AUTOCUAN_AUTHENTICATED_SESSION__)dialog.close();
  });

  var linkBtn=document.getElementById('googleLinkBtn');
  if(linkBtn)linkBtn.addEventListener('click',async function(){
   var btn=document.getElementById('googleLinkBtn');
   var err=document.getElementById('legacyGmailError');
   var emailInput=document.getElementById('legacyGmailEmail');
   var confirmInput=document.getElementById('legacyGmailEmailConfirm');
   var emailVal = emailInput ? emailInput.value.trim().toLowerCase() : '';
   var confirmVal = confirmInput ? confirmInput.value.trim().toLowerCase() : '';

   if(err)err.textContent='';

   if(!emailVal || !/^[^\s@]+@gmail\.com$/i.test(emailVal)){
    if(err)err.textContent='Gunakan alamat yang berakhiran @gmail.com.';
    if(emailInput)emailInput.focus();
    return;
   }
   if(emailVal !== confirmVal){
    if(err)err.textContent='Alamat email belum sama.';
    if(confirmInput)confirmInput.focus();
    return;
   }

   if(btn){ btn.disabled=true; btn.textContent='Menyimpan…'; }
   try{
    var res=await request('account-email-complete', { email: emailVal });
    if(res && res.success){
      if(btn) btn.textContent='Tersimpan ✓ · membuka workspace…';
      if(root.__AUTOCUAN_AUTHENTICATED_SESSION__){
        root.__AUTOCUAN_AUTHENTICATED_SESSION__.email_required = false;
        root.__AUTOCUAN_AUTHENTICATED_SESSION__.email = emailVal;
      }
      root.setTimeout(function(){
        if(dialog&&dialog.open)dialog.close();
        if(typeof root.enterApp==='function') root.enterApp({ replaceHistory: true });
      }, 1000);
      return;
    }
    throw new Error((res && res.error) || 'Gagal menyimpan alamat Gmail.');
   }catch(e){
    // Fallback if server requires OAuth link
    try{
     var urlRes=await request('account-google-link-url');
     if(urlRes && urlRes.auth_url){
       if(typeof root.openOAuthUrl==='function'){ root.openOAuthUrl(urlRes.auth_url); }
       else { root.location.assign(urlRes.auth_url); }
       return;
     }
    }catch(_){}
    if(err)err.textContent=e.message||'Tautan Gmail dibatalkan atau gagal.';
    if(btn){ btn.disabled=false; btn.textContent='Simpan & lanjutkan'; }
   }
  });
  return dialog;
 }
 function bonusCopy(data){
  var eligible=data&&data.google_bonus_eligible===true&&data.google_bonus_granted!==true&&data.google_link_state!=='unavailable';
  var description=document.getElementById('legacyGmailDescription');
  var notice=document.getElementById('legacyGmailBonusNotice');
  if(description)description.textContent=eligible?'Tautkan akun Google untuk melanjutkan dan mendapatkan bonus trial 7 hari.':'Tautkan akun Google untuk melanjutkan.';
  if(notice)notice.hidden=!eligible;
 }
 async function check(){
  bonusCopy(null);
  if(root.__AUTOCUAN_AUTHENTICATED_SESSION__&&root.__AUTOCUAN_AUTHENTICATED_SESSION__.google_link_state==='unlinked'&&(root.__AUTOCUAN_AUTHENTICATED_SESSION__.google_link_required===true||root.__AUTOCUAN_AUTHENTICATED_SESSION__.email_required===true)){
   var requiredDialog=mount();
   if(!requiredDialog.open)requiredDialog.showModal();
  }
  if(checking)return checking;
  var current=++generation;
  var pending=request('account-google-status').then(function(data){
   if(current!==generation)return;
   var unavailable=data.google_link_state==='unavailable';
   var req=!unavailable&&(data.google_link_required===true||data.required===true);
   if(root.__AUTOCUAN_AUTHENTICATED_SESSION__){
    root.__AUTOCUAN_AUTHENTICATED_SESSION__.google_link_state=data.google_link_state;
    root.__AUTOCUAN_AUTHENTICATED_SESSION__.google_link_required=req;
    root.__AUTOCUAN_AUTHENTICATED_SESSION__.email_required=req;
   }
   if(req||data.google_linked===true)mount();
   bonusCopy(data);
   if(unavailable){
    if(dialog&&dialog.open)dialog.close();
    return;
   }
   if(data.google_linked){
    var d=mount();
    var btn=document.getElementById('googleLinkBtn');
    var succ=document.getElementById('googleLinkSuccess');
    var emailEl=document.getElementById('googleLinkMaskedEmail');
    var badge=document.getElementById('googleLinkBonusBadge');
    if(btn)btn.hidden=true;
    if(succ)succ.hidden=false;
    if(emailEl&&data.google_email_masked)emailEl.textContent=data.google_email_masked;
    if(badge){
     if(data.google_bonus_granted){
      badge.textContent='Bonus trial 7 hari telah diberikan';
      badge.hidden=false;
     }else{
      badge.hidden=true;
     }
    }
    root.setTimeout(function(){
     if(dialog&&dialog.open)dialog.close();
    },1200);
    return;
   }
   if(req){
    var d=mount();
    if(!d.open)d.showModal();
   }else{
    if(dialog&&dialog.open)dialog.close();
   }
  }).catch(function(){}).finally(function(){
   if(checking===pending)checking=null;
  });
  checking=pending;
  return checking;
 }
 root.addEventListener('message',function(ev){
  if(ev&&ev.data&&ev.data.type==='autocuan:google-linked'){
   generation++;
   checking=null;
   check();
  }
 });
 if(root.location&&root.location.search){
  if(root.location.search.indexOf('google_linked=1')!==-1){
   try{
    var cleanUrl=root.location.pathname+(root.location.hash||'');
    root.history.replaceState(null,'',cleanUrl);
   }catch(_){}
  }
  if(root.location.search.indexOf('google_link_error=')!==-1){
   try{
    var m=root.location.search.match(/google_link_error=([^&]+)/);
    var errKey=m?decodeURIComponent(m[1]):'';
    var errMap={
     access_denied:'Otorisasi Google dibatalkan.',
     invalid_state:'Sesi otorisasi Google kedaluwarsa atau tidak valid.',
     state_expired:'Sesi otorisasi Google kedaluwarsa. Silakan coba lagi.',
     state_consumed:'Sesi otorisasi Google sudah pernah digunakan.',
     token_failed:'Gagal menukarkan kode otorisasi Google.',
     verification_failed:'Verifikasi identitas Google gagal.',
     link_conflict:'Akun Google ini sudah terhubung ke akun Auto-Cuan lain.',
     account_mismatch:'Akun Auto-Cuan ini sudah terikat dengan identitas Google lain.',
     user_not_eligible:'Akun Auto-Cuan tidak memenuhi syarat.'
    };
    var d=mount();
    var errEl=document.getElementById('legacyGmailError');
    if(errEl)errEl.textContent=errMap[errKey]||'Tautan akun Google gagal. Silakan coba lagi.';
    if(!d.open)d.showModal();
    var cleanUrl2=root.location.pathname+(root.location.hash||'');
    root.history.replaceState(null,'',cleanUrl2);
   }catch(_){}
  }
 }
 root.enforceLegacyGmail=check;
 root.addEventListener('autocuan:session-ready',function(){generation++;checking=null;check();});
 root.addEventListener('autocuan:session-cleared',function(){generation++;checking=null;if(dialog&&dialog.open)dialog.close();});
 root.addEventListener('focus',function(){if(root.__AUTOCUAN_AUTHENTICATED_SESSION__)check();});
 if(root.__AUTOCUAN_AUTHENTICATED_SESSION__)check();
})(window);
