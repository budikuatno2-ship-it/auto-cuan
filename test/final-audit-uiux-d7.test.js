'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const root=path.resolve(__dirname,'..');const file=process.env.D7_SOURCE||path.join(root,'public/index.html');const html=fs.readFileSync(file,'utf8');const source=html.slice(html.indexOf('function updateGlobalLiveRadarStatus('),html.indexOf('function updateDashGreeting('));
let fixed=Date.parse('2026-10-06T04:00:00Z');
class Clock extends Date{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}}
function run(){const ids=['globalLiveRadarChip','globalLiveRadarDot','globalLiveRadarText','heroLiveRadarBadge','heroLiveRadarDot','heroLiveRadarText'];const elements=Object.fromEntries(ids.map(id=>[id,{style:{setProperty(k,v){this[k]=v;}},classList:{add(){}},setAttribute(k,v){this[k]=v;}}]));const c={Date:Clock,document:{getElementById:id=>elements[id]}};vm.createContext(c);vm.runInContext(source,c);return {update:c.updateGlobalLiveRadarStatus,elements};}
const fresh={calculated_at:'2026-10-06T03:45:00Z',freshness_label:'Fresh',data_stale:false};
const cases=[
 ['verified fresh',fresh,'Live Radar'],
 ['stale old timestamp',{data_stale:true,calculated_at:'2026-10-04T03:00:00Z'},'Radar: Data lama'],
 ['stale missing timestamp',{data_stale:true},'Radar: Data lama'],
 ['stale null timestamp',{data_stale:true,calculated_at:null},'Radar: Data lama'],
 ['stale invalid timestamp',{data_stale:true,calculated_at:'invalid'},'Radar: Data lama'],
 ['false stale missing timestamp',{data_stale:false},'Belum pasti'],
 ['missing metadata',undefined,'Belum pasti'],
 ['null metadata',null,'Belum pasti'],
 ['invalid timestamp',{calculated_at:'invalid'},'Belum pasti'],
 ['known old timestamp',{calculated_at:'2026-10-04T03:00:00Z'},'Radar: Data lama'],
 ['unavailable',{status:'failed',...fresh},'Tak tersedia'],
 ['response error',{success:false,error:'local',...fresh},'Tak tersedia'],
 ['timestamp alone',{calculated_at:fresh.calculated_at},'Belum pasti'],
 ['request time is not source time',{fetched_at:fresh.calculated_at,generated_at:fresh.calculated_at},'Belum pasti'],
 ['future timestamp',{...fresh,calculated_at:'2026-10-07T03:00:00Z'},'Belum pasti'],
 ['backend close snapshot',{...fresh,freshness_label:'Market Close Snapshot'},'Radar: Sesi tutup'],
 ['backend delayed',{...fresh,freshness_label:'Delayed'},'Radar: Tertunda'],
 ['stale beats scan',{...fresh,data_stale:true,status:'scanning'},'Radar: Data lama'],
 ['scanning is not freshness',{...fresh,status:'scanning'},'Radar: Memproses'],
 ['cached Fresh claim cannot override source age',{...fresh,calculated_at:'2026-10-06T02:59:00Z'},'Belum pasti'],
 ['previous WIB date',{...fresh,calculated_at:'2026-10-05T15:00:00Z'},'Radar: Sesi kemarin'],
 ['24h rounded age threshold',{...fresh,calculated_at:'2026-10-05T04:29:00Z'},'Radar: Data lama']
];
for(const [name,input,label]of cases)test('D7 '+name,()=>{const {update,elements}=run();assert.doesNotThrow(()=>update(input));for(const [badge,text]of [['globalLiveRadarChip','globalLiveRadarText'],['heroLiveRadarBadge','heroLiveRadarText']]){assert.equal(elements[text].textContent,label);if(label!=='Live Radar')assert.doesNotMatch(elements[badge].title,/data pasar (terkini|hari ini)|live/i);assert.ok(elements[badge].title);assert.ok(elements[badge]['aria-label'].includes(label));}});
test('D7 alias timestamps and stale flags retain precedence',()=>{for(const key of ['calculated_at','last_updated_at','updated_at']){const {update,elements}=run();update({[key]:fresh.calculated_at,freshness_label:'Fresh'});assert.equal(elements.heroLiveRadarText.textContent,'Live Radar');}for(const key of ['data_stale','is_stale','freshness_is_stale']){const {update,elements}=run();update({...fresh,[key]:true});assert.equal(elements.heroLiveRadarText.textContent,'Radar: Data lama');}});
test('D7 transitions clear old status and copy',()=>{const {update,elements}=run();for(const state of [{},{data_stale:true},fresh,{...fresh,data_stale:true},fresh]){update(state);assert.equal(elements.heroLiveRadarText.textContent,state.freshness_label==='Fresh'&&!state.data_stale?'Live Radar':state.data_stale?'Radar: Data lama':'Belum pasti');assert.equal(elements.heroLiveRadarBadge.title,elements.globalLiveRadarChip.title);}});

test('D7 WIB day rollover uses one source date consistently',()=>{const previous=fixed;try{fixed=Date.parse('2026-10-05T18:15:00Z');const {update,elements}=run();update({...fresh,calculated_at:'2026-10-05T18:00:00Z'});assert.equal(elements.heroLiveRadarText.textContent,'Live Radar');}finally{fixed=previous;}});
