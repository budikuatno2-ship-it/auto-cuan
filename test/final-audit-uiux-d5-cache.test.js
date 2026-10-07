'use strict';

// ===========================================================================
// Tests for the tab keep-alive + SWR client cache (public/tab-keepalive-runtime.js).
//
// The contract worth protecting is behavioural, not cosmetic:
//   - a GET /api/ read is cached and served without a second round trip
//   - a mutation (any non-GET) is NEVER cached and NEVER served from cache
//   - a failed request is never cached, so a 502 cannot be frozen for 10 min
//   - the cache key ignores the volatile cache-buster params
//   - switching tabs never unmounts a panel (the keep-alive premise)
//
// LOCAL / MOCKED ONLY. No browser, network, or backend involvement: the module
// is loaded into a vm sandbox with a minimal fake window/fetch.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const RUNTIME_PATH = path.join(ROOT, 'public', 'tab-keepalive-runtime.js');
const runtimeSource = fs.readFileSync(RUNTIME_PATH, 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/** Minimal element stub — enough for classList/querySelector wiring. */
function makeElement(tag) {
  const classes = new Set();
  return {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, force) {
        if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
        else if (force) classes.add(c);
        else classes.delete(c);
      }
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    appendChild(c) { this.children.push(c); },
    querySelector() { return null; },
    closest() { return null; }
  };
}

/**
 * Load the runtime into a sandbox and hand back the API plus the fetch spy.
 * `responder(url, options)` returns { ok, status, body } or throws.
 */
function loadRuntime(responder) {
  const calls = [];
  const listeners = {};
  const head = makeElement('head');

  const win = {
    location: { origin: 'https://autocuan.web.id' },
    document: {
      readyState: 'complete',
      head,
      visibilityState: 'visible',
      __acKeepAliveHoverWired: false,
      getElementById() { return null; },
      createElement(tag) { return makeElement(tag); },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      querySelector() { return null; },
      querySelectorAll() { return []; }
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    setTimeout(fn) { return setTimeout(fn, 0); },
    clearTimeout(id) { clearTimeout(id); },
    requestAnimationFrame(fn) { return setTimeout(fn, 0); },
    scrollY: 0,
    scrollTo() {},
    fetch(url, options) {
      calls.push({ url: String(url), options: options || {} });
      const reply = responder(String(url), options || {});
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({
        ok: reply.ok !== false,
        status: reply.status || 200,
        text: () => Promise.resolve(reply.body === undefined ? '{}' : reply.body),
        json: () => Promise.resolve(JSON.parse(reply.body === undefined ? '{}' : reply.body))
      });
    }
  };
  win.window = win;

  const sandbox = {
    window: win,
    document: win.document,
    URL,
    Promise,
    JSON,
    Date,
    Map,
    WeakSet,
    WeakMap,
    Object,
    Array,
    String,
    Number,
    Boolean,
    encodeURIComponent,
    setTimeout,
    clearTimeout
  };

  vm.createContext(sandbox);
  vm.runInContext(runtimeSource, sandbox, { filename: 'tab-keepalive-runtime.js' });
  return { api: win.AutoCuanKeepAlive, calls, win, listeners };
}

test('D5 explicit cache revalidation replaces fresh data while passive GET stays cached',async()=>{
 let n=0;const {api,calls}=loadRuntime(()=>({body:JSON.stringify({success:true,n:++n})}));
 await api.cachedFetch('/api/watchlist');await api.cachedFetch('/api/watchlist');assert.equal(calls.length,1);
 const fresh=await (await api.cachedFetch('/api/watchlist',undefined,{revalidate:true})).json();assert.equal(fresh.n,2);assert.equal(calls.length,2);
 assert.equal(calls[1].options.cache,'no-cache');assert.equal(calls[0].options.cache,undefined);
 assert.equal((await (await api.cachedFetch('/api/watchlist')).json()).n,2);assert.equal(calls.length,2);
});
for(const kind of ['api','http','network'])test(`D5 ${kind} failure preserves last valid cache and allows retry`,async()=>{
 let failing=false;const {api,calls}=loadRuntime(()=>failing?(kind==='api'?{body:'{"success":false,"error":"local"}'}:kind==='http'?{ok:false,status:503}:new Error('local network failure')):{body:'{"success":true,"n":1}'});
 await api.cachedFetch('/api/watchlist');const before=api.peek('/api/watchlist');failing=true;
 try{const response=await api.cachedFetch('/api/watchlist',undefined,{revalidate:true});assert.equal(kind==='api'?(await response.json()).success:response.ok,false);}catch(e){assert.equal(kind,'network');}
 const after=api.peek('/api/watchlist');assert.deepEqual(after.data,before.data);assert.ok(after.ageMs>=before.ageMs);assert.equal(calls.length,2);
 failing=false;await api.cachedFetch('/api/watchlist',undefined,{revalidate:true});assert.equal(calls.length,3);
});
test('D5 concurrent forced readers share one fresh response without changing its shape',async()=>{
 const {api,calls,win}=loadRuntime(()=>({body:'{"success":true,"n":1}'}));await api.cachedFetch('/api/watchlist');let release;
 win.fetch=()=>{calls.push({url:'/api/watchlist'});return new Promise(resolve=>{release=()=>resolve({ok:true,status:200,text:async()=>'{"success":true,"n":2}'});});};
 const one=api.cachedFetch('/api/watchlist',undefined,{revalidate:true}),two=api.cachedFetch('/api/watchlist',undefined,{revalidate:true});assert.equal(calls.length,2);release();
 assert.equal((await (await one).json()).n,2);assert.equal((await (await two).json()).n,2);
});
