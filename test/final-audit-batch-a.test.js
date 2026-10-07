'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { resolveEntitlements } = require('../lib/entitlements');
const { createHandler } = require('../lib/legacy-gmail-handler');
const { createSessionToken } = require('../lib/admin-session');

const uid = '11111111-1111-4111-8111-111111111111';
const account = { id: uid, username: 'alice', is_approved: true, created_at: '2026-09-01T00:00:00Z' };
const now = new Date('2026-10-05T00:00:00Z');
const baseRow = { user_id: uid, plan_code: 'PREMIUM_1_MONTH', source: 'payment', status: 'active', starts_at: '2026-10-01T00:00:00Z', expires_at: '2026-11-01T00:00:00Z', lifetime: false };

function entitlementDb(rows, { wave8 = false, error = null, reject = false } = {}) {
  const columns = new Set(['user_id','plan_code','source','status','starts_at','expires_at','lifetime']);
  if (wave8) columns.add('trial_kind');
  return { from(table) {
    assert.equal(table, 'user_entitlements');
    let selected = [], owner;
    const query = {
      select(value) { selected = value.split(',').map(c=>c.trim()); return this; },
      eq(column,value) { assert.equal(column,'user_id'); owner=value; return this; },
      then(resolve,rejectPromise) {
        if (reject) return Promise.reject(new Error('Storage offline')).then(resolve,rejectPromise);
        const missing=selected.find(c=>!columns.has(c));
        const result = missing ? {data:null,error:{code:'42703',message:'Unknown column '+missing}} :
          {data:error?null:rows.filter(r=>r.user_id===owner).map(r=>Object.fromEntries(selected.map(c=>[c,r[c]]))),error};
        return Promise.resolve(result).then(resolve,rejectPromise);
      }
    };
    return query;
  }};
}

test('pre-Wave-8 fixture rejects unavailable selected columns', async()=>{
  const result=await entitlementDb([baseRow]).from('user_entitlements').select('plan_code,trial_kind').eq('user_id',uid);
  assert.equal(result.error.code,'42703');
});
for (const [name,row,expected] of [
  ['Lifetime',{...baseRow,plan_code:'LIFETIME',lifetime:true,expires_at:null},'LIFETIME'],
  ['paid term',baseRow,'PREMIUM_1_MONTH'],
  ['historical ten-day trial',{...baseRow,source:'trial',plan_code:null,expires_at:'2026-10-11T00:00:00Z'},'TRIAL']
]) test('pre-Wave-8 active '+name+' remains readable',async()=>{
  const out=await resolveEntitlements({},account,entitlementDb([row]),now);
  assert.equal(out.premium,true);assert.equal(out.current_plan,expected);
});
test('no entitlement, expired trial, and genuine storage errors remain fail-closed',async()=>{
  for(const db of [entitlementDb([]),entitlementDb([{...baseRow,source:'trial',expires_at:'2026-10-02T00:00:00Z'}]),entitlementDb([baseRow],{error:{code:'42501',message:'Permission denied'}})]){
    const out=await resolveEntitlements({},account,db,now);assert.equal(out.premium,false);
  }
  await assert.rejects(resolveEntitlements({},account,entitlementDb([baseRow],{reject:true}),now),/Storage offline/);
});
test('post-Wave-8 trial metadata does not change the entitlement read',async()=>{
  const out=await resolveEntitlements({},account,entitlementDb([{...baseRow,source:'trial',trial_kind:'initial_14d',expires_at:'2026-10-15T00:00:00Z'}],{wave8:true}),now);
  assert.equal(out.premium,true);assert.equal(out.current_plan,'TRIAL');
});

function googleDb({ user=account, link=null, error=null, throws=false, cutoff='2026-10-01T00:00:00Z', rolloutError=null }={}) {
  return {from(table){
    const q={select(){return this},eq(column,value){if(table==='app_user_google_links'){assert.equal(column,'user_id');assert.equal(value,user.id);}return this},async maybeSingle(){
      if(table==='app_users')return {data:user,error:null};
      if(table==='app_user_google_links'){if(throws)throw new Error('Network failure');return {data:link,error};}
      if(table==='system_feature_rollouts')return {data:cutoff?{cutoff_at:cutoff}:null,error:rolloutError};
      throw new Error('Unexpected table '+table);
    }};return q;
  }};
}
async function googleStatus(options={}){
  const user=options.user||account;
  const previous=process.env.SESSION_SECRET;process.env.SESSION_SECRET='local-batch-a-test-secret';
  try{
    const req={method:'POST',headers:{host:'localhost',origin:'http://localhost',cookie:'ac_sess='+createSessionToken({userId:user.id,username:user.username})},body:{action:'account-google-status'}};
    const res={setHeader(){},status(code){this.code=code;return this},json(data){this.data=data;return this}};
    await createHandler(()=>googleDb(options))(req,res);return res;
  }finally{if(previous===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previous;}
}
for(const [name,options] of [
  ['missing Wave-8 table',{error:{code:'42P01'}}],['permission failure',{error:{code:'42501'}}],
  ['transient read error',{error:{message:'Timeout'}}],['thrown lookup error',{throws:true}]
])test('Google status reports unavailable on '+name,async()=>{
  const {code,data}=await googleStatus(options);
  assert.equal(code,503);assert.equal(data.success,false);assert.equal(data.code,'GOOGLE_LINK_STATE_UNAVAILABLE');
  assert.equal(data.google_link_state,'unavailable');assert.equal(data.google_linked,null);assert.equal(data.required,false);assert.equal(data.google_link_required,false);assert.equal(data.google_bonus_eligible,false);
});
test('Google status distinguishes unlinked, linked, and exempt accounts',async()=>{
  for(const [options,state,required] of [[{},'unlinked',true],[{link:{unlinked_at:null,google_email:'alice@gmail.com'}},'linked',false],[{user:{...account,username:'review'}},'exempt',false]]){
    const {data}=await googleStatus(options);assert.equal(data.success,true);assert.equal(data.google_link_state,state);assert.equal(data.required,required);
  }
});
test('Google bonus eligibility stays server-owned and fail-closed',async()=>{
  for(const [options,eligible] of [[{},true],[{user:{...account,created_at:'2026-10-02T00:00:00Z'}},false],[{link:{unlinked_at:'2026-10-01',bonus_granted_at:'2026-09-30'}},false],[{cutoff:null},false],[{rolloutError:{message:'Unreadable'}},false]]){
    const {data}=await googleStatus(options);assert.equal(data.google_bonus_eligible,eligible);
  }
});

function googleRuntime(response, session={userId:uid}) {
  const nodes={};const listeners={};let shown=0;
  const dialog={open:false,setAttribute(){},addEventListener(){},showModal(){this.open=true;shown++},close(){this.open=false},set innerHTML(html){
    for(const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g))nodes[match[1]]={hidden:/\bhidden\b/.test(match[0]),textContent:'',addEventListener(){}};
    nodes.legacyGmailDescription=nodes.legacyGmailDescription||{textContent:''};
    nodes.legacyGmailDescription.textContent=html.match(/class="legacy-gmail-desc"[^>]*>([^<]*)/)[1];
    nodes.legacyGmailBonusNotice=nodes.legacyGmailBonusNotice||{hidden:/class="legacy-gmail-notice"[^>]*\bhidden\b/.test(html)};
  }};
  const document={body:{appendChild(){}},createElement(){return dialog},getElementById(id){return nodes[id]||null}};
  const root={__AUTOCUAN_AUTHENTICATED_SESSION__:session,setTimeout,clearTimeout,addEventListener(name,fn){listeners[name]=fn},fetch:async()=>{if(response instanceof Error)throw response;return {ok:response.success!==false,json:async()=>response}}};
  vm.runInNewContext(fs.readFileSync('public/legacy-gmail-runtime.js','utf8'),{window:root,document,AbortController});
  return {root,nodes,dialog,get shown(){return shown}};
}
test('failed/unavailable lookup cannot fabricate a mandatory dialog from a legacy email flag',async()=>{
  for(const response of [new Error('Offline'),{success:false,google_link_state:'unavailable',required:false}, {success:false,error:'Transient failure'}]){
    const f=googleRuntime(response,{userId:uid,email_required:true});await f.root.enforceLegacyGmail();assert.equal(f.shown,0);
  }
});
test('explicit unavailable state clears an obsolete mandatory dialog',async()=>{
  const f=googleRuntime({success:false,google_link_state:'unavailable',required:false},{userId:uid,google_link_state:'unlinked',email_required:true});
  await f.root.enforceLegacyGmail();assert.equal(f.dialog.open,false);assert.equal(f.root.__AUTOCUAN_AUTHENTICATED_SESSION__.email_required,false);
});
test('eligibility lookup failure removes a previously visible bonus promise',async()=>{
  const f=googleRuntime({success:true,google_link_state:'unlinked',required:true,google_bonus_eligible:true});
  await f.root.enforceLegacyGmail();assert.match(f.nodes.legacyGmailDescription.textContent,/7 hari/);
  f.root.fetch=async()=>{throw new Error('Offline')};await f.root.enforceLegacyGmail();
  assert.doesNotMatch(f.nodes.legacyGmailDescription.textContent,/bonus/);assert.equal(f.nodes.legacyGmailBonusNotice.hidden,true);
});
test('auth bootstrap enters the app for unavailable Google state, and gates authoritative unlinked state',async()=>{
  for(const [state,required] of [['unavailable',false],['linked',false],['exempt',false],['unlinked',true]]){
    let entered=0,landed=0,enforced=0;
    const storage=new Map();
    const data={success:true,userId:uid,username:'alice',google_link_state:state,email_required:required,google_link_required:required};
    const root={parseAppRoute(){return {authRequired:true,page:'dashboard'}},enterApp(){entered++},showLandingPage(){landed++},enforceLegacyGmail(){enforced++},dispatchEvent(){}};
    const document={readyState:'loading',addEventListener(){}};
    vm.runInNewContext(fs.readFileSync('public/auth-v2.js','utf8'),{window:root,document,fetch:async()=>({ok:true,json:async()=>data}),localStorage:{setItem(k,v){storage.set(k,v)},getItem(k){return storage.get(k)}},AbortController,setTimeout,clearTimeout,CustomEvent:class{}});
    await root.validateAutocuanSession();
    assert.equal(entered,required?0:1,state);assert.equal(landed,required?1:0,state);assert.equal(enforced,required?1:0,state);
  }
});
for(const [name,fields,bonus] of [
  ['eligible pre-rollout',{google_bonus_eligible:true},true],
  ['ineligible post-rollout',{google_bonus_eligible:false},false],
  ['bonus already granted',{google_bonus_eligible:true,google_bonus_granted:true},false],
  ['eligibility unavailable',{},false]
])test('Google dialog copy: '+name,async()=>{
  const f=googleRuntime({success:true,google_link_state:'unlinked',required:true,...fields});await f.root.enforceLegacyGmail();
  assert.equal(f.dialog.open,true);assert.equal(f.nodes.legacyGmailDescription.textContent.includes('bonus trial 7 hari'),bonus);assert.equal(f.nodes.legacyGmailBonusNotice.hidden,!bonus);
});

async function renderTrial(entitlement) {
  const nodes=Object.fromEntries(['acAccountCenter','acPanelProfile','acPanelSubscription','acPanelTerms','acCenterAvatar','acCenterTitle'].map(id=>[id,{hidden:false,querySelectorAll(){return []}}]));
  const document={readyState:'complete',activeElement:null,body:{},documentElement:{style:{}},querySelector(){return {}},getElementById(id){return nodes[id]||null}};
  const fetch=async()=>({ok:true,json:async()=>({success:true,profile:{username:'alice',subscription:{enabled:true,ready:true,entitlement}}})});
  const root={};
  vm.runInNewContext(fs.readFileSync('public/account-center-v1.js','utf8'),{window:root,document,localStorage:{getItem(){return 'true'}},fetch,AbortController,setTimeout(){return 0},clearTimeout,Intl,Date});
  await root.openAccountProfile();return nodes.acPanelProfile.innerHTML;
}
for(const [name,fields] of [
  ['historical trial',{starts_at:'2026-09-01',expires_at:'2026-09-11'}],
  ['current initial trial',{starts_at:'2026-10-01',expires_at:'2026-10-15'}],
  ['Google bonus extension',{starts_at:'2026-10-15',expires_at:'2026-10-22',trial_kind:'google_bonus_7d'}],
  ['generic active trial',{}]
])test('profile labels '+name+' without inventing a duration',async()=>{
  const html=await renderTrial({current_plan:'TRIAL',status:'active',...fields});
  assert.match(html,/<dt>Paket<\/dt><dd>Trial<\/dd>/);assert.doesNotMatch(html,/Trial 10 Hari/);
});
