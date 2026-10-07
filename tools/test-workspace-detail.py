"""Real local assets and official self-hosted NumberFlow, with mocked auth/API.
No production login, credentials, network data, or real-device claims.
"""
import json, os, re
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('PRECISION_TEST_OUTPUT','/mnt/data/detail-review'));OUT.mkdir(parents=True,exist_ok=True)
env={'__file__':str(ROOT/'tools/test-precision-browser.py')}
exec(compile((ROOT/'tools/test-precision-browser.py').read_text().split('with sync_playwright() as pw:')[0],'fixture','exec'),env)
landing={'__file__':str(ROOT/'tools/test-landing-experience.py')}
exec(compile((ROOT/'tools/test-landing-experience.py').read_text().split('checks=[];errors=[]')[0],'landing-fixture','exec'),landing)
fixture=env['fixture'].replace('<head>','<head><base href="https://autocuan.test/">'); mock=env['mock']
checks=[];errors=[]
def check(name,condition):
    assert condition,name
    checks.append(name)
def contrast(fg,bg):
    def light(css):
        channels=[float(n)/255 for n in re.findall(r'[\d.]+',css)[:3]]
        return sum((v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4)*w for v,w in zip(channels,[.2126,.7152,.0722]))
    a,b=light(fg),light(bg);return (max(a,b)+.05)/(min(a,b)+.05)
def serve(route):
    url=urlparse(route.request.url)
    if url.hostname!='autocuan.test':return route.abort()
    if url.path=='/':return route.fulfill(content_type='text/html',body=fixture)
    path=(ROOT/'public'/url.path.lstrip('/')).resolve()
    if not path.is_relative_to(ROOT/'public') or not path.is_file():return route.abort()
    return route.fulfill(content_type='text/javascript' if path.suffix in ['.js','.mjs'] else 'text/css',headers={'Access-Control-Allow-Origin':'*'},body=path.read_bytes())
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':980})
    page.route('**/*',serve);page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.set_content(fixture,wait_until='domcontentloaded')
        page.add_script_tag(content=mock)
        page.add_script_tag(content=landing['sidebar'])
        for name in ['money-sheet-formulas.js','money-sheet-model.js','portfolio-command-center-model.js','number-flow-runtime.js','money-sheet-grid.js','money-sheet-runtime.js']:
            page.add_script_tag(content=(ROOT/'public'/name).read_text())
        page.evaluate('AutoCuanMoneySheet.init()')
        page.wait_for_selector('#mmCashflowSpreadsheetBody tr')
        page.wait_for_function("document.querySelector('#mmTotalIncomeDisplay number-flow')?.shadowRoot")
        check('Official NumberFlow custom element is actually upgraded',page.evaluate("customElements.get('number-flow') && document.querySelector('#mmTotalIncomeDisplay').dataset.numberFlow==='ready'"))
        check('Exact accessible value is separate from animated graphics',page.locator('#mmTotalIncomeDisplay .ac-numeric-readable').inner_text()=='Rp 14.000.000' and page.locator('#mmTotalIncomeDisplay number-flow').get_attribute('aria-hidden')=='true')
        amount=lambda n:page.locator('#mmCashflowSpreadsheetBody tr').nth(n-1).locator('[data-col="3"]')
        def go(address):
            page.locator('#mmCellAddress').fill(address);page.locator('#mmCellAddress').press('Enter')
        go('D3');page.keyboard.press('F2');page.locator('#mmFormulaInput').fill('=ROUND(SUM(D1:D2)*0.1)');page.locator('#mmFormulaInput').press('Enter');page.locator('#mmSheetSearch').focus()
        check('Formula bar writes calculated rupiah',amount(3).input_value()=='1.400.000')
        amount(1).fill('20000000');page.locator('#mmSheetSearch').focus()
        check('Source edit recalculates dependent cells',amount(3).input_value()=='2.200.000')
        page.wait_for_timeout(320)
        check('Animated summary exposes final exact amount',page.locator('#mmTotalIncomeDisplay .ac-numeric-readable').inner_text()=='Rp 24.200.000')
        go('D1:D3')
        check('Address box selects a real range',page.locator('td.ms-selected').count()==3)
        check('Range status computes selected amount sum','24.200.000' in page.locator('#mmSelectionStats').inner_text())
        page.keyboard.press('Shift+ArrowDown')
        check('Shift arrow extends rather than discards selection',page.locator('td.ms-selected').count()==4)
        page.keyboard.press('Escape');check('Escape reduces range to active cell',page.locator('td.ms-selected').count()==1)
        go('D3');amount(3).fill('=D3');page.locator('#mmSheetSearch').focus()
        check('Cycle has an explicit validation error','melingkar' in page.locator('#mmSheetNotice').inner_text())
        check('Invalid formula cannot be saved',page.locator('#mmBtnSaveCashflow').is_disabled())
        amount(3).fill('=SUM(D1:D2)');page.locator('#mmSheetSearch').focus()
        check('Fixing a formula restores save readiness',not page.locator('#mmBtnSaveCashflow').is_disabled())
        go('D1');page.locator('#mmInsertRow').click()
        check('Insert creates a physical row',page.locator('#mmCashflowSpreadsheetBody tr').count()==8)
        check('Insert rebases dependencies',amount(4).get_attribute('data-formula')=='=SUM(D2:D3)' and amount(4).input_value()=='22.000.000')
        page.locator('#mmUndo').click();check('Undo restores structure and formula',page.locator('#mmCashflowSpreadsheetBody tr').count()==7 and amount(3).get_attribute('data-formula')=='=SUM(D1:D2)')
        before=amount(1).input_value();page.locator('#mmCashflowSpreadsheetBody [data-remove]').first.click()
        check('Deleting a referenced row is rejected without data loss',page.locator('#mmCashflowSpreadsheetBody tr').count()==7 and amount(1).input_value()==before and 'dipakai' in page.locator('#mmSheetNotice').inner_text())
        go('D1:D2');page.keyboard.press('Control+d');page.locator('#mmSheetSearch').focus()
        check('Fill down copies source and recalculates dependents',amount(2).input_value()=='20.000.000' and amount(3).input_value()=='40.000.000')
        page.locator('#mmUndo').click();check('Fill down undo is a single transaction',amount(2).input_value()=='2.000.000')
        amount(3).fill('100');page.locator('#mmSheetSearch').focus()
        go('C1');page.evaluate("()=>{const dt=new DataTransfer();dt.setData('text/plain','\"Gaji\\tutama\"\\t20000000\\t\"baris satu\\nbaris dua\"');document.activeElement.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:dt}));}")
        check('Quoted multiline paste preserves cell boundaries',page.locator('#mmCashflowSpreadsheetBody tr').first.locator('[data-col="2"]').input_value()=='Gaji\tutama' and page.locator('#mmCashflowSpreadsheetBody tr').first.locator('[data-col="4"]').input_value()=='baris satu\nbaris dua')
        handle=page.locator('[data-resize="3"]');old=int(handle.get_attribute('aria-valuenow'));handle.focus();handle.press('ArrowRight')
        check('Column width is keyboard resizable',int(handle.get_attribute('aria-valuenow'))==old+8)
        go('D1');page.locator('#mmSheetSort').select_option('amount');page.locator('#mmSheetSort').select_option('original')
        check('Physical addresses survive sorting',page.locator('#mmCashflowSpreadsheetBody tr').first.locator('th button').inner_text()=='1')
        page.locator('#mmExpandSheet').click();check('Focus mode increases worksheet space',page.locator('#page-money-management').evaluate("e=>e.classList.contains('ms-expanded')"))
        amount(1).focus();page.keyboard.press('Escape');check('Escape exits focus mode',not page.locator('#page-money-management').evaluate("e=>e.classList.contains('ms-expanded')"))
        page.evaluate("()=>{const e=document.getElementById('mmPortfolioExposure');for(const v of [0,-100,1234567890123,0])AutoCuanNumeric.set(e,v,{prefix:'Rp '});}");page.wait_for_timeout(320)
        check('Rapid positive/negative/zero updates end at exact zero',page.locator('#mmPortfolioExposure .ac-numeric-readable').inner_text()=='Rp 0')
        page.evaluate("AutoCuanNumeric.set(document.getElementById('mmPortfolioExposure'),null,{prefix:'Rp '})")
        check('Missing amount is not fabricated zero',page.locator('#mmPortfolioExposure').inner_text()=='\u2014')
        page.emulate_media(reduced_motion='reduce');page.wait_for_timeout(25)
        check('Reduced motion disables live numeric animation',page.evaluate("Array.from(document.querySelectorAll('number-flow')).every(e=>!e.animated)"))
        for theme in ['light','dark']:
            page.evaluate("t=>document.documentElement.classList.toggle('light',t==='light')",theme)
            colors=page.locator('#appSidebar .brand-mark').evaluate("e=>({bg:getComputedStyle(e).backgroundColor,fg:getComputedStyle(e.querySelector('svg')).color,after:getComputedStyle(e,'::after').display})")
            check(theme+' brand icon contrast',contrast(colors['fg'],colors['bg'])>=4.5)
            check(theme+' no stray status dot on logo',colors['after']=='none')
            page.locator('#headerUsername').evaluate("e=>e.textContent='Nama akun sangat panjang untuk verifikasi'")
            for width in [320,390,768,1024,1440]:
                page.set_viewport_size({'width':width,'height':980 if width>900 else 844})
                check(theme+'/'+str(width)+' worksheet has no page overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                if width < 1024:
                    # V2 deliberately moves Account Center into the drawer;
                    # the duplicate username/logout topbar controls stay hidden.
                    box=page.locator('#workspaceSidebarToggle').bounding_box()
                    check(f'{theme}/{width} mobile menu trigger fully visible',box is not None and box['x']>=0 and box['x']+box['width']<=width and box['height']>=44)
                    check(f'{theme}/{width} duplicate topbar account controls stay hidden',not page.locator('#headerUserLabel').is_visible() and not page.locator('#logoutBtn').is_visible())
                    page.locator('#workspaceSidebarToggle').click()
                    page.wait_for_function("document.getElementById('appSidebar').classList.contains('mobile-open')")
                    page.wait_for_timeout(250)
                    account=page.locator('#sidebarAccountEntry');box=account.bounding_box()
                    check(f'{theme}/{width} canonical drawer account entry fully visible',box is not None and box['x']>=0 and box['x']+box['width']<=width and box['y']>=0 and box['y']+box['height']<=page.viewport_size['height'] and box['height']>=44)
                    check(f'{theme}/{width} canonical account center hit reaches entry',account.evaluate("e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}"))
                    page.keyboard.press('Escape')
                    check(f'{theme}/{width} drawer closes and restores menu focus',page.evaluate("!document.getElementById('appSidebar').classList.contains('mobile-open')&&document.activeElement.id==='workspaceSidebarToggle'&&!document.getElementById('appMain').inert"))
                if width in [390,1440]:
                    page.evaluate('document.activeElement.blur();window.scrollTo(0,0)');page.screenshot(path=str(OUT/f'worksheet-{theme}-{width}.png'),full_page=True)
        page.evaluate("localStorage.setItem('autocuan_user_id','other');window.dispatchEvent(new StorageEvent('storage',{key:'autocuan_user_id',newValue:'other'}))")
        check('Account switch clears formula bar and selection',page.locator('#mmFormulaInput').input_value()=='' and page.locator('#mmCashflowSpreadsheetBody tr').count()==0)
        check('No uncaught page errors',not errors)
    finally:
        (OUT/'detail-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'page_errors':errors,'scope':'Chromium real assets and NumberFlow, mocked auth/API. Not production/physical devices.'},indent=2))
        try: page.screenshot(path=str(OUT/'detail-last-state.png'))
        except Exception: pass
        browser.close()
print(json.dumps({'passed':len(checks),'page_errors':errors}))
