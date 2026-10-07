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
   '<div id="legacyGmailContent" class="google-link-content">',
   '<h2 id="legacyGmailTitle">Hubungkan Akun Google</h2>',
   '<p id="legacyGmailDescription" class="legacy-gmail-desc">Tautkan akun Google untuk melanjutkan.</p>',
   '<div class="google-link-card">',
   '<button type="button" id="googleLinkBtn" class="google-link-btn">Tautkan Akun Google</button>',
   '<p id="legacyGmailBonusNotice" class="legacy-gmail-notice" hidden>Bonus hanya berlaku satu kali.</p>',
   '</div>',
   '<div id="googleLinkSuccess" class="google-link-success" hidden>',
   '<p class="google-link-success-title">Google terhubung</p>',
   '<p id="googleLinkMaskedEmail" class="google-link-masked-email"></p>',
   '<p id="googleLinkBonusBadge" class="google-link-success-badge" hidden></p>',
   '</div>',
   '<p id="legacyGmailError" role="alert" class="google-link-error"></p>',
   '<div class="legacy-gmail-actions">',
   '<button type="button" id="legacyGmailLogout" class="google-link-logout-btn">Logout</button>',
   '</div>',
   '</div>'
  ].join('');
  document.body.appendChild(dialog);
  dialog.addEventListener('cancel',function(e){e.preventDefault();});
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
   if(btn)btn.disabled=true;
   if(err)err.textContent='';
   try{
    var urlRes=await request('account-google-link-url');
    if(!urlRes||!urlRes.auth_url)throw new Error('URL otorisasi Google tidak tersedia.');
    // Real production flow: navigate user to Google OAuth consent screen
    if(typeof root.openOAuthUrl==='function'){
     root.openOAuthUrl(urlRes.auth_url);
    }else{
     root.location.assign(urlRes.auth_url);
    }
   }catch(e){
    if(err)err.textContent=e.message||'Tautan Google dibatalkan atau gagal.';
    if(btn)btn.disabled=false;
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
