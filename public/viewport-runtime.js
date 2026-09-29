/* One owner for keyboard geometry. Native layout and pinch zoom remain enabled. */
(function(root) {
  'use strict';
  if (!root || !root.document || root.AutoCuanViewport) return;
  const doc=root.document, html=doc.documentElement, vv=root.visualViewport;
  const composing=new WeakSet(), values=new Map();
  let frame=0, state=null, baseline=0, layoutWidth=0, revealPending=false;
  function editable(el) {
    if(!el || el.disabled || el.readOnly || (el.closest && el.closest('[inert]'))) return false;
    return el.tagName==='TEXTAREA' || el.isContentEditable || (el.tagName==='INPUT' && /^(text|search|email|url|tel|password|number)$/.test(el.type||'text'));
  }
  function isComposing(event) {return Boolean(event && (event.isComposing || event.keyCode===229 || (event.target && composing.has(event.target))));}
  function write(key,value) {if(values.get(key)!==value){values.set(key,value);html.style.setProperty(key,value);}}
  function reveal() {
    const el=doc.activeElement;
    if(!state || !state.keyboard || !editable(el) || !el.isConnected) return;
    const upper=state.top+12, lower=state.top+state.height-12;
    let parent=el.parentElement;
    while(parent && parent!==doc.body && parent!==html) {
      const css=root.getComputedStyle(parent);
      if(/^(auto|scroll)$/.test(css.overflowY) && parent.scrollHeight>parent.clientHeight) {
        const bounds=parent.getBoundingClientRect();let top=Math.max(upper,bounds.top), bottom=Math.min(lower,bounds.bottom);
        const head=parent.id==='mmSheetViewport' && parent.querySelector('thead');
        if(head)top=Math.max(top,head.getBoundingClientRect().bottom+4);
        const rect=el.getBoundingClientRect();let delta=rect.bottom>bottom?rect.bottom-bottom:rect.top<top?rect.top-top:0;
        if(delta && bottom>top)parent.scrollBy({top:delta,behavior:'instant'});
      }
      parent=parent.parentElement;
    }
    if(html.classList.contains('auth-dialog-open'))return;
    const rect=el.getBoundingClientRect();const delta=rect.bottom>lower?rect.bottom-lower:rect.top<upper?rect.top-upper:0;
    if(delta)root.scrollBy({top:delta,behavior:'instant'});
  }
  function sync() {
    frame=0;
    const width=html.clientWidth||root.innerWidth, height=Math.max(1,vv&&vv.height||root.innerHeight), scale=vv&&vv.scale||1;
    const layoutHeight=root.innerHeight||html.clientHeight, focus=editable(doc.activeElement);
    if(!layoutWidth || Math.abs(width-layoutWidth)>80){baseline=layoutHeight;layoutWidth=width;}
    if(!focus || !baseline)baseline=Math.max(baseline,height,layoutHeight);
    const keyboard=focus && width<1024 && Math.abs(scale-1)<.02 && Math.max(baseline,layoutHeight)-height>Math.max(100,baseline*.18);
    const next={left:vv&&vv.offsetLeft||0,top:vv&&vv.offsetTop||0,width:vv&&vv.width||width,height,scale,keyboard,keyboardGap:keyboard?Math.max(0,layoutHeight-height-(vv&&vv.offsetTop||0)):0};
    const changed=!state || Object.keys(next).some(key=>next[key]!==state[key]);
    const resized=!state || next.height!==state.height || next.keyboard!==state.keyboard;
    if(changed) {
      state=Object.freeze(next);
      for(const key of ['left','top','width','height'])write('--ac-vv-'+key,state[key]+'px');
      write('--ac-keyboard-gap',state.keyboardGap+'px');
      html.classList.toggle('ac-keyboard-open',Boolean(keyboard));
      doc.dispatchEvent(new CustomEvent('autocuan:viewportchange',{detail:state}));
    }
    if(revealPending || resized)reveal();
    revealPending=false;
  }
  function schedule(ensure) {revealPending=revealPending||ensure;if(!frame&&!doc.hidden)frame=root.requestAnimationFrame(sync);}
  doc.addEventListener('compositionstart',event=>composing.add(event.target),true);
  doc.addEventListener('compositionend',event=>composing.delete(event.target),true);
  doc.addEventListener('focusin',()=>schedule(true));
  doc.addEventListener('focusout',()=>schedule(false));
  if(vv){vv.addEventListener('resize',()=>schedule(true),{passive:true});vv.addEventListener('scroll',()=>schedule(false),{passive:true});}
  root.addEventListener('resize',()=>schedule(true),{passive:true});
  root.addEventListener('orientationchange',()=>{baseline=0;layoutWidth=0;schedule(true);},{passive:true});
  root.addEventListener('pageshow',()=>schedule(true),{passive:true});
  doc.addEventListener('visibilitychange',()=>{if(doc.hidden){if(frame)root.cancelAnimationFrame(frame);frame=0;}else schedule(true);});
  root.AutoCuanViewport={snapshot:()=>state,refresh:()=>schedule(false),reveal:el=>{if(el===doc.activeElement)schedule(true);},isComposing};
  sync();
})(window);
