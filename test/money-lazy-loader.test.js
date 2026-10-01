'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('money scripts load once, in dependency order, only after opening the page',async()=>{
 const scripts=[];let initialized=0;
 const root={currentPage:'money-management',document:{head:{appendChild(s){scripts.push(s);queueMicrotask(()=>{if(s.src.includes('runtime'))root.initMoneyManagement=()=>initialized++;s.onload();});}},createElement(){return{};}},showToast(){}};
 vm.runInNewContext(fs.readFileSync('public/money-sheet-lazy-loader.js','utf8'),{window:root,Promise});
 assert.equal(scripts.length,0);
 await Promise.all([root.initMoneyManagement(),root.initMoneyManagement()]);
 assert.equal(scripts.length,4);assert.equal(initialized,1);
 await root.initMoneyManagement();assert.equal(scripts.length,4);
 assert.ok(scripts[0].src.includes('formulas'));assert.ok(scripts[3].src.includes('runtime'));
});
