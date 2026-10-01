'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('dashboard entry survives removal of the optional legacy admin panel',()=>{
 const html=fs.readFileSync('public/index.html','utf8');
 const source=html.slice(html.indexOf('function showDashboard()'),html.indexOf('function checkInitialUrlTargetPage()'));
 const ctx={document:{getElementById:()=>null},localStorage:{setItem(){},getItem(){return null}},window:{},_saveChatTimer:null,getUsername:()=> 'legacy',isAdmin:()=>false,setTimeout(){},console};
 for(const n of ['clearLegacyDeviceBlock','setTopLevelView','setWorkspaceSidebarVisible','syncHeaderUsername','updateUsageCounter','updateDashGreeting','loadDashboardTop5Monitor','scheduleTop5HistoryLoad','startDashboardMonitorAutoRefresh','checkInitialUrlTargetPage'])ctx[n]=()=>{};
 vm.runInNewContext(source,ctx);assert.doesNotThrow(()=>ctx.showDashboard());
});
