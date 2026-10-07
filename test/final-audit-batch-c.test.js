'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const account = fs.readFileSync('public/account-center-v1.js', 'utf8');
const manager = html.slice(html.indexOf('// ===== ACCESSIBILITY: SKIP-LINK + MODAL FOCUS MANAGEMENT ====='), html.indexOf('</script>', html.indexOf('// ===== ACCESSIBILITY: SKIP-LINK + MODAL FOCUS MANAGEMENT =====')));

function fixture() {
  const elements = new Map(), observers = [], listeners = [];
  let closes = 0;
  const document = { readyState: 'complete', getElementById: id => elements.get(id), addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); }, querySelector() { return null; } };
  function element(id, tagName = 'DIV', parent) {
    const attrs = new Map(), classes = new Set();
    const el = { id, tagName, hidden: false, inert: false, disabled: false, isConnected: true, parentElement: parent, children: [], zIndex: 100,
      classList: { contains: x => classes.has(x), add: x => classes.add(x), toggle(x, on) { if (on) classes.add(x); else classes.delete(x); } },
      hasAttribute: x => attrs.has(x), setAttribute(k,v) { attrs.set(k,v); }, removeAttribute(k) { attrs.delete(k); },
      contains(other) { return other === this || this.children.some(c => c.contains(other)); },
      closest(selector) { for (let p = this; p; p = p.parentElement) if (selector === '[inert]' && p.inert) return p; return null; },
      getClientRects() { for (let p = this; p; p = p.parentElement) if (p.hidden || p.classList.contains('hidden')) return []; return [{}]; },
      querySelectorAll() { const out = []; const walk = n => n.children.forEach(c => { if (c.tagName === 'BUTTON' && !c.disabled) out.push(c); walk(c); }); walk(this); return out; },
      querySelector(selector) { if (selector[0] === '#') { const e = elements.get(selector.slice(1)); return e && this.contains(e) ? e : null; } return null; },
      focus() { if (!this.closest('[inert]') && this.getClientRects().length) document.activeElement = this; }
    };
    elements.set(id, el); if (parent) parent.children.push(el); return el;
  }
  document.body = element('body', 'BODY'); document.documentElement = element('html', 'HTML'); document.activeElement = document.body;
  const app = element('appMain', 'DIV', document.body), trigger = element('trigger', 'BUTTON', app), background = element('background', 'BUTTON', app);
  const priorInert = element('priorInert', 'DIV', document.body); priorInert.inert = true;
  const win = { matchMedia: () => ({ matches: false }), closeAccountCenter() { closes++; const m=elements.get('acAccountCenter'); m.hidden=true; document.activeElement=document.body; emit(m); } };
  function emit(target, addedNodes=[]) { observers.slice().forEach(o => { if (o.target === target) o.fn([{ addedNodes, removedNodes:[] }]); }); }
  vm.runInNewContext(manager, { document, window:win, getComputedStyle: el => ({ display:el.hidden?'none':'block', visibility:'visible', zIndex:String(el.zIndex) }), MutationObserver:class { constructor(fn) { this.fn=fn; } observe(target) { this.target=target; observers.push(this); } } });
  function mount(id='acAccountCenter') { const m=element(id,'DIV',document.body);m.hidden=true;const first=element(id+'Close','BUTTON',m), last=element(id+'Last','BUTTON',m);emit(document.body,[m]);return {m,first,last}; }
  function open(m) { trigger.focus();m.hidden=false;emit(m); }
  function key(key, shiftKey=false) { const e={key,shiftKey,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};for(const l of listeners.filter(l=>l.type==='keydown').sort((a,b)=>Boolean(b.capture)-Boolean(a.capture))){l.fn(e);if(e.stopped)break;}return e; }
  return { document,app,trigger,background,priorInert,mount,open,key,emit,listeners,get closes(){return closes;} };
}

test('lazy Account Center joins shared focus/inert management without auth styling',()=>{
  const f=fixture(),{m,first}=f.mount();f.open(m);
  assert.equal(f.document.activeElement,first);assert.equal(f.app.inert,true);assert.equal(f.priorInert.inert,true);
  assert.equal(f.document.documentElement.classList.contains('auth-dialog-open'),false);
  f.background.focus();assert.equal(f.document.activeElement,first);
});
test('Account Center wraps Tab and Shift+Tab and closes through its authoritative closer',()=>{
  const f=fixture(),{m,first,last}=f.mount();f.open(m);
  for(let i=0;i<8;i++){last.focus();assert.equal(f.key('Tab').prevented,true);assert.equal(f.document.activeElement,first);assert.equal(f.key('Tab',true).prevented,true);assert.equal(f.document.activeElement,last);}
  f.key('Escape');assert.equal(f.closes,1);assert.equal(m.hidden,true);assert.equal(f.document.activeElement,f.trigger);assert.equal(f.app.inert,false);assert.equal(f.priorInert.inert,true);
});
test('reopening does not install additional shared keyboard listeners or lose prior inert state',()=>{
  const f=fixture(),{m}=f.mount(),count=f.listeners.length;
  for(let i=0;i<5;i++){f.open(m);assert.ok(m.contains(f.document.activeElement));f.key('Escape');assert.equal(f.document.activeElement,f.trigger);assert.equal(f.app.inert,false);assert.equal(f.priorInert.inert,true);}
  assert.equal(f.listeners.length,count);assert.equal(f.closes,5);
});
test('nested standalone Terms retains topmost containment and returns to Account Center',()=>{
  const f=fixture(),{m,first}=f.mount();f.open(m);
  const nested=f.mount('standaloneTermsModal');nested.m.zIndex=101;nested.first.id='closeStandaloneTermsBtn';
  nested.m.querySelector=selector=>selector==='#closeStandaloneTermsBtn'?{click(){nested.m.hidden=true;f.document.activeElement=f.document.body;f.emit(nested.m);}}:null;
  nested.m.hidden=false;f.emit(nested.m);assert.ok(nested.m.contains(f.document.activeElement));assert.equal(m.inert,true);assert.equal(f.app.inert,true);
  f.key('Escape');assert.equal(f.closes,0);assert.equal(f.document.activeElement,first);assert.equal(m.inert,false);assert.equal(f.app.inert,true);
  f.key('Escape');assert.equal(f.closes,1);assert.equal(f.document.activeElement,f.trigger);
});
test('Account Center retains its original explicit trigger across repeated opens',async()=>{
  const root={hidden:true},trigger={focus(){document.activeElement=this;},setAttribute(k,v){this[k]=v;},getAttribute(){return 'dialog';}},other={focus(){document.activeElement=this;}};
  const document={activeElement:other,body:{},documentElement:{style:{overflow:'',removeProperty(){}}}};
  const start=account.indexOf('  async function openCenter('),end=account.indexOf('  function renderLoggedOut()',start);
  const close=account.slice(account.indexOf('  function closeCenter()'),start);
  const ctx={document,ensureCenter:()=>root,byId:()=>root,switchTab(){},isLoggedIn:()=>true,loadProfile:async()=>{}};
  vm.runInNewContext('var lastCenterFocus=null;'+close+account.slice(start,end),ctx);
  await ctx.openCenter('profile',trigger);assert.equal(document.activeElement,trigger);document.activeElement=other;
  await ctx.openCenter('terms');ctx.closeCenter();assert.equal(document.activeElement,trigger);assert.equal(trigger['aria-expanded'],'false');
});
test('Portfolio touch sizing is generated from scoped static CSS and leaves breakpoints intact',()=>{
  const css=fs.readFileSync('public/portfolio-command-center.css','utf8'),scoped=fs.readFileSync('public/portfolio-spa-scoped.css','utf8');
  assert.match(css,/@media \(min-width: 768px\) and \(pointer: coarse\)[\s\S]*#tabStrip\.tab-strip > \.tab[\s\S]*min-width: 44px !important;[\s\S]*min-height: 44px !important;/);
  assert.match(scoped,/:where\(#portofolioPartialMount\) #tabStrip\.tab-strip > \.tab\{\s*min-width: 44px !important;/);
  for(const media of ['max-width: 767px','min-width: 768px','max-width: 1180px','min-width: 1181px'])assert.ok(css.includes(media));
  assert.match(css,/grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
});

test('SPA Portfolio navigation selectors target mount descendants at every declared breakpoint',()=>{
  const scoped=fs.readFileSync('public/portfolio-spa-scoped.css','utf8');
  assert.doesNotMatch(scoped,/:where\(#portofolioPartialMount\)[^{\n]*\b(?:html|body)\b/);
  const start=scoped.indexOf('@media (max-width: 767px){',scoped.indexOf('color var(--motion-fast'));
  const navigation=scoped.slice(start,scoped.indexOf('@media (min-width: 768px) and (pointer: coarse)'));
  assert.match(navigation,/@media \(max-width: 767px\)[\s\S]*:where\(#portofolioPartialMount\) #tabStrip[\s\S]*display: none !important/);
  assert.match(navigation,/@media \(min-width: 768px\) and \(max-width: 1180px\)[\s\S]*:where\(#portofolioPartialMount\) #tabStrip[\s\S]*display: flex !important;\s*flex-wrap: nowrap !important;\s*overflow-x: auto !important/);
  assert.match(navigation,/@media \(min-width: 1181px\)[\s\S]*:where\(#portofolioPartialMount\) #tabStrip[\s\S]*display: grid !important;\s*grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
});
