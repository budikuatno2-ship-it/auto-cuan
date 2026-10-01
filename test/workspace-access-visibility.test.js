'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const source=html.slice(html.indexOf('function applyPremiumAccessUi()'),html.indexOf('function cancelPremiumAccessRequest()'));
function fixture(allowed,denied=false){
 function node(id){const classes=new Set(['hidden']);const attributes=new Map([['aria-hidden','true']]);return {id,classes,attributes,inert:true,classList:{add:n=>classes.add(n),remove:n=>classes.delete(n),toggle(n,value){value?classes.add(n):classes.delete(n)}},setAttribute:(n,v)=>attributes.set(n,v),removeAttribute:n=>attributes.delete(n)};}
 const selected=node('page-money-management'),other=node('page-screener'),nav=node('tabFinance');let clears=0,routes=[];
 const context={currentPage:'money-management',syncHeaderUsername(){},hasConfirmedPremiumAccess:()=>allowed,isDeniedWebsiteAccess:()=>denied,isPremiumFeaturePage:()=>true,clearRenderedPremiumData(){clears++},navigateTo:p=>routes.push(p),document:{querySelectorAll:selector=>selector.includes('nav')?[nav]:[selected,other]}};
 vm.runInNewContext(source+';applyPremiumAccessUi()',context);
 return {selected,other,nav,clears,routes,context,rerun(){vm.runInNewContext(source+';applyPremiumAccessUi()',context)}};
}
test('confirmed access restores the pending-hidden selected page, not every page',()=>{const x=fixture(true);assert.equal(x.selected.classes.has('hidden'),false);assert.equal(x.selected.inert,false);assert.equal(x.selected.attributes.has('aria-hidden'),false);assert.equal(x.other.classes.has('hidden'),true);assert.deepEqual(x.routes,[]);});
test('pending or unavailable access remains hidden and cannot reveal protected data',()=>{const x=fixture(false);assert.equal(x.selected.classes.has('hidden'),true);assert.equal(x.selected.inert,true);assert.equal(x.nav.disabled,true);assert.deepEqual(x.routes,[]);x.context.hasConfirmedPremiumAccess=()=>true;x.rerun();assert.equal(x.selected.classes.has('hidden'),false);});
test('definitive rejection still clears rendered data and routes away',()=>{const x=fixture(false,true);assert.equal(x.selected.classes.has('hidden'),true);assert.equal(x.clears,1);assert.deepEqual(x.routes,['dashboard']);});
test('approval callback never changes a top-level gate or navigates another selected page',()=>{const x=fixture(true);x.context.currentPage='dashboard';x.selected.classes.add('hidden');x.rerun();assert.equal(x.selected.classes.has('hidden'),true);assert.deepEqual(x.routes,[]);assert.doesNotMatch(source,/setTopLevelView|showDashboard|maintenanceScreen|appMain/);});
