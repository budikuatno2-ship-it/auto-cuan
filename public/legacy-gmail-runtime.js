(function(root){
 'use strict';
 var dialog,checking=null,generation=0;
 async function request(action,email){
  var controller=new AbortController(),timer=root.setTimeout(function(){controller.abort();},10000);
  try{var r=await root.fetch('/api/reset-password',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,email:email}),signal:controller.signal});var d=await r.json();if(!r.ok||!d.success)throw new Error(d.error||'Data akun belum tersedia. Coba lagi.');return d;}finally{root.clearTimeout(timer);}
 }
 function mount(){
  if(dialog)return dialog;
  dialog=document.createElement('dialog');dialog.id='legacyGmailDialog';dialog.setAttribute('aria-labelledby','legacyGmailTitle');dialog.className='legacy-gmail-dialog';
  dialog.innerHTML='<form id="legacyGmailForm"><h2 id="legacyGmailTitle">Lengkapi Gmail Anda</h2><p>Akun lama Anda belum memiliki email. Simpan Gmail untuk melanjutkan. Setelah tersimpan, gunakan Gmail saat login.</p><label for="legacyGmailInput">Gmail</label><input id="legacyGmailInput" type="email" required autocomplete="email" placeholder="nama@gmail.com"><p id="legacyGmailError" role="alert"></p><button type="submit">Simpan &amp; lanjutkan</button><button type="button" id="legacyGmailLogout">Logout</button></form>';
  document.body.appendChild(dialog);dialog.addEventListener('cancel',function(e){e.preventDefault();});
  document.getElementById('legacyGmailLogout').addEventListener('click',async function(){generation++;await root.logout();if(!root.__AUTOCUAN_AUTHENTICATED_SESSION__)dialog.close();});
  document.getElementById('legacyGmailForm').addEventListener('submit',async function(e){
   e.preventDefault();var button=e.target.querySelector('[type="submit"]'),error=document.getElementById('legacyGmailError'),session=root.__AUTOCUAN_AUTHENTICATED_SESSION__;button.disabled=true;error.textContent='';
   try{await request('account-email-complete',document.getElementById('legacyGmailInput').value);if(root.__AUTOCUAN_AUTHENTICATED_SESSION__!==session)return;generation++;checking=null;if(session)session.email_required=false;dialog.close();if(root.validateAutocuanSession)await root.validateAutocuanSession();}catch(err){error.textContent=err.message;}finally{button.disabled=false;}
  });return dialog;
 }
 async function check(){
  if(root.__AUTOCUAN_AUTHENTICATED_SESSION__ && root.__AUTOCUAN_AUTHENTICATED_SESSION__.email_required===true){var requiredDialog=mount();if(!requiredDialog.open)requiredDialog.showModal();}
  if(checking)return checking;
  var current=++generation;
  var pending=request('account-email-status').then(function(data){if(current!==generation)return;if(data.required){var d=mount();if(!d.open)d.showModal();}else if(dialog&&dialog.open){dialog.close();}}).catch(function(){/* Keep the known required dialog open during an outage. Retry after focus/login. */}).finally(function(){if(checking===pending)checking=null;});
  checking=pending;
  return checking;
 }
 root.enforceLegacyGmail=check;
 root.addEventListener('autocuan:session-ready',function(){generation++;checking=null;check();});
 root.addEventListener('autocuan:session-cleared',function(){generation++;checking=null;if(dialog&&dialog.open)dialog.close();});
 root.addEventListener('focus',function(){if(root.__AUTOCUAN_AUTHENTICATED_SESSION__)check();});
 if(root.__AUTOCUAN_AUTHENTICATED_SESSION__)check();
})(window);
