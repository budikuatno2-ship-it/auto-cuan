/* Progressive, self-hosted NumberFlow. Only explicitly selected summary values
   animate; the accessible text always exposes the exact latest source value. */
(function(root) {
  'use strict';
  if(root.AutoCuanNumeric)return;
  const records=new WeakMap(), live=new Set(), reduced=root.matchMedia('(prefers-reduced-motion: reduce)');
  let library=null, pending=null;
  function load() {
    if(!pending)pending=import('/vendor/number-flow-0.6.2/index.mjs').then(value=>{library=value;return value;}).catch(()=>null);
    return pending;
  }
  function sweep() {live.forEach(flow=>{if(!flow.isConnected){flow.animated=false;live.delete(flow);}});}
  function duration(name,fallback) {const raw=root.getComputedStyle(root.document.documentElement).getPropertyValue(name).trim(),n=parseFloat(raw);return Number.isFinite(n)?n*(raw.endsWith('ms')?1:1000):fallback;}
  function upgrade(element,record) {
    if(!library||!element.isConnected||records.get(element)!==record||record.value==null)return;
    try {
      if(!record.flow) {
        const flow=root.document.createElement('number-flow');flow.setAttribute('aria-hidden','true');flow.className='ac-number-flow';
        flow.locales='id-ID';flow.format=record.format;flow.numberPrefix=record.prefix;flow.numberSuffix=record.suffix;
        flow.respectMotionPreference=true;flow.trend=0;flow.transformTiming={duration:duration('--motion-base',260),easing:'cubic-bezier(.16,1,.3,1)'};
        flow.opacityTiming={duration:duration('--motion-fast',180),easing:'ease-out'};flow.animated=false;
        record.flow=flow;element.appendChild(flow);flow.update(record.value);record.text.classList.add('ac-numeric-readable');live.add(flow);
      } else {
        const flow=record.flow;flow.animated=!reduced.matches&&root.document.visibilityState==='visible'&&element.getClientRects().length>0;
        flow.update(record.value);
      }
      element.dataset.numberFlow='ready';sweep();
    }catch(_){if(record.flow){live.delete(record.flow);record.flow.remove();record.flow=null;}record.text.classList.remove('ac-numeric-readable');element.dataset.numberFlow='fallback';}
  }
  function set(element,value,options) {
    if(!element)return;
    options=options||{};const valid=typeof value==='number'&&Number.isFinite(value),prefix=options.prefix||'',suffix=options.suffix||'';
    const format={minimumFractionDigits:options.digits||0,maximumFractionDigits:options.digits||0};
    const text=valid?prefix+new Intl.NumberFormat('id-ID',format).format(value)+suffix:(options.empty||'\u2014');
    let record=records.get(element);const key=JSON.stringify([prefix,suffix,format]);
    if(!valid){if(record&&record.flow){record.flow.animated=false;live.delete(record.flow);}records.delete(element);element.textContent=text;delete element.dataset.numberFlow;return;}
    if(record && record.key===key && record.value===value && record.flow && element.contains(record.text)) return;
    if(!record||record.key!==key||!element.contains(record.text)){
      if(record&&record.flow){record.flow.animated=false;live.delete(record.flow);}
      const span=root.document.createElement('span');span.textContent=text;element.replaceChildren(span);
      record={key,value,text:span,prefix,suffix,format,flow:null};records.set(element,record);
    }else{record.value=value;record.text.textContent=text;}
    if(library)upgrade(element,record);
    else if(!reduced.matches)load().then(()=>upgrade(element,record));
  }
  reduced.addEventListener('change',()=>{sweep();live.forEach(flow=>{flow.animated=!reduced.matches&&root.document.visibilityState==='visible';});});
  root.document.addEventListener('visibilitychange',()=>{sweep();if(root.document.visibilityState!=='visible')live.forEach(flow=>{flow.animated=false;});});
  root.AutoCuanNumeric={set,load};
})(window);
