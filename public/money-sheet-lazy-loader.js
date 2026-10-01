(function(root){
 'use strict';
 var loading=null,loaded=new Set();
 var urls=['/money-sheet-formulas.js?v=20260929-v1','/money-sheet-model.js?v=20260929-v2','/money-sheet-grid.js?v=20260929-keyboard-v1','/money-sheet-runtime.js?v=20260929-keyboard-v1'];
 function script(url){
  if(loaded.has(url))return Promise.resolve();
  return new Promise(function(resolve,reject){
   var s=root.document.createElement('script');s.src=url;s.async=false;
   s.onload=function(){loaded.add(url);resolve();};
   s.onerror=function(){s.remove();reject(new Error('Lembar keuangan belum dapat dimuat. Buka kembali untuk mencoba lagi.'));};
   root.document.head.appendChild(s);
  });
 }
 function init(){
  if(loading)return loading;
  loading=urls.reduce(function(p,url){return p.then(function(){return script(url);});},Promise.resolve()).then(function(){
   if(root.currentPage==='money-management' && root.initMoneyManagement!==init)return root.initMoneyManagement();
  }).catch(function(error){root.initMoneyManagement=init;if(root.showToast)root.showToast(error.message,'error');}).finally(function(){loading=null;});
  return loading;
 }
 root.initMoneyManagement=init;
})(window);
