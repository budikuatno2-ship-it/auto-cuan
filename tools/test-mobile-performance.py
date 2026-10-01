"""Real component code; simulated viewport/IME and mocked APIs. No physical-device claim."""
import json,os,subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('PRECISION_TEST_OUTPUT','/mnt/data/mobile-verified'));OUT.mkdir(parents=True,exist_ok=True)
ENGINE=os.environ.get('BROWSER_ENGINE','chromium')
landing={'__file__':str(ROOT/'tools/test-landing-experience.py')}
exec(compile((ROOT/'tools/test-landing-experience.py').read_text().split('checks=[];errors=[]')[0],'landing-fixture','exec'),landing)
finance={'__file__':str(ROOT/'tools/test-precision-browser.py')}
exec(compile((ROOT/'tools/test-precision-browser.py').read_text().split('with sync_playwright() as pw:')[0],'finance-fixture','exec'),finance)
viewport=r"""window.__viewport=new EventTarget();Object.assign(__viewport,{width:innerWidth,height:innerHeight,offsetTop:0,offsetLeft:0,scale:1});Object.defineProperty(window,'visualViewport',{value:__viewport,configurable:true});window.__geometry=x=>{Object.assign(__viewport,x);__viewport.dispatchEvent(new Event('resize'));};"""
checks=[];errors=[];metrics={}
def check(name,value):
    assert value,name
    checks.append(name)
def geometry(page,**values):
    page.evaluate('(x)=>__geometry(x)',values)
    # Synchronize with the viewport owner's animation-frame publication rather
    # than assuming Chromium/WebKit complete every resize within a 70 ms sleep.
    page.wait_for_function("x=>{const s=window.AutoCuanViewport&&AutoCuanViewport.snapshot();return s&&Object.entries(x).every(([key,value])=>s[({offsetTop:'top',offsetLeft:'left'})[key]||key]===value)&&document.documentElement.classList.contains('ac-keyboard-open')===Boolean(s.keyboard)}",arg=values,timeout=5000)
    page.evaluate("()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
with sync_playwright() as pw:
    browser=pw.webkit.launch(headless=True) if ENGINE=='webkit' else pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':390,'height':844},reduced_motion='reduce')
    page.route('**/*',lambda r:r.abort());page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.set_content(landing['fixture'],wait_until='domcontentloaded')
        page.add_script_tag(content=viewport)
        page.add_script_tag(content=(ROOT/'public/viewport-runtime.js').read_text())
        page.add_script_tag(content='\n'.join(landing[k] for k in ['mock','handlers','theme','sidebar','manager']))
        page.evaluate('()=>{window.__logins=0;window.doLogin=()=>__logins++;}')
        for color in ['light','dark']:
            page.evaluate('(t)=>applyAppTheme(t)',color)
            for width in [320,390,768]:
                page.set_viewport_size({'width':width,'height':844});geometry(page,width=width,height=844,offsetTop=0,scale=1)
                page.evaluate('openRegisterModal()');page.wait_for_timeout(35);page.locator('#regPasswordConfirm').focus()
                geometry(page,height=330,offsetTop=45)
                box=page.locator('#registerModal > div').bounding_box()
                check(f'{color}/{width} registration is bounded above keyboard',box['y']>=45 and box['y']+box['height']<=376)
                check(f'{color}/{width} keyboard does not overwrite layout viewport',page.evaluate('innerHeight===844'))
                check(f'{color}/{width} mobile input is at least 16px',page.locator('#regPasswordConfirm').evaluate('e=>parseFloat(getComputedStyle(e).fontSize)>=16'))
                geometry(page,height=844,offsetTop=0)
                check(f'{color}/{width} keyboard class is released',page.evaluate("!document.documentElement.classList.contains('ac-keyboard-open')"))
                page.evaluate('closeRegisterModal()');page.wait_for_timeout(30)
        page.set_viewport_size({'width':390,'height':844});geometry(page,width=390,height=844)
        page.evaluate('openLoginModal()');page.wait_for_timeout(35);field=page.locator('#loginPassword');field.focus()
        field.dispatch_event('compositionstart')
        field.dispatch_event('keydown',{'key':'Enter','bubbles':True,'keyCode':229})
        check('IME confirmation does not submit login',page.evaluate('__logins===0'))
        field.dispatch_event('keydown',{'key':'Escape','bubbles':True})
        check('IME Escape does not dismiss login',page.locator('#loginModal').is_visible())
        field.dispatch_event('compositionend');field.press('Enter')
        check('Ordinary Enter submits exactly once',page.evaluate('__logins===1'))
        geometry(page,height=330,scale=2)
        check('Pinch zoom is not treated as a keyboard',page.evaluate('!AutoCuanViewport.snapshot().keyboard'))
        geometry(page,height=330,scale=1)
        check('Unzoomed focused keyboard is detected',page.evaluate('AutoCuanViewport.snapshot().keyboard'))
        field.press('Escape');geometry(page,height=844)
        check('Dismissed login releases modal scroll lock',page.evaluate("!document.documentElement.classList.contains('auth-dialog-open')"))
        page.screenshot(path=str(OUT/f'keyboard-auth-{ENGINE}.png'))
        # Separate page keeps auth fixture globals from altering worksheet runtime.
        page.close();page=browser.new_page(viewport={'width':390,'height':844},reduced_motion='reduce')
        page.route('**/*',lambda r:r.abort());page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(finance['fixture'],wait_until='domcontentloaded');page.add_script_tag(content=viewport+'\n'+finance['mock'])
        for f in ['viewport-runtime.js','money-sheet-formulas.js','money-sheet-model.js','portfolio-command-center-model.js','money-sheet-grid.js','money-sheet-runtime.js']:page.add_script_tag(content=(ROOT/'public'/f).read_text())
        page.evaluate('AutoCuanMoneySheet.init()');page.wait_for_selector('#mmCashflowSpreadsheetBody tr')
        note=page.locator('#mmCashflowSpreadsheetBody textarea').first;note.fill('first');note.press('End');note.press('Enter');note.type('second')
        check('Notes retain native multiline editing',note.input_value()=='first\nsecond')
        note.press('ArrowUp');check('Notes keep native caret movement',note.evaluate('e=>e===document.activeElement'))
        check('Plain multiline note paste is not a row import',note.evaluate("e=>{const data=new DataTransfer();data.setData('text/plain','line1\\nline2');const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});e.dispatchEvent(event);return !event.defaultPrevented;}"))
        label=page.locator('#mmCashflowSpreadsheetBody [data-col="2"]').first;label.focus();label.dispatch_event('compositionstart')
        label.dispatch_event('keydown',{'key':'Enter','bubbles':True,'keyCode':229});check('IME confirmation does not navigate worksheet cell',label.evaluate('e=>e===document.activeElement'))
        label.dispatch_event('compositionend');label.press('F2');bar=page.locator('#mmFormulaInput');bar.dispatch_event('compositionstart')
        bar.dispatch_event('keydown',{'key':'Enter','bubbles':True,'keyCode':229});check('IME confirmation does not exit formula bar',bar.evaluate('e=>e===document.activeElement'))
        bar.dispatch_event('compositionend');bar.press('Escape')
        geometry(page,height=330,offsetTop=45);check('Worksheet uses the shared viewport owner',page.evaluate('AutoCuanViewport.snapshot().keyboard'))
        geometry(page,height=844,offsetTop=0);page.set_viewport_size({'width':1440,'height':1000});geometry(page,width=1440,height=1000)
        page.locator('#mmCellAddress').fill('C1');page.locator('#mmCellAddress').press('Enter')
        page.evaluate("()=>{const data=new DataTransfer();data.setData('text/plain',Array.from({length:300},(_,n)=>'Pos '+n).join('\\n'));document.activeElement.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));}")
        check('Large sheet reaches 300 rows',page.locator('#mmCashflowSpreadsheetBody tr').count()==300)
        label=page.locator('#mmCashflowSpreadsheetBody [data-col="2"]').first;label.focus();page.wait_for_timeout(50)
        page.evaluate("window.__mutations=0;window.__observer=new MutationObserver(r=>__mutations+=r.length);__observer.observe(document.getElementById('mmCashflowSpreadsheetBody'),{subtree:true,attributes:true,attributeFilter:['class','aria-selected']});")
        timings=[]
        for n in range(15):timings.append(label.evaluate("(e,n)=>{const t=performance.now();e.value='Nama '+n;e.dispatchEvent(new InputEvent('input',{bubbles:true}));return performance.now()-t;}",n))
        page.wait_for_timeout(100);mutations=page.evaluate('__mutations')
        check('Typing does not repaint selection attributes on 1500 cells',mutations==0)
        metrics={'rows':300,'input_events':15,'selection_attribute_mutations':mutations,'handler_ms':[round(n,2) for n in timings],'scope':'Local simulated fixture; not production INP or physical-device timing.'}
        page.screenshot(path=str(OUT/f'keyboard-sheet-{ENGINE}.png'))
        check('No uncaught JavaScript errors',not errors)
    finally:
        diagnostic=page.evaluate("""()=>{const e=document.querySelector('#registerModal');if(!e)return {};function inspect(el){const s=getComputedStyle(el);let rules=[];function walk(list){for(const r of list){if(r.media&&!matchMedia(r.conditionText).matches)continue;if(r.cssRules)walk(r.cssRules);if(r.selectorText){try{if(el.matches(r.selectorText)&&['top','inset','height','min-height','max-height','overflow','overflow-y'].some(p=>r.style.getPropertyValue(p)))rules.push({selector:r.selectorText,css:r.style.cssText});}catch(_){}}}}for(const sheet of document.styleSheets){try{walk(sheet.cssRules)}catch(_){}}return {bounds:el.getBoundingClientRect().toJSON(),inline:el.getAttribute('style'),top:s.top,height:s.height,minHeight:s.minHeight,maxHeight:s.maxHeight,viewportTop:s.getPropertyValue('--ac-vv-top'),viewportHeight:s.getPropertyValue('--ac-vv-height'),rules};}return {viewport:window.AutoCuanViewport&&AutoCuanViewport.snapshot(),rootClass:document.documentElement.className,active:document.activeElement&&document.activeElement.id,modal:inspect(e),child:inspect(e.firstElementChild)};}""")
        (OUT/f'keyboard-geometry-{ENGINE}.json').write_text(json.dumps(diagnostic,indent=2))
        page.screenshot(path=str(OUT/f'keyboard-final-{ENGINE}.png'))
        (OUT/f'mobile-results-{ENGINE}.json').write_text(json.dumps({'engine':ENGINE,'passed':len(checks),'checks':checks,'page_errors':errors,'metrics':metrics,'scope':'Actual component markup/code, mocked APIs and simulated VisualViewport/IME. Not physical Android/iPhone or production.'},indent=2))
        browser.close()
print(json.dumps({'engine':ENGINE,'passed':len(checks),'page_errors':errors,'metrics':metrics}))
