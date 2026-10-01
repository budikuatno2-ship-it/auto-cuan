'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
process.env.SESSION_SECRET=crypto.randomBytes(32).toString('hex');
const {createSessionToken}=require('../lib/admin-session');
const {createHandler}=require('../lib/legacy-gmail-handler');
function fixture(account,updateError){
 const writes=[];let updating=false;
 const query={select(){return this},eq(k,v){if(updating)writes.push([k,v]);return this},is(){return this},update(v){updating=true;writes.push(v);return this},maybeSingle:async()=>({data:account,error:updating?updateError:null})};
 const handler=createHandler(()=>({from:()=>query}));
 const req={method:'POST',headers:{host:'localhost',origin:'http://localhost',cookie:'ac_sess='+createSessionToken({userId:'account-a',username:'legacy',deviceId:'d'})},body:{action:'account-email-complete',email:' USER@gmail.com ',userId:'victim'}};
 const res={setHeader(){},status(v){this.code=v;return this},json(v){this.data=v;return this}};
 return{handler,req,res,writes};
}
test('Gmail completion updates only the signed legacy account',async()=>{
 const f=fixture({id:'account-a',username:'legacy',email:null,is_blocked:false});await f.handler(f.req,f.res);
 assert.equal(f.res.code,200);assert.deepEqual(f.writes[0],{email:'user@gmail.com'});assert.ok(f.writes.some(v=>Array.isArray(v)&&v[0]==='id'&&v[1]==='account-a'));
});
test('Gmail completion rejects a forged account, cross-origin request, duplicate email and non-Gmail',async()=>{
 for(const variant of ['no-session','cross-origin','duplicate','non-gmail','blocked']){
  const f=fixture({id:'account-a',username:'legacy',email:null,is_blocked:variant==='blocked'},variant==='duplicate'?{code:'23505'}:null);
  if(variant==='no-session')delete f.req.headers.cookie;
  if(variant==='cross-origin')f.req.headers.origin='https://evil.example';
  if(variant==='non-gmail')f.req.body.email='user@example.com';
  await f.handler(f.req,f.res);assert.ok(f.res.code>=400,variant);
 }
});
test('existing email cannot be overwritten through completion',async()=>{
 const f=fixture({id:'account-a',username:'legacy',email:'old@gmail.com'});await f.handler(f.req,f.res);assert.equal(f.writes.length,0);assert.equal(f.res.data.email,'old@gmail.com');
});
test('legacy blank email is completed with a compare-and-set condition',async()=>{
 for(const email of ['', '   ']){
  const f=fixture({id:'account-a',username:'legacy',email});await f.handler(f.req,f.res);
  assert.equal(f.res.code,200);
  assert.ok(f.writes.some(v=>Array.isArray(v)&&v[0]==='email'&&v[1]===email));
 }
});
test('a known legacy requirement remains mandatory when the status request fails',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const listeners={};
 const dialog={open:false,setAttribute(){},addEventListener(name,fn){listeners[name]=fn;},showModal(){this.open=true;},close(){this.open=false;}};
 const document={body:{appendChild(){}},createElement(){return dialog},getElementById(){return {addEventListener(){}}}};
 const root={__AUTOCUAN_AUTHENTICATED_SESSION__:{userId:'legacy',email_required:true},setTimeout,clearTimeout,fetch:async()=>{throw new Error('offline')},addEventListener(name,fn){listeners[name]=fn}};
 vm.runInNewContext(fs.readFileSync('public/legacy-gmail-runtime.js','utf8'),{window:root,document,AbortController});
 await root.enforceLegacyGmail();assert.equal(dialog.open,true);
 let prevented=false;listeners.cancel({preventDefault(){prevented=true}});assert.equal(prevented,true);
 listeners['autocuan:session-cleared']();assert.equal(dialog.open,false);
});
