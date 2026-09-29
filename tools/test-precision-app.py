"""Full app preview navigation test; local mock server only, never production."""
import json, os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('PRECISION_TEST_OUTPUT','/mnt/data/precision-review')); OUT.mkdir(parents=True,exist_ok=True)
BASE='http://127.0.0.1:3100'
checks=[];errors=[]

def check(name,condition):
    assert condition,name
    checks.append(name)

def network(route):
    url=route.request.url
    if not url.startswith(BASE): return route.abort()
    if '/api/money-management' in url:
        params=parse_qs(urlparse(url).query); action=params.get('action',[''])[0]
        payload={'success':True,'user_id':'admin-budi-id','data':None}
        if action=='get-sheet':payload['data']={'month':params['month'][0],'sheet':{'version':1,'rows':[{'id':'initial','type':'income','category':'Utama','label':'Data uji','amount':12000000,'note':'Bukan data akun'}]},'notes':'','revision':0}
        return route.fulfill(status=200,content_type='application/json',body=json.dumps(payload))
    route.continue_()

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':1000},reduced_motion='reduce')
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/*',network)
    try:
        page.goto(BASE+'/preview/kelola-keuangan',wait_until='domcontentloaded')
        page.wait_for_selector('#mmCashflowSpreadsheetBody tr',timeout=30000)
        check('Full SPA loads the worksheet',page.locator('#page-money-management').is_visible())
        check('No duplicate Finance journal',page.locator('#mmPanelJournal,#mmTabBtnJournal').count()==0)
        check('Sidebar fixed in full app',page.locator('#appSidebar').evaluate("e=>getComputedStyle(e).position==='fixed'"))
        original=page.locator('#mmCashflowSpreadsheetBody tr input[data-field="label"]')
        original.fill('Perubahan belum disimpan')
        page.evaluate("navigateTo('portofolio')")
        page.wait_for_selector('#portofolioPartialMount #tabStrip',timeout=30000)
        page.wait_for_function("document.querySelector('#portofolioPartialMount #app') && !document.querySelector('#portofolioPartialMount #app').classList.contains('hidden')",timeout=30000)
        check('Portfolio keeps seven original tabs',page.locator('#portofolioPartialMount #tabStrip [data-tab]').count()==7)
        for tab in ['today','planner','watch','risk','scenarios','journal','ai']:
            page.locator('#portofolioPartialMount #tabStrip [data-tab="'+tab+'"]').click()
            check('Portfolio '+tab+' opens',page.locator('#portofolioPartialMount #page-'+tab).is_visible())
        for tab in ['analisis-chart','bandarmologi','intel','hunter','insider','ranking','pattern']:
            page.locator('#appSidebar [data-analysis-tab="'+tab+'"]').click()
            page.wait_for_function("tab=>window.__ACTIVE_ANALISIS_SUBTAB__===tab",arg=tab)
            page.wait_for_selector('#analisisPartialMount #analisisInput',state='attached')
            check('Analysis '+tab+' has exactly one active sidebar destination',page.locator('#appSidebar .sidebar-item.active').count()==1 and page.locator('#appSidebar .sidebar-item.active').get_attribute('data-analysis-tab')==tab)
            if tab!='analisis-chart':check('Analysis '+tab+' panel opens',page.locator('#panel-tab-'+tab).is_visible())
        page.evaluate("navigateTo('analisis','intel');navigateTo('analisis','hunter');navigateTo('money-management')")
        page.wait_for_timeout(250)
        check('Rapid navigation keeps last requested page',page.locator('#page-money-management').is_visible() and not page.locator('#page-analisis').is_visible())
        check('Unsaved sheet survives page navigation',original.input_value()=='Perubahan belum disimpan')
        for theme in ['dark','light']:
            page.evaluate("theme=>applyAppTheme(theme)",theme)
            page.screenshot(path=str(OUT/('full-app-'+theme+'.png')))
            check(theme+' workspace width stays inside viewport',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
        page.set_viewport_size({'width':390,'height':844})
        page.locator('#workspaceSidebarToggle').click()
        check('Mobile drawer opens with background inert',page.evaluate("document.getElementById('appMain').inert && document.getElementById('appSidebar').classList.contains('mobile-open')"))
        page.keyboard.press('Escape')
        check('Escape closes drawer and restores trigger focus',page.evaluate("!document.getElementById('appMain').inert && document.activeElement.id==='workspaceSidebarToggle'"))
        check('No new uncaught JavaScript errors during preview',not errors)
    finally:
        (OUT/'full-app-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'page_errors':errors,'url':page.url,'scope':'Full app with local preview/mock APIs, external requests blocked.'},indent=2))
        page.screenshot(path=str(OUT/'full-app-final-state.png'))
        browser.close()
print(json.dumps({'passed':len(checks),'page_errors':errors}))
