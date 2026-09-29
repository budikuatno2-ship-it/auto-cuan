"""Offline browser integration: real repository markup/CSS/runtime, mocked I/O.
Requires Python playwright and a Chromium executable; does not contact production.
"""
import json, os, re
from pathlib import Path
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('PRECISION_TEST_OUTPUT', '/mnt/data/precision-review'))
OUT.mkdir(parents=True, exist_ok=True)
html = (ROOT/'public/index.html').read_text()
soup = BeautifulSoup(html, 'html.parser')

def cssfile(p, seen=None):
    seen = set() if seen is None else seen
    if p in seen or not p.is_file(): return ''
    seen.add(p)
    text = p.read_text()
    def imp(m):
        name = m.group(1).split('?')[0]
        return cssfile(ROOT/'public'/name.lstrip('/') if name.startswith('/') else p.parent/name, seen)
    return re.sub(r'@import\s+(?:url\()?\s*[\"\']([^\"\']+)[\"\']\s*\)?\s*;', imp, text)

styles=[]
for element in soup.head.children:
    if getattr(element,'name',None)=='link' and 'stylesheet' in element.get('rel',[]) and element.get('href','').startswith('/'):
        styles.append('<style>'+cssfile(ROOT/'public'/element['href'].split('?')[0].lstrip('/'))+'</style>')
    if getattr(element,'name',None)=='style': styles.append(str(element))
css = ''.join(styles)
aside = soup.select_one('#appSidebar')
aside['class'] = ['app-sidebar']
for b in aside.select('[data-premium-nav],#tabAnalisisPattern'): b['class']=['sidebar-item']
for b in aside.select('.sidebar-item'): b['class']=['sidebar-item']+(['active'] if b.get('data-sidebar-page')=='money-management' else [])
finance = (ROOT/'partials/money-management.partial.html').read_text().replace('page-content money-sheet hidden','page-content money-sheet')
header = str(soup.select_one('#appMain > header'))
fixture = '<!doctype html><html><head><meta charset="utf-8">'+css+'</head><body class="sidebar-open"><div class="app-shell app-layout" id="appShell" data-sidebar-state="expanded">'+str(aside)+'<main class="app-main" id="appMain">'+header+'<div id="appContent" class="app-content">'+finance+'</div></main></div></body></html>'
mock = r'''(() => {
const values = new Map([['autocuan_user_id','test-user']]);
Object.defineProperty(window,'localStorage',{value:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),clear:()=>values.clear()},configurable:true});
window.__requests=[];window.__mode='ok';window.__resolveSave=null;
window.navigateTo=(...args)=>window.__navigation=args;
window.toggleAppTheme=()=>document.documentElement.classList.toggle('light');
window.toggleSidebarCollapse=()=>{document.body.classList.toggle('sidebar-collapsed');document.getElementById('appSidebar').classList.toggle('collapsed');document.getElementById('appSidebar').classList.toggle('is-collapsed');document.getElementById('appShell').dataset.sidebarState=document.body.classList.contains('sidebar-collapsed')?'collapsed':'expanded';};
window.confirm=()=>false;
window.fetch=async (url,options={})=>{
 __requests.push({url,options});
 if(options.method==='POST') {
   if(__mode==='delay') await new Promise(resolve=>window.__resolveSave=resolve);
   if(__mode==='conflict')return {ok:false,status:409,json:async()=>({success:false,code:'SHEET_CONFLICT',error:'Konflik versi. Ekspor lalu muat ulang.'})};
   const body=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({success:true,user_id:'test-user',data:{revision:(body.expected_revision||0)+1}})};
 }
 if(String(url).includes('portfolio-summary')) return {ok:true,json:async()=>({success:true,user_id:'test-user',data:null})};
 if(__mode==='load-error')return {ok:false,status:503,json:async()=>({success:false,error:'Penyimpanan tidak tersedia.'})};
 const month=new URL(url,'https://test.local').searchParams.get('month');
 return {ok:true,status:200,json:async()=>({success:true,user_id:'test-user',data:{month,notes:'Data contoh untuk pengujian, bukan data akun.',revision:0,sheet:AutoCuanMoneySheetModel.fromLegacy({income_salary:12000000,income_side:2000000,expense_necessities:4500000,expense_wants:1500000,savings_emergency:2000000,trading_capital_allocation:1000000})}})};
};})();'''
results=[]
def check(name, condition):
    assert condition, name
    results.append(name)

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1600,'height':1000},device_scale_factor=1)
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/*',lambda r:r.abort())
    page.set_content(fixture,wait_until='domcontentloaded')
    page.add_script_tag(content=mock)
    for file in ['money-sheet-formulas.js','money-sheet-model.js','portfolio-command-center-model.js','money-sheet-grid.js','money-sheet-runtime.js']:page.add_script_tag(content=(ROOT/'public'/file).read_text())
    page.evaluate('AutoCuanMoneySheet.init()')
    page.wait_for_selector('#mmCashflowSpreadsheetBody tr')
    check('Seven legacy rows loaded',page.locator('#mmCashflowSpreadsheetBody tr').count()==7)
    for motion in ['reduce','no-preference']:
        page.emulate_media(reduced_motion=motion)
        page.evaluate("document.documentElement.classList.add('light')")
        check('Light cell surface with '+motion,page.locator('#mmCashflowSpreadsheetBody input[data-field="label"]').first.evaluate("e=>{while(e){const c=getComputedStyle(e).backgroundColor;if(c!=='rgba(0, 0, 0, 0)')return c==='rgb(255, 255, 255)';e=e.parentElement}return false}"))
        check('Vertical sidebar profile with '+motion,page.locator('#appSidebar .sidebar-footer').evaluate("e=>getComputedStyle(e).flexDirection==='column'"))
    page.evaluate("document.documentElement.classList.remove('light')")

    check('Legacy remainder preserved',page.locator('#mmRemainingBudgetDisplay').inner_text()=='Rp 5.000.000')
    amount=page.locator('[data-row-id="legacy-income_salary"] [data-field="amount"]')
    amount.focus();page.evaluate('window.__original=document.activeElement')
    amount.fill('12500000');amount.press('End');amount.press('0');page.wait_for_timeout(100)
    check('Typing keeps cell identity and focus',page.evaluate('document.activeElement===window.__original && window.__original.isConnected'))
    check('Amount updates without recreating table',amount.input_value()=='125000000')
    amount.fill('12500000');amount.press('Tab')
    page.locator('#mmUndo').click()
    check('Undo restores exact original amount',amount.input_value()=='12.000.000')
    page.locator('#mmRedo').click()
    check('Redo restores edit',amount.input_value()=='12.500.000')
    amount.fill('-1');amount.press('Tab')
    check('Invalid amount blocks save',page.locator('#mmBtnSaveCashflow').is_disabled())
    page.locator('#mmSheetSearch').fill('Gaji')
    check('Filter preserves invalid raw entry',amount.input_value()=='-1')
    page.locator('#mmSheetSearch').fill('')
    amount.fill('12000000');amount.press('Tab')
    page.locator('#mmAddRow').click()
    check('Add row focuses editable name',page.locator('#mmCashflowSpreadsheetBody tr').count()==8 and page.evaluate('document.activeElement.dataset.field')=='label')
    page.keyboard.insert_text('<img src=x onerror=alert(1)>')
    check('User labels are plain text',page.locator('#mmCashflowSpreadsheetBody img').count()==0)
    page.locator('#mmUndo').click();page.locator('#mmUndo').click()
    check('Add row is undoable',page.locator('#mmCashflowSpreadsheetBody tr').count()==7)
    page.locator('[data-row-id="legacy-income_side"] [data-field="category"]').evaluate("el => {el.focus();const dt=new DataTransfer();dt.setData('text/plain','Proyek\\tFreelance\\t3000000\\tDiterima');el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}")
    check('Multi-cell paste updates all cells',page.locator('[data-row-id="legacy-income_side"] [data-field="amount"]').input_value()=='3.000.000')
    page.evaluate("window.__mode='conflict'");page.locator('#mmBtnSaveCashflow').click();page.wait_for_timeout(100)
    check('Conflict preserves edits and displays failure',page.locator('#mmSheetNotice').inner_text().startswith('Konflik') and page.evaluate('AutoCuanMoneySheet.hasUnsaved()'))
    page.evaluate("window.__mode='delay'");page.locator('#mmBtnSaveCashflow').click();amount.fill('13000000');amount.press('Tab')
    page.evaluate('window.__resolveSave()');page.wait_for_timeout(100)
    check('Edits during save remain dirty',page.evaluate('AutoCuanMoneySheet.hasUnsaved()'))
    check('Month disabled only while saving',not page.locator('#mmSheetMonth').is_disabled())
    page.evaluate("window.__mode='ok'");page.locator('#mmBtnSaveCashflow').click();page.wait_for_timeout(100)
    check('Confirmed save clears dirty state',not page.evaluate('AutoCuanMoneySheet.hasUnsaved()'))
    page.evaluate("localStorage.setItem('autocuan_portfolio_plans_test-user',JSON.stringify([{ticker:'BBCA',lots:10,entryPriceIdr:9000,stopLossIdr:8800,capitalIdr:9000000}]));localStorage.setItem('autocuan_portfolio_prices_test-user',JSON.stringify({BBCA:9100}));window.dispatchEvent(new CustomEvent('autocuan:portfolio-changed',{detail:{userId:'test-user'}}))")
    page.wait_for_timeout(100)
    check('Linked Portfolio updates without a page reload',page.locator('#mmPortfolioExposure').inner_text()=='Rp 9.000.000')
    check('Portfolio exposure is not deducted from cashflow',page.locator('#mmRemainingBudgetDisplay').inner_text()=='Rp 7.000.000')
    for theme in ['dark','light']:
        page.evaluate("document.documentElement.classList.toggle('light',%s)" % ('true' if theme=='light' else 'false'))
        page.wait_for_timeout(250)
        page.evaluate('document.activeElement.blur();window.scrollTo(0,0)');page.wait_for_timeout(400);page.screenshot(path=str(OUT/('finance-'+theme+'-review.png')),full_page=False)
        check(theme+' content clears sidebar',page.locator('#moneySheetTitle').bounding_box()['x'] >= 260)
        check(theme+' no horizontal page overflow',page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        a=page.locator('#appSidebar').bounding_box();p=page.locator('#appSidebar .sidebar-footer').bounding_box()
        check(theme+' sidebar fills viewport and profile docked',abs(a['y'])<1 and abs(a['height']-1000)<2 and abs(p['y']+p['height']-1000)<2)
    page.evaluate("document.getElementById('appContent').style.minHeight='2200px';window.scrollTo(0,600)")
    page.wait_for_timeout(100)
    check('Sidebar fixed during document scroll',abs(page.locator('#appSidebar').bounding_box()['y'])<1)
    page.evaluate("window.scrollTo(0,0);document.getElementById('appContent').style.minHeight='';toggleSidebarCollapse()")
    page.wait_for_timeout(250)
    check('Collapsed sidebar width 72px',abs(page.locator('#appSidebar').bounding_box()['width']-72)<1)
    page.screenshot(path=str(OUT/'finance-collapsed.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(250)
    check('Mobile page has no horizontal overflow',page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
    check('Sidebar is closed on mobile',page.locator('#appSidebar').bounding_box() is None or page.locator('#appSidebar').bounding_box()['x']<0)
    page.evaluate('document.activeElement.blur();window.scrollTo(0,0)');page.wait_for_timeout(250);page.screenshot(path=str(OUT/'finance-mobile.png'),full_page=True)
    page.evaluate("document.getElementById('appSidebar').classList.add('mobile-open');document.body.classList.add('sidebar-mobile-open')")
    page.wait_for_timeout(250)
    check('Mobile drawer shows text despite saved collapsed desktop preference',page.locator('#appSidebar .sidebar-label').first.is_visible())
    page.screenshot(path=str(OUT/'navigation-mobile.png'),full_page=True)
    page.evaluate("localStorage.setItem('autocuan_user_id','other-user');window.dispatchEvent(new StorageEvent('storage',{key:'autocuan_user_id',newValue:'other-user'}))")
    check('Account switch clears financial cell data',page.locator('#mmCashflowSpreadsheetBody tr').count()==0)
    check('No JavaScript page errors',not errors)
    (OUT/'browser-results.json').write_text(json.dumps({'passed':len(results),'checks':results,'page_errors':errors,'scope':'Offline actual-component browser tests. Mocked I/O. Not production or real database.'},indent=2))
    browser.close()
print(json.dumps({'passed':len(results),'output':str(OUT)}))
